-- ============================================================
-- Migration 027 — calling switch log (customer_settings.voicebot_enabled)
-- Run via apps/api/scripts/run-sql-file.ts.
--
-- One row per event, for GET /calling/logs and GET /calling/activity:
--   enabled / disabled  the calling switch changed. Written by a trigger, so
--                       every change is logged whoever made it: the engine
--                       API (PUT /settings/calling), the SaaS billing job
--                       (0 credits / top-up) or a direct database update.
--                       The writer may name itself in the same transaction:
--                         SELECT set_config('convixx.calling_source', 'api', true);
--                         SELECT set_config('convixx.calling_reason', '...', true);
--                       otherwise source = 'database'.
--   call_blocked        a call reached the engine while calling was off and
--                       was disconnected (written by the engine).
--   dial_blocked        a dial / campaign start was refused while calling
--                       was off (written by the engine).
--
-- Additive only: a new table and an AFTER UPDATE trigger that only inserts
-- into it. The trigger never blocks or changes the update itself.
-- ============================================================

CREATE TABLE IF NOT EXISTS calling_events (
  id          BIGSERIAL PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  event       TEXT NOT NULL CHECK (event IN ('enabled', 'disabled', 'call_blocked', 'dial_blocked')),
  source      TEXT,
  reason      TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calling_events_customer_created_idx
  ON calling_events (customer_id, created_at DESC);

CREATE OR REPLACE FUNCTION log_calling_switch_change() RETURNS trigger AS $$
BEGIN
  BEGIN
    INSERT INTO calling_events (customer_id, event, source, reason)
    VALUES (
      NEW.customer_id,
      CASE WHEN NEW.voicebot_enabled THEN 'enabled' ELSE 'disabled' END,
      COALESCE(NULLIF(current_setting('convixx.calling_source', true), ''), 'database'),
      NULLIF(current_setting('convixx.calling_reason', true), '')
    );
  EXCEPTION WHEN OTHERS THEN
    -- Logging must never fail the settings update.
    NULL;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_settings_calling_switch_log ON customer_settings;
CREATE TRIGGER customer_settings_calling_switch_log
  AFTER UPDATE OF voicebot_enabled ON customer_settings
  FOR EACH ROW
  WHEN (OLD.voicebot_enabled IS DISTINCT FROM NEW.voicebot_enabled)
  EXECUTE FUNCTION log_calling_switch_change();
