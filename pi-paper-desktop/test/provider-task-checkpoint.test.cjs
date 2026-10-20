const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { runVideoTask } = require('../src/generation-worker.cjs')
const { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID } = require('../src/agnes-model-catalog.cjs')

function providerResponse(payload) {
  const body = Buffer.from(JSON.stringify(payload))
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, resume() {}, async *[Symbol.asyncIterator]() { yield body } }
}

test('submitted cloud tasks resume the original upstream ID after a restart; ambiguous submission cannot retry', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-provider-checkpoint-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    const resolved = path.resolve(parent)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    await fs.rm(resolved, { recursive: true, force: true })
  })
  const opened = await store.createProject(parent, 'Checkpoint Test')
  const { project } = opened
  const node = await store.createNode({ projectId: project.projectId, canvasId: project.canvasId,
    idempotencyKey: 'checkpoint-node', expectedVersion: 0, type: 'video', params: { prompt: 'ocean' } })
  const create = (key) => store.createTask({ projectId: project.projectId, canvasId: project.canvasId,
    canvasVersion: 1, nodeId: node.node.id, modality: 'video', providerType: 'cloud', providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS.video, idempotencyKey: key, parameters: { prompt: 'ocean' } })
  const submitted = await create('submitted-task')
  await store.claimNextTask(project.projectId)
  await store.recordProviderCheckpoint(project.projectId, submitted.taskId, { phase: 'submitting' })
  await store.recordProviderCheckpoint(project.projectId, submitted.taskId, { phase: 'submitted', remoteTaskId: 'upstream-42' })
  await assert.rejects(store.recordProviderCheckpoint(project.projectId, submitted.taskId,
    { phase: 'submitted', remoteTaskId: 'another-task' }), /PROVIDER_CHECKPOINT_CONFLICT/)
  await store.close()
  await store.openProject(opened.directory || opened.projectDirectory || path.join(parent, 'Checkpoint Test'))
  const resumed = await store.claimNextTask(project.projectId)
  assert.equal(resumed.task.taskId, submitted.taskId)
  assert.deepEqual(resumed.providerCheckpoint, { phase: 'submitted', remoteTaskId: 'upstream-42' })
  let creationRequests = 0
  const polledUrls = []
  await runVideoTask({
    taskId: submitted.taskId,
    modality: 'video',
    providerType: 'cloud',
    providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS.video,
    endpoint: AGNES_API_BASE_URL,
    apiKey: 'mock-api-key-not-a-secret-123',
    prompt: 'ocean',
    parameters: {},
    remoteTaskId: resumed.providerCheckpoint.remoteTaskId,
    outputDirectory: resumed.outputDirectory,
  }, {
    checkpoint: async () => assert.fail('restored tasks should only query the upstream ID'),
    postJson: async () => { creationRequests += 1; throw new Error('unexpected task creation') },
    getAgnesResponse: async (url) => {
      polledUrls.push(url)
      return providerResponse({ status: 'completed', url: 'https://media.example-cdn.net/result.mp4' })
    },
    downloadAgnesOutput: async () => `generated/${submitted.taskId}/result.mp4`,
    sleep: async () => undefined,
    now: () => 0,
    pollIntervalMs: 0,
    timeoutMs: 1,
  })
  assert.equal(creationRequests, 0)
  assert.deepEqual(polledUrls, [
    `https://apihub.agnes-ai.com/agnesapi?video_id=upstream-42&model_name=${AGNES_MODELS.video}`,
  ])
  await store.recordTaskFailed(project.projectId, submitted.taskId, 'POLL_FAILED', 'query failed')
  const uncertain = await create('uncertain-task')
  await store.claimNextTask(project.projectId)
  await store.recordProviderCheckpoint(project.projectId, uncertain.taskId, { phase: 'submitting' })
  await store.recordTaskFailed(project.projectId, uncertain.taskId, 'NETWORK_TIMEOUT', 'submission outcome unknown')
  await assert.rejects(store.retryTask(project.projectId, uncertain.taskId), /提交结果待确认/)
})
