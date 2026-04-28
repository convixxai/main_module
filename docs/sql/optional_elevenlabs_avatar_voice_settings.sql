-- Optional: override ElevenLabs `voice_settings` JSON on an avatar row
-- (only if you use `elevenlabs_avatars` and want per-avatar tuning).
-- Replace UUIDs and JSON with your values. Keys are snake_case per ElevenLabs API.
-- No migration required for the voicebot improvements in code (defaults apply when this is NULL).

-- Example (PostgreSQL, JSON column):
/*
UPDATE elevenlabs_avatars
SET voice_settings = '{
  "stability": 0.48,
  "similarity_boost": 0.88,
  "style": 0.12,
  "use_speaker_boost": true,
  "speed": 1.0
}'::json
WHERE id = 'YOUR_AVATAR_UUID'
  AND customer_id = 'YOUR_CUSTOMER_UUID';
*/

-- If you store partial overrides only, merge manually in your admin UI or with jsonb_set
-- so you do not wipe other keys.
