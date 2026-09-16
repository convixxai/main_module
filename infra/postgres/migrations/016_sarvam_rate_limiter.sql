-- ============================================================
-- Migration 016 — Cross-process Sarvam translate rate limiter
--
-- Found 2026-09-16: KB translation pacing (kb-translation.ts's
-- pacedSarvamTranslate) was an in-process module-level queue, which only
-- serializes calls made by ONE Node process. When the standalone backfill
-- script (scripts/backfill-kb-translations.ts, a separate OS process) ran
-- at the same time as the live API server handling an admin's KB
-- upload/add, both processes paced their OWN calls independently, so the
-- combined real request rate to Sarvam roughly doubled and tripped the
-- rate limit again (confirmed: a live bulk-upload test run during an
-- active backfill got both its mr-IN and hi-IN translations rejected).
--
-- This single-row table is a cheap, atomic, cross-process pacing token:
-- every caller does one UPDATE ... RETURNING to reserve the next available
-- time slot (row-level locking makes concurrent reservations serialize
-- correctly regardless of which process/connection makes them), then
-- sleeps until its own reserved slot before actually calling Sarvam.
-- ============================================================

CREATE TABLE IF NOT EXISTS sarvam_rate_limiter (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  next_available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sarvam_rate_limiter_singleton CHECK (id = 1)
);

INSERT INTO sarvam_rate_limiter (id, next_available_at)
VALUES (1, now())
ON CONFLICT (id) DO NOTHING;
