// ============================================================
// Customer Settings DAO — one row per customer in `customer_settings`.
//
// Source of truth for every tenant-level runtime tunable defined in
// docs/SETTINGS_AND_FEATURES_CATALOG.md. One primary-key lookup per
// call + a short in-memory cache keep the hot voice path fast.
// ============================================================

import { pool } from "../config/db";

// ---------- Types ----------

export type EchoCancelLevel = "off" | "soft" | "aggressive";
export type BargeInMode = "immediate" | "finish_then_answer" | "finish_turn";
export type TtsProvider = "sarvam" | "elevenlabs";
export type SttProvider = "sarvam" | "elevenlabs";
export type TtsCodec = "wav" | "mp3";

export interface CustomerSettings {
  customer_id: string;

  // A. Voicebot runtime
  voicebot_enabled: boolean;
  voicebot_multilingual: boolean;
  default_language_code: string;
  allowed_language_codes: string[];

  // B. STT
  stt_provider: SttProvider;
  stt_model: string;
  stt_streaming_enabled: boolean;

  // C. TTS
  tts_provider: TtsProvider;
  tts_model: string;
  tts_default_speaker: string | null;
  tts_default_pace: number | null;
  tts_default_pitch: number | null;
  tts_default_loudness: number | null;
  tts_default_sample_rate: number;
  tts_output_codec: TtsCodec;
  tts_streaming_enabled: boolean;

  // D. RAG / LLM
  rag_use_openai_only: boolean;
  rag_top_k: number;
  rag_use_history: boolean;
  rag_history_max_turns: number | null;
  rag_distance_threshold: number | null;
  rag_streaming_enabled: boolean;
  llm_model_override: string | null;
  llm_max_tokens: number;
  llm_temperature: number;
  llm_top_p: number | null;
  llm_verification_enabled: boolean;
  llm_verification_threshold: number;
  llm_fallback_to_openai: boolean;
  openai_model: string;
  no_kb_fallback_instruction: string | null;

  // E. VAD / audio handling
  vad_silence_timeout_ms: number;
  vad_energy_threshold: number;
  vad_min_speech_ms: number;
  max_utterance_buffer_bytes: number;
  max_utterance_seconds: number | null;
  echo_cancel_level: EchoCancelLevel;

  // F. Barge-in
  barge_in_enabled: boolean;
  barge_in_mode: BargeInMode;
  barge_in_min_speech_ms: number;
  barge_in_energy_threshold: number;

  // G. Mid-call language switch
  allow_language_switch: boolean;
  language_switch_trigger_keywords: string[];
  language_switch_confirm_prompt: string;
  language_switch_options_prompt: string;
  language_switch_yes_words: string[];
  language_switch_no_words: string[];
  language_switch_timeout_ms: number;
  language_switch_max_attempts: number;

  // H. Stop words
  stop_words: string[];

  // I. IVR
  ivr_enabled: boolean;
  ivr_welcome_menu_id: string | null;
  ivr_input_timeout_ms: number;
  ivr_max_retries: number;
  ivr_speech_input_enabled: boolean;
  ivr_fallback_to_agent: boolean;

  // J. Call lifecycle
  max_call_duration_seconds: number | null;
  max_concurrent_calls: number;
  call_transcript_enabled: boolean;
  end_call_keywords: string[];
  end_call_silence_timeout_sec: number;
  handoff_to_human_enabled: boolean;
  human_agent_transfer_number: string | null;
  business_hours: Record<string, unknown>;
  holiday_calendar: unknown[];

  // K. Outbound
  outbound_enabled: boolean;

  // L. Webhooks & notifications
  webhook_url_call_start: string | null;
  webhook_url_call_end: string | null;
  webhook_url_transcript: string | null;
  webhook_url_ivr_event: string | null;
  webhook_url_language_event: string | null;
  webhook_secret: string | null;
  webhook_retry_attempts: number;
  email_notify_call_end: boolean;
  email_recipients: string[];
  slack_webhook_url: string | null;

  created_at: Date;
  updated_at: Date;
}

export type CustomerSettingsPatch = Partial<
  Omit<CustomerSettings, "customer_id" | "created_at" | "updated_at">
>;

// ---------- Scope tables ----------
//
// Kept here (not in the DB) so Swagger, Zod, and API routes all agree.
// See docs/SETTINGS_AND_FEATURES_CATALOG.md "Scope" column.

export const ADMIN_ONLY_FIELDS = new Set<keyof CustomerSettingsPatch>([
  "voicebot_enabled",
  "stt_model",
  "tts_model",
  "tts_default_sample_rate",
  "tts_output_codec",
  "llm_model_override",
  "openai_model",
  "vad_silence_timeout_ms",
  "vad_energy_threshold",
  "vad_min_speech_ms",
  "max_utterance_buffer_bytes",
  "max_utterance_seconds",
  "echo_cancel_level",
  "barge_in_min_speech_ms",
  "barge_in_energy_threshold",
  "language_switch_timeout_ms",
  "language_switch_max_attempts",
  "max_call_duration_seconds",
  "max_concurrent_calls",
  "end_call_silence_timeout_sec",
  "outbound_enabled",
  "webhook_secret",
  "webhook_retry_attempts",
]);

/**
 * All persisted columns, in a fixed order. Used by the PATCH
 * builder so we never push an arbitrary/unknown key into SQL.
 */
export const ALL_SETTINGS_FIELDS: ReadonlyArray<keyof CustomerSettingsPatch> = [
  // A
  "voicebot_enabled",
  "voicebot_multilingual",
  "default_language_code",
  "allowed_language_codes",
  // B
  "stt_provider",
  "stt_model",
  "stt_streaming_enabled",
  // C
  "tts_provider",
  "tts_model",
  "tts_default_speaker",
  "tts_default_pace",
  "tts_default_pitch",
  "tts_default_loudness",
  "tts_default_sample_rate",
  "tts_output_codec",
  "tts_streaming_enabled",
  // D
  "rag_use_openai_only",
  "rag_top_k",
  "rag_use_history",
  "rag_history_max_turns",
  "rag_distance_threshold",
  "rag_streaming_enabled",
  "llm_model_override",
  "llm_max_tokens",
  "llm_temperature",
  "llm_top_p",
  "llm_verification_enabled",
  "llm_verification_threshold",
  "llm_fallback_to_openai",
  "openai_model",
  "no_kb_fallback_instruction",
  // E
  "vad_silence_timeout_ms",
  "vad_energy_threshold",
  "vad_min_speech_ms",
  "max_utterance_buffer_bytes",
  "max_utterance_seconds",
  "echo_cancel_level",
  // F
  "barge_in_enabled",
  "barge_in_mode",
  "barge_in_min_speech_ms",
  "barge_in_energy_threshold",
  // G
  "allow_language_switch",
  "language_switch_trigger_keywords",
  "language_switch_confirm_prompt",
  "language_switch_options_prompt",
  "language_switch_yes_words",
  "language_switch_no_words",
  "language_switch_timeout_ms",
  "language_switch_max_attempts",
  // H
  "stop_words",
  // I
  "ivr_enabled",
  "ivr_welcome_menu_id",
  "ivr_input_timeout_ms",
  "ivr_max_retries",
  "ivr_speech_input_enabled",
  "ivr_fallback_to_agent",
  // J
  "max_call_duration_seconds",
  "max_concurrent_calls",
  "call_transcript_enabled",
  "end_call_keywords",
  "end_call_silence_timeout_sec",
  "handoff_to_human_enabled",
  "human_agent_transfer_number",
  "business_hours",
  "holiday_calendar",
  // K
  "outbound_enabled",
  // L
  "webhook_url_call_start",
  "webhook_url_call_end",
  "webhook_url_transcript",
  "webhook_url_ivr_event",
  "webhook_url_language_event",
  "webhook_secret",
  "webhook_retry_attempts",
  "email_notify_call_end",
  "email_recipients",
  "slack_webhook_url",
];

/** JSONB columns that must be stringified before being sent to pg. */
const JSONB_FIELDS = new Set<keyof CustomerSettingsPatch>([
  "business_hours",
  "holiday_calendar",
]);

// ---------- Cache ----------

const settingsCache = new Map<
  string,
  { data: CustomerSettings; ts: number }
>();
const CACHE_TTL_MS = 60_000; // 1 minute

export function invalidateCustomerSettingsCache(customerId: string): void {
  settingsCache.delete(customerId);
}

// ---------- Read ----------

/**
 * Load the customer_settings row. Returns null if the customer does not exist.
 * The 005 migration installs a trigger so every new customer gets a row, and
 * backfills existing customers. This function also auto-creates the row as a
 * safety net for databases where the trigger has not been installed yet.
 */
export async function getCustomerSettings(
  customerId: string
): Promise<CustomerSettings | null> {
  const cached = settingsCache.get(customerId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  let row = await fetchRow(customerId);
  if (!row) {
    // Safety net: customer_settings trigger may not be applied yet.
    const upsert = await pool.query(
      `INSERT INTO customer_settings (customer_id) VALUES ($1)
       ON CONFLICT (customer_id) DO NOTHING
       RETURNING customer_id`,
      [customerId]
    );
    if (upsert.rows.length === 0) {
      // Customer itself does not exist
      const check = await pool.query(
        `SELECT 1 FROM customers WHERE id = $1`,
        [customerId]
      );
      if (check.rows.length === 0) return null;
    }
    row = await fetchRow(customerId);
    if (!row) return null;
  }

  settingsCache.set(customerId, { data: row, ts: Date.now() });
  return row;
}

async function fetchRow(customerId: string): Promise<CustomerSettings | null> {
  const result = await pool.query(
    `SELECT * FROM customer_settings WHERE customer_id = $1`,
    [customerId]
  );
  if (result.rows.length === 0) return null;
  return normalize(result.rows[0] as Record<string, unknown>);
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalize(row: Record<string, unknown>): CustomerSettings {
  // pg returns NUMERIC as string. Coerce the ones we want as numbers.
  const numericFields: (keyof CustomerSettings)[] = [
    "tts_default_pace",
    "tts_default_pitch",
    "tts_default_loudness",
    "rag_distance_threshold",
    "llm_temperature",
    "llm_top_p",
    "llm_verification_threshold",
  ];
  const out = { ...row } as Record<string, unknown>;
  for (const f of numericFields) {
    out[f] = toNumberOrNull(row[f]);
  }
  return out as unknown as CustomerSettings;
}

// ---------- Write ----------

export interface UpdateOptions {
  /** When true, any ADMIN_ONLY_FIELDS key in `patch` is rejected (returned as a violation list). */
  enforceTenantScope?: boolean;
}

export interface UpdateResult {
  settings?: CustomerSettings;
  scopeViolations?: string[];
  unknownKeys?: string[];
}

/**
 * Apply a partial update to customer_settings.
 *
 * - `enforceTenantScope: true` → any admin-only field in the patch is reported
 *   in `scopeViolations` and NOT written; the caller should return 403.
 * - Unknown keys are silently reported in `unknownKeys` (never written).
 */
export async function updateCustomerSettings(
  customerId: string,
  patch: Record<string, unknown>,
  opts: UpdateOptions = {}
): Promise<UpdateResult> {
  const allowed = new Set<string>(ALL_SETTINGS_FIELDS as readonly string[]);
  const sets: string[] = [];
  const values: unknown[] = [];
  const unknownKeys: string[] = [];
  const scopeViolations: string[] = [];

  let idx = 1;
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) {
      unknownKeys.push(key);
      continue;
    }
    if (
      opts.enforceTenantScope &&
      ADMIN_ONLY_FIELDS.has(key as keyof CustomerSettingsPatch)
    ) {
      scopeViolations.push(key);
      continue;
    }

    const raw = (patch as Record<string, unknown>)[key];
    const value = JSONB_FIELDS.has(key as keyof CustomerSettingsPatch)
      ? raw === null
        ? null
        : JSON.stringify(raw)
      : raw;
    sets.push(`${key} = $${idx++}`);
    values.push(value);
  }

  if (scopeViolations.length > 0) {
    return { scopeViolations, unknownKeys };
  }

  if (sets.length === 0) {
    // Nothing to update — return current row
    const current = await getCustomerSettings(customerId);
    return current
      ? { settings: current, unknownKeys }
      : { unknownKeys };
  }

  // Ensure row exists (idempotent)
  await pool.query(
    `INSERT INTO customer_settings (customer_id) VALUES ($1)
     ON CONFLICT (customer_id) DO NOTHING`,
    [customerId]
  );

  values.push(customerId);
  const sql = `UPDATE customer_settings
               SET ${sets.join(", ")}
               WHERE customer_id = $${idx}
               RETURNING *`;
  const result = await pool.query(sql, values);
  if (result.rows.length === 0) {
    return { unknownKeys };
  }
  const settings = normalize(result.rows[0] as Record<string, unknown>);

  // Keep legacy `customers.rag_use_openai_only` in sync so anything still
  // reading it (auth middleware BC path) sees the same value.
  if (
    Object.prototype.hasOwnProperty.call(patch, "rag_use_openai_only") &&
    typeof patch.rag_use_openai_only === "boolean"
  ) {
    await pool
      .query(
        `UPDATE customers SET rag_use_openai_only = $1 WHERE id = $2`,
        [patch.rag_use_openai_only, customerId]
      )
      .catch(() => {});
  }

  invalidateCustomerSettingsCache(customerId);
  return { settings, unknownKeys };
}
