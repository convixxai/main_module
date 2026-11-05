-- ============================================================
-- Migration 021 — per-campaign agent for outbound campaigns
-- Run via apps/api/scripts/run-sql-file.ts (same pattern as 018).
--
-- The SaaS campaign wizard lets the user pick which agent runs a campaign
-- (campaigns.agent_id on the SaaS side), but the engine had nowhere to store
-- it, so every outbound call fell back to the dialed number's default agent
-- or the oldest active agent. The Vodafone WS handler (and Exotel campaign
-- calls) now prefer this column when a call is campaign-linked.
--
-- Additive only: nullable, ON DELETE SET NULL so removing an agent never
-- breaks a campaign (calls just fall back to the number/default agent).
-- ============================================================

ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

COMMENT ON COLUMN outbound_campaigns.agent_id IS
  'Agent that handles this campaign''s calls (system prompt, KB, voice). NULL = the caller number''s default agent, else the oldest active agent.';
