const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

test('Main snapshots configured model defaults at task creation and preserves canvas overrides', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8')
  const start = source.indexOf('async function createGenerationTaskInStore(')
  const end = source.indexOf('\nfunction dramaRenderBatchScope(', start)
  assert.ok(start >= 0 && end > start)
  const defaults = { ratio: 'adaptive', resolution: '480p', duration: 15, generate_audio: true }
  const constraints = { imageAspectRatio: 'adaptive' }
  const binding = { id: 'video-binding', providerId: 'volcengine-ark', modelType: 'video' }
  const context = vm.createContext({
    getOfficialCatalog: () => ({ providers: [{ id: binding.providerId }] }),
    providerSettings: {
      snapshot: async () => ({ models: [binding] }),
      resolve: async () => ({ providerId: binding.providerId, modelId: binding.id, model: { defaults, constraints } }),
    },
    localCore: { request: async (_method, input) => input },
    codedError: (code) => Object.assign(new Error(code), { code }),
    AGNES_PROVIDER_ID: 'agnes', ARK_PROVIDER_ID: 'volcengine',
  })
  vm.runInContext(source.slice(start, end), context)
  const input = { projectId: 'project', canvasId: 'canvas', canvasVersion: 1, nodeId: 'node', modality: 'video', providerType: 'cloud', providerId: binding.providerId, modelId: binding.id, prompt: 'ocean', idempotencyKey: 'request' }
  const task = await context.createGenerationTaskInStore(input)
  assert.equal(task.parameters.duration, 15)
  defaults.duration = 20
  assert.equal(task.parameters.duration, 15)
  const overridden = await context.createGenerationTaskInStore({ ...input, parameters: { aspect: '9:16', size: '720p', duration: 8, generate_audio: false } })
  assert.equal(overridden.parameters.aspect, '9:16')
  assert.equal(overridden.parameters.ratio, undefined)
  assert.equal(overridden.parameters.size, '720p')
  assert.equal(overridden.parameters.resolution, undefined)
  assert.equal(overridden.parameters.duration, 8)
  assert.equal(overridden.parameters.generate_audio, false)
  defaults.ratio = '16:9'
  const imageDerived = await context.createGenerationTaskInStore({ ...input, parameters: { firstFrameUrl: 'https://cdn.example/frame.png' } })
  assert.equal(imageDerived.parameters.ratio, undefined)
  const explicitRatio = await context.createGenerationTaskInStore({ ...input, parameters: { firstFrameUrl: 'https://cdn.example/frame.png', ratio: 'adaptive' } })
  assert.equal(explicitRatio.parameters.ratio, 'adaptive')
  await assert.rejects(context.createGenerationTaskInStore({ ...input, modelId: undefined }), { code: 'MODEL_UNAVAILABLE' })
})
