ALTER TABLE agent_render_jobs
  ADD COLUMN IF NOT EXISTS input_hash VARCHAR(64);

UPDATE agent_render_jobs
SET input_hash = md5(concat(shot_id, ':', keyframe_render_id)) || md5(concat(keyframe_render_id, ':', shot_id))
WHERE input_hash IS NULL;

ALTER TABLE agent_render_jobs
  ALTER COLUMN input_hash SET NOT NULL;
