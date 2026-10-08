ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS active_run_id BIGINT;

CREATE TABLE IF NOT EXISTS agent_runs (
  id BIGINT PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES agent_sessions(id),
  idempotency_key VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'queued',
  event_seq INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, idempotency_key),
  CHECK (status IN ('queued','running','waiting_confirmation','waiting_task','completed','failed','aborted'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_active_session
  ON agent_runs (session_id)
  WHERE status IN ('queued','running','waiting_confirmation','waiting_task');
CREATE INDEX IF NOT EXISTS ix_agent_runs_session_created ON agent_runs (session_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_run_events (
  event_id BIGINT PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES agent_runs(id),
  session_id BIGINT NOT NULL REFERENCES agent_sessions(id),
  event_seq INTEGER NOT NULL,
  type VARCHAR(32) NOT NULL,
  runtime VARCHAR(16) NOT NULL DEFAULT 'pi',
  runtime_version VARCHAR(32) NOT NULL DEFAULT '0.1.0',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(run_id, event_seq)
);
CREATE INDEX IF NOT EXISTS ix_agent_run_events_session_seq ON agent_run_events (session_id, event_seq);

CREATE TABLE IF NOT EXISTS agent_event_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_id BIGINT NOT NULL UNIQUE REFERENCES agent_run_events(event_id),
  run_id BIGINT NOT NULL REFERENCES agent_runs(id),
  session_id BIGINT NOT NULL REFERENCES agent_sessions(id),
  event_seq INTEGER NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_agent_event_outbox_pending ON agent_event_outbox (created_at, id) WHERE published_at IS NULL;
