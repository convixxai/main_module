-- Exotel Voicebot / tenant settings (see docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md)
-- Prerequisites: customers, chat_sessions tables exist (infra/postgres/init.sql).
-- Run once against your Convixx PostgreSQL database.

-- ============================================================
-- 1. Per-customer Exotel profile (all Exotel details for a tenant)
-- ============================================================
CREATE TABLE IF NOT EXISTS customer_exotel_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,

  exotel_account_sid TEXT,
  exotel_app_id TEXT,
  exotel_subdomain TEXT,

  exotel_api_key TEXT,
  exotel_api_token TEXT,

  inbound_phone_number TEXT,
  default_outbound_caller_id TEXT,

  webhook_secret TEXT,

  voicebot_wss_url TEXT,
  voicebot_bootstrap_https_url TEXT,

  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  use_sandbox BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exotel_inbound_number
  ON customer_exotel_settings (inbound_phone_number)
  WHERE inbound_phone_number IS NOT NULL;

COMMENT ON TABLE customer_exotel_settings IS 'Per-tenant Exotel credentials, numbers, and Voicebot WSS URLs';

-- If the table already existed without Voicebot columns, add them:
ALTER TABLE customer_exotel_settings
  ADD COLUMN IF NOT EXISTS voicebot_wss_url TEXT;
ALTER TABLE customer_exotel_settings
  ADD COLUMN IF NOT EXISTS voicebot_bootstrap_https_url TEXT;

-- ============================================================
-- 2. One row per call / stream lifecycle
-- ============================================================
CREATE TABLE IF NOT EXISTS exotel_call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  exotel_call_sid TEXT,
  exotel_stream_sid TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number TEXT,
  to_number TEXT,
  status TEXT,
  chat_session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_exotel_sessions_customer
  ON exotel_call_sessions (customer_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_exotel_sessions_stream
  ON exotel_call_sessions (exotel_stream_sid)
  WHERE exotel_stream_sid IS NOT NULL;

-- ============================================================
-- 3. Optional: HTTPS → WSS bootstrap tokens (opaque, store hashes)
-- ============================================================
CREATE TABLE IF NOT EXISTS exotel_wss_bootstrap_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exotel_bootstrap_expires
  ON exotel_wss_bootstrap_tokens (expires_at)
  WHERE used_at IS NULL;
