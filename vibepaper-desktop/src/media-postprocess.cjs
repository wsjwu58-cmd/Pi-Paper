const fs = require('node:fs/promises')
const nativeFs = require('node:fs')
const path = require('node:path')
const { resolveFfmpegPath, runFfmpeg } = require('./compose-provider.cjs')

const LOCAL_MEDIA_PROVIDER_ID = 'local-media-tools'
const LOCAL_MEDIA_MODEL_ID = 'ffmpeg-media-1'
const MAX_MEDIA_INPUT_BYTES = 4 * 1024 * 1024 * 1024
const MAX_MEDIA_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const IMAGE_OPERATIONS = new Set(['裁剪', '三视图'])
const VIDEO_OPERATIONS = new Set(['剪辑', '提帧', '超分'])

class MediaOperationFailure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function isLocalMediaOperation(modality, operation) {
  return modality === 'image'
    ? IMAGE_OPERATIONS.has(operation)
    : modality === 'video' && VIDEO_OPERATIONS.has(operation)
}

function parseLocalMediaReference(value) {
  if (typeof value !== 'string') return null
  const asset = new RegExp('^vibe://app/assets/(' + UUID + ')$', 'iu').exec(value)
  if (asset) return { type: 'asset', id: asset[1].toLowerCase() }
  const task = new RegExp('^vibe://app/tasks/(' + UUID + ')/output(?:\\?index=([0-3]))?$', 'iu').exec(value)
  if (task) return { type: 'task', id: task[1].toLowerCase(), outputIndex: Number(task[2] ?? 0) }
  return null
}

function assertInside(root, target) {
  const relative = path.relative(root, target)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '本地媒体不属于当前项目。')
  }
  return relative
}

async function resolveLocalMediaOperationSource(value, options) {
  const reference = parseLocalMediaReference(value)
  if (!reference) {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '本地后处理仅支持当前项目中的素材或已完成任务结果。')
  }
  if (!options?.localCore || typeof options.projectId !== 'string' || !options.projectId
    || typeof options.projectDirectory !== 'string' || !options.projectDirectory) {
    throw new MediaOperationFailure('TASK_PROJECT_CONTEXT_CHANGED', '当前项目不可用，无法处理本地媒体。')
  }

  let resolved
  try {
    resolved = reference.type === 'asset'
      ? await options.localCore.request('asset:resolve', { assetId: reference.id })
      : await options.localCore.request('task:resolve-output-preview', {
        projectId: options.projectId,
        taskId: reference.id,
        outputIndex: reference.outputIndex,
      })
  } catch {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '本地媒体不存在或无法读取。')
  }

  const expectedPrefix = options.modality === 'image' ? 'image/' : options.modality === 'video' ? 'video/' : ''
  if (!expectedPrefix || typeof resolved?.mimeType !== 'string' || !resolved.mimeType.startsWith(expectedPrefix)) {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', options.modality === 'image'
      ? '图片操作需要图片素材或图片任务结果。'
      : '视频操作需要视频素材或视频任务结果。')
  }
  if (!Number.isSafeInteger(resolved.sizeBytes) || resolved.sizeBytes <= 0 || resolved.sizeBytes > MAX_MEDIA_INPUT_BYTES) {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '本地媒体为空或超过 4 GiB 处理上限。')
  }

  const projectRoot = await fs.realpath(options.projectDirectory).catch(() => null)
  const dataRoot = projectRoot && path.join(projectRoot, '.vibepaper')
  const dataInfo = dataRoot ? await fs.lstat(dataRoot).catch(() => null) : null
  if (!dataRoot || !dataInfo?.isDirectory() || dataInfo.isSymbolicLink()
    || path.relative(dataRoot, await fs.realpath(dataRoot).catch(() => '')) !== '') {
    throw new MediaOperationFailure('TASK_PROJECT_CONTEXT_CHANGED', '当前项目媒体目录无效。')
  }
  const filePath = path.resolve(resolved.filePath ?? '')
  const realPath = await fs.realpath(filePath).catch(() => null)
  if (!realPath || path.relative(filePath, realPath) !== '') {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '本地媒体路径无效或指向符号链接。')
  }
  const relative = assertInside(dataRoot, realPath)
  const segments = relative.split(path.sep)
  if (segments[0] !== (reference.type === 'asset' ? 'assets' : 'generated')) {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '本地媒体路径不属于受管素材或任务结果。')
  }
  const info = await fs.lstat(realPath).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size !== resolved.sizeBytes
    || info.size <= 0 || info.size > MAX_MEDIA_INPUT_BYTES) {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '本地媒体在读取期间发生变化或不可用。')
  }
  return realPath
}

function assertOutputDirectory(job) {
  if (typeof job?.taskId !== 'string' || !new RegExp('^' + UUID + '$', 'iu').test(job.taskId)
    || typeof job.outputDirectory !== 'string') {
    throw new MediaOperationFailure('LOCAL_MEDIA_INPUT_INVALID', '后处理任务标识无效。')
  }
  const outputDirectory = path.resolve(job.outputDirectory)
  if (path.basename(outputDirectory) !== job.taskId || path.basename(path.dirname(outputDirectory)) !== 'generated') {
    throw new MediaOperationFailure('LOCAL_MEDIA_INPUT_INVALID', '后处理任务输出目录无效。')
  }
  return outputDirectory
}

async function validateSourceFile(sourcePath, modality) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '没有可读取的本地媒体输入。')
  }
  const info = await fs.lstat(sourcePath).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_MEDIA_INPUT_BYTES) {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '本地媒体不存在、为空或超过 4 GiB 处理上限。')
  }
  const realPath = await fs.realpath(sourcePath).catch(() => null)
  if (!realPath || path.relative(sourcePath, realPath) !== '') {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', '本地媒体不能是符号链接。')
  }
  const allowed = modality === 'image'
    ? new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
    : new Set(['.mp4', '.webm', '.mov', '.m4v'])
  if (!allowed.has(path.extname(sourcePath).toLowerCase())) {
    throw new MediaOperationFailure('LOCAL_MEDIA_SOURCE_INVALID', modality === 'image'
      ? '图片操作仅支持 PNG、JPEG、WebP 或 GIF。'
      : '视频操作仅支持 MP4、WebM、MOV 或 M4V。')
  }
  return info.size
}

function assertOperationJob(job) {
  const operation = job?.parameters?.operation
  if (job?.providerType !== 'local' || job?.providerId !== LOCAL_MEDIA_PROVIDER_ID
    || job?.modelId !== LOCAL_MEDIA_MODEL_ID || !isLocalMediaOperation(job?.modality, operation)) {
    throw new MediaOperationFailure('UNSUPPORTED_MEDIA_OPERATION', '当前本地媒体处理操作不可用。')
  }
  return operation
}

function ffmpegFailure(operation, result) {
  if (result?.error?.code === 'ETIMEDOUT') {
    return new MediaOperationFailure('LOCAL_MEDIA_PROCESSING_TIMEOUT', '本地媒体处理超时。')
  }
  return new MediaOperationFailure('LOCAL_MEDIA_PROCESSING_FAILED', `${operation}失败，请检查本地媒体格式后重试。`)
}

function runCheckedFfmpeg(ffmpegPath, args, timeoutMs, operation, dependencies) {
  const run = dependencies.runFfmpeg ?? runFfmpeg
  const result = run(ffmpegPath, args, timeoutMs)
  if (result?.status !== 0) throw ffmpegFailure(operation, result)
}

function resolveMediaFontFile(options = {}) {
  const env = options.env ?? process.env
  const candidates = [env.VIBEPAPER_MEDIA_FONT].filter((candidate) => typeof candidate === 'string' && candidate.trim())
  const fontDirectory = path.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts')
  if (process.platform === 'win32') {
    candidates.push(
      path.join(fontDirectory, 'arial.ttf'),
      path.join(fontDirectory, 'segoeui.ttf'),
      path.join(fontDirectory, 'calibri.ttf'),
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
      '/System/Library/Fonts/Supplemental/Helvetica.ttf',
      '/System/Library/Fonts/SFNS.ttf',
    )
  } else {
    candidates.push(
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
      '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
      '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
      '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
      '/usr/share/fonts/truetype/msttcorefonts/Arial.ttf',
    )
  }
  return candidates.find((candidate) => {
    try {
      return nativeFs.statSync(candidate).isFile()
    } catch {
      return false
    }
  }) ?? null
}

function escapeFilterFilePath(filePath) {
  return filePath.replace(/\\/gu, '/').replace(/:/gu, '\\:').replace(/'/gu, "\\'")
}

async function assertOutput(filePath, type) {
  const info = await fs.lstat(filePath).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_MEDIA_OUTPUT_BYTES) {
    throw new MediaOperationFailure('LOCAL_MEDIA_OUTPUT_INVALID', '本地媒体处理未生成可读取的结果。')
  }
  const handle = await fs.open(filePath, 'r')
  try {
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const valid = type === 'image'
      ? bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
      : bytesRead >= 8 && header.subarray(0, 32).includes(Buffer.from('ftyp'))
    if (!valid) throw new MediaOperationFailure('LOCAL_MEDIA_OUTPUT_INVALID', '本地媒体处理生成了无效结果。')
  } finally {
    await handle.close().catch(() => undefined)
  }
  return info.size
}

async function runLocalImageOperation(job, dependencies = {}) {
  const operation = assertOperationJob(job)
  if (job.modality !== 'image') throw new MediaOperationFailure('UNSUPPORTED_MODALITY', '图片操作只能用于图片节点。')
  assertOutputDirectory(job)
  await validateSourceFile(job.parameters.sourcePath, 'image')
  const ffmpegPath = dependencies.ffmpegPath ?? resolveFfmpegPath()
  if (!ffmpegPath) throw new MediaOperationFailure('LOCAL_MEDIA_TOOL_UNAVAILABLE', '未找到 FFmpeg，无法执行本地图片处理。')

  const outputPath = path.join(job.outputDirectory, operation === '裁剪' ? 'crop.jpg' : 'three-view.jpg')
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  let filter
  if (operation === '裁剪') {
    const cropMode = job.parameters.cropMode ?? 'single'
    const filters = {
      single: "crop=w='iw-2*floor(min(iw\\,ih)/8)':h='ih-2*floor(min(iw\\,ih)/8)':x='floor(min(iw\\,ih)/8)':y='floor(min(iw\\,ih)/8)'",
      四宫格: 'crop=iw/2:ih/2:0:0',
      九宫格: 'crop=iw/3:ih/3:0:0',
    }
    if (!Object.hasOwn(filters, cropMode)) {
      throw new MediaOperationFailure('LOCAL_MEDIA_INPUT_INVALID', '裁剪模式无效。')
    }
    filter = filters[cropMode]
  } else {
    const categories = { 人物: 'PERSON', 场景: 'SCENE', 产品: 'PRODUCT' }
    const category = categories[job.parameters.threeViewCategory ?? job.parameters.category]
    if (!category) throw new MediaOperationFailure('LOCAL_MEDIA_INPUT_INVALID', '三视图类别无效。')
    const fontFile = dependencies.fontFile ?? resolveMediaFontFile()
    if (!fontFile) throw new MediaOperationFailure('LOCAL_MEDIA_TOOL_UNAVAILABLE', '未找到系统字体，无法为三视图添加角度标注。')
    const fontOption = `fontfile='${escapeFilterFilePath(fontFile)}'`
    const tileWidth = 326
    const tileHeight = 968
    const contentHeight = tileHeight - 26
    const fit = `scale=${tileWidth}:${contentHeight}:force_original_aspect_ratio=increase:flags=lanczos,crop=${tileWidth}:${contentHeight}`
    const tile = (label, source, prefix = '') => `[${source}]${prefix}${fit},pad=${tileWidth}:${tileHeight}:0:26:color=0x141418,drawbox=x=0:y=0:w=iw:h=26:color=0x141418:t=fill,drawbox=x=0:y=0:w=iw:h=ih:color=0x1e1e24:t=2,drawtext=${fontOption}:text=${label}:fontcolor=white:fontsize=18:x=(w-text_w)/2:y=4[v${label.toLowerCase()}]`
    filter = [
      '[0:v]split=3[frontsrc][sidesrc][topsrc]',
      tile('FRONT', 'frontsrc'),
      tile('SIDE', 'sidesrc', 'hflip,'),
      tile('TOP', 'topsrc', 'transpose=clock,'),
      'color=c=0xf5f6fa:s=1024x1024:d=1[bg]',
      '[bg][vfront]overlay=12:40[one]',
      '[one][vside]overlay=348:40[two]',
      `[two][vtop]overlay=684:40,drawtext=${fontOption}:text=THREE-VIEW-${category}:fontcolor=0x282830:fontsize=20:x=12:y=8[out]`,
    ].join(';')
    args.push('-loop', '1')
  }
  args.push('-i', job.parameters.sourcePath)
  if (operation === '三视图') args.push('-filter_complex', filter, '-map', '[out]')
  else args.push('-vf', filter)
  args.push('-frames:v', '1', '-q:v', '2', outputPath)
  runCheckedFfmpeg(ffmpegPath, args, 2 * 60 * 1000, operation, dependencies)
  await assertOutput(outputPath, 'image')
  return {
    outputPath: `generated/${job.taskId}/${path.basename(outputPath)}`,
    outputMeta: {
      index: 0,
      operation,
      outputType: 'image',
      ...(operation === '三视图' ? { category: job.parameters.threeViewCategory ?? job.parameters.category } : {}),
    },
  }
}

function parseVideoResolution(value) {
  const match = typeof value === 'string' ? /^(\d{3,4})x(\d{3,4})$/u.exec(value) : null
  if (!match) throw new MediaOperationFailure('LOCAL_MEDIA_INPUT_INVALID', '视频超分辨率无效。')
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 320 || width > 3840 || height < 180 || height > 2160
    || width % 2 !== 0 || height % 2 !== 0) {
    throw new MediaOperationFailure('LOCAL_MEDIA_INPUT_INVALID', '视频超分辨率必须为 320×180 至 3840×2160 的偶数尺寸。')
  }
  return { width, height }
}

async function runLocalVideoOperation(job, dependencies = {}) {
  const operation = assertOperationJob(job)
  if (job.modality !== 'video') throw new MediaOperationFailure('UNSUPPORTED_MODALITY', '视频操作只能用于视频节点。')
  assertOutputDirectory(job)
  await validateSourceFile(job.parameters.sourcePath, 'video')
  const ffmpegPath = dependencies.ffmpegPath ?? resolveFfmpegPath()
  if (!ffmpegPath) throw new MediaOperationFailure('LOCAL_MEDIA_TOOL_UNAVAILABLE', '未找到 FFmpeg，无法执行本地视频处理。')

  let outputPath
  let args = ['-hide_banner', '-loglevel', 'error', '-y']
  if (operation === '提帧') {
    const frameAt = job.parameters.frameAt ?? 1
    if (typeof frameAt !== 'number' || !Number.isFinite(frameAt) || frameAt < 0 || frameAt > 3600) {
      throw new MediaOperationFailure('LOCAL_MEDIA_INPUT_INVALID', '提帧时间必须在 0 到 3600 秒之间。')
    }
    outputPath = path.join(job.outputDirectory, 'frame.jpg')
    args.push('-i', job.parameters.sourcePath, '-ss', String(frameAt), '-map', '0:v:0', '-frames:v', '1', '-q:v', '2', outputPath)
  } else {
    outputPath = path.join(job.outputDirectory, operation === '剪辑' ? 'trim.mp4' : 'upscale.mp4')
    const videoArgs = ['-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', operation === '剪辑' ? '23' : '20', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-f', 'mp4']
    if (operation === '剪辑') {
      const start = job.parameters.start ?? 0
      const end = job.parameters.end ?? 5
      if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
        || start < 0 || end <= start || end > 3600) {
        throw new MediaOperationFailure('LOCAL_MEDIA_INPUT_INVALID', '剪辑起止时间无效。')
      }
      const duration = end - start
      args.push('-ss', String(start), '-i', job.parameters.sourcePath, '-t', String(duration), ...videoArgs, outputPath)
    } else {
      const { width, height } = parseVideoResolution(job.parameters.resolution ?? '1920x1080')
      const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
      args.push('-i', job.parameters.sourcePath, '-vf', filter, ...videoArgs, outputPath)
    }
  }
  runCheckedFfmpeg(ffmpegPath, args, 15 * 60 * 1000, operation, dependencies)
  const outputType = operation === '提帧' ? 'image' : 'video'
  await assertOutput(outputPath, outputType)
  return {
    outputPath: `generated/${job.taskId}/${path.basename(outputPath)}`,
    outputMeta: { index: 0, operation, outputType },
  }
}

async function runLocalMediaOperation(job, dependencies = {}) {
  return job?.modality === 'image'
    ? runLocalImageOperation(job, dependencies)
    : runLocalVideoOperation(job, dependencies)
}

module.exports = {
  IMAGE_OPERATIONS,
  LOCAL_MEDIA_MODEL_ID,
  LOCAL_MEDIA_PROVIDER_ID,
  MAX_MEDIA_INPUT_BYTES,
  MediaOperationFailure,
  VIDEO_OPERATIONS,
  assertInside,
  isLocalMediaOperation,
  parseLocalMediaReference,
  resolveMediaFontFile,
  resolveLocalMediaOperationSource,
  runLocalImageOperation,
  runLocalMediaOperation,
  runLocalVideoOperation,
}
