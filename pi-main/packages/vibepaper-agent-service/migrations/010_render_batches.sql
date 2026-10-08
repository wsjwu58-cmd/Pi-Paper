CREATE TABLE IF NOT EXISTS agent_render_batches (
  id BIGINT PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  canvas_id BIGINT NOT NULL,
  series_id VARCHAR(64) NOT NULL,
  episode_no INTEGER NOT NULL,
  cost_cap INTEGER NOT NULL CHECK (cost_cap >= 0),
  estimated_cost INTEGER NOT NULL CHECK (estimated_cost >= 0),
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  idempotency_key VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('draft','awaiting_approval','running','partial','completed','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_render_batches_owner_key
  ON agent_render_batches (owner_id, idempotency_key);
CREATE INDEX IF NOT EXISTS ix_agent_render_batches_owner_created
  ON agent_render_batches (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_render_jobs (
  id BIGINT PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES agent_render_batches(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL,
  shot_id VARCHAR(64) NOT NULL,
  keyframe_render_id VARCHAR(64) NOT NULL,
  canvas_node_id BIGINT,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 2 AND 5),
  model_type VARCHAR(128) NOT NULL,
  model_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_cost INTEGER NOT NULL CHECK (estimated_cost >= 0),
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  task_id VARCHAR(128),
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('draft','running','completed','failed')),
  UNIQUE(batch_id, shot_id)
);
CREATE INDEX IF NOT EXISTS ix_agent_render_jobs_batch_status
  ON agent_render_jobs (batch_id, status);
