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
  updateExotelCallSessionLanguage,
  type ExotelSettings,
} from "../services/exotel-settings";
import { voicebotUrlsForCustomer } from "../services/exotel-voice-urls";
import {
  createSession,
  removeSession,
  nextMarkName,
  getActiveSessionCount,
  getActiveSessionsForCustomer,
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
  elevenLabsSpeechToText,
  elevenLabsSttToSarvamShape,
  elevenLabsTextToSpeech,
  elevenLabsWavOutputFormat,
  pcmSampleRateFromElevenOutputFormat,
  resolveElevenLabsSttModelId,
  resolveElevenLabsTtsModelId,
  bcp47ToElevenLabsLanguage,
  buildElevenLabsRagAudioTagHintForProvider,
} from "../services/elevenlabs";
import { applyAgentVoicePersonaToSession } from "../services/voice-persona";
import {
  voiceTrace,
  safeJsonForLog,
  redactInboundExotelForLog,
  redactOutboundExotelForLog,
} from "../services/voicebot-trace";
import { getCustomerSettings, type CustomerSettings } from "../services/customer-settings";
import { createRagTrace } from "../services/rag-trace";
import {
  fireTenantWebhook,
  postSlackIncomingWebhook,
} from "../services/tenant-webhooks";

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

/** Same as `DIRECT_MATCH_THRESHOLD` in ask.ts (pgvector distance). Skips LLM on first user turn when match is strong. */
const VOICEBOT_DIRECT_KB_DISTANCE = 0.3;

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

function tenantCs(session: VoicebotSession): CustomerSettings | null {
  return session.customerSettingsSnapshot ?? null;
}

/** Whether outbound TTS can run for this session (provider key + voice id when ElevenLabs). */
function voiceTtsCanRun(session: VoicebotSession): boolean {
  const cs = tenantCs(session);
  const p = cs?.tts_provider ?? "sarvam";
  if (p === "elevenlabs") {
    return (
      !!env.elevenlabs.apiKey &&
      !!(
        session.ttsSpeaker?.trim() ||
        cs?.tts_default_speaker?.trim() ||
        env.elevenlabs.defaultVoiceId
      )
    );
  }
  return !!env.sarvam.apiKey;
}

/** Human-readable reason when `voiceTtsCanRun` is false (for ops logs). */
function voiceTtsBlockingReason(session: VoicebotSession): string {
  const cs = tenantCs(session);
  const p = cs?.tts_provider ?? "sarvam";
  if (p === "elevenlabs") {
    if (!env.elevenlabs.apiKey) return "ELEVENLABS_API_KEY is not set";
    if (
      !(
        session.ttsSpeaker?.trim() ||
        cs?.tts_default_speaker?.trim() ||
        env.elevenlabs.defaultVoiceId
      )
    ) {
      return "no ElevenLabs voice_id (set agent tts_speaker, customer tts_default_speaker, elevenlabs avatar voice, or ELEVENLABS_DEFAULT_VOICE_ID)";
    }
    return "ElevenLabs TTS unavailable (check configuration)";
  }
  if (!env.sarvam.apiKey) return "SARVAM_API_KEY is not set";
  return "Sarvam TTS unavailable (check configuration)";
}

/** Load full `customer_settings` row onto the session (reuse `prefetched` when already loaded). */
async function applyCustomerVoiceSettingsToSession(
  session: VoicebotSession,
  prefetched?: CustomerSettings | null
): Promise<void> {
  const cs =
    prefetched !== undefined
      ? prefetched
      : await getCustomerSettings(session.customerId);
  session.customerSettingsSnapshot = cs ?? null;
  session.voicebotMultilingualEffective = cs?.voicebot_multilingual === true;
  const d = cs?.default_language_code?.trim();
  session.defaultLanguageCode = d && d.length > 0 ? d : "en-IN";
  const raw = cs?.allowed_language_codes;
  session.allowedLanguageCodes = Array.isArray(raw)
    ? raw.map((c) => String(c).trim()).filter((x) => x.length > 0)
    : [];
  const m = cs?.llm_max_tokens != null ? Number(cs.llm_max_tokens) : 150;
  session.llmMaxTokensForVoice = Math.min(512, Math.max(8, Number.isFinite(m) ? Math.floor(m) : 150));
  session.ragStreamingForVoice = cs?.rag_streaming_enabled === true;
  const lt = cs?.llm_temperature != null ? Number(cs.llm_temperature) : null;
  session.llmTemperatureVoice =
    lt != null && Number.isFinite(lt) ? lt : null;
  const ltp = cs?.llm_top_p != null ? Number(cs.llm_top_p) : null;
  session.llmTopPVoice =
    ltp != null && Number.isFinite(ltp) ? ltp : null;
}

function vadSilenceTimeoutMs(session: VoicebotSession): number {
  const v = tenantCs(session)?.vad_silence_timeout_ms;
  if (v != null && Number.isFinite(v) && v >= 300 && v <= 30_000) return Math.floor(v);
  return VAD_SILENCE_TIMEOUT_MS;
}

function vadEnergyThresholdForListening(session: VoicebotSession): number {
  const v = tenantCs(session)?.vad_energy_threshold;
  if (v != null && Number.isFinite(v) && v >= 50 && v <= 5000) return Math.floor(v);
  return VAD_ENERGY_THRESHOLD;
}

function maxInboundBufferBytes(session: VoicebotSession): number {
  const v = tenantCs(session)?.max_utterance_buffer_bytes;
  if (v != null && Number.isFinite(v) && v >= 64_000 && v <= 50 * 1024 * 1024) return Math.floor(v);
  return MAX_INBOUND_BUFFER_BYTES;
}

/** Minimum PCM16 mono bytes to treat as a real utterance (from `vad_min_speech_ms`). */
function minUtterancePcmBytes(session: VoicebotSession): number {
  const sr = session.mediaFormat.sample_rate;
  const ms = tenantCs(session)?.vad_min_speech_ms;
  const m = ms != null && Number.isFinite(ms) ? Math.max(50, Math.min(10_000, Number(ms))) : 200;
  return Math.max(320, Math.floor(sr * 2 * (m / 1000)));
}

function ragTopK(session: VoicebotSession): number {
  const v = tenantCs(session)?.rag_top_k;
  if (v != null && Number.isFinite(v)) return Math.min(20, Math.max(1, Math.floor(Number(v))));
  return 5;
}

function ragDirectKbDistanceThreshold(session: VoicebotSession): number {
  const v = tenantCs(session)?.rag_distance_threshold;
  if (v != null && Number.isFinite(v) && Number(v) > 0 && Number(v) < 2) return Number(v);
  return VOICEBOT_DIRECT_KB_DISTANCE;
}

function resolvedOpenAiModelForVoice(session: VoicebotSession): string | undefined {
  const cs = tenantCs(session);
  const o = cs?.llm_model_override?.trim() || cs?.openai_model?.trim();
  return o && o.length > 0 ? o : undefined;
}

function notifyCallStartFromSession(session: VoicebotSession): void {
  const cs = tenantCs(session);
  if (!cs) return;
  fireTenantWebhook(
    cs.webhook_url_call_start,
    cs.webhook_secret,
    {
      event: "call_start",
      customer_id: session.customerId,
      call_sid: session.callSid,
      stream_sid: session.streamSid,
      from: session.from,
      to: session.to,
      chat_session_id: session.chatSessionId,
      exotel_call_session_id: session.callSessionDbId,
    },
    cs.webhook_retry_attempts
  );
}

function notifyCallEndOnce(session: VoicebotSession, reason: string): void {
  if (session.callEndNotified) return;
  session.callEndNotified = true;
  notifyCallEndFromSession(session, reason);
}

function notifyCallEndFromSession(
  session: VoicebotSession,
  reason: string
): void {
  const cs = tenantCs(session);
  if (!cs) return;
  const payload: Record<string, unknown> = {
    event: "call_end",
    reason,
    customer_id: session.customerId,
    call_sid: session.callSid,
    stream_sid: session.streamSid,
    chat_session_id: session.chatSessionId,
    exotel_call_session_id: session.callSessionDbId,
  };
  if (cs.email_notify_call_end && cs.email_recipients.length > 0) {
    payload.email_notify_call_end = true;
    payload.email_recipients = cs.email_recipients;
  }
  fireTenantWebhook(
    cs.webhook_url_call_end,
    cs.webhook_secret,
    payload,
    cs.webhook_retry_attempts
  );
  void postSlackIncomingWebhook(
    cs.slack_webhook_url,
    `Voicebot call end (${reason}): ${session.callSid} · ${session.from} → ${session.to}`
  );
}

function fireTranscriptWebhookIfEnabled(
  session: VoicebotSession,
  turn: { user: string; assistant: string; source?: string }
): void {
  const cs = tenantCs(session);
  if (!cs || !cs.call_transcript_enabled) return;
  fireTenantWebhook(
    cs.webhook_url_transcript,
    cs.webhook_secret,
    {
      event: "transcript_turn",
      customer_id: session.customerId,
      call_sid: session.callSid,
      stream_sid: session.streamSid,
      exotel_call_session_id: session.callSessionDbId,
      user: turn.user,
      assistant: turn.assistant,
      assistant_source: turn.source ?? null,
    },
    cs.webhook_retry_attempts
  );
}

function trimRagHistory(
  session: VoicebotSession,
  history: { role: string; content: string }[]
): { role: string; content: string }[] {
  const cs = tenantCs(session);
  if (!cs || !cs.rag_use_history) return [];
  const maxTurns = cs.rag_history_max_turns;
  const capPairs = maxTurns != null && maxTurns > 0 ? maxTurns : 50;
  const maxMsgs = Math.min(history.length, capPairs * 2);
  return history.slice(-maxMsgs);
}

function textMatchesAnyPhrase(text: string, phrases: string[]): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  for (const p of phrases) {
    const s = String(p).trim().toLowerCase();
    if (s && t.includes(s)) return true;
  }
  return false;
}

function tryImmediateBargeInReset(
  session: VoicebotSession,
  energy: number,
  log?: FastifyRequest["log"]
): boolean {
  const cs = tenantCs(session);
  if (!cs?.barge_in_enabled || cs.barge_in_mode !== "immediate") return false;
  const th =
    cs.barge_in_energy_threshold != null && Number.isFinite(cs.barge_in_energy_threshold)
      ? Math.max(50, Math.floor(Number(cs.barge_in_energy_threshold)))
      : VAD_ENERGY_THRESHOLD;
  if (energy <= th) return false;
  if (!session.ttsInProgress && session.pendingMarks.size === 0) return false;

  voiceTrace(log, "pipeline.barge_in.immediate", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    energy,
    threshold: th,
  });
  clearPlaybackMarkFallback(session);
  session.pendingMarks.clear();
  session.isSpeaking = false;
  session.ttsInProgress = false;
  session.inboundPcm = [];
  session.inboundBytes = 0;
  return true;
}

function scheduleMaxCallDurationTimer(
  session: VoicebotSession,
  socket: WebSocket,
  log?: FastifyRequest["log"]
): void {
  const cs = tenantCs(session);
  const sec = cs?.max_call_duration_seconds;
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return;
  const ms = Math.min(24 * 3600_000, Math.max(1000, Math.floor(Number(sec) * 1000)));
  if (session.maxCallDurationTimer) {
    clearTimeout(session.maxCallDurationTimer);
    session.maxCallDurationTimer = null;
  }
  session.maxCallDurationTimer = setTimeout(() => {
    session.maxCallDurationTimer = null;
    log?.warn(
      { stream_sid: session.streamSid, max_call_duration_seconds: sec },
      "voicebot: max call duration reached"
    );
    voiceTrace(log, "call.max_duration", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      max_call_duration_seconds: sec,
    });
    notifyCallEndOnce(session, "max_call_duration");
    try {
      socket.close(1000, "max_call_duration");
    } catch {
      /* ignore */
    }
  }, ms);
}

/** Normalize to `xx-YY` (e.g. en-IN). */
function normalizeBcp47Tag(code: string): string {
  const t = code.trim();
  if (!t) return "en-IN";
  const parts = t.split(/[-_]/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
  }
  return parts[0].toLowerCase();
}

/** Non-empty allowlist; if DB list empty, use `[fallback]`. */
function normalizeAllowedLangList(
  fromSession: string[] | undefined,
  fallback: string
): string[] {
  const fb = normalizeBcp47Tag(fallback);
  const raw = fromSession?.length ? fromSession : [fb];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const n = normalizeBcp47Tag(c);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.length > 0 ? out : [fb];
}

/**
 * If Sarvam STT guesses a language outside the tenant allowlist (e.g. ta-IN),
 * snap to the tenant default so TTS/LLM stay within policy.
 */
function clampLanguageToAllowed(
  detectedRaw: string,
  allowed: string[],
  fallback: string
): string {
  if (allowed.length === 0) return normalizeBcp47Tag(fallback);
  const d = normalizeBcp47Tag(detectedRaw);
  if (allowed.includes(d)) return d;
  const primary = d.split("-")[0]?.toLowerCase() ?? "";
  const byPrimary = allowed.find(
    (a) => a.split("-")[0]?.toLowerCase() === primary
  );
  if (byPrimary) return byPrimary;
  return normalizeBcp47Tag(fallback);
}

const LANG_LABEL: Record<string, string> = {
  "en-IN": "English",
  "hi-IN": "Hindi",
  "mr-IN": "Marathi",
  "bn-IN": "Bengali",
  "gu-IN": "Gujarati",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "od-IN": "Odia",
  "pa-IN": "Punjabi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
};

function humanizeAllowedList(allowed: string[]): string {
  return allowed
    .map((c) => LANG_LABEL[c] ?? c)
    .join(", ");
}

/** Extra RAG / system rules when `voicebot_multilingual` is true (DB). */
function multilingualVoicePolicyRules(
  allowed: string[],
  defaultLang: string
): string {
  const def = normalizeBcp47Tag(defaultLang);
  const listTags = allowed.join(", ");
  const listHuman = humanizeAllowedList(allowed);
  return `
--- Voice language policy (this phone call; mandatory) ---
- You MUST reply only in these languages (tags: ${listTags}) — in practice: ${listHuman}.
- Prefer matching the user's language when it is clearly one of these. Default when ambiguous: ${def} (${LANG_LABEL[def] ?? def}).
- If the user asks to switch language (e.g. "speak Hindi", "मराठीत बोला"), comply immediately using one of the allowed languages only. Confirm briefly in the language you switched to.
- NEVER say you cannot speak, or apologize for not speaking, any language whose tag appears in the allowed list above. Just answer in that language.
- Do not use any language whose tag is not in [${listTags}]. If the user seems to use another language, reply in ${def} and briefly ask them to continue in one of: ${listHuman}.
`;
}

/** Multilingual is driven only by `customer_settings.voicebot_multilingual` (set at `start`). */
async function resolveVoicebotMultilingual(
  session: VoicebotSession
): Promise<boolean> {
  if (session.voicebotMultilingualEffective !== undefined) {
    return session.voicebotMultilingualEffective;
  }
  await applyCustomerVoiceSettingsToSession(session);
  return session.voicebotMultilingualEffective === true;
}

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
    `SELECT id, system_prompt, greeting_text, error_text, tts_pace, tts_model, tts_speaker, tts_sample_rate,
            avatar_id, elevenlabs_avatar_id
     FROM agents
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

async function loadVoicebotChatHistory(
  session: VoicebotSession
): Promise<{ role: string; content: string }[]> {
  if (!session.chatSessionId) return [];
  const { decrypt } = await import("../services/crypto");
  const historyResult = await pool.query(
    `SELECT role, content FROM chat_messages
     WHERE session_id = $1 ORDER BY created_at ASC`,
    [session.chatSessionId]
  );
  return historyResult.rows.map((r: { role: string; content: string }) => ({
    role: r.role,
    content: decrypt(r.content),
  }));
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
  fireTranscriptWebhookIfEnabled(session, {
    user: userText,
    assistant: assistantText,
    source: opts?.assistantSource ?? undefined,
  });
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
 * Convert text to PCM via tenant STT settings (Sarvam or ElevenLabs), then send to Exotel.
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
    const cs = tenantCs(session);
    const ttsProvider = cs?.tts_provider ?? "sarvam";
    const exotelRate = session.mediaFormat.sample_rate;

    if (ttsProvider === "elevenlabs") {
      if (!env.elevenlabs.apiKey) {
        session.ttsInProgress = false;
        log?.error("voicebot TTS: ELEVENLABS_API_KEY not configured");
        return false;
      }
      const voiceId =
        session.ttsSpeaker?.trim() ||
        cs?.tts_default_speaker?.trim() ||
        env.elevenlabs.defaultVoiceId ||
        "";
      if (!voiceId) {
        session.ttsInProgress = false;
        log?.error(
          "voicebot TTS: ElevenLabs needs voice_id (agent/session tts_speaker, customer_settings.tts_default_speaker, or ELEVENLABS_DEFAULT_VOICE_ID)"
        );
        voiceTrace(log, "pipeline.tts.error", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          reason: "missing_elevenlabs_voice_id",
        });
        return false;
      }
      const modelId = resolveElevenLabsTtsModelId(
        session.ttsModel ?? cs?.tts_model ?? null
      );
      const outputFormat = elevenLabsWavOutputFormat(exotelRate);

      logVoiceStage(log, "tts.start", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        call_sid: session.callSid,
        exotel_call_session_id: session.callSessionDbId,
        text_chars: text.length,
        languageCode,
        tts_provider: "elevenlabs",
        tts_model: modelId,
        tts_voice_id: voiceId,
        output_format: outputFormat,
      });
      voiceTrace(log, "pipeline.tts.request", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        call_sid: session.callSid,
        exotel_call_session_id: session.callSessionDbId,
        text_chars: text.length,
        text_preview: text.slice(0, 400),
        languageCode,
        tts_provider: "elevenlabs",
        tts_model: modelId,
        tts_voice_id: voiceId,
        output_format: outputFormat,
        exotel_stream_sample_rate: exotelRate,
      });

      const elTts = await elevenLabsTextToSpeech({
        voiceId,
        text: text.slice(0, 2500),
        modelId,
        outputFormat,
        voiceSettings: session.elevenlabsVoiceSettings ?? null,
      });

      if (elTts.status !== 200) {
        session.ttsInProgress = false;
        log?.error(
          { status: elTts.status, body: safeJsonForLog(elTts.body) },
          "voicebot ElevenLabs TTS failed"
        );
        voiceTrace(log, "pipeline.tts.error", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          status: elTts.status,
          body: safeJsonForLog(elTts.body),
          tts_provider: "elevenlabs",
        });
        logVoiceStage(
          log,
          "tts.error",
          {
            customerId: session.customerId,
            stream_sid: session.streamSid,
            status: elTts.status,
          },
          "voicebot ElevenLabs TTS failed"
        );
        return false;
      }

      let pcmOut = elTts.body as Buffer;
      if (!Buffer.isBuffer(pcmOut) || pcmOut.length === 0) {
        session.ttsInProgress = false;
        log?.error("voicebot ElevenLabs TTS returned empty body");
        return false;
      }

      voiceTrace(log, "pipeline.tts.response", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        pcm_bytes: pcmOut.length,
        tts_provider: "elevenlabs",
        content_type: elTts.contentType ?? null,
      });

      const parsedEl = parseWavPcm16Mono(pcmOut);
      let srcRate: number;
      if (parsedEl) {
        pcmOut = parsedEl.pcm;
        srcRate = parsedEl.sampleRate;
      } else {
        log?.warn(
          {
            stream_sid: session.streamSid,
            output_format: outputFormat,
            content_type: elTts.contentType ?? null,
            first_bytes: pcmOut.subarray(0, 16).toString("hex"),
            body_len: pcmOut.length,
          },
          "voicebot: ElevenLabs TTS was not a PCM WAV; treating as raw s16le from output_format"
        );
        srcRate = pcmSampleRateFromElevenOutputFormat(outputFormat);
      }
      if (srcRate !== exotelRate) {
        voiceTrace(log, "pipeline.tts.resample", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          pcm_bytes_before: pcmOut.length,
          from_sample_rate: srcRate,
          to_sample_rate: exotelRate,
        });
        pcmOut = resamplePcm16(pcmOut, srcRate, exotelRate);
      }

      sendAudioToExotel(ws, session, pcmOut, log);
      session.ttsInProgress = false;
      schedulePlaybackMarkFallback(session, pcmOut.length, exotelRate, log);
      logVoiceStage(log, "tts.sent_to_exotel", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        pcm_bytes: pcmOut.length,
        exotel_sample_rate: exotelRate,
        tts_provider: "elevenlabs",
      });
      return true;
    }

    const tenantCodec =
      cs?.tts_output_codec === "mp3" || cs?.tts_output_codec === "wav"
        ? cs.tts_output_codec
        : "wav";
    const codec = tenantCodec === "mp3" ? "wav" : tenantCodec;
    if (tenantCodec === "mp3") {
      voiceTrace(log, "pipeline.tts.codec_downgrade", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        requested: "mp3",
        using: "wav",
        note: "Exotel PCM path requires WAV from Sarvam",
      });
    }
    const ttsPayload: SarvamTtsBody = {
      text: text.slice(0, 2500),
      target_language_code: languageCode,
      model:
        session.ttsModel?.trim() ||
        cs?.tts_model?.trim() ||
        env.sarvam.ttsModel ||
        "bulbul:v2",
      speech_sample_rate: (
        session.ttsSampleRate ||
        cs?.tts_default_sample_rate ||
        parseInt(env.sarvam.ttsSpeechSampleRate, 10) ||
        22050
      ).toString(),
      output_audio_codec: codec,
    };
    if (session.ttsSpeaker?.trim()) {
      ttsPayload.speaker = session.ttsSpeaker.trim();
    } else if (cs?.tts_default_speaker?.trim()) {
      ttsPayload.speaker = cs.tts_default_speaker.trim();
    } else if (env.sarvam.ttsSpeaker) {
      ttsPayload.speaker = env.sarvam.ttsSpeaker;
    }

    const pace =
      session.ttsPace ??
      (cs?.tts_default_pace != null ? Number(cs.tts_default_pace) : null) ??
      env.sarvam.ttsPace;
    if (pace != null && !Number.isNaN(pace)) {
      ttsPayload.pace = pace;
    }
    const pitch =
      cs?.tts_default_pitch != null ? Number(cs.tts_default_pitch) : null;
    if (pitch != null && Number.isFinite(pitch)) {
      ttsPayload.pitch = pitch;
    }
    const loudness =
      cs?.tts_default_loudness != null ? Number(cs.tts_default_loudness) : null;
    if (loudness != null && Number.isFinite(loudness)) {
      ttsPayload.loudness = loudness;
    }

    logVoiceStage(log, "tts.start", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      call_sid: session.callSid,
      exotel_call_session_id: session.callSessionDbId,
      text_chars: text.length,
      languageCode,
      speech_sample_rate: ttsPayload.speech_sample_rate,
      tts_model: ttsPayload.model,
      tts_speaker: ttsPayload.speaker ?? null,
      tts_pace: ttsPayload.pace ?? null,
      tts_output_codec: ttsPayload.output_audio_codec ?? null,
    });
    voiceTrace(log, "pipeline.tts.request", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      call_sid: session.callSid,
      exotel_call_session_id: session.callSessionDbId,
      text_chars: text.length,
      text_preview: text.slice(0, 400),
      languageCode,
      speech_sample_rate: ttsPayload.speech_sample_rate,
      tts_model: ttsPayload.model,
      tts_speaker: ttsPayload.speaker ?? null,
      tts_pace: ttsPayload.pace ?? null,
      tts_pitch: ttsPayload.pitch ?? null,
      tts_loudness: ttsPayload.loudness ?? null,
      tts_output_codec: ttsPayload.output_audio_codec ?? null,
      exotel_stream_sample_rate: session.mediaFormat.sample_rate,
    });

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
      tts_provider: "sarvam",
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

/** Index of last char of a speakable slice, or -1 (buffer more). */
function findNextSpeakCut(s: string): number {
  if (s.length === 0) return -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch && ".!?\n।".includes(ch)) {
      if (i === s.length - 1 || /\s/.test(s[i + 1]!)) return i;
    }
  }
  if (s.length >= 140) {
    const lim = 100;
    const sp = s.lastIndexOf(" ", lim);
    if (sp > 30) return sp - 1;
    return lim - 1;
  }
  return -1;
}

/**
 * Buffers LLM token deltas and calls `speakToExotel` per sentence (or ~100 chars) so audio can start before the full reply finishes.
 */
function createStreamingVoiceTts(
  ws: WebSocket,
  session: VoicebotSession,
  ttsLanguage: string,
  log?: FastifyRequest["log"]
) {
  let buffer = "";
  return {
    async pushDelta(text: string): Promise<void> {
      buffer += text;
      for (;;) {
        const cut = findNextSpeakCut(buffer);
        if (cut < 0) break;
        const piece = buffer.slice(0, cut + 1).trim();
        buffer = buffer.slice(cut + 1).replace(/^\s+/, "");
        if (piece.length > 0) {
          await speakToExotel(ws, session, piece, ttsLanguage, log);
        }
      }
    },
    async flushRest(): Promise<void> {
      const rest = buffer.trim();
      buffer = "";
      if (rest.length > 0) {
        await speakToExotel(ws, session, rest, ttsLanguage, log);
      }
    },
  };
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
  if (session.greetingPending) {
    voiceTrace(log, "pipeline.defer_until_greeting", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      dropped_pcm_chunks: session.inboundPcm.length,
      dropped_bytes: session.inboundBytes,
    });
    session.inboundPcm = [];
    session.inboundBytes = 0;
    return;
  }
  const utteranceStartedAt = Date.now();

  // Grab all accumulated PCM and reset
  const pcmChunks = session.inboundPcm;
  session.inboundPcm = [];
  session.inboundBytes = 0;

  const combinedPcm = Buffer.concat(pcmChunks);
  const minBytes = minUtterancePcmBytes(session);
  if (combinedPcm.length < minBytes) {
    voiceTrace(log, "pipeline.skip_short_utterance", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      pcm_bytes: combinedPcm.length,
      min_required: minBytes,
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

  const multilingual = await resolveVoicebotMultilingual(session);
  if (session.llmMaxTokensForVoice === undefined) {
    await applyCustomerVoiceSettingsToSession(session);
  }
  const allowedNorm = normalizeAllowedLangList(
    session.allowedLanguageCodes,
    session.defaultLanguageCode || "en-IN"
  );

  const csUtterance = tenantCs(session);
  const sttProvider = csUtterance?.stt_provider ?? "sarvam";

  voiceTrace(log, "pipeline.stt.request", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    call_sid: session.callSid,
    exotel_call_session_id: session.callSessionDbId,
    wav_pcm_bytes: combinedPcm.length,
    sample_rate: session.mediaFormat.sample_rate,
    stt_provider: sttProvider,
  });

  try {
    // === Step 1: STT ===
    const wavBuffer = createWavBuffer(combinedPcm, session.mediaFormat.sample_rate);

    const sttLanguageHint = multilingual
      ? undefined
      : "en-IN";

    let stt: { status: number; body: unknown };

    if (sttProvider === "elevenlabs") {
      if (!env.elevenlabs.apiKey) {
        log?.error("voicebot STT: ELEVENLABS_API_KEY not configured");
        await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log);
        return;
      }
      const elModel = resolveElevenLabsSttModelId(csUtterance?.stt_model);
      const elLang = multilingual
        ? undefined
        : bcp47ToElevenLabsLanguage("en-IN", {
            multilingual: false,
            forceEnglish: true,
          });
      try {
        stt = await elevenLabsSpeechToText({
          fileBuffer: wavBuffer,
          filename: "utterance.wav",
          modelId: elModel,
          languageCode: elLang,
        });
      } catch (err) {
        log?.error({ err }, "voicebot ElevenLabs STT failed");
        await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log);
        return;
      }
    } else {
      if (!env.sarvam.apiKey) {
        log?.error("voicebot STT: SARVAM_API_KEY not configured");
        await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log);
        return;
      }
      const sttModel = csUtterance?.stt_model?.trim() || "saaras:v3";
      try {
        stt = await sarvamSpeechToText({
          fileBuffer: wavBuffer,
          filename: "utterance.wav",
          mimeType: "audio/wav",
          model: sttModel,
          mode: "transcribe",
          language_code: sttLanguageHint,
        });
      } catch (err) {
        log?.error({ err }, "voicebot Sarvam STT failed");
        await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log);
        return;
      }
    }

    if (stt.status !== 200) {
      log?.error({ status: stt.status, body: safeJsonForLog(stt.body) }, "voicebot STT failed");
      voiceTrace(log, "pipeline.stt.error", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        status: stt.status,
        body: safeJsonForLog(stt.body),
        stt_provider: sttProvider,
      });
      await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log);
      return;
    }

    let transcript: string;
    let detectedRaw: string;
    if (sttProvider === "elevenlabs") {
      const shaped = elevenLabsSttToSarvamShape(stt.body);
      transcript = shaped.transcript;
      detectedRaw = shaped.language_code;
    } else {
      const sttBody = stt.body as { transcript?: string; language_code?: string };
      transcript = sttBody.transcript?.trim() || "";
      detectedRaw = sttBody.language_code || "en-IN";
    }
    const effectiveLanguage = multilingual
      ? clampLanguageToAllowed(
          detectedRaw,
          allowedNorm,
          session.defaultLanguageCode || "en-IN"
        )
      : "en-IN";
    session.effectiveSttLanguageThisTurn = effectiveLanguage;
    await applyAgentVoicePersonaToSession(session);
    if (session.callSessionDbId) {
      void updateExotelCallSessionLanguage(
        session.callSessionDbId,
        effectiveLanguage
      ).catch(() => {});
    }
    logVoiceStage(log, "stt.done", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      language: effectiveLanguage,
      stt_detected: detectedRaw,
      transcript_chars: transcript?.length ?? 0,
    });

    voiceTrace(log, "pipeline.stt.response", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      call_sid: session.callSid,
      exotel_call_session_id: session.callSessionDbId,
      transcript: transcript || "",
      language: effectiveLanguage,
      stt_detected_raw: detectedRaw,
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
      language: effectiveLanguage,
      stt_detected_raw: detectedRaw,
    }, "voicebot STT result");

    voiceTrace(log, "pipeline.rag.start", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      exotel_call_session_id: session.callSessionDbId,
      question_preview: transcript.slice(0, 500),
    });

    // TTS language for this turn (also used for incremental TTS when RAG streaming is on)
    const ttsLanguage = multilingual
      ? mapToTtsLanguage(effectiveLanguage)
      : "en-IN";

    const csTurn = tenantCs(session);
    if (
      csTurn?.stop_words?.length &&
      textMatchesAnyPhrase(transcript, csTurn.stop_words)
    ) {
      voiceTrace(log, "pipeline.stop_word", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        transcript_preview: transcript.slice(0, 200),
      });
      return;
    }
    if (
      csTurn?.end_call_keywords?.length &&
      textMatchesAnyPhrase(transcript, csTurn.end_call_keywords)
    ) {
      const bye =
        csTurn.handoff_to_human_enabled && csTurn.human_agent_transfer_number
          ? "Thank you for calling. Connecting you to a team member now."
          : "Thank you for calling. Goodbye.";
      voiceTrace(log, "pipeline.end_call_keyword", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        transcript_preview: transcript.slice(0, 200),
      });
      await appendVoiceTurnToChat(session, transcript, bye, {
        assistantSource: "end_call_keyword",
      });
      await speakToExotel(ws, session, bye, ttsLanguage, log);
      return;
    }

    const streamToCall =
      session.ragStreamingForVoice === true
        ? { ws, ttsLanguage }
        : undefined;

    // === Step 2: Run RAG/Ask Pipeline ===
    const askResult = await runVoicebotAskPipeline(
      session,
      transcript,
      log,
      streamToCall
    );

    if (!askResult || !askResult.answer) {
      await appendVoiceTurnToChat(session, transcript, session.errorText || ERROR_AUDIO_TEXT, {
        assistantSource: "pipeline_error",
      });
      await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, effectiveLanguage, log);
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

    // === Step 3: TTS + Send (skip if RAG already streamed audio sentence-by-sentence) ===
    if (!askResult.spokeIncrementally) {
      await speakToExotel(ws, session, askResult.answer, ttsLanguage, log);
    }
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
  log?: FastifyRequest["log"],
  streamCall?: { ws: WebSocket; ttsLanguage: string }
): Promise<{
  answer: string;
  source: string;
  session_id: string;
  /** True when TTS was already sent in chunks (RAG stream); skip final speak. */
  spokeIncrementally?: boolean;
} | null> {
  try {
    const {
      generateEmbedding,
      prepareQuestionForKbEmbedding,
      chatOpenAI,
      streamChatOpenAI,
    } = await import("../services/llm");

    let customerPrompt: string;
    let defaultFallbackInstruction: string | null;

    if (session.voiceRagCustomerCache) {
      customerPrompt = session.voiceRagCustomerCache.systemPrompt;
      defaultFallbackInstruction = session.voiceRagCustomerCache.defaultNoKb;
    } else {
      const customerResult = await pool.query(
        `SELECT system_prompt, default_no_kb_fallback_instruction FROM customers WHERE id = $1`,
        [session.customerId]
      );
      if (customerResult.rows.length === 0) return null;
      customerPrompt = customerResult.rows[0].system_prompt;
      defaultFallbackInstruction =
        customerResult.rows[0].default_no_kb_fallback_instruction;
      session.voiceRagCustomerCache = {
        systemPrompt: customerPrompt,
        defaultNoKb: defaultFallbackInstruction,
      };
    }

    const ragTrace = createRagTrace(log);
    // Overlap: translate+embed || chat history (no dependency between them)
    const embedPipeline = (async () => {
      voiceTrace(log, "pipeline.rag.embedding", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        exotel_call_session_id: session.callSessionDbId,
        question_len: question.length,
      });
      const { textForEmbedding, translatedForSearch } =
        await prepareQuestionForKbEmbedding(question, {
          multilingual: session.voicebotMultilingualEffective === true,
          languageTag: session.effectiveSttLanguageThisTurn,
          trace: ragTrace,
        });
      voiceTrace(log, "pipeline.rag.embedding_query", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        exotel_call_session_id: session.callSessionDbId,
        translated_for_search: translatedForSearch,
        original_preview: question.slice(0, 240),
        embedding_text_preview: textForEmbedding.slice(0, 240),
      });
      const embedding = await generateEmbedding(textForEmbedding, ragTrace);
      logVoiceStage(log, "rag.embedding.done", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        vector_dims: embedding.length,
      });
      return { textForEmbedding, translatedForSearch, embedding };
    })();

    await ensureVoicebotChatSessionForUtterance(session, log);
    if (!session.chatSessionId) return null;

    const historyP = loadVoicebotChatHistory(session);

    let agentPrompt = customerPrompt;
    let agentFallbackInstruction: string | null = null;
    if (session.agentId) {
      const agentResult = await pool.query(
        `SELECT system_prompt, tts_pace, tts_model, tts_speaker, tts_sample_rate, no_kb_fallback_instruction,
                avatar_id, elevenlabs_avatar_id
         FROM agents WHERE id = $1`,
        [session.agentId]
      );
      if (agentResult.rows.length > 0) {
        const row = agentResult.rows[0];
        agentPrompt = row.system_prompt;
        agentFallbackInstruction = row.no_kb_fallback_instruction;

        session.ttsPace = row.tts_pace != null ? Number(row.tts_pace) : null;
        session.ttsModel = row.tts_model;
        session.ttsSpeaker = row.tts_speaker;
        session.ttsSampleRate = row.tts_sample_rate != null ? Number(row.tts_sample_rate) : null;
        await applyAgentVoicePersonaToSession(session, {
          avatarId: row.avatar_id as string | null,
          elevenlabsAvatarId: row.elevenlabs_avatar_id as string | null,
        });
      }
    }

    const csRag = tenantCs(session);
    const noKbFallbackInstruction =
      agentFallbackInstruction?.trim() ||
      csRag?.no_kb_fallback_instruction?.trim() ||
      defaultFallbackInstruction?.trim() ||
      'respond with a polite message like "I don\'t have an answer for that right now" then ask 1-2 follow-up questions related to the conversation context to keep the discussion going and explore sales opportunities.';

    const [embedBundle, historyRaw] = await Promise.all([embedPipeline, historyP]);
    const history = trimRagHistory(session, historyRaw);
    const { embedding, textForEmbedding, translatedForSearch } = embedBundle;

    // KB vector search
    const embeddingStr = `[${embedding.join(",")}]`;
    const kbLimit = ragTopK(session);
    const kbResult = await pool.query(
      `SELECT question, answer, (embedding <=> $2) AS distance
       FROM kb_entries
       WHERE customer_id = $1
       ORDER BY embedding <=> $2
       LIMIT $3`,
      [session.customerId, embeddingStr, kbLimit]
    );

    const kbMatchesForLog = kbResult.rows.map(
      (r: { question?: string; answer?: string; distance?: number | string }, i: number) => ({
        rank: i + 1,
        distance: Number(r.distance),
        question_preview: String(r.question ?? "").slice(0, 200),
        answer_preview: String(r.answer ?? "").slice(0, 200),
      })
    );

    voiceTrace(log, "pipeline.rag.kb_hit", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      exotel_call_session_id: session.callSessionDbId,
      rows: kbResult.rows.length,
      top_distances: kbMatchesForLog.map((r) => r.distance),
      direct_kb_threshold: ragDirectKbDistanceThreshold(session),
      rag_top_k: kbLimit,
      translated_for_search: translatedForSearch,
      question_original_preview: question.slice(0, 240),
      embedding_text_preview: textForEmbedding.slice(0, 240),
      stt_language: session.effectiveSttLanguageThisTurn ?? null,
      multilingual: session.voicebotMultilingualEffective === true,
      matches: kbMatchesForLog,
    });

    if (kbResult.rows.length === 0) {
      const noKbAnswer =
        "I don't have enough information to answer that question.";
      voiceTrace(log, "pipeline.rag.kb_miss", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        exotel_call_session_id: session.callSessionDbId,
        translated_for_search: translatedForSearch,
        question_original_preview: question.slice(0, 240),
        embedding_text_preview: textForEmbedding.slice(0, 240),
        stt_language: session.effectiveSttLanguageThisTurn ?? null,
        multilingual: session.voicebotMultilingualEffective === true,
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

    const top = kbResult.rows[0] as {
      question: string;
      answer: string;
      distance: number | string;
    };
    const dist = Number(top.distance);
    const priorUserTurns = history.filter((h) => h.role === "user").length;
    const directTh = ragDirectKbDistanceThreshold(session);
    // Same as HTTP `/ask`: allow kb-direct on first user turn whenever the vector
    // match is strong. Gating this to English-only caused Hindi (etc.) to always
    // take the LLM path and often pick the wrong passage among top-k chunks.
    const canDirectKb =
      Number.isFinite(dist) && dist < directTh && priorUserTurns === 0;

    if (canDirectKb) {
      const direct = String(top.answer).trim();
      if (direct.length > 0) {
        voiceTrace(log, "pipeline.rag.kb_direct", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          exotel_call_session_id: session.callSessionDbId,
          distance: dist,
        });
        await appendVoiceTurnToChat(session, question, direct, {
          assistantSource: "kb-direct",
        });
        return {
          answer: direct,
          source: "kb-direct",
          session_id: session.chatSessionId || "",
        };
      }
    }

    // Build context
    const context = kbResult.rows
      .map((m: any, i: number) => `Q${i + 1}: ${m.question}\nA${i + 1}: ${m.answer}`)
      .join("\n\n");

    // Build RAG prompt
    // ──────────────────────────────────────────────────────────────
    const multilingual = session.voicebotMultilingualEffective === true;
    const allowedNorm = normalizeAllowedLangList(
      session.allowedLanguageCodes,
      session.defaultLanguageCode || "en-IN"
    );
    let languageRule: string;
    if (multilingual) {
      languageRule = multilingualVoicePolicyRules(
        allowedNorm,
        session.defaultLanguageCode || "en-IN"
      );
      const turn = session.effectiveSttLanguageThisTurn;
      if (turn) {
        const label = LANG_LABEL[turn] ?? turn;
        languageRule += `\n- This user turn is handled as **${turn}** (${label}) after tenant language policy; prefer that language for your reply when it matches the user's intent and KB.\n`;
      }
    } else {
      languageRule =
        "\n- ALWAYS respond in English regardless of the question language.";
    }
    const elevenLabsTagHint = buildElevenLabsRagAudioTagHintForProvider(
      csRag?.tts_provider,
      session.ttsModel ?? csRag?.tts_model ?? null
    );
    const ragRules = `--- RAG rules ---
- Answer using ONLY information from the KNOWLEDGEBASE below.
- Keep answers SHORT and conversational — suitable for voice/phone.
- Avoid bullet points and complex formatting; speak naturally.
- If no passage answers the question: ${noKbFallbackInstruction}${languageRule}${elevenLabsTagHint}`;

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

    const maxTok = session.llmMaxTokensForVoice ?? 150;
    const tTop = session.llmTopPVoice;
    const voiceRagOpts = {
      temperature: session.llmTemperatureVoice ?? 0.2,
      top_p:
        tTop != null && tTop < 1
          ? tTop
          : 0.95,
      model: resolvedOpenAiModelForVoice(session),
    };
    const useLlmStream =
      streamCall != null &&
      session.ragStreamingForVoice === true;

    if (useLlmStream) {
      voiceTrace(log, "pipeline.rag.llm_stream", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        max_tokens: maxTok,
      });
      const ttsq = createStreamingVoiceTts(
        streamCall!.ws,
        session,
        streamCall!.ttsLanguage,
        log
      );
      const llmResult = await streamChatOpenAI(
        messages,
        maxTok,
        (d) => ttsq.pushDelta(d),
        ragTrace,
        voiceRagOpts
      );
      await ttsq.flushRest();
      const answer =
        llmResult.answer.trim() || "I'm sorry, I couldn't find an answer.";

      logVoiceStage(log, "rag.llm.done", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        provider: "openai",
        mode: "stream",
        answer_chars: answer.length,
        cost_usd: llmResult.costUsd,
      });
      voiceTrace(log, "pipeline.rag.llm_response", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        exotel_call_session_id: session.callSessionDbId,
        answer_preview: answer.slice(0, 400),
        cost_usd: llmResult.costUsd,
        mode: "stream",
      });
      await appendVoiceTurnToChat(session, question, answer, {
        assistantSource: "openai",
        openaiCostUsd: llmResult.costUsd,
      });
      return {
        answer,
        source: "openai",
        session_id: session.chatSessionId || "",
        spokeIncrementally: true,
      };
    }

    const llmResult = await chatOpenAI(
      messages,
      maxTok,
      ragTrace,
      voiceRagOpts
    );
    const answer =
      llmResult.answer.trim() || "I'm sorry, I couldn't find an answer.";

    logVoiceStage(log, "rag.llm.done", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      provider: "openai",
      mode: "complete",
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

      const csBoot = await getCustomerSettings(customerId);
      if (!csBoot || !csBoot.voicebot_enabled) {
        return reply.status(403).send({ error: "Voicebot disabled for this tenant" });
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

      let csConn: CustomerSettings | null = null;
      try {
        csConn = await getCustomerSettings(customerId);
      } catch (err) {
        log.error({ err }, "failed to load customer_settings for voicebot");
        socket.close(4500, "Internal error");
        return;
      }
      if (!csConn || !csConn.voicebot_enabled) {
        log.warn({ customerId }, "voicebot disabled in customer_settings");
        socket.close(4403, "Voicebot disabled");
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

              let csStart: CustomerSettings | null = null;
              try {
                csStart = await getCustomerSettings(customerId);
              } catch (err) {
                log.error({ err }, "voicebot: customer_settings load failed on start");
                socket.close(4500, "Internal error");
                break;
              }
              if (!csStart || !csStart.voicebot_enabled) {
                log.warn({ customerId }, "voicebot start rejected: disabled");
                socket.close(4403, "Voicebot disabled");
                break;
              }
              const activeForTenant = getActiveSessionsForCustomer(customerId).length;
              if (activeForTenant >= csStart.max_concurrent_calls) {
                log.warn(
                  { customerId, activeForTenant, max: csStart.max_concurrent_calls },
                  "voicebot start rejected: concurrent limit"
                );
                socket.close(4409, "Too many concurrent calls");
                break;
              }

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
                await applyCustomerVoiceSettingsToSession(session, csStart);
                await bootstrapVoicebotChatSession(session, log);
                await applyAgentVoicePersonaToSession(session, {
                  customerSettings: csStart,
                });
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
                  voicebotMultilingual: session.voicebotMultilingualEffective,
                  defaultLanguageCode: session.defaultLanguageCode,
                  currentLanguageCode: session.defaultLanguageCode,
                });
                notifyCallStartFromSession(session);
                scheduleMaxCallDurationTimer(session, socket, log);
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

              try {
                if (voiceTtsCanRun(session)) {
                  logVoiceStage(log, "greeting.sending", {
                    customerId,
                    stream_sid: session.streamSid,
                    call_sid: session.callSid,
                  });
                  const greetingLang =
                    session.voicebotMultilingualEffective === true
                      ? session.defaultLanguageCode || "en-IN"
                      : "en-IN";
                  await speakToExotel(
                    socket,
                    session,
                    session.greetingText || GREETING_TEXT,
                    greetingLang,
                    log
                  );
                  logVoiceStage(log, "greeting.sent", {
                    customerId,
                    stream_sid: session.streamSid,
                    call_sid: session.callSid,
                  });
                } else {
                  log.warn(
                    {
                      customerId,
                      stream_sid: session.streamSid,
                      call_sid: session.callSid,
                      tts_provider: session.customerSettingsSnapshot?.tts_provider ?? "sarvam",
                      has_elevenlabs_key: !!env.elevenlabs.apiKey,
                      agent_tts_speaker: session.ttsSpeaker?.trim() || null,
                      customer_tts_default_speaker:
                        session.customerSettingsSnapshot?.tts_default_speaker?.trim() || null,
                      env_default_voice_id: env.elevenlabs.defaultVoiceId ?? null,
                      reason: voiceTtsBlockingReason(session),
                    },
                    "voicebot: greeting audio skipped — outbound TTS not configured"
                  );
                  logVoiceStage(log, "greeting.skipped_no_tts", {
                    customerId,
                    stream_sid: session.streamSid,
                    call_sid: session.callSid,
                    reason: voiceTtsBlockingReason(session),
                  });
                }
              } finally {
                session.greetingPending = false;
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

              const energy = pcmRmsEnergy(pcm);
              // While agent audio is generating or Exotel has not yet ack'd playback via `mark`,
              // discard inbound unless immediate barge-in clears playback state.
              if (session.ttsInProgress || session.pendingMarks.size > 0) {
                if (!tryImmediateBargeInReset(session, energy, log)) {
                  break;
                }
              }

              // --- Energy-based VAD ---
              // Exotel sends media chunks every 20ms continuously, even during silence.
              // A simple timeout-based VAD would never fire because chunks always arrive.
              // Instead, measure the audio energy (loudness) to distinguish speech from silence.
              const isSpeech = energy > vadEnergyThresholdForListening(session);

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
                // if silence continues for tenant VAD timeout, process the utterance.
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
                  }, vadSilenceTimeoutMs(session));
                }
              }
              // else: silence and no buffered speech — caller hasn't spoken yet, ignore

              // Safety: if buffer is too large, force-process
              if (session.inboundBytes >= maxInboundBufferBytes(session)) {
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
                notifyCallEndOnce(session, `stopped:${reason}`);
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
          notifyCallEndOnce(session, `ws_closed:${code}`);
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
