const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const { CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js')
const { createMcpMainService } = require('../src/mcp-main-service.cjs')

const projectId = 'mcp-output-project-fixture'
const canvasId = 'mcp-output-canvas-fixture'
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')
const tinyMp4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32])

function openPostJson(port, route, body, token) {
  let resolveResponse
  let rejectResponse
  const promise = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject })
  const request = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', agent: false,
    headers: { 'content-type': 'application/json', connection: 'close',
      ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => {
      try { resolveResponse({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
      catch { rejectResponse(new Error('MCP fixture returned invalid JSON')) }
    })
  })
  request.once('error', rejectResponse)
  request.end(JSON.stringify(body))
  return { request, promise }
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-mcp-output-'))
  const handlers = new Map()
  const calls = []
  const context = { projectId, canvasId, version: 1 }
  let task = {
    taskId: '', canvasId, status: 'succeeded', modality: 'text',
    outputs: [{ index: 0, sizeBytes: 0, outputMeta: null }],
  }
  let taskProjectId
  let textOutput = ''
  const mediaResults = new Map()
  let mediaGate = null
  let notifyMediaStarted = null
  const service = createMcpMainService({
    userDataDirectory: path.join(root, 'user-data', 'VibePaper'),
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    assertTrustedSender: () => {},
    getActiveContext: async () => ({ ...context }),
    getWorker: () => ({ request: async () => ({ tools: [] }) }),
    getProviderSettings: () => null,
    loadCanvas: async () => ({ ...context }),
    getLocalCore: () => ({ request: async (method, input) => {
      calls.push({ method, input })
      if (method === 'task:get') return { ...task, taskId: input.taskId,
        ...(taskProjectId === undefined ? {} : { projectId: taskProjectId }) }
      if (method === 'task:read-output') return textOutput
      if (method === 'task:read-output-media') {
        notifyMediaStarted?.()
        if (mediaGate) await mediaGate
        const result = mediaResults.get(input.outputIndex)
        if (!result) throw Object.assign(new Error('missing test media result'), { code: 'TASK_OUTPUT_NOT_FOUND' })
        return result
      }
      throw new Error(`unexpected core request: ${method}`)
    } }),
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: () => {} } }),
  })
  t.after(async () => {
    await service.stop()
    await fs.rm(root, { recursive: true, force: true })
  })
  const instance = await service.start()
  const invoke = (name, input) => handlers.get(`desktop:mcp:${name}`)({}, input)
  await invoke('canvas-ready:set', { projectId, canvasId, version: 1, ready: true })
  await invoke('enabled:set', true)
  const client = await invoke('client:create', { clientName: 'codex',
    permissions: options.permissions || ['task.read'], providerGrants: [], mediaTypes: options.mediaTypes || [],
    disclosureVersion: 'desktop-mcp-provider-disclosure-v1', accepted: true })
  const grant = service.getStore().getClient(client.clientId)
  const bootstrapResponse = await openPostJson(instance.port, '/bootstrap', {
    clientId: client.clientId, grantId: grant.grantId,
    clientInfo: { name: 'output-fixture', version: '1' }, shortCode: '123456',
  }).promise
  const session = bootstrapResponse.body
  assert.equal(bootstrapResponse.status, 200)
  const beginCall = (argumentsValue) => openPostJson(instance.port, '/rpc', {
    method: 'tools/call', params: { name: 'read_task_output', arguments: argumentsValue },
  }, session.accessToken)
  const call = async (argumentsValue) => (await beginCall(argumentsValue).promise).body
  const setTask = (patch) => { task = { ...task, ...patch } }
  const setText = (value) => { textOutput = value }
  const setTaskProject = (value) => { taskProjectId = value }
  const setMedia = (index, value) => { mediaResults.set(index, value) }
  const holdMediaRead = () => {
    let release
    let started
    const startedPromise = new Promise((resolve) => { started = resolve })
    mediaGate = new Promise((resolve) => { release = resolve })
    notifyMediaStarted = () => { notifyMediaStarted = null; started() }
    return { started: startedPromise, release: () => { mediaGate = null; release() } }
  }
  return { call, beginCall, calls, setTask, setText, setTaskProject, setMedia, holdMediaRead, service }
}

test('MCP reads task text with bounded Unicode pagination and standard text content', async (t) => {
  const f = await fixture(t)
  f.setText('A🙂BC')
  const page = await f.call({ taskId: 'fixture-task', offset: 1, limit: 2 })
  assert.equal(page.isError, undefined)
  assert.deepEqual(page.content, [{ type: 'text', text: '🙂B' }])
  assert.deepEqual(page.structuredContent, {
    taskId: 'fixture-task', status: 'succeeded', modality: 'text', outputIndex: 0,
    output: '🙂B', offset: 1, nextOffset: 3, totalCharacters: 4, hasMore: true,
  })
  assert.equal(f.calls.filter((entry) => entry.method === 'task:read-output').length, 1)
})

test('MCP reads a selected image output as standard image content only after explicit preview', async (t) => {
  const f = await fixture(t, { permissions: ['task.read', 'media.read'], mediaTypes: ['image'] })
  f.setTask({ modality: 'image', outputs: [{ index: 0, sizeBytes: onePixelPng.length },
    { index: 1, sizeBytes: onePixelPng.length }] })
  f.setMedia(1, { bytes: Uint8Array.from(onePixelPng), mimeType: 'image/png', modality: 'image',
    outputIndex: 1, sizeBytes: onePixelPng.length })

  const metadata = await f.call({ taskId: 'fixture-task', outputIndex: 1 })
  assert.equal(metadata.structuredContent.mode, 'metadata')
  assert.equal(metadata.structuredContent.outputIndex, 1)
  assert.equal(f.calls.filter((entry) => entry.method === 'task:read-output-media').length, 0)

  const preview = await f.call({ taskId: 'fixture-task', outputIndex: 1, mode: 'preview' })
  assert.deepEqual(CallToolResultSchema.parse(preview), preview)
  assert.deepEqual(preview.content, [{ type: 'image', data: onePixelPng.toString('base64'), mimeType: 'image/png' }])
  assert.equal(preview.structuredContent.outputIndex, 1)
  assert.equal(preview.structuredContent.sizeBytes, onePixelPng.length)
  assert.equal(f.calls.find((entry) => entry.method === 'task:read-output-media').input.outputIndex, 1)
  assert.equal(JSON.stringify(preview).includes('filePath'), false)
})

test('MCP returns video preview bytes in an embedded standard resource', async (t) => {
  const f = await fixture(t, { permissions: ['task.read', 'media.read'], mediaTypes: ['video'] })
  f.setTask({ modality: 'video', outputs: [{ index: 0, sizeBytes: tinyMp4.length }] })
  f.setMedia(0, { bytes: Uint8Array.from(tinyMp4), mimeType: 'video/mp4', modality: 'video',
    outputIndex: 0, sizeBytes: tinyMp4.length })

  const result = await f.call({ taskId: 'fixture-task', mode: 'preview' })
  assert.deepEqual(CallToolResultSchema.parse(result), result)
  assert.deepEqual(result.content, [{ type: 'resource', resource: {
    uri: 'vibepaper://task-output/fixture-task/0', mimeType: 'video/mp4', blob: tinyMp4.toString('base64'),
  } }])
  assert.equal(result.structuredContent.mode, 'preview')
  assert.equal(result.structuredContent.modality, 'video')
})

test('MCP checks independent media permission and media type, task project, canvas, and status', async (t) => {
  const noMediaPermission = await fixture(t)
  noMediaPermission.setTask({ modality: 'image', outputs: [{ index: 0, sizeBytes: onePixelPng.length }] })
  assert.equal((await noMediaPermission.call({ taskId: 'fixture-task', mode: 'preview' })).structuredContent.errorCode,
    'PERMISSION_DENIED')

  const wrongMediaType = await fixture(t, { permissions: ['task.read', 'media.read'], mediaTypes: ['video'] })
  wrongMediaType.setTask({ modality: 'image', outputs: [{ index: 0, sizeBytes: onePixelPng.length }] })
  assert.equal((await wrongMediaType.call({ taskId: 'fixture-task', mode: 'preview' })).structuredContent.errorCode,
    'PERMISSION_DENIED')

  const scoped = await fixture(t, { permissions: ['task.read', 'media.read'], mediaTypes: ['image'] })
  scoped.setTask({ modality: 'image', outputs: [{ index: 0, sizeBytes: onePixelPng.length }] })
  scoped.setTaskProject('another-project')
  assert.equal((await scoped.call({ taskId: 'fixture-task', mode: 'preview' })).structuredContent.errorCode, 'TASK_NOT_FOUND')
  scoped.setTaskProject(undefined)
  scoped.setTask({ canvasId: 'another-canvas' })
  assert.equal((await scoped.call({ taskId: 'fixture-task', mode: 'preview' })).structuredContent.errorCode, 'TASK_NOT_FOUND')
  scoped.setTask({ canvasId, status: 'running' })
  assert.equal((await scoped.call({ taskId: 'fixture-task', mode: 'preview' })).structuredContent.errorCode, 'TASK_NOT_FOUND')
  assert.equal(scoped.calls.filter((entry) => entry.method === 'task:read-output-media').length, 0)
})

test('MCP cancellation after a media read starts clears returned bytes and does not publish them', async (t) => {
  const f = await fixture(t, { permissions: ['task.read', 'media.read'], mediaTypes: ['image'] })
  f.setTask({ modality: 'image', outputs: [{ index: 0, sizeBytes: onePixelPng.length }] })
  const bytes = Uint8Array.from(onePixelPng)
  f.setMedia(0, { bytes, mimeType: 'image/png', modality: 'image', outputIndex: 0, sizeBytes: bytes.length })
  const gate = f.holdMediaRead()
  const pending = f.beginCall({ taskId: 'fixture-task', mode: 'preview' })
  await gate.started
  pending.request.destroy()
  await new Promise((resolve) => setImmediate(resolve))
  gate.release()
  await pending.promise.catch(() => undefined)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bytes.some((byte) => byte !== 0), false)
})

test('MCP validates the expanded shared task output schema', async () => {
  const source = path.resolve(__dirname, '../../pi-main/packages/vibepaper-agent-service/src/desktop/mcp-runtime.ts')
  const runtime = await import(pathToFileURL(source).href)
  const tool = runtime.listMcpAuxiliaryTools().find((entry) => entry.name === 'read_task_output')
  assert.deepEqual(tool.inputSchema.properties.outputIndex, { type: 'integer', minimum: 0, maximum: 3, default: 0 })
  assert.deepEqual(tool.inputSchema.properties.mode, { type: 'string', enum: ['metadata', 'preview'], default: 'metadata' })
  assert.equal(tool.inputSchema.properties.limit.maximum, 5000)
})
