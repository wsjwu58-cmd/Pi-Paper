const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { resolveFfmpegPath, runFfmpeg } = require('./compose-provider.cjs')

const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024

async function validJpeg(filePath) {
  const info = await fs.lstat(filePath).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size < 4 || info.size > MAX_THUMBNAIL_BYTES) return null
  const handle = await fs.open(filePath, 'r').catch(() => null)
  if (!handle) return null
  try {
    const header = Buffer.alloc(3)
    await handle.read(header, 0, 3, 0)
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff ? info.size : null
  } finally {
    await handle.close()
  }
}

async function safeCacheDirectory(projectDirectory, sha256) {
  const dataRoot = path.join(projectDirectory, '.vibepaper')
  const thumbRoot = path.join(dataRoot, 'thumbnails')
  const hashDirectory = path.join(thumbRoot, sha256)
  for (const directory of [dataRoot, thumbRoot, hashDirectory]) {
    await fs.mkdir(directory, { recursive: true })
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== '') {
      throw new Error('缩略图缓存目录无效。')
    }
  }
  return hashDirectory
}

async function imageThumbnail(projectDirectory, asset, sourcePath, dependencies = {}) {
  if (typeof asset?.id !== 'string' || !/^[a-f0-9-]{36}$/iu.test(asset.id)
    || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(asset.sha256)
    || typeof asset.mime_type !== 'string' || !asset.mime_type.startsWith('image/')) return null
  const directory = await safeCacheDirectory(projectDirectory, asset.sha256)
  const targetPath = path.join(directory, `${asset.id}.jpg`)
  const existingSize = await validJpeg(targetPath)
  if (existingSize) return { filePath: targetPath, mimeType: 'image/jpeg', sizeBytes: existingSize }
  const ffmpegPath = dependencies.ffmpegPath ?? resolveFfmpegPath()
  if (!ffmpegPath) return null
  const temporaryPath = path.join(directory, `.thumbnail-${randomUUID()}.jpg`)
  try {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
      '-frames:v', '1', '-vf', 'scale=w=min(320\\,iw):h=-1:flags=bilinear',
      '-q:v', '3', temporaryPath,
    ]
    const result = (dependencies.runFfmpeg ?? runFfmpeg)(ffmpegPath, args, 30_000)
    if (result?.status !== 0) return null
    const sizeBytes = await validJpeg(temporaryPath)
    if (!sizeBytes) return null
    await fs.rm(targetPath, { force: true })
    await fs.rename(temporaryPath, targetPath)
    return { filePath: targetPath, mimeType: 'image/jpeg', sizeBytes }
  } catch {
    return null
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

module.exports = { imageThumbnail }
