const assert = require('node:assert/strict')
const test = require('node:test')

const apiPromise = import('../../pi-main/packages/ai/src/media/official-videos.ts')
const API_KEY = 'ark-video-test-secret'

function input(overrides = {}) {
  return {
    providerId: 'volcengine-ark',
    modelId: 'doubao-seedance-2-5-260628',
    modality: 'video',
    prompt: 'A paper lantern drifts through a rainy street.',
    params: {},
    references: [],
    ...overrides,
  }
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

const publicDns = async () => [{ address: '93.184.216.34' }]

test('Ark submit awaits the submitted checkpoint before the first task poll and returns a URL', async () => {
  const { generateOfficialVideo, ARK_VIDEO_BASE_URL } = await apiPromise
  const calls = []
  const order = []
  const fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body })
    if (init.method === 'POST') {
      order.push('POST')
      return response({ id: 'ark-task-101' }, 202)
    }
    order.push('GET')
    return response({ data: { status: 'succeeded', content: { video_url: { url: 'https://output.example.net/video.mp4?token=signed' } } } })
  }
  const result = await generateOfficialVideo(input(), {
    apiKey: API_KEY,
    baseUrl: ARK_VIDEO_BASE_URL,
    fetch,
    onSubmitting: async () => { order.push('submitting') },
    onSubmitted: async (remoteTaskId) => { order.push(`checkpoint:${remoteTaskId}`) },
    pollIntervalMs: 0,
    resolveReferenceHost: publicDns,
  })

  assert.deepEqual(order, ['submitting', 'POST', 'checkpoint:ark-task-101', 'GET'])
  assert.match(calls[0].url, /\/contents\/generations\/tasks$/u)
  assert.equal(calls[1].url, `${ARK_VIDEO_BASE_URL}/contents/generations/tasks/ark-task-101`)
  assert.equal(calls[0].body.includes(API_KEY), false)
  assert.deepEqual(result, {
    outputs: [{ url: 'https://output.example.net/video.mp4?token=signed', mimeType: 'video/mp4' }],
    remoteTaskId: 'ark-task-101',
    status: 'succeeded',
  })
})

test('a persisted remoteTaskId resumes with GET only and never submits again', async () => {
  const { generateOfficialVideo } = await apiPromise
  const methods = []
  const result = await generateOfficialVideo(input({ remoteTaskId: 'persisted-task-42' }), {
    apiKey: API_KEY,
    fetch: async (_url, init) => {
      methods.push(init.method)
      return response({ data: { status: 'completed', url: 'https://output.example.net/resumed.mp4' } })
    },
    onSubmitted: async () => assert.fail('resume must not call onSubmitted'),
    pollIntervalMs: 0,
    resolveReferenceHost: publicDns,
  })

  assert.deepEqual(methods, ['GET'])
  assert.equal(result.remoteTaskId, 'persisted-task-42')
})

test('default parameters and first/last frame adaptive ratio match Seedance 2.5', async () => {
  const { buildArkVideoRequest } = await apiPromise
  const defaults = buildArkVideoRequest(input())
  assert.equal(defaults.ratio, 'adaptive')
  assert.equal(defaults.resolution, '480p')
  assert.equal(defaults.duration, 15)
  assert.equal(defaults.generate_audio, true)

  const keyframes = buildArkVideoRequest(input({
    params: { ratio: '16:9', duration: 4, firstFrameUrl: 'https://media.example.net/first.png', lastFrameUrl: 'https://media.example.net/last.png' },
  }))
  assert.equal(keyframes.ratio, 'adaptive')
  assert.equal(keyframes.duration, 4)
  assert.deepEqual(keyframes.content.slice(1).map((item) => item.role), ['first_frame', 'last_frame'])
})

test('invalid video parameters do not mark a submission; checkpoint failure prevents POST', async () => {
  const { generateOfficialVideo } = await apiPromise
  let submitting = 0
  let requests = 0
  const options = { apiKey: API_KEY,
    fetch: async () => { requests += 1; return response({}) },
    onSubmitting: async () => { submitting += 1; throw new Error('checkpoint unavailable') },
    onSubmitted: async () => undefined,
  }
  await assert.rejects(generateOfficialVideo(input({ params: { duration: 31 } }), options))
  assert.equal(submitting, 0)
  await assert.rejects(generateOfficialVideo(input(), options), /checkpoint unavailable/)
  assert.equal(submitting, 1)
  assert.equal(requests, 0)
})

test('local or private Ark media references are rejected before any API request', async () => {
  const { generateOfficialVideo } = await apiPromise
  let requests = 0
  await assert.rejects(generateOfficialVideo(input({
    references: [{ type: 'video', url: 'https://127.0.0.1/private.mp4', role: 'reference_video' }],
  }), {
    apiKey: API_KEY,
    fetch: async () => { requests += 1; return response({}) },
    onSubmitted: async () => undefined,
    onSubmitting: async () => assert.fail('private reference cannot mark submitting'),
    resolveReferenceHost: publicDns,
  }), { code: 'INVALID_MEDIA_REFERENCE' })
  assert.equal(requests, 0)
})

test('provider errors redact API keys and signed reference URLs', async () => {
  const { generateOfficialVideo } = await apiPromise
  const signedReference = 'https://media.example.net/reference.mp4?sig=reference-secret'
  await assert.rejects(generateOfficialVideo(input({
    references: [{ type: 'video', url: signedReference, role: 'reference_video' }],
  }), {
    apiKey: API_KEY,
    fetch: async (_url, init) => init.method === 'POST'
      ? response({ id: 'failed-task' }, 202)
      : response({ error: { message: `rejected ${signedReference} Bearer ${API_KEY}` } }, 401),
    onSubmitted: async () => undefined,
    onSubmitting: async () => undefined,
    pollIntervalMs: 0,
    resolveReferenceHost: publicDns,
  }), (error) => {
    assert.equal(error.code, 'PROVIDER_HTTP_ERROR')
    assert.equal(error.message.includes(API_KEY), false)
    assert.equal(error.message.includes(signedReference), false)
    assert.match(error.message, /\[redacted reference URL\]/u)
    return true
  })
})
