// ============================================================
// Voicebot Session Manager
// Per-call in-memory state for active Exotel WebSocket streams.
// Reference: docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §9
// ============================================================

import type { ExotelMediaFormat } from "../types/exotel-ws";
import type { CustomerSettings } from "./customer-settings";
import type { ElevenLabsVoiceSettingsPayload } from "./elevenlabs";
import type { CartesiaGenerationConfig } from "./cartesia";
import type { CartesiaTtsSession } from "./cartesia-tts-ws";
import {
  closeCartesiaTtsSession,
} from "./cartesia-tts-ws";
import { PcmChunkBuffer } from "./pcm-audio";

/** State of a single live voicebot call. */
export interface VoicebotSession {
  /** The stream_sid from Exotel's `start` message (unique per connection). */
  streamSid: string;
  /** The call_sid from Exotel (unique per phone call). */
  callSid: string;
  /** Convixx customer (tenant) UUID. */
  customerId: string;
  /** Exotel account SID. */
  accountSid: string;
  /** Caller number (E.164). */
  from: string;
  /** Called number (E.164). */
  to: string;
  /** Media format negotiated in `start`. */
  mediaFormat: ExotelMediaFormat;
  /** Row ID in exotel_call_sessions. */
  callSessionDbId: string | null;
  /** Linked chat_sessions.id for multi-turn dialogue. */
  chatSessionId: string | null;
  /** Agent UUID resolved for this call (cached after first utterance). */
  agentId: string | null;
  /** Greeting text to play on call connect. */
  greetingText?: string;
  /** Error text to play on pipeline failure. */
  errorText?: string;
  /** TTS pace override for this session. */
  ttsPace?: number | null;
  /** TTS model override for this session. */
  ttsModel?: string | null;
  /** TTS speaker override for this session. */
  ttsSpeaker?: string | null;
  /** TTS sample rate override for this session. */
  ttsSampleRate?: number | null;
  /** ElevenLabs `voice_settings` when using an elevenlabs avatar / persona. */
  elevenlabsVoiceSettings?: ElevenLabsVoiceSettingsPayload | null;
  /** Cartesia `generation_config` from cartesia avatar / tenant defaults. */
  cartesiaGenerationConfig?: CartesiaGenerationConfig | null;
  cartesiaPronunciationDictId?: string | null;
  cartesiaLegacySpeed?: "slow" | "normal" | "fast" | null;
  cartesiaIsPvcVoice?: boolean;
  /** LLM-chosen emotion for the current assistant turn (runtime, not DB). */
  cartesiaTurnEmotion?: string | null;
  /** Persistent Cartesia TTS WebSocket for this call. */
  cartesiaTts?: CartesiaTtsSession | null;
  /**
   * Last outbound PCM samples from the prior ElevenLabs utterance (mono s16le tail),
   * used to crossfade into the next `speakToExotel` for smoother joins between streaming chunks.
   */
  elevenlabsOutboundTailPcm?: Buffer;
  /** Outbound PCM chunk buffer (respects Exotel 320-byte rules). */
  outboundBuffer: PcmChunkBuffer;
  /** Accumulated inbound PCM from caller (for batch STT or VAD). */
  inboundPcm: Buffer[];
  /** Total inbound PCM bytes received so far. */
  inboundBytes: number;
  /** Mark counter for tracking playback confirmations. */
  markCounter: number;
  /** Set of mark names sent but not yet acknowledged. */
  pendingMarks: Set<string>;
  /** If set, ignore incoming audio until this timestamp to prevent tail echo (used in outbound calls). */
  echoCancellationEndTime?: number;
  /** True after outbound media is sent until Exotel acknowledges all `mark` events (playback finished). */
  isSpeaking: boolean;
  /** True while Sarvam TTS is in flight (before PCM is sent); inbound should not drive STT/VAD yet. */
  ttsInProgress: boolean;
  /**
   * Until cleared after the greeting attempt, `processUtterance` must not run — otherwise VAD/STT
   * can start during bootstrap `await`s and race ahead of (or replace) the greeting TTS.
   */
  greetingPending: boolean;
  /** If Exotel never sends inbound `mark` ack, clear pending playback after this timeout. */
  playbackFallbackTimer: ReturnType<typeof setTimeout> | null;
  /** Timestamp when the stream started. */
  startedAt: number;
  /** Custom parameters from the Exotel start message. */
  customParameters: Record<string, string>;
  /** True if the session is being cleaned up. */
  isClosing: boolean;
  /**
   * From `customer_settings.voicebot_multilingual` (DB only). Set at call `start`.
   */
  voicebotMultilingualEffective?: boolean;
  /**
   * From `customer_settings.default_language_code` at call `start` (BCP-47).
   */
  defaultLanguageCode?: string;
  /**
   * Active pipeline language (BCP-47). Mirrored from `exotel_call_sessions.current_language_code`;
   * STT/LLM/TTS must follow this unless a multilingual switch flow updates it.
   */
  currentLanguageCode?: string;
  /**
   * Count of substantive user turns (non-empty STT) — used for early-window auto language alignment.
   */
  customerQueryCount?: number;
  /** When set, the next utterance is interpreted as yes/no for switching to `targetLanguage`. */
  pendingLanguageSwitch?: {
    targetLanguage: string;
    deferredTranscript: string;
    fromLanguage: string;
    confidence: number | null;
    unclearRetries: number;
  } | null;
  /**
   * From `customer_settings.allowed_language_codes` at call `start` (BCP-47 tags).
   */
  allowedLanguageCodes?: string[];
  /**
   * Set during each utterance after STT + tenant allowlist clamp; used for TTS and RAG hints.
   */
  effectiveSttLanguageThisTurn?: string;
  /**
   * From `customer_settings.llm_max_tokens` at `start` (RAG / voice answer length cap).
   */
  llmMaxTokensForVoice?: number;
  /**
   * From `customer_settings.rag_streaming_enabled` — allow streaming LLM when combined with
   * `ttsStreamingForVoice` (see `exotel-voicebot` `streamToCall`).
   */
  ragStreamingForVoice?: boolean;
  /**
   * From `customer_settings.tts_streaming_enabled` — sentence-chunk TTS from streaming LLM
   * (`createStreamingVoiceTts`). If false while RAG streaming is on, the pipeline uses
   * full `chatOpenAI` then a single `speakToExotel`.
   */
  ttsStreamingForVoice?: boolean;
  /**
   * From `customer_settings.stt_streaming_enabled` — reserved for future streaming STT; today
   * STT is always batch; used for logging / tracing.
   */
  sttStreamingForVoice?: boolean;
  /** From `customer_settings.llm_temperature` (voice RAG). */
  llmTemperatureVoice?: number | null;
  /** From `customer_settings.llm_top_p` (voice RAG). */
  llmTopPVoice?: number | null;
  /**
   * Cached from first `runVoicebotAskPipeline` customer row in this call (skip repeated PG round-trips).
   */
  voiceRagCustomerCache?: {
    systemPrompt: string;
    defaultNoKb: string | null;
  };
  /**
   * Cached agent row from first RAG call — avoids repeated PG round-trip per utterance.
   */
    voiceRagAgentCache?: {
    systemPrompt: string;
    fallbackInstruction: string | null;
    ttsPace: number | null;
    ttsModel: string | null;
    ttsSpeaker: string | null;
    ttsSampleRate: number | null;
    avatarId: string | null;
    elevenlabsAvatarId: string | null;
    cartesiaAvatarId: string | null;
  } | null;
  /**
   * Full tenant row from `getCustomerSettings` at `start` — drives VAD, RAG caps, webhooks, etc.
   */
  customerSettingsSnapshot?: CustomerSettings | null;
  /** Fired once when `max_call_duration_seconds` elapses. */
  maxCallDurationTimer?: ReturnType<typeof setTimeout> | null;
  /** Avoid duplicate `call_end` webhooks when both `stop` and `close` fire. */
  callEndNotified?: boolean;
  /** Timestamp (Date.now()) when the current utterance started processing — for TTFA measurement. */
  utteranceProcessingStartedAt?: number;
  /** Set to true once the first outbound audio for the current answer is sent (reset per utterance). */
  ttfaLogged?: boolean;
  /**
   * Count of consecutive filler-only utterances (hmm, um, …) since the last
   * real speech or filler-ack response. When this reaches the tenant's
   * `filler_ack_threshold`, the bot responds with an ack and resets to 0.
   */
  fillerConsecutiveCount?: number;
  sttDomainWords?: Record<string, string>;
  industryContext?: Record<string, any>;
  lastUserQuery?: string | null;
  lastBotResponse?: string | null;
  consecutiveRepeatCount?: number;
  discrepantLanguageCount?: number;
  discrepantLanguageTarget?: string | null;
  addLanguagePromptRule?: {
    targetLanguage: string;
    fromLanguage: string;
  } | null;
  /** Call mode: 'inbound', 'outbound', or 'outbound_campaign'. */
  mode?: "inbound" | "outbound" | "outbound_campaign";
  /** If in campaign mode, true until the customer speaks for the first time. */
  waitingForFirstSpeech?: boolean;
  /** Linked campaign ID if in campaign mode. */
  campaignId?: string | null;
}

/**
 * In-memory session store.
 * Key: stream_sid (unique per WebSocket connection / call).
 */
const activeSessions = new Map<string, VoicebotSession>();

/**
 * Create a new session when an Exotel `start` message arrives.
 */
export function createSession(params: {
  streamSid: string;
  callSid: string;
  customerId: string;
  accountSid: string;
  from: string;
  to: string;
  mediaFormat: ExotelMediaFormat;
  customParameters?: Record<string, string>;
}): VoicebotSession {
  const session: VoicebotSession = {
    streamSid: params.streamSid,
    callSid: params.callSid,
    customerId: params.customerId,
    accountSid: params.accountSid,
    from: params.from,
    to: params.to,
    mediaFormat: params.mediaFormat,
    callSessionDbId: null,
    chatSessionId: null,
    agentId: null,
    outboundBuffer: new PcmChunkBuffer(),
    inboundPcm: [],
    inboundBytes: 0,
    markCounter: 0,
    pendingMarks: new Set(),
    isSpeaking: false,
    ttsInProgress: false,
    greetingPending: true,
    playbackFallbackTimer: null,
    startedAt: Date.now(),
    customParameters: params.customParameters || {},
    isClosing: false,
    sttDomainWords: {},
    industryContext: {},
    lastUserQuery: null,
    lastBotResponse: null,
    consecutiveRepeatCount: 0,
    mode: "inbound", // default
    waitingForFirstSpeech: false,
    campaignId: null,
  };

  activeSessions.set(params.streamSid, session);
  return session;
}

/** Get session by stream_sid. */
export function getSession(streamSid: string): VoicebotSession | undefined {
  return activeSessions.get(streamSid);
}

/** Remove session on stream end. */
export function removeSession(streamSid: string): void {
  const session = activeSessions.get(streamSid);
    if (session) {
      session.isClosing = true;
      session.outboundBuffer.reset();
      session.inboundPcm = [];
      session.elevenlabsOutboundTailPcm = undefined;
    closeCartesiaTtsSession(session);
    if (session.playbackFallbackTimer) {
      clearTimeout(session.playbackFallbackTimer);
      session.playbackFallbackTimer = null;
    }
    if (session.maxCallDurationTimer) {
      clearTimeout(session.maxCallDurationTimer);
      session.maxCallDurationTimer = null;
    }
  }
  activeSessions.delete(streamSid);
}

/** Get all active session stream_sids for a given customer. */
export function getActiveSessionsForCustomer(
  customerId: string
): VoicebotSession[] {
  const sessions: VoicebotSession[] = [];
  for (const session of activeSessions.values()) {
    if (session.customerId === customerId) {
      sessions.push(session);
    }
  }
  return sessions;
}

/** Total active sessions count (all tenants). */
export function getActiveSessionCount(): number {
  return activeSessions.size;
}

/** Generate the next mark name for a session. */
export function nextMarkName(session: VoicebotSession): string {
  session.markCounter++;
  return `mark_${session.markCounter}`;
}
