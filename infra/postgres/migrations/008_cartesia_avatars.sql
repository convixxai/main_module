-- ============================================================
-- Migration 008 — Cartesia TTS avatars + customer_settings extensions
-- Prerequisites: 005, 007 applied.
-- Reference: docs/CARTESIA_TTS_VOICEBOT_INTEGRATION_PLAN.md
-- ============================================================

-- 1. Allow cartesia as TTS provider
ALTER TABLE customer_settings
  DROP CONSTRAINT IF EXISTS customer_settings_tts_provider_check;

ALTER TABLE customer_settings
  ADD CONSTRAINT customer_settings_tts_provider_check
  CHECK (tts_provider IN ('sarvam', 'elevenlabs', 'cartesia'));

ALTER TABLE avatars
  DROP CONSTRAINT IF EXISTS avatars_tts_provider_check;

ALTER TABLE avatars
  ADD CONSTRAINT avatars_tts_provider_check
  CHECK (tts_provider IN ('sarvam', 'elevenlabs', 'cartesia'));

-- 2. Tenant-level Cartesia + humanizer columns
ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS tts_humanizer_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tts_humanizer_system_prompt TEXT,
  ADD COLUMN IF NOT EXISTS tts_humanizer_style JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tts_humanizer_max_tokens INT NOT NULL DEFAULT 350
    CHECK (tts_humanizer_max_tokens > 0),
  ADD COLUMN IF NOT EXISTS cartesia_max_buffer_delay_ms INT NOT NULL DEFAULT 0
    CHECK (cartesia_max_buffer_delay_ms >= 0 AND cartesia_max_buffer_delay_ms <= 10000),
  ADD COLUMN IF NOT EXISTS cartesia_emotion_mode TEXT NOT NULL DEFAULT 'llm_per_turn'
    CHECK (cartesia_emotion_mode IN ('static', 'llm_per_turn', 'llm_per_sentence')),
  ADD COLUMN IF NOT EXISTS cartesia_allowed_emotions TEXT[] NOT NULL DEFAULT ARRAY[
    'neutral','calm','sympathetic','content','grateful','apologetic','enthusiastic','curious'
  ]::TEXT[];

COMMENT ON COLUMN customer_settings.tts_humanizer_enabled IS
  'When tts_provider=cartesia: optional LLM humanizer before TTS. Adds latency.';
COMMENT ON COLUMN customer_settings.tts_humanizer_style IS
  'HumanizerStyleSettings JSON for Cartesia humanizer path.';
COMMENT ON COLUMN customer_settings.cartesia_max_buffer_delay_ms IS
  'Cartesia WebSocket max_buffer_delay_ms. Use 0 with sentence-level streaming.';
COMMENT ON COLUMN customer_settings.cartesia_emotion_mode IS
  'static=avatar only; llm_per_turn=LLM picks emotion per reply; llm_per_sentence=Phase 2.';
COMMENT ON COLUMN customer_settings.cartesia_allowed_emotions IS
  'Allowlist of Cartesia emotion strings the LLM may return.';

-- 3. cartesia_avatars
CREATE TABLE IF NOT EXISTS cartesia_avatars (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  name                  TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',

  voice_id              TEXT NOT NULL,
  model_id              TEXT NOT NULL DEFAULT 'sonic-3.5',

  generation_config     JSONB NOT NULL DEFAULT '{"speed":1,"volume":1,"emotion":"neutral"}'::jsonb,

  pronunciation_dict_id TEXT,
  legacy_speed          TEXT CHECK (legacy_speed IS NULL OR legacy_speed IN ('slow','normal','fast')),
  is_pvc_voice          BOOLEAN NOT NULL DEFAULT FALSE,

  language_voice_map    JSONB NOT NULL DEFAULT '{}'::jsonb,

  is_default            BOOLEAN NOT NULL DEFAULT FALSE,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,

  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT uniq_cartesia_avatar_name_per_customer UNIQUE (customer_id, name)
);

CREATE INDEX IF NOT EXISTS idx_cartesia_avatars_customer
  ON cartesia_avatars(customer_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_default_cartesia_avatar_per_customer
  ON cartesia_avatars (customer_id)
  WHERE is_default = TRUE;

COMMENT ON TABLE cartesia_avatars IS
  'Cartesia Sonic voice personas. Use when tenant TTS provider is cartesia.';

CREATE OR REPLACE FUNCTION touch_cartesia_avatars_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cartesia_avatars_touch ON cartesia_avatars;
CREATE TRIGGER trg_cartesia_avatars_touch
  BEFORE UPDATE ON cartesia_avatars
  FOR EACH ROW EXECUTE FUNCTION touch_cartesia_avatars_updated_at();

-- 4. agents.cartesia_avatar_id
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS cartesia_avatar_id UUID
    REFERENCES cartesia_avatars(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agents_cartesia_avatar
  ON agents(cartesia_avatar_id)
  WHERE cartesia_avatar_id IS NOT NULL;
