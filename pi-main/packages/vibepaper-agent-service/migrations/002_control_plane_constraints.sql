ALTER TABLE drama_series ADD COLUMN IF NOT EXISTS owner_id BIGINT;
ALTER TABLE agent_messages ADD CONSTRAINT fk_agent_messages_session FOREIGN KEY (session_id) REFERENCES agent_sessions(id) NOT VALID;
ALTER TABLE agent_actions ADD CONSTRAINT fk_agent_actions_session FOREIGN KEY (session_id) REFERENCES agent_sessions(id) NOT VALID;
ALTER TABLE agent_approvals ADD CONSTRAINT fk_agent_approvals_action FOREIGN KEY (action_id) REFERENCES agent_actions(id) NOT VALID;
ALTER TABLE agent_approvals ADD CONSTRAINT fk_agent_approvals_session FOREIGN KEY (session_id) REFERENCES agent_sessions(id) NOT VALID;
ALTER TABLE agent_wakeup_notices ADD CONSTRAINT fk_agent_wakeup_session FOREIGN KEY (session_id) REFERENCES agent_sessions(id) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_approvals_action_id ON agent_approvals (action_id);
ALTER TABLE agent_actions ADD CONSTRAINT ck_agent_actions_status CHECK (status IN ('planned','awaiting_approval','approved','rejected','running','succeeded','failed','compensation_required')) NOT VALID;
ALTER TABLE agent_approvals ADD CONSTRAINT ck_agent_approvals_status CHECK (status IN ('pending','consumed','rejected','expired')) NOT VALID;
