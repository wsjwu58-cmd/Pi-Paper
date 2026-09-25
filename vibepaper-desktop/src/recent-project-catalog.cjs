const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const RECENT_PROJECTS_SCHEMA_VERSION = 1
const MAX_CATALOG_BYTES = 8 * 1024 * 1024
const MAX_RECENT_PROJECTS = 2000

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateProjectSummary(project) {
  if (!isRecord(project)
    || typeof project.projectId !== 'string' || !project.projectId || project.projectId.length > 200
    || typeof project.canvasId !== 'string' || !project.canvasId || project.canvasId.length > 200
    || typeof project.name !== 'string' || !project.name || project.name.length > 200) {
    throw new Error('本地项目身份无效。')
  }
  return {
    projectId: project.projectId,
    canvasId: project.canvasId,
    name: project.name,
  }
}

function validateCatalogEntry(entry) {
  if (!isRecord(entry)
    || Object.keys(entry).some((key) => !['projectId', 'canvasId', 'name', 'directory', 'lastOpenedAt'].includes(key))
    || typeof entry.directory !== 'string' || !path.isAbsolute(entry.directory)
    || typeof entry.lastOpenedAt !== 'string' || !Number.isFinite(Date.parse(entry.lastOpenedAt))) {
    throw new Error('最近项目清单包含无效记录。')
  }
  return {
    ...validateProjectSummary(entry),
    directory: path.resolve(entry.directory),
    lastOpenedAt: entry.lastOpenedAt,
  }
}

function createRecentProjectCatalog({ catalogFile, legacyFile, inspectProject }) {
  if (typeof catalogFile !== 'string' || !path.isAbsolute(catalogFile)
    || typeof legacyFile !== 'string' || !path.isAbsolute(legacyFile)
    || typeof inspectProject !== 'function') {
    throw new Error('最近项目清单设置无效。')
  }

  let serial = Promise.resolve()
  function enqueue(operation) {
    const result = serial.then(operation)
    serial = result.then(() => undefined, () => undefined)
    return result
  }

  async function readJsonFile(filePath) {
    let content
    try {
      const info = await fs.lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CATALOG_BYTES) {
        throw new Error('最近项目清单文件无效或超过大小上限。')
      }
      content = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    try {
      return JSON.parse(content)
    } catch {
      throw new Error('最近项目清单 JSON 格式无效。')
    }
  }

  async function readCatalog() {
    const document = await readJsonFile(catalogFile)
    if (document === null) return { exists: false, entries: [] }
    if (!isRecord(document) || document.schemaVersion !== RECENT_PROJECTS_SCHEMA_VERSION
      || !Array.isArray(document.projects) || document.projects.length > MAX_RECENT_PROJECTS) {
      throw new Error('最近项目清单版本或结构无效。')
    }
    const entries = document.projects.map(validateCatalogEntry)
    if (new Set(entries.map((entry) => entry.projectId)).size !== entries.length) {
      throw new Error('最近项目清单包含重复的项目身份。')
    }
    return { exists: true, entries }
  }

  async function readLegacyDirectory() {
    const legacy = await readJsonFile(legacyFile)
    if (!isRecord(legacy) || legacy.schemaVersion !== 1
      || typeof legacy.projectDirectory !== 'string' || !path.isAbsolute(legacy.projectDirectory)) return null
    return path.resolve(legacy.projectDirectory)
  }

  async function inspect(directory, expectedIdentity) {
    const result = await inspectProject(directory, expectedIdentity)
    if (!isRecord(result) || typeof result.directory !== 'string' || !path.isAbsolute(result.directory)) {
      throw new Error('本地项目检查结果无效。')
    }
    return {
      project: validateProjectSummary(result.project),
      directory: path.resolve(result.directory),
    }
  }

  async function writeJsonAtomically(filePath, payload, prefix) {
    const temporaryPath = path.join(path.dirname(filePath), `.${prefix}.${randomUUID()}.tmp`)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    let handle
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
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

  async function writeEntries(entries) {
    if (entries.length > MAX_RECENT_PROJECTS) throw new Error('最近项目数量超过本地清单上限。')
    await writeJsonAtomically(catalogFile, {
      schemaVersion: RECENT_PROJECTS_SCHEMA_VERSION,
      projects: entries,
    }, 'recent-projects')
  }

  async function recordWithinQueue(directory) {
    const checked = await inspect(directory)
    const { entries } = await readCatalog()
    const entry = {
      ...checked.project,
      directory: checked.directory,
      lastOpenedAt: new Date().toISOString(),
    }
    const next = [entry, ...entries.filter((candidate) => candidate.projectId !== entry.projectId)]
    // Keep the old single-project file for startup and downgrade compatibility.
    await writeJsonAtomically(legacyFile, {
      schemaVersion: 1,
      projectDirectory: checked.directory,
    }, 'recent-project')
    await writeEntries(next)
    return checked.project
  }

  async function listVerifiedWithinQueue() {
    const { exists, entries } = await readCatalog()
    const verified = []
    const validStoredIds = new Set()
    for (const entry of entries) {
      try {
        const checked = await inspect(entry.directory, {
          projectId: entry.projectId,
          canvasId: entry.canvasId,
        })
        verified.push({
          project: checked.project,
          directory: checked.directory,
          lastOpenedAt: entry.lastOpenedAt,
        })
        validStoredIds.add(checked.project.projectId)
      } catch {
        // Stale, moved, or identity-mismatched records remain on disk but are not offered to the UI.
      }
    }

    let legacyDirectory = null
    try {
      legacyDirectory = await readLegacyDirectory()
    } catch {
      // A malformed legacy single-project file must not hide a valid new catalog.
    }
    if (legacyDirectory) {
      try {
        const checked = await inspect(legacyDirectory)
        if (!validStoredIds.has(checked.project.projectId)) {
          const entry = {
            ...checked.project,
            directory: checked.directory,
            lastOpenedAt: new Date().toISOString(),
          }
          verified.unshift({ ...entry, project: checked.project })
          validStoredIds.add(checked.project.projectId)
          if (exists) await writeEntries([entry, ...entries.filter((item) => item.projectId !== entry.projectId)])
          else await writeEntries([entry])
        }
      } catch {
        // Keep a broken legacy path for compatibility; it is omitted from the validated project list.
      }
    }

    verified.sort((left, right) => Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt))
    return verified
  }

  return {
    listRecentProjects() {
      return enqueue(async () => (await listVerifiedWithinQueue()).map((entry) => entry.project))
    },
    record(directory) {
      return enqueue(() => recordWithinQueue(directory))
    },
    resolve(projectId) {
      return enqueue(async () => {
        if (typeof projectId !== 'string' || !projectId || projectId.length > 200) {
          throw new Error('最近项目标识无效。')
        }
        const entry = (await listVerifiedWithinQueue()).find((candidate) => candidate.project.projectId === projectId)
        if (!entry) throw new Error('最近项目不存在或项目身份已变化，请从项目目录重新打开。')
        return { project: entry.project, directory: entry.directory }
      })
    },
  }
}

module.exports = { createRecentProjectCatalog }
