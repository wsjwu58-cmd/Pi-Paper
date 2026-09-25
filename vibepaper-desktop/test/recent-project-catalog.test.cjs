const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createRecentProjectCatalog } = require('../src/recent-project-catalog.cjs')

async function setup(t) {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-recent-projects-'))
  const projectDirectory = path.join(userData, 'project-one')
  const otherDirectory = path.join(userData, 'project-two')
  await fs.mkdir(projectDirectory)
  await fs.mkdir(otherDirectory)
  const projects = new Map([
    [projectDirectory, { projectId: 'project-one-id', canvasId: 'canvas-one-id', name: '项目一' }],
    [otherDirectory, { projectId: 'project-two-id', canvasId: 'canvas-two-id', name: '项目二' }],
  ])
  const catalog = createRecentProjectCatalog({
    catalogFile: path.join(userData, 'recent-projects.json'),
    legacyFile: path.join(userData, 'recent-project.json'),
    inspectProject: async (directory, expectedIdentity) => {
      const resolved = await fs.realpath(directory)
      const project = projects.get(resolved)
      if (!project) throw new Error('项目不存在')
      if (expectedIdentity && (expectedIdentity.projectId !== project.projectId
        || expectedIdentity.canvasId !== project.canvasId)) throw new Error('项目身份不匹配')
      return { project, directory: resolved }
    },
  })
  t.after(() => fs.rm(userData, { recursive: true, force: true }))
  return { catalog, userData, projectDirectory, otherDirectory }
}

test('recent project catalog migrates the legacy single-project file without deleting it', async (t) => {
  const { catalog, userData, projectDirectory } = await setup(t)
  const legacyPath = path.join(userData, 'recent-project.json')
  const legacyContent = `${JSON.stringify({ schemaVersion: 1, projectDirectory })}\n`
  await fs.writeFile(legacyPath, legacyContent)

  const projects = await catalog.listRecentProjects()
  assert.deepEqual(projects, [{ projectId: 'project-one-id', canvasId: 'canvas-one-id', name: '项目一' }])
  assert.equal(await fs.readFile(legacyPath, 'utf8'), legacyContent)
  const stored = JSON.parse(await fs.readFile(path.join(userData, 'recent-projects.json'), 'utf8'))
  assert.equal(stored.schemaVersion, 1)
  assert.equal(stored.projects[0].projectId, 'project-one-id')
  assert.equal(stored.projects[0].directory, projectDirectory)
})

test('recent project list returns only identity-verified summaries and resolves by project ID', async (t) => {
  const { catalog, userData, projectDirectory, otherDirectory } = await setup(t)
  await catalog.record(projectDirectory)
  await catalog.record(otherDirectory)

  const listed = await catalog.listRecentProjects()
  assert.deepEqual(listed.map((project) => project.projectId), ['project-two-id', 'project-one-id'])
  assert.ok(listed.every((project) => !Object.hasOwn(project, 'directory')))
  assert.deepEqual(await catalog.resolve('project-two-id'), {
    project: { projectId: 'project-two-id', canvasId: 'canvas-two-id', name: '项目二' },
    directory: otherDirectory,
  })
  await assert.rejects(catalog.resolve('../outside'), /最近项目不存在/u)

  const catalogPath = path.join(userData, 'recent-projects.json')
  const stored = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
  stored.projects.find((project) => project.projectId === 'project-one-id').canvasId = 'replaced-canvas-id'
  await fs.writeFile(catalogPath, JSON.stringify(stored))
  assert.deepEqual(await catalog.listRecentProjects(), [
    { projectId: 'project-two-id', canvasId: 'canvas-two-id', name: '项目二' },
  ])
  await assert.rejects(catalog.resolve('project-one-id'), /最近项目不存在/u)
})

test('malformed legacy recent-project file does not hide a valid catalog or get deleted', async (t) => {
  const { catalog, userData, projectDirectory } = await setup(t)
  await catalog.record(projectDirectory)
  const legacyPath = path.join(userData, 'recent-project.json')
  await fs.writeFile(legacyPath, '{broken json')

  assert.deepEqual(await catalog.listRecentProjects(), [
    { projectId: 'project-one-id', canvasId: 'canvas-one-id', name: '项目一' },
  ])
  assert.equal(await fs.readFile(legacyPath, 'utf8'), '{broken json')
})
