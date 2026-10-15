const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js')
const { createMcpMainService } = require('../src/mcp-main-service.cjs')
const { createMcpStdioBridge, fixedInstancePath } = require('../src/mcp-stdio.cjs')
const { createProviderSettings } = require('../src/provider-settings.cjs')

const DISCLOSURE_VERSION = 'desktop-mcp-provider-disclosure-v1'
const PROJECT_ID = 'mcp-provider-project-fixture'
const CANVAS_ID = 'mcp-provider-canvas-fixture'

function fixtureCatalog() {
  return {
    providers: [
      { id: 'fixture-image', name: 'Fixture Image', providerType: 'cloud', configurable: true,
        baseUrl: 'https://image-api.fixture.invalid/v1', allowedHosts: ['image-api.fixture.invalid'],
        credentialFields: [{ name: 'apiKey', label: 'API Key', required: true, secret: true }] },
      { id: 'fixture-video', name: 'Fixture Video', providerType: 'cloud', configurable: true,
        baseUrl: 'https://video-api.fixture.invalid/v1', allowedHosts: ['video-api.fixture.invalid'],
        credentialFields: [{ name: 'apiKey', label: 'API Key', required: true, secret: true }] },
    ],
    models: [
      { id: 'fixture-image-model', apiModelId: 'image-v1', displayName: 'Fixture Image Model',
        providerId: 'fixture-image', modelType: 'image', implemented: true, defaults: { ratio: '1:1', size: '1024x1024' },
        constraints: { acceptedAspectRatios: ['1:1'], acceptedSizes: ['1024x1024'] } },
      { id: 'fixture-video-model', apiModelId: 'video-v1', displayName: 'Fixture Video Model',
        providerId: 'fixture-video', modelType: 'video', implemented: true, defaults: { resolution: '720p', duration: 5 },
        constraints: { acceptedResolutions: ['720p'], minimumDuration: 5, maximumDuration: 5 } },
    ],
  }
}

function encryptedFixtureStorage() {
  // Test-only AES key. This is not an application credential and never leaves this fixture.
  const key = Buffer.alloc(32, 0x5a)
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'os_crypt_fixture',
    async encryptStringAsync(plain) {
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([Buffer.from('fixture-aes-gcm-v1\0'), iv, cipher.getAuthTag(), ciphertext])
    },
    async decryptStringAsync(bytes) {
      const buffer = Buffer.from(bytes)
      const marker = Buffer.from('fixture-aes-gcm-v1\0')
      if (!buffer.subarray(0, marker.length).equals(marker) || buffer.length < marker.length + 28) {
        throw new Error('invalid fixture ciphertext')
      }
      const ivStart = marker.length
      const iv = buffer.subarray(ivStart, ivStart + 12)
      const tag = buffer.subarray(ivStart + 12, ivStart + 28)
      const ciphertext = buffer.subarray(ivStart + 28)
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    },
  }
}

async function walkFiles(directory) {
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

async function assertNoPersistedCanaries(root, canaries) {
  for (const file of await walkFiles(root)) {
    const bytes = await fs.readFile(file)
    for (const canary of canaries) {
      assert.equal(bytes.includes(Buffer.from(canary)), false, `plaintext canary persisted in ${file}`)
    }
    if (file.endsWith('.jsonl')) {
      const text = bytes.toString('utf8')
      for (const canary of canaries) assert.equal(text.includes(canary), false, `canary persisted in JSONL ${file}`)
    }
  }
}

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-mcp-provider-main-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const appDataPath = path.join(root, 'app-data')
  const userDataDirectory = path.join(appDataPath, 'VibePaper')
  const providerSettingsDirectory = path.join(root, 'provider-settings')
  const providerSettings = createProviderSettings({
    directory: providerSettingsDirectory,
    safeStorage: encryptedFixtureStorage(),
    catalog: fixtureCatalog,
    testOfficialProviderConnection: async () => { throw new Error('network access is disabled in this fixture') },
  })
  const handlers = new Map()
  const events = []
  const context = { projectId: PROJECT_ID, canvasId: CANVAS_ID, version: 1, name: 'MCP provider fixture' }
  const worker = { request: async (method) => {
    if (method === 'mcp:tools:list') return []
    throw new Error(`unexpected worker request: ${method}`)
  } }
  const service = createMcpMainService({
    userDataDirectory,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    assertTrustedSender: () => {},
    getActiveContext: async () => ({ ...context }),
    getWorker: () => worker,
    getProviderSettings: () => providerSettings,
    loadCanvas: async () => ({ ...context }),
    getLocalCore: () => null,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, payload }),
    } }),
  })
  let bridge
  let client
  let running
  const additionalConnections = []
  t.after(async () => {
    await service.stop().catch(() => {})
    await bridge?.close().catch(() => {})
    await running?.catch(() => {})
    await client?.close().catch(() => {})
    for (const connection of additionalConnections) {
      await connection.bridge.close().catch(() => {})
      await connection.running?.catch(() => {})
      await connection.client.close().catch(() => {})
    }
  })
  const instance = await service.start()
  const invoke = (suffix, input) => handlers.get(`desktop:mcp:${suffix}`)({}, input)
  await invoke('canvas-ready:set', { projectId: PROJECT_ID, canvasId: CANVAS_ID, version: 1, ready: true })
  await invoke('enabled:set', true)

  const created = await invoke('client:create', {
    clientName: 'codex',
    displayName: 'MCP provider integration fixture',
    permissions: ['provider.read', 'provider.configure'],
    providerGrants: ['fixture-image', 'fixture-video'].map((providerId) => ({
      providerId,
      credentialFields: ['apiKey'],
      credentialInputModes: ['authorized_env', 'inline', 'desktop_input'],
      authorizedEnv: [{ fieldName: 'apiKey', envVariableName: providerId === 'fixture-image'
        ? 'VIBEPAPER_FIXTURE_IMAGE_KEY' : 'VIBEPAPER_FIXTURE_VIDEO_KEY' }],
    })),
    mediaTypes: ['image', 'video'],
    disclosureVersion: DISCLOSURE_VERSION,
    accepted: true,
  })
  const configArgs = JSON.parse(created.config.claudeCode).mcpServers.vibepaper.args
  const grantIdFlag = configArgs.indexOf('--mcp-grant-id')
  assert(grantIdFlag >= 0 && typeof configArgs[grantIdFlag + 1] === 'string')
  const grantId = configArgs[grantIdFlag + 1]

  const canaries = [
    'fixture-image-env-key-canary-21d7',
    'fixture-image-env-key-conflict-canary-c490',
    'fixture-video-inline-key-canary-8a36',
    'fixture-video-inline-key-conflict-canary-f22b',
    'fixture-video-desktop-key-canary-d375',
    'fixture-revoked-desktop-key-canary-9e31',
  ]
  const env = {
    VIBEPAPER_FIXTURE_IMAGE_KEY: canaries[0],
    VIBEPAPER_FIXTURE_VIDEO_KEY: 'fixture-video-env-unused-canary',
  }
  const httpRecords = []
  const localFetch = globalThis.fetch
  const fetchImpl = async (input, init) => {
    const url = new URL(input)
    if (url.hostname !== '127.0.0.1') throw new Error('public network access is disabled in this fixture')
    const requestBody = init?.body === undefined ? undefined : JSON.parse(Buffer.from(init.body).toString('utf8'))
    const response = await localFetch(input, init)
    const responseBody = await response.clone().json().catch(() => null)
    httpRecords.push({ route: url.pathname, requestBody, responseBody, eventCount: events.length })
    return response
  }

  const instanceFilePath = fixedInstancePath(appDataPath)
  assert.equal(instanceFilePath, path.join(userDataDirectory, 'mcp-instance.json'))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const stderrLines = []
  bridge = createMcpStdioBridge({
    appDataPath,
    instanceFilePath,
    clientId: created.clientId,
    grantId,
    env,
    fetchImpl,
    transportOverride: serverTransport,
    stdin: new (require('node:stream').PassThrough)(),
    stderr: { write: (line) => stderrLines.push(line) },
    processLike: new EventEmitter(),
    randomCode: () => '482906',
  })
  client = new Client({ name: 'provider-main-integration', version: '1.0.0' })
  running = bridge.start()
  await client.connect(clientTransport)
  const listed = await client.listTools()
  assert.equal(Array.isArray(listed.tools), true)

  async function connectAdditionalClient(grant, code) {
    const configArgs = JSON.parse(grant.config.claudeCode).mcpServers.vibepaper.args
    const grantFlag = configArgs.indexOf('--mcp-grant-id')
    assert(grantFlag >= 0 && typeof configArgs[grantFlag + 1] === 'string')
    const [additionalClientTransport, additionalServerTransport] = InMemoryTransport.createLinkedPair()
    const additionalBridge = createMcpStdioBridge({
      appDataPath,
      instanceFilePath,
      clientId: grant.clientId,
      grantId: configArgs[grantFlag + 1],
      env: {},
      fetchImpl,
      transportOverride: additionalServerTransport,
      stdin: new (require('node:stream').PassThrough)(),
      stderr: { write: (line) => stderrLines.push(line) },
      processLike: new EventEmitter(),
      randomCode: () => code,
    })
    const additionalClient = new Client({ name: 'provider-read-only-integration', version: '1.0.0' })
    const additionalRunning = additionalBridge.start()
    const connection = { bridge: additionalBridge, client: additionalClient, running: additionalRunning }
    additionalConnections.push(connection)
    await additionalClient.connect(additionalClientTransport)
    await additionalClient.listTools()
    return additionalClient
  }

  return {
    root, providerSettingsDirectory, providerSettings, service, handlers, invoke, events, context, created, grantId,
    client, bridge, running, env, httpRecords, stderrLines, canaries, connectAdditionalClient,
  }
}

function publicConfig(providerId) {
  const model = providerId === 'fixture-image' ? 'fixture-image-model' : 'fixture-video-model'
  const modality = providerId === 'fixture-image' ? 'image' : 'video'
  return { providerId, enabledModelIds: [model], defaultModelIds: { [modality]: model }, timeoutSeconds: 30 }
}

function configureArgs(providerId, operationId, expectedRevision, credentialInput) {
  return { providerId, operationId, expectedRevision, publicConfig: publicConfig(providerId), credentialInput }
}

async function approveDisclosure(fixture, providerId) {
  const { actions } = await fixture.invoke('actions:list')
  const action = actions.find((entry) => entry.kind === 'provider_disclosure'
    && entry.providerId === providerId && entry.status === 'awaiting_disclosure')
  assert(action, `missing pending disclosure for ${providerId}`)
  assert.equal(action.projectId, PROJECT_ID)
  assert.equal(action.canvasId, CANVAS_ID)
  assert.equal(action.providerConfig.modalities.includes(providerId === 'fixture-image' ? 'image' : 'video'), true)
  const resolved = await fixture.invoke('actions:resolve', { proposalId: action.proposalId, decision: 'approve' })
  assert.deepEqual(resolved, { proposalId: action.proposalId, status: 'authorized' })
  return action
}

function assertProviderConfigurationChanged(fixture, providerId, revision) {
  const changed = fixture.events.find((entry) => entry.channel === 'desktop:mcp:event'
    && entry.payload?.type === 'provider.configuration.changed'
    && entry.payload.providerId === providerId && entry.payload.revision === revision)
  assert(changed, `missing provider.configuration.changed for ${providerId} revision ${revision}`)
  assert.deepEqual(Object.keys(changed.payload).sort(), ['providerId', 'revision', 'type'])
}

async function saveFromProviderPage(fixture, input) {
  const authorization = await fixture.service.authorizeProviderInputSave(input)
  const result = await fixture.providerSettings.save(authorization.cleanInput, {
    assertAuthorized: authorization.assertAuthorized,
  })
  const provider = result.providers.find((entry) => entry.id === authorization.cleanInput.providerId)
  const models = result.models.filter((entry) => entry.providerId === authorization.cleanInput.providerId)
  const recorded = await fixture.service.recordProviderUiSave({
    proposalId: authorization.action.proposalId,
    clientId: authorization.client.clientId,
    grantId: authorization.client.grantId,
    operationId: authorization.action.payload.operationId,
    providerId: authorization.cleanInput.providerId,
    publicResult: { provider, models },
  })
  assert.equal(recorded, true)
  return result
}

test('Main, SQLite provider ledger, secure settings, and SDK stdio keep image/video credential writes secret-safe and idempotent', async (t) => {
  const fixture = await createFixture(t)
  const imageDirectory = await fixture.client.callTool({ name: 'list_provider_configuration',
    arguments: { providerId: 'fixture-image' } })
  assert.equal(imageDirectory.isError, undefined)
  assert.deepEqual(imageDirectory.structuredContent.credentialInputModes,
    ['authorized_env', 'inline', 'desktop_input'])
  assert.deepEqual(imageDirectory.structuredContent.allowedCredentialFields, ['apiKey'])
  const imageSource = imageDirectory.structuredContent.credentialSources
    ?.find((source) => source.providerId === 'fixture-image' && source.fieldName === 'apiKey'
      && source.sourceKind === 'authorized_env')
  assert(imageSource, 'the authorized client must discover its env source through the public provider directory')
  assert.deepEqual(Object.keys(imageSource).sort(),
    ['envVariableName', 'expiresAt', 'fieldName', 'providerId', 'sourceKind', 'sourceRef'].sort())
  assert.equal(JSON.stringify(imageDirectory).includes(fixture.canaries[0]), false)

  const readOnlyGrant = await fixture.invoke('client:create', {
    clientName: 'codex',
    displayName: 'MCP provider read-only integration fixture',
    permissions: ['provider.read'],
    providerGrants: ['fixture-image', 'fixture-video'].map((providerId) => ({
      providerId, credentialFields: [], credentialInputModes: [], authorizedEnv: [],
    })),
    mediaTypes: ['image', 'video'],
    disclosureVersion: DISCLOSURE_VERSION,
    accepted: true,
  })
  const readOnlyClient = await fixture.connectAdditionalClient(readOnlyGrant, '710244')
  for (const providerId of ['fixture-image', 'fixture-video']) {
    const state = await readOnlyClient.callTool({ name: 'list_provider_configuration', arguments: { providerId } })
    assert.equal(state.isError, undefined)
    assert.deepEqual(state.structuredContent.credentialSources, [])
    assert.deepEqual(state.structuredContent.credentialInputModes, [])
    assert.deepEqual(state.structuredContent.allowedCredentialFields, [])
  }

  const imageArgs = configureArgs('fixture-image', 'fixture-image-env-save', 0, {
    source: 'authorized_env', sourceRefs: { apiKey: imageSource.sourceRef },
  })
  const imagePending = await fixture.client.callTool({ name: 'configure_provider', arguments: imageArgs })
  assert.equal(imagePending.structuredContent.status, 'awaiting_disclosure')
  await approveDisclosure(fixture, 'fixture-image')
  const imageSaved = await fixture.client.callTool({ name: 'configure_provider', arguments: imageArgs })
  assert.equal(imageSaved.structuredContent.status, 'saved')
  assert.equal(imageSaved.structuredContent.revision, 1)
  assertProviderConfigurationChanged(fixture, 'fixture-image', 1)
  const imageReplay = await fixture.client.callTool({ name: 'configure_provider', arguments: imageArgs })
  assert.equal(imageReplay.structuredContent.status, 'saved')
  assert.equal(imageReplay.structuredContent.revision, 1)

  fixture.env.VIBEPAPER_FIXTURE_IMAGE_KEY = fixture.canaries[1]
  const imageConflict = await fixture.client.callTool({ name: 'configure_provider', arguments: imageArgs })
  assert.equal(imageConflict.isError, true)
  assert.equal(imageConflict.structuredContent.errorCode, 'IDEMPOTENCY_CONFLICT')
  fixture.env.VIBEPAPER_FIXTURE_IMAGE_KEY = fixture.canaries[0]

  const staleImageCas = await fixture.client.callTool({ name: 'configure_provider', arguments:
    configureArgs('fixture-image', 'fixture-image-stale-cas', 0, {
      source: 'authorized_env', sourceRefs: { apiKey: imageSource.sourceRef },
    }) })
  assert.equal(staleImageCas.isError, true)
  assert.equal(staleImageCas.structuredContent.errorCode, 'PROVIDER_REVISION_CONFLICT')
  assert.equal((await fixture.providerSettings.snapshot()).providers.find((provider) => provider.id === 'fixture-image').revision, 1)

  const videoInlineInput = (secret) => ({ source: 'inline', credentials: { apiKey: secret } })
  const videoArgs = configureArgs('fixture-video', 'fixture-video-inline-save', 0,
    videoInlineInput(fixture.canaries[2]))
  const videoPending = await fixture.client.callTool({ name: 'configure_provider', arguments: videoArgs })
  assert.equal(videoPending.structuredContent.status, 'awaiting_disclosure')
  assert.equal(JSON.stringify(videoPending).includes(fixture.canaries[2]), false)
  await approveDisclosure(fixture, 'fixture-video')
  const videoSaved = await fixture.client.callTool({ name: 'configure_provider', arguments:
    configureArgs('fixture-video', 'fixture-video-inline-save', 0, videoInlineInput(fixture.canaries[2])) })
  assert.equal(videoSaved.structuredContent.status, 'saved')
  assert.equal(videoSaved.structuredContent.revision, 1)
  assertProviderConfigurationChanged(fixture, 'fixture-video', 1)
  const videoReplay = await fixture.client.callTool({ name: 'configure_provider', arguments:
    configureArgs('fixture-video', 'fixture-video-inline-save', 0, videoInlineInput(fixture.canaries[2])) })
  assert.equal(videoReplay.structuredContent.status, 'saved')
  assert.equal(videoReplay.structuredContent.revision, 1)
  const videoConflict = await fixture.client.callTool({ name: 'configure_provider', arguments:
    configureArgs('fixture-video', 'fixture-video-inline-save', 0, videoInlineInput(fixture.canaries[3])) })
  assert.equal(videoConflict.isError, true)
  assert.equal(videoConflict.structuredContent.errorCode, 'IDEMPOTENCY_CONFLICT')

  const disclosureRecords = fixture.events.filter((event) => event.payload?.type === 'pending-action.created'
    && event.payload.action?.kind === 'provider_disclosure')
  assert.equal(disclosureRecords.some((event) => event.payload.action.providerConfig.modalities.includes('image')), true)
  assert.equal(disclosureRecords.some((event) => event.payload.action.providerConfig.modalities.includes('video')), true)

  const snapshot = await fixture.providerSettings.snapshot()
  assert.equal(snapshot.models.find((model) => model.id === 'fixture-image-model').enabled, true)
  assert.equal(snapshot.models.find((model) => model.id === 'fixture-video-model').enabled, true)
  assert.equal((await fixture.providerSettings.credentials('fixture-image')).apiKey, fixture.canaries[0])
  assert.equal((await fixture.providerSettings.credentials('fixture-video')).apiKey, fixture.canaries[2])
  assert.equal(JSON.stringify(snapshot).includes(fixture.canaries[0]), false)
  assert.equal(JSON.stringify(snapshot).includes(fixture.canaries[2]), false)

  const videoInlineRequests = fixture.httpRecords.filter((entry) => entry.route === '/rpc'
    && entry.requestBody?.method === 'tools/call'
    && entry.requestBody?.params?.name === 'configure_provider'
    && entry.requestBody.params.arguments?.providerId === 'fixture-video'
    && entry.requestBody.params.arguments?.credentialInput?.source === 'inline')
  assert(videoInlineRequests.length >= 6)
  assert.equal(videoInlineRequests[0].requestBody.credentialValues, undefined,
    'the first inline preflight must not read/send values before disclosure')
  const videoDisclosureAuthorized = fixture.events.find((entry) => entry.payload?.type === 'pending-action.updated'
    && entry.payload.action?.kind === 'provider_disclosure'
    && entry.payload.action?.providerId === 'fixture-video'
    && entry.payload.action?.status === 'authorized')
  assert(videoDisclosureAuthorized, 'the desktop must authorize video disclosure before the credentialed retry')
  for (const entry of videoInlineRequests) {
    const values = entry.requestBody.credentialValues
    if (values && Object.keys(values).length) {
      assert.equal(entry.eventCount > fixture.events.indexOf(videoDisclosureAuthorized), true,
        'inline values may cross only after the desktop disclosure event')
      assert.equal(Object.values(values).length, 1)
      assert.equal([fixture.canaries[2], fixture.canaries[3]].includes(Object.values(values)[0]), true)
    }
  }

  const canaries = [...fixture.canaries, 'fixture-video-env-unused-canary']
  const responseText = JSON.stringify(fixture.httpRecords.map((entry) => entry.responseBody))
  const publicText = JSON.stringify({ events: fixture.events, stderr: fixture.stderrLines,
    clientConfig: fixture.created.config, snapshot })
  for (const canary of canaries) {
    assert.equal(responseText.includes(canary), false, `HTTP response leaked ${canary}`)
    assert.equal(publicText.includes(canary), false, `public state leaked ${canary}`)
  }
  await fixture.service.stop()
  const providerConfig = await fs.readFile(path.join(fixture.providerSettingsDirectory, 'providers.json'), 'utf8')
  for (const canary of canaries) assert.equal(providerConfig.includes(canary), false)
  await assertNoPersistedCanaries(fixture.root, canaries)
})

test('desktop_input saves the exact proposal with the canvas unavailable and a live revoke blocks a later save', async (t) => {
  const fixture = await createFixture(t)
  const videoArgs = configureArgs('fixture-video', 'fixture-video-desktop-input', 0, { source: 'desktop_input' })
  const pending = await fixture.client.callTool({ name: 'configure_provider', arguments: videoArgs })
  assert.equal(pending.structuredContent.status, 'awaiting_disclosure')
  await approveDisclosure(fixture, 'fixture-video')
  const desktopInput = await fixture.client.callTool({ name: 'configure_provider', arguments: videoArgs })
  assert.equal(desktopInput.structuredContent.status, 'awaiting_desktop_input')
  const proposalId = desktopInput.structuredContent.pendingActionId
  const action = fixture.service.getStore().getAction(proposalId)
  assert.equal(action.kind, 'provider_input')
  assert.equal(action.status, 'awaiting_desktop_input')
  assert.deepEqual(action.payload.credentialFields, ['apiKey'])

  await fixture.invoke('canvas-ready:set', { projectId: PROJECT_ID, canvasId: CANVAS_ID, ready: false })
  const providerPageState = await fixture.client.callTool({ name: 'list_provider_configuration',
    arguments: { providerId: 'fixture-video' } })
  assert.equal(providerPageState.isError, undefined)
  assert.equal(providerPageState.structuredContent.provider.id, 'fixture-video')

  const exactUiInput = {
    ...publicConfig('fixture-video'),
    baseUrl: 'https://video-api.fixture.invalid/v1',
    modelDefaults: {},
    expectedRevision: 0,
    operationId: 'fixture-video-desktop-input',
    mcpProposalId: proposalId,
    credentials: { apiKey: fixture.canaries[4] },
  }
  const mismatch = { ...exactUiInput, enabledModelIds: ['different-model'] }
  await assert.rejects(fixture.service.authorizeProviderInputSave(mismatch),
    (error) => error.code === 'MCP_PROVIDER_INPUT_MISMATCH')
  const saved = await saveFromProviderPage(fixture, exactUiInput)
  assert.equal(saved.providers.find((provider) => provider.id === 'fixture-video').revision, 1)
  assert.equal((await fixture.providerSettings.credentials('fixture-video')).apiKey, fixture.canaries[4])
  assert.equal(fixture.service.getStore().getAction(proposalId).status, 'completed')
  assert.equal(fixture.service.getStore().getOperation({ operationId: 'fixture-video-desktop-input',
    clientId: fixture.created.clientId, grantId: fixture.grantId }).status, 'saved')

  const revokeArgs = configureArgs('fixture-image', 'fixture-image-revoked-desktop-input', 0,
    { source: 'desktop_input' })
  const revokePending = await fixture.client.callTool({ name: 'configure_provider', arguments: revokeArgs })
  assert.equal(revokePending.structuredContent.status, 'awaiting_disclosure')
  await approveDisclosure(fixture, 'fixture-image')
  const revokeInput = await fixture.client.callTool({ name: 'configure_provider', arguments: revokeArgs })
  assert.equal(revokeInput.structuredContent.status, 'awaiting_desktop_input')
  const revokedProposalId = revokeInput.structuredContent.pendingActionId

  await fixture.invoke('client:revoke', fixture.created.clientId)
  assert.equal(fixture.service.getStore().getAction(revokedProposalId).status, 'invalidated')
  await assert.rejects(fixture.service.authorizeProviderInputSave({
    ...publicConfig('fixture-image'),
    baseUrl: 'https://image-api.fixture.invalid/v1',
    modelDefaults: {},
    expectedRevision: 0,
    operationId: 'fixture-image-revoked-desktop-input',
    mcpProposalId: revokedProposalId,
    credentials: { apiKey: fixture.canaries[5] },
  }), (error) => error.code === 'ACTION_NOT_FOUND')
  const afterRevoke = await fixture.client.callTool({ name: 'list_provider_configuration',
    arguments: { providerId: 'fixture-image' } })
  assert.equal(afterRevoke.isError, true)
  assert.equal(afterRevoke.structuredContent.errorCode, 'UNAUTHORIZED')
  assert.equal((await fixture.providerSettings.snapshot()).providers.find((provider) => provider.id === 'fixture-image').revision, 0)

  const canaries = [...fixture.canaries, 'fixture-video-env-unused-canary']
  const responseText = JSON.stringify(fixture.httpRecords.map((record) => record.responseBody))
  const returnedText = JSON.stringify({ events: fixture.events, stderr: fixture.stderrLines,
    clientConfig: fixture.created.config, saved: saved.providers })
  for (const canary of canaries) {
    assert.equal(responseText.includes(canary), false, `HTTP response leaked ${canary}`)
    assert.equal(returnedText.includes(canary), false, `public return value leaked ${canary}`)
  }

  const configureRequests = fixture.httpRecords.filter((record) => record.route === '/rpc'
    && record.requestBody?.method === 'tools/call'
    && record.requestBody?.params?.name === 'configure_provider')
  assert(configureRequests.length >= 4)
  for (const record of configureRequests) {
    const publicArguments = record.requestBody.params.arguments
    for (const canary of canaries) assert.equal(JSON.stringify(publicArguments).includes(canary), false)
  }
  const operationIds = ['fixture-video-desktop-input', 'fixture-image-revoked-desktop-input']
  for (const operationId of operationIds) {
    const record = fixture.service.getStore().getOperation({ operationId,
      clientId: fixture.created.clientId, grantId: fixture.grantId })
    for (const canary of canaries) assert.equal(JSON.stringify(record).includes(canary), false)
  }
  await fixture.service.stop()
  const providerConfig = await fs.readFile(path.join(fixture.providerSettingsDirectory, 'providers.json'), 'utf8')
  for (const canary of canaries) assert.equal(providerConfig.includes(canary), false)
  await assertNoPersistedCanaries(fixture.root, canaries)
})
