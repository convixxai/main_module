-- ============================================================
-- Cartesia STT (ink-whisper-2025-06-04) — database setup
-- Run manually in pgAdmin / psql. Do NOT use migration files.
-- Replace YOUR-CUSTOMER-UUID-HERE with your tenant UUID.
-- ============================================================

-- ------------------------------------------------------------
-- QUERY 1 — Extend stt_provider CHECK to allow 'cartesia'
-- ------------------------------------------------------------

SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'customer_settings'::regclass
  AND contype = 'c'
  AND pg_get_constraintdef(oid) LIKE '%stt_provider%';

ALTER TABLE customer_settings
  DROP CONSTRAINT IF EXISTS customer_settings_stt_provider_check;

ALTER TABLE customer_settings
  ADD CONSTRAINT customer_settings_stt_provider_check
  CHECK (stt_provider IN ('sarvam', 'elevenlabs', 'cartesia'));

-- ------------------------------------------------------------
-- QUERY 2 — Document valid Cartesia STT model (optional comment)
-- ------------------------------------------------------------

COMMENT ON COLUMN customer_settings.stt_model IS
  'STT model id. Sarvam: saaras:v3, saarika:*. ElevenLabs: scribe_v2. Cartesia: ink-whisper-2025-06-04 only (en, hi, mr).';

-- ------------------------------------------------------------
-- QUERY 3 — Enable Cartesia STT for one customer (English-only)
-- ------------------------------------------------------------

UPDATE customer_settings
SET
  stt_provider = 'cartesia',
  stt_model = 'ink-whisper-2025-06-04',
  stt_streaming_enabled = TRUE,
  default_language_code = 'en-IN',
  allowed_language_codes = ARRAY['en-IN']::TEXT[]
WHERE customer_id = 'YOUR-CUSTOMER-UUID-HERE';

-- ------------------------------------------------------------
-- QUERY 4 — Enable Cartesia STT (English + Hindi + Marathi)
-- ------------------------------------------------------------

UPDATE customer_settings
SET
  stt_provider = 'cartesia',
  stt_model = 'ink-whisper-2025-06-04',
  stt_streaming_enabled = TRUE,
  voicebot_multilingual = TRUE,
  allowed_language_codes = ARRAY['en-IN', 'hi-IN', 'mr-IN']::TEXT[],
  default_language_code = 'en-IN'
WHERE customer_id = 'YOUR-CUSTOMER-UUID-HERE';

-- ------------------------------------------------------------
-- QUERY 5 — Cartesia STT + Cartesia TTS on same tenant (common)
-- ------------------------------------------------------------

UPDATE customer_settings
SET
  stt_provider = 'cartesia',
  stt_model = 'ink-whisper-2025-06-04',
  stt_streaming_enabled = TRUE,
  tts_provider = 'cartesia',
  tts_model = 'sonic-3.5',
  tts_streaming_enabled = TRUE,
  voicebot_multilingual = TRUE,
  allowed_language_codes = ARRAY['en-IN', 'hi-IN', 'mr-IN']::TEXT[]
WHERE customer_id = 'YOUR-CUSTOMER-UUID-HERE';

-- ------------------------------------------------------------
-- QUERY 6 — Verify Cartesia STT tenants
-- ------------------------------------------------------------

SELECT customer_id, stt_provider, stt_model, stt_streaming_enabled,
       tts_provider, voicebot_multilingual, allowed_language_codes
FROM customer_settings
WHERE stt_provider = 'cartesia';

-- ------------------------------------------------------------
-- QUERY 7 — Rollback (revert tenants before dropping CHECK value)
-- ------------------------------------------------------------

-- UPDATE customer_settings
-- SET stt_provider = 'sarvam', stt_model = 'saaras:v3'
-- WHERE stt_provider = 'cartesia';
--
-- ALTER TABLE customer_settings
--   DROP CONSTRAINT IF EXISTS customer_settings_stt_provider_check;
--
-- ALTER TABLE customer_settings
--   ADD CONSTRAINT customer_settings_stt_provider_check
--   CHECK (stt_provider IN ('sarvam', 'elevenlabs'));
