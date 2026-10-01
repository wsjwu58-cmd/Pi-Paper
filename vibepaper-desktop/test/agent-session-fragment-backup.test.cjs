const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { openDesktopAgentStores } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/agent-stores.ts')
const { DesktopSessionFragments } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/session-fragments.ts')
const { createLocalProjectStore } = require('../src/project-store.cjs')

test('session fragments survive a real project backup and restore identity change', async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-session-fragment-restore-'))
  const projectsDirectory = path.join(temporaryDirectory, 'projects')
  const backupsDirectory = path.join(temporaryDirectory, 'backups')
  const restoredDirectory = path.join(temporaryDirectory, 'restored')
  await Promise.all([projectsDirectory, backupsDirectory, restoredDirectory].map((directory) => fs.mkdir(directory)))
  const store = createLocalProjectStore()
  let sourceAgentStores
  let restoredAgentStores
  t.after(async () => {
    await restoredAgentStores?.close()
    await sourceAgentStores?.close()
    await store.close()
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  })

  const source = await store.createProject(projectsDirectory, 'Fragment Source')
  sourceAgentStores = await openDesktopAgentStores(source.directory)
  const sourceFragments = new DesktopSessionFragments(
    sourceAgentStores.projectDirectory,
    sourceAgentStores.projectId,
    sourceAgentStores.sessions,
  )
  await sourceFragments.initialize()
  const session = await sourceAgentStores.sessions.createSession('片段来源')
  await sourceAgentStores.sessions.appendMessage(session.id, {
    role: 'user',
    content: '恢复后仍可读取',
    timestamp: Date.now(),
  })
  const saved = await sourceFragments.save(session.id, '备份片段')
  await sourceAgentStores.close()
  sourceAgentStores = undefined

  const backup = await store.backupProject(backupsDirectory, source.project.projectId)
  const restored = await store.restoreBackup(backup.directory, restoredDirectory)
  assert.notEqual(restored.project.projectId, source.project.projectId)

  restoredAgentStores = await openDesktopAgentStores(restored.directory)
  const restoredFragments = new DesktopSessionFragments(
    restoredAgentStores.projectDirectory,
    restoredAgentStores.projectId,
    restoredAgentStores.sessions,
  )
  await restoredFragments.initialize()
  assert.deepEqual(await restoredFragments.list(), await sourceFragments.list())

  const imported = await restoredFragments.import(saved.fragmentId, restored.project.canvasId)
  const transcript = await restoredAgentStores.sessions.listTranscriptMessages(imported.sessionId)
  assert.deepEqual(transcript.map(({ message }) => message.role), ['user'])
  assert.equal(transcript[0].message.content, '恢复后仍可读取')
  const restoredFile = path.join(
    restored.directory,
    '.vibepaper',
    'agent',
    'fragments',
    `${saved.fragmentId}.json`,
  )
  assert.equal(JSON.parse(await fs.readFile(restoredFile, 'utf8')).id, saved.fragmentId)
})
