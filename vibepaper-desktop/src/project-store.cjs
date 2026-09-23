const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const PROJECT_SCHEMA_VERSION = 1
const CANVAS_SCHEMA_VERSION = 1
const MAX_NODES = 10_000
const MAX_EDGES = 20_000
const MAX_CANVAS_BYTES = 32 * 1024 * 1024

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

function publicProject(project) {
  return {
    projectId: project.projectId,
    canvasId: project.canvasId,
    name: project.name,
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

function validateProject(projectDirectory, metadata, canvas) {
  if (!isRecord(metadata) || metadata.schemaVersion !== PROJECT_SCHEMA_VERSION
    || typeof metadata.projectId !== 'string' || !metadata.projectId
    || typeof metadata.canvasId !== 'string' || !metadata.canvasId
    || typeof metadata.name !== 'string') {
    throw new Error('所选文件夹的项目格式不受支持。')
  }
  if (!isRecord(canvas) || canvas.schemaVersion !== CANVAS_SCHEMA_VERSION
    || canvas.projectId !== metadata.projectId || canvas.canvasId !== metadata.canvasId
    || !Number.isSafeInteger(canvas.version) || canvas.version < 0) {
    throw new Error('项目画布文件损坏或版本不受支持。')
  }
  const graph = validateGraph(canvas.nodes, canvas.edges)
  return {
    directory: projectDirectory,
    metadata,
    canvas: { ...canvas, ...graph },
  }
}

async function readProjectDirectory(projectDirectory) {
  const root = path.resolve(projectDirectory)
  let metadata
  let canvas
  try {
    metadata = await readJson(path.join(root, '.vibepaper', 'project.json'))
    canvas = await readJson(path.join(root, '.vibepaper', 'canvas.json'))
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
      throw new Error('所选文件夹不是可读取的 VibePaper 本地项目。')
    }
    throw error
  }
  return validateProject(root, metadata, canvas)
}

function createDesktopProjectStore({ app, dialog, getWindow }) {
  const recentProjectPath = path.join(app.getPath('userData'), 'recent-project.json')
  let active = null
  let serial = Promise.resolve()

  function enqueue(operation) {
    const result = serial.then(operation)
    serial = result.then(() => undefined, () => undefined)
    return result
  }

  async function persistRecentProject(projectDirectory) {
    await writeJsonAtomically(recentProjectPath, { schemaVersion: 1, projectDirectory })
  }

  async function activate(project) {
    return enqueue(async () => {
      active = project
      await persistRecentProject(project.directory)
      return publicProject(project.metadata)
    })
  }

  async function restoreRecentProject() {
    try {
      const recent = await readJson(recentProjectPath)
      if (!isRecord(recent) || recent.schemaVersion !== 1 || typeof recent.projectDirectory !== 'string') return null
      return await activate(await readProjectDirectory(recent.projectDirectory))
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        await fs.rm(recentProjectPath, { force: true }).catch(() => undefined)
      }
      active = null
      return null
    }
  }

  async function createProject(nameValue) {
    const name = validateProjectName(nameValue)
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '选择新项目的保存位置',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const parent = path.resolve(result.filePaths[0])
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
      const canvas = {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        projectId: metadata.projectId,
        canvasId: metadata.canvasId,
        version: 0,
        nodes: [],
        edges: [],
      }
      await writeJsonAtomically(path.join(staging, 'project.json'), metadata)
      await writeJsonAtomically(path.join(staging, 'canvas.json'), canvas)
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

    return activate(await readProjectDirectory(destination))
  }

  async function openProject() {
    const result = await dialog.showOpenDialog(getWindow(), {
      title: '打开 VibePaper 本地项目',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return activate(await readProjectDirectory(result.filePaths[0]))
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

      const canvasPath = path.join(active.directory, '.vibepaper', 'canvas.json')
      const diskCanvas = await readJson(canvasPath)
      if (!isRecord(diskCanvas) || diskCanvas.version !== active.canvas.version
        || diskCanvas.projectId !== active.metadata.projectId || diskCanvas.canvasId !== active.metadata.canvasId) {
        throw new Error('项目文件已在其他位置更新，请重新打开项目后再保存。')
      }

      const graph = validateGraph(input.nodes, input.edges)
      const nextCanvas = {
        schemaVersion: CANVAS_SCHEMA_VERSION,
        projectId: active.metadata.projectId,
        canvasId: active.metadata.canvasId,
        version: active.canvas.version + 1,
        ...graph,
      }
      await writeJsonAtomically(canvasPath, nextCanvas)
      active.canvas = nextCanvas
      return { version: nextCanvas.version }
    })
  }

  return {
    createProject,
    getActiveProject,
    loadCanvas,
    openProject,
    restoreRecentProject,
    saveCanvas,
  }
}

module.exports = { createDesktopProjectStore }
