CREATE TABLE IF NOT EXISTS agent_artifacts (
  id BIGINT PRIMARY KEY,
  plan_id BIGINT NOT NULL REFERENCES agent_plans(id) ON DELETE CASCADE,
  producer_role VARCHAR(32) NOT NULL,
  schema_version INTEGER NOT NULL,
  content JSONB NOT NULL,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_agent_artifacts_role CHECK (producer_role IN ('lead', 'script', 'storyboard', 'visual', 'audit')),
  CONSTRAINT chk_agent_artifacts_schema_version CHECK (schema_version >= 1),
  CONSTRAINT chk_agent_artifacts_evidence_refs_array CHECK (jsonb_typeof(evidence_refs) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_agent_artifacts_plan_created
  ON agent_artifacts (plan_id, created_at, id);
