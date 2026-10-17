const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
const {
  BridgeFailure,
  callProviderWithCredentialPreflight,
  createMcpStdioBridge,
  fixedBridgeAuthPath,
  fixedInstancePath,
  prepareCredentialCall,
  readBridgeAuthFile,
  readInstanceFile,
  sanitizeTaskOutputResult,
  scrubValue,
  stripGenerationConfirmation,
  validateBridgeAuth,
  validateCredentialSources,
  validateGenerationConfirmation,
} = require('../src/mcp-stdio.cjs')

const BRIDGE_SECRET = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url')

async function writeMcpAuthFiles(appDataPath, instance, secret = BRIDGE_SECRET) {
  const instancePath = fixedInstancePath(appDataPath)
  const authPath = fixedBridgeAuthPath(appDataPath)
  await fs.mkdir(path.dirname(instancePath), { recursive: true })
  await fs.writeFile(instancePath, JSON.stringify(instance), { mode: 0o600 })
  await fs.writeFile(authPath, JSON.stringify({ schemaVersion: 1, instanceId: instance.instanceId,
    secret }), { mode: 0o600 })
}

async function createGenerationFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VibePaper MCP generation elicitation '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDataPath = path.join(root, 'App Data')
  const instanceFilePath = fixedInstancePath(appDataPath)
  const initialInstanceId = '00000000-0000-4000-8000-000000000081'
  const connectionId = '00000000-0000-4000-8000-000000000082'
  const accessToken = 'generation-test-access-token-that-stays-in-memory'
  const instance = { schemaVersion: 1, instanceId: initialInstanceId, host: '127.0.0.1', port: 32187,
    protocolVersion: 1, pid: process.pid }
  let activeInstanceId = initialInstanceId
  let activeBridgeSecret = options.bridgeSecret || BRIDGE_SECRET
  let bootstrapCalls = 0
  let prepareCalls = 0
  let confirmationCalls = 0
  let approvedTasks = 0
  let markConfirmationCall
  const confirmationCalled = new Promise((resolve) => { markConfirmationCall = resolve })
  const confirmations = []
  const elicitationRequests = []
  const proposal = {
    proposalId: 'proposal-fixture-1',
    challengeToken: 'private-generation-challenge-fixture-1',
    expiresAt: Date.now() + 60_000,
    items: [{ target: 'Video node 1', model: 'Example Video Model',
      input: { prompt: 'A paper boat crossing a blue lake' }, overwrite: false }],
  }
  const send = (value, statusCode = 200) => new Response(JSON.stringify(value), {
    status: statusCode, headers: { 'content-type': 'application/json' },
  })
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname
    const body = JSON.parse(Buffer.from(init.body).toString('utf8'))
    if (route === '/bootstrap') {
      bootstrapCalls += 1
      assert.equal(body.bridgeSecret, activeBridgeSecret)
      assert.equal(body.shortCode, undefined)
      body.bridgeSecret = ''
      return send({ instanceId: activeInstanceId, connectionId, accessToken,
        expiresAt: Date.now() + 60_000, credentialSources: [] })
    }
    if (route === '/close') return send({ closed: true })
    assert.equal(route, '/rpc')
    assert.equal(init.headers.authorization, `Bearer ${accessToken}`)
    if (body.method === 'tools/list') {
      return send({ tools: [{ name: 'prepare_generation', description: 'Prepare generation',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] })
    }
    if (body.method === 'tools/call') {
      prepareCalls += 1
      const value = options.malformedProposal
        ? { ...proposal, unexpected: true, challengeToken: 'leaked-invalid-private-challenge' }
        : proposal
      return send({ content: [{ type: 'text', text: 'Waiting for client confirmation.' }],
        structuredContent: { status: 'awaiting_confirmation' }, generationConfirmation: value })
    }
    if (body.method === 'generation/confirm') {
      confirmationCalls += 1
      markConfirmationCall()
      confirmations.push(body.params)
      if (options.rejectSessionChange && body.params.challengeToken === proposal.challengeToken
        && activeInstanceId !== initialInstanceId) {
        return send({ error: { code: 'GENERATION_CONFIRMATION_INVALIDATED' } }, 400)
      }
      if (body.params.decision === 'approve') approvedTasks += 1
      return send({ content: [{ type: 'text', text: body.params.decision === 'approve' ? 'Generation submitted.' : 'Generation declined.' }],
        structuredContent: { status: body.params.decision === 'approve' ? 'submitted' : 'rejected' } })
    }
    return send({ error: { code: 'NOT_FOUND' } }, 404)
  }
  await writeMcpAuthFiles(appDataPath, instance, activeBridgeSecret)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const clientOptions = options.clientSupportsForm === false ? {} : { capabilities: { elicitation: { form: {} } } }
  const client = new Client({ name: 'generation-fixture-client', version: '1.0.0' }, clientOptions)
  if (options.elicitationHandler) {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      elicitationRequests.push(request.params)
      return options.elicitationHandler(request.params, extra)
    })
  } else if (options.clientSupportsForm !== false) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitationRequests.push(request.params)
      return options.elicitationResult || { action: 'accept', content: { confirm: true } }
    })
  }
  const bridge = createMcpStdioBridge({ appDataPath, instanceFilePath,
    clientId: '00000000-0000-4000-8000-000000000083', grantId: '00000000-0000-4000-8000-000000000084',
    fetchImpl, transportOverride: serverTransport, stdin: new (require('node:stream').PassThrough)(),
    stderr: { write() {} }, processLike: new EventEmitter(),
    elicitationTimeoutMs: options.elicitationTimeoutMs ?? 120_000,
  })
  const running = bridge.start()
  await client.connect(clientTransport)
  const changeInstance = async (nextInstanceId) => {
    activeInstanceId = nextInstanceId
    activeBridgeSecret = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64url')
    await writeMcpAuthFiles(appDataPath, { ...instance, instanceId: nextInstanceId }, activeBridgeSecret)
  }
  const close = async ({ closeClient = true } = {}) => {
    await bridge.close()
    await running
    if (closeClient) await client.close().catch(() => {})
  }
  return { bridge, client, running, close, changeInstance, initialInstanceId,
    state: { get bootstrapCalls() { return bootstrapCalls }, get prepareCalls() { return prepareCalls },
      get confirmationCalls() { return confirmationCalls }, get approvedTasks() { return approvedTasks },
      confirmations, elicitationRequests, confirmationCalled, proposal }, }
}

test('inline credential values are not read before authorized disclosure preflight', async () => {
  const secret = 'mcp-inline-secret-canary-7f2c'
  let reads = 0
  const credentials = {}
  Object.defineProperty(credentials, 'apiKey', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return secret },
  })
  const args = { providerId: 'openai', credentialInput: { source: 'inline', credentials } }
  const prepared = prepareCredentialCall(args, { randomId: () => '00000000-0000-4000-8000-000000000001' })

  assert.deepEqual(prepared.arguments.credentialInput, {
    source: 'inline', sourceRefs: { apiKey: 'inline-00000000-0000-4000-8000-000000000001' },
  })
  assert.equal(reads, 0)
  assert.deepEqual(prepared.credentialValues, {})
  assert.equal(JSON.stringify(prepared.arguments).includes(secret), false)

  let preflightCalls = 0
  const pending = await callProviderWithCredentialPreflight(async (_method, params, credentialCall) => {
    preflightCalls += 1
    assert.equal(reads, 0)
    assert.deepEqual(credentialCall.credentialValues, {})
    assert.equal(JSON.stringify(params.arguments).includes(secret), false)
    return { content: [{ type: 'text', text: 'awaiting user disclosure' }],
      structuredContent: { status: 'awaiting_disclosure' } }
  }, prepared)
  assert.equal(pending.structuredContent.status, 'awaiting_disclosure')
  assert.equal(preflightCalls, 1)
  assert.equal(reads, 0)

  const authorizedCredentials = {}
  Object.defineProperty(authorizedCredentials, 'apiKey', {
    enumerable: true,
    configurable: true,
    get() { reads += 1; return secret },
  })
  const authorized = prepareCredentialCall({ providerId: 'openai', credentialInput: {
    source: 'inline', credentials: authorizedCredentials,
  } }, { randomId: () => '00000000-0000-4000-8000-000000000001' })
  let authorizedCalls = 0
  const saved = await callProviderWithCredentialPreflight(async (_method, params, credentialCall) => {
    authorizedCalls += 1
    if (authorizedCalls === 1) {
      assert.equal(reads, 0)
      assert.deepEqual(credentialCall.credentialValues, {})
      assert.equal(JSON.stringify(params.arguments).includes(secret), false)
      return { content: [{ type: 'text', text: 'credential source is ready after disclosure' }],
        structuredContent: { errorCode: 'CREDENTIAL_SOURCE_UNAVAILABLE' }, isError: true }
    }
    assert.equal(reads, 1)
    assert.deepEqual(Object.values(credentialCall.credentialValues), [secret])
    assert.equal(JSON.stringify(params.arguments).includes(secret), false)
    return { content: [{ type: 'text', text: 'saved' }], structuredContent: { status: 'saved' } }
  }, authorized)
  assert.equal(saved.structuredContent.status, 'saved')
  assert.equal(authorizedCalls, 2)
  assert.equal(reads, 1)
  assert.equal(Object.values(authorized.credentialValues)[0], secret)

  const echoed = scrubValue({ content: [{ type: 'text', text: `server echoed ${secret}` }], structuredContent: { detail: secret } }, [secret])
  assert.equal(JSON.stringify(echoed).includes(secret), false)
})

test('provider credential source metadata survives reply scrubbing while values stay hidden', () => {
  const result = scrubValue({
    credentialInputModes: ['authorized_env', 'inline', 'unexpected-secret-like-value'],
    allowedCredentialFields: ['apiKey'],
    credentialSources: [
      { sourceRef: 'source-ref-safe-1234', providerId: 'openai', fieldName: 'apiKey',
        sourceKind: 'authorized_env', envVariableName: 'VIBEPAPER_OPENAI_KEY', expiresAt: 1_800_000_000_000 },
      { sourceRef: 'source-ref-safe-5678', providerId: 'openai', fieldName: 'apiKey',
        sourceKind: 'authorized_env', envVariableName: 'VIBEPAPER_OPENAI_KEY', expiresAt: 1_800_000_000_000,
        value: 'provider-secret-canary' },
    ],
    credentials: { apiKey: 'provider-secret-canary' },
    credentialValues: { sourceRef: 'provider-secret-canary' },
    accessToken: 'bearer-canary',
  }, [])
  assert.deepEqual(result.credentialInputModes, ['authorized_env', 'inline'])
  assert.deepEqual(result.allowedCredentialFields, ['apiKey'])
  assert.deepEqual(result.credentialSources, [{ sourceRef: 'source-ref-safe-1234', providerId: 'openai',
    fieldName: 'apiKey', sourceKind: 'authorized_env', envVariableName: 'VIBEPAPER_OPENAI_KEY',
    expiresAt: 1_800_000_000_000 }])
  assert.equal(result.credentials, '[redacted]')
  assert.equal(result.credentialValues, '[redacted]')
  assert.equal(result.accessToken, '[redacted]')
  assert.equal(JSON.stringify(result).includes('provider-secret-canary'), false)
  assert.equal(JSON.stringify(result).includes('bearer-canary'), false)
})

test('desktop_input forwards only the no-secret marker and rejects added values', () => {
  const args = { providerId: 'openai', credentialInput: { source: 'desktop_input' } }
  const prepared = prepareCredentialCall(args)
  assert.equal(prepared.arguments, args)
  assert.deepEqual(prepared.credentialValues, {})
  assert.deepEqual(prepared.secretValues, [])
  assert.throws(() => prepareCredentialCall({ providerId: 'openai', credentialInput: {
    source: 'desktop_input', credentials: { apiKey: 'must-not-cross' },
  } }), (error) => error.code === 'INVALID_INPUT')
})

test('authorized environment credentials resolve only an exact provider, field, sourceRef, and registered variable', () => {
  const source = { sourceRef: 'source-ref-0001', providerId: 'openai', fieldName: 'apiKey',
    envVariableName: 'VIBEPAPER_TEST_OPENAI_KEY', expiresAt: Date.now() + 60_000 }
  const secret = 'mcp-env-secret-canary-89af'
  const args = { providerId: 'openai', credentialInput: { source: 'authorized_env', sourceRefs: { apiKey: source.sourceRef } } }
  const prepared = prepareCredentialCall(args, { credentialSources: [source], env: { VIBEPAPER_TEST_OPENAI_KEY: secret } })
  assert.deepEqual(prepared.credentialValues, { [source.sourceRef]: secret })
  assert.equal(JSON.stringify(prepared.arguments).includes(secret), false)

  assert.throws(() => prepareCredentialCall({ ...args, providerId: 'ark' }, {
    credentialSources: [source], env: { VIBEPAPER_TEST_OPENAI_KEY: secret },
  }), (error) => error instanceof BridgeFailure && error.code === 'CREDENTIAL_SOURCE_INVALID')
  assert.throws(() => prepareCredentialCall(args, { credentialSources: [source], env: { OTHER_KEY: secret } }),
    (error) => error instanceof BridgeFailure && error.code === 'CREDENTIAL_SOURCE_UNAVAILABLE')
  assert.throws(() => prepareCredentialCall({ ...args, credentialInput: { source: 'authorized_env', sourceRefs: { voiceId: source.sourceRef } } }, {
    credentialSources: [source], env: { VIBEPAPER_TEST_OPENAI_KEY: secret },
  }), (error) => error instanceof BridgeFailure && error.code === 'CREDENTIAL_SOURCE_INVALID')
})

test('credential source descriptors are exact, bounded, unexpired, and bound to the session', () => {
  const expiresAt = Date.now() + 60_000
  assert.deepEqual(validateCredentialSources([{
    sourceRef: 'source-ref-0002', providerId: 'openai', fieldName: 'apiKey', envVariableName: 'OPENAI_KEY', expiresAt,
  }], expiresAt, Date.now()).length, 1)
  assert.throws(() => validateCredentialSources([{
    sourceRef: 'source-ref-0002', providerId: 'openai', fieldName: 'apiKey', envVariableName: 'OPENAI_KEY', expiresAt,
    secret: 'must-not-be-accepted',
  }], expiresAt, Date.now()), (error) => error.code === 'MCP_RESPONSE_INVALID')
  assert.throws(() => validateCredentialSources([{
    sourceRef: 'source-ref-0003', providerId: 'openai', fieldName: 'apiKey', envVariableName: 'OPENAI_KEY', expiresAt: Date.now() - 1,
  }], expiresAt, Date.now()), (error) => error.code === 'MCP_RESPONSE_INVALID')
})

test('task output bridge rejects malformed media blobs and mismatched metadata', () => {
  const bytes = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
  const valid = {
    content: [{ type: 'resource', resource: {
      uri: 'vibepaper://task-output/task-fixture/0', mimeType: 'video/mp4', blob: bytes.toString('base64'),
    } }],
    structuredContent: { taskId: 'task-fixture', status: 'succeeded', modality: 'video', outputIndex: 0,
      mode: 'preview', mimeType: 'video/mp4', sizeBytes: bytes.length },
  }
  assert.deepEqual(sanitizeTaskOutputResult(valid), valid)

  for (const malformed of [
    { ...valid, content: [{ type: 'resource', resource: { ...valid.content[0].resource, blob: '%%%=' } }] },
    { ...valid, content: [{ type: 'resource', resource: { ...valid.content[0].resource, uri: 'file:///secret.mp4' } }] },
    { ...valid, structuredContent: { ...valid.structuredContent, mimeType: 'video/webm' } },
    { ...valid, content: [{ type: 'resource', resource: { ...valid.content[0].resource, mimeType: 'image/png' } }] },
  ]) {
    assert.throws(() => sanitizeTaskOutputResult(malformed), (error) => error.code === 'MCP_RESPONSE_INVALID')
  }
})

test('SDK bridge carries a bounded video resource larger than the former HTTP response cap', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VibePaper MCP large media response '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDataPath = path.join(root, 'App Data')
  const instanceFilePath = fixedInstancePath(appDataPath)
  await fs.mkdir(path.dirname(instanceFilePath), { recursive: true })
  const instanceId = '00000000-0000-4000-8000-000000000031'
  const connectionId = '00000000-0000-4000-8000-000000000032'
  const accessToken = 'large-media-response-test-bearer-value-123'
  const byteLength = 600 * 1024
  const blob = Buffer.alloc(byteLength, 0x36).toString('base64')
  const payload = {
    content: [{ type: 'resource', resource: {
      uri: 'vibepaper://task-output/task-fixture/0', mimeType: 'video/mp4', blob,
    } }],
    structuredContent: { taskId: 'task-fixture', status: 'succeeded', modality: 'video', outputIndex: 0,
      mode: 'preview', mimeType: 'video/mp4', sizeBytes: byteLength },
  }
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname
    const body = route === '/bootstrap'
      ? { instanceId, connectionId, accessToken, expiresAt: Date.now() + 60_000, credentialSources: [] }
      : route === '/rpc' ? payload : { closed: true }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
  await writeMcpAuthFiles(appDataPath, { schemaVersion: 1, instanceId, host: '127.0.0.1',
    port: 32123, protocolVersion: 1, pid: process.pid })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const bridge = createMcpStdioBridge({ appDataPath, instanceFilePath,
    clientId: '00000000-0000-4000-8000-000000000033', grantId: '00000000-0000-4000-8000-000000000034',
    fetchImpl, transportOverride: serverTransport, stdin: new (require('node:stream').PassThrough)(),
    stderr: { write() {} }, processLike: new EventEmitter(),
  })
  const client = new Client({ name: 'large-media-client', version: '1.0.0' })
  const running = bridge.start()
  await client.connect(clientTransport)
  const result = await client.callTool({ name: 'read_task_output', arguments: { taskId: 'task-fixture', mode: 'preview' } })
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0].type, 'resource')
  assert.equal(result.content[0].resource.blob.length, blob.length)
  assert.equal(result.structuredContent.sizeBytes, byteLength)
  await bridge.close()
  await running
  await client.close()
})

test('instance discovery accepts only the fixed file in the application data directory and rejects symlinks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VibePaper MCP path with spaces '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDataPath = path.join(root, 'Roaming Data')
  const instancePath = fixedInstancePath(appDataPath)
  await fs.mkdir(path.dirname(instancePath), { recursive: true })
  const instance = { schemaVersion: 1, instanceId: '00000000-0000-4000-8000-000000000001',
    host: '127.0.0.1', port: 32123, protocolVersion: 1, pid: 4200 }
  await fs.writeFile(instancePath, JSON.stringify(instance), { mode: 0o600 })
  assert.deepEqual(await readInstanceFile(instancePath, appDataPath), instance)
  await assert.rejects(readInstanceFile(path.join(root, 'other.json'), appDataPath), (error) => error.code === 'MCP_LAUNCH_CONFIGURATION_INVALID')

  const symlinkFs = {
    async lstat() {
      return { isSymbolicLink: () => true, isFile: () => true, size: 128 }
    },
    async readFile() { assert.fail('a symbolic link must be rejected before following it') },
  }
  await assert.rejects(readInstanceFile(instancePath, appDataPath, symlinkFs),
    (error) => error.code === 'DESKTOP_NOT_RUNNING')
})

test('bridge authorization file is fixed-path, per-instance, bounded, and private on POSIX', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VibePaper MCP bridge auth '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDataPath = path.join(root, 'App Data')
  const authPath = fixedBridgeAuthPath(appDataPath)
  const auth = { schemaVersion: 1, instanceId: '00000000-0000-4000-8000-000000000051', secret: BRIDGE_SECRET }
  await fs.mkdir(path.dirname(authPath), { recursive: true })
  await fs.writeFile(authPath, JSON.stringify(auth), { mode: 0o600 })
  assert.deepEqual(await readBridgeAuthFile(authPath, appDataPath), auth)
  assert.throws(() => validateBridgeAuth({ ...auth, instanceId: 'public-grant-id' }),
    (error) => error.code === 'MCP_BRIDGE_AUTH_INVALID')
  await assert.rejects(readBridgeAuthFile(path.join(root, 'other-auth.json'), appDataPath),
    (error) => error.code === 'MCP_LAUNCH_CONFIGURATION_INVALID')

  const symlinkFs = {
    async lstat() { return { isSymbolicLink: () => true, isFile: () => true, size: 128 } },
    async open() { assert.fail('a symbolic link must be rejected before it is opened') },
  }
  await assert.rejects(readBridgeAuthFile(authPath, appDataPath, symlinkFs),
    (error) => error.code === 'MCP_BRIDGE_AUTH_INVALID')

  const oversizedAuthPath = fixedBridgeAuthPath(path.join(root, 'Oversized'))
  await fs.mkdir(path.dirname(oversizedAuthPath), { recursive: true })
  await fs.writeFile(oversizedAuthPath, JSON.stringify({ ...auth, padding: 'x'.repeat(5000) }), { mode: 0o600 })
  await assert.rejects(readBridgeAuthFile(oversizedAuthPath, path.join(root, 'Oversized')),
    (error) => error.code === 'MCP_BRIDGE_AUTH_INVALID')

  if (process.platform !== 'win32') {
    await fs.chmod(authPath, 0o644)
    await assert.rejects(readBridgeAuthFile(authPath, appDataPath),
      (error) => error.code === 'MCP_BRIDGE_AUTH_INVALID')
  }
})

test('private generation confirmation fields are stripped recursively from public results', () => {
  const safe = stripGenerationConfirmation({
    generationConfirmation: { proposalId: 'private', challengeToken: 'private-challenge' },
    structuredContent: { status: 'awaiting_confirmation', challenge: 'private-challenge', detail: 'visible' },
  })
  assert.deepEqual(safe, { structuredContent: { status: 'awaiting_confirmation', detail: 'visible' } })
  assert.throws(() => validateGenerationConfirmation({ proposalId: 'p', challengeToken: 'short',
    expiresAt: Date.now() + 1000, items: [] }, Date.now()), (error) => error.code === 'MCP_RESPONSE_INVALID')
})

test('official SDK client initializes offline and receives an explicit DESKTOP_NOT_RUNNING tool result', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VibePaper MCP offline '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const bridge = createMcpStdioBridge({
    appDataPath: root,
    instanceFilePath: fixedInstancePath(root),
    clientId: '00000000-0000-4000-8000-000000000001',
    grantId: '00000000-0000-4000-8000-000000000002',
    transportOverride: serverTransport,
    stdin: new (require('node:stream').PassThrough)(),
    stderr: { write() {} },
    processLike: new EventEmitter(),
  })
  const client = new Client({ name: 'fixture-client', version: '1.0.0' })
  const running = bridge.start()
  await client.connect(clientTransport)
  const listed = await client.listTools()
  assert.equal(listed.tools.length, 1)
  assert.equal(listed.tools[0].name, 'get_context')
  assert.match(listed.tools[0].description, /DESKTOP_NOT_RUNNING/u)
  const result = await client.callTool({ name: 'get_context', arguments: {} })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.errorCode, 'DESKTOP_NOT_RUNNING')
  await bridge.close()
  await running
  await client.close()
})

test('SDK stdio adapter authenticates from the private instance file, isolates inline secrets, and never retries RPC', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VibePaper MCP SDK bridge '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDataPath = path.join(root, 'App Data')
  const instanceFilePath = fixedInstancePath(appDataPath)
  await fs.mkdir(path.dirname(instanceFilePath), { recursive: true })
  const instanceId = '00000000-0000-4000-8000-000000000001'
  const connectionId = '00000000-0000-4000-8000-000000000002'
  const accessToken = 'test-bearer-value-that-is-only-kept-in-memory'
  const secret = 'mcp-live-secret-canary-fc18'
  let rpcCalls = 0
  let bootstrapCalls = 0
  let closeCalls = 0
  let bridgeSecretFromBootstrap = null
  let rpcBody = null
  const main = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response.setHeader('content-type', 'application/json')
    if (request.url === '/bootstrap') {
      bootstrapCalls += 1
      bridgeSecretFromBootstrap = body.bridgeSecret
      assert.equal(body.shortCode, undefined)
      response.end(JSON.stringify({ instanceId, connectionId, accessToken,
        expiresAt: Date.now() + 60_000, credentialSources: [] }))
      return
    }
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
    if (request.url === '/rpc') {
      rpcCalls += 1
      rpcBody = body
      if (body.method === 'tools/list') {
        response.end(JSON.stringify({ tools: [{ name: 'get_context', description: 'read context',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }))
        return
      }
      const forwarded = JSON.stringify(body.params.arguments)
      assert.equal(forwarded.includes(secret), false)
      assert.equal(body.params.arguments.credentialInput.source, 'inline')
      assert.deepEqual(Object.keys(body.params.arguments.credentialInput.sourceRefs), ['apiKey'])
      if (rpcCalls === 2) {
        assert.equal(body.credentialValues, undefined)
        response.end(JSON.stringify({ content: [{ type: 'text', text: 'waiting for disclosure' }],
          structuredContent: { status: 'awaiting_disclosure' } }))
        return
      }
      if (rpcCalls === 3) {
        assert.equal(body.credentialValues, undefined)
        response.statusCode = 400
        response.end(JSON.stringify({ error: { code: 'CREDENTIAL_SOURCE_UNAVAILABLE' } }))
        return
      }
      assert.deepEqual(Object.values(body.credentialValues), [secret])
      response.end(JSON.stringify({ content: [{ type: 'text', text: `echo: ${secret}` }],
        structuredContent: { detail: secret, status: 'saved' } }))
      return
    }
    if (request.url === '/close') {
      closeCalls += 1
      assert.equal(body.connectionId, connectionId)
      response.end(JSON.stringify({ closed: true }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }))
  })
  await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => main.close(resolve)))
  const port = main.address().port
  await writeMcpAuthFiles(appDataPath, { schemaVersion: 1, instanceId, host: '127.0.0.1', port,
    protocolVersion: 1, pid: process.pid })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const stderrLines = []
  const bridge = createMcpStdioBridge({
    appDataPath, instanceFilePath,
    clientId: '00000000-0000-4000-8000-000000000003',
    grantId: '00000000-0000-4000-8000-000000000004',
    transportOverride: serverTransport,
    stdin: new (require('node:stream').PassThrough)(),
    stderr: { write: (line) => stderrLines.push(line) },
    processLike: new EventEmitter(),
  })
  const client = new Client({ name: 'fixture-client', version: '2.0.0' })
  const running = bridge.start()
  await client.connect(clientTransport)
  const listed = await client.listTools()
  assert.equal(listed.tools[0].name, 'get_context')
  const firstInput = { providerId: 'openai', operationId: 'fixture-op-pending', expectedRevision: 0,
    credentialInput: { source: 'inline', credentials: { apiKey: secret } } }
  const pending = await client.callTool({ name: 'configure_provider', arguments: firstInput })
  assert.equal(pending.structuredContent.status, 'awaiting_disclosure')
  assert.equal(rpcCalls, 2)

  const input = { providerId: 'openai', operationId: 'fixture-op-1', expectedRevision: 0,
    credentialInput: { source: 'inline', credentials: { apiKey: secret } } }
  const result = await client.callTool({ name: 'configure_provider', arguments: input })
  assert.equal(result.content[0].text.includes(secret), false)
  assert.equal(JSON.stringify(result.structuredContent).includes(secret), false)
  assert.equal(result.structuredContent.detail, '[redacted]')
  assert.equal(bootstrapCalls, 1)
  assert.equal(rpcCalls, 4)
  assert.equal(closeCalls, 0)
  assert.equal(bridgeSecretFromBootstrap, BRIDGE_SECRET)
  assert.equal(stderrLines.join('').includes(BRIDGE_SECRET), false)
  assert.equal(stderrLines.join('').includes('approval'), false)
  assert.equal(JSON.stringify(rpcBody).includes(accessToken), false)
  assert.equal(firstInput.credentialInput.credentials.apiKey, '')
  assert.equal(input.credentialInput.credentials.apiKey, '')
  assert.equal(JSON.stringify(input).includes(secret), false)

  await bridge.close()
  await running
  await client.close()
  assert.equal(closeCalls, 1)
})

test('a first direct configure call waits for bootstrap before resolving registered environment sources', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VibePaper MCP direct env call '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDataPath = path.join(root, 'App Data')
  const instanceFilePath = fixedInstancePath(appDataPath)
  await fs.mkdir(path.dirname(instanceFilePath), { recursive: true })
  const instanceId = '00000000-0000-4000-8000-000000000011'
  const connectionId = '00000000-0000-4000-8000-000000000012'
  const accessToken = 'direct-call-test-bearer-value-123'
  const sourceRef = 'source-ref-direct-call'
  const secret = 'authorized-env-direct-call-secret'
  let bootstrapStarted
  let releaseBootstrap
  const bootstrapWait = new Promise((resolve) => { bootstrapStarted = resolve })
  const pendingBootstrap = new Promise((resolve) => { releaseBootstrap = resolve })
  let bootstrapCalls = 0
  let rpcCalls = 0
  const main = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response.setHeader('content-type', 'application/json')
    if (request.url === '/bootstrap') {
      bootstrapCalls += 1
      bootstrapStarted()
      await pendingBootstrap
      response.end(JSON.stringify({ instanceId, connectionId, accessToken, expiresAt: Date.now() + 60_000,
        credentialSources: [{ sourceRef, providerId: 'openai', fieldName: 'apiKey',
          envVariableName: 'VIBEPAPER_REGISTERED_KEY', expiresAt: Date.now() + 50_000 }] }))
      return
    }
    if (request.url === '/close') {
      response.end(JSON.stringify({ closed: true }))
      return
    }
    assert.equal(request.url, '/rpc')
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
    rpcCalls += 1
    assert.deepEqual(body.params.arguments.credentialInput, { source: 'authorized_env', sourceRefs: { apiKey: sourceRef } })
    assert.equal(JSON.stringify(body.params.arguments).includes(secret), false)
    assert.deepEqual(body.credentialValues, { [sourceRef]: secret })
    response.end(JSON.stringify({ content: [{ type: 'text', text: 'prepared' }],
      structuredContent: { status: 'awaiting_disclosure' } }))
  })
  await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => main.close(resolve)))
  await writeMcpAuthFiles(appDataPath, { schemaVersion: 1, instanceId, host: '127.0.0.1',
    port: main.address().port, protocolVersion: 1, pid: process.pid })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const bridge = createMcpStdioBridge({ appDataPath, instanceFilePath,
    clientId: '00000000-0000-4000-8000-000000000013', grantId: '00000000-0000-4000-8000-000000000014',
    transportOverride: serverTransport, stdin: new (require('node:stream').PassThrough)(),
    stderr: { write() {} }, env: { VIBEPAPER_REGISTERED_KEY: secret }, processLike: new EventEmitter(),
  })
  const client = new Client({ name: 'direct-configure-client', version: '1.0.0' })
  const running = bridge.start()
  await client.connect(clientTransport)
  await bootstrapWait
  const call = client.callTool({ name: 'configure_provider', arguments: { providerId: 'openai',
    credentialInput: { source: 'authorized_env', sourceRefs: { apiKey: sourceRef } } } })
  await new Promise((resolve) => setImmediate(resolve))
  releaseBootstrap()
  const result = await call
  assert.equal(result.structuredContent.status, 'awaiting_disclosure', JSON.stringify(result))
  assert.equal(bootstrapCalls, 1)
  assert.equal(rpcCalls, 1)
  assert.equal(JSON.stringify(result).includes(secret), false)
  await bridge.close()
  await running
  await client.close()
})

test('an SDK cancellation aborts only the pending RPC and keeps the approved connection available', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'VibePaper MCP request cancellation '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDataPath = path.join(root, 'App Data')
  const instanceFilePath = fixedInstancePath(appDataPath)
  await fs.mkdir(path.dirname(instanceFilePath), { recursive: true })
  const instanceId = '00000000-0000-4000-8000-000000000021'
  const connectionId = '00000000-0000-4000-8000-000000000022'
  const accessToken = 'cancellation-test-bearer-value-123'
  let markRpcStarted
  let markRpcAborted
  const rpcStarted = new Promise((resolve) => { markRpcStarted = resolve })
  const rpcAborted = new Promise((resolve) => { markRpcAborted = resolve })
  let bootstrapCalls = 0
  let closeCalls = 0
  let callCount = 0
  const main = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    response.setHeader('content-type', 'application/json')
    if (request.url === '/bootstrap') {
      bootstrapCalls += 1
      response.end(JSON.stringify({ instanceId, connectionId, accessToken, expiresAt: Date.now() + 60_000,
        credentialSources: [] }))
      return
    }
    assert.equal(request.headers.authorization, `Bearer ${accessToken}`)
    if (request.url === '/rpc') {
      if (body.method === 'tools/list') {
        response.end(JSON.stringify({ tools: [{ name: 'get_context', description: 'read context',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }))
        return
      }
      callCount += 1
      if (callCount === 1) {
        response.once('close', markRpcAborted)
        markRpcStarted()
        await rpcAborted
        return
      }
      if (body.params.arguments?.oversized === true) {
        response.write(JSON.stringify({ content: [{ type: 'text', text: 'x'.repeat(13 * 1024 * 1024) }] }))
        response.end()
        return
      }
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'still connected' }],
        structuredContent: { connected: true } }))
      return
    }
    if (request.url === '/close') {
      closeCalls += 1
      response.end(JSON.stringify({ closed: true }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
  })
  await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => main.close(resolve)))
  await writeMcpAuthFiles(appDataPath, { schemaVersion: 1, instanceId, host: '127.0.0.1',
    port: main.address().port, protocolVersion: 1, pid: process.pid })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const bridge = createMcpStdioBridge({ appDataPath, instanceFilePath,
    clientId: '00000000-0000-4000-8000-000000000023', grantId: '00000000-0000-4000-8000-000000000024',
    transportOverride: serverTransport, stdin: new (require('node:stream').PassThrough)(),
    stderr: { write() {} }, processLike: new EventEmitter(),
  })
  const client = new Client({ name: 'cancellation-client', version: '1.0.0' })
  const running = bridge.start()
  await client.connect(clientTransport)
  await client.listTools()
  const rejectedCredentials = { source: 'inline', credentials: { apiKey: 'must-not-cross-as-tool-input' } }
  const rejected = await client.callTool({ name: 'get_context', arguments: { credentialInput: rejectedCredentials } })
  assert.equal(rejected.structuredContent.errorCode, 'CREDENTIAL_SOURCE_INVALID')
  assert.equal(rejectedCredentials.credentials.apiKey, '')
  assert.equal(callCount, 0)

  const controller = new AbortController()
  const pending = client.callTool({ name: 'get_context', arguments: {} }, undefined, { signal: controller.signal })
  await rpcStarted
  controller.abort(new Error('test cancellation'))
  await assert.rejects(pending)
  await rpcAborted
  assert.equal(closeCalls, 0)
  assert.equal(bootstrapCalls, 1)

  const followUp = await client.callTool({ name: 'get_context', arguments: {} })
  assert.equal(followUp.structuredContent.connected, true)
  assert.equal(bootstrapCalls, 1)
  const oversized = await client.callTool({ name: 'get_context', arguments: { oversized: true } })
  assert.equal(oversized.structuredContent.errorCode, 'MCP_RESPONSE_INVALID')
  await bridge.close()
  await running
  await client.close()
  assert.equal(closeCalls, 1)
})

test('generation is confirmed through the SDK form elicitation before Main receives approve', async (t) => {
  const fixture = await createGenerationFixture(t)
  try {
    const listed = await fixture.client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['prepare_generation'])
    const result = await fixture.client.callTool({ name: 'prepare_generation', arguments: {} })
    assert.equal(result.structuredContent.status, 'submitted')
    assert.equal(fixture.state.prepareCalls, 1)
    assert.equal(fixture.state.confirmationCalls, 1)
    assert.equal(fixture.state.confirmations[0].decision, 'approve')
    assert.equal(fixture.state.confirmations[0].proposalId, fixture.state.proposal.proposalId)
    assert.equal(fixture.state.confirmations[0].challengeToken, fixture.state.proposal.challengeToken)
    assert.equal(fixture.state.approvedTasks, 1)
    const elicitation = fixture.state.elicitationRequests[0]
    assert.equal(elicitation.mode, 'form')
    assert.deepEqual(Object.keys(elicitation.requestedSchema.properties), ['confirm'])
    assert.deepEqual(elicitation.requestedSchema.required, ['confirm'])
    assert.match(elicitation.message, /Video node 1/u)
    assert.match(elicitation.message, /Example Video Model/u)
    assert.match(elicitation.message, /A paper boat crossing a blue lake/u)
    assert.match(elicitation.message, /Overwrite existing content: No/u)
    assert.match(elicitation.message, /provider fees may apply/u)
    assert.equal(JSON.stringify(result).includes(fixture.state.proposal.challengeToken), false)
    assert.equal(Object.prototype.hasOwnProperty.call(result, 'generationConfirmation'), false)
  } finally {
    await fixture.close()
  }
})

test('declined and cancelled generation forms send only a reject decision', async (t) => {
  for (const elicitationResult of [
    { action: 'decline' },
    { action: 'cancel' },
    { action: 'accept', content: { confirm: false } },
  ]) {
    const fixture = await createGenerationFixture(t, { elicitationResult })
    try {
      const result = await fixture.client.callTool({ name: 'prepare_generation', arguments: {} })
      assert.equal(result.structuredContent.status, 'rejected')
      assert.equal(fixture.state.confirmationCalls, 1)
      assert.equal(fixture.state.confirmations[0].decision, 'reject')
      assert.equal(fixture.state.approvedTasks, 0)
      assert.equal(JSON.stringify(result).includes(fixture.state.proposal.challengeToken), false)
    } finally {
      await fixture.close()
    }
  }
})

test('clients without form elicitation fail before a generation proposal is created', async (t) => {
  const fixture = await createGenerationFixture(t, { clientSupportsForm: false })
  try {
    const result = await fixture.client.callTool({ name: 'prepare_generation', arguments: {} })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.errorCode, 'CLIENT_CONFIRMATION_UNSUPPORTED')
    assert.equal(fixture.state.prepareCalls, 0)
    assert.equal(fixture.state.confirmationCalls, 0)
    assert.equal(fixture.state.approvedTasks, 0)
  } finally {
    await fixture.close()
  }
})

test('malformed private confirmation data returns a safe error without leaking its challenge', async (t) => {
  const fixture = await createGenerationFixture(t, { malformedProposal: true })
  try {
    const result = await fixture.client.callTool({ name: 'prepare_generation', arguments: {} })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.errorCode, 'MCP_RESPONSE_INVALID')
    assert.equal(JSON.stringify(result).includes('leaked-invalid-private-challenge'), false)
    assert.equal(fixture.state.confirmationCalls, 0)
    assert.equal(fixture.state.approvedTasks, 0)
  } finally {
    await fixture.close()
  }
})

test('invalid form answers fail closed without forwarding an approval decision', async (t) => {
  const fixture = await createGenerationFixture(t, {
    elicitationResult: { action: 'accept', content: { confirm: 'yes' } },
  })
  try {
    const result = await fixture.client.callTool({ name: 'prepare_generation', arguments: {} })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.errorCode, 'GENERATION_CONFIRMATION_UNRESOLVED')
    assert.equal(fixture.state.confirmationCalls, 1)
    assert.equal(fixture.state.confirmations[0].decision, 'reject')
    assert.equal(fixture.state.approvedTasks, 0)
    assert.equal(JSON.stringify(result).includes(fixture.state.proposal.challengeToken), false)
  } finally {
    await fixture.close()
  }
})

test('form elicitation timeout leaves the proposal unsubmitted', async (t) => {
  const fixture = await createGenerationFixture(t, {
    elicitationTimeoutMs: 25,
    elicitationHandler: async (_params, extra) => new Promise((resolve) => {
      extra.signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true })
    }),
  })
  try {
    const result = await fixture.client.callTool({ name: 'prepare_generation', arguments: {} })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.errorCode, 'GENERATION_CONFIRMATION_UNRESOLVED')
    assert.equal(fixture.state.confirmationCalls, 1)
    assert.equal(fixture.state.confirmations[0].decision, 'reject')
    assert.equal(fixture.state.approvedTasks, 0)
  } finally {
    await fixture.close()
  }
})

test('cancelling the MCP call while the form is open rejects the pending proposal without approval', async (t) => {
  let markElicitationStarted
  const elicitationStarted = new Promise((resolve) => { markElicitationStarted = resolve })
  const fixture = await createGenerationFixture(t, {
    elicitationHandler: async (_params, extra) => new Promise((resolve) => {
      markElicitationStarted()
      extra.signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true })
    }),
  })
  try {
    const controller = new AbortController()
    const pending = fixture.client.callTool({ name: 'prepare_generation', arguments: {} }, undefined,
      { signal: controller.signal })
    await elicitationStarted
    controller.abort(new Error('cancelled by test'))
    await assert.rejects(pending)
    await Promise.race([fixture.state.confirmationCalled, new Promise((resolve) => setTimeout(resolve, 100))])
    assert.equal(fixture.state.confirmationCalls, 1)
    assert.equal(fixture.state.confirmations[0].decision, 'reject')
    assert.equal(fixture.state.approvedTasks, 0)
  } finally {
    await fixture.close()
  }
})

test('disconnecting the client while the form is open sends no confirmation', async (t) => {
  let markElicitationStarted
  const elicitationStarted = new Promise((resolve) => { markElicitationStarted = resolve })
  const fixture = await createGenerationFixture(t, {
    elicitationHandler: async () => new Promise(() => { markElicitationStarted() }),
  })
  try {
    const pending = fixture.client.callTool({ name: 'prepare_generation', arguments: {} })
    await elicitationStarted
    await fixture.client.close()
    await assert.rejects(pending)
    await fixture.bridge.close()
    await fixture.running
    assert.equal(fixture.state.confirmationCalls, 0)
    assert.equal(fixture.state.approvedTasks, 0)
  } finally {
    await fixture.close()
  }
})

test('instance and bridge credential changes during elicitation invalidate the proposal without an RPC', async (t) => {
  let fixture
  fixture = await createGenerationFixture(t, {
    rejectSessionChange: true,
    elicitationHandler: async () => {
      await fixture.changeInstance('00000000-0000-4000-8000-000000000085')
      return { action: 'accept', content: { confirm: true } }
    },
  })
  try {
    const result = await fixture.client.callTool({ name: 'prepare_generation', arguments: {} })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.errorCode, 'GENERATION_CONFIRMATION_UNRESOLVED')
    assert.equal(fixture.state.bootstrapCalls, 1)
    assert.equal(fixture.state.confirmationCalls, 0)
    assert.equal(fixture.state.approvedTasks, 0)
    assert.equal(JSON.stringify(result).includes(fixture.state.proposal.challengeToken), false)
  } finally {
    await fixture.close()
  }
})
