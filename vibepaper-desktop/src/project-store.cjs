const nativeFs = require('node:fs')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { backup, DatabaseSync } = require('node:sqlite')

const PROJECT_SCHEMA_VERSION = 1
const CANVAS_SCHEMA_VERSION = 1
const PROJECT_DB_SCHEMA_VERSION = 3
const PROJECT_BACKUP_SCHEMA_VERSION = 1
const MAX_NODES = 10_000
const MAX_EDGES = 20_000
const MAX_CANVAS_BYTES = 32 * 1024 * 1024
const MAX_ASSET_BYTES = 200 * 1024 * 1024
const MAX_TASK_INPUT_BYTES = 1024 * 1024
const MAX_TASK_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024

const ASSET_DB_SCHEMA = `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
    relative_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  ) STRICT;

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
    modality TEXT NOT NULL CHECK (modality IN ('text', 'image', 'audio', 'video')),
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
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || node.id.length > 256 || nodeIds.has(node.id)) {
      throw new Error('画布包含无效或重复的节点。')
    }
    if (!isRecord(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || !isRecord(node.data)) {
      throw new Error('画布节点缺少有效的位置或数据。')
    }
    nodeIds.add(node.id)
  }

  const edgeIds = new Set()
  for (const edge of edges) {
    if (!isRecord(edge) || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id)) {
      throw new Error('画布包含无效或重复的连线。')
    }
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string' || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error('画布连线引用了不存在的节点。')
    }
    edgeIds.add(edge.id)
  }

  const graph = JSON.parse(JSON.stringify({ nodes, edges }))
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
  const modalities = ['text', 'image', 'audio', 'video']
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
  const findAsset = database.prepare('SELECT id FROM assets WHERE id = ?')
  const insertReference = database.prepare('INSERT INTO asset_references (canvas_id, node_id, asset_id) VALUES (?, ?, ?)')
  for (const node of graph.nodes) {
    if (node.type !== 'image') continue
    const assetId = node.data.assetId
    if (typeof assetId !== 'string' || !findAsset.get(assetId)) {
      throw new Error('画布图片节点引用了不存在的本地素材。')
    }
    insertReference.run(canvasId, node.id, assetId)
  }
}

function validateAssetReferences(database, canvasId, graph) {
  const expected = new Map()
  for (const node of graph.nodes) {
    if (node.type !== 'image') continue
    if (typeof node.data.assetId !== 'string') throw new Error('项目画布中的图片节点缺少素材标识。')
    expected.set(node.id, node.data.assetId)
  }
  const actualRows = database.prepare('SELECT node_id, asset_id FROM asset_references WHERE canvas_id = ?').all(canvasId)
  if (actualRows.length !== expected.size || actualRows.some((row) => expected.get(row.node_id) !== row.asset_id)) {
    throw new Error('项目画布与本地素材引用记录不一致。')
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
    insertAssetReferences(database, metadata.canvasId, canvas)
    database.exec(`PRAGMA user_version = ${PROJECT_DB_SCHEMA_VERSION}`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
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

function readDatabaseCanvas(database, metadata) {
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
  const graph = validateGraph(nodes, edges)
  validateAssetReferences(database, metadata.canvasId, graph)
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    projectId: metadata.projectId,
    canvasId: metadata.canvasId,
    version: canvasRow.version,
    ...graph,
  }
}

async function copyAssetSource(sourcePath, temporaryPath) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath.length > 32_768) {
    throw new Error('所选图片文件无效。')
  }
  const source = path.resolve(sourcePath)
  const info = await fs.stat(source).catch(() => null)
  if (!info?.isFile()) throw new Error('请选择一个可读取的图片文件。')
  if (info.size <= 0 || info.size > MAX_ASSET_BYTES) throw new Error('图片文件必须大于 0 字节且不超过 200 MB。')

  let size = 0
  const hash = createHash('sha256')
  const digest = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length
      if (size > MAX_ASSET_BYTES) {
        callback(new Error('图片文件超过 200 MB 的本地素材上限。'))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  const handle = await fs.open(temporaryPath, 'wx', 0o600)
  try {
    await pipeline(
      nativeFs.createReadStream(source),
      digest,
      handle.createWriteStream({ autoClose: false }),
    )
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()
  if (size === 0) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw new Error('所选图片文件为空。')
  }
  return { sha256: hash.digest('hex'), sizeBytes: size }
}

async function copyProjectAssets(database, sourceDataDirectory, targetDataDirectory) {
  const assets = database.prepare('SELECT id, sha256, original_name, mime_type, size_bytes, relative_path FROM assets ORDER BY id').all()
  for (const asset of assets) {
    if (!/^assets\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp)$/iu.test(asset.relative_path)) {
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
      || await detectImageMimeType(targetPath) !== asset.mime_type) {
      await fs.rm(targetPath, { force: true }).catch(() => undefined)
      throw new Error(`项目素材“${asset.original_name ?? asset.id}”校验失败，备份未完成。`)
    }
  }
}

function projectBackupPaths(database) {
  const assetRows = database.prepare('SELECT relative_path FROM assets ORDER BY relative_path').all()
  const paths = ['project.json', 'project.sqlite']
  for (const row of assetRows) {
    if (typeof row.relative_path !== 'string'
      || !/^assets\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp)$/iu.test(row.relative_path)) {
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
  return paths
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

async function safeBackupFilePath(dataDirectory, relativePath) {
  const taskOutputMatch = /^generated\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/([a-z0-9][a-z0-9._-]{0,126})$/iu.exec(relativePath)
  const taskOutputExtensions = ['.txt', '.md', '.json', '.png', '.jpg', '.jpeg', '.webp', '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.mov']
  const isTaskOutput = taskOutputMatch && !taskOutputMatch[2].includes('..')
    && taskOutputExtensions.includes(path.extname(taskOutputMatch[2]).toLowerCase())
  if (relativePath !== 'project.json' && relativePath !== 'project.sqlite'
    && !/^assets\/[a-f0-9]{64}\/[a-f0-9-]{36}\.(?:png|jpg|gif|webp)$/iu.test(relativePath)
    && !isTaskOutput) {
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
  }
  const fileInfo = await fs.lstat(filePath).catch(() => null)
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) throw new Error(`备份文件“${relativePath}”缺失或路径无效。`)
  if (isTaskOutput && (fileInfo.size <= 0 || fileInfo.size > MAX_TASK_OUTPUT_BYTES)) {
    throw new Error(`备份任务结果“${relativePath}”为空或超过本地结果上限。`)
  }
  return filePath
}

async function createBackupManifest(dataDirectory, metadata, database, createdAt = new Date().toISOString()) {
  const files = []
  for (const relativePath of projectBackupPaths(database)) {
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
  if (!isRecord(manifest) || manifest.schemaVersion !== PROJECT_BACKUP_SCHEMA_VERSION
    || manifest.projectId !== metadata.projectId || typeof manifest.createdAt !== 'string'
    || !Array.isArray(manifest.files) || manifest.files.some((file) => !isRecord(file))) {
    throw new Error('备份校验清单格式无效。')
  }

  const expectedPaths = projectBackupPaths(database).sort()
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
  }
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
    if (schemaVersion !== 2 && schemaVersion !== PROJECT_DB_SCHEMA_VERSION) {
      throw new Error('该备份的项目数据库版本当前不支持恢复。')
    }
    const integrity = database.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('备份项目数据库完整性校验失败。')
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
      throw new Error('备份项目数据库存在无效引用。')
    }
    readDatabaseCanvas(database, metadata)
    await verifyBackupManifest(dataDirectory, metadata, database)
    return { directory, dataDirectory, metadata, database }
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

function extensionForImageMimeType(mimeType) {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' })[mimeType]
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

async function openProjectData(projectDirectory) {
  const directory = await fs.realpath(path.resolve(projectDirectory))
  const dataDirectory = path.join(directory, '.vibepaper')
  const dataDirectoryInfo = await fs.lstat(dataDirectory).catch(() => null)
  if (!dataDirectoryInfo?.isDirectory() || dataDirectoryInfo.isSymbolicLink()) {
    throw new Error('项目数据目录缺失、无效或不能是符号链接。')
  }
  let metadata
  try {
    metadata = await readJson(path.join(dataDirectory, 'project.json'))
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
      throw new Error('所选文件夹不是可读取的 VibePaper 本地项目。')
    }
    throw error
  }
  validateMetadata(metadata)

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
        legacyCanvas = validateLegacyCanvas(
          await readJson(path.join(dataDirectory, 'canvas.json')),
          metadata,
        )
      } catch (error) {
        if (error && error.code === 'ENOENT') throw new Error('项目缺少画布数据库和可迁移的画布文件。')
        throw error
      }
      initializeDatabase(database, metadata, legacyCanvas)
    } else {
      if (version === 1) await migrateDatabaseV1ToV2(database, dataDirectory)
      const migratedVersion = databaseVersion(database)
      if (migratedVersion === 2) await migrateDatabaseV2ToV3(database, dataDirectory)
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

  async function openProject(projectDirectory) {
    return enqueue(async () => {
      const directory = await fs.realpath(path.resolve(projectDirectory))
      if (active?.directory === directory) {
        return { project: publicProject(active.metadata), directory: active.directory }
      }
      const next = await openProjectData(directory)
      const previous = active
      active = next
      if (previous?.metadata.projectId !== next.metadata.projectId) previewDigestCache.clear()
      if (previous && previous.database !== next.database) await closeProjectData(previous)
      return { project: publicProject(next.metadata), directory: next.directory }
    })
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
        await copyProjectAssets(active.database, path.join(active.directory, '.vibepaper'), stagingData)
        await copyProjectTaskOutputs(active.database, path.join(active.directory, '.vibepaper'), stagingData)
        await backup(active.database, path.join(stagingData, 'project.sqlite'))
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

  function importAsset(sourcePath, projectId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法导入素材。')
      const { assetsDirectory } = await projectAssetsDirectory(active.directory)
      const temporaryPath = path.join(assetsDirectory, `.import-${randomUUID()}.tmp`)
      try {
        const copied = await copyAssetSource(sourcePath, temporaryPath)
        const mimeType = await detectImageMimeType(temporaryPath)
        const existing = active.database.prepare(`
          SELECT a.id, a.sha256, a.original_name, a.mime_type, a.size_bytes, a.created_at,
            (SELECT COUNT(*) FROM asset_references r WHERE r.asset_id = a.id) AS reference_count
          FROM assets a WHERE a.sha256 = ?
        `).get(copied.sha256)
        if (existing) {
          await fs.rm(temporaryPath, { force: true })
          return publicAsset(existing)
        }

        const assetId = randomUUID()
        const extension = extensionForImageMimeType(mimeType)
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
            INSERT INTO assets (id, sha256, original_name, mime_type, size_bytes, relative_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(assetId, copied.sha256, originalName, mimeType, copied.sizeBytes, relativePath, createdAt)
          active.database.exec('COMMIT')
        } catch (error) {
          active.database.exec('ROLLBACK')
          await fs.rm(destination, { force: true }).catch(() => undefined)
          throw error
        }
        return { assetId, name: originalName, mimeType, sizeBytes: copied.sizeBytes, createdAt, referenceCount: 0 }
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
    })
  }

  function listAssets(projectId) {
    return enqueue(async () => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取素材。')
      return active.database.prepare(`
        SELECT a.id AS assetId, a.original_name AS name, a.mime_type AS mimeType,
          a.size_bytes AS sizeBytes, a.created_at AS createdAt,
          (SELECT COUNT(*) FROM asset_references r WHERE r.asset_id = a.id) AS referenceCount
        FROM assets a ORDER BY a.created_at DESC, a.id
      `).all()
    })
  }

  function resolveAsset(assetId) {
    return enqueue(async () => {
      if (!active || typeof assetId !== 'string') throw new Error('本地素材不可用。')
      const asset = active.database.prepare('SELECT mime_type, relative_path FROM assets WHERE id = ?').get(assetId)
      if (!asset || !asset.relative_path.startsWith('assets/')) throw new Error('本地素材不存在。')
      const dataDirectory = path.resolve(active.directory, '.vibepaper')
      const filePath = path.resolve(dataDirectory, asset.relative_path)
      const relativePath = path.relative(dataDirectory, filePath)
      if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error('本地素材路径无效。')
      }
      if (!/^assets[\\/][a-f0-9]{64}[\\/][a-f0-9-]{36}\.(?:png|jpg|gif|webp)$/iu.test(asset.relative_path)) {
        throw new Error('本地素材路径格式无效。')
      }
      const assetDirectory = path.dirname(filePath)
      const directoryInfo = await fs.lstat(assetDirectory).catch(() => null)
      if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()
        || path.relative(assetDirectory, await fs.realpath(assetDirectory)) !== '') {
        throw new Error('本地素材目录缺失或路径无效。')
      }
      const fileInfo = await fs.lstat(filePath).catch(() => null)
      if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) throw new Error('本地素材文件缺失或无法读取。')
      return { filePath: await fs.realpath(filePath), mimeType: asset.mime_type }
    })
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
          normalized.parametersJson,
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

  function listTasks(projectId, limit = 100) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务。')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('任务列表上限无效。')
      return active.database.prepare('SELECT * FROM tasks ORDER BY created_at DESC, task_id LIMIT ?')
        .all(limit).map(taskFromRow)
    })
  }

  function getTask(projectId, taskId) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const row = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
      return row ? taskFromRow(row) : null
    })
  }

  function getTaskInput(projectId, taskId) {
    return enqueue(() => {
      if (!active || projectId !== active.metadata.projectId) throw new Error('当前项目已更改，无法读取任务输入。')
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务标识无效。')
      const row = active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)
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
      if (!row || row.status !== 'succeeded' || !['image', 'video'].includes(row.modality)) {
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
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
      }[extension]
      if (!mimeType || (row.modality === 'image' && !mimeType.startsWith('image/'))
        || (row.modality === 'video' && !mimeType.startsWith('video/'))) {
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

  function recordTaskSucceeded(projectId, taskId, outputPath) {
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
        return taskFromRow(current)
      }
      if (current.status !== 'running') throw new Error('TASK_STATE_CONFLICT')
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
        }, now)
        active.database.exec('COMMIT')
        return taskFromRow(active.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId))
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

  function saveCanvas(input) {
    return enqueue(async () => {
      if (!active || !isRecord(input)
        || input.projectId !== active.metadata.projectId || input.canvasId !== active.metadata.canvasId) {
        throw new Error('当前项目已更改，画布没有保存。')
      }
      if (input.expectedVersion !== active.canvas.version) {
        throw new Error('画布版本已变化，请重新打开项目后再保存。')
      }

      const graph = validateGraph(input.nodes, input.edges)
      const database = active.database
      await invalidateBackupManifest(path.join(active.directory, '.vibepaper'))
      database.exec('BEGIN IMMEDIATE')
      try {
        const persistedVersion = database.prepare('SELECT version FROM canvases WHERE id = ?').get(active.metadata.canvasId)
        if (!persistedVersion || persistedVersion.version !== input.expectedVersion) {
          throw new Error('画布版本已被其他操作更新，请重新打开项目后再保存。')
        }

        database.prepare('DELETE FROM edges WHERE canvas_id = ?').run(active.metadata.canvasId)
        database.prepare('DELETE FROM nodes WHERE canvas_id = ?').run(active.metadata.canvasId)
        insertGraph(database, active.metadata.canvasId, graph)
        insertAssetReferences(database, active.metadata.canvasId, graph)
        const nextVersion = input.expectedVersion + 1
        const update = database.prepare('UPDATE canvases SET version = ?, updated_at = ? WHERE id = ? AND version = ?')
          .run(nextVersion, new Date().toISOString(), active.metadata.canvasId, input.expectedVersion)
        if (update.changes !== 1) throw new Error('画布版本已被其他操作更新，请重新打开项目后再保存。')
        database.exec('COMMIT')

        active.canvas = {
          schemaVersion: CANVAS_SCHEMA_VERSION,
          projectId: active.metadata.projectId,
          canvasId: active.metadata.canvasId,
          version: nextVersion,
          ...graph,
        }
        return { version: nextVersion }
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
    backupProject,
    cancelTask,
    claimNextTask,
    close,
    createProject,
    createTask,
    getActiveProject,
    getTask,
    getTaskInput,
    importAsset,
    listAssets,
    listTaskEvents,
    listTasks,
    readTaskOutputText,
    resolveTaskOutputForPreview,
    loadCanvas,
    openProject,
    recordTaskFailed,
    recordTaskSucceeded,
    resolveAsset,
    restoreBackup,
    saveCanvas,
  }
}

function publicAsset(row) {
  return {
    assetId: row.id ?? row.assetId,
    name: row.original_name ?? row.name,
    mimeType: row.mime_type ?? row.mimeType,
    sizeBytes: Number(row.size_bytes ?? row.sizeBytes),
    createdAt: row.created_at ?? row.createdAt,
    referenceCount: Number(row.reference_count ?? row.referenceCount ?? 0),
  }
}

module.exports = { createLocalProjectStore }
