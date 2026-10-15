const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { runOfficialTask } = require('../src/generation-worker.cjs')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l0AAAAASUVORK5CYII='
const video = Buffer.from('000000186674797069736f6d0000000069736f6d69736f32', 'hex')
const loadApi = () => import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/index.ts')).href)

async function fixture(t, api, name, parameters) {
  const model = api.getOfficialProviderCatalog().models.find((entry) => entry.name === name)
  assert.ok(model?.implemented, name)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-selected-spec-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const taskId = randomUUID()
  const outputDirectory = path.join(root, 'generated', taskId)
  await fs.mkdir(outputDirectory, { recursive: true })
  return { root, job: { taskId, outputDirectory, providerId: model.providerId, apiModelId: model.apiModelId,
    modality: model.modelType, operation: model.operation, prompt: 'A quiet landscape', apiKey: 'fixture-key',
    endpoint: model.apiBaseUrl, parameters: { ...model.defaults, ...parameters, count: 1 } } }
}

test('non-default image ratios and tiers become exact provider pixel sizes or explicit image controls', async (t) => {
  const api = await loadApi()
  for (const choice of [
    { name: 'GPT-Image-2', ratio: '3:2', size: '1K', expected: '1536x1024' },
    { name: 'Seedream 5.0 Pro', ratio: '9:16', size: '2K', expected: '1584x2816' },
    { name: 'Banana Pro', ratio: '16:9', size: '4K', expected: '4K' },
  ]) {
    const { root, job } = await fixture(t, api, choice.name, { aspect: choice.ratio, ratio: choice.ratio,
      size: choice.size, resolution: choice.size, resKey: choice.size })
    let sent = false
    const result = await runOfficialTask(job, { api: {
      executeOfficialGeneration: (input, options) => api.executeOfficialGeneration(input, { ...options, fetch: async (_url, init) => {
        const body = JSON.parse(init.body)
        if (job.providerId === 'google') {
          assert.equal(body.response_format.aspect_ratio, choice.ratio)
          assert.equal(body.response_format.image_size, choice.expected)
        } else assert.equal(body.size, choice.expected, choice.name)
        sent = true
        return Response.json(job.providerId === 'google'
          ? { steps: [{ type: 'model_output', content: [{ type: 'image', data: png, mime_type: 'image/png' }] }] }
          : { data: [{ b64_json: png }] })
      } }),
    } })
    assert.ok(sent)
    assert.deepEqual(await fs.readFile(path.join(root, result.outputPath)), Buffer.from(png, 'base64'))
  }
})

test('non-default video ratio, resolution, duration and audio flag survive Worker and persisted submission', async (t) => {
  const api = await loadApi()
  for (const name of ['Seedance 2.0', 'MiniMax H3', 'Vidu Q3 Pro']) {
    const resolution = name === 'MiniMax H3' ? '768P' : '1080p'
    const { root, job } = await fixture(t, api, name, { aspect: '9:16', ratio: '9:16', size: resolution,
      resolution, resKey: resolution.toUpperCase(), duration: 10, ...(name !== 'MiniMax H3' ? { generate_audio: false } : {}) })
    const events = []
    const result = await runOfficialTask(job, {
      checkpoint: async (value) => events.push(value.phase),
      api: { executeOfficialGeneration: (input, options) => api.executeOfficialGeneration(input, { ...options,
        pollIntervalMs: 0, sleep: async () => {}, resolveOutputHost: async () => ['93.184.216.34'], fetch: async (_url, init) => {
          if (init.method === 'POST') {
            assert.deepEqual(events, ['submitting'])
            const body = JSON.parse(init.body)
            assert.equal(body.duration, 10, name)
            assert.equal(body.resolution.toLowerCase(), resolution.toLowerCase(), name)
            assert.equal(body.ratio ?? body.aspect_ratio, '9:16', name)
            if (name !== 'MiniMax H3') assert.equal(body.generate_audio ?? body.audio, false)
            return Response.json(job.providerId === 'minimax' || job.providerId === 'vidu' ? { task_id: 'spec-fixture' } : { id: 'spec-fixture' })
          }
          assert.deepEqual(events, ['submitting', 'submitted'])
          return Response.json(job.providerId === 'minimax'
            ? { task: { status: 'succeeded', content: { url: 'https://cdn.example/result.mp4' } } }
            : job.providerId === 'vidu' ? { state: 'success', creations: [{ url: 'https://cdn.example/result.mp4' }] }
              : { status: 'succeeded', content: { video_url: { url: 'https://cdn.example/result.mp4' } } })
        } }) },
      download: async () => { await fs.writeFile(path.join(job.outputDirectory, 'result.mp4'), video); return `generated/${job.taskId}/result.mp4` },
    })
    assert.deepEqual(await fs.readFile(path.join(root, result.outputPath)), video)
  }
})

test('unsupported or conflicting selected specifications fail before any provider request', async (t) => {
  const api = await loadApi()
  for (const [name, params] of [
    ['GPT-Image-2', { ratio: '21:9', aspect: '21:9', size: '1K' }],
    ['Seedream 5.0 Pro', { ratio: '9:16', aspect: '9:16', size: '4K' }],
    ['Seedance 2.0', { ratio: '9:16', aspect: '16:9' }],
    ['Seedance 2.0', { resolution: '1080p', size: '480p' }],
    ['Vidu Q3 Pro', { duration: 17 }],
  ]) {
    const { job } = await fixture(t, api, name, params)
    let submitted = false
    await assert.rejects(runOfficialTask(job, { checkpoint: async () => { submitted = true }, api: {
      executeOfficialGeneration: (input, options) => api.executeOfficialGeneration(input, { ...options,
        fetch: async () => { submitted = true; throw new Error('Unexpected provider request') } }),
    } }))
    assert.equal(submitted, false, name)
  }
})
