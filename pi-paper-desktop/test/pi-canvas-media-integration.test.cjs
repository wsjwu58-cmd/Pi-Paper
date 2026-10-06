const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { runOfficialTask } = require('../src/generation-worker.cjs')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l0AAAAASUVORK5CYII='

test('catalog video defaults reach actual Pi adapters with persisted submission before GET and local output', async (t) => {
  const api = await import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/index.ts')).href)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-canvas-video-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const videoBytes = Buffer.from('000000186674797069736f6d0000000069736f6d69736f32', 'hex')
  for (const model of api.getOfficialProviderCatalog().models.filter((m) => m.modelType === 'video' && m.implemented && m.providerId !== 'agnes')) {
    const taskId = randomUUID()
    const outputDirectory = path.join(root, 'generated', taskId)
    await fs.mkdir(outputDirectory, { recursive: true })
    const events = []
    const credentials = model.providerId === 'kling'
      ? { apiKey: 'fixture-key' }
      : { apiKey: 'fixture-key', workspaceId: 'fixture', region: 'cn-beijing' }
    const endpoint = model.providerId === 'alibaba-video' ? 'https://fixture.cn-beijing.maas.aliyuncs.com/api/v1' : model.apiBaseUrl
    const result = await runOfficialTask({ taskId, outputDirectory, providerId: model.providerId, apiModelId: model.apiModelId, modality: 'video', operation: model.operation,
      prompt: 'test', credentials, apiKey: credentials.apiKey, endpoint,
      parameters: { ...model.defaults, duration: model.defaults.duration ?? 4, size: model.defaults.resolution, aspect: model.defaults.ratio, resKey: model.defaults.resolution, style: 'ink', camera: 'slow', count: 1, referenceImages: [], referenceVideos: [], referenceAudios: [], ...(model.name === 'MiniMax Hailuo 2.3 Fast' ? { firstFrameUrl: `data:image/png;base64,${png}` } : {}) },
    }, {
      checkpoint: async (value) => events.push(value.phase),
      api: { executeOfficialGeneration: (input, options) => api.executeOfficialGeneration(input, { ...options, pollIntervalMs: 0, sleep: async () => {}, resolveReferenceHost: async () => [{ address: '93.184.216.34' }], resolveOutputHost: async () => ['93.184.216.34'], fetch: async (_url, init) => {
        events.push(init.method)
        const videoUrl = 'https://cdn.example/result.mp4'
        if (model.name === 'MiniMax Hailuo 2.3 Fast' && String(_url).includes('/files/retrieve')) return Response.json({ base_resp: { status_code: 0 }, file: { file_id: '42', purpose: 'video_generation', download_url: videoUrl } })
        if (model.providerId === 'google' && String(_url).includes('/files/')) return new Response(videoBytes, { headers: { 'content-type': 'video/mp4' } })
        let body
        if (init.method === 'POST') {
          assert.match(JSON.stringify(JSON.parse(init.body)), /Style: ink/)
          body = model.providerId === 'google' ? { name: `models/${model.apiModelId}/operations/remote-fixture` }
            : model.providerId === 'pixverse' ? { ErrCode: 0, Resp: { video_id: 42 } }
            : model.providerId === 'vidu' ? { task_id: 'remote-fixture' }
            : model.providerId === 'kling' ? { code: 0, data: { task_id: 'remote-fixture' } }
            : model.providerId === 'xai' ? { request_id: 'remote-fixture' }
            : model.providerId === 'alibaba-video' ? { output: { task_id: 'remote-fixture' } }
            : model.providerId === 'minimax' ? { task_id: 'remote-fixture', base_resp: { status_code: 0 } } : { id: 'remote-fixture' }
        } else {
          assert.ok(events.includes('submitted'), model.name)
          body = model.providerId === 'google' ? { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/fixture:download?alt=media' } }] } } }
            : model.providerId === 'pixverse' ? { ErrCode: 0, Resp: { status: 1, url: videoUrl } }
            : model.providerId === 'vidu' ? { state: 'success', creations: [{ url: videoUrl }] }
            : model.providerId === 'kling' ? { code: 0, data: { task_status: 'succeed', task_result: { videos: [{ url: videoUrl }] } } }
            : model.providerId === 'xai' ? { status: 'done', video: { url: videoUrl } }
            : model.providerId === 'alibaba-video' ? { output: { task_status: 'SUCCEEDED', video_url: videoUrl } }
            : model.name === 'MiniMax Hailuo 2.3 Fast' ? { status: 'Success', file_id: '42', base_resp: { status_code: 0 } }
            : model.providerId === 'minimax' ? { task: { status: 'succeeded', content: { url: videoUrl } } } : { status: 'succeeded', content: { video_url: model.name === 'Seedance 2.5' || model.providerId === 'byteplus' ? videoUrl : { url: videoUrl } } }
        }
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      } }) },
      download: async () => { await fs.writeFile(path.join(outputDirectory, 'result.mp4'), 'fixture-video'); return `generated/${taskId}/result.mp4` },
    })
    assert.deepEqual(events, ['submitting', 'POST', 'submitted', 'GET', ...(model.providerId === 'google' || model.name === 'MiniMax Hailuo 2.3 Fast' ? ['GET'] : [])], model.name)
    if (model.providerId === 'google') assert.deepEqual(await fs.readFile(path.join(root, result.outputPath)), videoBytes)
    else assert.equal(await fs.readFile(path.join(root, result.outputPath), 'utf8'), 'fixture-video')
  }
})

test('Vidu canvas frame aliases deduplicate reference images and preserve image-derived aspect ratio', async (t) => {
  const api = await import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/index.ts')).href)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-canvas-vidu-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const model = api.getOfficialProviderCatalog().models.find((m) => m.name === 'Vidu Q3 Pro')
  const first = `data:image/png;base64,${png}`
  const last = 'https://cdn.example/last.png'
  for (const useLast of [false, true]) {
    const taskId = randomUUID()
    const outputDirectory = path.join(root, 'generated', taskId)
    await fs.mkdir(outputDirectory, { recursive: true })
    const result = await runOfficialTask({ taskId, outputDirectory, providerId: model.providerId, apiModelId: model.apiModelId,
      modality: 'video', operation: model.operation, prompt: 'pan across a landscape', apiKey: 'fixture-key', endpoint: model.apiBaseUrl,
      parameters: { ...model.defaults, ratio: 'adaptive', aspect: 'adaptive', firstFrameUrl: first,
        ...(useLast ? { lastFrameUrl: last } : {}), referenceImages: useLast ? [first, last] : [first], count: 1 },
    }, {
      checkpoint: async () => {},
      api: { executeOfficialGeneration: (input, options) => api.executeOfficialGeneration(input, { ...options, pollIntervalMs: 0, sleep: async () => {}, resolveOutputHost: async () => ['93.184.216.34'], fetch: async (url, init) => {
        if (init.method === 'POST') {
          assert.ok(String(url).endsWith(useLast ? '/start-end2video' : '/img2video'))
          const body = JSON.parse(init.body)
          assert.deepEqual(body.images, useLast ? [first, last] : [first])
          assert.equal(body.aspect_ratio, undefined)
          return Response.json({ task_id: 'vidu-fixture' })
        }
        return Response.json({ state: 'success', creations: [{ url: 'https://cdn.example/result.mp4' }] })
      } }) },
      download: async () => { await fs.writeFile(path.join(outputDirectory, 'result.mp4'), 'fixture-video'); return `generated/${taskId}/result.mp4` },
    })
    assert.equal(await fs.readFile(path.join(root, result.outputPath), 'utf8'), 'fixture-video')
  }
})

test('actual Pi image adapters consume catalog defaults and canvas metadata end to end', async (t) => {
  const api = await import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/index.ts')).href)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-canvas-media-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const names = api.getOfficialProviderCatalog().models.filter((model) => model.modelType === 'image' && model.implemented && model.name !== 'Agnes Image 2.5 Flash').map((model) => model.name)
  for (const name of names) {
    const model = api.getOfficialProviderCatalog().models.find((m) => m.name === name)
    const taskId = randomUUID()
    const outputDirectory = path.join(root, 'generated', taskId)
    await fs.mkdir(outputDirectory, { recursive: true })
    const size = model.defaults.size
    const params = { ...model.defaults, prompt: 'test', size, resolution: size, resKey: size.toUpperCase(), aspect: '1:1', ratio: '1:1', count: 1,
      style: 'ink', camera: '', referenceImages: model.operation === 'edit' ? [`data:image/png;base64,${png}`] : [], referenceUrls: [], referenceTexts: [], upstreamNodeIds: [] }
    let requests = 0
    const result = await runOfficialTask({ taskId, outputDirectory, providerId: model.providerId, apiModelId: model.apiModelId, modality: 'image', operation: model.operation, prompt: 'test', parameters: params, apiKey: 'fixture-key', endpoint: model.apiBaseUrl }, {
      api: { executeOfficialGeneration: (input, options) => api.executeOfficialGeneration(input, { ...options, fetch: async (_url, init) => {
        requests++
        const body = JSON.parse(init.body)
        assert.equal(body.model, model.apiModelId, name)
        const response = model.providerId === 'google' ? { steps: [{ type: 'model_output', content: [{ type: 'image', data: png, mime_type: 'image/png' }] }] }
          : model.providerId === 'alibaba' ? { output: { choices: [{ message: { content: [{ image: 'https://cdn.example/result.png' }] } }] } }
          : { data: [{ b64_json: png }] }
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      } }) },
      download: async () => { await fs.writeFile(path.join(outputDirectory, 'result.png'), Buffer.from(png, 'base64')); return `generated/${taskId}/result.png` },
    })
    assert.equal(requests, 1, name)
    assert.deepEqual(await fs.readFile(path.join(root, result.outputPath)), Buffer.from(png, 'base64'), name)
  }
})

test('configured audio operations reach actual Pi adapters and persist MP3 results', async (t) => {
  const api = await import(pathToFileURL(path.join(__dirname, '../../pi-main/packages/ai/src/media/index.ts')).href)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-canvas-audio-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const audio = Buffer.from('ID3fixture-audio-bytes')
  for (const model of api.getOfficialProviderCatalog().models.filter((m) => m.modelType === 'audio' && m.implemented)) {
    const taskId = randomUUID()
    const outputDirectory = path.join(root, 'generated', taskId)
    await fs.mkdir(outputDirectory, { recursive: true })
    let requests = 0
    const result = await runOfficialTask({ taskId, outputDirectory, providerId: model.providerId, apiModelId: model.apiModelId, modality: 'audio', operation: model.operation,
      prompt: model.operation === 'voice-change' ? '' : 'hello', apiKey: 'fixture-key', credentials: { apiKey: 'fixture-key', voiceId: 'voice-fixture', appId: 'fixture-app', accessToken: 'fixture-token' }, endpoint: model.apiBaseUrl,
      parameters: { ...model.defaults, resKey: '2K', aspect: '1:1', style: '', camera: '', count: 1, referenceAudios: model.operation === 'voice-change' ? [`data:audio/mpeg;base64,${audio.toString('base64')}`] : [] },
    }, { api: { executeOfficialGeneration: (input, options) => api.executeOfficialGeneration(input, { ...options, fetch: async (_url, init) => {
      requests++
      if (model.operation === 'voice-change') assert.ok(init.body instanceof FormData)
      else { const body = JSON.parse(init.body); assert.match(body.text ?? body.prompt ?? body.req_params?.text ?? body.request?.text, /hello/) }
      if (model.providerId === 'minimax') return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: audio.toString('hex') } }), { headers: { 'content-type': 'application/json' } })
      if (model.providerId === 'doubao-voice') return new Response(`data: ${JSON.stringify({ code: 0, data: audio.toString('base64') })}\n\ndata: ${JSON.stringify({ code: 20000000 })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      if (model.providerId === 'doubao-voice-v1') return new Response(JSON.stringify({ code: 3000, data: audio.toString('base64') }), { headers: { 'content-type': 'application/json' } })
      return new Response(audio, { headers: { 'content-type': 'audio/mpeg' } })
    } }) } })
    assert.equal(requests, 1, model.name)
    assert.deepEqual(await fs.readFile(path.join(root, result.outputPath)), audio, model.name)
  }
})
