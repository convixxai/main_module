// ============================================================
// Vodafone (VI) Voice Streaming WebSocket Protocol Types
// Source: vendor doc "Voice Streaming – User Manual – Agent Calling"
// Reference: docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5.1
//
// These are the raw, VI-shaped wire types. Nothing outside
// services/vodafone-adapter.ts (once written) should import from this
// file directly — the core pipeline only sees the normalized types in
// types/telephony-provider.ts.
// ============================================================

// ---------- Inbound (VI → Convixx) ----------

/** Sent immediately after the WebSocket connection is established. */
export interface VodafoneConnectedMessage {
  event: "connected";
}

/** Media format info sent in the `start` message. VI documents this as a fixed shape: raw/8000/128000. */
export interface VodafoneMediaFormat {
  encoding: string; // "raw" (16-bit linear PCM)
  sample_rate: string; // "8000"
  bit_rate: string; // "128000"
}

/** Sent once, right after `connected`. Carries call/stream metadata + custom parameters. */
export interface VodafoneStartMessage {
  event: "start";
  sequence_number: number;
  room_id: string;
  start: {
    room_id: string;
    call_id: string;
    cli: string; // caller number
    dni: string; // recipient/dialed number
    custom_parameters?: Record<string, string>; // up to 3 key-value pairs, per Streaming Object config
    media_format: VodafoneMediaFormat;
  };
}

/** Audio packet, base64 PCM. Sent continuously by VI (unidirectional + bidirectional). */
export interface VodafoneMediaMessage {
  event: "media";
  sequence_number: number;
  room_id: string;
  media: {
    chunk: number; // chunk index in sequence
    timestamp: string; // offset in ms from start of stream
    payload: string; // base64-encoded 16-bit linear PCM, 8kHz, 128kbps
  };
}

/** DTMF digit pressed by the caller. Bidirectional streams in Voice Bot flows only. */
export interface VodafoneDtmfMessage {
  event: "dtmf";
  sequence_number: number;
  room_id: string;
  dtmf: {
    duration: string; // duration in ms
    digit: string;
  };
}

/** Stream/call ended. VI also sends this unilaterally (with a reason) and disconnects the call
 *  if it receives malformed data, unsupported size, or an unsupported format from us. */
export interface VodafoneStopMessage {
  event: "stop";
  sequence_number: number;
  room_id: string;
  stop: {
    call_id: string;
    reason: string;
  };
}

/** Checkpoint for media playback completion (bidirectional only). VI echoes back a mark we sent,
 *  once the matching audio has finished playing; VI can also send its own. */
export interface VodafoneMarkMessage {
  event: "mark";
  sequence_number: number;
  room_id: string;
  mark: {
    name: string;
  };
}

/** Union of all messages VI can send to us. */
export type VodafoneInboundMessage =
  | VodafoneConnectedMessage
  | VodafoneStartMessage
  | VodafoneMediaMessage
  | VodafoneDtmfMessage
  | VodafoneStopMessage
  | VodafoneMarkMessage;

// ---------- Outbound (Convixx → VI, bidirectional only) ----------

/** Send synthesized speech audio to VI for playback to the caller.
 *  NOTE: payload size must be 1.6KB-50KB and a multiple of 160 bytes — see
 *  chunkVodafoneAudio() below; VI will terminate the stream + disconnect
 *  the call on a violation. */
export interface VodafoneOutboundMedia {
  event: "media";
  sequence_number: number;
  room_id: string;
  media: {
    chunk: number;
    timestamp: string;
    payload: string; // base64-encoded 16-bit linear PCM, 8kHz, 128kbps
  };
}

/** Request an ack when specific queued audio has finished playing. VI replies with a matching `mark`. */
export interface VodafoneOutboundMark {
  event: "mark";
  sequence_number: number;
  room_id: string;
  mark: {
    name: string;
  };
}

/** Clear previously sent audio that has not yet been played (barge-in). Only cancels
 *  whole not-yet-started queued messages, not the one currently playing — see roadmap §8.5.1. */
export interface VodafoneOutboundClear {
  event: "clear";
  room_id: string;
}

/** Request graceful termination of the session for this room_id. Used to trigger the
 *  "patch to live agent" webhook flow — see roadmap §8.5.1. */
export interface VodafoneOutboundExit {
  event: "exit";
  room_id: string;
}

/** Union of all messages we can send to VI. */
export type VodafoneOutboundMessage =
  | VodafoneOutboundMedia
  | VodafoneOutboundMark
  | VodafoneOutboundClear
  | VodafoneOutboundExit;

// ---------- Call-patching webhook (VI → customer, on exit/disconnect) ----------

/** Ping-back request VI sends to the customer-configured webhook once the stream exits/disconnects. */
export interface VodafonePatchWebhookRequest {
  Callid: string;
  dni: string;
  cli: string;
}

/** Response the customer webhook must return: whether to transfer to a live agent, and to which number. */
export interface VodafonePatchWebhookResponse {
  callstatus: "1" | "0"; // 1 = transfer the call, 0 = hangup
  rm_number?: string; // 10-digit agent number, required when callstatus is "1"
}

// ---------- Chunking constraints (roadmap §8.5.1) ----------

export const VODAFONE_MEDIA_CHUNK_MIN_BYTES = 1600; // ~100ms of audio
export const VODAFONE_MEDIA_CHUNK_MAX_BYTES = 51200; // 50KB
export const VODAFONE_MEDIA_CHUNK_ALIGNMENT_BYTES = 160; // 10ms of 8kHz 16-bit PCM

/**
 * Splits raw PCM into VI-compliant chunks: each chunk is a multiple of 160
 * bytes, and (where the total allows) between 1.6KB and 50KB.
 *
 * Precondition: `pcm16.length` should itself be a multiple of 160 bytes
 * (true for audio produced on 10ms-frame boundaries, which is how both
 * this pipeline's STT capture and TTS synthesis already operate) — that
 * guarantees every chunk this returns, including the final/remainder one,
 * is also a multiple of 160 bytes. Passing audio that isn't 160-byte
 * aligned will produce a non-compliant trailing chunk; VI's own doc says
 * it terminates the stream + disconnects the call on an unsupported size.
 */
export function chunkVodafoneAudio(
  pcm16: Buffer,
  targetChunkBytes: number = VODAFONE_MEDIA_CHUNK_MIN_BYTES
): Buffer[] {
  const size = resolveAlignedChunkSize(targetChunkBytes);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pcm16.length; offset += size) {
    chunks.push(pcm16.subarray(offset, offset + size));
  }
  return chunks;
}

/** Shared size-clamping logic between chunkVodafoneAudio and VodafoneChunkBuffer. */
function resolveAlignedChunkSize(targetChunkBytes: number): number {
  const clamped = Math.min(
    VODAFONE_MEDIA_CHUNK_MAX_BYTES,
    Math.max(VODAFONE_MEDIA_CHUNK_ALIGNMENT_BYTES, targetChunkBytes)
  );
  return (
    clamped - (clamped % VODAFONE_MEDIA_CHUNK_ALIGNMENT_BYTES) ||
    VODAFONE_MEDIA_CHUNK_ALIGNMENT_BYTES
  );
}

/**
 * Stateful counterpart to chunkVodafoneAudio, for a call where PCM arrives in
 * arbitrary-sized pushes over time (e.g. incremental TTS deltas) rather than
 * as one complete buffer. Mirrors services/pcm-audio.ts's PcmChunkBuffer:
 * accumulates pushed bytes and emits only full, alignment-compliant chunks;
 * a trailing partial chunk stays buffered until a later push completes it.
 *
 * Known simplification (matches ExotelAdapter's PcmChunkBuffer usage): this
 * has no explicit "flush the trailing partial chunk with padding" step —
 * the TelephonyProviderAdapter interface doesn't yet model an
 * utterance/turn-boundary signal for an adapter to flush on.
 */
export class VodafoneChunkBuffer {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly chunkSize: number;

  constructor(targetChunkBytes: number = VODAFONE_MEDIA_CHUNK_MIN_BYTES) {
    this.chunkSize = resolveAlignedChunkSize(targetChunkBytes);
  }

  /** Append PCM data. Returns any complete, alignment-compliant chunks ready to send. */
  push(data: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const chunks: Buffer[] = [];
    while (this.buffer.length >= this.chunkSize) {
      chunks.push(this.buffer.subarray(0, this.chunkSize));
      this.buffer = this.buffer.subarray(this.chunkSize);
    }
    return chunks;
  }

  /** Bytes currently buffered but not yet emitted as a full chunk. */
  get pending(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

// ---------- Helpers ----------

/** Parse raw JSON text into a typed inbound VI message. */
export function parseVodafoneMessage(raw: string): VodafoneInboundMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== "object" || typeof msg.event !== "string") {
      return null;
    }
    return msg as VodafoneInboundMessage;
  } catch {
    return null;
  }
}
