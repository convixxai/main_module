-- Link chat_messages to the Exotel call row (voicebot) for filtering and auditing.
-- HTTP-sourced messages keep exotel_call_session_id NULL.

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS exotel_call_session_id UUID REFERENCES exotel_call_sessions(id) ON DELETE SET NULL;

COMMENT ON COLUMN chat_messages.exotel_call_session_id IS 'exotel_call_sessions.id when this message belongs to a PSTN/Voicebot call; NULL for non-voice API traffic.';

CREATE INDEX IF NOT EXISTS idx_chat_messages_exotel_call
  ON chat_messages (exotel_call_session_id)
  WHERE exotel_call_session_id IS NOT NULL;
