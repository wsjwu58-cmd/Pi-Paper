const fs = require('node:fs/promises')
const nativeFs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')

const COMPOSE_PROVIDER_ID = 'mock-compose'
const COMPOSE_MODEL_ID = 'compose-1.0'
const MAX_COMPOSE_INPUTS = 10_000
const MAX_MEDIA_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024

class ComposeFailure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function isFile(filePath, executable = false) {
  try {
    if (!nativeFs.statSync(filePath).isFile()) return false
    if (executable && process.platform !== 'win32') nativeFs.accessSync(filePath, nativeFs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findOnPath(name, env, platform) {
  const extensions = platform === 'win32'
    ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`)
      if (isFile(candidate, true)) return candidate
    }
  }
  return null
}

function findWinGetFfmpeg(env) {
  if (!env.LOCALAPPDATA) return null
  const root = path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
  let packages
  try {
    packages = nativeFs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  const candidates = []
  for (const entry of packages) {
    if (!entry.isDirectory() || !/^Gyan\.FFmpeg/iu.test(entry.name)) continue
    const packageRoot = path.join(root, entry.name)
    const pending = [{ directory: packageRoot, depth: 0 }]
    while (pending.length) {
      const current = pending.pop()
      if (current.depth > 6) continue
      let entries
      try {
        entries = nativeFs.readdirSync(current.directory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of entries) {
        const childPath = path.join(current.directory, child.name)
        if (child.isDirectory()) pending.push({ directory: childPath, depth: current.depth + 1 })
        else if (/^ffmpeg\.exe$/iu.test(child.name) && /[\\/]bin$/iu.test(current.directory) && isFile(childPath)) {
          try {
            candidates.push({ path: childPath, modifiedAt: nativeFs.statSync(childPath).mtimeMs })
          } catch {
            // Ignore files that disappear during discovery.
          }
        }
      }
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
  return candidates[0]?.path ?? null
}

function findImageioFfmpeg(env, platform) {
  const candidates = platform === 'win32'
    ? [{ command: 'python', args: ['-c'] }, { command: 'py', args: ['-3', '-c'] }]
    : [{ command: 'python3', args: ['-c'] }, { command: 'python', args: ['-c'] }]
  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [
      ...candidate.args,
      'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())',
    ], { env, encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const filePath = result.status === 0 ? result.stdout.trim().split(/\r?\n/u).at(-1) : ''
    if (filePath && isFile(filePath, true)) return filePath
  }
  return null
}

function resolveFfmpegPath(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  // Match generation-service's settings.ffmpeg_path (VIBEPAPER_FFMPEG_PATH)
  // and explicit FFMPEG_PATH override before falling back to discovery.
  const configured = (env.VIBEPAPER_FFMPEG_PATH || env.FFMPEG_PATH || '').trim()
  if (configured && isFile(configured, platform !== 'win32')) return configured
  const onPath = findOnPath(platform === 'win32' ? 'ffmpeg' : 'ffmpeg', env, platform)
  if (onPath) return onPath
  if (platform === 'win32') {
    const winGet = findWinGetFfmpeg(env)
    if (winGet) return winGet
  }
  return findImageioFfmpeg(env, platform)
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
  const result = spawnSync(ffmpegPath, args, {
    encoding: null,
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  return {
    status: result.status,
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : '',
    error: result.error ?? null,
  }
}

function errorTail(result) {
  return String(result?.stderr || result?.error?.message || '').slice(-400)
}

function assertWorkerOutputDirectory(directory, taskId) {
  const absolute = path.resolve(directory)
  if (path.basename(absolute) !== taskId || path.basename(path.dirname(absolute)) !== 'generated') {
    throw new ComposeFailure('MODEL_UNAVAILABLE', '合成任务输出目录无效。')
  }
  return absolute
}

async function validMp4(filePath) {
  let handle
  try {
    handle = await fs.open(filePath, 'r')
    const header = Buffer.alloc(64)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    return bytesRead >= 8 && header.subarray(0, 32).includes(Buffer.from('ftyp'))
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function validateInputPaths(inputPaths, generatedDirectory) {
  if (!Array.isArray(inputPaths) || inputPaths.length < 2 || inputPaths.length > MAX_COMPOSE_INPUTS) {
    throw new ComposeFailure('INVALID_INPUT', '合成至少需要 2 段视频输入。')
  }
  const rootInfo = await fs.lstat(generatedDirectory).catch(() => null)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()
    || path.relative(generatedDirectory, await fs.realpath(generatedDirectory)) !== '') {
    throw new ComposeFailure('INVALID_INPUT', '本地生成结果目录缺失或路径无效。')
  }
  const realRoot = await fs.realpath(generatedDirectory)
  const paths = []
  for (let index = 0; index < inputPaths.length; index += 1) {
    const candidate = inputPaths[index]
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new ComposeFailure('INVALID_INPUT', `无法读取第 ${index + 1} 段视频。`)
    }
    const info = await fs.lstat(candidate).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_MEDIA_OUTPUT_BYTES) {
      throw new ComposeFailure('INVALID_INPUT', `无法读取第 ${index + 1} 段视频。`)
    }
    const realPath = await fs.realpath(candidate)
    const relative = path.relative(realRoot, realPath)
    const parts = relative.split(path.sep)
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || parts.length !== 2 || !/^[a-f0-9-]{36}$/iu.test(parts[0])
      || !['.mp4', '.webm', '.mov'].includes(path.extname(parts[1]).toLowerCase())) {
      throw new ComposeFailure('INVALID_INPUT', `无法读取第 ${index + 1} 段视频。`)
    }
    paths.push(realPath)
  }
  return paths
}

function runAndCheck(execute, ffmpegPath, args, timeoutMs, failureMessage) {
  const result = execute(ffmpegPath, args, timeoutMs)
  if (result.error || result.status !== 0) {
    const detail = errorTail(result)
    throw new ComposeFailure('MODEL_UNAVAILABLE', `${failureMessage}${detail ? `：${detail}` : ''}`)
  }
}

async function composeVideos(job, overrides = {}) {
  const resolveFfmpeg = overrides.resolveFfmpegPath ?? resolveFfmpegPath
  const execute = overrides.runFfmpeg ?? runFfmpeg
  const validateMp4 = overrides.validMp4 ?? validMp4
  if (typeof job?.taskId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(job.taskId)) {
    throw new ComposeFailure('INVALID_INPUT', '合成任务标识无效。')
  }
  const outputDirectory = assertWorkerOutputDirectory(job.outputDirectory, job.taskId)
  const outputRoot = path.dirname(outputDirectory)
  const outputDirInfo = await fs.lstat(outputDirectory).catch(() => null)
  const realOutputDirectory = outputDirInfo?.isDirectory() && !outputDirInfo.isSymbolicLink()
    ? await fs.realpath(outputDirectory)
    : null
  if (!realOutputDirectory || path.relative(outputDirectory, realOutputDirectory) !== '') {
    throw new ComposeFailure('MODEL_UNAVAILABLE', '合成任务输出目录缺失或路径无效。')
  }

  const inputPaths = await validateInputPaths(job.inputPaths, outputRoot)
  const ffmpegPath = resolveFfmpeg()
  if (!ffmpegPath) throw new ComposeFailure('MODEL_UNAVAILABLE', '合成需要 ffmpeg，请安装后重试。')

  const workDirectory = path.join(outputDirectory, '_compose_inputs')
  const workInfo = await fs.lstat(workDirectory).catch(() => null)
  if (workInfo?.isSymbolicLink() || (workInfo && !workInfo.isDirectory())) {
    throw new ComposeFailure('MODEL_UNAVAILABLE', '合成临时目录无效。')
  }
  if (workInfo) await fs.rm(workDirectory, { recursive: true, force: true })
  await fs.mkdir(workDirectory)

  const temporaryOutput = path.join(outputDirectory, `.result-${randomUUID()}.mp4`)
  const normalized = []
  try {
    for (let index = 0; index < inputPaths.length; index += 1) {
      const outputPath = path.join(workDirectory, `norm_${index}.mp4`)
      runAndCheck(execute, ffmpegPath, [
        '-y', '-i', inputPaths[index],
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=24',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest',
        outputPath,
      ], 180_000, `第 ${index + 1} 段视频转码失败`)
      if (!await validateMp4(outputPath)) {
        throw new ComposeFailure('MODEL_UNAVAILABLE', `第 ${index + 1} 段视频转码失败：输出不是有效 MP4。`)
      }
      normalized.push(outputPath)
    }

    const listFile = path.join(workDirectory, 'concat.txt')
    await fs.writeFile(listFile, normalized.map((filePath) => `file '${path.basename(filePath)}'\n`).join(''), { encoding: 'utf8', mode: 0o600 })
    const concatArgs = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', temporaryOutput]
    let concat = execute(ffmpegPath, concatArgs, 180_000)
    if (concat.error || concat.status !== 0 || !await validateMp4(temporaryOutput)) {
      await fs.rm(temporaryOutput, { force: true })
      const fallbackArgs = [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', temporaryOutput,
      ]
      concat = execute(ffmpegPath, fallbackArgs, 240_000)
      if (concat.error || concat.status !== 0 || !await validateMp4(temporaryOutput)) {
        const detail = errorTail(concat)
        throw new ComposeFailure('MODEL_UNAVAILABLE', `视频拼接失败${detail ? `：${detail}` : ''}`)
      }
    }

    const outputInfo = await fs.lstat(temporaryOutput).catch(() => null)
    if (!outputInfo?.isFile() || outputInfo.isSymbolicLink() || outputInfo.size <= 0
      || outputInfo.size > MAX_MEDIA_OUTPUT_BYTES) {
      throw new ComposeFailure('MODEL_UNAVAILABLE', '视频拼接结果为空、格式无效或超过本地保存上限。')
    }
    const outputPath = path.join(outputDirectory, 'result.mp4')
    const existingOutput = await fs.lstat(outputPath).catch(() => null)
    if (existingOutput?.isSymbolicLink() || (existingOutput && !existingOutput.isFile())) {
      throw new ComposeFailure('MODEL_UNAVAILABLE', '合成结果文件路径无效。')
    }
    if (existingOutput) await fs.rm(outputPath, { force: true })
    await fs.rename(temporaryOutput, outputPath)
    if (!await validateMp4(outputPath)) throw new ComposeFailure('MODEL_UNAVAILABLE', '合成结果不是有效 MP4。')
    return { outputPath: `generated/${job.taskId}/result.mp4` }
  } catch (error) {
    if (error instanceof ComposeFailure) throw error
    throw new ComposeFailure('MODEL_UNAVAILABLE', error instanceof Error ? error.message.slice(0, 500) : '视频合成失败。')
  } finally {
    await fs.rm(temporaryOutput, { force: true }).catch(() => undefined)
    await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

module.exports = {
  COMPOSE_MODEL_ID,
  COMPOSE_PROVIDER_ID,
  ComposeFailure,
  composeVideos,
  resolveFfmpegPath,
}
