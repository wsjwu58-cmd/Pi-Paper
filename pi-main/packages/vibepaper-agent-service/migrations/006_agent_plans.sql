CREATE TABLE IF NOT EXISTS agent_plans (
  id BIGINT PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES agent_sessions(id),
  version INTEGER NOT NULL,
  canvas_version BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  plan_json JSONB NOT NULL,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, version)
);

CREATE TABLE IF NOT EXISTS agent_plan_steps (
  id BIGINT PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES agent_plans(id) ON DELETE CASCADE,
  step_key VARCHAR(128) NOT NULL,
  tool_name VARCHAR(128) NOT NULL,
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  input_hash VARCHAR(64) NOT NULL,
  estimated_cost INTEGER NOT NULL DEFAULT 0,
  rerun_of BIGINT REFERENCES agent_plan_steps(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_plan_steps_ready ON agent_plan_steps (plan_id, status);
