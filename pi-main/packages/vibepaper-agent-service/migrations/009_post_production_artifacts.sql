CREATE TABLE IF NOT EXISTS media_artifacts (
  id BIGINT PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  kind VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'accepted',
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  language VARCHAR(32),
  voice_id VARCHAR(128),
  task_id VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  lineage_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  segments JSONB NOT NULL DEFAULT '[]'::jsonb,
  dedupe_key VARCHAR(512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind IN ('video','tts','subtitle','composite')),
  CHECK (status IN ('draft','accepted','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_artifacts_dedupe_key
  ON media_artifacts (owner_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_artifacts_idempotency_key
  ON media_artifacts (owner_id, idempotency_key);
CREATE INDEX IF NOT EXISTS ix_media_artifacts_owner_created
  ON media_artifacts (owner_id, created_at DESC);
