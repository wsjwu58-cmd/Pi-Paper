const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  AGENT_CORE_METHODS,
  ALLOWED_AGENT_CORE_METHODS,
  createAgentLocalToolClient,
} = require('../src/agent-local-tools.cjs')
const {
  buildDesktopAgentModelDirectory,
  isDesktopAgentGenerationTarget,
} = require('../src/agent-model-directory.cjs')
const {
  buildAgentCanvasContext,
  getAgentCanvasNodeReferences,
} = require('../src/agent-canvas-context.cjs')

class FakeParentPort extends EventEmitter {
  postMessage(message) {
    this.lastRequest = message
    queueMicrotask(() => this.emit('message', {
      data: {
        kind: 'agent-local-core-response',
        requestId: message.requestId,
        ok: true,
        result: { canvasId: 'canvas-1', version: 4 },
      },
    }))
  }
}

test('Main and Worker share the restricted agent:core method allowlist', () => {
  assert.deepEqual(AGENT_CORE_METHODS, [
    'agent:core:load-canvas',
    'agent:core:create-node',
    'agent:core:update-node',
    'agent:core:connect-edge',
    'agent:core:save-canvas',
    'agent:core:get-task',
    'agent:core:list-assets',
    'agent:core:list-models',
    'agent:core:create-generation-task',
  ])
  assert.equal(ALLOWED_AGENT_CORE_METHODS.size, AGENT_CORE_METHODS.length)

  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8')
  assert.match(mainSource, /require\('\.\/agent-local-tools\.cjs'\)/u)
  assert.match(mainSource, /ALLOWED_AGENT_CORE_METHODS\.has\(method\)/u)
  assert.match(mainSource, /buildDesktopAgentModelDirectory\(agnes, localTextModel, getLocalAudioModel\(\)\)/u)
  assert.match(mainSource, /isDesktopAgentGenerationTarget\(targetNode, input\.modality\)/u)
})

test('Worker client correlates Main responses and rejects retired CJS tool methods', async () => {
  const parentPort = new FakeParentPort()
  const client = createAgentLocalToolClient(parentPort)

  await assert.doesNotReject(async () => {
    assert.deepEqual(await client.request('agent:core:load-canvas', { projectId: 'project-1', canvasId: 'canvas-1' }), {
      canvasId: 'canvas-1', version: 4,
    })
  })
  assert.equal(parentPort.lastRequest.kind, 'agent-local-core-request')
  assert.equal(parentPort.lastRequest.method, 'agent:core:load-canvas')
  assert.deepEqual(parentPort.lastRequest.payload, { projectId: 'project-1', canvasId: 'canvas-1' })

  await assert.rejects(client.request('agent:local-tool:get-canvas-summary', {}), /AGENT_LOCAL_CORE_METHOD_UNSUPPORTED/u)
  await assert.rejects(client.request('agent:core:delete-project', {}), /AGENT_LOCAL_CORE_METHOD_UNSUPPORTED/u)
  client.close()
  await assert.rejects(client.request('agent:core:load-canvas', {}), /AGENT_LOCAL_CORE_CLIENT_CLOSED/u)
})

test('Worker client preserves Local Core error codes and times out pending RPC', async () => {
  class ManualParentPort extends EventEmitter {
    postMessage(message) { this.lastRequest = message }
  }
  const parentPort = new ManualParentPort()
  const client = createAgentLocalToolClient(parentPort, 20)

  const failed = client.request('agent:core:load-canvas', {})
  parentPort.emit('message', {
    data: { kind: 'agent-local-core-response', requestId: parentPort.lastRequest.requestId, ok: false, errorCode: 'AGENT_PROJECT_CHANGED' },
  })
  await assert.rejects(failed, /AGENT_PROJECT_CHANGED/u)
  await assert.rejects(client.request('agent:core:load-canvas', {}, 1), /AGENT_LOCAL_CORE_TIMEOUT/u)
  client.close()
})

test('model directory returns capability metadata without credentials or local endpoints', () => {
  const models = buildDesktopAgentModelDirectory(
    { apiKeyConfigured: true, apiKey: 'cloud-secret' },
    { modelId: 'local-text-model', endpoint: 'http://127.0.0.1/private', apiKey: 'local-secret' },
    { modelId: 'local-sapi-tts', providerId: 'local-sapi-tts', available: true },
  )
  const serialized = JSON.stringify(models)

  assert.equal(models.length, 5)
  assert.equal(models.find((model) => model.providerType === 'local').name, 'local-text-model')
  assert.deepEqual(models.find((model) => model.modelType === 'audio'), {
    name: 'local-sapi-tts',
    displayName: 'Windows SAPI 语音合成',
    modelType: 'audio',
    providerId: 'local-sapi-tts',
    providerType: 'local',
    enabled: true,
    modalities: ['audio'],
    inputModes: ['text'],
    toolCalling: false,
    streaming: false,
    cancellation: false,
  })
  assert.doesNotMatch(serialized, /secret|127\.0\.0\.1|endpoint/u)
  assert.equal(buildDesktopAgentModelDirectory({ apiKeyConfigured: false }, null)[0].enabled, false)

  const unavailable = buildDesktopAgentModelDirectory(null, null, {
    modelId: 'local-sapi-tts',
    providerId: 'local-sapi-tts',
    available: false,
    unavailableReason: 'local-sapi-tts 仅支持 Windows。',
  }).find((model) => model.modelType === 'audio')
  assert.equal(unavailable.enabled, false)
  assert.match(unavailable.unavailableReason, /Windows/u)
})

test('Agent generation targets must match the requested modality', () => {
  assert.equal(isDesktopAgentGenerationTarget({ id: 'audio-1', type: 'audio' }, 'audio'), true)
  assert.equal(isDesktopAgentGenerationTarget({ id: 'image-1', type: 'image' }, 'audio'), false)
  assert.equal(isDesktopAgentGenerationTarget({ id: 'text-1', type: 'text' }, 'audio'), false)
  assert.equal(isDesktopAgentGenerationTarget({ id: 'audio-1', type: 'audio' }, 'image'), false)
})

test('Agent canvas context labels audio nodes and retains their typed references', () => {
  const audioNode = {
    id: 'a12b3456-c789-4abc-8def-1234567890ab',
    type: 'audio',
    data: { name: '旁白' },
  }
  const canvas = { nodes: [audioNode], edges: [] }

  assert.match(buildAgentCanvasContext(canvas), /节点 1（音频）：音频名称：旁白/u)
  assert.deepEqual(getAgentCanvasNodeReferences(canvas), [
    { nodeId: audioNode.id, nodeOrdinal: 1, type: 'audio' },
  ])
})
