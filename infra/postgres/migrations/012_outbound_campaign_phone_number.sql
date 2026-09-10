-- ============================================================
-- Migration 012 — link outbound_campaigns to company_phone_numbers
-- Run via apps/api/scripts/run-sql-file.ts (same pattern as 010/011).
-- Prerequisites: 011_roadmap_p0_and_schema.sql (creates company_phone_numbers).
--
-- Additive only: nullable FK, existing campaigns are unaffected and keep
-- resolving caller ID exactly as they do today (default_outbound_caller_id
-- || inbound_phone_number) until a campaign explicitly picks a number.
-- See docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.3.
-- ============================================================

ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS phone_number_id UUID REFERENCES company_phone_numbers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_phone_number
  ON outbound_campaigns (phone_number_id)
  WHERE phone_number_id IS NOT NULL;

COMMENT ON COLUMN outbound_campaigns.phone_number_id IS
  'Optional: which of the company''s numbers (company_phone_numbers) to use as caller ID for this campaign. NULL = fall back to customer_exotel_settings.default_outbound_caller_id || inbound_phone_number.';
