const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { definitionDigest, resolveCanvasNodeDefinitionGeneration } = require('../src/node-definition.cjs')
const { DesktopLocalToolGateway } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/local-tool-gateway.ts')
const { ApprovalService, InMemoryApprovalRepository } = require('../../pi-main/packages/vibepaper-agent-service/src/application/approval-service.ts')
const { createRuntimeTools, desktopGenerationConfirmationItems, submitApprovedGenerationAction } = require('../../pi-main/packages/vibepaper-agent-service/src/tools/runtime-tools.ts')

async function fixture(t, { empty = false, invalidReference = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-definition-generation-')))
  const projects = path.join(root, 'projects'), userData = path.join(root, 'userdata')
  await fs.mkdir(projects); await fs.mkdir(userData)
  const store = createLocalProjectStore(), marketplace = createMarketplaceService(userData)
  const { project, directory } = await store.createProject(projects, '节点生成测试')
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  const data = { schemaVersion: 1, baseType: 'image', promptTemplate: '{{product}}',
    fields: [{ id: 'product', label: '商品', kind: 'text', default: '' }] }
  const saved = await marketplace.saveNodeDefinition(directory, { name: '商品图', data })
  const componentId = saved.components[0].id
  await marketplace.install(directory, saved.id, [componentId])
  const snapshot = { name: '商品图', data }
  const nodeDefinition = { ref: { packageId: saved.id, componentId, version: saved.version, digest: definitionDigest(snapshot) },
    snapshot, values: { product: empty ? '' : '编辑后的玻璃杯' } }
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const created = await store.createNode({ ...base, expectedVersion: 0, idempotencyKey: 'create-definition', type: 'image', x: 0, y: 0,
    params: { nodeDefinition, nodeDefinitionReferenceTexts: invalidReference ? [''] : ['前景柔光'], prompt: '白色背景' } })
  const source = await fs.readFile(path.join(__dirname, '../src/main.cjs'), 'utf8')
  const start = source.indexOf('async function createGenerationTaskInStore(')
  const end = source.indexOf('\nfunction dramaRenderBatchScope(', start)
  assert.ok(start >= 0 && end > start)
  const readStart = source.indexOf("      case 'agent:core:load-canvas': {")
  const readEnd = source.indexOf("      case 'agent:core:create-node':", readStart)
  assert.ok(readStart >= 0 && readEnd > readStart)
  const readBranch = source.slice(readStart, readEnd)
    .replace("      case 'agent:core:load-canvas': {", '')
    .replace(/\s*\}\s*$/u, '')
  const context = vm.createContext({
    AGNES_PROVIDER_ID: 'agnes', ARK_PROVIDER_ID: 'volcengine',
    providerSettings: {
      snapshot: async () => ({ models: [{ id: 'fixture-image', providerId: 'fixture' }] }),
      resolve: async () => ({ providerId: 'fixture', modelId: 'fixture-image', model: { defaults: {}, constraints: {} } }),
    },
    localCore: { request: async (method, input) => {
      if (method === 'canvas:load') return store.loadCanvas(input.projectId, input.canvasId)
      assert.equal(method, 'task:create')
      return store.createTask(input)
    } },
    codedError: (code, message = code) => Object.assign(new Error(message), { code }),
    resolveCanvasNodeDefinitionGeneration,
  })
  vm.runInContext(source.slice(start, end), context)
  vm.runInContext(`async function loadAgentCanvas(input, active) { ${readBranch} }`, context)
  const calls = []
  const gateway = new DesktopLocalToolGateway({ request: async (method, input) => {
    calls.push({ method, input: structuredClone(input) })
    if (method === 'agent:core:list-models') return [{ name: 'fixture-image', modelType: 'image', modalities: ['image'],
      providerId: 'fixture', providerType: 'cloud', enabled: true }]
    if (method === 'agent:core:load-canvas') return context.loadAgentCanvas(input, { canvasId: project.canvasId })
    if (method === 'agent:core:create-generation-task') return context.createGenerationTaskInStore(input)
    throw new Error(`unexpected method ${method}`)
  } }, project.projectId)
  const approvals = new ApprovalService(new InMemoryApprovalRepository(), 'fixture-secret', 300)
  let action
  const runtimeContext = { userId: project.projectId, sessionId: 'session', canvasId: project.canvasId,
    canvasVersion: created.version, desktopMode: true, gateway, approvals, onApprovalRequired: async (value) => { action = value } }
  const submit = createRuntimeTools(runtimeContext).find((entry) => entry.name === 'submit_generation')
  return { ...base, store, created, gateway, approvals, submit, calls, getAction: () => action }
}

test('definition fields and saved references are approved, then pass real Main and TaskStore validation', async (t) => {
  const f = await fixture(t)
  await f.submit.execute('call', { nodeId: f.created.node.id, modelType: 'fixture-image', modelParams: { size: '2K' }, overwrite: false })
  const action = f.getAction()
  const prompt = '前景柔光\n\n编辑后的玻璃杯\n\n白色背景'
  assert.equal(action.params.modelParams.prompt, prompt)
  assert.deepEqual(action.params.modelParams.referenceTexts, ['前景柔光'])
  assert.equal((await desktopGenerationConfirmationItems(action, f.gateway))[0].input, '前景柔光 编辑后的玻璃杯 白色背景')
  assert.equal((await f.store.listTasks(f.projectId)).length, 0)
  const approved = await f.approvals.consumeApproval(action.actionId, action.approvalToken, f.created.version)
  const tasks = await submitApprovedGenerationAction(approved, f.gateway)
  assert.equal(tasks[0].status, 'queued')
  const submitted = f.calls.find((call) => call.method === 'agent:core:create-generation-task').input
  assert.equal(submitted.prompt, prompt)
  assert.deepEqual(submitted.parameters.referenceTexts, ['前景柔光'])
  assert.equal((await f.store.listTasks(f.projectId)).length, 1)
})

test('already accepted node-only actions resolve the same version-bound prompt on recovery', async (t) => {
  const f = await fixture(t)
  const action = await f.approvals.planActionAsync({ userId: f.projectId, sessionId: 'session', canvasId: f.canvasId,
    canvasVersion: f.created.version, toolName: 'submit_generation', estimatedCost: 0, risk: 'high', requiresApproval: true,
    params: { nodeId: f.created.node.id, modelType: 'fixture-image', modelParams: { size: '2K' }, overwrite: false } })
  const approved = await f.approvals.consumeApproval(action.actionId, action.approvalToken, f.created.version)
  assert.equal((await submitApprovedGenerationAction(approved, f.gateway))[0].status, 'queued')
  assert.equal((await f.store.listTasks(f.projectId)).length, 1)
})

test('empty definition and invalid or conflicting references cannot create an approval or task', async (t) => {
  for (const options of [{ empty: true }, { invalidReference: true }, {}]) {
    const f = await fixture(t, options)
    const modelParams = Object.keys(options).length ? {} : { referenceTexts: ['注入的参考'] }
    await assert.rejects(f.submit.execute('call', { nodeId: f.created.node.id, modelType: 'fixture-image', modelParams, overwrite: false }),
      { code: 'INVALID_INPUT' })
    assert.equal(f.getAction(), undefined)
    assert.equal((await f.store.listTasks(f.projectId)).length, 0)
  }
})

test('the approved definition cannot be submitted after the canvas changes', async (t) => {
  const f = await fixture(t)
  await f.submit.execute('call', { nodeId: f.created.node.id, modelType: 'fixture-image', modelParams: {}, overwrite: false })
  const action = f.getAction()
  const approved = await f.approvals.consumeApproval(action.actionId, action.approvalToken, f.created.version)
  await f.store.createNode({ projectId: f.projectId, canvasId: f.canvasId, expectedVersion: f.created.version,
    idempotencyKey: 'change-canvas', type: 'image', x: 300, y: 0, params: { prompt: '更改画布' } })
  await assert.rejects(submitApprovedGenerationAction(approved, f.gateway), { code: 'VERSION_CONFLICT' })
  assert.equal((await f.store.listTasks(f.projectId)).length, 0)
})

test('combined references cannot exceed the Main prompt limit', () => {
  const data = { schemaVersion: 1, baseType: 'image', promptTemplate: '{{product}}',
    fields: [{ id: 'product', label: '商品', kind: 'text', default: '' }] }
  const snapshot = { name: '商品图', data }
  const instance = { ref: { packageId: 'studio', componentId: 'node', version: '1.0.0', digest: definitionDigest(snapshot) },
    snapshot, values: { product: '杯子' } }
  const canvas = { version: 1, nodes: [{ id: 'node', type: 'image', data: { params: {
    nodeDefinition: instance, nodeDefinitionReferenceTexts: Array.from({ length: 11 }, () => '参'.repeat(19000)),
  } } }] }
  assert.throws(() => resolveCanvasNodeDefinitionGeneration(canvas, 'node', 1), /NODE_DEFINITION_PROMPT_MISMATCH/)
})

test('ordinary image nodes retain the submitted prompt', async (t) => {
  const f = await fixture(t)
  const ordinary = await f.store.createNode({ projectId: f.projectId, canvasId: f.canvasId, expectedVersion: f.created.version,
    idempotencyKey: 'create-ordinary', type: 'image', x: 300, y: 0, params: { prompt: '普通节点' } })
  const result = await f.gateway.createGenerationTask({ userId: f.projectId, canvasId: f.canvasId, canvasVersion: ordinary.version,
    nodeId: ordinary.node.id, modelType: 'fixture-image', modelParams: { prompt: '普通节点' }, idempotencyKey: 'ordinary-task' })
  assert.equal(result.status, 'queued')
  assert.equal(f.calls.find((call) => call.method === 'agent:core:create-generation-task').input.prompt, '普通节点')
})
