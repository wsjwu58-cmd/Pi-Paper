ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_memories ADD CONSTRAINT ck_user_memories_confidence CHECK (confidence >= 0 AND confidence <= 1) NOT VALID;
ALTER TABLE user_memories ADD CONSTRAINT ck_user_memories_scope CHECK (scope IN ('session','canvas','long_term','enterprise')) NOT VALID;
CREATE INDEX IF NOT EXISTS ix_user_memories_active_lookup
  ON user_memories (user_id, scope, canvas_id, confidence DESC, created_at DESC)
  WHERE deleted = false;
