const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')

const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex')
const JPEG_HEADER = Buffer.from('ffd8ff', 'hex')

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
    assert.equal(Number(migratedDatabase.prepare('PRAGMA user_version').get().user_version), 6)
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
  assert.match(main, /desktop:asset:delete',[\s\S]*assertActiveAssetProject\(projectId\)[\s\S]*localCore\.request\('asset:delete'/u)
  assert.match(preload, /renameAsset: \(projectId, assetId, name\) => ipcRenderer\.invoke\('desktop:asset:rename'/u)
  assert.match(preload, /replaceImage: \(projectId, assetId\) => ipcRenderer\.invoke\('desktop:asset:replace-image'/u)
  assert.match(preload, /deleteAsset: \(projectId, assetId\) => ipcRenderer\.invoke\('desktop:asset:delete'/u)
  assert.match(bridgeTypes, /renameAsset\(projectId: string, assetId: string, name: string\): Promise<DesktopAsset>/u)
  assert.match(bridgeTypes, /replaceImage\(projectId: string, assetId: string\): Promise<DesktopAsset \| null>/u)
  assert.match(bridgeTypes, /deleteAsset\(projectId: string, assetId: string\): Promise<DesktopAssetDeleteImpact>/u)
})
