// ============================================================
// Voicebot Session Manager
// Per-call in-memory state for active Exotel WebSocket streams.
// Reference: docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §9
// ============================================================

import type { ExotelMediaFormat } from "../types/exotel-ws";
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
  /** True after outbound media is sent until Exotel acknowledges all `mark` events (playback finished). */
  isSpeaking: boolean;
  /** True while Sarvam TTS is in flight (before PCM is sent); inbound should not drive STT/VAD yet. */
  ttsInProgress: boolean;
  /** If Exotel never sends inbound `mark` ack, clear pending playback after this timeout. */
  playbackFallbackTimer: ReturnType<typeof setTimeout> | null;
  /** Timestamp when the stream started. */
  startedAt: number;
  /** Custom parameters from the Exotel start message. */
  customParameters: Record<string, string>;
  /** True if the session is being cleaned up. */
  isClosing: boolean;
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
    playbackFallbackTimer: null,
    startedAt: Date.now(),
    customParameters: params.customParameters || {},
    isClosing: false,
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
    if (session.playbackFallbackTimer) {
      clearTimeout(session.playbackFallbackTimer);
      session.playbackFallbackTimer = null;
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
