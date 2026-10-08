const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const PROVIDER_ID = 'local-sapi-tts'
const MODEL_ID = 'local-sapi-tts'
const MAX_TEXT_LENGTH = 20_000
const SYNTHESIS_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024
const TONE_VOLUME = Object.freeze({ neutral: 100, calm: 88, warm: 94, energetic: 100 })

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$payload = ConvertFrom-Json -InputObject $reader.ReadToEnd()
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $culture = New-Object System.Globalization.CultureInfo([string]$payload.language)
  $gender = if ([string]$payload.voice -match '(^|[^a-z])male([^a-z]|$)|^(man|masculine|m|男)$|男') {
    [System.Speech.Synthesis.VoiceGender]::Male
  } else {
    [System.Speech.Synthesis.VoiceGender]::Female
  }
  try { $synth.SelectVoiceByHints($gender, [System.Speech.Synthesis.VoiceAge]::Adult, 0, $culture) } catch { }
  $synth.Rate = [int]$payload.rate
  $synth.Volume = [int]$payload.volume
  $synth.SetOutputToWaveFile([string]$payload.outputPath)
  $synth.Speak([string]$payload.text)
  [Console]::Out.Write((ConvertTo-Json -InputObject $synth.Voice.Name -Compress))
} finally {
  $synth.Dispose()
}
`

class SapiFailure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function roundHalfToEven(value) {
  const floor = Math.floor(value)
  const fraction = value - floor
  if (fraction < 0.5) return floor
  if (fraction > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

function isMaleVoice(voice) {
  return /(^|[^a-z])male([^a-z]|$)|^(man|masculine|m|男)$|男/iu.test(String(voice || ''))
}

function normalizeSapiParams(parameters = {}) {
  const params = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters : {}
  const prompt = params.prompt == null ? '' : String(params.prompt).trim()
  const referenceTexts = typeof params.referenceTexts === 'string'
    ? (params.referenceTexts.trim() ? [params.referenceTexts] : [])
    : Array.isArray(params.referenceTexts)
      ? params.referenceTexts.filter((value) => value != null && String(value).trim()).map((value) => String(value).trim())
      : []
  const generatedPrompt = [...referenceTexts, ...(prompt ? [prompt] : [])].join('\n')
  const text = generatedPrompt || (params.text == null ? '' : String(params.text || '').trim())
  const voice = String(params.voice || 'female').trim().toLowerCase()
  const containsCjk = /[\u4e00-\u9fff]/u.test(text)
  const language = String(params.language || (containsCjk ? 'zh-CN' : 'en-US'))

  let speed = 1
  const rawSpeed = params.speed === undefined ? 1 : params.speed
  if (typeof rawSpeed === 'number' || (typeof rawSpeed === 'string' && rawSpeed.trim())) {
    const parsed = Number(rawSpeed)
    if (Number.isFinite(parsed)) speed = parsed
  }
  speed = Math.max(0.5, Math.min(speed, 2))
  const rate = Math.max(-10, Math.min(10, roundHalfToEven(Math.log2(speed) * 5)))
  const tone = String(params.tone || 'neutral').trim().toLowerCase()

  return {
    text,
    voice,
    language,
    rate,
    volume: TONE_VOLUME[tone] ?? 100,
    tone,
    toneApplied: Object.hasOwn(TONE_VOLUME, tone),
    textHash: createHash('sha256').update(text, 'utf8').digest('hex'),
  }
}

async function ensureOutputDirectory(outputDirectory, taskId) {
  if (typeof taskId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(taskId)
    || typeof outputDirectory !== 'string') {
    throw new SapiFailure('INVALID_INPUT', '语音合成任务标识无效。')
  }
  const directory = path.resolve(outputDirectory)
  if (path.basename(directory) !== taskId || path.basename(path.dirname(directory)) !== 'generated') {
    throw new SapiFailure('MODEL_OUTPUT_INVALID', '语音合成结果目录无效。')
  }
  for (const candidate of [path.dirname(directory), directory]) {
    const info = await fs.lstat(candidate).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink() || path.relative(candidate, await fs.realpath(candidate)) !== '') {
      throw new SapiFailure('MODEL_OUTPUT_INVALID', '语音合成结果目录缺失或路径无效。')
    }
  }
  return directory
}

async function inspectWave(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 44 || info.size > MAX_OUTPUT_BYTES) {
      throw new SapiFailure('MODEL_OUTPUT_INVALID', 'Windows SAPI 未生成有效 WAV。')
    }
    const header = Buffer.alloc(12)
    const firstRead = await handle.read(header, 0, header.length, 0)
    if (firstRead.bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'RIFF'
      || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new SapiFailure('MODEL_OUTPUT_INVALID', 'Windows SAPI 未生成有效 WAV。')
    }
    const declaredFileSize = header.readUInt32LE(4) + 8
    if (declaredFileSize > info.size || declaredFileSize < 44) {
      throw new SapiFailure('MODEL_OUTPUT_INVALID', 'Windows SAPI WAV 文件头无效。')
    }

    let offset = 12
    let sampleRate = 0
    let blockAlign = 0
    let dataLength = 0
    while (offset + 8 <= declaredFileSize) {
      const chunkHeader = Buffer.alloc(8)
      const read = await handle.read(chunkHeader, 0, chunkHeader.length, offset)
      if (read.bytesRead !== chunkHeader.length) break
      const chunkType = chunkHeader.toString('ascii', 0, 4)
      const chunkLength = chunkHeader.readUInt32LE(4)
      const chunkDataOffset = offset + 8
      if (chunkLength > declaredFileSize - chunkDataOffset) {
        throw new SapiFailure('MODEL_OUTPUT_INVALID', 'Windows SAPI WAV 分块长度无效。')
      }
      if (chunkType === 'fmt ') {
        if (chunkLength < 16) throw new SapiFailure('MODEL_OUTPUT_INVALID', 'Windows SAPI WAV 音频格式无效。')
        const format = Buffer.alloc(16)
        const formatRead = await handle.read(format, 0, format.length, chunkDataOffset)
        if (formatRead.bytesRead !== format.length) throw new SapiFailure('MODEL_OUTPUT_INVALID', 'Windows SAPI WAV 音频格式无效。')
        sampleRate = format.readUInt32LE(4)
        blockAlign = format.readUInt16LE(12)
      } else if (chunkType === 'data') {
        dataLength = chunkLength
      }
      if (sampleRate && blockAlign && dataLength) break
      offset = chunkDataOffset + chunkLength + (chunkLength % 2)
    }
    if (!sampleRate || sampleRate < 8_000 || sampleRate > 384_000 || !blockAlign || !dataLength || dataLength % blockAlign !== 0) {
      throw new SapiFailure('MODEL_OUTPUT_INVALID', 'Windows SAPI WAV 不含有效音频数据。')
    }
    const frames = dataLength / blockAlign
    return { durationMs: Math.round(frames * 1000 / sampleRate), sampleRate }
  } finally {
    await handle.close()
  }
}

function runPowerShell(payload, options = {}) {
  const spawnProcess = options.spawn ?? spawn
  const executable = options.executable ?? 'powershell.exe'
  return new Promise((resolve, reject) => {
    let stdout = ''
    let settled = false
    const child = spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new SapiFailure('MODEL_TIMEOUT', 'Windows SAPI 语音合成超时。'))
    }, options.timeoutMs ?? SYNTHESIS_TIMEOUT_MS)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-16 * 1024) })
    child.stderr.resume()
    child.once('error', () => finish(new SapiFailure('MEDIA_PROCESSING_FAILED', '无法启动 Windows PowerShell。')))
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new SapiFailure('MEDIA_PROCESSING_FAILED', 'Windows SAPI 语音合成失败。'))
        return
      }
      let selectedVoice
      try {
        selectedVoice = JSON.parse(stdout.trim() || '""')
      } catch {
        selectedVoice = payload.voice
      }
      finish(null, typeof selectedVoice === 'string' && selectedVoice ? selectedVoice : payload.voice)
    })
    child.stdin.once('error', () => undefined)
    child.stdin.end(JSON.stringify(payload), 'utf8')
  })
}

async function runWindowsSapiTts(job, options = {}) {
  const params = { ...(job?.parameters ?? {}) }
  if (!String(params.prompt || '').trim() && typeof job?.prompt === 'string' && job.prompt.trim()) {
    params.prompt = job.prompt
  }
  const normalized = normalizeSapiParams(params)
  if (!normalized.text) throw new SapiFailure('INVALID_INPUT', '语音合成需要非空文本。')
  if (Array.from(normalized.text).length > MAX_TEXT_LENGTH) {
    throw new SapiFailure('INVALID_INPUT', `语音合成文本不能超过 ${MAX_TEXT_LENGTH} 字符。`)
  }
  if ((options.platform ?? process.platform) !== 'win32') {
    throw new SapiFailure('MODEL_UNAVAILABLE', 'local-sapi-tts 仅支持 Windows。')
  }

  const outputDirectory = await ensureOutputDirectory(job.outputDirectory, job.taskId)
  const temporaryPath = path.join(outputDirectory, `.result.${randomUUID()}.wav`)
  const outputPath = path.join(outputDirectory, 'result.wav')
  const payload = { ...normalized, outputPath: temporaryPath }
  let selectedVoice
  try {
    selectedVoice = await runPowerShell(payload, options)
    const wave = await inspectWave(temporaryPath)
    await fs.rename(temporaryPath, outputPath)
    return {
      outputPath: `generated/${job.taskId}/result.wav`,
      outputMeta: {
        index: 0,
        outputType: 'audio',
        voiceId: String(selectedVoice || normalized.voice),
        language: normalized.language,
        rate: normalized.rate,
        toneApplied: normalized.toneApplied,
        textHash: normalized.textHash,
        durationMs: wave.durationMs,
        sampleRate: wave.sampleRate,
        provider: PROVIDER_ID,
      },
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    if (error instanceof SapiFailure) throw error
    throw new SapiFailure('MEDIA_PROCESSING_FAILED', 'Windows SAPI 语音合成失败。')
  }
}

module.exports = {
  MODEL_ID,
  PROVIDER_ID,
  POWERSHELL_SCRIPT,
  SapiFailure,
  MAX_TEXT_LENGTH,
  inspectWave,
  isMaleVoice,
  normalizeSapiParams,
  roundHalfToEven,
  runPowerShell,
  runWindowsSapiTts,
}
