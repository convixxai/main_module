import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyAuth, adminAuth, AuthenticatedRequest } from "../middleware/auth";
import {
  getCustomerSettings,
  updateCustomerSettings,
  invalidateCustomerSettingsCache,
} from "../services/customer-settings";

// ---------- Schemas ----------

const bcp47 = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Invalid BCP-47 code (e.g. en-IN)");

/** All tunables are optional (this is PATCH). Types are strict per column. */
const settingsPatchSchema = z
  .object({
    // A. Voicebot runtime
    voicebot_enabled: z.boolean(),
    voicebot_multilingual: z.boolean(),
    default_language_code: bcp47,
    allowed_language_codes: z.array(bcp47).nonempty(),

    // B. STT
    stt_provider: z.enum(["sarvam", "elevenlabs"]),
    stt_model: z.string().min(1),
    stt_streaming_enabled: z.boolean(),

    // C. TTS
    tts_provider: z.enum(["sarvam", "elevenlabs"]),
    tts_model: z.string().min(1),
    tts_default_speaker: z.string().nullable(),
    tts_default_pace: z.number().min(0.5).max(2.0).nullable(),
    tts_default_pitch: z.number().nullable(),
    tts_default_loudness: z.number().nullable(),
    tts_default_sample_rate: z.number().int().positive(),
    tts_output_codec: z.enum(["wav", "mp3"]),
    tts_streaming_enabled: z.boolean(),

    // D. RAG / LLM
    rag_use_openai_only: z.boolean(),
    rag_top_k: z.number().int().positive(),
    rag_use_history: z.boolean(),
    rag_history_max_turns: z.number().int().positive().nullable(),
    rag_distance_threshold: z.number().min(0).max(2).nullable(),
    rag_streaming_enabled: z.boolean(),
    llm_model_override: z.string().nullable(),
    llm_max_tokens: z.number().int().positive(),
    llm_temperature: z.number().min(0).max(2),
    llm_top_p: z.number().min(0).max(1).nullable(),
    llm_verification_enabled: z.boolean(),
    llm_verification_threshold: z.number().min(0).max(1),
    llm_fallback_to_openai: z.boolean(),
    openai_model: z.string().min(1),
    no_kb_fallback_instruction: z.string().nullable(),

    // E. VAD / audio handling
    vad_silence_timeout_ms: z.number().int().nonnegative(),
    vad_energy_threshold: z.number().int().nonnegative(),
    vad_min_speech_ms: z.number().int().nonnegative(),
    max_utterance_buffer_bytes: z.number().int().positive(),
    max_utterance_seconds: z.number().int().positive().nullable(),
    echo_cancel_level: z.enum(["off", "soft", "aggressive"]),

    // F. Barge-in
    barge_in_enabled: z.boolean(),
    barge_in_mode: z.enum(["immediate", "finish_then_answer", "finish_turn"]),
    barge_in_min_speech_ms: z.number().int().nonnegative(),
    barge_in_energy_threshold: z.number().int().nonnegative(),

    // G. Mid-call language switch
    allow_language_switch: z.boolean(),
    language_switch_trigger_keywords: z.array(z.string()),
    language_switch_confirm_prompt: z.string(),
    language_switch_options_prompt: z.string(),
    language_switch_yes_words: z.array(z.string()),
    language_switch_no_words: z.array(z.string()),
    language_switch_timeout_ms: z.number().int().positive(),
    language_switch_max_attempts: z.number().int().positive(),

    // H. Stop words
    stop_words: z.array(z.string()),

    // I. IVR
    ivr_enabled: z.boolean(),
    ivr_welcome_menu_id: z.string().uuid().nullable(),
    ivr_input_timeout_ms: z.number().int().positive(),
    ivr_max_retries: z.number().int().nonnegative(),
    ivr_speech_input_enabled: z.boolean(),
    ivr_fallback_to_agent: z.boolean(),

    // J. Call lifecycle
    max_call_duration_seconds: z.number().int().positive().nullable(),
    max_concurrent_calls: z.number().int().positive(),
    call_transcript_enabled: z.boolean(),
    end_call_keywords: z.array(z.string()),
    end_call_silence_timeout_sec: z.number().int().positive(),
    handoff_to_human_enabled: z.boolean(),
    human_agent_transfer_number: z.string().nullable(),
    business_hours: z.record(z.string(), z.unknown()),
    holiday_calendar: z.array(z.unknown()),

    // K. Outbound
    outbound_enabled: z.boolean(),

    // L. Webhooks & notifications
    webhook_url_call_start: z.string().url().nullable(),
    webhook_url_call_end: z.string().url().nullable(),
    webhook_url_transcript: z.string().url().nullable(),
    webhook_url_ivr_event: z.string().url().nullable(),
    webhook_url_language_event: z.string().url().nullable(),
    webhook_secret: z.string().nullable(),
    webhook_retry_attempts: z.number().int().nonnegative(),
    email_notify_call_end: z.boolean(),
    email_recipients: z.array(z.string().email()),
    slack_webhook_url: z.string().url().nullable(),
  })
  .partial();

const patchRagSchema = z.object({
  rag_use_openai_only: z.boolean(),
});

// ---------- Helpers ----------

async function ensureCustomerExists(customerId: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM customers WHERE id = $1`, [
    customerId,
  ]);
  return r.rows.length > 0;
}

// ---------- Routes ----------

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // ============================================================
  // Tenant endpoints — x-api-key scoped to the authenticated customer
  // ============================================================

  /** Returns the full settings row for the caller. */
  app.get(
    "/settings",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const settings = await getCustomerSettings(customerId);
      if (!settings) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      return settings;
    }
  );

  /**
   * Partial update restricted to tenant-editable fields.
   * Admin-only fields (see ADMIN_ONLY_FIELDS in services/customer-settings.ts)
   * return 403 with a list of offending keys.
   */
  app.patch(
    "/settings",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = settingsPatchSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const result = await updateCustomerSettings(
        customerId,
        body.data as Record<string, unknown>,
        { enforceTenantScope: true }
      );

      if (result.scopeViolations && result.scopeViolations.length > 0) {
        return reply.status(403).send({
          error: "Some fields are admin-only",
          admin_only_fields: result.scopeViolations,
        });
      }

      if (!result.settings) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      return result.settings;
    }
  );

  // ---- Legacy: keep GET/PATCH /settings/rag working (now backed by customer_settings) ----

  app.get(
    "/settings/rag",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const settings = await getCustomerSettings(customerId);
      if (!settings) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      return { rag_use_openai_only: settings.rag_use_openai_only };
    }
  );

  app.patch(
    "/settings/rag",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = patchRagSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }
      const customerId = request.customerId!;
      const result = await updateCustomerSettings(
        customerId,
        { rag_use_openai_only: body.data.rag_use_openai_only },
        { enforceTenantScope: true }
      );
      if (!result.settings) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      return { rag_use_openai_only: result.settings.rag_use_openai_only };
    }
  );

  // ============================================================
  // Admin endpoints — x-admin-token, can edit any field
  // ============================================================

  app.get<{ Params: { customerId: string } }>(
    "/admin/customers/:customerId/settings",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;
      if (!(await ensureCustomerExists(customerId))) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      const settings = await getCustomerSettings(customerId);
      if (!settings) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      return settings;
    }
  );

  app.patch<{ Params: { customerId: string } }>(
    "/admin/customers/:customerId/settings",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;
      if (!(await ensureCustomerExists(customerId))) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      const body = settingsPatchSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }
      const result = await updateCustomerSettings(
        customerId,
        body.data as Record<string, unknown>,
        { enforceTenantScope: false }
      );
      if (!result.settings) {
        return reply.status(500).send({ error: "Failed to update settings" });
      }
      return result.settings;
    }
  );

  /**
   * Admin utility: reset every column to its database default by deleting
   * the row and letting the auto-create trigger insert a fresh one.
   */
  app.post<{ Params: { customerId: string } }>(
    "/admin/customers/:customerId/settings/reset",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;
      if (!(await ensureCustomerExists(customerId))) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      await pool.query(
        `DELETE FROM customer_settings WHERE customer_id = $1`,
        [customerId]
      );
      await pool.query(
        `INSERT INTO customer_settings (customer_id) VALUES ($1)
         ON CONFLICT (customer_id) DO NOTHING`,
        [customerId]
      );
      invalidateCustomerSettingsCache(customerId);
      const settings = await getCustomerSettings(customerId);
      return reply.send(settings);
    }
  );
}
