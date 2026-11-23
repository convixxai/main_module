// ============================================================
// Calling switch: customer_settings.voicebot_enabled.
//
// Off = no calls for this customer: a Vodafone call is disconnected as soon
// as VI connects it, Exotel refuses the stream, and dials / campaign starts
// are refused (see isCallingEnabled in customer-settings.ts). The SaaS turns
// it off when the company's call credits reach 0 and back on after a top-up
// (Saas Wireframe: EngineCallingSwitch); PUT /settings/calling sets it by hand.
//
// Every change is logged in calling_events by a database trigger (migration
// 027), whoever made it. Blocked calls and dials are logged here,
// fire-and-forget: logging never delays or fails a call.
// ============================================================

import { pool } from "../config/db";
import { invalidateCustomerSettingsCache } from "./customer-settings";

export type CallingEvent = "enabled" | "disabled" | "call_blocked" | "dial_blocked";

/** Fire-and-forget: log a blocked call or dial. Never throws, never awaited by the caller. */
export function recordCallingEvent(customerId: string, event: "call_blocked" | "dial_blocked", source: string, details?: Record<string, unknown>): void {
  pool
    .query(`INSERT INTO calling_events (customer_id, event, source, details) VALUES ($1, $2, $3, $4::jsonb)`, [
      customerId,
      event,
      source,
      details ? JSON.stringify(details) : null,
    ])
    .catch(() => {
      // calling_events missing (migration 027 not run) or DB hiccup: the call is unaffected.
    });
}

/**
 * Turn calling on or off. The trigger logs the change with this source and
 * reason (set in the same transaction). Returns false when the customer has
 * no settings row.
 */
export async function setCallingEnabled(customerId: string, enabled: boolean, source: string, reason: string | null): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('convixx.calling_source', $1, true), set_config('convixx.calling_reason', $2, true)`, [
      source,
      reason ?? "",
    ]);
    const r = await client.query(
      `UPDATE customer_settings SET voicebot_enabled = $2 WHERE customer_id = $1 RETURNING customer_id`,
      [customerId, enabled]
    );
    await client.query("COMMIT");
    invalidateCustomerSettingsCache(customerId);
    return r.rows.length > 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface BillingState {
  /** The SaaS company linked to this customer, if any. */
  linked: boolean;
  /** Call credits left (null when the company has no wallet yet). */
  credits_balance: number | null;
  /** Set when the SaaS switched calling off for 0 credits (cleared on top-up). */
  suspended_for_zero_credits_at: string | null;
  pulse_seconds: number | null;
}

let saasTables: Promise<boolean> | null = null;
function hasSaasBillingTables(): Promise<boolean> {
  saasTables ??= pool
    .query(`SELECT to_regclass('public.companies') IS NOT NULL AND to_regclass('public.credit_wallets') IS NOT NULL AS ok`)
    .then((r) => Boolean(r.rows[0]?.ok))
    .catch(() => {
      saasTables = null;
      return false;
    });
  return saasTables;
}

/** Credits and suspension state from the SaaS tables (shared database). Read only. */
export async function billingState(customerId: string): Promise<BillingState> {
  const none: BillingState = { linked: false, credits_balance: null, suspended_for_zero_credits_at: null, pulse_seconds: null };
  if (!(await hasSaasBillingTables())) return none;
  try {
    const r = await pool.query(
      `SELECT co.calling_suspended_at, co.pulse_seconds, w.balance
         FROM companies co LEFT JOIN credit_wallets w ON w.company_id = co.id
        WHERE co.engine_customer_id = $1::text
        ORDER BY co.id LIMIT 1`,
      [customerId]
    );
    const row = r.rows[0];
    if (!row) return none;
    return {
      linked: true,
      credits_balance: row.balance == null ? null : Number(row.balance),
      // SaaS timestamps are India wall-clock without a zone.
      suspended_for_zero_credits_at: row.calling_suspended_at ? istWallClockToIso(row.calling_suspended_at) : null,
      pulse_seconds: row.pulse_seconds == null ? null : Number(row.pulse_seconds),
    };
  } catch {
    return none;
  }
}

/** A `timestamp without time zone` holding India time, parsed by pg as local time, to a UTC ISO string. */
function istWallClockToIso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  const wallMs = d.getTime() - d.getTimezoneOffset() * 60_000; // the wall-clock digits as if UTC
  return new Date(wallMs - 330 * 60_000).toISOString();
}
