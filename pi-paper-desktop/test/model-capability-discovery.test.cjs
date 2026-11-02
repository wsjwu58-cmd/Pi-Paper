const assert = require('node:assert/strict')
const test = require('node:test')
const { discoverModelBindings } = require('../src/model-capability-discovery.cjs')

const catalog = {
  providers: [{ id: 'ready', name: 'Ready', configured: true, baseUrl: 'https://secret.example', apiKey: 'private-key' },
    { id: 'missing', name: 'Missing', configured: false }],
  models: [
    { id: 'image-ready', displayName: 'Studio', providerId: 'ready', providerType: 'cloud', modelType: 'image', implemented: true, enabled: true,
      inputModes: ['text', 'image'], credentials: 'private-secret', constraints: { acceptedAspectRatios: ['1:1', '16:9'], acceptedSizes: ['1K', '2K'], sizesByAspectRatio: { '1:1': ['1K', '2K'], '16:9': ['1K'] } } },
    { id: 'disabled', providerId: 'ready', modelType: 'image', implemented: true, enabled: false, inputModes: ['text'] },
    { id: 'not-configured', providerId: 'missing', modelType: 'image', implemented: true, enabled: false, inputModes: ['text'] },
    { id: 'not-implemented', providerId: 'ready', modelType: 'image', implemented: false, enabled: false, inputModes: ['text'] },
    { id: 'video-only', providerId: 'ready', modelType: 'video', implemented: true, enabled: true, inputModes: ['text'] },
    { id: 'local', providerId: 'local-engine', providerType: 'local', modelType: 'text', enabled: true, inputModes: ['text'] },
  ],
}

test('projects configured bindings by modality, reference and aspect-specific resolution without exposing secrets', () => {
  const result = discoverModelBindings(catalog, { modality: 'image', referenceInputs: ['image'], resolution: '1K', aspect: '1:1' })
  assert.deepEqual(result.bindings.map((item) => item.id).sort(), ['disabled', 'image-ready', 'not-configured', 'not-implemented'])
  assert.equal(result.bindings.find((item) => item.id === 'image-ready').available, true)
  assert.equal(result.bindings.find((item) => item.id === 'disabled').reason, 'MODEL_DISABLED')
  assert.equal(result.bindings.find((item) => item.id === 'not-configured').reason, 'PROVIDER_UNCONFIGURED')
  assert.equal(result.bindings.find((item) => item.id === 'not-implemented').reason, 'MODEL_UNIMPLEMENTED')
  assert.doesNotMatch(JSON.stringify(result), /private-key|private-secret|secret\.example|apiKey|credentials|baseUrl/)
  assert.equal(discoverModelBindings(catalog, { modality: 'text' }).bindings[0].id, 'local')
})

test('explains unsupported references, aspect and resolution instead of silently choosing a model', () => {
  const reason = (input) => discoverModelBindings(catalog, { modality: 'image', ...input }).bindings.find((item) => item.id === 'image-ready').reason
  assert.equal(reason({ referenceInputs: ['video'] }), 'UNSUPPORTED_INPUT')
  assert.equal(reason({ referenceInputs: ['text', 'image'] }), null)
  assert.equal(reason({ referenceInputs: ['text', 'image', 'audio'] }), 'UNSUPPORTED_INPUT')
  assert.equal(reason({ aspect: '9:16' }), 'UNSUPPORTED_ASPECT')
  assert.equal(reason({ aspect: '16:9', resolution: '2K' }), 'UNSUPPORTED_RESOLUTION')
  assert.equal(reason({ resolution: '8K' }), 'UNSUPPORTED_RESOLUTION')
  assert.throws(() => discoverModelBindings(catalog, { modality: 'image', referenceInputs: ['script'] }), /INVALID_INPUT/)
  assert.throws(() => discoverModelBindings(catalog, { modality: 'image', apiKey: 'secret' }), /INVALID_INPUT/)
})

test('real official catalog and provider settings snapshots drive availability without sending network requests', async (t) => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os')
  const { pathToFileURL } = require('node:url')
  const { createProviderSettings } = require('../src/provider-settings.cjs')
  const api = await import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/index.ts')).href)
  const official = api.getOfficialProviderCatalog()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'model-discovery-settings-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const safeStorage = { isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(`fixture:${Buffer.from(value).toString('base64')}`),
    decryptStringAsync: async (value) => Buffer.from(value.toString().replace(/^fixture:/u, ''), 'base64').toString() }
  const settings = createProviderSettings({ directory, safeStorage, catalog: () => official })
  const before = await settings.snapshot()
  assert.equal(discoverModelBindings(before, { modality: 'image' }).bindings.find((item) => item.id === 'target-glm-image').reason, 'PROVIDER_UNCONFIGURED')
  const saved = await settings.save({ providerId: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', expectedRevision: 0,
    enabledModelIds: ['target-glm-image'], defaultModelIds: {}, timeoutSeconds: 30, credentials: { apiKey: 'fixture-private-key' } })
  const matching = discoverModelBindings(saved, { modality: 'image', referenceInputs: ['text'], aspect: '1:1', resolution: '1280x1280' })
  assert.equal(matching.bindings.find((item) => item.id === 'target-glm-image').available, true)
  const mismatch = discoverModelBindings(saved, { modality: 'image', referenceInputs: ['image'] })
  assert.equal(mismatch.bindings.find((item) => item.id === 'target-glm-image').reason, 'UNSUPPORTED_INPUT')
  assert.doesNotMatch(JSON.stringify(matching), /fixture-private-key|open\.bigmodel\.cn/)
})
