const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { AGNES_MODELS, AGNES_PROVIDER_ID } = require('../src/agnes-model-catalog.cjs')
const { ARK_MODELS, ARK_PROVIDER_ID } = require('../src/ark-model-catalog.cjs')

async function openTestProject(t) {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-drama-production-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const opened = await store.createProject(parentDirectory, 'Drama Production Test')
  return { store, parentDirectory, ...opened }
}

async function createRenderCandidate(store, project, {
  durationSeconds = 4, model = AGNES_MODELS.video, additionalParams = {},
} = {}) {
  const scope = { projectId: project.projectId, canvasId: project.canvasId }
  await store.createDramaSeries({ ...scope, idempotencyKey: 'series-for-render-batch', series: { id: 'series-render', activeCanonRevision: 1 } })
  await store.createDramaCharacter({
    ...scope,
    idempotencyKey: 'character-for-render-batch',
    character: {
      id: 'hero-render', seriesId: 'series-render', name: '橘猫侠',
      identityAnchors: ['琥珀色右眼', '左耳缺口', '橘白短毛'], activeLookRevision: 1, voiceId: 'voice-render',
    },
  })
  await store.addDramaReferencePack({
    ...scope,
    idempotencyKey: 'reference-for-render-batch',
    pack: {
      id: 'reference-render', characterId: 'hero-render', lookRevision: 1, status: 'approved',
      frontAssetId: 'front-render', sideAssetId: 'side-render', backAssetId: 'back-render',
      expressionAssetIds: ['expression-render'],
    },
  })
  await store.createDramaShot({
    ...scope,
    idempotencyKey: 'shot-for-render-batch',
    shot: {
      id: 'shot-render', seriesId: 'series-render', episodeNo: 1, shotNo: 1, durationSeconds,
      characterBindings: [{ characterId: 'hero-render', lookRevision: 1 }], promptRevision: 1,
    },
  })

  const keyframeDraft = await store.prepareDramaKeyframeNode({ ...scope, shotId: 'shot-render' })
  await store.saveCanvas({
    ...scope,
    expectedVersion: 0,
    nodes: [{
      id: 'keyframe-node-render', type: 'image', position: { x: 0, y: 0 },
      data: { creativeType: 'keyframe', prompt: '角色正面关键帧', params: {
        shotId: 'shot-render', referencePackIds: keyframeDraft.referencePackIds,
        referenceAssetIds: keyframeDraft.referenceAssetIds,
      } },
    }],
    edges: [],
  })
  const keyframeTask = await store.createTask({
    ...scope, canvasVersion: 1, nodeId: 'keyframe-node-render', modality: 'image',
    providerType: 'local', providerId: 'test-image-provider', modelId: 'test-image-model',
    idempotencyKey: 'keyframe-image-task-render', parameters: { prompt: '角色正面关键帧', count: 1 },
  })
  const claimedKeyframe = await store.claimNextTask(project.projectId)
  assert.equal(claimedKeyframe.task.taskId, keyframeTask.taskId)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await fs.writeFile(path.join(claimedKeyframe.outputDirectory, 'result.png'), png)
  await store.recordTaskSucceeded(project.projectId, keyframeTask.taskId,
    `generated/${keyframeTask.taskId}/result.png`)
  await store.recordDramaKeyframe({
    ...scope,
    idempotencyKey: 'accept-keyframe-render',
    render: { id: keyframeTask.taskId, shotId: 'shot-render', status: 'accepted', referencePackIds: keyframeDraft.referencePackIds },
  })

  const videoDraft = await store.prepareDramaVideoNode({ ...scope, shotId: 'shot-render' })
  const video = await store.createNode({
    ...scope, expectedVersion: 1, idempotencyKey: 'create-video-node-render', type: 'video',
    x: 260, y: 40, creativeType: 'clip', modelRef: model, prompt: '橘猫侠转身看向镜头',
    params: {
        shotId: videoDraft.shotId, keyframeRenderId: videoDraft.keyframeRenderId,
        referencePackIds: videoDraft.referencePackIds, model,
        prompt: '橘猫侠转身看向镜头', aspectRatio: '9:16', ...additionalParams,
    },
  })
  return { scope, keyframeTask, videoNodeId: video.node.id, canvasVersion: video.version }
}

test('render reviews persist rule findings against an existing canvas node and keep task evidence', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes: [{ id: 'clip-node', type: 'video', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  })

  const failed = await store.createRenderReview({
    projectId: project.projectId,
    canvasId: project.canvasId,
    targetNodeId: 'clip-node',
    shotDurationSeconds: 4,
    expectedDurationSeconds: 3,
    characterConsistent: false,
    audioDurationMs: 4_000,
    videoDurationMs: 3_700,
    previousCamera: 'wide',
    currentCamera: 'close',
    retryCount: 1,
  })
  assert.equal(failed.verdict, 'fail')
  assert.deepEqual(failed.findings.map((finding) => finding.ruleId), [
    'SHOT_DURATION', 'CHARACTER_CONTINUITY', 'AUDIO_VIDEO_SYNC',
  ])

  const passing = await store.createRenderReview({
    projectId: project.projectId,
    canvasId: project.canvasId,
    targetNodeId: 'clip-node',
    shotDurationSeconds: 3,
    expectedDurationSeconds: 3,
    characterConsistent: true,
    audioDurationMs: 3_010,
    videoDurationMs: 3_000,
    previousCamera: 'wide',
    currentCamera: 'close',
  })
  assert.equal(passing.verdict, 'pass')
  assert.deepEqual(passing.findings, [])
  await assert.rejects(store.createRenderReview({
    projectId: project.projectId,
    canvasId: project.canvasId,
    targetNodeId: 'missing-node',
    shotDurationSeconds: 3,
    expectedDurationSeconds: 3,
    characterConsistent: true,
    audioDurationMs: 3_000,
    videoDurationMs: 3_000,
    previousCamera: 'wide',
    currentCamera: 'close',
  }), /审校目标节点不存在/u)

  await store.close()
  await store.openProject(directory)
  const persisted = await store.listRenderReviews(project.projectId, project.canvasId, 'clip-node')
  assert.equal(persisted.items.length, 2)
  assert.deepEqual(persisted.items.map((item) => item.status), ['pass', 'fail'])
  assert.equal(persisted.items[1].retry_count, 1)
  assert.equal(persisted.items[1].evidence.input.videoDurationMs, 3_700)
})

test('render batch reads return only stored records and report missing ids', async (t) => {
  const { store, project } = await openTestProject(t)
  assert.deepEqual(await store.listDramaRenderBatches(project.projectId, project.canvasId), { items: [] })
  await assert.rejects(store.getDramaRenderBatch(project.projectId, project.canvasId, 'missing'), /渲染批次不存在/u)
})

test('fresh project creates, confirms, submits, reconciles and reruns a real render batch through TaskStore', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  const ready = await createRenderCandidate(store, project)
  const { scope } = ready
  const candidates = await store.listDramaRenderCandidates(project.projectId, project.canvasId)
  assert.equal(candidates.items.length, 1)
  const candidate = candidates.items[0]
  assert.equal(candidate.seriesId, 'series-render')
  assert.equal(candidate.episodeNo, 1)
  assert.equal(candidate.durationSeconds, 4)
  assert.equal(candidate.keyframeRenderId, ready.keyframeTask.taskId)
  assert.equal(candidate.canvasNodeId, ready.videoNodeId)
  assert.equal(candidate.available, true)

  const jobInput = {
    shotId: candidate.shotId,
    keyframeRenderId: candidate.keyframeRenderId,
    canvasNodeId: candidate.canvasNodeId,
    durationSeconds: candidate.durationSeconds,
    modelType: 'video',
    providerType: candidate.providerType,
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    modelParams: candidate.modelParams,
  }
  const batchInput = {
    ...scope, idempotencyKey: 'render-batch-idempotency', seriesId: candidate.seriesId,
    episodeNo: candidate.episodeNo, canvasVersion: ready.canvasVersion, jobs: [jobInput],
  }
  const batch = await store.createDramaRenderBatch(batchInput)
  assert.equal(batch.status, 'awaiting_approval')
  assert.equal(batch.jobs[0].status, 'draft')
  assert.equal((await store.createDramaRenderBatch(batchInput)).id, batch.id)
  await assert.rejects(store.createDramaRenderBatch({
    ...batchInput, jobs: [{ ...jobInput, modelParams: { ...jobInput.modelParams, prompt: 'different prompt' } }],
  }), (error) => error.code === 'IDEMPOTENCY_CONFLICT')
  await assert.rejects(store.consumeDramaRenderBatchConfirmation({
    ...scope, batchId: batch.id, actionId: 'missing', token: '0'.repeat(64), canvasVersion: ready.canvasVersion,
  }), (error) => error.code === 'CONFIRMATION_REQUIRED')

  const interruptedConfirmation = await store.prepareDramaRenderBatchConfirmation({ ...scope, batchId: batch.id })
  await store.close()
  await store.openProject(directory)
  await assert.rejects(store.consumeDramaRenderBatchConfirmation({
    ...scope, batchId: batch.id, actionId: interruptedConfirmation.confirmation.actionId,
    token: interruptedConfirmation.confirmation.token, canvasVersion: ready.canvasVersion,
  }), (error) => error.code === 'CONFIRMATION_INVALIDATED')

  const prepared = await store.prepareDramaRenderBatchConfirmation({ ...scope, batchId: batch.id })
  const accepted = await store.consumeDramaRenderBatchConfirmation({
    ...scope, batchId: batch.id, actionId: prepared.confirmation.actionId,
    token: prepared.confirmation.token, canvasVersion: ready.canvasVersion,
  })
  assert.equal(accepted.confirmation.operation, 'submit')
  assert.equal(accepted.jobs[0].attempt, 0)
  assert.equal(accepted.jobs[0].taskIdempotencyKey, `drama-batch:${batch.id}:job:${batch.jobs[0].id}:attempt:0`)
  await assert.rejects(store.rejectDramaRenderBatchConfirmation({
    ...scope, batchId: batch.id, actionId: prepared.confirmation.actionId, token: prepared.confirmation.token,
  }), (error) => error.code === 'CONFIRMATION_ALREADY_CONSUMED')

  async function createBatchTask(job) {
    return store.createTask({
      ...scope, canvasVersion: ready.canvasVersion, nodeId: job.canvasNodeId, modality: 'video',
      providerType: job.providerType, providerId: job.providerId, modelId: job.modelId,
      idempotencyKey: job.taskIdempotencyKey,
      parameters: {
        ...job.modelParams,
        firstFrameUrl: `vibe://app/tasks/${job.keyframeRenderId}/output`,
      },
    })
  }

  const firstJob = accepted.jobs[0]
  const firstTask = await createBatchTask(firstJob)
  // Simulate a crash after TaskStore persisted the task but before the submitter
  // linked it to the render job. A retry uses the stable idempotency key and the
  // batch read recovers the task association from TaskStore.
  const retriedTask = await createBatchTask(firstJob)
  assert.equal(retriedTask.taskId, firstTask.taskId)
  let current = await store.getDramaRenderBatch(project.projectId, project.canvasId, batch.id)
  assert.equal(current.jobs[0].taskId, firstTask.taskId)
  assert.equal(current.jobs[0].status, 'running')
  const claimedVideo = await store.claimNextTask(project.projectId)
  assert.equal(claimedVideo.task.taskId, firstTask.taskId)
  await store.recordTaskFailed(project.projectId, firstTask.taskId, 'CLOUD_REQUEST_FAILED', 'provider unavailable')
  current = await store.getDramaRenderBatch(project.projectId, project.canvasId, batch.id)
  assert.equal(current.jobs[0].status, 'failed')
  assert.equal(current.jobs[0].errorCode, 'CLOUD_REQUEST_FAILED')

  const rejectedRerun = await store.rerunDramaRenderBatchJob({
    ...scope, batchId: batch.id, jobId: current.jobs[0].id,
  })
  assert.equal(rejectedRerun.confirmation.operation, 'rerun')
  assert.equal(rejectedRerun.batch.jobs[0].status, 'failed')
  await store.rejectDramaRenderBatchConfirmation({
    ...scope, batchId: batch.id, actionId: rejectedRerun.confirmation.actionId,
    token: rejectedRerun.confirmation.token,
  })
  current = await store.getDramaRenderBatch(project.projectId, project.canvasId, batch.id)
  assert.equal(current.jobs[0].status, 'failed')
  assert.equal(current.jobs[0].attempt, 0)

  const rerunPrepared = await store.rerunDramaRenderBatchJob({
    ...scope, batchId: batch.id, jobId: current.jobs[0].id,
  })
  const rerunAccepted = await store.consumeDramaRenderBatchConfirmation({
    ...scope, batchId: batch.id, actionId: rerunPrepared.confirmation.actionId,
    token: rerunPrepared.confirmation.token, canvasVersion: ready.canvasVersion,
  })
  assert.equal(rerunAccepted.jobs[0].attempt, 1)
  assert.equal(rerunAccepted.jobs[0].taskIdempotencyKey,
    `drama-batch:${batch.id}:job:${current.jobs[0].id}:attempt:1`)
  assert.equal(rerunAccepted.batch.jobs[0].status, 'draft')

  const rerunTask = await createBatchTask(rerunAccepted.jobs[0])
  assert.notEqual(rerunTask.taskId, firstTask.taskId)
  await store.markDramaRenderBatchTask({
    ...scope, batchId: batch.id, jobId: rerunAccepted.jobs[0].id, taskId: rerunTask.taskId,
  })
  const claimedRerun = await store.claimNextTask(project.projectId)
  assert.equal(claimedRerun.task.taskId, rerunTask.taskId)
  const successfulOutput = path.join(claimedRerun.outputDirectory, 'result.mp4')
  const successfulOutputBytes = Buffer.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0,
  ])
  await fs.writeFile(successfulOutput, successfulOutputBytes)
  await store.recordTaskSucceeded(project.projectId, rerunTask.taskId, `generated/${rerunTask.taskId}/result.mp4`)
  current = await store.getDramaRenderBatch(project.projectId, project.canvasId, batch.id)
  assert.equal(current.status, 'completed')
  assert.equal(current.jobs[0].status, 'completed')
  assert.equal(current.jobs[0].attempt, 1)
  assert.equal(current.jobs[0].taskId, rerunTask.taskId)
  await fs.rm(successfulOutput)
  current = await store.getDramaRenderBatch(project.projectId, project.canvasId, batch.id)
  assert.equal(current.status, 'failed')
  assert.equal(current.jobs[0].status, 'failed')
  assert.equal(current.jobs[0].errorCode, 'TASK_OUTPUT_UNAVAILABLE')
  await fs.writeFile(successfulOutput, successfulOutputBytes)
  current = await store.getDramaRenderBatch(project.projectId, project.canvasId, batch.id)
  assert.equal(current.status, 'completed')
  assert.equal(current.jobs[0].status, 'completed')
  assert.equal(AGNES_PROVIDER_ID, current.jobs[0].providerId)
})

test('render candidates expose model duration and unsupported local media before confirmation', async (t) => {
  const shortProject = await openTestProject(t)
  const shortReady = await createRenderCandidate(shortProject.store, shortProject.project, { durationSeconds: 3 })
  const shortCandidate = (await shortProject.store.listDramaRenderCandidates(
    shortProject.project.projectId, shortProject.project.canvasId,
  )).items[0]
  assert.equal(shortCandidate.available, false)
  assert.equal(shortCandidate.unavailableReasonCode, 'MODEL_DURATION_UNSUPPORTED')
  assert.match(shortCandidate.unavailableReason, /4–12 秒/u)
  await assert.rejects(shortProject.store.createDramaRenderBatch({
    ...shortReady.scope,
    idempotencyKey: 'short-agnes-batch',
    seriesId: shortCandidate.seriesId,
    episodeNo: shortCandidate.episodeNo,
    canvasVersion: shortReady.canvasVersion,
    jobs: [{
      shotId: shortCandidate.shotId,
      keyframeRenderId: shortCandidate.keyframeRenderId,
      canvasNodeId: shortCandidate.canvasNodeId,
      durationSeconds: shortCandidate.durationSeconds,
      modelType: 'video',
      providerType: shortCandidate.providerType,
      providerId: shortCandidate.providerId,
      modelId: shortCandidate.modelId,
      modelParams: shortCandidate.modelParams,
    }],
  }), (error) => error.code === 'MODEL_DURATION_UNSUPPORTED')

  const arkProject = await openTestProject(t)
  const arkReady = await createRenderCandidate(arkProject.store, arkProject.project, { durationSeconds: 4, model: ARK_MODELS.video })
  const arkCandidate = (await arkProject.store.listDramaRenderCandidates(
    arkProject.project.projectId, arkProject.project.canvasId,
  )).items[0]
  assert.equal(arkCandidate.available, true)
  assert.equal(arkCandidate.providerId, ARK_PROVIDER_ID)
  const arkBatch = await arkProject.store.createDramaRenderBatch({
    ...arkReady.scope,
    idempotencyKey: 'ark-batch-image-first-frame',
    seriesId: arkCandidate.seriesId,
    episodeNo: arkCandidate.episodeNo,
    canvasVersion: arkReady.canvasVersion,
    jobs: [{
      shotId: arkCandidate.shotId,
      keyframeRenderId: arkCandidate.keyframeRenderId,
      canvasNodeId: arkCandidate.canvasNodeId,
      durationSeconds: arkCandidate.durationSeconds,
      modelType: 'video',
      providerType: arkCandidate.providerType,
      providerId: arkCandidate.providerId,
      modelId: arkCandidate.modelId,
      modelParams: arkCandidate.modelParams,
    }],
  })
  assert.equal(arkBatch.jobs[0].providerId, ARK_PROVIDER_ID)

  const localMediaProject = await openTestProject(t)
  const localMediaReady = await createRenderCandidate(localMediaProject.store, localMediaProject.project, {
    durationSeconds: 4,
    model: ARK_MODELS.video,
    additionalParams: { referenceVideos: ['vibe://app/assets/11111111-1111-4111-8111-111111111111'] },
  })
  const localMediaCandidate = (await localMediaProject.store.listDramaRenderCandidates(
    localMediaProject.project.projectId, localMediaProject.project.canvasId,
  )).items[0]
  assert.equal(localMediaCandidate.available, false)
  assert.equal(localMediaCandidate.unavailableReasonCode, 'REFERENCE_MEDIA_UNSUPPORTED')
  assert.match(localMediaCandidate.unavailableReason, /视频或音频参考尚无供应商上传链/u)
  await assert.rejects(localMediaProject.store.createDramaRenderBatch({
    ...localMediaReady.scope,
    idempotencyKey: 'ark-batch-local-video-reference',
    seriesId: localMediaCandidate.seriesId,
    episodeNo: localMediaCandidate.episodeNo,
    canvasVersion: localMediaReady.canvasVersion,
    jobs: [{
      shotId: localMediaCandidate.shotId,
      keyframeRenderId: localMediaCandidate.keyframeRenderId,
      canvasNodeId: localMediaCandidate.canvasNodeId,
      durationSeconds: localMediaCandidate.durationSeconds,
      modelType: 'video',
      providerType: localMediaCandidate.providerType,
      providerId: localMediaCandidate.providerId,
      modelId: localMediaCandidate.modelId,
      modelParams: localMediaCandidate.modelParams,
    }],
  }), (error) => error.code === 'REFERENCE_MEDIA_UNSUPPORTED')
})

test('project schema v14 migration adds durable render batch and review tables with a rollback snapshot', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await store.close()
  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA foreign_keys = OFF')
    database.exec(`
      DROP TABLE drama_render_confirmations;
      DROP TABLE drama_render_jobs;
      DROP TABLE drama_render_batches;
      DROP TABLE render_reviews;
      DROP TABLE drama_state_commands;
      DROP TABLE drama_render_lineages;
      DROP TABLE drama_keyframes;
      DROP TABLE drama_shots;
      DROP TABLE drama_reference_packs;
      DROP TABLE drama_characters;
      DROP TABLE drama_series;
      PRAGMA user_version = 14;
    `)
  } finally {
    database.close()
  }

  await store.openProject(directory)
  const migrated = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 17)
    for (const table of ['drama_render_batches', 'drama_render_jobs', 'drama_render_confirmations', 'render_reviews', 'drama_series']) {
      assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
    }
  } finally {
    migrated.close()
  }
  const backups = await fs.readdir(path.join(directory, '.vibepaper', 'backups'))
  const backupName = backups.find((name) => name.startsWith('project-schema-v14-'))
  assert.ok(backupName)
  const backup = new DatabaseSync(path.join(directory, '.vibepaper', 'backups', backupName), { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 14)
    assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'render_reviews'").get(), undefined)
  } finally {
    backup.close()
  }
  assert.equal(store.getActiveProject().projectId, project.projectId)
})

test('project schema v16 migration adds confirmation and task recovery columns with a rollback snapshot', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await store.close()
  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA foreign_keys = OFF')
    database.exec(`
      DROP TABLE drama_render_confirmations;
      ALTER TABLE drama_render_batches DROP COLUMN request_hash;
      ALTER TABLE drama_render_jobs DROP COLUMN attempt;
      ALTER TABLE drama_render_jobs DROP COLUMN model_id;
      ALTER TABLE drama_render_jobs DROP COLUMN provider_id;
      ALTER TABLE drama_render_jobs DROP COLUMN provider_type;
      PRAGMA user_version = 16;
    `)
  } finally {
    database.close()
  }

  await store.openProject(directory)
  const migrated = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 17)
    const batchColumns = new Set(migrated.prepare('PRAGMA table_info(drama_render_batches)').all().map((row) => row.name))
    const jobColumns = new Set(migrated.prepare('PRAGMA table_info(drama_render_jobs)').all().map((row) => row.name))
    assert.ok(batchColumns.has('request_hash'))
    for (const column of ['provider_type', 'provider_id', 'model_id', 'attempt']) assert.ok(jobColumns.has(column))
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drama_render_confirmations'").get())
  } finally {
    migrated.close()
  }
  const backups = await fs.readdir(path.join(directory, '.vibepaper', 'backups'))
  const backupName = backups.find((name) => name.startsWith('project-schema-v16-'))
  assert.ok(backupName)
  const backup = new DatabaseSync(path.join(directory, '.vibepaper', 'backups', backupName), { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 16)
    assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drama_render_confirmations'").get(), undefined)
  } finally {
    backup.close()
  }
  assert.equal(store.getActiveProject().projectId, project.projectId)
})
