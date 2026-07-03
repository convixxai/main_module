-- ============================================================
-- SQL for Single Active Leg (SAL) Fix
-- Prevents AI-to-AI feedback loops in outbound dual-leg calls
-- ============================================================
--
-- APPROACH: Instead of complex echo detection, we designate ONLY ONE
-- stream as the "active responder" after script playback completes.
-- The other stream becomes completely passive (no STT processing).
--
-- NO SCHEMA CHANGES REQUIRED
-- We use the existing metadata JSONB field in exotel_call_sessions
--
-- Fields stored in metadata:
--   - active_responder_stream_sid: The stream_sid allowed to respond after script
--   - active_responder_set_at: Timestamp when active responder was designated
--
-- ============================================================

-- Example: Set active responder when script completes
-- (This is called by the primary stream after script playback mark)
/*
UPDATE exotel_call_sessions
SET metadata = COALESCE(metadata, '{}'::jsonb) || 
    jsonb_build_object(
        'active_responder_stream_sid', 'bf170b0c47143e56e790099783fd1a73',
        'active_responder_set_at', NOW()::text,
        'script_playback_complete', true,
        'script_completed_at', NOW()::text
    )
WHERE id = '6266f441-2c97-49a6-8f85-2af5eca94e14'::uuid;
*/

-- Example: Check if current stream is the active responder
/*
SELECT 
    id,
    metadata->>'active_responder_stream_sid' AS active_responder,
    metadata->>'script_playback_complete' AS script_complete
FROM exotel_call_sessions
WHERE id = '6266f441-2c97-49a6-8f85-2af5eca94e14'::uuid;
*/

-- ============================================================
-- HOW IT WORKS:
-- ============================================================
--
-- 1. During script playback:
--    - Primary stream (won lock) plays the script
--    - Secondary stream has time-based STT suppression
--
-- 2. When script playback completes (mark event on primary):
--    - Primary stream sets itself as 'active_responder_stream_sid'
--    - This is atomic - first writer wins
--
-- 3. After script, before processing ANY STT:
--    - Each stream checks: Am I the active_responder_stream_sid?
--    - YES: Process STT normally → LLM → TTS
--    - NO: Silently drop STT, do not respond
--
-- 4. Result:
--    - Only ONE stream ever responds to customer speech
--    - The other stream receives audio but ignores it
--    - No echo detection needed - no AI-to-AI possible
--
-- ============================================================
-- CLEANUP NOTE:
-- ============================================================
-- The shared_tts_buffer field is NO LONGER USED with this approach.
-- It can be safely ignored. The active_responder pattern is simpler
-- and more deterministic than fuzzy text matching.
-- ============================================================
