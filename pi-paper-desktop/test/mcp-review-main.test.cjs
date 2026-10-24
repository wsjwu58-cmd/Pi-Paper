const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { createMcpMainService, createTraeMcpConfig } = require('../src/mcp-main-service.cjs')
const { createMcpControlStore } = require('../src/mcp-control-store.cjs')

async function fixture(t, overrides = {}, behavior = {}) {
  const directory = await fs.mkdtemp(path.resolve(__dirname, '../../.test-temp/mcp-main-review-'))
  const handlers = new Map()
  const events = []
  const context = { projectId: 'review-project', canvasId: 'review-canvas', version: 1, name: 'Review canvas' }
  let service
  let flushStatus = 'flushed'
  let executions = 0
  let submissions = 0
  let resolveCalls = 0
  let dialogCalls = 0
  let proposal = null
  const completedOperations = new Map()
  const worker = { request: async (method, input) => {
    if (method === 'mcp:tools:list') return [{ name: 'create_nodes', inputSchema: { type: 'object' } }]
    if (method === 'mcp:actions:list') return []
    if (method === 'mcp:operation:get') return completedOperations.get(input.operationId) || null
    if (method === 'mcp:proposal:get') {
      if (!proposal || proposal.proposalId !== input.proposalId || proposal.clientId !== input.clientId
        || proposal.grantId !== input.grantId) return null
      return { ...proposal }
    }
    if (method === 'mcp:action:resolve') {
      resolveCalls += 1
      if (!proposal || proposal.proposalId !== input.proposalId || proposal.clientId !== input.clientId
        || proposal.grantId !== input.grantId) throw Object.assign(new Error('ACTION_NOT_FOUND'), { code: 'ACTION_NOT_FOUND' })
      if (proposal.status === 'submitted' || proposal.status === 'rejected') {
        return { proposalId: proposal.proposalId, status: proposal.status,
          ...(proposal.taskIds.length ? { tasks: proposal.taskIds.map((taskId) => ({ taskId, status: 'queued' })) } : {}) }
      }
      if (input.decision === 'reject') {
        proposal.status = 'rejected'
        return { proposalId: proposal.proposalId, status: 'rejected' }
      }
      submissions += 1
      proposal.status = 'submitted'
      proposal.taskIds = ['review-task-1']
      return { proposalId: proposal.proposalId, status: 'submitted', tasks: [{ taskId: 'review-task-1', status: 'queued' }] }
    }
    if (method === 'mcp:tool:execute') {
      if (behavior.idempotentWorker && completedOperations.has(input.arguments.operationId)) {
        const previous = completedOperations.get(input.arguments.operationId)
        assert.deepEqual(input.arguments, previous.arguments)
        return { structuredContent: previous.publicResult }
      }
      executions += 1
      if (behavior.prepareProposal && input.toolName === 'prepare_generation') {
        const expiresAt = Date.now() + (behavior.proposalTtlMs ?? 60_000)
        proposal = { proposalId: 'review-proposal', kind: 'generation', operationId: input.arguments.operationId,
          status: 'awaiting_confirmation', canvasVersion: input.canvasVersion, expiresAt, taskIds: [],
          clientId: input.clientId, grantId: input.grantId, projectId: input.projectId, canvasId: input.canvasId }
        const confirmationItems = [{ target: 'Review target', model: 'Fixture', input: 'Fixture prompt', overwrite: false }]
        return {
          structuredContent: { status: 'awaiting_confirmation', proposalId: proposal.proposalId, expiresAt,
            items: confirmationItems },
          proposal: { proposalId: proposal.proposalId, confirmationItems },
        }
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
    dialog: { showMessageBox: async () => { dialogCalls += 1; return { response: 0 } } },
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
          if (behavior.deferFlush) return
          if (behavior.dirtySave) context.version += 1
          handlers.get('desktop:mcp:canvas-flush:respond')({}, { requestId: payload.requestId,
            projectId: payload.projectId, canvasId: payload.canvasId, status: flushStatus,
            ...(flushStatus === 'flushed' ? { persistedVersion: context.version } : { errorCode: 'REVIEW_SAVE_FAILED' }) })
        })
      },
    } }), ...overrides,
  })
  const instance = await service.start()
  const authRecord = JSON.parse(await fs.readFile(path.join(directory, 'mcp-bridge-auth.json'), 'utf8'))
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
  const bootstrapFor = (target = grant, secret = authRecord.secret) => request('/bootstrap', {
    clientId: target.clientId, grantId: target.grantId,
    clientInfo: { name: 'review', version: '1' }, bridgeSecret: secret,
  })
  const bootstrap = await bootstrapFor()
  assert.equal(bootstrap.status, 200)
  const authorization = { authorization: `Bearer ${bootstrap.body.accessToken}` }
  const call = (name, args, auth = authorization) => request('/rpc', { method: 'tools/call', params: { name, arguments: args } }, auth)
  const confirm = (proposalId, challengeToken, decision = 'approve', auth = authorization) => request('/rpc', {
    method: 'generation/confirm', params: { proposalId, challengeToken, decision },
  }, auth)
  return { invoke, request, call, events, context, created, grant, authorization,
    service, instance, authRecord, bootstrapFor, confirm, session: bootstrap.body,
    setFlushStatus: (value) => { flushStatus = value }, executionCount: () => executions,
    submissionCount: () => submissions, resolutionCount: () => resolveCalls,
    dialogCallCount: () => dialogCalls,
    setFlushDelay: (value) => { behavior.deferFlush = value },
    respondFlush: (payload, status = 'flushed') => {
      if (status === 'flushed') context.version = payload.expectedVersion
      handlers.get('desktop:mcp:canvas-flush:respond')({}, { requestId: payload.requestId,
        projectId: payload.projectId, canvasId: payload.canvasId, status,
        ...(status === 'flushed' ? { persistedVersion: context.version } : { errorCode: 'REVIEW_SAVE_FAILED' }) })
    },
  }
}

test('concurrent starts on one Main instance share one bridge credential and listener', async (t) => {
  const directory = await fs.mkdtemp(path.resolve(__dirname, '../../.test-temp/mcp-main-start-'))
  const service = createMcpMainService({
    userDataDirectory: directory,
    ipcMain: { handle: () => {} },
    assertTrustedSender: () => {},
    getActiveContext: async () => null,
    getProviderSettings: () => null,
    getMainWindow: () => null,
  })
  t.after(async () => { await service.stop(); await fs.rm(directory, { recursive: true, force: true }) })
  const [first, second] = await Promise.all([service.start(), service.start()])
  assert.deepEqual(first, second)
  const record = JSON.parse(await fs.readFile(path.join(directory, 'mcp-bridge-auth.json'), 'utf8'))
  assert.equal(record.instanceId, first.instanceId)
  assert.equal(first.host, '127.0.0.1')
})

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

test('generation preparation returns a client confirmation challenge without a desktop card', async (t) => {
  const f = await fixture(t, {}, { prepareProposal: true })
  const result = await f.call('prepare_generation', { operationId: 'review-generation', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  assert.equal(result.body.isError, undefined)
  assert.equal(result.body.structuredContent.status, 'awaiting_confirmation')
  assert.equal(result.body.generationConfirmation.proposalId, result.body.structuredContent.proposalId)
  assert.equal(result.body.generationConfirmation.items[0].target, 'Review target')
  assert.equal(result.body.generationConfirmation.items[0].overwrite, false)
  assert.equal(typeof result.body.generationConfirmation.challengeToken, 'string')
  assert.equal(f.events.some((event) => event.payload.type === 'pending-action.created'
    && event.payload.action.kind === 'generation'), false)
  const flush = f.events.find((event) => event.channel === 'desktop:mcp:canvas-flush')
  const settled = f.events.find((event) => event.payload.type === 'canvas.write-settled')
  assert.equal(settled?.payload.requestId, flush.payload.requestId)
})

test('bridge bootstrap rejects a bad secret and connects with the private per-instance credential', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(Object.keys(f.authRecord).sort(), ['instanceId', 'schemaVersion', 'secret'])
  assert.equal(f.authRecord.schemaVersion, 1)
  assert.equal(f.authRecord.instanceId, f.instance.instanceId)
  assert.match(f.authRecord.secret, /^[A-Za-z0-9_-]{43}$/u)
  const bad = await f.bootstrapFor(f.grant, 'x'.repeat(43))
  assert.equal(bad.status, 401)
  const good = await f.bootstrapFor()
  assert.equal(good.status, 200)
  assert.equal(f.dialogCallCount(), 0)
  const instanceFile = await fs.readFile(f.service.getInstanceFile(), 'utf8')
  assert.equal(instanceFile.includes(f.authRecord.secret), false)
  assert.equal(JSON.stringify(f.created.config).includes(f.authRecord.secret), false)
})

test('normal RPC traffic does not consume the bootstrap rate budget', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < 8; index += 1) {
    const result = await f.request('/rpc', { method: 'tools/list', params: {} }, f.authorization)
    assert.equal(result.status, 200)
  }
  const reconnected = await f.bootstrapFor()
  assert.equal(reconnected.status, 200)
})

test('bootstrap rate bucket returns 429 after eight requests in its window', async (t) => {
  const f = await fixture(t)
  // fixture() already performed the first successful bootstrap.
  for (let index = 0; index < 7; index += 1) {
    const result = await f.bootstrapFor()
    assert.equal(result.status, 200)
  }
  const exceeded = await f.bootstrapFor()
  assert.equal(exceeded.status, 429)
  assert.equal(exceeded.body.error.code, 'RATE_LIMITED')
})

test('RPC address rate bucket returns 429 after 120 requests despite per-session limits', async (t) => {
  const f = await fixture(t)
  const authorizations = [f.authorization]
  for (let index = 0; index < 2; index += 1) {
    const session = await f.bootstrapFor()
    assert.equal(session.status, 200)
    authorizations.push({ authorization: `Bearer ${session.body.accessToken}` })
  }
  for (const authorization of authorizations) {
    for (let index = 0; index < 40; index += 1) {
      const result = await f.request('/rpc', { method: 'tools/list', params: {} }, authorization)
      assert.equal(result.status, 200)
    }
  }
  const exceeded = await f.request('/rpc', { method: 'tools/list', params: {} }, authorizations[0])
  assert.equal(exceeded.status, 429)
  assert.equal(exceeded.body.error.code, 'RATE_LIMITED')
})

test('generation confirmation rejects wrong tokens and another live client session', async (t) => {
  const f = await fixture(t, {}, { prepareProposal: true })
  const prepared = await f.call('prepare_generation', { operationId: 'review-generation-scope', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  const confirmation = prepared.body.generationConfirmation
  const wrongToken = await f.confirm(confirmation.proposalId, 'x'.repeat(43))
  assert.equal(wrongToken.body.isError, true)
  assert.equal(wrongToken.body.structuredContent.errorCode, 'GENERATION_CONFIRMATION_INVALID')

  const secondGrantResult = await f.invoke('client:create', { clientName: 'codex', permissions: ['generation.propose'],
    providerGrants: [], mediaTypes: [], disclosureVersion: 'desktop-mcp-provider-disclosure-v1', accepted: true })
  const secondGrant = f.service.getStore().getClient(secondGrantResult.clientId)
  const secondBootstrap = await f.bootstrapFor(secondGrant)
  const crossSession = await f.confirm(confirmation.proposalId, confirmation.challengeToken, 'approve',
    { authorization: `Bearer ${secondBootstrap.body.accessToken}` })
  assert.equal(crossSession.body.isError, true)
  assert.equal(crossSession.body.structuredContent.errorCode, 'GENERATION_CONFIRMATION_INVALID')
  assert.equal(f.submissionCount(), 0)
})

test('generation confirmation submits once and an exact replay returns the prior task state', async (t) => {
  const f = await fixture(t, {}, { prepareProposal: true })
  const prepared = await f.call('prepare_generation', { operationId: 'review-generation-once', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  const confirmation = prepared.body.generationConfirmation
  const first = await f.confirm(confirmation.proposalId, confirmation.challengeToken, 'approve')
  assert.equal(first.body.isError, undefined)
  assert.equal(first.body.structuredContent.status, 'submitted')
  assert.deepEqual(first.body.structuredContent.tasks, [{ taskId: 'review-task-1', status: 'queued' }])
  const replay = await f.confirm(confirmation.proposalId, confirmation.challengeToken, 'approve')
  assert.equal(replay.body.isError, undefined)
  assert.equal(replay.body.structuredContent.status, 'submitted')
  assert.deepEqual(replay.body.structuredContent.tasks, first.body.structuredContent.tasks)
  assert.equal(f.submissionCount(), 1)
  assert.equal(f.resolutionCount(), 1)
})

test('replayed and concurrent generation preparation preserve the first pending client confirmation', async (t) => {
  for (const concurrent of [false, true]) {
    await t.test(concurrent ? 'concurrent requests' : 'sequential replay', async (t) => {
      const f = await fixture(t, {}, { prepareProposal: true })
      const args = { operationId: 'review-generation-pending', expectedVersion: 1,
        generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] }
      const responses = concurrent
        ? await Promise.all([f.call('prepare_generation', args), f.call('prepare_generation', args)])
        : [await f.call('prepare_generation', args), await f.call('prepare_generation', args)]
      const prepared = responses.filter((result) => result.body.generationConfirmation)
      const rejected = responses.filter((result) => result.body.isError)
      assert.equal(prepared.length, 1, 'only one response may open the confirmation form')
      assert.equal(rejected.length, 1)
      assert.equal(rejected[0].body.structuredContent.errorCode, 'GENERATION_CONFIRMATION_PENDING')
      assert.equal(f.submissionCount(), 0)
      const confirmation = prepared[0].body.generationConfirmation
      const confirmed = await f.confirm(confirmation.proposalId, confirmation.challengeToken)
      assert.equal(confirmed.body.isError, undefined, 'the original form must remain usable')
      assert.equal(confirmed.body.structuredContent.status, 'submitted')
      assert.equal(f.submissionCount(), 1)
    })
  }
})

test('generation rejection is one use and never submits a task', async (t) => {
  const f = await fixture(t, {}, { prepareProposal: true })
  const prepared = await f.call('prepare_generation', { operationId: 'review-generation-reject', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  const confirmation = prepared.body.generationConfirmation
  const first = await f.confirm(confirmation.proposalId, confirmation.challengeToken, 'reject')
  assert.equal(first.body.structuredContent.status, 'rejected')
  const replay = await f.confirm(confirmation.proposalId, confirmation.challengeToken, 'approve')
  assert.equal(replay.body.structuredContent.status, 'rejected')
  assert.equal(f.submissionCount(), 0)
  assert.equal(f.resolutionCount(), 1)
})

test('renderer action resolution cannot approve an external client proposal', async (t) => {
  const f = await fixture(t, {}, { prepareProposal: true })
  const prepared = await f.call('prepare_generation', { operationId: 'review-generation-renderer', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  await assert.rejects(f.invoke('actions:resolve', { proposalId: prepared.body.generationConfirmation.proposalId, decision: 'approve' }),
    (error) => error.code === 'MCP_CLIENT_CONFIRMATION_REQUIRED')
  assert.equal(f.submissionCount(), 0)
})

test('expired generation confirmation is rejected before task submission', async (t) => {
  const f = await fixture(t, {}, { prepareProposal: true, proposalTtlMs: 80 })
  const prepared = await f.call('prepare_generation', { operationId: 'review-generation-expired', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const result = await f.confirm(prepared.body.generationConfirmation.proposalId,
    prepared.body.generationConfirmation.challengeToken, 'approve')
  assert.equal(result.body.isError, true)
  assert.equal(result.body.structuredContent.errorCode, 'ACTION_EXPIRED')
  assert.equal(f.submissionCount(), 0)
})

test('canvas version and project changes invalidate the generation confirmation', async (t) => {
  const f = await fixture(t, {}, { prepareProposal: true })
  const prepared = await f.call('prepare_generation', { operationId: 'review-generation-version', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  f.context.version += 1
  const versionConflict = await f.confirm(prepared.body.generationConfirmation.proposalId,
    prepared.body.generationConfirmation.challengeToken, 'approve')
  assert.equal(versionConflict.body.isError, true)
  assert.equal(versionConflict.body.structuredContent.errorCode, 'CANVAS_VERSION_CONFLICT')
  assert.equal(f.submissionCount(), 0)

  const other = await fixture(t, {}, { prepareProposal: true })
  const otherPrepared = await other.call('prepare_generation', { operationId: 'review-generation-project', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  other.context.projectId = 'another-project'
  const projectConflict = await other.confirm(otherPrepared.body.generationConfirmation.proposalId,
    otherPrepared.body.generationConfirmation.challengeToken, 'approve')
  assert.equal(projectConflict.body.isError, true)
  assert.equal(other.submissionCount(), 0)
})

test('disconnecting while the renderer save barrier is pending cancels generation before Worker submission', async (t) => {
  const f = await fixture(t, {}, { prepareProposal: true })
  const prepared = await f.call('prepare_generation', { operationId: 'review-generation-cancel', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] })
  f.setFlushDelay(true)
  const confirmation = prepared.body.generationConfirmation
  const priorFlushCount = f.events.filter((event) => event.channel === 'desktop:mcp:canvas-flush').length
  const body = JSON.stringify({ method: 'generation/confirm', params: {
    proposalId: confirmation.proposalId, challengeToken: confirmation.challengeToken, decision: 'approve',
  } })
  const outgoing = http.request({ host: '127.0.0.1', port: f.instance.port, path: '/rpc', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...f.authorization } })
  const disconnected = new Promise((resolve) => outgoing.once('error', resolve))
  outgoing.end(body)
  for (let attempt = 0; attempt < 50 && f.events.filter((event) => event.channel === 'desktop:mcp:canvas-flush').length <= priorFlushCount; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const flush = f.events.filter((event) => event.channel === 'desktop:mcp:canvas-flush')[priorFlushCount]
  assert(flush, 'the confirmation must reach the Main save barrier before disconnect')
  outgoing.destroy()
  await disconnected
  f.respondFlush(flush.payload)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(f.submissionCount(), 0)
  assert.equal(f.resolutionCount(), 0)

  f.setFlushDelay(false)
  const reconnected = await f.bootstrapFor()
  const reconnectedAuth = { authorization: `Bearer ${reconnected.body.accessToken}` }
  const retried = await f.call('prepare_generation', { operationId: 'review-generation-cancel', expectedVersion: 1,
    generations: [{ nodeId: 'node', modelType: 'fixture-binding', modelParams: {}, overwrite: false }] }, reconnectedAuth)
  assert.notEqual(retried.body.generationConfirmation.challengeToken, confirmation.challengeToken)
  const oldChallenge = await f.confirm(confirmation.proposalId, confirmation.challengeToken, 'approve', reconnectedAuth)
  assert.equal(oldChallenge.body.structuredContent.errorCode, 'GENERATION_CONFIRMATION_INVALID')
  const freshChallenge = await f.confirm(retried.body.generationConfirmation.proposalId,
    retried.body.generationConfirmation.challengeToken, 'approve', reconnectedAuth)
  assert.equal(freshChallenge.body.structuredContent.status, 'submitted')
  assert.equal(f.submissionCount(), 1)
})

test('generation Core authorization rejects a session revoked during provider revision lookup', async (t) => {
  let markEntered
  let releaseLookup
  const entered = new Promise((resolve) => { markEntered = resolve })
  const revisionLookup = new Promise((resolve) => { releaseLookup = resolve })
  const f = await fixture(t, { getProviderRevisions: () => { markEntered(); return revisionLookup } })
  const accessToken = f.authorization.authorization.slice('Bearer '.length)
  const commandId = 'review-generation-command'
  f.service.getActiveCommands().set(commandId, {
    commandId, connectionId: f.session.connectionId,
    sessionTokenHash: createHash('sha256').update(accessToken).digest('hex'),
    clientId: f.created.clientId, grantId: f.grant.grantId,
    projectId: f.context.projectId, canvasId: f.context.canvasId,
    permission: 'generation.propose', providerRevisions: { 'fixture-provider': 1 },
    expiresAt: Date.now() + 60_000, revoked: false,
  })
  const authorization = f.service.authorizeAgentCoreRequest(commandId, 'agent:core:create-generation-task', {
    projectId: f.context.projectId, canvasId: f.context.canvasId, providerId: 'fixture-provider',
  })
  await entered
  await f.invoke('client:revoke', f.created.clientId)
  releaseLookup({ 'fixture-provider': 1 })
  await assert.rejects(authorization, (error) => error.code === 'PERMISSION_DENIED')
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
  assert.match(f.created.config.codex, /default_tools_approval_mode\s*=\s*"approve"/u)
  assert.match(f.created.config.codex, /tool_timeout_sec\s*=\s*660/u)
  assert.doesNotMatch(f.created.config.codex, /\benv_vars\s*=/u)
  assert.equal(JSON.parse(f.created.config.claudeCode).mcpServers.vibepaper.env.ELECTRON_RUN_AS_NODE, '1')
  assert(JSON.parse(f.created.config.claudeCode).mcpServers.vibepaper)
  assert.equal(JSON.parse(f.created.config.cursor).mcpServers.vibepaper.type, 'stdio')
  assert.equal(JSON.parse(f.created.config.workbuddy).mcpServers.vibepaper.type, 'stdio')
  assert.equal(JSON.parse(f.created.config.claudeCode).mcpServers.vibepaper.type, undefined)
  assert.deepEqual(JSON.parse(f.created.config.cursor).mcpServers.vibepaper.args,
    JSON.parse(f.created.config.claudeCode).mcpServers.vibepaper.args)
  assert.deepEqual(JSON.parse(f.created.config.workbuddy).mcpServers.vibepaper.args,
    JSON.parse(f.created.config.claudeCode).mcpServers.vibepaper.args)
  assert.deepEqual(JSON.parse(f.created.config.other).mcpServers.vibepaper.args,
    JSON.parse(f.created.config.claudeCode).mcpServers.vibepaper.args)
  assert.equal(f.created.config.traeCommandCompatible, !/\s/u.test(process.execPath))
  if (f.created.config.traeCommandCompatible) {
    const traeServer = JSON.parse(f.created.config.trae).mcpServers.vibepaper
    assert.equal(traeServer.type, undefined)
    assert.deepEqual(traeServer.args, JSON.parse(f.created.config.claudeCode).mcpServers.vibepaper.args)
  } else {
    assert.equal(f.created.config.trae, null)
  }
  assert(!f.created.config.codex.includes('accessToken'))
  assert(!JSON.stringify(f.created.config).includes(f.authRecord.secret))
  assert.equal(f.dialogCallCount(), 0)
})

test('TRAE config exports a no-space executable as JSON arguments without secret values', () => {
  const executable = 'E:\\pp\\Pi-Paper\\Pi-Paper.exe'
  const args = ['mcp-node-entry.cjs', '--mcp-stdio', '--mcp-env-name', 'VIBEPAPER_PROVIDER_API_KEY']
  const result = createTraeMcpConfig(executable, args)
  assert.equal(result.commandCompatible, true)
  const server = JSON.parse(result.config).mcpServers.vibepaper
  assert.equal(server.command, executable)
  assert.deepEqual(server.args, args)
  assert.deepEqual(server.env, { ELECTRON_RUN_AS_NODE: '1' })
  assert.doesNotMatch(result.config, /secret-value-canary/u)
  assert.doesNotMatch(result.config, /shell|cmd\.exe|powershell\.exe/iu)

  const spaced = createTraeMcpConfig('C:\\Program Files\\Pi Paper\\Pi-Paper.exe', args)
  assert.equal(spaced.commandCompatible, false)
  assert.equal(spaced.config, null)
})

test('Cursor, WorkBuddy, and TRAE are accepted as separate client identities', async (t) => {
  const f = await fixture(t)
  for (const clientName of ['cursor', 'workbuddy', 'trae']) {
    const created = await f.invoke('client:create', {
      clientName,
      permissions: ['canvas.read'],
      providerGrants: [],
      mediaTypes: [],
      disclosureVersion: 'desktop-mcp-provider-disclosure-v1',
      accepted: true,
    })
    assert.equal(created.grant.clientName, clientName)
    assert.equal(typeof created.config.claudeCode, 'string')
    assert.equal(typeof created.config.cursor, 'string')
    assert.equal(typeof created.config.workbuddy, 'string')
    if (!created.config.traeCommandCompatible) assert.equal(created.config.trae, null)
  }
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

test('stopping Main removes only its own private bridge credential', async (t) => {
  const f = await fixture(t)
  await f.service.stop()
  await assert.rejects(fs.access(path.join(path.dirname(f.service.getInstanceFile()), 'mcp-bridge-auth.json')),
    (error) => error.code === 'ENOENT')
  await assert.rejects(fs.access(f.service.getInstanceFile()), (error) => error.code === 'ENOENT')
  assert.equal(f.dialogCallCount(), 0)
})
