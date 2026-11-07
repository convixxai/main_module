// ============================================================
// Vodafone (VI) reports: campaign status, campaign call report, campaign
// summary and call history. Vodafone only, read only.
//
// Two sources:
//   - VI's own APIs (below: status / report / summary / reports/calls);
//   - Convixx's own call log (exotel_call_sessions rows with
//     metadata.provider = 'vodafone', written by services/vodafone-call-log):
//     /vodafone/reports/history, /history/:id, /summary, /campaigns/:id/calls.
//
// Data comes from VI's own APIs (services/vodafone-obd.ts):
//   - campaignstatus           -> live counts of one campaign
//   - Pull Report calltype 2   -> one campaign's call records
//   - Pull Report calltype 4   -> one campaign's summary
//   - Pull Report calltype 1/2/3 -> call history (inbound / outbound /
//                                   click-to-call) for a date range
// plus our own lead counts. Nothing here dials, changes a campaign or
// touches Exotel / the shared /outbound routes.
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { getTelephonySettings } from "../services/telephony-settings";
import { getObdCampaignStatus, pullViCallReport, VodafoneObdError, type PullReportCallType } from "../services/vodafone-obd";
import { loadVodafoneCampaign, leadCounts, statusIdOf, pickDni, publicCampaign, viErrorReply } from "./vodafone-campaigns";
import { digitsOnly } from "./outbound-campaigns";
import { decrypt } from "../services/crypto";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Longest date range one history request may ask VI for. */
const MAX_RANGE_DAYS = 31;

const CALL_TYPES: Record<string, PullReportCallType> = { inbound: 1, outbound: 2, click_to_call: 3 };

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function istDate(d: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(d));
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

const rangeQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  raw: z.enum(["0", "1", "true", "false"]).optional(),
});

/** Validated {from, to} (IST dates), or an error message. */
function resolveRange(from: string | undefined, to: string | undefined, defFrom: string): { from: string; to: string } | string {
  const today = istToday();
  const f = from ?? defFrom;
  const t = to ?? (from && from > today ? from : today);
  if (t < f) return "`to` is before `from`";
  if (daysBetween(f, t) > MAX_RANGE_DAYS) return `The date range may be at most ${MAX_RANGE_DAYS} days`;
  return { from: f, to: t };
}

const wantsRaw = (v: string | undefined) => v === "1" || v === "true";

async function requireVodafone(customerId: string): Promise<{ flowId: string | null } | string> {
  const t = await getTelephonySettings(customerId);
  if (!t || t.provider_id !== "vodafone" || !t.is_enabled) return "Vodafone is not the enabled telephony provider for this customer";
  return { flowId: ((t.metadata as Record<string, unknown> | undefined)?.vi_flow_id as string | undefined) ?? null };
}

/** The DNI a report is pulled for: explicit, else the campaign / tenant calling number. */
async function reportDni(
  customerId: string,
  explicit: string | undefined,
  flowId: string | null,
  phoneNumberId: string | null
): Promise<string> {
  if (explicit) {
    const d = digitsOnly(explicit).slice(-10);
    if (d.length !== 10) throw new VodafoneObdError("dni must be a 10-digit number", 400);
    return d;
  }
  try {
    return await pickDni(customerId, flowId, phoneNumberId);
  } catch (err) {
    if (phoneNumberId) return pickDni(customerId, flowId, null); // campaign number no longer active: tenant DNI
    throw err;
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function vodafoneReportRoutes(app: FastifyInstance) {
  // Live status of one campaign (VI campaignstatus) + our own lead counts.
  app.get<{ Params: { id: string } }>("/vodafone/campaigns/:id/status", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.customerId!;
    const campaign = await loadVodafoneCampaign(customerId, id);
    if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });
    const leads = await leadCounts(campaign.id);
    let vi: Awaited<ReturnType<typeof getObdCampaignStatus>> | null = null;
    let viError: string | null = null;
    try {
      vi = await getObdCampaignStatus(customerId, statusIdOf(campaign));
    } catch (err) {
      viError = err instanceof VodafoneObdError ? err.message : String(err);
    }
    const b = vi?.baseDetails;
    return reply.send({
      campaign: publicCampaign(campaign),
      status: {
        engine_status: campaign.status,
        vi_status: vi?.currentStatus ?? null,
        window: vi?.campaignWindow ?? null,
        end_date: vi?.campaignEndDate ?? null,
        numbers_on_vi: b ? num(b.totalBaseReceived) : null,
        calls_placed: b ? num(b.totalCallInitiated) : null,
        connected: b ? num(b.totalCallsConnected) : null,
        not_connected: b ? num(b.totalCallsNotConnected) : null,
        remaining: b ? num(b.remainingNumbersInQueue) : null,
        success_rate_percent: b ? num(b.successRatePercentage) : null,
        retry: vi ? { interval: vi.retryInterval, within: vi.retryWithin, attempts: vi.retryAttempts } : null,
      },
      leads,
      vi_status_raw: vi,
      vi_status_error: viError,
    });
  });

  // One campaign's call records from VI (Pull Report, outbound).
  app.get<{ Params: { id: string } }>("/vodafone/campaigns/:id/report", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.customerId!;
    const q = rangeQuery.extend({ dni: z.string().optional() }).safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const campaign = await loadVodafoneCampaign(customerId, id);
    if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });
    if (!campaign.vi_campaign_ref_id) {
      return reply.status(400).send({ error: "This campaign has no VI campaign ID yet (not created on Vodafone)" });
    }
    const range = resolveRange(q.data.from, q.data.to, istDate(campaign.created_at));
    if (typeof range === "string") return reply.status(400).send({ error: range });
    try {
      const dni = await reportDni(customerId, q.data.dni, campaign.vi_flow_id ?? null, campaign.phone_number_id ?? null);
      const r = await pullViCallReport(customerId, {
        dni,
        calltype: 2,
        fromdate: range.from,
        todate: range.to,
        campaignid: campaign.vi_campaign_ref_id,
      });
      return reply.send({
        campaign: publicCampaign(campaign),
        period: range,
        dni,
        leads: await leadCounts(campaign.id),
        count: r.rows.length,
        calls: r.rows,
        ...(wantsRaw(q.data.raw) ? { raw: r.raw } : {}),
      });
    } catch (err) {
      return viErrorReply(reply, err, "Could not read the campaign report from Vodafone");
    }
  });

  // One campaign's summary from VI (Pull Report, outbound summary).
  app.get<{ Params: { id: string } }>("/vodafone/campaigns/:id/summary", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.customerId!;
    const q = z.object({ dni: z.string().optional(), raw: z.enum(["0", "1", "true", "false"]).optional() }).safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const campaign = await loadVodafoneCampaign(customerId, id);
    if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });
    if (!campaign.vi_campaign_ref_id) {
      return reply.status(400).send({ error: "This campaign has no VI campaign ID yet (not created on Vodafone)" });
    }
    try {
      const dni = await reportDni(customerId, q.data.dni, campaign.vi_flow_id ?? null, campaign.phone_number_id ?? null);
      const r = await pullViCallReport(customerId, { dni, calltype: 4, campaignid: campaign.vi_campaign_ref_id });
      return reply.send({
        campaign: publicCampaign(campaign),
        dni,
        leads: await leadCounts(campaign.id),
        summary: r.rows.length === 1 ? r.rows[0] : r.rows,
        ...(wantsRaw(q.data.raw) ? { raw: r.raw } : {}),
      });
    } catch (err) {
      return viErrorReply(reply, err, "Could not read the campaign summary from Vodafone");
    }
  });

  // Call history from VI for a date range: inbound, outbound (one campaign) or click-to-call.
  app.get("/vodafone/reports/calls", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const customerId = request.customerId!;
    const q = rangeQuery
      .extend({
        type: z.enum(["inbound", "outbound", "click_to_call"]),
        dni: z.string().optional(),
        /** Engine campaign id (uuid) or VI's numeric campaign ID; required for type=outbound. */
        campaign_id: z.string().optional(),
        call_id: z.string().regex(/^\d{1,50}$/).optional(),
      })
      .safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const vf = await requireVodafone(customerId);
    if (typeof vf === "string") return reply.status(400).send({ error: vf });
    const range = resolveRange(q.data.from, q.data.to, q.data.to ?? istToday());
    if (typeof range === "string") return reply.status(400).send({ error: range });

    let viCampaignId: string | null = null;
    let campaign: Record<string, any> | null = null;
    if (q.data.campaign_id) {
      if (z.string().uuid().safeParse(q.data.campaign_id).success) {
        campaign = await loadVodafoneCampaign(customerId, q.data.campaign_id);
        if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });
        viCampaignId = campaign.vi_campaign_ref_id ? String(campaign.vi_campaign_ref_id) : null;
        if (!viCampaignId) return reply.status(400).send({ error: "This campaign has no VI campaign ID yet" });
      } else if (/^\d{1,10}$/.test(q.data.campaign_id)) {
        // VI's numeric ID: only for this customer's own campaigns.
        const own = await pool.query(
          `SELECT * FROM outbound_campaigns
            WHERE customer_id = $1 AND telephony_provider_id = 'vodafone' AND vi_campaign_ref_id::text = $2 LIMIT 1`,
          [customerId, q.data.campaign_id]
        );
        campaign = own.rows[0] ?? null;
        if (!campaign) return reply.status(404).send({ error: "No Vodafone campaign of this customer has that VI campaign ID" });
        viCampaignId = q.data.campaign_id;
      } else {
        return reply.status(400).send({ error: "campaign_id must be the campaign uuid or VI's numeric campaign ID" });
      }
    }
    if (q.data.type === "outbound" && !viCampaignId) {
      return reply.status(400).send({ error: "campaign_id is required for type=outbound (VI reports outbound calls per campaign)" });
    }
    try {
      const dni = await reportDni(customerId, q.data.dni, campaign?.vi_flow_id ?? vf.flowId, campaign?.phone_number_id ?? null);
      const r = await pullViCallReport(customerId, {
        dni,
        calltype: CALL_TYPES[q.data.type],
        fromdate: range.from,
        todate: range.to,
        campaignid: q.data.type === "outbound" ? viCampaignId : null,
        call_id: q.data.call_id ?? null,
      });
      return reply.send({
        type: q.data.type,
        period: range,
        dni,
        campaign: campaign ? publicCampaign(campaign) : null,
        count: r.rows.length,
        calls: r.rows,
        ...(wantsRaw(q.data.raw) ? { raw: r.raw } : {}),
      });
    } catch (err) {
      return viErrorReply(reply, err, "Could not read the call history from Vodafone");
    }
  });
}

// ---------- Convixx's own Vodafone call log ----------

/** A call counts as connected like in the SaaS: answered flag, or >= 10 s. */
const CONNECTED_AFTER_SECONDS = 10;
/** An "active" row older than this is a call whose end was never recorded. */
const STALE_ACTIVE_HOURS = 3;

const historyQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  campaign_id: z.string().uuid().optional(),
  outcome: z.enum(["connected", "missed", "live"]).optional(),
  number: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

/** IST calendar date -> UTC wall-clock bound, as the engine stores times. */
const IST_DAY_START = `(($X)::date::timestamp AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'UTC'`;

/** Shared FROM/WHERE for Vodafone call rows of one customer. $1 = customer id. */
function callRowsSql(f: z.infer<typeof historyQuery>, params: unknown[]): string {
  const where = [`s.customer_id = $1`, `s.metadata->>'provider' = 'vodafone'`];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.from) where.push(`s.started_at >= ${IST_DAY_START.replace("$X", add(f.from))}`);
  if (f.to) where.push(`s.started_at < ${IST_DAY_START.replace("$X", add(f.to))} + interval '1 day'`);
  if (f.direction) where.push(`s.direction = ${add(f.direction)}`);
  if (f.campaign_id) where.push(`l.campaign_id = ${add(f.campaign_id)}`);
  if (f.number) {
    const d = digitsOnly(f.number).slice(-10);
    if (d) where.push(`(s.from_number LIKE ${add(`%${d}`)} OR s.to_number LIKE $${params.length})`);
  }
  if (f.outcome) where.push(`${OUTCOME_SQL} = ${add(f.outcome)}`);
  return `FROM exotel_call_sessions s
     LEFT JOIN LATERAL (
       SELECT campaign_id FROM outbound_campaign_leads WHERE session_id = s.id LIMIT 1
     ) l ON TRUE
     LEFT JOIN outbound_campaigns c ON c.id = l.campaign_id
     LEFT JOIN agents a ON a.id = s.agent_id
    WHERE ${where.join(" AND ")}`;
}

const DURATION_SQL = `GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s.ended_at, LEAST(NOW() AT TIME ZONE 'UTC', s.started_at + interval '${STALE_ACTIVE_HOURS} hours')) - s.started_at)))::int`;
const OUTCOME_SQL = `(CASE
    WHEN s.ended_at IS NULL AND s.status = 'active' AND s.started_at > (NOW() AT TIME ZONE 'UTC') - interval '${STALE_ACTIVE_HOURS} hours' THEN 'live'
    WHEN s.metadata->>'callee_answered' = 'true' OR ${DURATION_SQL} >= ${CONNECTED_AFTER_SECONDS} THEN 'connected'
    ELSE 'missed' END)`;

const CALL_COLUMNS = `s.id, s.direction, s.from_number, s.to_number, s.status, s.started_at, s.ended_at,
       s.chat_session_id, s.agent_id, a.name AS agent_name, s.exotel_call_sid AS vi_call_id,
       COALESCE(s.current_language_code, s.default_language_code) AS language_code,
       l.campaign_id, c.name AS campaign_name, s.metadata,
       ${DURATION_SQL} AS duration_seconds, ${OUTCOME_SQL} AS outcome`;

function utcIso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  // Column is UTC wall-clock without a zone; pg parsed it as local time.
  const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString();
  return iso;
}

function istText(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(iso)).replace(",", "");
}

function presentCall(r: Record<string, any>) {
  const outbound = r.direction === "outbound";
  const started = utcIso(r.started_at);
  const ended = utcIso(r.ended_at);
  return {
    id: r.id,
    direction: r.direction,
    customer_number: outbound ? r.to_number : r.from_number,
    our_number: outbound ? r.from_number : r.to_number,
    started_at: started,
    started_at_ist: istText(started),
    ended_at: ended,
    ended_at_ist: istText(ended),
    duration_seconds: Number(r.duration_seconds) || 0,
    outcome: r.outcome,
    status: r.status,
    campaign: r.campaign_id ? { id: r.campaign_id, name: r.campaign_name ?? null } : null,
    agent: r.agent_id ? { id: r.agent_id, name: r.agent_name ?? null } : null,
    language_code: r.language_code ?? null,
    vi_call_id: r.vi_call_id ?? null,
    chat_session_id: r.chat_session_id ?? null,
  };
}

export async function vodafoneOwnReportRoutes(app: FastifyInstance) {
  // Convixx call history for Vodafone calls (newest first).
  app.get("/vodafone/reports/history", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const q = historyQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const f = q.data;
    if (f.from && f.to && f.to < f.from) return reply.status(400).send({ error: "`to` is before `from`" });
    const params: unknown[] = [request.customerId];
    const from = callRowsSql(f, params);
    const [rows, total] = await Promise.all([
      pool.query(`SELECT ${CALL_COLUMNS} ${from} ORDER BY s.started_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`, params),
      pool.query(`SELECT COUNT(*)::int AS n ${from}`, params),
    ]);
    return reply.send({
      filters: { from: f.from ?? null, to: f.to ?? null, direction: f.direction ?? null, campaign_id: f.campaign_id ?? null, outcome: f.outcome ?? null, number: f.number ?? null },
      total: total.rows[0].n,
      limit: f.limit,
      offset: f.offset,
      calls: rows.rows.map(presentCall),
    });
  });

  // One Vodafone call with its transcript.
  app.get<{ Params: { id: string } }>("/vodafone/reports/history/:id", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.status(404).send({ error: "Call not found" });
    const params: unknown[] = [request.customerId];
    const from = callRowsSql({ limit: 1, offset: 0 }, params);
    params.push(id);
    const r = await pool.query(`SELECT ${CALL_COLUMNS} ${from} AND s.id = $${params.length}`, params);
    const row = r.rows[0];
    if (!row) return reply.status(404).send({ error: "Call not found" });
    let transcript: { role: string; text: string; at: string | null }[] = [];
    if (row.chat_session_id) {
      const m = await pool.query(
        `SELECT role, content, created_at FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC, id ASC`,
        [row.chat_session_id]
      );
      transcript = m.rows.map((x) => {
        let text = "";
        try {
          text = decrypt(x.content);
        } catch {
          text = "";
        }
        return { role: x.role === "assistant" ? "bot" : x.role === "user" ? "customer" : x.role, text, at: utcIso(x.created_at) };
      });
    }
    return reply.send({ call: presentCall(row), transcript });
  });

  // Totals for a period: calls, connected, missed, talk time, by day / hour (IST) / campaign.
  app.get("/vodafone/reports/summary", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const q = historyQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const f = q.data;
    if (f.from && f.to && f.to < f.from) return reply.status(400).send({ error: "`to` is before `from`" });
    const params: unknown[] = [request.customerId];
    const from = callRowsSql(f, params);
    const istStart = `((s.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')`;
    const [tot, byDay, byHour, byCampaign] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE ${OUTCOME_SQL} = 'connected')::int AS connected,
                COUNT(*) FILTER (WHERE ${OUTCOME_SQL} = 'missed')::int AS missed,
                COUNT(*) FILTER (WHERE ${OUTCOME_SQL} = 'live')::int AS live,
                COUNT(*) FILTER (WHERE s.direction = 'outbound')::int AS outbound,
                COUNT(*) FILTER (WHERE s.direction = 'inbound')::int AS inbound,
                COALESCE(SUM(${DURATION_SQL}), 0)::int AS talk_seconds,
                COALESCE(ROUND(AVG(${DURATION_SQL}) FILTER (WHERE ${OUTCOME_SQL} = 'connected')), 0)::int AS avg_connected_seconds
           ${from}`,
        params
      ),
      pool.query(`SELECT to_char(${istStart}, 'YYYY-MM-DD') AS day, COUNT(*)::int AS calls,
                         COUNT(*) FILTER (WHERE ${OUTCOME_SQL} = 'connected')::int AS connected
                    ${from} GROUP BY 1 ORDER BY 1`, params),
      pool.query(`SELECT EXTRACT(HOUR FROM ${istStart})::int AS hour, COUNT(*)::int AS calls
                    ${from} GROUP BY 1 ORDER BY 1`, params),
      pool.query(`SELECT l.campaign_id, c.name, COUNT(*)::int AS calls,
                         COUNT(*) FILTER (WHERE ${OUTCOME_SQL} = 'connected')::int AS connected,
                         COALESCE(SUM(${DURATION_SQL}), 0)::int AS talk_seconds
                    ${from} AND l.campaign_id IS NOT NULL GROUP BY 1, 2 ORDER BY 3 DESC`, params),
    ]);
    return reply.send({
      filters: { from: f.from ?? null, to: f.to ?? null, direction: f.direction ?? null, campaign_id: f.campaign_id ?? null },
      totals: tot.rows[0],
      by_day: byDay.rows,
      by_hour_ist: byHour.rows,
      by_campaign: byCampaign.rows.map((r) => ({ campaign_id: r.campaign_id, name: r.name, calls: r.calls, connected: r.connected, talk_seconds: r.talk_seconds })),
    });
  });

  // One campaign: its numbers (status, attempts, last attempt) and the calls made.
  app.get<{ Params: { id: string } }>("/vodafone/campaigns/:id/calls", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.customerId!;
    const campaign = await loadVodafoneCampaign(customerId, id);
    if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });
    const params: unknown[] = [customerId];
    const from = callRowsSql({ campaign_id: campaign.id, limit: 500, offset: 0 }, params);
    const [calls, leads] = await Promise.all([
      pool.query(`SELECT ${CALL_COLUMNS} ${from} ORDER BY s.started_at DESC LIMIT 500`, params),
      pool.query(
        `SELECT phone_number, status, attempts, last_attempt_at, vi_call_id, session_id
           FROM outbound_campaign_leads WHERE campaign_id = $1 ORDER BY created_at ASC LIMIT 50000`,
        [campaign.id]
      ),
    ]);
    return reply.send({
      campaign: publicCampaign(campaign),
      leads_summary: await leadCounts(campaign.id),
      numbers: leads.rows.map((r) => ({
        number: r.phone_number,
        status: r.status,
        attempts: r.attempts ?? 0,
        last_attempt_at: r.last_attempt_at ? utcIso(r.last_attempt_at) : null,
        vi_call_id: r.vi_call_id ?? null,
        call_id: r.session_id ?? null,
      })),
      calls: calls.rows.map(presentCall),
    });
  });
}
