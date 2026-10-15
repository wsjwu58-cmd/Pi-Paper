const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const { buildAgnesImageRequest, buildAgnesVideoRequest } = require('../src/generation-worker.cjs')
const { AGNES_MODELS } = require('../src/agnes-model-catalog.cjs')
const loadApi = () => import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/index.ts')).href)

function jobFor(modality, parameters) {
  return { modality, providerId: 'agnes', modelId: AGNES_MODELS[modality],
    prompt: 'A quiet landscape', parameters }
}

test('every declared legacy Agnes image specification reaches the existing request builder', async () => {
  const api = await loadApi()
  const model = api.getOfficialProviderCatalog().models.find(entry => entry.name === 'Agnes Image 2.5 Flash')
  assert.equal(model.route, 'legacy-agnes')
  assert.ok(model.constraints.acceptedSizes.length)
  assert.ok(model.constraints.acceptedAspectRatios.length)
  for (const size of model.constraints.acceptedSizes) {
    for (const ratio of model.constraints.acceptedAspectRatios) {
      const request = buildAgnesImageRequest(jobFor('image', { ...model.defaults, size, ratio,
        aspect: ratio, resKey: size, resolution: size }))
      assert.equal(request.size, size)
      assert.equal(request.ratio, ratio)
      assert.equal(request.model, AGNES_MODELS.image)
    }
  }
})

test('every declared legacy Agnes video ratio and duration reaches the existing request builder', async () => {
  const api = await loadApi()
  const model = api.getOfficialProviderCatalog().models.find(entry => entry.name === 'Agnes Video 2.5 Flash')
  assert.equal(model.route, 'legacy-agnes')
  assert.deepEqual(model.constraints.acceptedResolutions, ['720P'])
  assert.ok(model.constraints.acceptedAspectRatios.length)
  for (const ratio of model.constraints.acceptedAspectRatios) {
    for (let duration = model.constraints.minimumDuration; duration <= model.constraints.maximumDuration; duration++) {
      const request = buildAgnesVideoRequest(jobFor('video', { ...model.defaults, ratio, aspect: ratio,
        resolution: '720P', resKey: '720P', duration }))
      assert.equal(request.size, '720P')
      assert.equal(request.aspect_ratio, ratio)
      assert.equal(request.seconds, String(duration))
      assert.equal(request.model, AGNES_MODELS.video)
    }
  }
})
