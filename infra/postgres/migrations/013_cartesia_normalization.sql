-- ============================================================
-- Migration 013 - Cartesia text normalization control
-- Run in pgAdmin against your Convixx database (or via
-- apps/api/scripts/run-sql-file.ts, same as prior migrations).
-- Prerequisites: infra/postgres/init.sql, 001-012 already applied.
--
-- What this does: adds customer_settings.cartesia_normalization, a
-- free-text override for Cartesia's `normalization` TTS request field
-- (docs.cartesia.ai/build-with-cartesia/capability-guides/advanced-capabilities).
-- NULL (the default) preserves today's exact behavior - Cartesia's own
-- "auto" locale-aware normalizer runs, unchanged. Setting it to a locale
-- code (e.g. "en-IN") pins number/date reading conventions independently
-- of the spoken `language`/voice - e.g. a Hindi voice reading digits the
-- English way ("four eight two one" instead of a Hindi number word),
-- which is the common case for order numbers, OTPs, and phone numbers
-- read back mid-call. Setting it to "off" disables normalization entirely.
-- Requires Cartesia model sonic-3.6 or later (also added to
-- services/cartesia.ts's CARTESIA_MODELS in this change) - confirmed
-- against the real Cartesia API on 2026-09-10, and confirmed listed on
-- Cartesia's Free tier pricing page (same model across all tiers).
-- ============================================================

ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS cartesia_normalization TEXT;

COMMENT ON COLUMN customer_settings.cartesia_normalization IS
  'Cartesia TTS `normalization` override (e.g. "en-IN", "off"). NULL = Cartesia''s own "auto" locale-aware default, unchanged behavior. Requires sonic-3.6+.';
