const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const { createMcpMainService } = require('../src/mcp-main-service.cjs')

const projectId = 'mcp-discovery-project-fixture'
const canvasId = 'mcp-discovery-canvas-fixture'

function postJson(port, route, body, token) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', connection: 'close',
        ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch { reject(new Error('MCP fixture returned invalid JSON')) }
      })
    })
    request.once('error', reject)
    request.end(JSON.stringify(body))
  })
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-mcp-discovery-'))
  const handlers = new Map()
  const coreCalls = []
  let rows = options.rows || []
  const context = { projectId, canvasId, version: 1 }
  const mcpRuntime = await import(pathToFileURL(path.resolve(__dirname,
    '../../pi-main/packages/vibepaper-agent-service/src/desktop/mcp-runtime.ts')).href)
  const worker = { request: async (method) => {
    if (method === 'mcp:tools:list') return mcpRuntime.listMcpAuxiliaryTools()
    throw new Error(`unexpected worker request: ${method}`)
  } }
  const service = createMcpMainService({
    userDataDirectory: path.join(root, 'user-data', 'VibePaper'),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender: () => {},
    getActiveContext: async () => ({ ...context }),
    getWorker: () => worker,
    getProviderSettings: () => null,
    loadCanvas: async () => ({ ...context }),
    getLocalCore: () => ({ request: async (method, input) => {
      coreCalls.push({ method, input })
      if (method === 'task:list') return input.modality ? rows.filter((task) => task.modality === input.modality) : rows
      throw new Error(`unexpected Local Core request: ${method}`)
    } }),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => {} } }),
  })
  t.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })
  const instance = await service.start()
  const auth = JSON.parse(await fs.readFile(path.join(root, 'user-data', 'VibePaper', 'mcp-bridge-auth.json'), 'utf8'))
  const invoke = (name, input) => handlers.get(`desktop:mcp:${name}`)({}, input)
  await invoke('canvas-ready:set', { projectId, canvasId, version: 1, ready: true })
  await invoke('enabled:set', true)
  const client = await invoke('client:create', {
    clientName: 'codex', permissions: options.permissions || ['task.read'], providerGrants: [], mediaTypes: [],
    disclosureVersion: 'desktop-mcp-provider-disclosure-v1', accepted: true,
  })
  const grant = service.getStore().getClient(client.clientId)
  const bootstrap = await postJson(instance.port, '/bootstrap', {
    clientId: client.clientId, grantId: grant.grantId,
    clientInfo: { name: 'discovery-fixture', version: '1' }, bridgeSecret: auth.secret,
  })
  assert.equal(bootstrap.status, 200)
  const token = bootstrap.body.accessToken
  const rpc = (method, params) => postJson(instance.port, '/rpc', { method, params }, token)
  const call = (args, name = 'list_canvas_tasks') => rpc('tools/call', { name, arguments: args })
  return {
    call, rpc, coreCalls, service,
    setRows(value) { rows = value },
    setCanvas(value) { context.canvasId = value },
  }
}

test('MCP task discovery returns only a minimal, bounded DTO from the granted canvas', async (t) => {
  const secretPrompt = 'task-discovery-private-prompt-canary'
  const rows = [
    { taskId: 'current-1', canvasId, nodeId: 'node-1', status: 'running', modality: 'image',
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:01:00.000Z',
      prompt: secretPrompt, modelParams: { apiKey: 'private-key-canary', prompt: secretPrompt },
      providerId: 'private-provider', modelId: 'private-model', outputPath: 'C:\\private\\output.png',
      idempotencyKey: 'private-idempotency-key', errorMessage: secretPrompt },
    { taskId: 'current-2', canvasId, nodeId: 'node-2', status: 'queued', modality: 'video' },
    { taskId: 'foreign-task-id-canary', canvasId: 'different-canvas', nodeId: 'foreign-node',
      status: 'succeeded', modality: 'image', prompt: secretPrompt },
  ]
  const f = await fixture(t, { rows })
  const definitions = await f.rpc('tools/list', {})
  const discoveryTool = definitions.body.tools.find((tool) => tool.name === 'list_canvas_tasks')
  assert.ok(discoveryTool)
  assert.equal(discoveryTool.annotations.readOnlyHint, true)
  assert.deepEqual(discoveryTool.inputSchema.properties.limit,
    { type: 'integer', minimum: 1, maximum: 100, default: 50 })
  assert.deepEqual(discoveryTool.inputSchema.properties.modality.enum, ['text', 'image', 'video', 'audio', 'compose'])
  const response = await f.call({ limit: 1 })
  assert.equal(response.status, 200)
  assert.equal(response.body.isError, undefined)
  assert.deepEqual(response.body.structuredContent, {
    tasks: [{ taskId: 'current-1', nodeId: 'node-1', status: 'running', modality: 'image',
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:01:00.000Z' }],
    hasMore: true,
  })
  assert.deepEqual(f.coreCalls[0], { method: 'task:list', input: { projectId, canvasId, limit: 2 } })
  const serialized = JSON.stringify(response.body)
  for (const forbidden of [secretPrompt, 'private-key-canary', 'private-provider', 'private-model',
    'C:\\private\\output.png', 'private-idempotency-key', 'foreign-task-id-canary']) {
    assert.equal(serialized.includes(forbidden), false, `task discovery leaked ${forbidden}`)
  }

  f.setRows([])
  const empty = await f.call({})
  assert.deepEqual(empty.body.structuredContent, { tasks: [], hasMore: false })

  f.setRows([
    { taskId: 'newer-text-task', canvasId, status: 'succeeded', modality: 'text' },
    { taskId: 'older-image-task', canvasId, status: 'interrupted', modality: 'image' },
  ])
  const images = await f.call({ modality: 'image', limit: 1 })
  assert.deepEqual(images.body.structuredContent, {
    tasks: [{ taskId: 'older-image-task', status: 'interrupted', modality: 'image' }],
    hasMore: false,
  })
  assert.deepEqual(f.coreCalls[2], {
    method: 'task:list', input: { projectId, canvasId, modality: 'image', limit: 2 },
  })

  const invalidLimit = await f.call({ limit: 101 })
  assert.equal(invalidLimit.body.structuredContent.errorCode, 'INVALID_INPUT')
  const invalidModality = await f.call({ modality: 'unsupported' })
  assert.equal(invalidModality.body.structuredContent.errorCode, 'INVALID_INPUT')
  const injectedScope = await f.call({ canvasId: 'different-canvas' })
  assert.equal(injectedScope.body.structuredContent.errorCode, 'INVALID_INPUT')
  assert.equal(f.coreCalls.length, 3)
})

test('MCP task discovery requires task.read and rejects a changed canvas', async (t) => {
  const noTaskRead = await fixture(t, { permissions: ['canvas.read'] })
  const listed = await noTaskRead.rpc('tools/list', {})
  assert.equal(listed.body.tools.some((tool) => tool.name === 'list_canvas_tasks'), false)
  const denied = await noTaskRead.call({})
  assert.equal(denied.body.isError, true)
  assert.equal(denied.body.structuredContent.errorCode, 'PERMISSION_DENIED')
  assert.equal(noTaskRead.coreCalls.length, 0)

  const scoped = await fixture(t, { rows: [{ taskId: 'current', canvasId, status: 'running', modality: 'image' }] })
  scoped.setCanvas('other-canvas')
  const changed = await scoped.call({})
  assert.equal(changed.body.isError, true)
  assert.equal(changed.body.structuredContent.errorCode, 'PROJECT_CHANGED')
  assert.equal(scoped.coreCalls.length, 0)
})
