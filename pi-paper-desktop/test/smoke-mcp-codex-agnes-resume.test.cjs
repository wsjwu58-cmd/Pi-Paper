'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  classifyResumeMediaSnapshot,
  createAcceptanceMediaSubmissionGuard,
  describeResumeMediaProjectPath,
  isAcceptanceHarnessEntry,
  assertAcceptanceModeCompatibility,
  isVideoOnlyChainAccepted,
  validateResumeMediaProjectPath,
} = require('../scripts/smoke-mcp-codex-agnes.cjs')

function validImageSnapshot({ videoTask = null, extraNodes = [], imageStatus = 'succeeded' } = {}) {
  const imageTask = {
    taskId: 'task-image-1', modality: 'image', nodeId: 'image-1', status: imageStatus,
    outputs: [{ sha256: 'a'.repeat(64), sizeBytes: 868764 }],
  }
  const nodes = [
    { id: 'text-1', type: 'text' },
    { id: 'image-1', type: 'image' },
    ...extraNodes,
  ]
  const edges = [{ sourceNodeId: 'text-1', targetNodeId: 'image-1' }]
  const tasks = [imageTask]
  if (videoTask) {
    nodes.push({ id: videoTask.nodeId, type: 'video' })
    tasks.push(videoTask)
  }
  return { canvas: { nodes, edges }, tasks }
}

test('resume path accepts only a direct project child in a named acceptance run', () => {
  const workspace = path.join(os.tmpdir(), 'resume-workspace')
  const project = path.join(workspace, '.test-temp', 'mcp-codex-agnes-run-123', 'project', 'source-project')
  const accepted = describeResumeMediaProjectPath(project, workspace)
  assert.equal(accepted.projectDirectory, path.resolve(project))
  assert.equal(accepted.sourceRunName, 'mcp-codex-agnes-run-123')
  assert.equal(describeResumeMediaProjectPath(path.dirname(project), workspace), null)
  assert.equal(describeResumeMediaProjectPath(path.join(project, 'nested'), workspace), null)
  assert.equal(describeResumeMediaProjectPath(path.join(workspace, 'outside'), workspace), null)
})

test('harness dispatch recognizes Electron browser worker entry but keeps imports inert', () => {
  assert.equal(isAcceptanceHarnessEntry(false, { versions: { electron: '44.4.4' }, type: 'browser' }, ['electron', '--worker']), true)
  assert.equal(isAcceptanceHarnessEntry(false, { versions: { electron: '44.4.4' }, type: 'renderer' }, ['electron', '--worker']), false)
  assert.equal(isAcceptanceHarnessEntry(false, { versions: {} , type: 'browser' }, ['node', '--worker']), false)
  assert.equal(isAcceptanceHarnessEntry(true, { versions: {} , type: 'node' }, ['node', 'script.cjs']), true)
})

test('resume path validation rejects symlinked project storage and accepts regular project files', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-resume-path-'))
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }))
  const project = path.join(temporaryRoot, '.test-temp', 'mcp-codex-agnes-run-a', 'project', 'source')
  const data = path.join(project, '.vibepaper')
  await fs.mkdir(data, { recursive: true })
  await fs.writeFile(path.join(data, 'project.json'), '{}')
  await fs.writeFile(path.join(data, 'project.sqlite'), 'fixture')
  const validated = await validateResumeMediaProjectPath(project, temporaryRoot)
  assert.equal(validated.projectDirectory, path.resolve(project))

  const outside = path.join(temporaryRoot, 'outside-data')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'project.json'), '{}')
  await fs.writeFile(path.join(outside, 'project.sqlite'), 'fixture')
  await fs.rm(data, { recursive: true })
  try {
    await fs.symlink(outside, data, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip('Symlink or junction creation is unavailable in this environment')
    throw error
  }
  await assert.rejects(validateResumeMediaProjectPath(project, temporaryRoot), /TEMP_PATH_OUTSIDE_ACCEPTANCE_ROOT/u)
})

test('resume classifier accepts the exact existing image and optional single reusable video task', () => {
  const imageOnly = validImageSnapshot()
  assert.deepEqual(classifyResumeMediaSnapshot(imageOnly.canvas, imageOnly.tasks), {
    existingMediaTaskCount: 1,
    imageTaskStatus: 'succeeded',
    videoTaskPresent: false,
    videoTaskStatus: null,
    videoStage: 'submit',
    imageTaskKey: 'task-image-1',
    videoTaskKey: null,
  })

  const withVideo = validImageSnapshot({ videoTask: {
    taskId: 'task-video-1', modality: 'video', nodeId: 'video-1', status: 'running', outputs: [],
  } })
  const plan = classifyResumeMediaSnapshot(withVideo.canvas, withVideo.tasks)
  assert.equal(plan.videoTaskPresent, true)
  assert.equal(plan.videoTaskStatus, 'running')
  assert.equal(plan.videoStage, 'query')
})

test('resume classifier fails closed on invalid or ambiguous media tasks and nodes', () => {
  for (const status of ['failed', 'cancelled', 'queued', 'running', 'unknown']) {
    const snapshot = validImageSnapshot({ imageStatus: status })
    assert.throws(() => classifyResumeMediaSnapshot(snapshot.canvas, snapshot.tasks), { code: 'RESUME_MEDIA_TASK_INVALID' })
  }
  const duplicateImage = validImageSnapshot({ extraNodes: [{ id: 'image-2', type: 'image' }] })
  assert.throws(() => classifyResumeMediaSnapshot(duplicateImage.canvas, duplicateImage.tasks), { code: 'RESUME_MEDIA_TASK_INVALID' })

  const twoVideoNodes = validImageSnapshot({
    videoTask: { taskId: 'task-video-1', modality: 'video', nodeId: 'video-1', status: 'queued', outputs: [] },
    extraNodes: [{ id: 'video-2', type: 'video' }],
  })
  assert.throws(() => classifyResumeMediaSnapshot(twoVideoNodes.canvas, twoVideoNodes.tasks), { code: 'RESUME_MEDIA_TASK_AMBIGUOUS' })
  const duplicateVideoTasks = validImageSnapshot({
    videoTask: { taskId: 'task-video-1', modality: 'video', nodeId: 'video-1', status: 'queued', outputs: [] },
  })
  duplicateVideoTasks.tasks.push({ taskId: 'task-video-2', modality: 'video', nodeId: 'video-1', status: 'running', outputs: [] })
  assert.throws(() => classifyResumeMediaSnapshot(duplicateVideoTasks.canvas, duplicateVideoTasks.tasks), { code: 'RESUME_MEDIA_TASK_AMBIGUOUS' })
})

test('resume media submission guard rejects every image preparation and existing video preparation', async () => {
  let invoked = false
  const imageGuard = createAcceptanceMediaSubmissionGuard(() => 'image', {
    resumeMode: true,
    resolveModelModality: () => 'image',
  })
  await assert.rejects(imageGuard(async () => { invoked = true }, 'mcp:tool:execute', {
    toolName: 'prepare_generation', arguments: { generations: [{ modelType: 'image-binding', modelParams: {} }] },
  }), { code: 'QA_MEDIA_SCOPE_EXCEEDED' })
  assert.equal(invoked, false)

  const videoGuard = createAcceptanceMediaSubmissionGuard(() => 'video', {
    resumeMode: true,
    hasExistingVideoTask: () => true,
    resolveModelModality: () => 'video',
  })
  await assert.rejects(videoGuard(async () => { invoked = true }, 'mcp:tool:execute', {
    toolName: 'prepare_generation', arguments: { generations: [{ modelType: 'video-binding', modelParams: {
      duration: 4, resolution: '720P', aspectRatio: '16:9',
    } }] },
  }), { code: 'QA_MEDIA_SCOPE_EXCEEDED' })
  assert.equal(invoked, false)
})

test('resume query-only stages reject canvas mutations before dispatch', async () => {
  let invoked = false
  for (const stage of ['image-query', 'video-query', 'readback']) {
    const guard = createAcceptanceMediaSubmissionGuard(() => stage, { resumeMode: true })
    for (const toolName of ['create_nodes', 'connect_nodes']) {
      await assert.rejects(guard(async () => { invoked = true }, 'mcp:tool:execute', { toolName, arguments: {} }),
        { code: 'QA_MEDIA_SCOPE_EXCEEDED' })
    }
  }
  assert.equal(invoked, false)
})

test('video-only mode rejects resume and configuration-only combinations', () => {
  assert.equal(assertAcceptanceModeCompatibility(true, null, false), undefined)
  assert.throws(() => assertAcceptanceModeCompatibility(true, 'project-path', false), { code: 'QA_ASSERTION_FAILED' })
  assert.throws(() => assertAcceptanceModeCompatibility(true, null, true), { code: 'QA_ASSERTION_FAILED' })
  assert.equal(assertAcceptanceModeCompatibility(false, 'project-path', false), undefined)
})

test('video-only submission guard permits one video node, one connection and one video proposal only', async () => {
  let stage = 'video'
  const calls = []
  const guard = createAcceptanceMediaSubmissionGuard(() => stage, {
    videoOnly: true,
    resolveModelModality: (modelType) => modelType === 'image-binding' ? 'image' : 'video',
  })
  const invoke = async () => { calls.push('invoked'); return { structuredContent: { status: 'created' } } }
  await assert.rejects(guard(invoke, 'mcp:tool:execute', {
    toolName: 'create_nodes', arguments: { nodes: [{ type: 'text' }] },
  }), { code: 'QA_MEDIA_SCOPE_EXCEEDED' })
  await guard(invoke, 'mcp:tool:execute', {
    toolName: 'create_nodes', arguments: { nodes: [{ type: 'video' }] },
  })
  await assert.rejects(guard(invoke, 'mcp:tool:execute', {
    toolName: 'create_nodes', arguments: { nodes: [{ type: 'video' }] },
  }), { code: 'QA_MEDIA_SCOPE_EXCEEDED' })
  await guard(invoke, 'mcp:tool:execute', {
    toolName: 'connect_nodes', arguments: { nodeIds: ['text-1', 'video-1'] },
  })
  await assert.rejects(guard(invoke, 'mcp:tool:execute', {
    toolName: 'connect_nodes', arguments: { nodeIds: ['text-1', 'video-1'] },
  }), { code: 'QA_MEDIA_SCOPE_EXCEEDED' })
  await assert.rejects(guard(invoke, 'mcp:tool:execute', {
    toolName: 'prepare_generation', arguments: { generations: [{ modelType: 'image-binding', modelParams: {} }] },
  }), { code: 'QA_MEDIA_SCOPE_EXCEEDED' })
  await guard(invoke, 'mcp:tool:execute', {
    toolName: 'prepare_generation', arguments: { generations: [{ modelType: 'video-binding', modelParams: {
      duration: 4, resolution: '720P', aspectRatio: '16:9',
    } }] },
  })
  await assert.rejects(guard(invoke, 'mcp:tool:execute', {
    toolName: 'prepare_generation', arguments: { generations: [{ modelType: 'video-binding', modelParams: {
      duration: 4, resolution: '720P', aspectRatio: '16:9',
    } }] },
  }), { code: 'QA_MEDIA_SCOPE_EXCEEDED' })
  stage = 'readback'
  await assert.rejects(guard(invoke, 'mcp:tool:execute', {
    toolName: 'create_nodes', arguments: { nodes: [{ type: 'video' }] },
  }), { code: 'QA_MEDIA_SCOPE_EXCEEDED' })
  assert.equal(calls.length, 3)
})

test('video-only chain acceptance requires zero images and exactly one visible, matched video result', () => {
  const snapshot = {
    imageTaskCount: 0, imageNodeCount: 0, allImageTaskCount: 0,
    videoTaskCount: 1, videoNodeCount: 1, createdVideoNodeCount: 1, allVideoTaskCount: 1,
    videoTaskSuccess: true, videoTaskOutputCount: 1, videoReferencePresent: true,
    videoReferenceToTargetEdgeCount: 1,
  }
  const rendered = { mediaRendered: true, visible: true }
  assert.equal(isVideoOnlyChainAccepted(snapshot, rendered, true), true)
  assert.equal(isVideoOnlyChainAccepted({ ...snapshot, imageTaskCount: 1 }, rendered, true), false)
  assert.equal(isVideoOnlyChainAccepted({ ...snapshot, videoTaskCount: 2 }, rendered, true), false)
  assert.equal(isVideoOnlyChainAccepted(snapshot, { ...rendered, visible: false }, true), false)
  assert.equal(isVideoOnlyChainAccepted(snapshot, rendered, false), false)
})
