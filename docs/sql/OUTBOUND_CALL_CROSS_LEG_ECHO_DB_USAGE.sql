-- ============================================================
-- Outbound Call Cross-Leg Echo Detection - Database Usage
-- ============================================================
-- Date: 2026-07-03
-- Reference: docs/OUTBOUND_CALL_CROSS_LEG_ECHO_FIX_PLAN.md
-- ============================================================
--
-- This feature uses the EXISTING `exotel_call_sessions.metadata` JSONB field.
-- NO SCHEMA CHANGES REQUIRED.
--
-- The `metadata` field stores cross-leg coordination data for outbound calls:
--
-- ============================================================
-- METADATA STRUCTURE (for outbound campaign calls)
-- ============================================================
--
-- {
--   // Script playback coordination (already implemented)
--   "script_played_by_stream": "779346f980c32e50161fca3b6f381a73",  -- stream_sid that won the lock
--   "script_played_at": "2026-07-03T19:59:51.123Z",                  -- timestamp when lock was acquired
--
--   // NEW: Shared TTS buffer for cross-leg echo detection
--   "shared_tts_buffer": [
--     {
--       "text": "सर मैं छावनी रिसॉर्ट से बोल रही हूँ...",           -- TTS text
--       "timestamp": "2026-07-03T19:59:51.456Z",                      -- when TTS was sent
--       "stream_sid": "779346f980c32e50161fca3b6f381a73"              -- which stream sent it
--     },
--     {
--       "text": "आपका स्वागत है! क्या मैं आपकी किसी विशेष जानकारी में मदद कर सकती हूँ?",
--       "timestamp": "2026-07-03T20:00:27.789Z",
--       "stream_sid": "6195e501a7ffba07d392e240e6f11a73"
--     }
--   ],
--
--   // NEW: Script playback completion flag for coordinated re-enablement
--   "script_playback_complete": true,
--   "script_completed_at": "2026-07-03T20:00:22.000Z"
-- }
--
-- ============================================================
-- QUERIES USED BY THE APPLICATION
-- ============================================================

-- 1. Add TTS text to shared buffer (called when any stream sends TTS)
-- NOTE: This is an atomic append operation that also prunes old entries
/*
UPDATE exotel_call_sessions
SET metadata = jsonb_set(
  COALESCE(metadata, '{}'::jsonb),
  '{shared_tts_buffer}',
  (
    SELECT COALESCE(
      jsonb_agg(entry) FILTER (
        WHERE (entry->>'timestamp')::timestamptz > NOW() - INTERVAL '60 seconds'
      ),
      '[]'::jsonb
    ) || jsonb_build_array(
      jsonb_build_object(
        'text', $1::text,
        'timestamp', NOW()::text,
        'stream_sid', $2::text
      )
    )
    FROM jsonb_array_elements(
      COALESCE(metadata->'shared_tts_buffer', '[]'::jsonb)
    ) AS entry
  )
)
WHERE id = $3::uuid;
*/

-- 2. Read shared TTS buffer for echo detection (called on every STT result)
/*
SELECT metadata->'shared_tts_buffer' as shared_tts_buffer
FROM exotel_call_sessions
WHERE id = $1::uuid;
*/

-- 3. Mark script playback complete (called by winning stream on mark event)
/*
UPDATE exotel_call_sessions
SET metadata = COALESCE(metadata, '{}'::jsonb) ||
    jsonb_build_object(
      'script_playback_complete', true,
      'script_completed_at', NOW()::text
    )
WHERE id = $1::uuid;
*/

-- 4. Check if script playback is complete (used by secondary streams)
/*
SELECT
  metadata->>'script_playback_complete' as script_complete,
  metadata->>'script_completed_at' as completed_at
FROM exotel_call_sessions
WHERE id = $1::uuid;
*/

-- ============================================================
-- INDEXES (OPTIONAL - Only if performance is an issue)
-- ============================================================
-- The metadata JSONB field is already part of the exotel_call_sessions table.
-- If query performance becomes an issue, consider these indexes:

-- Index for looking up active outbound sessions by campaign
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_exotel_call_sessions_campaign_metadata
-- ON exotel_call_sessions ((metadata->>'campaign_id'))
-- WHERE metadata->>'campaign_id' IS NOT NULL;

-- ============================================================
-- CLEANUP (OPTIONAL - Run periodically to prune old metadata)
-- ============================================================
-- Old metadata is automatically handled by the application (60-second TTL),
-- but you can run this to clean up very old sessions if needed:

-- UPDATE exotel_call_sessions
-- SET metadata = metadata - 'shared_tts_buffer'
-- WHERE created_at < NOW() - INTERVAL '1 day'
--   AND metadata ? 'shared_tts_buffer';

-- ============================================================
-- NO MIGRATION REQUIRED
-- ============================================================
-- This implementation uses the existing `metadata` JSONB field which
-- already exists in the `exotel_call_sessions` table.
--
-- The field is designed for flexible per-session data storage,
-- and adding new keys (shared_tts_buffer, script_playback_complete)
-- does not require any schema changes.
