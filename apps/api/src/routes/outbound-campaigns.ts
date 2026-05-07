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
import { env } from "../config/env";

const CAMPAIGN_UPLOAD_DIR = path.join(process.cwd(), "uploads", "campaigns");

// Ensure upload directory exists
if (!fs.existsSync(CAMPAIGN_UPLOAD_DIR)) {
  fs.mkdirSync(CAMPAIGN_UPLOAD_DIR, { recursive: true });
}

const createCampaignSchema = z.object({
  name: z.string().min(1),
  script_text: z.string().min(1),
  language_code: z.string().default("en-IN"),
});

const addLeadsSchema = z.object({
  phone_numbers: z.array(z.string().min(3)).min(1),
});

const normalOutboundCallSchema = z.object({
  phone_number: z.string().min(3),
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
      const { name, script_text, language_code } = body.data;

      // Generate Audio via Sarvam TTS
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

        const result = await pool.query(
          `INSERT INTO outbound_campaigns (id, customer_id, name, script_text, language_code, audio_file_path, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [campaignId, customerId, name, script_text, language_code, filePath, "ready"]
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
        "SELECT id FROM outbound_campaigns WHERE id = $1 AND customer_id = $2",
        [id, customerId]
      );
      if (campaign.rows.length === 0) {
        return reply.status(404).send({ error: "Campaign not found" });
      }

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
        return reply.send({ message: `${phone_numbers.length} leads added to campaign` });
      } catch (err) {
        await client.query("ROLLBACK");
        app.log.error({ err }, "Failed to add leads to campaign");
        return reply.status(500).send({ error: "Internal Server Error" });
      } finally {
        client.release();
      }
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

      const settings = await getExotelSettings(customerId);
      const customerSettings = await getCustomerSettings(customerId);
      if (!settings || !settings.is_enabled) {
        return reply.status(400).send({ error: "Exotel not configured" });
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
      }

      // Update status to running
      await pool.query("UPDATE outbound_campaigns SET status = 'running' WHERE id = $1", [id]);

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

      // Background triggering (simplified one-by-one for now)
      // In a real production app, this would be a background queue.
      for (const lead of leads) {
        try {
          
          const pendingSessionId = await createCallSession({
            customerId,
            callSid: null,
            streamSid: null,
            direction: "outbound",
            fromNumber: settings.default_outbound_caller_id || settings.inbound_phone_number || "",
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
          const callerId = settings.default_outbound_caller_id || settings.inbound_phone_number;

          const { voicebot_wss_url: streamUrl, voicebot_status_callback_url: statusCallback } = voicebotUrlsForCustomer(customerId, request);
          
          app.log.info({ streamUrl, statusCallback, customerId }, "Triggering outbound campaign call via Exotel");
          
          const exotelResult = await exotelConnectCall({
            accountSid: settings.exotel_account_sid!,
            apiKey: settings.exotel_api_key!,
            apiToken: settings.exotel_api_token!,
            restApiBaseUrl: restApiBaseUrlFromSubdomain(settings.exotel_subdomain) || undefined,
            from: lead.phone_number,
            to: settings.default_outbound_caller_id || settings.inbound_phone_number || "",
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
      const { phone_number } = body.data;

      const settings = await getExotelSettings(customerId);
      const customerSettings = await getCustomerSettings(customerId);
      if (!settings || !settings.is_enabled) {
        return reply.status(400).send({ error: "Exotel not configured" });
      }

      try {
        const pendingSessionId = await createCallSession({
          customerId,
          callSid: null,
          streamSid: null,
          direction: "outbound",
          fromNumber: settings.default_outbound_caller_id || settings.inbound_phone_number || "",
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
        const callerId = settings.default_outbound_caller_id || settings.inbound_phone_number;

        const { voicebot_wss_url: streamUrl, voicebot_status_callback_url: statusCallback } = voicebotUrlsForCustomer(customerId, request);
        
        app.log.info({ streamUrl, statusCallback, customerId }, "Triggering direct outbound call via Exotel");
        
        const exotelResult = await exotelConnectCall({
          accountSid: settings.exotel_account_sid!,
          apiKey: settings.exotel_api_key!,
          apiToken: settings.exotel_api_token!,
          restApiBaseUrl: restApiBaseUrlFromSubdomain(settings.exotel_subdomain) || undefined,
          from: phone_number,
          to: settings.default_outbound_caller_id || settings.inbound_phone_number || "",
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
