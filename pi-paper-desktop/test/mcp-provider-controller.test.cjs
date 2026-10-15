const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createMcpControlStore } = require('../src/mcp-control-store.cjs')
const { createProviderSettings } = require('../src/provider-settings.cjs')
const { createMcpProviderController } = require('../src/mcp-provider-controller.cjs')

const API_KEY = 'controller-secret-canary-1'
const BASE_URL = 'https://api.openai.com/v1'
const PUBLIC_CONFIG = {
  providerId: 'openai',
  baseUrl: BASE_URL,
  enabledModelIds: ['openai-image'],
  defaultModelIds: { image: 'openai-image' },
  timeoutSeconds: 30,
}

function catalog() {
  return {
    providers: [{ id: 'openai', name: 'OpenAI', providerType: 'cloud', baseUrl: BASE_URL,
      credentialFields: [
        { name: 'apiKey', label: 'API Key', required: true, secret: true },
        { name: 'voiceId', label: 'Voice ID', required: false, secret: false },
      ] }],
    models: [{ id: 'openai-image', apiModelId: 'image-v1', displayName: 'Image V1', providerId: 'openai',
      modelType: 'image', implemented: true, inputModes: ['text'], defaults: {}, constraints: {} }],
  }
}

function safeStorage(available = true) {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (plain) => Buffer.from(`cipher:${Buffer.from(plain).toString('base64')}`),
    decryptStringAsync: async (bytes) => Buffer.from(Buffer.from(bytes).toString().replace(/^cipher:/u, ''), 'base64').toString(),
  }
}

function createLedger() {
  const records = new Map()
  const keyOf = ({ clientId, providerId, operationId }) => `${clientId}:${providerId}:${operationId}`
  return {
    records,
    async begin(input) {
      const key = keyOf(input)
      const record = records.get(key)
      if (record) return record.payloadDigest === input.payloadDigest
        ? { status: 'replay', record: { ...record } } : { status: 'conflict' }
      const created = { payloadDigest: input.payloadDigest, status: 'pending' }
      records.set(key, created)
      return { status: 'started', record: { ...created } }
    },
    async complete(input) {
      const key = keyOf(input)
      const record = records.get(key)
      if (!record) throw new Error('missing operation')
      if (['saved', 'failed', 'denied'].includes(record.status) && record.status !== input.status) throw new Error('terminal status')
      record.status = input.status
      if (input.publicResult) record.publicResult = input.publicResult
      if (input.errorCode) record.errorCode = input.errorCode
      return { ...record }
    },
    async get(input) {
      const record = records.get(keyOf(input))
      return record ? { ...record } : undefined
    },
  }
}

async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-mcp-provider-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const storage = options.storage || safeStorage()
  const makeSettings = () => createProviderSettings({ directory, safeStorage: storage, catalog,
    testOfficialProviderConnection: options.testOfficialProviderConnection, faultInjector: options.faultInjector })
  const settings = makeSettings()
  const ledger = options.ledger || createLedger()
  const calls = []
  const controllerOptions = {
    providerSettings: settings,
    providerOperationLedger: ledger,
    authorize: async (request) => { calls.push(['authorize', request.permission, request.credentialFields]); return { allowed: true } },
    ensureDisclosureAuthorization: async (request) => {
      calls.push(['disclosure', request.providerId, request.operationId])
      return options.disclosure ? options.disclosure(request) : { status: 'authorized', disclosureVersion: 'provider-v1', consentRecordId: 'consent-fixture' }
    },
    resolveAuthorizedCredentialSource: options.resolveAuthorizedCredentialSource,
    allowInlineCredentials: options.allowInlineCredentials === true,
    requestDesktopCredentialInput: options.requestDesktopCredentialInput,
    now: () => '2026-10-11T00:00:00.000Z',
  }
  return { directory, settings, makeSettings, ledger, calls, makeController: (override = {}) => createMcpProviderController({ ...controllerOptions, ...override }) }
}

function grant(overrides = {}) {
  return {
    clientId: 'client-fixture',
    permissions: ['provider.read', 'provider.configure'],
    issuedAt: Date.parse('2026-10-10T00:00:00.000Z'),
    expiresAt: Date.parse('2027-01-10T00:00:00.000Z'),
    providerGrants: [{ providerId: 'openai', credentialFields: ['apiKey', 'voiceId'],
      credentialInputModes: ['inline', 'authorized_env', 'desktop_input'],
      authorizedEnv: [{ fieldName: 'apiKey', envVariableName: 'VIBEPAPER_OPENAI_KEY' }] }],
    ...overrides,
  }
}

function inlineRequest(apiKey = API_KEY, overrides = {}) {
  return {
    grant: grant(), projectId: 'project-fixture', canvasId: 'canvas-fixture', providerId: 'openai',
    operationId: 'configure-1', expectedRevision: 0, publicConfig: { ...PUBLIC_CONFIG },
    credentialInput: { source: 'inline', credentials: { apiKey } },
    ...overrides,
  }
}

test('inline configuration is disclosed and authorized before reading the key, then only returns public state', async (t) => {
  const { settings, calls, makeController } = await setup(t, { allowInlineCredentials: true })
  const controller = makeController()
  let reads = 0
  const submitted = {}
  Object.defineProperty(submitted, 'apiKey', { enumerable: true, configurable: true, get() { reads++; return API_KEY } })
  const result = await controller.configureMcpProvider(inlineRequest(undefined, {
    credentialInput: { source: 'inline', credentials: submitted },
  }))
  assert.equal(result.status, 'saved')
  assert.equal(result.revision, 1)
  assert.equal(reads, 1)
  assert.equal(JSON.stringify(result).includes(API_KEY), false)
  assert.equal(result.provider.credentialFields.find((field) => field.name === 'apiKey').configured, true)
  assert.equal((await settings.credentials('openai')).apiKey, API_KEY)
  assert.ok(calls.findIndex((call) => call[0] === 'disclosure') > calls.findIndex((call) => call[0] === 'authorize'))
})

test('inline opaque source refs are resolved only after disclosure authorization', async (t) => {
  const { settings, makeController } = await setup(t, { allowInlineCredentials: true })
  const events = []
  const controller = makeController({
    ensureDisclosureAuthorization: async () => { events.push('disclosure'); return { status: 'authorized', disclosureVersion: 'v1', consentRecordId: 'consent-1' } },
    resolveInlineCredentialSource: async ({ sourceRef }) => { events.push(`read:${sourceRef}`); return API_KEY },
  })
  const result = await controller.configureMcpProvider(inlineRequest(undefined, {
    credentialInput: { source: 'inline', sourceRefs: { apiKey: 'inline-reference-123' } },
  }))
  assert.equal(result.status, 'saved')
  assert.deepEqual(events, ['disclosure', 'read:inline-reference-123'])
  assert.equal((await settings.credentials('openai')).apiKey, API_KEY)
})

test('disclosure pending does not read inline secret values or resolve authorized environment sources', async (t) => {
  let envReads = 0
  const { ledger, makeController } = await setup(t, {
    allowInlineCredentials: true,
    disclosure: async () => ({ status: 'awaiting_disclosure', pendingActionId: 'disclosure-action-1' }),
    resolveAuthorizedCredentialSource: async () => { envReads++; return 'env-secret' },
  })
  const controller = makeController()
  let secretReads = 0
  const credentials = {}
  Object.defineProperty(credentials, 'apiKey', { enumerable: true, configurable: true, get() { secretReads++; return API_KEY } })
  const pending = await controller.configureMcpProvider(inlineRequest(undefined, { credentialInput: { source: 'inline', credentials } }))
  assert.deepEqual(pending, { status: 'awaiting_disclosure', providerId: 'openai', operationId: 'configure-1', pendingActionId: 'disclosure-action-1' })
  assert.equal(secretReads, 0)
  assert.equal(envReads, 0)
  assert.equal(ledger.records.size, 0)
})

test('configuration authorization fails closed for missing, revoked, expired, and unscoped grants', async (t) => {
  let disclosures = 0
  const { makeController } = await setup(t, { allowInlineCredentials: true,
    disclosure: async () => { disclosures++; return { status: 'authorized', disclosureVersion: 'v1', consentRecordId: 'c1' } } })
  const missingTrustedAuthorize = makeController({ authorize: undefined })
  await assert.rejects(missingTrustedAuthorize.configureMcpProvider(inlineRequest()), (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  const controller = makeController()
  await assert.rejects(controller.configureMcpProvider(inlineRequest(API_KEY, { grant: grant({ revoked: true }) })),
    (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  await assert.rejects(controller.configureMcpProvider(inlineRequest(API_KEY, { grant: grant({ expiresAt: '2020-01-01T00:00:00.000Z' }) })),
    (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  await assert.rejects(controller.configureMcpProvider(inlineRequest(API_KEY, { grant: grant({ issuedAt: '2026-10-12T00:00:00.000Z' }) })),
    (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  await assert.rejects(controller.configureMcpProvider(inlineRequest(API_KEY, { grant: grant({ issuedAt: undefined }) })),
    (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  await assert.rejects(controller.configureMcpProvider(inlineRequest(API_KEY, { grant: grant({ providerGrants: [] }) })),
    (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  await assert.rejects(controller.configureMcpProvider(inlineRequest(API_KEY, { grant: grant(), credentialInput: {
    source: 'inline', credentials: { unscopedSecret: 'do-not-read' },
  } })), (error) => error.code === 'PROVIDER_FIELD_FORBIDDEN')
  assert.equal(disclosures, 0)
})

test('the same operation replays a saved key, while a different key conflicts without another write', async (t) => {
  const { settings, ledger, makeController } = await setup(t, { allowInlineCredentials: true })
  const controller = makeController()
  const first = await controller.configureMcpProvider(inlineRequest())
  const replay = await controller.configureMcpProvider(inlineRequest())
  assert.equal(first.status, 'saved')
  assert.equal(replay.status, 'saved')
  assert.equal(replay.revision, 1)
  assert.equal(JSON.stringify(replay).includes(API_KEY), false)
  await assert.rejects(controller.configureMcpProvider(inlineRequest('different-secret-canary')),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT' && !error.message.includes('different-secret-canary'))
  assert.equal((await settings.snapshotProvider('openai')).providers[0].revision, 1)
  assert.equal(ledger.records.size, 1)
})

test('provider operation ledger adapts the durable MCP control store started/replay records', async (t) => {
  const { directory, settings, makeController } = await setup(t, { allowInlineCredentials: true })
  const controlStore = createMcpControlStore(path.join(directory, 'mcp-control'))
  const grantId = 'grant-control-store-fixture'
  const ledger = {
    begin: async (input) => controlStore.beginOperation({
      operationId: input.operationId, clientId: input.clientId, grantId,
      projectId: 'project-fixture', canvasId: 'canvas-fixture',
      kind: `provider:${input.providerId}:configure`, payloadDigest: input.payloadDigest,
    }),
    get: async (input) => controlStore.getOperation({
      operationId: input.operationId, clientId: input.clientId, grantId,
    }),
    complete: async (input) => controlStore.completeOperation({
      operationId: input.operationId, clientId: input.clientId, grantId,
      status: input.status, result: input.publicResult, errorCode: input.errorCode,
    }),
  }
  const controller = makeController({ providerOperationLedger: ledger })
  const request = inlineRequest(API_KEY, { grant: grant({ grantId }) })
  try {
    const first = await controller.configureMcpProvider(request)
    const replay = await controller.configureMcpProvider(inlineRequest(API_KEY, { grant: grant({ grantId }) }))
    const record = controlStore.getOperation({ operationId: request.operationId,
      clientId: request.grant.clientId, grantId })

    assert.equal(first.status, 'saved')
    assert.equal(first.revision, 1)
    assert.equal(replay.status, 'saved')
    assert.equal(replay.revision, 1)
    assert.equal(record.status, 'saved')
    assert.equal(record.result.status, 'saved')
    assert.equal(JSON.stringify(record).includes(API_KEY), false)
    assert.equal((await settings.credentials('openai')).apiKey, API_KEY)
  } finally {
    controlStore.close()
  }
})

test('a pending operation recovers after settings committed but before its public ledger result', async (t) => {
  const { settings, makeSettings, ledger, makeController } = await setup(t, { allowInlineCredentials: true })
  const key = { clientId: 'client-fixture', providerId: 'openai', operationId: 'configure-1' }
  const payloadDigest = await settings.hmacProviderOperation({ providerId: 'openai', expectedRevision: 0,
    publicConfig: { ...PUBLIC_CONFIG }, credentials: { apiKey: API_KEY }, credentialSource: { mode: 'inline', fields: ['apiKey'] } })
  assert.equal((await ledger.begin({ ...key, payloadDigest })).status, 'started')
  await settings.save({ ...PUBLIC_CONFIG, expectedRevision: 0, operationId: key.operationId, credentials: { apiKey: API_KEY } })
  const restarted = makeController({ providerSettings: makeSettings() })
  const recovered = await restarted.configureMcpProvider(inlineRequest())
  assert.equal(recovered.status, 'saved')
  assert.equal(recovered.revision, 1)
  assert.equal((await ledger.get(key)).status, 'saved')
  assert.equal(JSON.stringify(recovered).includes(API_KEY), false)
})

test('a saved settings commit survives ledger completion failure and replays without another write', async (t) => {
  const delegate = createLedger()
  let failSavedCompletion = true
  const ledger = {
    records: delegate.records,
    begin: delegate.begin,
    get: delegate.get,
    async complete(input) {
      if (input.status === 'saved' && failSavedCompletion) {
        failSavedCompletion = false
        throw new Error(`ledger detail must not escape: ${API_KEY}`)
      }
      return delegate.complete(input)
    },
  }
  const { directory, settings, makeSettings, makeController } = await setup(t, { allowInlineCredentials: true, ledger })
  const controller = makeController()
  const capturedLogs = []
  const methods = ['debug', 'info', 'log', 'warn', 'error']
  const originalMethods = Object.fromEntries(methods.map((name) => [name, console[name]]))
  for (const name of methods) console[name] = (...args) => capturedLogs.push(args.map(String).join(' '))

  let failedError
  let recovered
  let conflictError
  let pendingStatus
  let savedStatus
  try {
    await assert.rejects(controller.configureMcpProvider(inlineRequest()), (error) => {
      failedError = error
      return error.code === 'PROVIDER_STATE_INCOMPLETE'
    })
    assert.equal((await settings.snapshotProvider('openai')).providers[0].revision, 1)
    assert.equal((await ledger.get({ clientId: 'client-fixture', providerId: 'openai', operationId: 'configure-1' })).status, 'pending')
    pendingStatus = await controller.getMcpProviderOperation({ grant: grant(), projectId: 'project-fixture',
      canvasId: 'canvas-fixture', providerId: 'openai', operationId: 'configure-1' })

    const restartedSettings = makeSettings()
    const originalSave = restartedSettings.save.bind(restartedSettings)
    let writesAfterRestart = 0
    restartedSettings.save = async (input) => { writesAfterRestart++; return originalSave(input) }
    const restarted = makeController({ providerSettings: restartedSettings })
    recovered = await restarted.configureMcpProvider(inlineRequest())
    assert.equal(writesAfterRestart, 0)
    assert.equal(recovered.status, 'saved')
    assert.equal(recovered.revision, 1)
    assert.equal((await ledger.get({ clientId: 'client-fixture', providerId: 'openai', operationId: 'configure-1' })).status, 'saved')
    savedStatus = await restarted.getMcpProviderOperation({ grant: grant(), projectId: 'project-fixture',
      canvasId: 'canvas-fixture', providerId: 'openai', operationId: 'configure-1' })

    await assert.rejects(restarted.configureMcpProvider(inlineRequest('different-ledger-retry-secret')),
      (error) => { conflictError = error; return error.code === 'IDEMPOTENCY_CONFLICT' })
  } finally {
    for (const name of methods) console[name] = originalMethods[name]
  }

  const ordinaryFiles = []
  async function collectOrdinaryFiles(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'credentials') await collectOrdinaryFiles(fullPath)
      } else if (/\.(?:json|jsonl|log|txt)$/iu.test(entry.name)) {
        ordinaryFiles.push(await fs.readFile(fullPath, 'utf8'))
      }
    }
  }
  await collectOrdinaryFiles(directory)
  const visibleArtifacts = JSON.stringify({ recovered, pendingStatus, savedStatus,
    failedError: { code: failedError?.code, message: failedError?.message },
    conflictError: { code: conflictError?.code, message: conflictError?.message }, logs: capturedLogs,
    ledger: [...ledger.records.values()], ordinaryFiles })
  assert.equal(visibleArtifacts.includes(API_KEY), false)
  assert.equal(visibleArtifacts.includes(Buffer.from(API_KEY).toString('base64')), false)
  assert.equal(visibleArtifacts.includes('different-ledger-retry-secret'), false)
})

test('operation replay across later revisions does not overwrite current settings and stale new operations conflict', async (t) => {
  const { settings, makeController } = await setup(t, { allowInlineCredentials: true })
  const controller = makeController()
  const originalSave = settings.save.bind(settings)
  let saveCount = 0
  settings.save = async (input) => { saveCount++; return originalSave(input) }

  const first = await controller.configureMcpProvider(inlineRequest())
  const secondConfig = { ...PUBLIC_CONFIG, timeoutSeconds: 60 }
  const second = await controller.configureMcpProvider(inlineRequest(undefined, {
    operationId: 'configure-2', expectedRevision: 1, publicConfig: secondConfig,
    credentialInput: undefined,
  }))
  assert.equal(first.revision, 1)
  assert.equal(second.revision, 2)
  assert.equal(saveCount, 2)

  const replayedFirst = await controller.configureMcpProvider(inlineRequest())
  assert.equal(replayedFirst.status, 'saved')
  assert.equal(replayedFirst.revision, 1)
  assert.equal(saveCount, 2)
  const current = await settings.snapshotProvider('openai')
  assert.equal(current.providers[0].revision, 2)
  assert.equal(current.providers[0].timeoutSeconds, 60)

  await assert.rejects(controller.configureMcpProvider(inlineRequest(undefined, {
    operationId: 'stale-new-operation', expectedRevision: 0,
    publicConfig: { ...PUBLIC_CONFIG, timeoutSeconds: 45 }, credentialInput: undefined,
  })), (error) => error.code === 'PROVIDER_REVISION_CONFLICT')
  assert.equal(saveCount, 2)
  const afterConflict = await settings.snapshotProvider('openai')
  assert.equal(afterConflict.providers[0].revision, 2)
  assert.equal(afterConflict.providers[0].timeoutSeconds, 60)
  assert.equal((await settings.credentials('openai')).apiKey, API_KEY)
})

test('authorized_env reads only the registered field and desktop_input is limited to grant fields', async (t) => {
  const resolved = []
  let inputRequest
  const { settings, ledger, makeController } = await setup(t, {
    resolveAuthorizedCredentialSource: async (input) => { resolved.push(input); return { value: API_KEY } },
    requestDesktopCredentialInput: async (input) => { inputRequest = input; return { proposalId: 'input-proposal-1' } },
  })
  const controller = makeController()
  const envResult = await controller.configureMcpProvider(inlineRequest(undefined, {
    operationId: 'env-op', credentialInput: { source: 'authorized_env', sourceRefs: { apiKey: 'source-ref-1' } },
  }))
  assert.equal(envResult.status, 'saved')
  assert.deepEqual(resolved.map((item) => [item.providerId, item.fieldName, item.envVariableName, item.sourceRef]),
    [['openai', 'apiKey', 'VIBEPAPER_OPENAI_KEY', 'source-ref-1']])

  const before = await settings.snapshotProvider('openai')
  const desktop = await controller.configureMcpProvider(inlineRequest(undefined, {
    operationId: 'desktop-op', expectedRevision: before.providers[0].revision,
    credentialInput: { source: 'desktop_input' },
  }))
  assert.equal(desktop.status, 'awaiting_desktop_input')
  assert.deepEqual(inputRequest.credentialFields, ['apiKey', 'voiceId'])
  assert.equal(JSON.stringify(inputRequest).includes(API_KEY), false)
  assert.equal((await ledger.get({ clientId: 'client-fixture', providerId: 'openai', operationId: 'desktop-op' })).status, 'awaiting_desktop_input')
  const afterUiSave = await settings.save({ ...PUBLIC_CONFIG, expectedRevision: before.providers[0].revision,
    operationId: 'desktop-op', credentials: { apiKey: API_KEY } })
  await ledger.complete({ clientId: 'client-fixture', providerId: 'openai', operationId: 'desktop-op', status: 'saved',
    publicResult: { status: 'saved', providerId: 'openai', revision: afterUiSave.providers[0].revision } })
  const operation = await controller.getMcpProviderOperation({ grant: grant(), projectId: 'project-fixture', canvasId: 'canvas-fixture',
    providerId: 'openai', operationId: 'desktop-op' })
  assert.equal(operation.status, 'saved')

  await assert.rejects(controller.configureMcpProvider(inlineRequest(undefined, {
    operationId: 'desktop-disallowed', expectedRevision: afterUiSave.providers[0].revision,
    grant: grant({ providerGrants: [{ providerId: 'openai', credentialFields: ['apiKey'], credentialInputModes: ['authorized_env'] }] }),
    credentialInput: { source: 'desktop_input' },
  })), (error) => error.code === 'PROVIDER_INPUT_MODE_FORBIDDEN')
})

test('live grant revocation during authorized source resolution prevents credential persistence', async (t) => {
  let active = true
  let resolverCalls = 0
  const { settings, ledger, makeController } = await setup(t)
  const originalSave = settings.save.bind(settings)
  let saves = 0
  settings.save = async (input) => { saves++; return originalSave(input) }
  const controller = makeController({
    authorize: async () => ({ allowed: active }),
    resolveAuthorizedCredentialSource: async () => {
      resolverCalls++
      await Promise.resolve()
      active = false
      return { value: API_KEY }
    },
  })
  await assert.rejects(controller.configureMcpProvider(inlineRequest(undefined, {
    credentialInput: { source: 'authorized_env', sourceRefs: { apiKey: 'registered-source-ref' } },
  })), (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  assert.equal(resolverCalls, 1)
  assert.equal(saves, 0)
  assert.equal((await settings.snapshotProvider('openai')).providers[0].revision, 0)
  assert.equal((await ledger.get({ clientId: 'client-fixture', providerId: 'openai', operationId: 'configure-1' })).status, 'failed')
  assert.equal((await settings.credentials('openai')).apiKey, undefined)
})

test('live grant revocation while ledger begin waits prevents desktop-input proposal creation', async (t) => {
  let active = true
  let requests = 0
  const delegate = createLedger()
  const ledger = {
    records: delegate.records,
    async begin(input) {
      const result = await delegate.begin(input)
      active = false
      return result
    },
    complete: delegate.complete,
    get: delegate.get,
  }
  const { settings, makeController } = await setup(t, { ledger })
  const originalSave = settings.save.bind(settings)
  let saves = 0
  settings.save = async (input) => { saves++; return originalSave(input) }
  const controller = makeController({
    authorize: async () => ({ allowed: active }),
    requestDesktopCredentialInput: async () => { requests++; return { proposalId: 'must-not-be-created' } },
  })
  await assert.rejects(controller.configureMcpProvider(inlineRequest(undefined, {
    credentialInput: { source: 'desktop_input' },
  })), (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  assert.equal(requests, 0)
  assert.equal(saves, 0)
  assert.equal((await settings.snapshotProvider('openai')).providers[0].revision, 0)
})

test('live grant revocation during provider snapshot prevents the official probe request', async (t) => {
  let active = true
  let probes = 0
  const { settings, makeController } = await setup(t)
  const originalSnapshot = settings.snapshotProvider.bind(settings)
  settings.snapshotProvider = async (providerId) => {
    const snapshot = await originalSnapshot(providerId)
    active = false
    return snapshot
  }
  settings.testSaved = async () => { probes++; return { status: 'connected', success: true } }
  const controller = makeController({ authorize: async () => ({ allowed: active }) })
  await assert.rejects(controller.probeMcpProvider({ grant: grant(), projectId: 'project-fixture',
    canvasId: 'canvas-fixture', providerId: 'openai', expectedRevision: 0 }),
  (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  assert.equal(probes, 0)
})

test('live grant revocation at the provider-settings revision commit rolls back staged credentials', async (t) => {
  let active = true
  let revoked = false
  const { directory, settings, makeController } = await setup(t, { allowInlineCredentials: true,
    faultInjector: async (point) => {
      if (!revoked && point === 'after-credential-write') { revoked = true; active = false }
    } })
  const controller = makeController({ authorize: async () => ({ allowed: active }) })
  await assert.rejects(controller.configureMcpProvider(inlineRequest()),
    (error) => error.code === 'PROVIDER_CONFIGURE_FORBIDDEN')
  assert.equal(revoked, true)
  const state = await settings.snapshotProvider('openai')
  assert.equal(state.providers[0].revision, 0)
  assert.equal(state.providers[0].configured, false)
  assert.equal((await settings.credentials('openai')).apiKey, undefined)
  assert.equal(await fs.access(path.join(directory, 'provider-settings.transaction.json')).then(() => true, () => false), false)
})

test('restart rolls back an interrupted authorized journal until the same operation is reauthorized', async (t) => {
  let crashed = false
  let armed = false
  const { directory, settings, makeSettings, ledger, makeController } = await setup(t, { allowInlineCredentials: true,
    faultInjector: async (point) => {
      if (armed && !crashed && point === 'after-credential-write') {
        crashed = true
        throw Object.assign(new Error('simulated process interruption'), { code: 'PROVIDER_SETTINGS_INJECTED_CRASH' })
      }
    } })
  await settings.save({ ...PUBLIC_CONFIG, expectedRevision: 0, credentials: { apiKey: 'previous-authorized-secret' } })
  armed = true
  const controller = makeController()
  await assert.rejects(controller.configureMcpProvider(inlineRequest('replacement-secret', {
    expectedRevision: 1, operationId: 'restart-recovery-op',
  })), (error) => error.code === 'PROVIDER_SAVE_FAILED')
  assert.equal(crashed, true)

  const restarted = makeSettings()
  const recovered = await restarted.snapshotProvider('openai')
  assert.equal(recovered.providers[0].revision, 1)
  assert.equal((await restarted.credentials('openai')).apiKey, 'previous-authorized-secret')
  assert.equal(await fs.access(path.join(directory, 'provider-settings.transaction.json')).then(() => true, () => false), false)
  assert.equal((await ledger.get({ clientId: 'client-fixture', providerId: 'openai', operationId: 'restart-recovery-op' })).status, 'pending')
})

test('probe returns an explicit unsupported result and secure-storage errors remain stable', async (t) => {
  let networkCalls = 0
  const { makeController } = await setup(t, { allowInlineCredentials: true,
    testOfficialProviderConnection: async () => { networkCalls++; return { status: 'connected', success: true } } })
  const controller = makeController()
  const saved = await controller.configureMcpProvider(inlineRequest())
  const probe = await controller.probeMcpProvider({ grant: grant(), projectId: 'project-fixture', canvasId: 'canvas-fixture',
    providerId: 'openai', expectedRevision: saved.revision })
  assert.equal(probe.status, 'unsupported')
  assert.equal(probe.success, false)
  assert.equal(networkCalls, 0)

  const blocked = await setup(t, { allowInlineCredentials: true, storage: safeStorage(false) })
  const blockedController = blocked.makeController()
  await assert.rejects(blockedController.configureMcpProvider(inlineRequest()), (error) => error.code === 'SECURE_STORAGE_UNAVAILABLE')
})

test('provider read is provider-scoped and never returns saved credential values', async (t) => {
  const { settings, makeController } = await setup(t, { allowInlineCredentials: true })
  const controller = makeController()
  await controller.configureMcpProvider(inlineRequest())
  const state = await controller.getMcpProviderState({ grant: grant(), projectId: 'project-fixture', canvasId: 'canvas-fixture' })
  assert.deepEqual(state.providers.map((provider) => provider.id), ['openai'])
  assert.equal(state.providers[0].credentialFields.find((field) => field.name === 'apiKey').configured, true)
  assert.equal(JSON.stringify(state).includes(API_KEY), false)
  assert.equal(JSON.stringify(await settings.snapshotProvider('openai')).includes(API_KEY), false)
})
