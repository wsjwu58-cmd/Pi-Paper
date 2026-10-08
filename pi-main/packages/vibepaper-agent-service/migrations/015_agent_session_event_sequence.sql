ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS event_seq INTEGER NOT NULL DEFAULT 0;

UPDATE agent_sessions AS sessions
SET event_seq = GREATEST(
  sessions.event_seq,
  COALESCE((SELECT MAX(events.event_seq) FROM agent_run_events AS events WHERE events.session_id = sessions.id), 0)
);
