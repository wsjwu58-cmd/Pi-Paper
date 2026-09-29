const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')

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

test('project schema v14 migration adds durable render batch and review tables with a rollback snapshot', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await store.close()
  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      DROP TABLE drama_render_jobs;
      DROP TABLE drama_render_batches;
      DROP TABLE render_reviews;
      PRAGMA user_version = 14;
    `)
  } finally {
    database.close()
  }

  await store.openProject(directory)
  const migrated = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 15)
    for (const table of ['drama_render_batches', 'drama_render_jobs', 'render_reviews']) {
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
