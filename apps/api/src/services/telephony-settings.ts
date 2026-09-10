// ============================================================
// Telephony Settings DAO — multi-carrier (Exotel, Vodafone, ...) configuration
// Table: company_telephony_settings (see infra/postgres/migrations/010_telephony_provider_adapter.sql)
// Generalizes services/exotel-settings.ts's ExotelSettings/getExotelSettings
// shape to any carrier. Not read by the live call path yet — see
// docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5.
// ============================================================

import { pool } from "../config/db";
import { decrypt } from "./crypto";

export interface TelephonySettings {
  id: string;
  customer_id: string;
  provider_id: string;
  credentials_enc: string | null;
  wss_base_url: string | null;
  bootstrap_https_url: string | null;
  is_enabled: boolean;
  use_sandbox: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Load telephony settings for a tenant. Returns null if not configured.
 * Same 60s in-memory cache pattern as services/exotel-settings.ts's
 * getExotelSettings — the same tenant may receive many concurrent calls.
 */
const settingsCache = new Map<string, { data: TelephonySettings; ts: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

export async function getTelephonySettings(
  customerId: string
): Promise<TelephonySettings | null> {
  const cached = settingsCache.get(customerId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const result = await pool.query(
    `SELECT * FROM company_telephony_settings WHERE customer_id = $1`,
    [customerId]
  );

  if (result.rows.length === 0) return null;

  const settings = result.rows[0] as TelephonySettings;
  settingsCache.set(customerId, { data: settings, ts: Date.now() });
  return settings;
}

export function invalidateTelephonySettingsCache(customerId: string): void {
  settingsCache.delete(customerId);
}

/**
 * Decrypt and parse a settings row's `credentials_enc` JSON blob (AES-256-GCM
 * via services/crypto.ts). Shape is provider-specific — callers know what
 * shape to expect for the provider_id they're reading (e.g. ExotelCredentials
 * below for provider_id='exotel').
 */
export function getDecryptedCredentials<T>(settings: TelephonySettings): T {
  if (!settings.credentials_enc) {
    throw new Error(
      `company_telephony_settings row for customer_id=${settings.customer_id} has no credentials_enc set`
    );
  }
  return JSON.parse(decrypt(settings.credentials_enc)) as T;
}

/** credentials_enc shape for provider_id='exotel' — matches apps/api/scripts/backfill-telephony-credentials.ts. */
export interface ExotelCredentials {
  account_sid: string | null;
  app_id: string | null;
  subdomain: string | null;
  api_key: string | null;
  api_token: string | null;
}
