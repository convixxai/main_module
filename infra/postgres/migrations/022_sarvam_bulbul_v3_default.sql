-- ============================================================
-- Migration 022 — Sarvam bulbul:v2 retired, default to bulbul:v3
-- Run via apps/api/scripts/run-sql-file.ts.
--
-- Sarvam's TTS API now rejects bulbul:v2 with HTTP 400 ("Model 'bulbul:v2'
-- has been deprecated. Please use 'bulbul:v3' instead."). The
-- customer_settings.tts_model column still defaulted to 'bulbul:v2', so every
-- newly created tenant (and the two remaining v2 rows) produced silent calls
-- on any agent that doesn't pin its own model. services/sarvam.ts now also
-- upgrades v2 at request time; this fixes the stored data and the default.
-- ============================================================

ALTER TABLE customer_settings ALTER COLUMN tts_model SET DEFAULT 'bulbul:v3';

UPDATE customer_settings
   SET tts_model = 'bulbul:v3', updated_at = NOW()
 WHERE tts_model IN ('bulbul:v1', 'bulbul:v2');
