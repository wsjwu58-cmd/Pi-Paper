const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')
const { openDesktopAgentStores } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/agent-stores.ts')
const { DesktopSessionFragments } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/session-fragments.ts')
const { SessionRunService } = require('../../pi-main/packages/vibepaper-agent-service/src/application/session-run-service.ts')
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
  const previousControl = new DatabaseSync(path.join(source.directory, '.vibepaper', 'agent', 'control.sqlite'))
  try {
    previousControl.exec('DROP TABLE desktop_task_continuations; PRAGMA user_version = 5')
  } finally {
    previousControl.close()
  }
  sourceAgentStores = await openDesktopAgentStores(source.directory)
  const migrationSnapshots = (await fs.readdir(path.join(source.directory, '.vibepaper', 'agent')))
    .filter((name) => /^control-v5-.*\.pre-migration\.sqlite$/u.test(name))
  assert.equal(migrationSnapshots.length, 1)
  const runs = new SessionRunService(sourceAgentStores.control)
  const origin = await runs.startRun({ sessionId: session.id, idempotencyKey: 'restore-continuation-origin' })
  await runs.setStatus(origin.runId, 'waiting_task')
  sourceAgentStores.control.linkTask({
    taskId: 'restore-terminal-task', sessionId: session.id, runId: origin.runId,
    nodeId: 'restore-node', status: 'queued',
  })
  sourceAgentStores.control.recordTaskStatus({ taskId: 'restore-terminal-task', status: 'succeeded' },
    { projectId: source.project.projectId })
  assert.equal(sourceAgentStores.control.listPendingTaskContinuations(source.project.projectId).length, 1)
  await sourceAgentStores.close()
  sourceAgentStores = undefined

  const backup = await store.backupProject(backupsDirectory, source.project.projectId)
  const restored = await store.restoreBackup(backup.directory, restoredDirectory)
  assert.notEqual(restored.project.projectId, source.project.projectId)

  restoredAgentStores = await openDesktopAgentStores(restored.directory)
  assert.equal((await fs.readdir(path.join(restored.directory, '.vibepaper', 'agent')))
    .some((name) => name.endsWith('.pre-migration.sqlite')), false)
  const restoredContinuation = restoredAgentStores.control.findTaskContinuationForRun(origin.runId)
  assert.equal(restoredContinuation.projectId, restored.project.projectId)
  assert.equal(restoredContinuation.status, 'invalidated')
  assert.equal(restoredAgentStores.control.listPendingTaskContinuations(restored.project.projectId).length, 0)
  const claim = await restoredAgentStores.control.claimTaskContinuation({
    originRunId: origin.runId, projectId: restored.project.projectId, apiKey: 'test-only-key',
  })
  assert.equal(claim.status, 'invalidated')
  assert.equal(restoredAgentStores.control.findByIdempotency(session.id, `task-continuation:${origin.runId}`), undefined)
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
