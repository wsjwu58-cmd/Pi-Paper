const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')

const imageSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function createImageTask(store, project, suffix, outputCount = 1) {
  const canvas = await store.loadCanvas(project.projectId, project.canvasId)
  const created = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: `mcp-output-node-${suffix}`,
    expectedVersion: canvas.version,
    type: 'image',
    params: { prompt: 'fixture output' },
  })
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: created.version,
    nodeId: created.node.id,
    modality: 'image',
    providerType: 'cloud',
    providerId: 'agnes',
    modelId: 'agnes-image-fixture',
    idempotencyKey: `mcp-output-task-${suffix}`,
    parameters: { prompt: 'fixture output', count: outputCount },
  })
  const claimed = await store.claimNextTask(project.projectId)
  const outputPaths = Array.from({ length: outputCount }, (_unused, index) =>
    `generated/${task.taskId}/result${index ? `-${index}` : ''}.png`)
  return { task, claimed, outputPaths }
}

test('Local Core returns only the selected bounded image output from the active project', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-mcp-output-store-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  const { project } = await store.createProject(root, 'MCP output store fixture')
  const { task, claimed, outputPaths } = await createImageTask(store, project, 'indexed', 2)
  const first = Buffer.concat([imageSignature, Buffer.from([1, 2, 3])])
  const second = Buffer.concat([imageSignature, Buffer.from([4, 5, 6])])
  await fs.writeFile(path.join(claimed.outputDirectory, path.basename(outputPaths[0])), first)
  await fs.writeFile(path.join(claimed.outputDirectory, path.basename(outputPaths[1])), second)
  await store.recordTaskSucceeded(project.projectId, task.taskId, outputPaths[0], null, outputPaths)

  const selected = await store.readTaskOutputMedia(project.projectId, task.taskId, 1)
  assert.deepEqual(selected.bytes, second)
  assert.equal(selected.mimeType, 'image/png')
  assert.equal(selected.modality, 'image')
  assert.equal(selected.outputIndex, 1)
  assert.equal(selected.sizeBytes, second.length)
  selected.bytes.fill(0)

  await assert.rejects(store.readTaskOutputMedia('another-project', task.taskId, 1),
    (error) => error.code === 'PROJECT_CHANGED')
  await assert.rejects(store.readTaskOutputMedia(project.projectId, '../outside', 0),
    (error) => error.code === 'INVALID_INPUT')
  await assert.rejects(store.readTaskOutputMedia(project.projectId, task.taskId, 4),
    (error) => error.code === 'INVALID_INPUT')

  const queued = await createImageTask(store, project, 'queued')
  await assert.rejects(store.readTaskOutputMedia(project.projectId, queued.task.taskId, 0),
    (error) => error.code === 'TASK_NOT_FOUND')
})

test('Local Core rejects MCP outputs above the image cap before reading bytes and rejects MIME mismatch', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-mcp-output-limits-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  const { project } = await store.createProject(root, 'MCP output limit fixture')
  const large = await createImageTask(store, project, 'large')
  const oversizedBytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x44)
  imageSignature.copy(oversizedBytes)
  await fs.writeFile(path.join(large.claimed.outputDirectory, path.basename(large.outputPaths[0])), oversizedBytes)
  await store.recordTaskSucceeded(project.projectId, large.task.taskId, large.outputPaths[0])
  await assert.rejects(store.readTaskOutputMedia(project.projectId, large.task.taskId, 0),
    (error) => error.code === 'OUTPUT_TOO_LARGE')

  const videoCanvas = await store.loadCanvas(project.projectId, project.canvasId)
  const videoNode = await store.createNode({ projectId: project.projectId, canvasId: project.canvasId,
    idempotencyKey: 'mcp-output-node-large-video', expectedVersion: videoCanvas.version,
    type: 'video', params: { prompt: 'large video fixture' } })
  const videoTask = await store.createTask({ projectId: project.projectId, canvasId: project.canvasId,
    canvasVersion: videoNode.version, nodeId: videoNode.node.id, modality: 'video', providerType: 'cloud',
    providerId: 'agnes', modelId: 'agnes-video-fixture', idempotencyKey: 'mcp-output-task-large-video',
    parameters: { prompt: 'large video fixture' } })
  const videoClaim = await store.claimNextTask(project.projectId)
  const videoPath = `generated/${videoTask.taskId}/result.mp4`
  const oversizedVideo = Buffer.alloc(8 * 1024 * 1024 + 1, 0x55)
  oversizedVideo.writeUInt32BE(24, 0)
  oversizedVideo.write('ftyp', 4, 'ascii')
  oversizedVideo.write('isom', 8, 'ascii')
  await fs.writeFile(path.join(videoClaim.outputDirectory, 'result.mp4'), oversizedVideo)
  await store.recordTaskSucceeded(project.projectId, videoTask.taskId, videoPath)
  await assert.rejects(store.readTaskOutputMedia(project.projectId, videoTask.taskId, 0),
    (error) => error.code === 'OUTPUT_TOO_LARGE')

  const mismatch = await createImageTask(store, project, 'mime-mismatch')
  const wrongBytes = Buffer.from('not a PNG payload')
  await fs.writeFile(path.join(mismatch.claimed.outputDirectory, path.basename(mismatch.outputPaths[0])), wrongBytes)
  await store.recordTaskSucceeded(project.projectId, mismatch.task.taskId, mismatch.outputPaths[0])
  await assert.rejects(store.readTaskOutputMedia(project.projectId, mismatch.task.taskId, 0),
    (error) => error.code === 'OUTPUT_MIME_MISMATCH')
})

test('Local Core rejects task output directories replaced with a junction', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-mcp-output-junction-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  const { project } = await store.createProject(root, 'MCP output junction fixture')
  const { task, claimed, outputPaths } = await createImageTask(store, project, 'junction')
  await fs.writeFile(path.join(claimed.outputDirectory, path.basename(outputPaths[0])),
    Buffer.concat([imageSignature, Buffer.from([1])]))
  await store.recordTaskSucceeded(project.projectId, task.taskId, outputPaths[0])

  const taskDirectory = claimed.outputDirectory
  const movedDirectory = `${taskDirectory}-moved`
  await fs.rename(taskDirectory, movedDirectory)
  try {
    await fs.symlink(movedDirectory, taskDirectory, 'junction')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      await fs.rename(movedDirectory, taskDirectory)
      t.skip(`Windows junction creation is unavailable: ${error.code}`)
      return
    }
    throw error
  }

  await assert.rejects(store.readTaskOutputMedia(project.projectId, task.taskId, 0),
    (error) => error.code === 'TASK_OUTPUT_UNAVAILABLE')
})
