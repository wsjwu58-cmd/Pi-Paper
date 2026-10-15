const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const openControls = new Set()
test.afterEach(() => {
  for (const control of openControls) control.close()
  openControls.clear()
})

async function fixture() {
  const directory = path.resolve(__dirname, '../../pi-main/packages/vibepaper-agent-service/src')
  const runtime = await import(pathToFileURL(path.join(directory, 'desktop/mcp-runtime.ts')).href)
  const { ApprovalService } = await import(pathToFileURL(path.join(directory, 'application/approval-service.ts')).href)
  const { DesktopAgentControlStore } = await import(pathToFileURL(path.join(directory, 'desktop/control-store.ts')).href)
  const effects = []
  const unexpected = async (...args) => {
    effects.push(args)
    throw new Error('The invalid request reached a domain gateway')
  }
  const gateway = Object.fromEntries([
    'getCanvasSummary', 'getSelectedNodes', 'getNodeDetail', 'listModels', 'searchAssets',
    'checkTaskStatus', 'execute', 'resolveGenerationModel', 'resolveGenerationModelForTarget',
    'createGenerationTask',
  ].map((name) => [name, unexpected]))
  const repository = new DesktopAgentControlStore(':memory:')
  openControls.add(repository)
  const approvalSecret = repository.getOrCreateApprovalSecret()
  const input = {
    clientId: 'review-client', grantId: 'review-grant', projectId: 'review-project', canvasId: 'review-canvas', canvasVersion: 1,
    control: repository,
    gateway, approvals: new ApprovalService(repository, approvalSecret, 60),
  }
  return { runtime, effects, input, repository, approvalSecret }
}

const generation = { nodeId: 'node', modelType: 'fixture-model', modelParams: { prompt: 'fixture' }, overwrite: false }
const hiddenTools = [
  ['delete_nodes', { nodeIds: ['node'] }],
  ['submit_generation', generation],
  ['submit_generation_batch', { generations: [generation, { ...generation, nodeId: 'another-node' }] }],
  ['request_render_audit', { targetNodeId: 'node', shotDurationSeconds: 1, expectedDurationSeconds: 1,
    characterConsistent: true, audioDurationMs: 1, videoDurationMs: 1, previousCamera: 'fixed', currentCamera: 'fixed' }],
]
for (const [toolName, args] of hiddenTools) {
  test(`external runtime rejects the hidden original tool ${toolName} before reading domain state`, async () => {
    const h = await fixture()
    await assert.rejects(h.runtime.executeMcpRuntimeTool({ ...h.input, toolName, arguments: args }),
      (error) => error.code === 'MCP_TOOL_UNAVAILABLE')
    assert.deepEqual(h.effects, [])
  })
}

const unknownFieldCases = [
  ['prepare_generation', {
    operationId: 'review-prepare', expectedVersion: 1, confirmed: true,
    generations: [{ nodeId: 'node', modelType: 'fixture-model', modelParams: { prompt: 'fixture' }, overwrite: false }],
  }],
  ['connect_nodes', {
    operationId: 'review-connect', expectedVersion: 1,
    sourceNodeId: 'source', targetNodeId: 'target', nodeIds: ['different', 'pair'],
  }],
  ['create_nodes', {
    operationId: 'review-create', expectedVersion: 1, idempotencyKey: 'client-owned-private-key',
    nodes: [{ type: 'text', prompt: 'fixture' }],
  }],
]
for (const [toolName, args] of unknownFieldCases) {
  test(`external ${toolName} rejects fields absent from its advertised schema before execution`, async () => {
    const h = await fixture()
    await assert.rejects(h.runtime.executeMcpRuntimeTool({ ...h.input, toolName, arguments: args }),
      (error) => error.code === 'INVALID_INPUT')
    assert.deepEqual(h.effects, [])
  })
}

test('stale external canvas version never reaches the domain write gateway', async () => {
  const h = await fixture()
  await assert.rejects(h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'create_nodes', arguments: {
    operationId: 'review-stale', expectedVersion: 0, nodes: [{ type: 'text', prompt: 'fixture' }],
  } }), (error) => error.code === 'CANVAS_VERSION_CONFLICT')
  assert.deepEqual(h.effects, [])
})

test('MCP tool discovery omits private confirmation and destructive tools', async () => {
  const h = await fixture()
  const definitions = h.runtime.listMcpRuntimeTools(h.input)
  for (const hidden of ['delete_nodes', 'submit_generation', 'submit_generation_batch', 'request_render_audit']) {
    assert(!definitions.some((tool) => tool.name === hidden))
  }
  assert(definitions.some((tool) => tool.name === 'prepare_generation'))
  assert(definitions.every((tool) => tool.inputSchema.additionalProperties === false))
  assert.deepEqual(h.effects, [])
})

test('runtime text and structured responses share the same public projection', async () => {
  const h = await fixture()
  const canary = 'review-private-value-that-does-not-resemble-a-provider-key'
  h.input.gateway.getNodeDetail = async () => ({
    id: 'node', type: 'text', prompt: 'Keep the ordinary reference https://example.com/article',
    approvalToken: canary, nested: { apiKey: canary, content: 'Visible user text' },
  })
  const result = await h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'get_node_detail', arguments: { nodeId: 'node' } })
  assert(!JSON.stringify(result.structuredContent).includes(canary))
  assert(!JSON.stringify(result.content).includes(canary), 'The compatibility text must not bypass the structured projection')
  assert(JSON.stringify(result).includes('https://example.com/article'), 'Ordinary user reference URLs must be preserved')
})

test('model binding projection does not retain a second unprojected result array', async () => {
  const h = await fixture()
  const canary = 'review-private-model-key'
  h.input.gateway.listModels = async () => [{
    id: 'fixture-binding', name: 'fixture-model', modelType: 'text', modalities: ['text'],
    providerId: 'fixture-provider', providerType: 'local', enabled: true, apiKey: canary,
  }]
  const result = await h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'list_models', arguments: {} })
  assert(!JSON.stringify(result).includes(canary))
  assert.equal(result.structuredContent.models[0].bindingId, 'fixture-binding')
})

test('node configuration cannot route credentials into project parameters', async () => {
  const h = await fixture()
  await assert.rejects(h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'update_node_config', arguments: {
    operationId: 'review-secret-route', expectedVersion: 1, nodeId: 'node',
    config: { params: { apiKey: 'review-credential-canary' } },
  } }), (error) => error.code === 'INVALID_INPUT')
  assert.deepEqual(h.effects, [])
})

test('generation proposal persists the original approval and requires desktop confirmation before creating tasks', async () => {
  const h = await fixture()
  const models = [{ id: 'fixture-binding', name: 'fixture-model', displayName: 'Fixture image',
    modelType: 'image', modalities: ['image'], providerId: 'fixture-provider', providerType: 'local', enabled: true }]
  h.input.gateway.listModels = async () => models
  h.input.gateway.getCanvasSummary = async () => ({ canvas: { id: h.input.canvasId, version: 1 }, nodes: [], edges: [] })
  h.input.gateway.getNodeDetail = async () => ({ id: 'node', type: 'image', label: 'Review target', params: { prompt: 'fixture' } })
  h.input.gateway.resolveGenerationModelForTarget = async () => 'fixture-model'
  h.input.gateway.createGenerationTask = async (input) => {
    h.effects.push(input)
    return { taskId: 'review-task', status: 'queued', modality: 'image', nodeId: input.nodeId }
  }
  const prepared = await h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'prepare_generation', arguments: {
    operationId: 'review-generation', expectedVersion: 1, generations: [{ ...generation, modelType: 'fixture-binding' }],
  } })
  assert.equal(prepared.structuredContent.status, 'awaiting_confirmation')
  assert(Array.isArray(prepared.structuredContent.items))
  assert.equal(h.effects.length, 0)
  assert(prepared.proposal?.approvalToken)
  assert(!JSON.stringify({ content: prepared.content, structuredContent: prepared.structuredContent }).includes(prepared.proposal.approvalToken))
  const persisted = await h.repository.find(prepared.proposal.proposalId)
  assert.equal(persisted.status, 'pending')
  assert.equal(persisted.action.sessionId, 'mcp:review-client')
  const confirmed = await h.runtime.confirmExternalMcpGeneration({
    clientId: h.input.clientId, projectId: h.input.projectId, canvasId: h.input.canvasId,
    actionId: prepared.proposal.proposalId, approvalToken: prepared.proposal.approvalToken,
    accept: true, currentCanvasVersion: 1,
  }, { projectId: h.input.projectId, control: h.repository }, h.input.gateway)
  assert.equal(confirmed.status, 'submitted')
  assert.equal(h.effects.length, 1)
  assert.equal(h.effects[0].modelType, 'fixture-model')
})

test('completed write replay survives the canvas version advanced by its first execution', async () => {
  const h = await fixture()
  let version = 1
  h.input.gateway.getCanvasSummary = async () => ({ canvas: { id: h.input.canvasId, version }, nodes: [], edges: [] })
  h.input.gateway.execute = async (command) => {
    h.effects.push(command)
    version += 1
    return { canvasVersion: version, createdNodes: [{ id: 'created-node', type: 'text' }] }
  }
  const args = { operationId: 'review-replay', expectedVersion: 1, nodes: [{ type: 'text', params: { content: 'Original request' } }] }
  const first = await h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'create_nodes', arguments: args })
  const replay = await h.runtime.executeMcpRuntimeTool({ ...h.input, canvasVersion: version, toolName: 'create_nodes', arguments: args })
  assert.deepEqual(JSON.parse(JSON.stringify(replay.structuredContent)), JSON.parse(JSON.stringify(first.structuredContent)))
  assert.equal(h.effects.length, 1)
  await assert.rejects(h.runtime.executeMcpRuntimeTool({ ...h.input, canvasVersion: version, toolName: 'create_nodes', arguments: {
    ...args, nodes: [{ type: 'text', params: { content: 'Different request using the old key' } }],
  } }), (error) => error.code === 'IDEMPOTENCY_CONFLICT')
  assert.equal(h.effects.length, 1)
})

test('serialized original node arrays cannot bypass credential parameter validation', async () => {
  const h = await fixture()
  await assert.rejects(h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'create_nodes', arguments: {
    operationId: 'review-serialized-secret', expectedVersion: 1,
    nodes: JSON.stringify([{ type: 'image', params: { apiKey: 'review-credential-canary' } }]),
  } }), (error) => error.code === 'INVALID_INPUT')
  assert.deepEqual(h.effects, [])
})

test('replaying a pending generation after canvas edits invalidates the proposal', async () => {
  const h = await fixture()
  let version = 1
  h.input.gateway.listModels = async () => [{ id: 'fixture-binding', name: 'fixture-model', modelType: 'image',
    modalities: ['image'], providerId: 'fixture-provider', providerType: 'local', enabled: true }]
  h.input.gateway.getCanvasSummary = async () => ({ canvas: { id: h.input.canvasId, version }, nodes: [], edges: [] })
  h.input.gateway.getNodeDetail = async () => ({ id: 'node', type: 'image', label: 'Review target', params: { prompt: 'fixture' } })
  h.input.gateway.resolveGenerationModelForTarget = async () => 'fixture-model'
  const args = { operationId: 'review-invalidated-pending', expectedVersion: 1,
    generations: [{ ...generation, modelType: 'fixture-binding' }] }
  const first = await h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'prepare_generation', arguments: args })
  assert.equal(first.structuredContent.status, 'awaiting_confirmation')
  version = 2
  const replay = await h.runtime.executeMcpRuntimeTool({ ...h.input, canvasVersion: version,
    toolName: 'prepare_generation', arguments: args })
  assert.equal(replay.structuredContent.status, 'invalidated')
  const persisted = h.repository.getMcpProposal({ proposalId: first.structuredContent.proposalId,
    clientId: h.input.clientId, grantId: h.input.grantId })
  assert.equal(persisted.status, 'invalidated')
  assert.equal(h.effects.length, 0)
})

test('expired generation replay cannot revive the old confirmation', async () => {
  const h = await fixture()
  const { ApprovalService } = await import(pathToFileURL(path.resolve(__dirname,
    '../../pi-main/packages/vibepaper-agent-service/src/application/approval-service.ts')).href)
  h.input.approvals = new ApprovalService(h.repository, h.approvalSecret, 0)
  h.input.gateway.listModels = async () => [{ id: 'fixture-binding', name: 'fixture-model', modelType: 'image',
    modalities: ['image'], providerId: 'fixture-provider', providerType: 'local', enabled: true }]
  h.input.gateway.getCanvasSummary = async () => ({ canvas: { id: h.input.canvasId, version: 1 }, nodes: [], edges: [] })
  h.input.gateway.getNodeDetail = async () => ({ id: 'node', type: 'image', label: 'Review target', params: { prompt: 'fixture' } })
  h.input.gateway.resolveGenerationModelForTarget = async () => 'fixture-model'
  const args = { operationId: 'review-expired-pending', expectedVersion: 1,
    generations: [{ ...generation, modelType: 'fixture-binding' }] }
  const first = await h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'prepare_generation', arguments: args })
  assert.equal(first.structuredContent.status, 'awaiting_confirmation')
  const replay = await h.runtime.executeMcpRuntimeTool({ ...h.input, toolName: 'prepare_generation', arguments: args })
  assert.equal(replay.structuredContent.status, 'invalidated')
  assert.equal(replay.structuredContent.errorCode, 'CONFIRMATION_EXPIRED')
  assert.equal(h.effects.length, 0)
})

test('completed domain steps use the same first response and durable replay projection', async () => {
  const h = await fixture()
  const { DesktopLocalToolGateway } = await import(pathToFileURL(path.resolve(__dirname,
    '../../pi-main/packages/vibepaper-agent-service/src/desktop/local-tool-gateway.ts')).href)
  let writes = 0
  const gateway = new DesktopLocalToolGateway({ request: async (method) => {
    if (method === 'agent:core:load-canvas') return { canvasId: h.input.canvasId, version: 1, nodes: [], edges: [] }
    assert.equal(method, 'agent:core:create-node')
    writes += 1
    return { node: { id: 'tracked-node', type: 'text', data: { content: 'Fixture' } }, version: 2 }
  } }, h.input.projectId)
  gateway.attachMcpCommand('c776ad5d-63cd-4e31-9bad-877817ccf848')
  const args = { operationId: 'review-tracked-replay', expectedVersion: 1, nodes: [{ type: 'text' }] }
  const first = await h.runtime.executeMcpRuntimeTool({ ...h.input, gateway, toolName: 'create_nodes', arguments: args })
  const replay = await h.runtime.executeMcpRuntimeTool({ ...h.input, gateway, canvasVersion: 2, toolName: 'create_nodes', arguments: args })
  assert.deepEqual(JSON.parse(JSON.stringify(replay.structuredContent)), JSON.parse(JSON.stringify(first.structuredContent)))
  assert.equal(writes, 1)
})

test('partial domain writes retain completed IDs and uncertainty without resubmitting', async () => {
  const h = await fixture()
  const { DesktopLocalToolGateway } = await import(pathToFileURL(path.resolve(__dirname,
    '../../pi-main/packages/vibepaper-agent-service/src/desktop/local-tool-gateway.ts')).href)
  let writes = 0
  const gateway = new DesktopLocalToolGateway({ request: async (method) => {
    if (method === 'agent:core:load-canvas') return { canvasId: h.input.canvasId, version: 1, nodes: [], edges: [] }
    assert.equal(method, 'agent:core:create-node')
    writes += 1
    if (writes === 1) return { node: { id: 'committed-node', type: 'text', data: {} }, version: 2 }
    throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' })
  } }, h.input.projectId)
  gateway.attachMcpCommand('c776ad5d-63cd-4e31-9bad-877817ccf848')
  const args = { operationId: 'review-tracked-partial', expectedVersion: 1, nodes: [{ type: 'text' }, { type: 'text' }] }
  await assert.rejects(h.runtime.executeMcpRuntimeTool({ ...h.input, gateway, toolName: 'create_nodes', arguments: args }))
  const record = h.repository.getMcpOperation({ operationId: args.operationId, clientId: h.input.clientId, grantId: h.input.grantId })
  assert.equal(record.status, 'submission_unknown')
  assert(record.result.effects.some((step) => step.nodeId === 'committed-node' && step.status === 'completed'))
  assert(record.result.effects.some((step) => step.status === 'uncertain'))
  const replay = await h.runtime.executeMcpRuntimeTool({ ...h.input, gateway, canvasVersion: 2, toolName: 'create_nodes', arguments: args })
  assert.equal(replay.structuredContent.status, 'submission_unknown')
  assert.equal(writes, 2)
})
