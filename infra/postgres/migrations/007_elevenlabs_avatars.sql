-- ============================================================
-- Migration 007 — elevenlabs_avatars + agents.elevenlabs_avatar_id
-- Prerequisites: 005 (avatars, agents.avatar_id) applied.
-- ============================================================

CREATE TABLE IF NOT EXISTS elevenlabs_avatars (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID          NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  name              TEXT          NOT NULL,
  description       TEXT          NOT NULL DEFAULT '',

  voice_id          TEXT          NOT NULL,
  model_id          TEXT,

  -- ElevenLabs API voice_settings (snake_case): stability, similarity_boost, style, speed, use_speaker_boost
  voice_settings    JSONB         NOT NULL DEFAULT '{}'::jsonb,

  -- Per BCP-47 overrides, e.g. {"hi-IN": {"voice_id": "...", "model_id": "...", "voice_settings": {}}}
  language_voice_map JSONB        NOT NULL DEFAULT '{}'::jsonb,

  is_default        BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,

  created_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP     NOT NULL DEFAULT NOW(),

  CONSTRAINT uniq_el_avatar_name_per_customer UNIQUE (customer_id, name)
);

CREATE INDEX IF NOT EXISTS idx_elevenlabs_avatars_customer
  ON elevenlabs_avatars(customer_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_default_el_avatar_per_customer
  ON elevenlabs_avatars (customer_id)
  WHERE is_default = TRUE;

COMMENT ON TABLE elevenlabs_avatars IS
  'ElevenLabs-only voice personas (voice_id, model, voice_settings, per-language map). Use when tenant TTS provider is elevenlabs; agents reference via agents.elevenlabs_avatar_id.';

CREATE OR REPLACE FUNCTION touch_elevenlabs_avatars_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_elevenlabs_avatars_touch ON elevenlabs_avatars;
CREATE TRIGGER trg_elevenlabs_avatars_touch
  BEFORE UPDATE ON elevenlabs_avatars
  FOR EACH ROW EXECUTE FUNCTION touch_elevenlabs_avatars_updated_at();

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS elevenlabs_avatar_id UUID
    REFERENCES elevenlabs_avatars(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agents_elevenlabs_avatar ON agents(elevenlabs_avatar_id)
  WHERE elevenlabs_avatar_id IS NOT NULL;
