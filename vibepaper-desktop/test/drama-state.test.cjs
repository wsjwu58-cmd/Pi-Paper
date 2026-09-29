const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')

async function openTestProject(t) {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-drama-state-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const opened = await store.createProject(parentDirectory, 'Drama State Test')
  return { store, parentDirectory, directory: opened.directory, project: opened.project }
}

function scoped(project, overrides = {}) {
  return { projectId: project.projectId, canvasId: project.canvasId, ...overrides }
}

async function createSeries(store, project, id, key = `series-${id}`) {
  return store.createDramaSeries(scoped(project, {
    idempotencyKey: key,
    series: { id, activeCanonRevision: 1 },
  }))
}

async function createCharacter(store, project, seriesId, id, overrides = {}) {
  return store.createDramaCharacter(scoped(project, {
    idempotencyKey: overrides.idempotencyKey ?? `character-${id}`,
    character: {
      id,
      seriesId,
      name: '橘猫侠',
      identityAnchors: ['琥珀色右眼', '左耳缺口', '橘白相间短毛', '红色铜铃项圈'],
      activeLookRevision: 1,
      voiceId: 'voice-hero-1',
      ...overrides.character,
    },
  }))
}

async function addReferencePack(store, project, characterId, id = `ref-${characterId}`, overrides = {}) {
  return store.addDramaReferencePack(scoped(project, {
    idempotencyKey: overrides.idempotencyKey ?? `pack-${id}`,
    pack: {
      id,
      characterId,
      lookRevision: 1,
      status: 'approved',
      frontAssetId: `front-${characterId}`,
      sideAssetId: `side-${characterId}`,
      backAssetId: `back-${characterId}`,
      expressionAssetIds: [`expression-${characterId}`],
      ...overrides.pack,
    },
  }))
}

async function createShot(store, project, seriesId, id, characterId, overrides = {}) {
  return store.createDramaShot(scoped(project, {
    idempotencyKey: overrides.idempotencyKey ?? `shot-${id}`,
    shot: {
      id,
      seriesId,
      episodeNo: 1,
      shotNo: 1,
      durationSeconds: 3,
      characterBindings: characterId ? [{ characterId, lookRevision: 1 }] : [],
      promptRevision: 1,
      ...overrides.shot,
    },
  }))
}

async function createReadyShot(store, project) {
  await createSeries(store, project, 'series-1')
  await createCharacter(store, project, 'series-1', 'hero-1')
  await addReferencePack(store, project, 'hero-1', 'ref-hero-1')
  await createShot(store, project, 'series-1', 'shot-1', 'hero-1')
  return { seriesId: 'series-1', characterId: 'hero-1', referencePackId: 'ref-hero-1', shotId: 'shot-1' }
}

test('drama series, approved reference packs and accepted keyframes persist and replay by command key', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  const state = await createReadyShot(store, project)
  const prepared = await store.prepareDramaKeyframeNode(scoped(project, { shotId: state.shotId }))
  assert.deepEqual(prepared.referencePackIds, [state.referencePackId])
  assert.deepEqual(prepared.referenceAssetIds, ['front-hero-1', 'side-hero-1', 'back-hero-1', 'expression-hero-1'])

  await assert.rejects(store.recordDramaKeyframe(scoped(project, {
    idempotencyKey: 'accept-keyframe-1',
    render: { id: 'keyframe-invalid', shotId: state.shotId, status: 'accepted', referencePackIds: [state.referencePackId, state.referencePackId] },
  })), (error) => error.code === 'MISSING_CHARACTER_REFERENCE')
  const accepted = await store.recordDramaKeyframe(scoped(project, {
    idempotencyKey: 'accept-keyframe-1',
    render: { id: 'keyframe-1', shotId: state.shotId, status: 'accepted', referencePackIds: [state.referencePackId] },
  }))
  assert.equal(accepted.status, 'accepted')
  assert.deepEqual(await store.recordDramaKeyframe(scoped(project, {
    idempotencyKey: 'accept-keyframe-1',
    render: { id: 'ignored-on-replay', shotId: 'invalid-shot', status: 'rejected', referencePackIds: [] },
  })), accepted)
  assert.deepEqual(await store.prepareDramaVideoNode(scoped(project, { shotId: state.shotId })), {
    nodeType: 'video',
    creativeType: 'clip',
    shotId: state.shotId,
    keyframeRenderId: 'keyframe-1',
    referencePackIds: [state.referencePackId],
  })

  await store.close()
  await store.openProject(directory)
  assert.equal((await store.prepareDramaVideoNode(scoped(project, { shotId: state.shotId }))).keyframeRenderId, 'keyframe-1')
})

test('drama state validates identity anchors, current Look revisions, reference packs and shot duration', async (t) => {
  const { store, project } = await openTestProject(t)
  await assert.rejects(store.createDramaSeries(scoped(project, {
    idempotencyKey: 'nonstandard-format',
    series: { id: 'nonstandard-series', format: {
      id: 'vertical-short-drama-v1', aspectRatio: '9:16', targetDurationSeconds: 180,
      minShotCount: 60, maxShotCount: 90, minShotDurationSeconds: 1,
      maxShotDurationSeconds: 5, keyframeFirst: true,
    } },
  })), (error) => error.code === 'INVALID_FORMAT')
  await createSeries(store, project, 'series-1')
  await assert.rejects(store.createDramaCharacter(scoped(project, {
    idempotencyKey: 'bad-character',
    character: {
      id: 'bad-hero', seriesId: 'series-1', name: 'Bad', voiceId: 'voice',
      identityAnchors: ['same', ' same ', 'third'], activeLookRevision: 1,
    },
  })), (error) => error.code === 'INVALID_IDENTITY_ANCHORS')
  await createCharacter(store, project, 'series-1', 'hero-1')

  await assert.rejects(addReferencePack(store, project, 'hero-1', 'wrong-look', {
    pack: { lookRevision: 2 },
  }), (error) => error.code === 'VERSION_CONFLICT')
  await assert.rejects(addReferencePack(store, project, 'hero-1', 'incomplete', {
    pack: { expressionAssetIds: [] },
  }), (error) => error.code === 'INCOMPLETE_REFERENCE_PACK')
  await addReferencePack(store, project, 'hero-1', 'ref-hero-1')
  await assert.rejects(createShot(store, project, 'series-1', 'too-long', 'hero-1', {
    shot: { durationSeconds: 6 },
  }), (error) => error.code === 'INVALID_SHOT_DURATION')
  await assert.rejects(createShot(store, project, 'series-1', 'wrong-look', 'hero-1', {
    shot: { characterBindings: [{ characterId: 'hero-1', lookRevision: 2 }] },
  }), (error) => error.code === 'INVALID_CHARACTER_BINDING')
  await createShot(store, project, 'series-1', 'shot-1', 'hero-1')
  await addReferencePack(store, project, 'hero-1', 'duplicate-approved')
  await assert.rejects(store.prepareDramaKeyframeNode(scoped(project, { shotId: 'shot-1' })),
    (error) => error.code === 'CHARACTER_REFERENCE_AMBIGUOUS')
})

test('drama state rejects cross-project, cross-series, cross-canvas and cross-shot references', async (t) => {
  const { store, project } = await openTestProject(t)
  const otherProjectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-drama-other-project-'))
  const otherStore = createLocalProjectStore()
  t.after(async () => {
    await otherStore.close()
    await fs.rm(otherProjectDirectory, { recursive: true, force: true })
  })
  const other = await otherStore.createProject(otherProjectDirectory, 'Other Drama State Project')
  await assert.rejects(createSeries(store, other.project, 'cross-project-series'),
    (error) => error.code === 'PROJECT_CHANGED')
  await createSeries(store, project, 'series-a')
  await createSeries(store, project, 'series-b')
  await createCharacter(store, project, 'series-a', 'hero-a')
  await createCharacter(store, project, 'series-b', 'hero-b')
  await addReferencePack(store, project, 'hero-a', 'ref-a')
  await addReferencePack(store, project, 'hero-b', 'ref-b')
  await assert.rejects(createShot(store, project, 'series-a', 'shot-a-invalid', 'hero-b'),
    (error) => error.code === 'INVALID_CHARACTER_BINDING')
  await createShot(store, project, 'series-a', 'shot-a', 'hero-a')
  await createShot(store, project, 'series-b', 'shot-b', 'hero-b')
  await store.recordDramaKeyframe(scoped(project, {
    idempotencyKey: 'accept-b',
    render: { id: 'keyframe-b', shotId: 'shot-b', status: 'accepted', referencePackIds: ['ref-b'] },
  }))
  await assert.rejects(store.recordDramaLineage(scoped(project, {
    idempotencyKey: 'cross-shot-lineage',
    lineage: { id: 'lineage-a', shotId: 'shot-a', keyframeRenderId: 'keyframe-b', status: 'submitted' },
  })), (error) => error.code === 'INVALID_KEYFRAME_REFERENCE')
  await assert.rejects(store.prepareDramaKeyframeNode({ projectId: project.projectId, canvasId: 'another-canvas', shotId: 'shot-a' }),
    (error) => error.code === 'PROJECT_CHANGED')
  await assert.rejects(store.prepareDramaKeyframeNode(scoped(project, { shotId: 'shot-from-other-project' })),
    (error) => error.code === 'NOT_FOUND')
})

test('lineage invalidation is targeted, durable and idempotent', async (t) => {
  const { store, project, directory } = await openTestProject(t)
  await createReadyShot(store, project)
  await createCharacter(store, project, 'series-1', 'hero-2')
  await addReferencePack(store, project, 'hero-2', 'ref-hero-2')
  await createShot(store, project, 'series-1', 'shot-2', 'hero-2', { shot: { shotNo: 2 } })
  await store.recordDramaKeyframe(scoped(project, {
    idempotencyKey: 'accept-for-lineage',
    render: { id: 'keyframe-1', shotId: 'shot-1', status: 'accepted', referencePackIds: ['ref-hero-1'] },
  }))
  await store.recordDramaKeyframe(scoped(project, {
    idempotencyKey: 'accept-for-other-lineage',
    render: { id: 'keyframe-2', shotId: 'shot-2', status: 'accepted', referencePackIds: ['ref-hero-2'] },
  }))
  await store.recordDramaLineage(scoped(project, {
    idempotencyKey: 'lineage-create',
    lineage: { id: 'lineage-1', shotId: 'shot-1', keyframeRenderId: 'keyframe-1', status: 'submitted' },
  }))
  await store.recordDramaLineage(scoped(project, {
    idempotencyKey: 'other-lineage-create',
    lineage: { id: 'lineage-2', shotId: 'shot-2', keyframeRenderId: 'keyframe-2', status: 'submitted' },
  }))
  const invalidated = await store.markDramaLineagesStaleForCharacter(scoped(project, {
    idempotencyKey: 'stale-hero', characterId: 'hero-1',
  }))
  assert.deepEqual(invalidated, ['lineage-1'])
  assert.deepEqual(await store.markDramaLineagesStaleForCharacter(scoped(project, {
    idempotencyKey: 'stale-hero', characterId: 'hero-1',
  })), invalidated)
  await store.close()
  await store.openProject(directory)
  const replay = await store.markDramaLineagesStaleForCharacter(scoped(project, {
    idempotencyKey: 'stale-hero', characterId: 'hero-1',
  }))
  assert.deepEqual(replay, ['lineage-1'])
  const db = new DatabaseSync(path.join(directory, '.vibepaper', 'project.sqlite'), { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT status FROM drama_render_lineages WHERE id = ?').get('lineage-1').status, 'stale')
    assert.equal(db.prepare('SELECT status FROM drama_render_lineages WHERE id = ?').get('lineage-2').status, 'submitted')
  } finally {
    db.close()
  }
})

test('failed drama writes roll back without consuming their idempotency key', async (t) => {
  const { store, project, directory } = await openTestProject(t)
  await createSeries(store, project, 'series-1')
  await assert.rejects(createSeries(store, project, 'series-1', 'retry-after-conflict'),
    (error) => error.code === 'CONFLICT')
  await createSeries(store, project, 'series-2', 'retry-after-conflict')
  const db = new DatabaseSync(path.join(directory, '.vibepaper', 'project.sqlite'), { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM drama_series').get().count, 2)
    assert.equal(db.prepare('SELECT operation FROM drama_state_commands WHERE canvas_id = ? AND idempotency_key = ?')
      .get(project.canvasId, 'retry-after-conflict').operation, 'create_series')
  } finally {
    db.close()
  }
})

test('project schema v15 migration adds drama state tables after a rollback snapshot', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await store.close()
  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE drama_state_commands;
      DROP TABLE drama_render_lineages;
      DROP TABLE drama_keyframes;
      DROP TABLE drama_shots;
      DROP TABLE drama_reference_packs;
      DROP TABLE drama_characters;
      DROP TABLE drama_series;
      PRAGMA user_version = 15;
    `)
  } finally {
    database.close()
  }

  await store.openProject(directory)
  const migrated = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 16)
    for (const table of [
      'drama_series', 'drama_characters', 'drama_reference_packs', 'drama_shots',
      'drama_keyframes', 'drama_render_lineages', 'drama_state_commands',
    ]) {
      assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
    }
  } finally {
    migrated.close()
  }
  const backups = await fs.readdir(path.join(directory, '.vibepaper', 'backups'))
  const backupName = backups.find((name) => name.startsWith('project-schema-v15-'))
  assert.ok(backupName)
  const backup = new DatabaseSync(path.join(directory, '.vibepaper', 'backups', backupName), { readOnly: true })
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 15)
    assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drama_series'").get(), undefined)
  } finally {
    backup.close()
  }
  assert.equal(store.getActiveProject().projectId, project.projectId)
})
