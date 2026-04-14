import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env";

const MAX_JSON_PREVIEW = 6000;

/** Structured realtime trace for Voicebot (PM2 / pino). Set `LOG_VOICEBOT_TRACE=false` to disable. */
export function voiceTrace(
  log: FastifyBaseLogger | undefined,
  step: string,
  fields: Record<string, unknown>
): void {
  if (!log || !env.logVoicebotTrace) return;
  log.info({ voicebotTrace: step, ...fields }, `voicebot:${step}`);
}

function truncate(s: string, max = MAX_JSON_PREVIEW): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

/** Safe JSON for logs (truncate; strip huge base64). */
export function safeJsonForLog(value: unknown): unknown {
  try {
    const s = JSON.stringify(value);
    return JSON.parse(truncate(s));
  } catch {
    return String(value).slice(0, 500);
  }
}

/** Redact Exotel inbound JSON for logging (never log raw media base64). */
export function redactInboundExotelForLog(msg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...msg };
  if (out.event === "media" && out.media && typeof out.media === "object") {
    const m = out.media as Record<string, unknown>;
    const p = m.payload;
    out.media = {
      ...m,
      payload: typeof p === "string" ? `[base64 ${p.length} chars]` : "[binary]",
    };
  }
  return out;
}

/** Redact outbound message to Exotel. */
export function redactOutboundExotelForLog(msg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...msg };
  if (out.event === "media" && out.media && typeof out.media === "object") {
    const m = out.media as Record<string, unknown>;
    const p = m.payload;
    out.media = {
      ...m,
      payload: typeof p === "string" ? `[base64 ${p.length} chars]` : "[binary]",
    };
  }
  return out;
}
