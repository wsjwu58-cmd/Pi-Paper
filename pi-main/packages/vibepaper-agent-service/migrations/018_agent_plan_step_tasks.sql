ALTER TABLE agent_plan_steps
  ADD COLUMN IF NOT EXISTS task_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_plan_steps_task
  ON agent_plan_steps (task_id)
  WHERE task_id IS NOT NULL;
