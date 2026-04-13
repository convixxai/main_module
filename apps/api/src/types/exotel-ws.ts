// ============================================================
// Exotel WebSocket Protocol Types
// Reference: docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §8
// ============================================================

// ---------- Inbound (Exotel → Convixx) ----------

/** Sent once after the WebSocket is established. */
export interface ExotelConnectedMessage {
  event: "connected";
  protocol?: string;
  version?: string;
}

/** Media format info sent in the `start` message. */
export interface ExotelMediaFormat {
  encoding: string;       // e.g. "raw" / "slin"
  sample_rate: number;    // 8000, 16000, or 24000
  bit_rate?: number;      // e.g. 256000
  channels?: number;      // typically 1
}

/** Sent once after `connected`. Carries call/stream metadata. */
export interface ExotelStartMessage {
  event: "start";
  sequence_number?: string;
  start: {
    stream_sid: string;
    call_sid: string;
    account_sid: string;
    from: string;
    to: string;
    custom_parameters?: Record<string, string>;
    media_format: ExotelMediaFormat;
  };
  stream_sid?: string;
}

/** Caller audio chunk — sent continuously during the call. */
export interface ExotelMediaMessage {
  event: "media";
  sequence_number?: string;
  stream_sid?: string;
  media: {
    chunk: string;       // chunk index
    timestamp: string;   // milliseconds since stream start
    payload: string;     // base64 encoded PCM (slin/16-bit LE mono)
  };
}

/** DTMF digit pressed by the caller. */
export interface ExotelDtmfMessage {
  event: "dtmf";
  stream_sid?: string;
  dtmf: {
    digit: string;       // "0"–"9", "*", "#"
    duration?: number;
  };
}

/** Stream/call ended. */
export interface ExotelStopMessage {
  event: "stop";
  stream_sid?: string;
  stop: {
    reason: string;      // e.g. "callerHangup", "error"
    account_sid?: string;
    call_sid?: string;
  };
}

/** Acknowledgement that audio previously sent + marked has been played. */
export interface ExotelMarkMessage {
  event: "mark";
  stream_sid?: string;
  mark: {
    name: string;
  };
}

/** Union of all messages Exotel can send. */
export type ExotelInboundMessage =
  | ExotelConnectedMessage
  | ExotelStartMessage
  | ExotelMediaMessage
  | ExotelDtmfMessage
  | ExotelStopMessage
  | ExotelMarkMessage;

// ---------- Outbound (Convixx → Exotel) ----------

/** Send synthesized speech audio to Exotel for playback to the caller. */
export interface ExotelOutboundMedia {
  event: "media";
  stream_sid: string;
  media: {
    payload: string;     // base64 encoded PCM (same format as inbound)
  };
}

/** Request notification when queued audio has been played. */
export interface ExotelOutboundMark {
  event: "mark";
  stream_sid: string;
  mark: {
    name: string;        // identifier echoed back in inbound mark
  };
}

/** Clear unplayed audio from the queue (barge-in). */
export interface ExotelOutboundClear {
  event: "clear";
  stream_sid: string;
}

/** Union of all messages Convixx can send to Exotel. */
export type ExotelOutboundMessage =
  | ExotelOutboundMedia
  | ExotelOutboundMark
  | ExotelOutboundClear;

// ---------- Helpers ----------

/** Parse raw JSON text into a typed inbound message. */
export function parseExotelMessage(raw: string): ExotelInboundMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== "object" || typeof msg.event !== "string") {
      return null;
    }
    return msg as ExotelInboundMessage;
  } catch {
    return null;
  }
}
