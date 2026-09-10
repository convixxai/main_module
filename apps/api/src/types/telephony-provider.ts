// ============================================================
// Telephony Provider Adapter — normalized, carrier-agnostic types
//
// The core voice-AI pipeline (STT -> RAG/LLM -> TTS, session state,
// dual-leg coordination, echo detection, filler acks, persona/voice
// resolution, agent routing) should only ever see these shapes, never a
// carrier's raw wire protocol (Exotel's or Vodafone/VI's).
//
// Each carrier gets exactly one adapter implementing
// TelephonyProviderAdapter below, whose only job is translating between
// its own wire protocol and these normalized types. See:
//   docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5, §8.5.1
// ============================================================

/** Audio format for a stream's media, as reported by the carrier's `start` event. */
export interface NormalizedMediaFormat {
  encoding: string; // e.g. "raw" (16-bit linear PCM)
  sampleRateHz: number; // e.g. 8000
  bitRate?: number; // e.g. 128000
  channels?: number; // typically 1
}

/** Sent once, immediately after the WebSocket connects. */
export interface CallConnectedEvent {
  type: "connected";
}

/** Sent once, right after `connected`. Carries call/stream metadata. */
export interface CallStartEvent {
  type: "start";
  streamId: string; // Exotel: stream_sid | Vodafone: room_id
  callId: string; // Exotel: call_sid    | Vodafone: call_id
  fromNumber: string; // caller (Exotel: from | Vodafone: cli)
  toNumber: string; // dialed number (Exotel: to | Vodafone: dni)
  customParameters: Record<string, string>;
  mediaFormat: NormalizedMediaFormat;
}

/** One chunk of caller (or, in bidirectional mode, bot) audio. */
export interface CallMediaEvent {
  type: "media";
  streamId: string;
  chunkIndex: number;
  timestampMs: number;
  pcm16: Buffer; // decoded from the carrier's base64 payload
}

/** Caller pressed a DTMF digit. */
export interface CallDtmfEvent {
  type: "dtmf";
  streamId: string;
  digit: string;
  durationMs?: number;
}

/** Stream/call ended, from either side. */
export interface CallStopEvent {
  type: "stop";
  streamId: string;
  callId?: string;
  reason: string;
}

/** Acknowledgement that a previously-sent mark's audio finished playing (bidirectional only). */
export interface CallMarkAckEvent {
  type: "markAck";
  streamId: string;
  name: string;
}

export type CallEvent =
  | CallConnectedEvent
  | CallStartEvent
  | CallMediaEvent
  | CallDtmfEvent
  | CallStopEvent
  | CallMarkAckEvent;

// ---------- Outbound (core pipeline -> carrier) ----------

/** A frame ready to be sent as-is (already carrier-shaped, opaque to the core pipeline). */
export interface OutboundFrame {
  raw: string; // JSON-stringified, carrier-specific wire message
}

export interface OutboundCallParams {
  toNumber: string;
  fromNumber?: string; // caller ID override; falls back to the company's primary/default number
  customParameters?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export type CallStatus =
  | "answered"
  | "failed"
  | "completed"
  | "busy"
  | "no-answer";

export interface CallStatusEvent {
  callId: string;
  status: CallStatus;
  toNumber?: string;
  fromNumber?: string;
  durationSeconds?: number;
  raw: unknown; // original carrier payload, kept for debugging/audit
}

/**
 * One implementation per telephony carrier (ExotelAdapter, VodafoneAdapter, ...).
 * This is the ONLY place a carrier's wire protocol should be referenced —
 * the core pipeline talks exclusively in CallEvent / OutboundFrame /
 * CallStatusEvent.
 */
export interface TelephonyProviderAdapter {
  readonly providerId: string; // 'exotel' | 'vodafone'

  /** Parse one raw inbound WebSocket text frame into a normalized event, or null if unrecognized. */
  parseInboundMessage(raw: string): CallEvent | null;

  /**
   * Build zero or more outbound audio frames for this PCM push. Carriers with a
   * minimum/maximum chunk size (Exotel: 320-byte multiples; Vodafone: 1.6KB-50KB,
   * 160-byte multiples) need stateful buffering across calls to accumulate partial
   * chunks, so implementations should keep a per-streamId buffer internally rather
   * than assume one call in maps to exactly one frame out.
   */
  buildAudioFrame(streamId: string, pcm16: Buffer): OutboundFrame[];

  /** Build an outbound mark (playback-completion checkpoint) frame. */
  buildMarkFrame(streamId: string, markName: string): OutboundFrame;

  /** Build a frame that cancels not-yet-played queued audio (barge-in). */
  buildClearFrame(streamId: string): OutboundFrame;

  /** Build a frame that gracefully requests session/stream termination, if the carrier supports it. */
  buildExitFrame?(streamId: string): OutboundFrame;

  /** Trigger an outbound call via the carrier's REST API. */
  triggerOutboundCall(params: OutboundCallParams): Promise<{ callId: string }>;

  /** Normalize a carrier-specific call-status webhook payload into a shared shape. */
  parseStatusCallback(payload: unknown): CallStatusEvent;
}
