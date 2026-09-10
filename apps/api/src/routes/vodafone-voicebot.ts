// ============================================================
// Vodafone (VI) Voicebot WebSocket route — first real, connectable
// implementation of the Vodafone side of Feature 5.
//
// Deliberately accepts duplication with exotel-voicebot.ts's turn-processing
// logic rather than waiting for the full core-pipeline extraction (see
// docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5.2
// "route + wiring now" decision, 2026-09-10). Reuses what's already shared
// (runAskPipeline, runSimulatorStt, VoicebotSession/createSession) and adds
// a purpose-built, simpler batch (non-streaming) turn loop for Vodafone —
// it does NOT replicate Exotel's dual-leg/campaign/language-switch/barge-in
// machinery. See the "Known limitations" note at the bottom of this file.
//
// Inbound-only: VodafoneAdapter.triggerOutboundCall/parseStatusCallback are
// still stubs (VI's outbound REST API / auth mechanism are undocumented —
// roadmap §8.5.1 open items 3/4), so this route only ever RECEIVES a
// WebSocket connection from VI; it never initiates one.
// ============================================================

import { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { pool } from "../config/db";
import { getTelephonySettings } from "../services/telephony-settings";
import { getCustomerSettings, type CustomerSettings } from "../services/customer-settings";
import { runAskPipeline } from "./ask";
import { runSimulatorStt } from "./voice-simulator";
import { createRagTrace } from "../services/rag-trace";
import { synthesizeSpeechToPcm8k } from "../services/vodafone-tts";
import { VodafoneAdapter } from "../services/vodafone-adapter";
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
  ttsConfig: { provider: "sarvam" | "elevenlabs" | "cartesia"; model: string | null; speaker: string | null; language: string | null };
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
): Promise<{ provider: "sarvam" | "elevenlabs" | "cartesia"; model: string | null; speaker: string | null; language: string }> {
  if (agentId) {
    if (provider === "cartesia") {
      const row = await pool.query(
        `SELECT ca.voice_id, ca.model_id FROM agents a JOIN cartesia_avatars ca ON ca.id = a.cartesia_avatar_id WHERE a.id = $1`,
        [agentId]
      );
      if (row.rows.length > 0) {
        return { provider, model: row.rows[0].model_id, speaker: row.rows[0].voice_id, language };
      }
    } else if (provider === "elevenlabs") {
      const row = await pool.query(
        `SELECT ea.voice_id, ea.model_id FROM agents a JOIN elevenlabs_avatars ea ON ea.id = a.elevenlabs_avatar_id WHERE a.id = $1`,
        [agentId]
      );
      if (row.rows.length > 0) {
        return { provider, model: row.rows[0].model_id, speaker: row.rows[0].voice_id, language };
      }
    } else {
      const row = await pool.query(
        `SELECT tts_speaker, tts_model FROM avatars av JOIN agents a ON a.avatar_id = av.id WHERE a.id = $1 AND av.tts_provider = 'sarvam'`,
        [agentId]
      );
      if (row.rows.length > 0) {
        return { provider, model: row.rows[0].tts_model, speaker: row.rows[0].tts_speaker, language };
      }
    }
  }
  return {
    provider,
    model: cust?.tts_model ?? null,
    speaker: cust?.tts_default_speaker ?? null,
    language,
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
  session.defaultLanguageCode = customerSettings?.default_language_code ?? "en-IN";
  session.allowedLanguageCodes = customerSettings?.allowed_language_codes ?? ["en-IN"];
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
    const stt = await runSimulatorStt({
      fileBuffer: wav,
      filename: "utterance.wav",
      mimeType: "audio/wav",
      customerId: session.customerId,
      languageHintBcp47: session.defaultLanguageCode ?? undefined,
    });
    if (stt.status !== 200 || !stt.transcript.trim()) {
      app.log.warn({ streamId, status: stt.status }, "vodafone-voicebot: STT empty/failed for utterance");
      return;
    }
    const transcript = stt.transcript.trim();
    app.log.info({ streamId, transcript }, "vodafone-voicebot: transcript ready");

    const systemPrompt = session.voiceRagCustomerCache?.systemPrompt ?? "You are a helpful assistant.";
    const trace = createRagTrace(app.log);
    const askResult = await runAskPipeline({
      customerId: session.customerId,
      customerPrompt: systemPrompt,
      question: transcript,
      inputSessionId: session.chatSessionId,
      inputAgentId: session.agentId,
      sequentialLlm: true,
      embeddingLanguageHint: stt.language_code,
      trace,
    });
    const answer = askResult.answer.trim();
    if (!answer) return;

    const pcm = await synthesizeSpeechToPcm8k(answer, state.ttsConfig);
    sendFrames(ws, adapter.buildAudioFrame(streamId, pcm));
    sendFrames(ws, adapter.buildMarkFrame(streamId, nextMarkName(session)));
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
//   doesn't yet — TTS here is one-shot, not chunked/interruptible).
// - Batch (non-streaming) STT and TTS only — higher per-turn latency than
//   Exotel's streaming-enabled path. Matches this file's scope: get a real,
//   connectable, correct Vodafone call working, not feature parity.
// - VAD is the same simple fixed-silence-timer approach §4.1 of the roadmap
//   already flagged as the biggest latency/naturalness gap on Exotel.
// ============================================================
