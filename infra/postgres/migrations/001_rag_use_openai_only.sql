-- Run once in pgAdmin (existing databases). New installs get this from init.sql.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS rag_use_openai_only BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN customers.rag_use_openai_only IS
  'When true, RAG answers use OpenAI only; self-hosted LLM is skipped.';
