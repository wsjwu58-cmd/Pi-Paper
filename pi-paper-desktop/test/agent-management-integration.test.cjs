const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { openDesktopAgentStores } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/agent-stores.ts')
const { snapshotDesktopAgentSkill } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/skill-context.ts')

async function workerHarness() {
  const filename = path.resolve(__dirname, '../src/agent-worker.cjs')
  const source = await fs.readFile(filename, 'utf8')
  const parentPort = new EventEmitter()
  parentPort.postMessage = () => {}
  const module = { exports: {} }
  const context = vm.createContext({ module, process: { parentPort }, AbortController, setTimeout, clearTimeout, console })
  const wrapper = vm.runInContext(`(function(require,module,process){\n${source}\nmodule.exports={dispatch};})`, context, { filename })
  wrapper(createRequire(filename), module, context.process)
  return module.exports.dispatch
}

test('original TS services run through Worker session, skill and persistent plan dispatch', async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-agent-management-'))
  const projects = path.join(temporaryDirectory, 'projects')
  await fs.mkdir(projects)
  await fs.mkdir(path.join(temporaryDirectory, 'user-data'))
  const store = createLocalProjectStore()
  const dispatch = await workerHarness()
  t.after(async () => {
    await dispatch('agent:close')
    await store.close()
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  })
  const created = await store.createProject(projects, 'Agent 管理回归')
  const projectId = created.project.projectId
  const canvasId = created.project.canvasId
  await dispatch('agent:open', { projectDirectory: created.directory, userDataDirectory: path.join(temporaryDirectory, 'user-data') })
  const session = await dispatch('agent:create-session', { projectId, canvasId, title: '原会话' })
  assert.equal((await dispatch('agent:get-session', { projectId, sessionId: session.sessionId })).canvasId, canvasId)
  const patch = await dispatch('agent:update-session', { projectId, sessionId: session.sessionId, input: { title: '第一集分镜' } })
  assert.equal(patch.title, '第一集分镜')
  const skill = await dispatch('agent:create-skill', { projectId, draft: { name: '回归技能', description: '技能快照回归', instructions: '保留第一版角色规则', category: 'general' } })
  const skillId = skill.id ?? skill.skill?.id
  assert.equal(typeof skillId, 'string')
  await dispatch('agent:set-session-skills', { projectId, sessionId: session.sessionId, input: [skillId] })
  await dispatch('agent:update-skill', { projectId, skillId, patch: { instructions: '第二版已修改角色规则' } })
  const attached = await dispatch('agent:attach-session-skill', { projectId, sessionId: session.sessionId, input: skillId })
  assert.equal(attached.version, 1)
  const oldSkills = await dispatch('agent:list-skills', { projectId, sessionId: session.sessionId })
  assert.equal(oldSkills.items.find((item) => item.id === skillId).instructions, '保留第一版角色规则')
  const copy = await dispatch('agent:copy-session', { projectId, canvasId, sessionId: session.sessionId, input: {} })
  assert.equal(copy.title, '第一集分镜 副本')
  assert.equal((await dispatch('agent:get-messages', { projectId, sessionId: copy.sessionId })).length, 0)
  const compiled = await dispatch('agent:plan:create', { projectId, id: session.sessionId, canvasId, input: {
    profile: 'canvas-general', plan: { id: '1234567891', version: 1, canvasVersion: 0, steps: [
      { id: 'read', tool: 'get_canvas_summary', inputHash: 'hash-read', dependsOn: [] },
      { id: 'models', tool: 'list_models', inputHash: 'hash-models', dependsOn: ['read'] },
    ] },
  } })
  assert.deepEqual(Array.from(compiled.readySet), ['read'])
  assert.equal('totalEstimatedCost' in compiled, false)
  assert.equal('estimatedCost' in compiled.plan.steps[0], false)
  await dispatch('agent:update-session', { projectId, sessionId: session.sessionId, input: { status: 'archived' } })
  assert.equal((await dispatch('agent:list-sessions', { projectId, filter: { status: 'archived' } })).length, 1)
  await assert.rejects(dispatch('agent:send-message', {
    projectId, sessionId: session.sessionId, canvasId, canvasVersion: 0, canvasNodeCount: 0,
    content: '继续第一集创作', canvasContext: '空白画布', apiKey: 'isolated-test-no-provider-request',
    idempotencyKey: 'archived-session-must-not-start',
  }), /SESSION_ARCHIVED/)
  assert.equal((await dispatch('agent:plan:get', { projectId, id: compiled.plan.id })).steps.length, 2)
  await assert.rejects(dispatch('agent:plan:rerun', { projectId, id: compiled.plan.id, input: 'read' }), /PERMISSION_DENIED/)
  await dispatch('agent:update-session', { projectId, sessionId: session.sessionId, input: { status: 'active' } })
  const rerun = await dispatch('agent:plan:rerun', { projectId, id: compiled.plan.id, input: 'read' })
  assert.equal(rerun.rerunOf, compiled.plan.id)
  await dispatch('agent:close')
  await dispatch('agent:open', { projectDirectory: created.directory, userDataDirectory: path.join(temporaryDirectory, 'user-data') })
  assert.equal((await dispatch('agent:get-session', { projectId, sessionId: session.sessionId })).title, '第一集分镜')
  const reopenedSkills = await dispatch('agent:list-skills', { projectId, sessionId: session.sessionId })
  assert.equal(reopenedSkills.items.find((item) => item.id === skillId).version, 1)
  await dispatch('agent:set-session-skills', { projectId, sessionId: session.sessionId, input: [skillId] })
  assert.equal((await dispatch('agent:list-skills', { projectId, sessionId: session.sessionId })).items.find((item) => item.id === skillId).version, 2)
  assert.equal((await dispatch('agent:plan:get', { projectId, id: rerun.id })).rerunOf, undefined)
  await dispatch('agent:delete-session', { projectId, sessionId: session.sessionId })
  assert.equal((await dispatch('agent:list-sessions', { projectId })).length, 1)
  await assert.rejects(dispatch('agent:plan:get', { projectId, id: compiled.plan.id }), /NOT_FOUND/)
  await assert.rejects(dispatch('agent:get-messages', { projectId, sessionId: session.sessionId }), /NOT_FOUND|DELETED/)
})

test('schema 8 session state, skill snapshots and plans survive real backup identity rebinding', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-agent-plan-backup-'))
  const dirs = ['projects', 'backups', 'restored'].map((name) => path.join(directory, name))
  await Promise.all(dirs.map((name) => fs.mkdir(name)))
  const store = createLocalProjectStore()
  let stores
  t.after(async () => { await stores?.close(); await store.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const source = await store.createProject(dirs[0], '备份源')
  stores = await openDesktopAgentStores(source.directory)
  const session = await stores.sessions.createSession('快照来源', source.project.canvasId)
  await stores.sessions.setSessionSkillSnapshots(session.id, [snapshotDesktopAgentSkill({
    id: 'project-test-skill', key: 'project-test-skill', name: '旧版方法', description: '备份验证', instructions: '保留角色和镜头规则',
    source: 'project', category: 'general', version: 1, enabled: true,
  })])
  await stores.plans.create({ ownerId: stores.projectId, sessionId: session.id, canvasId: source.project.canvasId, expectedVersion: 1, profile: 'canvas-general', plan: {
    id: '1234567892', sessionId: session.id, version: 1, canvasVersion: 0,
    steps: [{ id: 'read', tool: 'get_canvas_summary', dependsOn: [], status: 'pending', inputHash: 'hash', estimatedCost: 0 }],
  } })
  await stores.sessions.updateSession(session.id, { status: 'archived' })
  await stores.close(); stores = undefined
  const backup = await store.backupProject(dirs[1], source.project.projectId)
  const restored = await store.restoreBackup(backup.directory, dirs[2])
  stores = await openDesktopAgentStores(restored.directory)
  assert.notEqual(stores.projectId, source.project.projectId)
  assert.equal((await stores.sessions.getSession(session.id)).status, 'archived')
  assert.equal(stores.control.getSessionSkillSnapshots(session.id)[0].instructions, '保留角色和镜头规则')
  assert.equal((await stores.plans.get('1234567892', stores.projectId)).steps.length, 1)
  await assert.rejects(stores.plans.get('1234567892', source.project.projectId), /PERMISSION_DENIED/)
})
