-- ============================================================
-- Migration 018 — Vodafone (VI) OBD Campaign support
-- Run via apps/api/scripts/run-sql-file.ts (same pattern as 010/011/012).
--
-- Generalizes outbound_campaigns/outbound_campaign_leads (built Exotel-only,
-- see docs/outbound_campaign_process_plan.md) to also support VI's "OBD
-- Campaign API With Flow" (docs: Outbound Campaign.html, shared 2026-10-14).
-- VI dials the base in bulk on its own side via a pre-built portal Flow
-- (which already contains the Streaming node pointing at our existing
-- /telephony/vodafone/voicebot/:customerId endpoint) — there is no per-lead
-- REST call equivalent to Exotel's Calls/connect, so the new columns track
-- VI's own campaign-level identifiers rather than a call_sid per lead at
-- trigger time.
--
-- Additive only: nullable/defaulted columns, existing Exotel campaigns are
-- unaffected and keep telephony_provider_id = 'exotel'.
-- ============================================================

ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS telephony_provider_id TEXT NOT NULL DEFAULT 'exotel'
    CHECK (telephony_provider_id IN ('exotel', 'vodafone'));

-- VI portal Flow id (encrypted/opaque string VI issues from its Flow builder UI).
-- Required for 'vodafone' campaigns, unused for 'exotel'. The Flow must already
-- contain a Streaming node bound to this tenant's Vodafone WS endpoint — see
-- services/vodafone-obd.ts header comment.
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS vi_flow_id TEXT;

-- VI's own campaign identifiers, returned by POST .../obdcampaignapi/createCampaign.
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS vi_campaign_id TEXT;
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS vi_campaign_ref_id BIGINT;

-- Cached result of POST .../obdcampaignapi/getsampleBaseHeads for vi_flow_id —
-- the per-lead variable names the Flow's base schema actually expects (e.g.
-- ["msisdn","call_type","campaign_id"]), fetched once at campaign-create time
-- so the lead-upload step can key each JSON record correctly without
-- re-deriving/guessing the names on every call.
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS vi_base_variable_names TEXT[];

CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_vi_campaign_id
  ON outbound_campaigns (vi_campaign_id)
  WHERE vi_campaign_id IS NOT NULL;

COMMENT ON COLUMN outbound_campaigns.telephony_provider_id IS
  'Which carrier this campaign runs on: exotel (per-lead Calls/connect, existing flow) or vodafone (VI OBD Campaign API With Flow, bulk-dialed by VI).';
COMMENT ON COLUMN outbound_campaigns.vi_flow_id IS
  'VI portal Flow id for vodafone campaigns. The Flow must contain a Streaming node already bound to this tenant''s Vodafone WS endpoint (configured manually in VI''s portal, not by this codebase).';
COMMENT ON COLUMN outbound_campaigns.vi_campaign_id IS
  'VI-issued encrypted campaign key (createCampaign response "campainKey"). Used for all subsequent OBD API calls (base load, start/stop, status).';
COMMENT ON COLUMN outbound_campaigns.vi_campaign_ref_id IS
  'VI-issued numeric campaign_Ref_ID (createCampaign response), for display/reporting only.';

-- Per-lead VI call id. Unlike Exotel (callSid returned synchronously from
-- Calls/connect), VI's With-Flow campaigns dial the whole base asynchronously
-- on VI's side, so this is nullable and only ever backfilled later from
-- Pullreport (calltype=2) reconciliation if/when that's built — never set at
-- trigger time.
ALTER TABLE outbound_campaign_leads
  ADD COLUMN IF NOT EXISTS vi_call_id TEXT;
