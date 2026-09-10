-- ============================================================
-- Migration 011 — Roadmap P0 fixes + additive schema for Features 1/3/4 and §5.6
-- Run in pgAdmin against your Convixx database (or via
-- apps/api/scripts/run-sql-file.ts, same as migration 010).
-- Prerequisites: infra/postgres/init.sql, 001-010 already applied.
--
-- What this does (see docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md):
--   1. P0-7: HNSW index on kb_entries.embedding (matches the `<=>` cosine
--      operator actually used by ask.ts and exotel-voicebot.ts).
--   2. §5.5: customer_settings.out_of_scope_distance_threshold — makes
--      ask.ts's hardcoded 0.8 "definitely out of scope" cutoff tenant-tunable.
--      Nullable; NULL preserves today's exact behavior.
--   3. P0-1: flips stt/tts/rag_streaming_enabled defaults to TRUE for future
--      customer_settings rows, and backfills the one existing gap (see below).
--   4. Additive-only schema for Feature 1 (agent-level TTS provider),
--      §5.6 (per-agent KB scoping), Feature 3 (multi-number), and Feature 4
--      (tool calling) — none of these columns/tables are read by any
--      existing route/service yet, so this cannot change current behavior.
--      Runtime logic for these features is intentionally NOT part of this
--      migration or this session's work.
-- ============================================================

-- ============================================================
-- 1. P0-7 — HNSW index for cosine-distance KB retrieval
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_kb_entries_embedding_hnsw
  ON kb_entries USING hnsw (embedding vector_cosine_ops);

-- ============================================================
-- 2. §5.5 — tenant-tunable out-of-scope distance threshold
-- ============================================================
ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS out_of_scope_distance_threshold NUMERIC(4,3);

COMMENT ON COLUMN customer_settings.out_of_scope_distance_threshold IS
  'Overrides ask.ts''s hardcoded 0.8 "definitely out of scope" cosine-distance cutoff. NULL = use 0.8 (unchanged default behavior).';

-- ============================================================
-- 3. P0-1 — streaming flag defaults (future rows) + narrow backfill
-- ============================================================
ALTER TABLE customer_settings ALTER COLUMN stt_streaming_enabled SET DEFAULT TRUE;
ALTER TABLE customer_settings ALTER COLUMN tts_streaming_enabled SET DEFAULT TRUE;
ALTER TABLE customer_settings ALTER COLUMN rag_streaming_enabled SET DEFAULT TRUE;

-- Backfill: only flips flags that are currently FALSE for tenants who already
-- have Exotel configured (customer_exotel_settings row exists). Confirmed
-- (2026-09-09) this only affects one existing customer's stt_streaming_enabled,
-- and is a no-op there today since stt_streaming_enabled is only consumed
-- when stt_provider='cartesia' (exotel-voicebot.ts:455,570) and that
-- customer's stt_provider is 'elevenlabs'.
UPDATE customer_settings cs
SET stt_streaming_enabled = TRUE
FROM customer_exotel_settings ces
WHERE cs.customer_id = ces.customer_id
  AND cs.stt_streaming_enabled = FALSE;

UPDATE customer_settings cs
SET tts_streaming_enabled = TRUE
FROM customer_exotel_settings ces
WHERE cs.customer_id = ces.customer_id
  AND cs.tts_streaming_enabled = FALSE;

UPDATE customer_settings cs
SET rag_streaming_enabled = TRUE
FROM customer_exotel_settings ces
WHERE cs.customer_id = ces.customer_id
  AND cs.rag_streaming_enabled = FALSE;

-- ============================================================
-- 4a. Feature 1 (§8.1) — agent-level TTS provider, nullable = inherit company default
-- ============================================================
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS tts_provider TEXT
    CHECK (tts_provider IN ('sarvam','elevenlabs','cartesia'));

-- ============================================================
-- 4b. §5.6 — per-agent KB scoping, nullable = shared/company-wide (prerequisite for Feature 2)
-- ============================================================
ALTER TABLE kb_entries
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kb_entries_agent
  ON kb_entries (agent_id)
  WHERE agent_id IS NOT NULL;

-- ============================================================
-- 4c. Feature 3 (§8.3) — one company, many phone numbers
-- ============================================================
CREATE TABLE IF NOT EXISTS company_phone_numbers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  phone_number      TEXT UNIQUE NOT NULL,
  label             TEXT,
  default_agent_id  UUID REFERENCES agents(id) ON DELETE SET NULL,
  is_primary        BOOLEAN NOT NULL DEFAULT FALSE,
  is_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_phone_numbers_customer
  ON company_phone_numbers (customer_id);

-- Only ONE primary number per customer
CREATE UNIQUE INDEX IF NOT EXISTS uniq_primary_phone_number_per_customer
  ON company_phone_numbers (customer_id)
  WHERE is_primary = TRUE;

COMMENT ON TABLE company_phone_numbers IS
  'One row per DID a company owns. Backfilled from customer_exotel_settings.inbound_phone_number for existing tenants (is_primary=TRUE). Not read by any live route yet — routing logic is deferred.';

-- Backfill one row per existing customer_exotel_settings.inbound_phone_number
INSERT INTO company_phone_numbers (customer_id, phone_number, is_primary, is_enabled)
SELECT ces.customer_id, ces.inbound_phone_number, TRUE, ces.is_enabled
FROM customer_exotel_settings ces
WHERE ces.inbound_phone_number IS NOT NULL
  AND ces.inbound_phone_number <> ''
ON CONFLICT (phone_number) DO NOTHING;

-- Now that company_phone_numbers exists, apply the guarded provider_override_id
-- addition from migration 010 (which skipped it since this table didn't exist yet).
ALTER TABLE company_phone_numbers
  ADD COLUMN IF NOT EXISTS provider_override_id TEXT REFERENCES telephony_providers(id);

-- ============================================================
-- 4d. Feature 4 (§8.4) — tool calling via three CRM source types
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_tools (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_name     TEXT NOT NULL,
  source_type   TEXT NOT NULL CHECK (source_type IN ('native_crm','oauth_crm','customer_curl')),
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_agent_tool_name UNIQUE (agent_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools (agent_id);

CREATE TABLE IF NOT EXISTS crm_oauth_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  agent_id          UUID REFERENCES agents(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('zoho','salesforce')),
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  expires_at        TIMESTAMPTZ,
  scope             TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_oauth_connections_customer ON crm_oauth_connections (customer_id);

CREATE TABLE IF NOT EXISTS customer_crm_tools (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_name         TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  http_method       TEXT NOT NULL DEFAULT 'GET',
  url_template      TEXT NOT NULL,
  headers_template  JSONB NOT NULL DEFAULT '{}'::jsonb,
  param_schema      JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_mapping  JSONB NOT NULL DEFAULT '{}'::jsonb,
  timeout_ms        INTEGER NOT NULL DEFAULT 2500,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_customer_crm_tool_name UNIQUE (agent_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_customer_crm_tools_agent ON customer_crm_tools (agent_id);

COMMENT ON TABLE agent_tools IS 'Tool registry per agent for LLM tool-calling (Feature 4). Not wired into the live call pipeline yet.';
COMMENT ON TABLE crm_oauth_connections IS 'Zoho/Salesforce OAuth tokens, AES-256-GCM encrypted via services/crypto.ts. Not wired into the live call pipeline yet.';
COMMENT ON TABLE customer_crm_tools IS 'Generic customer-configured HTTP/cURL tools (Feature 4 Type 3). Not wired into the live call pipeline yet.';
