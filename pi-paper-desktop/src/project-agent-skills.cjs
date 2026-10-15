const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const { loadSkillsFromDir } = require('../../pi-main/packages/coding-agent/src/core/skill-loader.ts')
const { parseFrontmatter } = require('../../pi-main/packages/coding-agent/src/utils/frontmatter.ts')
const { stringify } = require('../../pi-main/node_modules/yaml')

const MAX_SKILL_BYTES = 512 * 1024
const MAX_TREE_ENTRIES = 10_000
const SKILL_CATEGORIES = new Set(['general', 'image', 'video', 'text', 'canvas'])
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,159}$/u

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') throw new Error('SKILL_NAME_INVALID')
  const name = value.trim()
  if (!name || name.length > 64) throw new Error('SKILL_NAME_INVALID')
  return name
}

function normalizeDescription(value, fallback) {
  const description = typeof value === 'string' ? value.trim() : ''
  if (description.length > 1024) throw new Error('SKILL_DESCRIPTION_INVALID')
  return description || fallback
}

function normalizeCategory(value) {
  const category = typeof value === 'string' ? value.trim() : 'general'
  if (!SKILL_CATEGORIES.has(category)) throw new Error('SKILL_CATEGORY_INVALID')
  return category
}

function normalizeInstructions(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('SKILL_INSTRUCTIONS_INVALID')
  if (Buffer.byteLength(value, 'utf8') > MAX_SKILL_BYTES) throw new Error('SKILL_FILE_TOO_LARGE')
  return value.trim()
}

function slugify(value) {
  const slug = value.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 36).replace(/-+$/gu, '')
  return slug || 'skill'
}

function skillIdFor(name) {
  return `project-${slugify(name)}-${crypto.randomUUID().slice(0, 8)}`
}

function isWithin(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

async function requirePlainDirectory(directory, parent) {
  const info = await fs.lstat(directory).catch((error) => {
    if (error && error.code === 'ENOENT') return null
    throw error
  })
  if (!info) {
    await fs.mkdir(directory, { mode: 0o700 })
  } else if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('SKILL_DIRECTORY_INVALID')
  }
  const realDirectory = await fs.realpath(directory)
  if (!isWithin(parent, realDirectory) || realDirectory !== directory) throw new Error('SKILL_PATH_OUTSIDE_PROJECT')
}

async function projectSkillRoot(projectDirectory) {
  if (typeof projectDirectory !== 'string' || !projectDirectory.trim()) throw new Error('AGENT_PROJECT_PATH_INVALID')
  const projectRoot = await fs.realpath(path.resolve(projectDirectory))
  const dataRoot = path.join(projectRoot, '.vibepaper')
  const agentRoot = path.join(dataRoot, 'agent')
  const skillsRoot = path.join(agentRoot, 'skills')
  for (const [directory, parent] of [[dataRoot, projectRoot], [agentRoot, dataRoot]]) {
    const info = await fs.lstat(directory).catch((error) => {
      if (error && error.code === 'ENOENT') return null
      throw error
    })
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('SKILL_PROJECT_STORAGE_INVALID')
    const realDirectory = await fs.realpath(directory)
    if (realDirectory !== directory || !isWithin(parent, realDirectory)) throw new Error('SKILL_PATH_OUTSIDE_PROJECT')
  }
  await requirePlainDirectory(skillsRoot, agentRoot)
  return skillsRoot
}

async function assertNoSymlinks(root) {
  let visited = 0
  const visit = async (directory, depth) => {
    if (depth > 64) throw new Error('SKILL_DIRECTORY_TOO_DEEP')
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      visited += 1
      if (visited > MAX_TREE_ENTRIES) throw new Error('SKILL_DIRECTORY_TOO_LARGE')
      const target = path.join(directory, entry.name)
      const info = await fs.lstat(target)
      if (info.isSymbolicLink()) throw new Error('SKILL_SYMLINK_UNSUPPORTED')
      if (info.isDirectory()) {
        const realDirectory = await fs.realpath(target)
        if (!isWithin(root, realDirectory) || realDirectory !== target) throw new Error('SKILL_PATH_OUTSIDE_PROJECT')
        await visit(target, depth + 1)
      }
    }
  }
  await visit(root, 0)
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

function skillMetadata(frontmatter) {
  const metadata = isRecord(frontmatter.metadata) ? frontmatter.metadata : {}
  const appMetadata = isRecord(metadata.vibepaper) ? metadata.vibepaper : {}
  return appMetadata
}

function toProjectSkill(skill, skillsRoot, rawContent) {
  const relativePath = path.relative(skillsRoot, skill.filePath)
  if (!relativePath || !isWithin(skillsRoot, path.resolve(skill.filePath))) throw new Error('SKILL_PATH_OUTSIDE_PROJECT')
  const id = relativePath.endsWith('.md') && !relativePath.includes(path.sep)
    ? path.basename(relativePath, '.md')
    : path.relative(skillsRoot, skill.baseDir).split(path.sep).join('/')
  const { frontmatter, body } = parseFrontmatter(rawContent)
  const appMetadata = skillMetadata(frontmatter)
  const metadataId = asText(appMetadata.id)
  const safeId = metadataId && metadataId === id && SKILL_ID_PATTERN.test(metadataId) ? metadataId : id
  const displayName = normalizeDisplayName(asText(appMetadata.displayName) || skill.name)
  const categoryValue = asText(appMetadata.category) || 'general'
  const category = SKILL_CATEGORIES.has(categoryValue) ? categoryValue : 'general'
  const versionValue = appMetadata.version
  const version = Number.isSafeInteger(versionValue) && versionValue > 0 ? versionValue : 1
  return {
    id: safeId,
    key: safeId,
    name: displayName,
    description: skill.description,
    instructions: body,
    source: 'project',
    category,
    version,
    enabled: appMetadata.enabled !== false,
  }
}

async function listProjectAgentSkills(projectDirectory, keyword) {
  const skillsRoot = await projectSkillRoot(projectDirectory)
  await assertNoSymlinks(skillsRoot)
  const loaded = loadSkillsFromDir({ dir: skillsRoot, source: 'project' })
  const skills = []
  for (const entry of loaded.skills) {
    const filePath = path.resolve(entry.filePath)
    if (!isWithin(skillsRoot, filePath)) throw new Error('SKILL_PATH_OUTSIDE_PROJECT')
    const fileInfo = await fs.lstat(filePath)
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_SKILL_BYTES) continue
    const rawContent = await fs.readFile(filePath, 'utf8')
    try {
      skills.push(toProjectSkill(entry, skillsRoot, rawContent))
    } catch (error) {
      if (error instanceof Error && error.message === 'SKILL_NAME_INVALID') continue
      throw error
    }
  }
  const normalizedKeyword = typeof keyword === 'string' ? keyword.trim().toLocaleLowerCase() : ''
  return skills.filter((skill) => !normalizedKeyword || [skill.id, skill.name, skill.description, skill.instructions]
    .some((value) => value.toLocaleLowerCase().includes(normalizedKeyword)))
}

async function ensureUniqueName(projectDirectory, name, reservedNames = [], exceptId) {
  const normalizedName = name.toLocaleLowerCase()
  if (reservedNames.some((candidate) => typeof candidate === 'string' && candidate.toLocaleLowerCase() === normalizedName)) {
    throw new Error('SKILL_NAME_COLLISION')
  }
  const skills = await listProjectAgentSkills(projectDirectory)
  if (skills.some((skill) => skill.id !== exceptId && skill.name.toLocaleLowerCase() === normalizedName)) {
    throw new Error('SKILL_NAME_COLLISION')
  }
}

function buildSkillDocument({ id, name, description, category, version, enabled, instructions, priorFrontmatter = {} }) {
  const frontmatter = { ...priorFrontmatter }
  frontmatter.name = id
  frontmatter.description = description
  const priorMetadata = isRecord(frontmatter.metadata) ? { ...frontmatter.metadata } : {}
  priorMetadata.vibepaper = {
    schemaVersion: 1,
    id,
    displayName: name,
    category,
    version,
    enabled,
  }
  frontmatter.metadata = priorMetadata
  const yaml = stringify(frontmatter).trimEnd()
  const document = `---\n${yaml}\n---\n\n${instructions.trim()}\n`
  if (Buffer.byteLength(document, 'utf8') > MAX_SKILL_BYTES) throw new Error('SKILL_FILE_TOO_LARGE')
  return document
}

async function atomicWriteFile(targetPath, content, exclusive = false) {
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    if (exclusive) {
      await fs.link(temporaryPath, targetPath)
      await fs.rm(temporaryPath, { force: true })
    } else {
      await fs.rename(temporaryPath, targetPath)
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function managedSkillPath(skillsRoot, skillId) {
  if (typeof skillId !== 'string' || !SKILL_ID_PATTERN.test(skillId)) throw new Error('SKILL_ID_INVALID')
  const targetPath = path.resolve(skillsRoot, `${skillId}.md`)
  if (path.dirname(targetPath) !== skillsRoot) throw new Error('SKILL_ID_INVALID')
  return targetPath
}

async function createProjectAgentSkill(projectDirectory, draft, reservedNames = []) {
  if (!isRecord(draft)) throw new Error('SKILL_INPUT_INVALID')
  const name = normalizeDisplayName(draft.name)
  const description = normalizeDescription(draft.description, name)
  const instructions = normalizeInstructions(draft.instructions)
  const category = normalizeCategory(draft.category)
  await ensureUniqueName(projectDirectory, name, reservedNames)
  const skillsRoot = await projectSkillRoot(projectDirectory)
  const id = skillIdFor(name)
  const targetPath = managedSkillPath(skillsRoot, id)
  const content = buildSkillDocument({ id, name, description, category, version: 1, enabled: true, instructions })
  await atomicWriteFile(targetPath, content, true)
  const created = (await listProjectAgentSkills(projectDirectory)).find((skill) => skill.id === id)
  if (!created) throw new Error('SKILL_CREATE_FAILED')
  return created
}

async function resolveManagedSkill(projectDirectory, skillId) {
  const skillsRoot = await projectSkillRoot(projectDirectory)
  await assertNoSymlinks(skillsRoot)
  const targetPath = managedSkillPath(skillsRoot, skillId)
  const info = await fs.lstat(targetPath).catch((error) => {
    if (error && error.code === 'ENOENT') return null
    throw error
  })
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('SKILL_NOT_FOUND')
  const skill = (await listProjectAgentSkills(projectDirectory)).find((entry) => entry.id === skillId)
  if (!skill || skill.id !== skillId) throw new Error('SKILL_NOT_FOUND')
  const rawContent = await fs.readFile(targetPath, 'utf8')
  const { frontmatter, body } = parseFrontmatter(rawContent)
  return { skillsRoot, targetPath, skill, rawContent, frontmatter, body }
}

async function updateProjectAgentSkill(projectDirectory, skillId, patch, reservedNames = []) {
  if (!isRecord(patch)) throw new Error('SKILL_INPUT_INVALID')
  const current = await resolveManagedSkill(projectDirectory, skillId)
  const appMetadata = skillMetadata(current.frontmatter)
  const name = patch.name === undefined ? current.skill.name : normalizeDisplayName(patch.name)
  const description = patch.description === undefined
    ? current.skill.description
    : normalizeDescription(patch.description, name)
  const category = patch.category === undefined ? current.skill.category : normalizeCategory(patch.category)
  const instructions = patch.instructions === undefined ? current.body : normalizeInstructions(patch.instructions)
  const enabled = patch.enabled === undefined ? current.skill.enabled : patch.enabled
  if (typeof enabled !== 'boolean') throw new Error('SKILL_ENABLED_INVALID')
  await ensureUniqueName(projectDirectory, name, reservedNames, skillId)
  const oldVersion = current.skill.version
  const version = oldVersion + 1
  const historyDirectory = path.join(current.skillsRoot, '.versions')
  await requirePlainDirectory(historyDirectory, current.skillsRoot)
  const historyPath = path.join(historyDirectory, `${skillId}-v${oldVersion}.md`)
  const existingHistory = await fs.lstat(historyPath).catch((error) => {
    if (error && error.code === 'ENOENT') return null
    throw error
  })
  if (!existingHistory) await atomicWriteFile(historyPath, current.rawContent, true)
  const content = buildSkillDocument({
    id: skillId,
    name,
    description,
    category,
    version,
    enabled,
    instructions,
    priorFrontmatter: current.frontmatter,
  })
  await atomicWriteFile(current.targetPath, content)
  const [updated] = await listProjectAgentSkills(projectDirectory, skillId)
  if (!updated) throw new Error('SKILL_UPDATE_FAILED')
  return updated
}

async function importProjectAgentSkill(projectDirectory, fileName, contents, reservedNames = []) {
  if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255
    || (path.extname(fileName).toLowerCase() !== '.md' && path.extname(fileName).toLowerCase() !== '.markdown')) {
    throw new Error('SKILL_IMPORT_FILE_INVALID')
  }
  if (typeof contents !== 'string' || !contents.trim() || Buffer.byteLength(contents, 'utf8') > MAX_SKILL_BYTES) {
    throw new Error('SKILL_FILE_TOO_LARGE')
  }
  let parsed
  try {
    parsed = parseFrontmatter(contents)
  } catch {
    throw new Error('SKILL_FRONTMATTER_INVALID')
  }
  const appMetadata = skillMetadata(parsed.frontmatter)
  const fileDisplayName = path.basename(fileName, path.extname(fileName)).trim()
  const name = normalizeDisplayName(asText(appMetadata.displayName) || asText(parsed.frontmatter.name) || fileDisplayName)
  const description = normalizeDescription(parsed.frontmatter.description, `从文件“${path.basename(fileName)}”导入的 Skill`)
  const categoryValue = asText(appMetadata.category) || 'general'
  const category = normalizeCategory(categoryValue)
  const instructions = normalizeInstructions(parsed.body || contents)
  await ensureUniqueName(projectDirectory, name, reservedNames)
  const skillsRoot = await projectSkillRoot(projectDirectory)
  const id = skillIdFor(name)
  const targetPath = managedSkillPath(skillsRoot, id)
  const content = buildSkillDocument({
    id,
    name,
    description,
    category,
    version: 1,
    enabled: true,
    instructions,
    priorFrontmatter: parsed.frontmatter,
  })
  await atomicWriteFile(targetPath, content, true)
  const created = (await listProjectAgentSkills(projectDirectory)).find((skill) => skill.id === id)
  if (!created) throw new Error('SKILL_IMPORT_FAILED')
  return created
}

async function deleteProjectAgentSkill(projectDirectory, skillId) {
  const current = await resolveManagedSkill(projectDirectory, skillId)
  const deletedDirectory = path.join(current.skillsRoot, '.deleted')
  await requirePlainDirectory(deletedDirectory, current.skillsRoot)
  const destination = path.join(deletedDirectory, `${skillId}-${crypto.randomUUID()}.md`)
  await fs.rename(current.targetPath, destination)
  return { status: 'ok' }
}

module.exports = {
  createProjectAgentSkill,
  deleteProjectAgentSkill,
  importProjectAgentSkill,
  listProjectAgentSkills,
  updateProjectAgentSkill,
}
