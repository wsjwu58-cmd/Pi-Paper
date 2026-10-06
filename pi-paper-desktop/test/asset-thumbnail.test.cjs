const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const nativeFs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { resolveFfmpegPath } = require('../src/compose-provider.cjs')

const ffmpegPath = resolveFfmpegPath()
const ffprobePath = ffmpegPath && path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const available = Boolean(ffmpegPath && ffprobePath && nativeFs.existsSync(ffprobePath))

function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr || `${executable} failed`)
  return result.stdout.trim()
}

function dimensions(filePath) {
  const output = command(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath,
  ])
  return JSON.parse(output).streams[0]
}

test('local image assets receive a 320px JPEG thumbnail that refreshes after replacement', {
  skip: !available && 'FFmpeg/FFprobe are unavailable',
}, async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-asset-thumbnail-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parent, { recursive: true, force: true })
  })
  const { project } = await store.createProject(parent, 'Thumbnail Test')
  const firstPath = path.join(parent, 'first.png')
  const secondPath = path.join(parent, 'second.png')
  command(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x400:d=1', '-frames:v', '1', firstPath])
  command(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=800x200:d=1', '-frames:v', '1', secondPath])

  const asset = await store.importAsset(firstPath, project.projectId)
  const original = await store.resolveAsset(asset.assetId)
  const first = await store.resolveAssetThumbnail(asset.assetId)
  assert.equal(first.mimeType, 'image/jpeg')
  assert.notEqual(first.filePath, original.filePath)
  assert.deepEqual(dimensions(first.filePath), { width: 320, height: 200 })
  assert.equal((await store.resolveAssetThumbnail(asset.assetId)).filePath, first.filePath)

  await store.replaceAsset(project.projectId, asset.assetId, secondPath)
  const second = await store.resolveAssetThumbnail(asset.assetId)
  assert.equal(second.mimeType, 'image/jpeg')
  assert.notEqual(second.filePath, first.filePath)
  assert.deepEqual(dimensions(second.filePath), { width: 320, height: 80 })

  const backupParent = path.join(parent, 'backups')
  const restoreParent = path.join(parent, 'restored')
  await fs.mkdir(backupParent)
  await fs.mkdir(restoreParent)
  const backup = await store.backupProject(backupParent, project.projectId)
  await store.restoreBackup(backup.directory, restoreParent)
  const restoredThumbnail = await store.resolveAssetThumbnail(asset.assetId)
  assert.equal(restoredThumbnail.mimeType, 'image/jpeg')
  assert.deepEqual(dimensions(restoredThumbnail.filePath), { width: 320, height: 80 })
})
