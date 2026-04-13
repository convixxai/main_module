-- ============================================================
-- Exotel Voicebot Multi-Tenant Tables
-- Migration 003: Additional indexes and voice-specific views
-- Run AFTER: 002_exotel_voicebot_tables.sql
-- ============================================================

-- Additional index for faster customer lookup by call_sid
CREATE INDEX IF NOT EXISTS idx_exotel_sessions_call_sid
  ON exotel_call_sessions (exotel_call_sid)
  WHERE exotel_call_sid IS NOT NULL;

-- Additional index for status filtering on recent call sessions
CREATE INDEX IF NOT EXISTS idx_exotel_sessions_status
  ON exotel_call_sessions (status)
  WHERE status IS NOT NULL;

-- Add agent_id column to exotel_call_sessions if not exists
ALTER TABLE exotel_call_sessions
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

-- ============================================================
-- View: Active and recent call sessions with customer name
-- ============================================================
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
