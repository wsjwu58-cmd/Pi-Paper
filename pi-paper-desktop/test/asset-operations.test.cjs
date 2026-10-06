const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const test = require('node:test')
const vm = require('node:vm')
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

function minimalMp3() {
  const frameLength = 417
  const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x64])
  const frames = Buffer.alloc(frameLength * 2)
  frameHeader.copy(frames, 0)
  frameHeader.copy(frames, frameLength)
  return frames
}

function id3Mp3() {
  const tagBody = Buffer.from('metadata')
  const id3Header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, tagBody.length])
  return Buffer.concat([id3Header, tagBody, minimalMp3()])
}

function minimalFtyp(brand = 'isom') {
  const buffer = Buffer.alloc(24)
  buffer.writeUInt32BE(buffer.length, 0)
  buffer.write('ftyp', 4, 'ascii')
  buffer.write(brand, 8, 'ascii')
  buffer.writeUInt32BE(0, 12)
  buffer.write('isom', 16, 'ascii')
  buffer.write('mp42', 20, 'ascii')
  return buffer
}

function minimalWebm() {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('webm test payload')])
}

function minimalWebp() {
  const buffer = Buffer.alloc(16)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WEBP', 8, 'ascii')
  buffer.write('VP8 ', 12, 'ascii')
  return buffer
}

function minimalOgg() {
  return Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24)])
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

async function createMainIpcHarness({ devServerUrl } = {}) {
  const root = path.resolve(__dirname, '..', '..')
  const source = await fs.readFile(path.join(root, 'pi-paper-desktop/src/main.cjs'), 'utf8')
  const handlers = new Map()
  const protocolHandlers = new Map()
  const registeredSchemes = []
  const headerHandlers = []
  const electron = {
    app: { setName() {}, setPath() {}, requestSingleInstanceLock: () => false, quit() {}, getPath: (name) => name === 'temp' ? os.tmpdir() : os.tmpdir() },
    BrowserWindow: class {},
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({}) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    net: {},
    protocol: {
      registerSchemesAsPrivileged: (schemes) => registeredSchemes.push(...schemes),
      handle: (scheme, handler) => protocolHandlers.set(scheme, handler),
    },
    safeStorage: {},
    session: { defaultSession: { webRequest: { onHeadersReceived: (handler) => headerHandlers.push(handler) } } },
    utilityProcess: {},
  }
  const mainRequire = (name) => {
    if (name === 'electron') return electron
    if (name === './renderer-trust.cjs') return require('../src/renderer-trust.cjs')
    if (name === './canvas-media.cjs') return require('../src/canvas-media.cjs')
    if (name.startsWith('.')) return {}
    return require(name)
  }
  const context = vm.createContext({
    require: mainRequire,
    process: { env: devServerUrl ? { VITE_DEV_SERVER_URL: devServerUrl } : {} },
    __dirname: path.join(root, 'pi-paper-desktop', 'src'),
    URL,
    Request,
    Response,
    Headers,
    Buffer,
    console,
  })
  vm.runInContext(source, context, { filename: 'pi-paper-desktop/src/main.cjs' })
  vm.runInContext('registerProjectIpc(); registerContentSecurityPolicy(); registerRendererProtocol()', context)

  const frame = { url: devServerUrl || 'vibe://app/' }
  const sender = { mainFrame: frame }
  context.__testSender = sender
  vm.runInContext('mainWindow = { webContents: __testSender }', context)

  return {
    handlers,
    protocolHandlers,
    registeredSchemes,
    headerHandlers,
    electron,
    event: { sender, senderFrame: frame },
    setLocalCore(localCore) {
      context.__testLocalCore = localCore
      vm.runInContext('localCore = __testLocalCore', context)
    },
  }
}

async function createLegacyParamsReferenceFixture(t) {
  const context = await openTestProject(t)
  const imagePath = await writeImage(context.parentDirectory, 'legacy-reference.png', Buffer.concat([PNG_HEADER, Buffer.from(' legacy image')]))
  const alternateImagePath = await writeImage(context.parentDirectory, 'alternate-reference.png', Buffer.concat([PNG_HEADER, Buffer.from(' alternate image')]))
  const wavePath = await writeImage(context.parentDirectory, 'legacy-reference.wav', minimalWave())
  const image = await context.store.importAsset(imagePath, context.project.projectId)
  const alternateImage = await context.store.importAsset(alternateImagePath, context.project.projectId)
  const audio = await context.store.importAsset(wavePath, context.project.projectId, 'local')
  const imageNode = await context.store.createNode({
    projectId: context.project.projectId,
    canvasId: context.project.canvasId,
    idempotencyKey: 'legacy-params-image-reference',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: image.assetId },
  })
  const audioNode = await context.store.createNode({
    projectId: context.project.projectId,
    canvasId: context.project.canvasId,
    idempotencyKey: 'legacy-params-audio-reference',
    expectedVersion: 1,
    type: 'audio',
  })
  const textNode = await context.store.createNode({
    projectId: context.project.projectId,
    canvasId: context.project.canvasId,
    idempotencyKey: 'legacy-params-unreferenced-text',
    expectedVersion: 2,
    type: 'text',
  })
  await context.store.close()

  const databasePath = path.join(context.directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('BEGIN IMMEDIATE')
    const legacyAudioPayload = JSON.parse(database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
      .get(context.project.canvasId, audioNode.node.id).payload_json)
    legacyAudioPayload.data.params = { assetId: audio.assetId }
    database.prepare('UPDATE nodes SET payload_json = ? WHERE canvas_id = ? AND id = ?')
      .run(JSON.stringify(legacyAudioPayload), context.project.canvasId, audioNode.node.id)
    const legacyImagePayload = JSON.parse(database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
      .get(context.project.canvasId, imageNode.node.id).payload_json)
    delete legacyImagePayload.data.assetId
    database.prepare('UPDATE nodes SET payload_json = ? WHERE canvas_id = ? AND id = ?')
      .run(JSON.stringify(legacyImagePayload), context.project.canvasId, imageNode.node.id)
    database.prepare('DELETE FROM asset_references WHERE canvas_id = ? AND node_id IN (?, ?)')
      .run(context.project.canvasId, imageNode.node.id, audioNode.node.id)
    database.exec('PRAGMA user_version = 8; COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.close()
  }
  return { ...context, databasePath, image, alternateImage, audio, imageNode, audioNode, textNode }
}

async function mutateV8ProjectDatabase(databasePath, mutate) {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('BEGIN IMMEDIATE')
    await mutate(database)
    database.exec('PRAGMA user_version = 8; COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.close()
  }
}

async function mutateProjectToV9(databasePath) {
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE assets_v9 (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/wav')),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
      ) STRICT;
      INSERT INTO assets_v9 (id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted)
        SELECT id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_v9 RENAME TO assets;
      CREATE INDEX assets_by_sha ON assets(sha256, deleted);
      PRAGMA user_version = 9;
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
    database.close()
  }
}

async function mutateProjectToV10(databasePath) {
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      DROP TABLE task_outputs;
      CREATE TABLE assets_v10 (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN (
          'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/wav', 'audio/mpeg'
        )),
        size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 209715200),
        relative_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
      ) STRICT;
      INSERT INTO assets_v10 SELECT id, sha256, original_name, mime_type, size_bytes, relative_path, created_at, updated_at, deleted FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_v10 RENAME TO assets;
      CREATE INDEX assets_by_sha ON assets(sha256, deleted);
      PRAGMA user_version = 10;
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
    database.close()
  }
}

test('local asset import detects image, WAV and MP3 content, hashes it and tracks references', async (t) => {
  const { store, directory, parentDirectory, project } = await openTestProject(t)
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-duplicate-import-backup-'))
  const restoreParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-duplicate-import-restore-'))
  t.after(async () => {
    await fs.rm(backupParent, { recursive: true, force: true })
    await fs.rm(restoreParent, { recursive: true, force: true })
  })
  const imageBytes = Buffer.concat([PNG_HEADER, Buffer.from(' imported png payload')])
  const waveBytes = minimalWave()
  const mp3Bytes = id3Mp3()
  const imagePath = await writeImage(parentDirectory, 'cover.png', imageBytes)
  const wavePath = await writeImage(parentDirectory, 'voice.wav', waveBytes)
  const mp3Path = await writeImage(parentDirectory, 'voice.mp3', mp3Bytes)
  const image = await store.importAsset(imagePath, project.projectId)
  await assert.rejects(store.importAsset(wavePath, project.projectId), /PNG、JPEG、GIF 和 WebP 图片/u)
  const audio = await store.importAsset(wavePath, project.projectId, 'local')
  const duplicateAudio = await store.importAsset(wavePath, project.projectId, 'local')
  const mp3Audio = await store.importAsset(mp3Path, project.projectId, 'local')

  assert.equal(image.assetType, 'image')
  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.name, 'cover.png')
  assert.equal(audio.assetType, 'audio')
  assert.equal(audio.mimeType, 'audio/wav')
  assert.equal(audio.name, 'voice.wav')
  assert.equal(mp3Audio.assetType, 'audio')
  assert.equal(mp3Audio.mimeType, 'audio/mpeg')
  assert.equal(mp3Audio.name, 'voice.mp3')
  assert.notEqual(duplicateAudio.assetId, audio.assetId, 'each import creates an independent asset record')
  const audioResolved = await store.resolveAsset(audio.assetId)
  const duplicateAudioResolved = await store.resolveAsset(duplicateAudio.assetId)
  const mp3Resolved = await store.resolveAsset(mp3Audio.assetId)
  assert.notEqual(duplicateAudioResolved.filePath, audioResolved.filePath)
  assert.equal(mp3Resolved.mimeType, 'audio/mpeg', 'asset preview resolution retains the MPEG audio MIME type')
  assert.match(mp3Resolved.filePath, /\.mp3$/u)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(image.assetId)).filePath), imageBytes)
  assert.deepEqual(await fs.readFile(audioResolved.filePath), waveBytes)
  assert.deepEqual(await fs.readFile(duplicateAudioResolved.filePath), waveBytes)
  assert.deepEqual(await fs.readFile(mp3Resolved.filePath), mp3Bytes)

  const database = new DatabaseSync(path.join(directory, '.vibepaper', 'project.sqlite'), { readOnly: true })
  try {
    const rows = database.prepare('SELECT id, sha256, mime_type, relative_path FROM assets ORDER BY mime_type').all()
    assert.equal(rows.length, 4)
    assert.equal(rows.find((row) => row.id === image.assetId).sha256, createHash('sha256').update(imageBytes).digest('hex'))
    assert.equal(rows.find((row) => row.id === audio.assetId).sha256, createHash('sha256').update(waveBytes).digest('hex'))
    assert.equal(rows.find((row) => row.id === mp3Audio.assetId).sha256, createHash('sha256').update(mp3Bytes).digest('hex'))
    const duplicateAudioRow = rows.find((row) => row.id === duplicateAudio.assetId)
    const audioRow = rows.find((row) => row.id === audio.assetId)
    assert.equal(duplicateAudioRow.sha256, audioRow.sha256)
    assert.match(audioRow.relative_path, /\.wav$/u)
    assert.match(duplicateAudioRow.relative_path, /\.wav$/u)
    assert.notEqual(duplicateAudioRow.relative_path, audioRow.relative_path)
    assert.match(rows.find((row) => row.id === mp3Audio.assetId).relative_path, /\.mp3$/u)
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
  const duplicateAudioNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'imported-duplicate-audio-node',
    expectedVersion: 2,
    type: 'audio',
    params: { assetId: duplicateAudio.assetId },
  })
  const mp3Node = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'imported-mp3-audio-node',
    expectedVersion: 3,
    type: 'audio',
    params: { assetId: mp3Audio.assetId },
  })
  const referencedAssets = await store.listAssets(project.projectId)
  assert.equal(referencedAssets.find((asset) => asset.assetId === image.assetId).referenceCount, 1)
  assert.equal(referencedAssets.find((asset) => asset.assetId === audio.assetId).referenceCount, 1)
  assert.equal(referencedAssets.find((asset) => asset.assetId === duplicateAudio.assetId).referenceCount, 1)
  assert.equal(referencedAssets.find((asset) => asset.assetId === mp3Audio.assetId).referenceCount, 1)

  const deleted = await store.deleteAsset(project.projectId, audio.assetId)
  assert.deepEqual(deleted, {
    deletedAssetId: audio.assetId,
    references: [{ canvasId: project.canvasId, nodeId: audioNode.node.id, type: 'canvas' }],
  })
  const remainingAssets = await store.listAssets(project.projectId)
  assert.equal(remainingAssets.some((asset) => asset.assetId === audio.assetId), false)
  assert.equal(remainingAssets.find((asset) => asset.assetId === duplicateAudio.assetId).referenceCount, 1)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(duplicateAudio.assetId)).filePath), waveBytes)
  assert.ok(store.loadCanvas(project.projectId, project.canvasId).nodes.some((node) => node.id === duplicateAudioNode.node.id))

  const backup = await store.backupProject(backupParent, project.projectId)
  const restored = await store.restoreBackup(backup.directory, restoreParent)
  const restoredAssets = await store.listAssets(restored.project.projectId)
  assert.equal(restoredAssets.find((asset) => asset.assetId === duplicateAudio.assetId).referenceCount, 1)
  assert.equal(restoredAssets.find((asset) => asset.assetId === mp3Audio.assetId).referenceCount, 1)
  const restoredAudioPath = (await store.resolveAsset(audio.assetId)).filePath
  const restoredDuplicateAudioPath = (await store.resolveAsset(duplicateAudio.assetId)).filePath
  assert.notEqual(restoredAudioPath, restoredDuplicateAudioPath)
  assert.deepEqual(await fs.readFile(restoredAudioPath), waveBytes)
  assert.deepEqual(await fs.readFile(restoredDuplicateAudioPath), waveBytes)
  const restoredMp3 = await store.resolveAsset(mp3Audio.assetId)
  assert.equal(restoredMp3.mimeType, 'audio/mpeg')
  assert.match(restoredMp3.filePath, /\.mp3$/u)
  assert.deepEqual(await fs.readFile(restoredMp3.filePath), mp3Bytes)
  assert.ok(store.loadCanvas(restored.project.projectId, restored.project.canvasId).nodes.some((node) => node.id === mp3Node.node.id))
  assert.ok(store.loadCanvas(restored.project.projectId, restored.project.canvasId).nodes.some((node) => node.id === duplicateAudioNode.node.id))
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
  const disguisedMp3Path = await writeImage(parentDirectory, 'not-really-audio.mp3', Buffer.from('not an MPEG audio stream'.padEnd(40, ' ')))
  const truncatedFrame = Buffer.alloc(64)
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(truncatedFrame)
  const truncatedMp3Path = await writeImage(parentDirectory, 'truncated-frame.mp3', truncatedFrame)
  const layerTwoFrame = Buffer.alloc(834)
  Buffer.from([0xff, 0xfd, 0x90, 0x64]).copy(layerTwoFrame, 0)
  Buffer.from([0xff, 0xfd, 0x90, 0x64]).copy(layerTwoFrame, 417)
  const layerTwoPath = await writeImage(parentDirectory, 'mpeg-layer-two.mp3', layerTwoFrame)
  const id3OnlyPath = await writeImage(parentDirectory, 'id3-only.mp3', Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ...Buffer.alloc(32),
  ]))
  const truncatedId3Path = await writeImage(parentDirectory, 'truncated-id3.mp3', Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00,
    ...Buffer.alloc(24),
  ]))
  await assert.rejects(store.importAsset(disguisedPath, project.projectId, 'local'), /本地 WAV 素材/u)
  await assert.rejects(store.importAsset(disguisedMp3Path, project.projectId, 'local'), /有效 MPEG 音频帧/u)
  await assert.rejects(store.importAsset(truncatedMp3Path, project.projectId, 'local'), /MPEG 音频帧已截断/u)
  await assert.rejects(store.importAsset(layerTwoPath, project.projectId, 'local'), /有效 MPEG 音频帧/u)
  await assert.rejects(store.importAsset(id3OnlyPath, project.projectId, 'local'), /有效 MPEG 音频帧/u)
  await assert.rejects(store.importAsset(truncatedId3Path, project.projectId, 'local'), /ID3v2 标记已截断/u)
  assert.deepEqual(await store.listAssets(project.projectId), [])
})

test('image, video, audio and text imports validate formats, keep node references and survive backup restore', async (t) => {
  const { store, parentDirectory, project } = await openTestProject(t)
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-all-assets-backup-'))
  const restoreParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-all-assets-restore-'))
  t.after(async () => {
    await fs.rm(backupParent, { recursive: true, force: true })
    await fs.rm(restoreParent, { recursive: true, force: true })
  })

  const formats = [
    { name: 'asset.png', bytes: Buffer.concat([PNG_HEADER, Buffer.from(' png')]), mimeType: 'image/png', assetType: 'image' },
    { name: 'asset.jpg', bytes: Buffer.concat([JPEG_HEADER, Buffer.from(' jpeg')]), mimeType: 'image/jpeg', assetType: 'image' },
    { name: 'asset.gif', bytes: Buffer.from('GIF89a animation fixture'), mimeType: 'image/gif', assetType: 'image' },
    { name: 'asset.webp', bytes: minimalWebp(), mimeType: 'image/webp', assetType: 'image' },
    { name: 'asset.mp4', bytes: minimalFtyp('isom'), mimeType: 'video/mp4', assetType: 'video' },
    { name: 'asset.mov', bytes: minimalFtyp('qt  '), mimeType: 'video/quicktime', assetType: 'video' },
    { name: 'asset.webm', bytes: minimalWebm(), mimeType: 'video/webm', assetType: 'video' },
    { name: 'asset.wav', bytes: minimalWave(), mimeType: 'audio/wav', assetType: 'audio' },
    { name: 'asset.mp3', bytes: id3Mp3(), mimeType: 'audio/mpeg', assetType: 'audio' },
    { name: 'asset.ogg', bytes: minimalOgg(), mimeType: 'audio/ogg', assetType: 'audio' },
    { name: 'asset.m4a', bytes: minimalFtyp('M4A '), mimeType: 'audio/mp4', assetType: 'audio' },
    { name: 'asset.txt', bytes: Buffer.from('plain UTF-8 text\n'), mimeType: 'text/plain', assetType: 'text' },
    { name: 'asset.md', bytes: Buffer.from('# Markdown\n'), mimeType: 'text/markdown', assetType: 'text' },
  ]
  const assets = []
  for (const format of formats) {
    const sourcePath = await writeImage(parentDirectory, format.name, format.bytes)
    const asset = await store.importAsset(sourcePath, project.projectId, 'local')
    assert.equal(asset.mimeType, format.mimeType, format.name)
    assert.equal(asset.assetType, format.assetType, format.name)
    assert.deepEqual(await fs.readFile((await store.resolveAsset(asset.assetId)).filePath), format.bytes)
    assets.push(asset)
  }

  const referencedKinds = [
    { type: 'image', asset: assets[0] },
    { type: 'video', asset: assets[4] },
    { type: 'audio', asset: assets[7] },
    { type: 'text', asset: assets[11] },
  ]
  const nodes = []
  for (let index = 0; index < referencedKinds.length; index += 1) {
    const entry = referencedKinds[index]
    const created = await store.createNode({
      projectId: project.projectId,
      canvasId: project.canvasId,
      idempotencyKey: `all-media-reference-${entry.type}`,
      expectedVersion: index,
      type: entry.type,
      params: { assetId: entry.asset.assetId },
    })
    nodes.push(created.node.id)
  }
  await assert.rejects(store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'all-media-invalid-reference',
    expectedVersion: referencedKinds.length,
    type: 'text',
    params: { assetId: assets[7].assetId },
  }), /类型不匹配/u)
  assert.equal((await store.listAssets(project.projectId)).find((asset) => asset.assetId === assets[11].assetId).referenceCount, 1)

  const backup = await store.backupProject(backupParent, project.projectId)
  const restored = await store.restoreBackup(backup.directory, restoreParent)
  const restoredAssets = await store.listAssets(restored.project.projectId)
  assert.equal(restoredAssets.length, formats.length)
  for (let index = 0; index < formats.length; index += 1) {
    const format = formats[index]
    const restoredAsset = restoredAssets.find((entry) => entry.assetId === assets[index].assetId)
    assert.equal(restoredAsset.mimeType, format.mimeType, format.name)
    assert.equal(restoredAsset.assetType, format.assetType, format.name)
    assert.deepEqual(await fs.readFile((await store.resolveAsset(restoredAsset.assetId)).filePath), format.bytes)
  }
  const restoredCanvas = store.loadCanvas(restored.project.projectId, restored.project.canvasId)
  assert.deepEqual(restoredCanvas.nodes.map((node) => node.id), nodes)
  assert.equal(restoredAssets.find((entry) => entry.assetId === assets[11].assetId).referenceCount, 1)
})

test('director capture IPC validates local PNG bytes and imports them only for an existing director node', async () => {
  const harness = await createMainIpcHarness()
  const assetId = 'f1bbdc54-d75e-4329-9e4d-495d1b32da40'
  const project = { projectId: 'project-1', canvasId: 'canvas-1' }
  const png = Buffer.concat([PNG_HEADER, Buffer.from('director capture')])
  let targetType = 'director'
  let importedBytes
  let importedPath
  let imports = 0
  harness.setLocalCore({
    async request(method, payload) {
      if (method === 'project:get-active') return project
      if (method === 'canvas:load') return { nodes: [{ id: 'director-node', type: targetType }] }
      assert.equal(method, 'asset:import')
      assert.equal(payload.projectId, project.projectId)
      assert.equal(payload.assetKind, 'image')
      importedPath = payload.sourcePath
      importedBytes = await fs.readFile(payload.sourcePath)
      imports += 1
      return { assetId, assetType: 'image', mimeType: 'image/png' }
    },
  })

  const save = harness.handlers.get('desktop:asset:save-director-capture')
  const result = JSON.parse(JSON.stringify(await save(harness.event, {
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: 'director-node',
    pngBytes: new Uint8Array(png),
  })))
  assert.deepEqual(result, { assetId, url: `vibe://app/assets/${assetId}` })
  assert.deepEqual(importedBytes, png)
  await assert.rejects(fs.stat(importedPath), { code: 'ENOENT' }, 'the IPC temp file is removed after local import')

  await assert.rejects(save(harness.event, {
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: 'director-node',
    pngBytes: Buffer.from('not a PNG'),
  }), /必须是有效 PNG/u)
  targetType = 'image'
  await assert.rejects(save(harness.event, {
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: 'director-node',
    pngBytes: new Uint8Array(png),
  }), /导演台节点已不存在/u)
  assert.equal(imports, 1, 'invalid bytes or a non-director node never reach asset import')
})

test('director photo assets are referenced by the node, affect deletion, and survive project backup restore', async (t) => {
  const { store, parentDirectory, project } = await openTestProject(t)
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-director-backup-'))
  const restoreParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-director-restore-'))
  t.after(async () => {
    await fs.rm(backupParent, { recursive: true, force: true })
    await fs.rm(restoreParent, { recursive: true, force: true })
  })
  const firstPhotoBytes = Buffer.concat([PNG_HEADER, Buffer.from('director scene photo one')])
  const secondPhotoBytes = Buffer.concat([PNG_HEADER, Buffer.from('director scene photo two')])
  const latestPhotoBytes = Buffer.concat([PNG_HEADER, Buffer.from('director scene photo latest')])
  const firstPhotoPath = await writeImage(parentDirectory, 'director-capture-one.png', firstPhotoBytes)
  const secondPhotoPath = await writeImage(parentDirectory, 'director-capture-two.png', secondPhotoBytes)
  const latestPhotoPath = await writeImage(parentDirectory, 'director-capture-latest.png', latestPhotoBytes)
  const firstPhoto = await store.importAsset(firstPhotoPath, project.projectId, 'image')
  const secondPhoto = await store.importAsset(secondPhotoPath, project.projectId, 'image')
  const latestPhoto = await store.importAsset(latestPhotoPath, project.projectId, 'image')
  const firstPhotoUrl = `vibe://app/assets/${firstPhoto.assetId}`
  const secondPhotoUrl = `vibe://app/assets/${secondPhoto.assetId}`
  const latestPhotoUrl = `vibe://app/assets/${latestPhoto.assetId}`
  const director = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'director-photo-reference',
    expectedVersion: 0,
    type: 'director',
    params: {
      assetId: latestPhoto.assetId,
      url: latestPhotoUrl,
      lastOutputUrl: latestPhotoUrl,
      captures: [firstPhotoUrl, secondPhotoUrl, latestPhotoUrl],
    },
  })
  const image = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'director-photo-image-consumer',
    expectedVersion: 1,
    type: 'image',
    params: { prompt: 'Use the director photo as composition reference.' },
  })
  await store.connectEdge({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 2,
    idempotencyKey: 'director-photo-reference-edge',
    sourceNodeId: director.node.id,
    targetNodeId: image.node.id,
  })
  const canvas = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(canvas.edges[0].data.valid, true, 'director outputs can feed image nodes')
  const referencesBeforeUpdate = await store.listAssets(project.projectId)
  for (const photo of [firstPhoto, secondPhoto, latestPhoto]) {
    assert.equal(referencesBeforeUpdate.find((item) => item.assetId === photo.assetId).referenceCount, 1)
  }
  const backup = await store.backupProject(backupParent, project.projectId)
  const updated = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: director.node.id,
    idempotencyKey: 'director-remove-old-photo-reference',
    expectedVersion: 3,
    params: {
      ...canvas.nodes.find((node) => node.id === director.node.id).data.params,
      captures: [firstPhotoUrl, latestPhotoUrl],
      assetId: latestPhoto.assetId,
      url: latestPhotoUrl,
      lastOutputUrl: latestPhotoUrl,
    },
  })
  assert.equal(updated.version, 4)
  assert.equal((await store.listAssets(project.projectId)).find((item) => item.assetId === secondPhoto.assetId).referenceCount, 0,
    'updating the gallery removes references for photos no longer in captures')
  const removedPhotoImpact = await store.deleteAsset(project.projectId, secondPhoto.assetId)
  assert.deepEqual(removedPhotoImpact.references, [])

  const impact = await store.deleteAsset(project.projectId, firstPhoto.assetId)
  assert.deepEqual(impact.references, [{ canvasId: project.canvasId, nodeId: director.node.id, type: 'canvas' }])
  const restored = await store.restoreBackup(backup.directory, restoreParent)
  const restoredAsset = (await store.listAssets(restored.project.projectId)).find((item) => item.assetId === firstPhoto.assetId)
  assert.equal(restoredAsset?.referenceCount, 1)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(firstPhoto.assetId)).filePath), firstPhotoBytes)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(secondPhoto.assetId)).filePath), secondPhotoBytes)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(latestPhoto.assetId)).filePath), latestPhotoBytes)
  const restoredCanvas = store.loadCanvas(restored.project.projectId, restored.project.canvasId)
  const restoredDirector = restoredCanvas.nodes.find((node) => node.id === director.node.id)
  assert.equal(restoredDirector?.data.params.assetId, latestPhoto.assetId)
  assert.deepEqual(restoredDirector?.data.params.captures, [firstPhotoUrl, secondPhotoUrl, latestPhotoUrl])
  const restoredAssets = await store.listAssets(restored.project.projectId)
  for (const photo of [firstPhoto, secondPhoto, latestPhoto]) {
    assert.equal(restoredAssets.find((item) => item.assetId === photo.assetId).referenceCount, 1)
  }
  assert.equal(restoredCanvas.edges[0].data.valid, true)
})

test('project schema v12 migrates director capture gallery references with a rollback snapshot', async (t) => {
  const { store, parentDirectory, directory, project } = await openTestProject(t)
  const firstPhotoPath = await writeImage(parentDirectory, 'schema-v12-director-one.png', Buffer.concat([PNG_HEADER, Buffer.from('photo one')]))
  const latestPhotoPath = await writeImage(parentDirectory, 'schema-v12-director-latest.png', Buffer.concat([PNG_HEADER, Buffer.from('photo latest')]))
  const firstPhoto = await store.importAsset(firstPhotoPath, project.projectId, 'image')
  const latestPhoto = await store.importAsset(latestPhotoPath, project.projectId, 'image')
  const firstPhotoUrl = `vibe://app/assets/${firstPhoto.assetId}`
  const latestPhotoUrl = `vibe://app/assets/${latestPhoto.assetId}`
  const director = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'schema-v12-director-gallery',
    expectedVersion: 0,
    type: 'director',
    params: {
      assetId: latestPhoto.assetId,
      captures: [firstPhotoUrl, latestPhotoUrl],
      url: latestPhotoUrl,
      lastOutputUrl: latestPhotoUrl,
    },
  })
  await store.close()

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const legacyDatabase = new DatabaseSync(databasePath)
  legacyDatabase.exec('PRAGMA foreign_keys = OFF')
  try {
    legacyDatabase.exec('BEGIN IMMEDIATE')
    legacyDatabase.exec(`
      DROP INDEX IF EXISTS asset_references_by_asset;
      ALTER TABLE asset_references RENAME TO asset_references_v13;
      CREATE TABLE asset_references (
        canvas_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        PRIMARY KEY (canvas_id, node_id),
        FOREIGN KEY (canvas_id, node_id) REFERENCES nodes(canvas_id, id) ON DELETE CASCADE,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT
      ) STRICT;
      INSERT INTO asset_references (canvas_id, node_id, asset_id)
        SELECT canvas_id, node_id, asset_id FROM asset_references_v13 WHERE asset_id = '${latestPhoto.assetId}';
      DROP TABLE asset_references_v13;
      CREATE INDEX asset_references_by_asset ON asset_references(asset_id);
      PRAGMA user_version = 12;
      COMMIT;
    `)
  } catch (error) {
    legacyDatabase.exec('ROLLBACK')
    throw error
  } finally {
    legacyDatabase.exec('PRAGMA foreign_keys = ON')
    legacyDatabase.close()
  }

  await store.openProject(directory)
  const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true })
  let migrationBackup
  try {
    assert.equal(migratedDatabase.prepare('PRAGMA user_version').get().user_version, 17)
    assert.deepEqual(migratedDatabase.prepare('PRAGMA foreign_key_check').all(), [])
    const primaryKeyColumns = migratedDatabase.prepare('PRAGMA table_info(asset_references)').all()
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name)
    assert.deepEqual(primaryKeyColumns, ['canvas_id', 'node_id', 'asset_id'])
    assert.deepEqual(migratedDatabase.prepare(`
      SELECT asset_id FROM asset_references WHERE canvas_id = ? AND node_id = ? ORDER BY asset_id
    `).all(project.canvasId, director.node.id).map((row) => row.asset_id), [firstPhoto.assetId, latestPhoto.assetId].sort())
    const backupNames = (await fs.readdir(path.join(directory, '.vibepaper', 'backups')))
      .filter((name) => name.startsWith('project-schema-v12-'))
    assert.equal(backupNames.length, 1, 'migration keeps a single v12 rollback snapshot')
    migrationBackup = path.join(directory, '.vibepaper', 'backups', backupNames[0])
  } finally {
    migratedDatabase.close()
  }

  const migratedAssets = await store.listAssets(project.projectId)
  assert.equal(migratedAssets.find((asset) => asset.assetId === firstPhoto.assetId).referenceCount, 1)
  assert.equal(migratedAssets.find((asset) => asset.assetId === latestPhoto.assetId).referenceCount, 1)
  assert.deepEqual((await store.deleteAsset(project.projectId, firstPhoto.assetId)).references, [
    { canvasId: project.canvasId, nodeId: director.node.id, type: 'canvas' },
  ])

  const rollbackDatabase = new DatabaseSync(migrationBackup, { readOnly: true })
  try {
    assert.equal(rollbackDatabase.prepare('PRAGMA user_version').get().user_version, 12)
    assert.equal(rollbackDatabase.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 1,
      'the rollback snapshot retains the original one-reference schema state')
    assert.deepEqual(rollbackDatabase.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    rollbackDatabase.close()
  }

  await store.close()
  await store.openProject(directory)
  const reopenedAssets = await store.listAssets(project.projectId)
  assert.equal(reopenedAssets.find((asset) => asset.assetId === latestPhoto.assetId).referenceCount, 1,
    'opening schema v13 again leaves migrated references intact')
})

test('project schema v9 enables validated MP3 assets with a v9 rollback snapshot', async (t) => {
  const { store, directory, parentDirectory, project } = await openTestProject(t)
  const imagePath = await writeImage(parentDirectory, 'schema-v9-image.png', Buffer.concat([PNG_HEADER, Buffer.from(' v9 image')]))
  const wavePath = await writeImage(parentDirectory, 'schema-v9-audio.wav', minimalWave())
  const mp3Path = await writeImage(parentDirectory, 'schema-v10-audio.mp3', id3Mp3())
  const image = await store.importAsset(imagePath, project.projectId)
  const audio = await store.importAsset(wavePath, project.projectId, 'local')
  const imageNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'schema-v9-image-reference',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: image.assetId },
  })
  const audioNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'schema-v9-audio-reference',
    expectedVersion: 1,
    type: 'audio',
    params: { assetId: audio.assetId },
  })
  await store.close()

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  await mutateProjectToV9(databasePath)
  await store.openProject(directory)
  const importedMp3 = await store.importAsset(mp3Path, project.projectId, 'local')
  assert.equal(importedMp3.mimeType, 'audio/mpeg')
  assert.equal(importedMp3.referenceCount, 0)
  const resolvedMp3 = await store.resolveAsset(importedMp3.assetId)
  assert.equal(resolvedMp3.mimeType, 'audio/mpeg')
  assert.deepEqual(await fs.readFile(resolvedMp3.filePath), await fs.readFile(mp3Path))
  assert.equal((await store.listAssets(project.projectId)).find((entry) => entry.assetId === image.assetId).referenceCount, 1)
  assert.equal((await store.listAssets(project.projectId)).find((entry) => entry.assetId === audio.assetId).referenceCount, 1)
  assert.deepEqual(store.loadCanvas(project.projectId, project.canvasId).nodes.map((node) => node.id), [imageNode.node.id, audioNode.node.id])

  const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get().user_version), 17)
    assert.deepEqual(migratedDatabase.prepare('PRAGMA foreign_key_check').all(), [])
    const schema = migratedDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get().sql
    assert.match(schema, /audio\/mpeg/u)
    assert.equal(migratedDatabase.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 2)
  } finally {
    migratedDatabase.close()
  }

  const backupDirectory = path.join(directory, '.vibepaper', 'backups')
  const backupName = (await fs.readdir(backupDirectory)).find((name) => name.startsWith('project-schema-v9-'))
  assert.ok(backupName, 'v9 SQLite snapshot exists before migration')
  const backupPath = path.join(backupDirectory, backupName)
  const backupStats = await fs.stat(backupPath)
  assert.ok(backupStats.size > 0)
  const backupDatabase = new DatabaseSync(backupPath, { readOnly: true })
  try {
    assert.equal(Number(backupDatabase.prepare('PRAGMA user_version').get().user_version), 9)
    const oldSchema = backupDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get().sql
    assert.match(oldSchema, /audio\/wav/u)
    assert.doesNotMatch(oldSchema, /audio\/mpeg/u)
    assert.equal(backupDatabase.prepare('SELECT COUNT(*) AS count FROM assets').get().count, 2)
    assert.equal(backupDatabase.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 2)
    assert.deepEqual(backupDatabase.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    backupDatabase.close()
  }
})

test('project schema v10 expands asset MIME types through v13 and keeps v10 and v11 rollback snapshots', async (t) => {
  const { store, directory, parentDirectory, project } = await openTestProject(t)
  const imagePath = await writeImage(parentDirectory, 'schema-v10-image.png', Buffer.concat([PNG_HEADER, Buffer.from(' v10 image')]))
  const image = await store.importAsset(imagePath, project.projectId)
  await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'schema-v10-image-reference',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: image.assetId },
  })
  await store.close()

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  await mutateProjectToV10(databasePath)
  await store.openProject(directory)
  const videoPath = await writeImage(parentDirectory, 'after-v10.webm', minimalWebm())
  const video = await store.importAsset(videoPath, project.projectId, 'local')
  assert.equal(video.mimeType, 'video/webm')
  assert.deepEqual(await fs.readFile((await store.resolveAsset(video.assetId)).filePath), minimalWebm())

  const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true })
  try {
    assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get().user_version), 17)
    assert.deepEqual(migratedDatabase.prepare('PRAGMA foreign_key_check').all(), [])
    assert.match(migratedDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get().sql, /video\/webm/u)
    assert.equal(migratedDatabase.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 1)
  } finally {
    migratedDatabase.close()
  }

  const backupDirectory = path.join(directory, '.vibepaper', 'backups')
  const backupNames = await fs.readdir(backupDirectory)
  const v10Name = backupNames.find((name) => name.startsWith('project-schema-v10-'))
  const v11Name = backupNames.find((name) => name.startsWith('project-schema-v11-'))
  assert.ok(v10Name, 'the original v10 schema is snapshotted before the asset migration')
  assert.ok(v11Name, 'the intermediate v11 schema is snapshotted before task-output migration')
  for (const [name, expectedVersion, expectsVideo] of [[v10Name, 10, false], [v11Name, 11, true]]) {
    const rollback = new DatabaseSync(path.join(backupDirectory, name), { readOnly: true })
    try {
      assert.equal(Number(rollback.prepare('PRAGMA user_version').get().user_version), expectedVersion)
      const schema = rollback.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assets'").get().sql
      assert.equal(/video\/webm/u.test(schema), expectsVideo)
      assert.equal(rollback.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 1)
      assert.deepEqual(rollback.prepare('PRAGMA foreign_key_check').all(), [])
    } finally {
      rollback.close()
    }
  }
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

test('WAV assets can be replaced with validated MP3 in place and retain references through backup and restore', async (t) => {
  const { store, directory, parentDirectory, project } = await openTestProject(t)
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-audio-replace-backup-'))
  const restoreParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-audio-replace-restore-'))
  t.after(async () => {
    await fs.rm(backupParent, { recursive: true, force: true })
    await fs.rm(restoreParent, { recursive: true, force: true })
  })

  const originalBytes = minimalWave()
  const replacementBytes = id3Mp3()
  const originalPath = await writeImage(parentDirectory, 'replace-original.wav', originalBytes)
  const replacementPath = await writeImage(parentDirectory, 'replace-next.mp3', replacementBytes)
  const originalAsset = await store.importAsset(originalPath, project.projectId, 'local')
  const node = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'audio-replacement-reference-node',
    expectedVersion: 0,
    type: 'audio',
    params: { assetId: originalAsset.assetId },
  })
  const oldFile = await store.resolveAsset(originalAsset.assetId)
  const replaced = await store.replaceAudioAsset(project.projectId, originalAsset.assetId, replacementPath)
  assert.equal(replaced.assetId, originalAsset.assetId)
  assert.equal(replaced.assetType, 'audio')
  assert.equal(replaced.mimeType, 'audio/mpeg')
  assert.equal(replaced.name, 'replace-next.mp3')
  assert.equal(replaced.referenceCount, 1)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(originalAsset.assetId)).filePath), replacementBytes)
  await assert.rejects(fs.access(oldFile.filePath))

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const updated = database.prepare('SELECT sha256, mime_type, relative_path FROM assets WHERE id = ?')
      .get(originalAsset.assetId)
    assert.equal(updated.sha256, createHash('sha256').update(replacementBytes).digest('hex'))
    assert.equal(updated.mime_type, 'audio/mpeg')
    assert.match(updated.relative_path, new RegExp(`^assets/${updated.sha256}/${originalAsset.assetId}\\.mp3$`, 'u'))
    assert.deepEqual(database.prepare('SELECT node_id, asset_id FROM asset_references').all().map((row) => ({ ...row })), [
      { node_id: node.node.id, asset_id: originalAsset.assetId },
    ])
  } finally {
    database.close()
  }

  const backup = await store.backupProject(backupParent, project.projectId)
  const restored = await store.restoreBackup(backup.directory, restoreParent)
  const restoredAsset = (await store.listAssets(restored.project.projectId)).find((asset) => asset.assetId === originalAsset.assetId)
  assert.equal(restoredAsset.assetType, 'audio')
  assert.equal(restoredAsset.mimeType, 'audio/mpeg')
  assert.equal(restoredAsset.referenceCount, 1)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(originalAsset.assetId)).filePath), replacementBytes)
  assert.deepEqual(store.loadCanvas(restored.project.projectId, restored.project.canvasId).nodes.map((entry) => entry.id), [node.node.id])
})

test('audio and image replacement routes reject the other asset type and invalid WAV or MP3 bytes', async (t) => {
  const { store, parentDirectory, project } = await openTestProject(t)
  const imagePath = await writeImage(parentDirectory, 'replace-kind-image.png', Buffer.concat([PNG_HEADER, Buffer.from(' image bytes')]))
  const wavePath = await writeImage(parentDirectory, 'replace-kind-audio.wav', minimalWave())
  const invalidWavePath = await writeImage(parentDirectory, 'replace-kind-invalid.wav', Buffer.concat([PNG_HEADER, Buffer.alloc(40, 1)]))
  const invalidMp3Path = await writeImage(parentDirectory, 'replace-kind-invalid.mp3', Buffer.from('not an MP3 stream'.padEnd(40, ' ')))
  const image = await store.importAsset(imagePath, project.projectId)
  const audio = await store.importAsset(wavePath, project.projectId, 'local')
  const imageNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'replace-kind-image-node',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: image.assetId },
  })
  const audioNode = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'replace-kind-audio-node',
    expectedVersion: 1,
    type: 'audio',
    params: { assetId: audio.assetId },
  })

  await assert.rejects(store.replaceAudioAsset(project.projectId, image.assetId, wavePath), /只能替换音频素材/u)
  await assert.rejects(store.replaceAsset(project.projectId, audio.assetId, imagePath), /只能替换图片素材/u)
  await assert.rejects(store.replaceAudioAsset(project.projectId, audio.assetId, invalidWavePath), /本地 WAV 素材格式无效/u)
  await assert.rejects(store.replaceAudioAsset(project.projectId, audio.assetId, invalidMp3Path), /有效 MPEG 音频帧/u)
  assert.deepEqual(await fs.readFile((await store.resolveAsset(image.assetId)).filePath), await fs.readFile(imagePath))
  assert.deepEqual(await fs.readFile((await store.resolveAsset(audio.assetId)).filePath), await fs.readFile(wavePath))
  const listed = await store.listAssets(project.projectId)
  assert.equal(listed.find((asset) => asset.assetId === image.assetId).referenceCount, 1)
  assert.equal(listed.find((asset) => asset.assetId === audio.assetId).referenceCount, 1)
  assert.deepEqual(store.loadCanvas(project.projectId, project.canvasId).nodes.map((entry) => entry.id), [
    imageNode.node.id,
    audioNode.node.id,
  ])
})

test('generic asset replacement validates and preserves each media category, including same-hash text MIME changes', async (t) => {
  const { store, parentDirectory, project } = await openTestProject(t)
  const cases = [
    { type: 'image', beforeName: 'generic-before.png', before: Buffer.concat([PNG_HEADER, Buffer.from(' original')]), afterName: 'generic-after.jpg', after: Buffer.concat([JPEG_HEADER, Buffer.from(' replacement')]), afterMime: 'image/jpeg' },
    { type: 'video', beforeName: 'generic-before.mp4', before: minimalFtyp('isom'), afterName: 'generic-after.webm', after: minimalWebm(), afterMime: 'video/webm' },
    { type: 'audio', beforeName: 'generic-before.wav', before: minimalWave(), afterName: 'generic-after.ogg', after: minimalOgg(), afterMime: 'audio/ogg' },
    { type: 'text', beforeName: 'generic-before.txt', before: Buffer.from('same text bytes\n'), afterName: 'generic-after.md', after: Buffer.from('same text bytes\n'), afterMime: 'text/markdown' },
  ]
  const fixtures = []
  for (let index = 0; index < cases.length; index += 1) {
    const entry = cases[index]
    const beforePath = await writeImage(parentDirectory, entry.beforeName, entry.before)
    const afterPath = await writeImage(parentDirectory, entry.afterName, entry.after)
    const asset = await store.importAsset(beforePath, project.projectId, 'local')
    const node = await store.createNode({
      projectId: project.projectId,
      canvasId: project.canvasId,
      idempotencyKey: `generic-replace-reference-${entry.type}`,
      expectedVersion: index,
      type: entry.type,
      params: { assetId: asset.assetId },
    })
    fixtures.push({ ...entry, asset, afterPath, nodeId: node.node.id, beforePath: (await store.resolveAsset(asset.assetId)).filePath })
  }

  for (const fixture of fixtures) {
    const replaced = await store.replaceAssetFile(project.projectId, fixture.asset.assetId, fixture.afterPath)
    assert.equal(replaced.assetId, fixture.asset.assetId)
    assert.equal(replaced.assetType, fixture.type)
    assert.equal(replaced.mimeType, fixture.afterMime)
    assert.equal(replaced.name, fixture.afterName)
    assert.equal(replaced.referenceCount, 1)
    const resolved = await store.resolveAsset(fixture.asset.assetId)
    assert.equal(resolved.mimeType, fixture.afterMime)
    assert.deepEqual(await fs.readFile(resolved.filePath), fixture.after)
    await assert.rejects(fs.access(fixture.beforePath))
  }

  const text = fixtures.find((entry) => entry.type === 'text')
  const textResolved = await store.resolveAsset(text.asset.assetId)
  assert.match(textResolved.filePath, /\.md$/u, 'MIME extension changes even when the content hash stays the same')
  await assert.rejects(store.replaceAssetFile(project.projectId, text.asset.assetId, fixtures[0].afterPath), /保持相同的类型/u)
  assert.deepEqual(await fs.readFile(textResolved.filePath), text.after)
  assert.deepEqual((await store.listAssets(project.projectId)).map((asset) => asset.referenceCount), [1, 1, 1, 1])
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
    assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get().user_version), 17)
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

test('project schema v7 migrates image assets and references through v10 with rollback snapshots', async (t) => {
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
    assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get().user_version), 17)
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

test('project schema v8 backfills only legacy params asset references and preserves a v8 rollback snapshot', async (t) => {
  const fixture = await createLegacyParamsReferenceFixture(t)
  await fixture.store.openProject(fixture.directory)

  const migratedDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true })
  let v8BackupName
  try {
    assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get().user_version), 17)
    assert.deepEqual(migratedDatabase.prepare(`
      SELECT node_id, asset_id FROM asset_references WHERE canvas_id = ? ORDER BY node_id
    `).all(fixture.project.canvasId).map((row) => ({ ...row })), [
      { node_id: fixture.audioNode.node.id, asset_id: fixture.audio.assetId },
      { node_id: fixture.imageNode.node.id, asset_id: fixture.image.assetId },
    ].sort((left, right) => left.node_id.localeCompare(right.node_id)))
    assert.deepEqual(migratedDatabase.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    migratedDatabase.close()
  }
  assert.equal(fixture.store.loadCanvas(fixture.project.projectId, fixture.project.canvasId).nodes.length, 3)
  assert.equal((await fixture.store.listAssets(fixture.project.projectId)).find((asset) => asset.assetId === fixture.image.assetId).referenceCount, 1)
  assert.equal((await fixture.store.listAssets(fixture.project.projectId)).find((asset) => asset.assetId === fixture.audio.assetId).referenceCount, 1)

  const backupDirectory = path.join(fixture.directory, '.vibepaper', 'backups')
  v8BackupName = (await fs.readdir(backupDirectory)).find((name) => name.startsWith('project-schema-v8-'))
  assert.ok(v8BackupName, 'v8 database snapshot exists before migration')
  const backupDatabase = new DatabaseSync(path.join(backupDirectory, v8BackupName), { readOnly: true })
  try {
    assert.equal(Number(backupDatabase.prepare('PRAGMA user_version').get().user_version), 8)
    assert.equal(backupDatabase.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 0)
  } finally {
    backupDatabase.close()
  }

  await fixture.store.close()
  await fixture.store.openProject(fixture.directory)
  const reopenedDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true })
  try {
    assert.equal(Number(reopenedDatabase.prepare('PRAGMA user_version').get().user_version), 17)
    assert.equal(reopenedDatabase.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 2)
  } finally {
    reopenedDatabase.close()
  }
  assert.deepEqual((await fs.readdir(backupDirectory)).filter((name) => /^project-schema-v8-.*\.sqlite$/u.test(name)), [v8BackupName])
})

test('project schema v8 refuses conflicting legacy references without changing the database', async (t) => {
  const fixture = await createLegacyParamsReferenceFixture(t)
  await mutateV8ProjectDatabase(fixture.databasePath, (database) => {
    database.prepare(`
      INSERT INTO asset_references (canvas_id, node_id, asset_id) VALUES (?, ?, ?)
    `).run(fixture.project.canvasId, fixture.imageNode.node.id, fixture.alternateImage.assetId)
  })

  await assert.rejects(fixture.store.openProject(fixture.directory), /项目画布与本地素材引用记录不一致/u)
  const unchangedDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true })
  try {
    assert.equal(Number(unchangedDatabase.prepare('PRAGMA user_version').get().user_version), 8)
    assert.deepEqual(unchangedDatabase.prepare(`
      SELECT node_id, asset_id FROM asset_references WHERE canvas_id = ?
    `).all(fixture.project.canvasId).map((row) => ({ ...row })), [
      { node_id: fixture.imageNode.node.id, asset_id: fixture.alternateImage.assetId },
    ])
    assert.deepEqual(unchangedDatabase.prepare('PRAGMA foreign_key_check').all(), [])
  } finally {
    unchangedDatabase.close()
  }
})

test('project schema v8 does not backfill missing references for nodes that already use data.assetId', async (t) => {
  const fixture = await createLegacyParamsReferenceFixture(t)
  await mutateV8ProjectDatabase(fixture.databasePath, (database) => {
    const row = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
      .get(fixture.project.canvasId, fixture.imageNode.node.id)
    const payload = JSON.parse(row.payload_json)
    payload.data.assetId = fixture.image.assetId
    database.prepare('UPDATE nodes SET payload_json = ? WHERE canvas_id = ? AND id = ?')
      .run(JSON.stringify(payload), fixture.project.canvasId, fixture.imageNode.node.id)
  })

  await assert.rejects(fixture.store.openProject(fixture.directory), /项目画布与本地素材引用记录不一致/u)
  const unchangedDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true })
  try {
    assert.equal(Number(unchangedDatabase.prepare('PRAGMA user_version').get().user_version), 8)
    assert.equal(unchangedDatabase.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 0)
  } finally {
    unchangedDatabase.close()
  }
})

test('project schema v8 refuses legacy references with missing or mismatched assets before backfilling', async (t) => {
  await t.test('missing asset', async (t) => {
    const fixture = await createLegacyParamsReferenceFixture(t)
    await mutateV8ProjectDatabase(fixture.databasePath, (database) => {
      database.prepare('DELETE FROM assets WHERE id = ?').run(fixture.image.assetId)
    })
    await assert.rejects(fixture.store.openProject(fixture.directory), /引用了不存在的本地素材/u)
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true })
    try {
      assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 8)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 0)
    } finally {
      database.close()
    }
  })

  await t.test('MIME mismatch', async (t) => {
    const fixture = await createLegacyParamsReferenceFixture(t)
    await mutateV8ProjectDatabase(fixture.databasePath, (database) => {
      const row = database.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
        .get(fixture.project.canvasId, fixture.audioNode.node.id)
      const payload = JSON.parse(row.payload_json)
      payload.data.params.assetId = fixture.image.assetId
      database.prepare('UPDATE nodes SET payload_json = ? WHERE canvas_id = ? AND id = ?')
        .run(JSON.stringify(payload), fixture.project.canvasId, fixture.audioNode.node.id)
    })
    await assert.rejects(fixture.store.openProject(fixture.directory), /素材引用类型不匹配/u)
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true })
    try {
      assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 8)
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM asset_references').get().count, 0,
        'the valid image candidate is not inserted before all legacy references are checked')
    } finally {
      database.close()
    }
  })
})

test('project schema v8 refuses extra references for nodes without local assets', async (t) => {
  const fixture = await createLegacyParamsReferenceFixture(t)
  await mutateV8ProjectDatabase(fixture.databasePath, (database) => {
    database.prepare(`
      INSERT INTO asset_references (canvas_id, node_id, asset_id) VALUES (?, ?, ?)
    `).run(fixture.project.canvasId, fixture.textNode.node.id, fixture.image.assetId)
  })

  await assert.rejects(fixture.store.openProject(fixture.directory), /项目画布与本地素材引用记录不一致/u)
  const unchangedDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true })
  try {
    assert.equal(Number(unchangedDatabase.prepare('PRAGMA user_version').get().user_version), 8)
    assert.deepEqual(unchangedDatabase.prepare(`
      SELECT node_id, asset_id FROM asset_references WHERE canvas_id = ?
    `).all(fixture.project.canvasId).map((row) => ({ ...row })), [
      { node_id: fixture.textNode.node.id, asset_id: fixture.image.assetId },
    ])
  } finally {
    unchangedDatabase.close()
  }
})

test('restoring a v8 backup with a missing legacy params reference migrates the staged project to v10', async (t) => {
  const { store, parentDirectory, project } = await openTestProject(t)
  const backupParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-v8-restore-backup-'))
  const restoreParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-v8-restore-target-'))
  t.after(async () => {
    await fs.rm(backupParent, { recursive: true, force: true })
    await fs.rm(restoreParent, { recursive: true, force: true })
  })

  const sourcePath = await writeImage(parentDirectory, 'restore-v8-image.png', Buffer.concat([PNG_HEADER, Buffer.from(' restore v8')]))
  const asset = await store.importAsset(sourcePath, project.projectId)
  const node = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'restore-v8-legacy-reference',
    expectedVersion: 0,
    type: 'image',
    params: { assetId: asset.assetId },
  })
  const backup = await store.backupProject(backupParent, project.projectId)
  const backupDataDirectory = path.join(backup.directory, '.vibepaper')
  const backupDatabasePath = path.join(backupDataDirectory, 'project.sqlite')
  const backupDatabase = new DatabaseSync(backupDatabasePath)
  try {
    backupDatabase.exec('BEGIN IMMEDIATE')
    backupDatabase.prepare('DELETE FROM asset_references WHERE canvas_id = ? AND node_id = ?')
      .run(project.canvasId, node.node.id)
    const legacyPayload = JSON.parse(backupDatabase.prepare('SELECT payload_json FROM nodes WHERE canvas_id = ? AND id = ?')
      .get(project.canvasId, node.node.id).payload_json)
    delete legacyPayload.data.assetId
    backupDatabase.prepare('UPDATE nodes SET payload_json = ? WHERE canvas_id = ? AND id = ?')
      .run(JSON.stringify(legacyPayload), project.canvasId, node.node.id)
    backupDatabase.exec('PRAGMA user_version = 8; COMMIT')
  } catch (error) {
    backupDatabase.exec('ROLLBACK')
    throw error
  } finally {
    backupDatabase.close()
  }

  const manifestPath = path.join(backupDataDirectory, 'backup-manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const databaseBytes = await fs.readFile(backupDatabasePath)
  const databaseEntry = manifest.files.find((entry) => entry.path === 'project.sqlite')
  assert.ok(databaseEntry, 'the backup manifest includes its SQLite database')
  databaseEntry.sha256 = createHash('sha256').update(databaseBytes).digest('hex')
  databaseEntry.sizeBytes = databaseBytes.length
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const restored = await store.restoreBackup(backup.directory, restoreParent)
  const restoredAssets = await store.listAssets(restored.project.projectId)
  assert.equal(restoredAssets.find((entry) => entry.assetId === asset.assetId).referenceCount, 1)
  assert.deepEqual(store.loadCanvas(restored.project.projectId, restored.project.canvasId).nodes.map((entry) => entry.id), [node.node.id])

  const restoredDatabasePath = path.join(restored.directory, '.vibepaper', 'project.sqlite')
  const restoredDatabase = new DatabaseSync(restoredDatabasePath, { readOnly: true })
  try {
    assert.equal(Number(restoredDatabase.prepare('PRAGMA user_version').get().user_version), 17)
    assert.deepEqual(restoredDatabase.prepare('PRAGMA foreign_key_check').all(), [])
    assert.deepEqual(restoredDatabase.prepare('SELECT node_id, asset_id FROM asset_references').all().map((row) => ({ ...row })), [
      { node_id: node.node.id, asset_id: asset.assetId },
    ])
  } finally {
    restoredDatabase.close()
  }
  assert.ok((await fs.readdir(path.join(restored.directory, '.vibepaper', 'backups')))
    .some((name) => name.startsWith('project-schema-v8-')))
})

test('asset operations are exposed through project-scoped IPC and a path-restricted preload bridge', async () => {
  const root = path.resolve(__dirname, '..', '..')
  const read = (relativePath) => fs.readFile(path.join(root, relativePath), 'utf8')
  const [localCore, main, preload, bridgeTypes] = await Promise.all([
    read('pi-paper-desktop/src/local-core.cjs'),
    read('pi-paper-desktop/src/main.cjs'),
    read('pi-paper-desktop/src/preload.cjs'),
    read('pi-paper-web/src/desktop/desktop-bridge.d.ts'),
  ])

  assert.match(localCore, /case 'asset:rename':\s+return store\.renameAsset/u)
  assert.match(localCore, /case 'asset:replace':\s+return store\.replaceAsset/u)
  assert.match(localCore, /case 'asset:replace-file':\s+return store\.replaceAssetFile/u)
  assert.match(localCore, /case 'asset:replace-audio':\s+return store\.replaceAudioAsset/u)
  assert.match(localCore, /case 'asset:delete':\s+return store\.deleteAsset/u)
  assert.match(main, /desktop:asset:rename',[\s\S]*assertAssetId\(assetId\)[\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:rename'/u)
  assert.match(main, /desktop:asset:replace-image',[\s\S]*dialog\.showOpenDialog[\s\S]*localCore\.request\('asset:replace'/u)
  assert.match(main, /desktop:asset:replace-audio',[\s\S]*dialog\.showOpenDialog[\s\S]*extensions: \['wav', 'mp3', 'ogg', 'm4a'\][\s\S]*localCore\.request\('asset:replace-audio'/u)
  assert.match(main, /desktop:asset:replace',[\s\S]*assertTrustedSender\(event\)[\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:replace-file'/u)
  assert.match(main, /desktop:asset:import-image',[\s\S]*localCore\.request\('asset:import', \{ sourcePath: result\.filePaths\[0\], projectId, assetKind: 'image' \}/u)
  assert.match(main, /desktop:asset:import-local',[\s\S]*assertTrustedSender\(event\)[\s\S]*extensions: \['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'wav', 'mp3', 'ogg', 'm4a', 'txt', 'md'\][\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:import', \{ sourcePath: result\.filePaths\[0\], projectId, assetKind: 'local' \}/u)
  assert.match(main, /desktop:asset:import-local-assets', async \(event, projectId\) => \{[\s\S]*assertTrustedSender\(event\)[\s\S]*await assertActiveAssetProject\(projectId\)[\s\S]*properties: \['openFile', 'multiSelections'\][\s\S]*await assertActiveAssetProject\(projectId\)[\s\S]*for \(const sourcePath of result\.filePaths\)[\s\S]*safeLocalAssetImportError\(error\)[\s\S]*return \{ assets, errors \}/u)
  assert.match(main, /function localAssetImportName\(sourcePath\)[\s\S]*path\.basename\(sourcePath\)/u)
  assert.match(main, /desktop:asset:delete',[\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:delete'/u)
  assert.match(preload, /renameAsset: \(projectId, assetId, name\) => ipcRenderer\.invoke\('desktop:asset:rename'/u)
  assert.match(preload, /replaceImage: \(projectId, assetId\) => ipcRenderer\.invoke\('desktop:asset:replace-image'/u)
  assert.match(preload, /replaceAudio: \(projectId, assetId\) => ipcRenderer\.invoke\('desktop:asset:replace-audio'/u)
  assert.match(preload, /replaceAsset: \(projectId, assetId\) => ipcRenderer\.invoke\('desktop:asset:replace'/u)
  assert.match(preload, /importLocalAsset: \(projectId\) => ipcRenderer\.invoke\('desktop:asset:import-local', projectId\)/u)
  assert.match(preload, /importLocalAssets: \(projectId\) => ipcRenderer\.invoke\('desktop:asset:import-local-assets', projectId\)/u)
  assert.match(localCore, /case 'asset:import':[\s\S]*!\['image', 'video', 'audio', 'text', 'local'\]\.includes\(assetKind\)[\s\S]*store\.importAsset\(payload\.sourcePath, payload\.projectId, assetKind\)/u)
  assert.match(preload, /deleteAsset: \(projectId, assetId\) => ipcRenderer\.invoke\('desktop:asset:delete'/u)
  assert.match(main, /desktop:asset:save-task-output',[\s\S]*assertTrustedSender\(event\)[\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:save-task-output', \{ projectId, taskId \}/u)
  assert.match(preload, /saveTaskOutputToLibrary: \(projectId, taskId\) => ipcRenderer\.invoke\('desktop:asset:save-task-output', projectId, taskId\)/u)
  assert.match(localCore, /case 'asset:save-task-output':[\s\S]*store\.saveTaskOutputToLibrary\(payload\.projectId, payload\.taskId\)/u)
  assert.match(bridgeTypes, /saveTaskOutputToLibrary\(projectId: string, taskId: string\): Promise<DesktopAsset>/u)
  assert.match(bridgeTypes, /'audio\/wav'/u)
  assert.match(bridgeTypes, /renameAsset\(projectId: string, assetId: string, name: string\): Promise<DesktopAsset>/u)
  assert.match(bridgeTypes, /replaceImage\(projectId: string, assetId: string\): Promise<DesktopAsset \| null>/u)
  assert.match(bridgeTypes, /replaceAsset\(projectId: string, assetId: string\): Promise<DesktopAsset \| null>/u)
  assert.match(bridgeTypes, /'video\/webm'/u)
  assert.match(bridgeTypes, /'text\/markdown'/u)
  assert.match(bridgeTypes, /importLocalAssets\(projectId: string\): Promise<DesktopAssetImportResult \| null>/u)
  assert.match(bridgeTypes, /errors: Array<\{ name: string; message: string \}>/u)
  assert.match(bridgeTypes, /deleteAsset\(projectId: string, assetId: string\): Promise<DesktopAssetDeleteImpact>/u)
})

test('multi-file asset IPC continues after per-file failures, hides source paths, and rechecks the project', async () => {
  const harness = await createMainIpcHarness()
  const selectedPaths = [
    path.join(os.tmpdir(), 'private-source', 'first.png'),
    path.join(os.tmpdir(), 'private-source', 'blocked.wav'),
    path.join(os.tmpdir(), 'private-source', 'last.mp3'),
  ]
  let selected = { canceled: false, filePaths: selectedPaths }
  let activeProjectId = 'project-1'
  let activeProjectChecks = 0
  const importRequests = []
  let pickerOptions
  harness.electron.dialog.showOpenDialog = async (_window, options) => {
    pickerOptions = options
    return selected
  }
  harness.setLocalCore({
    async request(method, payload) {
      if (method === 'project:get-active') {
        activeProjectChecks += 1
        return { projectId: activeProjectId }
      }
      assert.equal(method, 'asset:import')
      importRequests.push(payload)
      if (payload.sourcePath === selectedPaths[1]) {
        throw new Error(`EACCES: permission denied, open '${payload.sourcePath}'`)
      }
      return { assetId: `asset-${importRequests.length}`, name: path.basename(payload.sourcePath) }
    },
  })

  const importMany = harness.handlers.get('desktop:asset:import-local-assets')
  const result = JSON.parse(JSON.stringify(await importMany(harness.event, 'project-1')))
  const plainPickerOptions = JSON.parse(JSON.stringify(pickerOptions))
  assert.deepEqual(plainPickerOptions.properties, ['openFile', 'multiSelections'])
  assert.deepEqual(plainPickerOptions.filters[0].extensions, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'wav', 'mp3', 'ogg', 'm4a', 'txt', 'md'])
  assert.equal(activeProjectChecks, 2, 'the project identity is checked before and after the picker')
  assert.deepEqual(importRequests.map((request) => request.assetKind), ['local', 'local', 'local'])
  assert.deepEqual(result.assets.map((asset) => asset.assetId), ['asset-1', 'asset-3'])
  assert.deepEqual(result.errors, [{ name: 'blocked.wav', message: '文件读取或导入失败。' }])
  assert.equal(JSON.stringify(result).includes(os.tmpdir()), false, 'source paths never cross the IPC boundary')

  selected = { canceled: false, filePaths: [selectedPaths[0]] }
  harness.electron.dialog.showOpenDialog = async (_window, options) => {
    activeProjectId = 'different-project'
    assert.ok(options.properties.includes('multiSelections'))
    return selected
  }
  await assert.rejects(importMany(harness.event, 'project-1'), /当前项目已更改/u)
  assert.equal(importRequests.length, 3, 'an identity change after selection prevents importing selected files')

  activeProjectId = 'project-1'
  selected = { canceled: true, filePaths: [] }
  const canceled = await importMany(harness.event, 'project-1')
  assert.equal(canceled, null)
  assert.equal(importRequests.length, 3, 'canceling the picker does not create an asset')
})

test('generic replacement IPC stays project-scoped and offers all supported local file types', async () => {
  const harness = await createMainIpcHarness()
  const selectedPath = path.join(os.tmpdir(), 'private-source', 'replacement.md')
  let activeChecks = 0
  let pickerOptions
  let replaceRequest
  harness.electron.dialog.showOpenDialog = async (_window, options) => {
    pickerOptions = options
    return { canceled: false, filePaths: [selectedPath] }
  }
  harness.setLocalCore({
    async request(method, payload) {
      if (method === 'project:get-active') {
        activeChecks += 1
        return { projectId: 'project-1' }
      }
      replaceRequest = { method, payload }
      return { assetId: payload.assetId, assetType: 'text', mimeType: 'text/markdown' }
    },
  })

  const replace = harness.handlers.get('desktop:asset:replace')
  const result = await replace(harness.event, 'project-1', 'f1bbdc54-d75e-4329-9e4d-495d1b32da40')
  assert.equal(activeChecks, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(pickerOptions.filters[0].extensions)), [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'wav', 'mp3', 'ogg', 'm4a', 'txt', 'md',
  ])
  assert.equal(replaceRequest.method, 'asset:replace-file')
  assert.deepEqual(JSON.parse(JSON.stringify(replaceRequest.payload)), {
    projectId: 'project-1',
    assetId: 'f1bbdc54-d75e-4329-9e4d-495d1b32da40',
    sourcePath: selectedPath,
  })
  assert.equal(result.mimeType, 'text/markdown')
})

test('local media protocol enables streaming playback in dev and packaged modes', async () => {
  for (const devServerUrl of [undefined, 'http://127.0.0.1:5173']) {
    const { registeredSchemes } = await createMainIpcHarness({ devServerUrl })
    const mediaScheme = registeredSchemes.find(({ scheme }) => scheme === 'vibe')
    assert.ok(mediaScheme)
    assert.equal(mediaScheme.privileges.stream, true)
    assert.equal(mediaScheme.privileges.standard, true)
    assert.equal(mediaScheme.privileges.secure, true)
    assert.equal(mediaScheme.privileges.supportFetchAPI, true)
  }
})

test('local asset preview IPC serves detected MIME with nosniff and supports byte ranges', async (t) => {
  const { store, parentDirectory, project } = await openTestProject(t)
  const textPath = await writeImage(parentDirectory, 'preview.md', Buffer.from('# Local preview\n'))
  const videoPath = await writeImage(parentDirectory, 'preview.mp4', minimalFtyp('isom'))
  const imagePath = await writeImage(parentDirectory, 'preview.png', Buffer.concat([PNG_HEADER, Buffer.from(' thumbnail fallback')]))
  const text = await store.importAsset(textPath, project.projectId, 'local')
  const video = await store.importAsset(videoPath, project.projectId, 'local')
  const image = await store.importAsset(imagePath, project.projectId, 'local')
  const harness = await createMainIpcHarness()
  harness.setLocalCore({
    async request(method, payload) {
      if (method === 'asset:resolve-thumbnail') return store.resolveAssetThumbnail(payload.assetId)
      assert.equal(method, 'asset:resolve')
      return store.resolveAsset(payload.assetId)
    },
  })
  const handler = harness.protocolHandlers.get('vibe')
  const makeRequest = (assetId, range) => ({
    url: `vibe://app/assets/${assetId}`,
    method: 'GET',
    headers: new Headers(range ? { range } : {}),
  })
  const textResponse = await handler(makeRequest(text.assetId))
  assert.equal(textResponse.status, 200)
  assert.equal(textResponse.headers.get('content-type'), 'text/markdown')
  assert.equal(textResponse.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await textResponse.text(), '# Local preview\n')

  const thumbnailResponse = await handler({
    url: `vibe://app/assets/${image.assetId}/thumbnail`,
    method: 'GET',
    headers: new Headers(),
  })
  assert.equal(thumbnailResponse.status, 200)
  assert.equal(thumbnailResponse.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await thumbnailResponse.arrayBuffer()), Buffer.concat([PNG_HEADER, Buffer.from(' thumbnail fallback')]))

  const rangeResponse = await handler(makeRequest(video.assetId, 'bytes=4-7'))
  assert.equal(rangeResponse.status, 206)
  assert.equal(rangeResponse.headers.get('content-type'), 'video/mp4')
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 4-7/${minimalFtyp('isom').length}`)
  assert.equal(await rangeResponse.text(), 'ftyp')

  const invalidRangeResponse = await handler(makeRequest(video.assetId, 'bytes=999999-'))
  assert.equal(invalidRangeResponse.status, 416)
  assert.equal(invalidRangeResponse.headers.get('content-range'), `bytes */${minimalFtyp('isom').length}`)
})

test('desktop CSP permits the local vibe scheme for image and audio previews in dev and packaged modes', async () => {
  for (const devServerUrl of [undefined, 'http://localhost:5173']) {
    const harness = await createMainIpcHarness({ devServerUrl })
    const url = devServerUrl || 'vibe://app/'
    const response = await new Promise((resolve) => {
      harness.headerHandlers[0]({
        resourceType: 'mainFrame',
        url,
        responseHeaders: { 'Content-Security-Policy': ["default-src 'none'"] },
      }, resolve)
    })
    const policy = response.responseHeaders['Content-Security-Policy'][0]
    assert.match(policy, /img-src 'self' data: blob: vibe:/u)
    assert.match(policy, /media-src 'self' data: blob: vibe:/u)
    assert.match(policy, /connect-src 'self' vibe:/u)
  }
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

test('drama asset IPC delegates body validation so idempotent replays can return their snapshots', async () => {
  const harness = await createMainIpcHarness()
  let forwarded
  harness.setLocalCore({
    async request(method, payload) {
      forwarded = { method, payload }
      return { replayed: true }
    },
  })
  const handler = harness.handlers.get('desktop:canvas:drama-assets:upsert')
  const input = {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    canvasVersion: 0,
    idempotencyKey: 'existing-command',
    assetType: 'invalid-type',
    assetId: [],
    data: [],
  }
  assert.deepEqual(await handler(harness.event, input), { replayed: true })
  assert.equal(forwarded.method, 'canvas:drama-assets:upsert')
  assert.deepEqual(JSON.parse(JSON.stringify(forwarded.payload)), input)
})

test('drama state IPC allowlists operations and forwards active project scope to Local Core', async () => {
  const harness = await createMainIpcHarness()
  const calls = []
  harness.setLocalCore({
    async request(method, payload) {
      calls.push({ method, payload })
      if (method === 'project:get-active') return { projectId: 'project-1' }
      return { id: 'series-1' }
    },
  })
  const handler = harness.handlers.get('desktop:drama:state')
  const input = {
    projectId: 'project-1',
    canvasId: 'canvas-1',
    idempotencyKey: 'series-create',
    series: { id: 'series-1' },
  }

  assert.deepEqual(await handler(harness.event, 'createSeries', input), { id: 'series-1' })
  assert.equal(calls[0].method, 'project:get-active')
  assert.deepEqual(calls[1], { method: 'drama:series:create', payload: input })
  await assert.rejects(handler(harness.event, 'deleteSeries', input), /短剧状态操作无效/u)
})

test('local video task and asset previews accept playback fragments with byte ranges', async (t) => {
  const { store, project, parentDirectory } = await openTestProject(t)
  const videoBytes = Buffer.concat([minimalFtyp('isom'), Buffer.from('range-preview-payload')])
  const assetPath = await writeImage(parentDirectory, 'playback-preview.mp4', videoBytes)
  const asset = await store.importAsset(assetPath, project.projectId, 'local')
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 0,
    nodeId: null,
    modality: 'video',
    providerType: 'cloud',
    providerId: 'provider-test',
    modelId: 'video-test',
    idempotencyKey: 'video-playback-protocol-fragment',
    parameters: { prompt: 'Protocol range fixture' },
  })
  const claimed = await store.claimNextTask(project.projectId)
  assert.equal(claimed.task.taskId, task.taskId)
  await fs.writeFile(path.join(claimed.outputDirectory, 'result.mp4'), videoBytes)
  await store.recordTaskSucceeded(project.projectId, task.taskId, `generated/${task.taskId}/result.mp4`)

  const harness = await createMainIpcHarness()
  harness.setLocalCore({
    async request(method, payload) {
      if (method === 'project:get-active') return { projectId: project.projectId }
      if (method === 'task:resolve-output-preview') {
        return store.resolveTaskOutputForPreview(payload.projectId, payload.taskId, payload.outputIndex)
      }
      if (method === 'asset:resolve') return store.resolveAsset(payload.assetId)
      throw new Error(`Unexpected Local Core call: ${method}`)
    },
  })
  const handler = harness.protocolHandlers.get('vibe')
  const request = (url, range = 'bytes=4-7') => ({
    url,
    method: 'GET',
    headers: new Headers({ range }),
  })

  const taskResponse = await handler(request(`vibe://app/tasks/${task.taskId}/output?index=0#t=0.001`))
  assert.equal(taskResponse.status, 206)
  assert.equal(taskResponse.headers.get('content-type'), 'video/mp4')
  assert.equal(taskResponse.headers.get('content-range'), `bytes 4-7/${videoBytes.length}`)
  assert.equal(await taskResponse.text(), 'ftyp')

  const assetResponse = await handler(request(`vibe://app/assets/${asset.assetId}#t=0.001`))
  assert.equal(assetResponse.status, 206)
  assert.equal(assetResponse.headers.get('content-type'), 'video/mp4')
  assert.equal(assetResponse.headers.get('content-range'), `bytes 4-7/${videoBytes.length}`)
  assert.equal(await assetResponse.text(), 'ftyp')

  const invalidTaskFragment = await handler(request(`vibe://app/tasks/${task.taskId}/output#download`))
  assert.equal(invalidTaskFragment.status, 404)
  const invalidTaskQuery = await handler(request(`vibe://app/tasks/${task.taskId}/output?other=1#t=0.001`))
  assert.equal(invalidTaskQuery.status, 404)
  const invalidAssetFragment = await handler(request(`vibe://app/assets/${asset.assetId}#download`))
  assert.equal(invalidAssetFragment.status, 404)
})
