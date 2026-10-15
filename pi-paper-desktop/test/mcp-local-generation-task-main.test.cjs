const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

async function createTaskFixture() {
  const source = await fs.readFile(path.join(__dirname, '../src/main.cjs'), 'utf8')
  const start = source.indexOf('async function createGenerationTaskInStore(')
  const end = source.indexOf('\nfunction dramaRenderBatchScope(', start)
  assert.ok(start >= 0 && end > start)
  const requests = []
  const context = vm.createContext({
    AGNES_PROVIDER_ID: 'agnes',
    ARK_PROVIDER_ID: 'volcengine',
    SAPI_PROVIDER_ID: 'local-sapi-tts',
    SAPI_MODEL_ID: 'local-sapi-tts',
    LOCAL_MEDIA_PROVIDER_ID: 'local-media-postprocess',
    LOCAL_MEDIA_MODEL_ID: 'local-media-postprocess',
    providerSettings: { snapshot: async () => ({ models: [] }) },
    localCore: { request: async (method, input) => {
      requests.push({ method, input })
      return { taskId: `task-${requests.length}`, ...input }
    } },
    getLocalTextModelConfig: async () => ({ providerId: 'local-openai-compatible', modelId: 'mcp-review-text' }),
    getOfficialCatalog: () => ({ providers: [{ id: 'agnes' }, { id: 'volcengine-ark' }] }),
    isLocalMediaOperation: (modality, operation) => modality === 'image' && operation === 'local-image',
    parseLocalMediaReference: (value) => value === 'local://fixture/image.png' ? { path: 'fixture' } : null,
    codedError: (code, message = code) => Object.assign(new Error(message), { code }),
  })
  vm.runInContext(source.slice(start, end), context)
  return { create: context.createGenerationTaskInStore, requests }
}

function taskInput(overrides = {}) {
  return {
    projectId: 'project', canvasId: 'canvas', canvasVersion: 10, nodeId: 'target',
    providerType: 'local', providerId: 'local-openai-compatible', modelId: 'mcp-review-text',
    modality: 'text', prompt: 'hello', idempotencyKey: 'local-task', parameters: {},
    ...overrides,
  }
}

test('Main accepts exact local text, SAPI, and postprocess bindings while keeping cloud providers scoped', async () => {
  const fixture = await createTaskFixture()

  const text = await fixture.create(taskInput())
  assert.equal(text.providerId, 'local-openai-compatible')
  assert.equal(text.modelId, 'mcp-review-text')
  await assert.rejects(fixture.create(taskInput({ providerId: 'untrusted-local-provider' })), { code: 'MODEL_UNAVAILABLE' })
  await assert.rejects(fixture.create(taskInput({ modelId: 'untrusted-local-model' })), { code: 'MODEL_UNAVAILABLE' })

  const audio = await fixture.create(taskInput({
    providerId: 'local-sapi-tts', modelId: 'local-sapi-tts', modality: 'audio',
  }))
  assert.equal(audio.providerId, 'local-sapi-tts')

  const image = await fixture.create(taskInput({
    providerId: 'local-media-postprocess', modelId: 'local-media-postprocess', modality: 'image', prompt: 'resize',
    parameters: { operation: 'local-image', sourceUrl: 'local://fixture/image.png' },
  }))
  assert.equal(image.providerId, 'local-media-postprocess')
  assert.equal(fixture.requests.length, 3)

  await assert.rejects(fixture.create(taskInput({ providerType: 'cloud' })), { code: 'MODEL_UNAVAILABLE' })
  assert.equal(fixture.requests.length, 3)
})
