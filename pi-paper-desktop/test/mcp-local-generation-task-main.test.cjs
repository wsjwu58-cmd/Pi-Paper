const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

async function createTaskFixture(options = {}) {
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
    providerSettings: options.providerSettings ?? { snapshot: async () => ({ models: [] }) },
    localCore: options.localCore ?? { request: async (method, input) => {
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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function resolvedCloudProvider(resolve) {
  return {
    snapshot: async () => ({ models: [{ id: 'fixture-image', providerId: 'fixture-provider' }] }),
    resolve,
  }
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

test('MCP authorization is rechecked after provider resolution before task:create', async () => {
  const resolving = deferred()
  const releaseProvider = deferred()
  const fixture = await createTaskFixture({
    providerSettings: resolvedCloudProvider(async () => {
      resolving.resolve()
      await releaseProvider.promise
      return { providerId: 'fixture-provider', modelId: 'fixture-image', model: { defaults: {}, constraints: {} } }
    }),
  })
  let revoked = false
  let authorizationChecks = 0
  const pending = fixture.create(taskInput({
    providerType: 'cloud', providerId: 'fixture-provider', modelId: 'fixture-image', modality: 'image',
  }), { assertAuthorized: async () => {
    authorizationChecks += 1
    if (revoked) throw Object.assign(new Error('MCP command was revoked'), { code: 'PERMISSION_DENIED' })
  } })

  await resolving.promise
  revoked = true
  releaseProvider.resolve()

  await assert.rejects(pending, { code: 'PERMISSION_DENIED' })
  assert.equal(authorizationChecks, 1)
  assert.equal(fixture.requests.length, 0)
})

test('authorized MCP generation dispatches one task without forwarding the authorization callback', async () => {
  const fixture = await createTaskFixture({
    providerSettings: resolvedCloudProvider(async () => ({
      providerId: 'fixture-provider', modelId: 'fixture-image', model: { defaults: {}, constraints: {} },
    })),
  })
  let authorizationChecks = 0

  const task = await fixture.create(taskInput({
    providerType: 'cloud', providerId: 'fixture-provider', modelId: 'fixture-image', modality: 'image',
  }), { assertAuthorized: async () => { authorizationChecks += 1 } })

  assert.equal(authorizationChecks, 1)
  assert.equal(fixture.requests.length, 1)
  assert.equal(fixture.requests[0].method, 'task:create')
  assert.equal(task.taskId, 'task-1')
  assert.equal(Object.hasOwn(fixture.requests[0].input, 'assertAuthorized'), false)
  assert.equal(Object.hasOwn(fixture.requests[0].input, 'mcpCommandId'), false)
})

test('a disconnected caller does not cause task:create to be replayed after dispatch begins', async () => {
  const dispatchStarted = deferred()
  const loseResponse = deferred()
  const requests = []
  const fixture = await createTaskFixture({
    providerSettings: resolvedCloudProvider(async () => ({
      providerId: 'fixture-provider', modelId: 'fixture-image', model: { defaults: {}, constraints: {} },
    })),
    localCore: { request: async (method, input) => {
      requests.push({ method, input })
      dispatchStarted.resolve()
      return loseResponse.promise
    } },
  })
  let authorizationChecks = 0
  const pending = fixture.create(taskInput({
    providerType: 'cloud', providerId: 'fixture-provider', modelId: 'fixture-image', modality: 'image',
  }), { assertAuthorized: async () => { authorizationChecks += 1 } })

  await dispatchStarted.promise
  loseResponse.reject(Object.assign(new Error('connection closed'), { code: 'TRANSPORT_CLOSED' }))

  await assert.rejects(pending, { code: 'TRANSPORT_CLOSED' })
  assert.equal(authorizationChecks, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'task:create')
})
