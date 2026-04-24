-- Per-call language + multilingual snapshot for Exotel Voicebot.
-- Run in pgAdmin after 005 (or anytime on existing DB).

ALTER TABLE exotel_call_sessions
  ADD COLUMN IF NOT EXISTS voicebot_multilingual BOOLEAN,
  ADD COLUMN IF NOT EXISTS default_language_code TEXT,
  ADD COLUMN IF NOT EXISTS current_language_code TEXT;

COMMENT ON COLUMN exotel_call_sessions.voicebot_multilingual IS
  'Snapshot of customer_settings.voicebot_multilingual when the call started.';
COMMENT ON COLUMN exotel_call_sessions.default_language_code IS
  'Snapshot of customer_settings.default_language_code when the call started (BCP-47).';
COMMENT ON COLUMN exotel_call_sessions.current_language_code IS
  'Last Sarvam STT language_code for this call (BCP-47); updated each utterance when processing audio.';
