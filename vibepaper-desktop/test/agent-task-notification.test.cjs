const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { COMPOSE_MODEL_ID, COMPOSE_PROVIDER_ID } = require('../src/compose-provider.cjs')

async function createHarness() {
  const mainPath = path.resolve(__dirname, '../src/main.cjs')
  const mainRequire = createRequire(mainPath)
  const handlers = new Map()
  const electron = {
    app: { setName() {}, setPath() {}, getPath: () => 'user-data', requestSingleInstanceLock: () => false, quit() {} },
    protocol: { registerSchemesAsPrivileged() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
  }
  const warnings = []
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : mainRequire(name),
    __dirname: path.dirname(mainPath),
    process: { env: {} },
    console: { warn: (message) => warnings.push(message) },
    URL,
    Buffer,
  })
  vm.runInContext(await fs.readFile(mainPath, 'utf8'), context)
  const sender = { mainFrame: { url: 'vibe://app/' } }
  context.testSender = sender
  vm.runInContext('mainWindow = { webContents: testSender }; providerSettings = { credentials: async () => ({}) }; registerProjectIpc()', context)
  return { context, handlers, warnings, event: { sender, senderFrame: sender.mainFrame } }
}

async function drain(harness, { outcome = 'success', wrongProject = false, failNotification = false } = {}) {
  const calls = []
  let claimed = false
  harness.context.testCore = {
    async request(method) {
      calls.push(method)
      if (method === 'task:claim-next') {
        if (claimed) return null
        claimed = true
        return {
          task: { taskId: 'task-1', modality: 'compose', providerType: 'local',
            providerId: COMPOSE_PROVIDER_ID, modelId: COMPOSE_MODEL_ID },
          parameters: {}, outputDirectory: 'unused-test-output',
        }
      }
      if (method === 'task:resolve-compose-inputs') return []
      if (method === 'task:get') return { status: 'running' }
      return {}
    },
  }
  harness.context.testAgent = {
    async request(method, payload) {
      calls.push({ method, payload })
      if (failNotification) throw new Error('secret should not be logged')
      if (method === 'agent:list-continuation-models') return []
      return { scheduled: 1 }
    },
  }
  harness.context.testGenerator = {
    async request() {
      if (outcome === 'failure') {
        const error = new Error('Generation failed')
        error.code = 'GENERATION_FAILED'
        throw error
      }
      return { outputPath: 'generated/task-1/result.mp4' }
    },
  }
  vm.runInContext(`localCore = testCore; agentWorker = testAgent;
    agentProjectId = ${wrongProject ? "'another-project'" : "'project-1'"};
    startGenerationWorker = () => testGenerator`, harness.context)
  await vm.runInContext("drainTaskQueue('project-1')", harness.context)
  await new Promise((resolve) => setImmediate(resolve))
  return calls
}

test('successful generation notifies Agent after the authoritative result is saved', async () => {
  const harness = await createHarness()
  const calls = await drain(harness, {})
  const objectCalls = calls.filter((call) => typeof call === 'object')
  const notificationIndex = calls.indexOf(objectCalls[0])
  assert.ok(notificationIndex > calls.indexOf('task:succeeded'))
  assert.deepEqual(JSON.parse(JSON.stringify(objectCalls[0])), {
    method: 'agent:list-continuation-models', payload: { projectId: 'project-1' },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(objectCalls[1])), {
    method: 'agent:reconcile-tasks', payload: { projectId: 'project-1', connectionsBySession: {}, unavailableSessionIds: [] },
  })
})

test('automatic continuation resolves the configured binding and key independently for each session', async () => {
  const harness = await createHarness()
  const notifications = []
  harness.context.testSettings = {
    async snapshot() {
      return { models: [
        { id: 'target-deepseek-v4-1-flash', providerId: 'deepseek', modelType: 'text', implemented: true, toolCalling: true, enabled: true },
        { id: 'target-claude-sonnet-4-6', providerId: 'anthropic', modelType: 'text', implemented: true, toolCalling: true, enabled: true },
      ] }
    },
    async resolve(providerId, modelId) {
      return {
        providerId,
        apiModelId: providerId === 'deepseek' ? 'deepseek-flash' : 'claude-sonnet-4-6',
        apiKey: providerId === 'deepseek' ? 'deepseek-only-key' : 'anthropic-only-key',
        credentials: { apiKey: providerId === 'deepseek' ? 'deepseek-only-key' : 'anthropic-only-key' },
        endpoint: providerId === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.anthropic.com',
        modelId,
      }
    },
    async credentials() { return { apiKey: 'agnes-legacy-key' } },
  }
  harness.context.testAgent = {
    async request(method, payload) {
      notifications.push({ method, payload })
      if (method === 'agent:list-continuation-models') return [
        { sessionId: 'session-deepseek', bindingId: 'target-deepseek-v4-1-flash' },
        { sessionId: 'session-anthropic', bindingId: 'target-claude-sonnet-4-6' },
      ]
      return { scheduled: 2 }
    },
  }
  vm.runInContext("providerSettings = testSettings; agentWorker = testAgent; agentProjectId = 'project-1'", harness.context)

  await vm.runInContext("notifyAgentTaskState('project-1')", harness.context)

  const reconcile = notifications.find((call) => call.method === 'agent:reconcile-tasks')
  assert.ok(reconcile)
  assert.deepEqual(Object.keys(reconcile.payload.connectionsBySession), ['session-deepseek', 'session-anthropic'])
  assert.equal(reconcile.payload.connectionsBySession['session-deepseek'].apiKey, 'deepseek-only-key')
  assert.equal(reconcile.payload.connectionsBySession['session-deepseek'].modelDefinition.provider, 'deepseek')
  assert.equal(reconcile.payload.connectionsBySession['session-deepseek'].modelDefinition.id, 'deepseek-flash')
  assert.equal(reconcile.payload.connectionsBySession['session-anthropic'].apiKey, 'anthropic-only-key')
  assert.equal(reconcile.payload.connectionsBySession['session-anthropic'].modelDefinition.provider, 'anthropic')
  assert.equal(reconcile.payload.connectionsBySession['session-anthropic'].modelDefinition.id, 'claude-sonnet-4-6')
  assert.equal(JSON.stringify(reconcile.payload).includes('agnes-legacy-key'), false)
})

test('unavailable session binding does not fall back to a configured Agnes key', async () => {
  const harness = await createHarness()
  const notifications = []
  harness.context.testSettings = {
    async snapshot() { return { models: [] } },
    async credentials() { return { apiKey: 'agnes-legacy-key' } },
  }
  harness.context.testAgent = {
    async request(method, payload) {
      notifications.push({ method, payload })
      if (method === 'agent:list-continuation-models') return [
        { sessionId: 'session-custom', bindingId: 'target-custom-text-binding' },
      ]
      return {}
    },
  }
  vm.runInContext("providerSettings = testSettings; agentWorker = testAgent; agentProjectId = 'project-1'", harness.context)

  await vm.runInContext("notifyAgentTaskState('project-1')", harness.context)

  const reconcile = notifications.find((call) => call.method === 'agent:reconcile-tasks')
  assert.deepEqual(JSON.parse(JSON.stringify(reconcile.payload)), {
    projectId: 'project-1', connectionsBySession: {}, unavailableSessionIds: ['session-custom'],
  })
})

test('failed generation also opens the Agent recovery path after failure persistence', async () => {
  const harness = await createHarness()
  const calls = await drain(harness, { outcome: 'failure' })
  assert.ok(calls.findIndex((call) => typeof call === 'object') > calls.indexOf('task:failed'))
  assert.equal(calls.filter((call) => typeof call === 'object').length, 2)
})

test('notification failure never changes a successful task or exposes the worker error', async () => {
  const harness = await createHarness()
  const calls = await drain(harness, { failNotification: true })
  assert.ok(calls.includes('task:succeeded'))
  assert.ok(!calls.includes('task:failed'))
  assert.deepEqual(harness.warnings, ['AGENT_TASK_RECONCILIATION_UNAVAILABLE'])
})

test('task completion cannot notify an Agent in another project', async () => {
  const harness = await createHarness()
  const calls = await drain(harness, { wrongProject: true })
  assert.ok(calls.includes('task:succeeded'))
  assert.equal(calls.filter((call) => typeof call === 'object').length, 0)
})

test('project switching during credential lookup cannot pass credentials to the old Worker', async () => {
  const harness = await createHarness()
  let finishLookup
  const notifications = []
  harness.context.testLookup = () => new Promise((resolve) => { finishLookup = resolve })
  harness.context.testAgent = { async request(method, ...args) {
    notifications.push([method, ...args])
    if (method === 'agent:list-continuation-models') return [{ sessionId: 'session-1', bindingId: 'agnes-2.5-flash' }]
    return {}
  } }
  vm.runInContext("agentWorker = testAgent; agentProjectId = 'project-1'; providerSettings = { credentials: async () => ({ apiKey: await testLookup() }) }", harness.context)
  const lookup = vm.runInContext("notifyAgentTaskState('project-1')", harness.context)
  for (let attempt = 0; attempt < 20 && typeof finishLookup !== 'function'; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(typeof finishLookup, 'function')
  vm.runInContext("agentProjectId = 'project-2'", harness.context)
  finishLookup('test-only-credential')
  await lookup
  assert.deepEqual(notifications.map(([method]) => method), ['agent:list-continuation-models'])
})

test('cancelling a queued task notifies the Agent without needing a generation worker', async () => {
  const harness = await createHarness()
  const calls = []
  harness.context.testCore = { async request(method) { calls.push(method); return { status: 'cancelled' } } }
  harness.context.testAgent = { async request(method, payload) { calls.push({ method, payload }); return method === 'agent:list-continuation-models' ? [] : {} } }
  vm.runInContext("localCore = testCore; agentWorker = testAgent; agentProjectId = 'project-1'", harness.context)
  const task = await harness.handlers.get('desktop:task:cancel')(harness.event, 'project-1', 'task-1')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(task.status, 'cancelled')
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    'task:cancel',
    { method: 'agent:list-continuation-models', payload: { projectId: 'project-1' } },
    { method: 'agent:reconcile-tasks', payload: { projectId: 'project-1', connectionsBySession: {}, unavailableSessionIds: [] } },
  ])
})
