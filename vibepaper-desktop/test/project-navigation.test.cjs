const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const { createRequire } = require('node:module')

async function harness() {
  const mainPath = path.resolve(__dirname, '../src/main.cjs')
  const mainRequire = createRequire(mainPath)
  const handlers = new Map()
  const electron = {
    app: { setName() {}, requestSingleInstanceLock: () => false, quit() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  }
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : mainRequire(name),
    __dirname: path.dirname(mainPath), process: { env: {} }, console, URL, Buffer,
  })
  vm.runInContext(await fs.readFile(mainPath, 'utf8'), context)
  const directory = await fs.realpath(path.resolve(__dirname, '..'))
  const calls = []
  const project = { projectId: 'project-1', canvasId: 'canvas-1' }
  const worker = { live: true }
  const sender = { mainFrame: { url: 'vibe://app/workspace' } }
  Object.assign(context, {
    fixtureDirectory: directory, fixtureWorker: worker, fixtureSender: sender,
    fixtureCore: { async request(method, input) {
      calls.push({ method, input })
      if (input.expectedProjectId && input.expectedProjectId !== project.projectId) throw new Error('PROJECT_IDENTITY_MISMATCH')
      return { project, directory }
    } },
    fixtureCatalog: {
      resolve: async () => ({ project, directory }),
      record: async () => { calls.push('record'); return project },
    },
    fixtureStop: async () => { calls.push('stop') },
    fixtureStart: async () => { calls.push('start') },
  })
  vm.runInContext(`activeProjectDirectory = fixtureDirectory; agentWorker = fixtureWorker;
    agentProjectId = 'project-1'; localCore = fixtureCore;
    recentProjectCatalog = fixtureCatalog; mainWindow = { webContents: fixtureSender };
    stopAgentWorker = fixtureStop; startAgentWorker = fixtureStart;
    scheduleTaskPump = async () => {}; registerProjectIpc()`, context)
  return { context, calls, handlers, directory, worker, event: { sender, senderFrame: sender.mainFrame } }
}

test('reentering the active canvas preserves a live Agent and does not wait for generation', async () => {
  const h = await harness()
  vm.runInContext('taskPumpPromise = new Promise(() => {})', h.context)
  const result = await Promise.race([
    h.handlers.get('desktop:project:open-recent')(h.event, 'project-1'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation waited for generation')), 250)),
  ])
  assert.equal(result.projectId, 'project-1')
  assert.equal(vm.runInContext('agentWorker', h.context), h.worker)
  assert.equal(vm.runInContext('projectTransitionCount', h.context), 0)
  assert.deepEqual(h.calls.map((call) => typeof call === 'string' ? call : call.method), ['project:open', 'record'])
  assert.equal(h.calls[0].input.expectedCanvasId, 'canvas-1')
})

test('same-directory navigation still rejects a changed project identity', async () => {
  const h = await harness()
  h.context.fixtureInput = { expectedProjectId: 'different-project', expectedCanvasId: 'canvas-1' }
  await assert.rejects(vm.runInContext('openProjectForNavigation(fixtureDirectory, fixtureInput)', h.context), /PROJECT_IDENTITY_MISMATCH/)
  assert.ok(!h.calls.includes('stop'))
})

test('another project keeps the existing task and Agent transition gate', async () => {
  const h = await harness()
  let finishPump
  h.context.fixturePump = new Promise((resolve) => { finishPump = resolve })
  vm.runInContext('activeProjectDirectory = null; taskPumpPromise = fixturePump', h.context)
  const opening = vm.runInContext('openProjectForNavigation(fixtureDirectory)', h.context)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(h.calls, [])
  finishPump()
  await opening
  assert.deepEqual(h.calls.map((call) => typeof call === 'string' ? call : call.method), ['stop', 'project:open', 'start'])
})
