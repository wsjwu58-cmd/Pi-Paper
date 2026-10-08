ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS session_id BIGINT REFERENCES agent_sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS ix_user_memories_session_active
  ON user_memories (session_id, created_at DESC)
  WHERE deleted = false;
