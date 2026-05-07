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
import fs from "fs";
import path from "path";
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
  extractOutboundSessionIdFromCustomParameters,
  waitForOutboundCalleeAnswered,
} from "../services/exotel-outbound-flow";
import {
  createSession,
  removeSession,
  nextMarkName,
  getActiveSessionCount,
  getActiveSessionsForCustomer,
  type VoicebotSession,
} from "../services/voicebot-session";
import {
  pickFillerAckPhrase,
  isFillerOnlyTranscript,
} from "../services/voice-filler-acks";
import {
  decodeBase64Pcm,
  encodeBase64Pcm,
  PcmChunkBuffer,
  isLikelyMp3Buffer,
  parseWavPcm16Mono,
  parseWavToPcmS16leMono,
  pcmDurationMs,
  resamplePcm16,
  crossfadePcm16MonoUtteranceJoin,
} from "../services/pcm-audio";
import {
  sarvamSpeechToText,
  sarvamSpeechToTextWebsocket,
  sarvamSttWebsocketModelSupported,
  sarvamTextToSpeech,
  sarvamTextToSpeechStream,
  sarvamTtsStreamIncremental,
  type SarvamTtsBody,
} from "../services/sarvam";
import {
  elevenLabsSpeechToText,
  elevenLabsSttToSarvamShape,
  elevenLabsTextToSpeech,
  elevenLabsTextToSpeechStream,
  elevenLabsTextToSpeechStreamIncremental,
  pcmSampleRateFromElevenOutputFormat,
  resolveElevenLabsSttModelId,
  resolveElevenLabsTtsModelId,
  elevenLabsTtsModelIsV3,
  elevenLabsTtsOutputFormatForTelephony,
  bcp47ToElevenLabsLanguage,
  buildElevenLabsRagAudioTagHintForProvider,
  ELEVENLABS_BUILTIN_INDIAN_MULTILINGUAL_VOICE_ID,
  ELEVENLABS_PREMADE_API_SAFE_VOICE_ID,
  elevenLabsTtsIsLibraryOrPaymentError,
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
import { relaxAgentPrompt } from "../services/rag-prompt-utils";
import { correctUtteranceWithOpenAI } from "../services/llm";
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

/**
 * In-memory cache for pre-rendered greeting PCM audio. Key is
 * `${customerId}:${greetingText}:${ttsProvider}:${ttsSpeaker}:${lang}:${sampleRate}`.
 * Avoids a full TTS round-trip on every new call for the same tenant/agent.
 */
const greetingPcmCache = new Map<string, { pcm: Buffer; ts: number }>();
const GREETING_CACHE_TTL_MS = 3600_000; // 1 hour

function getGreetingCacheKey(
  customerId: string,
  text: string,
  provider: string,
  speaker: string,
  lang: string,
  sampleRate: number
): string {
  return `${customerId}:${text.slice(0, 200)}:${provider}:${speaker}:${lang}:${sampleRate}`;
}

function getCachedGreetingPcm(key: string): Buffer | null {
  const entry = greetingPcmCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > GREETING_CACHE_TTL_MS) {
    greetingPcmCache.delete(key);
    return null;
  }
  return entry.pcm;
}

function setCachedGreetingPcm(key: string, pcm: Buffer): void {
  greetingPcmCache.set(key, { pcm, ts: Date.now() });
  if (greetingPcmCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of greetingPcmCache) {
      if (now - v.ts > GREETING_CACHE_TTL_MS) greetingPcmCache.delete(k);
    }
  }
}

/**
 * After the first greeting plays for a tenant, generate and cache the PCM in the background
 * so subsequent calls for the same tenant get instant greetings. Fire-and-forget.
 */
async function preWarmGreetingCache(
  session: VoicebotSession,
  text: string,
  languageCode: string,
  cacheKey: string,
  log?: FastifyRequest["log"]
): Promise<void> {
  try {
    const cs = tenantCs(session);
    const ttsProvider = cs?.tts_provider ?? "sarvam";
    const exotelRate = session.mediaFormat.sample_rate;

    if (ttsProvider === "elevenlabs") return; // ElevenLabs caching would need voice_id alignment

    const ttsPayload: SarvamTtsBody = {
      text: text.slice(0, 2500),
      target_language_code: languageCode,
      model: session.ttsModel?.trim() || cs?.tts_model?.trim() || env.sarvam.ttsModel || "bulbul:v2",
      speech_sample_rate: exotelRate.toString(),
      output_audio_codec: "wav",
    };
    if (session.ttsSpeaker?.trim()) ttsPayload.speaker = session.ttsSpeaker.trim();
    else if (cs?.tts_default_speaker?.trim()) ttsPayload.speaker = cs.tts_default_speaker.trim();
    else if (env.sarvam.ttsSpeaker) ttsPayload.speaker = env.sarvam.ttsSpeaker;

    const pace = session.ttsPace ?? (cs?.tts_default_pace != null ? Number(cs.tts_default_pace) : null) ?? env.sarvam.ttsPace;
    if (pace != null && !Number.isNaN(pace)) ttsPayload.pace = pace;

    const rest = await sarvamTextToSpeech(ttsPayload);
    if (rest.status !== 200) return;
    const b64 = (rest.body as { audios?: string[] })?.audios?.[0];
    if (!b64) return;
    const wavBuf = Buffer.from(b64, "base64");
    const parsed = parseWavToPcmS16leMono(wavBuf);
    if (!parsed) return;
    let pcm = parsed.pcm;
    if (parsed.sampleRate !== exotelRate) {
      pcm = resamplePcm16(pcm, parsed.sampleRate, exotelRate);
    }
    setCachedGreetingPcm(cacheKey, pcm);
    log?.info({ customerId: session.customerId, cache_key_len: cacheKey.length, pcm_bytes: pcm.length }, "voicebot: greeting PCM cached for next call");
  } catch {
    // Best-effort; don't let cache warming break anything
  }
}

/** Same as `DIRECT_MATCH_THRESHOLD` in ask.ts (pgvector distance). Skips LLM on first user turn when match is strong. */
const VOICEBOT_DIRECT_KB_DISTANCE = 0.3;
const VOICEBOT_RELATED_SCOPE_DISTANCE_DEFAULT = 0.55;

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

/** Load pre-rendered campaign audio script from file. */
async function loadCampaignAudio(campaignId: string): Promise<Buffer | null> {
  const result = await pool.query(
    "SELECT audio_file_path FROM outbound_campaigns WHERE id = $1",
    [campaignId]
  );
  if (result.rows.length === 0 || !result.rows[0].audio_file_path) return null;
  const filePath = result.rows[0].audio_file_path;
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
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
        env.elevenlabs.defaultVoiceId ||
        env.elevenlabs.defaultIndianMultilingualVoiceId ||
        ELEVENLABS_BUILTIN_INDIAN_MULTILINGUAL_VOICE_ID
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
      return "no ElevenLabs voice_id (set agent tts_speaker, customer tts_default_speaker, elevenlabs avatar, ELEVENLABS_DEFAULT_VOICE_ID, or ELEVENLABS_DEFAULT_INDIAN_MULTILINGUAL_VOICE_ID; built-in Indian default applies when none are set)";
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
  session.ttsStreamingForVoice = cs?.tts_streaming_enabled === true;
  session.sttStreamingForVoice = cs?.stt_streaming_enabled === true;
  const lt = cs?.llm_temperature != null ? Number(cs.llm_temperature) : null;
  session.llmTemperatureVoice =
    lt != null && Number.isFinite(lt) ? lt : null;
  const ltp = cs?.llm_top_p != null ? Number(cs.llm_top_p) : null;
  session.llmTopPVoice =
    ltp != null && Number.isFinite(ltp) ? ltp : null;

  session.sttDomainWords = (cs?.stt_domain_words && typeof cs.stt_domain_words === "object")
    ? cs.stt_domain_words as Record<string, string>
    : {};
  session.industryContext = (cs?.industry_context && typeof cs.industry_context === "object")
    ? cs.industry_context as Record<string, any>
    : {};
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

function allowRelatedGeneralAnswersVoice(session: VoicebotSession): boolean {
  return tenantCs(session)?.allow_related_general_answers === true;
}

function relatedAnswerStrictnessVoice(session: VoicebotSession): string {
  return tenantCs(session)?.related_answer_strictness || "balanced";
}

function relatedScopeDistanceThresholdVoice(session: VoicebotSession): number {
  const v = tenantCs(session)?.related_scope_distance_threshold;
  if (v != null && Number.isFinite(v) && Number(v) > 0 && Number(v) < 2)
    return Number(v);
  return VOICEBOT_RELATED_SCOPE_DISTANCE_DEFAULT;
}

function outOfScopeMessageVoice(session: VoicebotSession): string {
  const custom = tenantCs(session)?.out_of_scope_message?.trim();
  if (custom) return custom;
  return "I can help with questions related to this business and its services, but I can't answer unrelated topics.";
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
  /** Voice: default 3 Q/A pairs (6 messages) to keep LLM prompt small for latency. */
  const defaultVoicePairs = 3;
  const capPairs =
    maxTurns != null && maxTurns > 0 ? maxTurns : defaultVoicePairs;
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

/** Same acceptance rule as clamp (exact tag or matching primary subtag). */
function isLanguageInAllowedList(detectedRaw: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const d = normalizeBcp47Tag(detectedRaw);
  if (allowed.includes(d)) return true;
  const primary = d.split("-")[0]?.toLowerCase() ?? "";
  return allowed.some(
    (a) => a.split("-")[0]?.toLowerCase() === primary
  );
}

function languagesLooselyEqual(a: string, b: string): boolean {
  const na = normalizeBcp47Tag(a);
  const nb = normalizeBcp47Tag(b);
  if (na === nb) return true;
  const pa = na.split("-")[0]?.toLowerCase() ?? "";
  const pb = nb.split("-")[0]?.toLowerCase() ?? "";
  return pa.length > 0 && pa === pb;
}

function persistSessionActiveLanguage(
  session: VoicebotSession,
  lang: string,
  log?: FastifyRequest["log"]
): void {
  const n = normalizeBcp47Tag(lang);
  session.currentLanguageCode = n;
  if (session.callSessionDbId) {
    void updateExotelCallSessionLanguage(session.callSessionDbId, n).catch(() => { });
  }
  voiceTrace(log, "voicebot.language.active_updated", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    call_sid: session.callSid,
    exotel_call_session_id: session.callSessionDbId,
    current_language_code: n,
  });
}

type LanguageSwitchPolicyOutcome =
  | { action: "continue" }
  | { action: "pending"; target: string; confidence: number | null };

function applyLanguageSwitchPolicy(
  session: VoicebotSession,
  params: {
    multilingual: boolean;
    nextQueryIndex: number;
    clampedDetected: string;
    detectedRaw: string;
    languageProbability: number | null;
    sttProvider: string;
    allowedNorm: string[];
    log?: FastifyRequest["log"];
  }
): LanguageSwitchPolicyOutcome {
  const {
    multilingual,
    nextQueryIndex,
    clampedDetected,
    languageProbability,
    sttProvider,
    allowedNorm,
  } = params;
  if (!multilingual) {
    return { action: "continue" };
  }
  const active = normalizeBcp47Tag(
    session.currentLanguageCode || session.defaultLanguageCode || "en-IN"
  );
  if (!isLanguageInAllowedList(clampedDetected, allowedNorm)) {
    voiceTrace(params.log, "voicebot.language.policy.detected_disallowed", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      clamped_detected: clampedDetected,
      active_language: active,
    });
    return { action: "continue" };
  }
  if (languagesLooselyEqual(clampedDetected, active)) {
    return { action: "continue" };
  }
  const conf = sttProvider === "sarvam" ? params.languageProbability : null;
  const silentOk =
    nextQueryIndex <= 2 && conf != null && conf > 0.8;
  if (silentOk) {
    persistSessionActiveLanguage(session, clampedDetected, params.log);
    voiceTrace(params.log, "voicebot.language.silent_switch_early_window", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      from: active,
      to: normalizeBcp47Tag(clampedDetected),
      query_index: nextQueryIndex,
      language_probability: conf,
    });
    return { action: "continue" };
  }
  if (nextQueryIndex <= 2) {
    voiceTrace(params.log, "voicebot.language.early_no_switch", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      active_language: active,
      detected_clamped: clampedDetected,
      language_probability: conf,
      query_index: nextQueryIndex,
    });
    return { action: "continue" };
  }
  return {
    action: "pending",
    target: normalizeBcp47Tag(clampedDetected),
    confidence: conf,
  };
}

function languageSwitchConfirmPrompt(activeTag: string, targetTag: string): string {
  return `I detected ${targetTag}. Would you like to continue in that language? Please say yes or no.`;
}

function parseLanguageSwitchConfirmation(transcript: string): "yes" | "no" | "unclear" {
  const t = transcript.trim().toLowerCase();
  if (!t) return "unclear";
  if (
    /\bhindi\b/.test(t) ||
    /\bmarathi\b/.test(t) ||
    /\benglish\b/.test(t) ||
    /\bgujarati\b/.test(t) ||
    /\bchange\b/.test(t) ||
    /\bswitch\b/.test(t)
  ) {
    return "yes";
  }
  if (
    /\bno\b/.test(t) ||
    /\bnahi\b/.test(t) ||
    /\bनहीं\b/.test(t) ||
    /\bmat\b/.test(t) ||
    /\bcancel\b/.test(t) ||
    /\bdon't\b/.test(t) ||
    /\bdo not\b/.test(t) ||
    /\bnope\b/.test(t) ||
    /\bdon't switch\b/.test(t)
  ) {
    return "no";
  }
  if (
    /\byes\b/.test(t) ||
    /\byeah\b/.test(t) ||
    /\bokay\b/.test(t) ||
    /\bok\b/.test(t) ||
    /\bsure\b/.test(t) ||
    /\bhaan\b/.test(t) ||
    /\bha\b/.test(t) ||
    /\bहाँ\b/.test(t) ||
    /\bजी\b/.test(t) ||
    /\btheek\b/.test(t) ||
    /\bthik\b/.test(t) ||
    /\bswitch\b/.test(t)
  ) {
    return "yes";
  }
  if (/^[ny]$/i.test(t)) return t === "y" || t === "Y" ? "yes" : "no";
  return "unclear";
}

/**
 * When Sarvam tags a wrong script language (e.g. gu-IN) for clear English speech, the first transcript
 * is still usually Latin. Skipping the 2nd REST rehint in that case saves ~1s+ (TTFA).
 */
function transcriptLooksLatinHeavyForRehintSkip(
  text: string,
  minRatio: number
): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  let latin = 0;
  let letters = 0;
  for (const ch of t) {
    if (/[A-Za-z]/.test(ch)) {
      latin++;
      letters++;
    } else if (/\p{L}/u.test(ch)) {
      letters++;
    }
  }
  if (letters === 0) return true;
  return latin / letters >= minRatio;
}

/**
 * True when a meaningful share of letters are non-ASCII (Indic/CJK/etc.). Rehinting those
 * utterances with en-IN/mr-IN/hi-IN often replaces a good transcript with garbage ("Result").
 */
function transcriptIsPrimarilyNonLatinScript(
  text: string,
  minNonLatinRatio: number
): boolean {
  const t = text.trim();
  if (t.length < 2) return false;
  let nonLatin = 0;
  let letters = 0;
  for (const ch of t) {
    if (/[A-Za-z]/.test(ch)) {
      letters++;
    } else if (/\p{L}/u.test(ch)) {
      letters++;
      nonLatin++;
    }
  }
  if (letters === 0) return false;
  return nonLatin / letters >= minNonLatinRatio;
}

/** Heuristic: REST rehint with a clamped language hint destroyed a longer non-Latin transcript. */
function rehintLikelyCorruptedFirstPass(first: string, retry: string): boolean {
  const a = first.trim();
  const b = retry.trim();
  if (a.length < 4 || b.length === 0) return false;
  let nonLatin = 0;
  for (const ch of a) {
    if (!/[A-Za-z]/.test(ch) && /\p{L}/u.test(ch)) nonLatin++;
  }
  if (nonLatin >= 3 && b.length < a.length * 0.35) return true;
  if (
    nonLatin >= 2 &&
    b.length <= 16 &&
    /^[A-Za-z][A-Za-z.!?,'\s-]*$/.test(b) &&
    !/\s{2,}/.test(b)
  ) {
    return true;
  }
  return false;
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
- **Grammar and fluency (non-English):** In Hindi, Marathi, or any other allowed non-English language, write **natural, grammatically correct** lines a native speaker would say on a phone call. Avoid stiff word-for-word translations from English; use correct verb forms, agreement, word order, and everyday vocabulary for that language. If the KNOWLEDGEBASE is English, still express the facts in fluent target-language sentences—do not paste broken or mixed grammar.
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
async function appendUserChatLine(
  session: VoicebotSession,
  userText: string
): Promise<void> {
  if (!session.chatSessionId || !userText || !userText.trim()) return;
  session.lastUserQuery = userText;
  const callId = exotelCallIdForMessages(session);
  const { encrypt } = await import("../services/crypto");
  const uq = [session.chatSessionId, "user", encrypt(userText), "voice", callId] as const;
  try {
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source, exotel_call_session_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [...uq]
    );
  } catch (err) {
    if (!isMissingExotelColumnError(err)) throw err;
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source) VALUES ($1, $2, $3, $4)`,
      [uq[0], uq[1], uq[2], uq[3]]
    );
  }
  await touchChatSession(session.chatSessionId);
}

async function appendVoiceTurnToChat(
  session: VoicebotSession,
  userText: string,
  assistantText: string,
  opts?: { assistantSource?: string | null; openaiCostUsd?: number | null }
): Promise<void> {
  if (!session.chatSessionId) return;

  if (userText && userText !== session.lastUserQuery) {
    appendUserChatLine(session, userText).catch(() => { });
  }
  await appendAssistantChatLine(session, assistantText, opts?.assistantSource || "voice", opts?.openaiCostUsd);

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
  source: string,
  openaiCostUsd?: number | null
): Promise<void> {
  if (!session.chatSessionId || !text) return;

  const { encrypt } = await import("../services/crypto");
  const callId = exotelCallIdForMessages(session);
  const row = [session.chatSessionId, "assistant", encrypt(text), source, openaiCostUsd ?? null, callId] as const;
  try {
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source, openai_cost_usd, exotel_call_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [...row]
    );
  } catch (err) {
    if (!isMissingExotelColumnError(err)) throw err;
    await pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source, openai_cost_usd) VALUES ($1, $2, $3, $4, $5)`,
      [row[0], row[1], row[2], row[3], row[4]]
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

function sendExotelPlaybackMark(
  ws: WebSocket,
  session: VoicebotSession,
  log?: FastifyRequest["log"]
): void {
  const ctx: VoiceTraceCtx = {
    customerId: session.customerId,
    streamSid: session.streamSid,
    callSid: session.callSid,
    exotelCallDbId: session.callSessionDbId,
  };
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

/**
 * Send PCM audio back to Exotel as base64 media frames.
 * Respects chunk sizing rules (320-byte multiples, 3.2KB–100KB).
 * Use `omitMark` for incremental TTS chunks, then call `sendExotelPlaybackMark` once after the stream.
 */
function sendAudioToExotel(
  ws: WebSocket,
  session: VoicebotSession,
  pcmBuffer: Buffer,
  log?: FastifyRequest["log"],
  options?: { omitMark?: boolean }
): void {
  const omitMark = options?.omitMark === true;
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

  if (allChunks.length > 0 && omitMark) {
    session.isSpeaking = true;
  }

  // TTFA: log time from utterance start to first outbound audio for the answer
  if (
    allChunks.length > 0 &&
    !session.ttfaLogged &&
    session.utteranceProcessingStartedAt &&
    !session.greetingPending
  ) {
    session.ttfaLogged = true;
    const ttfaMs = Date.now() - session.utteranceProcessingStartedAt;
    voiceTrace(log, "pipeline.ttfa", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      ttfa_ms: ttfaMs,
      target_ms: 2000,
      met_target: ttfaMs < 2000,
    });
    logVoiceStage(log, "ttfa.first_audio", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      ttfa_ms: ttfaMs,
    }, `voicebot TTFA: ${ttfaMs}ms${ttfaMs < 2000 ? " ✓" : " (over target)"}`);
  }

  voiceTrace(log, "exotel.out.media_batch", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    call_sid: session.callSid,
    exotel_call_session_id: session.callSessionDbId,
    pcm_in_bytes: pcmBuffer.length,
    media_chunks: allChunks.length,
    outbound_b64_chars: totalB64,
    omit_mark: omitMark,
  });

  // Send a mark after the last chunk so we know when playback completes
  if (allChunks.length > 0 && !omitMark) {
    sendExotelPlaybackMark(ws, session, log);
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

    if (ttsProvider !== "elevenlabs") {
      session.elevenlabsOutboundTailPcm = undefined;
    }

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
        env.elevenlabs.defaultIndianMultilingualVoiceId?.trim() ||
        ELEVENLABS_BUILTIN_INDIAN_MULTILINGUAL_VOICE_ID ||
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
      const useElevenLabsStream = session.ttsStreamingForVoice === true;
      const outputFormat = elevenLabsTtsOutputFormatForTelephony(
        modelId,
        exotelRate,
        { streaming: useElevenLabsStream }
      );

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

      const vs = session.elevenlabsVoiceSettings ?? null;
      const ttsBody = {
        voiceId,
        text: text.slice(0, 4000),
        modelId,
        outputFormat,
      };

      const fadeSamples = exotelRate <= 8000 ? 40 : 56;
      const tailBytes = fadeSamples * 2;
      const prevTailJoin = session.elevenlabsOutboundTailPcm;
      const pcmFormatRate = pcmSampleRateFromElevenOutputFormat(outputFormat);
      const useElIncrementalPipe =
        useElevenLabsStream && pcmFormatRate === exotelRate;

      /** Buffered TTS (`/stream` aggregates when resampling needed or non‑streaming HTTP). */
      const execElevenBuffered = () =>
        (useElevenLabsStream ? elevenLabsTextToSpeechStream : elevenLabsTextToSpeech);

      /** Parse ElevenLabs body → PCM at `pcmFormatRate` (via WAV parse or raw `output_format`). */
      async function pcmFromBufferedResponse(elTts: {
        status: number;
        body: Buffer | unknown;
        contentType?: string;
      }): Promise<
        | { ok: false; status: number; body: unknown }
        | {
          ok: true;
          pcmOut: Buffer;
          contentType: string | undefined;
        }
      > {
        if (elTts.status !== 200) {
          return { ok: false, status: elTts.status, body: elTts.body };
        }
        let pcmCandidate = elTts.body as Buffer;
        if (!Buffer.isBuffer(pcmCandidate) || pcmCandidate.length === 0) {
          return { ok: false, status: 500, body: { error: "empty_elevenlabs_tts_body" } };
        }
        voiceTrace(log, "pipeline.tts.response", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          pcm_bytes: pcmCandidate.length,
          tts_provider: "elevenlabs",
          content_type: elTts.contentType ?? null,
        });

        let pcmWork = pcmCandidate;
        let srcRateLocal: number;
        const wavParsed = parseWavPcm16Mono(pcmWork);
        if (wavParsed) {
          pcmWork = wavParsed.pcm;
          srcRateLocal = wavParsed.sampleRate;
        } else {
          log?.warn(
            {
              stream_sid: session.streamSid,
              output_format: outputFormat,
              content_type: elTts.contentType ?? null,
              first_bytes: pcmWork.subarray(0, 16).toString("hex"),
              body_len: pcmWork.length,
            },
            "voicebot: ElevenLabs TTS was not a PCM WAV; treating as raw s16le from output_format"
          );
          srcRateLocal = pcmSampleRateFromElevenOutputFormat(outputFormat);
        }
        if (srcRateLocal !== exotelRate) {
          voiceTrace(log, "pipeline.tts.resample", {
            customerId: session.customerId,
            stream_sid: session.streamSid,
            pcm_bytes_before: pcmWork.length,
            from_sample_rate: srcRateLocal,
            to_sample_rate: exotelRate,
          });
          pcmWork = resamplePcm16(pcmWork, srcRateLocal, exotelRate);
        }

        let pcmOutJoined = pcmWork;
        if (
          prevTailJoin &&
          prevTailJoin.length === tailBytes &&
          pcmOutJoined.length >= tailBytes
        ) {
          pcmOutJoined = crossfadePcm16MonoUtteranceJoin(
            prevTailJoin,
            pcmOutJoined,
            fadeSamples
          );
          voiceTrace(log, "pipeline.tts.elevenlabs_utterance_crossfade", {
            customerId: session.customerId,
            stream_sid: session.streamSid,
            fade_samples: fadeSamples,
            exotel_sample_rate: exotelRate,
          });
        }

        sendAudioToExotel(ws, session, pcmOutJoined, log);
        session.elevenlabsOutboundTailPcm =
          pcmOutJoined.length >= tailBytes
            ? Buffer.from(pcmOutJoined.subarray(pcmOutJoined.length - tailBytes))
            : pcmOutJoined.length > 0
              ? Buffer.from(pcmOutJoined)
              : undefined;
        schedulePlaybackMarkFallback(session, pcmOutJoined.length, exotelRate, log);
        logVoiceStage(log, "tts.sent_to_exotel", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          pcm_bytes: pcmOutJoined.length,
          exotel_sample_rate: exotelRate,
          tts_provider: "elevenlabs",
        });

        return { ok: true, pcmOut: pcmOutJoined, contentType: elTts.contentType };
      }

      async function pcmFromIncrementalStream(params: Parameters<
        typeof elevenLabsTextToSpeechStreamIncremental
      >[0]): Promise<
        | { ok: false; status: number; body: unknown }
        | { ok: true; totalPcmBytes: number }
      > {
        let totalBytes = 0;
        let firstChunk = true;
        let firstChunkSent = false;
        let pcmAcc = Buffer.alloc(0);

        try {
          for await (const rawPiece of elevenLabsTextToSpeechStreamIncremental(params)) {
            let pcmPiece = rawPiece;
            if (
              firstChunk &&
              prevTailJoin &&
              prevTailJoin.length === tailBytes &&
              pcmPiece.length >= tailBytes
            ) {
              pcmPiece = crossfadePcm16MonoUtteranceJoin(
                prevTailJoin,
                pcmPiece,
                fadeSamples
              );
              voiceTrace(log, "pipeline.tts.elevenlabs_utterance_crossfade", {
                customerId: session.customerId,
                stream_sid: session.streamSid,
                fade_samples: fadeSamples,
                exotel_sample_rate: exotelRate,
                streamed: true,
              });
            }
            firstChunk = false;
            pcmAcc = Buffer.concat([pcmAcc, pcmPiece]);

            if (!firstChunkSent) {
              voiceTrace(log, "pipeline.tts.first_chunk", {
                customerId: session.customerId,
                stream_sid: session.streamSid,
                chunk_bytes: pcmPiece.length,
                tts_provider: "elevenlabs",
              });
              firstChunkSent = true;
            }

            sendAudioToExotel(ws, session, pcmPiece, log, { omitMark: true });
            totalBytes += pcmPiece.length;
          }
          if (totalBytes === 0) {
            return { ok: false, status: 500, body: { error: "empty_stream" } };
          }

          session.elevenlabsOutboundTailPcm =
            pcmAcc.length >= tailBytes
              ? Buffer.from(pcmAcc.subarray(pcmAcc.length - tailBytes))
              : Buffer.from(pcmAcc);

          schedulePlaybackMarkFallback(session, totalBytes, exotelRate, log);
          sendExotelPlaybackMark(ws, session, log);
          logVoiceStage(log, "tts.sent_to_exotel", {
            customerId: session.customerId,
            stream_sid: session.streamSid,
            pcm_bytes: totalBytes,
            exotel_sample_rate: exotelRate,
            tts_provider: "elevenlabs",
            incremental_stream: true,
          });

          return { ok: true, totalPcmBytes: totalBytes };
        } catch (e: unknown) {
          const er = e as Error & { status?: number; responseBody?: unknown };
          if (typeof er.status === "number") {
            return { ok: false, status: er.status, body: er.responseBody ?? String(e) };
          }
          throw e;
        }
      }

      const runAttempt = async (params: typeof ttsBody & { voiceSettings: typeof vs }) => {
        if (useElIncrementalPipe) {
          return pcmFromIncrementalStream(params);
        }
        const el = await execElevenBuffered()(params);
        return pcmFromBufferedResponse(el);
      };

      let r = await runAttempt({ ...ttsBody, voiceId, voiceSettings: vs });
      if (!r.ok && vs) {
        voiceTrace(log, "pipeline.tts.retry", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          reason: "without_voice_settings",
          prior_status: r.status,
          eleven_v3: elevenLabsTtsModelIsV3(modelId),
        });
        r = await runAttempt({ ...ttsBody, voiceId, voiceSettings: null });
      }

      if (
        !r.ok &&
        elevenLabsTtsIsLibraryOrPaymentError(r.status, r.body) &&
        voiceId !== ELEVENLABS_PREMADE_API_SAFE_VOICE_ID
      ) {
        voiceTrace(log, "pipeline.tts.retry", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          reason: "premade_voice_free_tier",
          prior_status: r.status,
          prior_voice_id: voiceId,
          fallback_voice_id: ELEVENLABS_PREMADE_API_SAFE_VOICE_ID,
        });
        r = await runAttempt({
          ...ttsBody,
          voiceId: ELEVENLABS_PREMADE_API_SAFE_VOICE_ID,
          voiceSettings: null,
        });
      }

      if (!r.ok) {
        session.ttsInProgress = false;
        log?.error(
          { status: r.status, body: safeJsonForLog(r.body) },
          "voicebot ElevenLabs TTS failed"
        );
        voiceTrace(log, "pipeline.tts.error", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          status: r.status,
          body: safeJsonForLog(r.body),
          tts_provider: "elevenlabs",
        });
        logVoiceStage(
          log,
          "tts.error",
          {
            customerId: session.customerId,
            stream_sid: session.streamSid,
            status: r.status,
          },
          "voicebot ElevenLabs TTS failed"
        );
        return false;
      }

      session.ttsInProgress = false;
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
    const useSarvamTtsStream = session.ttsStreamingForVoice === true;
    const useLinear16TtsStream =
      useSarvamTtsStream && env.sarvam.ttsStreamLinear16;
    const useIncrementalStream =
      useLinear16TtsStream && env.sarvam.ttsIncrementalStream;
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
      sarvam_tts_path: useIncrementalStream ? "incremental_stream" : useSarvamTtsStream ? "http_stream" : "rest_json",
      sarvam_stream_linear16: useLinear16TtsStream,
    });

    // --- True incremental streaming: pipe PCM chunks to Exotel as they arrive ---
    if (useIncrementalStream) {
      try {
        let totalPcmBytes = 0;
        let firstChunkSent = false;
        for await (const chunk of sarvamTtsStreamIncremental({
          text: ttsPayload.text,
          target_language_code: ttsPayload.target_language_code,
          speaker: ttsPayload.speaker,
          model: ttsPayload.model,
          pace: ttsPayload.pace ?? null,
          speech_sample_rate: exotelRate,
          output_audio_codec: "linear16",
          pitch: ttsPayload.pitch ?? null,
          loudness: ttsPayload.loudness ?? null,
        })) {
          if (!firstChunkSent) {
            voiceTrace(log, "pipeline.tts.first_chunk", {
              customerId: session.customerId,
              stream_sid: session.streamSid,
              chunk_bytes: chunk.length,
            });
            firstChunkSent = true;
          }
          sendAudioToExotel(ws, session, chunk, log, { omitMark: true });
          totalPcmBytes += chunk.length;
        }
        session.ttsInProgress = false;
        if (totalPcmBytes === 0) {
          log?.warn({ stream_sid: session.streamSid }, "voicebot incremental TTS yielded 0 bytes");
          return false;
        }
        sendExotelPlaybackMark(ws, session, log);
        schedulePlaybackMarkFallback(session, totalPcmBytes, exotelRate, log);
        logVoiceStage(log, "tts.sent_to_exotel", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          pcm_bytes: totalPcmBytes,
          exotel_sample_rate: exotelRate,
          tts_provider: "sarvam",
          mode: "incremental_stream",
        });
        return true;
      } catch (err) {
        voiceTrace(log, "pipeline.tts.incremental_fallback", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          err: String(err),
        });
        // Fall through to legacy path on incremental stream failure
      }
    }

    let speechSrNum = Number(ttsPayload.speech_sample_rate) || 22050;
    type TtsOk = { status: number; body: unknown; b64OrRaw: "b64" | "buffer"; b64?: string; buf?: Buffer };
    let tts: TtsOk;
    if (useSarvamTtsStream) {
      const streamRes = await sarvamTextToSpeechStream({
        text: ttsPayload.text,
        target_language_code: ttsPayload.target_language_code,
        speaker: ttsPayload.speaker,
        model: ttsPayload.model,
        pace: ttsPayload.pace ?? null,
        speech_sample_rate: useLinear16TtsStream ? exotelRate : speechSrNum,
        output_audio_codec: (useLinear16TtsStream
          ? "linear16"
          : (ttsPayload.output_audio_codec || "wav")) as string,
        pitch: ttsPayload.pitch ?? null,
        loudness: ttsPayload.loudness ?? null,
      });
      if (streamRes.status !== 200 || !streamRes.audioBuffer || streamRes.audioBuffer.length === 0) {
        voiceTrace(log, "pipeline.tts.stream_fallback_rest", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
          stream_status: streamRes.status,
          reason: "retry_batch_json",
        });
        const rest = await sarvamTextToSpeech(ttsPayload);
        tts = {
          status: rest.status,
          body: rest.body,
          b64OrRaw: "b64",
          b64: (rest.body as { audios?: string[] })?.audios?.[0],
        };
      } else {
        tts = { status: 200, body: { streamed: true }, b64OrRaw: "buffer", buf: streamRes.audioBuffer };
      }
    } else {
      const rest = await sarvamTextToSpeech(ttsPayload);
      tts = {
        status: rest.status,
        body: rest.body,
        b64OrRaw: "b64",
        b64: (rest.body as { audios?: string[] })?.audios?.[0],
      };
    }

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

    let wavBuffer: Buffer;
    if (tts.b64OrRaw === "buffer" && tts.buf) {
      voiceTrace(log, "pipeline.tts.response", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        pcm_bytes: tts.buf.length,
        sarvam_tts_path: "http_stream",
      });
      wavBuffer = tts.buf;
    } else {
      const b64Audio = tts.b64;
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
        sarvam_tts_path: "rest_json",
      });

      wavBuffer = Buffer.from(b64Audio, "base64");
    }
    if (useLinear16TtsStream && tts.b64OrRaw === "buffer") {
      speechSrNum = exotelRate;
    }

    function tryDecodeSarvamAudio(buf: Buffer): { pcm: Buffer; srcRate: number } | null {
      const w = parseWavToPcmS16leMono(buf);
      if (w) return { pcm: w.pcm, srcRate: w.sampleRate };
      if (isLikelyMp3Buffer(buf)) return null;
      const isRiff =
        buf.length >= 12 &&
        buf.toString("ascii", 0, 4) === "RIFF" &&
        buf.toString("ascii", 8, 12) === "WAVE";
      if (isRiff) return null;
      // Headerless raw PCM (linear16 stream or unknown format with even byte count)
      if (buf.length > 0 && buf.length % 2 === 0) {
        return { pcm: buf, srcRate: speechSrNum };
      }
      return null;
    }

    let decoded = tryDecodeSarvamAudio(wavBuffer);
    if (!decoded) {
      // Instead of calling sarvamTextToSpeech AGAIN (double TTS), try REST once only
      // when this is the stream path. Log and skip the second attempt pattern.
      if (tts.b64OrRaw === "b64") {
        session.ttsInProgress = false;
        log?.error(
          { stream_sid: session.streamSid, bytes: wavBuffer.length },
          "voicebot TTS: could not decode audio from Sarvam REST"
        );
        return false;
      }
      voiceTrace(log, "pipeline.tts.stream_decode_failed_rest_fallback", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        bytes: wavBuffer.length,
        is_mp3: isLikelyMp3Buffer(wavBuffer),
        first_bytes: wavBuffer.subarray(0, 16).toString("hex"),
      });
      const rest = await sarvamTextToSpeech(ttsPayload);
      if (rest.status !== 200) {
        session.ttsInProgress = false;
        log?.error({ status: rest.status, body: safeJsonForLog(rest.body) }, "voicebot TTS REST fallback failed");
        return false;
      }
      const b64Audio = (rest.body as { audios?: string[] })?.audios?.[0];
      if (!b64Audio) {
        session.ttsInProgress = false;
        log?.error("voicebot TTS REST fallback returned no audio");
        return false;
      }
      wavBuffer = Buffer.from(b64Audio, "base64");
      decoded = tryDecodeSarvamAudio(wavBuffer);
    }
    if (!decoded) {
      session.ttsInProgress = false;
      log?.error(
        { stream_sid: session.streamSid, bytes: wavBuffer.length },
        "voicebot TTS: could not decode Sarvam audio (WAV/PCM/REST)"
      );
      return false;
    }
    let pcmData = decoded.pcm;
    const srcRate = decoded.srcRate;

    if (srcRate !== exotelRate) {
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
    if (ch && ".!?\n।,".includes(ch)) {
      if (i === s.length - 1 || /\s/.test(s[i + 1]!)) return i;
    }
  }
  if (s.length >= 48) {
    const lim = 48;
    const sp = s.lastIndexOf(" ", lim);
    if (sp > 12) return sp - 1;
    return lim - 1;
  }
  return -1;
}

/** Longer streaming chunks for ElevenLabs — fewer TTS round-trips (split on sentence end only, wider force-cut). */
function findNextSpeakCutElevenLabs(s: string): number {
  if (s.length === 0) return -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch && ".!?।".includes(ch)) {
      if (i === s.length - 1 || /\s/.test(s[i + 1]!)) return i;
    }
  }
  const minLen = 220;
  if (s.length >= minLen) {
    const sp = s.lastIndexOf(" ", minLen);
    if (sp > 72) return sp - 1;
    return minLen - 1;
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
  const useElevenLabsCuts =
    (tenantCs(session)?.tts_provider ?? "sarvam") === "elevenlabs";
  const cutAt = useElevenLabsCuts ? findNextSpeakCutElevenLabs : findNextSpeakCut;
  let buffer = "";
  return {
    async pushDelta(text: string): Promise<void> {
      buffer += text;
      for (; ;) {
        const cut = cutAt(buffer);
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
 * RAG + TTS path after STT produced a final `transcript` and `session.effectiveSttLanguageThisTurn` is set.
 */
async function runVoicebotReplyPipelineAfterTranscriptReady(
  ws: WebSocket,
  session: VoicebotSession,
  transcript: string,
  utteranceStartedAt: number,
  tAfterStt: number,
  multilingual: boolean,
  log?: FastifyRequest["log"]
): Promise<void> {
  const pipelineBcp = multilingual
    ? normalizeBcp47Tag(session.currentLanguageCode || session.defaultLanguageCode || "en-IN")
    : "en-IN";
  const ttsLanguage = multilingual ? mapToTtsLanguage(pipelineBcp) : "en-IN";

  log?.info(
    {
      stream_sid: session.streamSid,
      transcript,
      language: pipelineBcp,
    },
    "voicebot STT result"
  );

  if (session.isClosing) return;

  if (transcript && transcript.trim().length > 0) {
    appendUserChatLine(session, transcript).catch((err) => {
      log?.error({ err }, "voicebot: failed to persist user query in background");
    });
  }

  const csTurn = tenantCs(session);
  if (csTurn?.stop_words?.length && textMatchesAnyPhrase(transcript, csTurn.stop_words)) {
    voiceTrace(log, "pipeline.stop_word", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      transcript_preview: transcript.slice(0, 200),
    });
    return;
  }
  if (csTurn?.end_call_keywords?.length && textMatchesAnyPhrase(transcript, csTurn.end_call_keywords)) {
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

  // ------------------------------------------------------------------
  // Filler-only utterance handling (hmm, um, uh, …)
  // Controlled by customer_settings.filler_ack_enabled (per-tenant).
  // The bot does NOT react on the first filler; it waits. Only after
  // `filler_ack_threshold` consecutive fillers it responds with an ack
  // phrase and resets the counter. Any real (non-filler) speech also
  // resets the counter.
  // ------------------------------------------------------------------
  const fillerFeatureEnabled =
    env.voicebot.fillerAckEnabled &&
    csTurn?.filler_ack_enabled === true;

  if (fillerFeatureEnabled && isFillerOnlyTranscript(transcript)) {
    const count = (session.fillerConsecutiveCount ?? 0) + 1;
    const threshold = csTurn?.filler_ack_threshold ?? 2;

    voiceTrace(log, "pipeline.stt.filler_detected", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      call_sid: session.callSid,
      exotel_call_session_id: session.callSessionDbId,
      transcript_preview: transcript.slice(0, 120),
      consecutive_count: count,
      threshold,
    });

    if (count < threshold) {
      // Below threshold — stay silent, wait for the customer to speak
      session.fillerConsecutiveCount = count;
      logVoiceStage(log, "stt.filler_wait", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        consecutive_count: count,
        threshold,
      });
      return;
    }

    // Threshold reached — acknowledge and reset
    session.fillerConsecutiveCount = 0;

    const ack = pickFillerAckPhrase(multilingual ? pipelineBcp : "en-IN", {
      englishOverride: env.voicebot.fillerAckText,
    });
    voiceTrace(log, "pipeline.stt.filler_only", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      call_sid: session.callSid,
      exotel_call_session_id: session.callSessionDbId,
      transcript_preview: transcript.slice(0, 120),
      ack_preview: ack.slice(0, 200),
      consecutive_count: count,
      threshold,
    });
    logVoiceStage(log, "stt.filler_skip_rag", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      transcript_chars: transcript.length,
    });
    if (session.isClosing) return;
    await appendVoiceTurnToChat(session, transcript, ack, {
      assistantSource: "filler_ack",
    });
    await speakToExotel(ws, session, ack, ttsLanguage, log);
    const tEnd = Date.now();
    const elapsedMs = tEnd - utteranceStartedAt;
    const sttMs = tAfterStt - utteranceStartedAt;
    const fillerMs = tEnd - tAfterStt;
    voiceTrace(log, "pipeline.utterance.timing", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      stt_ms: sttMs,
      ask_pipeline_ms: fillerMs,
      final_tts_ms: 0,
      total_ms: elapsedMs,
      spoke_incrementally: false,
      filler_only: true,
    });
    logVoiceStage(log, "utterance.completed", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      llm_source: "filler_ack",
      elapsed_ms: elapsedMs,
      timing_stt_ms: sttMs,
      timing_ask_pipeline_ms: fillerMs,
      timing_final_tts_ms: 0,
    });
    return;
  }

  // Real speech detected — reset consecutive filler counter
  if (session.fillerConsecutiveCount) {
    session.fillerConsecutiveCount = 0;
  }

  voiceTrace(log, "pipeline.rag.start", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    exotel_call_session_id: session.callSessionDbId,
    question_preview: transcript.slice(0, 500),
  });

  if (session.isClosing) return;

  const streamToCall =
    session.ragStreamingForVoice === true && session.ttsStreamingForVoice === true
      ? { ws, ttsLanguage }
      : undefined;
  if (
    session.ragStreamingForVoice === true &&
    session.ttsStreamingForVoice !== true &&
    log
  ) {
    voiceTrace(log, "pipeline.rag.tts_streaming_off", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      reason: "full_llm_then_single_tts",
    });
  }

  const askResult = await runVoicebotAskPipeline(session, transcript, log, streamToCall);
  const tAfterAsk = Date.now();

  if (!askResult || !askResult.answer) {
    await appendVoiceTurnToChat(session, transcript, session.errorText || ERROR_AUDIO_TEXT, {
      assistantSource: "pipeline_error",
    });
    await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, ttsLanguage, log);
    logVoiceStage(log, "pipeline.fallback_error_audio", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
    });
    return;
  }

  log?.info(
    {
      stream_sid: session.streamSid,
      answer: askResult.answer.slice(0, 200),
      source: askResult.source,
    },
    "voicebot pipeline result"
  );

  if (!askResult.spokeIncrementally) {
    await speakToExotel(ws, session, askResult.answer, ttsLanguage, log);
  }
  const tEnd = Date.now();
  const elapsedMs = tEnd - utteranceStartedAt;
  const sttMs = tAfterStt - utteranceStartedAt;
  const askMs = tAfterAsk - tAfterStt;
  const finalTtsMs = askResult.spokeIncrementally ? 0 : tEnd - tAfterAsk;
  voiceTrace(log, "pipeline.utterance.timing", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    stt_ms: sttMs,
    ask_pipeline_ms: askMs,
    final_tts_ms: finalTtsMs,
    total_ms: elapsedMs,
    spoke_incrementally: askResult.spokeIncrementally === true,
  });
  logVoiceStage(log, "utterance.completed", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    llm_source: askResult.source,
    elapsed_ms: elapsedMs,
    timing_stt_ms: sttMs,
    timing_ask_pipeline_ms: askMs,
    timing_final_tts_ms: finalTtsMs,
  });
  if (elapsedMs > 15000) {
    log?.warn({ stream_sid: session.streamSid, elapsedMs }, "voicebot utterance slow path (>15s)");
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
  session.utteranceProcessingStartedAt = utteranceStartedAt;
  session.ttfaLogged = false;

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
  const sttModelForPath = (csUtterance?.stt_model ?? "saaras:v3").trim();
  const sttImplLine: "websocket" | "batch" =
    sttProvider === "sarvam" &&
      session.sttStreamingForVoice === true &&
      sarvamSttWebsocketModelSupported(sttModelForPath)
      ? "websocket"
      : "batch";

  voiceTrace(log, "pipeline.stt.request", {
    customerId: session.customerId,
    stream_sid: session.streamSid,
    call_sid: session.callSid,
    exotel_call_session_id: session.callSessionDbId,
    wav_pcm_bytes: combinedPcm.length,
    sample_rate: session.mediaFormat.sample_rate,
    stt_provider: sttProvider,
    stt_streaming_enabled: session.sttStreamingForVoice === true,
    stt_implementation: sttImplLine,
    multilingual,
    customer_query_count_before: session.customerQueryCount ?? 0,
    elevenlabs_stt_full_auto: env.voicebot.elevenlabsSttFullAuto,
    sarvam_stt_full_auto: env.voicebot.sarvamSttFullAuto,
  });

  try {
    // === Step 1: STT ===
    const wavBuffer = createWavBuffer(combinedPcm, session.mediaFormat.sample_rate);

    /**
     * Sarvam multilingual: first two **completed** user queries (see `customerQueryCount` before this
     * turn) omit `language_code` / use `unknown` so Sarvam returns `language_probability` for
     * `docs/EXOTEL_VOICEBOT_LANGUAGE_SWITCHING_SPEC.md`. From the third query onward, send an explicit
     * hint (`session.currentLanguageCode`) for better narrowband accuracy — still one STT request.
     * `VOICEBOT_SARVAM_STT_FULL_AUTO` forces open detect for the whole call.
     * See `docs/VOICEBOT_STT_QUALITY_AND_TUNING.md`.
     */
    const priorUserQueryCount = session.customerQueryCount ?? 0;
    const sarvamMultilingualOpenDetect =
      multilingual &&
      sttProvider === "sarvam" &&
      !env.voicebot.sarvamSttFullAuto &&
      priorUserQueryCount < 2;

    const allowedNorm = normalizeAllowedLangList(
      session.allowedLanguageCodes,
      session.defaultLanguageCode || "en-IN"
    );

    let sttLanguageHint = !multilingual
      ? normalizeBcp47Tag(session.defaultLanguageCode || "en-IN")
      : sttProvider === "sarvam"
        ? sarvamMultilingualOpenDetect
          ? normalizeBcp47Tag(session.defaultLanguageCode || "en-IN")
          : normalizeBcp47Tag(
            session.currentLanguageCode ||
            session.defaultLanguageCode ||
            "en-IN"
          )
        : session.defaultLanguageCode?.trim() || "en-IN";

    sttLanguageHint = clampLanguageToAllowed(
      sttLanguageHint,
      allowedNorm,
      session.defaultLanguageCode || "en-IN"
    );

    if (sttProvider === "sarvam") {
      voiceTrace(log, "pipeline.stt.sarvam_language_hint", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        current_language_code: session.currentLanguageCode ?? null,
        default_language_code: session.defaultLanguageCode ?? null,
        prior_user_query_count: priorUserQueryCount,
        sarvam_open_detect_multilingual: sarvamMultilingualOpenDetect,
        language_code_sent: sttLanguageHint ?? "auto",
      });
    }

    let stt: { status: number; body: unknown };

    if (sttProvider === "elevenlabs") {
      if (!env.elevenlabs.apiKey) {
        log?.error("voicebot STT: ELEVENLABS_API_KEY not configured");
        await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log);
        return;
      }
      const elModel = resolveElevenLabsSttModelId(csUtterance?.stt_model);
      /**
       * Multilingual: first two user queries omit `language_code` when not full-auto — mirrors Sarvam
       * open-detect window for language-switch policy; after that, bias to `session.currentLanguageCode`
       * for 8 kHz accuracy (`docs/VOICEBOT_STT_QUALITY_AND_TUNING.md`). English-only stays forced English.
       */
      let elLang: string | undefined;
      if (!multilingual) {
        elLang = bcp47ToElevenLabsLanguage("en-IN", {
          multilingual: false,
          forceEnglish: true,
        });
      } else if (env.voicebot.elevenlabsSttFullAuto) {
        elLang = undefined;
      } else {
        const hintBcp47 =
          session.currentLanguageCode?.trim() ||
          session.defaultLanguageCode?.trim() ||
          "en-IN";
        const elMultilingualOpenDetect = priorUserQueryCount < 2;
        elLang = elMultilingualOpenDetect
          ? bcp47ToElevenLabsLanguage(hintBcp47, {
            multilingual: true,
            forceEnglish: false,
          }) ?? "en"
          : bcp47ToElevenLabsLanguage(hintBcp47, {
            multilingual: true,
            forceEnglish: false,
          }) ?? "en";
      }
      voiceTrace(log, "pipeline.stt.elevenlabs_language_hint", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        current_language_code: session.currentLanguageCode ?? null,
        default_language_code: session.defaultLanguageCode ?? null,
        prior_user_query_count: priorUserQueryCount,
        elevenlabs_open_detect_multilingual:
          multilingual &&
          !env.voicebot.elevenlabsSttFullAuto &&
          priorUserQueryCount < 2,
        language_code_sent: elLang ?? "auto",
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
      const sttModel = sttModelForPath;
      const useSttWebsocket =
        session.sttStreamingForVoice === true &&
        sarvamSttWebsocketModelSupported(sttModel);
      try {
        if (useSttWebsocket) {
          const wsLanguage = (() => {
            if (sttLanguageHint && sttLanguageHint.trim().length > 0) {
              return sttLanguageHint;
            }
            return "unknown";
          })();
          stt = await sarvamSpeechToTextWebsocket({
            wavBuffer,
            sampleRate: session.mediaFormat.sample_rate,
            model: sttModel,
            mode: "transcribe",
            language_code: wsLanguage,
            shouldAbort: () => session.isClosing,
          });
          if (stt.status !== 200) {
            if (session.isClosing || stt.status === 499) {
              return;
            }
            voiceTrace(log, "pipeline.stt.websocket_fallback", {
              customerId: session.customerId,
              stream_sid: session.streamSid,
              stt_status: stt.status,
              body: safeJsonForLog(stt.body),
            });
            if (session.isClosing) return;
            stt = await sarvamSpeechToText({
              fileBuffer: wavBuffer,
              filename: "utterance.wav",
              mimeType: "audio/wav",
              model: sttModel,
              mode: "transcribe",
              language_code: sttLanguageHint,
            });
          }
        } else {
          stt = await sarvamSpeechToText({
            fileBuffer: wavBuffer,
            filename: "utterance.wav",
            mimeType: "audio/wav",
            model: sttModel,
            mode: "transcribe",
            language_code: sttLanguageHint,
          });
        }
      } catch (err) {
        log?.error({ err }, "voicebot Sarvam STT failed");
        await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log);
        return;
      }
    }

    if (stt.status !== 200) {
      if (session.isClosing) return;
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

    if (session.isClosing) return;

    let transcript: string;
    let detectedRaw: string;
    let languageProbability: number | null = null;
    if (sttProvider === "elevenlabs") {
      const shaped = elevenLabsSttToSarvamShape(stt.body);
      transcript = shaped.transcript;
      detectedRaw = shaped.language_code;
    } else {
      const sttBody = stt.body as {
        transcript?: string;
        language_code?: string;
        language_probability?: number;
      };
      transcript = sttBody.transcript?.trim() || "";
      detectedRaw = sttBody.language_code || "en-IN";
      const lp = sttBody.language_probability;
      languageProbability = typeof lp === "number" && Number.isFinite(lp) ? lp : null;
    }

    if (session.sttDomainWords && Object.keys(session.sttDomainWords).length > 0) {
      for (const [misrecognised, correctWord] of Object.entries(session.sttDomainWords)) {
        if (!misrecognised) continue;
        const escaped = misrecognised.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`\\b${escaped}\\b`, "gi");
        transcript = transcript.replace(re, correctWord);
      }
    }

    if (session.lastUserQuery && transcript) {
      const last = session.lastUserQuery.trim().toLowerCase();
      const current = transcript.trim().toLowerCase();
      const isRepetitive = last.includes(current) || current.includes(last);
      if (isRepetitive) {
        session.consecutiveRepeatCount = (session.consecutiveRepeatCount || 0) + 1;
      } else {
        session.consecutiveRepeatCount = 0;
      }

      if (session.consecutiveRepeatCount >= 2 && csUtterance?.rag_use_openai_only === true) {
        const corrected = await correctUtteranceWithOpenAI(
          wavBuffer,
          transcript,
          session.allowedLanguageCodes || []
        );
        if (corrected) {
          transcript = corrected;
        }
      }
    }
    session.lastUserQuery = transcript;


    if (session.pendingLanguageSwitch) {
      const pending = session.pendingLanguageSwitch;
      const activeBcp = normalizeBcp47Tag(
        session.currentLanguageCode || session.defaultLanguageCode || "en-IN"
      );
      const ttsPromptLang = multilingual ? mapToTtsLanguage(activeBcp) : "en-IN";
      if (!transcript.trim()) {
        voiceTrace(log, "voicebot.language.confirm_empty_transcript", {
          customerId: session.customerId,
          stream_sid: session.streamSid,
        });
        return;
      }
      const reply = parseLanguageSwitchConfirmation(transcript);
      if (reply === "yes") {
        persistSessionActiveLanguage(session, pending.targetLanguage, log);
        session.pendingLanguageSwitch = null;
        session.effectiveSttLanguageThisTurn = normalizeBcp47Tag(
          session.currentLanguageCode || session.defaultLanguageCode || "en-IN"
        );
        await applyAgentVoicePersonaToSession(session);
        if (session.callSessionDbId) {
          void updateExotelCallSessionLanguage(
            session.callSessionDbId,
            session.effectiveSttLanguageThisTurn
          ).catch(() => { });
        }

        const targetLabel = LANG_LABEL[pending.targetLanguage] ?? pending.targetLanguage;
        let ackMsg = `Okay, let's continue in ${targetLabel}. How can I help you?`;
        if (pending.targetLanguage.startsWith("hi")) {
          ackMsg = `ठीक है, अब हम हिंदी में बात करेंगे। मैं आपकी क्या मदद कर सकता हूँ?`;
        } else if (pending.targetLanguage.startsWith("mr")) {
          ackMsg = `ठीक आहे, आता आपण मराठीत बोलूया. मी तुम्हाला कशी मदत करू?`;
        }

        const cleanedConfirm = transcript.toLowerCase().replace(/\b(yes|yeah|okay|sure|haan|ha|ji|switch|hindi|english|marathi|gujarati)\b/gi, "").trim();

        if (cleanedConfirm.length > 3) {
          const tAfterStt = Date.now();
          await runVoicebotReplyPipelineAfterTranscriptReady(
            ws,
            session,
            cleanedConfirm,
            utteranceStartedAt,
            tAfterStt,
            multilingual,
            log
          );
        } else {
          await appendVoiceTurnToChat(session, transcript, ackMsg, {
            assistantSource: "language_switch_acknowledged",
          });
          const ttsLang = multilingual ? mapToTtsLanguage(pending.targetLanguage) : "en-IN";
          await speakToExotel(ws, session, ackMsg, ttsLang, log);
        }
        return;
      }
      if (reply === "no") {
        session.pendingLanguageSwitch = null;
        const msg = `Okay, we will continue in ${activeBcp}.`;
        await appendVoiceTurnToChat(session, transcript, msg, {
          assistantSource: "language_switch_declined",
        });
        await speakToExotel(ws, session, msg, ttsPromptLang, log);
        return;
      }
      pending.unclearRetries += 1;
      if (pending.unclearRetries <= 1) {
        const prompt = languageSwitchConfirmPrompt(activeBcp, pending.targetLanguage);
        await appendVoiceTurnToChat(session, transcript, prompt, {
          assistantSource: "language_switch_reprompt",
        });
        await speakToExotel(ws, session, prompt, ttsPromptLang, log);
        return;
      }
      session.pendingLanguageSwitch = null;
      const msg = `I will continue in ${activeBcp}.`;
      await appendVoiceTurnToChat(session, transcript, msg, {
        assistantSource: "language_switch_unclear_abort",
      });
      await speakToExotel(ws, session, msg, ttsPromptLang, log);
      return;
    }

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
      return;
    }

    if (!multilingual) {
      session.currentLanguageCode = normalizeBcp47Tag(session.defaultLanguageCode || "en-IN");
    }

    if (!session.currentLanguageCode?.trim()) {
      session.currentLanguageCode = normalizeBcp47Tag(
        session.defaultLanguageCode || "en-IN"
      );
    }

    const isAllowed = isLanguageInAllowedList(detectedRaw, allowedNorm) || transcriptLooksLatinHeavyForRehintSkip(transcript, 0.5);
    if (!isAllowed) {
      voiceTrace(log, "pipeline.stt.disallowed_language_detected", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        detected_raw: detectedRaw,
        allowed_languages: allowedNorm,
      });

      const fallbackLang = normalizeBcp47Tag(session.defaultLanguageCode || "en-IN");
      const listHuman = humanizeAllowedList(allowedNorm);
      const msg = `Sorry, I only understand ${listHuman}. Please speak in one of these languages.`;

      await appendVoiceTurnToChat(session, transcript, msg, {
        assistantSource: "disallowed_language_abort",
      });
      await speakToExotel(ws, session, msg, fallbackLang, log);
      return;
    }

    const nextQueryIndex = (session.customerQueryCount ?? 0) + 1;
    const clampedForPolicy = clampLanguageToAllowed(
      detectedRaw,
      allowedNorm,
      session.defaultLanguageCode || "en-IN"
    );

    const activeBcp = normalizeBcp47Tag(
      session.currentLanguageCode || session.defaultLanguageCode || "en-IN"
    );

    const isDifferentLang = !languagesLooselyEqual(clampedForPolicy, activeBcp);
    if (isDifferentLang) {
      if (session.discrepantLanguageTarget === clampedForPolicy) {
        session.discrepantLanguageCount = (session.discrepantLanguageCount || 0) + 1;
      } else {
        session.discrepantLanguageTarget = clampedForPolicy;
        session.discrepantLanguageCount = 1;
      }
    } else {
      session.discrepantLanguageCount = 0;
      session.discrepantLanguageTarget = null;
    }

    if (session.discrepantLanguageCount >= 2 && session.voicebotMultilingualEffective === true) {
      session.pendingLanguageSwitch = {
        targetLanguage: clampedForPolicy,
        deferredTranscript: "",
        fromLanguage: activeBcp,
        confidence: 1.0,
        unclearRetries: 0,
      };

      session.addLanguagePromptRule = {
        targetLanguage: clampedForPolicy,
        fromLanguage: activeBcp,
      };
    }

    session.customerQueryCount = nextQueryIndex;

    let effectiveLanguage = multilingual
      ? normalizeBcp47Tag(session.currentLanguageCode || session.defaultLanguageCode || "en-IN")
      : normalizeBcp47Tag("en-IN");
    session.effectiveSttLanguageThisTurn = effectiveLanguage;
    await applyAgentVoicePersonaToSession(session);
    if (session.callSessionDbId) {
      void updateExotelCallSessionLanguage(session.callSessionDbId, effectiveLanguage).catch(
        () => { }
      );
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
      language_probability: languageProbability,
      raw: safeJsonForLog(stt.body),
    });

    if (session.isClosing) return;

    const tAfterStt = Date.now();

    await runVoicebotReplyPipelineAfterTranscriptReady(
      ws,
      session,
      transcript,
      utteranceStartedAt,
      tAfterStt,
      multilingual,
      log
    );
  } catch (err) {
    log?.error({ err, stream_sid: session.streamSid }, "voicebot utterance processing error");
    logVoiceStage(log, "utterance.exception", {
      customerId: session.customerId,
      stream_sid: session.streamSid,
      err: String(err),
    }, "voicebot utterance failed");
    await speakToExotel(ws, session, session.errorText || ERROR_AUDIO_TEXT, "en-IN", log).catch(() => { });
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
    if (session.isClosing) return null;

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
          voicePreferNativeEmbeddingForIndic: true,
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

    // Parallel: history + agent row (agent is cached after first utterance)
    const historyP = loadVoicebotChatHistory(session);
    const agentP = (async () => {
      if (!session.agentId) return;
      if (session.voiceRagAgentCache !== undefined) {
        const c = session.voiceRagAgentCache;
        if (c) {
          session.ttsPace = c.ttsPace;
          session.ttsModel = c.ttsModel;
          session.ttsSpeaker = c.ttsSpeaker;
          session.ttsSampleRate = c.ttsSampleRate;
          await applyAgentVoicePersonaToSession(session, {
            avatarId: c.avatarId,
            elevenlabsAvatarId: c.elevenlabsAvatarId,
          });
        }
        return;
      }
      const agentResult = await pool.query(
        `SELECT system_prompt, tts_pace, tts_model, tts_speaker, tts_sample_rate, no_kb_fallback_instruction,
                avatar_id, elevenlabs_avatar_id
         FROM agents WHERE id = $1`,
        [session.agentId]
      );
      if (agentResult.rows.length > 0) {
        const row = agentResult.rows[0];
        session.voiceRagAgentCache = {
          systemPrompt: row.system_prompt,
          fallbackInstruction: row.no_kb_fallback_instruction,
          ttsPace: row.tts_pace != null ? Number(row.tts_pace) : null,
          ttsModel: row.tts_model,
          ttsSpeaker: row.tts_speaker,
          ttsSampleRate: row.tts_sample_rate != null ? Number(row.tts_sample_rate) : null,
          avatarId: row.avatar_id as string | null,
          elevenlabsAvatarId: row.elevenlabs_avatar_id as string | null,
        };
        session.ttsPace = session.voiceRagAgentCache.ttsPace;
        session.ttsModel = session.voiceRagAgentCache.ttsModel;
        session.ttsSpeaker = session.voiceRagAgentCache.ttsSpeaker;
        session.ttsSampleRate = session.voiceRagAgentCache.ttsSampleRate;
        await applyAgentVoicePersonaToSession(session, {
          avatarId: row.avatar_id as string | null,
          elevenlabsAvatarId: row.elevenlabs_avatar_id as string | null,
        });
      } else {
        session.voiceRagAgentCache = null;
      }
    })();

    let agentPrompt = customerPrompt;
    let agentFallbackInstruction: string | null = null;

    const [embedBundle, historyRaw] = await Promise.all([embedPipeline, historyP, agentP]);

    if (session.isClosing) return null;

    // Apply agent data after parallel fetch completes
    if (session.voiceRagAgentCache) {
      agentPrompt = session.voiceRagAgentCache.systemPrompt;
      agentFallbackInstruction = session.voiceRagAgentCache.fallbackInstruction;
    }
    agentPrompt = relaxAgentPrompt(agentPrompt, allowRelatedGeneralAnswersVoice(session));

    const csRag = tenantCs(session);
    const noKbFallbackInstruction =
      agentFallbackInstruction?.trim() ||
      csRag?.no_kb_fallback_instruction?.trim() ||
      defaultFallbackInstruction?.trim() ||
      'respond with a polite message like "I don\'t have an answer for that right now" then ask 1-2 follow-up questions related to the conversation context to keep the discussion going and explore sales opportunities.';
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
      const noKbAnswer = allowRelatedGeneralAnswersVoice(session)
        ? outOfScopeMessageVoice(session)
        : "I don't have enough information to answer that question.";
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
    const relatedScopeTh = relatedScopeDistanceThresholdVoice(session);
    const isShortQuery = question.trim().length < 20;
    if (
      allowRelatedGeneralAnswersVoice(session) &&
      !isShortQuery &&
      Number.isFinite(dist) &&
      dist > 0.8
    ) {
      const out = outOfScopeMessageVoice(session);
      voiceTrace(log, "pipeline.rag.out_of_scope_distance_gate", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        exotel_call_session_id: session.callSessionDbId,
        distance: dist,
        related_scope_distance_threshold: relatedScopeTh,
      });
      await appendVoiceTurnToChat(session, question, out, {
        assistantSource: "out-of-scope",
      });
      return {
        answer: out,
        source: "none",
        session_id: session.chatSessionId || "",
      };
    }
    const priorUserTurns = history.filter((h) => h.role === "user").length;
    const directTh = ragDirectKbDistanceThreshold(session);
    // Allow kb-direct on ANY turn: first turn uses the full threshold; subsequent
    // turns use a tighter threshold (60%) to reduce false positives when context matters.
    const directThForTurn = priorUserTurns === 0 ? directTh : directTh * 0.6;
    const canDirectKb =
      Number.isFinite(dist) && dist < directThForTurn;

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
      const def = normalizeBcp47Tag(session.defaultLanguageCode || "en-IN");
      const label = LANG_LABEL[def] ?? def;
      languageRule = `\n- ALWAYS respond in ${label} (${def}) regardless of the question language.\n- Strictly generate responses ONLY in ${label} (${def}).\n- NEVER generate responses in any other language or a mixture of languages.\n`;
    }
    const elevenLabsTagHint = buildElevenLabsRagAudioTagHintForProvider(
      csRag?.tts_provider,
      session.ttsModel ?? csRag?.tts_model ?? null,
      { customerTtsModelRaw: csRag?.tts_model ?? null }
    );

    let industryContextPrompt = "";
    if (session.industryContext && Object.keys(session.industryContext).length > 0) {
      industryContextPrompt = "\n--- INDUSTRY CONTEXT & TONE GUIDELINES ---\n";
      for (const [key, val] of Object.entries(session.industryContext)) {
        if (typeof val === "string") {
          industryContextPrompt += `- ${key}: ${val}\n`;
        } else {
          industryContextPrompt += `- ${key}: ${JSON.stringify(val)}\n`;
        }
      }
      industryContextPrompt += "--- END INDUSTRY CONTEXT ---\n";
    }

    const def = normalizeBcp47Tag(session.defaultLanguageCode || "en-IN");
    const listHuman = humanizeAllowedList(allowedNorm);
    const listTags = allowedNorm.join(", ");
    const strictConstraint = `\n- CRITICAL: You MUST strictly generate the response ONLY in one of the allowed languages: ${listHuman} (${listTags}).\n- NEVER generate garbled, non-words, or mixed-language text. Ensure the script matches the selected language perfectly.\n- If the user query is in any disallowed language other than ${listTags}, you MUST ignore it and answer only in ${LANG_LABEL[def] ?? def} asking the user to use an allowed language.`;

    let strictnessHint = "";
    const s = relatedAnswerStrictnessVoice(session);
    if (s === "permissive") {
      strictnessHint = "- STRICTNESS: PERMISSIVE. You are explicitly AUTHORIZED and ENCOURAGED to use your internal general knowledge to answer questions that are not explicitly in the Knowledgebase, as long as they are related to the business (e.g., travel distances, nearby locations, weather, local culture). DO NOT say 'I don't know' for these topics. Instead, use your best estimation or calculation based on the context. You have permission to bypass any previous 'Knowledgebase only' instructions for these helpful estimations.";
    } else if (s === "strict") {
      strictnessHint = "- STRICTNESS: STRICT. Even in related mode, if the KB doesn't have the specific answer, you MUST say you don't know rather than estimating. Stick strictly to the provided facts.";
    } else {
      strictnessHint = "- STRICTNESS: BALANCED. Use general knowledge for related topics (like distances), but be cautious and clearly mention that you are providing an estimate.";
    }


    const ragRules = allowRelatedGeneralAnswersVoice(session)
      ? `--- RAG rules ---
- The KNOWLEDGEBASE below is authoritative for tenant/business facts.
- Keep answers SHORT and conversational — suitable for voice/phone.
- Avoid bullet points and complex formatting; speak naturally.
- If exact fact is missing but the query is related to this business/domain (e.g., travel distance, nearby cities, landmarks), answer with grounded general knowledge, estimation, or simple calculation.
- For inferred/estimated values, clearly mention they are approximate.
- Never invent tenant-specific operational details (pricing, policy, inventory) not present in KB. General travel distances/times are permitted if location is known.
- ${strictnessHint}${languageRule}${elevenLabsTagHint}${industryContextPrompt}${strictConstraint}`
      : `--- RAG rules ---
- Answer using ONLY information from the KNOWLEDGEBASE below.
- Keep answers SHORT and conversational — suitable for voice/phone.
- Avoid bullet points and complex formatting; speak naturally.
- If no passage answers the question: ${noKbFallbackInstruction}${languageRule}${elevenLabsTagHint}${industryContextPrompt}${strictConstraint}`;

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

    const maxTok = Math.min(
      session.llmMaxTokensForVoice ?? 150,
      env.voicebot.voiceLlmMaxTokensCap
    );
    const tTop = session.llmTopPVoice;
    const voiceRagOpts = {
      temperature: session.llmTemperatureVoice ?? 0.2,
      top_p:
        tTop != null && tTop < 1
          ? tTop
          : 0.95,
      model: resolvedOpenAiModelForVoice(session),
    };
    // `streamCall` is only passed from `processUtterance` when RAG + TTS streaming are both on.
    const useLlmStream = streamCall != null;

    if (useLlmStream) {
      voiceTrace(log, "pipeline.rag.llm_stream", {
        customerId: session.customerId,
        stream_sid: session.streamSid,
        max_tokens: maxTok,
        tts_streaming_enabled: true,
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
      const rawAnswer =
        llmResult.answer.trim() || "I'm sorry, I couldn't find an answer.";
      const answer = allowRelatedGeneralAnswersVoice(session) &&
        rawAnswer.toLowerCase().includes("out_of_scope")
        ? outOfScopeMessageVoice(session)
        : rawAnswer;

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
    const rawAnswer =
      llmResult.answer.trim() || "I'm sorry, I couldn't find an answer.";
    const answer = allowRelatedGeneralAnswersVoice(session) &&
      rawAnswer.toLowerCase().includes("out_of_scope")
      ? outOfScopeMessageVoice(session)
      : rawAnswer;

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

        // Media arrives every ~20ms; logging each frame floods PM2/pino with near-duplicate lines.
        if (msg.event !== "media") {
          voiceTrace(log, "exotel.in", {
            customerId,
            stream_sid: session?.streamSid,
            call_sid: session?.callSid,
            exotel_call_session_id: session?.callSessionDbId,
            chat_session_id: session?.chatSessionId,
            raw_utf8_bytes: raw.length,
            payload: redactInboundExotelForLog(msg as unknown as Record<string, unknown>),
          });
        }

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

              let outboundLinkedId: string | null = null;
              const outboundIdCandidate = extractOutboundSessionIdFromCustomParameters(
                details.custom_parameters as Record<string, string> | undefined
              );
              if (outboundIdCandidate) {
                const oCheck = await pool.query(
                  `SELECT id, metadata FROM exotel_call_sessions
                   WHERE id = $1::uuid AND customer_id = $2::uuid AND direction = 'outbound'`,
                  [outboundIdCandidate, customerId]
                );
                if (oCheck.rows.length === 0) {
                  log.warn(
                    { outboundIdCandidate, customerId },
                    "voicebot: outbound CustomField session id not found — creating inbound session row"
                  );
                } else {
                  outboundLinkedId = outboundIdCandidate;
                  const om = oCheck.rows[0].metadata as Record<string, unknown> | null;
                  if (om?.callee_answered !== true) {
                    await waitForOutboundCalleeAnswered(outboundLinkedId, log);
                  }
                }
              }
              if (!outboundLinkedId && details.from && details.to) {
                const df = String(details.from).replace(/\D/g, "");
                const dt = String(details.to).replace(/\D/g, "");
                if (df.length >= 8 && dt.length >= 8) {
                  const fb = await pool.query(
                    `SELECT id, metadata FROM exotel_call_sessions
                     WHERE customer_id = $1::uuid AND direction = 'outbound'
                       AND COALESCE(metadata->>'voicebot_bridge','') <> 'true'
                       AND started_at > NOW() - INTERVAL '15 minutes'
                       AND regexp_replace(coalesce(from_number,''), '\\D', '', 'g') = $2
                       AND regexp_replace(coalesce(to_number,''), '\\D', '', 'g') = $3
                     ORDER BY started_at DESC LIMIT 1`,
                    [customerId, df, dt]
                  );
                  if (fb.rows.length > 0) {
                    outboundLinkedId = fb.rows[0].id as string;
                    const om = fb.rows[0].metadata as Record<string, unknown> | null;
                    log.info(
                      { outboundLinkedId, customerId },
                      "voicebot: matched outbound session by From/To digits (CustomField missing)"
                    );
                    if (om?.callee_answered !== true) {
                      await waitForOutboundCalleeAnswered(outboundLinkedId, log);
                    }
                  }
                }
              }

              if (!outboundLinkedId && details.call_sid) {
                const csid = String(details.call_sid).trim();
                if (csid) {
                  const bySid = await pool.query(
                    `SELECT id, metadata FROM exotel_call_sessions
                     WHERE customer_id = $1::uuid AND direction = 'outbound'
                       AND exotel_call_sid = $2`,
                    [customerId, csid]
                  );
                  if (bySid.rows.length > 0) {
                    outboundLinkedId = bySid.rows[0].id as string;
                    const om = bySid.rows[0].metadata as Record<string, unknown> | null;
                    log.info(
                      { outboundLinkedId, customerId, call_sid: csid },
                      "voicebot: matched outbound session by Exotel CallSid (ccs / From-To fallback unused)"
                    );
                    if (om?.callee_answered !== true) {
                      await waitForOutboundCalleeAnswered(outboundLinkedId, log);
                    }
                  }
                }
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

              const campaignId = details.custom_parameters?.campaign_id;
              if (campaignId) {
                session.mode = "outbound_campaign";
                session.campaignId = campaignId;
                session.waitingForFirstSpeech = true;
                log.info({ campaignId }, "voicebot: identified as outbound campaign call");
              } else if (outboundLinkedId) {
                session.mode = "outbound";
              } else {
                session.mode = "inbound";
              }

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
                if (outboundLinkedId) {
                  const patch = JSON.stringify({
                    voicebot_bridge: true,
                    voicebot_started_at: new Date().toISOString(),
                    media_format: details.media_format,
                  });
                  const upd = await pool.query(
                    `UPDATE exotel_call_sessions
                     SET exotel_stream_sid = $1,
                         exotel_call_sid = COALESCE(exotel_call_sid, $2),
                         metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                         status = 'active'
                     WHERE id = $4::uuid AND customer_id = $5::uuid AND direction = 'outbound'
                     RETURNING id`,
                    [
                      details.stream_sid,
                      details.call_sid,
                      patch,
                      outboundLinkedId,
                      customerId,
                    ]
                  );
                  session.callSessionDbId =
                    (upd.rows[0]?.id as string | undefined) ?? outboundLinkedId;
                } else {
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
                }
                session.currentLanguageCode = normalizeBcp47Tag(
                  session.voicebotMultilingualEffective === true
                    ? session.defaultLanguageCode || "en-IN"
                    : "en-IN"
                );
                notifyCallStartFromSession(session);
                scheduleMaxCallDurationTimer(session, socket, log);

                if (session.mode === "outbound_campaign") {
                  log.info({ stream_sid: session.streamSid }, "voicebot: campaign mode — waiting for first customer speech before playing script");
                  session.greetingPending = false; // Not really "pending" in the traditional sense
                } else {
                  await appendAssistantChatLine(session, session.greetingText || GREETING_TEXT, "voice_greeting");
                  voiceTrace(log, "call.session_ready", {
                    customerId,
                    chat_session_id: session.chatSessionId,
                    exotel_call_session_id: session.callSessionDbId,
                    stream_sid: session.streamSid,
                    call_sid: session.callSid,
                  });
                }
              } catch (err) {
                log.error({ err }, "voicebot: failed to bootstrap chat/call session rows");
              }

              try {
                if (session.mode === "outbound_campaign") {
                  // Skip immediate greeting for campaigns
                  break;
                }
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
                  const greetingText = session.greetingText || GREETING_TEXT;
                  const cs = tenantCs(session);
                  const cacheKey = getGreetingCacheKey(
                    customerId,
                    greetingText,
                    cs?.tts_provider ?? "sarvam",
                    session.ttsSpeaker?.trim() || cs?.tts_default_speaker?.trim() || "",
                    greetingLang,
                    session.mediaFormat.sample_rate
                  );
                  const cachedPcm = getCachedGreetingPcm(cacheKey);
                  let greetingOk: boolean;
                  if (cachedPcm) {
                    voiceTrace(log, "greeting.cache_hit", {
                      customerId,
                      stream_sid: session.streamSid,
                      pcm_bytes: cachedPcm.length,
                    });
                    session.ttsInProgress = true;
                    sendAudioToExotel(socket, session, cachedPcm, log);
                    session.ttsInProgress = false;
                    schedulePlaybackMarkFallback(session, cachedPcm.length, session.mediaFormat.sample_rate, log);
                    greetingOk = true;
                  } else {
                    greetingOk = await speakToExotel(
                      socket,
                      session,
                      greetingText,
                      greetingLang,
                      log
                    );
                  }
                  if (!greetingOk) {
                    log.warn(
                      {
                        customerId,
                        stream_sid: session.streamSid,
                        call_sid: session.callSid,
                      },
                      "voicebot: greeting TTS failed — caller may hear silence until the next reply; see tts.error / pipeline.tts.error logs"
                    );
                    logVoiceStage(log, "greeting.tts_failed", {
                      customerId,
                      stream_sid: session.streamSid,
                      call_sid: session.callSid,
                    });
                  } else {
                    logVoiceStage(log, "greeting.sent", {
                      customerId,
                      stream_sid: session.streamSid,
                      call_sid: session.callSid,
                    });
                    // Background: warm cache for next call with same greeting
                    if (!cachedPcm) {
                      void preWarmGreetingCache(session, greetingText, greetingLang, cacheKey, log);
                    }
                  }
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

              if (isSpeech && session.waitingForFirstSpeech && session.campaignId) {
                session.waitingForFirstSpeech = false;
                log.info({ campaignId: session.campaignId }, "voicebot: customer speech detected — playing campaign script");

                const campaignAudio = await loadCampaignAudio(session.campaignId);
                if (campaignAudio) {
                  const wavParsed = parseWavToPcmS16leMono(campaignAudio);
                  if (wavParsed) {
                    let pcm = wavParsed.pcm;
                    const sr = session.mediaFormat.sample_rate;
                    if (wavParsed.sampleRate !== sr) {
                      pcm = resamplePcm16(pcm, wavParsed.sampleRate, sr);
                    }
                    session.ttsInProgress = true;
                    sendAudioToExotel(socket, session, pcm, log);
                    session.ttsInProgress = false;
                    schedulePlaybackMarkFallback(session, pcm.length, sr, log);

                    // Link to chat session as initial bot message
                    await pool.query(
                      "SELECT script_text FROM outbound_campaigns WHERE id = $1",
                      [session.campaignId]
                    ).then(r => {
                      if (r.rows.length > 0) {
                        appendAssistantChatLine(session!, r.rows[0].script_text, "campaign_script");
                      }
                    });
                  }
                } else {
                  log.error({ campaignId: session.campaignId }, "voicebot: campaign audio file not found");
                }
                break;
              }

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
            endCallSession(session.callSessionDbId, `ws_closed:${code}`).catch(() => { });
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
