// ============================================================
// Exotel Settings Admin Routes
// CRUD for customer_exotel_settings — admin token required.
// Reference: docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §12.1
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { adminAuth } from "../middleware/auth";
import {
  invalidateExotelSettingsCache,
  getExotelSettings,
} from "../services/exotel-settings";
import { voicebotUrlsForCustomer } from "../services/exotel-voice-urls";
import { getActiveSessionsForCustomer } from "../services/voicebot-session";

// ---------- Schemas ----------

const upsertExotelSettingsSchema = z.object({
  exotel_account_sid: z.string().min(1).optional(),
  exotel_app_id: z.string().min(1).optional(),
  exotel_subdomain: z.string().min(1).optional(),
  exotel_api_key: z.string().min(1).optional(),
  exotel_api_token: z.string().min(1).optional(),
  inbound_phone_number: z.string().min(1).optional(),
  default_outbound_caller_id: z.string().min(1).optional(),
  is_enabled: z.boolean().optional(),
  use_sandbox: z.boolean().optional(),
});

// ---------- Routes ----------

export async function exotelSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ---- Get Exotel settings for a customer ----
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/exotel-settings",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;

      const result = await pool.query(
        `SELECT
           id, customer_id,
           exotel_account_sid, exotel_app_id, exotel_subdomain,
           inbound_phone_number, default_outbound_caller_id,
           is_enabled, use_sandbox,
           (exotel_api_key IS NOT NULL) AS has_api_key,
           (exotel_api_token IS NOT NULL) AS has_api_token,
           created_at, updated_at
         FROM customer_exotel_settings
         WHERE customer_id = $1`,
        [customerId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Exotel settings not found for this customer" });
      }

      const row = result.rows[0];
      const urls = voicebotUrlsForCustomer(customerId, request);
      return reply.send({
        ...row,
        ...urls,
      });
    }
  );

  // ---- Create or update Exotel settings for a customer ----
  app.put<{ Params: { customerId: string } }>(
    "/customers/:customerId/exotel-settings",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;
      const body = upsertExotelSettingsSchema.safeParse(request.body ?? {});

      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      // Verify customer exists
      const customer = await pool.query(
        "SELECT id FROM customers WHERE id = $1",
        [customerId]
      );
      if (customer.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }

      const d = body.data;

      const result = await pool.query(
        `INSERT INTO customer_exotel_settings (
           customer_id,
           exotel_account_sid, exotel_app_id, exotel_subdomain,
           exotel_api_key, exotel_api_token,
           inbound_phone_number, default_outbound_caller_id,
           is_enabled, use_sandbox
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (customer_id) DO UPDATE SET
           exotel_account_sid = COALESCE(EXCLUDED.exotel_account_sid, customer_exotel_settings.exotel_account_sid),
           exotel_app_id = COALESCE(EXCLUDED.exotel_app_id, customer_exotel_settings.exotel_app_id),
           exotel_subdomain = COALESCE(EXCLUDED.exotel_subdomain, customer_exotel_settings.exotel_subdomain),
           exotel_api_key = COALESCE(EXCLUDED.exotel_api_key, customer_exotel_settings.exotel_api_key),
           exotel_api_token = COALESCE(EXCLUDED.exotel_api_token, customer_exotel_settings.exotel_api_token),
           inbound_phone_number = COALESCE(EXCLUDED.inbound_phone_number, customer_exotel_settings.inbound_phone_number),
           default_outbound_caller_id = COALESCE(EXCLUDED.default_outbound_caller_id, customer_exotel_settings.default_outbound_caller_id),
           webhook_secret = NULL,
           voicebot_wss_url = NULL,
           voicebot_bootstrap_https_url = NULL,
           is_enabled = COALESCE(EXCLUDED.is_enabled, customer_exotel_settings.is_enabled),
           use_sandbox = COALESCE(EXCLUDED.use_sandbox, customer_exotel_settings.use_sandbox),
           updated_at = NOW()
         RETURNING
           id, customer_id,
           exotel_account_sid, exotel_app_id, exotel_subdomain,
           inbound_phone_number, default_outbound_caller_id,
           is_enabled, use_sandbox,
           (exotel_api_key IS NOT NULL) AS has_api_key,
           (exotel_api_token IS NOT NULL) AS has_api_token,
           created_at, updated_at`,
        [
          customerId,
          d.exotel_account_sid || null,
          d.exotel_app_id || null,
          d.exotel_subdomain || null,
          d.exotel_api_key || null,
          d.exotel_api_token || null,
          d.inbound_phone_number || null,
          d.default_outbound_caller_id || null,
          d.is_enabled ?? false,
          d.use_sandbox ?? false,
        ]
      );

      // Invalidate cache for this customer
      invalidateExotelSettingsCache(customerId);

      const row = result.rows[0];
      const urls = voicebotUrlsForCustomer(customerId, request);
      return reply.send({ ...row, ...urls });
    }
  );

  // ---- Delete Exotel settings for a customer ----
  app.delete<{ Params: { customerId: string } }>(
    "/customers/:customerId/exotel-settings",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;

      const result = await pool.query(
        `DELETE FROM customer_exotel_settings WHERE customer_id = $1 RETURNING id`,
        [customerId]
      );

      invalidateExotelSettingsCache(customerId);

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "No Exotel settings found" });
      }

      return reply.send({ deleted: true, id: result.rows[0].id });
    }
  );

  // ---- Get active voicebot sessions for a customer ----
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/voicebot-sessions",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;

      // In-memory active sessions
      const activeSessions = getActiveSessionsForCustomer(customerId).map((s) => ({
        stream_sid: s.streamSid,
        call_sid: s.callSid,
        from: s.from,
        to: s.to,
        sample_rate: s.mediaFormat.sample_rate,
        started_at: new Date(s.startedAt).toISOString(),
        duration_seconds: Math.round((Date.now() - s.startedAt) / 1000),
        is_speaking: s.isSpeaking,
        has_chat_session: !!s.chatSessionId,
      }));

      // Recent DB call sessions
      const dbSessions = await pool.query(
        `SELECT id, exotel_call_sid, exotel_stream_sid, direction,
                from_number, to_number, status,
                chat_session_id, started_at, ended_at
         FROM exotel_call_sessions
         WHERE customer_id = $1
         ORDER BY started_at DESC
         LIMIT 25`,
        [customerId]
      );

      return reply.send({
        active: activeSessions,
        recent: dbSessions.rows,
      });
    }
  );
}
