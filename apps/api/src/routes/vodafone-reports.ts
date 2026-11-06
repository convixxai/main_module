// ============================================================
// Vodafone (VI) reports: campaign status, campaign call report, campaign
// summary and call history. Vodafone only, read only.
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
