const nativeFs = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { backup, DatabaseSync } = require('node:sqlite')

const PROJECT_SCHEMA_VERSION = 1
const CANVAS_SCHEMA_VERSION = 1
const CANVAS_EXPORT_SCHEMA_VERSION = '1.0.0'
const PROJECT_DB_SCHEMA_VERSION = 10
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
const AGENT_BACKUP_DIRECTORIES = new Set(['sessions', 'memory', 'skills', 'session-memory'])
const AGENT_BACKUP_EXTENSIONS = new Set(['.jsonl', '.json', '.md', '.zst'])
const EDGE_COMPATIBLE_TARGET_TYPES = Object.freeze({
  text: new Set(['text', 'image', 'video', 'audio', 'director']),
  image: new Set(['image', 'video', 'director']),
  video: new Set(['video', 'compose']),
  audio: new Set(['audio', 'video']),
  compose: new Set(['video', 'compose']),
  director: new Set(['image', 'video']),
})

const ASSET_DB_SCHEMA = `
  CREATE TABLE assets (
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

  CREATE INDEX assets_by_sha ON assets(sha256, deleted);

  CREATE TABLE asset_references (
    canvas_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    PRIMARY KEY (canvas_id, node_id),
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
  ${CANVAS_GRAPH_COMMANDS_DB_SCHEMA}
  ${CANVAS_GROUP_STACK_DB_SCHEMA}
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ...(typeof row.output_metadata === 'string' ? { outputMeta: JSON.parse(row.output_metadata) } : {}),
  }
}

const TASKS_WITH_OUTPUT_METADATA = `
  SELECT tasks.*,
    (SELECT json_extract(events.data_json, '$.outputMeta')
      FROM task_events AS events
      WHERE events.task_id = tasks.task_id AND events.type = 'succeeded'
      ORDER BY events.event_seq DESC LIMIT 1) AS output_metadata
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

function validateTaskOutputRelativePath(taskId, modality, relativePath) {
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
  const allowed = {
    text: ['.txt', '.md', '.json'],
    image: ['.png', '.jpg', '.jpeg', '.webp'],
    audio: ['.mp3', '.wav', '.ogg', '.m4a'],
    video: ['.mp4', '.webm', '.mov'],
    compose: ['.mp4'],
  }[modality]
  if (!allowed?.includes(extension)) throw new Error('生成结果文件格式与任务模态不匹配。')
  return relativePath
}

function taskOutputFingerprint(info) {
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`
}

async function resolveTaskOutputFile(dataDirectory, taskId, modality, relativePath, cached = null) {
  validateTaskOutputRelativePath(taskId, modality, relativePath)
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
    SELECT task_id, modality, output_path, output_sha256, output_size_bytes
    FROM tasks WHERE status = 'succeeded' ORDER BY task_id
  `).all()
  for (const task of tasks) {
    const source = await resolveTaskOutputFile(sourceDataDirectory, task.task_id, task.modality, task.output_path)
    if (source.sha256 !== task.output_sha256 || source.sizeBytes !== task.output_size_bytes) {
      throw new Error(`生成任务“${task.task_id}”的结果校验失败，项目备份未完成。`)
    }
    const targetPath = path.resolve(targetDataDirectory, ...task.output_path.split('/'))
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
    const copied = await resolveTaskOutputFile(targetDataDirectory, task.task_id, task.modality, task.output_path)
    if (copied.sha256 !== task.output_sha256 || copied.sizeBytes !== task.output_size_bytes) {
      await fs.rm(targetPath, { force: true }).catch(() => undefined)
      throw new Error(`生成任务“${task.task_id}”的结果复制校验失败，项目备份未完成。`)
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

function insertAssetReferences(database, canvasId, graph) {
  const findAsset = database.prepare('SELECT id, mime_type FROM assets WHERE id = ?')
  const insertReference = database.prepare('INSERT INTO asset_references (canvas_id, node_id, asset_id) VALUES (?, ?, ?)')
  for (const node of graph.nodes) {
    if (!['image', 'audio'].includes(node.type)) continue
    const params = isRecord(node.data.params) ? node.data.params : {}
    const assetId = node.data.assetId ?? params.assetId
    if (assetId === undefined || assetId === null || assetId === '') continue
    const asset = typeof assetId === 'string' ? findAsset.get(assetId) : null
    const expectedMimePrefix = node.type === 'image' ? 'image/' : 'audio/'
    if (!asset) throw new Error(node.type === 'image'
      ? '画布图片节点引用了不存在的本地素材。' : '画布音频节点引用了不存在的本地素材。')
    if (!asset.mime_type.startsWith(expectedMimePrefix)) {
      throw new Error(`画布${node.type === 'image' ? '图片' : '音频'}节点引用了类型不匹配的本地素材。`)
    }
    insertReference.run(canvasId, node.id, assetId)
  }
}

function validateAssetReferences(database, canvasId, graph, { allowLegacyParamsGaps = false } = {}) {
  const expected = new Map()
  const legacyParamsReferences = new Set()
  for (const node of graph.nodes) {
    if (!['image', 'audio'].includes(node.type)) continue
    const params = isRecord(node.data.params) ? node.data.params : {}
    const assetId = node.data.assetId ?? params.assetId
    if (assetId === undefined || assetId === null || assetId === '') continue
    if (typeof assetId !== 'string') throw new Error(`项目画布中的${node.type === 'image' ? '图片' : '音频'}节点素材标识无效。`)
    const asset = database.prepare('SELECT mime_type FROM assets WHERE id = ?').get(assetId)
    const expectedMimePrefix = node.type === 'image' ? 'image/' : 'audio/'
    if (!asset) throw new Error(node.type === 'image'
      ? '项目画布中的图片节点引用了不存在的本地素材。' : '项目画布中的音频节点引用了不存在的本地素材。')
    if (!asset.mime_type.startsWith(expectedMimePrefix)) throw new Error('项目画布中的本地素材引用类型不匹配。')
    expected.set(node.id, assetId)
    if (node.data.assetId === undefined || node.data.assetId === null) legacyParamsReferences.add(node.id)
  }
  const actualRows = database.prepare('SELECT node_id, asset_id FROM asset_references WHERE canvas_id = ?').all(canvasId)
  const hasConflictingOrExtraRows = actualRows.some((row) => expected.get(row.node_id) !== row.asset_id)
  const actualNodeIds = new Set(actualRows.map((row) => row.node_id))
  const missingRows = [...expected].filter(([nodeId]) => !actualNodeIds.has(nodeId))
  if (!hasConflictingOrExtraRows && missingRows.length === 0) return []
  if (allowLegacyParamsGaps && !hasConflictingOrExtraRows
    && missingRows.every(([nodeId]) => legacyParamsReferences.has(nodeId))) {
    return missingRows.map(([nodeId, assetId]) => ({ canvasId, nodeId, assetId }))
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
  if (['image', 'audio'].includes(node.type) && typeof data.assetId === 'string' && params.assetId === undefined) {
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
  if (['image', 'audio'].includes(node.type) && typeof data.assetId === 'string'
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
      validateAssetReferences(database, canvasId, { nodes }, { allowLegacyParamsGaps: true }))
    for (const row of missingRows) insertReference.run(row.canvasId, row.nodeId, row.assetId)

    for (const { canvasId, nodes } of canvasGraphs) {
      validateAssetReferences(database, canvasId, { nodes })
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
  if (version === PROJECT_DB_SCHEMA_VERSION) return
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
    if (!/^assets\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp|wav|mp3)$/iu.test(asset.relative_path)) {
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
      || !/^assets\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp|wav|mp3)$/iu.test(row.relative_path)) {
      throw new Error('项目素材清单包含无效路径，无法备份或恢复。')
    }
    paths.push(row.relative_path)
  }
  if (databaseVersion(database) >= 3) {
    const taskRows = database.prepare(`
      SELECT task_id, modality, output_path, output_sha256, output_size_bytes
      FROM tasks WHERE status = 'succeeded' ORDER BY task_id
    `).all()
    for (const task of taskRows) {
      validateTaskOutputRelativePath(task.task_id, task.modality, task.output_path)
      if (!/^[a-f0-9]{64}$/u.test(task.output_sha256)
        || !Number.isSafeInteger(task.output_size_bytes) || task.output_size_bytes <= 0) {
        throw new Error(`生成任务“${task.task_id}”的结果索引无效，无法备份或恢复。`)
      }
      paths.push(task.output_path)
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
    try {
      const targetControl = path.join(targetDataDirectory, 'agent', 'control.sqlite')
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
    if (version !== 1) throw new Error('Agent 控制数据库版本当前不支持恢复。')
    const integrity = control.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok'
      || control.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('Agent 控制数据库完整性校验失败。')
    }
    const now = new Date().toISOString()
    control.exec('BEGIN IMMEDIATE')
    try {
      control.prepare(`UPDATE approvals SET project_id = ?, status = CASE WHEN status = 'pending' THEN 'invalidated' ELSE status END, updated_at = ?`)
        .run(nextProjectId, now)
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
    if (version !== 1 || integrity.length !== 1 || integrity[0].integrity_check !== 'ok'
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
    && !/^assets\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp|wav|mp3)$/iu.test(relativePath)
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
    if (![2, 3, 4, 5, 6, 7, 8, 9, PROJECT_DB_SCHEMA_VERSION].includes(schemaVersion)) {
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

async function detectAssetMimeType(filePath, diagnosticPath = filePath) {
  try {
    return await detectImageMimeType(filePath)
  } catch {
    return detectAudioMimeType(filePath, diagnosticPath)
  }
}

function extensionForAssetMimeType(mimeType) {
  return ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
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
      if (databaseVersion(database) !== PROJECT_DB_SCHEMA_VERSION) {
        throw new Error(`本地项目数据库版本 ${databaseVersion(database)} 当前不受支持。`)
      }
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

  async function createProject(parentDirectory, nameValue) {
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
        version: 0,
        nodes: [],
        edges: [],
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
      await fs.rename(staging, path.join(destination, '.vibepaper'))
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
        await fs.rename(staging, destination)
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
        await fs.rename(staging, destination)
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
    if (assetKind !== 'image' && assetKind !== 'local') throw new Error('素材导入类型无效。')
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法导入素材。')
      const { assetsDirectory } = await projectAssetsDirectory(active.directory)
      const temporaryPath = path.join(assetsDirectory, `.import-${randomUUID()}.tmp`)
      try {
        const copied = await copyAssetSource(sourcePath, temporaryPath)
        const mimeType = assetKind === 'image'
          ? await detectImageMimeType(temporaryPath)
          : await detectAssetMimeType(temporaryPath, sourcePath)
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
        const originalName = rawName.replace(/[\u0000-\u001f]/gu, '_').slice(0, 255) || `image.${extension}`
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

  function replaceAssetByType(projectId, assetId, sourcePath, assetType) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法替换素材。')
      if (typeof assetId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(assetId)) {
        throw new Error('素材标识无效。')
      }
      const database = active.database
      const current = database.prepare('SELECT * FROM assets WHERE id = ? AND deleted = 0').get(assetId)
      if (!current) throw new Error('本地素材不存在。')
      const currentMatchesType = assetType === 'audio'
        ? ['audio/wav', 'audio/mpeg'].includes(current.mime_type)
        : current.mime_type.startsWith('image/')
      if (!currentMatchesType) throw new Error(assetType === 'audio' ? '只能替换 WAV 或 MP3 音频素材。' : '只能替换图片素材。')
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
          : await detectImageMimeType(temporaryPath)
        const extension = extensionForAssetMimeType(mimeType)
        const rawName = path.basename(path.resolve(sourcePath))
        const normalizedName = normalizeAssetName(rawName || current.original_name)
        const nextUpdatedAt = new Date().toISOString()

        if (copied.sha256 !== current.sha256 || !oldAssetFile) {
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
      return { filePath: resolved.filePath, mimeType: asset.mime_type }
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

  function resolveTaskOutputForPreview(projectId, taskId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务结果。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const row = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!row || row.status !== 'succeeded' || !['image', 'audio', 'video', 'compose'].includes(row.modality)) {
        throw new Error('此任务没有可预览的媒体结果。')
      }
      const cacheKey = `${projectId}:${taskId}`
      const output = await resolveTaskOutputFile(
        path.join(active.directory, '.vibepaper'),
        row.task_id,
        row.modality,
        row.output_path,
        previewDigestCache.get(cacheKey),
      )
      if (output.sha256 !== row.output_sha256 || output.sizeBytes !== row.output_size_bytes) {
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
        '.webm': 'video/webm',
      }[extension]
      if (!mimeType || (row.modality === 'image' && !mimeType.startsWith('image/'))
        || (row.modality === 'audio' && !mimeType.startsWith('audio/'))
        || (['video', 'compose'].includes(row.modality) && !mimeType.startsWith('video/'))) {
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
        return { task: taskFromRow(row), parameters: JSON.parse(row.input_json), outputDirectory }
      } catch (error) {
        active.database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function recordTaskSucceeded(projectId, taskId, outputPath, rawOutputMeta = null) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法完成任务。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const current = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      const output = await resolveTaskOutputFile(
        path.join(active.directory, '.vibepaper'),
        current.task_id,
        current.modality,
        outputPath,
      )
      if (current.status === 'succeeded') {
        if (current.output_path !== outputPath || current.output_sha256 !== output.sha256
          || current.output_size_bytes !== output.sizeBytes) throw new Error('TASK_RESULT_CONFLICT')
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
        return succeeded
      }
      if (current.status !== 'running') throw new Error('TASK_STATE_CONFLICT')
      const outputMeta = current.modality === 'audio' && current.provider_type === 'local'
        && current.provider_id === 'local-sapi-tts'
        ? normalizeAudioOutputMeta(rawOutputMeta) : null
      if (current.modality === 'audio' && current.provider_type === 'local'
        && current.provider_id === 'local-sapi-tts' && !outputMeta) {
        throw new Error('AUDIO_OUTPUT_METADATA_INVALID')
      }
      const now = new Date().toISOString()
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      active.database.exec('BEGIN IMMEDIATE')
      try {
        const update = active.database.prepare(`
          UPDATE tasks SET status = 'succeeded', output_path = ?, output_sha256 = ?, output_size_bytes = ?,
            error_code = NULL, updated_at = ?, completed_at = ?
          WHERE task_id = ? AND status = 'running'
        `).run(outputPath, output.sha256, output.sizeBytes, now, now, taskId)
        if (update.changes !== 1) throw new Error('TASK_STATE_CONFLICT')
        appendTaskEvent(active.database, taskId, 'succeeded', {
          outputPath,
          outputSha256: output.sha256,
          outputSizeBytes: output.sizeBytes,
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

  function recordTaskFailed(projectId, taskId, errorCode) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法更新任务。')
      if (typeof taskId !== 'string' || !taskId || typeof errorCode !== 'string'
        || !/^[A-Z0-9_]{1,120}$/u.test(errorCode)) throw new Error('任务失败信息无效。')
      const current = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      if (!current) throw new Error('TASK_NOT_FOUND')
      if (current.status === 'failed' && current.error_code === errorCode) return taskFromRow(current)
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
        appendTaskEvent(active.database, taskId, 'failed', { errorCode }, now)
        active.database.exec('COMMIT')
        return taskFromRow(active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId))
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
      if (current.status !== 'queued') throw new Error('TASK_CANCELLATION_REQUIRES_WORKER')
      const now = new Date().toISOString()
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      active.database.exec('BEGIN IMMEDIATE')
      try {
        const update = active.database.prepare(`
          UPDATE tasks SET status = 'cancelled', error_code = NULL, updated_at = ?, completed_at = ?
          WHERE task_id = ? AND status = 'queued'
        `).run(now, now, taskId)
        if (update.changes !== 1) throw new Error('TASK_STATE_CONFLICT')
        appendTaskEvent(active.database, taskId, 'cancelled', {}, now)
        active.database.exec('COMMIT')
        return taskFromRow(active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId))
      } catch (error) {
        active.database.exec('ROLLBACK')
        throw error
      }
    })
  }

  function getActiveProject() {
    return active ? publicProject(active.metadata) : null
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
          const localAsset = ['image', 'audio'].includes(payload.type) && typeof payload.params.assetId === 'string'
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
        const localAssetId = ['image', 'audio'].includes(payload.type) && typeof payload.params.assetId === 'string'
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
          try {
            const snapshot = JSON.parse(command.result_snapshot)
            resultVersion = snapshot?.version ?? snapshot?.canvas?.version ?? command.result_canvas_version
            if (!Number.isSafeInteger(resultVersion) || resultVersion < 0) {
              throw new Error('invalid save snapshot')
            }
          } catch {
            throw new Error('画布命令结果快照损坏。')
          }
          database.exec('COMMIT')
          return { version: resultVersion, replayed: true }
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
          `).run(nextVersion, JSON.stringify({ version: nextVersion }), active.metadata.canvasId, idempotencyKey)
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
          ? { version: nextVersion, replayed: false }
          : { version: nextVersion }
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

  return {
    addGroup,
    addStack,
    backupProject,
    cancelTask,
    claimNextTask,
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
    importAsset,
    saveTaskOutputToLibrary,
    listAssets,
    listTaskEvents,
    listTasks,
    readTaskOutputText,
    resolveComposeInputPaths,
    resolveTaskOutputForPreview,
    loadCanvas,
    openProject,
    recordTaskFailed,
    recordTaskSucceeded,
    resolveAsset,
    renameAsset,
    replaceAsset,
    replaceAudioAsset,
    deleteAsset,
    restoreBackup,
    saveCanvas,
    searchTasks,
    updateGroup,
    updateNode,
    updateStack,
  }
}

function publicAsset(row) {
  const mimeType = row.mime_type ?? row.mimeType
  return {
    assetId: row.id ?? row.assetId,
    assetType: typeof mimeType === 'string' && mimeType.startsWith('audio/') ? 'audio' : 'image',
    name: row.original_name ?? row.name,
    mimeType,
    sizeBytes: Number(row.size_bytes ?? row.sizeBytes),
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt,
    referenceCount: Number(row.reference_count ?? row.referenceCount ?? 0),
  }
}

module.exports = { createLocalProjectStore, validateGraph }
