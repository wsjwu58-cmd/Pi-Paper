CREATE TABLE IF NOT EXISTS story_bibles (
  id BIGINT PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  title VARCHAR(255) NOT NULL,
  canon TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS story_episodes (
  id BIGINT PRIMARY KEY,
  bible_id BIGINT NOT NULL REFERENCES story_bibles(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL,
  episode_no INTEGER NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  UNIQUE(bible_id, episode_no)
);

CREATE TABLE IF NOT EXISTS story_scenes (
  id BIGINT PRIMARY KEY,
  episode_id BIGINT NOT NULL REFERENCES story_episodes(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL,
  scene_no INTEGER NOT NULL,
  summary TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  UNIQUE(episode_id, scene_no)
);

CREATE TABLE IF NOT EXISTS continuity_facts (
  id BIGINT PRIMARY KEY,
  scene_id BIGINT NOT NULL REFERENCES story_scenes(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL,
  statement TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS foreshadows (
  id BIGINT PRIMARY KEY,
  scene_id BIGINT NOT NULL REFERENCES story_scenes(id) ON DELETE CASCADE,
  owner_id BIGINT NOT NULL,
  clue TEXT NOT NULL,
  payoff TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'planted',
  resolved_at TIMESTAMPTZ
);
