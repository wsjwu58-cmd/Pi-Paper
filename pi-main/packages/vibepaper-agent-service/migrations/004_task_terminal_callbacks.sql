-- Task terminal callbacks are keyed by task_id and are safe to replay.
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS task_id VARCHAR(64);
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS run_id BIGINT REFERENCES agent_runs(id);
CREATE INDEX IF NOT EXISTS ix_agent_actions_task_id ON agent_actions (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_agent_wakeup_notices_task_status ON agent_wakeup_notices (task_id, terminal_status, id DESC);

CREATE TABLE IF NOT EXISTS agent_task_terminal_conflicts (
  id BIGINT PRIMARY KEY,
  task_id VARCHAR(64) NOT NULL,
  previous_status VARCHAR(32) NOT NULL,
  received_status VARCHAR(32) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
