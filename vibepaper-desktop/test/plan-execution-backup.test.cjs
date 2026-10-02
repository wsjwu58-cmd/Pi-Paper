const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')
const { openDesktopAgentStores } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/agent-stores.ts')
const { SessionRunService } = require('../../pi-main/packages/vibepaper-agent-service/src/application/session-run-service.ts')
const { createLocalProjectStore } = require('../src/project-store.cjs')

test('restored project preserves plan execution history but invalidates continuation authorization', async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-plan-execution-backup-'))
  const directories = ['projects', 'backups', 'restored'].map((name) => path.join(temporaryDirectory, name))
  await Promise.all(directories.map((directory) => fs.mkdir(directory)))
  const store = createLocalProjectStore()
  let agentStores
  t.after(async () => {
    await agentStores?.close()
    await store.close()
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  })
  const source = await store.createProject(directories[0], '计划执行备份')
  agentStores = await openDesktopAgentStores(source.directory)
  const session = await agentStores.sessions.createSession('待确认计划', source.project.canvasId)
  const planId = '1234567893'
  await agentStores.plans.create({
    ownerId: agentStores.projectId, sessionId: session.id, canvasId: source.project.canvasId,
    expectedVersion: 1, profile: 'canvas-general', plan: {
      id: planId, sessionId: session.id, version: 1, canvasVersion: 0,
      steps: [{ id: 'read', tool: 'get_canvas_summary', dependsOn: [], status: 'pending', inputHash: 'hash', estimatedCost: 0 }],
    },
  })
  const run = await new SessionRunService(agentStores.control).startRun({
    sessionId: session.id, idempotencyKey: 'backup-plan-step',
  })
  await new SessionRunService(agentStores.control).setStatus(run.runId, 'waiting_confirmation')
  await agentStores.close()
  agentStores = undefined
  const database = new DatabaseSync(path.join(source.directory, '.vibepaper', 'agent', 'control.sqlite'))
  try {
    assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 8)
    const now = new Date().toISOString()
    database.prepare(`INSERT INTO desktop_plan_executions
      (plan_id, step_id, canvas_id, profile, run_id, state, created_at, updated_at)
      VALUES (?, 'read', ?, 'canvas-general', ?, 'waiting_confirmation', ?, ?)`)
      .run(planId, source.project.canvasId, run.runId, now, now)
  } finally { database.close() }
  const backup = await store.backupProject(directories[1], source.project.projectId)
  const restored = await store.restoreBackup(backup.directory, directories[2])
  agentStores = await openDesktopAgentStores(restored.directory)
  const restoredDatabase = new DatabaseSync(path.join(restored.directory, '.vibepaper', 'agent', 'control.sqlite'), { readOnly: true })
  try {
    assert.equal(restoredDatabase.prepare('SELECT stop_requested FROM desktop_plan_execution_context WHERE plan_id = ?').get(planId).stop_requested, 1)
    const execution = restoredDatabase.prepare('SELECT state, error_code FROM desktop_plan_executions WHERE plan_id = ?').get(planId)
    assert.equal(execution.state, 'cancelled')
    assert.equal(execution.error_code, 'PROJECT_RESTORED')
  } finally { restoredDatabase.close() }
  assert.equal(agentStores.control.findById(run.runId).status, 'aborted')
  assert.equal((await agentStores.plans.get(planId, agentStores.projectId)).steps.length, 1)
})
