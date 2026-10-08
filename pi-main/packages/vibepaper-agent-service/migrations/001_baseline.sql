CREATE TABLE IF NOT EXISTS agent_sessions (
  id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL, canvas_id BIGINT, title VARCHAR(128) NOT NULL DEFAULT '新对话',
  skill_id BIGINT, token_used_total INTEGER NOT NULL DEFAULT 0, points_used_total INTEGER NOT NULL DEFAULT 0,
  model_usage JSONB NOT NULL DEFAULT '{}'::jsonb, status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS skill_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS loaded_skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS ix_agent_sessions_user_updated ON agent_sessions (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  id BIGINT PRIMARY KEY, session_id BIGINT NOT NULL, role VARCHAR(16) NOT NULL, msg_type VARCHAR(16) NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '', meta JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_agent_messages_session_id ON agent_messages (session_id, id);

CREATE TABLE IF NOT EXISTS skills (
  id BIGINT PRIMARY KEY, owner_id BIGINT NOT NULL, name VARCHAR(128) NOT NULL, description TEXT, instructions TEXT NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'manual', category VARCHAR(32) NOT NULL DEFAULT 'general', version INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_skills_owner ON skills (owner_id);

CREATE TABLE IF NOT EXISTS user_memories (
  id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL, tenant_id BIGINT, canvas_id BIGINT, content TEXT NOT NULL,
  memory_type VARCHAR(32) NOT NULL DEFAULT 'preference', scope VARCHAR(16) NOT NULL DEFAULT 'long_term',
  visibility VARCHAR(16) NOT NULL DEFAULT 'user', source VARCHAR(64) NOT NULL DEFAULT 'user', confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
  embedding JSONB NOT NULL DEFAULT '[]'::jsonb, expires_at TIMESTAMPTZ, deleted BOOLEAN NOT NULL DEFAULT false,
  last_merged_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_user_memories_user_scope ON user_memories (user_id, scope, created_at DESC);

CREATE TABLE IF NOT EXISTS session_fragments (
  id BIGINT PRIMARY KEY, owner_id BIGINT NOT NULL, title VARCHAR(128), content JSONB NOT NULL DEFAULT '[]'::jsonb,
  canvas_id BIGINT, fragment_type VARCHAR(32) NOT NULL DEFAULT 'worldview', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS render_reviews (
  id BIGINT PRIMARY KEY, canvas_id BIGINT NOT NULL, user_id BIGINT NOT NULL, target_node_id BIGINT NOT NULL,
  target_kind VARCHAR(32) NOT NULL DEFAULT 'clip', scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  failures JSONB NOT NULL DEFAULT '[]'::jsonb, recommended_action VARCHAR(64), evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  retry_count INTEGER NOT NULL DEFAULT 0, status VARCHAR(16) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_render_reviews_canvas_node ON render_reviews (canvas_id, target_node_id);

CREATE TABLE IF NOT EXISTS agent_actions (
  id BIGINT PRIMARY KEY, session_id BIGINT NOT NULL, user_id BIGINT NOT NULL, action_type VARCHAR(64) NOT NULL,
  tool_name VARCHAR(64), params JSONB NOT NULL DEFAULT '{}'::jsonb, risk_level VARCHAR(16) NOT NULL DEFAULT 'low',
  status VARCHAR(32) NOT NULL DEFAULT 'planned', canvas_version INTEGER, result JSONB, error_code VARCHAR(64),
  idempotency_key VARCHAR(128), estimated_cost INTEGER NOT NULL DEFAULT 0, task_id VARCHAR(64), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_actions_idempotency_key ON agent_actions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_approvals (
  id BIGINT PRIMARY KEY, action_id BIGINT NOT NULL, session_id BIGINT NOT NULL, user_id BIGINT NOT NULL, canvas_id BIGINT,
  canvas_version INTEGER NOT NULL, tool_name VARCHAR(64) NOT NULL, action_hash VARCHAR(64) NOT NULL,
  estimated_cost INTEGER NOT NULL DEFAULT 0, nonce VARCHAR(64) NOT NULL UNIQUE, token_signature VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ, status VARCHAR(16) NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_wakeup_notices (
  id BIGINT PRIMARY KEY, session_id BIGINT NOT NULL, task_id VARCHAR(64) NOT NULL, terminal_status VARCHAR(32) NOT NULL,
  canvas_id BIGINT, node_id BIGINT, user_id BIGINT, payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  processing_at TIMESTAMPTZ, processed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, task_id, terminal_status)
);

CREATE TABLE IF NOT EXISTS drama_series (
  id VARCHAR(64) PRIMARY KEY, canvas_id BIGINT NOT NULL, owner_id BIGINT NOT NULL, active_canon_revision INTEGER NOT NULL DEFAULT 1,
  format JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drama_characters (
  id VARCHAR(64) PRIMARY KEY, series_id VARCHAR(64) NOT NULL REFERENCES drama_series(id), name VARCHAR(128) NOT NULL,
  identity_anchors JSONB NOT NULL, active_look_revision INTEGER NOT NULL, voice_id VARCHAR(128) NOT NULL,
  appearance JSONB NOT NULL DEFAULT '{}'::jsonb, wardrobe JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drama_reference_packs (
  id VARCHAR(64) PRIMARY KEY, character_id VARCHAR(64) NOT NULL REFERENCES drama_characters(id), look_revision INTEGER NOT NULL,
  status VARCHAR(16) NOT NULL, front_asset_id VARCHAR(128) NOT NULL, side_asset_id VARCHAR(128) NOT NULL,
  back_asset_id VARCHAR(128) NOT NULL, expression_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drama_shots (
  id VARCHAR(64) PRIMARY KEY, series_id VARCHAR(64) NOT NULL REFERENCES drama_series(id), episode_no INTEGER NOT NULL, shot_no INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL, character_bindings JSONB NOT NULL DEFAULT '[]'::jsonb, prompt_revision INTEGER NOT NULL DEFAULT 1,
  prompt TEXT NOT NULL DEFAULT '', status VARCHAR(24) NOT NULL DEFAULT 'draft', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(series_id, episode_no, shot_no)
);
CREATE TABLE IF NOT EXISTS drama_keyframes (
  id VARCHAR(64) PRIMARY KEY, shot_id VARCHAR(64) NOT NULL REFERENCES drama_shots(id), status VARCHAR(16) NOT NULL,
  reference_pack_ids JSONB NOT NULL DEFAULT '[]'::jsonb, canvas_node_id BIGINT, asset_id VARCHAR(128), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drama_render_lineages (
  id VARCHAR(64) PRIMARY KEY, shot_id VARCHAR(64) NOT NULL REFERENCES drama_shots(id), keyframe_render_id VARCHAR(64) NOT NULL REFERENCES drama_keyframes(id),
  status VARCHAR(24) NOT NULL DEFAULT 'draft', video_task_id VARCHAR(64), canvas_node_id BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drama_render_batches (
  id VARCHAR(64) PRIMARY KEY, series_id VARCHAR(64) NOT NULL REFERENCES drama_series(id), episode_no INTEGER NOT NULL,
  stage VARCHAR(24) NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'draft', estimated_cost INTEGER NOT NULL DEFAULT 0,
  approved_cost_cap INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drama_audit_reports (
  id VARCHAR(64) PRIMARY KEY, series_id VARCHAR(64) NOT NULL REFERENCES drama_series(id), episode_no INTEGER,
  status VARCHAR(24) NOT NULL DEFAULT 'open', findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
