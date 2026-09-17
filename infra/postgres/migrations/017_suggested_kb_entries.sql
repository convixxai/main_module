-- Suggested knowledgebase: queries the voicebot couldn't answer from the live
-- KB, logged fire-and-forget from the call path (never awaited, never affects
-- what's spoken to the caller) so an admin can review and promote them.
-- Similar/duplicate questions within a customer are grouped into one pending
-- row (occurrence_count) via embedding-distance matching instead of creating
-- a new row every time the same gap is hit.

CREATE TABLE IF NOT EXISTS suggested_kb_entries (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id             UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  question                TEXT NOT NULL,
  question_language_code  TEXT,
  answer_given            TEXT,
  occurrence_count        INT NOT NULL DEFAULT 1,
  first_asked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_asked_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ignored', 'added')),
  source                  TEXT,
  embedding               VECTOR(384),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_suggested_kb_entries_customer_status
  ON suggested_kb_entries (customer_id, status, last_asked_at DESC);

CREATE INDEX IF NOT EXISTS idx_suggested_kb_entries_embedding_hnsw
  ON suggested_kb_entries USING hnsw (embedding vector_cosine_ops);
