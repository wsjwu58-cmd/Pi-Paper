CREATE TABLE IF NOT EXISTS agent_session_context (
  session_id BIGINT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  canvas_id BIGINT,
  canvas_version BIGINT NOT NULL DEFAULT 0,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  compacted_to_event_seq BIGINT NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_agent_session_context_canvas ON agent_session_context (canvas_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_candidates (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  tenant_id BIGINT,
  canvas_id BIGINT,
  session_id BIGINT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  memory_type VARCHAR(32) NOT NULL DEFAULT 'preference',
  scope VARCHAR(16) NOT NULL DEFAULT 'long_term',
  source VARCHAR(64) NOT NULL DEFAULT 'agent',
  source_event_seq BIGINT,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  dedupe_key VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_candidates_pending_dedupe
  ON memory_candidates (user_id, scope, dedupe_key)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_memory_candidates_review
  ON memory_candidates (status, created_at DESC);

ALTER TABLE user_memories DROP CONSTRAINT IF EXISTS user_memories_visibility_check;
UPDATE user_memories SET visibility = 'user' WHERE visibility = 'private';
ALTER TABLE user_memories ALTER COLUMN visibility SET DEFAULT 'user';
ALTER TABLE user_memories ADD CONSTRAINT user_memories_visibility_check
  CHECK (visibility IN ('user', 'enterprise')) NOT VALID;
