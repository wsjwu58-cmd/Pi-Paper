const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  WorkerFailure,
  agnesMediaUrl,
  buildAgnesImageRequest,
  buildAgnesVideoRequest,
  buildArkVideoRequest,
  extensionForMediaType,
  getAgnesResponse,
  hasMediaSignature,
  isPublicAddress,
  downloadAgnesOutput,
  postJson,
  runImageTask,
  runVideoTask,
  runArkVideoTask,
} = require('../src/generation-worker.cjs')
const { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID } = require('../src/agnes-model-catalog.cjs')
const { ARK_API_BASE_URL, ARK_MODELS, ARK_PROVIDER_ID, resolveArkVideoModelConfig } = require('../src/ark-model-catalog.cjs')

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

function arkVideoJob(parameters = {}) {
  return {
    taskId: TASK_ID,
    modality: 'video',
    providerType: 'cloud',
    providerId: ARK_PROVIDER_ID,
    modelId: ARK_MODELS.video,
    apiKey: 'mock-ark-api-key-not-a-secret',
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

test('cloud HTTP errors preserve the provider detail and redact the configured API key', async (t) => {
  const apiKey = 'mock-api-key-must-not-be-persisted'
  const server = http.createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: `invalid image dimensions; echoed ${apiKey}` } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()

  await assert.rejects(
    postJson(`http://127.0.0.1:${address.port}/images/generations`, { prompt: 'test' }, apiKey),
    (error) => error.code === 'CLOUD_REQUEST_FAILED'
      && error.statusCode === 400
      && /invalid image dimensions/u.test(error.message)
      && !error.message.includes(apiKey),
  )
})

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
  assert.deepEqual(downloaded.slice(0, 4), [CDN_URL, jobFor('image').outputDirectory, TASK_ID, 'image'])
  assert.equal(downloaded[5], 0)
  assert.deepEqual(result, {
    outputPath: `generated/${TASK_ID}/result.png`,
    outputPaths: [`generated/${TASK_ID}/result.png`],
  })
})

test('Agnes image count submits one request per requested output and keeps indexed files', async () => {
  const requests = []
  const downloads = []
  const result = await runImageTask(jobFor('image', { count: 3 }), {
    postJson: async (_endpoint, payload) => {
      requests.push(payload)
      return { data: [{ url: CDN_URL }] }
    },
    downloadAgnesOutput: async (...args) => {
      downloads.push(args)
      const index = args[5]
      return `generated/${TASK_ID}/result${index ? `-${index}` : ''}.png`
    },
  })

  assert.equal(requests.length, 3)
  assert.ok(requests.every((request) => request.n === 1))
  assert.deepEqual(downloads.map((args) => args[5]), [0, 1, 2])
  assert.deepEqual(result, {
    outputPath: `generated/${TASK_ID}/result.png`,
    outputPaths: [
      `generated/${TASK_ID}/result.png`,
      `generated/${TASK_ID}/result-1.png`,
      `generated/${TASK_ID}/result-2.png`,
    ],
  })
})

test('Agnes image operations preserve the original outpaint and upscale prompt semantics', () => {
  const outpaint = buildAgnesImageRequest({
    ...jobFor('image'),
    prompt: '',
    parameters: { operation: '扩图', sourceUrl: 'data:image/png;base64,iVBORw0KGgo=', style: '水墨' },
  })
  assert.equal(outpaint.prompt, '扩展画面边缘，保持主体完整，outpainting，扩图\n风格：水墨')
  assert.equal(outpaint.extra_body.image[0], 'iVBORw0KGgo=')

  const upscale = buildAgnesImageRequest({
    ...jobFor('image'),
    prompt: '保留主体',
    parameters: { operation: 'upscale_image', sourceUrl: 'https://media.example-cdn.net/source.png' },
  })
  assert.equal(upscale.prompt, '保留主体，高清超分，保留原构图')
  assert.equal(upscale.extra_body.image[0], 'https://media.example-cdn.net/source.png')
})

test('unsupported image processing fails visibly instead of falling back to generated content', async () => {
  await assert.rejects(
    runImageTask(jobFor('image', { operation: '裁剪' }), {
      postJson: async () => ({ data: [{ url: CDN_URL }] }),
      downloadAgnesOutput: async () => 'unreachable',
    }),
    (error) => error.code === 'UNSUPPORTED_IMAGE_OPERATION',
  )
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
  assert.deepEqual(result, {
    outputPath: `generated/${TASK_ID}/result.png`,
    outputPaths: [`generated/${TASK_ID}/result.png`],
  })
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

test('Agnes rate limiting remains visible after retries are exhausted', async () => {
  let attempts = 0
  await assert.rejects(
    runVideoTask(jobFor('video'), {
      postJson: async () => {
        attempts += 1
        throw new WorkerFailure('CLOUD_REQUEST_FAILED', 'mock rate limit', 429)
      },
      sleep: async () => {},
    }),
    (error) => error.code === 'CLOUD_RATE_LIMITED' && error.statusCode === 429,
  )
  assert.equal(attempts, 5)
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
  assert.equal(keyframes.first_frame, 'https://media.example-cdn.net/frames/first.png')
  assert.equal(keyframes.last_frame, 'https://media.example-cdn.net/frames/last.png')
  assert.equal(Object.hasOwn(keyframes, 'extra_body'), false)
  assert.deepEqual(buildAgnesVideoRequest(jobFor('video', {
    firstFrameUrl: 'https://media.example-cdn.net/frames/first.png',
  })), {
    model: AGNES_MODELS.video,
    prompt: '雨夜街道中的纸灯笼',
    mode: 'keyframe',
    seconds: '5',
    size: '720P',
    aspect_ratio: '16:9',
    n: 1,
    first_frame: 'https://media.example-cdn.net/frames/first.png',
  })

  const references = buildAgnesVideoRequest(jobFor('video', {
    referenceImages: ['https://media.example-cdn.net/one.png'],
  }))
  assert.equal(references.mode, 'reference')
  assert.deepEqual(references.images, ['https://media.example-cdn.net/one.png'])
  assert.equal(Object.hasOwn(references, 'extra_body'), false)
})

test('video task serializes an upstream first-frame image using the Agnes 2.5 keyframe API fields', async () => {
  const firstFrame = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`
  let posted
  const result = await runVideoTask(jobFor('video', {
    firstFrameUrl: firstFrame,
    imageUrl: firstFrame,
    referenceImages: [firstFrame],
    duration: 4,
    aspect: '9:16',
  }), {
    postJson: async (url, payload) => {
      posted = { url, payload: JSON.parse(JSON.stringify(payload)) }
      return { video_id: VIDEO_ID }
    },
    getAgnesResponse: async () => response(200, {
      status: 'completed',
      url: 'https://media.example-cdn.net/output/result.mp4',
    }),
    downloadAgnesOutput: async () => `generated/${TASK_ID}/result.mp4`,
    sleep: async () => {},
    now: () => 0,
    pollIntervalMs: 0,
    timeoutMs: 1,
  })

  assert.equal(posted.url, `${AGNES_API_BASE_URL}/videos`)
  assert.equal(posted.payload.model, AGNES_MODELS.video)
  assert.equal(posted.payload.mode, 'keyframe')
  assert.equal(posted.payload.first_frame, firstFrame)
  assert.equal(posted.payload.last_frame, undefined)
  assert.equal(Object.hasOwn(posted.payload, 'extra_body'), false)
  assert.equal(Object.hasOwn(posted.payload, 'images'), false)
  assert.deepEqual(result, { outputPath: `generated/${TASK_ID}/result.mp4` })
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

test('video status polling backs off after 429, 502, 503 and 504, then resets after a successful poll', async () => {
  let now = 0
  const delays = []
  const statuses = [
    response(429, { error: 'rate limited' }),
    response(502, { error: 'bad gateway' }),
    response(503, { error: 'video queue is full, please retry later' }),
    response(504, { error: 'gateway timeout' }),
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

test('video polling preserves transient provider status and detail after bounded retries', async (t) => {
  for (const statusCode of [429, 502, 503, 504]) {
    await t.test(`HTTP ${statusCode}`, async () => {
      const delays = []
      const detail = 'video queue is full, please retry later'
      await assert.rejects(
        runVideoTask(jobFor('video'), {
          postJson: async () => ({ video_id: `poll-error-${statusCode}` }),
          getAgnesResponse: async () => response(statusCode, { error: { message: detail } }),
          sleep: async (milliseconds) => delays.push(milliseconds),
          now: (() => { let now = 0; return () => ++now })(),
          pollIntervalMs: 0,
          timeoutMs: 100,
        }),
        (error) => error.code === (statusCode === 429 ? 'CLOUD_RATE_LIMITED' : 'CLOUD_REQUEST_FAILED')
          && error.statusCode === statusCode
          && error.message.includes(detail),
      )
      assert.deepEqual(delays, [0, 0, 0, 0, 0])
    })
  }
})

test('video status polling backs off transient connection failures and recovers', async () => {
  let now = 0
  let attempts = 0
  const delays = []
  const result = await runVideoTask(jobFor('video'), {
    postJson: async () => ({ video_id: 'poll-network-recovery' }),
    getAgnesResponse: async () => {
      attempts += 1
      if (attempts < 5) throw new WorkerFailure('CLOUD_PROVIDER_UNAVAILABLE', 'mock connection reset')
      return response(200, { status: 'completed', metadata: { video_url: 'https://media.example-cdn.net/result.mp4' } })
    },
    downloadAgnesOutput: async () => `generated/${TASK_ID}/result.mp4`,
    sleep: async (milliseconds) => {
      delays.push(milliseconds)
      now += milliseconds
    },
    now: () => now,
    pollIntervalMs: 10_000,
    timeoutMs: 300_000,
  })

  assert.equal(attempts, 5)
  assert.deepEqual(delays, [10_000, 20_000, 40_000, 60_000, 60_000])
  assert.deepEqual(result, { outputPath: `generated/${TASK_ID}/result.mp4` })
})

test('video creation retries Agnes HTTP 429, 502, 503 and 504 before polling', async (t) => {
  for (const statusCode of [429, 502, 503, 504]) {
    await t.test(`HTTP ${statusCode}`, async () => {
      let attempts = 0
      const delays = []
      const result = await runVideoTask(jobFor('video'), {
        postJson: async () => {
          attempts += 1
          if (attempts === 1) throw new WorkerFailure('CLOUD_REQUEST_FAILED', 'mock transient response', statusCode)
          return { video_id: `retry-video-${statusCode}` }
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

      assert.equal(attempts, 2)
      assert.deepEqual(delays, [3_000, 0])
      assert.deepEqual(result, { outputPath: `generated/${TASK_ID}/result.mp4` })
    })
  }
})

test('video creation surfaces the final Agnes queue-full response after bounded retries', async () => {
  let attempts = 0
  const delays = []
  await assert.rejects(
    runVideoTask(jobFor('video'), {
      postJson: async () => {
        attempts += 1
        throw new WorkerFailure('CLOUD_REQUEST_FAILED', 'Agnes 请求失败 HTTP 503：video queue is full, please retry later', 503)
      },
      sleep: async (milliseconds) => delays.push(milliseconds),
    }),
    (error) => error.code === 'CLOUD_REQUEST_FAILED'
      && error.statusCode === 503
      && /video queue is full, please retry later/u.test(error.message),
  )
  assert.equal(attempts, 5)
  assert.deepEqual(delays, [3_000, 6_000, 12_000, 24_000])
})

test('Ark video request preserves separate HTTPS image, video, and audio reference content types', () => {
  const request = buildArkVideoRequest(arkVideoJob({
    ratio: '16:9',
    duration: 6,
    firstFrameUrl: 'https://images.example-cdn.net/start.png?sig=one',
    referenceVideos: ['https://media.example-cdn.net/ref.mp4?sig=two'],
    referenceAudios: ['https://media.example-cdn.net/ref.wav?sig=three'],
  }))
  assert.equal(request.model, 'doubao-seedance-2-5-260628')
  assert.equal(request.duration, 6)
  assert.equal(request.ratio, 'adaptive', 'Seedance 2.5 keyframe references lock the source aspect ratio')
  assert.equal(request.resolution, '720p')
  assert.deepEqual(request.content.slice(1), [
    { type: 'image_url', image_url: { url: 'https://images.example-cdn.net/start.png?sig=one' }, role: 'first_frame' },
    { type: 'video_url', video_url: { url: 'https://media.example-cdn.net/ref.mp4?sig=two' }, role: 'reference_video' },
    { type: 'audio_url', audio_url: { url: 'https://media.example-cdn.net/ref.wav?sig=three' }, role: 'reference_audio' },
  ])
  assert.equal(JSON.stringify(request).includes('mock-ark-api-key'), false)
})

test('Ark references reject non-HTTPS, local, private, credentialed, and overlong addresses before sending', () => {
  for (const reference of [
    'http://media.example.net/ref.mp4',
    'https://localhost/ref.mp4',
    'https://127.0.0.1/ref.mp4',
    'https://192.168.1.5/ref.mp4',
    'https://user:pass@media.example.net/ref.mp4',
    `https://media.example.net/${'a'.repeat(4100)}`,
    'vibe://app/assets/11111111-1111-4111-8111-111111111111',
  ]) {
    assert.throws(
      () => buildArkVideoRequest(arkVideoJob({ referenceVideos: [reference] })),
      (error) => error.code === 'CLOUD_REFERENCE_UNAVAILABLE',
    )
  }
})

test('Ark task does not submit local media, data URLs, or Files API IDs as reference URLs', async () => {
  let submissions = 0
  const unsupportedReferences = {
    referenceVideos: [
      'data:video/mp4;base64,AAAA',
      'file:///C:/Users/example/reference.mp4',
      'file-20251018114827-6zgrb',
      'mm_file://file-20251018114827-6zgrb',
      'vibe://app/assets/11111111-1111-4111-8111-111111111111',
    ],
    referenceAudios: [
      'data:audio/mpeg;base64,AAAA',
      'file:///C:/Users/example/reference.mp3',
      'file-20251018114827-6zgrb',
      'mm_file://file-20251018114827-6zgrb',
      'vibe://app/assets/11111111-1111-4111-8111-111111111111',
    ],
  }

  for (const [field, references] of Object.entries(unsupportedReferences)) {
    for (const reference of references) {
      await assert.rejects(
        runArkVideoTask(arkVideoJob({ [field]: [reference] }), {
          postArkJson: async () => { submissions += 1; return { id: 'should-not-submit' } },
          getArkJson: async () => assert.fail('an unsupported reference must not create a task'),
        }),
        (error) => error.code === 'CLOUD_REFERENCE_UNAVAILABLE',
      )
    }
  }
  assert.equal(submissions, 0)
})

test('Seedance 2.5 duration and mixed media reference limits match the model contract', () => {
  assert.equal(buildArkVideoRequest(arkVideoJob({ duration: 4 })).duration, 4)
  assert.equal(buildArkVideoRequest(arkVideoJob({ duration: 30 })).duration, 30)
  for (const duration of [3, 31]) {
    assert.throws(() => buildArkVideoRequest(arkVideoJob({ duration })),
      (error) => error.code === 'CLOUD_INPUT_INVALID' && /4 到 30 秒/u.test(error.message))
  }

  const references = Array.from({ length: 50 }, (_, index) => `https://media.example-cdn.net/ref-${index}.mp4`)
  assert.equal(buildArkVideoRequest(arkVideoJob({ referenceVideos: references })).content.length, 51)
  references.push('https://media.example-cdn.net/ref-50.mp4')
  assert.throws(() => buildArkVideoRequest(arkVideoJob({ referenceVideos: references })),
    (error) => error.code === 'CLOUD_INPUT_INVALID' && /参考数量/u.test(error.message))
})

test('Ark maps original desktop node size values to supported resolution names', () => {
  assert.equal(buildArkVideoRequest(arkVideoJob({ size: '720P', resolution: '1280x720' })).resolution, '720p')
  assert.equal(buildArkVideoRequest(arkVideoJob({ size: '1080P' })).resolution, '1080p')
  assert.equal(buildArkVideoRequest(arkVideoJob({ size: '480P' })).resolution, '480p')
  assert.throws(() => buildArkVideoRequest(arkVideoJob({ size: '8K' })),
    (error) => error.code === 'CLOUD_INPUT_INVALID' && /分辨率/u.test(error.message))
})

test('Ark video task posts, polls and saves results without logging or returning signed reference URLs', async () => {
  const refUrl = 'https://media.example-cdn.net/private.mp4?signature=secret'
  const posts = []
  const polls = []
  const downloads = []
  const result = await runArkVideoTask(arkVideoJob({ referenceVideos: [refUrl] }), {
    resolveReferenceHost: async () => [{ address: '93.184.216.34', family: 4 }],
    postArkJson: async (...args) => { posts.push(args); return { id: 'ark-task-123' } },
    getArkJson: async (...args) => {
      polls.push(args)
      return { data: { status: 'succeeded', content: { video_url: 'https://result.example-cdn.net/result.mp4?token=output' } } }
    },
    downloadArkOutput: async (...args) => { downloads.push(args); return `generated/${TASK_ID}/result.mp4` },
    sleep: async () => {},
    now: () => 0,
  })
  assert.equal(posts[0][0], `${ARK_API_BASE_URL}/contents/generations/tasks`)
  assert.equal(posts[0][1].content[1].video_url.url, refUrl)
  assert.equal(posts[0][2], 'mock-ark-api-key-not-a-secret')
  assert.equal(polls[0][0], `${ARK_API_BASE_URL}/contents/generations/tasks/ark-task-123`)
  assert.deepEqual(downloads[0].slice(0, 4), ['https://result.example-cdn.net/result.mp4?token=output', arkVideoJob().outputDirectory, TASK_ID, 'video'])
  assert.deepEqual(result, { outputPath: `generated/${TASK_ID}/result.mp4` })
})

test('desktop video node reference fields route through the Main Ark model selection and save mocked output', async () => {
  // These are the exact desktop NodeEditor parameter names produced by
  // buildMediaReferenceParameters(..., 'video', true).
  const nodeParameters = {
    prompt: '雨夜中的纸灯笼',
    referenceImages: ['https://images.example-cdn.net/start.png'],
    referenceVideos: ['https://media.example-cdn.net/ref.mp4?sig=video'],
    referenceAudios: ['https://media.example-cdn.net/ref.wav?sig=audio'],
    duration: 8,
    ratio: '16:9',
  }
  const model = resolveArkVideoModelConfig({
    providerId: ARK_PROVIDER_ID,
    modality: 'video',
    modelId: ARK_MODELS.video,
    apiKey: 'mock-ark-key-not-a-secret',
  })
  const posts = []
  const polls = []
  const downloads = []
  const output = await runArkVideoTask({
    ...model,
    taskId: TASK_ID,
    modality: 'video',
    prompt: nodeParameters.prompt,
    parameters: nodeParameters,
    outputDirectory: path.join('test-project', '.vibepaper', 'generated', TASK_ID),
  }, {
    resolveReferenceHost: async () => [{ address: '93.184.216.34', family: 4 }],
    postArkJson: async (...args) => { posts.push(args); return { id: 'main-route-task-1' } },
    getArkJson: async (...args) => {
      polls.push(args)
      return { data: { status: 'succeeded', content: { video_url: 'https://result.example-cdn.net/generated.mp4' } } }
    },
    downloadArkOutput: async (...args) => { downloads.push(args); return `generated/${TASK_ID}/result.mp4` },
    sleep: async () => {},
    now: () => 0,
  })

  assert.equal(model.providerId, 'volcengine-ark')
  assert.equal(model.modelId, 'doubao-seedance-2-5-260628')
  assert.equal(posts[0][0], `${ARK_API_BASE_URL}/contents/generations/tasks`)
  assert.deepEqual(posts[0][1].content.slice(1), [
    { type: 'image_url', image_url: { url: nodeParameters.referenceImages[0] }, role: 'reference_image' },
    { type: 'video_url', video_url: { url: nodeParameters.referenceVideos[0] }, role: 'reference_video' },
    { type: 'audio_url', audio_url: { url: nodeParameters.referenceAudios[0] }, role: 'reference_audio' },
  ])
  assert.equal(polls[0][0], `${ARK_API_BASE_URL}/contents/generations/tasks/main-route-task-1`)
  assert.deepEqual(downloads[0].slice(1, 4), [path.join('test-project', '.vibepaper', 'generated', TASK_ID), TASK_ID, 'video'])
  assert.deepEqual(output, { outputPath: `generated/${TASK_ID}/result.mp4` })

  assert.throws(
    () => buildAgnesVideoRequest(jobFor('video', nodeParameters)),
    (error) => error.code === 'UNSUPPORTED_REFERENCE_MEDIA',
  )
})

test('Ark task blocks reference hosts resolving to private addresses and redacts signed URLs from provider errors', async () => {
  const refUrl = 'https://media.example-cdn.net/ref.mp4?signature=secret'
  await assert.rejects(
    runArkVideoTask(arkVideoJob({ referenceVideos: [refUrl] }), {
      resolveReferenceHost: async () => [{ address: '10.0.0.7', family: 4 }],
      postArkJson: async () => assert.fail('private reference must not be sent'),
    }),
    (error) => error.code === 'CLOUD_REFERENCE_UNAVAILABLE',
  )

  await assert.rejects(
    runArkVideoTask(arkVideoJob({ referenceVideos: [refUrl] }), {
      resolveReferenceHost: async () => [{ address: '93.184.216.34', family: 4 }],
      postArkJson: async () => ({ id: 'ark-task-123' }),
      getArkJson: async () => { throw new WorkerFailure('CLOUD_REQUEST_FAILED', `provider echoed ${refUrl}`, 400) },
      sleep: async () => {},
      now: () => 0,
    }),
    (error) => error.code === 'CLOUD_REQUEST_FAILED'
      && !error.message.includes(refUrl)
      && error.message.includes('[已隐藏参考地址]'),
  )
})

test('Ark task errors preserve the provider reason while hiding unrelated signed media URLs', async () => {
  const unrelatedSignedUrl = 'https://private-output.example/result.mp4?signature=provider-secret'
  await assert.rejects(
    runArkVideoTask(arkVideoJob(), {
      postArkJson: async () => ({ id: 'ark-task-failed' }),
      getArkJson: async () => ({
        data: { status: 'failed', error: { message: `input asset expired at ${unrelatedSignedUrl}` } },
      }),
      sleep: async () => {},
      now: () => 0,
    }),
    (error) => error.code === 'CLOUD_GENERATION_FAILED'
      && error.message.includes('input asset expired')
      && error.message.includes('[已隐藏媒体地址]')
      && !error.message.includes('https://')
      && !error.message.includes('provider-secret'),
  )
})
