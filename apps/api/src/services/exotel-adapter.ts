// ============================================================
// ExotelAdapter — first implementation of TelephonyProviderAdapter
//
// Translates between Exotel's raw WebSocket/REST wire protocol and the
// normalized types in types/telephony-provider.ts. This is standalone,
// additive code: it is NOT wired into apps/api/src/routes/exotel-voicebot.ts
// or the live /exotel/voicebot/:customerId route. The live route keeps
// reading customer_exotel_settings and building Exotel-shaped messages
// inline exactly as it does today — zero behavior change to live calls.
//
// Reference: docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5
// ============================================================

import {
  parseExotelMessage,
  type ExotelStartMessage,
  type ExotelMediaMessage,
  type ExotelDtmfMessage,
  type ExotelStopMessage,
  type ExotelMarkMessage,
  type ExotelOutboundMedia,
  type ExotelOutboundMark,
  type ExotelOutboundClear,
} from "../types/exotel-ws";
import type {
  CallEvent,
  CallStatus,
  CallStatusEvent,
  OutboundCallParams,
  OutboundFrame,
  TelephonyProviderAdapter,
} from "../types/telephony-provider";
import { PcmChunkBuffer, decodeBase64Pcm, encodeBase64Pcm } from "./pcm-audio";
import {
  getDecryptedCredentials,
  getTelephonySettings,
  type ExotelCredentials,
} from "./telephony-settings";
import {
  exotelConnectCall,
  restApiBaseUrlFromSubdomain,
} from "./exotel-connect-call";
import { statusPayloadIndicatesCalleeLegAnswered } from "./exotel-outbound-flow";

/** Exotel -> normalized CallEvent. Returns null for events we don't recognize/need. */
export function mapExotelEventToCallEvent(
  raw: string
): CallEvent | null {
  const msg = parseExotelMessage(raw);
  if (!msg) return null;

  switch (msg.event) {
    case "connected":
      return { type: "connected" };

    case "start": {
      const m = msg as ExotelStartMessage;
      const s = m.start;
      return {
        type: "start",
        streamId: s.stream_sid,
        callId: s.call_sid,
        fromNumber: s.from,
        toNumber: s.to,
        customParameters: s.custom_parameters ?? {},
        mediaFormat: {
          encoding: s.media_format.encoding,
          sampleRateHz: s.media_format.sample_rate,
          bitRate: s.media_format.bit_rate,
          channels: s.media_format.channels,
        },
      };
    }

    case "media": {
      const m = msg as ExotelMediaMessage;
      return {
        type: "media",
        streamId: m.stream_sid ?? "",
        chunkIndex: Number(m.media.chunk) || 0,
        timestampMs: Number(m.media.timestamp) || 0,
        pcm16: decodeBase64Pcm(m.media.payload),
      };
    }

    case "dtmf": {
      const m = msg as ExotelDtmfMessage;
      return {
        type: "dtmf",
        streamId: m.stream_sid ?? "",
        digit: m.dtmf.digit,
        durationMs: m.dtmf.duration,
      };
    }

    case "stop": {
      const m = msg as ExotelStopMessage;
      return {
        type: "stop",
        streamId: m.stream_sid ?? "",
        callId: m.stop.call_sid,
        reason: m.stop.reason,
      };
    }

    case "mark": {
      const m = msg as ExotelMarkMessage;
      return {
        type: "markAck",
        streamId: m.stream_sid ?? "",
        name: m.mark.name,
      };
    }

    default:
      return null;
  }
}

function frame(message: object): OutboundFrame {
  return { raw: JSON.stringify(message) };
}

/** Best-effort mapping of an Exotel StatusCallback payload to the normalized CallStatus union. */
function mapExotelCallStatus(payload: Record<string, unknown>): CallStatus {
  if (statusPayloadIndicatesCalleeLegAnswered(payload)) return "answered";

  const legs = payload.Legs as unknown[] | undefined;
  const leg2 = Array.isArray(legs) && legs.length > 1 ? (legs[1] as Record<string, unknown>) : undefined;
  const status = String(leg2?.Status ?? payload.Status ?? "").toLowerCase().trim();

  if (status === "busy") return "busy";
  if (status === "no-answer") return "no-answer";
  if (status === "completed" || status === "in-progress") return "completed";
  return "failed";
}

/**
 * ExotelAdapter — providerId 'exotel'. See file header: not wired into the
 * live call path yet, but a complete, correct implementation of the
 * TelephonyProviderAdapter contract against Exotel's real wire protocol.
 */
export class ExotelAdapter implements TelephonyProviderAdapter {
  readonly providerId = "exotel";

  /** Per-streamId chunk buffer, mirroring exotel-voicebot.ts's session.outboundBuffer. */
  private readonly chunkBuffers = new Map<string, PcmChunkBuffer>();

  parseInboundMessage(raw: string): CallEvent | null {
    return mapExotelEventToCallEvent(raw);
  }

  /**
   * Pushes pcm16 into a per-stream PcmChunkBuffer (same class + defaults
   * exotel-voicebot.ts's sendAudioToExotel uses) and returns one frame per
   * fully-aligned 320-byte-multiple chunk emitted.
   *
   * Known simplification vs. the live sendAudioToExotel: this only returns
   * chunks produced by push() (the incremental/streaming path, matching
   * omitMark:true today). It does not flush+pad the trailing partial chunk
   * at utterance end — the TelephonyProviderAdapter interface doesn't yet
   * model an "utterance/turn boundary" signal for the adapter to flush on,
   * so end-of-utterance flushing stays a call-site concern until the core
   * pipeline is actually wired through adapters.
   */
  buildAudioFrame(streamId: string, pcm16: Buffer): OutboundFrame[] {
    let buf = this.chunkBuffers.get(streamId);
    if (!buf) {
      buf = new PcmChunkBuffer();
      this.chunkBuffers.set(streamId, buf);
    }
    const chunks = buf.push(pcm16);
    return chunks.map((chunk) => {
      const media: ExotelOutboundMedia = {
        event: "media",
        stream_sid: streamId,
        media: { payload: encodeBase64Pcm(chunk) },
      };
      return frame(media);
    });
  }

  /** Drops the per-stream chunk buffer. Call once a stream/call ends. */
  releaseStream(streamId: string): void {
    this.chunkBuffers.delete(streamId);
  }

  buildMarkFrame(streamId: string, markName: string): OutboundFrame {
    const mark: ExotelOutboundMark = {
      event: "mark",
      stream_sid: streamId,
      mark: { name: markName },
    };
    return frame(mark);
  }

  /**
   * Builds Exotel's documented `clear` frame. Known gap found during
   * exploration: exotel-voicebot.ts never sends this today (barge-in only
   * resets local session state) — this method is not yet exercised by any
   * live code path, but implements the documented wire shape correctly.
   */
  buildClearFrame(streamId: string): OutboundFrame {
    const clear: ExotelOutboundClear = { event: "clear", stream_sid: streamId };
    return frame(clear);
  }

  // Exotel's protocol has no "exit" equivalent (that's Vodafone/VI-specific) — omitted.

  async triggerOutboundCall(
    params: OutboundCallParams
  ): Promise<{ callId: string }> {
    if (!params.fromNumber) {
      throw new Error(
        "ExotelAdapter.triggerOutboundCall requires fromNumber — this adapter does not " +
          "replicate exotel-outbound-call.ts's default-caller-ID fallback chain yet."
      );
    }

    const customerId = params.metadata?.customerId as string | undefined;
    if (!customerId) {
      throw new Error("ExotelAdapter.triggerOutboundCall requires metadata.customerId");
    }

    const settings = await getTelephonySettings(customerId);
    if (!settings || settings.provider_id !== "exotel") {
      throw new Error(`No exotel company_telephony_settings row for customer_id=${customerId}`);
    }
    const creds = getDecryptedCredentials<ExotelCredentials>(settings);
    if (!creds.account_sid || !creds.api_key || !creds.api_token) {
      throw new Error(`Incomplete Exotel credentials for customer_id=${customerId}`);
    }

    const restApiBaseUrl = restApiBaseUrlFromSubdomain(creds.subdomain) ?? undefined;

    const { call } = await exotelConnectCall({
      accountSid: creds.account_sid,
      apiKey: creds.api_key,
      apiToken: creds.api_token,
      from: params.fromNumber,
      to: params.toNumber,
      callerId: params.fromNumber,
      restApiBaseUrl,
    });

    const callId = call && typeof call.Sid === "string" ? call.Sid : undefined;
    if (!callId) {
      throw new Error("Exotel connect call succeeded but response had no Call.Sid");
    }
    return { callId };
  }

  parseStatusCallback(payload: unknown): CallStatusEvent {
    const p = (payload ?? {}) as Record<string, unknown>;
    const callId = typeof p.CallSid === "string" ? p.CallSid : "";
    return {
      callId,
      status: mapExotelCallStatus(p),
      toNumber: typeof p.To === "string" ? p.To : undefined,
      fromNumber: typeof p.From === "string" ? p.From : undefined,
      durationSeconds:
        typeof p.CallDuration === "string" ? parseInt(p.CallDuration, 10) : undefined,
      raw: payload,
    };
  }
}
