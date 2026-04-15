// ============================================================
// Exotel Voicebot WebSocket Route — Multi-tenant
// This is the per-tenant WSS endpoint that Exotel connects to.
//
// Route:    GET /exotel/voicebot/:customerId    (WebSocket upgrade)
// Route:    GET /exotel/voicebot/bootstrap/:customerId  (HTTPS bootstrap)
//
// Reference: docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §14 Phase C+D
// ============================================================

import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import { pool } from "../config/db";
import { env } from "../config/env";
import {
  parseExotelMessage,
  type ExotelInboundMessage,
  type ExotelStartMessage,
  type ExotelMediaMessage,
  type ExotelOutboundMedia,
  type ExotelOutboundMark,
} from "../types/exotel-ws";
import {
  getExotelSettings,
  createCallSession,
  endCallSession,
  linkChatSessionToCall,
  type ExotelSettings,
} from "../services/exotel-settings";
import { voicebotUrlsForCustomer } from "../services/exotel-voice-urls";
import {
  createSession,
  removeSession,
  nextMarkName,
  getActiveSessionCount,
  type VoicebotSession,
} from "../services/voicebot-session";
import {
  decodeBase64Pcm,
  encodeBase64Pcm,
  PcmChunkBuffer,
  parseWavPcm16Mono,
  pcmDurationMs,
  resamplePcm16,
} from "../services/pcm-audio";
import {
  sarvamSpeechToText,
  sarvamTextToSpeech,
  type SarvamTtsBody,
} from "../services/sarvam";
import {
  voiceTrace,
  safeJsonForLog,
  redactInboundExotelForLog,
  redactOutboundExotelForLog,
} from "../services/voicebot-trace";

// ============================================================
// Constants
// ============================================================

/** Silence detection: if no media for this many ms, treat as end of utterance. */
const VAD_SILENCE_TIMEOUT_MS = 1500;

/** Maximum inbound PCM buffer before force-processing (avoid OOM). */
const MAX_INBOUND_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB ≈ ~160s at 16kHz

/** Fallback error audio text when STT/LLM/TTS fails. */
const ERROR_AUDIO_TEXT = "Sorry, I was unable to process that. Please try again.";

/** Greeting text for new calls. */
const GREETING_TEXT = "Hello! How can I help you today?";

/** Energy threshold for voice activity detection.
 *  PCM chunks with RMS energy below this are treated as silence.
 *  Telephony audio (8kHz) typically has noise floor ~50-150.
 *  Speech is typically 300-5000+. Start with 200 and tune if needed. */
const VAD_ENERGY_THRESHOLD = 200;

/**
 * Compute RMS (root mean square) energy of a 16-bit LE PCM buffer.
 * Returns 0 for empty buffers. Speech typically > 300, silence < 150.
 */
function pcmRmsEnergy(pcm: Buffer): number {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * 2);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / sampleCount);
}

/** If Exotel never sends inbound `mark` after our outbound audio, unblock STT after this slack past estimated play time. */
const PLAYBACK_MARK_FALLBACK_SLACK_MS = 2500;

function clearPlaybackMarkFallback(session: VoicebotSession): void {
  if (session.playbackFallbackTimer) {
    clearTimeout(session.playbackFallbackTimer);
    session.playbackFallbackTimer = null;
  }
}

/**
 * Exotel should echo `mark` when playback reaches each mark. If that never arrives, pending marks
 * would block caller audio forever — clear after estimated PCM duration + slack.
 */
function schedulePlaybackMarkFallback(
  session: VoicebotSession,
  outboundPcmBytes: number,
  exotelSampleRate: number,
  log?: FastifyRequest["log"]
): void {
  clearPlaybackMarkFallback(session);
  if (outboundPcmBytes <= 0 || session.pendingMarks.size === 0) return;
  const playMs = pcmDurationMs(outboundPcmBytes, exotelSampleRate);
  const waitMs = Math.ceil(playMs + PLAYBACK_MARK_FALLBACK_SLACK_MS);
  session.playbackFallbackTimer = setTimeout(() => {
    session.playbackFallbackTimer = null;
    if (session.pendingMarks.size === 0) return;
    log?.warn(
      {
        stream_sid: session.streamSid,
        pending_marks: [...session.pendingMarks],
        fallback_after_ms: waitMs,
      },
      "voicebot: mark ack missing after playback window; clearing pending marks so caller audio can be processed"
    );
    session.pendingMarks.clear();
    session.isSpeaking = false;
  }, waitMs);
}

// ============================================================
// Helpers — chat_sessions / chat_messages (one session per call)
// ============================================================

/**
 * One `chat_sessions` row per phone call; all turns go to `chat_messages` under that id.
 * Call once from Exotel `start` before `createCallSession` so the call row can store `chat_session_id`.
 */
async function bootstrapVoicebotChatSession(
  session: VoicebotSession,
  _log?: FastifyRequest["log"]
): Promise<void> {
  if (session.chatSessionId) return;

  const sessionResult = await pool.query(
    `INSERT INTO chat_sessions (customer_id) VALUES ($1) RETURNING id`,
    [session.customerId]
  );
  session.chatSessionId = sessionResult.rows[0].id as string;

  const agentsResult = await pool.query(
    `SELECT id, system_prompt, greeting_text, error_text, tts_pace, tts_model, tts_speaker, tts_sample_rate FROM agents
     WHERE customer_id = $1 AND is_active = TRUE
     ORDER BY created_at ASC LIMIT 1`,
    [session.customerId]
  );
  if (agentsResult.rows.length > 0) {
    const row = agentsResult.rows[0];
    session.agentId = row.id as string;
    
    session.greetingText = row.greeting_text;
    session.errorText = row.error_text;
    session.ttsPace = row.tts_pace != null ? Number(row.tts_pace) : null;
    session.ttsModel = row.tts_model;
    session.ttsSpeaker = row.tts_speaker;
    session.ttsSampleRate = row.tts_sample_rate != null ? Number(row.tts_sample_rate) : null;

    await pool.query(
      `UPDATE chat_sessions SET agent_id = $1, updated_at = NOW() WHERE id = $2`,
      [session.agentId, session.chatSessionId]
    );
  }
}

/**
 * If `start` did not run (should not happen), recover chat + link to call.
 */
async function ensureVoicebotChatSessionForUtterance(
  session: VoicebotSession,
  log?: FastifyRequest["log"]
): Promise<void> {
  if (session.chatSessionId) return;
  await bootstrapVoicebotChatSession(session, log);
  if (session.callSessionDbId && session.chatSessionId) {
    await linkChatSessionToCall(session.callSessionDbId, session.chatSessionId);
  }
}

async function touchChatSession(sessionId: string): Promise<void> {
  await pool.query(`UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1`, [sessionId]);
}

function exotelCallIdForMessages(session: VoicebotSession): string | null {
  return session.callSessionDbId;
}

/** PG undefined_column — migration 004 not applied yet; retry without exotel_call_session_id. */
function isMissingExotelColumnError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === "42703" || /exotel_call_session_id/i.test(String(e?.message ?? ""));
}

/** Persist user + assistant lines for this voice turn (encrypted content). Tagged with Exotel call row id when present. */
async function appendVoiceTurnToChat(
  session: VoicebotSession,
  userText: string,
  assistantText: string,
  opts?: { assistantSource?: string | null; openaiCostUsd?: number | null }
): Promise<void> {
  if (!session.chatSessionId) return;
  const callId = exotelCallIdForMessages(session);
  const { encrypt } = await import("../services/crypto");
  const uq = [session.chatSessionId, "user", encrypt(userText), "voice", callId] as const;
  const aq = [
    session.chatSessionId,
    "assistant",
    encrypt(assistantText),
    opts?.assistantSource ?? "voice",
    opts?.openaiCostUsd ?? null,
    callId,
  ] as const;
  try {
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source, exotel_call_session_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [...uq]
    );
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source, openai_cost_usd, exotel_call_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [...aq]
    );
  } catch (err) {
    if (!isMissingExotelColumnError(err)) throw err;
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source) VALUES ($1, $2, $3, $4)`,
      [uq[0], uq[1], uq[2], uq[3]]
    );
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source, openai_cost_usd) VALUES ($1, $2, $3, $4, $5)`,
      [aq[0], aq[1], aq[2], aq[3], aq[4]]
    );
  }
  await touchChatSession(session.chatSessionId);
}

/** Assistant-only line (e.g. greeting). */
async function appendAssistantChatLine(
  session: VoicebotSession,
  text: string,
  source: string
): Promise<void> {
  if (!session.chatSessionId) return;

  const { encrypt } = await import("../services/crypto");
  const callId = exotelCallIdForMessages(session);
  const row = [session.chatSessionId, "assistant", encrypt(text), source, callId] as const;
  try {
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source, exotel_call_session_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [...row]
    );
  } catch (err) {
    if (!isMissingExotelColumnError(err)) throw err;
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source) VALUES ($1, $2, $3, $4)`,
      [row[0], row[1], row[2], row[3]]
    );
  }
  await touchChatSession(session.chatSessionId);
}

type VoiceTraceCtx = {
  customerId: string;
  streamSid?: string;
  callSid?: string;
  exotelCallDbId?: string | null;
};

function logVoiceStage(
  log: FastifyRequest["log"] | undefined,
  stage: string,
  meta: Record<string, unknown> = {},
  message?: string
): void {
  log?.info({ voicebotStage: stage, ...meta }, message ?? `voicebot stage: ${stage}`);
}

/**
 * Send a JSON message to Exotel on the WebSocket (logs safe payload preview).
 */
function sendToExotel(
  ws: WebSocket,
  message: object,
  log?: FastifyRequest["log"],
  ctx?: VoiceTraceCtx,
  options?: { skipTrace?: boolean }
): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (!options?.skipTrace && log) {
    const asRecord = message as Record<string, unknown>;
    voiceTrace(log, "exotel.out.json", {
      customerId: ctx?.customerId,
      stream_sid: ctx?.streamSid ?? (asRecord.stream_sid as string | undefined),
      call_sid: ctx?.callSid,
      exotel_call_session_id: ctx?.exotelCallDbId,
      payload: redactOutboundExotelForLog(asRecord),
    });
  }
  ws.send(JSON.stringify(message));
}

/**
 * Send PCM audio back to Exotel as base64 media frames.
 * Respects chunk sizing rules (320-byte multiples, 3.2KB–100KB).
 */
function sendAudioToExotel(
  ws: WebSocket,
  session: VoicebotSession,
  pcmBuffer: Buffer,
  log?: FastifyRequest["log"]
): void {
  const chunkBuffer = new PcmChunkBuffer();
  const chunks = chunkBuffer.push(pcmBuffer);
  const flushed: Buffer[] = [];
  let piece: Buffer | null;
  while ((piece = chunkBuffer.flush()) !== null) {
    flushed.push(piece);
  }

  const allChunks = flushed.length > 0 ? [...chunks, ...flushed] : chunks;
  let totalB64 = 0;

  const ctx: VoiceTraceCtx = {
    customerId: session.customerId,
    streamSid: session.streamSid,
    callSid: session.callSid,
    exotelCallDbId: session.callSessionDbId,
  };

  for (const chunk of allChunks) {
    const b64 = encodeBase64Pcm(chunk);
    totalB64 += b64.length;
    const media: ExotelOutboundMedia = {
      event: "media",
      stream_sid: session.streamSid,
      media: { payload: b64 },
    };
    sendToExotel(ws, media, log, ctx, { skipTrace: true });
  }

  voiceTrace(log, "exotel.out.media_batch", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    call_sid: session.callSid,
    exotel_call_session_id: session.callSessionDbId,
    pcm_in_bytes: pcmBuffer.length,
    media_chunks: allChunks.length,
    outbound_b64_chars: totalB64,
  });

  // Send a mark after the last chunk so we know when playback completes
  if (allChunks.length > 0) {
    const markName = nextMarkName(session);
    session.pendingMarks.add(markName);
    session.isSpeaking = true;
    const mark: ExotelOutboundMark = {
      event: "mark",
      stream_sid: session.streamSid,
      mark: { name: markName },
    };
    sendToExotel(ws, mark, log, ctx);
  }
}

/**
 * Convert text to PCM audio via Sarvam TTS, then send to Exotel.
 * Returns true if audio was successfully sent.
 */
async function speakToExotel(
  ws: WebSocket,
  session: VoicebotSession,
  text: string,
  languageCode: string = "en-IN",
  log?: FastifyRequest["log"]
): Promise<boolean> {
  session.ttsInProgress = true;
  try {
    logVoiceStage(log, "tts.start", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      call_sid: session.callSid,
      exotel_call_session_id: session.callSessionDbId,
      text_chars: text.length,
      languageCode,
    });
    voiceTrace(log, "pipeline.tts.request", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      call_sid: session.callSid,
      exotel_call_session_id: session.callSessionDbId,
      text_chars: text.length,
      text_preview: text.slice(0, 400),
      languageCode,
      sample_rate: session.mediaFormat.sample_rate,
    });

    const ttsPayload: SarvamTtsBody = {
      text: text.slice(0, 2500),
      target_language_code: languageCode,
      model: session.ttsModel || env.sarvam.ttsModel || "bulbul:v3",
      speech_sample_rate: (session.ttsSampleRate || env.sarvam.ttsSpeechSampleRate || "8000").toString(),
      output_audio_codec: "wav",
    };
    if (session.ttsSpeaker) {
      ttsPayload.speaker = session.ttsSpeaker;
    } else if (env.sarvam.ttsSpeaker) {
      ttsPayload.speaker = env.sarvam.ttsSpeaker;
    }
    
    const pace = session.ttsPace ?? env.sarvam.ttsPace;
    if (pace != null && !Number.isNaN(pace)) {
      ttsPayload.pace = pace;
    }

    const tts = await sarvamTextToSpeech(ttsPayload);

    if (tts.status !== 200) {
      session.ttsInProgress = false;
      log?.error({ status: tts.status, body: safeJsonForLog(tts.body) }, "voicebot TTS failed");
      voiceTrace(log, "pipeline.tts.error", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        status: tts.status,
        body: safeJsonForLog(tts.body),
      });
      logVoiceStage(log, "tts.error", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        status: tts.status,
      }, "voicebot TTS failed");
      return false;
    }

    const ttsData = tts.body as { audios?: string[] };
    const b64Audio = ttsData.audios?.[0];
    if (!b64Audio) {
      session.ttsInProgress = false;
      log?.error("voicebot TTS returned no audio");
      logVoiceStage(log, "tts.empty_audio", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
      }, "voicebot TTS returned empty audio payload");
      return false;
    }

    voiceTrace(log, "pipeline.tts.response", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      wav_b64_chars: b64Audio.length,
    });

    const wavBuffer = Buffer.from(b64Audio, "base64");
    const parsed = parseWavPcm16Mono(wavBuffer);
    const fallbackRate = parseInt(env.sarvam.ttsSpeechSampleRate, 10) || 22050;
    let pcmData: Buffer;
    let srcRate: number;

    if (parsed) {
      pcmData = parsed.pcm;
      srcRate = parsed.sampleRate;
    } else {
      pcmData = wavBuffer.length > 44 ? wavBuffer.subarray(44) : wavBuffer;
      srcRate = fallbackRate;
      log?.warn(
        { stream_sid: session.streamSid, wav_bytes: wavBuffer.length },
        "voicebot: WAV parse failed; assuming raw PCM at SARVAM_TTS_SPEECH_SAMPLE_RATE"
      );
    }

    const exotelRate = session.mediaFormat.sample_rate;
    if (srcRate !== exotelRate) {
      voiceTrace(log, "pipeline.tts.resample", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        pcm_bytes_before: pcmData.length,
        from_sample_rate: srcRate,
        to_sample_rate: exotelRate,
      });
      pcmData = resamplePcm16(pcmData, srcRate, exotelRate);
    }

    sendAudioToExotel(ws, session, pcmData, log);
    session.ttsInProgress = false;
    schedulePlaybackMarkFallback(session, pcmData.length, exotelRate, log);
    logVoiceStage(log, "tts.sent_to_exotel", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      pcm_bytes: pcmData.length,
      exotel_sample_rate: exotelRate,
    });
    return true;
  } catch (err) {
    session.ttsInProgress = false;
    log?.error({ err }, "voicebot speakToExotel failed");
    logVoiceStage(log, "tts.exception", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      err: String(err),
    }, "voicebot speakToExotel threw");
    return false;
  }
}

/**
 * Process accumulated inbound audio: STT → Pipeline → TTS → Send to Exotel.
 * This is the core voice agent pipeline for a single utterance.
 */
async function processUtterance(
  ws: WebSocket,
  session: VoicebotSession,
  log?: FastifyRequest["log"]
): Promise<void> {
  if (session.inboundPcm.length === 0 || session.isClosing) return;
  if (session.ttsInProgress || session.pendingMarks.size > 0) return;
  const utteranceStartedAt = Date.now();

  // Grab all accumulated PCM and reset
  const pcmChunks = session.inboundPcm;
  session.inboundPcm = [];
  session.inboundBytes = 0;

  const combinedPcm = Buffer.concat(pcmChunks);
  if (combinedPcm.length < 1600) {
    voiceTrace(log, "pipeline.skip_short_utterance", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      pcm_bytes: combinedPcm.length,
      min_required: 1600,
    });
    return;
  }
  logVoiceStage(log, "utterance.received", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    pcm_bytes: combinedPcm.length,
    estimated_ms: (combinedPcm.length / 2 / session.mediaFormat.sample_rate) * 1000,
  });

  log?.info({
    stream_sid: session.streamSid,
    pcm_bytes: combinedPcm.length,
    duration_ms: (combinedPcm.length / 2 / session.mediaFormat.sample_rate) * 1000,
  }, "voicebot processing utterance");

  voiceTrace(log, "pipeline.stt.request", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    call_sid: session.callSid,
    exotel_call_session_id: session.callSessionDbId,
    wav_pcm_bytes: combinedPcm.length,
    sample_rate: session.mediaFormat.sample_rate,
  });

  try {
    // === Step 1: STT ===
    // Create a minimal WAV header for the raw PCM so Sarvam can process it
    const wavBuffer = createWavBuffer(combinedPcm, session.mediaFormat.sample_rate);

    // ──────────────────────────────────────────────────────────────
    // TEMPORARY FIX: Force English STT when VOICEBOT_MULTILINGUAL=false (default).
    // Sarvam auto-detection on 8kHz telephony audio is unreliable (misdetects
    // English as Gujarati/other languages with <25% confidence).
    //
    // TODO: When ready for all Indian languages, set VOICEBOT_MULTILINGUAL=true
    // in .env — this will remove the language_code hint and let Sarvam auto-detect.
    // ──────────────────────────────────────────────────────────────
    const sttLanguageHint = env.voicebotMultilingual
      ? undefined          // Multi-language: let Sarvam auto-detect
      : "en-IN";           // English-only: force English transcription

    const stt = await sarvamSpeechToText({
      fileBuffer: wavBuffer,
      filename: "utterance.wav",
      mimeType: "audio/wav",
      model: "saaras:v3",
      mode: "transcribe",
      language_code: sttLanguageHint,
    });

    if (stt.status !== 200) {
      log?.error({ status: stt.status, body: safeJsonForLog(stt.body) }, "voicebot STT failed");
      voiceTrace(log, "pipeline.stt.error", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        status: stt.status,
        body: safeJsonForLog(stt.body),
      });
      await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log);
      return;
    }

    const sttBody = stt.body as { transcript?: string; language_code?: string };
    const transcript = sttBody.transcript?.trim();
    const detectedLanguage = sttBody.language_code || "en-IN";
    logVoiceStage(log, "stt.done", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      language: detectedLanguage,
      transcript_chars: transcript?.length ?? 0,
    });

    voiceTrace(log, "pipeline.stt.response", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      call_sid: session.callSid,
      exotel_call_session_id: session.callSessionDbId,
      transcript: transcript || "",
      language: detectedLanguage,
      raw: safeJsonForLog(stt.body),
    });

    if (!transcript) {
      log?.warn(
        {
          stream_sid: session.streamSid,
          stt_body: safeJsonForLog(stt.body),
        },
        "voicebot STT empty transcript — check audio encoding/sample rate vs Exotel media_format"
      );
      voiceTrace(log, "pipeline.stt.empty_transcript", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        raw: safeJsonForLog(stt.body),
      });
      return; // Silence or noise — don't respond
    }

    log?.info({
      stream_sid: session.streamSid,
      transcript,
      language: detectedLanguage,
    }, "voicebot STT result");

    voiceTrace(log, "pipeline.rag.start", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      exotel_call_session_id: session.callSessionDbId,
      question_preview: transcript.slice(0, 500),
    });

    // === Step 2: Run RAG/Ask Pipeline ===
    // Reuse the existing ask pipeline via internal function call
    const askResult = await runVoicebotAskPipeline(
      session,
      transcript,
      log
    );

    if (!askResult || !askResult.answer) {
      await appendVoiceTurnToChat(session, transcript, session.errorText || ERROR_AUDIO_TEXT, {
        assistantSource: "pipeline_error",
      });
      await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, detectedLanguage, log);
      logVoiceStage(log, "pipeline.fallback_error_audio", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
      });
      return;
    }

    log?.info({
      stream_sid: session.streamSid,
      answer: askResult.answer.slice(0, 200),
      source: askResult.source,
    }, "voicebot pipeline result");

    // === Step 3: TTS + Send ===
    // ──────────────────────────────────────────────────────────────
    // TEMPORARY FIX: Force English TTS when VOICEBOT_MULTILINGUAL=false (default).
    // When STT misdetects the language (e.g. gu-IN for English speech),
    // TTS receives English text with wrong language code → garbled audio.
    //
    // TODO: When VOICEBOT_MULTILINGUAL=true, the old mapToTtsLanguage()
    // will be used again so TTS follows the STT-detected language.
    // ──────────────────────────────────────────────────────────────
    const ttsLanguage = env.voicebotMultilingual
      ? mapToTtsLanguage(detectedLanguage)   // Multi-language: follow STT detection
      : "en-IN";                              // English-only: always English TTS
    await speakToExotel(ws, session, askResult.answer, ttsLanguage, log);
    const elapsedMs = Date.now() - utteranceStartedAt;
    logVoiceStage(log, "utterance.completed", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      llm_source: askResult.source,
      elapsed_ms: elapsedMs,
    });
    if (elapsedMs > 15000) {
      log?.warn({ stream_sid: session.streamSid, elapsedMs }, "voicebot utterance slow path (>15s)");
    }
  } catch (err) {
    log?.error({ err, stream_sid: session.streamSid }, "voicebot utterance processing error");
    logVoiceStage(log, "utterance.exception", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      err: String(err),
    }, "voicebot utterance failed");
    await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log).catch(() => {});
  }
}

/**
 * Create a WAV file buffer from raw 16-bit LE mono PCM.
 */
function createWavBuffer(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // 16-bit mono = 2 bytes/sample
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);       // fmt chunk size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Map Sarvam STT language code to a TTS-compatible code.
 */
function mapToTtsLanguage(lang: string): string {
  const supported = [
    "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN",
    "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
  ];
  if (supported.includes(lang)) return lang;
  // Fallback: try matching the primary language
  const primary = lang.split("-")[0];
  const match = supported.find((s) => s.startsWith(primary + "-"));
  return match || "en-IN";
}

/**
 * Minimal ask pipeline call for voicebot — reuses the DB-based pipeline
 * (agents, KB, sessions) without going through HTTP.
 */
async function runVoicebotAskPipeline(
  session: VoicebotSession,
  question: string,
  log?: FastifyRequest["log"]
): Promise<{ answer: string; source: string; session_id: string } | null> {
  try {
    // Import the pipeline function lazily to avoid circular deps
    const { generateEmbedding, chatOpenAI } = await import("../services/llm");

    // Get customer system prompt
    const customerResult = await pool.query(
      `SELECT system_prompt, rag_use_openai_only FROM customers WHERE id = $1`,
      [session.customerId]
    );
    if (customerResult.rows.length === 0) return null;

    const customerPrompt = customerResult.rows[0].system_prompt;

    await ensureVoicebotChatSessionForUtterance(session, log);

    let agentPrompt = customerPrompt;
    if (session.agentId) {
      const agentResult = await pool.query(
        `SELECT system_prompt, tts_pace, tts_model, tts_speaker, tts_sample_rate FROM agents WHERE id = $1`,
        [session.agentId]
      );
      if (agentResult.rows.length > 0) {
        const row = agentResult.rows[0];
        agentPrompt = row.system_prompt;

        session.ttsPace = row.tts_pace != null ? Number(row.tts_pace) : null;
        session.ttsModel = row.tts_model;
        session.ttsSpeaker = row.tts_speaker;
        session.ttsSampleRate = row.tts_sample_rate != null ? Number(row.tts_sample_rate) : null;
      }
    }

    voiceTrace(log, "pipeline.rag.embedding", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      exotel_call_session_id: session.callSessionDbId,
      question_len: question.length,
    });

    // Generate embedding for the question
    const embedding = await generateEmbedding(question);
    logVoiceStage(log, "rag.embedding.done", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      vector_dims: embedding.length,
    });

    // KB vector search
    const embeddingStr = `[${embedding.join(",")}]`;
    const kbResult = await pool.query(
      `SELECT question, answer, (embedding <=> $2) AS distance
       FROM kb_entries
       WHERE customer_id = $1
       ORDER BY embedding <=> $2
       LIMIT 3`,
      [session.customerId, embeddingStr]
    );

    voiceTrace(log, "pipeline.rag.kb_hit", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      exotel_call_session_id: session.callSessionDbId,
      rows: kbResult.rows.length,
      top_distances: kbResult.rows.map((r: { distance?: number }) => r.distance),
    });

    if (kbResult.rows.length === 0) {
      const noKbAnswer =
        "I don't have enough information to answer that question.";
      voiceTrace(log, "pipeline.rag.kb_miss", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        exotel_call_session_id: session.callSessionDbId,
      });
      await appendVoiceTurnToChat(session, question, noKbAnswer, {
        assistantSource: "kb-empty",
      });
      logVoiceStage(log, "rag.kb_miss", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
      });
      return {
        answer: noKbAnswer,
        source: "none",
        session_id: session.chatSessionId || "",
      };
    }

    // Build context
    const context = kbResult.rows
      .map((m: any, i: number) => `Q${i + 1}: ${m.question}\nA${i + 1}: ${m.answer}`)
      .join("\n\n");

    // Get chat history
    const { decrypt } = await import("../services/crypto");
    const historyResult = await pool.query(
      `SELECT role, content FROM chat_messages
       WHERE session_id = $1 ORDER BY created_at ASC`,
      [session.chatSessionId]
    );
    const history = historyResult.rows.map((r: any) => ({
      role: r.role,
      content: decrypt(r.content),
    }));

    // Build RAG prompt
    // ──────────────────────────────────────────────────────────────
    // TEMPORARY FIX: When VOICEBOT_MULTILINGUAL=false, add English-only
    // instruction so LLM never responds in a non-English language.
    // TODO: Remove the English-only rule when multilingual is enabled.
    // ──────────────────────────────────────────────────────────────
    const languageRule = env.voicebotMultilingual
      ? ""                                                              // Multi-language: no restriction
      : "\n- ALWAYS respond in English regardless of the question language."; // English-only
    const ragRules = `--- RAG rules ---
- Answer using ONLY information from the KNOWLEDGEBASE below.
- Keep answers SHORT and conversational — suitable for voice/phone.
- Avoid bullet points and complex formatting; speak naturally.
- Use ANSWER_NOT_FOUND only when no passage answers the question.${languageRule}`;

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      {
        role: "system",
        content: `${agentPrompt}\n\n${ragRules}\n\n--- KNOWLEDGEBASE ---\n${context}\n--- END ---`,
      },
      ...history.map((h: any) => ({ role: h.role, content: h.content })),
      { role: "user", content: question },
    ];

    voiceTrace(log, "pipeline.rag.llm_request", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      exotel_call_session_id: session.callSessionDbId,
      history_messages: messages.length,
      system_chars: messages[0]?.content?.length ?? 0,
      user_preview: question.slice(0, 300),
    });

    // Call OpenAI (faster for voice)
    const llmResult = await chatOpenAI(messages, 150);
    const answer = llmResult.answer.trim() || "I'm sorry, I couldn't find an answer.";
    logVoiceStage(log, "rag.llm.done", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      provider: "openai",
      answer_chars: answer.length,
      cost_usd: llmResult.costUsd,
    });

    voiceTrace(log, "pipeline.rag.llm_response", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      exotel_call_session_id: session.callSessionDbId,
      answer_preview: answer.slice(0, 400),
      cost_usd: llmResult.costUsd,
    });

    await appendVoiceTurnToChat(session, question, answer, {
      assistantSource: "openai",
      openaiCostUsd: llmResult.costUsd,
    });

    return {
      answer,
      source: "openai",
      session_id: session.chatSessionId || "",
    };
  } catch (err) {
    log?.error({ err }, "voicebot ask pipeline error");
    voiceTrace(log, "pipeline.rag.error", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      err: String(err),
    });
    logVoiceStage(log, "rag.exception", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      err: String(err),
    }, "voicebot RAG pipeline failed");
    return null;
  }
}

// ============================================================
// Route Registration
// ============================================================

export async function exotelVoicebotRoutes(app: FastifyInstance): Promise<void> {
  // ---- HTTPS Bootstrap route ----
  // Returns { url: "wss://..." } for Exotel to connect to.
  app.get<{ Params: { customerId: string } }>(
    "/exotel/voicebot/bootstrap/:customerId",
    async (request, reply) => {
      const { customerId } = request.params;

      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(customerId)) {
        return reply.status(400).send({ error: "Invalid customer ID format" });
      }

      const settings = await getExotelSettings(customerId);
      if (!settings || !settings.is_enabled) {
        return reply.status(404).send({ error: "Voicebot not configured for this tenant" });
      }

      const { voicebot_wss_url: wssUrl } = voicebotUrlsForCustomer(customerId, request);

      return reply.send({ url: wssUrl });
    }
  );

  // ---- Health check for Voicebot WebSocket system ----
  app.get("/exotel/voicebot/status", async (_request, reply) => {
    return reply.send({
      status: "ok",
      active_sessions: getActiveSessionCount(),
      timestamp: new Date().toISOString(),
    });
  });

  // ---- WebSocket endpoint — per-tenant ----
  // Exotel connects here for each call (one WS connection per call).
  app.get<{ Params: { customerId: string } }>(
    "/exotel/voicebot/:customerId",
    { websocket: true },
    async (socket: WebSocket, request) => {
      const { customerId } = request.params;
      const log = request.log;

      log.info({ customerId }, "exotel voicebot connection attempt");

      // ---- Validate tenant ----
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(customerId)) {
        log.warn({ customerId }, "invalid customer ID in voicebot WSS URL");
        socket.close(4400, "Invalid customer ID format");
        return;
      }

      let settings: ExotelSettings | null;
      try {
        settings = await getExotelSettings(customerId);
      } catch (err) {
        log.error({ err }, "failed to load exotel settings");
        socket.close(4500, "Internal error");
        return;
      }

      if (!settings || !settings.is_enabled) {
        log.warn({ customerId }, "voicebot not enabled for tenant");
        socket.close(4404, "Voicebot not configured");
        return;
      }

      log.info({ customerId }, "exotel voicebot connection accepted");

      // ---- State for this connection ----
      let session: VoicebotSession | null = null;
      let vadTimer: ReturnType<typeof setTimeout> | null = null;
      let isProcessing = false;
      let sawMediaBeforeStart = false;

      // ---- Message handler ----
      socket.on("message", async (rawData: Buffer | string) => {
        const raw = typeof rawData === "string" ? rawData : rawData.toString("utf-8");
        const msg = parseExotelMessage(raw);

        if (!msg) {
          log.warn({ raw: raw.slice(0, 200) }, "voicebot: unparseable message");
          return;
        }

        voiceTrace(log, "exotel.in", {
          customerId,
          stream_sid: session?.streamSid,
          call_sid: session?.callSid,
          exotel_call_session_id: session?.callSessionDbId,
          chat_session_id: session?.chatSessionId,
          raw_utf8_bytes: raw.length,
          payload: redactInboundExotelForLog(msg as unknown as Record<string, unknown>),
        });

        try {
          switch (msg.event) {
            // ---- connected ----
            case "connected":
              voiceTrace(log, "exotel.in.connected", { customerId });
              log.info("voicebot: Exotel connected");
              break;

            // ---- start ----
            case "start": {
              const startMsg = msg as ExotelStartMessage;
              const details = startMsg.start;

              session = createSession({
                streamSid: details.stream_sid,
                callSid: details.call_sid,
                customerId,
                accountSid: details.account_sid,
                from: details.from,
                to: details.to,
                mediaFormat: {
                  ...details.media_format,
                  sample_rate: parseInt(String(details.media_format.sample_rate), 10) || 8000,
                },
                customParameters: details.custom_parameters,
              });

              log.info({
                stream_sid: details.stream_sid,
                call_sid: details.call_sid,
                from: details.from,
                to: details.to,
                sample_rate: details.media_format.sample_rate,
                encoding: details.media_format.encoding,
              }, "voicebot: stream started");
              logVoiceStage(log, "call.started", {
                customerId,
                stream_sid: details.stream_sid,
                call_sid: details.call_sid,
                sample_rate: details.media_format.sample_rate,
                encoding: details.media_format.encoding,
              });

              // One chat_sessions row for this call; link via exotel_call_sessions.chat_session_id
              try {
                await bootstrapVoicebotChatSession(session, log);
                session.callSessionDbId = await createCallSession({
                  customerId,
                  callSid: details.call_sid,
                  streamSid: details.stream_sid,
                  direction: "inbound",
                  fromNumber: details.from,
                  toNumber: details.to,
                  chatSessionId: session.chatSessionId,
                  metadata: {
                    media_format: details.media_format,
                    custom_parameters: details.custom_parameters,
                  },
                });
                await appendAssistantChatLine(session, session.greetingText || GREETING_TEXT, "voice_greeting");
                voiceTrace(log, "call.session_ready", {
                  customerId,
                  chat_session_id: session.chatSessionId,
                  exotel_call_session_id: session.callSessionDbId,
                  stream_sid: session.streamSid,
                  call_sid: session.callSid,
                });
              } catch (err) {
                log.error({ err }, "voicebot: failed to bootstrap chat/call session rows");
              }

              // Send greeting audio
              if (env.sarvam.apiKey) {
                logVoiceStage(log, "greeting.sending", {
                  customerId,
                  stream_sid: session.streamSid,
                  call_sid: session.callSid,
                });
                await speakToExotel(socket, session, session.greetingText || GREETING_TEXT, "en-IN", log);
                logVoiceStage(log, "greeting.sent", {
                  customerId,
                  stream_sid: session.streamSid,
                  call_sid: session.callSid,
                });
              }
              break;
            }

            // ---- media (caller audio) ----
            case "media": {
              if (!session) {
                if (!sawMediaBeforeStart) {
                  sawMediaBeforeStart = true;
                  log?.warn(
                    {
                      customerId,
                      stream_sid: (msg as ExotelMediaMessage).stream_sid,
                    },
                    "voicebot received media before start; cannot process/greet until start event arrives"
                  );
                }
                break;
              }

              const mediaMsg = msg as ExotelMediaMessage;
              const pcm = decodeBase64Pcm(mediaMsg.media.payload);

              // While agent audio is generating or Exotel has not yet ack'd playback via `mark`,
              // do not buffer inbound for STT/VAD — discard caller audio during playback.
              if (session.ttsInProgress || session.pendingMarks.size > 0) {
                break;
              }

              // --- Energy-based VAD ---
              // Exotel sends media chunks every 20ms continuously, even during silence.
              // A simple timeout-based VAD would never fire because chunks always arrive.
              // Instead, measure the audio energy (loudness) to distinguish speech from silence.
              const energy = pcmRmsEnergy(pcm);
              const isSpeech = energy > VAD_ENERGY_THRESHOLD;

              if (isSpeech) {
                // Caller is speaking — buffer this chunk
                session.inboundPcm.push(pcm);
                session.inboundBytes += pcm.length;

                // Cancel any silence timer — caller is still talking
                if (vadTimer) {
                  clearTimeout(vadTimer);
                  vadTimer = null;
                }
              } else if (session.inboundPcm.length > 0) {
                // Caller was speaking but this chunk is silent —
                // they may have paused or finished speaking.
                // Still buffer it (captures natural pauses within speech).
                session.inboundPcm.push(pcm);
                session.inboundBytes += pcm.length;

                // Start the silence timer if not already running —
                // if silence continues for VAD_SILENCE_TIMEOUT_MS, process the utterance.
                // Do NOT reset the timer on subsequent silence chunks;
                // let it count down from when silence first began.
                if (!vadTimer) {
                  vadTimer = setTimeout(async () => {
                    vadTimer = null;
                    if (!session || session.isClosing || isProcessing) return;
                    if (session.inboundPcm.length === 0) return;
                    logVoiceStage(log, "vad.timeout_triggered", {
                      customerId: session.customerId,
                      stream_sid: session.streamSid,
                      buffered_chunks: session.inboundPcm.length,
                      buffered_bytes: session.inboundBytes,
                    });

                    isProcessing = true;
                    try {
                      await processUtterance(socket, session, log);
                    } catch (err) {
                      log.error({ err }, "voicebot: utterance processing error");
                    } finally {
                      isProcessing = false;
                    }
                  }, VAD_SILENCE_TIMEOUT_MS);
                }
              }
              // else: silence and no buffered speech — caller hasn't spoken yet, ignore

              // Safety: if buffer is too large, force-process
              if (session.inboundBytes >= MAX_INBOUND_BUFFER_BYTES) {
                if (vadTimer) { clearTimeout(vadTimer); vadTimer = null; }
                if (!isProcessing) {
                  isProcessing = true;
                  try {
                    await processUtterance(socket, session, log);
                  } catch (err) {
                    log.error({ err }, "voicebot: utterance processing error");
                  } finally {
                    isProcessing = false;
                  }
                }
              }
              break;
            }

            // ---- dtmf ----
            case "dtmf": {
              if (!session) break;
              const digit = (msg as any).dtmf?.digit;
              log.info({ stream_sid: session.streamSid, digit }, "voicebot: DTMF received");
              // Future: route to agent logic if product requires keypad input
              break;
            }

            // ---- mark ----
            case "mark": {
              if (!session) break;
              const markName = (msg as any).mark?.name;
              if (markName) {
                session.pendingMarks.delete(markName);
                if (session.pendingMarks.size === 0) {
                  session.isSpeaking = false;
                  clearPlaybackMarkFallback(session);
                  // Clear any audio that arrived during playback — it's echo/crosstalk
                  session.inboundPcm = [];
                  session.inboundBytes = 0;
                  if (vadTimer) { clearTimeout(vadTimer); vadTimer = null; }
                  log?.info({
                    stream_sid: session.streamSid,
                    mark: markName,
                  }, "voicebot: playback complete, cleared inbound buffer, ready for caller speech");
                }
              }
              break;
            }

            // ---- stop ----
            case "stop": {
              const reason = (msg as any).stop?.reason || "unknown";
              log.info({
                stream_sid: session?.streamSid,
                reason,
              }, "voicebot: stream stopped");

              if (vadTimer) clearTimeout(vadTimer);

              if (session) {
                if (session.inboundBytes > 0) {
                  log?.warn(
                    {
                      stream_sid: session.streamSid,
                      pending_bytes: session.inboundBytes,
                    },
                    "voicebot call stopped with pending inbound audio; utterance may be incomplete"
                  );
                }
                // Update DB row
                if (session.callSessionDbId) {
                  await endCallSession(session.callSessionDbId, `stopped:${reason}`);
                }
                removeSession(session.streamSid);
                session = null;
              }
              break;
            }
          }
        } catch (err) {
          log.error({ err, event: msg.event }, "voicebot: message handler error");
        }
      });

      // ---- Connection close ----
      socket.on("close", (code, reason) => {
        if (vadTimer) clearTimeout(vadTimer);

        log.info({
          stream_sid: session?.streamSid,
          code,
          reason: reason?.toString(),
        }, "voicebot: WebSocket closed");

        if (session) {
          if (session.callSessionDbId) {
            endCallSession(session.callSessionDbId, `ws_closed:${code}`).catch(() => {});
          }
          removeSession(session.streamSid);
        }
      });

      // ---- Error handler ----
      socket.on("error", (err) => {
        log.error({ err, stream_sid: session?.streamSid }, "voicebot: WebSocket error");
      });
    }
  );
}
