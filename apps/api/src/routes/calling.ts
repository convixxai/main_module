// ============================================================
// Calling switch + calling logs (for the SaaS and admins).
//
//   GET  /settings/calling   is calling on? credits, last change
//   PUT  /settings/calling   turn calling on / off  {enabled, reason?, force?}
//   GET  /calling/logs       switch changes, blocked calls and dials
//   GET  /calling/activity   calls, talk time, credits, blocked calls per
//                            hour / day / week / month (IST)
//
// Auth: x-api-key, or x-admin-token with x-customer-id / customer_id.
// Read only, except PUT /settings/calling.
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyOrAdminAuth, AuthenticatedRequest } from "../middleware/auth";
import { billingState, setCallingEnabled } from "../services/calling-switch";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVENTS = ["enabled", "disabled", "call_blocked", "dial_blocked"] as const;
const GROUPS = { hour: 7, day: 92, week: 366, month: 731 } as const; // longest range (days) per grouping

const putBody = z
  .object({
    enabled: z.boolean(),
    reason: z.string().trim().max(500).optional(),
    /** Turn calling on although the credit balance is 0 or less. */
    force: z.boolean().optional(),
  })
  .strict();

const logsQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  event: z.enum(EVENTS).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const activityQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  group: z.enum(["hour", "day", "week", "month"]).default("day"),
});

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function istText(d: unknown): string | null {
  if (!d) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(d as string)).replace(",", "");
}

/** Who made a change through this API, for the log. */
function sourceOf(request: AuthenticatedRequest): string {
  return request.headers["x-api-key"] ? "api:customer-key" : "api:admin";
}

async function callingView(customerId: string) {
  const [row, last, billing] = await Promise.all([
    pool.query(`SELECT voicebot_enabled FROM customer_settings WHERE customer_id = $1`, [customerId]),
    pool
      .query(
        `SELECT event, source, reason, created_at FROM calling_events
          WHERE customer_id = $1 AND event IN ('enabled', 'disabled') ORDER BY created_at DESC LIMIT 1`,
        [customerId]
      )
      .catch(() => ({ rows: [] as any[] })),
    billingState(customerId),
  ]);
  if (row.rows.length === 0) return null;
  const l = last.rows[0];
  return {
    calling_enabled: row.rows[0].voicebot_enabled !== false,
    last_change: l ? { event: l.event, source: l.source, reason: l.reason ?? null, at: new Date(l.created_at).toISOString(), at_ist: istText(l.created_at) } : null,
    billing: {
      ...billing,
      suspended_for_zero_credits_at_ist: istText(billing.suspended_for_zero_credits_at),
    },
    note: "When off, new calls are disconnected as soon as they connect and dials / campaign starts are refused. Calls already in progress finish normally.",
  };
}

/** IST date range -> SQL bounds on a timestamptz expression. */
function istRange(from: string, to: string, add: (v: unknown) => string): { start: string; end: string } {
  return {
    start: `((${add(from)})::date::timestamp AT TIME ZONE 'Asia/Kolkata')`,
    end: `(((${add(to)})::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`,
  };
}

let callChargesTable: Promise<boolean> | null = null;
function hasCallCharges(): Promise<boolean> {
  callChargesTable ??= pool
    .query(`SELECT to_regclass('public.call_charges') IS NOT NULL AS ok`)
    .then((r) => Boolean(r.rows[0]?.ok))
    .catch(() => {
      callChargesTable = null;
      return false;
    });
  return callChargesTable;
}

export async function callingRoutes(app: FastifyInstance) {
  app.get("/settings/calling", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const view = await callingView(request.customerId!);
    if (!view) return reply.status(404).send({ error: "Customer not found" });
    return view;
  });

  app.put("/settings/calling", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const body = putBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    const customerId = request.customerId!;
    const { enabled, reason, force } = body.data;
    if (force && request.headers["x-api-key"]) {
      // A customer must not be able to call unpaid: only Convixx admins override billing.
      return reply.status(403).send({ error: "force needs the admin token (x-admin-token)", code: "force_admin_only" });
    }
    if (enabled && !force) {
      const billing = await billingState(customerId);
      if (billing.credits_balance !== null && billing.credits_balance <= 0) {
        return reply.status(409).send({
          error: "No call credits left: calls would run unpaid. Top up credits (calling then turns on by itself), or send force: true to turn it on anyway.",
          code: "no_credits",
          credits_balance: billing.credits_balance,
        });
      }
    }
    const ok = await setCallingEnabled(customerId, enabled, sourceOf(request), reason ?? null);
    if (!ok) return reply.status(404).send({ error: "Customer not found" });
    request.log.info({ customerId, enabled, force: !!force, source: sourceOf(request) }, "calling switch changed via API");
    return callingView(customerId);
  });

  app.get("/calling/logs", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const q = logsQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const f = q.data;
    const to = f.to ?? istToday();
    const from = f.from ?? addDays(to, -29);
    if (to < from) return reply.status(400).send({ error: "`to` is before `from`" });
    const params: unknown[] = [request.customerId];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const r = istRange(from, to, add);
    const where = [`customer_id = $1`, `created_at >= ${r.start}`, `created_at < ${r.end}`];
    if (f.event) where.push(`event = ${add(f.event)}`);
    try {
      const [rows, total, counts] = await Promise.all([
        pool.query(`SELECT id, event, source, reason, details, created_at FROM calling_events WHERE ${where.join(" AND ")}
                     ORDER BY created_at DESC, id DESC LIMIT ${f.limit} OFFSET ${f.offset}`, params),
        pool.query(`SELECT COUNT(*)::int AS n FROM calling_events WHERE ${where.join(" AND ")}`, params),
        pool.query(`SELECT event, COUNT(*)::int AS n FROM calling_events WHERE ${where.slice(0, 3).join(" AND ")} GROUP BY event`, params.slice(0, 3)),
      ]);
      const byEvent: Record<string, number> = { enabled: 0, disabled: 0, call_blocked: 0, dial_blocked: 0 };
      for (const c of counts.rows) byEvent[c.event] = c.n;
      return {
        filters: { from, to, event: f.event ?? null },
        counts: byEvent,
        total: total.rows[0].n,
        limit: f.limit,
        offset: f.offset,
        logs: rows.rows.map((x) => ({
          id: Number(x.id),
          event: x.event,
          source: x.source ?? null,
          reason: x.reason ?? null,
          details: x.details ?? null,
          at: new Date(x.created_at).toISOString(),
          at_ist: istText(x.created_at),
        })),
      };
    } catch (err) {
      request.log.warn({ err }, "calling logs unavailable (migration 027 not run?)");
      return reply.status(503).send({ error: "Calling logs are not set up on this server yet" });
    }
  });

  app.get("/calling/activity", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const q = activityQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const f = q.data;
    const maxDays = GROUPS[f.group];
    const to = f.to ?? istToday();
    const from = f.from ?? addDays(to, f.group === "hour" ? 0 : f.group === "day" ? -29 : f.group === "week" ? -83 : -364);
    if (to < from) return reply.status(400).send({ error: "`to` is before `from`" });
    if (daysBetween(from, to) + 1 > maxDays) {
      return reply.status(400).send({ error: `With group=${f.group} the range can be at most ${maxDays} days` });
    }
    const customerId = request.customerId!;
    const fmt = { hour: "YYYY-MM-DD HH24:00", day: "YYYY-MM-DD", week: "IYYY-\"W\"IW", month: "YYYY-MM" }[f.group];
    const trunc = f.group;

    // Calls (both providers). started_at is UTC wall-clock without a zone.
    const callParams: unknown[] = [customerId];
    const addC = (v: unknown) => { callParams.push(v); return `$${callParams.length}`; };
    const cr = istRange(from, to, addC);
    const startedTz = `(s.started_at AT TIME ZONE 'UTC')`;
    const period = (ts: string) => `to_char(date_trunc('${trunc}', ${ts} AT TIME ZONE 'Asia/Kolkata'), '${fmt}')`;
    const duration = `GREATEST(0, EXTRACT(EPOCH FROM (s.ended_at - s.started_at)))`;
    const charges = await hasCallCharges();

    const evParams: unknown[] = [customerId];
    const addE = (v: unknown) => { evParams.push(v); return `$${evParams.length}`; };
    const er = istRange(from, to, addE);

    const [calls, events] = await Promise.all([
      pool.query(
        `SELECT ${period(startedTz)} AS period,
                COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE s.metadata->>'callee_answered' = 'true' OR (s.ended_at IS NOT NULL AND ${duration} >= 10))::int AS connected,
                COUNT(*) FILTER (WHERE s.direction = 'outbound')::int AS outbound,
                COUNT(*) FILTER (WHERE s.direction = 'inbound')::int AS inbound,
                COALESCE(SUM(${duration}) FILTER (WHERE s.ended_at IS NOT NULL), 0)::int AS talk_seconds,
                ${charges ? "COALESCE(SUM(cc.pulses_charged), 0)::int" : "0"} AS credits_deducted
           FROM exotel_call_sessions s
           ${charges ? "LEFT JOIN call_charges cc ON cc.call_session_id = s.id::text" : ""}
          WHERE s.customer_id = $1 AND ${startedTz} >= ${cr.start} AND ${startedTz} < ${cr.end}
          GROUP BY 1`,
        callParams
      ),
      pool
        .query(
          `SELECT ${period("e.created_at")} AS period,
                  COUNT(*) FILTER (WHERE e.event = 'call_blocked')::int AS calls_blocked,
                  COUNT(*) FILTER (WHERE e.event = 'dial_blocked')::int AS dials_blocked,
                  COUNT(*) FILTER (WHERE e.event = 'disabled')::int AS times_disabled,
                  COUNT(*) FILTER (WHERE e.event = 'enabled')::int AS times_enabled
             FROM calling_events e
            WHERE e.customer_id = $1 AND e.created_at >= ${er.start} AND e.created_at < ${er.end}
            GROUP BY 1`,
          evParams
        )
        .catch(() => ({ rows: [] as any[] })),
    ]);

    const empty = { calls: 0, connected: 0, outbound: 0, inbound: 0, talk_seconds: 0, credits_deducted: 0, calls_blocked: 0, dials_blocked: 0, times_disabled: 0, times_enabled: 0 };
    const byPeriod = new Map<string, typeof empty>();
    for (const r of [...calls.rows, ...events.rows]) {
      const cur = byPeriod.get(r.period) ?? { ...empty };
      for (const k of Object.keys(empty) as (keyof typeof empty)[]) if (r[k] !== undefined) cur[k] = Number(r[k]) || 0;
      byPeriod.set(r.period, cur);
    }
    const periods = [...byPeriod.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, v]) => ({ period: p, ...v }));
    const totals = periods.reduce((t, p) => {
      for (const k of Object.keys(empty) as (keyof typeof empty)[]) t[k] += p[k];
      return t;
    }, { ...empty });
    return {
      filters: { from, to, group: f.group, timezone: "Asia/Kolkata" },
      totals,
      periods,
      note: "Only periods with activity are listed. Calls = calls that reached the engine (Vodafone and Exotel); credits_deducted = Call Pulses charged for those calls.",
    };
  });
}
