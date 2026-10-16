const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { createMcpMainService } = require('../src/mcp-main-service.cjs')
const { createMcpControlStore } = require('../src/mcp-control-store.cjs')

async function fixture(t, overrides = {}, behavior = {}) {
  const directory = await fs.mkdtemp(path.resolve(__dirname, '../../.test-temp/mcp-main-review-'))
  const handlers = new Map()
  const events = []
  const context = { projectId: 'review-project', canvasId: 'review-canvas', version: 1, name: 'Review canvas' }
  let service
  let flushStatus = 'flushed'
  let executions = 0
  const completedOperations = new Map()
  const worker = { request: async (method, input) => {
    if (method === 'mcp:tools:list') return [{ name: 'create_nodes', inputSchema: { type: 'object' } }]
    if (method === 'mcp:actions:list') return []
    if (method === 'mcp:operation:get') return completedOperations.get(input.operationId) || null
    if (method === 'mcp:tool:execute') {
      if (behavior.idempotentWorker && completedOperations.has(input.arguments.operationId)) {
        const previous = completedOperations.get(input.arguments.operationId)
        assert.deepEqual(input.arguments, previous.arguments)
        return { structuredContent: previous.publicResult }
      }
      executions += 1
      if (behavior.prepareProposal && input.toolName === 'prepare_generation') return {
        structuredContent: { status: 'awaiting_confirmation', proposalId: 'review-proposal' },
        proposal: { proposalId: 'review-proposal', confirmationItems: [{ target: 'Review target', model: 'Fixture', input: 'Fixture' }] },
      }
      if (input.toolName === 'create_nodes') context.version += 1
      const result = { status: 'completed', version: context.version }
      if (behavior.idempotentWorker) completedOperations.set(input.arguments.operationId, {
        status: 'completed', arguments: input.arguments, publicResult: result,
      })
      return { structuredContent: result }
    }
    throw new Error('UNEXPECTED_WORKER_METHOD')
  } }
  service = createMcpMainService({
    userDataDirectory: directory,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    assertTrustedSender: () => {}, getActiveContext: async () => ({ ...context }),
    getWorker: () => worker, getProviderSettings: () => ({
      snapshot: async () => ({ providers: behavior.providerConfig ? [{ id: 'fixture-provider', name: 'Fixture',
        revision: 0, credentialFields: [{ name: 'apiKey', configured: false }] }] : [], models: [] }),
      save: async () => { throw new Error('UNEXPECTED_PROVIDER_WRITE') },
    }),
    loadCanvas: async () => ({ ...context }), getLocalCore: () => null,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => {
        events.push({ channel, payload })
        if (channel === 'desktop:mcp:canvas-flush') queueMicrotask(() => {
          if (behavior.dirtySave) context.version += 1
          handlers.get('desktop:mcp:canvas-flush:respond')({}, { requestId: payload.requestId,
            projectId: payload.projectId, canvasId: payload.canvasId, status: flushStatus,
            ...(flushStatus === 'flushed' ? { persistedVersion: context.version } : { errorCode: 'REVIEW_SAVE_FAILED' }) })
        })
      },
    } }), ...overrides,
  })
  const instance = await service.start()
  t.after(async () => { await service.stop() })
  const invoke = (suffix, input) => handlers.get(`desktop:mcp:${suffix}`)({}, input)
  await invoke('canvas-ready:set',
    { projectId: context.projectId, canvasId: context.canvasId, version: context.version, ready: true })
  await invoke('enabled:set', true)
  const created = await invoke('client:create', { clientName: 'other',
    permissions: ['canvas.read', 'canvas.write', 'generation.propose', ...(behavior.providerConfig ? ['provider.read'] : [])],
    providerGrants: behavior.providerConfig ? [{ providerId: 'fixture-provider', credentialFields: [],
      credentialInputModes: [], authorizedEnv: [] }] : [],
    mediaTypes: [], disclosureVersion: 'desktop-mcp-provider-disclosure-v1', accepted: true })
  const grant = service.getStore().getClient(created.clientId)
  const request = (route, body, extraHeaders = {}) => new Promise((resolve, reject) => {
    const raw = JSON.stringify(body)
    const outgoing = http.request({ host: '127.0.0.1', port: instance.port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...extraHeaders } }, (response) => {
      let received = ''
      response.on('data', (chunk) => { received += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(received) }))
    })
    outgoing.on('error', reject); outgoing.end(raw)
  })
  const bootstrap = await request('/bootstrap', { clientId: grant.clientId, grantId: grant.grantId,
    clientInfo: { name: 'review', version: '1' }, shortCode: '123456' })
  assert.equal(bootstrap.status, 200)
  const authorization = { authorization: `Bearer ${bootstrap.body.accessToken}` }
  const call = (name, args) => request('/rpc', { method: 'tools/call', params: { name, arguments: args } }, authorization)
  return { invoke, request, call, events, context, created, grant, authorization,
    service, instance,
    setFlushStatus: (value) => { flushStatus = value }, executionCount: () => executions }
}

test('external write settles the exact renderer flush request', async (t) => {
  const f = await fixture(t)
  const result = await f.call('create_nodes', { operationId: 'review-write', expectedVersion: 1, nodes: [{ type: 'text' }] })
  assert.equal(result.body.isError, undefined)
  assert.equal(f.executionCount(), 1)
  const flush = f.events.find((event) => event.channel === 'desktop:mcp:canvas-flush')
  const settled = f.events.find((event) => event.payload.type === 'canvas.write-settled')
  assert.equal(settled?.payload.requestId, flush.payload.requestId)
})

test('failed renderer save releases the same barrier without executing worker writes', async (t) => {
  const f = await fixture(t)
  f.setFlushStatus('failed')
  const result = await f.call('create_nodes', { operationId: 'review-write', expectedVersion: 1, nodes: [{ type: 'text' }] })
  assert.equal(result.body.isError, true)
  assert.equal(f.executionCount(), 0)
  const flush = f.events.find((event) => event.channel === 'desktop:mcp:canvas-flush')
  const settled = f.events.find((event) => event.payload.type === 'canvas.write-settled')
  assert.equal(settled?.payload.requestId, flush.payload.requestId)
})

test('saving dirty renderer changes rejects stale external CAS and releases the barrier', async (t) => {
  const f = await fixture(t, {}, { dirtySave: true })
  const result = await f.call('create_nodes', { operationId: 'review-write', expectedVersion: 1, nodes: [{ type: 'text' }] })
  assert.equal(result.body.isError, true)
  assert.equal(result.body.structuredContent.errorCode, 'CANVAS_VERSION_CONFLICT')
  assert.equal(f.context.version, 2)
  assert.equal(f.executionCount(), 0)
  const flush = f.events.find((event) => event.channel === 'desktop:mcp:canvas-flush')
  const settled = f.events.find((event) => event.payload.type === 'canvas.write-settled')
  assert.equal(settled?.payload.requestId, flush.payload.requestId)
})

test('generation proposal releases the flush barrier while retaining desktop confirmation', async (t) => {
  const f = await fixture(t, {}, { prepareProposal: true })
  const result = await f.call('prepare_generation', { operationId: 'review-generation', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  assert.equal(result.body.isError, undefined)
  assert.equal(result.body.structuredContent.status, 'awaiting_confirmation')
  assert(f.events.some((event) => event.payload.type === 'pending-action.created' && event.payload.action.kind === 'generation'))
  const flush = f.events.find((event) => event.channel === 'desktop:mcp:canvas-flush')
  const settled = f.events.find((event) => event.payload.type === 'canvas.write-settled')
  assert.equal(settled?.payload.requestId, flush.payload.requestId)
})

test('Main tools reject extra fields instead of silently dropping them', async (t) => {
  const f = await fixture(t)
  const result = await f.call('get_context', { consent: true, secret: 'review-secret-canary' })
  assert.equal(result.body.isError, true)
  assert(!JSON.stringify(result.body).includes('review-secret-canary'))
})

test('loopback Origin and invalid bearer are rejected before business operations', async (t) => {
  const f = await fixture(t)
  const origin = await f.request('/rpc', { method: 'tools/list', params: {} }, { ...f.authorization, origin: 'https://untrusted.invalid' })
  assert.equal(origin.status, 403)
  const bearer = await f.request('/rpc', { method: 'tools/list', params: {} }, { authorization: 'Bearer invalid' })
  assert.equal(bearer.status, 401)
  assert.equal(f.executionCount(), 0)
})

test('revocation immediately denies the active connection', async (t) => {
  const f = await fixture(t)
  await f.invoke('client:revoke', f.created.clientId)
  const result = await f.call('get_context', {})
  assert.equal(result.status, 401)
  assert.equal(f.executionCount(), 0)
})

test('client config has separate usable Codex TOML and Claude Code JSON', async (t) => {
  const f = await fixture(t)
  assert.match(f.created.config.codex, /\[mcp_servers\.vibepaper\]/u)
  assert.match(f.created.config.codex, /startup_timeout_sec\s*=\s*150/u)
  assert.doesNotMatch(f.created.config.codex, /\benv_vars\s*=/u)
  assert.equal(JSON.parse(f.created.config.claudeCode).mcpServers.vibepaper.env.ELECTRON_RUN_AS_NODE, '1')
  assert(JSON.parse(f.created.config.claudeCode).mcpServers.vibepaper)
  assert(!f.created.config.codex.includes('accessToken'))
})

test('Codex config forwards only deduplicated authorized environment variable names', async (t) => {
  const providerSettings = {
    snapshot: async () => ({ providers: [
      { id: 'fixture-provider', name: 'Fixture', revision: 0, credentialFields: [{ name: 'apiKey' }] },
      { id: 'fixture-provider-secondary', name: 'Fixture secondary', revision: 0, credentialFields: [{ name: 'apiKey' }] },
    ], models: [] }),
  }
  const f = await fixture(t, { getProviderSettings: () => providerSettings }, { providerConfig: true })
  const sharedEnvironmentVariable = 'VIBEPAPER_REVIEW_CREDENTIAL'
  const created = await f.invoke('client:create', {
    clientName: 'codex', displayName: 'Codex authorized environment review',
    permissions: ['provider.read', 'provider.configure'],
    providerGrants: ['fixture-provider', 'fixture-provider-secondary'].map((providerId) => ({
      providerId,
      credentialFields: ['apiKey'],
      credentialInputModes: ['authorized_env'],
      authorizedEnv: [{ fieldName: 'apiKey', envVariableName: sharedEnvironmentVariable }],
    })),
    mediaTypes: [], disclosureVersion: 'desktop-mcp-provider-disclosure-v1', accepted: true,
  })
  assert.match(created.config.codex, /env_vars\s*=\s*\["VIBEPAPER_REVIEW_CREDENTIAL"\]/u)
  assert.equal(created.config.codex.match(/\bVIBEPAPER_REVIEW_CREDENTIAL\b/gu)?.length, 2)
  assert(!created.config.codex.includes('UNGRANTED_REVIEW_CREDENTIAL'))
  assert(!created.config.codex.includes('credentialValue'))
  const claudeConfig = JSON.parse(created.config.claudeCode).mcpServers.vibepaper
  assert.equal(claudeConfig.args.filter((argument) => argument === '--mcp-env-name').length, 1)
  assert(claudeConfig.args.includes(sharedEnvironmentVariable))
})

test('restarting the device store invalidates unfinished desktop authorization actions', async (t) => {
  const directory = await fs.mkdtemp(path.resolve(__dirname, '../../.test-temp/mcp-restart-review-'))
  const initial = createMcpControlStore(directory)
  for (const status of ['awaiting_pairing', 'awaiting_disclosure', 'awaiting_desktop_input']) {
    initial.createAction({ proposalId: `review-${status}`, kind: status, status,
      expiresAt: Date.now() + 60000, payload: { providerId: 'fixture-provider' } })
  }
  initial.close()
  const recovered = createMcpControlStore(directory)
  t.after(() => recovered.close())
  for (const status of ['awaiting_pairing', 'awaiting_disclosure', 'awaiting_desktop_input']) {
    assert.equal(recovered.getAction(`review-${status}`).status, 'invalidated')
  }
})

test('original provider page can finish independent provider flows while canvas writes are unavailable', async (t) => {
  const f = await fixture(t, {}, { providerConfig: true })
  await f.invoke('canvas-ready:set', { projectId: f.context.projectId, canvasId: f.context.canvasId, ready: false })
  const provider = await f.call('list_provider_configuration', { providerId: 'fixture-provider' })
  assert.equal(provider.status, 200)
  assert.equal(provider.body.isError, undefined)
  assert.equal(provider.body.structuredContent.provider.id, 'fixture-provider')
  const write = await f.call('create_nodes', { operationId: 'review-away-from-canvas', expectedVersion: 1,
    nodes: [{ type: 'text' }] })
  assert.equal(write.body.isError, true)
  assert.equal(f.executionCount(), 0)
})

test('a completed external operation replays after the canvas version advances', async (t) => {
  const f = await fixture(t, {}, { idempotentWorker: true })
  const args = { operationId: 'review-main-replay', expectedVersion: 1, nodes: [{ type: 'text' }] }
  const first = await f.call('create_nodes', args)
  assert.equal(first.body.isError, undefined)
  assert.equal(f.context.version, 2)
  const second = await f.call('create_nodes', args)
  assert.equal(second.body.isError, undefined)
  assert.deepEqual(second.body.structuredContent, first.body.structuredContent)
  assert.equal(f.context.version, 2)
  assert.equal(f.executionCount(), 1)
})

test('disconnecting during native pairing prevents a late approval from creating a live connection', async (t) => {
  let calls = 0
  let finishApproval
  let notifyDialog
  const entered = new Promise(resolve => { notifyDialog = resolve })
  const f = await fixture(t, { dialog: { showMessageBox: async () => {
    if (++calls === 1) return { response: 0 }
    notifyDialog()
    return new Promise(resolve => { finishApproval = resolve })
  } } })
  const created = await f.invoke('client:create', { clientName: 'other', permissions: ['canvas.read'],
    providerGrants: [], mediaTypes: [], disclosureVersion: 'desktop-mcp-provider-disclosure-v1', accepted: true })
  const grant = f.service.getStore().getClient(created.clientId)
  const bytes = JSON.stringify({ clientId: grant.clientId, grantId: grant.grantId,
    clientInfo: { name: 'disconnected-review', version: '1' }, shortCode: '456789' })
  const outgoing = http.request({ host: '127.0.0.1', port: f.instance.port, path: '/bootstrap', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) } })
  const disconnected = new Promise(resolve => outgoing.once('error', resolve))
  outgoing.end(bytes)
  await entered
  outgoing.destroy()
  await disconnected
  finishApproval({ response: 0 })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  const state = await f.service.getState()
  assert.equal(state.clients.find(client => client.clientId === grant.clientId).connected, false)
})
