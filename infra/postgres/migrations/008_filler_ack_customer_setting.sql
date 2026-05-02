-- ============================================================
-- Migration 008 — filler_ack per-customer setting
-- Run in pgAdmin against your Convixx database.
-- Prerequisites: 005_customer_settings_and_avatars.sql already applied.
--
-- What this does:
--   1. Adds filler_ack_enabled (BOOLEAN, default FALSE) to customer_settings.
--      When TRUE, the voicebot will acknowledge filler-only utterances
--      (hmm, um, uh, …) instead of sending them through RAG/LLM.
--   2. Adds filler_ack_threshold (INT, default 2) to customer_settings.
--      The number of consecutive filler-only utterances the bot must
--      receive BEFORE it responds with an acknowledgment. On the first
--      filler the bot stays silent (waits); on the Nth filler (threshold)
--      it plays an ack phrase and resets the counter.
--
-- Reference: docs/VOICEBOT_FILLER_ACK_LOGIC.md
-- ============================================================

-- 1. Add columns
ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS filler_ack_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS filler_ack_threshold  INT     NOT NULL DEFAULT 2
    CHECK (filler_ack_threshold >= 1 AND filler_ack_threshold <= 10);

-- 2. Comments
COMMENT ON COLUMN customer_settings.filler_ack_enabled IS
  'When TRUE, filler-only utterances (hmm, um, uh, …) are acknowledged with a short phrase instead of going through RAG/LLM. Disabled by default.';

COMMENT ON COLUMN customer_settings.filler_ack_threshold IS
  'Number of consecutive filler-only utterances before the bot responds with an acknowledgment. Default 2 means the bot waits on the first filler and responds on the second consecutive filler. Resets after each ack or after any real speech.';
