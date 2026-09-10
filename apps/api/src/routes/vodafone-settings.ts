// ============================================================
// Vodafone (VI) Settings Admin Routes
// CRUD for company_telephony_settings where provider_id='vodafone' - mirrors
// exotel-settings.ts's shape for company_telephony_settings/customer_exotel_settings.
//
// There is no Vodafone outbound-call-creation REST API to wrap here (VI's
// contract for that is still undocumented, see
// services/vodafone-adapter.ts's triggerOutboundCall). VI's model is the
// reverse of Exotel's: VI connects out to a WebSocket URL that the customer
// configures on VI's own Streaming Object, we never call VI to start a
// stream. So this route only captures what our side actually needs to
// accept that inbound connection (is_enabled), plus a generic, optional
// credentials blob in case VI's auth mechanism (still open, see roadmap
// §8.5.1 item 3) turns out to need one, and returns the WebSocket URL to
// hand to VI's config UI.
//
// Reference: docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5, §8.5.1
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { adminAuth } from "../middleware/auth";
import { encrypt } from "../services/crypto";
import { invalidateTelephonySettingsCache } from "../services/telephony-settings";
import { vodafoneVoicebotUrlForCustomer } from "../services/vodafone-voice-urls";

const upsertVodafoneSettingsSchema = z.object({
  is_enabled: z.boolean().optional(),
  use_sandbox: z.boolean().optional(),
  /** Free-form, e.g. { custom_parameters: { agentId: "..." } } for reference/documentation of what is configured on VI's Streaming Object - not enforced or read by the WS route today. */
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Opaque credentials blob (shape TBD - VI's auth/handshake mechanism is undocumented). Stored encrypted if provided; never read back in plaintext. */
  credentials: z.record(z.string(), z.string()).optional(),
});

async function loadRow(customerId: string) {
  const result = await pool.query(
    `SELECT id, customer_id, provider_id, is_enabled, use_sandbox, metadata,
            (credentials_enc IS NOT NULL) AS has_credentials,
            created_at, updated_at
     FROM company_telephony_settings
     WHERE customer_id = $1`,
    [customerId]
  );
  return result.rows[0] ?? null;
}

export async function vodafoneSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ---- Get Vodafone settings for a customer ----
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/vodafone-settings",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;
      const row = await loadRow(customerId);

      if (!row || row.provider_id !== "vodafone") {
        return reply.status(404).send({ error: "Vodafone settings not found for this customer" });
      }

      const urls = vodafoneVoicebotUrlForCustomer(customerId, request);
      return reply.send({ ...row, ...urls });
    }
  );

  // ---- Create or update Vodafone settings for a customer ----
  app.put<{ Params: { customerId: string } }>(
    "/customers/:customerId/vodafone-settings",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;
      const body = upsertVodafoneSettingsSchema.safeParse(request.body ?? {});

      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customer = await pool.query("SELECT id FROM customers WHERE id = $1", [customerId]);
      if (customer.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }

      const existing = await loadRow(customerId);
      const previousProviderId: string | null = existing?.provider_id ?? null;

      const d = body.data;
      const credentialsEnc = d.credentials ? encrypt(JSON.stringify(d.credentials)) : null;

      const result = await pool.query(
        `INSERT INTO company_telephony_settings (
           customer_id, provider_id, credentials_enc, is_enabled, use_sandbox, metadata
         ) VALUES (
           $1, 'vodafone', $2,
           COALESCE($3, FALSE),
           COALESCE($4, FALSE),
           COALESCE($5::jsonb, '{}'::jsonb)
         )
         ON CONFLICT (customer_id) DO UPDATE SET
           provider_id = 'vodafone',
           credentials_enc = COALESCE($2, company_telephony_settings.credentials_enc),
           is_enabled = COALESCE($3, company_telephony_settings.is_enabled),
           use_sandbox = COALESCE($4, company_telephony_settings.use_sandbox),
           metadata = COALESCE($5::jsonb, company_telephony_settings.metadata),
           updated_at = NOW()
         RETURNING id, customer_id, provider_id, is_enabled, use_sandbox, metadata,
                   (credentials_enc IS NOT NULL) AS has_credentials,
                   created_at, updated_at`,
        [
          customerId,
          credentialsEnc,
          d.is_enabled ?? null,
          d.use_sandbox ?? null,
          d.metadata ? JSON.stringify(d.metadata) : null,
        ]
      );

      invalidateTelephonySettingsCache(customerId);

      const row = result.rows[0];
      const urls = vodafoneVoicebotUrlForCustomer(customerId, request);
      return reply.send({
        ...row,
        ...urls,
        ...(previousProviderId && previousProviderId !== "vodafone"
          ? { switched_from_provider_id: previousProviderId }
          : {}),
      });
    }
  );

  // ---- Delete Vodafone settings for a customer ----
  app.delete<{ Params: { customerId: string } }>(
    "/customers/:customerId/vodafone-settings",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;

      const result = await pool.query(
        `DELETE FROM company_telephony_settings WHERE customer_id = $1 AND provider_id = 'vodafone' RETURNING id`,
        [customerId]
      );

      invalidateTelephonySettingsCache(customerId);

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "No Vodafone settings found" });
      }

      return reply.send({ deleted: true, id: result.rows[0].id });
    }
  );
}
