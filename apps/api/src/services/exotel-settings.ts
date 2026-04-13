// ============================================================
// Exotel Settings DAO — Multi-tenant Exotel configuration
// Tables: customer_exotel_settings, exotel_call_sessions
// Reference: docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §12
// ============================================================

import { pool } from "../config/db";

// ---------- customer_exotel_settings ----------

export interface ExotelSettings {
  id: string;
  customer_id: string;
  exotel_account_sid: string | null;
  exotel_app_id: string | null;
  exotel_subdomain: string | null;
  exotel_api_key: string | null;
  exotel_api_token: string | null;
  inbound_phone_number: string | null;
  default_outbound_caller_id: string | null;
  webhook_secret: string | null;
  voicebot_wss_url: string | null;
  voicebot_bootstrap_https_url: string | null;
  is_enabled: boolean;
  use_sandbox: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Load Exotel settings for a tenant. Returns null if not configured.
 * Uses a short in-memory cache (configurable TTL) to avoid DB hits on every
 * WebSocket connection — the same tenant may receive many concurrent calls.
 */
const settingsCache = new Map<string, { data: ExotelSettings; ts: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

export async function getExotelSettings(
  customerId: string
): Promise<ExotelSettings | null> {
  const cached = settingsCache.get(customerId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const result = await pool.query(
    `SELECT * FROM customer_exotel_settings WHERE customer_id = $1`,
    [customerId]
  );

  if (result.rows.length === 0) return null;

  const settings = result.rows[0] as ExotelSettings;
  settingsCache.set(customerId, { data: settings, ts: Date.now() });
  return settings;
}

/**
 * Look up tenant by inbound phone number.
 * Used when the URL doesn't embed customer_id but we know the called DID.
 */
export async function getExotelSettingsByNumber(
  phoneNumber: string
): Promise<ExotelSettings | null> {
  const result = await pool.query(
    `SELECT * FROM customer_exotel_settings
     WHERE inbound_phone_number = $1 AND is_enabled = TRUE`,
    [phoneNumber]
  );
  return result.rows.length > 0 ? (result.rows[0] as ExotelSettings) : null;
}

/** Invalidate cached settings for a specific customer. */
export function invalidateExotelSettingsCache(customerId: string): void {
  settingsCache.delete(customerId);
}

// ---------- exotel_call_sessions ----------

export interface ExotelCallSession {
  id: string;
  customer_id: string;
  exotel_call_sid: string | null;
  exotel_stream_sid: string | null;
  direction: "inbound" | "outbound";
  from_number: string | null;
  to_number: string | null;
  status: string | null;
  chat_session_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Insert a new call session row when a Voicebot stream starts.
 */
export async function createCallSession(params: {
  customerId: string;
  callSid: string | null;
  streamSid: string | null;
  direction: "inbound" | "outbound";
  fromNumber: string | null;
  toNumber: string | null;
  chatSessionId: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const result = await pool.query(
    `INSERT INTO exotel_call_sessions
       (customer_id, exotel_call_sid, exotel_stream_sid, direction,
        from_number, to_number, status, chat_session_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
     RETURNING id`,
    [
      params.customerId,
      params.callSid,
      params.streamSid,
      params.direction,
      params.fromNumber,
      params.toNumber,
      params.chatSessionId,
      params.metadata ? JSON.stringify(params.metadata) : null,
    ]
  );
  return result.rows[0].id;
}

/**
 * Update a call session when the stream ends.
 */
export async function endCallSession(
  sessionId: string,
  status: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const metaClause = metadata
    ? `, metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb`
    : "";
  const values: unknown[] = [status, sessionId];
  if (metadata) {
    values.push(JSON.stringify(metadata));
  }
  await pool.query(
    `UPDATE exotel_call_sessions
     SET status = $1, ended_at = NOW()${metaClause}
     WHERE id = $2`,
    metadata ? [status, sessionId, JSON.stringify(metadata)] : [status, sessionId]
  ).catch(() => {});
}

/**
 * Link a chat_session_id to an existing call session.
 */
export async function linkChatSessionToCall(
  callSessionId: string,
  chatSessionId: string
): Promise<void> {
  await pool.query(
    `UPDATE exotel_call_sessions SET chat_session_id = $1 WHERE id = $2`,
    [chatSessionId, callSessionId]
  ).catch(() => {});
}
