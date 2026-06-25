-- ============================================================
-- Cartesia voicebot setup — run AFTER migration 008
-- Run each section separately in pgAdmin as needed.
-- Replace placeholders before executing sample data blocks.
-- ============================================================

-- ------------------------------------------------------------
-- QUERY 1 — Schema (same as migration 008; skip if already applied)
-- ------------------------------------------------------------
-- See: infra/postgres/migrations/008_cartesia_avatars.sql

-- ------------------------------------------------------------
-- QUERY 2 — Enable Cartesia for one customer (tenant settings)
-- Replace ead34d8f-de23-452c-9091-85b2af98ac82
-- ------------------------------------------------------------
UPDATE customer_settings
SET
  tts_provider = 'cartesia',
  tts_model = 'sonic-3.5',
  tts_default_speaker = 'f786b574-daa5-4673-aa0c-cbe3e8534c02',
  tts_streaming_enabled = TRUE,
  rag_streaming_enabled = TRUE,
  tts_humanizer_enabled = FALSE,
  cartesia_max_buffer_delay_ms = 0,
  cartesia_emotion_mode = 'llm_per_turn',
  cartesia_allowed_emotions = ARRAY[
    'neutral','calm','sympathetic','content','grateful',
    'apologetic','enthusiastic','curious','determined'
  ]::TEXT[]
WHERE customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';

-- ------------------------------------------------------------
-- QUERY 3 — Sample Cartesia avatar (English support — Katie)
-- Replace ead34d8f-de23-452c-9091-85b2af98ac82
-- ------------------------------------------------------------
INSERT INTO cartesia_avatars (
  customer_id,
  name,
  description,
  voice_id,
  model_id,
  generation_config,
  language_voice_map,
  is_default,
  is_active
) VALUES (
  'ead34d8f-de23-452c-9091-85b2af98ac82',
  'Katie — EN Support',
  'Cartesia Sonic 3.5 en-US female; recommended for voice agents',
  'f786b574-daa5-4673-aa0c-cbe3e8534c02',
  'sonic-3.5',
  '{"speed":1,"volume":1,"emotion":"sympathetic"}'::jsonb,
  '{
    "en-IN": {"generation_config": {"emotion": "sympathetic", "speed": 1, "volume": 1}},
    "hi-IN": {
      "voice_id": "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
      "model_id": "sonic-3.5",
      "generation_config": {"emotion": "calm", "speed": 1, "volume": 1}
    }
  }'::jsonb,
  TRUE,
  TRUE
)
ON CONFLICT (customer_id, name) DO NOTHING;

-- ------------------------------------------------------------
-- QUERY 4 — Sample Cartesia avatar (Hindi — Skylar)
-- Replace ead34d8f-de23-452c-9091-85b2af98ac82
-- ------------------------------------------------------------
INSERT INTO cartesia_avatars (
  customer_id,
  name,
  description,
  voice_id,
  model_id,
  generation_config,
  is_default,
  is_active
) VALUES (
  'ead34d8f-de23-452c-9091-85b2af98ac82',
  'Skylar — Hindi',
  'Secondary persona for Hindi calls',
  'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
  'sonic-3.5',
  '{"speed":1,"volume":1,"emotion":"calm"}'::jsonb,
  FALSE,
  TRUE
)
ON CONFLICT (customer_id, name) DO NOTHING;

-- ------------------------------------------------------------
-- QUERY 5 — Link agent to Cartesia avatar
-- Replace YOUR_AGENT_UUID and CARTESIA_AVATAR_UUID
-- ------------------------------------------------------------
UPDATE agents
SET cartesia_avatar_id = '68cc9cfc-cfa4-4713-be97-118df98226d8'
WHERE id = '513f3ca6-d49a-4123-8848-f86811600407'
  AND customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';

-- ------------------------------------------------------------
-- QUERY 6 — Static emotion mode (LLM does not pick emotion)
-- ------------------------------------------------------------
UPDATE customer_settings
SET cartesia_emotion_mode = 'static'
WHERE customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';

-- ------------------------------------------------------------
-- QUERY 7 — Enable humanizer (adds LLM latency before TTS)
-- ------------------------------------------------------------
UPDATE customer_settings
SET
  tts_humanizer_enabled = TRUE,
  tts_humanizer_max_tokens = 350,
  tts_humanizer_style = '{
    "emotion_intensity": "high",
    "speaking_pace": "natural_conversational",
    "warmth": "warm_friendly",
    "formality": "casual_professional",
    "use_fillers": "light_natural",
    "emphasis_style": "expressive_balanced",
    "scenario": "live_phone_call",
    "speaker_persona": "helpful human agent who genuinely cares",
    "target_language": "preserve_input_language",
    "reaction_level": "believable_not_dramatic",
    "pause_style": "natural_micro_pauses"
  }'::jsonb
WHERE customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';

-- ------------------------------------------------------------
-- QUERY 8 — Verify configuration
-- Replace ead34d8f-de23-452c-9091-85b2af98ac82
-- ------------------------------------------------------------
SELECT
  cs.customer_id,
  cs.tts_provider,
  cs.tts_model,
  cs.tts_default_speaker,
  cs.tts_streaming_enabled,
  cs.rag_streaming_enabled,
  cs.cartesia_emotion_mode,
  cs.cartesia_allowed_emotions,
  cs.cartesia_max_buffer_delay_ms,
  cs.tts_humanizer_enabled
FROM customer_settings cs
WHERE cs.customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';

SELECT
  ca.id,
  ca.name,
  ca.voice_id,
  ca.model_id,
  ca.generation_config,
  ca.language_voice_map,
  ca.is_default,
  ca.is_active
FROM cartesia_avatars ca
WHERE ca.customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82'
ORDER BY ca.is_default DESC, ca.name;

SELECT
  a.id AS agent_id,
  a.name AS agent_name,
  a.cartesia_avatar_id,
  ca.name AS cartesia_avatar_name
FROM agents a
LEFT JOIN cartesia_avatars ca ON ca.id = a.cartesia_avatar_id
WHERE a.customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';
