const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { backup, DatabaseSync } = require('node:sqlite')

const PROJECT_SCHEMA_VERSION = 1
const CANVAS_SCHEMA_VERSION = 1
const PROJECT_DB_SCHEMA_VERSION = 1
const MAX_NODES = 10_000
const MAX_EDGES = 20_000
const MAX_CANVAS_BYTES = 32 * 1024 * 1024

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
    database.exec(`PRAGMA user_version = ${PROJECT_DB_SCHEMA_VERSION}`)
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
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    projectId: metadata.projectId,
    canvasId: metadata.canvasId,
    version: canvasRow.version,
    ...graph,
  }
}

async function openProjectData(projectDirectory) {
  const directory = path.resolve(projectDirectory)
  let metadata
  try {
    metadata = await readJson(path.join(directory, '.vibepaper', 'project.json'))
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
      throw new Error('所选文件夹不是可读取的 VibePaper 本地项目。')
    }
    throw error
  }
  validateMetadata(metadata)

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath, { timeout: 5000 })
  try {
    setDatabaseMode(database)
    const version = databaseVersion(database)
    if (version === 0) {
      let legacyCanvas
      try {
        legacyCanvas = validateLegacyCanvas(
          await readJson(path.join(directory, '.vibepaper', 'canvas.json')),
          metadata,
        )
      } catch (error) {
        if (error && error.code === 'ENOENT') throw new Error('项目缺少画布数据库和可迁移的画布文件。')
        throw error
      }
      initializeDatabase(database, metadata, legacyCanvas)
    } else if (version !== PROJECT_DB_SCHEMA_VERSION) {
      throw new Error(`本地项目数据库版本 ${version} 当前不受支持。`)
    }
    const canvas = readDatabaseCanvas(database, metadata)
    return { directory, metadata, database, canvas }
  } catch (error) {
    database.close()
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

function createLocalProjectStore() {
  let active = null
  let serial = Promise.resolve()

  function enqueue(operation) {
    const result = serial.then(operation)
    serial = result.then(() => undefined, () => undefined)
    return result
  }

  async function openProject(projectDirectory) {
    return enqueue(async () => {
      const next = await openProjectData(projectDirectory)
      const previous = active
      active = next
      if (previous && previous.database !== next.database) closeDatabase(previous.database)
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
      const relativeToProject = path.relative(active.directory, parent)
      if (relativeToProject === '' || (!path.isAbsolute(relativeToProject)
        && relativeToProject !== '..' && !relativeToProject.startsWith(`..${path.sep}`))) {
        throw new Error('请选择当前项目文件夹之外的备份位置。')
      }
      const parentInfo = await fs.stat(parent).catch(() => null)
      if (!parentInfo?.isDirectory()) throw new Error('备份位置不可用。')

      const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
      const backupName = `${active.metadata.name} Backup ${timestamp} ${randomUUID().slice(0, 8)}`
      const destination = path.join(parent, backupName)
      const staging = path.join(parent, `.vibepaper-backup-${randomUUID()}`)
      const stagingData = path.join(staging, '.vibepaper')
      try {
        await fs.mkdir(staging)
        await fs.mkdir(stagingData)
        await writeJsonAtomically(path.join(stagingData, 'project.json'), active.metadata)
        await backup(active.database, path.join(stagingData, 'project.sqlite'))
        await fs.rename(staging, destination)
      } catch (error) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      return { directory: destination, name: backupName }
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
      database.exec('BEGIN IMMEDIATE')
      try {
        const persistedVersion = database.prepare('SELECT version FROM canvases WHERE id = ?').get(active.metadata.canvasId)
        if (!persistedVersion || persistedVersion.version !== input.expectedVersion) {
          throw new Error('画布版本已被其他操作更新，请重新打开项目后再保存。')
        }

        database.prepare('DELETE FROM edges WHERE canvas_id = ?').run(active.metadata.canvasId)
        database.prepare('DELETE FROM nodes WHERE canvas_id = ?').run(active.metadata.canvasId)
        insertGraph(database, active.metadata.canvasId, graph)
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
      if (active) closeDatabase(active.database)
      active = null
    })
  }

  return {
    backupProject,
    close,
    createProject,
    getActiveProject,
    loadCanvas,
    openProject,
    saveCanvas,
  }
}

module.exports = { createLocalProjectStore }
