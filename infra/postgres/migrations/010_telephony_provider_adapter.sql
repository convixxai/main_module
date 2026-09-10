-- ============================================================
-- Migration 010 — Telephony Provider Adapter (multi-carrier: Exotel + Vodafone)
-- Run in pgAdmin against your Convixx database.
-- Prerequisites: infra/postgres/init.sql, 001-009 already applied.
--
-- What this does:
--   1. Creates telephony_providers (static registry: 'exotel', 'vodafone').
--   2. Creates company_telephony_settings — generalizes
--      customer_exotel_settings to support multiple carriers.
--      customer_id UNIQUE enforces "one telephony provider per company"
--      at the schema level (not just as a convention).
--   3. Backfills one company_telephony_settings row per existing
--      customer_exotel_settings row, provider_id='exotel'. Non-secret
--      columns (wss/bootstrap URLs, is_enabled, use_sandbox) are copied
--      directly here; credentials_enc is left NULL and must be populated
--      by the companion script apps/api/scripts/backfill-telephony-credentials.ts
--      (needs the Node AES-256-GCM helper in services/crypto.ts — the
--      encryption key lives in app env, not in Postgres, so this can't be
--      done in pure SQL). This is additive only — customer_exotel_settings
--      is untouched and the existing ExotelAdapter-equivalent code path
--      keeps reading it until the adapter extraction (roadmap Phase 1)
--      cuts traffic over.
--   4. Adds company_phone_numbers.provider_override_id (nullable, column
--      only, no behavior) for a future per-number carrier-migration
--      window — guarded so this migration doesn't fail if
--      company_phone_numbers (roadmap §8.3) hasn't been created yet.
--
-- Reference: docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5, §8.5.1
-- ============================================================

-- ============================================================
-- 1. telephony_providers — static registry
-- ============================================================
CREATE TABLE IF NOT EXISTS telephony_providers (
  id            TEXT PRIMARY KEY,          -- 'exotel' | 'vodafone'
  display_name  TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE telephony_providers IS
  'Static registry of supported telephony carriers. Referenced by company_telephony_settings.provider_id.';

INSERT INTO telephony_providers (id, display_name) VALUES
  ('exotel', 'Exotel'),
  ('vodafone', 'Vodafone (VI)')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 2. company_telephony_settings — ONE row per customer.
-- ============================================================
CREATE TABLE IF NOT EXISTS company_telephony_settings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  provider_id           TEXT NOT NULL REFERENCES telephony_providers(id),

  -- Provider-specific credentials, stored as a single AES-256-GCM
  -- encrypted JSON blob via services/crypto.ts (encrypt()/decrypt()),
  -- same primitive already used for chat-message content at rest.
  -- Shape is provider-specific, e.g.:
  --   Exotel:   {"account_sid":"...","app_id":"...","subdomain":"...","api_key":"...","api_token":"..."}
  --   Vodafone: {"api_key":"...", ...}  -- exact auth mechanism still TBD, see roadmap §8.5.1 open item 3
  credentials_enc       TEXT,

  wss_base_url          TEXT,
  bootstrap_https_url   TEXT,

  is_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  use_sandbox           BOOLEAN NOT NULL DEFAULT FALSE,

  -- Provider-specific extras that don't need dedicated columns.
  -- For Vodafone (roadmap §8.5.1): e.g.
  --   {"chunk_size_bytes": 1600, "streaming_mode": "foreground", "custom_parameters": {...}}
  -- (chunk size must be 1600-51200 bytes and a multiple of 160 — enforced
  -- in code by VodafoneAdapter.buildAudioFrame, not by a DB constraint,
  -- since it's a per-call framing detail, not a settings-row shape).
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_telephony_provider
  ON company_telephony_settings (provider_id);

COMMENT ON TABLE company_telephony_settings IS
  'One row per customer. Generalizes customer_exotel_settings to support multiple telephony carriers (Exotel, Vodafone/VI). customer_id UNIQUE enforces one provider per company at the schema level. See docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5.';

CREATE OR REPLACE FUNCTION touch_company_telephony_settings_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_company_telephony_settings_touch ON company_telephony_settings;
CREATE TRIGGER trg_company_telephony_settings_touch
  BEFORE UPDATE ON company_telephony_settings
  FOR EACH ROW EXECUTE FUNCTION touch_company_telephony_settings_updated_at();

-- ============================================================
-- 3. Backfill: one row per existing customer_exotel_settings row.
--    credentials_enc is intentionally left NULL here — run
--    apps/api/scripts/backfill-telephony-credentials.ts once after this
--    migration to encrypt+populate it from the plaintext Exotel columns.
-- ============================================================
INSERT INTO company_telephony_settings
  (customer_id, provider_id, wss_base_url, bootstrap_https_url, is_enabled, use_sandbox, created_at)
SELECT
  ces.customer_id,
  'exotel',
  ces.voicebot_wss_url,
  ces.voicebot_bootstrap_https_url,
  ces.is_enabled,
  ces.use_sandbox,
  ces.created_at
FROM customer_exotel_settings ces
ON CONFLICT (customer_id) DO NOTHING;

-- ============================================================
-- 4. company_phone_numbers.provider_override_id — future carrier-migration
--    window support (roadmap §8.5 / open decision §10.5). Column only;
--    no read path uses it yet. Guarded: company_phone_numbers doesn't
--    exist yet (roadmap §8.3 is a separate, not-yet-applied migration).
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'company_phone_numbers') THEN
    ALTER TABLE company_phone_numbers
      ADD COLUMN IF NOT EXISTS provider_override_id TEXT REFERENCES telephony_providers(id);
  END IF;
END $$;
