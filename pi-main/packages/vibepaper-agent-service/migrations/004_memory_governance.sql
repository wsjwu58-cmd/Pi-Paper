ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS visibility VARCHAR(32) NOT NULL DEFAULT 'private';
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE user_memories DROP CONSTRAINT IF EXISTS user_memories_visibility_check;
ALTER TABLE user_memories ADD CONSTRAINT user_memories_visibility_check CHECK (visibility IN ('private', 'enterprise')) NOT VALID;
CREATE INDEX IF NOT EXISTS idx_user_memories_scope_active ON user_memories (tenant_id, user_id, expires_at) WHERE deleted_at IS NULL;
