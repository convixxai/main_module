-- ============================================================
-- Migration 026 — suggested knowledgebase: review flow for the SaaS
-- Run via apps/api/scripts/run-sql-file.ts. Extends 017_suggested_kb_entries.
--
-- Statuses: 'pending' (to review), 'added' (customer added it to the KB),
-- 'rejected' (customer declined). The old 'ignored' value (KB admin portal)
-- is renamed to 'rejected'.
--
-- New columns:
--   kind             'unanswered' (bot could not answer) or 'ai_answered'
--                    (AI answered, but no close KB entry)
--   kb_top_distance  cosine distance of the best KB match when it was asked
--   agent_id         agent that answered
--   last_session_id  chat session of the latest occurrence (= the call's
--                    transcript, for "view the conversation")
--   kb_entry_id      KB entry created from it (when added)
--   reviewed_at      when the status was last set by the customer
--   review_note      optional note from the reviewer
--
-- Additive only; existing rows become kind 'unanswered' (the only kind
-- logged before this migration).
-- ============================================================

ALTER TABLE suggested_kb_entries DROP CONSTRAINT IF EXISTS suggested_kb_entries_status_check;
UPDATE suggested_kb_entries SET status = 'rejected' WHERE status = 'ignored';
ALTER TABLE suggested_kb_entries
  ADD CONSTRAINT suggested_kb_entries_status_check CHECK (status IN ('pending', 'added', 'rejected'));

ALTER TABLE suggested_kb_entries
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'unanswered',
  ADD COLUMN IF NOT EXISTS kb_top_distance REAL,
  ADD COLUMN IF NOT EXISTS agent_id UUID,
  ADD COLUMN IF NOT EXISTS last_session_id UUID,
  ADD COLUMN IF NOT EXISTS kb_entry_id UUID,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_note TEXT;

ALTER TABLE suggested_kb_entries DROP CONSTRAINT IF EXISTS suggested_kb_entries_kind_check;
ALTER TABLE suggested_kb_entries
  ADD CONSTRAINT suggested_kb_entries_kind_check CHECK (kind IN ('unanswered', 'ai_answered'));
