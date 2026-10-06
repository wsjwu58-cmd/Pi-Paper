const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createProviderSettings } = require('../src/provider-settings.cjs')

const API_KEY = 'sk-test-provider-key-123456'

test('per-model visual defaults persist across restart and reject unsupported fields or bounds', async (t) => {
  const catalog = fixtureCatalog()
  catalog.models[0].defaults = { resolution: '480p', ratio: 'adaptive', duration: 15, generate_audio: true }
  catalog.models[0].modelType = 'video'
  catalog.models[0].constraints = { acceptedResolutions: ['480p', '720p'], acceptedAspectRatios: ['adaptive', '16:9'], minimumDuration: 4, maximumDuration: 30, supportsGenerateAudio: true }
  const { directory, providerSettings } = await setup(t, { catalog: () => catalog })
  const id = catalog.models[0].id
  const defaults = { resolution: '720p', ratio: '16:9', duration: 20, generate_audio: false }
  await providerSettings.save(config('openai', { credentials: { apiKey: API_KEY }, enabledModelIds: [id], modelDefaults: { [id]: defaults } }))
  const restarted = createProviderSettings({ directory, safeStorage: createSafeStorage(), catalog: () => catalog })
  assert.deepEqual((await restarted.resolve('openai', id, 'video')).model.defaults, defaults)
  for (const invalid of [{ resolution: '4K' }, { duration: 31 }, { duration: 4.5 }, { generate_audio: 'yes' }, { apiKey: 'must-not-save' }]) {
    await assert.rejects(providerSettings.save(config('openai', { modelDefaults: { [id]: invalid } })), (error) => error.code === 'PROVIDER_DEFAULT_INVALID')
  }
  assert.deepEqual((await providerSettings.resolve('openai', id, 'video')).model.defaults, defaults)
  catalog.models[0].constraints.acceptedDurations = [6, 20, 30]
  catalog.models[0].constraints.durationByResolution = { '720p': [20] }
  await assert.rejects(providerSettings.save(config('openai', { modelDefaults: { [id]: { resolution: '720p', duration: 6 } } })), (error) => error.code === 'PROVIDER_DEFAULT_INVALID')
  assert.deepEqual((await providerSettings.resolve('openai', id, 'video')).model.defaults, defaults)
})

test('ratio-specific model defaults reject invalid combinations and persist exact supported dimensions', async (t) => {
  const catalog = fixtureCatalog()
  const model = catalog.models[0]
  model.modelType = 'image'
  model.defaults = { ratio: '1:1', size: '1280x1280' }
  model.constraints = { acceptedAspectRatios: ['1:1', '3:2'], acceptedSizes: ['1280x1280', '1536x1024'], sizesByAspectRatio: { '1:1': ['1280x1280'], '3:2': ['1536x1024'] } }
  const { providerSettings } = await setup(t, { catalog: () => catalog })
  const input = config('openai', { credentials: { apiKey: API_KEY }, enabledModelIds: [model.id], modelDefaults: { [model.id]: { ratio: '3:2', size: '1536x1024' } } })
  await providerSettings.save(input)
  assert.deepEqual((await providerSettings.resolve('openai', model.id, 'image')).model.defaults, { ratio: '3:2', size: '1536x1024' })
  await assert.rejects(providerSettings.save({ ...input, modelDefaults: { [model.id]: { ratio: '3:2', size: '1280x1280' } } }), (error) => error.code === 'PROVIDER_DEFAULT_INVALID')
})

test('Kling official AK/SK configuration is encrypted, usable without API Key, and never returned to Renderer', async (t) => {
  const { pathToFileURL } = require('node:url')
  const api = await import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/index.ts')).href)
  const catalog = api.getOfficialProviderCatalog()
  const { directory, providerSettings } = await setup(t, { catalog: () => catalog,
    testOfficialProviderConnection: async (providerId, options) => {
      assert.equal(providerId, 'kling')
      assert.deepEqual(options.credentials, credentials)
      return { status: 'connected', success: true, message: 'official accepted' }
    },
  })
  const model = catalog.models.find((m) => m.name === 'Kling V3')
  const credentials = { accessKey: 'kling-access-private', secretKey: 'kling-secret-private' }
  const input = { providerId: 'kling', baseUrl: 'https://api-singapore.klingai.com', enabledModelIds: [model.id], defaultModelIds: { video: model.id }, timeoutSeconds: 60, credentials }
  await assert.rejects(providerSettings.save({ ...input, credentials: { accessKey: credentials.accessKey } }))
  const snapshot = await providerSettings.save(input)
  assert.equal(snapshot.models.find((m) => m.id === model.id).enabled, true)
  for (const secret of Object.values(credentials)) {
    assert.equal(JSON.stringify(snapshot).includes(secret), false)
    assert.equal((await fs.readFile(path.join(directory, 'providers.json'), 'utf8')).includes(secret), false)
  }
  const binding = await providerSettings.resolve('kling', model.id, 'video')
  assert.deepEqual(binding.credentials, credentials)
  assert.equal(binding.apiKey, undefined)
  assert.equal((await providerSettings.test(input)).status, 'connected')
  const switchedToApiKey = await providerSettings.save({ ...input, credentials: { apiKey: 'kling-new-key' } })
  assert.equal(switchedToApiKey.providers.find((provider) => provider.id === 'kling').configured, true)
  assert.deepEqual((await providerSettings.credentials('kling')), { apiKey: 'kling-new-key' })
  const switchedBackToLegacy = await providerSettings.save({ ...input, credentials })
  assert.equal(switchedBackToLegacy.providers.find((provider) => provider.id === 'kling').configured, true)
  assert.deepEqual((await providerSettings.credentials('kling')), credentials)
  await assert.rejects(providerSettings.save({ ...input, credentials: { apiKey: 'new', accessKey: 'legacy', secretKey: 'legacy-secret' } }), (error) => error.code === 'CLOUD_CREDENTIAL_INVALID')
  let calls = 0
  const result = await api.testOfficialProviderConnection('kling', { credentials, fetch: async (url, init) => {
    calls++
    assert.equal(String(url), 'https://api-singapore.klingai.com/v1/videos/text2video?pageNum=1&pageSize=1')
    assert.equal(init.method, 'GET')
    assert.match(new Headers(init.headers).get('Authorization'), /^Bearer [^.]+\.[^.]+\.[^.]+$/u)
    return new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 })
  } })
  assert.equal(result.status, 'connected')
  assert.equal(calls, 1)
  const emptyKling = await setup(t, { catalog: () => catalog })
  assert.equal((await emptyKling.providerSettings.snapshot()).providers.find((provider) => provider.id === 'kling').configured, false)
  await assert.rejects(emptyKling.providerSettings.save({ ...input, credentials: {} }), (error) => error.code === 'CLOUD_CREDENTIAL_MISSING')
  await assert.rejects(api.testOfficialProviderConnection('kling', { credentials: { accessKey: credentials.accessKey } }))
})

test('per-model voice credentials gate speech without disabling other modalities', async (t) => {
  const catalog = fixtureCatalog()
  catalog.providers[0].credentialFields.push({ name: 'voiceId', label: 'Voice ID', required: false })
  catalog.models.push({ id: 'speech', apiModelId: 'speech', providerId: 'openai', modelType: 'audio', implemented: true, requiredCredentials: ['voiceId'] })
  const { providerSettings } = await setup(t, { catalog: () => catalog })
  const before = await providerSettings.save(config('openai', { credentials: { apiKey: API_KEY }, enabledModelIds: ['speech', 'openai-gpt-5'] }))
  assert.equal(before.models.find((m) => m.id === 'speech').enabled, false)
  assert.equal(before.models.find((m) => m.id === 'openai-gpt-5').enabled, true)
  await assert.rejects(providerSettings.resolve('openai', 'speech', 'audio'))
  const after = await providerSettings.save(config('openai', { credentials: { voiceId: 'voice-fixture' }, enabledModelIds: ['speech', 'openai-gpt-5'] }))
  assert.equal(after.models.find((m) => m.id === 'speech').enabled, true)
  assert.equal(JSON.stringify(after).includes(API_KEY), false)
})

test('Wan workspace routing uses exact official regions and cannot inject arbitrary hosts', async (t) => {
  const catalog = fixtureCatalog()
  catalog.providers.push({ id: 'alibaba-video', name: 'Wan', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', credentialFields: [
    { name: 'apiKey', label: 'API Key', required: true, secret: true },
    { name: 'workspaceId', label: 'Workspace', required: true }, { name: 'region', label: 'Region', required: true },
  ] })
  catalog.models.push({ id: 'wan', apiModelId: 'wan3.0-video', providerId: 'alibaba-video', modelType: 'video', implemented: true })
  const { providerSettings } = await setup(t, { catalog: () => catalog })
  const input = { providerId: 'alibaba-video', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', enabledModelIds: ['wan'], defaultModelIds: {}, timeoutSeconds: 30,
    credentials: { apiKey: API_KEY, workspaceId: 'ws-fixture', region: 'cn-beijing' } }
  await providerSettings.save(input)
  assert.equal((await providerSettings.resolve('alibaba-video', 'wan', 'video')).endpoint, 'https://ws-fixture.cn-beijing.maas.aliyuncs.com/api/v1')
  await assert.rejects(providerSettings.save({ ...input, credentials: { ...input.credentials, workspaceId: 'evil.example' } }))
  await assert.rejects(providerSettings.save({ ...input, credentials: { ...input.credentials, region: 'unknown' } }))
})

test('pending providers have no usable credentials or endpoint and do not break configured catalogs', async (t) => {
  const catalog = fixtureCatalog()
  catalog.providers.push({ id: 'pending', name: 'Pending', baseUrl: '', credentialFields: [], configurable: false,
    unavailableReason: '官方适配待完成' })
  const { providerSettings } = await setup(t, { catalog: () => catalog })
  const snapshot = await providerSettings.snapshot()
  assert.equal(snapshot.providers.find((provider) => provider.id === 'pending').configured, false)
  await assert.rejects(providerSettings.save({ providerId: 'pending' }), (error) => error.code === 'PROVIDER_UNAVAILABLE')
})

test('model-specific media API paths remain on the configured official origin', async (t) => {
  const catalog = fixtureCatalog()
  catalog.models[0].apiBaseUrl = 'https://api.openai.com/v1/media'
  const { providerSettings } = await setup(t, { catalog: () => catalog })
  await providerSettings.save(config('openai', { credentials: { apiKey: API_KEY }, enabledModelIds: ['openai-gpt-5'] }))
  assert.equal((await providerSettings.resolve('openai', 'openai-gpt-5', 'text')).endpoint, 'https://api.openai.com/v1/media')
  catalog.models[0].apiBaseUrl = 'https://untrusted.example/v1'
  await assert.rejects(providerSettings.resolve('openai', 'openai-gpt-5', 'text'), (error) => error.code === 'PROVIDER_ENDPOINT_INVALID')
})

function fixtureCatalog() {
  return {
    providers: [
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
        credentialFields: [{ name: 'apiKey', label: 'API Key', required: true, secret: true }],
        connectionTest: { kind: 'models-list', path: '/models' } },
      { id: 'agnes', name: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
        credentialFields: [{ name: 'apiKey', label: 'API Key', required: true, secret: true }] },
      { id: 'volcengine-ark', name: 'Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        credentialFields: [{ name: 'apiKey', label: 'API Key', required: true, secret: true }] },
    ],
    models: [
      { id: 'openai-gpt-5', apiModelId: 'gpt-5', displayName: 'GPT-5', providerId: 'openai', modelType: 'text', implemented: true },
      { id: 'openai-image-placeholder', apiModelId: 'unverified-image-model', displayName: 'Image placeholder', providerId: 'openai', modelType: 'image', implemented: false },
      { id: 'agnes-text', apiModelId: 'agnes-2.5-flash', displayName: 'Agnes Text', providerId: 'agnes', modelType: 'text', implemented: true },
      { id: 'ark-video', apiModelId: 'doubao-seedance-2-5-260628', displayName: 'Seedance', providerId: 'volcengine-ark', modelType: 'video', implemented: true },
    ],
  }
}

function createSafeStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain) => Buffer.from(`test-cipher:${Buffer.from(plain).toString('base64')}`),
    decryptStringAsync: async (bytes) => Buffer.from(
      Buffer.from(bytes).toString().replace(/^test-cipher:/u, ''), 'base64',
    ).toString(),
  }
}

async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-provider-settings-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const safeStorage = createSafeStorage()
  const providerSettings = createProviderSettings({
    directory,
    safeStorage,
    catalog: options.catalog || fixtureCatalog,
    legacyCredentials: options.legacyCredentials || {},
    testOfficialProviderConnection: options.testOfficialProviderConnection,
  })
  return { directory, safeStorage, providerSettings }
}

function config(providerId, overrides = {}) {
  const urls = {
    openai: 'https://api.openai.com/v1',
    agnes: 'https://apihub.agnes-ai.com/v1',
    'volcengine-ark': 'https://ark.cn-beijing.volces.com/api/v3',
  }
  return {
    providerId,
    baseUrl: urls[providerId],
    enabledModelIds: [],
    defaultModelIds: {},
    timeoutSeconds: 30,
    ...overrides,
  }
}

test('static catalog models become usable only when implemented, enabled, and backed by credentials', async (t) => {
  const { directory, providerSettings } = await setup(t)
  const before = await providerSettings.snapshot()
  assert.equal(before.providers.find((provider) => provider.id === 'openai').configured, false)
  assert.equal(before.models.find((model) => model.id === 'openai-gpt-5').enabled, false)

  const saved = await providerSettings.save(config('openai', {
    credentials: { apiKey: API_KEY },
    enabledModelIds: ['openai-gpt-5', 'openai-image-placeholder'],
    defaultModelIds: { text: 'openai-gpt-5' },
  }))
  const provider = saved.providers.find((item) => item.id === 'openai')
  assert.equal(provider.configured, true)
  assert.equal(provider.enabledModelIds.includes('openai-gpt-5'), true)
  assert.equal(saved.models.find((model) => model.id === 'openai-gpt-5').enabled, true)
  assert.equal(saved.models.find((model) => model.id === 'openai-image-placeholder').enabled, false)
  assert.equal(JSON.stringify(saved).includes(API_KEY), false)

  const publicSettings = await fs.readFile(path.join(directory, 'providers.json'), 'utf8')
  const encryptedCredentials = await fs.readFile(path.join(directory, 'credentials', 'provider-openai.bin'))
  assert.equal(publicSettings.includes(API_KEY), false)
  assert.equal(encryptedCredentials.toString().includes(API_KEY), false)

  const resolved = await providerSettings.resolve('openai', 'openai-gpt-5', 'text')
  assert.equal(resolved.officialPi, true)
  assert.equal(resolved.apiModelId, 'gpt-5')
  assert.equal(resolved.apiKey, API_KEY)
  await assert.rejects(providerSettings.resolve('openai', 'openai-image-placeholder', 'image'), { code: 'MODEL_UNAVAILABLE' })
})

test('official HTTPS host, port, userinfo, query, and fragment restrictions reject endpoint overrides safely', async (t) => {
  const { providerSettings } = await setup(t)
  for (const baseUrl of [
    'https://attacker.example/v1',
    'http://api.openai.com/v1',
    'https://user:secret@api.openai.com/v1',
    'https://api.openai.com:8443/v1',
    'https://api.openai.com/v1?api_key=secret',
    'https://api.openai.com/v1#secret',
    'not a URL?secret=sk-private',
  ]) {
    await assert.rejects(providerSettings.save(config('openai', { baseUrl, credentials: { apiKey: API_KEY } })), (error) => {
      assert.equal(error.code, 'PROVIDER_ENDPOINT_INVALID')
      assert.equal(error.message.includes('secret'), false)
      assert.equal(error.message.includes(API_KEY), false)
      return true
    })
  }
})

test('existing Agnes and Ark keys remain readable through legacy credential aliases', async (t) => {
  let clearedAgnes = 0
  let clearedArk = 0
  const { providerSettings } = await setup(t, {
    legacyCredentials: {
      agnes: { read: async () => 'agnes-legacy-key', clear: async () => { clearedAgnes += 1 } },
      volcengine: { read: async () => 'ark-legacy-key', clear: async () => { clearedArk += 1 } },
    },
  })
  const initial = await providerSettings.snapshot()
  assert.equal(initial.providers.find((provider) => provider.id === 'agnes').configured, true)
  assert.equal(initial.providers.find((provider) => provider.id === 'volcengine-ark').configured, true)
  assert.equal(initial.models.find((model) => model.id === 'agnes-text').enabled, false)

  const agnes = await providerSettings.save(config('agnes', {
    enabledModelIds: ['agnes-text'], defaultModelIds: { text: 'agnes-text' },
  }))
  assert.equal(agnes.models.find((model) => model.id === 'agnes-text').enabled, true)
  assert.equal((await providerSettings.resolve('agnes', 'agnes-text', 'text')).apiKey, 'agnes-legacy-key')

  const ark = await providerSettings.save(config('volcengine-ark', { enabledModelIds: ['ark-video'] }))
  assert.equal(ark.models.find((model) => model.id === 'ark-video').enabled, true)
  assert.equal((await providerSettings.resolve('volcengine-ark', 'ark-video', 'video')).apiKey, 'ark-legacy-key')

  await providerSettings.clear('volcengine-ark')
  assert.equal(clearedArk, 1)
  await providerSettings.clear('agnes')
  assert.equal(clearedAgnes, 1)
})

test('connection test uses an unsaved OpenAI key for the non-billing models probe and redacts failures', async (t) => {
  let calls = 0
  let probeArgs
  const { directory, providerSettings } = await setup(t, {
    testOfficialProviderConnection: async (providerId, options) => {
      calls += 1
      probeArgs = { providerId, ...options }
      return { status: 'connected', success: true, message: 'GET /models succeeded' }
    },
  })
  const result = await providerSettings.test(config('openai', { credentials: { apiKey: API_KEY } }))
  assert.equal(result.status, 'connected')
  assert.equal(result.success, true)
  assert.equal(result.message.includes(API_KEY), false)
  assert.equal(calls, 1)
  assert.equal(probeArgs.providerId, 'openai')
  assert.equal(probeArgs.apiKey, API_KEY)
  assert.equal(probeArgs.baseUrl, 'https://api.openai.com/v1')
  await assert.rejects(fs.access(path.join(directory, 'providers.json')))

  const { providerSettings: failingSettings } = await setup(t, {
    testOfficialProviderConnection: async () => {
      const error = new Error(`request rejected Bearer ${API_KEY}`)
      error.code = 'OFFICIAL_PROVIDER_ERROR'
      throw error
    },
  })
  await assert.rejects(failingSettings.test(config('openai', { credentials: { apiKey: API_KEY } })), (error) => {
    assert.equal(error.code, 'OFFICIAL_PROVIDER_ERROR')
    assert.equal(error.message.includes(API_KEY), false)
    return true
  })
})

test('providers without a safe authentication probe return unsupported instead of claiming validation', async (t) => {
  let probeCalls = 0
  const { providerSettings } = await setup(t, {
    testOfficialProviderConnection: async () => { probeCalls += 1; return { status: 'connected', success: true } },
  })
  const result = await providerSettings.test(config('agnes', { credentials: { apiKey: 'agnes-test-key' } }))
  assert.equal(result.status, 'unsupported')
  assert.equal(result.success, false)
  assert.match(result.message, /未发送请求/u)
  assert.equal(probeCalls, 0)
})

test('connection testing only requires authentication secrets, not a non-secret voice ID', async (t) => {
  const { pathToFileURL } = require('node:url')
  const api = await import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/index.ts')).href)
  const catalog = api.getOfficialProviderCatalog()
  let probeOptions
  const { providerSettings } = await setup(t, { catalog: () => catalog,
    testOfficialProviderConnection: async (_providerId, options) => {
      probeOptions = options
      return { status: 'connected', success: true, message: 'authorized' }
    },
  })
  const result = await providerSettings.test(config('elevenlabs', { credentials: { apiKey: 'xi-eleven-test' } }))
  assert.deepEqual(result, { status: 'connected', success: true, message: 'authorized' })
  assert.equal(probeOptions.credentials.apiKey, 'xi-eleven-test')
  assert.equal(probeOptions.credentials.voiceId, undefined)
})
