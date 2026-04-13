# Exotel Voicebot — PostgreSQL Database Setup

> **Run these queries in order** on your Convixx PostgreSQL database (`convixx_kb`).
> All statements use `IF NOT EXISTS` / `IF NOT EXISTS` so they are safe to re-run.

---

## Prerequisites

The following tables must already exist (from `infra/postgres/init.sql`):

- `customers`
- `chat_sessions`
- `agents`

---

## Step 1 — Create `customer_exotel_settings` table

Stores per-tenant Exotel credentials, phone numbers, and Voicebot WebSocket URLs.

```sql
CREATE TABLE IF NOT EXISTS customer_exotel_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,

  -- Exotel account details
  exotel_account_sid TEXT,
  exotel_app_id TEXT,
  exotel_subdomain TEXT,

  -- Exotel API credentials (kept secret, never returned in API GET responses)
  exotel_api_key TEXT,
  exotel_api_token TEXT,

  -- Phone numbers
  inbound_phone_number TEXT,
  default_outbound_caller_id TEXT,

  -- Webhook/WSS authentication secret
  webhook_secret TEXT,

  -- Voicebot endpoint URLs
  voicebot_wss_url TEXT,
  voicebot_bootstrap_https_url TEXT,

  -- Feature flags
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  use_sandbox BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

## Step 2 — Create index on `inbound_phone_number`

For DID-based tenant lookup (when a call comes in on a specific number).

```sql
CREATE INDEX IF NOT EXISTS idx_exotel_inbound_number
  ON customer_exotel_settings (inbound_phone_number)
  WHERE inbound_phone_number IS NOT NULL;
```

---

## Step 3 — Add table comment

```sql
COMMENT ON TABLE customer_exotel_settings IS
  'Per-tenant Exotel credentials, numbers, and Voicebot WSS URLs';
```

---

## Step 4 — Safe ALTER (if table existed before without Voicebot columns)

```sql
ALTER TABLE customer_exotel_settings
  ADD COLUMN IF NOT EXISTS voicebot_wss_url TEXT;

ALTER TABLE customer_exotel_settings
  ADD COLUMN IF NOT EXISTS voicebot_bootstrap_https_url TEXT;
```

---

## Step 5 — Create `exotel_call_sessions` table

One row per call/stream lifecycle. Tracks every Voicebot call with caller info, status, and optional link to a `chat_sessions` row.

```sql
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
```

---

## Step 6 — Indexes on `exotel_call_sessions`

```sql
-- Customer + time-based lookup (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_exotel_sessions_customer
  ON exotel_call_sessions (customer_id, started_at DESC);

-- Stream SID lookup (for real-time session matching)
CREATE INDEX IF NOT EXISTS idx_exotel_sessions_stream
  ON exotel_call_sessions (exotel_stream_sid)
  WHERE exotel_stream_sid IS NOT NULL;

-- Call SID lookup
CREATE INDEX IF NOT EXISTS idx_exotel_sessions_call_sid
  ON exotel_call_sessions (exotel_call_sid)
  WHERE exotel_call_sid IS NOT NULL;

-- Status filtering
CREATE INDEX IF NOT EXISTS idx_exotel_sessions_status
  ON exotel_call_sessions (status)
  WHERE status IS NOT NULL;
```

---

## Step 7 — Add `agent_id` column to `exotel_call_sessions`

Links each call to the agent that handled it.

```sql
ALTER TABLE exotel_call_sessions
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
```

---

## Step 8 — Create `exotel_wss_bootstrap_tokens` table (optional)

For signed HTTPS→WSS bootstrap tokens. Only needed if you use token-based WebSocket authentication.

```sql
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
```

---

## Step 9 — Create summary view

A convenient view that joins call sessions with customer names and calculates call duration.

```sql
CREATE OR REPLACE VIEW v_exotel_call_summary AS
SELECT
  ecs.id,
  ecs.customer_id,
  c.name AS customer_name,
  ecs.exotel_call_sid,
  ecs.exotel_stream_sid,
  ecs.direction,
  ecs.from_number,
  ecs.to_number,
  ecs.status,
  ecs.chat_session_id,
  ecs.agent_id,
  ecs.started_at,
  ecs.ended_at,
  EXTRACT(EPOCH FROM (COALESCE(ecs.ended_at, NOW()) - ecs.started_at)) AS duration_seconds,
  ecs.metadata
FROM exotel_call_sessions ecs
JOIN customers c ON c.id = ecs.customer_id
ORDER BY ecs.started_at DESC;

COMMENT ON VIEW v_exotel_call_summary IS
  'Denormalized view of Exotel call sessions with customer names and duration.';
```

---

## Quick Copy — Run All at Once

If you want to run everything in one go, copy-paste this entire block:

```sql
-- ============================================================
-- EXOTEL VOICEBOT — FULL DATABASE SETUP
-- Safe to re-run (uses IF NOT EXISTS everywhere)
-- ============================================================

-- 1. customer_exotel_settings
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

COMMENT ON TABLE customer_exotel_settings IS
  'Per-tenant Exotel credentials, numbers, and Voicebot WSS URLs';

ALTER TABLE customer_exotel_settings
  ADD COLUMN IF NOT EXISTS voicebot_wss_url TEXT;
ALTER TABLE customer_exotel_settings
  ADD COLUMN IF NOT EXISTS voicebot_bootstrap_https_url TEXT;

-- 2. exotel_call_sessions
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
CREATE INDEX IF NOT EXISTS idx_exotel_sessions_call_sid
  ON exotel_call_sessions (exotel_call_sid)
  WHERE exotel_call_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exotel_sessions_status
  ON exotel_call_sessions (status)
  WHERE status IS NOT NULL;

ALTER TABLE exotel_call_sessions
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

-- 3. exotel_wss_bootstrap_tokens (optional)
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

-- 4. Summary view
CREATE OR REPLACE VIEW v_exotel_call_summary AS
SELECT
  ecs.id,
  ecs.customer_id,
  c.name AS customer_name,
  ecs.exotel_call_sid,
  ecs.exotel_stream_sid,
  ecs.direction,
  ecs.from_number,
  ecs.to_number,
  ecs.status,
  ecs.chat_session_id,
  ecs.agent_id,
  ecs.started_at,
  ecs.ended_at,
  EXTRACT(EPOCH FROM (COALESCE(ecs.ended_at, NOW()) - ecs.started_at)) AS duration_seconds,
  ecs.metadata
FROM exotel_call_sessions ecs
JOIN customers c ON c.id = ecs.customer_id
ORDER BY ecs.started_at DESC;

COMMENT ON VIEW v_exotel_call_summary IS
  'Denormalized view of Exotel call sessions with customer names and duration.';

-- ✅ Done! All Exotel Voicebot tables are ready.
```

---

## Verification Queries

After running the setup, verify everything was created correctly:

```sql
-- Check all 3 tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'customer_exotel_settings',
    'exotel_call_sessions',
    'exotel_wss_bootstrap_tokens'
  );

-- Check the view exists
SELECT table_name
FROM information_schema.views
WHERE table_schema = 'public'
  AND table_name = 'v_exotel_call_summary';

-- Check columns on customer_exotel_settings
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'customer_exotel_settings'
ORDER BY ordinal_position;

-- Check columns on exotel_call_sessions (should include agent_id)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'exotel_call_sessions'
ORDER BY ordinal_position;

-- Count indexes
SELECT indexname
FROM pg_indexes
WHERE tablename IN ('customer_exotel_settings', 'exotel_call_sessions', 'exotel_wss_bootstrap_tokens')
ORDER BY tablename, indexname;
```

---

## Tables Summary

| Table | Purpose |
|-------|---------|
| `customer_exotel_settings` | Per-tenant Exotel config (SID, keys, phone numbers, WSS URL, enabled flag) |
| `exotel_call_sessions` | One row per Voicebot call — tracks caller, status, linked chat session |
| `exotel_wss_bootstrap_tokens` | (Optional) Signed tokens for HTTPS→WSS bootstrap auth |
| `v_exotel_call_summary` | View — joins call sessions with customer names + duration |
