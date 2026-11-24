-- ============================================================
-- Migration 028 — data the SaaS asked for on 2026-11-24
-- (docs/SAAS_REPLY_2026-11-24.md). Run via apps/api/scripts/run-sql-file.ts.
--
-- Additive only, safe on the live database:
--   - new nullable columns with no default (no table rewrite);
--   - new tables, with no foreign keys onto busy tables (no extra locks);
--   - lock_timeout: if a table is busy, this migration fails fast instead of
--     queueing behind a long query (and making live queries queue behind it).
--     Just run it again.
--
-- Columns:
--   outbound_campaign_leads.variables  per-lead {{placeholders}} for the campaign script (A9)
--   agents.llm_temperature / llm_max_tokens  per-agent answer settings, NULL = as today (B1)
--   company_phone_numbers.number_type  'did' | 'virtual' | NULL (B4)
--   kb_entries.source  'manual' | 'json_upload' | 'csv_upload' | 'api' | NULL (B5)
-- Tables:
--   kb_entries_archived     archived KB entries, outside kb_entries so answers never see them (B5)
--   api_request_log         one row per request made with a customer API key, 30 days (C1)
--   call_insights           post-call disposition / sentiment / voicemail / markers (A4-A7)
--   call_insight_settings   per-customer switches for the post-call job (A4-A7)
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE outbound_campaign_leads ADD COLUMN IF NOT EXISTS variables JSONB;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_temperature NUMERIC(3, 2);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS llm_max_tokens INTEGER;

ALTER TABLE company_phone_numbers ADD COLUMN IF NOT EXISTS number_type TEXT;

ALTER TABLE kb_entries ADD COLUMN IF NOT EXISTS source TEXT;

RESET lock_timeout;

-- Archived KB entries: moved here (with their translations) by
-- PATCH /kb/entries/:id {"archived": true}, moved back by {"archived": false}.
-- Same ids, so an archived entry keeps its id. Retrieval only reads
-- kb_entries, so archiving adds nothing to /ask.
CREATE TABLE IF NOT EXISTS kb_entries_archived (
  id                   UUID PRIMARY KEY,
  customer_id          UUID NOT NULL,
  question             TEXT NOT NULL,
  answer               TEXT NOT NULL,
  embedding            vector,
  agent_id             UUID,
  source_language_code TEXT,
  source               TEXT,
  created_at           TIMESTAMP,
  archived_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  translations         JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_kb_entries_archived_customer ON kb_entries_archived (customer_id, archived_at DESC);

-- Requests made with a customer API key (no bodies, no headers, no query
-- strings). Written in batches by the engine, outside the request.
CREATE TABLE IF NOT EXISTS api_request_log (
  id          BIGSERIAL PRIMARY KEY,
  customer_id UUID NOT NULL,
  api_key_id  UUID NOT NULL,
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,
  status      INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_request_log_key ON api_request_log (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_request_log_customer ON api_request_log (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_request_log_created ON api_request_log (created_at);

-- Post-call analysis, one row per call session (exotel_call_sessions.id),
-- written by the call-insights worker after the call has ended.
CREATE TABLE IF NOT EXISTS call_insights (
  call_session_id        UUID PRIMARY KEY,
  customer_id            UUID NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('done', 'error')),
  disposition            TEXT CHECK (disposition IN ('interested', 'not_interested', 'callback', 'qualified', 'converted', 'voicemail', 'wrong_number', 'no_conversation')),
  disposition_confidence NUMERIC(3, 2),
  sentiment              TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  sentiment_score        NUMERIC(3, 2),
  is_voicemail           BOOLEAN,
  markers                JSONB,
  model                  TEXT,
  prompt_tokens          INTEGER,
  completion_tokens      INTEGER,
  cost_usd               NUMERIC(12, 6),
  error                  TEXT,
  attempts               INTEGER NOT NULL DEFAULT 1,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_insights_customer ON call_insights (customer_id, created_at DESC);

-- Per-customer switches. No row = analysis on, markers off.
CREATE TABLE IF NOT EXISTS call_insight_settings (
  customer_id     UUID PRIMARY KEY,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  markers_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
