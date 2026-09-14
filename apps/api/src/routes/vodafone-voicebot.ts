// ============================================================
// Vodafone (VI) Voicebot WebSocket route — first real, connectable
// implementation of the Vodafone side of Feature 5.
//
// Deliberately accepts duplication with exotel-voicebot.ts's turn-processing
// logic rather than waiting for the full core-pipeline extraction (see
// docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5.2
// "route + wiring now" decision, 2026-09-10). Reuses what's already shared
// (runAskPipeline, runSimulatorStt, VoicebotSession/createSession).
// It does NOT replicate Exotel's dual-leg/campaign/language-switch/barge-in
// machinery. See the "Known limitations" note at the bottom of this file.
//
// Low-latency streaming turn (2026-09-10): when the tenant's
// customer_settings.rag_streaming_enabled is TRUE (this column already
// exists and already defaults to TRUE - see migration 011), each utterance
// is answered via runAskPipeline's onLlmTextDelta hook instead of waiting
// for the full answer: LLM tokens are cut into speakable sentences
// (services/voice-reply-stream.ts) and each sentence is synthesized and
// sent to VI as soon as it's ready, so the caller hears the first sentence
// long before the full answer has finished generating. This mirrors the
// pattern already proven in exotel-voicebot.ts's createStreamingVoiceTts,
// including its same accepted tradeoff: the audio already spoken is the
// RAW streamed answer, not the post-processed/swapped one (e.g. an
// out-of-scope or not-found substitution), since that swap can only be
// decided once the full answer is known - chat history still logs the
// correct, swapped text via runAskPipeline's own saveMessage calls. Setting
// rag_streaming_enabled to FALSE for a tenant reverts that tenant to the
// original batch turn loop immediately, no deploy required - this is the
// intended real-time kill switch.
//
// Inbound-only: VodafoneAdapter.triggerOutboundCall/parseStatusCallback are
// still stubs (VI's outbound REST API / auth mechanism are undocumented —
// roadmap §8.5.1 open items 3/4), so this route only ever RECEIVES a
// WebSocket connection from VI; it never initiates one.
// ============================================================

import { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { env } from "../config/env";
import { pool } from "../config/db";
import { getTelephonySettings } from "../services/telephony-settings";
import { getCustomerSettings, type CustomerSettings } from "../services/customer-settings";
import { runAskPipeline } from "./ask";
import { runSimulatorStt } from "./voice-simulator";
import { createRagTrace } from "../services/rag-trace";
import { synthesizeSpeechToPcm8k } from "../services/vodafone-tts";
import { VodafoneAdapter } from "../services/vodafone-adapter";
import {
  getOrCreateCartesiaTtsSession,
  type CartesiaTtsSession,
} from "../services/cartesia-tts-ws";
import { SentenceStreamBuffer, looksLikeRawRagMarker } from "../services/voice-reply-stream";
import { VOICE_SPOKEN_REPLY_STYLE_RULE } from "../services/rag-prompt-utils";
import {
  normalizeBcp47Tag,
  normalizeAllowedLangList,
  clampLanguageToAllowed,
  languagesLooselyEqual,
  decideLanguageSwitchAction,
  languageSwitchOptionsPrompt,
  parseLanguageChoice,
  persistSessionActiveLanguage,
  languageSwitchAcknowledgement,
} from "../services/voice-language-infer";
import type { CallEvent, OutboundFrame } from "../types/telephony-provider";
import {
  createSession,
  removeSession,
  nextMarkName,
  type VoicebotSession,
} from "../services/voicebot-session";

const VAD_ENERGY_THRESHOLD = 200;
const VAD_SILENCE_MS = 1500;
const MIN_UTTERANCE_BYTES = 1600; // ~100ms @ 8kHz 16-bit mono
const MAX_UTTERANCE_BYTES = 5 * 1024 * 1024;

function pcmRmsEnergy(buf: Buffer): number {
  if (buf.length < 2) return 0;
  let sum = 0;
  const samples = buf.length / 2;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

/** Wraps raw 16-bit LE mono PCM in a minimal WAV header — STT providers expect a real audio container. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface VodafoneCallState {
  session: VoicebotSession;
  adapter: VodafoneAdapter;
  ws: WebSocket;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  customerSettings: CustomerSettings | null;
  ttsConfig: {
    provider: "sarvam" | "elevenlabs" | "cartesia";
    model: string | null;
    speaker: string | null;
    language: string | null;
    normalization: string | null;
  };
  processing: boolean;
}

const calls = new Map<string, VodafoneCallState>();

function sendFrames(ws: WebSocket, frames: OutboundFrame | OutboundFrame[]): void {
  const list = Array.isArray(frames) ? frames : [frames];
  for (const f of list) {
    if (ws.readyState === ws.OPEN) ws.send(f.raw);
  }
}

/**
 * Resolves the actual voice to speak with: agent-level avatar first
 * (cartesia_avatars/elevenlabs_avatars/avatars via the agent's *_avatar_id),
 * falling back to customer_settings.tts_default_speaker/tts_model. Mirrors
 * (a simplified version of) voice-persona.ts's resolution order.
 */
async function resolveTtsConfig(
  provider: "sarvam" | "elevenlabs" | "cartesia",
  agentId: string | null,
  cust: CustomerSettings | null,
  language: string
): Promise<{
  provider: "sarvam" | "elevenlabs" | "cartesia";
  model: string | null;
  speaker: string | null;
  language: string;
  normalization: string | null;
}> {
  // Cartesia-only, customer-level (mirrors cartesia_max_buffer_delay_ms/cartesia_emotion_mode -
  // not per-avatar today). No-op for sarvam/elevenlabs providers.
  const normalization = cust?.cartesia_normalization ?? null;
  if (agentId) {
    if (provider === "cartesia") {
      const row = await pool.query(
        `SELECT ca.voice_id, ca.model_id FROM agents a JOIN cartesia_avatars ca ON ca.id = a.cartesia_avatar_id WHERE a.id = $1`,
        [agentId]
      );
      if (row.rows.length > 0) {
        return { provider, model: row.rows[0].model_id, speaker: row.rows[0].voice_id, language, normalization };
      }
    } else if (provider === "elevenlabs") {
      const row = await pool.query(
        `SELECT ea.voice_id, ea.model_id FROM agents a JOIN elevenlabs_avatars ea ON ea.id = a.elevenlabs_avatar_id WHERE a.id = $1`,
        [agentId]
      );
      if (row.rows.length > 0) {
        return { provider, model: row.rows[0].model_id, speaker: row.rows[0].voice_id, language, normalization };
      }
    } else {
      const row = await pool.query(
        `SELECT av.tts_speaker, av.tts_model FROM avatars av JOIN agents a ON a.avatar_id = av.id WHERE a.id = $1 AND av.tts_provider = 'sarvam'`,
        [agentId]
      );
      if (row.rows.length > 0) {
        return { provider, model: row.rows[0].tts_model, speaker: row.rows[0].tts_speaker, language, normalization };
      }
    }
  }
  return {
    provider,
    model: cust?.tts_model ?? null,
    speaker: cust?.tts_default_speaker ?? null,
    language,
    normalization,
  };
}

async function resolveInitialAgentAndChatSession(customerId: string): Promise<{
  chatSessionId: string;
  agentId: string | null;
  systemPrompt: string;
}> {
  const chatRes = await pool.query(`INSERT INTO chat_sessions (customer_id) VALUES ($1) RETURNING id`, [
    customerId,
  ]);
  const chatSessionId = chatRes.rows[0].id as string;

  const agentRes = await pool.query(
    `SELECT id, system_prompt FROM agents WHERE customer_id = $1 AND is_active = TRUE ORDER BY created_at ASC LIMIT 1`,
    [customerId]
  );
  const customerRes = await pool.query(`SELECT system_prompt FROM customers WHERE id = $1`, [customerId]);
  const fallbackPrompt = customerRes.rows[0]?.system_prompt ?? "You are a helpful assistant.";

  if (agentRes.rows.length === 0) {
    return { chatSessionId, agentId: null, systemPrompt: fallbackPrompt };
  }
  return {
    chatSessionId,
    agentId: agentRes.rows[0].id as string,
    systemPrompt: agentRes.rows[0].system_prompt || fallbackPrompt,
  };
}

async function handleStart(app: FastifyInstance, ws: WebSocket, customerId: string, event: Extract<CallEvent, { type: "start" }>): Promise<void> {
  const telephony = await getTelephonySettings(customerId);
  if (!telephony || telephony.provider_id !== "vodafone" || !telephony.is_enabled) {
    app.log.warn({ customerId }, "vodafone-voicebot: no enabled vodafone telephony settings for this customer");
    ws.close(4400, "vodafone not configured for this customer");
    return;
  }

  const customerSettings = await getCustomerSettings(customerId);
  const session = createSession({
    streamSid: event.streamId,
    callSid: event.callId,
    customerId,
    accountSid: "",
    from: event.fromNumber,
    to: event.toNumber,
    mediaFormat: {
      encoding: event.mediaFormat.encoding,
      sample_rate: event.mediaFormat.sampleRateHz,
      bit_rate: event.mediaFormat.bitRate,
    },
    customParameters: event.customParameters,
  });
  session.defaultLanguageCode = normalizeBcp47Tag(customerSettings?.default_language_code ?? "en-IN");
  session.allowedLanguageCodes = normalizeAllowedLangList(
    customerSettings?.allowed_language_codes,
    session.defaultLanguageCode
  );
  session.currentLanguageCode = session.defaultLanguageCode;

  const { chatSessionId, agentId, systemPrompt } = await resolveInitialAgentAndChatSession(customerId);
  session.chatSessionId = chatSessionId;
  session.agentId = agentId;
  session.voiceRagCustomerCache = { systemPrompt, defaultNoKb: null };

  const ttsConfig = await resolveTtsConfig(
    (customerSettings?.tts_provider as "sarvam" | "elevenlabs" | "cartesia") ?? "sarvam",
    agentId,
    customerSettings,
    session.defaultLanguageCode ?? "en-IN"
  );

  const adapter = new VodafoneAdapter();
  const state: VodafoneCallState = {
    session,
    adapter,
    ws,
    silenceTimer: null,
    customerSettings,
    ttsConfig,
    processing: false,
  };
  calls.set(event.streamId, state);

  app.log.info({ customerId, streamId: event.streamId, callId: event.callId }, "vodafone-voicebot: call started");

  const greeting = "Hello, how can I help you today?";
  try {
    const pcm = await synthesizeSpeechToPcm8k(greeting, state.ttsConfig);
    sendFrames(ws, adapter.buildAudioFrame(event.streamId, pcm));
    sendFrames(ws, adapter.buildMarkFrame(event.streamId, nextMarkName(session)));
  } catch (err) {
    app.log.error({ err, customerId }, "vodafone-voicebot: greeting synthesis failed");
  }
}

/**
 * Language hint sent to STT for this utterance. Ported from exotel-voicebot.ts:
 * forcing a fixed default (e.g. "en-IN") on every turn biases Sarvam toward
 * Romanizing Indic speech as English instead of transcribing it natively,
 * which would silently break language-switch detection (STT would never
 * report anything but the default language). For the first two turns of a
 * multilingual call, the hint is omitted entirely so Sarvam auto-detects;
 * after that, the CURRENT session language is used instead of the fixed
 * default, so it stays consistent with a switch that's already been
 * confirmed.
 */
function resolveSttLanguageHint(state: VodafoneCallState): string | undefined {
  const { session } = state;
  const multilingual = state.customerSettings?.voicebot_multilingual === true;
  const allowedNorm = session.allowedLanguageCodes?.length ? session.allowedLanguageCodes : ["en-IN"];
  const def = normalizeBcp47Tag(session.defaultLanguageCode || "en-IN");

  if (!multilingual) return def;

  const sttProvider = state.customerSettings?.stt_provider ?? "sarvam";
  const priorUserQueryCount = session.customerQueryCount ?? 0;
  const openDetect =
    sttProvider === "sarvam" && !env.voicebot.sarvamSttFullAuto && priorUserQueryCount < 2;

  const current = normalizeBcp47Tag(session.currentLanguageCode || session.defaultLanguageCode || "en-IN");
  let hint: string | undefined = openDetect
    ? (!languagesLooselyEqual(current, def) ? current : undefined)
    : current;

  if (hint) hint = clampLanguageToAllowed(hint, allowedNorm, def);
  return hint;
}

type LanguageSwitchOutcome =
  | { action: "handled" }
  | { action: "continue"; transcript: string };

/**
 * Explicit-confirmation-only mid-call language switch - shared logic with
 * Exotel via services/voice-language-infer.ts (see that file's header for
 * the full design note: the bot never silently changes language on its own
 * inference, only after the caller explicitly confirms on a later turn).
 * Gated behind customer_settings.voicebot_multilingual, same as Exotel.
 *
 * Returns "handled" when this turn was fully answered here (an offer was
 * just spoken, or a pending offer was resolved with nothing left to answer)
 * and the caller must NOT also run the RAG pipeline for it; "continue" with
 * a (possibly trimmed) transcript otherwise.
 */
async function handleLanguageSwitchFlow(
  streamId: string,
  state: VodafoneCallState,
  transcript: string,
  sttLanguageCode: string | null
): Promise<LanguageSwitchOutcome> {
  const { session, adapter, ws } = state;
  if (state.customerSettings?.voicebot_multilingual !== true) {
    return { action: "continue", transcript };
  }

  const allowedNorm = session.allowedLanguageCodes?.length ? session.allowedLanguageCodes : ["en-IN"];
  const activeBcp = normalizeBcp47Tag(session.currentLanguageCode || session.defaultLanguageCode || "en-IN");

  async function speak(text: string): Promise<void> {
    const pcm = await synthesizeSpeechToPcm8k(text, state.ttsConfig);
    sendFrames(ws, adapter.buildAudioFrame(streamId, pcm));
    sendFrames(ws, adapter.buildMarkFrame(streamId, nextMarkName(session)));
  }

  if (session.pendingLanguageSwitch) {
    const pending = session.pendingLanguageSwitch;
    const choice = parseLanguageChoice(
      transcript,
      allowedNorm,
      state.customerSettings?.language_switch_yes_words ?? [],
      state.customerSettings?.language_switch_no_words ?? []
    );
    const chosenTarget =
      choice.kind === "language" ? choice.target : choice.kind === "yes" ? pending.targetLanguage : null;

    if (chosenTarget) {
      const n = persistSessionActiveLanguage(session, chosenTarget);
      session.pendingLanguageSwitch = null;
      // If the caller packed a real question in with the confirmation
      // ("yes, and also what are your hours"), strip the confirmation words
      // and answer the rest now, in the newly-confirmed language, instead
      // of making them repeat it on the next turn.
      const cleaned = transcript
        .toLowerCase()
        .replace(/\b(yes|yeah|okay|sure|haan|ha|ji|switch|hindi|english|marathi|gujarati)\b/gi, "")
        .trim();
      if (cleaned.length > 3) {
        return { action: "continue", transcript: cleaned };
      }
      await speak(languageSwitchAcknowledgement(n));
      return { action: "handled" };
    }
    if (choice.kind === "no") {
      session.pendingLanguageSwitch = null;
      await speak(`Okay, we will continue in ${activeBcp}.`);
      return { action: "handled" };
    }
    pending.unclearRetries += 1;
    const maxAttempts = state.customerSettings?.language_switch_max_attempts ?? 2;
    if (pending.unclearRetries <= maxAttempts) {
      await speak(languageSwitchOptionsPrompt(state.customerSettings, allowedNorm));
      return { action: "handled" };
    }
    session.pendingLanguageSwitch = null;
    await speak(`I will continue in ${activeBcp}.`);
    return { action: "handled" };
  }

  if (!sttLanguageCode) {
    return { action: "continue", transcript };
  }
  const clamped = clampLanguageToAllowed(sttLanguageCode, allowedNorm, activeBcp);
  const decision = decideLanguageSwitchAction(session, state.customerSettings, {
    multilingual: true,
    clampedDetected: clamped,
    languageProbability: null,
    sttProvider: state.customerSettings?.stt_provider ?? "sarvam",
    allowedNorm,
  });
  if (decision.action === "offer") {
    session.pendingLanguageSwitch = {
      targetLanguage: decision.target,
      deferredTranscript: "",
      fromLanguage: activeBcp,
      confidence: decision.confidence,
      unclearRetries: 0,
    };
    session.languageSwitchOfferedThisCall = true;
    await speak(languageSwitchOptionsPrompt(state.customerSettings, allowedNorm));
    return { action: "handled" };
  }
  return { action: "continue", transcript };
}

async function processUtterance(app: FastifyInstance, streamId: string): Promise<void> {
  const state = calls.get(streamId);
  if (!state || state.processing) return;
  const { session, adapter, ws } = state;

  const combined = Buffer.concat(session.inboundPcm);
  session.inboundPcm = [];
  session.inboundBytes = 0;
  if (combined.length < MIN_UTTERANCE_BYTES) return;

  state.processing = true;
  try {
    const wav = pcmToWav(combined, session.mediaFormat.sample_rate || 8000);
    const sttLanguageHint = resolveSttLanguageHint(state);
    const stt = await runSimulatorStt({
      fileBuffer: wav,
      filename: "utterance.wav",
      mimeType: "audio/wav",
      customerId: session.customerId,
      languageHintBcp47: sttLanguageHint,
    });
    session.customerQueryCount = (session.customerQueryCount ?? 0) + 1;
    if (stt.status !== 200 || !stt.transcript.trim()) {
      app.log.warn({ streamId, status: stt.status }, "vodafone-voicebot: STT empty/failed for utterance");
      return;
    }
    const transcript = stt.transcript.trim();
    app.log.info({ streamId, transcript }, "vodafone-voicebot: transcript ready");

    const languageResult = await handleLanguageSwitchFlow(streamId, state, transcript, stt.language_code);
    if (languageResult.action === "handled") return;
    const finalTranscript = languageResult.transcript;

    if (state.customerSettings?.rag_streaming_enabled === true) {
      await answerUtteranceStreaming(app, streamId, state, finalTranscript, stt.language_code);
    } else {
      await answerUtteranceBatch(app, streamId, state, finalTranscript, stt.language_code);
    }
  } catch (err) {
    app.log.error({ err, streamId }, "vodafone-voicebot: turn processing failed");
    try {
      const pcm = await synthesizeSpeechToPcm8k("Sorry, I was unable to process that.", state.ttsConfig);
      sendFrames(ws, adapter.buildAudioFrame(streamId, pcm));
      sendFrames(ws, adapter.buildMarkFrame(streamId, nextMarkName(session)));
    } catch {
      /* best-effort fallback only */
    }
  } finally {
    state.processing = false;
  }
}

/** Original batch turn loop: wait for the full answer, then synthesize and send it in one shot. */
async function answerUtteranceBatch(
  app: FastifyInstance,
  streamId: string,
  state: VodafoneCallState,
  transcript: string,
  sttLanguageCode: string | null
): Promise<void> {
  const { session, adapter, ws } = state;
  const systemPrompt = session.voiceRagCustomerCache?.systemPrompt ?? "You are a helpful assistant.";
  const trace = createRagTrace(app.log);
  const askResult = await runAskPipeline({
    customerId: session.customerId,
    customerPrompt: systemPrompt,
    question: transcript,
    inputSessionId: session.chatSessionId,
    inputAgentId: session.agentId,
    sequentialLlm: true,
    embeddingLanguageHint: sttLanguageCode,
    additionalSystemPrompt: VOICE_SPOKEN_REPLY_STYLE_RULE,
    trace,
  });
  const answer = askResult.answer.trim();
  if (!answer) return;

  const pcm = await synthesizeSpeechToPcm8k(answer, state.ttsConfig);
  sendFrames(ws, adapter.buildAudioFrame(streamId, pcm));
  sendFrames(ws, adapter.buildMarkFrame(streamId, nextMarkName(session)));
}

/**
 * Low-latency turn loop (customer_settings.rag_streaming_enabled = TRUE): the LLM
 * answer is streamed token-by-token, cut into speakable sentences, and each
 * sentence is synthesized and sent as soon as it's ready - see the file header
 * for the full design note and its accepted tradeoff (spoken audio is the raw
 * streamed text; chat history logs the post-processed one via runAskPipeline's
 * own saveMessage calls).
 */
async function answerUtteranceStreaming(
  app: FastifyInstance,
  streamId: string,
  state: VodafoneCallState,
  transcript: string,
  sttLanguageCode: string | null
): Promise<void> {
  const { session, adapter, ws } = state;
  const systemPrompt = session.voiceRagCustomerCache?.systemPrompt ?? "You are a helpful assistant.";
  const trace = createRagTrace(app.log);

  const isCartesia =
    state.ttsConfig.provider === "cartesia" && !!state.ttsConfig.speaker?.trim();
  type CartesiaReplyStream = Awaited<ReturnType<CartesiaTtsSession["beginReplyStream"]>>;
  const cartesia: { reply: CartesiaReplyStream | null; audioPump: Promise<void> | null } = {
    reply: null,
    audioPump: null,
  };
  let spoke = false;

  async function speakSentence(text: string): Promise<void> {
    if (session.isClosing || !text.trim()) return;
    // Raw RAG sentinel token (ANSWER_NOT_FOUND/OUT_OF_SCOPE) - never speak it
    // verbatim; the pipeline's own final `answer` already has the friendly
    // swapped text, spoken via the "nothing spoken yet" fallback below.
    if (looksLikeRawRagMarker(text)) return;
    if (isCartesia) {
      if (!cartesia.reply) {
        const cartesiaTts = getOrCreateCartesiaTtsSession(session, app.log);
        cartesia.reply = await cartesiaTts.beginReplyStream({
          modelId: state.ttsConfig.model ?? undefined,
          voiceId: state.ttsConfig.speaker!.trim(),
          language: state.ttsConfig.language ?? "en",
          normalization: state.ttsConfig.normalization ?? undefined,
          outputFormat: { container: "raw", encoding: "pcm_s16le", sample_rate: 8000 },
        });
        const stream = cartesia.reply;
        cartesia.audioPump = (async () => {
          for await (const chunk of stream.audio) {
            if (session.isClosing) break;
            sendFrames(ws, adapter.buildAudioFrame(streamId, chunk));
          }
        })();
      }
      cartesia.reply.push(text, true);
      spoke = true;
    } else {
      const pcm = await synthesizeSpeechToPcm8k(text, state.ttsConfig);
      sendFrames(ws, adapter.buildAudioFrame(streamId, pcm));
      spoke = true;
    }
  }

  const sentences = new SentenceStreamBuffer((sentence) => speakSentence(sentence));

  const askResult = await runAskPipeline({
    customerId: session.customerId,
    customerPrompt: systemPrompt,
    question: transcript,
    inputSessionId: session.chatSessionId,
    inputAgentId: session.agentId,
    embeddingLanguageHint: sttLanguageCode,
    additionalSystemPrompt: VOICE_SPOKEN_REPLY_STYLE_RULE,
    onLlmTextDelta: (delta) => sentences.push(delta),
    trace,
  });

  await sentences.flush();

  if (isCartesia && cartesia.reply) {
    cartesia.reply.finish();
    if (cartesia.audioPump) await cartesia.audioPump;
  }

  // Covers two cases: the no_kb/kb_direct/out_of_scope-distance-gate branches
  // never call the LLM (onLlmTextDelta is never invoked), and the raw-marker
  // guard above can suppress the only sentence that was streamed. Either way,
  // nothing has actually been spoken yet - fall back to a single batch
  // synthesis of the resolved (already-swapped) answer, exactly like
  // answerUtteranceBatch, so those cases are still heard correctly.
  if (!spoke) {
    const answer = askResult.answer.trim();
    if (answer) {
      const pcm = await synthesizeSpeechToPcm8k(answer, state.ttsConfig);
      sendFrames(ws, adapter.buildAudioFrame(streamId, pcm));
      spoke = true;
    }
  }

  if (spoke) {
    sendFrames(ws, adapter.buildMarkFrame(streamId, nextMarkName(session)));
  }
}

function armSilenceTimer(app: FastifyInstance, streamId: string): void {
  const state = calls.get(streamId);
  if (!state) return;
  if (state.silenceTimer) clearTimeout(state.silenceTimer);
  state.silenceTimer = setTimeout(() => {
    void processUtterance(app, streamId);
  }, VAD_SILENCE_MS);
}

export async function vodafoneVoicebotRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { customerId: string } }>(
    "/telephony/vodafone/voicebot/:customerId",
    { websocket: true },
    (socket, request) => {
      const { customerId } = request.params;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRe.test(customerId)) {
        socket.close(4400, "invalid customerId");
        return;
      }

      const adapterForParsing = new VodafoneAdapter();
      let streamId: string | null = null;

      socket.on("message", (raw: Buffer) => {
        void (async () => {
          const event = adapterForParsing.parseInboundMessage(raw.toString("utf8"));
          if (!event) return;

          switch (event.type) {
            case "connected":
              break;

            case "start":
              streamId = event.streamId;
              await handleStart(app, socket, customerId, event);
              break;

            case "media": {
              const state = streamId ? calls.get(streamId) : undefined;
              if (!state || state.session.isClosing) return;
              const energy = pcmRmsEnergy(event.pcm16);
              state.session.inboundPcm.push(event.pcm16);
              state.session.inboundBytes += event.pcm16.length;
              if (state.session.inboundBytes > MAX_UTTERANCE_BYTES) {
                await processUtterance(app, streamId!);
                return;
              }
              if (energy >= VAD_ENERGY_THRESHOLD) {
                armSilenceTimer(app, streamId!);
              } else if (state.session.inboundPcm.length > 0) {
                armSilenceTimer(app, streamId!);
              }
              break;
            }

            case "dtmf":
              app.log.info({ streamId, digit: event.digit }, "vodafone-voicebot: dtmf received (no menu wired up yet)");
              break;

            case "markAck": {
              const state = streamId ? calls.get(streamId) : undefined;
              state?.session.pendingMarks.delete(event.name);
              break;
            }

            case "stop": {
              const state = streamId ? calls.get(streamId) : undefined;
              if (state) {
                state.session.isClosing = true;
                if (state.silenceTimer) clearTimeout(state.silenceTimer);
                state.adapter.releaseStream(event.streamId);
                removeSession(event.streamId);
                calls.delete(event.streamId);
              }
              app.log.info({ streamId: event.streamId, reason: event.reason }, "vodafone-voicebot: stop");
              break;
            }
          }
        })().catch((err) => {
          app.log.error({ err, streamId }, "vodafone-voicebot: message handling error");
        });
      });

      socket.on("close", () => {
        if (!streamId) return;
        const state = calls.get(streamId);
        if (state) {
          if (state.silenceTimer) clearTimeout(state.silenceTimer);
          state.adapter.releaseStream(streamId);
        }
        removeSession(streamId);
        calls.delete(streamId);
      });
    }
  );
}

// ============================================================
// Known limitations (deliberate, given the "route + wiring now, accept
// duplication" decision — see file header):
// - Single-leg inbound only. No dual-leg/outbound-campaign echo suppression
//   (that machinery is Exotel-specific and campaign-only; nothing calls
//   VodafoneAdapter.triggerOutboundCall yet since it's still a stub).
// - No mid-call language-switch flow, no filler acks, no barge-in beyond
//   what VI's own `clear` event would do if the core loop sent it (it
//   doesn't yet - TTS here is one-shot per sentence, not interruptible).
// - STT is still batch (one call per utterance, after VAD silence). TTS/LLM
//   now stream per-sentence when rag_streaming_enabled is TRUE (see file
//   header) - closes most, not all, of the latency gap with Exotel's
//   streaming-enabled path (Exotel also streams STT; this route doesn't yet).
// - VAD is the same simple fixed-silence-timer approach §4.1 of the roadmap
//   already flagged as the biggest latency/naturalness gap on Exotel.
// ============================================================
