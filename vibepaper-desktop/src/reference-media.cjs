const fs = require('node:fs/promises')
const path = require('node:path')

const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_PAYLOAD_BYTES = 64 * 1024 * 1024
const UUID_PATTERN = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const MIME_EXTENSIONS = new Map([
  ['image/png', ['png']],
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/webp', ['webp']],
])
const SINGLE_REFERENCE_FIELDS = [
  'image', 'imageUrl', 'image_url', 'referenceUrl', 'sourceUrl', 'firstFrameUrl', 'lastFrameUrl',
]
const LIST_REFERENCE_FIELDS = ['referenceImages', 'reference_images', 'referenceUrls']

class ReferenceMediaFailure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function imageMimeFromBytes(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

function parseLocalReference(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const source = value.trim()
  if (!/^vibe:/iu.test(source)) return null

  const asset = new RegExp(`^vibe://app/assets/(${UUID_PATTERN})$`, 'iu').exec(source)
  if (asset) return { type: 'asset', id: asset[1].toLowerCase() }
  const taskOutput = new RegExp(`^vibe://app/tasks/(${UUID_PATTERN})/output$`, 'iu').exec(source)
  if (taskOutput) return { type: 'task-output', id: taskOutput[1].toLowerCase() }
  throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '本地媒体参考地址无效。')
}

function assertContainedPath(root, target, label) {
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', `${label}不属于当前项目。`)
  }
  return relative
}

async function assertManagedImagePath(projectDirectory, filePath, type, id) {
  if (typeof projectDirectory !== 'string' || !projectDirectory || typeof filePath !== 'string' || !filePath) {
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '本地媒体参考不可用。')
  }
  const projectRoot = await fs.realpath(projectDirectory).catch(() => null)
  if (!projectRoot) throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '当前项目不可用。')
  const dataRoot = path.join(projectRoot, '.vibepaper')
  const dataInfo = await fs.lstat(dataRoot).catch(() => null)
  if (!dataInfo?.isDirectory() || dataInfo.isSymbolicLink() || path.relative(dataRoot, await fs.realpath(dataRoot)) !== '') {
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '当前项目媒体目录无效。')
  }

  const absoluteFile = path.resolve(filePath)
  const realFile = await fs.realpath(absoluteFile).catch(() => null)
  if (!realFile || path.relative(absoluteFile, realFile) !== '') {
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '本地媒体参考路径无效。')
  }
  const relative = assertContainedPath(dataRoot, realFile, '本地媒体参考')
  const segments = relative.split(path.sep)
  const expectedRoot = type === 'asset' ? 'assets' : 'generated'
  if (segments[0] !== expectedRoot || segments.length < 3) {
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '本地媒体参考路径无效。')
  }

  if (type === 'asset') {
    if (segments.length !== 3 || !/^[a-f0-9]{64}$/iu.test(segments[1])
      || !new RegExp(`^${id}\\.(?:png|jpg|jpeg|webp)$`, 'iu').test(segments[2])) {
      throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '本地素材路径无效。')
    }
  } else if (segments[1] !== id || segments.length !== 3
    || !/^result\.(?:png|jpg|jpeg|webp)$/iu.test(segments[2])) {
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '任务图片结果路径无效。')
  }

  let current = dataRoot
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    const info = await fs.lstat(current).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink() || path.relative(current, await fs.realpath(current)) !== '') {
      throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '本地媒体参考目录无效。')
    }
  }
  const info = await fs.lstat(realFile).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '本地媒体参考文件无效。')
  }
  assertContainedPath(type === 'asset' ? path.join(dataRoot, 'assets') : path.join(dataRoot, 'generated'), realFile, '本地媒体参考')
  return realFile
}

async function readBoundedImage(filePath, expectedMimeType, expectedSizeBytes) {
  if (!MIME_EXTENSIONS.has(expectedMimeType)) {
    throw new ReferenceMediaFailure('CLOUD_INPUT_INVALID', 'Agnes 参考图仅支持 PNG、JPEG 或 WebP。')
  }

  let handle
  try {
    handle = await fs.open(filePath, 'r')
    const before = await handle.stat()
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size <= 0
      || before.size > MAX_REFERENCE_IMAGE_BYTES
      || expectedSizeBytes !== undefined && expectedSizeBytes !== before.size) {
      throw new ReferenceMediaFailure('CLOUD_INPUT_INVALID', 'Agnes 图片参考为空或超过 20 MiB 上限。')
    }

    const chunks = []
    const buffer = Buffer.alloc(64 * 1024)
    let totalBytes = 0
    let position = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      totalBytes += bytesRead
      if (totalBytes > MAX_REFERENCE_IMAGE_BYTES) {
        throw new ReferenceMediaFailure('CLOUD_INPUT_INVALID', 'Agnes 图片参考超过 20 MiB 上限。')
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      position += bytesRead
    }
    const after = await handle.stat()
    if (totalBytes !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new ReferenceMediaFailure('CLOUD_INPUT_INVALID', '读取本地图片参考时文件发生变化。')
    }

    const bytes = Buffer.concat(chunks, totalBytes)
    if (imageMimeFromBytes(bytes) !== expectedMimeType) {
      throw new ReferenceMediaFailure('CLOUD_INPUT_INVALID', '本地图片参考内容与素材格式不匹配。')
    }
    return `data:${expectedMimeType};base64,${bytes.toString('base64')}`
  } catch (error) {
    if (error instanceof ReferenceMediaFailure) throw error
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '无法读取本地图片参考。')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function resolveLocalReference(value, { localCore, projectId, projectDirectory }) {
  const local = parseLocalReference(value)
  if (!local) return value
  if (!localCore || typeof projectId !== 'string' || !projectId) {
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '当前项目不可用，无法读取本地图片参考。')
  }

  let resolved
  try {
    resolved = local.type === 'asset'
      ? await localCore.request('asset:resolve', { assetId: local.id })
      : await localCore.request('task:resolve-output-preview', { projectId, taskId: local.id })
  } catch {
    throw new ReferenceMediaFailure('CLOUD_REFERENCE_UNAVAILABLE', '本地图片参考不存在或不可用。')
  }
  const filePath = await assertManagedImagePath(projectDirectory, resolved?.filePath, local.type, local.id)
  return readBoundedImage(filePath, resolved?.mimeType, resolved?.sizeBytes)
}

async function resolveGenerationImageReferences(parameters, options) {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return parameters
  const resolved = { ...parameters }
  let expandedBytes = 0
  const cache = new Map()
  const resolve = async (value) => {
    if (typeof value !== 'string' || !value.trim()) return value
    const key = value.trim()
    if (!cache.has(key)) {
      const dataUrl = await resolveLocalReference(key, options)
      cache.set(key, dataUrl)
    }
    const dataUrl = cache.get(key)
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
      const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1)
      expandedBytes += Buffer.from(encoded, 'base64').length
      if (expandedBytes > MAX_REFERENCE_PAYLOAD_BYTES) {
        throw new ReferenceMediaFailure('CLOUD_INPUT_INVALID', '图片参考总大小超过本地请求上限。')
      }
    }
    return dataUrl
  }

  for (const field of SINGLE_REFERENCE_FIELDS) {
    if (typeof resolved[field] === 'string') resolved[field] = await resolve(resolved[field])
  }
  for (const field of LIST_REFERENCE_FIELDS) {
    if (typeof resolved[field] === 'string') {
      resolved[field] = await resolve(resolved[field])
    } else if (Array.isArray(resolved[field])) {
      resolved[field] = await Promise.all(resolved[field].map((value) => resolve(value)))
    }
  }
  return resolved
}

module.exports = {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_PAYLOAD_BYTES,
  ReferenceMediaFailure,
  imageMimeFromBytes,
  parseLocalReference,
  resolveGenerationImageReferences,
}
