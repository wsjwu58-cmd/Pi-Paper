const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')

test('video frame extraction stores an image output with operation-aware preview and backup validation', async (t) => {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-frame-task-'))
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-frame-backup-'))
  const restoreParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-frame-restore-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
    await fs.rm(backupParent, { recursive: true, force: true })
    await fs.rm(restoreParent, { recursive: true, force: true })
  })

  const { project } = await store.createProject(parentDirectory, 'Frame Extraction Test')
  const created = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'frame-extraction-node',
    expectedVersion: 0,
    type: 'video',
    params: {},
  })
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: created.version,
    nodeId: created.node.id,
    modality: 'video',
    providerType: 'local',
    providerId: 'local-media-tools',
    modelId: 'ffmpeg-media-1',
    idempotencyKey: 'frame-extraction-task',
    parameters: { operation: '提帧', sourceUrl: 'vibe://app/tasks/00000000-0000-4000-8000-000000000001/output', frameAt: 1 },
  })
  const claimed = await store.claimNextTask(project.projectId)
  assert.equal(claimed.task.taskId, task.taskId)
  const relativeOutput = `generated/${task.taskId}/frame.jpg`
  await fs.writeFile(path.join(claimed.outputDirectory, 'frame.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))

  await assert.rejects(
    store.recordTaskSucceeded(project.projectId, task.taskId, relativeOutput),
    /LOCAL_MEDIA_OUTPUT_METADATA_INVALID/u,
  )
  const succeeded = await store.recordTaskSucceeded(project.projectId, task.taskId, relativeOutput, {
    index: 0,
    operation: '提帧',
    outputType: 'image',
  })
  assert.deepEqual(succeeded.outputMeta, { index: 0, operation: '提帧', outputType: 'image' })
  assert.deepEqual(succeeded.outputs[0].outputMeta, { index: 0, operation: '提帧', outputType: 'image' })

  const preview = await store.resolveTaskOutputForPreview(project.projectId, task.taskId)
  assert.equal(preview.mimeType, 'image/jpeg')
  assert.equal(path.basename(preview.filePath), 'frame.jpg')

  const backup = await store.backupProject(backupParent, project.projectId)
  assert.ok(await fs.stat(path.join(backup.directory, '.vibepaper', relativeOutput)))
  const restored = await store.restoreBackup(backup.directory, restoreParent)
  const restoredTask = await store.getTask(restored.project.projectId, task.taskId)
  assert.deepEqual(restoredTask.outputMeta, { index: 0, operation: '提帧', outputType: 'image' })
  const restoredPreview = await store.resolveTaskOutputForPreview(restored.project.projectId, task.taskId)
  assert.equal(restoredPreview.mimeType, 'image/jpeg')
  assert.equal(path.basename(restoredPreview.filePath), 'frame.jpg')
})

test('video frame operation cannot claim a video output format or a mismatched output kind', async (t) => {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-frame-validation-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const { project } = await store.createProject(parentDirectory, 'Frame Validation Test')
  const created = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'frame-validation-node',
    expectedVersion: 0,
    type: 'video',
    params: {},
  })
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: created.version,
    nodeId: created.node.id,
    modality: 'video',
    providerType: 'local',
    providerId: 'local-media-tools',
    modelId: 'ffmpeg-media-1',
    idempotencyKey: 'frame-validation-task',
    parameters: { operation: '提帧', sourceUrl: 'vibe://app/tasks/00000000-0000-4000-8000-000000000001/output', frameAt: 1 },
  })
  const claimed = await store.claimNextTask(project.projectId)
  await fs.writeFile(path.join(claimed.outputDirectory, 'wrong.mp4'), Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))
  await assert.rejects(
    store.recordTaskSucceeded(project.projectId, task.taskId, `generated/${task.taskId}/wrong.mp4`, {
      index: 0, operation: '提帧', outputType: 'image',
    }),
    /生成结果文件格式与任务模态不匹配/u,
  )
  await fs.writeFile(path.join(claimed.outputDirectory, 'frame.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  await assert.rejects(
    store.recordTaskSucceeded(project.projectId, task.taskId, `generated/${task.taskId}/frame.jpg`, {
      index: 0, operation: '提帧', outputType: 'video',
    }),
    /LOCAL_MEDIA_OUTPUT_METADATA_INVALID/u,
  )
})
