-- ============================================================
-- Migration 005 — customer_settings + avatars
-- Run in pgAdmin against your Convixx database.
-- Prerequisites: infra/postgres/init.sql, 001, 002, 003, 004 already applied.
--
-- What this does:
--   1. Creates customer_settings (ONE row per customer, all tunables).
--   2. Creates avatars (many per customer, reusable voice personas).
--   3. Adds agents.avatar_id (optional FK so agents can inherit an avatar).
--   4. Auto-creates a settings row for every new customer.
--   5. Backfills settings rows for existing customers and copies
--      rag_use_openai_only from customers so the new API is immediately live.
--
-- Reference: docs/SETTINGS_AND_FEATURES_CATALOG.md
-- ============================================================

-- ============================================================
-- 1. customer_settings — ONE row per customer.
--    Every column has a safe default; the auto-create trigger
--    guarantees every customer has a row, so reads are a single
--    primary-key lookup (fast).
-- ============================================================
CREATE TABLE IF NOT EXISTS customer_settings (
  customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,

  -- A. Voicebot runtime
  voicebot_enabled              BOOLEAN       NOT NULL DEFAULT FALSE,
  voicebot_multilingual         BOOLEAN       NOT NULL DEFAULT FALSE,
  default_language_code         TEXT          NOT NULL DEFAULT 'en-IN',
  allowed_language_codes        TEXT[]        NOT NULL DEFAULT ARRAY['en-IN']::TEXT[],

  -- B. STT
  stt_provider                  TEXT          NOT NULL DEFAULT 'sarvam'
    CHECK (stt_provider IN ('sarvam','elevenlabs')),
  stt_model                     TEXT          NOT NULL DEFAULT 'saaras:v3',
  stt_streaming_enabled         BOOLEAN       NOT NULL DEFAULT FALSE,

  -- C. TTS
  tts_provider                  TEXT          NOT NULL DEFAULT 'sarvam'
    CHECK (tts_provider IN ('sarvam','elevenlabs')),
  tts_model                     TEXT          NOT NULL DEFAULT 'bulbul:v2',
  tts_default_speaker           TEXT,
  tts_default_pace              NUMERIC(3,2),
  tts_default_pitch             NUMERIC(3,2),
  tts_default_loudness          NUMERIC(3,2),
  tts_default_sample_rate       INT           NOT NULL DEFAULT 22050,
  tts_output_codec              TEXT          NOT NULL DEFAULT 'wav'
    CHECK (tts_output_codec IN ('wav','mp3')),
  tts_streaming_enabled         BOOLEAN       NOT NULL DEFAULT FALSE,

  -- D. RAG / LLM
  rag_use_openai_only           BOOLEAN       NOT NULL DEFAULT FALSE,
  rag_top_k                     INT           NOT NULL DEFAULT 3 CHECK (rag_top_k > 0),
  rag_use_history               BOOLEAN       NOT NULL DEFAULT TRUE,
  rag_history_max_turns         INT,
  rag_distance_threshold        NUMERIC(4,3),
  rag_streaming_enabled         BOOLEAN       NOT NULL DEFAULT FALSE,
  llm_model_override            TEXT,
  llm_max_tokens                INT           NOT NULL DEFAULT 150 CHECK (llm_max_tokens > 0),
  llm_temperature               NUMERIC(3,2)  NOT NULL DEFAULT 0.25,
  llm_top_p                     NUMERIC(3,2),
  llm_verification_enabled      BOOLEAN       NOT NULL DEFAULT FALSE,
  llm_verification_threshold    NUMERIC(3,2)  NOT NULL DEFAULT 0.80,
  llm_fallback_to_openai        BOOLEAN       NOT NULL DEFAULT TRUE,
  openai_model                  TEXT          NOT NULL DEFAULT 'gpt-4o-mini',
  no_kb_fallback_instruction    TEXT,

  -- E. VAD / audio handling
  vad_silence_timeout_ms        INT           NOT NULL DEFAULT 1500,
  vad_energy_threshold          INT           NOT NULL DEFAULT 200,
  vad_min_speech_ms             INT           NOT NULL DEFAULT 200,
  max_utterance_buffer_bytes    INT           NOT NULL DEFAULT 5242880, -- 5 MB
  max_utterance_seconds         INT,
  echo_cancel_level             TEXT          NOT NULL DEFAULT 'off'
    CHECK (echo_cancel_level IN ('off','soft','aggressive')),

  -- F. Barge-in
  barge_in_enabled              BOOLEAN       NOT NULL DEFAULT FALSE,
  barge_in_mode                 TEXT          NOT NULL DEFAULT 'finish_then_answer'
    CHECK (barge_in_mode IN ('immediate','finish_then_answer','finish_turn')),
  barge_in_min_speech_ms        INT           NOT NULL DEFAULT 400,
  barge_in_energy_threshold     INT           NOT NULL DEFAULT 250,

  -- G. Mid-call language switch
  allow_language_switch         BOOLEAN       NOT NULL DEFAULT FALSE,
  language_switch_trigger_keywords TEXT[]     NOT NULL DEFAULT ARRAY['change language','switch language','भाषा बदलो','भाषा बदलें']::TEXT[],
  language_switch_confirm_prompt   TEXT       NOT NULL DEFAULT 'Would you like to change the language? Please say yes or no.',
  language_switch_options_prompt   TEXT       NOT NULL DEFAULT 'Please say one of: {LANGUAGE_LIST}.',
  language_switch_yes_words     TEXT[]        NOT NULL DEFAULT ARRAY['yes','haan','हाँ','ho','हो']::TEXT[],
  language_switch_no_words      TEXT[]        NOT NULL DEFAULT ARRAY['no','nahi','नहीं']::TEXT[],
  language_switch_timeout_ms    INT           NOT NULL DEFAULT 6000,
  language_switch_max_attempts  INT           NOT NULL DEFAULT 2,

  -- H. Stop words
  stop_words                    TEXT[]        NOT NULL DEFAULT ARRAY['stop','operator','main menu','go back','cancel']::TEXT[],

  -- I. IVR
  ivr_enabled                   BOOLEAN       NOT NULL DEFAULT FALSE,
  ivr_welcome_menu_id           UUID,
  ivr_input_timeout_ms          INT           NOT NULL DEFAULT 5000,
  ivr_max_retries               INT           NOT NULL DEFAULT 3,
  ivr_speech_input_enabled      BOOLEAN       NOT NULL DEFAULT TRUE,
  ivr_fallback_to_agent         BOOLEAN       NOT NULL DEFAULT TRUE,

  -- J. Call lifecycle
  max_call_duration_seconds     INT,
  max_concurrent_calls          INT           NOT NULL DEFAULT 10,
  call_transcript_enabled       BOOLEAN       NOT NULL DEFAULT TRUE,
  end_call_keywords             TEXT[]        NOT NULL DEFAULT ARRAY['goodbye','bye']::TEXT[],
  end_call_silence_timeout_sec  INT           NOT NULL DEFAULT 20,
  handoff_to_human_enabled      BOOLEAN       NOT NULL DEFAULT FALSE,
  human_agent_transfer_number   TEXT,
  business_hours                JSONB         NOT NULL DEFAULT '{}'::jsonb,
  holiday_calendar              JSONB         NOT NULL DEFAULT '[]'::jsonb,

  -- K. Outbound
  outbound_enabled              BOOLEAN       NOT NULL DEFAULT FALSE,

  -- L. Webhooks & notifications
  webhook_url_call_start        TEXT,
  webhook_url_call_end          TEXT,
  webhook_url_transcript        TEXT,
  webhook_url_ivr_event         TEXT,
  webhook_url_language_event    TEXT,
  webhook_secret                TEXT,
  webhook_retry_attempts        INT           NOT NULL DEFAULT 3,
  email_notify_call_end         BOOLEAN       NOT NULL DEFAULT FALSE,
  email_recipients              TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
  slack_webhook_url             TEXT,

  created_at                    TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMP     NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE customer_settings IS
  'One row per customer. Source of truth for all tenant-level runtime tunables (voicebot, STT/TTS, RAG/LLM, VAD, barge-in, language switch, IVR, call lifecycle, webhooks). See docs/SETTINGS_AND_FEATURES_CATALOG.md.';

-- Touch updated_at on any UPDATE
CREATE OR REPLACE FUNCTION touch_customer_settings_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_settings_touch ON customer_settings;
CREATE TRIGGER trg_customer_settings_touch
  BEFORE UPDATE ON customer_settings
  FOR EACH ROW EXECUTE FUNCTION touch_customer_settings_updated_at();

-- Auto-create one settings row when a customer is inserted
CREATE OR REPLACE FUNCTION customer_settings_autocreate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO customer_settings (customer_id)
  VALUES (NEW.id)
  ON CONFLICT (customer_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_settings_autocreate ON customers;
CREATE TRIGGER trg_customer_settings_autocreate
  AFTER INSERT ON customers
  FOR EACH ROW EXECUTE FUNCTION customer_settings_autocreate();

-- Backfill rows for existing customers
INSERT INTO customer_settings (customer_id)
SELECT id FROM customers
ON CONFLICT (customer_id) DO NOTHING;

-- Copy existing rag_use_openai_only from customers (zero-downtime migration)
UPDATE customer_settings cs
SET rag_use_openai_only = c.rag_use_openai_only
FROM customers c
WHERE cs.customer_id = c.id;


-- ============================================================
-- 2. avatars — many per customer. Reusable voice personas that
--    bundle provider + model + speaker + pace/pitch/loudness
--    with optional per-language overrides via language_voice_map.
-- ============================================================
CREATE TABLE IF NOT EXISTS avatars (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID          NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  name              TEXT          NOT NULL,
  description       TEXT          NOT NULL DEFAULT '',
  tone              TEXT,                          -- 'friendly' | 'formal' | 'energetic' | 'calm' | ...

  tts_provider      TEXT          NOT NULL DEFAULT 'sarvam'
    CHECK (tts_provider IN ('sarvam','elevenlabs')),
  tts_model         TEXT,                          -- e.g. 'bulbul:v3' / 'eleven_multilingual_v2'
  tts_speaker       TEXT,                          -- Sarvam speaker id OR ElevenLabs voice id
  tts_pace          NUMERIC(3,2),
  tts_pitch         NUMERIC(3,2),
  tts_loudness      NUMERIC(3,2),
  tts_sample_rate   INT,                           -- override customer_settings.tts_default_sample_rate

  -- Optional per-language override. Shape (example):
  -- {
  --   "hi-IN": {"tts_provider":"sarvam","tts_model":"bulbul:v3","tts_speaker":"asha","tts_pace":0.95},
  --   "en-IN": {"tts_provider":"elevenlabs","tts_model":"eleven_multilingual_v2","tts_speaker":"21m00Tcm4TlvDq8ikWAM"}
  -- }
  language_voice_map JSONB        NOT NULL DEFAULT '{}'::jsonb,

  is_default        BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,

  created_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP     NOT NULL DEFAULT NOW(),

  CONSTRAINT uniq_avatar_name_per_customer UNIQUE (customer_id, name)
);

CREATE INDEX IF NOT EXISTS idx_avatars_customer ON avatars(customer_id);

-- Only ONE default avatar per customer
CREATE UNIQUE INDEX IF NOT EXISTS uniq_default_avatar_per_customer
  ON avatars (customer_id)
  WHERE is_default = TRUE;

COMMENT ON TABLE avatars IS
  'Reusable voice personas per customer. Agents reference an avatar via agents.avatar_id; session TTS params are resolved as session → agent → avatar (incl. language_voice_map) → customer_settings → env → hard-coded.';

CREATE OR REPLACE FUNCTION touch_avatars_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_avatars_touch ON avatars;
CREATE TRIGGER trg_avatars_touch
  BEFORE UPDATE ON avatars
  FOR EACH ROW EXECUTE FUNCTION touch_avatars_updated_at();


-- ============================================================
-- 3. agents.avatar_id — agents may point to an avatar for TTS
-- ============================================================
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS avatar_id UUID
    REFERENCES avatars(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agents_avatar ON agents(avatar_id)
  WHERE avatar_id IS NOT NULL;
