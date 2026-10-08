ALTER TABLE agent_render_batches
  ADD COLUMN IF NOT EXISTS session_id BIGINT,
  ADD COLUMN IF NOT EXISTS canvas_version INTEGER,
  ADD COLUMN IF NOT EXISTS approval_action_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_render_batches_approval_action
  ON agent_render_batches (approval_action_id)
  WHERE approval_action_id IS NOT NULL;
