const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const nativeFs = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { composeVideos, resolveFfmpegPath } = require('../src/compose-provider.cjs')

const MP4_HEADER = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])

function node(id, type, data = {}) {
  return { id, type, position: { x: 0, y: 0 }, data: { ...data, params: {} } }
}

async function openProject(t) {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-compose-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const opened = await store.createProject(parentDirectory, 'Compose Test')
  return { store, ...opened }
}

async function completeVideoTask(store, project, nodeId, index, canvasVersion) {
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion,
    nodeId,
    modality: 'video',
    providerType: 'cloud',
    providerId: 'provider-test',
    modelId: 'video-test',
    idempotencyKey: `compose-source-${index}`,
    parameters: { prompt: `clip ${index}` },
  })
  const claimed = await store.claimNextTask(project.projectId)
  assert.equal(claimed.task.taskId, task.taskId)
  const resultPath = path.join(claimed.outputDirectory, 'result.mp4')
  await fs.writeFile(resultPath, MP4_HEADER)
  await store.recordTaskSucceeded(project.projectId, task.taskId, `generated/${task.taskId}/result.mp4`)
  return task
}

async function saveComposeGraph(store, project, nodes, version = 0) {
  return store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: version,
    nodes,
    edges: [
      { id: 'video-a-to-compose', source: 'video-a', target: 'compose', data: { valid: true } },
      { id: 'video-b-to-compose', source: 'video-b', target: 'compose', data: { valid: true } },
    ],
  })
}

test('compose task snapshots connected successful video outputs and keeps compose as its modality', async (t) => {
  const { store, directory, project } = await openProject(t)
  await saveComposeGraph(store, project, [node('video-a', 'video'), node('video-b', 'video'), node('compose', 'compose')])
  const sourceA = await completeVideoTask(store, project, 'video-a', 'a', 1)
  const sourceB = await completeVideoTask(store, project, 'video-b', 'b', 1)

  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 1,
    nodeId: 'compose',
    modality: 'compose',
    providerType: 'local',
    providerId: 'mock-compose',
    modelId: 'compose-1.0',
    idempotencyKey: 'compose-run-1',
    parameters: { operation: 'compose', inputNodeIds: ['video-b', 'video-a'], count: 1 },
  })
  assert.equal(task.modality, 'compose')
  assert.equal(task.providerType, 'local')
  const snapshot = await store.getTaskInput(project.projectId, task.taskId)
  assert.deepEqual(snapshot.parameters.inputNodeIds, ['video-b', 'video-a'])
  assert.deepEqual(snapshot.parameters.inputTaskIds, [sourceB.taskId, sourceA.taskId])

  const claimed = await store.claimNextTask(project.projectId)
  assert.equal(claimed.task.taskId, task.taskId)
  const paths = await store.resolveComposeInputPaths(project.projectId, task.taskId)
  assert.equal(paths.length, 2)
  assert.equal(paths[0], path.join(directory, '.vibepaper', 'generated', sourceB.taskId, 'result.mp4'))
  assert.equal(paths[1], path.join(directory, '.vibepaper', 'generated', sourceA.taskId, 'result.mp4'))

  const outputPath = path.join(claimed.outputDirectory, 'result.mp4')
  await fs.writeFile(outputPath, MP4_HEADER)
  await store.recordTaskSucceeded(project.projectId, task.taskId, `generated/${task.taskId}/result.mp4`)
  assert.deepEqual(await store.resolveTaskOutputForPreview(project.projectId, task.taskId), {
    filePath: await fs.realpath(outputPath),
    mimeType: 'video/mp4',
    sizeBytes: MP4_HEADER.length,
  })
  const search = await store.searchTasks(project.projectId, { modality: 'compose', status: 'succeeded' })
  assert.equal(search.total, 1)

  const replay = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 1,
    nodeId: 'compose',
    modality: 'compose',
    providerType: 'local',
    providerId: 'mock-compose',
    modelId: 'compose-1.0',
    idempotencyKey: 'compose-run-1',
    parameters: { operation: 'compose', inputNodeIds: ['video-b', 'video-a'], count: 1 },
  })
  assert.equal(replay.taskId, task.taskId)
  assert.equal(replay.status, 'succeeded')
})

test('compose rejects unconnected inputs, missing successful tasks and arbitrary input URLs', async (t) => {
  const { store, project } = await openProject(t)
  await saveComposeGraph(store, project, [node('video-a', 'video'), node('video-b', 'video'), node('compose', 'compose')])
  const request = {
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 1,
    nodeId: 'compose',
    modality: 'compose',
    providerType: 'local',
    providerId: 'mock-compose',
    modelId: 'compose-1.0',
    idempotencyKey: 'compose-invalid-1',
    parameters: { operation: 'compose', inputNodeIds: ['video-a', 'video-b'], count: 1 },
  }
  await assert.rejects(store.createTask(request), /已完成的视频任务/u)
  await completeVideoTask(store, project, 'video-a', 'a', 1)
  await completeVideoTask(store, project, 'video-b', 'b', 1)
  await assert.rejects(store.createTask({
    ...request,
    idempotencyKey: 'compose-invalid-url',
    parameters: { ...request.parameters, inputUrls: ['C:\\private\\movie.mp4'] },
  }), /合成任务输入无效/u)
  await assert.rejects(store.createTask({
    ...request,
    idempotencyKey: 'compose-invalid-node',
    parameters: { operation: 'compose', inputNodeIds: ['video-a', 'not-connected'], count: 1 },
  }), /连接到合成节点/u)
})

test('compose refuses an older successful output when the source currentOutputId points at a failed task', async (t) => {
  const { store, project } = await openProject(t)
  const originalNodes = [node('video-a', 'video'), node('video-b', 'video'), node('compose', 'compose')]
  await saveComposeGraph(store, project, originalNodes)
  await completeVideoTask(store, project, 'video-a', 'a-success', 1)
  await completeVideoTask(store, project, 'video-b', 'b-success', 1)
  const latest = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 1,
    nodeId: 'video-a',
    modality: 'video',
    providerType: 'cloud',
    providerId: 'provider-test',
    modelId: 'video-test',
    idempotencyKey: 'compose-source-a-failed',
    parameters: { prompt: 'new attempt' },
  })
  assert.equal((await store.claimNextTask(project.projectId)).task.taskId, latest.taskId)
  await store.recordTaskFailed(project.projectId, latest.taskId, 'CLOUD_GENERATION_FAILED')

  await store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 1,
    nodes: [
      node('video-a', 'video', { currentOutputId: latest.taskId }),
      originalNodes[1],
      originalNodes[2],
    ],
    edges: [
      { id: 'video-a-to-compose', source: 'video-a', target: 'compose', data: { valid: true } },
      { id: 'video-b-to-compose', source: 'video-b', target: 'compose', data: { valid: true } },
    ],
  })
  await assert.rejects(store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 2,
    nodeId: 'compose',
    modality: 'compose',
    providerType: 'local',
    providerId: 'mock-compose',
    modelId: 'compose-1.0',
    idempotencyKey: 'compose-must-not-fallback',
    parameters: { operation: 'compose', inputNodeIds: ['video-a', 'video-b'], count: 1 },
  }), /已完成的视频任务/u)
})

test('project database v6 migrates tasks without losing task events and admits compose tasks', async (t) => {
  const { store, directory, project } = await openProject(t)
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 0,
    nodeId: null,
    modality: 'text',
    providerType: 'local',
    providerId: 'provider-test',
    modelId: 'model-test',
    idempotencyKey: 'migration-preserved-task',
    parameters: { prompt: 'preserve across v6 migration' },
  })
  await store.close()

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  let priorEvents
  try {
    priorEvents = database.prepare(`
      SELECT event_id, task_id, event_seq, type, data_json, created_at
      FROM task_events WHERE task_id = ? ORDER BY event_seq
    `).all(task.taskId)
    assert.equal(priorEvents.length, 1)
    assert.equal(priorEvents[0].type, 'created')
    database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE tasks_v6 (
        task_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 255),
        input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
        canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        canvas_version INTEGER NOT NULL CHECK (canvas_version >= 0),
        node_id TEXT,
        modality TEXT NOT NULL CHECK (modality IN ('text', 'image', 'audio', 'video')),
        provider_type TEXT NOT NULL CHECK (provider_type IN ('local', 'cloud')),
        provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 160),
        model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
        input_json TEXT NOT NULL CHECK (json_valid(input_json)),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        output_path TEXT,
        output_sha256 TEXT CHECK (output_sha256 IS NULL OR length(output_sha256) = 64),
        output_size_bytes INTEGER CHECK (output_size_bytes IS NULL OR output_size_bytes > 0),
        error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 120),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        CHECK (
          (status = 'succeeded' AND output_path IS NOT NULL AND output_sha256 IS NOT NULL AND output_size_bytes IS NOT NULL)
          OR (status <> 'succeeded' AND output_path IS NULL AND output_sha256 IS NULL AND output_size_bytes IS NULL)
        )
      ) STRICT;
      INSERT INTO tasks_v6 SELECT * FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_v6 RENAME TO tasks;
      CREATE INDEX tasks_by_status ON tasks(status, created_at);
      CREATE INDEX tasks_by_canvas ON tasks(canvas_id, created_at);
      PRAGMA user_version = 6;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `)
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally {
    database.close()
  }

  await store.openProject(directory)
  const migratedDatabase = new DatabaseSync(databasePath)
  try {
    assert.equal(migratedDatabase.prepare('PRAGMA user_version').get().user_version, 10)
    assert.equal(migratedDatabase.prepare('PRAGMA foreign_key_check').all().length, 0)
    const migratedEvents = migratedDatabase.prepare(`
      SELECT event_id, task_id, event_seq, type, data_json, created_at
      FROM task_events WHERE task_id = ? ORDER BY event_seq
    `).all(task.taskId)
    assert.deepEqual(migratedEvents, priorEvents)
  } finally {
    migratedDatabase.close()
  }
  assert.equal((await store.getTask(project.projectId, task.taskId)).status, 'queued')
})

test('compose worker uses FFmpeg to transcode and concatenate real local MP4 inputs', { timeout: 120_000 }, async (t) => {
  const ffmpeg = resolveFfmpegPath()
  if (!ffmpeg) return t.skip('FFmpeg is not installed in this environment.')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-compose-worker-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const generated = path.join(root, 'generated')
  const outputId = '99999999-9999-4999-8999-999999999999'
  const inputIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  const outputDirectory = path.join(generated, outputId)
  await fs.mkdir(outputDirectory, { recursive: true })
  const inputPaths = []
  for (let index = 0; index < inputIds.length; index += 1) {
    const inputDirectory = path.join(generated, inputIds[index])
    await fs.mkdir(inputDirectory)
    const inputPath = path.join(inputDirectory, 'result.mp4')
    const color = index === 0 ? 'red' : 'blue'
    const created = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:d=0.5:r=24`,
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', inputPath,
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    assert.equal(created.status, 0, created.stderr || created.error?.message)
    inputPaths.push(inputPath)
  }

  const result = await composeVideos({ taskId: outputId, outputDirectory, inputPaths })
  assert.equal(result.outputPath, `generated/${outputId}/result.mp4`)
  const outputPath = path.join(outputDirectory, 'result.mp4')
  const outputStat = await fs.stat(outputPath)
  assert.ok(outputStat.size > 0)
  const decoded = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', outputPath, '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(decoded.status, 0, decoded.stderr || decoded.error?.message)
})

test('compose maps missing FFmpeg and process failures to visible model-unavailable errors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-compose-failure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const generated = path.join(root, 'generated')
  const taskId = '99999999-9999-4999-8999-999999999999'
  const inputIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  const outputDirectory = path.join(generated, taskId)
  await fs.mkdir(outputDirectory, { recursive: true })
  const inputPaths = []
  for (const inputId of inputIds) {
    const inputDirectory = path.join(generated, inputId)
    await fs.mkdir(inputDirectory)
    const inputPath = path.join(inputDirectory, 'result.mp4')
    await fs.writeFile(inputPath, MP4_HEADER)
    inputPaths.push(inputPath)
  }
  const job = { taskId, outputDirectory, inputPaths }

  await assert.rejects(
    composeVideos(job, { resolveFfmpegPath: () => null }),
    (error) => error.code === 'MODEL_UNAVAILABLE' && /ffmpeg/u.test(error.message),
  )
  await assert.rejects(
    composeVideos(job, {
      resolveFfmpegPath: () => 'ffmpeg-test-binary',
      runFfmpeg: () => ({ status: 1, stderr: 'fixture encoder failure' }),
    }),
    (error) => error.code === 'MODEL_UNAVAILABLE' && /fixture encoder failure/u.test(error.message),
  )
  assert.equal(await fs.stat(path.join(outputDirectory, 'result.mp4')).then(() => true, () => false), false)
  assert.equal(await fs.stat(path.join(outputDirectory, '_compose_inputs')).then(() => true, () => false), false)
})

test('FFmpeg resolution honors the original settings environment field before FFMPEG_PATH', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-ffmpeg-config-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const configuredPath = path.join(root, process.platform === 'win32' ? 'configured.exe' : 'configured')
  const fallbackPath = path.join(root, process.platform === 'win32' ? 'fallback.exe' : 'fallback')
  await fs.writeFile(configuredPath, 'configured binary placeholder')
  await fs.writeFile(fallbackPath, 'fallback binary placeholder')
  if (process.platform !== 'win32') {
    await fs.chmod(configuredPath, 0o700)
    await fs.chmod(fallbackPath, 0o700)
  }

  assert.equal(resolveFfmpegPath({
    env: { PATH: '', VIBEPAPER_FFMPEG_PATH: configuredPath, FFMPEG_PATH: fallbackPath },
  }), configuredPath)
  assert.equal(resolveFfmpegPath({
    env: { PATH: '', FFMPEG_PATH: fallbackPath },
  }), fallbackPath)
})

test('compose retries concat with re-encoding when stream-copy concatenation fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-compose-fallback-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const generated = path.join(root, 'generated')
  const taskId = '99999999-9999-4999-8999-999999999999'
  const inputIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  const outputDirectory = path.join(generated, taskId)
  await fs.mkdir(outputDirectory, { recursive: true })
  const inputPaths = []
  for (const inputId of inputIds) {
    const inputDirectory = path.join(generated, inputId)
    await fs.mkdir(inputDirectory)
    const inputPath = path.join(inputDirectory, 'result.mp4')
    await fs.writeFile(inputPath, MP4_HEADER)
    inputPaths.push(inputPath)
  }

  let concatAttempts = 0
  const result = await composeVideos({ taskId, outputDirectory, inputPaths }, {
    resolveFfmpegPath: () => 'ffmpeg-test-binary',
    runFfmpeg: (_ffmpegPath, args) => {
      const outputPath = args.at(-1)
      if (args.includes('concat')) {
        concatAttempts += 1
        if (concatAttempts === 1) return { status: 1, stderr: 'stream copy failed' }
      }
      nativeFs.writeFileSync(outputPath, MP4_HEADER)
      return { status: 0, stderr: '' }
    },
    validMp4: async () => true,
  })

  assert.equal(concatAttempts, 2)
  assert.equal(result.outputPath, `generated/${taskId}/result.mp4`)
  assert.equal((await fs.stat(path.join(outputDirectory, 'result.mp4'))).size, MP4_HEADER.length)
})
