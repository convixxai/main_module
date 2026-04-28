// ============================================================
// Outbound Voicebot — callee answered gate + CustomField parsing
// Reference: Exotel StatusCallback answered (second leg), Connect CustomField
// ============================================================

import type { FastifyBaseLogger } from "fastify";
import { pool } from "../config/db";

const CCS_RE = /ccs=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;

/** Parse `ccs=<uuid>` from Connect API CustomField (≤128 chars). */
export function parseCcsSessionIdFromCustomField(cf: string | null | undefined): string | null {
  if (!cf?.trim()) return null;
  const m = cf.trim().match(CCS_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Extract Convixx `exotel_call_sessions.id` from Exotel Voicebot `custom_parameters`.
 * Forwarding of Connect `CustomField` into WS depends on Exotel config; also scans values for `ccs=<uuid>`.
 */
export function extractOutboundSessionIdFromCustomParameters(
  cp: Record<string, string> | undefined
): string | null {
  if (!cp || typeof cp !== "object") return null;
  const direct =
    cp.ccs ??
    cp.CCS ??
    cp.CustomField ??
    cp.custom_field ??
    cp.customField;
  if (typeof direct === "string") {
    const u = direct.trim();
    if (/^[0-9a-f-]{36}$/i.test(u)) return u.toLowerCase();
    const fromCf = parseCcsSessionIdFromCustomField(u);
    if (fromCf) return fromCf;
  }
  for (const v of Object.values(cp)) {
    if (typeof v !== "string") continue;
    const fromCf = parseCcsSessionIdFromCustomField(v);
    if (fromCf) return fromCf;
    const m = v.match(/ccs=([0-9a-f-]{36})/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * True when StatusCallback indicates the **second leg** (callee) has answered — safe to run greeting.
 * See Exotel docs: answered events include Legs[] for Connect two numbers.
 */
export function statusPayloadIndicatesCalleeLegAnswered(payload: Record<string, unknown>): boolean {
  const ev = String(payload.EventType ?? payload.eventType ?? "").toLowerCase();
  if (ev !== "answered") return false;
  const legs = payload.Legs as unknown[] | undefined;
  if (!Array.isArray(legs) || legs.length < 2) return false;
  const leg2 = legs[1] as Record<string, unknown>;
  const stRaw = leg2?.Status;
  const st = String(stRaw ?? "")
    .toLowerCase()
    .trim();
  // First-leg-only "answered" callbacks often leave leg 2 empty / not attempted yet.
  const blocked =
    st === "" ||
    st === "null" ||
    st === "no-answer" ||
    st === "busy" ||
    st === "failed" ||
    st === "canceled" ||
    st === "cancelled";
  if (blocked) return false;
  if (st === "completed" || st === "in-progress") return true;
  const ocRaw = leg2?.OnCallDuration;
  const oc = typeof ocRaw === "number" ? ocRaw : parseInt(String(ocRaw ?? ""), 10);
  // Secondary signal when Status uses another casing/value but talk time has started.
  if (Number.isFinite(oc) && oc > 0) return true;
  return false;
}

const DEFAULT_WAIT_MS = 180_000;
const POLL_MS = 250;

/**
 * Blocks until `exotel_call_sessions.metadata.callee_answered` is true (set by HTTP StatusCallback)
 * or timeout. On timeout, logs and returns — caller may still play greeting to avoid dead air forever.
 */
export async function waitForOutboundCalleeAnswered(
  sessionRowId: string,
  log: FastifyBaseLogger,
  options?: { timeoutMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + timeoutMs;
  log.info(
    { sessionRowId, timeout_ms: timeoutMs },
    "voicebot: outbound — waiting for callee answered (StatusCallback)"
  );
  while (Date.now() < deadline) {
    const r = await pool.query(
      `SELECT metadata FROM exotel_call_sessions WHERE id = $1`,
      [sessionRowId]
    );
    const meta = r.rows[0]?.metadata as Record<string, unknown> | undefined;
    if (meta?.callee_answered === true) {
      log.info({ sessionRowId }, "voicebot: outbound — callee answered, continuing flow");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  log.warn(
    { sessionRowId, timeout_ms: timeoutMs },
    "voicebot: outbound — timeout waiting for callee answered; proceeding with greeting anyway"
  );
}
