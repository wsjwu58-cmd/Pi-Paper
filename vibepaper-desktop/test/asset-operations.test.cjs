const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')

const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex')
const JPEG_HEADER = Buffer.from('ffd8ff', 'hex')
function minimalWave() {
  const buffer = Buffer.alloc(46)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16_000, 24)
  buffer.writeUInt32LE(32_000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(2, 40)
  buffer.writeInt16LE(100, 44)
  return buffer
}

function audioOutputMeta() {
  return {
    index: 0,
    outputType: 'audio',
    voiceId: 'Test Voice',
    language: 'en-US',
    rate: 0,
    toneApplied: true,
    textHash: 'a'.repeat(64),
    durationMs: 1,
    sampleRate: 16_000,
    provider: 'local-sapi-tts',
  }
}

async function openTestProject(t) {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-asset-operations-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const opened = await store.createProject(parentDirectory, 'Asset Operations Test')
  return { store, parentDirectory, ...opened }
}

async function writeImage(parentDirectory, name, bytes) {
  const sourcePath = path.join(parentDirectory, name)
  await fs.writeFile(sourcePath, bytes)
  return sourcePath
}

test('local asset import detects image and WAV content, hashes it and tracks references', async (t) => {
  const { store, directory, parentDirectory, project } = await openTestProject(t)
  const imageBytes = Buffer.concat([PNG_HEADER, Buffer.from(' imported png payload')])
  const waveBytes = minimalWave()
  const imagePath = await writeImage(parentDirectory, 'cover.png', imageBytes)
  const wavePath = await writeImage(parentDirectory, 'voice.wav', waveBytes)
  const image = await store.importAsset(imagePath, project.projectId)
  await assert.rejects(store.importAsset(wavePath, project.projectId), /PNG、JPEG、GIF 和 WebP 图片/u)
  const audio = await store.importAsset(wavePath, project.projectId, 'local')
  const duplicateAudio = await store.importAsset(wavePath, project.projectId, 'local')

  assert.equal(image.assetType, 'image')
  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.name, 'cover.png')
  assert.equal(audio.assetType, 'audio')
  assert.equal(audio.mimeType, 'audio/wav')
  assert.equal(audio.name, 'voice.wav')
  assert.equal(duplicateAudio.assetId, audio.assetId, 'same-content import retains the existing SHA-256 deduplication behavior')
  assert.deepEqual(await fs.readFile((await store.resolveAsset(image.assetId)).filePath), imageBytes)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(audio.assetId)).filePath), waveBytes)

  const database = new DatabaseSync(path.join(directory, '.vibepaper', 'project.sqlite'), { readOnly: true })
  try {
    const rows = database.prepare('SELECT id, sha256, mime_type, relative_path FROM assets ORDER BY mime_type').all()
    assert.equal(rows.length, 2)
    assert.equal(rows.find((row) => row.id === image.assetId).sha256, createHash('sha256').update(imageBytes).digest('hex'))
    assert.equal(rows.find((row) => row.id === audio.assetId).sha256, createHash('sha256').update(waveBytes).digest('hex'))
    assert.match(rows.find((row) => row.id === audio.assetId).relative_path, /\.wav$/u)
  } finally {
    database.close()
  }

  const imageNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'imported-image-node',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: image.assetId },
  })
  const audioNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'imported-audio-node',
    expectedVersion: 1,
    type: 'audio',
    params: { assetId: audio.assetId },
  })
  const referencedAssets = await store.listAssets(project.projectId)
  assert.equal(referencedAssets.find((asset) => asset.assetId === image.assetId).referenceCount, 1)
  assert.equal(referencedAssets.find((asset) => asset.assetId === audio.assetId).referenceCount, 1)
})

test('imported WAV assets and audio references survive project backup and restore', async (t) => {
  const { store, parentDirectory, project } = await openTestProject(t)
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-audio-import-backup-'))
  const restoreParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-audio-import-restore-'))
  t.after(async () => {
    await fs.rm(backupParent, { recursive: true, force: true })
    await fs.rm(restoreParent, { recursive: true, force: true })
  })
  const imageBytes = Buffer.concat([PNG_HEADER, Buffer.from(' imported backup image')])
  const waveBytes = minimalWave()
  const imagePath = await writeImage(parentDirectory, 'backup-image.png', imageBytes)
  const wavePath = await writeImage(parentDirectory, 'restore-me.wav', waveBytes)
  const image = await store.importAsset(imagePath, project.projectId)
  const audio = await store.importAsset(wavePath, project.projectId, 'local')
  const imageNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'imported-image-backup-node',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: image.assetId },
  })
  const audioNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'imported-audio-backup-node',
    expectedVersion: 1,
    type: 'audio',
    params: { assetId: audio.assetId },
  })

  const backup = await store.backupProject(backupParent, project.projectId)
  const restored = await store.restoreBackup(backup.directory, restoreParent)
  const restoredAssets = await store.listAssets(restored.project.projectId)
  assert.equal(restoredAssets.find((asset) => asset.assetId === image.assetId).referenceCount, 1)
  assert.equal(restoredAssets.find((asset) => asset.assetId === audio.assetId).referenceCount, 1)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(image.assetId)).filePath), imageBytes)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(audio.assetId)).filePath), waveBytes)
  assert.deepEqual(store.loadCanvas(restored.project.projectId, restored.project.canvasId).nodes.map((node) => node.id), [
    imageNode.node.id,
    audioNode.node.id,
  ])
})

test('local asset import rejects unsupported or disguised file contents', async (t) => {
  const { store, parentDirectory, project } = await openTestProject(t)
  const disguisedPath = await writeImage(parentDirectory, 'not-really-audio.wav', Buffer.from('not a RIFF WAV or image'))
  await assert.rejects(store.importAsset(disguisedPath, project.projectId, 'local'), /本地 WAV 素材/u)
  assert.deepEqual(await store.listAssets(project.projectId), [])
})

test('image assets can be renamed, replaced in place and logically deleted with reference impact', async (t) => {
  const { store, parentDirectory, project } = await openTestProject(t)
  const originalBytes = Buffer.concat([PNG_HEADER, Buffer.from(' original png payload')])
  const replacementBytes = Buffer.concat([JPEG_HEADER, Buffer.from(' replacement jpeg payload')])
  const originalPath = await writeImage(parentDirectory, 'original.png', originalBytes)
  const replacementPath = await writeImage(parentDirectory, 'replacement.jpg', replacementBytes)
  const first = await store.importAsset(originalPath, project.projectId)
  const second = await store.importAsset(replacementPath, project.projectId)

  const node = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'asset-reference-node',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: first.assetId },
  })
  const oldResolved = await store.resolveAsset(first.assetId)
  const renamed = await store.renameAsset(project.projectId, first.assetId, '主视觉')
  assert.equal(renamed.assetId, first.assetId)
  assert.equal(renamed.name, '主视觉')
  assert.equal(renamed.createdAt, first.createdAt)
  assert.equal((await store.listAssets(project.projectId)).find((asset) => asset.assetId === first.assetId).referenceCount, 1)

  const replaced = await store.replaceAsset(project.projectId, first.assetId, replacementPath)
  assert.equal(replaced.assetId, first.assetId)
  assert.equal(replaced.mimeType, 'image/jpeg')
  assert.equal(replaced.name, 'replacement.jpg')
  assert.equal(replaced.referenceCount, 1)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(first.assetId)).filePath), replacementBytes)
  await assert.rejects(fs.access(oldResolved.filePath))

  const assetsAfterReplace = await store.listAssets(project.projectId)
  assert.equal(assetsAfterReplace.length, 2, 'replacement may share content hash while preserving both asset identities')
  assert.equal(assetsAfterReplace.filter((asset) => asset.mimeType === 'image/jpeg').length, 2)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).nodes[0].id, node.node.id)

  const deleted = await store.deleteAsset(project.projectId, first.assetId)
  assert.deepEqual(deleted, {
    deletedAssetId: first.assetId,
    references: [{ canvasId: project.canvasId, nodeId: node.node.id, type: 'canvas' }],
  })
  assert.deepEqual((await store.listAssets(project.projectId)).map((asset) => asset.assetId), [second.assetId])
  assert.deepEqual(await fs.readFile((await store.resolveAsset(first.assetId)).filePath), replacementBytes,
    'soft deletion keeps an existing canvas reference readable')
  await assert.rejects(store.renameAsset(project.projectId, first.assetId, '再次重命名'), /本地素材不存在/u)
  await assert.rejects(store.deleteAsset(project.projectId, first.assetId), /本地素材不存在/u)
  await assert.rejects(store.replaceAsset('wrong-project', second.assetId, originalPath), /当前项目已更改/u)
  await assert.rejects(store.renameAsset(project.projectId, second.assetId, '   '), /素材名称/u)
})

test('project schema v5 migrates assets and references to soft-delete metadata before operations', async (t) => {
  const { store, directory, parentDirectory, project } = await openTestProject(t)
  const sourcePath = await writeImage(parentDirectory, 'legacy.png', Buffer.concat([PNG_HEADER, Buffer.from(' legacy payload')]))
  const asset = await store.importAsset(sourcePath, project.projectId)
  const node = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'legacy-asset-reference-node',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: asset.assetId },
  })
  await store.close()

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE assets_v5 (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO assets_v5 (id, sha256, original_name, mime_type, size_bytes, relative_path, created_at)
        SELECT id, sha256, original_name, mime_type, size_bytes, relative_path, created_at FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_v5 RENAME TO assets;
      PRAGMA user_version = 5;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `)
  } finally {
    database.close()
  }

  await store.openProject(directory)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).nodes[0].id, node.node.id)
  const migrated = (await store.listAssets(project.projectId))[0]
  assert.equal(migrated.assetId, asset.assetId)
  assert.equal(migrated.updatedAt, migrated.createdAt)
  assert.equal(migrated.referenceCount, 1)
  assert.ok(await store.resolveAsset(asset.assetId))

  const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get().user_version), 8)
    assert.deepEqual(migratedDatabase.prepare('PRAGMA foreign_key_check').all(), [])
    const columns = migratedDatabase.prepare('PRAGMA table_info(assets)').all().map((row) => row.name)
    assert.ok(columns.includes('updated_at'))
    assert.ok(columns.includes('deleted'))
    const backupName = (await fs.readdir(path.join(directory, '.vibepaper', 'backups')))
      .find((name) => name.startsWith('project-schema-v5-'))
    assert.ok(backupName, 'v5 database backup exists before migration')
  } finally {
    migratedDatabase.close()
  }
})

test('project schema v7 migrates image assets and references to v8 with a rollback snapshot', async (t) => {
  const { store, directory, parentDirectory, project } = await openTestProject(t)
  const sourcePath = await writeImage(parentDirectory, 'v7-image.png', Buffer.concat([PNG_HEADER, Buffer.from(' v7 payload')]))
  const asset = await store.importAsset(sourcePath, project.projectId)
  const node = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'v7-image-reference-node',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: asset.assetId },
  })
  await store.close()

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE assets_v7 (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
      ) STRICT;
      INSERT INTO assets_v7 SELECT id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_v7 RENAME TO assets;
      CREATE INDEX assets_by_sha ON assets(sha256, deleted);
      PRAGMA user_version = 7;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `)
  } finally {
    database.close()
  }

  await store.openProject(directory)
  assert.equal((await store.listAssets(project.projectId))[0].assetId, asset.assetId)
  assert.equal((await store.listAssets(project.projectId))[0].referenceCount, 1)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).nodes[0].id, node.node.id)

  const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get().user_version), 8)
    assert.deepEqual(migratedDatabase.prepare('PRAGMA foreign_key_check').all(), [])
    const backupName = (await fs.readdir(path.join(directory, '.vibepaper', 'backups')))
      .find((name) => name.startsWith('project-schema-v7-'))
    assert.ok(backupName, 'v7 database backup exists before migration')
    const backupDatabase = new DatabaseSync(path.join(directory, '.vibepaper', 'backups', backupName), { readOnly: true })
    try {
      assert.equal(Number(backupDatabase.prepare('PRAGMA user_version').get().user_version), 7)
      assert.match(backupDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get().sql,
        /image\/webp/u)
      assert.doesNotMatch(backupDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get().sql,
        /audio\/wav/u)
    } finally {
      backupDatabase.close()
    }
  } finally {
    migratedDatabase.close()
  }
})

test('asset operations are exposed through project-scoped IPC and a path-restricted preload bridge', async () => {
  const root = path.resolve(__dirname, '..', '..')
  const read = (relativePath) => fs.readFile(path.join(root, relativePath), 'utf8')
  const [localCore, main, preload, bridgeTypes] = await Promise.all([
    read('vibepaper-desktop/src/local-core.cjs'),
    read('vibepaper-desktop/src/main.cjs'),
    read('vibepaper-desktop/src/preload.cjs'),
    read('vibepaper-web/src/desktop/desktop-bridge.d.ts'),
  ])

  assert.match(localCore, /case 'asset:rename':\s+return store\.renameAsset/u)
  assert.match(localCore, /case 'asset:replace':\s+return store\.replaceAsset/u)
  assert.match(localCore, /case 'asset:delete':\s+return store\.deleteAsset/u)
  assert.match(main, /desktop:asset:rename',[\s\S]*assertAssetId\(assetId\)[\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:rename'/u)
  assert.match(main, /desktop:asset:replace-image',[\s\S]*dialog\.showOpenDialog[\s\S]*localCore\.request\('asset:replace'/u)
  assert.match(main, /desktop:asset:import-image',[\s\S]*localCore\.request\('asset:import', \{ sourcePath: result\.filePaths\[0\], projectId, assetKind: 'image' \}/u)
  assert.match(main, /desktop:asset:import-local',[\s\S]*assertTrustedSender\(event\)[\s\S]*extensions: \['png', 'jpg', 'jpeg', 'gif', 'webp', 'wav'\][\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:import', \{ sourcePath: result\.filePaths\[0\], projectId, assetKind: 'local' \}/u)
  assert.match(main, /desktop:asset:delete',[\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:delete'/u)
  assert.match(preload, /renameAsset: \(projectId, assetId, name\) => ipcRenderer\.invoke\('desktop:asset:rename'/u)
  assert.match(preload, /replaceImage: \(projectId, assetId\) => ipcRenderer\.invoke\('desktop:asset:replace-image'/u)
  assert.match(preload, /importLocalAsset: \(projectId\) => ipcRenderer\.invoke\('desktop:asset:import-local', projectId\)/u)
  assert.match(localCore, /case 'asset:import':[\s\S]*assetKind !== 'image' && assetKind !== 'local'[\s\S]*store\.importAsset\(payload\.sourcePath, payload\.projectId, assetKind\)/u)
  assert.match(preload, /deleteAsset: \(projectId, assetId\) => ipcRenderer\.invoke\('desktop:asset:delete'/u)
  assert.match(main, /desktop:asset:save-task-output',[\s\S]*assertTrustedSender\(event\)[\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:save-task-output', \{ projectId, taskId \}/u)
  assert.match(preload, /saveTaskOutputToLibrary: \(projectId, taskId\) => ipcRenderer\.invoke\('desktop:asset:save-task-output', projectId, taskId\)/u)
  assert.match(localCore, /case 'asset:save-task-output':[\s\S]*store\.saveTaskOutputToLibrary\(payload\.projectId, payload\.taskId\)/u)
  assert.match(bridgeTypes, /saveTaskOutputToLibrary\(projectId: string, taskId: string\): Promise<DesktopAsset>/u)
  assert.match(bridgeTypes, /'audio\/wav'/u)
  assert.match(bridgeTypes, /renameAsset\(projectId: string, assetId: string, name: string\): Promise<DesktopAsset>/u)
  assert.match(bridgeTypes, /replaceImage\(projectId: string, assetId: string\): Promise<DesktopAsset \| null>/u)
  assert.match(bridgeTypes, /deleteAsset\(projectId: string, assetId: string\): Promise<DesktopAssetDeleteImpact>/u)
})

test('successful verified task WAVs become separate audio assets with durable node references and backup restore', async (t) => {
  const { store, project } = await openTestProject(t)
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-audio-backup-'))
  const restoreParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-audio-restore-'))
  t.after(async () => {
    await fs.rm(backupParent, { recursive: true, force: true })
    await fs.rm(restoreParent, { recursive: true, force: true })
  })
  const input = {
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 0,
    nodeId: null,
    modality: 'audio',
    providerType: 'local',
    providerId: 'local-sapi-tts',
    modelId: 'local-sapi-tts',
    idempotencyKey: 'asset-output-audio',
    parameters: { prompt: 'Hello.' },
  }
  const task = await store.createTask(input)
  const claimed = await store.claimNextTask(project.projectId)
  const wave = minimalWave()
  await fs.writeFile(path.join(claimed.outputDirectory, 'result.wav'), wave)
  const resultPath = `generated/${task.taskId}/result.wav`
  await store.recordTaskSucceeded(project.projectId, task.taskId, resultPath, audioOutputMeta())

  await assert.rejects(store.saveTaskOutputToLibrary('another-project', task.taskId), /当前项目已更改/u)
  await assert.rejects(store.saveTaskOutputToLibrary(project.projectId, 'not-a-task-id'), /任务标识无效/u)
  const first = await store.saveTaskOutputToLibrary(project.projectId, task.taskId)
  const second = await store.saveTaskOutputToLibrary(project.projectId, task.taskId)
  assert.notEqual(first.assetId, second.assetId, 'each explicit save creates an asset record')
  assert.equal(first.assetType, 'audio')
  assert.equal(first.mimeType, 'audio/wav')
  assert.equal(first.name, `task-${task.taskId}-output.wav`)
  assert.equal(first.sizeBytes, wave.length)
  assert.equal(first.referenceCount, 0)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(first.assetId)).filePath), wave)

  const audioNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'audio-asset-node',
    expectedVersion: 0,
    type: 'audio',
    params: { assetId: first.assetId, prompt: '' },
  })
  assert.equal((await store.listAssets(project.projectId)).find((asset) => asset.assetId === first.assetId).referenceCount, 1)

  const backup = await store.backupProject(backupParent, project.projectId)
  const restored = await store.restoreBackup(backup.directory, restoreParent)
  const restoredAssets = await store.listAssets(restored.project.projectId)
  const restoredAudio = restoredAssets.find((asset) => asset.assetId === first.assetId)
  assert.ok(restoredAudio)
  assert.equal(restoredAudio.assetType, 'audio')
  assert.equal(restoredAudio.mimeType, 'audio/wav')
  assert.equal(restoredAudio.referenceCount, 1)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(first.assetId)).filePath), wave)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(second.assetId)).filePath), wave)
  const impact = await store.deleteAsset(restored.project.projectId, first.assetId)
  assert.deepEqual(impact.references, [{ canvasId: restored.project.canvasId, nodeId: audioNode.node.id, type: 'canvas' }])
  assert.deepEqual(await fs.readFile((await store.resolveAsset(first.assetId)).filePath), wave,
    'soft deletion preserves referenced audio files')
})

test('saving audio task output rejects non-WAV bytes and changed task output', async (t) => {
  const { store, project } = await openTestProject(t)
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 0,
    nodeId: null,
    modality: 'audio',
    providerType: 'local',
    providerId: 'local-sapi-tts',
    modelId: 'local-sapi-tts',
    idempotencyKey: 'asset-output-invalid-audio',
    parameters: { prompt: 'Hello.' },
  })
  const claimed = await store.claimNextTask(project.projectId)
  await fs.writeFile(path.join(claimed.outputDirectory, 'result.wav'), Buffer.from('not a wav'))
  await store.recordTaskSucceeded(project.projectId, task.taskId, `generated/${task.taskId}/result.wav`, audioOutputMeta())
  await assert.rejects(store.saveTaskOutputToLibrary(project.projectId, task.taskId), /本地 WAV 素材/u)

  await fs.writeFile(path.join(claimed.outputDirectory, 'result.wav'), minimalWave())
  await assert.rejects(store.saveTaskOutputToLibrary(project.projectId, task.taskId), /任务音频结果校验失败/u)
  assert.equal((await store.listAssets(project.projectId)).length, 0)
})
