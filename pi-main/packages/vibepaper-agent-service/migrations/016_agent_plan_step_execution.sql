ALTER TABLE agent_plan_steps
  ADD COLUMN IF NOT EXISTS effect VARCHAR(32),
  ADD COLUMN IF NOT EXISTS concurrency_key VARCHAR(128),
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(256),
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_ref TEXT,
  ADD COLUMN IF NOT EXISTS last_error VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_plan_steps_idempotency
  ON agent_plan_steps (plan_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_plan_steps_lease
  ON agent_plan_steps (plan_id, status, lease_until);
