const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { startCreatorModelFixture } = require('./fixtures/creator-model.cjs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { Worker } = require('node:worker_threads')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { executeCreatorMarketplace } = require('../src/creator-marketplace.cjs')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { portableTemplateGraph } = require('../dist/plugin-template-graph.cjs')

test('offline OpenAI-compatible fixture drives a real Worker creator turn through the project and canvas', { timeout: 30000 }, async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creator-worker-fixture-')))
  const projects = path.join(root, 'projects'), userdata = path.join(root, 'userdata')
  await fs.mkdir(projects); await fs.mkdir(userdata)
  const store = createLocalProjectStore(), project = await store.createProject(projects, '三视图项目')
  const projectId = project.project.projectId, canvasId = project.project.canvasId
  const service = createMarketplaceService(userdata)
  const fixture = await startCreatorModelFixture()
  const { calls, seenSchemas, server } = fixture
  const workerBundle = path.resolve(__dirname, '../dist/agent-worker.cjs')
  const worker = new Worker(`const { parentPort } = require('node:worker_threads'); process.parentPort = { on: (...args) => parentPort.on(...args), postMessage: (...args) => parentPort.postMessage(...args) }; require(${JSON.stringify(workerBundle)})`, { eval: true })
  t.after(async () => { await worker.terminate(); await new Promise((resolve) => server.close(resolve)); await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  let nextId = 0
  const pending = new Map()
  function request(method, payload) {
    const id = ++nextId
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ id, method, payload }) })
  }
  const core = async (method, payload) => {
    if (method === 'canvas:load') return store.loadCanvas(payload.projectId, payload.canvasId)
    if (method === 'canvas:save') return store.saveCanvas(payload)
    if (method === 'canvas:create-node') return store.createNode(payload)
    if (method === 'agent:lookup-operation') return store.lookupAgentOperation(payload)
    throw new Error(`unexpected core method ${method}`)
  }
  worker.on('message', async (message) => {
    if (message.kind === 'agent-local-core-request') {
      try {
        let result
        if (message.method === 'agent:core:load-canvas') result = await core('canvas:load', message.payload)
        else if (message.method === 'agent:core:marketplace') {
          const input = message.payload
          await request('agent:authorize-marketplace', { projectId, canvasId, sessionId: input.sessionId, runId: input.runId, modeVersion: input.modeVersion, action: input.action })
          result = await executeCreatorMarketplace({ service, directory: project.directory, ...input, authorize() {}, core, graph: portableTemplateGraph, trackApply() {},
            barrier: async (target, operation) => {
              const canvas = await store.loadCanvas(projectId, canvasId)
              if (canvas.version !== target.expectedVersion) throw new Error('CANVAS_VERSION_CONFLICT')
              return operation(canvas.version)
            } })
        } else if (message.method === 'agent:core:list-models' || message.method === 'agent:core:list-assets') result = []
        else throw new Error(`unexpected Worker method ${message.method}`)
        worker.postMessage({ kind: 'agent-local-core-response', requestId: message.requestId, ok: true, result })
      } catch (error) {
        worker.postMessage({ kind: 'agent-local-core-response', requestId: message.requestId, ok: false, errorCode: error.message })
      }
      return
    }
    if (!pending.has(message.id)) return
    const pendingCall = pending.get(message.id); pending.delete(message.id)
    if (message.ok) pendingCall.resolve(message.result); else pendingCall.reject(new Error(message.error))
  })
  worker.on('error', (error) => { for (const request of pending.values()) request.reject(error); pending.clear() })
  await request('agent:open', { projectDirectory: project.directory, userDataDirectory: userdata })
  const session = await request('agent:create-session', { projectId, canvasId, title: '三视图' })
  await request('agent:set-session-model', { projectId, sessionId: session.sessionId, bindingId: 'fixture-model' })
  await request('agent:set-session-mode', { projectId, sessionId: session.sessionId, mode: 'creator' })
  const modelDefinition = { id: 'fixture-model', name: 'fixture-model', api: 'openai-completions', provider: 'fixture',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }
  const result = await request('agent:send-message', { projectId, canvasId, sessionId: session.sessionId, modelId: 'fixture-model', modelDefinition,
    content: '做一个商品三视图插件，分别写正面、侧面和背面拍摄要求，保存下来，并在当前画布用一次。',
    canvasContext: '空画布', canvasVersion: 0, canvasNodeCount: 0, canvasDomain: 'general', apiKey: 'fixture-key', idempotencyKey: 'fixture-turn' })
  assert.match(result.assistantText, /尚未生成/)
  assert.deepEqual(calls, ['marketplace_inspect', 'creator_validate', 'creator_save', 'creator_install', 'creator_enable', 'marketplace_apply'])
  assert.ok(seenSchemas[0].includes('creator_save'))
  const canvas = await store.loadCanvas(projectId, canvasId)
  assert.equal(canvas.nodes.length, 6); assert.equal(canvas.edges.length, 3)
  assert.equal((await store.listTasks(projectId)).length, 0)
  assert.equal((await service.list(project.directory)).find((item) => item.id === fixture.packageId).source, 'project')
  const standard = await request('agent:create-session', { projectId, canvasId, title: '普通模式' })
  await request('agent:set-session-model', { projectId, sessionId: standard.sessionId, bindingId: 'fixture-model' })
  await request('agent:send-message', { projectId, canvasId, sessionId: standard.sessionId, modelId: 'fixture-model', modelDefinition,
    content: '请说明当前画布。', canvasContext: '画布', canvasVersion: canvas.version, canvasNodeCount: canvas.nodes.length,
    canvasDomain: 'general', apiKey: 'fixture-key', idempotencyKey: 'standard-turn' })
  assert.equal(seenSchemas.at(-1).includes('creator_save'), false)
  assert.ok(seenSchemas.at(-1).includes('marketplace_inspect'))
  const rolePackage = await service.install(project.directory, 'short-drama-workbench', ['shot-reviewer'])
  await request('agent:set-role', { projectId, sessionId: standard.sessionId,
    binding: { packageId: rolePackage.id, componentId: 'shot-reviewer', digest: rolePackage.installedDigest } })
  await request('agent:send-message', { projectId, canvasId, sessionId: standard.sessionId, modelId: 'fixture-model', modelDefinition,
    content: '请检查画布。', canvasContext: '画布', canvasVersion: canvas.version, canvasNodeCount: canvas.nodes.length,
    canvasDomain: 'general', apiKey: 'fixture-key', idempotencyKey: 'readonly-turn' })
  assert.equal(seenSchemas.at(-1).includes('marketplace_apply'), false)
  assert.equal(seenSchemas.at(-1).includes('creator_save'), false)
  assert.ok(seenSchemas.at(-1).includes('marketplace_inspect'))
  await request('agent:close', {})
})
