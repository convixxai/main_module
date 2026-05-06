-- Tenant-level controls for related in-scope answers outside explicit KB lines.
ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS allow_related_general_answers BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS related_scope_distance_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.55,
  ADD COLUMN IF NOT EXISTS related_answer_strictness TEXT NOT NULL DEFAULT 'balanced',
  ADD COLUMN IF NOT EXISTS out_of_scope_message TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'customer_settings_related_answer_strictness_chk'
  ) THEN
    ALTER TABLE customer_settings
      ADD CONSTRAINT customer_settings_related_answer_strictness_chk
      CHECK (related_answer_strictness IN ('strict', 'balanced', 'permissive'));
  END IF;
END $$;

