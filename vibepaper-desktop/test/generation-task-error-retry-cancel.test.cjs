const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { runImageTask, postJson } = require('../src/generation-worker.cjs')
const { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID } = require('../src/agnes-model-catalog.cjs')

test('provider error details reach the task linked to its canvas node; failed tasks retry and running tasks cancel cleanly', async (t) => {
  const apiKey = 'mock-api-key-not-a-secret'
  const server = http.createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'image dimensions are unsupported' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const providerEndpoint = `http://127.0.0.1:${server.address().port}/images/generations`

  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-generation-task-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const opened = await store.createProject(parentDirectory, 'Generation Error Test')
  const { project } = opened
  const createdNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'generation-error-image-node',
    expectedVersion: 0,
    type: 'image',
    params: { prompt: 'rainy street image' },
  })

  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 1,
    nodeId: createdNode.node.id,
    modality: 'image',
    providerType: 'cloud',
    providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS.image,
    idempotencyKey: 'generation-error-task',
    parameters: { prompt: 'rainy street image' },
  })
  const claimed = await store.claimNextTask(project.projectId)
  assert.equal(claimed.task.taskId, task.taskId)

  let providerError
  await assert.rejects(runImageTask({
    taskId: task.taskId,
    modality: 'image',
    providerType: 'cloud',
    providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS.image,
    endpoint: AGNES_API_BASE_URL,
    apiKey,
    prompt: 'rainy street image',
    parameters: {},
    outputDirectory: claimed.outputDirectory,
  }, {
    postJson: (_endpoint, payload, credential, timeoutMs) => postJson(providerEndpoint, payload, credential, timeoutMs),
  }), (error) => {
    providerError = error
    return error.code === 'CLOUD_REQUEST_FAILED' && /image dimensions are unsupported/u.test(error.message)
  })

  await store.recordTaskFailed(project.projectId, task.taskId, providerError.code, providerError.message)
  const failed = await store.getTask(project.projectId, task.taskId)
  assert.equal(failed.nodeId, createdNode.node.id)
  assert.equal(failed.errorCode, 'CLOUD_REQUEST_FAILED')
  assert.match(failed.errorMessage, /image dimensions are unsupported/u)
  assert.equal(failed.errorMessage.includes(apiKey), false)
  const canvas = await store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(canvas.nodes.some((node) => node.id === createdNode.node.id), true)

  const retried = await store.retryTask(project.projectId, task.taskId)
  assert.equal(retried.taskId, task.taskId)
  assert.equal(retried.status, 'queued')
  assert.equal(retried.errorMessage, null)
  assert.equal((await store.retryTask(project.projectId, task.taskId)).status, 'queued')

  const retriedClaim = await store.claimNextTask(project.projectId)
  assert.equal(retriedClaim.task.taskId, task.taskId)
  await fs.writeFile(path.join(retriedClaim.outputDirectory, 'partial.png'), Buffer.from('partial output'))
  const cancelled = await store.cancelTask(project.projectId, task.taskId)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(await store.cleanupCancelledTaskOutput(project.projectId, task.taskId), true)
  await assert.rejects(fs.stat(retriedClaim.outputDirectory), { code: 'ENOENT' })
  await assert.rejects(store.retryTask(project.projectId, task.taskId), /不可重试/u)
})

test('image task persists up to four indexed outputs and resolves each output for node previews', async (t) => {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-generation-image-count-'))
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-generation-image-backup-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
    await fs.rm(backupParent, { recursive: true, force: true })
  })
  const { project } = await store.createProject(parentDirectory, 'Image Count Test')
  const { node } = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'image-count-node',
    expectedVersion: 0,
    type: 'image',
    params: { prompt: 'four images' },
  })
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 1,
    nodeId: node.id,
    modality: 'image',
    providerType: 'cloud',
    providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS.image,
    idempotencyKey: 'image-count-task',
    parameters: { prompt: 'four images', count: 3 },
  })
  const claimed = await store.claimNextTask(project.projectId)
  const outputPaths = ['result.png', 'result-1.png', 'result-2.png']
    .map((fileName) => `generated/${task.taskId}/${fileName}`)
  for (let index = 0; index < outputPaths.length; index += 1) {
    await fs.writeFile(path.join(claimed.outputDirectory, path.basename(outputPaths[index])), Buffer.from([0x89, 0x50, 0x4e, 0x47, index + 1]))
  }

  const succeeded = await store.recordTaskSucceeded(project.projectId, task.taskId, outputPaths[0], null, outputPaths)
  assert.equal(succeeded.status, 'succeeded')
  assert.deepEqual(succeeded.outputs.map((output) => output.index), [0, 1, 2])
  assert.deepEqual(succeeded.outputs.map((output) => output.outputPath), outputPaths)

  const second = await store.resolveTaskOutputForPreview(project.projectId, task.taskId, 1)
  assert.equal(second.filePath, path.join(claimed.outputDirectory, 'result-1.png'))
  assert.equal(second.mimeType, 'image/png')
  await assert.rejects(store.resolveTaskOutputForPreview(project.projectId, task.taskId, 3), /没有此序号/u)

  const backup = await store.backupProject(backupParent, project.projectId)
  const restored = await store.restoreBackup(backup.directory, backupParent)
  const restoredTask = await store.getTask(restored.project.projectId, task.taskId)
  assert.deepEqual(restoredTask.outputs.map((output) => output.outputPath), outputPaths)
  const restoredSecond = await store.resolveTaskOutputForPreview(restored.project.projectId, task.taskId, 1)
  assert.equal(restoredSecond.filePath, path.join(restored.directory, '.vibepaper', outputPaths[1]))
})

test('schema v11 project backups restore and migrate legacy task output into the indexed output table', async (t) => {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-generation-v11-project-'))
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-generation-v11-backup-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
    await fs.rm(backupParent, { recursive: true, force: true })
  })

  const { project } = await store.createProject(parentDirectory, 'Version 11 Restore Test')
  const { node } = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'v11-output-node',
    expectedVersion: 0,
    type: 'image',
    params: { prompt: 'legacy output' },
  })
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 1,
    nodeId: node.id,
    modality: 'image',
    providerType: 'cloud',
    providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS.image,
    idempotencyKey: 'v11-output-task',
    parameters: { prompt: 'legacy output', count: 1 },
  })
  const claimed = await store.claimNextTask(project.projectId)
  const outputPath = `generated/${task.taskId}/result.png`
  await fs.writeFile(path.join(claimed.outputDirectory, 'result.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
  await store.recordTaskSucceeded(project.projectId, task.taskId, outputPath, null, [outputPath])

  const backup = await store.backupProject(backupParent, project.projectId)
  const backupDataDirectory = path.join(backup.directory, '.vibepaper')
  const backupDatabasePath = path.join(backupDataDirectory, 'project.sqlite')
  const legacyDatabase = new DatabaseSync(backupDatabasePath)
  try {
    legacyDatabase.exec('DROP TABLE task_outputs; PRAGMA user_version = 11;')
  } finally {
    legacyDatabase.close()
  }
  const manifestPath = path.join(backupDataDirectory, 'backup-manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const legacyDatabaseBytes = await fs.readFile(backupDatabasePath)
  const databaseManifestEntry = manifest.files.find((entry) => entry.path === 'project.sqlite')
  assert.ok(databaseManifestEntry)
  databaseManifestEntry.sha256 = crypto.createHash('sha256').update(legacyDatabaseBytes).digest('hex')
  databaseManifestEntry.sizeBytes = legacyDatabaseBytes.byteLength
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const restored = await store.restoreBackup(backup.directory, backupParent)
  const restoredTask = await store.getTask(restored.project.projectId, task.taskId)
  assert.deepEqual(restoredTask.outputs.map((output) => output.outputPath), [outputPath])
  assert.deepEqual(restoredTask.outputs.map((output) => output.index), [0])
  const restoredDatabase = new DatabaseSync(path.join(restored.directory, '.vibepaper', 'project.sqlite'))
  try {
    assert.equal(restoredDatabase.prepare('PRAGMA user_version').get().user_version, 15)
    assert.equal(restoredDatabase.prepare('SELECT COUNT(*) AS count FROM task_outputs WHERE task_id = ?').get(task.taskId).count, 1)
  } finally {
    restoredDatabase.close()
  }
  const restoredPreview = await store.resolveTaskOutputForPreview(restored.project.projectId, task.taskId, 0)
  assert.equal(restoredPreview.filePath, path.join(restored.directory, '.vibepaper', outputPath))
})

test('restart-interrupted local tasks can retry, while cloud tasks require provider-state reconciliation', async (t) => {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-interrupted-task-'))
  let store = createLocalProjectStore()
  t.after(async () => {
    await store?.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const opened = await store.createProject(parentDirectory, 'Interrupted Task Test')
  const { project } = opened
  const { node } = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'interrupted-task-node',
    expectedVersion: 0,
    type: 'text',
    params: { prompt: 'resume task' },
  })
  const common = {
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 1,
    nodeId: node.id,
    modality: 'text',
    modelId: 'local-text-model',
    parameters: { prompt: 'resume task' },
  }
  const localTask = await store.createTask({
    ...common,
    providerType: 'local',
    providerId: 'openai-compatible-local',
    idempotencyKey: 'interrupted-local-task',
  })
  const cloudTask = await store.createTask({
    ...common,
    providerType: 'cloud',
    providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS.text,
    idempotencyKey: 'interrupted-cloud-task',
  })
  await store.close()

  const database = new DatabaseSync(path.join(opened.directory, '.vibepaper', 'project.sqlite'))
  try {
    database.prepare("UPDATE tasks SET status = 'interrupted', error_code = 'PROCESS_INTERRUPTED' WHERE task_id IN (?, ?)")
      .run(localTask.taskId, cloudTask.taskId)
  } finally {
    database.close()
  }
  store = createLocalProjectStore()
  await store.openProject(opened.directory, project)

  const retried = await store.retryTask(project.projectId, localTask.taskId)
  assert.equal(retried.status, 'queued')
  assert.equal(retried.errorCode, null)
  await assert.rejects(store.retryTask(project.projectId, cloudTask.taskId), /结果未知.*自动重试/u)
  assert.equal((await store.getTask(project.projectId, cloudTask.taskId)).status, 'interrupted')
})
