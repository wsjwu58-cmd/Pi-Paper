const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')

async function openTestProject(t) {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-drama-assets-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const opened = await store.createProject(parentDirectory, 'Drama Assets Test')
  return { store, parentDirectory, ...opened }
}

function assetInput(project, overrides = {}) {
  return {
    projectId: project.project.projectId,
    canvasId: project.project.canvasId,
    canvasVersion: 0,
    idempotencyKey: 'drama-create-1',
    assetType: 'series_bible',
    data: { premise: 'A test premise' },
    ...overrides,
  }
}

test('drama asset writes validate, version, replay snapshots, filter, and survive reopening', async (t) => {
  const { store, project, directory } = await openTestProject(t)
  const created = await store.upsertDramaAsset(assetInput({ project }))
  assert.equal(created.assetVersion, 1)
  assert.equal(created.canvasVersion, 1)
  assert.equal(created.currentCanvasVersion, 1)
  assert.equal(created.replayed, false)

  const updated = await store.upsertDramaAsset(assetInput({ project }, {
    canvasVersion: 1,
    idempotencyKey: 'drama-update-1',
    assetId: created.assetId,
    data: { premise: 'Updated premise', episodeId: 'ep-1' },
  }))
  assert.equal(updated.assetVersion, 2)
  assert.equal(updated.canvasVersion, 2)

  const replay = await store.upsertDramaAsset(assetInput({ project }, {
    canvasVersion: 0,
    idempotencyKey: 'drama-create-1',
    assetType: 'invalid-type',
    assetId: [],
    data: [],
  }))
  assert.equal(replay.replayed, true)
  assert.equal(replay.assetId, created.assetId)
  assert.equal(replay.assetVersion, 1)
  assert.equal(replay.canvasVersion, 1)
  assert.equal(replay.currentCanvasVersion, 2)
  assert.deepEqual(replay.data, { premise: 'A test premise' })

  assert.deepEqual((await store.listDramaAssets(project.projectId, project.canvasId, {
    assetType: 'series_bible', episodeId: 'ep-1',
  })).items.map((item) => item.assetId), [created.assetId])
  assert.equal((await store.listDramaAssets(project.projectId, project.canvasId, {
    assetType: 'episode',
  })).items.length, 0)

  await store.close()
  await store.openProject(directory)
  const persisted = await store.listDramaAssets(project.projectId, project.canvasId)
  assert.equal(persisted.items.length, 1)
  assert.equal(persisted.items[0].assetVersion, 2)
  assert.equal(persisted.items[0].currentCanvasVersion, 2)
})

test('drama asset validation follows Java requireText, rejects stale versions, and keeps type immutable', async (t) => {
  const { store, project } = await openTestProject(t)
  const created = await store.upsertDramaAsset(assetInput({ project }, {
    data: { premise: false },
  }))
  assert.deepEqual(created.data, { premise: false })

  await assert.rejects(store.upsertDramaAsset(assetInput({ project }, {
    idempotencyKey: 'stale-write',
    canvasVersion: 0,
  })), /画布版本已变化/u)
  await assert.rejects(store.upsertDramaAsset(assetInput({ project }, {
    idempotencyKey: 'change-type',
    canvasVersion: 1,
    assetId: created.assetId,
    assetType: 'episode',
    data: { episodeNo: 1, goal: 'A goal' },
  })), /类型不可变更/u)
  await assert.rejects(store.upsertDramaAsset(assetInput({ project }, {
    idempotencyKey: 'blank-required',
    canvasVersion: 1,
    data: { premise: '   ' },
  })), /缺少字段: premise/u)
})

test('project schema v13 migrates short drama tables with a rollback snapshot', async (t) => {
  const { store, directory } = await openTestProject(t)
  await store.close()
  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE drama_asset_commands;
      DROP TABLE drama_assets;
      PRAGMA user_version = 13;
    `)
  } finally {
    database.close()
  }

  const reopened = await store.openProject(directory)
  const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(migratedDatabase.prepare('PRAGMA user_version').get().user_version, 16)
    assert.ok(migratedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drama_assets'").get())
    assert.ok(migratedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drama_asset_commands'").get())
  } finally {
    migratedDatabase.close()
  }
  const backups = await fs.readdir(path.join(directory, '.vibepaper', 'backups'))
  const backupName = backups.find((name) => name.startsWith('project-schema-v13-'))
  assert.ok(backupName)
  const backup = new DatabaseSync(path.join(directory, '.vibepaper', 'backups', backupName), { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 13)
    assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drama_assets'").get(), undefined)
  } finally {
    backup.close()
  }
  assert.equal(reopened.project.projectId, store.getActiveProject().projectId)
})
