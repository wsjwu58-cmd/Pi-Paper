-- Reconcile the legacy Agent database before migrations that create dependent indexes.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS active_run_id BIGINT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS skill_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS loaded_skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS tenant_id BIGINT;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS canvas_id BIGINT;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS source VARCHAR(64) NOT NULL DEFAULT 'user';
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS visibility VARCHAR(32) NOT NULL DEFAULT 'private';
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS session_id BIGINT;

ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS task_id VARCHAR(64);
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS run_id BIGINT;
