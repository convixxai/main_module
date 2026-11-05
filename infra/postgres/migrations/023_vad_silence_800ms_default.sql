-- ============================================================
-- Migration 023 — 800ms end-of-speech silence for everyone
-- Run via apps/api/scripts/run-sql-file.ts.
--
-- Product decision 2026-11-05: callers waited 1500ms of pure silence-detection
-- before the bot even started working on a reply. Default is now 800ms (same
-- as the code fallbacks in exotel-voicebot.ts / vodafone-voicebot.ts).
--
-- Only rows still on the old 1500ms default are moved; tenants that were
-- tuned to something else (e.g. 500 / 1000) keep their value. Raise a single
-- tenant back up if its callers get cut off mid-sentence (no barge-in on VI).
-- ============================================================

ALTER TABLE customer_settings ALTER COLUMN vad_silence_timeout_ms SET DEFAULT 800;

UPDATE customer_settings
   SET vad_silence_timeout_ms = 800, updated_at = NOW()
 WHERE vad_silence_timeout_ms = 1500;
