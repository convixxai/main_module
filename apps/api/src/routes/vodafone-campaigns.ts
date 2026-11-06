// ============================================================
// Vodafone (VI) outbound campaigns: dedicated API.
//
// Vodafone campaigns are NOT dialed like Exotel (one REST call per lead).
// VI runs the whole campaign itself through its OBD Campaign API ("With
// Flow", services/vodafone-obd.ts):
//
//   createCampaign -> getsampleBaseHeads -> staticCampaignDataIngestion
//   (the numbers) -> StartorStop(S)
//
// and dials the base inside the date/time window. Every answered call comes
// back on the tenant's Streaming WS (/telephony/vodafone/voicebot/:id) with
// custom_parameters {call_type: "outbound", campaign_id}, where the bot
// speaks the campaign script and handles the conversation.
//
// These routes never touch Exotel and never render a Sarvam audio file (the
// bot speaks the script live). One call, POST /vodafone/campaigns, creates,
// loads and starts a campaign; the others manage it afterwards. The generic
// /outbound/campaigns* routes still work for older clients.
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import { pool } from "../config/db";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { getTelephonySettings } from "../services/telephony-settings";
import { resolvePhoneNumberById } from "../services/company-phone-numbers";
import {
  createObdCampaignWithFlow,
  getSampleBaseHeads,
  staticCampaignBaseLoad,
  startOrStopObdCampaign,
  startObdCampaignOrConfirmActive,
  getObdCampaignStatus,
  getVodafoneObdCredentials,
  getActiveDniList,
  VodafoneObdError,
} from "../services/vodafone-obd";
import { resolveObdDni, digitsOnly, buildObdBaseRecord, DEFAULT_OBD_BASE_VARIABLES } from "./outbound-campaigns";

/** Records per staticCampaignDataIngestion request. */
const VI_BASE_CHUNK = 1000;
const MAX_NUMBERS_PER_REQUEST = 50_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

const phoneList = z.array(z.string().min(3)).min(1).max(MAX_NUMBERS_PER_REQUEST);

const createSchema = z.object({
  name: z.string().min(1).max(200),
  /** First line the bot speaks when the lead answers (also seeded into the call's chat history). */
  script_text: z.string().min(1).max(4000),
  language_code: z.string().default("en-IN"),
  /** Numbers VI should dial. Optional: add later with POST /vodafone/campaigns/:id/leads. */
  phone_numbers: phoneList.optional(),
  /** company_phone_numbers id used as the outbound DNI; omitted = tenant DNI, else primary number. */
  phone_number_id: z.string().uuid().optional(),
  /** Agent that answers; omitted = the DNI number's default agent, else the oldest active agent. */
  agent_id: z.string().uuid().optional(),
  /** Dialing window (IST). Defaults: today, 09:00:00-21:00:00. */
  fromdate: z.string().regex(DATE_RE).optional(),
  todate: z.string().regex(DATE_RE).optional(),
  fromtime: z.string().regex(TIME_RE).optional(),
  totime: z.string().regex(TIME_RE).optional(),
  dial_timeout_seconds: z.number().int().min(5).max(120).optional(),
  /** "0" = retry interval in minutes, "1" = in days. */
  retry_interval_type: z.enum(["0", "1"]).optional(),
  retry_interval_value: z.number().int().positive().optional(),
  retry_count: z.number().int().min(0).max(10).optional(),
  /** Start dialing right away (default true). false = create + load only, start later with /start. */
  start: z.boolean().optional(),
});

const leadsSchema = z.object({ phone_numbers: phoneList });

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function withSeconds(t: string): string {
  return t.length === 5 ? `${t}:00` : t;
}

/** Digits-only, at least 10 digits, de-duplicated on the last 10 digits. */
function normalizeNumbers(input: string[]): { valid: string[]; invalid: number; duplicates: number } {
  const seen = new Set<string>();
  const valid: string[] = [];
  let invalid = 0;
  let duplicates = 0;
  for (const raw of input) {
    const d = digitsOnly(raw);
    if (d.length < 10 || d.length > 13) {
      invalid++;
      continue;
    }
    const key = d.slice(-10);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    valid.push(d);
  }
  return { valid, invalid, duplicates };
}

function viErrorReply(reply: any, err: unknown, message: string) {
  const status = err instanceof VodafoneObdError ? err.httpStatus : 502;
  return reply.status(status === 400 || status === 404 ? status : 502).send({
    error: message,
    details: err instanceof VodafoneObdError ? err.body ?? err.message : String(err),
  });
}

async function loadVodafoneCampaign(customerId: string, id: string): Promise<Record<string, any> | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const res = await pool.query(
    `SELECT * FROM outbound_campaigns
      WHERE id = $1 AND customer_id = $2 AND telephony_provider_id = 'vodafone' AND status != 'deleted'`,
    [id, customerId]
  );
  return res.rows[0] ?? null;
}

async function leadCounts(campaignId: string): Promise<Record<string, number>> {
  const res = await pool.query(
    `SELECT status, COUNT(*)::int AS n FROM outbound_campaign_leads WHERE campaign_id = $1 GROUP BY status`,
    [campaignId]
  );
  const counts: Record<string, number> = { total: 0, pending: 0, calling: 0, completed: 0, failed: 0 };
  for (const r of res.rows) {
    counts[r.status] = r.n;
    counts.total += r.n;
  }
  return counts;
}

/** VI's campaignstatus wants the numeric campaign_Ref_ID; the campainKey is refused. */
function statusIdOf(campaign: Record<string, any>): string {
  return String(campaign.vi_campaign_ref_id ?? campaign.vi_campaign_id);
}

/**
 * The calling number (DNI, 10 digits) for this campaign's base records. It
 * must be one of the Flow's active DNIs, or VI drops every record ("Base not
 * loaded"). The configured number (campaign phone_number_id, else the tenant
 * dni, else the primary number) is used when VI lists it; a number picked
 * explicitly for the campaign that VI does not list is an error; otherwise
 * the Flow's first active DNI is used.
 */
async function pickDni(
  customerId: string,
  flowId: string | null | undefined,
  phoneNumberId: string | null | undefined
): Promise<string> {
  const creds = await getVodafoneObdCredentials(customerId);
  let configured: string | null = null;
  try {
    configured = (await resolveObdDni(customerId, phoneNumberId ?? null, creds.dni)).slice(-10);
  } catch (err) {
    if (phoneNumberId) throw err;
  }
  let active: string[] = [];
  if (flowId) {
    try {
      active = await getActiveDniList(customerId, flowId);
    } catch {
      active = []; // VI list unavailable: fall back to the configured number
    }
  }
  if (active.length === 0) {
    if (configured) return configured;
    throw new VodafoneObdError("No outbound DNI: VI lists no active DNI for this Flow and none is configured", 400);
  }
  if (configured && active.includes(configured)) return configured;
  if (phoneNumberId) {
    throw new VodafoneObdError(
      `The campaign number ${configured} is not an active DNI on this Vodafone Flow. Active DNIs: ${active.join(", ")}`,
      400,
      { active_dnis: active }
    );
  }
  return active[0];
}

/**
 * Uploads numbers to the VI campaign base in chunks and records each chunk
 * as local leads only after VI accepted it, so the local list always matches
 * what VI has. Stops at the first failed chunk.
 */
async function pushNumbers(
  customerId: string,
  campaign: Record<string, any>,
  numbers: string[]
): Promise<{ pushed: number; alreadyInCampaign: number; dni?: string; error?: unknown }> {
  // A retry re-sends the whole list: never upload a number VI already has
  // (it would be dialed twice). Matched on the last 10 digits. Exception: if
  // VI reports an empty base, nothing local ever reached it (e.g. records it
  // dropped), so everything is uploaded again.
  const existing = await pool.query(
    `SELECT DISTINCT RIGHT(regexp_replace(phone_number, '\\D', '', 'g'), 10) AS d
       FROM outbound_campaign_leads WHERE campaign_id = $1`,
    [campaign.id]
  );
  const local = new Set<string>(existing.rows.map((r) => r.d));
  let viBaseEmpty = false;
  if (local.size > 0) {
    try {
      const st = await getObdCampaignStatus(customerId, statusIdOf(campaign));
      viBaseEmpty = Number(st?.baseDetails?.totalBaseReceived ?? -1) === 0;
    } catch {
      viBaseEmpty = false; // unknown: keep the safe no-double-dial rule
    }
  }
  const fresh = viBaseEmpty ? numbers : numbers.filter((n) => !local.has(n.slice(-10)));
  const alreadyInCampaign = numbers.length - fresh.length;
  numbers = fresh;
  if (numbers.length === 0) return { pushed: 0, alreadyInCampaign };
  const dni = await pickDni(customerId, campaign.vi_flow_id, campaign.phone_number_id);
  const variableNames: string[] =
    Array.isArray(campaign.vi_base_variable_names) && campaign.vi_base_variable_names.length > 0
      ? campaign.vi_base_variable_names
      : DEFAULT_OBD_BASE_VARIABLES;

  let pushed = 0;
  for (let i = 0; i < numbers.length; i += VI_BASE_CHUNK) {
    const chunk = numbers.slice(i, i + VI_BASE_CHUNK);
    const records = chunk.map((n) => buildObdBaseRecord(variableNames, n, dni, String(campaign.id)));
    try {
      await staticCampaignBaseLoad(customerId, campaign.vi_campaign_id, records);
    } catch (error) {
      return { pushed, alreadyInCampaign, dni, error };
    }
    const newLocal = chunk.filter((n) => !local.has(n.slice(-10)));
    if (newLocal.length > 0) {
      await pool.query(
        `INSERT INTO outbound_campaign_leads (campaign_id, phone_number)
         SELECT $1, UNNEST($2::text[])`,
        [campaign.id, newLocal]
      );
    }
    pushed += chunk.length;
  }
  return { pushed, alreadyInCampaign, dni };
}

function publicCampaign(row: Record<string, any>) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    provider: "vodafone",
    language_code: row.language_code,
    script_text: row.script_text,
    agent_id: row.agent_id ?? null,
    phone_number_id: row.phone_number_id ?? null,
    vi_campaign_id: row.vi_campaign_id,
    vi_campaign_ref_id: row.vi_campaign_ref_id,
    vi_flow_id: row.vi_flow_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function vodafoneCampaignRoutes(app: FastifyInstance) {
  // Create the VI OBD campaign, load the numbers and start it: one call.
  app.post("/vodafone/campaigns", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const body = createSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    const customerId = request.customerId!;
    const d = body.data;

    // Vodafone only: no fallback to Exotel, ever.
    const telephony = await getTelephonySettings(customerId);
    if (!telephony || telephony.provider_id !== "vodafone" || !telephony.is_enabled) {
      return reply.status(400).send({
        error: "Vodafone is not the enabled telephony provider for this customer. Set it with PUT /customers/:customerId/vodafone-settings.",
      });
    }
    try {
      await getVodafoneObdCredentials(customerId);
    } catch (err) {
      return viErrorReply(reply, err, "Vodafone OBD credentials are not set");
    }
    const viFlowId = (telephony.metadata as Record<string, unknown> | undefined)?.vi_flow_id as string | undefined;
    if (!viFlowId) {
      return reply.status(400).send({
        error: "No VI Flow id for this customer. Set vi_flow_id with PUT /customers/:customerId/vodafone-settings (the Flow with the Streaming node built in VI's portal).",
      });
    }

    if (d.phone_number_id && !(await resolvePhoneNumberById(customerId, d.phone_number_id))) {
      return reply.status(400).send({ error: "phone_number_id does not belong to this customer or is disabled" });
    }
    if (d.agent_id) {
      const agent = await pool.query(`SELECT id FROM agents WHERE id = $1 AND customer_id = $2 AND is_active = TRUE`, [
        d.agent_id,
        customerId,
      ]);
      if (agent.rows.length === 0) {
        return reply.status(400).send({ error: "agent_id does not belong to this customer or is inactive" });
      }
    }

    const today = istToday();
    const window = {
      fromdate: d.fromdate ?? today,
      todate: d.todate ?? d.fromdate ?? today,
      fromtime: withSeconds(d.fromtime ?? "09:00:00"),
      totime: withSeconds(d.totime ?? "21:00:00"),
    };
    if (window.todate < window.fromdate) return reply.status(400).send({ error: "todate is before fromdate" });
    if (window.totime <= window.fromtime) return reply.status(400).send({ error: "totime must be after fromtime" });
    if (window.todate < today) return reply.status(400).send({ error: "The dialing window has already ended" });

    const numbers = normalizeNumbers(d.phone_numbers ?? []);
    if (d.phone_numbers && numbers.valid.length === 0) {
      return reply.status(400).send({ error: "None of phone_numbers is a valid number (10-13 digits)" });
    }

    // Pick the calling number before creating anything on VI: it must be an
    // active DNI on the Flow, or VI loads no numbers at all.
    let dni: string;
    try {
      dni = await pickDni(customerId, viFlowId, d.phone_number_id ?? null);
    } catch (err) {
      return viErrorReply(reply, err, "No usable outbound DNI for this campaign");
    }

    let viCampaignId: string;
    let viCampaignRefId: number | null = null;
    try {
      const created = await createObdCampaignWithFlow(customerId, {
        flowid: viFlowId,
        ...window,
        dialtimeout: String(d.dial_timeout_seconds ?? 15),
        name: d.name,
        description: d.name,
        retryintervaltype: d.retry_interval_type ?? "0",
        retryintervalvalue: d.retry_interval_value ?? 60,
        retrycount: d.retry_count ?? 0,
      });
      if (!created?.campainKey) throw new VodafoneObdError("VI createCampaign returned no campainKey", 502, created);
      viCampaignId = created.campainKey;
      viCampaignRefId = created.campaign_Ref_ID ?? null;
    } catch (err) {
      app.log.error({ err, customerId }, "vodafone-campaigns: VI createCampaign failed");
      return viErrorReply(reply, err, "Vodafone could not create the campaign");
    }

    // Variable names the Flow's base expects; defaults if VI can't say.
    let baseVars: string[] | null = null;
    try {
      const heads = await getSampleBaseHeads(customerId, viCampaignId);
      baseVars = heads.length > 0 ? heads : null;
    } catch (err) {
      app.log.warn({ err, viCampaignId }, "vodafone-campaigns: getsampleBaseHeads failed, using default base variables");
    }

    const id = randomUUID();
    const inserted = await pool.query(
      `INSERT INTO outbound_campaigns (
         id, customer_id, name, script_text, language_code, audio_file_path, status, phone_number_id,
         telephony_provider_id, vi_flow_id, vi_campaign_id, vi_campaign_ref_id, vi_base_variable_names, agent_id
       ) VALUES ($1,$2,$3,$4,$5,NULL,'ready',$6,'vodafone',$7,$8,$9,$10,$11)
       RETURNING *`,
      [id, customerId, d.name, d.script_text, d.language_code, d.phone_number_id ?? null, viFlowId, viCampaignId, viCampaignRefId, baseVars, d.agent_id ?? null]
    );
    let campaign = inserted.rows[0];

    const leads = { received: d.phone_numbers?.length ?? 0, valid: numbers.valid.length, invalid: numbers.invalid, duplicates: numbers.duplicates, pushed: 0 };
    if (numbers.valid.length > 0) {
      const push = await pushNumbers(customerId, campaign, numbers.valid);
      leads.pushed = push.pushed;
      if (push.error) {
        app.log.error({ err: push.error, campaignId: id }, "vodafone-campaigns: base upload to VI failed");
        return reply.status(502).send({
          error: "The campaign was created on Vodafone but uploading the numbers failed. Retry the remaining numbers with POST /vodafone/campaigns/{id}/leads, then POST /vodafone/campaigns/{id}/start.",
          details: push.error instanceof VodafoneObdError ? push.error.body ?? push.error.message : String(push.error),
          campaign: publicCampaign(campaign),
          leads,
        });
      }
    }

    let started = false;
    let viStatus: unknown = null;
    if (d.start !== false && leads.pushed > 0) {
      try {
        const res = await startObdCampaignOrConfirmActive(customerId, viCampaignId, viCampaignRefId);
        viStatus = res.viStatus;
        if (res.alreadyActive) {
          app.log.info({ campaignId: id, viCampaignId, viStatus: res.viStatus?.currentStatus }, "vodafone-campaigns: VI already runs the campaign on its window");
        }
        const upd = await pool.query(
          `UPDATE outbound_campaigns SET status = 'running', updated_at = NOW() WHERE id = $1 RETURNING *`,
          [id]
        );
        campaign = upd.rows[0];
        started = true;
      } catch (err) {
        app.log.error({ err, campaignId: id }, "vodafone-campaigns: VI start failed");
        return reply.status(502).send({
          error: "The campaign and its numbers are on Vodafone but starting it failed. Retry with POST /vodafone/campaigns/{id}/start.",
          details: err instanceof VodafoneObdError ? err.body ?? err.message : String(err),
          campaign: publicCampaign(campaign),
          leads,
        });
      }
    }

    if (leads.pushed > 0 && !viStatus) {
      try {
        viStatus = await getObdCampaignStatus(customerId, String(viCampaignRefId ?? viCampaignId));
      } catch {
        viStatus = null;
      }
    }
    app.log.info(
      { customerId, campaignId: id, viCampaignId, viCampaignRefId, dni, leads, started, viStatus },
      "vodafone-campaigns: campaign created"
    );
    return reply.status(201).send({
      message: started
        ? "Vodafone campaign started; VI dials the numbers inside the window"
        : leads.pushed > 0
          ? "Vodafone campaign created and loaded; start it with POST /vodafone/campaigns/{id}/start"
          : "Vodafone campaign created; add numbers with POST /vodafone/campaigns/{id}/leads",
      started,
      window,
      dni,
      leads,
      campaign: publicCampaign(campaign),
      vi_status: viStatus,
    });
  });

  // The calling numbers (DNIs) VI accepts for this customer's Flow, with the
  // matching company phone numbers: the only valid outbound numbers.
  app.get("/vodafone/active-dnis", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const customerId = request.customerId!;
    const telephony = await getTelephonySettings(customerId);
    if (!telephony || telephony.provider_id !== "vodafone" || !telephony.is_enabled) {
      return reply.status(400).send({ error: "Vodafone is not the enabled telephony provider for this customer" });
    }
    const flowId = (telephony.metadata as Record<string, unknown> | undefined)?.vi_flow_id as string | undefined;
    if (!flowId) return reply.status(400).send({ error: "No vi_flow_id set for this customer" });
    let active: string[];
    try {
      active = await getActiveDniList(customerId, flowId);
    } catch (err) {
      return viErrorReply(reply, err, "Could not read the active DNIs from Vodafone");
    }
    const nums = await pool.query(
      `SELECT id, phone_number, label, is_primary FROM company_phone_numbers WHERE customer_id = $1 AND is_enabled = TRUE`,
      [customerId]
    );
    return reply.send({
      active_dnis: active.map((dni) => {
        const n = nums.rows.find((r) => digitsOnly(r.phone_number).slice(-10) === dni);
        return { dni, phone_number_id: n?.id ?? null, phone_number: n?.phone_number ?? null, label: n?.label ?? null };
      }),
    });
  });

  // List this customer's Vodafone campaigns.
  app.get("/vodafone/campaigns", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const res = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*)::int FROM outbound_campaign_leads l WHERE l.campaign_id = c.id) AS total_leads,
              (SELECT COUNT(*)::int FROM outbound_campaign_leads l WHERE l.campaign_id = c.id AND l.status = 'completed') AS completed_calls
         FROM outbound_campaigns c
        WHERE c.customer_id = $1 AND c.telephony_provider_id = 'vodafone' AND c.status != 'deleted'
        ORDER BY c.created_at DESC`,
      [request.customerId]
    );
    return reply.send(res.rows.map((r) => ({ ...publicCampaign(r), total_leads: r.total_leads, completed_calls: r.completed_calls })));
  });

  // One campaign: local lead counts + live VI dialing status.
  app.get<{ Params: { id: string } }>("/vodafone/campaigns/:id", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const campaign = await loadVodafoneCampaign(request.customerId!, id);
    if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });
    let vi: unknown = null;
    let viError: string | null = null;
    try {
      vi = await getObdCampaignStatus(request.customerId!, statusIdOf(campaign));
    } catch (err) {
      viError = err instanceof VodafoneObdError ? err.message : String(err);
    }
    return reply.send({ campaign: publicCampaign(campaign), leads: await leadCounts(campaign.id), vi_status: vi, vi_status_error: viError });
  });

  // Add more numbers to an existing campaign (VI dials them in the window if it is running).
  app.post<{ Params: { id: string } }>("/vodafone/campaigns/:id/leads", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const body = leadsSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    const customerId = request.customerId!;
    const campaign = await loadVodafoneCampaign(customerId, id);
    if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });

    const numbers = normalizeNumbers(body.data.phone_numbers);
    if (numbers.valid.length === 0) return reply.status(400).send({ error: "None of phone_numbers is a valid number (10-13 digits)" });
    let push: { pushed: number; alreadyInCampaign: number; error?: unknown };
    try {
      push = await pushNumbers(customerId, campaign, numbers.valid);
    } catch (err) {
      return viErrorReply(reply, err, "Could not upload the numbers to Vodafone");
    }
    const leads = {
      received: body.data.phone_numbers.length,
      valid: numbers.valid.length,
      invalid: numbers.invalid,
      duplicates: numbers.duplicates,
      already_in_campaign: push.alreadyInCampaign,
      pushed: push.pushed,
    };
    if (push.error) {
      app.log.error({ err: push.error, campaignId: id }, "vodafone-campaigns: base upload to VI failed");
      return reply.status(502).send({
        error: "Uploading the numbers to Vodafone failed part-way; only the first `pushed` numbers were accepted",
        details: push.error instanceof VodafoneObdError ? push.error.body ?? push.error.message : String(push.error),
        leads,
      });
    }
    return reply.send({ message: `${push.pushed} numbers added to the Vodafone campaign`, leads });
  });

  // Start (or resume after pause).
  app.post<{ Params: { id: string } }>("/vodafone/campaigns/:id/start", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.customerId!;
    const campaign = await loadVodafoneCampaign(customerId, id);
    if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });
    const counts = await leadCounts(campaign.id);
    if (counts.total === 0) return reply.status(400).send({ error: "This campaign has no numbers yet; add them with POST /vodafone/campaigns/{id}/leads" });
    let res: Awaited<ReturnType<typeof startObdCampaignOrConfirmActive>>;
    try {
      res = await startObdCampaignOrConfirmActive(customerId, campaign.vi_campaign_id, campaign.vi_campaign_ref_id);
    } catch (err) {
      app.log.error({ err, campaignId: id }, "vodafone-campaigns: VI start failed");
      return viErrorReply(reply, err, "Vodafone could not start the campaign");
    }
    if (res.alreadyActive) {
      app.log.info({ campaignId: id, viStatus: res.viStatus?.currentStatus }, "vodafone-campaigns: VI already runs the campaign on its window");
    }
    await pool.query(`UPDATE outbound_campaigns SET status = 'running', updated_at = NOW() WHERE id = $1`, [id]);
    return reply.send({
      message: res.alreadyActive ? "Vodafone campaign is already scheduled on VI; it dials inside its window" : "Vodafone campaign started",
      id,
      vi_campaign_id: campaign.vi_campaign_id,
      status: "running",
      already_active: res.alreadyActive,
      vi_status: res.viStatus,
    });
  });

  // Pause.
  app.post<{ Params: { id: string } }>("/vodafone/campaigns/:id/pause", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.customerId!;
    const campaign = await loadVodafoneCampaign(customerId, id);
    if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });
    try {
      await startOrStopObdCampaign(customerId, campaign.vi_campaign_id, "P");
    } catch (err) {
      app.log.error({ err, campaignId: id }, "vodafone-campaigns: VI pause failed");
      return viErrorReply(reply, err, "Vodafone could not pause the campaign");
    }
    // outbound_campaigns.status has no 'paused' value: a paused campaign is 'ready' (start resumes it).
    await pool.query(`UPDATE outbound_campaigns SET status = 'ready', updated_at = NOW() WHERE id = $1`, [id]);
    return reply.send({ message: "Vodafone campaign paused", id, status: "ready", paused: true });
  });

  // Delete: pause on VI first, then soft-delete locally.
  app.delete<{ Params: { id: string } }>("/vodafone/campaigns/:id", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const customerId = request.customerId!;
    const campaign = await loadVodafoneCampaign(customerId, id);
    if (!campaign) return reply.status(404).send({ error: "Vodafone campaign not found" });
    let viPaused = true;
    try {
      await startOrStopObdCampaign(customerId, campaign.vi_campaign_id, "P");
    } catch (err) {
      viPaused = false;
      app.log.error({ err, campaignId: id }, "vodafone-campaigns: VI pause on delete failed (deleting locally anyway)");
    }
    await pool.query(`UPDATE outbound_campaigns SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [id]);
    return reply.send({ message: "Vodafone campaign deleted", id, vi_paused: viPaused });
  });
}
