-- ============================================================
-- Migration 019 — Per-agent voice settings (pitch/loudness + provider-
-- specific extras), completing the per-agent voice feature started by
-- agents.tts_provider/tts_speaker/tts_model (migration 011) and the
-- GET /voices catalog. agents.tts_pace already existed and was already
-- wired into the Sarvam synthesis path; this adds its two siblings
-- (pitch/loudness) plus a generic JSONB bucket for ElevenLabs
-- (stability/similarity_boost/style/speed/use_speaker_boost) and Cartesia
-- (speed/volume/emotion) knobs that don't fit fixed columns since each
-- provider's parameter vocabulary is different.
--
-- Additive only, all nullable/defaulted — no existing agent's behavior
-- changes until these are explicitly set.
-- ============================================================

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS tts_pitch NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS tts_loudness NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS tts_voice_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN agents.tts_pitch IS
  'Sarvam-only pitch override, same scale as customer_settings.tts_default_pitch. NULL = inherit the tenant default.';
COMMENT ON COLUMN agents.tts_loudness IS
  'Sarvam-only loudness override, same scale as customer_settings.tts_default_loudness. NULL = inherit the tenant default.';
COMMENT ON COLUMN agents.tts_voice_settings IS
  'Provider-specific extra knobs not covered by tts_pace/tts_pitch/tts_loudness, applied only when this agent''s effective tts_provider matches: ElevenLabs {stability,similarity_boost,style,speed,use_speaker_boost} or Cartesia {speed,volume,emotion}. {} = provider/tenant defaults (unchanged behavior).';
