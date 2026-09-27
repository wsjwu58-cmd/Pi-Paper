const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  WorkerFailure,
  agnesMediaUrl,
  buildAgnesVideoRequest,
  extensionForMediaType,
  getAgnesResponse,
  hasMediaSignature,
  isPublicAddress,
  downloadAgnesOutput,
  runImageTask,
  runVideoTask,
} = require('../src/generation-worker.cjs')
const { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID } = require('../src/agnes-model-catalog.cjs')

const TASK_ID = '99999999-9999-4999-8999-999999999999'
const VIDEO_ID = 'video/id 1'
const CDN_URL = 'https://media.example-cdn.net/output/result.png?signature=mock'

function jobFor(modality, parameters = {}) {
  return {
    taskId: TASK_ID,
    modality,
    providerType: 'cloud',
    providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS[modality],
    endpoint: AGNES_API_BASE_URL,
    // This is a fake test value. No request is sent to Agnes.
    apiKey: 'mock-cloud-key-not-a-secret',
    prompt: '雨夜街道中的纸灯笼',
    parameters,
    outputDirectory: path.join('test-project', '.vibepaper', 'generated', TASK_ID),
  }
}

function response(statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    resumed: false,
    resume() { this.resumed = true },
    async *[Symbol.asyncIterator]() { yield body },
  }
}

function mediaResponse(statusCode, bytes, contentType) {
  return {
    statusCode,
    headers: { 'content-type': contentType },
    resumed: false,
    resume() { this.resumed = true },
    async *[Symbol.asyncIterator]() { yield bytes },
  }
}

test('image request maps the original canvas aspect and resolution fields to Agnes API fields', async () => {
  let request
  let downloaded
  const result = await runImageTask(jobFor('image', {
    aspect: '9:16',
    resolution: '3840x2160',
  }), {
    postJson: async (...args) => {
      request = args
      return { data: [{ url: CDN_URL }] }
    },
    downloadAgnesOutput: async (...args) => {
      downloaded = args
      return `generated/${TASK_ID}/result.png`
    },
  })

  assert.equal(request[0], `${AGNES_API_BASE_URL}/images/generations`)
  assert.deepEqual(request[1], {
    model: AGNES_MODELS.image,
    prompt: '雨夜街道中的纸灯笼',
    n: 1,
    size: '4K',
    ratio: '9:16',
    extra_body: { response_format: 'url' },
  })
  assert.equal(request[2], 'mock-cloud-key-not-a-secret')
  assert.deepEqual(downloaded, [CDN_URL, jobFor('image').outputDirectory, TASK_ID, 'image'])
  assert.deepEqual(result, { outputPath: `generated/${TASK_ID}/result.png` })
})

test('image responses accept provider CDN URLs and preserve returned media format', async () => {
  assert.equal(agnesMediaUrl(CDN_URL), CDN_URL)
  assert.equal(extensionForMediaType('application/octet-stream', 'image', CDN_URL), 'png')
  assert.equal(extensionForMediaType('image/jpg', 'image'), 'jpg')

  await assert.rejects(
    runImageTask(jobFor('image'), {
      postJson: async () => ({ data: [{}] }),
      downloadAgnesOutput: async () => 'unreachable',
    }),
    (error) => error instanceof WorkerFailure && error.code === 'CLOUD_INVALID_RESPONSE',
  )
})

test('image creation retries transient Agnes statuses with exponential delays', async () => {
  let attempts = 0
  const delays = []
  const result = await runImageTask(jobFor('image'), {
    postJson: async () => {
      attempts += 1
      if (attempts < 4) throw new WorkerFailure('CLOUD_REQUEST_FAILED', 'mock transient response', attempts === 1 ? 429 : 503)
      return { data: [{ url: CDN_URL }] }
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
    downloadAgnesOutput: async () => `generated/${TASK_ID}/result.png`,
  })

  assert.equal(attempts, 4)
  assert.deepEqual(delays, [3_000, 6_000, 12_000])
  assert.deepEqual(result, { outputPath: `generated/${TASK_ID}/result.png` })
})

test('image creation stops after five attempts and preserves the final provider failure code', async () => {
  let attempts = 0
  const delays = []
  await assert.rejects(
    runImageTask(jobFor('image'), {
      postJson: async () => {
        attempts += 1
        throw new WorkerFailure('CLOUD_REQUEST_FAILED', 'mock overloaded response', 503)
      },
      sleep: async (milliseconds) => delays.push(milliseconds),
      downloadAgnesOutput: async () => 'unreachable',
    }),
    (error) => error.code === 'CLOUD_REQUEST_FAILED' && error.statusCode === 503,
  )
  assert.equal(attempts, 5)
  assert.deepEqual(delays, [3_000, 6_000, 12_000, 24_000])
})

test('Agnes media URLs must use HTTPS and cannot target private or local addresses', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('2001:4860:4860::8888'), true)
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.10.2',
    '::1', 'fc00::1', 'fe80::1', '2001:db8::1',
  ]) assert.equal(isPublicAddress(address), false, address)

  for (const url of [
    'http://media.example-cdn.net/output.png',
    'https://localhost/output.png',
    'https://127.0.0.1/output.png',
    'https://media.example-cdn.net:8443/output.png',
  ]) {
    assert.throws(() => agnesMediaUrl(url), (error) => error.code === 'CLOUD_INVALID_RESPONSE')
  }
})

test('Agnes redirects are followed with a public-address check on every host and no cross-host API key', async () => {
  const requested = []
  const resolved = []
  const redirect = response(302, {})
  redirect.headers.location = 'https://media.example-cdn.net/assets/result.mp4?signature=mock'
  const final = response(200, { ready: true })

  const result = await getAgnesResponse('https://apihub.agnes-ai.com/agnesapi?video_id=1', 'mock-cloud-key-not-a-secret', 1000, {
    resolvePublicAddress: async (hostname) => {
      resolved.push(hostname)
      return [{ address: '8.8.8.8', family: 4 }]
    },
    requestAgnesUrl: async (url, options) => {
      requested.push({ url: url.toString(), headers: options.headers })
      let lookupResult
      options.lookup(url.hostname, { family: 4 }, (...args) => { lookupResult = args })
      assert.deepEqual(lookupResult, [null, '8.8.8.8', 4])
      return requested.length === 1 ? redirect : final
    },
  })

  assert.equal(result, final)
  assert.equal(redirect.resumed, true)
  assert.deepEqual(resolved, ['apihub.agnes-ai.com', 'media.example-cdn.net'])
  assert.equal(requested[0].headers.authorization, 'Bearer mock-cloud-key-not-a-secret')
  assert.equal(requested[1].headers.authorization, undefined)
  assert.equal(requested[1].headers.accept, '*/*')
})

test('Agnes API key is not resent after a redirect returns to the initial host', async () => {
  const first = response(302, {})
  first.headers.location = 'https://media.example-cdn.net/intermediate'
  const second = response(302, {})
  second.headers.location = 'https://apihub.agnes-ai.com/result'
  const final = response(200, { ready: true })
  const responses = [first, second, final]
  const authorizations = []
  const result = await getAgnesResponse('https://apihub.agnes-ai.com/start', 'mock-cloud-key-not-a-secret', 1000, {
    resolvePublicAddress: async () => [{ address: '8.8.8.8', family: 4 }],
    requestAgnesUrl: async (_url, options) => {
      authorizations.push(options.headers.authorization)
      return responses.shift()
    },
  })
  assert.equal(result, final)
  assert.deepEqual(authorizations, ['Bearer mock-cloud-key-not-a-secret', undefined, undefined])
})

test('media download accepts a redirected provider CDN response with a normal image content type', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-agnes-media-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const generated = path.join(root, 'generated')
  const outputDirectory = path.join(generated, TASK_ID)
  await fs.mkdir(outputDirectory, { recursive: true })
  const redirect = response(307, {})
  redirect.headers.location = 'https://media.example-cdn.net/assets/result.png?signature=mock'
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const final = mediaResponse(200, pngBytes, 'image/png')
  let requestCount = 0

  const output = await downloadAgnesOutput('https://apihub.agnes-ai.com/result', outputDirectory, TASK_ID, 'image', {
    getAgnesResponse: (url, apiKey, timeoutMs) => getAgnesResponse(url, apiKey, timeoutMs, {
      resolvePublicAddress: async () => [{ address: '8.8.8.8', family: 4 }],
      requestAgnesUrl: async () => (++requestCount === 1 ? redirect : final),
    }),
  })

  assert.equal(output, `generated/${TASK_ID}/result.png`)
  assert.equal(requestCount, 2)
  assert.deepEqual(await fs.readFile(path.join(outputDirectory, 'result.png')), pngBytes)
})

test('media download rejects HTTP 200 HTML error pages before marking the task successful', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-agnes-invalid-media-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const generated = path.join(root, 'generated')
  const outputDirectory = path.join(generated, TASK_ID)
  await fs.mkdir(outputDirectory, { recursive: true })
  const html = Buffer.from('<html>temporarily unavailable</html>')

  await assert.rejects(
    downloadAgnesOutput('https://media.example-cdn.net/opaque', outputDirectory, TASK_ID, 'image', {
      getAgnesResponse: async () => mediaResponse(200, html, 'application/octet-stream'),
    }),
    (error) => error.code === 'CLOUD_INVALID_RESPONSE',
  )
  await assert.rejects(fs.stat(path.join(outputDirectory, 'result.jpg')), { code: 'ENOENT' })
})

test('media signature checks match the supported PNG, JPEG, WebP, MP4 and WebM outputs', () => {
  assert.equal(hasMediaSignature('png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true)
  assert.equal(hasMediaSignature('jpg', Buffer.from([0xff, 0xd8, 0xff, 0x00])), true)
  assert.equal(hasMediaSignature('webp', Buffer.from('RIFF0000WEBPVP8 ', 'ascii')), true)
  assert.equal(hasMediaSignature('mp4', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])), true)
  assert.equal(hasMediaSignature('webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), true)
  assert.equal(hasMediaSignature('jpg', Buffer.from('<html>')), false)
})

test('video request maps the canvas aspect field and polls successful 2xx responses', async () => {
  let now = 0
  let request
  const pollUrls = []
  let download
  const videoJob = jobFor('video', { aspect: '1:1', duration: 7 })
  assert.deepEqual(buildAgnesVideoRequest(videoJob), {
    model: AGNES_MODELS.video,
    prompt: videoJob.prompt,
    mode: 'text',
    seconds: '7',
    size: '720P',
    aspect_ratio: '1:1',
    n: 1,
  })

  const result = await runVideoTask(videoJob, {
    postJson: async (url, body, apiKey) => {
      request = { url, body, apiKey }
      return { video_id: VIDEO_ID }
    },
    getAgnesResponse: async (url, apiKey) => {
      pollUrls.push({ url, apiKey })
      return pollUrls.length === 1
        ? response(202, { status: 'processing' })
        : response(200, { status: 'completed', data: { content: { video_url: 'https://media.example-cdn.net/output/final.mp4' } } })
    },
    downloadAgnesOutput: async (...args) => {
      download = args
      return `generated/${TASK_ID}/result.mp4`
    },
    sleep: async () => { now += 1 },
    now: () => now,
    pollIntervalMs: 1,
    timeoutMs: 100,
  })

  assert.equal(request.url, `${AGNES_API_BASE_URL}/videos`)
  assert.equal(request.body.aspect_ratio, '1:1')
  assert.equal(request.apiKey, 'mock-cloud-key-not-a-secret')
  assert.deepEqual(pollUrls.map((item) => item.url), [
    `https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(VIDEO_ID)}&model_name=${AGNES_MODELS.video}`,
    `https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(VIDEO_ID)}&model_name=${AGNES_MODELS.video}`,
  ])
  assert.equal(pollUrls.every((item) => item.apiKey === 'mock-cloud-key-not-a-secret'), true)
  assert.deepEqual(download, [
    'https://media.example-cdn.net/output/final.mp4',
    videoJob.outputDirectory,
    TASK_ID,
    'video',
  ])
  assert.deepEqual(result, { outputPath: `generated/${TASK_ID}/result.mp4` })
})

test('video request preserves public keyframe and reference-image inputs', () => {
  const keyframes = buildAgnesVideoRequest(jobFor('video', {
    firstFrameUrl: 'https://media.example-cdn.net/frames/first.png',
    lastFrameUrl: 'https://media.example-cdn.net/frames/last.png',
    aspect: '16:9',
  }))
  assert.equal(keyframes.mode, 'keyframe')
  assert.deepEqual(keyframes.extra_body, {
    image: [
      'https://media.example-cdn.net/frames/first.png',
      'https://media.example-cdn.net/frames/last.png',
    ],
    mode: 'keyframes',
  })

  const references = buildAgnesVideoRequest(jobFor('video', {
    referenceImages: ['https://media.example-cdn.net/one.png'],
  }))
  assert.equal(references.mode, 'reference')
  assert.deepEqual(references.extra_body, {
    image: ['https://media.example-cdn.net/one.png'],
    mode: 'reference',
  })
})

test('video request fails visibly instead of dropping unresolved local canvas media', () => {
  assert.throws(
    () => buildAgnesVideoRequest(jobFor('video', { firstFrameUrl: 'vibe://app/assets/11111111-1111-4111-8111-111111111111' })),
    (error) => error.code === 'CLOUD_REFERENCE_UNAVAILABLE' && /本地画布媒体参考/u.test(error.message),
  )
})

test('video polling maps non-success HTTP responses to the cloud request failure code', async () => {
  const failedResponse = response(404, { error: 'mock not found' })
  await assert.rejects(
    runVideoTask(jobFor('video'), {
      postJson: async () => ({ video_id: 'missing-video' }),
      getAgnesResponse: async () => failedResponse,
      sleep: async () => {},
      now: (() => { let now = 0; return () => ++now })(),
      pollIntervalMs: 0,
      timeoutMs: 10,
    }),
    (error) => error.code === 'CLOUD_REQUEST_FAILED',
  )
  assert.equal(failedResponse.resumed, true)
})

test('video status polling backs off exponentially after 429 and resets after success', async () => {
  let now = 0
  const delays = []
  const statuses = [
    response(429, { error: 'rate limited' }),
    response(429, { error: 'rate limited' }),
    response(429, { error: 'rate limited' }),
    response(429, { error: 'rate limited' }),
    response(202, { status: 'processing' }),
    response(200, { status: 'completed', metadata: { video_url: 'https://media.example-cdn.net/result.mp4' } }),
  ]

  const result = await runVideoTask(jobFor('video'), {
    postJson: async () => ({ video_id: 'video-rate-limit' }),
    getAgnesResponse: async () => statuses.shift(),
    downloadAgnesOutput: async () => `generated/${TASK_ID}/result.mp4`,
    sleep: async (milliseconds) => {
      delays.push(milliseconds)
      now += milliseconds
    },
    now: () => now,
    pollIntervalMs: 10_000,
    timeoutMs: 300_000,
  })

  assert.deepEqual(delays, [10_000, 20_000, 40_000, 60_000, 60_000, 10_000])
  assert.deepEqual(result, { outputPath: `generated/${TASK_ID}/result.mp4` })
})

test('video creation retries transient Agnes statuses before polling', async () => {
  let attempts = 0
  const delays = []
  const result = await runVideoTask(jobFor('video'), {
    postJson: async () => {
      attempts += 1
      if (attempts < 3) throw new WorkerFailure('CLOUD_REQUEST_FAILED', 'mock transient response', 502)
      return { video_id: 'retry-video' }
    },
    getAgnesResponse: async () => response(200, {
      status: 'completed',
      metadata: { video_url: 'https://media.example-cdn.net/result.mp4' },
    }),
    downloadAgnesOutput: async () => `generated/${TASK_ID}/result.mp4`,
    sleep: async (milliseconds) => { delays.push(milliseconds) },
    now: (() => { let now = 0; return () => ++now })(),
    pollIntervalMs: 0,
    timeoutMs: 10,
  })

  assert.equal(attempts, 3)
  assert.deepEqual(delays, [3_000, 6_000, 0])
  assert.deepEqual(result, { outputPath: `generated/${TASK_ID}/result.mp4` })
})
