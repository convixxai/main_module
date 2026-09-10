// ============================================================
// VodafoneAdapter — second implementation of TelephonyProviderAdapter
//
// Translates between VI's (Vodafone Idea's Voice Streaming product) raw
// WebSocket wire protocol and the normalized types in
// types/telephony-provider.ts. Standalone, additive code, following the
// same pattern as services/exotel-adapter.ts. Wired into
// routes/vodafone-voicebot.ts (GET /telephony/vodafone/voicebot/:customerId),
// which requires an enabled company_telephony_settings row with
// provider_id='vodafone' — create one via routes/vodafone-settings.ts
// (PUT /customers/:customerId/vodafone-settings).
//
// Several pieces of this adapter are DELIBERATELY INCOMPLETE because the
// vendor spec we have doesn't cover them yet (see
// docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md
// §8.5.1 "Still open" items 3/4/5): the WS auth/handshake mechanism, the
// outbound-call REST API contract, and a general call-status callback
// shape. Rather than guess a fictional contract for those, the affected
// methods throw a clear, explicit "not available yet" error naming
// exactly what's missing — so nobody mistakes a stub for a real
// integration if this is wired up before that vendor detail arrives.
//
// Reference: docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5, §8.5.1
// ============================================================

import {
  parseVodafoneMessage,
  VodafoneChunkBuffer,
  type VodafoneStartMessage,
  type VodafoneMediaMessage,
  type VodafoneDtmfMessage,
  type VodafoneStopMessage,
  type VodafoneMarkMessage,
  type VodafoneOutboundMedia,
  type VodafoneOutboundMark,
  type VodafoneOutboundClear,
  type VodafoneOutboundExit,
  type VodafonePatchWebhookRequest,
  type VodafonePatchWebhookResponse,
} from "../types/vodafone-ws";
import type {
  CallEvent,
  CallStatusEvent,
  OutboundCallParams,
  OutboundFrame,
  TelephonyProviderAdapter,
} from "../types/telephony-provider";
import { decodeBase64Pcm, encodeBase64Pcm } from "./pcm-audio";

function frame(message: object): OutboundFrame {
  return { raw: JSON.stringify(message) };
}

/** VI -> normalized CallEvent. Returns null for events we don't recognize/need. */
export function mapVodafoneEventToCallEvent(raw: string): CallEvent | null {
  const msg = parseVodafoneMessage(raw);
  if (!msg) return null;

  switch (msg.event) {
    case "connected":
      return { type: "connected" };

    case "start": {
      const m = msg as VodafoneStartMessage;
      const s = m.start;
      return {
        type: "start",
        streamId: s.room_id,
        callId: s.call_id,
        fromNumber: s.cli,
        toNumber: s.dni,
        customParameters: s.custom_parameters ?? {},
        mediaFormat: {
          encoding: s.media_format.encoding,
          sampleRateHz: Number(s.media_format.sample_rate) || 0,
          bitRate: Number(s.media_format.bit_rate) || undefined,
        },
      };
    }

    case "media": {
      const m = msg as VodafoneMediaMessage;
      return {
        type: "media",
        streamId: m.room_id,
        chunkIndex: m.media.chunk,
        timestampMs: Number(m.media.timestamp) || 0,
        pcm16: decodeBase64Pcm(m.media.payload),
      };
    }

    case "dtmf": {
      const m = msg as VodafoneDtmfMessage;
      return {
        type: "dtmf",
        streamId: m.room_id,
        digit: m.dtmf.digit,
        durationMs: Number(m.dtmf.duration) || undefined,
      };
    }

    case "stop": {
      const m = msg as VodafoneStopMessage;
      return {
        type: "stop",
        streamId: m.room_id,
        callId: m.stop.call_id,
        reason: m.stop.reason,
      };
    }

    case "mark": {
      const m = msg as VodafoneMarkMessage;
      return {
        type: "markAck",
        streamId: m.room_id,
        name: m.mark.name,
      };
    }

    default:
      return null;
  }
}

/**
 * Builds the response a customer webhook must return to VI's "patch to live
 * agent" ping-back (roadmap §8.5.1) — not part of TelephonyProviderAdapter
 * itself (it's an HTTP webhook response, not a WS frame), but colocated
 * here since it's Vodafone-specific glue the future webhook route will need.
 */
export function buildVodafonePatchResponse(
  decision: { transfer: true; agentNumber: string } | { transfer: false }
): VodafonePatchWebhookResponse {
  if (decision.transfer) {
    return { callstatus: "1", rm_number: decision.agentNumber };
  }
  return { callstatus: "0" };
}

/** Type guard for the "patch to live agent" webhook request body VI will POST. */
export function isVodafonePatchWebhookRequest(
  body: unknown
): body is VodafonePatchWebhookRequest {
  const b = body as Record<string, unknown> | null;
  return (
    !!b &&
    typeof b.Callid === "string" &&
    typeof b.dni === "string" &&
    typeof b.cli === "string"
  );
}

/**
 * VodafoneAdapter — providerId 'vodafone'. See file header: standalone,
 * unwired, and deliberately incomplete on the three points the vendor spec
 * doesn't cover yet (auth, outbound REST API, general status callbacks).
 */
export class VodafoneAdapter implements TelephonyProviderAdapter {
  readonly providerId = "vodafone";

  /** Per-streamId chunk buffer — see VodafoneChunkBuffer's own docs for the chunking rule. */
  private readonly chunkBuffers = new Map<string, VodafoneChunkBuffer>();

  /** Monotonic per-stream sequence counter for outbound media/mark frames (VI requires sequence_number on every message). */
  private readonly sequenceCounters = new Map<string, number>();
  /** Monotonic per-stream chunk-index counter for outbound media frames (VI's `media.chunk` — index within the whole stream, not per-push). */
  private readonly chunkIndexCounters = new Map<string, number>();

  private nextSequenceNumber(streamId: string): number {
    const next = (this.sequenceCounters.get(streamId) ?? 0) + 1;
    this.sequenceCounters.set(streamId, next);
    return next;
  }

  private nextChunkIndex(streamId: string): number {
    const next = (this.chunkIndexCounters.get(streamId) ?? -1) + 1;
    this.chunkIndexCounters.set(streamId, next);
    return next;
  }

  parseInboundMessage(raw: string): CallEvent | null {
    return mapVodafoneEventToCallEvent(raw);
  }

  /**
   * Pushes pcm16 into a per-stream VodafoneChunkBuffer and returns one frame
   * per fully-aligned chunk emitted (1.6KB-50KB, multiple of 160 bytes —
   * see roadmap §8.5.1). Same documented simplification as ExotelAdapter:
   * no end-of-utterance flush yet, since the interface has no turn-boundary
   * signal for the adapter to flush on.
   */
  buildAudioFrame(streamId: string, pcm16: Buffer): OutboundFrame[] {
    let buf = this.chunkBuffers.get(streamId);
    if (!buf) {
      buf = new VodafoneChunkBuffer();
      this.chunkBuffers.set(streamId, buf);
    }
    const chunks = buf.push(pcm16);
    return chunks.map((chunk) => {
      const media: VodafoneOutboundMedia = {
        event: "media",
        sequence_number: this.nextSequenceNumber(streamId),
        room_id: streamId,
        media: {
          chunk: this.nextChunkIndex(streamId),
          timestamp: String(Date.now()),
          payload: encodeBase64Pcm(chunk),
        },
      };
      return frame(media);
    });
  }

  /** Drops the per-stream chunk buffer and sequence counter. Call once a stream/call ends. */
  releaseStream(streamId: string): void {
    this.chunkBuffers.delete(streamId);
    this.sequenceCounters.delete(streamId);
    this.chunkIndexCounters.delete(streamId);
  }

  buildMarkFrame(streamId: string, markName: string): OutboundFrame {
    const mark: VodafoneOutboundMark = {
      event: "mark",
      sequence_number: this.nextSequenceNumber(streamId),
      room_id: streamId,
      mark: { name: markName },
    };
    return frame(mark);
  }

  /**
   * Builds VI's documented `clear` frame (barge-in). Per roadmap §8.5.1,
   * VI's own doc says this only cancels whole not-yet-started queued
   * messages, not the one currently playing — send audio in small chunks
   * (near the 1.6KB floor) if responsive barge-in matters for a given call.
   */
  buildClearFrame(streamId: string): OutboundFrame {
    const clear: VodafoneOutboundClear = { event: "clear", room_id: streamId };
    return frame(clear);
  }

  /**
   * Builds VI's `exit` frame — requests graceful session teardown, which is
   * also what triggers VI's "patch to live agent" webhook flow (roadmap
   * §8.5.1). Exotel has no equivalent; this is a genuinely Vodafone-only
   * capability the normalized interface's optional buildExitFrame exists for.
   */
  buildExitFrame(streamId: string): OutboundFrame {
    const exit: VodafoneOutboundExit = { event: "exit", room_id: streamId };
    return frame(exit);
  }

  /**
   * NOT IMPLEMENTED: VI's outbound-call-origination REST API contract is
   * not in the vendor doc we have (roadmap §8.5.1 "still open" item 4) —
   * only that streaming "can also be started via API for all types of
   * calls." We don't know the endpoint, auth, or request/response shape,
   * so this throws rather than guessing a fictional contract that could
   * silently do the wrong thing (or nothing) if ever actually called.
   * Replace this once VI's REST API reference is in hand.
   */
  async triggerOutboundCall(_params: OutboundCallParams): Promise<{ callId: string }> {
    throw new Error(
      "VodafoneAdapter.triggerOutboundCall is not implemented: VI's outbound-call REST API " +
        "contract (endpoint, auth, request/response shape) is not yet documented — see " +
        "docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5.1 open item 4."
    );
  }

  /**
   * BEST-EFFORT / INCOMPLETE: the only VI webhook this codebase has a
   * documented shape for is the "patch to live agent" ping-back (see
   * isVodafonePatchWebhookRequest/buildVodafonePatchResponse above), which
   * is a routing decision request, not a general call-status notification.
   * VI has not published a general call-lifecycle status-callback shape
   * (roadmap §8.5.1 open item 5), so there's nothing real to parse here yet.
   * This throws rather than fabricating field names that don't exist in any
   * real VI payload.
   */
  parseStatusCallback(_payload: unknown): CallStatusEvent {
    throw new Error(
      "VodafoneAdapter.parseStatusCallback is not implemented: VI has not published a general " +
        "call-lifecycle status-callback shape — only the 'patch to live agent' webhook is documented " +
        "(see isVodafonePatchWebhookRequest/buildVodafonePatchResponse in this file). See " +
        "docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5.1 open item 5."
    );
  }
}
