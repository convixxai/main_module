import { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "fs";
import { randomUUID } from "crypto";
import path from "path";
import { pool } from "../config/db";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { sarvamTextToSpeechStream } from "../services/sarvam";
import { getExotelSettings, createCallSession } from "../services/exotel-settings";
import { getCustomerSettings } from "../services/customer-settings";
import { exotelConnectCall, restApiBaseUrlFromSubdomain } from "../services/exotel-connect-call";
import { voicebotUrlsForCustomer } from "../services/exotel-voice-urls";
import { resolvePhoneNumberById } from "../services/company-phone-numbers";
import { env } from "../config/env";
import type { ExotelSettings } from "../services/exotel-settings";
import { getTelephonySettings } from "../services/telephony-settings";
import {
  createObdCampaignWithFlow,
  getSampleBaseHeads,
  staticCampaignBaseLoad,
  startOrStopObdCampaign,
  getObdCampaignStatus,
  getVodafoneObdCredentials,
  VodafoneObdError,
  type StaticObdBaseRecord,
} from "../services/vodafone-obd";

/** Which carrier a customer is configured for right now. Defaults to 'exotel' (today's only fully-wired provider) when no company_telephony_settings row exists at all. */
async function resolveTelephonyProvider(customerId: string): Promise<"exotel" | "vodafone"> {
  const settings = await getTelephonySettings(customerId);
  if (settings?.provider_id === "vodafone" && settings.is_enabled) return "vodafone";
  return "exotel";
}

/**
 * Feature 3 (one company, many numbers): resolves the caller ID to use for
 * an outbound call. If `phoneNumberId` names an enabled number belonging to
 * this customer, uses it; otherwise falls back to exactly today's
 * `default_outbound_caller_id || inbound_phone_number` chain, unchanged.
 */
async function resolveOutboundCallerId(
  customerId: string,
  phoneNumberId: string | null | undefined,
  settings: ExotelSettings
): Promise<string | null> {
  if (phoneNumberId) {
    const number = await resolvePhoneNumberById(customerId, phoneNumberId);
    if (number) return number.phone_number;
  }
  return settings.default_outbound_caller_id || settings.inbound_phone_number || null;
}

/**
 * Feature 3 (one company, many numbers) for Vodafone OBD campaigns: resolves
 * the `dni` (outbound caller CLI) to use for this campaign's base records.
 * If the campaign has a `phone_number_id` naming an enabled number belonging
 * to this customer, uses that number; otherwise falls back to the tenant-wide
 * `credentials.dni` (today's only option before per-campaign numbers existed)
 * — mirrors resolveOutboundCallerId's same fallback shape for Exotel.
 */
async function resolveObdDni(
  customerId: string,
  phoneNumberId: string | null | undefined,
  tenantDni: string | null | undefined
): Promise<string> {
  if (phoneNumberId) {
    const number = await resolvePhoneNumberById(customerId, phoneNumberId);
    if (number) return number.phone_number;
  }
  return tenantDni ?? "";
}

/**
 * Builds one VI OBD base record per lead, keyed by whatever
 * getSampleBaseHeads actually returned for this campaign's flowid (cached on
 * outbound_campaigns.vi_base_variable_names at creation time) — rather than
 * hardcoding variable names, since those are defined in VI's portal per
 * Flow, not by this codebase. `msisdn` and `dni` are filled from the lead
 * phone number and the tenant's configured OBD server CLI respectively;
 * `call_type`/`campaign_id` (or whatever else the Flow's schema defines)
 * fall back to an empty string when this Flow doesn't expose that variable.
 */
function buildObdBaseRecord(
  variableNames: string[],
  phoneNumber: string,
  dni: string,
  campaignId: string
): StaticObdBaseRecord {
  const record: StaticObdBaseRecord = { dni, msisdn: phoneNumber };
  for (const varName of variableNames) {
    if (varName === "msisdn" || varName === "dni") continue;
    if (varName === "call_type") record[varName] = "outbound";
    else if (varName === "campaign_id") record[varName] = campaignId;
    else record[varName] = "";
  }
  return record;
}

const CAMPAIGN_UPLOAD_DIR = path.join(process.cwd(), "uploads", "campaigns");

// Ensure upload directory exists
if (!fs.existsSync(CAMPAIGN_UPLOAD_DIR)) {
  fs.mkdirSync(CAMPAIGN_UPLOAD_DIR, { recursive: true });
}

const createCampaignSchema = z.object({
  name: z.string().min(1),
  script_text: z.string().min(1),
  language_code: z.string().default("en-IN"),
  phone_number_id: z.string().uuid().optional(),
  /**
   * Vodafone-only fields below — required when this customer's telephony
   * provider resolves to 'vodafone' (checked in the handler, not here,
   * since the required set depends on which carrier the customer is on).
   * See services/vodafone-obd.ts header for the "With Flow" design.
   * NOTE: vi_flow_id is NOT one of these — it's tied to the tenant's
   * WS/Streaming Object wiring, not to an individual campaign, so it's
   * configured once via PUT /customers/:customerId/vodafone-settings and
   * read from there (see metadata.vi_flow_id) rather than passed here.
   */
  fromdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  todate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  fromtime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
  totime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/).optional(),
  dial_timeout_seconds: z.number().int().positive().default(15).optional(),
  retry_interval_type: z.enum(["0", "1"]).default("0").optional(),
  retry_interval_value: z.number().int().positive().default(60).optional(),
  retry_count: z.number().int().min(0).default(0).optional(),
});

const addLeadsSchema = z.object({
  phone_numbers: z.array(z.string().min(3)).min(1),
});

const normalOutboundCallSchema = z.object({
  phone_number: z.string().min(3),
  phone_number_id: z.string().uuid().optional(),
});

const triggerCampaignSchema = z.object({
  phone_numbers: z.array(z.string().min(3)).optional(),
});

export async function outboundCampaignRoutes(app: FastifyInstance) {
  // 1. Create Campaign
  app.post(
    "/outbound/campaigns",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = createCampaignSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const {
        name,
        script_text,
        language_code,
        phone_number_id,
        fromdate,
        todate,
        fromtime,
        totime,
        dial_timeout_seconds,
        retry_interval_type,
        retry_interval_value,
        retry_count,
      } = body.data;

      if (phone_number_id) {
        const number = await resolvePhoneNumberById(customerId, phone_number_id);
        if (!number) {
          return reply.status(400).send({ error: "phone_number_id does not belong to this customer or is disabled" });
        }
      }

      const telephonySettings = await getTelephonySettings(customerId);
      const provider: "exotel" | "vodafone" =
        telephonySettings?.provider_id === "vodafone" && telephonySettings.is_enabled ? "vodafone" : "exotel";
      // vi_flow_id is configured once per tenant via PUT /customers/:customerId/vodafone-settings
      // (metadata.vi_flow_id) — not passed per campaign, see createCampaignSchema's comment.
      const viFlowId = (telephonySettings?.metadata as Record<string, unknown> | undefined)?.vi_flow_id as
        | string
        | undefined;
      if (provider === "vodafone" && (!viFlowId || !fromdate || !todate || !fromtime || !totime)) {
        return reply.status(400).send({
          error:
            "This customer is on Vodafone — set vi_flow_id via PUT /customers/:customerId/vodafone-settings first, and pass fromdate/todate/fromtime/totime to create an OBD campaign",
        });
      }

      // Generate Audio via Sarvam TTS — our bot streams this itself over the
      // live WS channel once connected (same as the inbound greeting path),
      // independent of VI's own in-flow voice-upload mechanism.
      try {
        const ttsResult = await sarvamTextToSpeechStream({
          text: script_text,
          target_language_code: language_code,
          output_audio_codec: "wav",
        });

        if (ttsResult.status !== 200 || !ttsResult.audioBuffer) {
          return reply.status(502).send({
            error: "TTS Generation failed",
            details: ttsResult.body
          });
        }

        const campaignId = randomUUID();
        const fileName = `${campaignId}.wav`;
        const filePath = path.join(CAMPAIGN_UPLOAD_DIR, fileName);

        fs.writeFileSync(filePath, ttsResult.audioBuffer);

        let viCampaignId: string | null = null;
        let viCampaignRefId: number | null = null;
        let viBaseVariableNames: string[] | null = null;

        if (provider === "vodafone") {
          try {
            const created = await createObdCampaignWithFlow(customerId, {
              flowid: viFlowId!,
              fromdate: fromdate!,
              todate: todate!,
              fromtime: fromtime!,
              totime: totime!,
              dialtimeout: String(dial_timeout_seconds ?? 15),
              name,
              description: name,
              retryintervaltype: (retry_interval_type ?? "0") as "0" | "1",
              retryintervalvalue: retry_interval_value ?? 60,
              retrycount: retry_count ?? 0,
            });
            viCampaignId = created.campainKey;
            viCampaignRefId = created.campaign_Ref_ID;
            viBaseVariableNames = await getSampleBaseHeads(customerId, viCampaignId);
          } catch (viErr) {
            fs.unlinkSync(filePath);
            const status = viErr instanceof VodafoneObdError ? viErr.httpStatus : 502;
            app.log.error({ err: viErr }, "Failed to create VI OBD campaign");
            return reply.status(status === 400 ? 400 : 502).send({
              error: "Vodafone OBD campaign creation failed",
              details: viErr instanceof VodafoneObdError ? viErr.body : String(viErr),
            });
          }
        }

        const result = await pool.query(
          `INSERT INTO outbound_campaigns (
             id, customer_id, name, script_text, language_code, audio_file_path, status, phone_number_id,
             telephony_provider_id, vi_flow_id, vi_campaign_id, vi_campaign_ref_id, vi_base_variable_names
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [
            campaignId,
            customerId,
            name,
            script_text,
            language_code,
            filePath,
            "ready",
            phone_number_id ?? null,
            provider,
            viFlowId ?? null,
            viCampaignId,
            viCampaignRefId,
            viBaseVariableNames,
          ]
        );

        return reply.status(201).send(result.rows[0]);
      } catch (err) {
        app.log.error({ err }, "Failed to create outbound campaign");
        return reply.status(500).send({ error: "Internal Server Error" });
      }
    }
  );

  // 2. Add Leads to Campaign
  app.post<{ Params: { id: string } }>(
    "/outbound/campaigns/:id/leads",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const body = addLeadsSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const { phone_numbers } = body.data;

      // Verify campaign ownership
      const campaign = await pool.query(
        "SELECT * FROM outbound_campaigns WHERE id = $1 AND customer_id = $2",
        [id, customerId]
      );
      if (campaign.rows.length === 0) {
        return reply.status(404).send({ error: "Campaign not found" });
      }
      const campaignRow = campaign.rows[0];

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const phone of phone_numbers) {
          await client.query(
            "INSERT INTO outbound_campaign_leads (campaign_id, phone_number) VALUES ($1, $2)",
            [id, phone]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        app.log.error({ err }, "Failed to add leads to campaign");
        return reply.status(500).send({ error: "Internal Server Error" });
      } finally {
        client.release();
      }

      // Vodafone campaigns: also push the base to VI so it actually dials
      // these numbers (Exotel campaigns dial per-lead later, at /trigger).
      if (campaignRow.telephony_provider_id === "vodafone") {
        try {
          const creds = await getVodafoneObdCredentials(customerId);
          const dni = await resolveObdDni(customerId, campaignRow.phone_number_id, creds.dni);
          const variableNames: string[] = campaignRow.vi_base_variable_names ?? ["msisdn", "dni", "call_type", "campaign_id"];
          const records = phone_numbers.map((phone) =>
            buildObdBaseRecord(variableNames, phone, dni, id)
          );
          await staticCampaignBaseLoad(customerId, campaignRow.vi_campaign_id, records);
        } catch (viErr) {
          app.log.error({ err: viErr, campaignId: id }, "Failed to push lead base to VI OBD campaign");
          return reply.status(viErr instanceof VodafoneObdError ? viErr.httpStatus : 502).send({
            error: "Leads saved locally, but pushing the base to Vodafone failed",
            details: viErr instanceof VodafoneObdError ? viErr.body : String(viErr),
          });
        }
      }

      return reply.send({ message: `${phone_numbers.length} leads added to campaign` });
    }
  );

  // 3. Trigger Campaign (Start calls)
  app.post<{ Params: { id: string } }>(
    "/outbound/campaigns/:id/trigger",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const body = triggerCampaignSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const { phone_numbers } = body.data;

      const campaignRes = await pool.query(
        "SELECT * FROM outbound_campaigns WHERE id = $1 AND customer_id = $2",
        [id, customerId]
      );
      if (campaignRes.rows.length === 0) {
        return reply.status(404).send({ error: "Campaign not found" });
      }

      const campaign = campaignRes.rows[0];
      if (campaign.status === "deleted") {
        return reply.status(400).send({ error: "Campaign is deleted" });
      }

      // If phone_numbers provided, add them as leads first
      if (phone_numbers && phone_numbers.length > 0) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const phone of phone_numbers) {
            await client.query(
              "INSERT INTO outbound_campaign_leads (campaign_id, phone_number) VALUES ($1, $2)",
              [id, phone]
            );
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          app.log.error({ err }, "Failed to add leads during trigger");
          return reply.status(500).send({ error: "Failed to add leads" });
        } finally {
          client.release();
        }

        if (campaign.telephony_provider_id === "vodafone") {
          try {
            const creds = await getVodafoneObdCredentials(customerId);
            const dni = await resolveObdDni(customerId, campaign.phone_number_id, creds.dni);
            const variableNames: string[] = campaign.vi_base_variable_names ?? ["msisdn", "dni", "call_type", "campaign_id"];
            const records = phone_numbers.map((phone) =>
              buildObdBaseRecord(variableNames, phone, dni, id)
            );
            await staticCampaignBaseLoad(customerId, campaign.vi_campaign_id, records);
          } catch (viErr) {
            app.log.error({ err: viErr, campaignId: id }, "Failed to push lead base to VI OBD campaign at trigger time");
            return reply.status(viErr instanceof VodafoneObdError ? viErr.httpStatus : 502).send({
              error: "Leads saved locally, but pushing the base to Vodafone failed",
              details: viErr instanceof VodafoneObdError ? viErr.body : String(viErr),
            });
          }
        }
      }

      // Update status to running
      await pool.query("UPDATE outbound_campaigns SET status = 'running' WHERE id = $1", [id]);

      // Vodafone: VI dials the whole base itself once the campaign is
      // started — there is no per-lead REST call to loop over like Exotel's
      // Calls/connect below. Hand off to StartorStop and return.
      if (campaign.telephony_provider_id === "vodafone") {
        try {
          await startOrStopObdCampaign(customerId, campaign.vi_campaign_id, "S");
        } catch (viErr) {
          app.log.error({ err: viErr, campaignId: id }, "Failed to start VI OBD campaign");
          return reply.status(viErr instanceof VodafoneObdError ? viErr.httpStatus : 502).send({
            error: "Failed to start Vodafone OBD campaign",
            details: viErr instanceof VodafoneObdError ? viErr.body : String(viErr),
          });
        }
        return reply.send({ message: "Vodafone OBD campaign started", vi_campaign_id: campaign.vi_campaign_id });
      }

      const settings = await getExotelSettings(customerId);
      const customerSettings = await getCustomerSettings(customerId);
      if (!settings || !settings.is_enabled) {
        return reply.status(400).send({ error: "Exotel not configured" });
      }

      // Get pending leads
      const leadsRes = await pool.query(
        "SELECT * FROM outbound_campaign_leads WHERE campaign_id = $1 AND status = 'pending'",
        [id]
      );
      const leads = leadsRes.rows;

      const results = {
        total: leads.length,
        triggered: 0,
        failed: 0,
      };

      // Feature 3 (one company, many numbers): resolve once per trigger call
      // (same caller ID for every lead in this run) rather than per-lead.
      const resolvedCallerId = await resolveOutboundCallerId(customerId, campaign.phone_number_id, settings);

      // Background triggering (simplified one-by-one for now)
      // In a real production app, this would be a background queue.
      for (const lead of leads) {
        try {

          const pendingSessionId = await createCallSession({
            customerId,
            callSid: null,
            streamSid: null,
            direction: "outbound",
            fromNumber: resolvedCallerId || "",
            toNumber: lead.phone_number,
            chatSessionId: null,
            metadata: {
              campaign_id: id,
              lead_id: lead.id,
              source: "outbound_campaign",
            },
            voicebotMultilingual: customerSettings?.voicebot_multilingual,
            defaultLanguageCode: customerSettings?.default_language_code,
            currentLanguageCode: customerSettings?.default_language_code,
          });

          const customField = `campaign_id=${id}|ccs=${pendingSessionId}`;
          const callerId = resolvedCallerId;

          const { voicebot_wss_url: streamUrl, voicebot_status_callback_url: statusCallback } = voicebotUrlsForCustomer(customerId, request);

          app.log.info({ streamUrl, statusCallback, customerId }, "Triggering outbound campaign call via Exotel");

          const exotelResult = await exotelConnectCall({
            accountSid: settings.exotel_account_sid!,
            apiKey: settings.exotel_api_key!,
            apiToken: settings.exotel_api_token!,
            restApiBaseUrl: restApiBaseUrlFromSubdomain(settings.exotel_subdomain) || undefined,
            from: resolvedCallerId || "",
            to: lead.phone_number,
            callerId: callerId!,
            streamUrl,
            streamBegin: "atLeg2connect",
            customField,
            statusCallback,
            statusCallbackEvents: ["answered", "terminal"],
            statusCallbackContentType: "application/json",
          });

          const callSid = exotelResult.call?.Sid;
          await pool.query(
            "UPDATE outbound_campaign_leads SET status = 'calling', call_sid = $1, session_id = $2 WHERE id = $3",
            [callSid, pendingSessionId, lead.id]
          );
          
          // Update the session row with the actual CallSid
          if (callSid) {
            await pool.query(
              "UPDATE exotel_call_sessions SET exotel_call_sid = $1 WHERE id = $2",
              [callSid, pendingSessionId]
            );
          }

          results.triggered++;
        } catch (err) {
          app.log.error({ err, leadId: lead.id }, "Failed to trigger call for lead");
          await pool.query(
            "UPDATE outbound_campaign_leads SET status = 'failed' WHERE id = $1",
            [lead.id]
          );
          results.failed++;
        }
      }

      return reply.send({
        message: "Campaign triggering process finished",
        results,
      });
    }
  );

  // 4. Delete Campaign (Soft delete + delete audio)
  app.delete<{ Params: { id: string } }>(
    "/outbound/campaigns/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const customerId = request.customerId!;

      const campaignRes = await pool.query(
        "SELECT * FROM outbound_campaigns WHERE id = $1 AND customer_id = $2",
        [id, customerId]
      );
      if (campaignRes.rows.length === 0) {
        return reply.status(404).send({ error: "Campaign not found" });
      }

      const campaign = campaignRes.rows[0];
      if (campaign.telephony_provider_id === "vodafone" && campaign.vi_campaign_id) {
        try {
          await startOrStopObdCampaign(customerId, campaign.vi_campaign_id, "P");
        } catch (viErr) {
          app.log.error({ err: viErr, campaignId: id }, "Failed to pause VI OBD campaign on delete (continuing with local delete)");
        }
      }

      if (campaign.audio_file_path && fs.existsSync(campaign.audio_file_path)) {
        fs.unlinkSync(campaign.audio_file_path);
      }

      await pool.query(
        "UPDATE outbound_campaigns SET status = 'deleted', audio_file_path = NULL WHERE id = $1",
        [id]
      );

      return reply.send({ message: "Campaign deleted and audio file removed" });
    }
  );

  // 4b. Pause/Resume a running Vodafone OBD campaign (Exotel has no
  // campaign-level pause — its calls are already individually triggered).
  app.post<{ Params: { id: string } }>(
    "/outbound/campaigns/:id/pause",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const customerId = request.customerId!;

      const campaignRes = await pool.query(
        "SELECT * FROM outbound_campaigns WHERE id = $1 AND customer_id = $2",
        [id, customerId]
      );
      if (campaignRes.rows.length === 0) {
        return reply.status(404).send({ error: "Campaign not found" });
      }
      const campaign = campaignRes.rows[0];
      if (campaign.telephony_provider_id !== "vodafone" || !campaign.vi_campaign_id) {
        return reply.status(400).send({ error: "Pause is only supported for Vodafone OBD campaigns" });
      }

      try {
        await startOrStopObdCampaign(customerId, campaign.vi_campaign_id, "P");
      } catch (viErr) {
        app.log.error({ err: viErr, campaignId: id }, "Failed to pause VI OBD campaign");
        return reply.status(viErr instanceof VodafoneObdError ? viErr.httpStatus : 502).send({
          error: "Failed to pause Vodafone OBD campaign",
          details: viErr instanceof VodafoneObdError ? viErr.body : String(viErr),
        });
      }

      await pool.query("UPDATE outbound_campaigns SET status = 'ready' WHERE id = $1", [id]);
      return reply.send({ message: "Vodafone OBD campaign paused" });
    }
  );

  // 4c. Live status for a Vodafone OBD campaign (pulled directly from VI).
  app.get<{ Params: { id: string } }>(
    "/outbound/campaigns/:id/status",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      const customerId = request.customerId!;

      const campaignRes = await pool.query(
        "SELECT * FROM outbound_campaigns WHERE id = $1 AND customer_id = $2",
        [id, customerId]
      );
      if (campaignRes.rows.length === 0) {
        return reply.status(404).send({ error: "Campaign not found" });
      }
      const campaign = campaignRes.rows[0];
      if (campaign.telephony_provider_id !== "vodafone" || !campaign.vi_campaign_id) {
        return reply.status(400).send({ error: "Live status is only available for Vodafone OBD campaigns" });
      }

      try {
        const status = await getObdCampaignStatus(customerId, campaign.vi_campaign_id);
        return reply.send(status);
      } catch (viErr) {
        app.log.error({ err: viErr, campaignId: id }, "Failed to fetch VI OBD campaign status");
        return reply.status(viErr instanceof VodafoneObdError ? viErr.httpStatus : 502).send({
          error: "Failed to fetch Vodafone OBD campaign status",
          details: viErr instanceof VodafoneObdError ? viErr.body : String(viErr),
        });
      }
    }
  );

  // 5. Normal Outbound Call (No campaign)
  app.post(
    "/outbound/call",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = normalOutboundCallSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const { phone_number, phone_number_id } = body.data;

      const settings = await getExotelSettings(customerId);
      const customerSettings = await getCustomerSettings(customerId);
      if (!settings || !settings.is_enabled) {
        return reply.status(400).send({ error: "Exotel not configured" });
      }
      const resolvedCallerId = await resolveOutboundCallerId(customerId, phone_number_id, settings);

      try {
        const pendingSessionId = await createCallSession({
          customerId,
          callSid: null,
          streamSid: null,
          direction: "outbound",
          fromNumber: resolvedCallerId || "",
          toNumber: phone_number,
          chatSessionId: null,
          metadata: {
            source: "normal_outbound",
          },
          voicebotMultilingual: customerSettings?.voicebot_multilingual,
          defaultLanguageCode: customerSettings?.default_language_code,
          currentLanguageCode: customerSettings?.default_language_code,
        });

        const customField = `ccs=${pendingSessionId}`;
        const callerId = resolvedCallerId;

        const { voicebot_wss_url: streamUrl, voicebot_status_callback_url: statusCallback } = voicebotUrlsForCustomer(customerId, request);
        
        app.log.info({ streamUrl, statusCallback, customerId }, "Triggering direct outbound call via Exotel");
        
        const exotelResult = await exotelConnectCall({
          accountSid: settings.exotel_account_sid!,
          apiKey: settings.exotel_api_key!,
          apiToken: settings.exotel_api_token!,
          restApiBaseUrl: restApiBaseUrlFromSubdomain(settings.exotel_subdomain) || undefined,
          from: resolvedCallerId || "",
          to: phone_number,
          callerId: callerId!,
          streamUrl,
          streamBegin: "atLeg2connect",
          customField,
          statusCallback,
          statusCallbackEvents: ["answered", "terminal"],
          statusCallbackContentType: "application/json",
        });

        const callSid = exotelResult.call?.Sid;
        if (callSid) {
          await pool.query(
            "UPDATE exotel_call_sessions SET exotel_call_sid = $1 WHERE id = $2",
            [callSid, pendingSessionId]
          );
        }

        return reply.send({
          message: "Outbound call initiated",
          call_sid: callSid,
          session_id: pendingSessionId
        });
      } catch (err) {
        app.log.error({ err, phone_number }, "Failed to trigger normal outbound call");
        return reply.status(500).send({ error: "Internal Server Error" });
      }
    }
  );

  // 5. List all campaigns for a customer
  app.get(
    "/outbound/campaigns",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      
      try {
        const result = await pool.query(
          `SELECT 
             c.*,
             (SELECT COUNT(*) FROM outbound_campaign_leads WHERE campaign_id = c.id) as total_leads,
             (SELECT COUNT(*) FROM outbound_campaign_leads WHERE campaign_id = c.id AND status = 'calling') as active_calls,
             (SELECT COUNT(*) FROM outbound_campaign_leads WHERE campaign_id = c.id AND status = 'completed') as completed_calls
           FROM outbound_campaigns c
           WHERE customer_id = $1
           ORDER BY created_at DESC`,
          [customerId]
        );

        return reply.send(result.rows);
      } catch (err) {
        app.log.error({ err, customerId }, "Failed to list campaigns");
        return reply.status(500).send({ error: "Internal Server Error" });
      }
    }
  );
}
