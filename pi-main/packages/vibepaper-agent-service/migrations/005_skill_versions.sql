CREATE TABLE IF NOT EXISTS skill_versions (
  id BIGINT PRIMARY KEY,
  skill_id BIGINT NOT NULL REFERENCES skills(id),
  version INTEGER NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  content TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(skill_id, version),
  UNIQUE(skill_id, content_hash)
);
