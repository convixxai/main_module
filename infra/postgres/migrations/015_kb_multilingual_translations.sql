-- ============================================================
-- Migration 015 — Per-language KB translations (structural work only)
--
-- Builds the multi-language KB storage for tenants with more than one
-- allowed_language_code (e.g. the Ganeshotsav customer: mr-IN/hi-IN/en-IN).
-- Every KB entry gets ONE row per allowed language (question, answer, and
-- its own embedding), instead of translating the caller's live question on
-- every single call. See chat context 2026-09-16.
--
-- IMPORTANT: this migration is PURELY ADDITIVE and does NOT change what any
-- live call reads today. kb_entries keeps its own question/answer/embedding
-- exactly as before, and ask.ts / exotel-voicebot.ts / vodafone-voicebot.ts
-- keep querying kb_entries unchanged. kb_entry_translations is a new,
-- parallel table that the KB admin portal now also writes to, so it is
-- fully populated and testable ahead of a later, separate cutover of the
-- live query path onto it.
-- ============================================================

-- Which language each entry was originally authored/uploaded in. Existing
-- rows default to en-IN (matches the Ganeshotsav KB's actual history).
ALTER TABLE kb_entries
  ADD COLUMN IF NOT EXISTS source_language_code TEXT NOT NULL DEFAULT 'en-IN';

COMMENT ON COLUMN kb_entries.source_language_code IS
  'BCP-47 tag of the language this entry was originally authored in. Editing this language''s text is what can cascade-retranslate kb_entry_translations; editing any other language only updates that one row.';

CREATE TABLE IF NOT EXISTS kb_entry_translations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_entry_id        UUID NOT NULL REFERENCES kb_entries(id) ON DELETE CASCADE,
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  language_code      TEXT NOT NULL,
  question           TEXT NOT NULL,
  answer             TEXT NOT NULL,
  embedding          vector(384),
  is_source          BOOLEAN NOT NULL DEFAULT FALSE,
  -- TRUE once an admin hand-edits this specific language row directly (as
  -- opposed to it being machine-translated from the source language) - a
  -- later cascade-retranslate from the source skips these unless the admin
  -- explicitly opts to overwrite them, so manual fixes don't get silently
  -- clobbered by the next source-language edit.
  manually_edited    BOOLEAN NOT NULL DEFAULT FALSE,
  translation_status TEXT NOT NULL DEFAULT 'ok'
    CHECK (translation_status IN ('ok', 'pending', 'stale', 'failed')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kb_entry_id, language_code)
);

-- Matches the filter shape the live query would use post-migration
-- (customer_id + language_code, then order by cosine distance) - see
-- vectorSearchWithDistance in ask.ts for the equivalent kb_entries query.
CREATE INDEX IF NOT EXISTS idx_kb_entry_translations_lookup
  ON kb_entry_translations (customer_id, language_code);

CREATE INDEX IF NOT EXISTS idx_kb_entry_translations_entry
  ON kb_entry_translations (kb_entry_id);

CREATE INDEX IF NOT EXISTS idx_kb_entry_translations_embedding_hnsw
  ON kb_entry_translations USING hnsw (embedding vector_cosine_ops);
