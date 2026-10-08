const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  MAX_TEXT_LENGTH,
  POWERSHELL_SCRIPT,
  SapiFailure,
  inspectWave,
  isMaleVoice,
  normalizeSapiParams,
  roundHalfToEven,
  runPowerShell,
  runWindowsSapiTts,
} = require('../src/sapi-tts.cjs')
const { createLocalProjectStore } = require('../src/project-store.cjs')

const TASK_ID = '11111111-1111-4111-8111-111111111111'

function outputDirectory(root, taskId = TASK_ID) {
  return path.join(root, 'generated', taskId)
}

async function createOutputDirectory(root, taskId = TASK_ID) {
  const directory = outputDirectory(root, taskId)
  await fs.mkdir(directory, { recursive: true })
  return directory
}

function audioTask(directory, parameters = {}) {
  return {
    taskId: TASK_ID,
    modality: 'audio',
    providerType: 'local',
    providerId: 'local-sapi-tts',
    modelId: 'local-sapi-tts',
    prompt: parameters.prompt ?? 'Hello from VibePaper',
    parameters,
    outputDirectory: directory,
  }
}

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

function outputMeta(overrides = {}) {
  return {
    index: 0,
    outputType: 'audio',
    voiceId: 'Microsoft Zira Desktop',
    language: 'en-US',
    rate: 0,
    toneApplied: true,
    textHash: 'a'.repeat(64),
    durationMs: 1,
    sampleRate: 16_000,
    provider: 'local-sapi-tts',
    ...overrides,
  }
}

test('SAPI input normalization preserves original defaults, speed, tone and hash semantics', () => {
  const normalized = normalizeSapiParams({
    prompt: '  你好  ',
    voice: ' FEMALE ',
    speed: 2,
    tone: 'calm',
    language: 'zh-CN',
  })
  assert.equal(normalized.text, '你好')
  assert.equal(normalized.voice, 'female')
  assert.equal(normalized.language, 'zh-CN')
  assert.equal(normalized.rate, 5)
  assert.equal(normalized.volume, 88)
  assert.equal(normalized.toneApplied, true)
  assert.match(normalized.textHash, /^[a-f0-9]{64}$/u)

  const unknownTone = normalizeSapiParams({ prompt: 'hello', tone: 'mystery' })
  assert.equal(unknownTone.volume, 100)
  assert.equal(unknownTone.toneApplied, false)
  assert.equal(normalizeSapiParams({ prompt: '中文' }).language, 'zh-CN')
  assert.equal(normalizeSapiParams({ prompt: 'hello' }).language, 'en-US')
  for (const [speed, expectedRate] of [[0.5, -5], [0.95, 0], [1, 0], [1.5, 3], [2, 5]]) {
    assert.equal(normalizeSapiParams({ prompt: 'hello', speed }).rate, expectedRate)
  }
  assert.equal(normalizeSapiParams({ prompt: 'hello', speed: Math.SQRT2 }).rate, 3)
  assert.equal(roundHalfToEven(2.5), 2)
  assert.equal(roundHalfToEven(-2.5), -2)
})

test('female voice is not classified as male', () => {
  assert.equal(isMaleVoice('female'), false)
  assert.equal(isMaleVoice('Microsoft Zira Desktop'), false)
  assert.equal(isMaleVoice('male'), true)
  assert.equal(isMaleVoice('男'), true)
  assert.match(POWERSHELL_SCRIPT, /\^\(man\|masculine\|m\|男\)\$/u)
})

test('SAPI rejects empty and over-limit text before platform or process checks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-sapi-invalid-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await assert.rejects(
    runWindowsSapiTts(audioTask(outputDirectory(root), { prompt: '' }), { platform: 'linux' }),
    (error) => error instanceof SapiFailure && error.code === 'INVALID_INPUT',
  )
  await assert.rejects(
    runWindowsSapiTts(audioTask(outputDirectory(root), { prompt: '界'.repeat(MAX_TEXT_LENGTH + 1) }), { platform: 'linux' }),
    (error) => error instanceof SapiFailure && error.code === 'INVALID_INPUT',
  )
})

test('SAPI reports MODEL_UNAVAILABLE on platforms without Windows System.Speech', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-sapi-platform-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await assert.rejects(
    runWindowsSapiTts(audioTask(outputDirectory(root)), { platform: 'linux' }),
    (error) => error instanceof SapiFailure && error.code === 'MODEL_UNAVAILABLE',
  )
})

test('PowerShell receives the JSON request through stdin, never through process arguments', async () => {
  let args = []
  let stdin = ''
  const fakeSpawn = (_executable, processArgs) => {
    args = processArgs
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {}
    child.stdin.on('data', (chunk) => { stdin += chunk.toString('utf8') })
    child.stdin.on('finish', () => {
      setImmediate(() => {
        child.stdout.end('"Test Voice"')
        child.emit('close', 0)
      })
    })
    return child
  }
  const text = 'private text that must not appear in argv'
  const selectedVoice = await runPowerShell({ text, voice: 'female' }, { spawn: fakeSpawn })
  assert.equal(selectedVoice, 'Test Voice')
  assert.equal(JSON.parse(stdin).text, text)
  assert.equal(args.includes(text), false)
  assert.ok(args.includes(POWERSHELL_SCRIPT))
})

test('PowerShell stderr cannot place spoken text in a task error', async () => {
  const text = 'private words emitted in an error'
  const fakeSpawn = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => {}
    child.stdin.on('finish', () => {
      setImmediate(() => {
        child.stderr.end(`PowerShell error mentioning ${text}`)
        child.stdout.end('')
        child.emit('close', 1)
      })
    })
    return child
  }
  await assert.rejects(
    runPowerShell({ text, voice: 'female' }, { spawn: fakeSpawn }),
    (error) => error.code === 'MEDIA_PROCESSING_FAILED' && !error.message.includes(text),
  )
})

test('Windows SAPI generates and validates a real WAV file', { skip: process.platform !== 'win32', timeout: 130_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-sapi-real-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directory = await createOutputDirectory(root)
  const result = await runWindowsSapiTts(audioTask(directory, {
    prompt: '你好，VibePaper。',
    voice: 'female',
    language: 'zh-CN',
    speed: 0.95,
    tone: 'calm',
  }))
  assert.equal(result.outputPath, `generated/${TASK_ID}/result.wav`)
  const wavePath = path.join(directory, 'result.wav')
  const inspected = await inspectWave(wavePath)
  assert.ok((await fs.stat(wavePath)).size > 44)
  assert.ok(inspected.durationMs > 0)
  assert.ok(inspected.sampleRate >= 16_000)
  assert.equal(result.outputMeta.language, 'zh-CN')
  assert.match(result.outputMeta.voiceId, /Huihui|Yaoyao/iu)
  assert.equal(result.outputMeta.rate, 0)
  assert.equal(result.outputMeta.toneApplied, true)
  assert.ok(result.outputMeta.textHash)
  assert.equal(result.outputMeta.sampleRate, inspected.sampleRate)
})

test('audio task output preview and idempotency survive project restart', async (t) => {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-audio-task-'))
  let store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const { project, directory: projectDirectory } = await store.createProject(parentDirectory, 'Audio task test')
  const input = {
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 0,
    nodeId: null,
    modality: 'audio',
    providerType: 'local',
    providerId: 'local-sapi-tts',
    modelId: 'local-sapi-tts',
    idempotencyKey: 'audio-preview-restart',
    parameters: { prompt: 'Hello from VibePaper.' },
  }
  const task = await store.createTask(input)
  const claimed = await store.claimNextTask(project.projectId)
  assert.equal(claimed.task.taskId, task.taskId)
  const relativeOutput = `generated/${task.taskId}/result.wav`
  await fs.writeFile(path.join(claimed.outputDirectory, 'result.wav'), minimalWave())
  await store.recordTaskSucceeded(project.projectId, task.taskId, relativeOutput, outputMeta())
  const idempotentSuccess = await store.recordTaskSucceeded(project.projectId, task.taskId, relativeOutput)
  assert.deepEqual(idempotentSuccess.outputMeta, outputMeta())
  await assert.rejects(
    store.recordTaskSucceeded(project.projectId, task.taskId, relativeOutput, outputMeta({ voiceId: 'different voice' })),
    /TASK_RESULT_CONFLICT/u,
  )

  const preview = await store.resolveTaskOutputForPreview(project.projectId, task.taskId)
  assert.equal(preview.mimeType, 'audio/wav')
  assert.equal(preview.sizeBytes, 46)
  const listed = await store.listTasks(project.projectId)
  assert.deepEqual(listed[0].outputMeta, outputMeta())
  const searched = await store.searchTasks(project.projectId, { modality: 'audio', status: 'succeeded' })
  assert.deepEqual(searched.items[0].outputMeta, outputMeta())

  await store.close()
  store = createLocalProjectStore()
  await store.openProject(projectDirectory)
  const replay = await store.createTask(input)
  assert.equal(replay.taskId, task.taskId)
  assert.equal(replay.status, 'succeeded')
  assert.deepEqual((await store.getTask(project.projectId, task.taskId)).outputMeta, outputMeta())
  assert.equal((await store.resolveTaskOutputForPreview(project.projectId, task.taskId)).mimeType, 'audio/wav')
})

test('invalid audio input and unsupported platform persist their task error codes', async (t) => {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-audio-failures-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const { project } = await store.createProject(parentDirectory, 'Audio failures')
  const baseInput = {
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 0,
    nodeId: null,
    modality: 'audio',
    providerType: 'local',
    providerId: 'local-sapi-tts',
    modelId: 'local-sapi-tts',
  }
  const cases = [
    { key: 'audio-empty-text', parameters: { prompt: '' }, platform: 'win32', code: 'INVALID_INPUT' },
    { key: 'audio-platform-unavailable', parameters: { prompt: 'Hello.' }, platform: 'linux', code: 'MODEL_UNAVAILABLE' },
  ]
  for (const [index, item] of cases.entries()) {
    const task = await store.createTask({ ...baseInput, idempotencyKey: item.key, parameters: item.parameters })
    const claimed = await store.claimNextTask(project.projectId)
    assert.equal(claimed.task.taskId, task.taskId)
    const request = audioTask(claimed.outputDirectory, claimed.parameters)
    request.taskId = task.taskId
    let executionError
    try {
      await runWindowsSapiTts(request, { platform: item.platform })
    } catch (error) {
      executionError = error
    }
    assert.equal(executionError?.code, item.code)
    await store.recordTaskFailed(project.projectId, task.taskId, executionError.code)
    const failed = await store.getTask(project.projectId, task.taskId)
    assert.equal(failed.status, 'failed', `case ${index}`)
    assert.equal(failed.errorCode, item.code)
  }
})
