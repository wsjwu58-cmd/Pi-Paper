const nativeFs = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { backup, DatabaseSync } = require('node:sqlite')
const { imageThumbnail } = require('./asset-thumbnail.cjs')
const { AGNES_MODELS, AGNES_PROVIDER_ID } = require('./agnes-model-catalog.cjs')
const { ARK_MODELS, ARK_PROVIDER_ID } = require('./ark-model-catalog.cjs')

const PROJECT_SCHEMA_VERSION = 1
const CANVAS_SCHEMA_VERSION = 1
const CANVAS_EXPORT_SCHEMA_VERSION = '1.0.0'
const PROJECT_DB_SCHEMA_VERSION = 17
const PROJECT_BACKUP_SCHEMA_VERSION = 2
const MAX_NODES = 10_000
const MAX_EDGES = 20_000
const MAX_CANVAS_BYTES = 32 * 1024 * 1024
const MAX_ASSET_BYTES = 200 * 1024 * 1024
const MAX_TASK_INPUT_BYTES = 1024 * 1024
const MAX_TASK_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024
const MAX_TASK_SEARCH_PAGE = 1_000_000
const MAX_TASK_SEARCH_PAGE_SIZE = 100
const COMPOSE_PROVIDER_ID = 'mock-compose'
const COMPOSE_MODEL_ID = 'compose-1.0'
const TASK_SEARCH_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'compose'])
const TASK_SEARCH_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'])
const MAX_AGENT_BACKUP_BYTES = 4 * 1024 * 1024 * 1024
const MAX_AGENT_BACKUP_FILES = 100_000
const MAX_AGENT_SESSION_HEADER_BYTES = 1024 * 1024
const AGENT_BACKUP_DIRECTORIES = new Set(['sessions', 'memory', 'skills', 'session-memory', 'daily-memory', 'fragments'])
const AGENT_BACKUP_EXTENSIONS = new Set(['.jsonl', '.json', '.md', '.zst'])
const DIRECTOR_CAPTURE_ASSET_URL = /^vibe:\/\/app\/assets\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu
const EDGE_COMPATIBLE_TARGET_TYPES = Object.freeze({
  text: new Set(['text', 'image', 'video', 'audio', 'director']),
  image: new Set(['image', 'video', 'director']),
  video: new Set(['video', 'compose']),
  audio: new Set(['audio', 'video']),
  compose: new Set(['video', 'compose']),
  director: new Set(['image', 'video']),
})
const ASSET_NODE_MIME_PREFIX = Object.freeze({
  image: 'image/',
  video: 'video/',
  audio: 'audio/',
  text: 'text/',
  director: 'image/',
})
const ASSET_NODE_LABEL = Object.freeze({ image: '图片', video: '视频', audio: '音频', text: '文本', director: '导演台' })

const ASSET_DB_SCHEMA = `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN (
      'image/png', 'image/jpeg', 'image/gif', 'image/webp',
      'video/mp4', 'video/quicktime', 'video/webm',
      'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/mp4',
      'text/plain', 'text/markdown'
    )),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
    relative_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
  ) STRICT;

  CREATE INDEX assets_by_sha ON assets(sha256, deleted);

  CREATE TABLE asset_references (
    canvas_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    PRIMARY KEY (canvas_id, node_id, asset_id),
    FOREIGN KEY (canvas_id, node_id) REFERENCES nodes(canvas_id, id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT
  ) STRICT;

  CREATE INDEX asset_references_by_asset ON asset_references(asset_id);
`

const TASK_DB_SCHEMA = `
  CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 255),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    canvas_version INTEGER NOT NULL CHECK (canvas_version >= 0),
    node_id TEXT,
    modality TEXT NOT NULL CHECK (modality IN ('text', 'image', 'audio', 'video', 'compose')),
    provider_type TEXT NOT NULL CHECK (provider_type IN ('local', 'cloud')),
    provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 160),
    model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
    input_json TEXT NOT NULL CHECK (json_valid(input_json)),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    output_path TEXT,
    output_sha256 TEXT CHECK (output_sha256 IS NULL OR length(output_sha256) = 64),
    output_size_bytes INTEGER CHECK (output_size_bytes IS NULL OR output_size_bytes > 0),
    error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 120),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    CHECK (
      (status = 'succeeded' AND output_path IS NOT NULL AND output_sha256 IS NOT NULL AND output_size_bytes IS NOT NULL)
      OR (status <> 'succeeded' AND output_path IS NULL AND output_sha256 IS NULL AND output_size_bytes IS NULL)
    )
  ) STRICT;

  CREATE INDEX tasks_by_status ON tasks(status, created_at);
  CREATE INDEX tasks_by_canvas ON tasks(canvas_id, created_at);

  CREATE TABLE task_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    event_seq INTEGER NOT NULL CHECK (event_seq > 0),
    type TEXT NOT NULL CHECK (type IN ('created', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    created_at TEXT NOT NULL,
    UNIQUE (task_id, event_seq)
  ) STRICT;
`

const TASK_OUTPUTS_DB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_outputs (
    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
    output_index INTEGER NOT NULL CHECK (output_index >= 0 AND output_index < 4),
    output_path TEXT NOT NULL,
    output_sha256 TEXT NOT NULL CHECK (length(output_sha256) = 64),
    output_size_bytes INTEGER NOT NULL CHECK (output_size_bytes > 0),
    output_metadata_json TEXT CHECK (output_metadata_json IS NULL OR json_valid(output_metadata_json)),
    PRIMARY KEY (task_id, output_index),
    UNIQUE (task_id, output_path)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS task_outputs_by_task ON task_outputs(task_id, output_index);
`

const CANVAS_GRAPH_COMMANDS_DB_SCHEMA = `
  CREATE TABLE canvas_graph_commands (
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
    result_canvas_version INTEGER CHECK (result_canvas_version IS NULL OR result_canvas_version >= 0),
    result_snapshot TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result_snapshot)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (canvas_id, idempotency_key)
  ) STRICT;
`

const CANVAS_GROUP_STACK_DB_SCHEMA = `
  CREATE TABLE canvas_groups (
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    layout TEXT NOT NULL,
    node_ids_json TEXT NOT NULL CHECK (json_valid(node_ids_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (canvas_id, id)
  ) STRICT;

  CREATE TABLE canvas_stacks (
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    collapsed INTEGER NOT NULL CHECK (collapsed IN (0, 1)),
    node_ids_json TEXT NOT NULL CHECK (json_valid(node_ids_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (canvas_id, id)
  ) STRICT;
`

const DRAMA_ASSET_TYPES = Object.freeze([
  'series_bible', 'episode', 'scene', 'character_profile', 'character_look',
  'shot_spec', 'continuity_constraint', 'audio_cue', 'subtitle_cue',
])

const DRAMA_ASSETS_DB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS drama_assets (
    asset_id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL CHECK (asset_type IN (
      'series_bible', 'episode', 'scene', 'character_profile', 'character_look',
      'shot_spec', 'continuity_constraint', 'audio_cue', 'subtitle_cue'
    )),
    asset_version INTEGER NOT NULL CHECK (asset_version >= 1),
    canvas_version INTEGER NOT NULL CHECK (canvas_version >= 0),
    data_json TEXT NOT NULL CHECK (json_valid(data_json) AND json_type(data_json) = 'object'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (canvas_id, asset_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_assets_by_canvas ON drama_assets(canvas_id, created_at, asset_id);

  CREATE TABLE IF NOT EXISTS drama_asset_commands (
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    asset_id TEXT NOT NULL REFERENCES drama_assets(asset_id) ON DELETE RESTRICT,
    asset_type TEXT NOT NULL CHECK (asset_type IN (
      'series_bible', 'episode', 'scene', 'character_profile', 'character_look',
      'shot_spec', 'continuity_constraint', 'audio_cue', 'subtitle_cue'
    )),
    asset_version INTEGER NOT NULL CHECK (asset_version >= 1),
    result_canvas_version INTEGER NOT NULL CHECK (result_canvas_version >= 1),
    asset_data_snapshot TEXT NOT NULL CHECK (json_valid(asset_data_snapshot) AND json_type(asset_data_snapshot) = 'object'),
    created_at TEXT NOT NULL,
    PRIMARY KEY (canvas_id, idempotency_key)
  ) STRICT;
`

// Schema installed by the historical v14 -> v15 migration. Keep this baseline
// separate from the v17 fresh-project schema so the subsequent v16 -> v17
// migration can add the new columns exactly once.
const DRAMA_PIPELINE_DB_SCHEMA_V15 = `
  CREATE TABLE IF NOT EXISTS drama_render_batches (
    batch_id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    series_id TEXT NOT NULL,
    episode_no INTEGER NOT NULL CHECK (episode_no > 0),
    estimated_cost INTEGER NOT NULL CHECK (estimated_cost >= 0),
    status TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'running', 'partial', 'completed', 'failed')),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    session_id TEXT,
    canvas_version INTEGER CHECK (canvas_version IS NULL OR canvas_version >= 0),
    approval_action_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (canvas_id, idempotency_key)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_render_batches_by_canvas
    ON drama_render_batches(canvas_id, created_at DESC, batch_id);

  CREATE TABLE IF NOT EXISTS drama_render_jobs (
    job_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES drama_render_batches(batch_id) ON DELETE CASCADE,
    shot_id TEXT NOT NULL,
    keyframe_render_id TEXT NOT NULL,
    canvas_node_id TEXT,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 2 AND 5),
    model_type TEXT NOT NULL,
    model_params_json TEXT NOT NULL CHECK (json_valid(model_params_json) AND json_type(model_params_json) = 'object'),
    estimated_cost INTEGER NOT NULL CHECK (estimated_cost >= 0),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'completed', 'failed')),
    task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (batch_id, shot_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_render_jobs_by_batch_status
    ON drama_render_jobs(batch_id, status);
  CREATE INDEX IF NOT EXISTS drama_render_jobs_by_task ON drama_render_jobs(task_id);

  CREATE TABLE IF NOT EXISTS render_reviews (
    review_id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL,
    target_kind TEXT NOT NULL DEFAULT 'clip',
    scores_json TEXT NOT NULL CHECK (json_valid(scores_json) AND json_type(scores_json) = 'object'),
    failures_json TEXT NOT NULL CHECK (json_valid(failures_json) AND json_type(failures_json) = 'array'),
    recommended_action TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
    retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
    status TEXT NOT NULL CHECK (status IN ('pass', 'fail')),
    source_task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS render_reviews_by_canvas_node
    ON render_reviews(canvas_id, target_node_id, created_at DESC);
`

const DRAMA_PIPELINE_DB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS drama_render_batches (
    batch_id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    series_id TEXT NOT NULL,
    episode_no INTEGER NOT NULL CHECK (episode_no > 0),
    estimated_cost INTEGER NOT NULL CHECK (estimated_cost >= 0),
    status TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'running', 'partial', 'completed', 'failed')),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    request_hash TEXT NOT NULL DEFAULT '' CHECK (request_hash = '' OR length(request_hash) = 64),
    session_id TEXT,
    canvas_version INTEGER CHECK (canvas_version IS NULL OR canvas_version >= 0),
    approval_action_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (canvas_id, idempotency_key)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_render_batches_by_canvas
    ON drama_render_batches(canvas_id, created_at DESC, batch_id);

  CREATE TABLE IF NOT EXISTS drama_render_jobs (
    job_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES drama_render_batches(batch_id) ON DELETE CASCADE,
    shot_id TEXT NOT NULL,
    keyframe_render_id TEXT NOT NULL,
    canvas_node_id TEXT,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 2 AND 5),
    model_type TEXT NOT NULL,
    provider_type TEXT NOT NULL DEFAULT 'cloud' CHECK (provider_type IN ('local', 'cloud')),
    provider_id TEXT NOT NULL DEFAULT 'agnes',
    model_id TEXT NOT NULL DEFAULT 'video',
    model_params_json TEXT NOT NULL CHECK (json_valid(model_params_json) AND json_type(model_params_json) = 'object'),
    estimated_cost INTEGER NOT NULL CHECK (estimated_cost >= 0),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'completed', 'failed')),
    task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    error_code TEXT,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (batch_id, shot_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_render_jobs_by_batch_status
    ON drama_render_jobs(batch_id, status);
  CREATE INDEX IF NOT EXISTS drama_render_jobs_by_task ON drama_render_jobs(task_id);

  CREATE TABLE IF NOT EXISTS drama_render_confirmations (
    confirmation_id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL REFERENCES drama_render_batches(batch_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('submit', 'rerun')),
    job_id TEXT REFERENCES drama_render_jobs(job_id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
    token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
    canvas_version INTEGER NOT NULL CHECK (canvas_version >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'invalidated')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_render_confirmations_by_batch
    ON drama_render_confirmations(batch_id, created_at DESC, confirmation_id);

  CREATE TABLE IF NOT EXISTS render_reviews (
    review_id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL,
    target_kind TEXT NOT NULL DEFAULT 'clip',
    scores_json TEXT NOT NULL CHECK (json_valid(scores_json) AND json_type(scores_json) = 'object'),
    failures_json TEXT NOT NULL CHECK (json_valid(failures_json) AND json_type(failures_json) = 'array'),
    recommended_action TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json) AND json_type(evidence_json) = 'object'),
    retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
    status TEXT NOT NULL CHECK (status IN ('pass', 'fail')),
    source_task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS render_reviews_by_canvas_node
    ON render_reviews(canvas_id, target_node_id, created_at DESC);
`

const DRAMA_STATE_DB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS drama_series (
    id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    active_canon_revision INTEGER NOT NULL,
    format_json TEXT NOT NULL CHECK (json_valid(format_json) AND json_type(format_json) = 'object'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_series_by_canvas ON drama_series(canvas_id, created_at, id);

  CREATE TABLE IF NOT EXISTS drama_characters (
    id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL REFERENCES drama_series(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    identity_anchors_json TEXT NOT NULL CHECK (json_valid(identity_anchors_json) AND json_type(identity_anchors_json) = 'array'),
    active_look_revision INTEGER NOT NULL,
    voice_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_characters_by_series ON drama_characters(series_id, created_at, id);

  CREATE TABLE IF NOT EXISTS drama_reference_packs (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES drama_characters(id) ON DELETE CASCADE,
    look_revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'retired')),
    front_asset_id TEXT NOT NULL,
    side_asset_id TEXT NOT NULL,
    back_asset_id TEXT NOT NULL,
    expression_asset_ids_json TEXT NOT NULL CHECK (json_valid(expression_asset_ids_json) AND json_type(expression_asset_ids_json) = 'array'),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_reference_packs_by_character_look
    ON drama_reference_packs(character_id, look_revision, status, created_at, id);

  CREATE TABLE IF NOT EXISTS drama_shots (
    id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL REFERENCES drama_series(id) ON DELETE CASCADE,
    episode_no INTEGER NOT NULL,
    shot_no INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    character_bindings_json TEXT NOT NULL CHECK (json_valid(character_bindings_json) AND json_type(character_bindings_json) = 'array'),
    prompt_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (series_id, episode_no, shot_no)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_shots_by_series_episode ON drama_shots(series_id, episode_no, shot_no);

  CREATE TABLE IF NOT EXISTS drama_keyframes (
    id TEXT PRIMARY KEY,
    shot_id TEXT NOT NULL REFERENCES drama_shots(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('draft', 'accepted', 'rejected', 'stale')),
    reference_pack_ids_json TEXT NOT NULL CHECK (json_valid(reference_pack_ids_json) AND json_type(reference_pack_ids_json) = 'array'),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_keyframes_by_shot_status ON drama_keyframes(shot_id, status, created_at DESC, id DESC);

  CREATE TABLE IF NOT EXISTS drama_render_lineages (
    id TEXT PRIMARY KEY,
    shot_id TEXT NOT NULL REFERENCES drama_shots(id) ON DELETE CASCADE,
    keyframe_render_id TEXT NOT NULL REFERENCES drama_keyframes(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'ready_for_video', 'submitted', 'stale')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drama_render_lineages_by_shot_status
    ON drama_render_lineages(shot_id, status, created_at, id);

  CREATE TABLE IF NOT EXISTS drama_state_commands (
    canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
    operation TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 64),
    input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (canvas_id, idempotency_key)
  ) STRICT;
`

const PROJECT_DB_SCHEMA = `
  CREATE TABLE project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE canvases (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version >= 0),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE nodes (
    canvas_id TEXT NOT NULL,
    id TEXT NOT NULL,
    position_x REAL NOT NULL,
    position_y REAL NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (canvas_id, id),
    FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE edges (
    canvas_id TEXT NOT NULL,
    id TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (canvas_id, id),
    FOREIGN KEY (canvas_id, source_node_id) REFERENCES nodes(canvas_id, id) ON DELETE CASCADE,
    FOREIGN KEY (canvas_id, target_node_id) REFERENCES nodes(canvas_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX edges_by_source ON edges(canvas_id, source_node_id);
  CREATE INDEX edges_by_target ON edges(canvas_id, target_node_id);
  ${ASSET_DB_SCHEMA}
  ${TASK_DB_SCHEMA}
  ${TASK_OUTPUTS_DB_SCHEMA}
  ${CANVAS_GRAPH_COMMANDS_DB_SCHEMA}
  ${CANVAS_GROUP_STACK_DB_SCHEMA}
  ${DRAMA_ASSETS_DB_SCHEMA}
  ${DRAMA_PIPELINE_DB_SCHEMA}
  ${DRAMA_STATE_DB_SCHEMA}
`

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateProjectName(value) {
  if (typeof value !== 'string') throw new Error('请输入项目名称。')
  const name = value.trim()
  if (!name || name.length > 60 || /[<>:"/\\|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name)) {
    throw new Error('项目名称需为 1–60 个字符，且不能包含系统保留字符。')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) {
    throw new Error('该项目名称被操作系统保留，请换一个名称。')
  }
  return name
}

function publicProject(metadata) {
  return {
    projectId: metadata.projectId,
    canvasId: metadata.canvasId,
    name: metadata.name,
  }
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content)
}

async function readProjectMetadata(dataDirectory) {
  const metadataPath = path.join(dataDirectory, 'project.json')
  const info = await fs.lstat(metadataPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('项目元数据缺失或路径无效。')
  return readJson(metadataPath)
}

async function readProjectLegacyCanvas(dataDirectory, metadata) {
  const canvasPath = path.join(dataDirectory, 'canvas.json')
  const info = await fs.lstat(canvasPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('项目缺少画布数据库和可迁移的画布文件。')
  return validateLegacyCanvas(await readJson(canvasPath), metadata)
}

async function writeJsonAtomically(filePath, value) {
  const parent = path.dirname(filePath)
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  await fs.mkdir(parent, { recursive: true })
  let handle
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function publishStagedDirectory(stagingPath, destinationPath) {
  const staging = path.resolve(stagingPath)
  const destination = path.resolve(destinationPath)
  if (path.dirname(staging) !== path.dirname(destination)) {
    throw new Error('备份发布路径必须位于同一父目录。')
  }

  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fs.lstat(destination).then(() => {
        const error = new Error('发布目标已存在，未覆盖现有目录。')
        error.code = 'EEXIST'
        throw error
      }, (error) => {
        if (nodeErrorCode(error) !== 'ENOENT') throw error
      })
      await fs.rename(staging, destination)
      return
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(nodeErrorCode(error)) || attempt === 3) throw error
      // Windows security scanners can briefly hold a newly written SQLite backup directory.
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
  throw lastError
}

function validateGraph(nodes, edges) {
  if (!Array.isArray(nodes) || nodes.length > MAX_NODES) throw new Error('画布节点数据无效或超过上限。')
  if (!Array.isArray(edges) || edges.length > MAX_EDGES) throw new Error('画布连线数据无效或超过上限。')

  const nodeIds = new Set()
  const nodeTypes = new Map()
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || node.id.length > 256 || nodeIds.has(node.id)) {
      throw new Error('画布包含无效或重复的节点。')
    }
    if (!isRecord(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || !isRecord(node.data)) {
      throw new Error('画布节点缺少有效的位置或数据。')
    }
    if (typeof node.type !== 'string' || !Object.hasOwn(EDGE_COMPATIBLE_TARGET_TYPES, node.type)) {
      throw new Error(`非法节点类型: ${String(node.type)}`)
    }
    nodeIds.add(node.id)
    nodeTypes.set(node.id, node.type)
  }

  const edgeIds = new Set()
  const validatedEdges = []
  for (const edge of edges) {
    if (!isRecord(edge)) {
      throw new Error('画布包含无效或重复的连线。')
    }
    if (typeof edge.id !== 'string' || !edge.id) {
      throw new Error('画布包含无效或重复的连线。')
    }
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      throw new Error('画布连线引用了不存在的节点。')
    }
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      // CanvasService.saveCanvas only persists edges whose endpoints both
      // belong to the submitted graph. Keep the same behavior for snapshots.
      continue
    }
    if (edgeIds.has(edge.id)) {
      throw new Error('画布包含无效或重复的连线。')
    }
    edgeIds.add(edge.id)

    const sourceType = nodeTypes.get(edge.source)
    const targetType = nodeTypes.get(edge.target)
    const compatible = EDGE_COMPATIBLE_TARGET_TYPES[sourceType].has(targetType)
    const originalData = isRecord(edge.data) ? edge.data : {}
    const originalPayload = isRecord(originalData.edge) ? originalData.edge : {}
    const requestedValidity = originalPayload.valid ?? originalData.valid
    const valid = compatible && requestedValidity !== false
    const sourcePort = edge.sourceHandle ?? originalPayload.sourcePort ?? 'output'
    const targetPort = edge.targetHandle ?? originalPayload.targetPort ?? 'input'
    const dependencyType = originalPayload.dependencyType ?? edge.dependencyType ?? 'reference'

    // Keep the same validity payload that the Web canvas derives from
    // CanvasService.toEdgePayload(). This lets the renderer show incompatible
    // edges as invalid while preserving the user's graph for later repair.
    validatedEdges.push({
      ...edge,
      data: {
        ...originalData,
        valid,
        edge: {
          ...originalPayload,
          id: edge.id,
          sourceNodeId: edge.source,
          sourcePort,
          targetNodeId: edge.target,
          targetPort,
          valid,
          dependencyType,
        },
      },
    })
  }

  const graph = JSON.parse(JSON.stringify({ nodes, edges: validatedEdges }))
  if (Buffer.byteLength(JSON.stringify(graph), 'utf8') > MAX_CANVAS_BYTES) throw new Error('画布数据超过本地项目的单次保存上限。')
  return graph
}

function validateMetadata(metadata) {
  if (!isRecord(metadata) || metadata.schemaVersion !== PROJECT_SCHEMA_VERSION
    || typeof metadata.projectId !== 'string' || !metadata.projectId
    || typeof metadata.canvasId !== 'string' || !metadata.canvasId
    || typeof metadata.name !== 'string') {
    throw new Error('所选文件夹的项目格式不受支持。')
  }
}

function validateLegacyCanvas(canvas, metadata) {
  if (!isRecord(canvas) || canvas.schemaVersion !== CANVAS_SCHEMA_VERSION
    || canvas.projectId !== metadata.projectId || canvas.canvasId !== metadata.canvasId
    || !Number.isSafeInteger(canvas.version) || canvas.version < 0) {
    throw new Error('项目画布文件损坏或版本不受支持。')
  }
  const graph = validateGraph(canvas.nodes, canvas.edges)
  return { schemaVersion: CANVAS_SCHEMA_VERSION, ...canvas, ...graph }
}

function databaseVersion(database) {
  const row = database.prepare('PRAGMA user_version').get()
  return Number(row.user_version)
}

function taskFromRow(row) {
  let outputs = []
  if (typeof row.outputs_json === 'string') {
    try {
      outputs = JSON.parse(row.outputs_json)
    } catch {
      outputs = []
    }
  }
  if (outputs.length === 0 && row.status === 'succeeded' && typeof row.output_path === 'string') {
    outputs = [{
      index: 0,
      outputPath: row.output_path,
      sha256: row.output_sha256,
      sizeBytes: row.output_size_bytes,
      outputMeta: null,
    }]
  }
  return {
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    canvasId: row.canvas_id,
    canvasVersion: row.canvas_version,
    nodeId: row.node_id,
    modality: row.modality,
    providerType: row.provider_type,
    providerId: row.provider_id,
    modelId: row.model_id,
    status: row.status,
    attemptCount: row.attempt_count,
    outputPath: row.output_path,
    outputSha256: row.output_sha256,
    outputSizeBytes: row.output_size_bytes,
    errorCode: row.error_code,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    outputs,
    ...(typeof row.output_metadata === 'string' ? { outputMeta: JSON.parse(row.output_metadata) } : {}),
  }
}

const TASKS_WITH_OUTPUT_METADATA = `
  SELECT tasks.*,
    (SELECT json_extract(events.data_json, '$.outputMeta')
      FROM task_events AS events
      WHERE events.task_id = tasks.task_id AND events.type = 'succeeded'
      ORDER BY events.event_seq DESC LIMIT 1) AS output_metadata,
    CASE WHEN tasks.status = 'failed' THEN (
      SELECT json_extract(events.data_json, '$.errorMessage')
      FROM task_events AS events
      WHERE events.task_id = tasks.task_id AND events.type = 'failed'
      ORDER BY events.event_seq DESC LIMIT 1
    ) ELSE NULL END AS error_message,
    (SELECT COALESCE(json_group_array(json(output_json)), '[]') FROM (
      SELECT json_object(
        'index', task_outputs.output_index,
        'outputPath', task_outputs.output_path,
        'sha256', task_outputs.output_sha256,
        'sizeBytes', task_outputs.output_size_bytes,
        'outputMeta', CASE WHEN task_outputs.output_metadata_json IS NULL
          THEN NULL ELSE json(task_outputs.output_metadata_json) END
      ) AS output_json
      FROM task_outputs WHERE task_outputs.task_id = tasks.task_id
      ORDER BY task_outputs.output_index
    )) AS outputs_json
  FROM tasks
`

function normalizeAudioOutputMeta(value) {
  if (!isRecord(value) || value.index !== 0 || value.outputType !== 'audio'
    || typeof value.voiceId !== 'string' || value.voiceId.length > 256
    || typeof value.language !== 'string' || value.language.length > 100
    || !Number.isSafeInteger(value.rate) || value.rate < -10 || value.rate > 10
    || typeof value.toneApplied !== 'boolean'
    || typeof value.textHash !== 'string' || !/^[a-f0-9]{64}$/iu.test(value.textHash)
    || !Number.isSafeInteger(value.durationMs) || value.durationMs < 0
    || !Number.isSafeInteger(value.sampleRate) || value.sampleRate < 8_000 || value.sampleRate > 384_000
    || value.providerId !== undefined && value.providerId !== 'local-sapi-tts'
    || value.provider !== undefined && value.provider !== 'local-sapi-tts') return null
  return {
    index: 0,
    outputType: 'audio',
    voiceId: value.voiceId,
    language: value.language,
    rate: value.rate,
    toneApplied: value.toneApplied,
    textHash: value.textHash,
    durationMs: value.durationMs,
    sampleRate: value.sampleRate,
    provider: 'local-sapi-tts',
  }
}

function normalizeLocalMediaOutputMeta(value, task, parameters) {
  if (task.provider_type !== 'local' || task.provider_id !== 'local-media-tools') return null
  const operation = typeof parameters?.operation === 'string' ? parameters.operation : ''
  const allowed = task.modality === 'image'
    ? new Set(['裁剪', '三视图'])
    : task.modality === 'video' ? new Set(['剪辑', '提帧', '超分']) : new Set()
  const outputType = operation === '提帧' ? 'image' : task.modality
  if (!allowed.has(operation) || !isRecord(value) || value.index !== 0
    || value.operation !== operation || value.outputType !== outputType) return null
  if (operation === '三视图' && !['人物', '场景', '产品'].includes(value.category)) return null
  return {
    index: 0,
    operation,
    outputType,
    ...(operation === '三视图' ? { category: value.category } : {}),
  }
}

function appendTaskEvent(database, taskId, type, data, createdAt = new Date().toISOString()) {
  const sequence = database.prepare('SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM task_events WHERE task_id = ?')
    .get(taskId).next_seq
  database.prepare(`
    INSERT INTO task_events (event_id, task_id, event_seq, type, data_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), taskId, sequence, type, JSON.stringify(data), createdAt)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
  }
  return value
}

function assertNoCredentialFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialFields(item)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)$/iu.test(key)) {
      throw new Error('密钥和凭据不能写入本地生成任务。')
    }
    assertNoCredentialFields(child)
  }
}

function normalizeTaskInput(input) {
  const modalities = ['text', 'image', 'audio', 'video', 'compose']
  const providerTypes = ['local', 'cloud']
  if (!isRecord(input)
    || typeof input.projectId !== 'string' || !input.projectId
    || typeof input.canvasId !== 'string' || !input.canvasId
    || !Number.isSafeInteger(input.canvasVersion) || input.canvasVersion < 0
    || (input.nodeId !== undefined && input.nodeId !== null && (typeof input.nodeId !== 'string' || !input.nodeId))
    || !modalities.includes(input.modality)
    || !providerTypes.includes(input.providerType)
    || typeof input.providerId !== 'string' || !input.providerId.trim() || input.providerId.length > 160
    || typeof input.modelId !== 'string' || !input.modelId.trim() || input.modelId.length > 200
    || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 255
    || (input.parameters !== undefined && !isRecord(input.parameters))) {
    throw new Error('本地生成任务参数无效。')
  }
  if (input.modality === 'compose') {
    const ids = input.parameters.inputNodeIds
    if (input.providerType !== 'local' || input.providerId.trim() !== COMPOSE_PROVIDER_ID
      || input.modelId.trim() !== COMPOSE_MODEL_ID || input.nodeId == null
      || input.parameters.operation !== 'compose'
      || !Array.isArray(ids) || ids.length < 2 || ids.length > MAX_NODES
      || ids.some((nodeId) => typeof nodeId !== 'string' || !nodeId.trim() || nodeId.length > 256)
      || input.parameters.count !== undefined && input.parameters.count !== 1
      || Object.hasOwn(input.parameters, 'inputUrls') || Object.hasOwn(input.parameters, 'inputs')
      || Object.hasOwn(input.parameters, 'inputTaskIds')) {
      throw new Error('合成任务输入无效：至少选择 2 个已连接的本地视频节点。')
    }
  }
  const requestedCount = input.parameters?.count
  if (requestedCount !== undefined && (!Number.isSafeInteger(requestedCount) || requestedCount < 1
    || (input.modality === 'image' ? requestedCount > 4 : requestedCount !== 1))) {
    throw new Error(input.modality === 'image' ? '图片生成数量必须为 1–4。' : '当前任务模态只支持生成 1 个结果。')
  }
  const parametersJson = JSON.stringify(input.parameters ?? {})
  if (Buffer.byteLength(parametersJson, 'utf8') > MAX_TASK_INPUT_BYTES) {
    throw new Error('生成任务输入超过本地保存上限。')
  }
  assertNoCredentialFields(JSON.parse(parametersJson))
  const canonicalInput = JSON.stringify(canonicalJson({
    canvasId: input.canvasId,
    canvasVersion: input.canvasVersion,
    nodeId: input.nodeId ?? null,
    modality: input.modality,
    providerType: input.providerType,
    providerId: input.providerId.trim(),
    modelId: input.modelId.trim(),
    parameters: JSON.parse(parametersJson),
  }))
  return {
    ...input,
    nodeId: input.nodeId ?? null,
    providerId: input.providerId.trim(),
    modelId: input.modelId.trim(),
    parametersJson,
    inputHash: createHash('sha256').update(canonicalInput).digest('hex'),
  }
}

function normalizeTaskSearchInput(input) {
  if (!isRecord(input)) throw new Error('任务搜索请求无效。')
  const page = input.page ?? 1
  const pageSize = input.pageSize ?? 20
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_TASK_SEARCH_PAGE
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_TASK_SEARCH_PAGE_SIZE) {
    throw new Error('任务搜索分页参数无效。')
  }

  const textFilter = (key) => {
    const value = input[key]
    if (value === undefined || value === null) return ''
    if (typeof value !== 'string' || value.length > 200) throw new Error('任务搜索条件无效。')
    return value.trim()
  }
  const keyword = textFilter('keyword')
  const model = textFilter('model')
  const modality = input.modality ?? ''
  const status = input.status ?? ''
  if (modality !== '' && (typeof modality !== 'string' || !TASK_SEARCH_MODALITIES.has(modality))) {
    throw new Error('任务模态筛选无效。')
  }
  if (status !== '' && (typeof status !== 'string' || !TASK_SEARCH_STATUSES.has(status))) {
    throw new Error('任务状态筛选无效。')
  }

  const timestamp = (key) => {
    const value = input[key]
    if (value === undefined || value === null) return null
    if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) {
      throw new Error('任务日期筛选无效。')
    }
    return value
  }
  const fromTime = timestamp('fromTime')
  const toTime = timestamp('toTime')
  if (fromTime !== null && toTime !== null && fromTime > toTime) {
    throw new Error('任务日期范围无效。')
  }

  return { page, pageSize, keyword, model, modality, status, fromTime, toTime }
}

function pickLatestNodeTask(tasks, currentOutputId) {
  if (currentOutputId !== undefined && currentOutputId !== null && String(currentOutputId)) {
    const pinned = tasks.find((task) => task.task_id === String(currentOutputId))
    if (pinned) return pinned
  }
  const inflight = tasks.find((task) => task.status === 'running' || task.status === 'queued')
  const succeeded = tasks.find((task) => task.status === 'succeeded' && task.output_path)
    ?? tasks.find((task) => task.status === 'succeeded')
  if (inflight && succeeded) {
    const inflightAt = Date.parse(inflight.created_at || '') || 0
    const succeededAt = Date.parse(succeeded.created_at || '') || 0
    return inflightAt > succeededAt ? inflight : succeeded
  }
  return inflight ?? succeeded ?? tasks[0] ?? null
}

function taskOperationFromInput(inputJson) {
  if (typeof inputJson !== 'string') return ''
  try {
    const parameters = JSON.parse(inputJson)
    return typeof parameters?.operation === 'string' ? parameters.operation : ''
  } catch {
    return ''
  }
}

function validateTaskOutputRelativePath(taskId, modality, relativePath, operation = '') {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(taskId)) {
    throw new Error('任务结果标识无效。')
  }
  const prefix = `generated/${taskId}/`
  if (typeof relativePath !== 'string' || !relativePath.startsWith(prefix)) {
    throw new Error('生成结果路径必须位于该任务的本地结果目录。')
  }
  const fileName = relativePath.slice(prefix.length)
  if (!/^[a-z0-9][a-z0-9._-]{0,126}$/iu.test(fileName) || fileName.includes('..')) {
    throw new Error('生成结果文件名无效。')
  }
  const extension = path.extname(fileName).toLowerCase()
  let allowed = {
    text: ['.txt', '.md', '.json'],
    image: ['.png', '.jpg', '.jpeg', '.webp'],
    audio: ['.mp3', '.wav', '.ogg', '.m4a'],
    video: ['.mp4', '.webm', '.mov'],
    compose: ['.mp4'],
  }[modality]
  if (modality === 'video' && operation === '提帧') {
    allowed = ['.png', '.jpg', '.jpeg', '.webp']
  }
  if (!allowed?.includes(extension)) throw new Error('生成结果文件格式与任务模态不匹配。')
  return relativePath
}

function taskOutputFingerprint(info) {
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`
}

async function resolveTaskOutputFile(dataDirectory, taskId, modality, relativePath, cached = null, operation = '') {
  validateTaskOutputRelativePath(taskId, modality, relativePath, operation)
  const generatedDirectory = path.join(dataDirectory, 'generated')
  const taskDirectory = path.join(generatedDirectory, taskId)
  for (const [directory, label] of [[generatedDirectory, '生成结果目录'], [taskDirectory, '任务结果目录']]) {
    const info = await fs.lstat(directory).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== '') {
      throw new Error(`${label}缺失或路径无效。`)
    }
  }
  const filePath = path.resolve(dataDirectory, ...relativePath.split('/'))
  const relativeToData = path.relative(dataDirectory, filePath)
  if (!relativeToData || relativeToData.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToData)) {
    throw new Error('生成结果路径越界。')
  }
  const info = await fs.lstat(filePath).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_TASK_OUTPUT_BYTES) {
    throw new Error('生成结果文件缺失、不可读或超过本地结果上限。')
  }
  const actualPath = await fs.realpath(filePath)
  if (path.relative(filePath, actualPath) !== '') throw new Error('生成结果不能是符号链接。')
  const fingerprint = taskOutputFingerprint(info)
  const digest = cached?.filePath === actualPath && cached.fingerprint === fingerprint
    ? cached.digest
    : await hashFile(actualPath)
  if (digest.sizeBytes <= 0 || digest.sizeBytes > MAX_TASK_OUTPUT_BYTES) {
    throw new Error('生成结果文件超过本地结果上限。')
  }
  return { filePath: actualPath, fingerprint, ...digest }
}

async function ensureTaskOutputDirectory(dataDirectory, taskId) {
  const generatedDirectory = path.join(dataDirectory, 'generated')
  const taskDirectory = path.join(generatedDirectory, taskId)
  for (const directory of [generatedDirectory, taskDirectory]) {
    await fs.mkdir(directory).catch((error) => {
      if (error?.code !== 'EEXIST') throw error
    })
    const info = await fs.lstat(directory).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink()
      || path.relative(directory, await fs.realpath(directory)) !== '') {
      throw new Error('任务结果目录缺失或路径无效。')
    }
  }
  return taskDirectory
}

async function copyProjectTaskOutputs(database, sourceDataDirectory, targetDataDirectory) {
  if (databaseVersion(database) < 3) return
  const tasks = database.prepare(`
    SELECT task_id, modality, input_json, output_path, output_sha256, output_size_bytes
    FROM tasks WHERE status = 'succeeded' ORDER BY task_id
  `).all()
  for (const task of tasks) {
    const operation = taskOperationFromInput(task.input_json)
    const rows = databaseVersion(database) >= 12
      ? database.prepare(`SELECT output_path, output_sha256, output_size_bytes, output_metadata_json FROM task_outputs
          WHERE task_id = ? ORDER BY output_index`).all(task.task_id)
      : []
    const outputs = rows.length > 0 ? rows : [task]
    for (const output of outputs) {
      const source = await resolveTaskOutputFile(sourceDataDirectory, task.task_id, task.modality, output.output_path, null, operation)
      if (source.sha256 !== output.output_sha256 || source.sizeBytes !== output.output_size_bytes) {
        throw new Error(`生成任务“${task.task_id}”的结果校验失败，项目备份未完成。`)
      }
      const targetPath = path.resolve(targetDataDirectory, ...output.output_path.split('/'))
      const relativeToTarget = path.relative(targetDataDirectory, targetPath)
      if (!relativeToTarget || relativeToTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToTarget)) {
        throw new Error('生成任务结果路径越界，无法备份。')
      }
      const targetTaskDirectory = path.dirname(targetPath)
      await fs.mkdir(targetTaskDirectory, { recursive: true })
      const targetDirectoryInfo = await fs.lstat(targetTaskDirectory)
      if (!targetDirectoryInfo.isDirectory() || targetDirectoryInfo.isSymbolicLink()
        || path.relative(targetTaskDirectory, await fs.realpath(targetTaskDirectory)) !== '') {
        throw new Error('项目备份中的任务结果目录无效。')
      }
      await fs.copyFile(source.filePath, targetPath)
      const copied = await resolveTaskOutputFile(targetDataDirectory, task.task_id, task.modality, output.output_path, null, operation)
      if (copied.sha256 !== output.output_sha256 || copied.sizeBytes !== output.output_size_bytes) {
        await fs.rm(targetPath, { force: true }).catch(() => undefined)
        throw new Error(`生成任务“${task.task_id}”的结果复制校验失败，项目备份未完成。`)
      }
    }
  }
}

function recoverInterruptedTasks(database) {
  const tasks = database.prepare("SELECT task_id FROM tasks WHERE status = 'running' ORDER BY created_at").all()
  if (tasks.length === 0) return 0
  database.exec('BEGIN IMMEDIATE')
  try {
    const now = new Date().toISOString()
    for (const task of tasks) {
      const checkpoint = latestProviderCheckpoint(database, task.task_id)
      if (checkpoint?.phase === 'submitted' && checkpoint.remoteTaskId) {
        database.prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE task_id = ? AND status = 'running'").run(now, task.task_id)
        appendTaskEvent(database, task.task_id, 'created', { resumeProviderTask: true }, now)
        continue
      }
      const update = database.prepare(`
        UPDATE tasks SET status = 'interrupted', error_code = 'PROCESS_INTERRUPTED', updated_at = ?
        WHERE task_id = ? AND status = 'running'
      `).run(now, task.task_id)
      if (update.changes === 1) appendTaskEvent(database, task.task_id, 'interrupted', { reason: 'PROCESS_RESTART' }, now)
    }
    database.exec('COMMIT')
    return tasks.length
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function latestProviderCheckpoint(database, taskId) {
  const row = database.prepare(`SELECT data_json FROM task_events
    WHERE task_id = ? AND type = 'running' AND json_extract(data_json, '$.providerCheckpoint.phase') IS NOT NULL
    ORDER BY event_seq DESC LIMIT 1`).get(taskId)
  return row ? JSON.parse(row.data_json).providerCheckpoint : null
}

function nodeErrorCode(error) {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return nodeErrorCode(error) !== 'ESRCH'
  }
}

async function acquireProjectWriterLock(dataDirectory) {
  const lockPath = path.join(dataDirectory, 'project.lock')
  const recoveryLockPath = path.join(dataDirectory, 'project.lock.recovery')

  async function withRecoveryLock(operation) {
    const recoveryLock = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }
    let handle
    try {
      handle = await fs.open(recoveryLockPath, 'wx', 0o600)
    } catch (error) {
      if (nodeErrorCode(error) === 'EEXIST') {
        throw new Error('项目写入锁正在由另一个进程恢复，请稍后重试。')
      }
      throw error
    }
    let ready = false
    try {
      await handle.writeFile(`${JSON.stringify(recoveryLock)}\n`, 'utf8')
      await handle.sync()
      ready = true
      return await operation()
    } finally {
      try {
        await handle.close()
      } finally {
        if (!ready) {
          await fs.rm(recoveryLockPath, { force: true })
        } else {
          const info = await fs.lstat(recoveryLockPath).catch(() => null)
          if (info?.isFile() && !info.isSymbolicLink()) {
            let current
            try {
              current = JSON.parse(await fs.readFile(recoveryLockPath, 'utf8'))
            } catch {
              current = null
            }
            if (isRecord(current) && current.token === recoveryLock.token) {
              await fs.rm(recoveryLockPath, { force: true })
            }
          }
        }
      }
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const lock = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }
    let handle
    try {
      handle = await fs.open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8')
      await handle.sync()
      let released = false
      return async () => {
        if (released) return
        released = true
        await handle.close()
        const info = await fs.lstat(lockPath).catch(() => null)
        if (!info?.isFile() || info.isSymbolicLink()) return
        let current
        try {
          current = JSON.parse(await fs.readFile(lockPath, 'utf8'))
        } catch {
          return
        }
        if (isRecord(current) && current.token === lock.token) await fs.rm(lockPath, { force: true })
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (nodeErrorCode(error) !== 'EEXIST') {
        if (handle) await fs.rm(lockPath, { force: true }).catch(() => undefined)
        throw error
      }
    }

    const info = await fs.lstat(lockPath).catch((error) => {
      if (nodeErrorCode(error) === 'ENOENT') return null
      throw error
    })
    if (!info) continue
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('项目写入锁文件无效。请检查项目后再重试。')
    const currentText = await fs.readFile(lockPath, 'utf8')
    let current
    try {
      current = JSON.parse(currentText)
    } catch {
      throw new Error('项目写入锁文件不完整。请关闭 VibePaper 并检查项目后再重试。')
    }
    if (!isRecord(current) || !Number.isSafeInteger(current.pid) || current.pid < 1
      || typeof current.token !== 'string' || current.token.length < 16
      || typeof current.startedAt !== 'string') {
      throw new Error('项目写入锁文件格式无效。请关闭 VibePaper 并检查项目后再重试。')
    }
    if (processIsRunning(current.pid)) throw new Error('该项目已在另一个 VibePaper 实例中打开。')
    const recovered = await withRecoveryLock(async () => {
      const latestInfo = await fs.lstat(lockPath).catch((error) => {
        if (nodeErrorCode(error) === 'ENOENT') return null
        throw error
      })
      if (!latestInfo) return true
      if (!latestInfo.isFile() || latestInfo.isSymbolicLink()) {
        throw new Error('项目写入锁文件无效。请检查项目后再重试。')
      }
      if ((await fs.readFile(lockPath, 'utf8')) !== currentText) return false
      if (processIsRunning(current.pid)) throw new Error('该项目已在另一个 VibePaper 实例中打开。')
      await fs.rm(lockPath, { force: true })
      return true
    })
    if (!recovered) continue
  }
  throw new Error('无法取得项目写入锁，请关闭其他 VibePaper 实例后重试。')
}

function setDatabaseMode(database) {
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
}

function insertGraph(database, canvasId, graph) {
  const insertNode = database.prepare(`
    INSERT INTO nodes (canvas_id, id, position_x, position_y, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const node of graph.nodes) {
    insertNode.run(canvasId, node.id, node.position.x, node.position.y, JSON.stringify(node))
  }

  const insertEdge = database.prepare(`
    INSERT INTO edges (canvas_id, id, source_node_id, target_node_id, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const edge of graph.edges) {
    insertEdge.run(canvasId, edge.id, edge.source, edge.target, JSON.stringify(edge))
  }
}

function nodeAssetReferenceCandidates(node, { includeDirectorCaptures = true } = {}) {
  const expectedMimePrefix = ASSET_NODE_MIME_PREFIX[node.type]
  if (!expectedMimePrefix) return []
  const data = isRecord(node.data) ? node.data : {}
  const nested = isRecord(data.node) ? data.node : {}
  const params = isRecord(data.params) ? data.params : isRecord(nested.params) ? nested.params : {}
  const candidates = new Map()
  const add = (assetId, required) => {
    if (assetId === undefined || assetId === null || assetId === '') return
    const existing = candidates.get(assetId)
    candidates.set(assetId, { assetId, required: Boolean(required || existing?.required) })
  }

  add(data.assetId ?? nested.assetId ?? params.assetId, true)
  if (node.type === 'director' && includeDirectorCaptures) {
    const addLocalAssetUrl = (value) => {
      if (typeof value !== 'string') return
      const match = DIRECTOR_CAPTURE_ASSET_URL.exec(value)
      if (match) add(match[1], false)
    }
    if (Array.isArray(params.captures)) params.captures.forEach(addLocalAssetUrl)
    for (const key of ['url', 'lastOutputUrl', 'thumbnailUrl', 'referenceUrl', 'output_url']) {
      addLocalAssetUrl(params[key])
    }
  }
  return [...candidates.values()]
}

function insertAssetReferences(database, canvasId, graph) {
  const findAsset = database.prepare('SELECT id, mime_type FROM assets WHERE id = ?')
  const insertReference = database.prepare('INSERT INTO asset_references (canvas_id, node_id, asset_id) VALUES (?, ?, ?)')
  for (const node of graph.nodes) {
    const expectedMimePrefix = ASSET_NODE_MIME_PREFIX[node.type]
    for (const { assetId, required } of nodeAssetReferenceCandidates(node)) {
      if (typeof assetId !== 'string') {
        if (required) throw new Error(`画布${ASSET_NODE_LABEL[node.type]}节点素材标识无效。`)
        continue
      }
      const asset = findAsset.get(assetId)
      if (!asset) {
        if (required) throw new Error(`画布${ASSET_NODE_LABEL[node.type]}节点引用了不存在的本地素材。`)
        continue
      }
      if (!asset.mime_type.startsWith(expectedMimePrefix)) {
        if (required) throw new Error(`画布${ASSET_NODE_LABEL[node.type]}节点引用了类型不匹配的本地素材。`)
        continue
      }
      insertReference.run(canvasId, node.id, assetId)
    }
  }
}

function validateAssetReferences(database, canvasId, graph, {
  allowLegacyParamsGaps = false,
  includeDirectorCaptures = true,
} = {}) {
  const expected = new Map()
  const legacyParamsReferences = new Set()
  for (const node of graph.nodes) {
    const expectedMimePrefix = ASSET_NODE_MIME_PREFIX[node.type]
    if (!expectedMimePrefix) continue
    const data = isRecord(node.data) ? node.data : {}
    const nested = isRecord(data.node) ? data.node : {}
    const params = isRecord(data.params) ? data.params : isRecord(nested.params) ? nested.params : {}
    for (const { assetId, required } of nodeAssetReferenceCandidates(node, { includeDirectorCaptures })) {
      const isPrimaryParamsReference = (data.assetId === undefined || data.assetId === null)
        && (nested.assetId === undefined || nested.assetId === null)
        && assetId === params.assetId
      if (typeof assetId !== 'string') {
        if (required) throw new Error(`项目画布中的${ASSET_NODE_LABEL[node.type]}节点素材标识无效。`)
        continue
      }
      const asset = database.prepare('SELECT mime_type FROM assets WHERE id = ?').get(assetId)
      // Older imported canvases can contain stale local capture URLs. They do
      // not represent a materialized asset and must not block project opening.
      if (!asset && !required) continue
      if (!asset) throw new Error(`项目画布中的${ASSET_NODE_LABEL[node.type]}节点引用了不存在的本地素材。`)
      if (!asset.mime_type.startsWith(expectedMimePrefix)) {
        if (!required) continue
        throw new Error('项目画布中的本地素材引用类型不匹配。')
      }
      const key = `${node.id}\u0000${assetId}`
      expected.set(key, { canvasId, nodeId: node.id, assetId })
      if (isPrimaryParamsReference) legacyParamsReferences.add(key)
    }
  }
  const actualRows = database.prepare('SELECT node_id, asset_id FROM asset_references WHERE canvas_id = ?').all(canvasId)
  const actual = new Set(actualRows.map((row) => `${row.node_id}\u0000${row.asset_id}`))
  const expectedKeys = new Set(expected.keys())
  const hasConflictingOrExtraRows = [...actual].some((key) => !expectedKeys.has(key))
  const missingRows = [...expected].filter(([key]) => !actual.has(key)).map(([, reference]) => reference)
  if (!hasConflictingOrExtraRows && missingRows.length === 0) return []
  if (allowLegacyParamsGaps && !hasConflictingOrExtraRows
    && missingRows.every(({ nodeId, assetId }) => legacyParamsReferences.has(`${nodeId}\u0000${assetId}`))) {
    return missingRows
  }
  throw new Error('项目画布与本地素材引用记录不一致。')
}

function normalizeCreateNodeInput(input) {
  if (typeof input.type !== 'string' || !input.type.trim()) {
    throw new Error('节点类型不能为空。')
  }
  if (input.expectedVersion !== undefined && input.expectedVersion !== null
    && (!Number.isInteger(input.expectedVersion) || input.expectedVersion < -2_147_483_648 || input.expectedVersion > 2_147_483_647)) {
    throw new Error('画布版本无效，请重新打开项目。')
  }

  const numberOrDefault = (key, fallback) => {
    const value = input[key]
    if (value === undefined || value === null) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`节点${key}无效。`)
    return value
  }
  const optionalString = (key) => {
    const value = input[key]
    if (value === undefined || value === null) return null
    if (typeof value !== 'string') throw new Error(`节点${key}无效。`)
    return value
  }

  let params = input.params ?? {}
  if (!isRecord(params)) throw new Error('节点参数必须是对象。')
  try {
    const json = JSON.stringify(params)
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_CANVAS_BYTES) {
      throw new Error('节点参数超过本地画布数据上限。')
    }
    params = JSON.parse(json)
  } catch (error) {
    if (error instanceof Error && error.message === '节点参数超过本地画布数据上限。') throw error
    throw new Error('节点参数必须是有效的 JSON 对象。')
  }
  if (!isRecord(params)) throw new Error('节点参数必须是有效的 JSON 对象。')

  const modelRef = optionalString('modelRef')
  const creativeType = optionalString('creativeType')
  const explicitPrompt = optionalString('prompt')
  let prompt = explicitPrompt
  if (prompt === null) {
    const promptValue = params.prompt ?? params.title
    prompt = promptValue === undefined || promptValue === null ? null : String(promptValue)
  }
  if (modelRef !== null) params.model = modelRef
  if (prompt !== null) params.prompt = prompt

  return {
    type: input.type,
    x: numberOrDefault('x', 120),
    y: numberOrDefault('y', 120),
    width: numberOrDefault('width', 280),
    height: numberOrDefault('height', 220),
    params,
    creativeType,
    modelRef,
    prompt,
    expectedVersion: input.expectedVersion ?? null,
  }
}

function flowNodeFromPayload(payload, assetId) {
  const data = {
    label: payload.prompt ?? '',
    node: payload,
    params: payload.params,
    status: payload.status,
    currentOutputId: payload.currentOutputId,
    groupId: payload.groupId,
    stackId: payload.stackId,
    creativeType: payload.creativeType,
    stale: payload.stale,
    modelRef: payload.modelRef,
    prompt: payload.prompt,
    output: payload.output,
    execStatus: payload.execStatus,
    selected: false,
  }
  if (assetId) data.assetId = assetId
  if (typeof payload.params.name === 'string') data.name = payload.params.name
  if (typeof payload.params.url === 'string') data.url = payload.params.url
  return {
    id: payload.id,
    type: payload.type,
    position: { x: payload.x, y: payload.y },
    width: payload.width,
    height: payload.height,
    data,
  }
}

function cloneJsonRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label}必须是对象。`)
  try {
    const json = JSON.stringify(value)
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_CANVAS_BYTES) {
      throw new Error(`${label}超过本地画布数据上限。`)
    }
    const parsed = JSON.parse(json)
    if (!isRecord(parsed)) throw new Error('invalid JSON object')
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message === `${label}超过本地画布数据上限。`) throw error
    throw new Error(`${label}必须是有效的 JSON 对象。`)
  }
}

function normalizeCanvasEntityId(value, label) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw new Error(`${label}标识无效。`)
}

function normalizeDramaAssetData(assetType, value) {
  if (!DRAMA_ASSET_TYPES.includes(assetType)) throw new Error('未知短剧资产类型。')
  const data = cloneJsonRecord(value, '短剧资产 data')
  if (Object.keys(data).length === 0) throw new Error('短剧资产 data 不能为空。')

  const hasText = (...keys) => keys.some((key) => {
    const field = data[key]
    if (field == null) return false
    // DramaAssetService.requireText uses Jackson's Object.toString().isBlank(),
    // so any non-null JSON value with a nonblank representation is accepted.
    // Java collections render as [] / {}, including when they are empty.
    if (Array.isArray(field) || isRecord(field)) return true
    return String(field).trim().length > 0
  })
  const hasNumber = (...keys) => keys.some((key) => typeof data[key] === 'number' && Number.isFinite(data[key]))
  const missing = (field) => { throw new Error(`短剧资产缺少字段: ${field}`) }
  switch (assetType) {
    case 'series_bible':
      if (!hasText('premise')) missing('premise')
      break
    case 'episode':
      if (!hasNumber('episodeNo', 'episode_no')) missing('episodeNo')
      if (!hasText('goal')) missing('goal')
      break
    case 'scene':
      if (!hasNumber('sceneOrder', 'scene_order')) missing('sceneOrder')
      if (!hasText('goal')) missing('goal')
      break
    case 'character_profile':
      if (!hasText('name')) missing('name')
      if (!hasText('identityAnchor', 'identity_anchor')) missing('identityAnchor')
      break
    case 'character_look':
      if (!hasText('characterId', 'character_id')) missing('characterId')
      break
    case 'shot_spec':
      if (!hasNumber('shotNo', 'shot_no')) missing('shotNo')
      if (!hasText('purpose')) missing('purpose')
      break
    case 'continuity_constraint':
      if (!hasText('subject')) missing('subject')
      if (!hasText('rule')) missing('rule')
      break
    case 'audio_cue':
    case 'subtitle_cue':
      if (!hasText('text')) missing('text')
      break
    default:
      throw new Error('未知短剧资产类型。')
  }
  return data
}

function dramaAssetPayload(row, currentCanvasVersion, replayed = false) {
  const assetId = row.asset_id ?? row.assetId
  return {
    id: assetId,
    assetId,
    canvasId: row.canvas_id ?? row.canvasId,
    assetType: row.asset_type ?? row.assetType,
    assetVersion: Number(row.asset_version ?? row.assetVersion),
    canvasVersion: Number(row.canvas_version ?? row.canvasVersion),
    currentCanvasVersion: Number(currentCanvasVersion),
    data: JSON.parse(row.data_json ?? row.asset_data_snapshot ?? row.data ?? '{}'),
    replayed,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt,
  }
}

function requiredDramaInteger(value, field) {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} 必须是整数。`)
  return value
}

function requiredDramaText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空。`)
  return value.trim()
}

const STANDARD_VERTICAL_SHORT_DRAMA_FORMAT = Object.freeze({
  id: 'vertical-short-drama-v1',
  aspectRatio: '9:16',
  targetDurationSeconds: 180,
  minShotCount: 60,
  maxShotCount: 90,
  minShotDurationSeconds: 2,
  maxShotDurationSeconds: 5,
  keyframeFirst: true,
})

function dramaStateError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function dramaStateText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw dramaStateError('INVALID_INPUT', `${field}不能为空`)
  return value.trim()
}

function dramaStateStrings(value, field) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw dramaStateError('INVALID_INPUT', `${field}状态格式无效`)
  }
  return value.map((item) => item.trim())
}

function dramaStateBindings(value) {
  if (!Array.isArray(value)) throw dramaStateError('INVALID_INPUT', '镜头角色绑定状态格式无效')
  return value.map((item) => {
    if (!isRecord(item) || typeof item.characterId !== 'string' || typeof item.lookRevision !== 'number') {
      throw dramaStateError('INVALID_INPUT', '镜头角色绑定状态格式无效')
    }
    return { characterId: dramaStateText(item.characterId, 'characterId'), lookRevision: item.lookRevision }
  })
}

function dramaStateStatus(value, allowed, field) {
  if (!allowed.includes(value)) throw dramaStateError('INVALID_INPUT', `${field}状态无效`)
  return value
}

function dramaStateUniqueConflict(error) {
  if (typeof error !== 'object' || error === null) return false
  if (typeof error.code === 'string' && /SQLITE_CONSTRAINT_(?:PRIMARYKEY|UNIQUE)/u.test(error.code)) return true
  return typeof error.message === 'string'
    && /(?:UNIQUE constraint failed|PRIMARY KEY must be unique)/u.test(error.message)
}

function sameDramaIds(actual, expected) {
  if (actual.length !== expected.length) return false
  const sortedActual = [...actual].sort()
  const sortedExpected = [...expected].sort()
  return sortedActual.every((id, index) => id === sortedExpected[index])
}

function isStandardDramaFormat(format) {
  return isRecord(format) && Object.entries(STANDARD_VERTICAL_SHORT_DRAMA_FORMAT)
    .every(([key, value]) => format[key] === value)
}

function requireDramaIdempotencyKey(value) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 128) {
    throw dramaStateError('INVALID_INPUT', 'Idempotency-Key 必须为 1-128 个字符。')
  }
  return value.trim()
}

function dramaRenderTaskIdempotencyKey(batchId, jobId, attempt) {
  return `drama-batch:${batchId}:job:${jobId}:attempt:${attempt}`
}

function dramaRenderBatchPayload(database, row) {
  const jobs = database.prepare(`
    SELECT job_id, shot_id, keyframe_render_id, canvas_node_id, duration_seconds, model_type,
      provider_type, provider_id, model_id, model_params_json, estimated_cost, input_hash,
      status, task_id, error_code, attempt
    FROM drama_render_jobs WHERE batch_id = ? ORDER BY created_at, job_id
  `).all(row.batch_id).map((job) => ({
    id: job.job_id,
    shotId: job.shot_id,
    keyframeRenderId: job.keyframe_render_id,
    ...(job.canvas_node_id == null ? {} : { canvasNodeId: job.canvas_node_id }),
    durationSeconds: Number(job.duration_seconds),
    modelType: job.model_type,
    providerType: job.provider_type,
    providerId: job.provider_id,
    modelId: job.model_id,
    modelParams: JSON.parse(job.model_params_json),
    estimatedCost: Number(job.estimated_cost),
    inputHash: job.input_hash,
    status: job.status,
    ...(job.task_id == null ? {} : { taskId: job.task_id }),
    ...(job.error_code == null ? {} : { errorCode: job.error_code }),
    attempt: Number(job.attempt),
  }))
  return {
    id: row.batch_id,
    canvasId: row.canvas_id,
    seriesId: row.series_id,
    episodeNo: Number(row.episode_no),
    estimatedCost: Number(row.estimated_cost),
    status: row.status,
    ...(row.session_id == null ? {} : { sessionId: row.session_id }),
    ...(row.canvas_version == null ? {} : { canvasVersion: Number(row.canvas_version) }),
    ...(row.approval_action_id == null ? {} : { approvalActionId: row.approval_action_id }),
    jobs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function renderReviewPayload(row, projectId) {
  return {
    id: row.review_id,
    canvas_id: row.canvas_id,
    user_id: projectId,
    target_node_id: row.target_node_id,
    target_kind: row.target_kind,
    scores: JSON.parse(row.scores_json),
    failures: JSON.parse(row.failures_json),
    recommended_action: row.recommended_action,
    evidence: JSON.parse(row.evidence_json),
    retry_count: Number(row.retry_count),
    status: row.status,
    ...(row.source_task_id == null ? {} : { source_task_id: row.source_task_id }),
    created_at: row.created_at,
  }
}

function normalizeCanvasNodeIds(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_NODES) {
    throw new Error(label)
  }
  return value.map((nodeId) => normalizeCanvasEntityId(nodeId, '节点'))
}

function normalizeCanvasGroups(groups) {
  if (groups === undefined || groups === null) return []
  if (!Array.isArray(groups) || groups.length > MAX_NODES) throw new Error('画布编组数据无效或超过上限。')
  const ids = new Set()
  return groups.map((group) => {
    if (!isRecord(group)) throw new Error('画布编组数据无效。')
    const id = normalizeCanvasEntityId(group.id, '编组')
    if (ids.has(id)) throw new Error('画布包含重复编组。')
    ids.add(id)
    const name = group.name ?? '编组'
    const color = group.color ?? '#8b5cf6'
    const layout = group.layout ?? 'free'
    if (typeof name !== 'string' || typeof color !== 'string' || typeof layout !== 'string') {
      throw new Error('画布编组数据无效。')
    }
    const nodeIds = normalizeCanvasNodeIds(group.nodeIds ?? [], '画布编组节点列表无效。')
    return { id, name, color, layout, nodeIds }
  })
}

function normalizeCanvasStacks(stacks) {
  if (stacks === undefined || stacks === null) return []
  if (!Array.isArray(stacks) || stacks.length > MAX_NODES) throw new Error('画布堆叠数据无效或超过上限。')
  const ids = new Set()
  return stacks.map((stack) => {
    if (!isRecord(stack)) throw new Error('画布堆叠数据无效。')
    const id = normalizeCanvasEntityId(stack.id, '堆叠')
    if (ids.has(id)) throw new Error('画布包含重复堆叠。')
    ids.add(id)
    const collapsed = stack.collapsed ?? true
    if (typeof collapsed !== 'boolean') throw new Error('堆叠 collapsed 无效。')
    const nodeIds = normalizeCanvasNodeIds(stack.nodeIds ?? [], '画布堆叠节点列表无效。')
    return { id, collapsed, nodeIds }
  })
}

function setNodeMembership(node, field, value) {
  const data = isRecord(node.data) ? node.data : {}
  const nextData = { ...data, [field]: value }
  if (isRecord(data.node)) nextData.node = { ...data.node, [field]: value }
  return { ...node, data: nextData }
}

function updateNodeMembership(database, canvasId, nodeId, field, value) {
  const row = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
    .get(canvasId, nodeId)
  if (!row) return null
  const updated = setNodeMembership(JSON.parse(row.payload_json), field, value)
  const result = database.prepare(`
    UPDATE nodes SET payload_json = ? WHERE canvas_id = ? AND id = ?
  `).run(JSON.stringify(updated), canvasId, nodeId)
  if (result.changes !== 1) return null
  return updated
}

function updateNodeMemberships(database, canvasId, nodeIds, field, value, requireEveryNode) {
  const updatedNodes = new Map()
  for (const nodeId of nodeIds) {
    const updated = updateNodeMembership(database, canvasId, nodeId, field, value)
    if (!updated && requireEveryNode) throw new Error('节点不存在')
    if (updated) updatedNodes.set(nodeId, updated)
  }
  return updatedNodes
}

function nodesWithMembershipUpdates(nodes, updatedNodes) {
  return nodes.map((node) => updatedNodes.get(node.id) ?? node)
}

function groupPayloadFromRow(row) {
  if (!row) return null
  const payload = normalizeCanvasGroups([{
    id: row.id,
    name: row.name,
    color: row.color,
    layout: row.layout,
    nodeIds: JSON.parse(row.node_ids_json),
  }])[0]
  return payload
}

function stackPayloadFromRow(row) {
  if (!row) return null
  return normalizeCanvasStacks([{
    id: row.id,
    collapsed: Boolean(row.collapsed),
    nodeIds: JSON.parse(row.node_ids_json),
  }])[0]
}

function normalizeUpdateNodeInput(input) {
  const expectedVersion = input.expectedVersion ?? null
  if (expectedVersion !== null
    && (!Number.isInteger(expectedVersion) || expectedVersion < -2_147_483_648 || expectedVersion > 2_147_483_647)) {
    throw new Error('画布版本无效，请重新打开项目。')
  }

  const request = { expectedVersion }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (input[key] === undefined || input[key] === null) continue
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error(`节点${key}无效。`)
    request[key] = input[key]
  }
  for (const key of ['params', 'output']) {
    if (input[key] === undefined || input[key] === null) continue
    request[key] = cloneJsonRecord(input[key], key === 'params' ? '节点参数' : '节点输出')
  }
  for (const key of ['status', 'creativeType', 'modelRef', 'prompt', 'execStatus']) {
    if (input[key] === undefined || input[key] === null) continue
    if (typeof input[key] !== 'string') throw new Error(`节点${key}无效。`)
    request[key] = input[key]
  }
  for (const key of ['currentOutputId', 'groupId', 'stackId']) {
    if (input[key] === undefined || input[key] === null) continue
    const value = input[key]
    if (!(typeof value === 'string' && value.length > 0 && value.length <= 256)
      && !(typeof value === 'number' && Number.isSafeInteger(value))) {
      throw new Error(`节点${key}无效。`)
    }
    request[key] = value
  }
  if (input.stale !== undefined && input.stale !== null) {
    if (typeof input.stale !== 'boolean') throw new Error('节点stale无效。')
    request.stale = input.stale
  }
  return request
}

function nodePayloadFromFlowNode(node) {
  const data = isRecord(node.data) ? node.data : {}
  const nested = isRecord(data.node) ? data.node : {}
  let params = isRecord(data.params) ? data.params : isRecord(nested.params) ? nested.params : {}
  if (Object.hasOwn(ASSET_NODE_MIME_PREFIX, node.type) && typeof data.assetId === 'string' && params.assetId === undefined) {
    params = { ...params, assetId: data.assetId }
  }
  return {
    id: node.id,
    type: node.type,
    x: node.position.x,
    y: node.position.y,
    width: node.width ?? nested.width ?? null,
    height: node.height ?? nested.height ?? null,
    params: cloneJsonRecord(params, '节点参数'),
    status: data.status ?? nested.status ?? 'idle',
    currentOutputId: data.currentOutputId ?? nested.currentOutputId ?? null,
    groupId: data.groupId ?? nested.groupId ?? null,
    stackId: data.stackId ?? nested.stackId ?? null,
    creativeType: data.creativeType ?? nested.creativeType ?? null,
    stale: data.stale ?? nested.stale ?? false,
    modelRef: data.modelRef ?? nested.modelRef ?? null,
    prompt: data.prompt ?? nested.prompt ?? null,
    output: isRecord(data.output) ? cloneJsonRecord(data.output, '节点输出')
      : isRecord(nested.output) ? cloneJsonRecord(nested.output, '节点输出') : null,
    execStatus: data.execStatus ?? nested.execStatus ?? 'idle',
  }
}

function canvasNodeExportPayload(node) {
  const payload = nodePayloadFromFlowNode(node)
  const data = isRecord(node.data) ? node.data : {}
  if (Object.hasOwn(ASSET_NODE_MIME_PREFIX, node.type) && typeof data.assetId === 'string'
    && payload.params.assetId === undefined) {
    payload.params.assetId = data.assetId
  }
  return payload
}

function preserveNodeGenerationState(nodes, previousNodes) {
  const previousById = new Map(previousNodes.map((node) => [node.id, node]))
  const preservedMediaParamKeys = ['url', 'lastOutputUrl', 'thumbnailUrl', 'output_url', 'lastOutputText']
  const successfulStatuses = new Set(['succeeded', 'success', 'ready'])
  const resetStatuses = new Set(['idle', 'stale', ''])

  return nodes.map((node) => {
    const previous = previousById.get(node.id)
    if (!previous) return node

    const payload = nodePayloadFromFlowNode(node)
    const previousPayload = nodePayloadFromFlowNode(previous)
    const nextParams = { ...payload.params }
    for (const key of preservedMediaParamKeys) {
      const value = nextParams[key]
      if ((value === undefined || value === null || String(value).trim() === '')
        && previousPayload.params[key] !== undefined && previousPayload.params[key] !== null) {
        nextParams[key] = previousPayload.params[key]
      }
    }
    payload.params = nextParams

    if ((!payload.output || Object.keys(payload.output).length === 0)
      && previousPayload.output && Object.keys(previousPayload.output).length > 0) {
      payload.output = previousPayload.output
    }

    const incomingExecStatus = String(payload.execStatus ?? '').toLowerCase()
    const previousExecStatus = String(previousPayload.execStatus ?? '').toLowerCase()
    if (successfulStatuses.has(previousExecStatus) && resetStatuses.has(incomingExecStatus)) {
      payload.execStatus = previousPayload.execStatus
      if (resetStatuses.has(String(payload.status ?? '').toLowerCase())) {
        payload.status = previousPayload.status ?? previousPayload.execStatus
      }
    }

    const data = { ...node.data, params: payload.params, output: payload.output,
      status: payload.status, execStatus: payload.execStatus }
    if (isRecord(data.node)) {
      data.node = {
        ...data.node,
        params: payload.params,
        output: payload.output,
        status: payload.status,
        execStatus: payload.execStatus,
      }
    }
    return { ...node, data }
  })
}

function canvasNodeContentSignature(node) {
  const payload = nodePayloadFromFlowNode(node)
  return JSON.stringify(canonicalJson({
    params: payload.params,
    creativeType: payload.creativeType,
    modelRef: payload.modelRef,
    prompt: payload.prompt,
    output: payload.output,
  }))
}

function canvasEdgeExportPayload(edge) {
  const data = isRecord(edge.data) ? edge.data : {}
  const payload = isRecord(data.edge) ? data.edge : {}
  return {
    id: payload.id ?? edge.id,
    sourceNodeId: payload.sourceNodeId ?? edge.source,
    sourcePort: payload.sourcePort ?? edge.sourceHandle ?? 'output',
    targetNodeId: payload.targetNodeId ?? edge.target,
    targetPort: payload.targetPort ?? edge.targetHandle ?? 'input',
    valid: payload.valid ?? data.valid ?? true,
    dependencyType: payload.dependencyType ?? edge.dependencyType ?? 'reference',
  }
}

function importCanvasId(value, label) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw new Error(`${label}标识无效。`)
}

function importedProjectName(value) {
  const source = typeof value === 'string' && value.trim() ? value.trim() : '导入的画布'
  const safe = source.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/gu, '').trim().slice(0, 60)
  try {
    return validateProjectName(safe || '导入的画布')
  } catch {
    return '导入的画布'
  }
}

function normalizeCanvasImportDocument(document) {
  if (!isRecord(document)) throw new Error('画布 JSON 格式错误：根节点必须是对象。')
  let schemaVersion = document.schema_version
  if (schemaVersion === undefined || schemaVersion === null) schemaVersion = document.schemaVersion
  if (schemaVersion === undefined || schemaVersion === null) throw new Error('缺少 schema_version，导入拒绝。')
  const versionText = String(schemaVersion)
  const versionMatch = /^(\d+)(?:\.\d+)*$/u.exec(versionText)
  if (!versionMatch || Number(versionMatch[1]) < 1) {
    throw new Error(`画布版本不兼容：导入版本 ${versionText}，当前最低兼容 ${CANVAS_EXPORT_SCHEMA_VERSION}。`)
  }

  const nodes = document.nodes ?? []
  const edges = document.edges ?? []
  if (!Array.isArray(nodes) || nodes.length > MAX_NODES) throw new Error('画布节点数据无效或超过上限。')
  if (!Array.isArray(edges) || edges.length > MAX_EDGES) throw new Error('画布连线数据无效或超过上限。')
  const oldToNewNodeId = new Map()
  const importedNodes = []
  const importedNodeTypes = new Map()
  const warnings = []
  let droppedAssetReferenceCount = 0

  for (const rawNode of nodes) {
    if (!isRecord(rawNode) || typeof rawNode.type !== 'string'
      || !Object.hasOwn(EDGE_COMPATIBLE_TARGET_TYPES, rawNode.type)) {
      throw new Error(`非法节点类型: ${String(rawNode?.type)}`)
    }
    const oldId = importCanvasId(rawNode.id, '节点')
    if (oldToNewNodeId.has(oldId)) throw new Error('画布包含重复的节点。')
    const params = rawNode.params === undefined || rawNode.params === null
      ? {} : cloneJsonRecord(rawNode.params, '节点参数')
    const originalAssetId = params.assetId
    const droppedDirectorAssetIds = new Set()
    if (rawNode.type === 'director') {
      if (typeof originalAssetId === 'string' && originalAssetId) droppedDirectorAssetIds.add(originalAssetId)
      const removeLocalAssetUrl = (value) => {
        if (typeof value !== 'string') return false
        const match = DIRECTOR_CAPTURE_ASSET_URL.exec(value)
        if (!match) return false
        droppedDirectorAssetIds.add(match[1])
        return true
      }
      if (Array.isArray(params.captures)) {
        params.captures = params.captures.filter((value) => !removeLocalAssetUrl(value))
      }
      for (const key of ['url', 'lastOutputUrl', 'thumbnailUrl', 'referenceUrl', 'output_url']) {
        if (removeLocalAssetUrl(params[key])) delete params[key]
      }
    }
    if (['image', 'audio', 'video', 'text', 'director'].includes(rawNode.type)
      && originalAssetId !== undefined && originalAssetId !== null && originalAssetId !== '') {
      // CanvasService.importCanvas copies params verbatim. Local assets are scoped
      // to their project, so an ID from a foreign project cannot be made valid
      // in the fresh project created for this import.
      delete params.assetId
      droppedAssetReferenceCount += rawNode.type === 'director'
        ? Math.max(1, droppedDirectorAssetIds.size)
        : 1
    } else if (droppedDirectorAssetIds.size > 0) {
      droppedAssetReferenceCount += droppedDirectorAssetIds.size
    }
    const numberField = (key, fallback) => {
      const value = rawNode[key]
      if (value === undefined || value === null) return fallback
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`画布节点 ${key} 无效。`)
      return value
    }
    const creativeType = rawNode.creativeType ?? rawNode.creative_type ?? null
    if (creativeType !== null && typeof creativeType !== 'string') throw new Error('画布节点 creativeType 无效。')
    const newId = randomUUID()
    oldToNewNodeId.set(oldId, newId)
    importedNodeTypes.set(newId, rawNode.type)
    importedNodes.push(flowNodeFromPayload({
      id: newId,
      type: rawNode.type,
      x: numberField('x', 100),
      y: numberField('y', 100),
      width: numberField('width', 260),
      height: numberField('height', 200),
      params,
      status: 'idle',
      currentOutputId: null,
      groupId: null,
      stackId: null,
      creativeType,
      stale: false,
      modelRef: null,
      prompt: null,
      output: null,
      execStatus: 'idle',
    }))
  }
  if (droppedAssetReferenceCount > 0) {
    warnings.push(`有 ${droppedAssetReferenceCount} 个素材引用不在导入文件中，已从新项目节点移除；请在素材库中重新选择本地素材。`)
  }

  const importedEdges = []
  for (const rawEdge of edges) {
    if (!isRecord(rawEdge)) throw new Error('画布包含无效连线。')
    const sourceValue = rawEdge.sourceNodeId ?? rawEdge.source_node_id
    const targetValue = rawEdge.targetNodeId ?? rawEdge.target_node_id
    const oldSource = importCanvasId(sourceValue, '连线源节点')
    const oldTarget = importCanvasId(targetValue, '连线目标节点')
    const source = oldToNewNodeId.get(oldSource)
    const target = oldToNewNodeId.get(oldTarget)
    if (!source || !target) continue
    const compatible = EDGE_COMPATIBLE_TARGET_TYPES[importedNodeTypes.get(source)].has(importedNodeTypes.get(target))
    const sourcePort = rawEdge.sourcePort ?? rawEdge.source_port ?? 'output'
    const targetPort = rawEdge.targetPort ?? rawEdge.target_port ?? 'input'
    let dependencyType = rawEdge.dependencyType ?? rawEdge.dependency_type ?? 'reference'
    if (typeof dependencyType !== 'string') dependencyType = String(dependencyType)
    if (typeof sourcePort !== 'string' || typeof targetPort !== 'string') throw new Error('画布连线端口无效。')
    const id = randomUUID()
    importedEdges.push({
      id,
      source,
      sourceHandle: sourcePort,
      target,
      targetHandle: targetPort,
      data: {
        valid: compatible,
        edge: {
          id,
          sourceNodeId: source,
          sourcePort,
          targetNodeId: target,
          targetPort,
          valid: compatible,
          dependencyType,
        },
      },
    })
  }
  const graph = validateGraph(importedNodes, importedEdges)
  let canvasName = '导入的画布'
  if (isRecord(document.canvas) && document.canvas.name !== undefined && document.canvas.name !== null) {
    if (typeof document.canvas.name !== 'string') throw new Error('画布名称无效。')
    canvasName = document.canvas.name
  }
  return {
    name: importedProjectName(canvasName),
    graph: { ...graph, groups: [], stacks: [] },
    warnings,
  }
}

function applyUpdateNodeRequest(flowNode, request) {
  const currentData = isRecord(flowNode.data) ? flowNode.data : {}
  const hasNestedPayload = isRecord(currentData.node)
  const nested = hasNestedPayload ? currentData.node : {}
  const payload = nodePayloadFromFlowNode(flowNode)
  let contentChanged = false

  for (const key of ['x', 'y', 'width', 'height', 'params', 'status', 'currentOutputId', 'groupId', 'stackId',
    'creativeType', 'stale', 'modelRef', 'prompt', 'output', 'execStatus']) {
    if (request[key] === undefined) continue
    payload[key] = request[key]
    if (['params', 'creativeType', 'modelRef', 'prompt', 'output'].includes(key)) contentChanged = true
  }
  if (request.execStatus !== undefined
    && ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'].includes(request.execStatus)) {
    payload.status = request.execStatus
  }

  if (payload.modelRef !== null) payload.params.model = payload.modelRef
  if (payload.prompt !== null) payload.params.prompt = payload.prompt
  if (payload.output !== null) {
    if (payload.output.url !== undefined && payload.output.url !== null) {
      payload.params.output_url = payload.output.url
      if (payload.params.lastOutputUrl === undefined || payload.params.lastOutputUrl === null) {
        payload.params.lastOutputUrl = payload.output.url
      }
      if (payload.params.url === undefined || payload.params.url === null) payload.params.url = payload.output.url
    } else {
      payload.params.output = payload.output
    }
  }
  if (contentChanged) payload.stale = false

  const data = {
    ...currentData,
    params: payload.params,
    status: payload.status,
    currentOutputId: payload.currentOutputId,
    groupId: payload.groupId,
    stackId: payload.stackId,
    creativeType: payload.creativeType,
    stale: payload.stale,
    modelRef: payload.modelRef,
    prompt: payload.prompt,
    execStatus: payload.execStatus,
  }
  if (request.prompt !== undefined) data.label = payload.prompt
  if (request.output !== undefined) data.output = payload.output
  if (hasNestedPayload) data.node = payload

  const updated = {
    ...flowNode,
    position: { ...flowNode.position, x: payload.x, y: payload.y },
    data,
  }
  if (request.width !== undefined) updated.width = payload.width
  if (request.height !== undefined) updated.height = payload.height
  return { node: updated, contentChanged }
}

function markDownstreamNodesStale(nodes, edges, sourceNodeId) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const staleNodeIds = new Set()
  const outgoingInputEdges = new Map()
  for (const edge of edges) {
    const dependencyType = edge.data?.edge?.dependencyType ?? edge.dependencyType ?? 'reference'
    if (dependencyType !== 'input') continue
    const outgoing = outgoingInputEdges.get(edge.source) ?? []
    outgoing.push(edge)
    outgoingInputEdges.set(edge.source, outgoing)
  }

  const pending = [sourceNodeId]
  while (pending.length > 0) {
    const currentSourceId = pending.pop()
    for (const edge of outgoingInputEdges.get(currentSourceId) ?? []) {
      const target = nodesById.get(edge.target)
      if (!target) continue
      const data = isRecord(target.data) ? target.data : {}
      const nested = isRecord(data.node) ? data.node : null
      if ((data.stale ?? nested?.stale) === true) continue

      const execStatus = data.execStatus ?? nested?.execStatus ?? ''
      const preserveExecStatus = ['queued', 'running', 'succeeded', 'success', 'ready'].includes(String(execStatus).toLowerCase())
      const nextExecStatus = preserveExecStatus ? execStatus : 'stale'
      const nextData = { ...data, stale: true }
      if (!preserveExecStatus) nextData.execStatus = 'stale'
      if (nested) nextData.node = { ...nested, stale: true, execStatus: nextExecStatus }
      nodesById.set(target.id, { ...target, data: nextData })
      staleNodeIds.add(target.id)
      pending.push(target.id)
    }
  }
  return {
    nodes: nodes.map((node) => nodesById.get(node.id)),
    staleNodeIds,
  }
}

function initializeDatabase(database, metadata, canvas) {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(PROJECT_DB_SCHEMA)
    const insertMetadata = database.prepare('INSERT INTO project_metadata (key, value) VALUES (?, ?)')
    insertMetadata.run('projectId', metadata.projectId)
    insertMetadata.run('canvasId', metadata.canvasId)
    database.prepare('INSERT INTO canvases (id, version, updated_at) VALUES (?, ?, ?)')
      .run(metadata.canvasId, canvas.version, new Date().toISOString())
    insertGraph(database, metadata.canvasId, canvas)
    insertCanvasGroupsAndStacks(
      database,
      metadata.canvasId,
      normalizeCanvasGroups(canvas.groups),
      normalizeCanvasStacks(canvas.stacks),
    )
    insertAssetReferences(database, metadata.canvasId, canvas)
    database.exec(`PRAGMA user_version = ${PROJECT_DB_SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function insertCanvasGroupsAndStacks(database, canvasId, groups, stacks) {
  const insertGroup = database.prepare(`
    INSERT INTO canvas_groups (canvas_id, id, name, color, layout, node_ids_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const group of groups) {
    const now = new Date().toISOString()
    insertGroup.run(canvasId, group.id, group.name, group.color, group.layout, JSON.stringify(group.nodeIds), now, now)
  }
  const insertStack = database.prepare(`
    INSERT INTO canvas_stacks (canvas_id, id, collapsed, node_ids_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  for (const stack of stacks) {
    const now = new Date().toISOString()
    insertStack.run(canvasId, stack.id, stack.collapsed ? 1 : 0, JSON.stringify(stack.nodeIds), now, now)
  }
}

async function migrateDatabaseV1ToV2(database, dataDirectory) {
  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v1-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(ASSET_DB_SCHEMA)
    database.exec('PRAGMA user_version = 2')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function migrateDatabaseV2ToV3(database, dataDirectory) {
  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v2-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(TASK_DB_SCHEMA)
    database.exec('PRAGMA user_version = 3')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function migrateDatabaseV3ToV4(database, dataDirectory) {
  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v3-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(CANVAS_GRAPH_COMMANDS_DB_SCHEMA)
    database.exec('PRAGMA user_version = 4')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function migrateDatabaseV4ToV5(database, dataDirectory) {
  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v4-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(CANVAS_GROUP_STACK_DB_SCHEMA)
    database.exec('PRAGMA user_version = 5')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function migrateDatabaseV5ToV6(database, dataDirectory) {
  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v5-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE assets_v6 (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
      ) STRICT;
      INSERT INTO assets_v6 (id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted)
        SELECT id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, created_at, 0 FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_v6 RENAME TO assets;
      CREATE INDEX assets_by_sha ON assets(sha256, deleted);
      PRAGMA user_version = 6;
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new Error('本地素材迁移后检测到无效引用。')
  }
}

async function migrateDatabaseV6ToV7(database, dataDirectory) {
  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v6-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE tasks_v7 (
        task_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 255),
        input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
        canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        canvas_version INTEGER NOT NULL CHECK (canvas_version >= 0),
        node_id TEXT,
        modality TEXT NOT NULL CHECK (modality IN ('text', 'image', 'audio', 'video', 'compose')),
        provider_type TEXT NOT NULL CHECK (provider_type IN ('local', 'cloud')),
        provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 160),
        model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
        input_json TEXT NOT NULL CHECK (json_valid(input_json)),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        output_path TEXT,
        output_sha256 TEXT CHECK (output_sha256 IS NULL OR length(output_sha256) = 64),
        output_size_bytes INTEGER CHECK (output_size_bytes IS NULL OR output_size_bytes > 0),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 120),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        CHECK (
          (status = 'succeeded' AND output_path IS NOT NULL AND output_sha256 IS NOT NULL AND output_size_bytes IS NOT NULL)
          OR (status <> 'succeeded' AND output_path IS NULL AND output_sha256 IS NULL AND output_size_bytes IS NULL)
        )
      ) STRICT;
      INSERT INTO tasks_v7 (
        task_id, idempotency_key, input_hash, canvas_id, canvas_version, node_id, modality,
        provider_type, provider_id, model_id, input_json, status, attempt_count, output_path,
        output_sha256, output_size_bytes, error_code, created_at, updated_at, started_at, completed_at
      ) SELECT
        task_id, idempotency_key, input_hash, canvas_id, canvas_version, node_id, modality,
        provider_type, provider_id, model_id, input_json, status, attempt_count, output_path,
        output_sha256, output_size_bytes, error_code, created_at, updated_at, started_at, completed_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_v7 RENAME TO tasks;
      CREATE INDEX tasks_by_status ON tasks(status, created_at);
      CREATE INDEX tasks_by_canvas ON tasks(canvas_id, created_at);
      PRAGMA user_version = 7;
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new Error('合成任务迁移后检测到无效引用。')
  }
}

async function migrateDatabaseV7ToV8(database, dataDirectory) {
  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v7-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE assets_v8 (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/wav')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
      ) STRICT;
      INSERT INTO assets_v8 (id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted)
        SELECT id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_v8 RENAME TO assets;
      CREATE INDEX assets_by_sha ON assets(sha256, deleted);
      PRAGMA user_version = 8;
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new Error('音频素材迁移后检测到无效引用。')
  }
}

async function migrateDatabaseV8ToV9(database, dataDirectory) {
  const version = databaseVersion(database)
  if (version === 9) return
  if (version !== 8) throw new Error(`无法将本地项目数据库从版本 ${version} 升级到版本 9。`)

  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v8-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  const canvases = database.prepare('SELECT id FROM canvases ORDER BY id').all()
  const selectNodes = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? ORDER BY rowid')
  const insertReference = database.prepare(`
    INSERT INTO asset_references (canvas_id, node_id, asset_id) VALUES (?, ?, ?)
  `)
  database.exec('BEGIN IMMEDIATE')
  try {
    const canvasGraphs = canvases.map(({ id: canvasId }) => ({
      canvasId,
      nodes: selectNodes.all(canvasId).map((row) => JSON.parse(row.payload_json)),
    }))

    const missingRows = canvasGraphs.flatMap(({ canvasId, nodes }) =>
      validateAssetReferences(database, canvasId, { nodes }, {
        allowLegacyParamsGaps: true,
        includeDirectorCaptures: false,
      }))
    for (const row of missingRows) insertReference.run(row.canvasId, row.nodeId, row.assetId)

    for (const { canvasId, nodes } of canvasGraphs) {
      validateAssetReferences(database, canvasId, { nodes }, { includeDirectorCaptures: false })
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('本地素材引用迁移后检测到无效引用。')
    }
    database.exec('PRAGMA user_version = 9')
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function migrateDatabaseV9ToV10(database, dataDirectory) {
  const version = databaseVersion(database)
  if (version === 10) return
  if (version !== 9) throw new Error(`无法将本地项目数据库从版本 ${version} 升级到版本 10。`)

  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v9-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE assets_v10 (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/wav', 'audio/mpeg')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
      ) STRICT;
      INSERT INTO assets_v10 (id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted)
        SELECT id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_v10 RENAME TO assets;
      CREATE INDEX assets_by_sha ON assets(sha256, deleted);
      PRAGMA user_version = 10;
    `)
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('MP3 素材迁移后检测到无效引用。')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
}

async function migrateDatabaseV10ToV11(database, dataDirectory) {
  const version = databaseVersion(database)
  if (version === 11) return
  if (version !== 10) throw new Error(`无法将本地项目数据库从版本 ${version} 升级到版本 11。`)

  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v10-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE assets_v11 (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN (
          'image/png', 'image/jpeg', 'image/gif', 'image/webp',
          'video/mp4', 'video/quicktime', 'video/webm',
          'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/mp4',
          'text/plain', 'text/markdown'
        )),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
      ) STRICT;
      INSERT INTO assets_v11 (id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted)
        SELECT id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_v11 RENAME TO assets;
      CREATE INDEX assets_by_sha ON assets(sha256, deleted);
      PRAGMA user_version = 11;
    `)
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('素材类型迁移后检测到无效引用。')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
}

async function migrateDatabaseV11ToV12(database, dataDirectory) {
  const version = databaseVersion(database)
  if (version === 12) return
  if (version !== 11) throw new Error(`无法将本地项目数据库从版本 ${version} 升级到版本 12。`)

  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v11-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('BEGIN IMMEDIATE')
  try {
    // Schema migration tests and interrupted migrations can arrive here with
    // the table already present. Keep the migration idempotent and backfill
    // any succeeded legacy task that has not yet been indexed.
    database.exec(TASK_OUTPUTS_DB_SCHEMA)
    database.exec(`
      INSERT INTO task_outputs (
        task_id, output_index, output_path, output_sha256, output_size_bytes, output_metadata_json
      )
      SELECT tasks.task_id, 0, tasks.output_path, tasks.output_sha256, tasks.output_size_bytes,
        (SELECT json_extract(events.data_json, '$.outputMeta')
          FROM task_events AS events
          WHERE events.task_id = tasks.task_id AND events.type = 'succeeded'
          ORDER BY events.event_seq DESC LIMIT 1)
      FROM tasks WHERE tasks.status = 'succeeded'
      ON CONFLICT(task_id, output_index) DO NOTHING
    `)
    database.exec('PRAGMA user_version = 12')
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('任务多结果迁移后检测到无效引用。')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function migrateDatabaseV12ToV13(database, dataDirectory) {
  const version = databaseVersion(database)
  if (version === 13) return
  if (version !== 12) throw new Error(`无法将本地项目数据库从版本 ${version} 升级到版本 13。`)

  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v12-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE asset_references_v13 (
        canvas_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        PRIMARY KEY (canvas_id, node_id, asset_id),
        FOREIGN KEY (canvas_id, node_id) REFERENCES nodes(canvas_id, id) ON DELETE CASCADE,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT
      ) STRICT;
      INSERT INTO asset_references_v13 (canvas_id, node_id, asset_id)
        SELECT canvas_id, node_id, asset_id FROM asset_references;
    `)

    const findAsset = database.prepare('SELECT id, mime_type FROM assets WHERE id = ?')
    const insertReference = database.prepare(`
      INSERT INTO asset_references_v13 (canvas_id, node_id, asset_id) VALUES (?, ?, ?)
      ON CONFLICT(canvas_id, node_id, asset_id) DO NOTHING
    `)
    const directorNodes = database.prepare(`
      SELECT canvas_id, payload_json FROM nodes WHERE json_extract(payload_json, '$.type') = 'director'
    `).all()
    for (const row of directorNodes) {
      const node = JSON.parse(row.payload_json)
      for (const { assetId, required } of nodeAssetReferenceCandidates(node)) {
        if (typeof assetId !== 'string') {
          if (required) throw new Error('项目画布中的导演台节点素材标识无效。')
          continue
        }
        const asset = findAsset.get(assetId)
        if (!asset) {
          if (required) throw new Error('项目画布中的导演台节点引用了不存在的本地素材。')
          continue
        }
        if (!asset.mime_type.startsWith('image/')) {
          if (required) throw new Error('项目画布中的导演台节点素材类型无效。')
          continue
        }
        insertReference.run(row.canvas_id, node.id, assetId)
      }
    }

    database.exec(`
      DROP INDEX IF EXISTS asset_references_by_asset;
      DROP TABLE asset_references;
      ALTER TABLE asset_references_v13 RENAME TO asset_references;
      CREATE INDEX asset_references_by_asset ON asset_references(asset_id);
      PRAGMA user_version = 13;
    `)
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('导演台历史照片引用迁移后检测到无效引用。')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
}

async function migrateDatabaseV13ToV14(database, dataDirectory) {
  const version = databaseVersion(database)
  if (version === 14) return
  if (version !== 13) throw new Error(`无法将本地项目数据库从版本 ${version} 升级到版本 14。`)

  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v13-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(DRAMA_ASSETS_DB_SCHEMA)
    database.exec('PRAGMA user_version = 14')
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('短剧资产迁移后检测到无效引用。')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function migrateDatabaseV14ToV15(database, dataDirectory) {
  const version = databaseVersion(database)
  if (version === 15) return
  if (version !== 14) throw new Error(`无法将本地项目数据库从版本 ${version} 升级到版本 15。`)

  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v14-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(DRAMA_PIPELINE_DB_SCHEMA_V15)
    database.exec('PRAGMA user_version = 15')
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('短剧生产状态迁移后检测到无效引用。')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function migrateDatabaseV15ToV16(database, dataDirectory) {
  const version = databaseVersion(database)
  if (version === 16) return
  if (version !== 15) throw new Error(`无法将本地项目数据库从版本 ${version} 升级到版本 16。`)

  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v15-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(DRAMA_STATE_DB_SCHEMA)
    database.exec('PRAGMA user_version = 16')
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('短剧剧集与关键帧状态迁移后检测到无效引用。')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function migrateDatabaseV16ToV17(database, dataDirectory) {
  const version = databaseVersion(database)
  if (version === 17) return
  if (version !== 16) throw new Error(`无法将本地项目数据库从版本 ${version} 升级到版本 17。`)

  const backupDirectory = path.join(dataDirectory, 'backups')
  await fs.mkdir(backupDirectory, { recursive: true })
  const backupDirectoryInfo = await fs.lstat(backupDirectory)
  const realBackupDirectory = await fs.realpath(backupDirectory)
  if (!backupDirectoryInfo.isDirectory() || backupDirectoryInfo.isSymbolicLink()
    || path.relative(backupDirectory, realBackupDirectory) !== '') {
    throw new Error('项目升级备份目录不能是符号链接。')
  }
  const backupPath = path.join(backupDirectory, `project-schema-v16-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}.sqlite`)
  await backup(database, backupPath)
  await fs.chmod(backupPath, 0o600).catch(() => undefined)

  database.exec('BEGIN IMMEDIATE')
  try {
    const hasColumn = (table, column) => database.prepare(`PRAGMA table_info(${table})`)
      .all().some((row) => row.name === column)
    if (!hasColumn('drama_render_batches', 'request_hash')) {
      database.exec("ALTER TABLE drama_render_batches ADD COLUMN request_hash TEXT NOT NULL DEFAULT '' CHECK (request_hash = '' OR length(request_hash) = 64)")
    }
    for (const [column, definition] of [
      ['provider_type', "TEXT NOT NULL DEFAULT 'cloud' CHECK (provider_type IN ('local', 'cloud'))"],
      ['provider_id', "TEXT NOT NULL DEFAULT 'agnes'"],
      ['model_id', "TEXT NOT NULL DEFAULT 'video'"],
      ['attempt', 'INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0)'],
    ]) {
      if (!hasColumn('drama_render_jobs', column)) {
        database.exec(`ALTER TABLE drama_render_jobs ADD COLUMN ${column} ${definition}`)
      }
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS drama_render_confirmations (
        confirmation_id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL REFERENCES drama_render_batches(batch_id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('submit', 'rerun')),
        job_id TEXT REFERENCES drama_render_jobs(job_id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
        token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
        canvas_version INTEGER NOT NULL CHECK (canvas_version >= 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'expired', 'invalidated')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS drama_render_confirmations_by_batch
        ON drama_render_confirmations(batch_id, created_at DESC, confirmation_id);
    `)
    database.exec(`
      PRAGMA user_version = 17;
    `)
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('渲染批次确认状态迁移后检测到无效引用。')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function readDatabaseCanvas(database, metadata, { allowLegacyParamsAssetReferenceGaps = false } = {}) {
  const projectId = database.prepare('SELECT value FROM project_metadata WHERE key = ?').get('projectId')
  const canvasId = database.prepare('SELECT value FROM project_metadata WHERE key = ?').get('canvasId')
  if (projectId?.value !== metadata.projectId || canvasId?.value !== metadata.canvasId) {
    throw new Error('本地数据库与项目身份不匹配。')
  }

  const canvasRow = database.prepare('SELECT version FROM canvases WHERE id = ?').get(metadata.canvasId)
  if (!canvasRow || !Number.isSafeInteger(canvasRow.version) || canvasRow.version < 0) {
    throw new Error('本地数据库缺少有效画布记录。')
  }
  const nodes = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? ORDER BY rowid').all(metadata.canvasId)
    .map((row) => JSON.parse(row.payload_json))
  const edges = database.prepare('SELECT payload_json FROM edges WHERE canvas_id = ? ORDER BY rowid').all(metadata.canvasId)
    .map((row) => JSON.parse(row.payload_json))
  const groups = databaseVersion(database) >= 5
    ? normalizeCanvasGroups(database.prepare(`
      SELECT id, name, color, layout, node_ids_json FROM canvas_groups
      WHERE canvas_id = ? ORDER BY rowid
    `).all(metadata.canvasId).map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      layout: row.layout,
      nodeIds: JSON.parse(row.node_ids_json),
    })))
    : []
  const stacks = databaseVersion(database) >= 5
    ? normalizeCanvasStacks(database.prepare(`
      SELECT id, collapsed, node_ids_json FROM canvas_stacks
      WHERE canvas_id = ? ORDER BY rowid
    `).all(metadata.canvasId).map((row) => ({
      id: row.id,
      collapsed: Boolean(row.collapsed),
      nodeIds: JSON.parse(row.node_ids_json),
    })))
    : []
  const graph = validateGraph(nodes, edges)
  validateAssetReferences(database, metadata.canvasId, graph, {
    allowLegacyParamsGaps: allowLegacyParamsAssetReferenceGaps,
  })
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    projectId: metadata.projectId,
    canvasId: metadata.canvasId,
    version: canvasRow.version,
    ...graph,
    groups,
    stacks,
  }
}

async function copyAssetSource(sourcePath, temporaryPath) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath.length > 32_768) {
    throw new Error('所选素材文件无效。')
  }
  const source = path.resolve(sourcePath)
  const info = await fs.stat(source).catch(() => null)
  if (!info?.isFile()) throw new Error('请选择一个可读取的素材文件。')
  if (info.size <= 0 || info.size > MAX_ASSET_BYTES) throw new Error('素材文件必须大于 0 字节且不超过 200 MB。')

  let size = 0
  const hash = createHash('sha256')
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    for await (const chunk of nativeFs.createReadStream(source)) {
      size += chunk.length
      if (size > MAX_ASSET_BYTES) throw new Error('素材文件超过 200 MB 的本地素材上限。')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null)
        if (bytesWritten <= 0) throw new Error('素材文件写入失败。')
        offset += bytesWritten
      }
    }
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()
  if (size === 0) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw new Error('所选素材文件为空。')
  }
  return { sha256: hash.digest('hex'), sizeBytes: size }
}

async function copyProjectAssets(database, sourceDataDirectory, targetDataDirectory) {
  const assets = database.prepare('SELECT id, sha256, original_name, mime_type, size_bytes, relative_path FROM assets ORDER BY id').all()
  for (const asset of assets) {
    if (!/^assets\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp|mp4|mov|webm|wav|mp3|ogg|m4a|txt|md)$/iu.test(asset.relative_path)) {
      throw new Error('项目素材清单包含无效路径，无法安全备份。')
    }
    const sourcePath = path.resolve(sourceDataDirectory, asset.relative_path)
    const relativePath = path.relative(sourceDataDirectory, sourcePath)
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error('项目素材清单包含越界路径，无法安全备份。')
    }
    const sourceAssetsDirectory = path.join(sourceDataDirectory, 'assets')
    const sourceAssetDirectory = path.dirname(sourcePath)
    const assetsInfo = await fs.lstat(sourceAssetsDirectory).catch(() => null)
    const assetDirectoryInfo = await fs.lstat(sourceAssetDirectory).catch(() => null)
    const fileInfo = await fs.lstat(sourcePath).catch(() => null)
    if (!assetsInfo?.isDirectory() || assetsInfo.isSymbolicLink()
      || !assetDirectoryInfo?.isDirectory() || assetDirectoryInfo.isSymbolicLink()
      || !fileInfo?.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error(`项目素材“${asset.original_name ?? asset.id}”缺失或路径无效，无法安全备份。`)
    }

    const targetPath = path.resolve(targetDataDirectory, relativePath)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    const copied = await copyAssetSource(sourcePath, targetPath)
    if (copied.sha256 !== asset.sha256 || copied.sizeBytes !== asset.size_bytes
      || await detectAssetMimeType(targetPath) !== asset.mime_type) {
      await fs.rm(targetPath, { force: true }).catch(() => undefined)
      throw new Error(`项目素材“${asset.original_name ?? asset.id}”校验失败，备份未完成。`)
    }
  }
}

async function listAgentBackupFiles(dataDirectory) {
  const agentDirectory = path.join(dataDirectory, 'agent')
  const agentInfo = await fs.lstat(agentDirectory).catch((error) => {
    if (nodeErrorCode(error) === 'ENOENT') return null
    throw error
  })
  if (!agentInfo) return []
  if (!agentInfo.isDirectory() || agentInfo.isSymbolicLink()
    || path.relative(agentDirectory, await fs.realpath(agentDirectory)) !== '') {
    throw new Error('Agent 数据目录无效，无法备份或恢复。')
  }

  const files = []
  const migrationSnapshotName = /^control-v[1-7]-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pre-migration\.sqlite$/iu
  let totalBytes = 0
  const visit = async (directory, relativeDirectory, depth) => {
    if (depth > 24) throw new Error('Agent 数据目录层级超过安全上限。')
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (relativeDirectory === '' && ['writer.lock', 'writer.lock.recovery', 'control.sqlite-wal', 'control.sqlite-shm'].includes(entry.name)) {
        continue
      }
      const absolutePath = path.join(directory, entry.name)
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const info = await fs.lstat(absolutePath)
      if (info.isSymbolicLink()) throw new Error(`Agent 备份路径“${relativePath}”不能是符号链接。`)
      if (relativeDirectory === '' && info.isFile() && migrationSnapshotName.test(entry.name)) continue
      if (info.isDirectory()) {
        if (path.relative(absolutePath, await fs.realpath(absolutePath)) !== '') {
          throw new Error(`Agent 备份目录“${relativePath}”不能指向目录之外。`)
        }
        if (relativeDirectory === '' && !AGENT_BACKUP_DIRECTORIES.has(entry.name)) {
          throw new Error(`Agent 数据目录“${entry.name}”当前不支持备份。`)
        }
        await visit(absolutePath, relativePath, depth + 1)
        continue
      }
      if (!info.isFile()) throw new Error(`Agent 备份路径“${relativePath}”不是普通文件。`)
      if (relativeDirectory === '' && entry.name === 'control.sqlite') {
        files.push({ relativePath: 'agent/control.sqlite', absolutePath, sizeBytes: info.size })
      } else {
        const extension = path.extname(entry.name).toLowerCase()
        if (!AGENT_BACKUP_EXTENSIONS.has(extension)) {
          throw new Error(`Agent 文件“${relativePath}”当前不支持备份。`)
        }
        files.push({ relativePath: `agent/${relativePath}`, absolutePath, sizeBytes: info.size })
      }
      totalBytes += info.size
      if (files.length > MAX_AGENT_BACKUP_FILES || totalBytes > MAX_AGENT_BACKUP_BYTES) {
        throw new Error('Agent 数据超过项目备份容量上限。')
      }
    }
  }

  for (const entry of await fs.readdir(agentDirectory, { withFileTypes: true })) {
    if (['writer.lock', 'writer.lock.recovery', 'control.sqlite-wal', 'control.sqlite-shm'].includes(entry.name)) continue
    const absolutePath = path.join(agentDirectory, entry.name)
    const info = await fs.lstat(absolutePath)
    if (info.isSymbolicLink()) throw new Error(`Agent 备份路径“${entry.name}”不能是符号链接。`)
    // Pre-upgrade snapshots are local rollback files, not the authoritative
    // database of a restored project with a new identity.
    if (info.isFile() && migrationSnapshotName.test(entry.name)) continue
    if (entry.name === 'control.sqlite') {
      if (!info.isFile()) throw new Error('Agent 控制数据库路径无效。')
      files.push({ relativePath: 'agent/control.sqlite', absolutePath, sizeBytes: info.size })
      totalBytes += info.size
      continue
    }
    if (!info.isDirectory() || !AGENT_BACKUP_DIRECTORIES.has(entry.name)) {
      throw new Error(`Agent 数据目录“${entry.name}”当前不支持备份。`)
    }
    await visit(absolutePath, entry.name, 1)
  }
  if (files.length > MAX_AGENT_BACKUP_FILES || totalBytes > MAX_AGENT_BACKUP_BYTES) {
    throw new Error('Agent 数据超过项目备份容量上限。')
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function projectBackupPaths(database, dataDirectory, includeAgent = true) {
  const assetRows = database.prepare('SELECT relative_path FROM assets ORDER BY relative_path').all()
  const paths = ['project.json', 'project.sqlite']
  for (const row of assetRows) {
    if (typeof row.relative_path !== 'string'
      || !/^assets\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp|mp4|mov|webm|wav|mp3|ogg|m4a|txt|md)$/iu.test(row.relative_path)) {
      throw new Error('项目素材清单包含无效路径，无法备份或恢复。')
    }
    paths.push(row.relative_path)
  }
  if (databaseVersion(database) >= 3) {
    const taskRows = database.prepare(`
        SELECT task_id, modality, provider_type, provider_id, input_json, output_path, output_sha256, output_size_bytes
      FROM tasks WHERE status = 'succeeded' ORDER BY task_id
    `).all()
    for (const task of taskRows) {
      const operation = taskOperationFromInput(task.input_json)
      const outputRows = databaseVersion(database) >= 12
        ? database.prepare(`SELECT output_path, output_sha256, output_size_bytes, output_metadata_json FROM task_outputs
            WHERE task_id = ? ORDER BY output_index`).all(task.task_id)
        : []
      const outputs = outputRows.length > 0 ? outputRows : [task]
      for (const output of outputs) {
        validateTaskOutputRelativePath(task.task_id, task.modality, output.output_path, operation)
        if (task.provider_type === 'local' && task.provider_id === 'local-media-tools') {
          let outputMeta = null
          try {
            outputMeta = typeof output.output_metadata_json === 'string'
              ? JSON.parse(output.output_metadata_json)
              : null
          } catch {
            outputMeta = null
          }
          let parameters = null
          try {
            parameters = JSON.parse(task.input_json)
          } catch {
            parameters = null
          }
          if (!normalizeLocalMediaOutputMeta(outputMeta, task, parameters)) {
            throw new Error(`生成任务“${task.task_id}”的本地媒体结果元数据无效，无法备份或恢复。`)
          }
        }
        if (!/^[a-f0-9]{64}$/u.test(output.output_sha256)
          || !Number.isSafeInteger(output.output_size_bytes) || output.output_size_bytes <= 0) {
          throw new Error(`生成任务“${task.task_id}”的结果索引无效，无法备份或恢复。`)
        }
        paths.push(output.output_path)
      }
    }
  }
  if (includeAgent) {
    for (const file of await listAgentBackupFiles(dataDirectory)) paths.push(file.relativePath)
  }
  return paths
}

async function withAgentBackupLock(dataDirectory, operation) {
  const agentDirectory = path.join(dataDirectory, 'agent')
  await fs.mkdir(agentDirectory, { recursive: true, mode: 0o700 })
  const info = await fs.lstat(agentDirectory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Agent 数据目录无效，无法创建项目备份。')
  if (path.relative(agentDirectory, await fs.realpath(agentDirectory)) !== '') {
    throw new Error('Agent 数据目录不能指向目录之外。')
  }
  const recoveryLockPath = path.join(agentDirectory, 'writer.lock.recovery')
  const recoveryLockInfo = await fs.lstat(recoveryLockPath).catch((error) => {
    if (nodeErrorCode(error) === 'ENOENT') return null
    throw error
  })
  if (recoveryLockInfo) throw new Error('Agent 正在恢复写入锁，请稍后再备份。')
  const lockPath = path.join(agentDirectory, 'writer.lock')
  const lock = { pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }
  let handle
  try {
    handle = await fs.open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (nodeErrorCode(error) === 'EEXIST') {
      throw new Error('Agent 正在写入会话，或写入锁状态不明确；请关闭 Agent 后重试备份。')
    }
    throw error
  }
  let ready = false
  try {
    await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8')
    await handle.sync()
    ready = true
    return await operation()
  } finally {
    await handle.close().catch(() => undefined)
    const currentInfo = await fs.lstat(lockPath).catch(() => null)
    if (currentInfo?.isFile() && !currentInfo.isSymbolicLink()) {
      let current
      try {
        current = JSON.parse(await fs.readFile(lockPath, 'utf8'))
      } catch {
        current = null
      }
      if (isRecord(current) && current.token === lock.token) await fs.rm(lockPath, { force: true }).catch(() => undefined)
    }
    if (!ready) await fs.rm(lockPath, { force: true }).catch(() => undefined)
  }
}

async function copyAgentData(sourceDataDirectory, targetDataDirectory, options = {}) {
  const files = await listAgentBackupFiles(sourceDataDirectory)
  if (files.length === 0) return false
  const sourceControl = files.find((file) => file.relativePath === 'agent/control.sqlite')
  if (sourceControl) {
    await validateAgentControlDatabase(sourceControl.absolutePath)
    const sourceDatabase = new DatabaseSync(sourceControl.absolutePath, { timeout: 5000 })
    const targetControl = path.join(targetDataDirectory, 'agent', 'control.sqlite')
    try {
      await fs.mkdir(path.dirname(targetControl), { recursive: true, mode: 0o700 })
      await backup(sourceDatabase, targetControl)
      await validateAgentControlDatabase(targetControl, true)
      await fs.chmod(targetControl, 0o600).catch(() => undefined)
    } finally {
      sourceDatabase.close()
    }
    await fs.rm(`${targetControl}-wal`, { force: true })
    await fs.rm(`${targetControl}-shm`, { force: true })
  }
  for (const file of files) {
    if (file.relativePath === 'agent/control.sqlite') continue
    const sourceInfo = await fs.lstat(file.absolutePath)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Agent 文件“${file.relativePath}”已发生变化。`)
    const targetPath = path.join(targetDataDirectory, ...file.relativePath.split('/'))
    await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 })
    await fs.copyFile(file.absolutePath, targetPath, nativeFs.constants.COPYFILE_EXCL)
    await fs.chmod(targetPath, 0o600).catch(() => undefined)
  }
  if (options.expectedProjectId) {
    await validateAgentSessionHeaders(targetDataDirectory, options.expectedProjectId)
  }
  if (options.rebaseProjectId) {
    await rebaseAgentProjectIdentity(targetDataDirectory, options.rebaseProjectId.from, options.rebaseProjectId.to)
  }
  return true
}

async function validateAgentSessionHeaders(dataDirectory, projectId) {
  const expectedCwd = `vibepaper-project-${projectId}`
  const files = await listAgentBackupFiles(dataDirectory)
  for (const file of files.filter((candidate) => candidate.relativePath.startsWith('agent/sessions/')
    && candidate.relativePath.endsWith('.jsonl'))) {
    let header
    try {
      header = (await readAgentSessionHeader(file.absolutePath)).header
    } catch {
      throw new Error(`Agent 会话“${path.basename(file.absolutePath)}”头部格式无效。`)
    }
    if (!isRecord(header) || header.kind !== 'header' || header.version !== 4 || header.cwd !== expectedCwd
      || !isRecord(header.metadata) || header.metadata.projectId !== projectId) {
      throw new Error(`Agent 会话“${path.basename(file.absolutePath)}”与备份项目身份不匹配。`)
    }
  }
}

async function readAgentSessionHeader(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const chunks = []
    let position = 0
    while (position <= MAX_AGENT_SESSION_HEADER_BYTES) {
      const chunk = Buffer.allocUnsafe(64 * 1024)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) throw new Error('Agent 会话缺少换行结尾的头部。')
      const bytes = chunk.subarray(0, bytesRead)
      const newlineIndex = bytes.indexOf(0x0a)
      if (newlineIndex >= 0) {
        if (position + newlineIndex > MAX_AGENT_SESSION_HEADER_BYTES) {
          throw new Error('Agent 会话头部超过本地上限。')
        }
        chunks.push(Buffer.from(bytes.subarray(0, newlineIndex)))
        const headerBytes = Buffer.concat(chunks)
        let header
        try {
          header = JSON.parse(headerBytes.toString('utf8').replace(/\r$/u, ''))
        } catch {
          throw new Error('Agent 会话头部 JSON 无效。')
        }
        return {
          header,
          lineEnding: headerBytes.at(-1) === 0x0d ? '\r\n' : '\n',
          nextByteOffset: position + newlineIndex + 1,
        }
      }
      chunks.push(Buffer.from(bytes))
      position += bytesRead
    }
    throw new Error('Agent 会话头部超过本地上限。')
  } finally {
    await handle.close()
  }
}

async function writeAgentSessionHeaderAtomically(filePath, header, lineEnding, nextByteOffset) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  try {
    const originalTail = nativeFs.createReadStream(filePath, { start: nextByteOffset })
    async function* updatedContents() {
      yield Buffer.from(`${JSON.stringify(header)}${lineEnding}`, 'utf8')
      for await (const chunk of originalTail) yield chunk
    }
    await pipeline(
      Readable.from(updatedContents()),
      nativeFs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    )
    const handle = await fs.open(temporaryPath, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporaryPath, filePath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function rebaseAgentProjectIdentity(dataDirectory, previousProjectId, nextProjectId) {
  const agentDirectory = path.join(dataDirectory, 'agent')
  const files = await listAgentBackupFiles(dataDirectory)
  const oldCwd = `vibepaper-project-${previousProjectId}`
  const newCwd = `vibepaper-project-${nextProjectId}`
  const memoryFile = files.find((file) => file.relativePath === 'agent/memory/MEMORY.md')
  if (memoryFile) {
    if (memoryFile.sizeBytes > 1024 * 1024) throw new Error('项目记忆文件超过本地上限。')
    const text = await fs.readFile(memoryFile.absolutePath, 'utf8')
    const lines = text.split(/\r?\n/u)
    if (lines[0] !== '# VibePaper project memory') throw new Error('项目记忆文件格式无效。')
    const rebased = lines.map((line) => {
      if (!line.startsWith('- <!-- vibepaper-memory ')) return line
      const match = /^- <!-- vibepaper-memory (\{.*?\}) --> (.*)$/u.exec(line)
      if (!match) throw new Error('项目记忆文件格式无效。')
      const metadata = JSON.parse(match[1])
      if (!isRecord(metadata) || metadata.userId !== previousProjectId || metadata.scope !== 'long_term') {
        throw new Error('项目记忆与备份项目身份不匹配。')
      }
      return `- <!-- vibepaper-memory ${JSON.stringify({ ...metadata, userId: nextProjectId })} --> ${match[2]}`
    }).join('\n')
    await fs.writeFile(memoryFile.absolutePath, rebased, { mode: 0o600 })
  }
  for (const file of files) {
    const scope = file.relativePath.startsWith('agent/session-memory/') && file.relativePath.endsWith('/MEMORY.md') ? 'session'
      : /^agent\/memory\/canvas\/[a-f0-9]{64}\.md$/u.test(file.relativePath) ? 'canvas'
        : /^agent\/daily-memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(file.relativePath) ? 'daily' : null
    if (!scope) continue
    if (file.sizeBytes > 1024 * 1024) throw new Error('项目记忆文件超过本地上限。')
    const lines = (await fs.readFile(file.absolutePath, 'utf8')).split(/\r?\n/u)
    if (lines[0] !== `# VibePaper ${scope} memory`) throw new Error('项目记忆文件格式无效。')
    const rebased = lines.map((line) => {
      if (!line.startsWith('- <!-- vibepaper-memory ')) return line
      const match = /^- <!-- vibepaper-memory (\{.*?\}) --> (.*)$/u.exec(line)
      if (!match) throw new Error('项目记忆文件格式无效。')
      const metadata = JSON.parse(match[1])
      if (!isRecord(metadata) || metadata.userId !== previousProjectId || metadata.scope !== scope) throw new Error('项目记忆与备份项目身份不匹配。')
      return `- <!-- vibepaper-memory ${JSON.stringify({ ...metadata, userId: nextProjectId })} --> ${match[2]}`
    }).join('\n')
    await fs.writeFile(file.absolutePath, rebased, { mode: 0o600 })
  }
  for (const file of files.filter((candidate) => candidate.relativePath.startsWith('agent/sessions/')
    && candidate.relativePath.endsWith('.jsonl'))) {
    const { header, lineEnding, nextByteOffset } = await readAgentSessionHeader(file.absolutePath)
    if (!isRecord(header) || header.kind !== 'header' || header.version !== 4 || header.cwd !== oldCwd
      || !isRecord(header.metadata) || header.metadata.projectId !== previousProjectId) {
      throw new Error(`Agent 会话“${path.basename(file.absolutePath)}”与备份项目身份不匹配。`)
    }
    header.cwd = newCwd
    header.metadata = { ...header.metadata, projectId: nextProjectId }
    await writeAgentSessionHeaderAtomically(file.absolutePath, header, lineEnding, nextByteOffset)
  }

  const oldSessionDirectory = path.join(agentDirectory, 'sessions', `--${oldCwd}--`)
  const newSessionDirectory = path.join(agentDirectory, 'sessions', `--${newCwd}--`)
  const oldDirectoryInfo = await fs.lstat(oldSessionDirectory).catch((error) => {
    if (nodeErrorCode(error) === 'ENOENT') return null
    throw error
  })
  if (oldDirectoryInfo) {
    if (!oldDirectoryInfo.isDirectory() || oldDirectoryInfo.isSymbolicLink()) throw new Error('Agent 会话目录无效。')
    const newDirectoryInfo = await fs.lstat(newSessionDirectory).catch(() => null)
    if (newDirectoryInfo) throw new Error('恢复副本中已存在相同的 Agent 会话目录。')
    await fs.rename(oldSessionDirectory, newSessionDirectory)
  }

  const controlPath = path.join(agentDirectory, 'control.sqlite')
  const controlInfo = await fs.lstat(controlPath).catch((error) => {
    if (nodeErrorCode(error) === 'ENOENT') return null
    throw error
  })
  if (!controlInfo) return
  if (!controlInfo.isFile() || controlInfo.isSymbolicLink()) throw new Error('Agent 控制数据库路径无效。')
  const control = new DatabaseSync(controlPath, { timeout: 5000 })
  try {
    const version = Number(control.prepare('PRAGMA user_version').get().user_version)
    if (![1, 2, 3, 4, 5, 6, 7, 8].includes(version)) throw new Error('Agent 控制数据库版本当前不支持恢复。')
    const integrity = control.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok'
      || control.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('Agent 控制数据库完整性校验失败。')
    }
    const now = new Date().toISOString()
    control.exec('BEGIN IMMEDIATE')
    try {
      control.prepare(`UPDATE approvals SET project_id = ?, status = CASE WHEN status IN ('pending', 'accepted') THEN 'invalidated' ELSE status END, updated_at = ?`)
        .run(nextProjectId, now)
      if (version >= 4) {
        if (control.prepare('SELECT 1 FROM desktop_memory_candidates WHERE user_id != ? LIMIT 1').get(previousProjectId)) throw new Error('记忆候选与备份项目身份不匹配。')
        control.prepare('UPDATE desktop_memory_candidates SET user_id = ? WHERE user_id = ?').run(nextProjectId, previousProjectId)
      }
      if (version >= 6) {
        if (control.prepare('SELECT 1 FROM desktop_task_continuations WHERE project_id != ? LIMIT 1').get(previousProjectId)) {
          throw new Error('Agent 续跑记录与备份项目身份不匹配。')
        }
        // A restored copy has a new project identity and cannot inherit an
        // authorization to continue the source project's pending operations.
        control.prepare(`UPDATE desktop_task_continuations SET project_id = ?,
          status = CASE WHEN status IN ('pending', 'claimed', 'interrupted') THEN 'invalidated' ELSE status END,
          updated_at = ?`).run(nextProjectId, now)
      }
      if (version >= 8) {
        control.prepare('UPDATE desktop_plan_execution_context SET stop_requested = 1, updated_at = ?').run(now)
        control.prepare(`UPDATE desktop_plan_executions SET state = 'cancelled',
          error_code = 'PROJECT_RESTORED', updated_at = ?
          WHERE state IN ('running', 'waiting_confirmation', 'waiting_task', 'reconciliation_required')`).run(now)
      }
      const activeRuns = control.prepare(`SELECT id, session_id FROM agent_runs
        WHERE status IN ('queued', 'running', 'waiting_confirmation', 'waiting_task')`).all()
      for (const run of activeRuns) {
        const eventSeq = Number(control.prepare('SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM run_events WHERE session_id = ?')
          .get(run.session_id).next_seq)
        const eventId = randomUUID()
        const outboxId = randomUUID()
        const data = { reason: 'PROJECT_RESTORED' }
        const event = {
          eventId,
          sessionId: run.session_id,
          runId: run.id,
          eventSeq,
          type: 'run_aborted',
          runtime: 'pi',
          runtimeVersion: 'desktop-restore',
          data,
          createdAt: now,
        }
        control.prepare("UPDATE agent_runs SET status = 'aborted', updated_at = ? WHERE id = ?").run(now, run.id)
        control.prepare(`INSERT INTO run_events
          (event_id, session_id, run_id, event_seq, type, runtime, runtime_version, data_json, created_at)
          VALUES (?, ?, ?, ?, 'run_aborted', 'pi', 'desktop-restore', ?, ?)`)
          .run(eventId, run.session_id, run.id, eventSeq, JSON.stringify(data), now)
        control.prepare(`INSERT INTO outbox
          (outbox_id, session_id, run_id, event_seq, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(outboxId, run.session_id, run.id, eventSeq, JSON.stringify(event), now)
      }
      control.exec('COMMIT')
    } catch (error) {
      control.exec('ROLLBACK')
      throw error
    }
  } finally {
    closeDatabase(control)
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of nativeFs.createReadStream(filePath)) {
    sizeBytes += chunk.length
    hash.update(chunk)
  }
  return { sha256: hash.digest('hex'), sizeBytes }
}

async function validateAgentControlDatabase(filePath, checkpointOnClose = false) {
  const database = new DatabaseSync(filePath, { timeout: 5000 })
  try {
    const version = Number(database.prepare('PRAGMA user_version').get().user_version)
    const integrity = database.prepare('PRAGMA integrity_check').all()
    if (![1, 2, 3, 4, 5, 6, 7, 8].includes(version) || integrity.length !== 1 || integrity[0].integrity_check !== 'ok'
      || database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('Agent 控制数据库版本或完整性校验失败。')
    }
  } finally {
    if (checkpointOnClose) closeDatabase(database)
    else database.close()
  }
}

function isValidAgentBackupRelativePath(relativePath) {
  if (relativePath === 'agent/control.sqlite') return true
  if (typeof relativePath !== 'string' || !relativePath.startsWith('agent/')) return false
  const segments = relativePath.split('/')
  return segments.length >= 3
    && segments.every((segment) => segment && segment !== '.' && segment !== '..'
      && /^[A-Za-z0-9._-]+$/u.test(segment))
    && AGENT_BACKUP_DIRECTORIES.has(segments[1])
    && AGENT_BACKUP_EXTENSIONS.has(path.extname(segments.at(-1)).toLowerCase())
}

async function safeBackupFilePath(dataDirectory, relativePath) {
  const taskOutputMatch = /^generated\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/([a-z0-9][a-z0-9._-]{0,126})$/iu.exec(relativePath)
  const taskOutputExtensions = ['.txt', '.md', '.json', '.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.mov']
  const isTaskOutput = taskOutputMatch && !taskOutputMatch[2].includes('..')
    && taskOutputExtensions.includes(path.extname(taskOutputMatch[2]).toLowerCase())
  const isAgentFile = isValidAgentBackupRelativePath(relativePath)
  if (relativePath !== 'project.json' && relativePath !== 'project.sqlite'
    && !/^assets\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp|mp4|mov|webm|wav|mp3|ogg|m4a|txt|md)$/iu.test(relativePath)
    && !isTaskOutput && !isAgentFile) {
    throw new Error('备份包含无效文件路径。')
  }
  const rootInfo = await fs.lstat(dataDirectory).catch(() => null)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()
    || path.relative(dataDirectory, await fs.realpath(dataDirectory)) !== '') {
    throw new Error('备份项目数据目录无效。')
  }
  const filePath = path.join(dataDirectory, relativePath)
  if (relativePath.startsWith('assets/')) {
    const assetsPath = path.join(dataDirectory, 'assets')
    const hashPath = path.dirname(filePath)
    const assetsInfo = await fs.lstat(assetsPath).catch(() => null)
    const hashInfo = await fs.lstat(hashPath).catch(() => null)
    if (!assetsInfo?.isDirectory() || assetsInfo.isSymbolicLink()
      || !hashInfo?.isDirectory() || hashInfo.isSymbolicLink()
      || path.relative(assetsPath, await fs.realpath(assetsPath)) !== ''
      || path.relative(hashPath, await fs.realpath(hashPath)) !== '') {
      throw new Error(`备份素材“${relativePath}”所在目录无效。`)
    }
  } else if (isTaskOutput) {
    const generatedPath = path.join(dataDirectory, 'generated')
    const taskPath = path.join(generatedPath, taskOutputMatch[1])
    for (const directory of [generatedPath, taskPath]) {
      const info = await fs.lstat(directory).catch(() => null)
      if (!info?.isDirectory() || info.isSymbolicLink()
        || path.relative(directory, await fs.realpath(directory)) !== '') {
        throw new Error(`备份任务结果目录“${relativePath}”无效。`)
      }
    }
  } else if (isAgentFile) {
    const segments = relativePath.split('/').slice(0, -1)
    let currentDirectory = dataDirectory
    for (const segment of segments) {
      currentDirectory = path.join(currentDirectory, segment)
      const directoryInfo = await fs.lstat(currentDirectory).catch(() => null)
      if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()
        || path.relative(currentDirectory, await fs.realpath(currentDirectory)) !== '') {
        throw new Error(`Agent 备份目录“${relativePath}”无效。`)
      }
    }
  }
  const fileInfo = await fs.lstat(filePath).catch(() => null)
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) throw new Error(`备份文件“${relativePath}”缺失或路径无效。`)
  if (relativePath.startsWith('assets/') && (fileInfo.size <= 0 || fileInfo.size > MAX_ASSET_BYTES)) {
    throw new Error(`备份素材“${relativePath}”为空或超过本地素材上限。`)
  }
  if (isTaskOutput && (fileInfo.size <= 0 || fileInfo.size > MAX_TASK_OUTPUT_BYTES)) {
    throw new Error(`备份任务结果“${relativePath}”为空或超过本地结果上限。`)
  }
  if (isAgentFile && fileInfo.size > MAX_AGENT_BACKUP_BYTES) throw new Error(`Agent 文件“${relativePath}”超过本地备份上限。`)
  return filePath
}

async function createBackupManifest(dataDirectory, metadata, database, createdAt = new Date().toISOString()) {
  const files = []
  for (const relativePath of await projectBackupPaths(database, dataDirectory)) {
    const file = await hashFile(await safeBackupFilePath(dataDirectory, relativePath))
    files.push({ path: relativePath, ...file })
  }
  return {
    schemaVersion: PROJECT_BACKUP_SCHEMA_VERSION,
    projectId: metadata.projectId,
    createdAt,
    files,
  }
}

async function verifyBackupManifest(dataDirectory, metadata, database) {
  const manifestPath = path.join(dataDirectory, 'backup-manifest.json')
  let manifest
  try {
    const manifestInfo = await fs.lstat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('备份校验清单路径无效。')
    manifest = await readJson(manifestPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    if (error instanceof Error && error.message === '备份校验清单路径无效。') throw error
    throw new Error('备份校验清单无法读取。')
  }
  if (!isRecord(manifest) || ![1, PROJECT_BACKUP_SCHEMA_VERSION].includes(manifest.schemaVersion)
    || manifest.projectId !== metadata.projectId || typeof manifest.createdAt !== 'string'
    || !Array.isArray(manifest.files) || manifest.files.some((file) => !isRecord(file))) {
    throw new Error('备份校验清单格式无效。')
  }

  const expectedPaths = (await projectBackupPaths(database, dataDirectory, manifest.schemaVersion >= 2)).sort()
  const actualPaths = manifest.files.map((file) => file?.path)
  if (actualPaths.some((filePath) => typeof filePath !== 'string')
    || new Set(actualPaths).size !== actualPaths.length
    || JSON.stringify([...actualPaths].sort()) !== JSON.stringify(expectedPaths)) {
    throw new Error('备份文件清单与项目数据库不一致。')
  }

  for (const entry of manifest.files) {
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)
      || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      throw new Error('备份文件校验信息无效。')
    }
    const actual = await hashFile(await safeBackupFilePath(dataDirectory, entry.path))
    if (actual.sha256 !== entry.sha256 || actual.sizeBytes !== entry.sizeBytes) {
      throw new Error(`备份文件“${entry.path}”校验失败。`)
    }
    if (entry.path === 'agent/control.sqlite') await validateAgentControlDatabase(await safeBackupFilePath(dataDirectory, entry.path))
    if (entry.path.startsWith('assets/')) {
      const asset = database.prepare('SELECT mime_type, sha256, size_bytes FROM assets WHERE relative_path = ?').get(entry.path)
      const assetPath = await safeBackupFilePath(dataDirectory, entry.path)
      if (!asset || asset.size_bytes > MAX_ASSET_BYTES || await detectAssetMimeType(assetPath) !== asset.mime_type) {
        throw new Error(`备份素材“${entry.path}”格式校验失败。`)
      }
    }
  }
  if (manifest.schemaVersion >= 2) await validateAgentSessionHeaders(dataDirectory, metadata.projectId)
  return manifest.schemaVersion
}

async function invalidateBackupManifest(dataDirectory) {
  await fs.rm(path.join(dataDirectory, 'backup-manifest.json'), { force: true })
}

async function validateRestorableProject(projectDirectory) {
  const directory = path.resolve(projectDirectory)
  const dataDirectory = path.join(directory, '.vibepaper')
  const dataInfo = await fs.lstat(dataDirectory).catch(() => null)
  if (!dataInfo?.isDirectory() || dataInfo.isSymbolicLink()) {
    throw new Error('所选文件夹不是有效的 VibePaper 项目备份。')
  }
  const realDataDirectory = await fs.realpath(dataDirectory)
  if (path.relative(dataDirectory, realDataDirectory) !== '') throw new Error('备份项目数据目录无效。')

  const metadataPath = path.join(dataDirectory, 'project.json')
  const metadataInfo = await fs.lstat(metadataPath).catch(() => null)
  if (!metadataInfo?.isFile() || metadataInfo.isSymbolicLink()) throw new Error('备份项目元数据缺失或路径无效。')
  let metadata
  try {
    metadata = await readJson(metadataPath)
  } catch {
    throw new Error('备份项目缺少有效的项目元数据。')
  }
  validateMetadata(metadata)

  const databasePath = path.join(dataDirectory, 'project.sqlite')
  const databaseInfo = await fs.lstat(databasePath).catch(() => null)
  if (!databaseInfo?.isFile() || databaseInfo.isSymbolicLink()) throw new Error('备份项目数据库缺失或路径无效。')
  const database = new DatabaseSync(databasePath, { timeout: 5000 })
  try {
    const schemaVersion = databaseVersion(database)
    if (![2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, PROJECT_DB_SCHEMA_VERSION].includes(schemaVersion)) {
      throw new Error('该备份的项目数据库版本当前不支持恢复。')
    }
    const integrity = database.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('备份项目数据库完整性校验失败。')
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('备份项目数据库存在无效引用。')
    }
    readDatabaseCanvas(database, metadata, { allowLegacyParamsAssetReferenceGaps: schemaVersion === 8 })
    const backupSchemaVersion = await verifyBackupManifest(dataDirectory, metadata, database)
    return { directory, dataDirectory, metadata, database, backupSchemaVersion }
  } catch (error) {
    database.close()
    throw error
  }
}

function restoredProjectName(originalName) {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  return validateProjectName(`${originalName.slice(0, 24)} Restored ${timestamp} ${randomUUID().slice(0, 6)}`)
}

async function detectImageMimeType(filePath) {
  const handle = await fs.open(filePath, 'r')
  const header = Buffer.alloc(16)
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
    if (bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg'
    if (bytesRead >= 6 && ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6))) return 'image/gif'
    if (bytesRead >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
    throw new Error('当前本地素材切片只支持 PNG、JPEG、GIF 和 WebP 图片。')
  } finally {
    await handle.close()
  }
}

async function detectWavMimeType(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (info.size < 44 || info.size > MAX_ASSET_BYTES) throw new Error('本地 WAV 素材大小无效。')
    const header = Buffer.alloc(12)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'RIFF'
      || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('本地 WAV 素材格式无效。')
    }
    const riffEnd = header.readUInt32LE(4) + 8
    if (riffEnd < 44 || riffEnd > info.size) throw new Error('本地 WAV 素材块长度无效。')

    let offset = 12
    let hasFormat = false
    let hasAudioData = false
    while (offset + 8 <= riffEnd) {
      const chunkHeader = Buffer.alloc(8)
      const read = await handle.read(chunkHeader, 0, chunkHeader.length, offset)
      if (read.bytesRead !== chunkHeader.length) throw new Error('本地 WAV 素材块已截断。')
      const chunkSize = chunkHeader.readUInt32LE(4)
      const bodyOffset = offset + 8
      const nextOffset = bodyOffset + chunkSize + (chunkSize % 2)
      if (nextOffset > riffEnd) throw new Error('本地 WAV 素材块长度无效。')
      const chunkName = chunkHeader.toString('ascii', 0, 4)
      if (chunkName === 'fmt ') {
        if (chunkSize < 16) throw new Error('本地 WAV 音频格式块无效。')
        const format = Buffer.alloc(16)
        const formatRead = await handle.read(format, 0, format.length, bodyOffset)
        if (formatRead.bytesRead !== format.length || format.readUInt16LE(2) <= 0
          || format.readUInt32LE(4) <= 0 || format.readUInt16LE(12) <= 0 || format.readUInt16LE(14) <= 0) {
          throw new Error('本地 WAV 音频参数无效。')
        }
        hasFormat = true
      } else if (chunkName === 'data') {
        if (chunkSize <= 0) throw new Error('本地 WAV 音频数据为空。')
        hasAudioData = true
      }
      offset = nextOffset
    }
    if (!hasFormat || !hasAudioData) throw new Error('本地 WAV 素材缺少音频格式或数据块。')
    return 'audio/wav'
  } finally {
    await handle.close()
  }
}

async function detectMp3MimeType(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (info.size < 24 || info.size > MAX_ASSET_BYTES) throw new Error('本地 MP3 素材大小无效。')

    const id3Header = Buffer.alloc(10)
    const initialRead = await handle.read(id3Header, 0, id3Header.length, 0)
    let audioOffset = 0
    if (initialRead.bytesRead >= 3 && id3Header.toString('ascii', 0, 3) === 'ID3') {
      if (initialRead.bytesRead !== id3Header.length) throw new Error('本地 MP3 ID3v2 标记已截断。')
      const majorVersion = id3Header[3]
      const revision = id3Header[4]
      const flags = id3Header[5]
      const encodedSize = id3Header.subarray(6, 10)
      if (majorVersion < 2 || majorVersion > 4 || revision === 0xff
        || encodedSize.some((byte) => (byte & 0x80) !== 0)) {
        throw new Error('本地 MP3 ID3v2 标记无效。')
      }
      const tagSize = ((encodedSize[0] & 0x7f) << 21)
        | ((encodedSize[1] & 0x7f) << 14)
        | ((encodedSize[2] & 0x7f) << 7)
        | (encodedSize[3] & 0x7f)
      audioOffset = 10 + tagSize
      if (audioOffset > info.size) throw new Error('本地 MP3 ID3v2 标记已截断。')
      if (majorVersion === 4 && (flags & 0x10) !== 0) {
        if (tagSize < 10) throw new Error('本地 MP3 ID3v2 尾标记无效。')
        const footer = Buffer.alloc(10)
        const footerRead = await handle.read(footer, 0, footer.length, audioOffset - footer.length)
        if (footerRead.bytesRead !== footer.length || footer.toString('ascii', 0, 3) !== '3DI'
          || !footer.subarray(3).equals(id3Header.subarray(3))) {
          throw new Error('本地 MP3 ID3v2 尾标记无效。')
        }
      }
    }

    const scanLength = Math.min(info.size - audioOffset, 65_536)
    const audioHeaders = Buffer.alloc(scanLength)
    const scanRead = await handle.read(audioHeaders, 0, audioHeaders.length, audioOffset)
    let foundTruncatedFrame = false
    const mpeg1Bitrates = {
      1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
      2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
      3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
    }
    const mpeg2Bitrates = {
      1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
      2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
      3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
    }
    const baseSampleRates = [44_100, 48_000, 32_000]
    for (let offset = 0; offset + 4 <= scanRead.bytesRead; offset += 1) {
      const header = audioHeaders.readUInt32BE(offset)
      if ((header >>> 21) !== 0x7ff) continue
      const version = (header >>> 19) & 0x3
      const layer = (header >>> 17) & 0x3
      const bitrateIndex = (header >>> 12) & 0xf
      const sampleRateIndex = (header >>> 10) & 0x3
      if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 0xf || sampleRateIndex === 0x3) continue

      const bitrateKbps = (version === 3 ? mpeg1Bitrates : mpeg2Bitrates)[layer][bitrateIndex]
      const sampleRate = baseSampleRates[sampleRateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
      const padding = (header >>> 9) & 1
      const frameLength = Math.floor(((version === 3 ? 144 : 72) * bitrateKbps * 1000) / sampleRate + padding)
      const absoluteOffset = audioOffset + offset
      if (frameLength < 24 || absoluteOffset + frameLength > info.size) {
        foundTruncatedFrame = true
        continue
      }
      return 'audio/mpeg'
    }
    if (foundTruncatedFrame) throw new Error('本地 MP3 MPEG 音频帧已截断。')
    throw new Error('本地 MP3 素材缺少有效 MPEG 音频帧。')
  } finally {
    await handle.close()
  }
}

async function detectAudioMimeType(filePath, diagnosticPath = filePath) {
  const extension = path.extname(diagnosticPath).toLowerCase()
  if (extension === '.m4a') return detectContainerMimeType(filePath, diagnosticPath)
  if (extension === '.ogg') return detectOggMimeType(filePath)
  try {
    return await detectWavMimeType(filePath)
  } catch (wavError) {
    try {
      return await detectMp3MimeType(filePath)
    } catch (mp3Error) {
      const extension = path.extname(diagnosticPath).toLowerCase()
      if (extension === '.wav') throw wavError
      throw mp3Error
    }
  }
}

async function detectOggMimeType(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const info = await handle.stat()
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (info.size > MAX_ASSET_BYTES || bytesRead !== 4 || header.toString('ascii') !== 'OggS') {
      throw new Error('本地 OGG 音频素材格式无效。')
    }
    return 'audio/ogg'
  } finally {
    await handle.close()
  }
}

async function detectContainerMimeType(filePath, diagnosticPath = filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (info.size < 12 || info.size > MAX_ASSET_BYTES) throw new Error('本地视频或 M4A 素材大小无效。')
    const header = Buffer.alloc(16)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead < 12 || header.toString('ascii', 4, 8) !== 'ftyp') {
      throw new Error(path.extname(diagnosticPath).toLowerCase() === '.m4a'
        ? '本地 M4A 音频素材格式无效。' : '本地 MP4/MOV 视频素材格式无效。')
    }
    const boxSize = header.readUInt32BE(0)
    if (boxSize < 16 || boxSize > info.size) throw new Error('本地 MP4/MOV 素材容器长度无效。')
    const brand = header.toString('ascii', 8, 12)
    const extension = path.extname(diagnosticPath).toLowerCase()
    if (extension === '.m4a' || /^M4[ABP ]$/u.test(brand)) return 'audio/mp4'
    if (extension === '.mov' || brand === 'qt  ') return 'video/quicktime'
    return 'video/mp4'
  } finally {
    await handle.close()
  }
}

async function detectVideoMimeType(filePath, diagnosticPath = filePath) {
  const extension = path.extname(diagnosticPath).toLowerCase()
  const handle = await fs.open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (info.size < 4 || info.size > MAX_ASSET_BYTES) throw new Error('本地视频素材大小无效。')
    const header = Buffer.alloc(16)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (extension === '.webm') {
      if (bytesRead >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm'
      throw new Error('本地 WebM 视频素材格式无效。')
    }
  } finally {
    await handle.close()
  }
  return detectContainerMimeType(filePath, diagnosticPath)
}

async function detectTextMimeType(filePath, diagnosticPath = filePath) {
  const extension = path.extname(diagnosticPath).toLowerCase()
  if (!['.txt', '.md'].includes(extension)) throw new Error('文本素材只支持 TXT 和 Markdown 文件。')
  const info = await fs.stat(filePath)
  if (info.size <= 0 || info.size > MAX_ASSET_BYTES) throw new Error('本地文本素材大小无效。')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for await (const chunk of nativeFs.createReadStream(filePath)) {
      if (chunk.includes(0)) throw new Error('本地文本素材包含二进制数据。')
      decoder.decode(chunk, { stream: true })
    }
    decoder.decode()
  } catch (error) {
    if (error instanceof Error && error.message === '本地文本素材包含二进制数据。') throw error
    throw new Error('本地文本素材不是有效的 UTF-8 文件。')
  }
  return extension === '.md' ? 'text/markdown' : 'text/plain'
}

async function detectAssetMimeType(filePath, diagnosticPath = filePath) {
  const extension = path.extname(diagnosticPath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) return detectImageMimeType(filePath)
  if (['.wav', '.mp3', '.ogg', '.m4a'].includes(extension)) return detectAudioMimeType(filePath, diagnosticPath)
  if (['.mp4', '.mov', '.webm'].includes(extension)) return detectVideoMimeType(filePath, diagnosticPath)
  if (['.txt', '.md'].includes(extension)) return detectTextMimeType(filePath, diagnosticPath)
  throw new Error('素材类型必须是 PNG/JPEG/GIF/WebP 图片、MP4/MOV/WebM 视频、WAV/MP3/OGG/M4A 音频或 TXT/MD 文本。')
}

function extensionForAssetMimeType(mimeType) {
  return ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'text/plain': 'txt',
    'text/markdown': 'md',
  })[mimeType]
}

async function projectAssetsDirectory(projectDirectory) {
  const dataPath = path.join(projectDirectory, '.vibepaper')
  const dataInfo = await fs.lstat(dataPath)
  if (!dataInfo.isDirectory() || dataInfo.isSymbolicLink()) throw new Error('项目数据目录无效。')
  const dataDirectory = await fs.realpath(dataPath)
  const expectedAssetsDirectory = path.join(dataDirectory, 'assets')
  await fs.mkdir(expectedAssetsDirectory, { recursive: true })
  const assetsDirectory = await fs.realpath(expectedAssetsDirectory)
  if (path.relative(expectedAssetsDirectory, assetsDirectory) !== '') throw new Error('项目素材目录不能是符号链接。')
  return { dataDirectory, assetsDirectory }
}

function assertAssetRowPath(asset) {
  if (!isRecord(asset) || typeof asset.id !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(asset.id)
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(asset.sha256)) {
    throw new Error('本地素材索引无效。')
  }
  const extension = extensionForAssetMimeType(asset.mime_type)
  const expectedPath = `assets/${asset.sha256}/${asset.id}.${extension}`
  if (!extension || asset.relative_path !== expectedPath) throw new Error('本地素材路径无效。')
  return expectedPath
}

async function resolveProjectAssetFile(projectDirectory, asset, { allowMissing = false } = {}) {
  const relativePath = assertAssetRowPath(asset)
  const { dataDirectory, assetsDirectory } = await projectAssetsDirectory(projectDirectory)
  const filePath = path.resolve(dataDirectory, ...relativePath.split('/'))
  const relativeToAssets = path.relative(assetsDirectory, filePath)
  if (!relativeToAssets || relativeToAssets === '..' || relativeToAssets.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToAssets)) {
    throw new Error('本地素材路径越界。')
  }

  const directory = path.dirname(filePath)
  const directoryInfo = await fs.lstat(directory).catch((error) => {
    if (allowMissing && nodeErrorCode(error) === 'ENOENT') return null
    throw error
  })
  if (!directoryInfo && allowMissing) return null
  const realDirectory = await fs.realpath(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
    || path.relative(directory, realDirectory) !== '') {
    throw new Error('本地素材内容目录缺失或路径无效。')
  }

  const fileInfo = await fs.lstat(filePath).catch((error) => {
    if (allowMissing && nodeErrorCode(error) === 'ENOENT') return null
    throw error
  })
  if (!fileInfo && allowMissing) return null
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error('本地素材文件缺失或路径无效。')
  const realFile = await fs.realpath(filePath)
  if (path.relative(filePath, realFile) !== '') throw new Error('本地素材文件不能是符号链接。')
  return { filePath, dataDirectory, assetsDirectory }
}

function normalizeAssetName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) {
    throw new Error('素材名称需为 1-255 个字符。')
  }
  const name = value.replace(/[\u0000-\u001f]/gu, '_')
  if (!name.trim()) throw new Error('素材名称不能为空。')
  return name
}

function assertExpectedProjectIdentity(metadata, expectedIdentity) {
  if (expectedIdentity === undefined || expectedIdentity === null) return
  if (!isRecord(expectedIdentity)
    || typeof expectedIdentity.projectId !== 'string' || !expectedIdentity.projectId
    || typeof expectedIdentity.canvasId !== 'string' || !expectedIdentity.canvasId) {
    throw new Error('最近项目身份校验请求无效。')
  }
  if (metadata.projectId !== expectedIdentity.projectId || metadata.canvasId !== expectedIdentity.canvasId) {
    throw new Error('最近项目身份已变化，请从项目目录重新打开。')
  }
}

async function inspectProjectDirectory(projectDirectory, expectedIdentity) {
  if (typeof projectDirectory !== 'string' || !projectDirectory.trim()) throw new Error('项目目录无效。')
  const directory = await fs.realpath(path.resolve(projectDirectory))
  const rootInfo = await fs.lstat(directory)
  if (!rootInfo.isDirectory()) throw new Error('项目目录不是文件夹。')
  const dataDirectory = path.join(directory, '.vibepaper')
  const dataDirectoryInfo = await fs.lstat(dataDirectory).catch(() => null)
  if (!dataDirectoryInfo?.isDirectory() || dataDirectoryInfo.isSymbolicLink()) {
    throw new Error('项目数据目录缺失、无效或不能是符号链接。')
  }
  const metadata = await readProjectMetadata(dataDirectory)
  validateMetadata(metadata)
  assertExpectedProjectIdentity(metadata, expectedIdentity)

  const databasePath = path.join(dataDirectory, 'project.sqlite')
  const databaseInfo = await fs.lstat(databasePath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
  if (!databaseInfo) {
    await readProjectLegacyCanvas(dataDirectory, metadata)
    return { project: publicProject(metadata), directory }
  }
  if (databaseInfo.isSymbolicLink() || !databaseInfo.isFile()) {
    throw new Error('项目数据库不能是符号链接或非普通文件。')
  }

  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 })
  try {
    const version = databaseVersion(database)
    if (version === 0) {
      await readProjectLegacyCanvas(dataDirectory, metadata)
    } else {
      if (version < 1 || version > PROJECT_DB_SCHEMA_VERSION) {
        throw new Error(`本地项目数据库版本 ${version} 当前不受支持。`)
      }
      const storedProjectId = database.prepare('SELECT value FROM project_metadata WHERE key = ?').get('projectId')
      const storedCanvasId = database.prepare('SELECT value FROM project_metadata WHERE key = ?').get('canvasId')
      if (storedProjectId?.value !== metadata.projectId || storedCanvasId?.value !== metadata.canvasId) {
        throw new Error('本地数据库与项目身份不匹配。')
      }
      const canvas = database.prepare('SELECT id FROM canvases WHERE id = ?').get(metadata.canvasId)
      if (!canvas) throw new Error('本地数据库缺少项目对应的画布。')
    }
  } finally {
    database.close()
  }
  return { project: publicProject(metadata), directory }
}

async function openProjectData(projectDirectory, expectedIdentity) {
  const directory = await fs.realpath(path.resolve(projectDirectory))
  const dataDirectory = path.join(directory, '.vibepaper')
  const dataDirectoryInfo = await fs.lstat(dataDirectory).catch(() => null)
  if (!dataDirectoryInfo?.isDirectory() || dataDirectoryInfo.isSymbolicLink()) {
    throw new Error('项目数据目录缺失、无效或不能是符号链接。')
  }
  let metadata
  try {
    metadata = await readProjectMetadata(dataDirectory)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
      throw new Error('所选文件夹不是可读取的 VibePaper 本地项目。')
    }
    throw error
  }
  validateMetadata(metadata)
  assertExpectedProjectIdentity(metadata, expectedIdentity)

  const releaseWriterLock = await acquireProjectWriterLock(dataDirectory)
  let database
  try {
    const databasePath = path.join(dataDirectory, 'project.sqlite')
    const databaseInfo = await fs.lstat(databasePath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
    if (databaseInfo?.isSymbolicLink() || (databaseInfo && !databaseInfo.isFile())) {
      throw new Error('项目数据库不能是符号链接或非普通文件。')
    }
    database = new DatabaseSync(databasePath, { timeout: 5000 })
    setDatabaseMode(database)
    const version = databaseVersion(database)
    if (version > 0 && version < PROJECT_DB_SCHEMA_VERSION) {
      await invalidateBackupManifest(dataDirectory)
    }
    if (version === 0) {
      let legacyCanvas
      try {
        legacyCanvas = await readProjectLegacyCanvas(dataDirectory, metadata)
      } catch (error) {
        if (error && error.code === 'ENOENT') throw new Error('项目缺少画布数据库和可迁移的画布文件。')
        throw error
      }
      initializeDatabase(database, metadata, legacyCanvas)
    } else {
      if (version === 1) await migrateDatabaseV1ToV2(database, dataDirectory)
      const migratedVersion = databaseVersion(database)
      if (migratedVersion === 2) await migrateDatabaseV2ToV3(database, dataDirectory)
      if (databaseVersion(database) === 3) await migrateDatabaseV3ToV4(database, dataDirectory)
      if (databaseVersion(database) === 4) await migrateDatabaseV4ToV5(database, dataDirectory)
      if (databaseVersion(database) === 5) await migrateDatabaseV5ToV6(database, dataDirectory)
      if (databaseVersion(database) === 6) await migrateDatabaseV6ToV7(database, dataDirectory)
      if (databaseVersion(database) === 7) await migrateDatabaseV7ToV8(database, dataDirectory)
      if (databaseVersion(database) === 8) await migrateDatabaseV8ToV9(database, dataDirectory)
      if (databaseVersion(database) === 9) await migrateDatabaseV9ToV10(database, dataDirectory)
      if (databaseVersion(database) === 10) await migrateDatabaseV10ToV11(database, dataDirectory)
      if (databaseVersion(database) === 11) await migrateDatabaseV11ToV12(database, dataDirectory)
      if (databaseVersion(database) === 12) await migrateDatabaseV12ToV13(database, dataDirectory)
      if (databaseVersion(database) === 13) await migrateDatabaseV13ToV14(database, dataDirectory)
      if (databaseVersion(database) === 14) await migrateDatabaseV14ToV15(database, dataDirectory)
      if (databaseVersion(database) === 15) await migrateDatabaseV15ToV16(database, dataDirectory)
      if (databaseVersion(database) === 16) await migrateDatabaseV16ToV17(database, dataDirectory)
      if (databaseVersion(database) !== PROJECT_DB_SCHEMA_VERSION) {
        throw new Error(`本地项目数据库版本 ${databaseVersion(database)} 当前不受支持。`)
      }
    }
    const pendingConfirmations = database.prepare(`
      SELECT COUNT(*) AS count FROM drama_render_confirmations
      WHERE status IN ('pending', 'accepted')
    `).get().count
    if (pendingConfirmations > 0) {
      await invalidateBackupManifest(dataDirectory)
      database.prepare(`
        UPDATE drama_render_confirmations SET status = 'invalidated', updated_at = ?
        WHERE status IN ('pending', 'accepted')
      `).run(new Date().toISOString())
    }
    const interruptedTaskCount = database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'").get().count
    if (interruptedTaskCount > 0) {
      await invalidateBackupManifest(dataDirectory)
      recoverInterruptedTasks(database)
    }
    const canvas = readDatabaseCanvas(database, metadata)
    return { directory, metadata, database, canvas, releaseWriterLock }
  } catch (error) {
    try {
      database?.close()
    } finally {
      await releaseWriterLock()
    }
    throw error
  }
}

function closeDatabase(database) {
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    database.close()
  }
}

async function closeProjectData(project) {
  try {
    closeDatabase(project.database)
  } finally {
    await project.releaseWriterLock()
  }
}

function createLocalProjectStore() {
  let active = null
  let serial = Promise.resolve()
  const previewDigestCache = new Map()

  function enqueue(operation) {
    const result = serial.then(operation)
    serial = result.then(() => undefined, () => undefined)
    return result
  }

  async function openProject(projectDirectory, expectedIdentity) {
    return enqueue(async () => {
      const directory = await fs.realpath(path.resolve(projectDirectory))
      if (active?.directory === directory) {
        assertExpectedProjectIdentity(active.metadata, expectedIdentity)
        return { project: publicProject(active.metadata), directory: active.directory }
      }
      const next = await openProjectData(directory, expectedIdentity)
      const previous = active
      active = next
      if (previous?.metadata.projectId !== next.metadata.projectId) previewDigestCache.clear()
      if (previous && previous.database !== next.database) await closeProjectData(previous)
      return { project: publicProject(next.metadata), directory: next.directory }
    })
  }

  function inspectProject(projectDirectory, expectedIdentity) {
    return enqueue(() => inspectProjectDirectory(projectDirectory, expectedIdentity))
  }

  function resolveProjectCover(projectDirectory, expectedIdentity) {
    return enqueue(async () => {
      const checked = await inspectProjectDirectory(projectDirectory, expectedIdentity)
      const dataDirectory = path.join(checked.directory, '.vibepaper')
      const databasePath = path.join(dataDirectory, 'project.sqlite')
      if (!await fs.stat(databasePath).catch(() => null)) return null
      const ownsDatabase = active?.directory !== checked.directory
      const database = ownsDatabase ? new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 }) : active.database
      try {
        // Only real successful images whose node still belongs to this canvas
        // can become its cover. Reading another card must not activate it.
        const rows = database.prepare(`SELECT tasks.* FROM tasks JOIN nodes
          ON nodes.canvas_id = tasks.canvas_id AND nodes.id = tasks.node_id
          WHERE tasks.canvas_id = ? AND tasks.status = 'succeeded' AND tasks.modality = 'image'
            AND json_extract(nodes.payload_json, '$.type') = 'image'
          ORDER BY tasks.completed_at DESC, tasks.created_at DESC LIMIT 20`).all(checked.project.canvasId)
        for (const row of rows) {
          try {
            const output = await resolveTaskOutputFile(dataDirectory, row.task_id, row.modality, row.output_path)
            if (output.sha256 !== row.output_sha256 || output.sizeBytes !== row.output_size_bytes) continue
            const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(output.filePath).toLowerCase()]
            if (mimeType) return { filePath: output.filePath, sizeBytes: output.sizeBytes, mimeType, sha256: output.sha256 }
          } catch {
            // A missing or altered image is not a valid cover; try another result.
          }
        }
        return null
      } finally {
        if (ownsDatabase) database.close()
      }
    })
  }

  async function createProject(parentDirectory, nameValue, importedCanvas = null) {
    const name = validateProjectName(nameValue)
    const parent = path.resolve(parentDirectory)
    const destination = path.join(parent, name)
    const staging = path.join(parent, `.vibepaper-create-${randomUUID()}`)
    if (path.dirname(destination) !== parent || path.dirname(staging) !== parent) throw new Error('所选项目路径无效。')
    const stagingInsideParent = () => {
      const resolvedParent = path.resolve(parent)
      const resolvedStaging = path.resolve(staging)
      return path.dirname(resolvedStaging) === resolvedParent
        && path.basename(resolvedStaging).startsWith('.vibepaper-create-')
    }

    let destinationCreated = false
    try {
      await fs.mkdir(staging)
      const metadata = {
        schemaVersion: PROJECT_SCHEMA_VERSION,
        projectId: randomUUID(),
        canvasId: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
      }
      const initialCanvas = {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        projectId: metadata.projectId,
        canvasId: metadata.canvasId,
        version: importedCanvas ? 1 : 0,
        nodes: importedCanvas?.nodes ?? [],
        edges: importedCanvas?.edges ?? [],
        groups: importedCanvas?.groups ?? [],
        stacks: importedCanvas?.stacks ?? [],
      }
      await writeJsonAtomically(path.join(staging, 'project.json'), metadata)

      const database = new DatabaseSync(path.join(staging, 'project.sqlite'), { timeout: 5000 })
      try {
        setDatabaseMode(database)
        initializeDatabase(database, metadata, initialCanvas)
      } finally {
        closeDatabase(database)
      }

      await fs.mkdir(destination)
      destinationCreated = true
      const projectDataPath = path.join(destination, '.vibepaper')
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fs.rename(staging, projectDataPath)
          break
        } catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error?.code) || attempt >= 3) throw error
          await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt))
        }
      }
    } catch (error) {
      if (stagingInsideParent()) {
        await fs.rm(path.resolve(staging), { recursive: true, force: true }).catch(() => undefined)
      }
      if (destinationCreated) await fs.rmdir(destination).catch(() => undefined)
      if (error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')) {
        throw new Error('该位置已存在同名文件夹，请使用其他项目名称或位置。')
      }
      throw error
    }

    return openProject(destination)
  }

  async function importCanvasDocument(parentDirectory, document) {
    const imported = normalizeCanvasImportDocument(document)
    const created = await createProject(parentDirectory, imported.name, imported.graph)
    return { ...created, warnings: imported.warnings }
  }

  function renameProject(projectId, directoryValue, nameValue) {
    return enqueue(async () => {
      if (typeof projectId !== 'string' || !projectId || projectId.length > 200) {
        throw new Error('本地项目标识无效。')
      }
      const name = validateProjectName(nameValue)
      if (typeof directoryValue !== 'string' || !directoryValue.trim()) throw new Error('项目目录无效。')
      const directory = await fs.realpath(path.resolve(directoryValue))
      let target = active?.directory === directory ? active : null
      let opened = null
      if (!target) {
        const dataDirectory = path.join(directory, '.vibepaper')
        const metadata = await readProjectMetadata(dataDirectory)
        validateMetadata(metadata)
        if (metadata.projectId !== projectId) throw new Error('最近项目身份已变化，请从项目目录重新打开。')
        opened = await openProjectData(directory, { projectId, canvasId: metadata.canvasId })
        target = opened
      }
      try {
        if (target.metadata.projectId !== projectId) throw new Error('最近项目身份已变化，请从项目目录重新打开。')
        if (target.metadata.name !== name) {
          const dataDirectory = path.join(directory, '.vibepaper')
          await invalidateBackupManifest(dataDirectory)
          const metadata = { ...target.metadata, name }
          await writeJsonAtomically(path.join(dataDirectory, 'project.json'), metadata)
          target.metadata = metadata
        }
        return { project: publicProject(target.metadata), directory }
      } finally {
        if (opened) await closeProjectData(opened)
      }
    })
  }

  function backupProject(parentDirectory, projectId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) {
        throw new Error('当前项目已更改，无法创建备份。')
      }

      const parent = path.resolve(parentDirectory)
      const parentInfo = await fs.stat(parent).catch(() => null)
      if (!parentInfo?.isDirectory()) throw new Error('备份位置不可用。')
      const realProjectDirectory = await fs.realpath(active.directory)
      const realParentDirectory = await fs.realpath(parent)
      const relativeToProject = path.relative(realProjectDirectory, realParentDirectory)
      if (relativeToProject === '' || (!path.isAbsolute(relativeToProject)
        && relativeToProject !== '..' && !relativeToProject.startsWith(`..${path.sep}`))) {
        throw new Error('请选择当前项目文件夹之外的备份位置。')
      }

      const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
      const backupName = `${active.metadata.name} Backup ${timestamp} ${randomUUID().slice(0, 8)}`
      const destination = path.join(parent, backupName)
      const staging = path.join(parent, `.vibepaper-backup-${randomUUID()}`)
      const stagingData = path.join(staging, '.vibepaper')
      try {
        await fs.mkdir(staging)
        await fs.mkdir(stagingData)
        await writeJsonAtomically(path.join(stagingData, 'project.json'), active.metadata)
        const sourceDataDirectory = path.join(active.directory, '.vibepaper')
        await copyProjectAssets(active.database, sourceDataDirectory, stagingData)
        await copyProjectTaskOutputs(active.database, path.join(active.directory, '.vibepaper'), stagingData)
        await backup(active.database, path.join(stagingData, 'project.sqlite'))
        await withAgentBackupLock(sourceDataDirectory, () => copyAgentData(sourceDataDirectory, stagingData, {
          expectedProjectId: active.metadata.projectId,
        }))
        const manifest = await createBackupManifest(stagingData, active.metadata, active.database)
        await writeJsonAtomically(path.join(stagingData, 'backup-manifest.json'), manifest)
        await publishStagedDirectory(staging, destination)
      } catch (error) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      return { directory: destination, name: backupName }
    })
  }

  function restoreBackup(sourceDirectory, parentDirectory) {
    return enqueue(async () => {
      const source = await validateRestorableProject(sourceDirectory)
      let staging = null
      let published = false
      try {
        const parent = path.resolve(parentDirectory)
        const parentInfo = await fs.stat(parent).catch(() => null)
        if (!parentInfo?.isDirectory()) throw new Error('恢复位置不可用。')
        const realSourceDirectory = await fs.realpath(source.directory)
        const realParentDirectory = await fs.realpath(parent)
        const relativeToSource = path.relative(realSourceDirectory, realParentDirectory)
        if (relativeToSource === '' || (!path.isAbsolute(relativeToSource)
          && relativeToSource !== '..' && !relativeToSource.startsWith(`..${path.sep}`))) {
          throw new Error('恢复位置不能位于备份项目目录内。')
        }

        const name = restoredProjectName(source.metadata.name)
        const destination = path.join(parent, name)
        staging = path.join(parent, `.vibepaper-restore-${randomUUID()}`)
        await fs.mkdir(staging)
        const stagingData = path.join(staging, '.vibepaper')
        await fs.mkdir(stagingData)
        const restoredMetadata = {
          ...source.metadata,
          projectId: randomUUID(),
          name,
        }
        await writeJsonAtomically(path.join(stagingData, 'project.json'), restoredMetadata)
        await backup(source.database, path.join(stagingData, 'project.sqlite'))
        await copyProjectAssets(source.database, source.dataDirectory, stagingData)
        await copyProjectTaskOutputs(source.database, source.dataDirectory, stagingData)
        if (source.backupSchemaVersion >= 2) {
          await copyAgentData(source.dataDirectory, stagingData, {
            rebaseProjectId: { from: source.metadata.projectId, to: restoredMetadata.projectId },
          })
        }

        const restoredDatabase = new DatabaseSync(path.join(stagingData, 'project.sqlite'), { timeout: 5000 })
        try {
          setDatabaseMode(restoredDatabase)
          restoredDatabase.exec('BEGIN IMMEDIATE')
          try {
            const updated = restoredDatabase.prepare('UPDATE project_metadata SET value = ? WHERE key = ?')
              .run(restoredMetadata.projectId, 'projectId')
            if (updated.changes !== 1) throw new Error('备份项目身份无法更新。')
            restoredDatabase.exec('COMMIT')
          } catch (error) {
            restoredDatabase.exec('ROLLBACK')
            throw error
          }
        } finally {
          closeDatabase(restoredDatabase)
        }

        const stagedProject = await openProjectData(staging)
        await closeProjectData(stagedProject)
        await publishStagedDirectory(staging, destination)
        published = true

        const next = await openProjectData(destination)
        const previous = active
        active = next
        if (previous && previous.database !== next.database) await closeProjectData(previous)
        return { project: publicProject(next.metadata), directory: next.directory }
      } catch (error) {
        if (staging && !published) await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
        throw error
      } finally {
        source.database.close()
      }
    })
  }

  function importAsset(sourcePath, projectId, assetKind = 'image') {
    if (!['image', 'video', 'audio', 'text', 'local'].includes(assetKind)) throw new Error('素材导入类型无效。')
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法导入素材。')
      const { assetsDirectory } = await projectAssetsDirectory(active.directory)
      const temporaryPath = path.join(assetsDirectory, `.import-${randomUUID()}.tmp`)
      try {
        const copied = await copyAssetSource(sourcePath, temporaryPath)
        const mimeType = assetKind === 'local'
          ? await detectAssetMimeType(temporaryPath, sourcePath)
          : assetKind === 'image'
            ? await detectImageMimeType(temporaryPath)
            : assetKind === 'video'
              ? await detectVideoMimeType(temporaryPath, sourcePath)
              : assetKind === 'audio'
                ? await detectAudioMimeType(temporaryPath, sourcePath)
                : await detectTextMimeType(temporaryPath, sourcePath)
        const assetId = randomUUID()
        const extension = extensionForAssetMimeType(mimeType)
        const relativePath = `assets/${copied.sha256}/${assetId}.${extension}`
        const assetDirectory = path.join(assetsDirectory, copied.sha256)
        await fs.mkdir(assetDirectory, { recursive: true })
        const assetDirectoryInfo = await fs.lstat(assetDirectory)
        const realAssetDirectory = await fs.realpath(assetDirectory)
        if (!assetDirectoryInfo.isDirectory() || assetDirectoryInfo.isSymbolicLink()
          || path.relative(assetDirectory, realAssetDirectory) !== '') {
          throw new Error('项目素材内容目录不能是符号链接。')
        }
        const destination = path.join(assetDirectory, `${assetId}.${extension}`)
        await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
        await fs.rename(temporaryPath, destination)

        const rawName = path.basename(path.resolve(sourcePath))
        const originalName = rawName.replace(/[\u0000-\u001f]/gu, '_').slice(0, 255) || `asset.${extension}`
        const createdAt = new Date().toISOString()
        try {
          active.database.exec('BEGIN IMMEDIATE')
          active.database.prepare(`
            INSERT INTO assets (id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(assetId, copied.sha256, originalName, mimeType, copied.sizeBytes, relativePath, createdAt, createdAt)
          active.database.exec('COMMIT')
        } catch (error) {
          active.database.exec('ROLLBACK')
          await fs.rm(destination, { force: true }).catch(() => undefined)
          throw error
        }
        return publicAsset({
          id: assetId,
          sha256: copied.sha256,
          original_name: originalName,
          mime_type: mimeType,
          size_bytes: copied.sizeBytes,
          created_at: createdAt,
          updated_at: createdAt,
          reference_count: 0,
        })
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
    })
  }

  function saveTaskOutputToLibrary(projectId, taskId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法保存任务素材。')
      if (typeof taskId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(taskId)) {
        throw new Error('任务标识无效。')
      }
      const task = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!task || task.status !== 'succeeded' || task.modality !== 'audio'
        || typeof task.output_path !== 'string' || path.extname(task.output_path).toLowerCase() !== '.wav'
        || !/^[a-f0-9]{64}$/iu.test(task.output_sha256 ?? '')
        || !Number.isSafeInteger(task.output_size_bytes) || task.output_size_bytes <= 0) {
        throw new Error('只有当前项目中已成功的 WAV 音频任务可以保存到素材库。')
      }

      const dataDirectory = path.join(active.directory, '.vibepaper')
      const output = await resolveTaskOutputFile(dataDirectory, task.task_id, task.modality, task.output_path)
      if (output.sha256 !== task.output_sha256 || output.sizeBytes !== task.output_size_bytes) {
        throw new Error('任务音频结果校验失败，无法保存到素材库。')
      }

      const { assetsDirectory } = await projectAssetsDirectory(active.directory)
      const temporaryPath = path.join(assetsDirectory, `.task-output-${randomUUID()}.tmp`)
      let destinationPath = null
      let databaseCommitted = false
      try {
        const copied = await copyAssetSource(output.filePath, temporaryPath)
        if (copied.sha256 !== task.output_sha256 || copied.sizeBytes !== task.output_size_bytes) {
          throw new Error('任务音频结果在保存期间发生变化。')
        }
        const mimeType = await detectWavMimeType(temporaryPath)
        const assetId = randomUUID()
        const extension = extensionForAssetMimeType(mimeType)
        const relativePath = `assets/${copied.sha256}/${assetId}.${extension}`
        const assetDirectory = path.join(assetsDirectory, copied.sha256)
        await fs.mkdir(assetDirectory, { recursive: true })
        const assetDirectoryInfo = await fs.lstat(assetDirectory)
        const realAssetDirectory = await fs.realpath(assetDirectory)
        if (!assetDirectoryInfo.isDirectory() || assetDirectoryInfo.isSymbolicLink()
          || path.relative(assetDirectory, realAssetDirectory) !== '') {
          throw new Error('项目素材内容目录不能是符号链接。')
        }
        destinationPath = path.join(assetDirectory, `${assetId}.${extension}`)
        await invalidateBackupManifest(dataDirectory)
        await fs.rename(temporaryPath, destinationPath)

        const originalName = `task-${task.task_id}-output.wav`
        const createdAt = new Date().toISOString()
        try {
          active.database.exec('BEGIN IMMEDIATE')
          active.database.prepare(`
            INSERT INTO assets (id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(assetId, copied.sha256, originalName, mimeType, copied.sizeBytes, relativePath, createdAt, createdAt)
          active.database.exec('COMMIT')
          databaseCommitted = true
        } catch (error) {
          active.database.exec('ROLLBACK')
          throw error
        }
        return publicAsset({
          id: assetId,
          original_name: originalName,
          mime_type: mimeType,
          size_bytes: copied.sizeBytes,
          created_at: createdAt,
          updated_at: createdAt,
          reference_count: 0,
        })
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
        if (!databaseCommitted && destinationPath) await fs.rm(destinationPath, { force: true }).catch(() => undefined)
        throw error
      }
    })
  }

  function listAssets(projectId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取素材。')
      return active.database.prepare(`
        SELECT a.id AS assetId, a.original_name AS name, a.mime_type AS mimeType,
          a.size_bytes AS sizeBytes, a.created_at AS createdAt, a.updated_at AS updatedAt,
          (SELECT COUNT(*) FROM asset_references r WHERE r.asset_id = a.id) AS referenceCount
        FROM assets a WHERE a.deleted = 0 ORDER BY a.created_at DESC, a.id
      `).all().map(publicAsset)
    })
  }

  function renameAsset(projectId, assetId, name) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法重命名素材。')
      if (typeof assetId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(assetId)) {
        throw new Error('素材标识无效。')
      }
      const normalizedName = normalizeAssetName(name)
      const database = active.database
      if (!database.prepare('SELECT id FROM assets WHERE id = ? AND deleted = 0').get(assetId)) {
        throw new Error('本地素材不存在。')
      }
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        const updated = database.prepare('UPDATE assets SET original_name = ?, updated_at = ? WHERE id = ? AND deleted = 0')
          .run(normalizedName, new Date().toISOString(), assetId)
        if (updated.changes !== 1) throw new Error('本地素材不存在。')
        const row = database.prepare(`
          SELECT a.id AS assetId, a.original_name AS name, a.mime_type AS mimeType,
            a.size_bytes AS sizeBytes, a.created_at AS createdAt, a.updated_at AS updatedAt,
            (SELECT COUNT(*) FROM asset_references r WHERE r.asset_id = a.id) AS referenceCount
          FROM assets a WHERE a.id = ?
        `).get(assetId)
        database.exec('COMMIT')
        return publicAsset(row)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function replaceAsset(projectId, assetId, sourcePath) {
    return replaceAssetByType(projectId, assetId, sourcePath, 'image')
  }

  function replaceAudioAsset(projectId, assetId, sourcePath) {
    return replaceAssetByType(projectId, assetId, sourcePath, 'audio')
  }

  function replaceAssetFile(projectId, assetId, sourcePath) {
    return replaceAssetByType(projectId, assetId, sourcePath, 'any')
  }

  function replaceAssetByType(projectId, assetId, sourcePath, assetType) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法替换素材。')
      if (typeof assetId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(assetId)) {
        throw new Error('素材标识无效。')
      }
      const database = active.database
      const current = database.prepare('SELECT * FROM assets WHERE id = ? AND deleted = 0').get(assetId)
      if (!current) throw new Error('本地素材不存在。')
      const currentMatchesType = assetType === 'any'
        || assetType === 'audio' && current.mime_type.startsWith('audio/')
        || assetType === 'image' && current.mime_type.startsWith('image/')
      if (!currentMatchesType) throw new Error(assetType === 'audio' ? '只能替换音频素材。' : '只能替换图片素材。')
      assertAssetRowPath(current)
      const oldAssetFile = await resolveProjectAssetFile(active.directory, current, { allowMissing: true })
      const { assetsDirectory } = await projectAssetsDirectory(active.directory)
      const temporaryPath = path.join(assetsDirectory, `.replace-${randomUUID()}.tmp`)
      let destinationPath = null
      let destinationAsset = null
      let databaseCommitted = false
      try {
        const copied = await copyAssetSource(sourcePath, temporaryPath)
        const mimeType = assetType === 'audio'
          ? await detectAudioMimeType(temporaryPath, sourcePath)
          : assetType === 'image'
            ? await detectImageMimeType(temporaryPath)
            : await detectAssetMimeType(temporaryPath, sourcePath)
        if (assetType === 'any' && !mimeType.startsWith(current.mime_type.split('/')[0] + '/')) {
          throw new Error('替换素材必须与原素材保持相同的类型。')
        }
        const extension = extensionForAssetMimeType(mimeType)
        const rawName = path.basename(path.resolve(sourcePath))
        const normalizedName = normalizeAssetName(rawName || current.original_name)
        const nextUpdatedAt = new Date().toISOString()

        if (copied.sha256 !== current.sha256 || mimeType !== current.mime_type || !oldAssetFile) {
          const relativePath = `assets/${copied.sha256}/${assetId}.${extension}`
          const assetDirectory = path.join(assetsDirectory, copied.sha256)
          await fs.mkdir(assetDirectory, { recursive: true })
          const directoryInfo = await fs.lstat(assetDirectory)
          const realAssetDirectory = await fs.realpath(assetDirectory)
          if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
            || path.relative(assetDirectory, realAssetDirectory) !== '') {
            throw new Error('项目素材内容目录不能是符号链接。')
          }
          destinationPath = path.join(assetDirectory, `${assetId}.${extension}`)
          destinationAsset = { id: assetId, sha256: copied.sha256, mime_type: mimeType, relative_path: relativePath }
          await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
          await fs.rename(temporaryPath, destinationPath)
        } else {
          await fs.rm(temporaryPath, { force: true })
          await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
        }

        database.exec('BEGIN IMMEDIATE')
        try {
          const updated = destinationAsset
            ? database.prepare(`
              UPDATE assets
              SET sha256 = ?, original_name = ?, mime_type = ?, size_bytes = ?, relative_path = ?, updated_at = ?
              WHERE id = ? AND deleted = 0 AND sha256 = ? AND relative_path = ?
            `).run(copied.sha256, normalizedName, mimeType, copied.sizeBytes, destinationAsset.relative_path,
              nextUpdatedAt, assetId, current.sha256, current.relative_path)
            : database.prepare(`
              UPDATE assets SET original_name = ?, updated_at = ?
              WHERE id = ? AND deleted = 0 AND sha256 = ? AND relative_path = ?
            `).run(normalizedName, nextUpdatedAt, assetId, current.sha256, current.relative_path)
          if (updated.changes !== 1) throw new Error('本地素材已变化，无法替换。')
          const result = database.prepare(`
            SELECT a.id AS assetId, a.original_name AS name, a.mime_type AS mimeType,
              a.size_bytes AS sizeBytes, a.created_at AS createdAt, a.updated_at AS updatedAt,
              (SELECT COUNT(*) FROM asset_references r WHERE r.asset_id = a.id) AS referenceCount
            FROM assets a WHERE a.id = ?
          `).get(assetId)
          database.exec('COMMIT')
          databaseCommitted = true
          if (oldAssetFile && destinationPath && oldAssetFile.filePath !== destinationPath) {
            await resolveProjectAssetFile(active.directory, current, { allowMissing: true })
              .then((resolved) => resolved ? fs.rm(resolved.filePath, { force: true }) : undefined)
              .catch(() => undefined)
          }
          return publicAsset(result)
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
        if (!databaseCommitted && destinationPath && destinationAsset) {
          await resolveProjectAssetFile(active.directory, destinationAsset, { allowMissing: true })
            .then((resolved) => resolved ? fs.rm(resolved.filePath, { force: true }) : undefined)
            .catch(() => undefined)
        }
        throw error
      }
    })
  }

  function deleteAsset(projectId, assetId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法删除素材。')
      if (typeof assetId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(assetId)) {
        throw new Error('素材标识无效。')
      }
      const database = active.database
      if (!database.prepare('SELECT id FROM assets WHERE id = ? AND deleted = 0').get(assetId)) {
        throw new Error('本地素材不存在。')
      }
      const references = database.prepare(`
        SELECT canvas_id AS canvasId, node_id AS nodeId FROM asset_references
        WHERE asset_id = ? ORDER BY canvas_id, node_id
      `).all(assetId).map((reference) => ({ ...reference, type: 'canvas' }))
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        const updated = database.prepare('UPDATE assets SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0')
          .run(new Date().toISOString(), assetId)
        if (updated.changes !== 1) throw new Error('本地素材不存在。')
        database.exec('COMMIT')
        return { deletedAssetId: assetId, references }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function resolveAsset(assetId) {
    return enqueue(async () => {
      if (!active || typeof assetId !== 'string') throw new Error('本地素材不可用。')
      const asset = active.database.prepare('SELECT id, sha256, mime_type, relative_path FROM assets WHERE id = ?').get(assetId)
      if (!asset) throw new Error('本地素材不存在。')
      const resolved = await resolveProjectAssetFile(active.directory, asset)
      const info = await fs.stat(resolved.filePath)
      return { filePath: resolved.filePath, mimeType: asset.mime_type, sizeBytes: info.size }
    })
  }

  function resolveAssetThumbnail(assetId) {
    return enqueue(async () => {
      if (!active || typeof assetId !== 'string') throw new Error('本地素材不可用。')
      const asset = active.database.prepare('SELECT id, sha256, mime_type, relative_path FROM assets WHERE id = ?').get(assetId)
      if (!asset || !asset.mime_type.startsWith('image/')) throw new Error('图片素材不存在。')
      const resolved = await resolveProjectAssetFile(active.directory, asset)
      const thumbnail = await imageThumbnail(active.directory, asset, resolved.filePath)
      if (thumbnail) return thumbnail
      const info = await fs.stat(resolved.filePath)
      return { filePath: resolved.filePath, mimeType: asset.mime_type, sizeBytes: info.size }
    })
  }

  async function resolveComposeSourceTaskIds(database, canvasId, composeNodeId, inputNodeIds) {
    const target = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
      .get(canvasId, composeNodeId)
    if (!target || JSON.parse(target.payload_json).type !== 'compose') {
      throw new Error('合成目标节点不存在或不是合成节点。')
    }

    const incomingEdges = database.prepare(`
      SELECT source_node_id, payload_json FROM edges WHERE canvas_id = ? AND target_node_id = ?
    `).all(canvasId, composeNodeId)
    const connectedCounts = new Map()
    for (const row of incomingEdges) {
      const payload = JSON.parse(row.payload_json)
      const data = isRecord(payload.data) ? payload.data : {}
      const edge = isRecord(data.edge) ? data.edge : {}
      if (data.valid === false || edge.valid === false) continue
      connectedCounts.set(row.source_node_id, (connectedCounts.get(row.source_node_id) ?? 0) + 1)
    }
    const requestedCounts = new Map()
    for (const nodeId of inputNodeIds) {
      requestedCounts.set(nodeId, (requestedCounts.get(nodeId) ?? 0) + 1)
    }

    const videoTasks = database.prepare(`
      SELECT * FROM tasks WHERE canvas_id = ? AND node_id = ? AND modality = 'video'
      ORDER BY created_at DESC, task_id
    `)
    const taskIds = []
    for (const nodeId of inputNodeIds) {
      if ((requestedCounts.get(nodeId) ?? 0) > (connectedCounts.get(nodeId) ?? 0)) {
        throw new Error('合成输入必须来自连接到合成节点的视频节点。')
      }
      const source = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
        .get(canvasId, nodeId)
      if (!source) throw new Error('合成输入视频节点不存在。')
      const payload = JSON.parse(source.payload_json)
      if (payload.type !== 'video') throw new Error('合成输入只支持视频节点。')
      const data = isRecord(payload.data) ? payload.data : {}
      const nestedNode = isRecord(data.node) ? data.node : {}
      if (data.stale === true || nestedNode.stale === true || payload.stale === true) {
        throw new Error('合成输入视频节点已过期，请先重新生成视频。')
      }

      const currentOutputId = data.currentOutputId ?? nestedNode.currentOutputId
      const sourceTask = pickLatestNodeTask(videoTasks.all(canvasId, nodeId), currentOutputId)
      if (!sourceTask || !sourceTask.output_path || !sourceTask.output_sha256
        || sourceTask.status !== 'succeeded' || !Number.isSafeInteger(sourceTask.output_size_bytes)) {
        throw new Error('每个合成输入都必须有已完成的视频任务。')
      }
      const output = await resolveTaskOutputFile(
        path.join(active.directory, '.vibepaper'),
        sourceTask.task_id,
        'video',
        sourceTask.output_path,
      )
      if (output.sha256 !== sourceTask.output_sha256 || output.sizeBytes !== sourceTask.output_size_bytes) {
        throw new Error('合成输入视频结果校验失败。')
      }
      taskIds.push(sourceTask.task_id)
    }
    return taskIds
  }

  function createTask(input) {
    return enqueue(async () => {
      if (!active) throw new Error('没有打开的本地项目。')
      const normalized = normalizeTaskInput(input)
      if (normalized.projectId !== active.metadata.projectId || normalized.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，无法创建生成任务。')
      }
      const existing = active.database.prepare('SELECT * FROM tasks WHERE idempotency_key = ?')
        .get(normalized.idempotencyKey)
      if (existing) {
        if (existing.input_hash !== normalized.inputHash) throw new Error('TASK_IDEMPOTENCY_CONFLICT')
        return taskFromRow(existing)
      }
      if (normalized.canvasVersion !== active.canvas.version) throw new Error('画布版本已变化，请重新读取后再提交任务。')
      if (normalized.nodeId && !active.database.prepare('SELECT 1 FROM nodes WHERE canvas_id = ? AND id = ?')
        .get(normalized.canvasId, normalized.nodeId)) {
        throw new Error('生成任务关联的节点已不存在。')
      }

      let parametersJson = normalized.parametersJson
      if (normalized.modality === 'compose') {
        const parameters = JSON.parse(parametersJson)
        const inputTaskIds = await resolveComposeSourceTaskIds(
          active.database,
          normalized.canvasId,
          normalized.nodeId,
          parameters.inputNodeIds,
        )
        parameters.inputTaskIds = inputTaskIds
        parametersJson = JSON.stringify(parameters)
        if (Buffer.byteLength(parametersJson, 'utf8') > MAX_TASK_INPUT_BYTES) {
          throw new Error('合成任务输入超过本地保存上限。')
        }
      }

      const now = new Date().toISOString()
      const taskId = randomUUID()
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      active.database.exec('BEGIN IMMEDIATE')
      try {
        const persistedCanvas = active.database.prepare('SELECT version FROM canvases WHERE id = ?').get(normalized.canvasId)
        if (!persistedCanvas || persistedCanvas.version !== normalized.canvasVersion) {
          throw new Error('画布版本已变化，请重新读取后再提交任务。')
        }
        active.database.prepare(`
          INSERT INTO tasks (
            task_id, idempotency_key, input_hash, canvas_id, canvas_version, node_id,
            modality, provider_type, provider_id, model_id, input_json, status,
            attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
        `).run(
          taskId,
          normalized.idempotencyKey,
          normalized.inputHash,
          normalized.canvasId,
          normalized.canvasVersion,
          normalized.nodeId,
          normalized.modality,
          normalized.providerType,
          normalized.providerId,
          normalized.modelId,
          parametersJson,
          now,
          now,
        )
        appendTaskEvent(active.database, taskId, 'created', {
          modality: normalized.modality,
          providerType: normalized.providerType,
          providerId: normalized.providerId,
          modelId: normalized.modelId,
          canvasVersion: normalized.canvasVersion,
        }, now)
        active.database.exec('COMMIT')
        return taskFromRow(active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId))
      } catch (error) {
        active.database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function resolveComposeInputPaths(projectId, taskId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取合成输入。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('合成任务标识无效。')
      const task = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!task || task.modality !== 'compose' || task.status !== 'running') {
        throw new Error('合成任务当前不可执行。')
      }
      const parameters = JSON.parse(task.input_json)
      if (!Array.isArray(parameters.inputNodeIds) || !Array.isArray(parameters.inputTaskIds)
        || parameters.inputNodeIds.length < 2 || parameters.inputNodeIds.length !== parameters.inputTaskIds.length) {
        throw new Error('合成任务的输入快照无效。')
      }
      const paths = []
      for (let index = 0; index < parameters.inputTaskIds.length; index += 1) {
        const sourceTaskId = parameters.inputTaskIds[index]
        const nodeId = parameters.inputNodeIds[index]
        const sourceTask = active.database.prepare(`
          SELECT * FROM tasks WHERE task_id = ? AND canvas_id = ? AND node_id = ?
            AND modality = 'video' AND status = 'succeeded'
        `).get(sourceTaskId, task.canvas_id, nodeId)
        if (!sourceTask || !sourceTask.output_path || !sourceTask.output_sha256
          || !Number.isSafeInteger(sourceTask.output_size_bytes)) {
          throw new Error('合成输入视频任务已不可用。')
        }
        const output = await resolveTaskOutputFile(
          path.join(active.directory, '.vibepaper'),
          sourceTask.task_id,
          'video',
          sourceTask.output_path,
        )
        if (output.sha256 !== sourceTask.output_sha256 || output.sizeBytes !== sourceTask.output_size_bytes) {
          throw new Error('合成输入视频结果校验失败。')
        }
        paths.push(output.filePath)
      }
      return paths
    })
  }

  function listTasks(projectId, limit = 100) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务。')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('任务列表上限无效。')
      return active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} ORDER BY tasks.created_at DESC, tasks.task_id LIMIT ?`)
        .all(limit).map(taskFromRow)
    })
  }

  function searchTasks(projectId, query) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法搜索任务。')
      const normalized = normalizeTaskSearchInput(query)
      const clauses = []
      const values = []
      if (normalized.keyword) {
        const promptExpression = `COALESCE(
          CASE WHEN json_type(input_json, '$.prompt') = 'text'
            THEN json_extract(input_json, '$.prompt') END,
          CASE WHEN json_type(input_json, '$.modelParams.prompt') = 'text'
            THEN json_extract(input_json, '$.modelParams.prompt') END,
          ''
        )`
        clauses.push(`instr(lower(${promptExpression}), lower(?)) > 0`)
        values.push(normalized.keyword)
      }
      if (normalized.model) {
        clauses.push("instr(lower(provider_id || ' ' || model_id || ' ' || provider_type), lower(?)) > 0")
        values.push(normalized.model)
      }
      if (normalized.modality) {
        clauses.push('modality = ?')
        values.push(normalized.modality)
      }
      if (normalized.status) {
        clauses.push('status = ?')
        values.push(normalized.status)
      }
      if (normalized.fromTime !== null) {
        clauses.push('created_at >= ?')
        values.push(new Date(normalized.fromTime).toISOString())
      }
      if (normalized.toTime !== null) {
        clauses.push('created_at <= ?')
        values.push(new Date(normalized.toTime).toISOString())
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const total = Number(active.database.prepare(`SELECT COUNT(*) AS total FROM tasks ${where}`)
        .get(...values).total)
      const offset = (normalized.page - 1) * normalized.pageSize
      const items = active.database.prepare(`
        ${TASKS_WITH_OUTPUT_METADATA} ${where}
        ORDER BY tasks.created_at DESC, tasks.task_id
        LIMIT ? OFFSET ?
      `).all(...values, normalized.pageSize, offset).map(taskFromRow)
      return { items, total, page: normalized.page, pageSize: normalized.pageSize }
    })
  }

  function getTask(projectId, taskId) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const row = active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId)
      return row ? taskFromRow(row) : null
    })
  }

  function getTaskInput(projectId, taskId) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务输入。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const row = active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId)
      return row ? { task: taskFromRow(row), parameters: JSON.parse(row.input_json) } : null
    })
  }

  function readTaskOutputText(projectId, taskId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务结果。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const row = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!row || row.status !== 'succeeded' || row.modality !== 'text') {
        throw new Error('此任务没有可读取的文本结果。')
      }
      if (!Number.isSafeInteger(row.output_size_bytes) || row.output_size_bytes <= 0
        || row.output_size_bytes > 1024 * 1024) {
        throw new Error('任务结果大小无效。')
      }
      const output = await resolveTaskOutputFile(
        path.join(active.directory, '.vibepaper'),
        row.task_id,
        row.modality,
        row.output_path,
      )
      if (output.sha256 !== row.output_sha256 || output.sizeBytes !== row.output_size_bytes) {
        throw new Error('任务结果校验失败。')
      }
      const contents = await fs.readFile(output.filePath)
      if (contents.length !== row.output_size_bytes
        || createHash('sha256').update(contents).digest('hex') !== row.output_sha256) {
        throw new Error('读取任务结果时校验失败。')
      }
      return contents.toString('utf8')
    })
  }

  function resolveTaskOutputForPreview(projectId, taskId, outputIndex = 0) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务结果。')
      if (typeof taskId !== 'string' || !taskId || !Number.isSafeInteger(outputIndex)
        || outputIndex < 0 || outputIndex > 3) throw new Error('任务结果查询参数无效。')
      const row = active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId)
      if (!row || row.status !== 'succeeded' || !['image', 'audio', 'video', 'compose'].includes(row.modality)) {
        throw new Error('此任务没有可预览的媒体结果。')
      }
      const operation = taskOperationFromInput(row.input_json)
      const indexedOutput = active.database.prepare(`SELECT output_path, output_sha256, output_size_bytes, output_metadata_json
        FROM task_outputs WHERE task_id = ? AND output_index = ?`).get(taskId, outputIndex)
      const outputRow = indexedOutput ?? (outputIndex === 0 ? {
        output_path: row.output_path,
        output_sha256: row.output_sha256,
        output_size_bytes: row.output_size_bytes,
        output_metadata_json: null,
      } : null)
      if (!outputRow) throw new Error('任务没有此序号的结果。')
      let rawOutputMeta = null
      try {
        rawOutputMeta = typeof outputRow.output_metadata_json === 'string'
          ? JSON.parse(outputRow.output_metadata_json)
          : typeof row.output_metadata === 'string' ? JSON.parse(row.output_metadata) : null
      } catch {
        rawOutputMeta = null
      }
      let outputType = row.modality
      if (row.provider_type === 'local' && row.provider_id === 'local-media-tools') {
        let parameters
        try {
          parameters = JSON.parse(row.input_json)
        } catch {
          throw new Error('本地媒体任务输入无效。')
        }
        const outputMeta = normalizeLocalMediaOutputMeta(rawOutputMeta, row, parameters)
        if (!outputMeta) throw new Error('LOCAL_MEDIA_OUTPUT_METADATA_INVALID')
        outputType = outputMeta.outputType
      }
      const cacheKey = `${projectId}:${taskId}:${outputIndex}`
      const output = await resolveTaskOutputFile(
        path.join(active.directory, '.vibepaper'),
        row.task_id,
        row.modality,
        outputRow.output_path,
        previewDigestCache.get(cacheKey),
        operation,
      )
      if (output.sha256 !== outputRow.output_sha256 || output.sizeBytes !== outputRow.output_size_bytes) {
        previewDigestCache.delete(cacheKey)
        throw new Error('任务结果校验失败。')
      }
      previewDigestCache.set(cacheKey, {
        filePath: output.filePath,
        fingerprint: output.fingerprint,
        digest: { sha256: output.sha256, sizeBytes: output.sizeBytes },
      })
      const extension = path.extname(output.filePath).toLowerCase()
      const mimeType = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
      }[extension]
      if (!mimeType || (outputType === 'image' && !mimeType.startsWith('image/'))
        || (outputType === 'audio' && !mimeType.startsWith('audio/'))
        || (['video', 'compose'].includes(outputType) && !mimeType.startsWith('video/'))
        || !['image', 'audio', 'video', 'compose'].includes(outputType)) {
        throw new Error('任务结果格式与模态不匹配。')
      }
      return { filePath: output.filePath, mimeType, sizeBytes: output.sizeBytes }
    })
  }

  function listTaskEvents(projectId, taskId, afterSeq = 0) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务记录。')
      if (typeof taskId !== 'string' || !taskId || !Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        throw new Error('任务记录查询参数无效。')
      }
      return active.database.prepare(`
        SELECT event_id AS eventId, task_id AS taskId, event_seq AS eventSeq, type, data_json AS dataJson, created_at AS createdAt
        FROM task_events WHERE task_id = ? AND event_seq > ? ORDER BY event_seq
      `).all(taskId, afterSeq).map((event) => ({
        eventId: event.eventId,
        taskId: event.taskId,
        eventSeq: event.eventSeq,
        type: event.type,
        data: JSON.parse(event.dataJson),
        createdAt: event.createdAt,
      }))
    })
  }

  function claimNextTask(projectId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法领取任务。')
      const candidate = active.database.prepare("SELECT task_id FROM tasks WHERE status = 'queued' ORDER BY created_at, task_id LIMIT 1")
        .get()
      if (!candidate) return null
      const taskId = candidate.task_id
      const outputDirectory = await ensureTaskOutputDirectory(
        path.join(active.directory, '.vibepaper'),
        taskId,
      )
      const now = new Date().toISOString()
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      active.database.exec('BEGIN IMMEDIATE')
      try {
        const update = active.database.prepare(`
          UPDATE tasks SET status = 'running', attempt_count = attempt_count + 1,
            started_at = ?, updated_at = ?, error_code = NULL
          WHERE task_id = ? AND status = 'queued'
        `).run(now, now, taskId)
        if (update.changes !== 1) throw new Error('TASK_STATE_CONFLICT')
        const row = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
        appendTaskEvent(active.database, taskId, 'running', { attemptCount: row.attempt_count }, now)
        active.database.exec('COMMIT')
        return { task: taskFromRow(row), parameters: JSON.parse(row.input_json), outputDirectory,
          providerCheckpoint: latestProviderCheckpoint(active.database, taskId) }
      } catch (error) {
        active.database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function recordProviderCheckpoint(projectId, taskId, checkpoint) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改。')
      const task = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!task || task.status !== 'running' || task.provider_type !== 'cloud') throw new Error('TASK_STATE_CONFLICT')
      if (!isRecord(checkpoint) || !['submitting', 'submitted'].includes(checkpoint.phase)
        || checkpoint.phase === 'submitted' && (typeof checkpoint.remoteTaskId !== 'string'
          || !checkpoint.remoteTaskId || checkpoint.remoteTaskId.length > 2048 || /[\u0000-\u001f]/u.test(checkpoint.remoteTaskId))) {
        throw new Error('PROVIDER_CHECKPOINT_INVALID')
      }
      const previous = latestProviderCheckpoint(active.database, taskId)
      if (previous?.remoteTaskId && previous.remoteTaskId !== checkpoint.remoteTaskId) throw new Error('PROVIDER_CHECKPOINT_CONFLICT')
      const safe = checkpoint.phase === 'submitted'
        ? { phase: 'submitted', remoteTaskId: checkpoint.remoteTaskId }
        : { phase: 'submitting' }
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      const now = new Date().toISOString()
      appendTaskEvent(active.database, taskId, 'running', { providerCheckpoint: safe }, now)
      return safe
    })
  }

  function recordTaskSucceeded(projectId, taskId, outputPath, rawOutputMeta = null, rawOutputPaths = null) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法完成任务。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const current = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      const outputPaths = rawOutputPaths === null || rawOutputPaths === undefined ? [outputPath] : rawOutputPaths
      if (!Array.isArray(outputPaths) || outputPaths.length < 1 || outputPaths.length > 4
        || outputPaths.some((item) => typeof item !== 'string') || outputPaths[0] !== outputPath) {
        throw new Error('TASK_RESULT_OUTPUTS_INVALID')
      }
      let parameters
      try {
        parameters = JSON.parse(current.input_json)
      } catch {
        throw new Error('TASK_INPUT_INVALID')
      }
      const expectedOutputCount = current.modality === 'image' ? (parameters.count ?? 1) : 1
      if (outputPaths.length !== expectedOutputCount) throw new Error('TASK_RESULT_OUTPUT_COUNT_MISMATCH')
      const outputs = []
      const operation = typeof parameters.operation === 'string' ? parameters.operation : ''
      for (const resultPath of outputPaths) {
        outputs.push(await resolveTaskOutputFile(
          path.join(active.directory, '.vibepaper'),
          current.task_id,
          current.modality,
          resultPath,
          null,
          operation,
        ))
      }
      if (current.status === 'succeeded') {
        const saved = active.database.prepare(`SELECT output_index, output_path, output_sha256, output_size_bytes
          FROM task_outputs WHERE task_id = ? ORDER BY output_index`).all(taskId)
        const savedOutputs = saved.length > 0 ? saved : [{
          output_index: 0,
          output_path: current.output_path,
          output_sha256: current.output_sha256,
          output_size_bytes: current.output_size_bytes,
        }]
        if (savedOutputs.length !== outputs.length || outputs.some((output, index) => {
          const savedOutput = savedOutputs[index]
          return !savedOutput || savedOutput.output_index !== index
            || savedOutput.output_path !== outputPaths[index]
            || savedOutput.output_sha256 !== output.sha256
            || savedOutput.output_size_bytes !== output.sizeBytes
        })) throw new Error('TASK_RESULT_CONFLICT')
        const row = active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId)
        const succeeded = taskFromRow(row)
        if (current.modality === 'audio' && current.provider_type === 'local'
          && current.provider_id === 'local-sapi-tts'
          && rawOutputMeta !== null && rawOutputMeta !== undefined) {
          const retryMeta = normalizeAudioOutputMeta(rawOutputMeta)
          if (!retryMeta || JSON.stringify(retryMeta) !== JSON.stringify(succeeded.outputMeta)) {
            throw new Error('TASK_RESULT_CONFLICT')
          }
        }
        if (current.provider_type === 'local' && current.provider_id === 'local-media-tools') {
          const retryMeta = normalizeLocalMediaOutputMeta(rawOutputMeta, current, parameters)
          if (!retryMeta || JSON.stringify(retryMeta) !== JSON.stringify(succeeded.outputMeta)) {
            throw new Error('TASK_RESULT_CONFLICT')
          }
        }
        return succeeded
      }
      if (current.status !== 'running') throw new Error('TASK_STATE_CONFLICT')
      const outputMeta = current.modality === 'audio' && current.provider_type === 'local'
        && current.provider_id === 'local-sapi-tts'
        ? normalizeAudioOutputMeta(rawOutputMeta)
        : current.provider_type === 'local' && current.provider_id === 'local-media-tools'
          ? normalizeLocalMediaOutputMeta(rawOutputMeta, current, parameters)
          : null
      if (current.modality === 'audio' && current.provider_type === 'local'
        && current.provider_id === 'local-sapi-tts' && !outputMeta) {
        throw new Error('AUDIO_OUTPUT_METADATA_INVALID')
      }
      if (current.provider_type === 'local' && current.provider_id === 'local-media-tools' && !outputMeta) {
        throw new Error('LOCAL_MEDIA_OUTPUT_METADATA_INVALID')
      }
      const outputInserts = outputs.map((output, index) => ({
        index,
        outputPath: outputPaths[index],
        sha256: output.sha256,
        sizeBytes: output.sizeBytes,
        outputMeta: index === 0 && outputMeta ? outputMeta : null,
      }))
      const now = new Date().toISOString()
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      active.database.exec('BEGIN IMMEDIATE')
      try {
        const update = active.database.prepare(`
          UPDATE tasks SET status = 'succeeded', output_path = ?, output_sha256 = ?, output_size_bytes = ?,
            error_code = NULL, updated_at = ?, completed_at = ?
          WHERE task_id = ? AND status = 'running'
        `).run(outputPath, outputs[0].sha256, outputs[0].sizeBytes, now, now, taskId)
        if (update.changes !== 1) throw new Error('TASK_STATE_CONFLICT')
        const insertOutput = active.database.prepare(`INSERT INTO task_outputs (
          task_id, output_index, output_path, output_sha256, output_size_bytes, output_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?)`)
        for (const output of outputInserts) {
          insertOutput.run(taskId, output.index, output.outputPath, output.sha256, output.sizeBytes,
            output.outputMeta ? JSON.stringify(output.outputMeta) : null)
        }
        appendTaskEvent(active.database, taskId, 'succeeded', {
          outputPath,
          outputSha256: outputs[0].sha256,
          outputSizeBytes: outputs[0].sizeBytes,
          outputs: outputInserts.map(({ index, outputPath: resultPath, sha256, sizeBytes }) => ({
            index, outputPath: resultPath, outputSha256: sha256, outputSizeBytes: sizeBytes,
          })),
          ...(outputMeta ? { outputMeta } : {}),
        }, now)
        active.database.exec('COMMIT')
        const row = active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId)
        return taskFromRow(row)
      } catch (error) {
        active.database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function recordTaskFailed(projectId, taskId, errorCode, rawErrorMessage = null) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法更新任务。')
      if (typeof taskId !== 'string' || !taskId || typeof errorCode !== 'string'
        || !/^[A-Z0-9_]{1,120}$/u.test(errorCode)) throw new Error('任务失败信息无效。')
      const errorMessage = typeof rawErrorMessage === 'string'
        ? rawErrorMessage.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 1000)
        : ''
      const visibleErrorMessage = errorMessage || `生成任务失败（${errorCode}）。`
      const current = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      if (current.status === 'failed' && current.error_code === errorCode) {
        return taskFromRow(active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId))
      }
      if (current.status !== 'running') throw new Error('TASK_STATE_CONFLICT')
      const now = new Date().toISOString()
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      active.database.exec('BEGIN IMMEDIATE')
      try {
        const update = active.database.prepare(`
          UPDATE tasks SET status = 'failed', error_code = ?, updated_at = ?, completed_at = ?
          WHERE task_id = ? AND status = 'running'
        `).run(errorCode, now, now, taskId)
        if (update.changes !== 1) throw new Error('TASK_STATE_CONFLICT')
        appendTaskEvent(active.database, taskId, 'failed', { errorCode, errorMessage: visibleErrorMessage }, now)
        active.database.exec('COMMIT')
        return taskFromRow(active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId))
      } catch (error) {
        active.database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function cancelTask(projectId, taskId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法取消任务。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const current = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      if (current.status === 'cancelled') return taskFromRow(current)
      if (!['queued', 'running'].includes(current.status)) throw new Error('TASK_CANCELLATION_REQUIRES_ACTIVE_TASK')
      const now = new Date().toISOString()
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      active.database.exec('BEGIN IMMEDIATE')
      try {
        const update = active.database.prepare(`
          UPDATE tasks SET status = 'cancelled', error_code = NULL, updated_at = ?, completed_at = ?
          WHERE task_id = ? AND status IN ('queued', 'running')
        `).run(now, now, taskId)
        if (update.changes !== 1) throw new Error('TASK_STATE_CONFLICT')
        appendTaskEvent(active.database, taskId, 'cancelled', { fromStatus: current.status }, now)
        active.database.exec('COMMIT')
        return taskFromRow(active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId))
      } catch (error) {
        active.database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function cleanupCancelledTaskOutput(projectId, taskId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法清理任务结果。')
      if (typeof taskId !== 'string' || !taskId
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(taskId)) {
        throw new Error('任务标识无效。')
      }
      const task = active.database.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId)
      if (!task) throw new Error('TASK_NOT_FOUND')
      if (task.status !== 'cancelled') throw new Error('TASK_OUTPUT_CLEANUP_REQUIRES_CANCELLED_TASK')
      const dataDirectory = path.join(active.directory, '.vibepaper')
      const generatedDirectory = path.join(dataDirectory, 'generated')
      const generatedInfo = await fs.lstat(generatedDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      if (!generatedInfo) return false
      if (!generatedInfo.isDirectory() || generatedInfo.isSymbolicLink()
        || path.relative(generatedDirectory, await fs.realpath(generatedDirectory)) !== '') {
        throw new Error('任务结果目录无效，无法清理。')
      }
      const taskDirectory = path.join(generatedDirectory, taskId)
      const taskInfo = await fs.lstat(taskDirectory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      if (!taskInfo) return false
      if (!taskInfo.isDirectory() || taskInfo.isSymbolicLink()
        || path.relative(taskDirectory, await fs.realpath(taskDirectory)) !== '') {
        throw new Error('任务结果目录无效，无法清理。')
      }
      await invalidateBackupManifest(dataDirectory)
      await fs.rm(taskDirectory, { recursive: true, force: true })
      for (const cacheKey of previewDigestCache.keys()) {
        if (cacheKey.startsWith(`${projectId}:${taskId}:`)) previewDigestCache.delete(cacheKey)
      }
      return true
    })
  }

  function retryTask(projectId, taskId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法重试任务。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const current = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      if (current.status === 'queued' || current.status === 'running') {
        return taskFromRow(active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId))
      }
      const providerCheckpoint = latestProviderCheckpoint(active.database, taskId)
      if (providerCheckpoint?.phase === 'submitting') {
        throw new Error('官方生成任务的提交结果待确认，不能安全重新提交；请先在供应商处核实。')
      }
      if (current.status === 'interrupted' && current.provider_type === 'cloud' && !providerCheckpoint?.remoteTaskId) {
        throw new Error('云端任务中断后结果未知，当前无法安全自动重试。')
      }
      if (current.status !== 'failed' && !(current.status === 'interrupted' && (current.provider_type === 'local' || providerCheckpoint?.remoteTaskId))) {
        throw new Error('任务不可重试。')
      }
      const now = new Date().toISOString()
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      active.database.exec('BEGIN IMMEDIATE')
      try {
        const update = active.database.prepare(`
          UPDATE tasks SET status = 'queued', error_code = NULL, started_at = NULL,
            completed_at = NULL, updated_at = ?
          WHERE task_id = ? AND status = ?
        `).run(now, taskId, current.status)
        if (update.changes !== 1) throw new Error('TASK_STATE_CONFLICT')
        appendTaskEvent(active.database, taskId, 'created', {
          retry: true,
          previousStatus: current.status,
          previousErrorCode: current.error_code,
        }, now)
        active.database.exec('COMMIT')
        return taskFromRow(active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.task_id = ?`).get(taskId))
      } catch (error) {
        active.database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function getActiveProject() {
    return active ? publicProject(active.metadata) : null
  }

  function requireDramaScope(projectId, canvasId) {
    if (!active || projectId !== active.metadata.projectId || canvasId !== active.metadata.canvasId) {
      throw dramaStateError('PROJECT_CHANGED', '当前项目已更改，请重新打开画布。')
    }
    return { database: active.database, canvasId }
  }

  function requireDramaSeriesRow(database, canvasId, seriesId) {
    const row = database.prepare(`
      SELECT id, canvas_id, active_canon_revision, format_json
      FROM drama_series WHERE id = ? AND canvas_id = ?
    `).get(seriesId, canvasId)
    if (!row) throw dramaStateError('NOT_FOUND', '短剧系列不存在')
    let format
    try {
      format = JSON.parse(row.format_json)
    } catch {
      throw dramaStateError('INVALID_STATE', '短剧规格状态无效')
    }
    if (!isStandardDramaFormat(format)) {
      throw dramaStateError('INVALID_STATE', '短剧规格状态无效')
    }
    return {
      id: row.id,
      canvasId: row.canvas_id,
      activeCanonRevision: Number(row.active_canon_revision),
      format,
    }
  }

  function requireDramaCharacterRow(database, canvasId, characterId) {
    const row = database.prepare(`
      SELECT character.id, character.series_id, character.name, character.identity_anchors_json,
        character.active_look_revision, character.voice_id
      FROM drama_characters character
      JOIN drama_series series ON series.id = character.series_id
      WHERE character.id = ? AND series.canvas_id = ?
    `).get(characterId, canvasId)
    if (!row) throw dramaStateError('NOT_FOUND', '角色不存在')
    let identityAnchors
    try {
      identityAnchors = dramaStateStrings(JSON.parse(row.identity_anchors_json), '角色外形锚点')
    } catch (error) {
      if (error?.code === 'INVALID_INPUT') throw dramaStateError('INVALID_STATE', '角色外形锚点状态格式无效')
      throw error
    }
    return {
      id: row.id,
      seriesId: row.series_id,
      name: row.name,
      identityAnchors,
      activeLookRevision: Number(row.active_look_revision),
      voiceId: row.voice_id,
    }
  }

  function requireDramaShotRow(database, canvasId, shotId) {
    const row = database.prepare(`
      SELECT shot.id, shot.series_id, shot.episode_no, shot.shot_no, shot.duration_seconds,
        shot.character_bindings_json, shot.prompt_revision
      FROM drama_shots shot
      JOIN drama_series series ON series.id = shot.series_id
      WHERE shot.id = ? AND series.canvas_id = ?
    `).get(shotId, canvasId)
    if (!row) throw dramaStateError('NOT_FOUND', '镜头不存在')
    let characterBindings
    try {
      characterBindings = dramaStateBindings(JSON.parse(row.character_bindings_json))
    } catch {
      throw dramaStateError('INVALID_STATE', '镜头角色绑定状态格式无效')
    }
    return {
      id: row.id,
      seriesId: row.series_id,
      episodeNo: Number(row.episode_no),
      shotNo: Number(row.shot_no),
      durationSeconds: Number(row.duration_seconds),
      characterBindings,
      promptRevision: Number(row.prompt_revision),
    }
  }

  function prepareDramaKeyframe(database, canvasId, shotId) {
    const shot = requireDramaShotRow(database, canvasId, shotId)
    const packs = shot.characterBindings.map((binding) => {
      requireDramaCharacterRow(database, canvasId, binding.characterId)
      const rows = database.prepare(`
        SELECT pack.id, pack.character_id, pack.look_revision, pack.status,
          pack.front_asset_id, pack.side_asset_id, pack.back_asset_id, pack.expression_asset_ids_json
        FROM drama_reference_packs pack
        JOIN drama_characters character ON character.id = pack.character_id
        JOIN drama_series series ON series.id = character.series_id
        WHERE pack.character_id = ? AND pack.look_revision = ? AND pack.status = 'approved'
          AND series.canvas_id = ?
      `).all(binding.characterId, binding.lookRevision, canvasId)
      if (rows.length === 0) {
        throw dramaStateError('MISSING_CHARACTER_REFERENCE', '人物镜头缺少已批准角色参考包')
      }
      if (rows.length > 1) {
        throw dramaStateError('CHARACTER_REFERENCE_AMBIGUOUS', '人物镜头存在多个角色参考包，需要人工选择')
      }
      const row = rows[0]
      let expressionAssetIds
      try {
        expressionAssetIds = dramaStateStrings(JSON.parse(row.expression_asset_ids_json), '角色表情表')
      } catch {
        throw dramaStateError('INVALID_STATE', '角色表情表状态格式无效')
      }
      for (const [value, field] of [
        [row.front_asset_id, '角色正面参考图'],
        [row.side_asset_id, '角色侧面参考图'],
        [row.back_asset_id, '角色背面参考图'],
      ]) dramaStateText(value, field)
      if (expressionAssetIds.length === 0) {
        throw dramaStateError('INCOMPLETE_REFERENCE_PACK', '角色参考包缺少表情表')
      }
      return {
        id: row.id,
        frontAssetId: row.front_asset_id,
        sideAssetId: row.side_asset_id,
        backAssetId: row.back_asset_id,
        expressionAssetIds,
      }
    })
    return {
      nodeType: 'image',
      creativeType: 'keyframe',
      shotId: shot.id,
      referencePackIds: packs.map((pack) => pack.id),
      referenceAssetIds: packs.flatMap((pack) => [
        pack.frontAssetId,
        pack.sideAssetId,
        pack.backAssetId,
        ...pack.expressionAssetIds,
      ]),
    }
  }

  async function beginDramaMutation(database, canvasId, idempotencyKey, operation) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const previous = database.prepare(`
        SELECT operation, result_json FROM drama_state_commands
        WHERE canvas_id = ? AND idempotency_key = ?
      `).get(canvasId, idempotencyKey)
      if (previous) {
        if (previous.operation !== operation) {
          throw dramaStateError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于其他短剧状态命令。')
        }
        let result
        try {
          result = JSON.parse(previous.result_json)
        } catch {
          throw dramaStateError('INVALID_STATE', '短剧命令结果快照损坏。')
        }
        database.exec('COMMIT')
        return { replayed: true, result }
      }
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      return null
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function finishDramaMutation(database, canvasId, idempotencyKey, operation, input, result) {
    const now = new Date().toISOString()
    const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    database.prepare(`
      INSERT INTO drama_state_commands (
        canvas_id, idempotency_key, operation, input_hash, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(canvasId, idempotencyKey, operation, inputHash, JSON.stringify(result), now)
  }

  function listDramaAssets(projectId, canvasId, filters = {}) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId || canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，请重新打开画布。')
      }
      if (!isRecord(filters)) throw new Error('短剧资产筛选条件无效。')
      const assetType = filters.assetType == null || filters.assetType === '' ? null : filters.assetType
      if (assetType !== null && !DRAMA_ASSET_TYPES.includes(assetType)) throw new Error('未知短剧资产类型。')
      const scopeFilters = ['episodeId', 'sceneId', 'shotId'].map((key) => {
        const value = filters[key]
        if (value != null && (typeof value !== 'string' || value.length > 200)) throw new Error('短剧资产筛选条件无效。')
        return value || null
      })
      const currentCanvasVersion = Number(active.database.prepare('SELECT version FROM canvases WHERE id = ?')
        .get(canvasId)?.version)
      if (!Number.isSafeInteger(currentCanvasVersion)) throw new Error('本地画布不存在。')
      const rows = active.database.prepare(`
        SELECT asset_id, canvas_id, asset_type, asset_version, canvas_version,
          data_json, created_at, updated_at
        FROM drama_assets
        WHERE canvas_id = ? AND (? IS NULL OR asset_type = ?)
        ORDER BY created_at ASC, asset_id ASC
      `).all(canvasId, assetType, assetType)
      const [episodeId, sceneId, shotId] = scopeFilters
      const items = rows.map((row) => dramaAssetPayload(row, currentCanvasVersion)).filter((item) => {
        const matches = (camel, snake, expected) => {
          if (!expected) return true
          const actual = Object.hasOwn(item.data, camel) ? item.data[camel] : item.data[snake]
          return actual != null && String(actual) === expected
        }
        return matches('episodeId', 'episode_id', episodeId)
          && matches('sceneId', 'scene_id', sceneId)
          && matches('shotId', 'shot_id', shotId)
      })
      return { items }
    })
  }

  function upsertDramaAsset(input) {
    return enqueue(() => {
      if (!isRecord(input)
        || typeof input.projectId !== 'string' || typeof input.canvasId !== 'string'
        || !Number.isSafeInteger(input.canvasVersion) || input.canvasVersion < 0
        || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.trim().length < 1
        || input.idempotencyKey.trim().length > 128) {
        throw new Error('短剧资产写入请求无效。')
      }
      const { projectId, canvasId } = input
      const assetType = input.assetType
      const canvasVersion = input.canvasVersion
      const idempotencyKey = input.idempotencyKey.trim()
      if (!active || projectId !== active.metadata.projectId || canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，请重新打开画布。')
      }
      const database = active.database
      database.exec('BEGIN IMMEDIATE')
      try {
        const previous = database.prepare(`
          SELECT canvas_id, idempotency_key, input_hash, asset_id, asset_type,
            asset_version, result_canvas_version, asset_data_snapshot, created_at
          FROM drama_asset_commands WHERE canvas_id = ? AND idempotency_key = ?
        `).get(canvasId, idempotencyKey)
        const currentCanvasVersion = Number(database.prepare('SELECT version FROM canvases WHERE id = ?')
          .get(canvasId)?.version)
        if (!Number.isSafeInteger(currentCanvasVersion)) throw new Error('本地画布不存在。')
        if (previous) {
          database.exec('COMMIT')
          return dramaAssetPayload({
            asset_id: previous.asset_id,
            canvas_id: previous.canvas_id,
            asset_type: previous.asset_type,
            asset_version: previous.asset_version,
            canvas_version: previous.result_canvas_version,
            asset_data_snapshot: previous.asset_data_snapshot,
            created_at: previous.created_at,
          }, currentCanvasVersion, true)
        }
        if (currentCanvasVersion !== canvasVersion) throw new Error('画布版本已变化，请刷新后重试。')

        // Java checks the idempotency ledger before validating the body. A
        // replay with the same key therefore returns its original snapshot,
        // even if the retried body is different or malformed.
        const assetId = input.assetId == null ? null : normalizeCanvasEntityId(input.assetId, '短剧资产')
        const data = normalizeDramaAssetData(assetType, input.data)
        const inputHash = createHash('sha256').update(JSON.stringify({
          assetType,
          assetId,
          canvasVersion,
          data,
        })).digest('hex')

        const now = new Date().toISOString()
        let nextAssetId = assetId
        let nextAssetVersion = 1
        let createdAt = now
        if (assetId !== null) {
          const current = database.prepare(`
            SELECT asset_id, asset_type, asset_version, created_at
            FROM drama_assets WHERE asset_id = ? AND canvas_id = ?
          `).get(assetId, canvasId)
          if (!current) throw new Error('短剧资产不存在。')
          if (current.asset_type !== assetType) throw new Error('短剧资产类型不可变更。')
          nextAssetVersion = Number(current.asset_version) + 1
          createdAt = current.created_at
          database.prepare(`
            UPDATE drama_assets SET asset_version = ?, canvas_version = ?, data_json = ?, updated_at = ?
            WHERE asset_id = ? AND canvas_id = ?
          `).run(nextAssetVersion, currentCanvasVersion + 1, JSON.stringify(data), now, assetId, canvasId)
        } else {
          nextAssetId = randomUUID()
          database.prepare(`
            INSERT INTO drama_assets (
              asset_id, canvas_id, asset_type, asset_version, canvas_version, data_json, created_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
          `).run(nextAssetId, canvasId, assetType, currentCanvasVersion + 1, JSON.stringify(data), now, now)
        }

        const nextCanvasVersion = currentCanvasVersion + 1
        const canvasUpdate = database.prepare(`
          UPDATE canvases SET version = ?, updated_at = ? WHERE id = ? AND version = ?
        `).run(nextCanvasVersion, now, canvasId, currentCanvasVersion)
        if (canvasUpdate.changes !== 1) throw new Error('画布已被并发更新，请刷新后重试。')
        database.prepare(`
          INSERT INTO drama_asset_commands (
            canvas_id, idempotency_key, input_hash, asset_id, asset_type, asset_version,
            result_canvas_version, asset_data_snapshot, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(canvasId, idempotencyKey, inputHash, nextAssetId, assetType, nextAssetVersion,
          nextCanvasVersion, JSON.stringify(data), now)
        database.exec('COMMIT')
        active.canvas = { ...active.canvas, version: nextCanvasVersion }
        return dramaAssetPayload({
          asset_id: nextAssetId,
          canvas_id: canvasId,
          asset_type: assetType,
          asset_version: nextAssetVersion,
          canvas_version: nextCanvasVersion,
          data_json: JSON.stringify(data),
          created_at: createdAt,
          updated_at: now,
        }, nextCanvasVersion, false)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function createDramaSeries(input) {
    return enqueue(async () => {
      if (!isRecord(input)) {
        throw dramaStateError('INVALID_INPUT', '短剧系列创建请求无效')
      }
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const idempotencyKey = requireDramaIdempotencyKey(input.idempotencyKey)
      const replay = await beginDramaMutation(database, canvasId, idempotencyKey, 'create_series')
      if (replay) return replay.result
      try {
        if (!isRecord(input.series)) throw dramaStateError('INVALID_INPUT', '短剧系列创建请求无效')
        const raw = input.series
        const id = normalizeCanvasEntityId(raw.id ?? randomUUID(), '短剧系列')
        const activeCanonRevision = raw.activeCanonRevision ?? 1
        if (!Number.isSafeInteger(activeCanonRevision) || activeCanonRevision < 0) {
          throw dramaStateError('INVALID_INPUT', 'activeCanonRevision 必须是非负整数')
        }
        const format = cloneJsonRecord(raw.format ?? STANDARD_VERTICAL_SHORT_DRAMA_FORMAT, '短剧规格')
        if (!isStandardDramaFormat(format)) {
          throw dramaStateError('INVALID_FORMAT', '短剧规格与标准竖屏短剧不匹配')
        }
        const series = { id, canvasId, activeCanonRevision, format }
        const now = new Date().toISOString()
        database.prepare(`
          INSERT INTO drama_series (id, canvas_id, active_canon_revision, format_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, canvasId, activeCanonRevision, JSON.stringify(format), now, now)
        finishDramaMutation(database, canvasId, idempotencyKey, 'create_series', series, series)
        database.exec('COMMIT')
        return JSON.parse(JSON.stringify(series))
      } catch (error) {
        database.exec('ROLLBACK')
        if (dramaStateUniqueConflict(error)) throw dramaStateError('CONFLICT', '短剧系列已存在')
        throw error
      }
    })
  }

  function createDramaCharacter(input) {
    return enqueue(async () => {
      if (!isRecord(input)) {
        throw dramaStateError('INVALID_INPUT', '角色创建请求无效')
      }
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const idempotencyKey = requireDramaIdempotencyKey(input.idempotencyKey)
      const replay = await beginDramaMutation(database, canvasId, idempotencyKey, 'create_character')
      if (replay) return replay.result
      try {
        if (!isRecord(input.character)) throw dramaStateError('INVALID_INPUT', '角色创建请求无效')
        const raw = input.character
        const character = {
          id: normalizeCanvasEntityId(raw.id ?? randomUUID(), '角色'),
          seriesId: normalizeCanvasEntityId(raw.seriesId, '短剧系列'),
          name: dramaStateText(raw.name, '角色名'),
          identityAnchors: dramaStateStrings(raw.identityAnchors, '角色外形锚点'),
          activeLookRevision: raw.activeLookRevision ?? 1,
          voiceId: dramaStateText(raw.voiceId, '角色 voiceId'),
        }
        if (!Number.isSafeInteger(character.activeLookRevision) || character.activeLookRevision < 0) {
          throw dramaStateError('INVALID_INPUT', 'activeLookRevision 必须是非负整数')
        }
        const normalizedAnchors = character.identityAnchors.map((anchor) => anchor.trim())
        if (normalizedAnchors.length < 3 || normalizedAnchors.length > 5 || normalizedAnchors.some((anchor) => !anchor)) {
          throw dramaStateError('INVALID_IDENTITY_ANCHORS', '角色必须包含 3-5 条不可变外形锚点')
        }
        if (new Set(normalizedAnchors).size !== normalizedAnchors.length) {
          throw dramaStateError('INVALID_IDENTITY_ANCHORS', '角色外形锚点不能重复')
        }
        requireDramaSeriesRow(database, canvasId, character.seriesId)
        const now = new Date().toISOString()
        database.prepare(`
          INSERT INTO drama_characters (
            id, series_id, name, identity_anchors_json, active_look_revision, voice_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(character.id, character.seriesId, character.name, JSON.stringify(character.identityAnchors),
          character.activeLookRevision, character.voiceId, now, now)
        finishDramaMutation(database, canvasId, idempotencyKey, 'create_character', character, character)
        database.exec('COMMIT')
        return JSON.parse(JSON.stringify(character))
      } catch (error) {
        database.exec('ROLLBACK')
        if (dramaStateUniqueConflict(error)) throw dramaStateError('CONFLICT', '角色已存在')
        throw error
      }
    })
  }

  function addDramaReferencePack(input) {
    return enqueue(async () => {
      if (!isRecord(input)) {
        throw dramaStateError('INVALID_INPUT', '角色参考包创建请求无效')
      }
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const idempotencyKey = requireDramaIdempotencyKey(input.idempotencyKey)
      const replay = await beginDramaMutation(database, canvasId, idempotencyKey, 'add_reference_pack')
      if (replay) return replay.result
      try {
        if (!isRecord(input.pack)) throw dramaStateError('INVALID_INPUT', '角色参考包创建请求无效')
        const raw = input.pack
        const pack = {
          id: normalizeCanvasEntityId(raw.id ?? randomUUID(), '角色参考包'),
          characterId: normalizeCanvasEntityId(raw.characterId, '角色'),
          lookRevision: raw.lookRevision,
          status: dramaStateStatus(raw.status, ['draft', 'approved', 'retired'], '角色参考包'),
          frontAssetId: dramaStateText(raw.frontAssetId, '角色正面参考图'),
          sideAssetId: dramaStateText(raw.sideAssetId, '角色侧面参考图'),
          backAssetId: dramaStateText(raw.backAssetId, '角色背面参考图'),
          expressionAssetIds: dramaStateStrings(raw.expressionAssetIds, '角色表情表'),
        }
        if (!Number.isSafeInteger(pack.lookRevision) || pack.lookRevision < 0) {
          throw dramaStateError('INVALID_INPUT', 'lookRevision 必须是非负整数')
        }
        const character = requireDramaCharacterRow(database, canvasId, pack.characterId)
        if (pack.lookRevision !== character.activeLookRevision) {
          throw dramaStateError('VERSION_CONFLICT', '角色参考包不是当前 Look revision')
        }
        if (pack.status === 'approved' && pack.expressionAssetIds.length === 0) {
          throw dramaStateError('INCOMPLETE_REFERENCE_PACK', '角色参考包缺少表情表')
        }
        const now = new Date().toISOString()
        database.prepare(`
          INSERT INTO drama_reference_packs (
            id, character_id, look_revision, status, front_asset_id, side_asset_id,
            back_asset_id, expression_asset_ids_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(pack.id, pack.characterId, pack.lookRevision, pack.status, pack.frontAssetId,
          pack.sideAssetId, pack.backAssetId, JSON.stringify(pack.expressionAssetIds), now)
        finishDramaMutation(database, canvasId, idempotencyKey, 'add_reference_pack', pack, pack)
        database.exec('COMMIT')
        return JSON.parse(JSON.stringify(pack))
      } catch (error) {
        database.exec('ROLLBACK')
        if (dramaStateUniqueConflict(error)) throw dramaStateError('CONFLICT', '角色参考包已存在')
        throw error
      }
    })
  }

  function createDramaShot(input) {
    return enqueue(async () => {
      if (!isRecord(input)) {
        throw dramaStateError('INVALID_INPUT', '镜头创建请求无效')
      }
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const idempotencyKey = requireDramaIdempotencyKey(input.idempotencyKey)
      const replay = await beginDramaMutation(database, canvasId, idempotencyKey, 'create_shot')
      if (replay) return replay.result
      try {
        if (!isRecord(input.shot)) throw dramaStateError('INVALID_INPUT', '镜头创建请求无效')
        const raw = input.shot
        const shot = {
          id: normalizeCanvasEntityId(raw.id ?? randomUUID(), '镜头'),
          seriesId: normalizeCanvasEntityId(raw.seriesId, '短剧系列'),
          episodeNo: raw.episodeNo,
          shotNo: raw.shotNo,
          durationSeconds: raw.durationSeconds,
          characterBindings: dramaStateBindings(raw.characterBindings),
          promptRevision: raw.promptRevision ?? 1,
        }
        for (const [value, field] of [
          [shot.episodeNo, 'episodeNo'],
          [shot.shotNo, 'shotNo'],
          [shot.durationSeconds, 'durationSeconds'],
          [shot.promptRevision, 'promptRevision'],
        ]) {
          if (!Number.isSafeInteger(value) || value < 0) {
            throw dramaStateError('INVALID_INPUT', `${field} 必须是非负整数`)
          }
        }
        const series = requireDramaSeriesRow(database, canvasId, shot.seriesId)
        if (shot.durationSeconds < series.format.minShotDurationSeconds
          || shot.durationSeconds > series.format.maxShotDurationSeconds) {
          throw dramaStateError('INVALID_SHOT_DURATION', '竖屏短剧单镜时长必须在 2-5 秒之间')
        }
        for (const binding of shot.characterBindings) {
          if (!Number.isSafeInteger(binding.lookRevision) || binding.lookRevision < 0) {
            throw dramaStateError('INVALID_CHARACTER_BINDING', '镜头包含无效角色')
          }
          const character = requireDramaCharacterRow(database, canvasId, binding.characterId)
          if (character.seriesId !== shot.seriesId || character.activeLookRevision !== binding.lookRevision) {
            throw dramaStateError('INVALID_CHARACTER_BINDING', '镜头未绑定系列当前角色 Look revision')
          }
        }
        const now = new Date().toISOString()
        database.prepare(`
          INSERT INTO drama_shots (
            id, series_id, episode_no, shot_no, duration_seconds, character_bindings_json, prompt_revision, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(shot.id, shot.seriesId, shot.episodeNo, shot.shotNo, shot.durationSeconds,
          JSON.stringify(shot.characterBindings), shot.promptRevision, now)
        finishDramaMutation(database, canvasId, idempotencyKey, 'create_shot', shot, shot)
        database.exec('COMMIT')
        return JSON.parse(JSON.stringify(shot))
      } catch (error) {
        database.exec('ROLLBACK')
        if (dramaStateUniqueConflict(error)) throw dramaStateError('CONFLICT', '镜头已存在')
        throw error
      }
    })
  }

  function prepareDramaKeyframeNode(input) {
    return enqueue(() => {
      if (!isRecord(input)) throw dramaStateError('INVALID_INPUT', '关键帧节点准备请求无效')
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const shotId = normalizeCanvasEntityId(input.shotId, '镜头')
      return prepareDramaKeyframe(database, canvasId, shotId)
    })
  }

  function recordDramaKeyframe(input) {
    return enqueue(async () => {
      if (!isRecord(input)) {
        throw dramaStateError('INVALID_INPUT', '关键帧状态写入请求无效')
      }
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const idempotencyKey = requireDramaIdempotencyKey(input.idempotencyKey)
      const replay = await beginDramaMutation(database, canvasId, idempotencyKey, 'record_keyframe')
      if (replay) return replay.result
      try {
        if (!isRecord(input.render)) throw dramaStateError('INVALID_INPUT', '关键帧状态写入请求无效')
        const raw = input.render
        const render = {
          id: normalizeCanvasEntityId(raw.id ?? randomUUID(), '关键帧'),
          shotId: normalizeCanvasEntityId(raw.shotId, '镜头'),
          status: dramaStateStatus(raw.status, ['draft', 'accepted', 'rejected', 'stale'], '关键帧'),
          referencePackIds: dramaStateStrings(raw.referencePackIds, '关键帧参考包'),
        }
        const expected = prepareDramaKeyframe(database, canvasId, render.shotId)
        if (render.status === 'accepted' && !sameDramaIds(render.referencePackIds, expected.referencePackIds)) {
          throw dramaStateError('MISSING_CHARACTER_REFERENCE', '关键帧未绑定当前角色参考包')
        }
        const now = new Date().toISOString()
        database.prepare(`
          INSERT INTO drama_keyframes (id, shot_id, status, reference_pack_ids_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(render.id, render.shotId, render.status, JSON.stringify(render.referencePackIds), now)
        finishDramaMutation(database, canvasId, idempotencyKey, 'record_keyframe', render, render)
        database.exec('COMMIT')
        return JSON.parse(JSON.stringify(render))
      } catch (error) {
        database.exec('ROLLBACK')
        if (dramaStateUniqueConflict(error)) throw dramaStateError('CONFLICT', '关键帧已存在')
        throw error
      }
    })
  }

  function prepareDramaVideoNode(input) {
    return enqueue(() => {
      if (!isRecord(input)) throw dramaStateError('INVALID_INPUT', '视频节点准备请求无效')
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const shotId = normalizeCanvasEntityId(input.shotId, '镜头')
      const expected = prepareDramaKeyframe(database, canvasId, shotId)
      const row = database.prepare(`
        SELECT id, reference_pack_ids_json FROM drama_keyframes
        WHERE shot_id = ? AND status = 'accepted'
        ORDER BY created_at DESC, id DESC LIMIT 1
      `).get(shotId)
      if (!row) throw dramaStateError('KEYFRAME_NOT_ACCEPTED', '视频生成必须引用已接受的关键帧')
      let referencePackIds
      try {
        referencePackIds = dramaStateStrings(JSON.parse(row.reference_pack_ids_json), '关键帧参考包')
      } catch {
        throw dramaStateError('INVALID_STATE', '关键帧参考包状态格式无效')
      }
      if (!sameDramaIds(referencePackIds, expected.referencePackIds)) {
        throw dramaStateError('MISSING_CHARACTER_REFERENCE', '视频生成缺少当前角色参考包')
      }
      return {
        nodeType: 'video',
        creativeType: 'clip',
        shotId,
        keyframeRenderId: row.id,
        referencePackIds: expected.referencePackIds,
      }
    })
  }

  function recordDramaLineage(input) {
    return enqueue(async () => {
      if (!isRecord(input)) {
        throw dramaStateError('INVALID_INPUT', '镜头渲染血缘写入请求无效')
      }
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const idempotencyKey = requireDramaIdempotencyKey(input.idempotencyKey)
      const replay = await beginDramaMutation(database, canvasId, idempotencyKey, 'record_lineage')
      if (replay) return replay.result
      try {
        if (!isRecord(input.lineage)) throw dramaStateError('INVALID_INPUT', '镜头渲染血缘写入请求无效')
        const raw = input.lineage
        const lineage = {
          id: normalizeCanvasEntityId(raw.id ?? randomUUID(), '渲染血缘'),
          shotId: normalizeCanvasEntityId(raw.shotId, '镜头'),
          keyframeRenderId: normalizeCanvasEntityId(raw.keyframeRenderId, '关键帧'),
          status: dramaStateStatus(raw.status, ['draft', 'ready_for_video', 'submitted', 'stale'], '渲染血缘'),
        }
        requireDramaShotRow(database, canvasId, lineage.shotId)
        const keyframe = database.prepare('SELECT id, shot_id FROM drama_keyframes WHERE id = ?').get(lineage.keyframeRenderId)
        if (!keyframe) throw dramaStateError('NOT_FOUND', '关键帧不存在')
        if (keyframe.shot_id !== lineage.shotId) {
          throw dramaStateError('INVALID_KEYFRAME_REFERENCE', '渲染血缘必须引用同一镜头的关键帧')
        }
        const now = new Date().toISOString()
        database.prepare(`
          INSERT INTO drama_render_lineages (id, shot_id, keyframe_render_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(lineage.id, lineage.shotId, lineage.keyframeRenderId, lineage.status, now, now)
        finishDramaMutation(database, canvasId, idempotencyKey, 'record_lineage', lineage, lineage)
        database.exec('COMMIT')
        return JSON.parse(JSON.stringify(lineage))
      } catch (error) {
        database.exec('ROLLBACK')
        if (dramaStateUniqueConflict(error)) throw dramaStateError('CONFLICT', '镜头渲染血缘已存在')
        throw error
      }
    })
  }

  function markDramaLineagesStaleForCharacter(input) {
    return enqueue(async () => {
      if (!isRecord(input)) throw dramaStateError('INVALID_INPUT', '镜头渲染血缘失效请求无效')
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const idempotencyKey = requireDramaIdempotencyKey(input.idempotencyKey)
      const replay = await beginDramaMutation(database, canvasId, idempotencyKey, 'stale_lineages_for_character')
      if (replay) return replay.result
      try {
        const characterId = normalizeCanvasEntityId(input.characterId, '角色')
        const rows = database.prepare(`
          SELECT lineage.id, shot.character_bindings_json
          FROM drama_render_lineages lineage
          JOIN drama_shots shot ON shot.id = lineage.shot_id
          JOIN drama_series series ON series.id = shot.series_id
          WHERE lineage.status <> 'stale' AND series.canvas_id = ?
          ORDER BY lineage.rowid
        `).all(canvasId)
        const ids = rows.filter((row) => {
          let bindings
          try {
            bindings = dramaStateBindings(JSON.parse(row.character_bindings_json))
          } catch {
            throw dramaStateError('INVALID_STATE', '镜头角色绑定状态格式无效')
          }
          return bindings.some((binding) => binding.characterId === characterId)
        }).map((row) => row.id)
        const update = database.prepare(`
          UPDATE drama_render_lineages SET status = 'stale', updated_at = ?
          WHERE id = ? AND status <> 'stale'
        `)
        const now = new Date().toISOString()
        const staleIds = []
        for (const id of ids) {
          if (update.run(now, id).changes === 1) staleIds.push(id)
        }
        finishDramaMutation(database, canvasId, idempotencyKey, 'stale_lineages_for_character', { characterId }, staleIds)
        database.exec('COMMIT')
        return staleIds
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function readDramaNode(database, canvasId, nodeId, label) {
    const row = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?').get(canvasId, nodeId)
    if (!row) throw dramaStateError('NODE_NOT_FOUND', `${label}节点不存在。`)
    try {
      const flowNode = JSON.parse(row.payload_json)
      if (!isRecord(flowNode) || !isRecord(flowNode.data)) throw new Error('invalid node')
      return nodePayloadFromFlowNode(flowNode)
    } catch {
      throw dramaStateError('INVALID_STATE', `${label}节点状态损坏。`)
    }
  }

  async function requireActualAcceptedKeyframe(database, canvasId, shot, keyframeRenderId) {
    const accepted = database.prepare(`
      SELECT keyframe.id, keyframe.reference_pack_ids_json, series.active_canon_revision,
        shot.prompt_revision, shot.character_bindings_json
      FROM drama_keyframes keyframe
      JOIN drama_shots shot ON shot.id = keyframe.shot_id
      JOIN drama_series series ON series.id = shot.series_id
      WHERE keyframe.id = ? AND keyframe.shot_id = ? AND keyframe.status = 'accepted'
        AND shot.series_id = ? AND shot.episode_no = ? AND shot.duration_seconds = ?
        AND series.canvas_id = ?
    `).get(keyframeRenderId, shot.id, shot.seriesId, shot.episodeNo, shot.durationSeconds, canvasId)
    if (!accepted) throw dramaStateError('KEYFRAME_NOT_ACCEPTED', '批次必须引用该镜头当前已接受的关键帧。')
    const current = prepareDramaKeyframe(database, canvasId, shot.id)
    let acceptedPackIds
    try {
      acceptedPackIds = dramaStateStrings(JSON.parse(accepted.reference_pack_ids_json), '关键帧参考包')
    } catch {
      throw dramaStateError('INVALID_STATE', '关键帧参考包状态格式无效。')
    }
    if (!sameDramaIds(acceptedPackIds, current.referencePackIds)) {
      throw dramaStateError('KEYFRAME_STALE', '关键帧引用的角色参考包已过期，请先重新生成并接受关键帧。')
    }

    // v16 accepts a state record only. A batch is stricter: the accepted ID must
    // identify the real, succeeded TaskStore image and its owned keyframe node.
    const task = database.prepare('SELECT * FROM tasks WHERE task_id = ? AND canvas_id = ?')
      .get(keyframeRenderId, canvasId)
    if (!task || task.modality !== 'image' || task.status !== 'succeeded' || !task.node_id || !task.output_path) {
      throw dramaStateError('KEYFRAME_OUTPUT_UNAVAILABLE', '已接受关键帧必须对应可读取的本地图片生成任务。')
    }
    const imageNode = readDramaNode(database, canvasId, task.node_id, '关键帧')
    if (imageNode.type !== 'image' || imageNode.creativeType !== 'keyframe'
      || imageNode.params.shotId !== shot.id
      || !sameDramaIds(dramaStateStrings(imageNode.params.referencePackIds, '关键帧参考包'), current.referencePackIds)) {
      throw dramaStateError('KEYFRAME_NODE_MISMATCH', '关键帧任务节点与当前镜头或角色参考包不匹配。')
    }
    try {
      const output = await resolveTaskOutputFile(
        path.join(active.directory, '.vibepaper'), task.task_id, 'image', task.output_path,
      )
      if (output.sha256 !== task.output_sha256 || output.sizeBytes !== task.output_size_bytes) throw new Error('output mismatch')
    } catch {
      throw dramaStateError('KEYFRAME_OUTPUT_UNAVAILABLE', '已接受关键帧的本地结果文件缺失或校验失败。')
    }
    return { task, referencePackIds: current.referencePackIds, accepted }
  }

  function dramaRenderBatchModelAvailability(providerType, providerId, modelId, durationSeconds, modelParams = {}) {
    const mediaReferenceValues = (keys) => keys.flatMap((key) => {
      const value = modelParams[key]
      return Array.isArray(value) ? value : value == null || value === '' ? [] : [value]
    }).filter((value) => typeof value === 'string' && value.trim())
    const nonImageReferences = [
      ...mediaReferenceValues(['referenceVideos', 'reference_videos']),
      ...mediaReferenceValues(['referenceAudios', 'reference_audios']),
    ]
    const hasLocalNonImageReference = nonImageReferences.some((value) => /^(?:vibe:|file:)/iu.test(value.trim()))
    if (providerType === 'cloud' && providerId === AGNES_PROVIDER_ID && modelId === AGNES_MODELS.video) {
      if (durationSeconds < 4 || durationSeconds > 12) {
        return {
          available: false,
          unavailableReasonCode: 'MODEL_DURATION_UNSUPPORTED',
          unavailableReason: 'Agnes 视频模型只接受 4–12 秒；此镜头时长不能用于批量生成。',
        }
      }
      if (nonImageReferences.length > 0) {
        return {
          available: false,
          unavailableReasonCode: 'UNSUPPORTED_REFERENCE_MEDIA',
          unavailableReason: 'Agnes 视频模型不支持视频或音频参考，请先从此镜头移除这些参考素材。',
        }
      }
      return { available: true }
    }
    if (providerType === 'cloud' && providerId === ARK_PROVIDER_ID && modelId === ARK_MODELS.video) {
      if (durationSeconds < 4 || durationSeconds > 30) {
        return {
          available: false,
          unavailableReasonCode: 'MODEL_DURATION_UNSUPPORTED',
          unavailableReason: 'Ark Seedance 视频模型只接受 4–30 秒；此镜头时长不能用于批量生成。',
        }
      }
      if (hasLocalNonImageReference) {
        return {
          available: false,
          unavailableReasonCode: 'REFERENCE_MEDIA_UNSUPPORTED',
          unavailableReason: 'Ark 本地视频或音频参考尚无供应商上传链，请移除这些参考或改用模型可访问的 HTTPS 地址。',
        }
      }
      return { available: true }
    }
    return {
      available: false,
      unavailableReasonCode: 'MODEL_UNAVAILABLE',
      unavailableReason: '此提供方或模型尚未接入短剧批次生成。',
    }
  }

  async function normalizeDramaRenderJob(database, canvasId, seriesId, episodeNo, rawJob, options = {}) {
    if (!isRecord(rawJob)) throw dramaStateError('INVALID_INPUT', '渲染批次镜头参数无效。')
    const shotId = normalizeCanvasEntityId(rawJob.shotId, '镜头')
    const keyframeRenderId = normalizeCanvasEntityId(rawJob.keyframeRenderId, '关键帧')
    const canvasNodeId = normalizeCanvasEntityId(rawJob.canvasNodeId, '视频节点')
    const shot = requireDramaShotRow(database, canvasId, shotId)
    if (shot.seriesId !== seriesId || shot.episodeNo !== episodeNo) {
      throw dramaStateError('INVALID_SHOT_REFERENCE', '批次镜头必须属于指定系列和集数。')
    }
    if (!Number.isSafeInteger(rawJob.durationSeconds) || rawJob.durationSeconds !== shot.durationSeconds) {
      throw dramaStateError('INVALID_SHOT_DURATION', '批次镜头时长必须與镜头状态一致。')
    }
    if (rawJob.modelType !== 'video') throw dramaStateError('INVALID_INPUT', '渲染批次只支持视频生成任务。')
    const accepted = await requireActualAcceptedKeyframe(database, canvasId, shot, keyframeRenderId)
    const videoNode = readDramaNode(database, canvasId, canvasNodeId, '视频')
    if (videoNode.type !== 'video' || videoNode.creativeType !== 'clip'
      || videoNode.params.shotId !== shot.id
      || videoNode.params.keyframeRenderId !== keyframeRenderId
      || !sameDramaIds(dramaStateStrings(videoNode.params.referencePackIds, '视频角色参考包'), accepted.referencePackIds)) {
      throw dramaStateError('VIDEO_NODE_MISMATCH', '批次目标节点必须属于当前镜头并引用当前已接受关键帧和角色参考包。')
    }

    const modelParams = cloneJsonRecord(rawJob.modelParams ?? {}, '视频模型参数')
    const providerType = rawJob.providerType ?? modelParams.providerType
    const providerId = rawJob.providerId ?? modelParams.providerId
    const modelId = rawJob.modelId ?? modelParams.modelId
    if (!['cloud', 'local'].includes(providerType)
      || typeof providerId !== 'string' || !providerId.trim() || providerId.length > 160
      || typeof modelId !== 'string' || !modelId.trim() || modelId.length > 200) {
      throw dramaStateError('INVALID_INPUT', '批次必须明确指定提供方类型、提供方和模型。')
    }
    const nodePrompt = typeof videoNode.prompt === 'string' ? videoNode.prompt
      : typeof videoNode.params.prompt === 'string' ? videoNode.params.prompt : ''
    if (!nodePrompt.trim() || (modelParams.prompt !== undefined && modelParams.prompt !== nodePrompt)) {
      throw dramaStateError('VIDEO_PROMPT_MISMATCH', '批次提示词必须与目标视频节点中已保存的提示词一致。')
    }
    modelParams.prompt = nodePrompt
    modelParams.seconds = shot.durationSeconds
    // Never accept a renderer supplied frame URL. Resolve it from the accepted
    // TaskStore output at submission using this confirmed keyframe ID.
    delete modelParams.firstFrameUrl
    assertNoCredentialFields(modelParams)
    const availability = dramaRenderBatchModelAvailability(
      providerType, providerId.trim(), modelId.trim(), shot.durationSeconds, modelParams,
    )
    if (!options.allowUnavailableModel && !availability.available) {
      throw dramaStateError(availability.unavailableReasonCode, availability.unavailableReason)
    }
    const series = requireDramaSeriesRow(database, canvasId, seriesId)
    const lookRevision = shot.characterBindings.reduce((current, binding) => Math.max(current, binding.lookRevision), 0)
    const inputHash = createHash('sha256').update(JSON.stringify({
      canonRevision: series.activeCanonRevision,
      characterLookRevision: lookRevision,
      promptRevision: shot.promptRevision,
      canvasVersion: Number(database.prepare('SELECT version FROM canvases WHERE id = ?').get(canvasId).version),
      lineageInputs: [keyframeRenderId],
    })).digest('hex')
    return {
      shotId,
      keyframeRenderId,
      canvasNodeId,
      durationSeconds: shot.durationSeconds,
      modelType: 'video',
      providerType,
      providerId: providerId.trim(),
      modelId: modelId.trim(),
      modelParams,
      inputHash,
      shot,
    }
  }

  function listDramaRenderCandidates(projectId, canvasId) {
    return enqueue(async () => {
      const { database } = requireDramaScope(projectId, canvasId)
      const shots = database.prepare(`
        SELECT shot.id FROM drama_shots shot
        JOIN drama_series series ON series.id = shot.series_id
        WHERE series.canvas_id = ? ORDER BY shot.episode_no, shot.shot_no, shot.id
      `).all(canvasId)
      const nodeIds = database.prepare('SELECT id FROM nodes WHERE canvas_id = ? ORDER BY id').all(canvasId)
      const candidatesByShot = new Map()

      for (const row of shots) {
        const shot = requireDramaShotRow(database, canvasId, row.id)
        const accepted = database.prepare(`
          SELECT id FROM drama_keyframes WHERE shot_id = ? AND status = 'accepted'
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get(shot.id)
        if (!accepted) continue

        let keyframe
        try {
          keyframe = await requireActualAcceptedKeyframe(database, canvasId, shot, accepted.id)
        } catch (error) {
          if (['KEYFRAME_OUTPUT_UNAVAILABLE', 'KEYFRAME_NODE_MISMATCH', 'KEYFRAME_STALE'].includes(error?.code)) continue
          throw error
        }

        const shotCandidates = []
        for (const nodeRow of nodeIds) {
          const videoNode = readDramaNode(database, canvasId, nodeRow.id, '视频')
          if (videoNode.type !== 'video' || videoNode.creativeType !== 'clip'
            || videoNode.params.shotId !== shot.id
            || videoNode.params.keyframeRenderId !== accepted.id
            || !sameDramaIds(dramaStateStrings(videoNode.params.referencePackIds, '视频角色参考包'), keyframe.referencePackIds)) {
            continue
          }
          const nodeModel = typeof videoNode.params.model === 'string' && videoNode.params.model.trim()
            ? videoNode.params.model.trim()
            : typeof videoNode.modelRef === 'string' ? videoNode.modelRef.trim() : ''
          const provider = nodeModel === AGNES_MODELS.video
            ? { providerType: 'cloud', providerId: AGNES_PROVIDER_ID, modelId: AGNES_MODELS.video }
            : nodeModel === ARK_MODELS.video
              ? { providerType: 'cloud', providerId: ARK_PROVIDER_ID, modelId: ARK_MODELS.video }
              : null
          if (!provider) continue
          const modelParams = { ...videoNode.params }
          if (videoNode.prompt && modelParams.prompt === undefined) modelParams.prompt = videoNode.prompt
          try {
            const normalized = await normalizeDramaRenderJob(database, canvasId, shot.seriesId, shot.episodeNo, {
              shotId: shot.id,
              keyframeRenderId: accepted.id,
              canvasNodeId: videoNode.id,
              durationSeconds: shot.durationSeconds,
              modelType: 'video',
              ...provider,
              modelParams,
            }, { allowUnavailableModel: true })
            shotCandidates.push({
              seriesId: shot.seriesId,
              episodeNo: shot.episodeNo,
              shotId: shot.id,
              shotNo: shot.shotNo,
              durationSeconds: normalized.durationSeconds,
              keyframeRenderId: normalized.keyframeRenderId,
              canvasNodeId: normalized.canvasNodeId,
              prompt: normalized.modelParams.prompt,
              providerType: normalized.providerType,
              providerId: normalized.providerId,
              modelId: normalized.modelId,
              modelParams: normalized.modelParams,
              ...dramaRenderBatchModelAvailability(
                normalized.providerType, normalized.providerId, normalized.modelId, normalized.durationSeconds,
                normalized.modelParams,
              ),
            })
          } catch (error) {
            if (['VIDEO_NODE_MISMATCH', 'VIDEO_PROMPT_MISMATCH', 'KEYFRAME_NOT_ACCEPTED', 'KEYFRAME_STALE'].includes(error?.code)) continue
            throw error
          }
        }
        if (shotCandidates.length === 1) candidatesByShot.set(shot.id, shotCandidates[0])
      }
      return { items: [...candidatesByShot.values()] }
    })
  }

  function renderBatchConfirmationSnapshot(database, batch, operation, jobId) {
    const expectedStatus = operation === 'rerun' ? 'failed' : 'draft'
    const jobs = database.prepare(`
      SELECT * FROM drama_render_jobs WHERE batch_id = ? AND status = ?
        AND (? IS NULL OR job_id = ?) ORDER BY created_at, job_id
    `).all(batch.batch_id, expectedStatus, jobId ?? null, jobId ?? null)
    if (jobs.length === 0) throw dramaStateError('NO_JOBS_TO_SUBMIT', '批次中没有可提交的镜头任务。')
    if (operation === 'rerun' && (jobs.length !== 1 || Number(jobs[0].attempt) >= 20)) {
      throw dramaStateError(Number(jobs[0].attempt) >= 20 ? 'RERUN_LIMIT_REACHED' : 'JOB_NOT_FAILED',
        Number(jobs[0].attempt) >= 20 ? '该镜头已达到局部重跑次数上限。' : '只有失败的镜头任务可以局部重跑。')
    }
    const version = Number(database.prepare('SELECT version FROM canvases WHERE id = ?').get(batch.canvas_id)?.version)
    if (!Number.isSafeInteger(version) || version !== Number(batch.canvas_version)) {
      throw dramaStateError('VERSION_CONFLICT', '画布版本已变化，请重新检查批次后确认。')
    }
    const snapshot = {
      batchId: batch.batch_id,
      canvasId: batch.canvas_id,
      canvasVersion: version,
      operation,
      jobId: jobId ?? null,
      jobs: jobs.map((job) => ({
        id: job.job_id,
        shotId: job.shot_id,
        keyframeRenderId: job.keyframe_render_id,
        canvasNodeId: job.canvas_node_id,
        durationSeconds: Number(job.duration_seconds),
        modelType: job.model_type,
        providerType: job.provider_type,
        providerId: job.provider_id,
        modelId: job.model_id,
        modelParams: JSON.parse(job.model_params_json),
        inputHash: job.input_hash,
        attempt: Number(job.attempt) + (operation === 'rerun' ? 1 : 0),
        taskIdempotencyKey: dramaRenderTaskIdempotencyKey(
          batch.batch_id, job.job_id, Number(job.attempt) + (operation === 'rerun' ? 1 : 0),
        ),
      })),
    }
    const contentHash = createHash('sha256').update(JSON.stringify(canonicalJson(snapshot))).digest('hex')
    return { snapshot, contentHash }
  }

  function publicDramaConfirmation(row, token, snapshot) {
    return {
      actionId: row.confirmation_id,
      token,
      expiresAt: row.expires_at,
      operation: row.operation,
      batchId: row.batch_id,
      canvasVersion: Number(row.canvas_version),
      contentHash: row.content_hash,
      jobs: snapshot.jobs.map((job) => ({
        id: job.id,
        shotId: job.shotId,
        canvasNodeId: job.canvasNodeId,
        keyframeRenderId: job.keyframeRenderId,
        durationSeconds: job.durationSeconds,
        providerType: job.providerType,
        providerId: job.providerId,
        modelId: job.modelId,
        prompt: job.modelParams.prompt,
      })),
    }
  }

  async function prepareDramaRenderConfirmation(database, batch, operation, jobId = null) {
    const { snapshot, contentHash } = renderBatchConfirmationSnapshot(database, batch, operation, jobId)
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    const confirmationId = randomUUID()
    const token = randomBytes(32).toString('hex')
    await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare(`
        UPDATE drama_render_confirmations SET status = 'invalidated', updated_at = ?
        WHERE batch_id = ? AND operation = ? AND status IN ('pending', 'accepted')
      `).run(now, batch.batch_id, operation)
      database.prepare(`
        INSERT INTO drama_render_confirmations (
          confirmation_id, canvas_id, batch_id, operation, job_id, content_hash, snapshot_json, token_hash,
          canvas_version, status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(confirmationId, batch.canvas_id, batch.batch_id, operation, jobId,
        contentHash, JSON.stringify(snapshot), createHash('sha256').update(token).digest('hex'), Number(batch.canvas_version),
        expiresAt, now, now)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    const row = database.prepare('SELECT * FROM drama_render_confirmations WHERE confirmation_id = ?').get(confirmationId)
    return publicDramaConfirmation(row, token, snapshot)
  }

  async function reconcileDramaRenderBatch(database, batchId) {
    const batch = database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ?').get(batchId)
    if (!batch) throw dramaStateError('NOT_FOUND', '渲染批次不存在。')
    const jobs = database.prepare('SELECT * FROM drama_render_jobs WHERE batch_id = ? ORDER BY created_at, job_id').all(batchId)
    const updates = []
    for (const job of jobs) {
      const stableKey = dramaRenderTaskIdempotencyKey(batchId, job.job_id, Number(job.attempt))
      const task = job.task_id
        ? database.prepare('SELECT * FROM tasks WHERE task_id = ? AND canvas_id = ?').get(job.task_id, batch.canvas_id)
        : database.prepare('SELECT * FROM tasks WHERE idempotency_key = ? AND canvas_id = ?').get(stableKey, batch.canvas_id)
      if (!task) continue
      let status = 'running'
      let errorCode = null
      if (task.status === 'succeeded') {
        try {
          const output = await resolveTaskOutputFile(path.join(active.directory, '.vibepaper'), task.task_id, 'video', task.output_path)
          if (output.sha256 !== task.output_sha256 || output.sizeBytes !== task.output_size_bytes) throw new Error('mismatch')
          status = 'completed'
        } catch {
          status = 'failed'
          errorCode = 'TASK_OUTPUT_UNAVAILABLE'
        }
      } else if (task.status === 'failed') {
        status = 'failed'
        errorCode = task.error_code || 'GENERATION_FAILED'
      } else if (task.status === 'cancelled') {
        status = 'failed'
        errorCode = 'TASK_CANCELLED'
      } else if (task.status === 'interrupted') {
        status = 'failed'
        errorCode = 'TASK_INTERRUPTED'
      }
      if (job.task_id !== task.task_id || job.status !== status || job.error_code !== errorCode) {
        updates.push({ jobId: job.job_id, taskId: task.task_id, status, errorCode })
      }
    }
    if (updates.length > 0) {
      const now = new Date().toISOString()
      database.exec('BEGIN IMMEDIATE')
      try {
        const update = database.prepare(`UPDATE drama_render_jobs SET task_id = ?, status = ?, error_code = ?, updated_at = ? WHERE job_id = ?`)
        for (const item of updates) update.run(item.taskId, item.status, item.errorCode, now, item.jobId)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    }
    const statuses = database.prepare('SELECT status FROM drama_render_jobs WHERE batch_id = ?').all(batchId).map((job) => job.status)
    const completed = statuses.filter((status) => status === 'completed').length
    const failed = statuses.filter((status) => status === 'failed').length
    const activeCount = statuses.filter((status) => status === 'running').length
    let batchStatus
    if (statuses.length > 0 && completed === statuses.length) batchStatus = 'completed'
    else if (statuses.length > 0 && failed === statuses.length) batchStatus = 'failed'
    else if (completed > 0 && failed > 0) batchStatus = 'partial'
    else if (activeCount > 0) batchStatus = 'running'
    else batchStatus = batch.status === 'draft' ? 'draft' : 'awaiting_approval'
    if (batch.status !== batchStatus) {
      database.prepare('UPDATE drama_render_batches SET status = ?, updated_at = ? WHERE batch_id = ?')
        .run(batchStatus, new Date().toISOString(), batchId)
    }
  }

  async function createDramaRenderBatch(input) {
    return enqueue(async () => {
      if (!isRecord(input)) throw dramaStateError('INVALID_INPUT', '渲染批次创建请求无效。')
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const idempotencyKey = requireDramaIdempotencyKey(input.idempotencyKey)
      const seriesId = normalizeCanvasEntityId(input.seriesId, '短剧系列')
      if (!Number.isSafeInteger(input.episodeNo) || input.episodeNo < 1
        || !Number.isSafeInteger(input.canvasVersion) || input.canvasVersion < 0
        || !Array.isArray(input.jobs) || input.jobs.length < 1 || input.jobs.length > 90) {
        throw dramaStateError('INVALID_INPUT', '渲染批次需包含 1-90 个镜头及有效版本。')
      }
      assertNoCredentialFields(input.jobs)
      const requestHash = createHash('sha256').update(JSON.stringify(canonicalJson({
        canvasId, seriesId, episodeNo: input.episodeNo, canvasVersion: input.canvasVersion, jobs: input.jobs,
      }))).digest('hex')
      const replay = database.prepare(`SELECT * FROM drama_render_batches WHERE canvas_id = ? AND idempotency_key = ?`)
        .get(canvasId, idempotencyKey)
      if (replay) {
        if (replay.request_hash && replay.request_hash !== requestHash) {
          throw dramaStateError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key 已用于不同的渲染批次内容。')
        }
        await reconcileDramaRenderBatch(database, replay.batch_id)
        return dramaRenderBatchPayload(database, database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ?').get(replay.batch_id))
      }
      const currentVersion = Number(database.prepare('SELECT version FROM canvases WHERE id = ?').get(canvasId)?.version)
      if (input.canvasVersion !== currentVersion) throw dramaStateError('VERSION_CONFLICT', '画布版本已变化，请重新读取后创建批次。')
      const series = requireDramaSeriesRow(database, canvasId, seriesId)
      const normalizedJobs = []
      const shotIds = new Set()
      for (const rawJob of input.jobs) {
        const job = await normalizeDramaRenderJob(database, canvasId, seriesId, input.episodeNo, rawJob)
        if (shotIds.has(job.shotId)) throw dramaStateError('DUPLICATE_SHOT', '同一批次不能重复包含同一镜头。')
        shotIds.add(job.shotId)
        normalizedJobs.push(job)
      }
      const batchId = randomUUID()
      const now = new Date().toISOString()
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        database.prepare(`INSERT INTO drama_render_batches (
          batch_id, canvas_id, series_id, episode_no, estimated_cost, status, idempotency_key,
          canvas_version, request_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 'awaiting_approval', ?, ?, ?, ?, ?)`)
          .run(batchId, canvasId, seriesId, input.episodeNo, idempotencyKey, currentVersion, requestHash, now, now)
        const insert = database.prepare(`INSERT INTO drama_render_jobs (
          job_id, batch_id, shot_id, keyframe_render_id, canvas_node_id, duration_seconds, model_type,
          provider_type, provider_id, model_id, model_params_json, estimated_cost, input_hash, status,
          task_id, error_code, attempt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'video', ?, ?, ?, ?, 0, ?, 'draft', NULL, NULL, 0, ?, ?)`)
        for (const job of normalizedJobs) {
          insert.run(randomUUID(), batchId, job.shotId, job.keyframeRenderId, job.canvasNodeId,
            job.durationSeconds, job.providerType, job.providerId, job.modelId,
            JSON.stringify(job.modelParams), job.inputHash, now, now)
        }
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        if (dramaStateUniqueConflict(error)) throw dramaStateError('IDEMPOTENCY_CONFLICT', '渲染批次已存在。')
        throw error
      }
      requireDramaSeriesRow(database, canvasId, series.id)
      return dramaRenderBatchPayload(database, database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ?').get(batchId))
    })
  }

  function prepareDramaRenderBatchConfirmation(input) {
    return enqueue(async () => {
      if (!isRecord(input)) throw dramaStateError('INVALID_INPUT', '渲染批次确认请求无效。')
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const batchId = normalizeCanvasEntityId(input.batchId, '渲染批次')
      await reconcileDramaRenderBatch(database, batchId)
      const batch = database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ? AND canvas_id = ?')
        .get(batchId, canvasId)
      if (!batch) throw dramaStateError('NOT_FOUND', '渲染批次不存在。')
      const operation = input.operation ?? 'submit'
      if (!['submit', 'rerun'].includes(operation)) throw dramaStateError('INVALID_INPUT', '确认操作无效。')
      const jobId = operation === 'rerun' ? normalizeCanvasEntityId(input.jobId, '渲染任务') : null
      const confirmation = await prepareDramaRenderConfirmation(database, batch, operation, jobId)
      return { batch: dramaRenderBatchPayload(database, batch), confirmation }
    })
  }

  function consumeDramaRenderBatchConfirmation(input) {
    return enqueue(async () => {
      if (!isRecord(input) || typeof input.actionId !== 'string' || !input.actionId
        || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/iu.test(input.token)) {
        throw dramaStateError('CONFIRMATION_REQUIRED', '请先查看并确认本批次的生成内容。')
      }
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const batchId = normalizeCanvasEntityId(input.batchId, '渲染批次')
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      await reconcileDramaRenderBatch(database, batchId)
      const batch = database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ? AND canvas_id = ?')
        .get(batchId, canvasId)
      const confirmation = database.prepare('SELECT * FROM drama_render_confirmations WHERE confirmation_id = ? AND batch_id = ? AND canvas_id = ?')
        .get(input.actionId, batchId, canvasId)
      if (!batch || !confirmation) throw dramaStateError('CONFIRMATION_REQUIRED', '找不到本地渲染确认记录，请重新检查批次。')
      if (confirmation.status === 'invalidated') {
        throw dramaStateError('CONFIRMATION_INVALIDATED', '此确认在应用重启后已失效，请重新查看生成内容并确认。')
      }
      if (confirmation.status === 'rejected') throw dramaStateError('CONFIRMATION_REJECTED', '此渲染确认已拒绝，请重新查看批次后再确认。')
      if (confirmation.status === 'expired'
        || (confirmation.status === 'pending' && Date.parse(confirmation.expires_at) <= Date.now())) {
        database.prepare("UPDATE drama_render_confirmations SET status = 'expired', updated_at = ? WHERE confirmation_id = ?")
          .run(new Date().toISOString(), confirmation.confirmation_id)
        throw dramaStateError('CONFIRMATION_EXPIRED', '渲染确认已过期，请重新检查批次。')
      }
      const suppliedHash = createHash('sha256').update(input.token).digest()
      const expectedHash = Buffer.from(confirmation.token_hash, 'hex')
      if (expectedHash.length !== suppliedHash.length || !timingSafeEqual(expectedHash, suppliedHash)) {
        throw dramaStateError('CONFIRMATION_INVALID', '渲染确认凭据无效。')
      }
      const currentVersion = Number(database.prepare('SELECT version FROM canvases WHERE id = ?').get(canvasId)?.version)
      if (input.canvasVersion !== currentVersion || currentVersion !== Number(confirmation.canvas_version)) {
        database.prepare("UPDATE drama_render_confirmations SET status = 'invalidated', updated_at = ? WHERE confirmation_id = ?")
          .run(new Date().toISOString(), confirmation.confirmation_id)
        throw dramaStateError('CONFIRMATION_SCOPE_CHANGED', '画布版本已变化，此确认不能提交，请重新检查批次。')
      }
      let snapshot
      try {
        snapshot = JSON.parse(confirmation.snapshot_json)
      } catch {
        throw dramaStateError('INVALID_STATE', '渲染确认记录损坏，请重新检查批次。')
      }
      const contentHash = createHash('sha256').update(JSON.stringify(canonicalJson(snapshot))).digest('hex')
      if (!isRecord(snapshot) || contentHash !== confirmation.content_hash
        || snapshot.batchId !== batchId || snapshot.canvasId !== canvasId
        || snapshot.canvasVersion !== currentVersion || snapshot.operation !== confirmation.operation
        || snapshot.jobId !== (confirmation.job_id ?? null) || !Array.isArray(snapshot.jobs)) {
        database.prepare("UPDATE drama_render_confirmations SET status = 'invalidated', updated_at = ? WHERE confirmation_id = ?")
          .run(new Date().toISOString(), confirmation.confirmation_id)
        throw dramaStateError('CONFIRMATION_SCOPE_CHANGED', '确认内容与本地记录不匹配，请重新检查批次。')
      }
      if (confirmation.status === 'pending') {
        const current = renderBatchConfirmationSnapshot(database, batch, confirmation.operation, confirmation.job_id)
        if (current.contentHash !== confirmation.content_hash) {
          database.prepare("UPDATE drama_render_confirmations SET status = 'invalidated', updated_at = ? WHERE confirmation_id = ?")
            .run(new Date().toISOString(), confirmation.confirmation_id)
          throw dramaStateError('CONFIRMATION_SCOPE_CHANGED', '批次内容已变化，此确认不能提交，请重新检查批次。')
        }
        database.exec('BEGIN IMMEDIATE')
        try {
          if (confirmation.operation === 'rerun') {
            const target = snapshot.jobs[0]
            const updated = database.prepare(`UPDATE drama_render_jobs
              SET status = 'draft', task_id = NULL, error_code = NULL, attempt = ?, updated_at = ?
              WHERE batch_id = ? AND job_id = ? AND status = 'failed' AND attempt = ?`)
              .run(target.attempt, new Date().toISOString(), batchId, target.id, target.attempt - 1)
            if (updated.changes !== 1) throw dramaStateError('CONFIRMATION_SCOPE_CHANGED', '失败任务状态已变化，请重新检查批次。')
            database.prepare(`UPDATE drama_render_batches SET status = 'awaiting_approval', approval_action_id = NULL,
              updated_at = ? WHERE batch_id = ?`).run(new Date().toISOString(), batchId)
          }
          database.prepare("UPDATE drama_render_confirmations SET status = 'accepted', updated_at = ? WHERE confirmation_id = ? AND status = 'pending'")
            .run(new Date().toISOString(), confirmation.confirmation_id)
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      }
      return {
        batch: dramaRenderBatchPayload(database,
          database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ?').get(batchId)),
        jobs: snapshot.jobs,
        confirmation: {
          actionId: confirmation.confirmation_id,
          operation: confirmation.operation,
          canvasVersion: currentVersion,
          contentHash,
        },
      }
    })
  }

  function rejectDramaRenderBatchConfirmation(input) {
    return enqueue(async () => {
      if (!isRecord(input) || typeof input.actionId !== 'string' || !input.actionId
        || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/iu.test(input.token)) {
        throw dramaStateError('CONFIRMATION_REQUIRED', '渲染确认请求无效。')
      }
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const batchId = normalizeCanvasEntityId(input.batchId, '渲染批次')
      const confirmation = database.prepare('SELECT * FROM drama_render_confirmations WHERE confirmation_id = ? AND batch_id = ? AND canvas_id = ?')
        .get(input.actionId, batchId, canvasId)
      if (!confirmation) throw dramaStateError('CONFIRMATION_REQUIRED', '找不到本地渲染确认记录。')
      const suppliedHash = createHash('sha256').update(input.token).digest()
      const expectedHash = Buffer.from(confirmation.token_hash, 'hex')
      if (expectedHash.length !== suppliedHash.length || !timingSafeEqual(expectedHash, suppliedHash)) {
        throw dramaStateError('CONFIRMATION_INVALID', '渲染确认凭据无效。')
      }
      if (confirmation.status === 'rejected') return { rejected: true }
      if (confirmation.status === 'accepted') {
        throw dramaStateError('CONFIRMATION_ALREADY_CONSUMED', '此确认已经消费，不能再拒绝。')
      }
      if (confirmation.status === 'invalidated') {
        throw dramaStateError('CONFIRMATION_INVALIDATED', '此确认已失效，不能再更改状态。')
      }
      if (confirmation.status === 'expired' || Date.parse(confirmation.expires_at) <= Date.now()) {
        if (confirmation.status === 'pending') {
          database.prepare("UPDATE drama_render_confirmations SET status = 'expired', updated_at = ? WHERE confirmation_id = ? AND status = 'pending'")
            .run(new Date().toISOString(), confirmation.confirmation_id)
        }
        throw dramaStateError('CONFIRMATION_EXPIRED', '渲染确认已过期，请重新检查批次。')
      }
      if (confirmation.status !== 'pending') throw dramaStateError('CONFIRMATION_INVALID', '渲染确认状态无效。')
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      const rejected = database.prepare("UPDATE drama_render_confirmations SET status = 'rejected', updated_at = ? WHERE confirmation_id = ? AND status = 'pending'")
        .run(new Date().toISOString(), confirmation.confirmation_id)
      if (rejected.changes !== 1) throw dramaStateError('CONFIRMATION_INVALID', '渲染确认状态已变化，请重新检查批次。')
      return { rejected: true }
    })
  }

  function rerunDramaRenderBatchJob(input) {
    return enqueue(async () => {
      if (!isRecord(input)) throw dramaStateError('INVALID_INPUT', '局部重跑请求无效。')
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const batchId = normalizeCanvasEntityId(input.batchId, '渲染批次')
      const jobId = normalizeCanvasEntityId(input.jobId, '渲染任务')
      await reconcileDramaRenderBatch(database, batchId)
      const batch = database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ? AND canvas_id = ?')
        .get(batchId, canvasId)
      const job = database.prepare('SELECT * FROM drama_render_jobs WHERE batch_id = ? AND job_id = ?')
        .get(batchId, jobId)
      if (!batch || !job) throw dramaStateError('NOT_FOUND', '渲染批次或任务不存在。')
      if (job.status !== 'failed') throw dramaStateError('JOB_NOT_FAILED', '只有失败的镜头任务可以局部重跑。')
      if (Number(job.attempt) >= 20) throw dramaStateError('RERUN_LIMIT_REACHED', '该镜头已达到局部重跑次数上限。')
      const confirmation = await prepareDramaRenderConfirmation(database, batch, 'rerun', jobId)
      return { batch: dramaRenderBatchPayload(database, batch), confirmation }
    })
  }

  function markDramaRenderBatchTask(input) {
    return enqueue(async () => {
      if (!isRecord(input)) throw dramaStateError('INVALID_INPUT', '批次任务关联请求无效。')
      const { database, canvasId } = requireDramaScope(input.projectId, input.canvasId)
      const batchId = normalizeCanvasEntityId(input.batchId, '渲染批次')
      const jobId = normalizeCanvasEntityId(input.jobId, '渲染任务')
      const taskId = normalizeCanvasEntityId(input.taskId, '本地生成任务')
      const job = database.prepare('SELECT * FROM drama_render_jobs WHERE batch_id = ? AND job_id = ?')
        .get(batchId, jobId)
      const task = database.prepare('SELECT * FROM tasks WHERE task_id = ? AND canvas_id = ?')
        .get(taskId, canvasId)
      if (!job || !task) throw dramaStateError('NOT_FOUND', '批次任务或本地任务不存在。')
      const expectedIdempotencyKey = dramaRenderTaskIdempotencyKey(batchId, jobId, Number(job.attempt))
      if (task.idempotency_key !== expectedIdempotencyKey || task.node_id !== job.canvas_node_id
        || task.modality !== 'video' || task.provider_type !== job.provider_type
        || task.provider_id !== job.provider_id || task.model_id !== job.model_id) {
        throw dramaStateError('TASK_ASSOCIATION_MISMATCH', '本地任务与已确认的批次镜头不匹配。')
      }
      database.prepare('UPDATE drama_render_jobs SET task_id = ?, updated_at = ? WHERE batch_id = ? AND job_id = ?')
        .run(taskId, new Date().toISOString(), batchId, jobId)
      await reconcileDramaRenderBatch(database, batchId)
      return dramaRenderBatchPayload(database, database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ?').get(batchId))
    })
  }

  function markDramaRenderBatchJobFailure(input) {
    return enqueue(async () => {
      if (!isRecord(input) || typeof input.errorCode !== 'string' || !/^[A-Z0-9_]{1,120}$/u.test(input.errorCode)) {
        throw dramaStateError('INVALID_INPUT', '批次任务失败信息无效。')
      }
      const { database } = requireDramaScope(input.projectId, input.canvasId)
      const batchId = normalizeCanvasEntityId(input.batchId, '渲染批次')
      const jobId = normalizeCanvasEntityId(input.jobId, '渲染任务')
      database.prepare(`UPDATE drama_render_jobs SET status = 'failed', error_code = ?, updated_at = ?
        WHERE batch_id = ? AND job_id = ? AND status = 'draft'`)
        .run(input.errorCode, new Date().toISOString(), batchId, jobId)
      await reconcileDramaRenderBatch(database, batchId)
      return dramaRenderBatchPayload(database, database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ?').get(batchId))
    })
  }

  function listDramaRenderBatches(projectId, canvasId) {
    return enqueue(async () => {
      const { database } = requireDramaScope(projectId, canvasId)
      const rows = database.prepare(`
        SELECT * FROM drama_render_batches WHERE canvas_id = ?
        ORDER BY created_at DESC, batch_id DESC
      `).all(canvasId)
      for (const row of rows) await reconcileDramaRenderBatch(database, row.batch_id)
      return { items: rows.map((row) => dramaRenderBatchPayload(database,
        database.prepare('SELECT * FROM drama_render_batches WHERE batch_id = ?').get(row.batch_id))) }
    })
  }

  function getDramaRenderBatch(projectId, canvasId, batchId) {
    return enqueue(async () => {
      const { database } = requireDramaScope(projectId, canvasId)
      const id = normalizeCanvasEntityId(batchId, '渲染批次')
      await reconcileDramaRenderBatch(database, id)
      const row = database.prepare('SELECT * FROM drama_render_batches WHERE canvas_id = ? AND batch_id = ?')
        .get(canvasId, id)
      if (!row) throw dramaStateError('NOT_FOUND', '渲染批次不存在。')
      return dramaRenderBatchPayload(database, row)
    })
  }

  function listRenderReviews(projectId, canvasId, targetNodeId) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId || canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，请重新打开画布。')
      }
      const target = targetNodeId == null || targetNodeId === ''
        ? null
        : normalizeCanvasEntityId(targetNodeId, '审校目标节点')
      const rows = active.database.prepare(`
        SELECT * FROM render_reviews
        WHERE canvas_id = ? AND (? IS NULL OR target_node_id = ?)
        ORDER BY created_at DESC, rowid DESC
      `).all(canvasId, target, target)
      return { items: rows.map((row) => renderReviewPayload(row, active.metadata.projectId)) }
    })
  }

  function createRenderReview(input) {
    return enqueue(() => {
      if (!isRecord(input)
        || typeof input.projectId !== 'string' || typeof input.canvasId !== 'string'
        || input.projectId !== active?.metadata.projectId || input.canvasId !== active?.metadata.canvasId) {
        throw new Error('当前项目已更改，请重新打开画布。')
      }
      if (input.canvasVersion !== undefined) {
        if (!Number.isSafeInteger(input.canvasVersion) || input.canvasVersion < 0) {
          throw new Error('AGENT_CANVAS_VERSION_INVALID')
        }
        const currentVersion = Number(active.database.prepare('SELECT version FROM canvases WHERE id = ?')
          .get(input.canvasId)?.version)
        if (currentVersion !== input.canvasVersion) throw new Error('AGENT_CANVAS_CHANGED')
      }
      const targetNodeId = normalizeCanvasEntityId(input.targetNodeId, '审校目标节点')
      const targetNode = active.database.prepare(`
        SELECT id FROM nodes WHERE canvas_id = ? AND id = ?
      `).get(input.canvasId, targetNodeId)
      if (!targetNode) throw new Error('审校目标节点不存在。')
      const shotDurationSeconds = requiredDramaInteger(input.shotDurationSeconds, 'shotDurationSeconds')
      const expectedDurationSeconds = requiredDramaInteger(input.expectedDurationSeconds, 'expectedDurationSeconds')
      const audioDurationMs = requiredDramaInteger(input.audioDurationMs, 'audioDurationMs')
      const videoDurationMs = requiredDramaInteger(input.videoDurationMs, 'videoDurationMs')
      if (typeof input.characterConsistent !== 'boolean') throw new Error('characterConsistent 必须是布尔值。')
      const previousCamera = requiredDramaText(input.previousCamera, 'previousCamera')
      const currentCamera = requiredDramaText(input.currentCamera, 'currentCamera')
      const retryCount = input.retryCount == null ? 0 : requiredDramaInteger(input.retryCount, 'retryCount')
      if (retryCount < 0) throw new Error('retryCount 不能小于 0。')
      const targetKind = input.targetKind == null ? 'clip' : requiredDramaText(input.targetKind, 'targetKind')
      const findings = []
      if (shotDurationSeconds !== expectedDurationSeconds) findings.push({
        ruleId: 'SHOT_DURATION', severity: 'error', evidence: `${shotDurationSeconds} != ${expectedDurationSeconds}`,
      })
      if (!input.characterConsistent) findings.push({
        ruleId: 'CHARACTER_CONTINUITY', severity: 'error', evidence: 'character identity anchors differ',
      })
      if (Math.abs(audioDurationMs - videoDurationMs) > 100) findings.push({
        ruleId: 'AUDIO_VIDEO_SYNC', severity: 'error', evidence: `${audioDurationMs}ms vs ${videoDurationMs}ms`,
      })
      const verdict = findings.some((finding) => finding.severity === 'error') ? 'fail' : 'pass'
      const ruleVersion = 'continuity-v1'
      const recommendation = verdict === 'pass' ? 'accept' : 'fix_and_retry'
      const id = randomUUID()
      const now = new Date().toISOString()
      const latestTask = active.database.prepare(`
        SELECT task_id FROM tasks WHERE canvas_id = ? AND node_id = ? AND modality = 'video'
        ORDER BY created_at DESC, task_id DESC LIMIT 1
      `).get(input.canvasId, targetNodeId)
      const auditInput = {
        shotDurationSeconds,
        expectedDurationSeconds,
        characterConsistent: input.characterConsistent,
        audioDurationMs,
        videoDurationMs,
        previousCamera,
        currentCamera,
      }
      const scores = { verdict, ruleVersion }
      const evidence = {
        ruleVersion,
        ownerId: input.projectId,
        input: auditInput,
        ...(latestTask ? { sourceTaskId: latestTask.task_id } : {}),
      }
      active.database.prepare(`
        INSERT INTO render_reviews (
          review_id, canvas_id, target_node_id, target_kind, scores_json, failures_json,
          recommended_action, evidence_json, retry_count, status, source_task_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.canvasId, targetNodeId, targetKind, JSON.stringify(scores), JSON.stringify(findings),
        recommendation, JSON.stringify(evidence), retryCount, verdict, latestTask?.task_id ?? null, now)
      return {
        id,
        ownerId: input.projectId,
        verdict,
        findings,
        ruleVersion,
        ...(latestTask ? { sourceTaskId: latestTask.task_id } : {}),
      }
    })
  }

  function loadCanvas(projectId, canvasId) {
    if (!active || projectId !== active.metadata.projectId || canvasId !== active.metadata.canvasId) {
      throw new Error('当前项目已更改，请重新打开画布。')
    }
    return JSON.parse(JSON.stringify(active.canvas))
  }

  function exportCanvas(projectId, canvasId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId || canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，请重新打开画布。')
      }
      const canvas = readDatabaseCanvas(active.database, active.metadata)
      const updatedAt = active.database.prepare('SELECT updated_at FROM canvases WHERE id = ?')
        .get(active.metadata.canvasId)?.updated_at ?? null
      const document = {
        schema_version: CANVAS_EXPORT_SCHEMA_VERSION,
        schemaVersion: CANVAS_EXPORT_SCHEMA_VERSION,
        canvas: {
          id: canvas.canvasId,
          name: active.metadata.name,
          description: null,
          schemaVersion: CANVAS_EXPORT_SCHEMA_VERSION,
          version: canvas.version,
          createdAt: active.metadata.createdAt,
          updatedAt,
        },
        nodes: canvas.nodes.map(canvasNodeExportPayload),
        edges: canvas.edges.map(canvasEdgeExportPayload),
        groups: canvas.groups,
        stacks: canvas.stacks,
      }
      return JSON.parse(JSON.stringify(document))
    })
  }

  function createNode(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const idempotencyKey = input.idempotencyKey
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
        throw new Error('Idempotency-Key 必须为 1-128 个字符。')
      }
      const request = normalizeCreateNodeInput(input)
      const database = active.database
      database.exec('BEGIN IMMEDIATE')
      try {
        let command = database.prepare(`
          SELECT operation, result_canvas_version, result_snapshot
          FROM canvas_graph_commands WHERE canvas_id = ? AND idempotency_key = ?
        `).get(active.metadata.canvasId, idempotencyKey)
        if (command && command.operation !== 'create_nodes') {
          throw new Error('Idempotency-Key 已用于其他画布命令。')
        }
        if (command && command.result_snapshot !== '{}') {
          let payload
          try {
            payload = JSON.parse(command.result_snapshot)
            if (!isRecord(payload) || typeof payload.id !== 'string' || typeof payload.type !== 'string'
              || !isRecord(payload.params)) throw new Error('invalid node snapshot')
          } catch {
            throw new Error('画布命令结果快照损坏。')
          }
          const localAsset = Object.hasOwn(ASSET_NODE_MIME_PREFIX, payload.type) && typeof payload.params.assetId === 'string'
            ? database.prepare('SELECT id FROM assets WHERE id = ?').get(payload.params.assetId)?.id
            : undefined
          const node = flowNodeFromPayload(payload, localAsset)
          database.exec('COMMIT')
          return {
            node: JSON.parse(JSON.stringify(node)),
            version: active.canvas.version,
            replayed: true,
          }
        }

        if (!command) {
          database.prepare(`
            INSERT INTO canvas_graph_commands (canvas_id, idempotency_key, operation, created_at)
            VALUES (?, ?, 'create_nodes', ?)
          `).run(active.metadata.canvasId, idempotencyKey, new Date().toISOString())
        }

        const canvasRow = database.prepare('SELECT version FROM canvases WHERE id = ?')
          .get(active.metadata.canvasId)
        if (!canvasRow || canvasRow.version !== active.canvas.version
          || (request.expectedVersion !== null && request.expectedVersion !== canvasRow.version)) {
          throw new Error('画布已在其他会话更新，请刷新。')
        }
        if (!Object.hasOwn(EDGE_COMPATIBLE_TARGET_TYPES, request.type)) {
          throw new Error(`非法节点类型: ${request.type}`)
        }

        const nodeId = randomUUID()
        const payload = {
          id: nodeId,
          type: request.type,
          x: request.x,
          y: request.y,
          width: request.width,
          height: request.height,
          params: request.params,
          status: 'idle',
          currentOutputId: null,
          groupId: null,
          stackId: null,
          creativeType: request.creativeType,
          stale: false,
          modelRef: request.modelRef,
          prompt: request.prompt,
          output: null,
          execStatus: 'idle',
        }
        const localAssetId = Object.hasOwn(ASSET_NODE_MIME_PREFIX, payload.type) && typeof payload.params.assetId === 'string'
          ? database.prepare('SELECT id FROM assets WHERE id = ?').get(payload.params.assetId)?.id
          : undefined
        const node = flowNodeFromPayload(payload, localAssetId)
        const graph = validateGraph([...active.canvas.nodes, node], active.canvas.edges)
        const persistedNode = graph.nodes[graph.nodes.length - 1]
        const nextVersion = canvasRow.version + 1
        if (!Number.isSafeInteger(nextVersion)) throw new Error('画布版本已达到本地上限。')

        await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
        database.prepare(`
          INSERT INTO nodes (canvas_id, id, position_x, position_y, payload_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(active.metadata.canvasId, persistedNode.id, persistedNode.position.x, persistedNode.position.y, JSON.stringify(persistedNode))
        insertAssetReferences(database, active.metadata.canvasId, { nodes: [persistedNode] })
        const updated = database.prepare(`
          UPDATE canvases SET version = ?, updated_at = ? WHERE id = ? AND version = ?
        `).run(nextVersion, new Date().toISOString(), active.metadata.canvasId, canvasRow.version)
        if (updated.changes !== 1) throw new Error('画布已在其他会话更新，请刷新。')
        database.prepare(`
          UPDATE canvas_graph_commands
          SET operation = 'create_nodes', result_canvas_version = ?, result_snapshot = ?
          WHERE canvas_id = ? AND idempotency_key = ?
        `).run(nextVersion, JSON.stringify(payload), active.metadata.canvasId, idempotencyKey)
        database.exec('COMMIT')

        active.canvas = {
          ...active.canvas,
          version: nextVersion,
          nodes: graph.nodes,
          edges: graph.edges,
        }
        return {
          node: JSON.parse(JSON.stringify(persistedNode)),
          version: nextVersion,
          replayed: false,
        }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function updateNode(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      if (typeof input.nodeId !== 'string' || !input.nodeId || input.nodeId.length > 256) {
        throw new Error('节点标识无效。')
      }
      const idempotencyKey = input.idempotencyKey
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
        throw new Error('Idempotency-Key 必须为 1-128 个字符。')
      }
      const request = normalizeUpdateNodeInput(input)
      const database = active.database
      database.exec('BEGIN IMMEDIATE')
      try {
        const command = database.prepare(`
          SELECT operation, result_snapshot
          FROM canvas_graph_commands WHERE canvas_id = ? AND idempotency_key = ?
        `).get(active.metadata.canvasId, idempotencyKey)
        if (command && command.operation !== 'update_node_config') {
          throw new Error('Idempotency-Key 已用于其他画布命令。')
        }
        if (command && command.result_snapshot !== '{}') {
          let node
          try {
            node = JSON.parse(command.result_snapshot)
            if (!isRecord(node) || typeof node.id !== 'string' || typeof node.type !== 'string'
              || !isRecord(node.position) || !isRecord(node.data)) throw new Error('invalid node snapshot')
          } catch {
            throw new Error('画布命令结果快照损坏。')
          }
          database.exec('COMMIT')
          return {
            node: JSON.parse(JSON.stringify(node)),
            version: active.canvas.version,
            replayed: true,
          }
        }

        if (!command) {
          database.prepare(`
            INSERT INTO canvas_graph_commands (canvas_id, idempotency_key, operation, created_at)
            VALUES (?, ?, 'update_node_config', ?)
          `).run(active.metadata.canvasId, idempotencyKey, new Date().toISOString())
        }

        const canvasRow = database.prepare('SELECT version FROM canvases WHERE id = ?')
          .get(active.metadata.canvasId)
        if (!canvasRow || canvasRow.version !== active.canvas.version
          || (request.expectedVersion !== null && request.expectedVersion !== canvasRow.version)) {
          throw new Error('画布已在其他会话更新，请刷新。')
        }
        const storedNode = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
          .get(active.metadata.canvasId, input.nodeId)
        const currentNode = active.canvas.nodes.find((node) => node.id === input.nodeId)
        if (!storedNode || !currentNode) throw new Error('节点不存在。')

        const { node: updatedNode, contentChanged } = applyUpdateNodeRequest(currentNode, request)
        const candidateNodes = active.canvas.nodes.map((node) => node.id === input.nodeId ? updatedNode : node)
        const staleResult = contentChanged
          ? markDownstreamNodesStale(candidateNodes, active.canvas.edges, input.nodeId)
          : { nodes: candidateNodes, staleNodeIds: new Set() }
        const graph = validateGraph(staleResult.nodes, active.canvas.edges)
        const resultNode = graph.nodes.find((node) => node.id === input.nodeId)
        const nextVersion = canvasRow.version + 1
        if (!Number.isSafeInteger(nextVersion)) throw new Error('画布版本已达到本地上限。')

        await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
        const updateNodeRow = database.prepare(`
          UPDATE nodes SET position_x = ?, position_y = ?, payload_json = ?
          WHERE canvas_id = ? AND id = ?
        `)
        const changedNodeIds = new Set([input.nodeId, ...staleResult.staleNodeIds])
        for (const nodeId of changedNodeIds) {
          const node = graph.nodes.find((entry) => entry.id === nodeId)
          if (!node) continue
          updateNodeRow.run(node.position.x, node.position.y, JSON.stringify(node), active.metadata.canvasId, nodeId)
        }
        database.prepare('DELETE FROM asset_references WHERE canvas_id = ? AND node_id = ?')
          .run(active.metadata.canvasId, input.nodeId)
        insertAssetReferences(database, active.metadata.canvasId, { nodes: [resultNode] })
        const updatedCanvas = database.prepare(`
          UPDATE canvases SET version = ?, updated_at = ? WHERE id = ? AND version = ?
        `).run(nextVersion, new Date().toISOString(), active.metadata.canvasId, canvasRow.version)
        if (updatedCanvas.changes !== 1) throw new Error('画布已在其他会话更新，请刷新。')
        database.prepare(`
          UPDATE canvas_graph_commands
          SET operation = 'update_node_config', result_canvas_version = ?, result_snapshot = ?
          WHERE canvas_id = ? AND idempotency_key = ?
        `).run(nextVersion, JSON.stringify(resultNode), active.metadata.canvasId, idempotencyKey)
        database.exec('COMMIT')

        active.canvas = { ...active.canvas, version: nextVersion, nodes: graph.nodes, edges: graph.edges }
        return {
          node: JSON.parse(JSON.stringify(resultNode)),
          version: nextVersion,
          replayed: false,
        }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function deleteNode(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      if (typeof input.nodeId !== 'string' || !input.nodeId || input.nodeId.length > 256) {
        throw new Error('节点标识无效。')
      }
      const idempotencyKey = input.idempotencyKey
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
        throw new Error('Idempotency-Key 必须为 1-128 个字符。')
      }
      const expectedVersion = input.expectedVersion ?? null
      if (expectedVersion !== null
        && (!Number.isInteger(expectedVersion) || expectedVersion < -2_147_483_648 || expectedVersion > 2_147_483_647)) {
        throw new Error('画布版本无效，请重新打开项目。')
      }

      const database = active.database
      database.exec('BEGIN IMMEDIATE')
      try {
        const command = database.prepare(`
          SELECT operation, result_snapshot
          FROM canvas_graph_commands WHERE canvas_id = ? AND idempotency_key = ?
        `).get(active.metadata.canvasId, idempotencyKey)
        if (command && command.operation !== 'delete_nodes') {
          throw new Error('Idempotency-Key 已用于其他画布命令。')
        }
        if (command && command.result_snapshot !== '{}') {
          let impact
          try {
            impact = JSON.parse(command.result_snapshot)
            if (!isRecord(impact) || typeof impact.deletedNodeId !== 'string'
              || !Array.isArray(impact.connectedEdges) || !impact.connectedEdges.every((id) => typeof id === 'string')
              || !Array.isArray(impact.downstreamNodes)
              || !impact.downstreamNodes.every((node) => isRecord(node)
                && typeof node.id === 'string' && typeof node.type === 'string' && typeof node.name === 'string')) {
              throw new Error('invalid delete snapshot')
            }
          } catch {
            throw new Error('画布命令结果快照损坏。')
          }
          database.exec('COMMIT')
          return JSON.parse(JSON.stringify(impact))
        }

        if (!command) {
          database.prepare(`
            INSERT INTO canvas_graph_commands (canvas_id, idempotency_key, operation, created_at)
            VALUES (?, ?, 'delete_nodes', ?)
          `).run(active.metadata.canvasId, idempotencyKey, new Date().toISOString())
        }

        const canvasRow = database.prepare('SELECT version FROM canvases WHERE id = ?')
          .get(active.metadata.canvasId)
        if (!canvasRow || canvasRow.version !== active.canvas.version
          || (expectedVersion !== null && expectedVersion !== canvasRow.version)) {
          throw new Error('画布已在其他会话更新，请刷新。')
        }
        const storedNode = database.prepare('SELECT id FROM nodes WHERE canvas_id = ? AND id = ?')
          .get(active.metadata.canvasId, input.nodeId)
        if (!storedNode || !active.canvas.nodes.some((node) => node.id === input.nodeId)) {
          throw new Error('节点不存在。')
        }

        const connectedEdges = database.prepare(`
          SELECT id, source_node_id, target_node_id
          FROM edges
          WHERE canvas_id = ? AND (source_node_id = ? OR target_node_id = ?)
          ORDER BY rowid
        `).all(active.metadata.canvasId, input.nodeId, input.nodeId)
        const downstreamIds = new Set(connectedEdges
          .filter((edge) => edge.source_node_id === input.nodeId)
          .map((edge) => edge.target_node_id))
        const downstreamRows = downstreamIds.size === 0
          ? []
          : database.prepare(`
            SELECT id, payload_json FROM nodes
            WHERE canvas_id = ? AND id IN (${Array.from(downstreamIds, () => '?').join(', ')})
            ORDER BY rowid
          `).all(active.metadata.canvasId, ...downstreamIds)
        const legacyNodeNames = {
          text: '文本节点',
          image: '图片节点',
          video: '视频节点',
          audio: '音频节点',
          compose: '合成节点',
          director: '导演台节点',
        }
        const impact = {
          connectedEdges: connectedEdges.map((edge) => edge.id),
          downstreamNodes: downstreamRows.map((row) => {
            const payload = JSON.parse(row.payload_json)
            return {
              id: row.id,
              type: payload.type,
              name: Object.hasOwn(legacyNodeNames, payload.type) ? legacyNodeNames[payload.type] : '节点',
            }
          }),
          deletedNodeId: input.nodeId,
        }
        const nextVersion = canvasRow.version + 1
        if (!Number.isSafeInteger(nextVersion)) throw new Error('画布版本已达到本地上限。')

        await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
        const deleteEdge = database.prepare('DELETE FROM edges WHERE canvas_id = ? AND id = ?')
        for (const edge of connectedEdges) deleteEdge.run(active.metadata.canvasId, edge.id)
        const deleted = database.prepare('DELETE FROM nodes WHERE canvas_id = ? AND id = ?')
          .run(active.metadata.canvasId, input.nodeId)
        if (deleted.changes !== 1) throw new Error('节点不存在。')
        const updatedCanvas = database.prepare(`
          UPDATE canvases SET version = ?, updated_at = ? WHERE id = ? AND version = ?
        `).run(nextVersion, new Date().toISOString(), active.metadata.canvasId, canvasRow.version)
        if (updatedCanvas.changes !== 1) throw new Error('画布已在其他会话更新，请刷新。')
        database.prepare(`
          UPDATE canvas_graph_commands
          SET operation = 'delete_nodes', result_canvas_version = ?, result_snapshot = ?
          WHERE canvas_id = ? AND idempotency_key = ?
        `).run(nextVersion, JSON.stringify(impact), active.metadata.canvasId, idempotencyKey)
        database.exec('COMMIT')

        active.canvas = {
          ...active.canvas,
          version: nextVersion,
          nodes: active.canvas.nodes.filter((node) => node.id !== input.nodeId),
          edges: active.canvas.edges.filter((edge) => edge.source !== input.nodeId && edge.target !== input.nodeId),
        }
        return JSON.parse(JSON.stringify(impact))
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function connectEdge(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const sourceNodeId = input.sourceNodeId
      const targetNodeId = input.targetNodeId
      if (typeof sourceNodeId !== 'string' || !sourceNodeId
        || typeof targetNodeId !== 'string' || !targetNodeId) {
        throw new Error('连线节点标识无效。')
      }
      const hasIdempotencyKey = input.idempotencyKey !== undefined && input.idempotencyKey !== null
      const idempotencyKey = hasIdempotencyKey ? input.idempotencyKey : null
      if (hasIdempotencyKey
        && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128)) {
        throw new Error('Idempotency-Key 必须为 1-128 个字符。')
      }
      const expectedVersion = input.expectedVersion ?? null
      if (expectedVersion !== null
        && (!Number.isInteger(expectedVersion) || expectedVersion < -2_147_483_648 || expectedVersion > 2_147_483_647)) {
        throw new Error('画布版本无效，请重新打开项目后再连接。')
      }

      const database = active.database
      database.exec('BEGIN IMMEDIATE')
      try {
        const command = hasIdempotencyKey
          ? database.prepare(`
            SELECT operation, result_snapshot
            FROM canvas_graph_commands WHERE canvas_id = ? AND idempotency_key = ?
          `).get(active.metadata.canvasId, idempotencyKey)
          : undefined
        if (command && command.operation !== 'connect_nodes') {
          throw new Error('Idempotency-Key 已用于其他画布命令。')
        }
        if (command && command.result_snapshot !== '{}') {
          let edge
          try {
            edge = JSON.parse(command.result_snapshot)
            if (!isRecord(edge) || typeof edge.id !== 'string'
              || typeof edge.sourceNodeId !== 'string' || typeof edge.sourcePort !== 'string'
              || typeof edge.targetNodeId !== 'string' || typeof edge.targetPort !== 'string'
              || typeof edge.valid !== 'boolean' || typeof edge.dependencyType !== 'string') {
              throw new Error('invalid edge snapshot')
            }
          } catch {
            throw new Error('画布命令结果快照损坏。')
          }
          database.exec('COMMIT')
          return {
            edge: JSON.parse(JSON.stringify(edge)),
            version: active.canvas.version,
            replayed: true,
          }
        }

        if (hasIdempotencyKey && !command) {
          database.prepare(`
            INSERT INTO canvas_graph_commands (canvas_id, idempotency_key, operation, created_at)
            VALUES (?, ?, 'connect_nodes', ?)
          `).run(active.metadata.canvasId, idempotencyKey, new Date().toISOString())
        }

        if (sourceNodeId === targetNodeId) throw new Error('禁止自连接')
        const existingRow = database.prepare(`
          SELECT payload_json FROM edges
          WHERE canvas_id = ? AND source_node_id = ? AND target_node_id = ?
          ORDER BY rowid LIMIT 1
        `).get(active.metadata.canvasId, sourceNodeId, targetNodeId)
        if (existingRow) {
          const existingEdge = active.canvas.edges.find((edge) => edge.source === sourceNodeId && edge.target === targetNodeId)
            ?? JSON.parse(existingRow.payload_json)
          const existingPayload = existingEdge.data?.edge ?? {
            id: existingEdge.id,
            sourceNodeId: existingEdge.source,
            sourcePort: existingEdge.sourceHandle ?? 'output',
            targetNodeId: existingEdge.target,
            targetPort: existingEdge.targetHandle ?? 'input',
            valid: existingEdge.data?.valid ?? true,
            dependencyType: existingEdge.dependencyType ?? 'reference',
          }
          const canvasRow = database.prepare('SELECT version FROM canvases WHERE id = ?')
            .get(active.metadata.canvasId)
          if (!canvasRow) throw new Error('画布不存在。')
          if (hasIdempotencyKey) {
            database.prepare(`
              UPDATE canvas_graph_commands
              SET operation = 'connect_nodes', result_canvas_version = ?, result_snapshot = ?
              WHERE canvas_id = ? AND idempotency_key = ?
            `).run(canvasRow.version, JSON.stringify(existingPayload), active.metadata.canvasId, idempotencyKey)
          }
          database.exec('COMMIT')
          return {
            edge: JSON.parse(JSON.stringify(existingPayload)),
            version: active.canvas.version,
            replayed: true,
          }
        }

        const canvasRow = database.prepare('SELECT version FROM canvases WHERE id = ?')
          .get(active.metadata.canvasId)
        if (!canvasRow || canvasRow.version !== active.canvas.version
          || (expectedVersion !== null && expectedVersion !== canvasRow.version)) {
          throw new Error('画布已在其他会话更新，请刷新。')
        }

        const sourceRow = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
          .get(active.metadata.canvasId, sourceNodeId)
        const targetRow = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
          .get(active.metadata.canvasId, targetNodeId)
        if (!sourceRow || !targetRow) throw new Error('节点不存在')
        const sourceNode = JSON.parse(sourceRow.payload_json)
        const targetNode = JSON.parse(targetRow.payload_json)
        if (!Object.hasOwn(EDGE_COMPATIBLE_TARGET_TYPES, sourceNode.type)
          || !EDGE_COMPATIBLE_TARGET_TYPES[sourceNode.type].has(targetNode.type)) {
          throw new Error(`连线不兼容：${sourceNode.type} 不能作为 ${targetNode.type} 的上游`)
        }

        const sourcePort = input.sourcePort ?? 'output'
        const targetPort = input.targetPort ?? 'input'
        if (typeof sourcePort !== 'string' || typeof targetPort !== 'string') {
          throw new Error('连线端口无效。')
        }
        const dependencyType = input.dependencyType ?? 'reference'
        if (!new Set(['reference', 'input', 'control']).has(dependencyType)) {
          throw new Error('dependencyType 必须是 reference/input/control')
        }

        const edgeId = randomUUID()
        const edge = {
          id: edgeId,
          source: sourceNodeId,
          sourceHandle: sourcePort,
          target: targetNodeId,
          targetHandle: targetPort,
          data: {
            valid: true,
            edge: {
              id: edgeId,
              sourceNodeId,
              sourcePort,
              targetNodeId,
              targetPort,
              valid: true,
              dependencyType,
            },
          },
        }
        const graph = validateGraph(active.canvas.nodes, [...active.canvas.edges, edge])
        const normalizedEdge = graph.edges[graph.edges.length - 1]
        const nextVersion = canvasRow.version + 1
        if (!Number.isSafeInteger(nextVersion)) throw new Error('画布版本已达到本地上限。')
        const now = new Date().toISOString()
        await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
        database.prepare(`
          INSERT INTO edges (canvas_id, id, source_node_id, target_node_id, payload_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(active.metadata.canvasId, normalizedEdge.id, sourceNodeId, targetNodeId, JSON.stringify(normalizedEdge))
        const updated = database.prepare(`
          UPDATE canvases SET version = ?, updated_at = ? WHERE id = ? AND version = ?
        `).run(nextVersion, now, active.metadata.canvasId, canvasRow.version)
        if (updated.changes !== 1) throw new Error('画布已在其他会话更新，请刷新。')
        if (hasIdempotencyKey) {
          database.prepare(`
            UPDATE canvas_graph_commands
            SET operation = 'connect_nodes', result_canvas_version = ?, result_snapshot = ?
            WHERE canvas_id = ? AND idempotency_key = ?
          `).run(nextVersion, JSON.stringify(normalizedEdge.data.edge), active.metadata.canvasId, idempotencyKey)
        }
        database.exec('COMMIT')

        active.canvas = { ...active.canvas, version: nextVersion, edges: graph.edges }
        return {
          edge: JSON.parse(JSON.stringify(normalizedEdge.data.edge)),
          version: nextVersion,
          replayed: false,
        }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function deleteEdge(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      if (typeof input.edgeId !== 'string' || !input.edgeId || input.edgeId.length > 256) {
        throw new Error('连线标识无效。')
      }

      const database = active.database
      database.exec('BEGIN IMMEDIATE')
      try {
        const edge = database.prepare('SELECT id FROM edges WHERE canvas_id = ? AND id = ?')
          .get(active.metadata.canvasId, input.edgeId)
        if (!edge) throw new Error('连线不存在')

        await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
        const deleted = database.prepare('DELETE FROM edges WHERE canvas_id = ? AND id = ?')
          .run(active.metadata.canvasId, input.edgeId)
        if (deleted.changes !== 1) throw new Error('连线不存在')
        database.exec('COMMIT')

        active.canvas = {
          ...active.canvas,
          edges: active.canvas.edges.filter((candidate) => candidate.id !== input.edgeId),
        }
        return { status: 'ok' }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function addGroup(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const nodeIds = normalizeCanvasNodeIds(input.nodeIds, '编组至少需要 2 个节点', 2)
      const color = input.color ?? '#8b5cf6'
      if (typeof color !== 'string') throw new Error('编组颜色无效。')
      const group = { id: randomUUID(), name: '编组', color, layout: 'free', nodeIds }
      const database = active.database
      const now = new Date().toISOString()

      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        database.prepare(`
          INSERT INTO canvas_groups (canvas_id, id, name, color, layout, node_ids_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(active.metadata.canvasId, group.id, group.name, group.color, group.layout,
          JSON.stringify(group.nodeIds), now, now)
        const updatedNodes = updateNodeMemberships(
          database, active.metadata.canvasId, nodeIds, 'groupId', group.id, true,
        )
        database.exec('COMMIT')

        active.canvas = {
          ...active.canvas,
          nodes: nodesWithMembershipUpdates(active.canvas.nodes, updatedNodes),
          groups: [...active.canvas.groups, group],
        }
        return JSON.parse(JSON.stringify(group))
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function updateGroup(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const groupId = normalizeCanvasEntityId(input.groupId, '编组')
      const database = active.database
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        const currentRow = database.prepare(`
          SELECT id, name, color, layout, node_ids_json
          FROM canvas_groups WHERE canvas_id = ? AND id = ?
        `).get(active.metadata.canvasId, groupId)
        if (!currentRow) throw new Error('编组不存在')

        const current = groupPayloadFromRow(currentRow)
        const name = input.name === undefined || input.name === null ? current.name : input.name
        const color = input.color === undefined || input.color === null ? current.color : input.color
        const layout = input.layout === undefined || input.layout === null ? current.layout : input.layout
        if (typeof name !== 'string' || typeof color !== 'string' || typeof layout !== 'string') {
          throw new Error('编组数据无效。')
        }
        if (input.layout !== undefined && input.layout !== null
          && !['free', 'grid', 'horizontal'].includes(layout)) {
          throw new Error('布局类型必须是 free/grid/horizontal')
        }
        const nodeIds = input.nodeIds === undefined || input.nodeIds === null
          ? current.nodeIds
          : normalizeCanvasNodeIds(input.nodeIds, '画布编组节点列表无效。')
        const updatedGroup = { id: groupId, name, color, layout, nodeIds }
        const updatedAt = new Date().toISOString()
        database.prepare(`
          UPDATE canvas_groups
          SET name = ?, color = ?, layout = ?, node_ids_json = ?, updated_at = ?
          WHERE canvas_id = ? AND id = ?
        `).run(name, color, layout, JSON.stringify(nodeIds), updatedAt, active.metadata.canvasId, groupId)
        database.exec('COMMIT')

        active.canvas = {
          ...active.canvas,
          groups: active.canvas.groups.map((group) => group.id === groupId ? updatedGroup : group),
        }
        return JSON.parse(JSON.stringify(updatedGroup))
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function deleteGroup(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const groupId = normalizeCanvasEntityId(input.groupId, '编组')
      const database = active.database
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database.prepare(`
          SELECT node_ids_json FROM canvas_groups WHERE canvas_id = ? AND id = ?
        `).get(active.metadata.canvasId, groupId)
        if (!row) throw new Error('编组不存在')
        const nodeIds = normalizeCanvasNodeIds(JSON.parse(row.node_ids_json), '画布编组节点列表无效。')
        const updatedNodes = updateNodeMemberships(
          database, active.metadata.canvasId, nodeIds, 'groupId', null, false,
        )
        const deleted = database.prepare('DELETE FROM canvas_groups WHERE canvas_id = ? AND id = ?')
          .run(active.metadata.canvasId, groupId)
        if (deleted.changes !== 1) throw new Error('编组不存在')
        database.exec('COMMIT')

        active.canvas = {
          ...active.canvas,
          nodes: nodesWithMembershipUpdates(active.canvas.nodes, updatedNodes),
          groups: active.canvas.groups.filter((group) => group.id !== groupId),
        }
        return { status: 'ok' }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function addStack(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const nodeIds = normalizeCanvasNodeIds(input.nodeIds, '堆叠至少需要 2 个节点', 2)
      const stack = { id: randomUUID(), collapsed: true, nodeIds }
      const database = active.database
      const now = new Date().toISOString()

      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        database.prepare(`
          INSERT INTO canvas_stacks (canvas_id, id, collapsed, node_ids_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(active.metadata.canvasId, stack.id, 1, JSON.stringify(stack.nodeIds), now, now)
        const updatedNodes = updateNodeMemberships(
          database, active.metadata.canvasId, nodeIds, 'stackId', stack.id, true,
        )
        database.exec('COMMIT')

        active.canvas = {
          ...active.canvas,
          nodes: nodesWithMembershipUpdates(active.canvas.nodes, updatedNodes),
          stacks: [...active.canvas.stacks, stack],
        }
        return JSON.parse(JSON.stringify(stack))
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function updateStack(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const stackId = normalizeCanvasEntityId(input.stackId, '堆叠')
      const database = active.database
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        const currentRow = database.prepare(`
          SELECT id, collapsed, node_ids_json
          FROM canvas_stacks WHERE canvas_id = ? AND id = ?
        `).get(active.metadata.canvasId, stackId)
        if (!currentRow) throw new Error('堆叠不存在')
        if (input.collapsed !== undefined && input.collapsed !== null && typeof input.collapsed !== 'boolean') {
          throw new Error('堆叠 collapsed 无效。')
        }
        const updatedStack = {
          id: stackId,
          collapsed: input.collapsed === undefined || input.collapsed === null
            ? Boolean(currentRow.collapsed)
            : input.collapsed,
          nodeIds: normalizeCanvasNodeIds(JSON.parse(currentRow.node_ids_json), '画布堆叠节点列表无效。'),
        }
        database.prepare(`
          UPDATE canvas_stacks SET collapsed = ?, updated_at = ? WHERE canvas_id = ? AND id = ?
        `).run(updatedStack.collapsed ? 1 : 0, new Date().toISOString(), active.metadata.canvasId, stackId)
        database.exec('COMMIT')

        active.canvas = {
          ...active.canvas,
          stacks: active.canvas.stacks.map((stack) => stack.id === stackId ? updatedStack : stack),
        }
        return JSON.parse(JSON.stringify(updatedStack))
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function extractFromStack(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const stackId = normalizeCanvasEntityId(input.stackId, '堆叠')
      const nodeId = normalizeCanvasEntityId(input.nodeId, '节点')
      const database = active.database
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        const currentRow = database.prepare(`
          SELECT id, collapsed, node_ids_json
          FROM canvas_stacks WHERE canvas_id = ? AND id = ?
        `).get(active.metadata.canvasId, stackId)
        if (!currentRow) throw new Error('堆叠不存在')
        const storedNode = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
          .get(active.metadata.canvasId, nodeId)
        const currentNode = active.canvas.nodes.find((node) => node.id === nodeId)
        if (!storedNode || !currentNode) throw new Error('节点不存在')
        const stack = stackPayloadFromRow(currentRow)
        if (!stack.nodeIds.includes(nodeId)) throw new Error('该节点不在堆叠中')

        const remainingNodeIds = stack.nodeIds.filter((candidate) => candidate !== nodeId)
        if (remainingNodeIds.length === 0) {
          database.prepare('DELETE FROM canvas_stacks WHERE canvas_id = ? AND id = ?')
            .run(active.metadata.canvasId, stackId)
        } else {
          database.prepare(`
            UPDATE canvas_stacks SET node_ids_json = ?, updated_at = ? WHERE canvas_id = ? AND id = ?
          `).run(JSON.stringify(remainingNodeIds), new Date().toISOString(), active.metadata.canvasId, stackId)
        }
        const updatedNode = updateNodeMembership(database, active.metadata.canvasId, nodeId, 'stackId', null)
        if (!updatedNode) throw new Error('节点不存在')
        database.exec('COMMIT')

        const updatedFlowNode = updatedNode
        const remainingStack = remainingNodeIds.length === 0
          ? null
          : { ...stack, nodeIds: remainingNodeIds }
        active.canvas = {
          ...active.canvas,
          nodes: nodesWithMembershipUpdates(active.canvas.nodes, new Map([[nodeId, updatedFlowNode]])),
          stacks: remainingStack
            ? active.canvas.stacks.map((candidate) => candidate.id === stackId ? remainingStack : candidate)
            : active.canvas.stacks.filter((candidate) => candidate.id !== stackId),
        }
        return nodePayloadFromFlowNode(updatedFlowNode)
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function deleteStack(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const stackId = normalizeCanvasEntityId(input.stackId, '堆叠')
      const database = active.database
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database.prepare(`
          SELECT node_ids_json FROM canvas_stacks WHERE canvas_id = ? AND id = ?
        `).get(active.metadata.canvasId, stackId)
        if (!row) throw new Error('堆叠不存在')
        const nodeIds = normalizeCanvasNodeIds(JSON.parse(row.node_ids_json), '画布堆叠节点列表无效。')
        const updatedNodes = updateNodeMemberships(
          database, active.metadata.canvasId, nodeIds, 'stackId', null, false,
        )
        const deleted = database.prepare('DELETE FROM canvas_stacks WHERE canvas_id = ? AND id = ?')
          .run(active.metadata.canvasId, stackId)
        if (deleted.changes !== 1) throw new Error('堆叠不存在')
        database.exec('COMMIT')

        active.canvas = {
          ...active.canvas,
          nodes: nodesWithMembershipUpdates(active.canvas.nodes, updatedNodes),
          stacks: active.canvas.stacks.filter((stack) => stack.id !== stackId),
        }
        return { status: 'ok' }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function saveCanvas(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      const hasIdempotencyKey = input.idempotencyKey !== undefined && input.idempotencyKey !== null
      const idempotencyKey = hasIdempotencyKey ? input.idempotencyKey : null
      if (hasIdempotencyKey
        && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128)) {
        throw new Error('Idempotency-Key 必须为 1-128 个字符。')
      }
      const database = active.database
      database.exec('BEGIN IMMEDIATE')
      try {
        const command = hasIdempotencyKey
          ? database.prepare(`
            SELECT operation, result_canvas_version, result_snapshot
            FROM canvas_graph_commands WHERE canvas_id = ? AND idempotency_key = ?
          `).get(active.metadata.canvasId, idempotencyKey)
          : undefined
        if (command && command.operation !== 'save_canvas') {
          throw new Error('Idempotency-Key 已用于其他画布命令。')
        }
        if (command && command.result_snapshot !== '{}') {
          let resultVersion
          let staleNodeIds = []
          try {
            const snapshot = JSON.parse(command.result_snapshot)
            resultVersion = snapshot?.version ?? snapshot?.canvas?.version ?? command.result_canvas_version
            if (!Number.isSafeInteger(resultVersion) || resultVersion < 0) {
              throw new Error('invalid save snapshot')
            }
            staleNodeIds = Array.isArray(snapshot?.staleNodeIds)
              ? snapshot.staleNodeIds.filter((nodeId) => typeof nodeId === 'string')
              : []
          } catch {
            throw new Error('画布命令结果快照损坏。')
          }
          database.exec('COMMIT')
          return { version: resultVersion, staleNodeIds, replayed: true }
        }

        if (hasIdempotencyKey && !command) {
          database.prepare(`
            INSERT INTO canvas_graph_commands (canvas_id, idempotency_key, operation, created_at)
            VALUES (?, ?, 'save_canvas', ?)
          `).run(active.metadata.canvasId, idempotencyKey, new Date().toISOString())
        }

        if (input.expectedVersion !== active.canvas.version) {
          throw new Error('画布版本已变化，请重新打开项目后再保存。')
        }
        const persistedVersion = database.prepare('SELECT version FROM canvases WHERE id = ?').get(active.metadata.canvasId)
        if (!persistedVersion || persistedVersion.version !== input.expectedVersion) {
          throw new Error('画布版本已被其他操作更新，请重新打开项目后再保存。')
        }

        const graph = validateGraph(input.nodes, input.edges)
        graph.nodes = preserveNodeGenerationState(graph.nodes, active.canvas.nodes)
        const previousNodesById = new Map(active.canvas.nodes.map((node) => [node.id, node]))
        const contentChangedNodeIds = graph.nodes
          .filter((node) => {
            const previous = previousNodesById.get(node.id)
            return previous && canvasNodeContentSignature(node) !== canvasNodeContentSignature(previous)
          })
          .map((node) => node.id)
        const staleNodeIds = new Set()
        for (const nodeId of contentChangedNodeIds) {
          const staleResult = markDownstreamNodesStale(graph.nodes, graph.edges, nodeId)
          graph.nodes = staleResult.nodes
          for (const staleNodeId of staleResult.staleNodeIds) staleNodeIds.add(staleNodeId)
        }
        // Existing Renderer saves contain only graph data. Preserve Store-only
        // group/stack entities when those fields are omitted from the snapshot.
        const groups = input.groups === undefined
          ? normalizeCanvasGroups(active.canvas.groups)
          : normalizeCanvasGroups(input.groups)
        const stacks = input.stacks === undefined
          ? normalizeCanvasStacks(active.canvas.stacks)
          : normalizeCanvasStacks(input.stacks)
        if (Buffer.byteLength(JSON.stringify({ ...graph, groups, stacks }), 'utf8') > MAX_CANVAS_BYTES) {
          throw new Error('画布数据超过本地项目的单次保存上限。')
        }

        await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
        database.prepare('DELETE FROM edges WHERE canvas_id = ?').run(active.metadata.canvasId)
        database.prepare('DELETE FROM canvas_groups WHERE canvas_id = ?').run(active.metadata.canvasId)
        database.prepare('DELETE FROM canvas_stacks WHERE canvas_id = ?').run(active.metadata.canvasId)
        database.prepare('DELETE FROM nodes WHERE canvas_id = ?').run(active.metadata.canvasId)
        insertGraph(database, active.metadata.canvasId, graph)
        insertCanvasGroupsAndStacks(database, active.metadata.canvasId, groups, stacks)
        insertAssetReferences(database, active.metadata.canvasId, graph)
        const nextVersion = input.expectedVersion + 1
        const update = database.prepare('UPDATE canvases SET version = ?, updated_at = ? WHERE id = ? AND version = ?')
          .run(nextVersion, new Date().toISOString(), active.metadata.canvasId, input.expectedVersion)
        if (update.changes !== 1) throw new Error('画布版本已被其他操作更新，请重新打开项目后再保存。')
        if (hasIdempotencyKey) {
          database.prepare(`
            UPDATE canvas_graph_commands
            SET operation = 'save_canvas', result_canvas_version = ?, result_snapshot = ?
            WHERE canvas_id = ? AND idempotency_key = ?
          `).run(nextVersion, JSON.stringify({
            version: nextVersion,
            staleNodeIds: [...staleNodeIds],
          }), active.metadata.canvasId, idempotencyKey)
        }
        database.exec('COMMIT')

        active.canvas = {
          schemaVersion: CANVAS_SCHEMA_VERSION,
          projectId: active.metadata.projectId,
          canvasId: active.metadata.canvasId,
          version: nextVersion,
          ...graph,
          groups,
          stacks,
        }
        return hasIdempotencyKey
          ? { version: nextVersion, staleNodeIds: [...staleNodeIds], replayed: false }
          : { version: nextVersion, staleNodeIds: [...staleNodeIds] }
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    })
  }

  async function close() {
    return enqueue(async () => {
      const current = active
      active = null
      if (current) await closeProjectData(current)
    })
  }

  function getDeletedNodeCommand(input) {
    if (!active || !isRecord(input) || input.projectId !== active.metadata.projectId
      || input.canvasId !== active.metadata.canvasId || typeof input.idempotencyKey !== 'string') {
      throw new Error('当前项目已更改。')
    }
    const command = active.database.prepare(`SELECT operation, result_canvas_version, result_snapshot
      FROM canvas_graph_commands WHERE canvas_id = ? AND idempotency_key = ?`)
      .get(input.canvasId, input.idempotencyKey)
    if (!command || command.operation !== 'delete_nodes' || command.result_snapshot === '{}') return null
    const result = JSON.parse(command.result_snapshot)
    if (!isRecord(result) || typeof result.deletedNodeId !== 'string'
      || !Number.isSafeInteger(command.result_canvas_version)) throw new Error('画布命令结果快照损坏。')
    return { ...result, version: command.result_canvas_version }
  }

  function lookupAgentOperation(input) {
    if (!active || !isRecord(input) || input.projectId !== active.metadata.projectId
      || input.canvasId !== active.metadata.canvasId || typeof input.idempotencyKey !== 'string') throw new Error('当前项目已更改。')
    if (input.method === 'agent:core:create-generation-task') {
      const row = active.database.prepare(`${TASKS_WITH_OUTPUT_METADATA} WHERE tasks.idempotency_key = ?`).get(input.idempotencyKey)
      return row ? taskFromRow(row) : null
    }
    const expectedOperation = {
      'agent:core:create-node': 'create_nodes', 'agent:core:update-node': 'update_node_config',
      'agent:core:connect-edge': 'connect_nodes', 'agent:core:save-canvas': 'save_canvas',
    }[input.method]
    if (!expectedOperation) throw new Error('INVALID_INPUT')
    const row = active.database.prepare(`SELECT operation, result_snapshot, result_canvas_version
      FROM canvas_graph_commands WHERE canvas_id = ? AND idempotency_key = ?`).get(input.canvasId, input.idempotencyKey)
    if (!row || row.operation !== expectedOperation || row.result_snapshot === '{}') return null
    const result = JSON.parse(row.result_snapshot)
    if (!isRecord(result) || !Number.isSafeInteger(row.result_canvas_version)) throw new Error('画布命令结果快照损坏。')
    if (input.method === 'agent:core:create-node') return { node: flowNodeFromPayload(result), version: row.result_canvas_version, replayed: true }
    if (input.method === 'agent:core:update-node') return { node: result, version: row.result_canvas_version, replayed: true }
    if (input.method === 'agent:core:connect-edge') return { edge: result, version: row.result_canvas_version, replayed: true }
    return { ...result, replayed: true }
  }

  return {
    getDeletedNodeCommand,
    lookupAgentOperation,
    addGroup,
    addStack,
    backupProject,
    cancelTask,
    cleanupCancelledTaskOutput,
    claimNextTask,
    recordProviderCheckpoint,
    close,
    connectEdge,
    createNode,
    createProject,
    createTask,
    deleteGroup,
    deleteEdge,
    deleteNode,
    deleteStack,
    extractFromStack,
    exportCanvas,
    getActiveProject,
    getTask,
    getTaskInput,
    inspectProject,
    resolveProjectCover,
    importCanvasDocument,
    importAsset,
    saveTaskOutputToLibrary,
    listAssets,
    listDramaAssets,
    listDramaRenderCandidates,
    listDramaRenderBatches,
    getDramaRenderBatch,
    createDramaRenderBatch,
    prepareDramaRenderBatchConfirmation,
    consumeDramaRenderBatchConfirmation,
    rejectDramaRenderBatchConfirmation,
    rerunDramaRenderBatchJob,
    markDramaRenderBatchTask,
    markDramaRenderBatchJobFailure,
    createDramaSeries,
    createDramaCharacter,
    addDramaReferencePack,
    createDramaShot,
    prepareDramaKeyframeNode,
    recordDramaKeyframe,
    prepareDramaVideoNode,
    recordDramaLineage,
    markDramaLineagesStaleForCharacter,
    listRenderReviews,
    listTaskEvents,
    listTasks,
    readTaskOutputText,
    resolveComposeInputPaths,
    resolveTaskOutputForPreview,
    loadCanvas,
    openProject,
    recordTaskFailed,
    recordTaskSucceeded,
    retryTask,
    resolveAsset,
    resolveAssetThumbnail,
    renameAsset,
    replaceAsset,
    replaceAssetFile,
    replaceAudioAsset,
    deleteAsset,
    restoreBackup,
    renameProject,
    saveCanvas,
    searchTasks,
    updateGroup,
    upsertDramaAsset,
    createRenderReview,
    updateNode,
    updateStack,
  }
}

function publicAsset(row) {
  const mimeType = row.mime_type ?? row.mimeType
  const assetType = typeof mimeType === 'string' ? mimeType.split('/', 1)[0] : ''
  return {
    assetId: row.id ?? row.assetId,
    assetType: ['image', 'video', 'audio', 'text'].includes(assetType) ? assetType : 'image',
    name: row.original_name ?? row.name,
    mimeType,
    sizeBytes: Number(row.size_bytes ?? row.sizeBytes),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt,
    referenceCount: Number(row.reference_count ?? row.referenceCount ?? 0),
  }
}

module.exports = { createLocalProjectStore, validateGraph }
