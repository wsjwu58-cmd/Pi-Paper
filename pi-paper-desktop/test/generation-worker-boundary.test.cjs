const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const test = require('node:test')
const { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID } = require('../src/agnes-model-catalog.cjs')
const { ARK_MODELS, ARK_PROVIDER_ID } = require('../src/ark-model-catalog.cjs')

const TASK_ID = '99999999-9999-4999-8999-999999999999'
const API_KEY = 'boundary-test-key-not-a-secret'

class TestParentPort extends EventEmitter {
  postMessage(message) {
    this.emit('outgoing', message)
  }
}

function createWorkerHarness() {
  const workerPath = path.join(__dirname, '..', 'src', 'generation-worker.cjs')
  const workerRequire = createRequire(workerPath)
  const parentPort = new TestParentPort()
  const calls = { posts: [], polls: [] }

  const https = {
    request(rawUrl, _options, onResponse) {
      const url = new URL(rawUrl)
      calls.posts.push(url.toString())
      const request = new EventEmitter()
      request.end = () => {
        const response = new EventEmitter()
        response.statusCode = 202
        const payload = url.pathname.endsWith('/images/generations')
          ? { data: [{ url: 'https://media.example-cdn.net/should-not-download.png' }] }
          : url.pathname.endsWith('/videos')
            ? { video_id: 'agnes-boundary-task' }
            : { id: 'ark-boundary-task' }
        queueMicrotask(() => {
          onResponse(response)
          response.emit('data', Buffer.from(JSON.stringify(payload)))
          response.emit('end')
        })
      }
      request.destroy = (error) => { if (error) queueMicrotask(() => request.emit('error', error)) }
      return request
    },
    get(rawUrl) {
      calls.polls.push(new URL(rawUrl).toString())
      const request = new EventEmitter()
      request.destroy = (error) => { if (error) queueMicrotask(() => request.emit('error', error)) }
      queueMicrotask(() => request.emit('error', new Error('network disabled in test harness')))
      return request
    },
  }
  const dns = { promises: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] } }
  const localRequire = (id) => {
    if (id === './worker-network.cjs') return { initializeWorkerProxy: () => false }
    if (id === 'node:https') return https
    if (id === 'node:dns') return dns
    return workerRequire(id)
  }
  const workerProcess = new Proxy(process, {
    get(target, property) {
      return property === 'parentPort' ? parentPort : Reflect.get(target, property, target)
    },
  })
  const workerModule = { exports: {} }
  const source = fs.readFileSync(workerPath, 'utf8')
  const fastWorkerTimer = (callback, milliseconds, ...args) => setTimeout(callback, milliseconds >= 30_000 ? milliseconds : 0, ...args)
  const evaluateWorker = new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', 'Buffer', 'setTimeout', 'clearTimeout', source)
  evaluateWorker(localRequire, workerModule, workerModule.exports, workerPath, path.dirname(workerPath), workerProcess,
    Buffer, fastWorkerTimer, clearTimeout)
  return { parentPort, calls }
}

function sendWorkerRequest(parentPort, request, acknowledge) {
  const messages = []
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      parentPort.off('outgoing', receive)
      reject(new Error('worker request timed out'))
    }, 2_000)
    function receive(message) {
      messages.push(message)
      if (message.type === 'provider-checkpoint') {
        queueMicrotask(() => parentPort.emit('message', {
          type: 'provider-checkpoint-ack',
          sequence: message.sequence,
          ok: acknowledge(message.checkpoint),
        }))
        return
      }
      if (message.id === request.id) {
        clearTimeout(timeout)
        parentPort.off('outgoing', receive)
        resolve({ response: message, messages })
      }
    }
    parentPort.on('outgoing', receive)
    parentPort.emit('message', request)
  })
}

function taskPayload(providerId, modelId, modality, endpoint) {
  return {
    taskId: TASK_ID,
    modality,
    providerType: 'cloud',
    providerId,
    modelId,
    endpoint,
    apiKey: API_KEY,
    prompt: 'checkpoint boundary test',
    parameters: {},
    outputDirectory: path.join('test-project', '.vibepaper', 'generated', TASK_ID),
  }
}

test('worker parentPort routes honor checkpoint acknowledgments for legacy media without network access', async () => {
  const worker = createWorkerHarness()

  const image = await sendWorkerRequest(worker.parentPort, {
    id: 901,
    method: 'generate:image',
    payload: taskPayload(AGNES_PROVIDER_ID, AGNES_MODELS.image, 'image', AGNES_API_BASE_URL),
  }, () => false)
  assert.equal(image.response.errorCode, 'TASK_CHECKPOINT_FAILED')
  assert.deepEqual(image.messages.filter((message) => message.type === 'provider-checkpoint').map((message) => message.checkpoint), [
    { phase: 'submitting' },
  ])

  const agnesVideo = await sendWorkerRequest(worker.parentPort, {
    id: 902,
    method: 'generate:video',
    payload: taskPayload(AGNES_PROVIDER_ID, AGNES_MODELS.video, 'video', AGNES_API_BASE_URL),
  }, (checkpoint) => checkpoint.phase !== 'submitted')
  assert.equal(agnesVideo.response.errorCode, 'TASK_CHECKPOINT_FAILED')
  assert.deepEqual(agnesVideo.messages.filter((message) => message.type === 'provider-checkpoint').map((message) => message.checkpoint), [
    { phase: 'submitting' },
    { phase: 'submitted', remoteTaskId: 'agnes-boundary-task' },
  ])

  const arkVideo = await sendWorkerRequest(worker.parentPort, {
    id: 903,
    method: 'generate:video',
    payload: taskPayload(ARK_PROVIDER_ID, ARK_MODELS.video, 'video'),
  }, (checkpoint) => checkpoint.phase !== 'submitted')
  assert.equal(arkVideo.response.errorCode, 'TASK_CHECKPOINT_FAILED')
  assert.deepEqual(arkVideo.messages.filter((message) => message.type === 'provider-checkpoint').map((message) => message.checkpoint), [
    { phase: 'submitting' },
    { phase: 'submitted', remoteTaskId: 'ark-boundary-task' },
  ])

  assert.equal(worker.calls.posts.length, 2, 'image is blocked before POST; each video submits once')
  assert.equal(worker.calls.polls.length, 0, 'negative submitted ACK must stop both video status queries')
})
