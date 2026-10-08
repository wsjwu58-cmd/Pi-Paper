const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const nativeFs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const {
  LOCAL_MEDIA_MODEL_ID,
  LOCAL_MEDIA_PROVIDER_ID,
  MediaOperationFailure,
  parseLocalMediaReference,
  resolveLocalMediaOperationSource,
  resolveMediaFontFile,
  runLocalImageOperation,
  runLocalVideoOperation,
} = require('../src/media-postprocess.cjs')
const { resolveFfmpegPath, runFfmpeg } = require('../src/compose-provider.cjs')

const ffmpegPath = resolveFfmpegPath()
const ffprobePath = ffmpegPath
  ? path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  : null
const mediaToolsAvailable = Boolean(ffmpegPath && ffprobePath && nativeFs.existsSync(ffprobePath))

test('three-view font resolution accepts an explicit portable font override', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-media-font-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const fontPath = path.join(root, 'portable-font.ttf')
  await fs.writeFile(fontPath, 'font test placeholder')
  assert.equal(resolveMediaFontFile({ env: { VIBEPAPER_MEDIA_FONT: fontPath } }), fontPath)
})

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr || `${command} failed`)
  return result.stdout.trim()
}

function probe(filePath) {
  const text = runCommand(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-show_entries', 'format=duration', '-of', 'json', filePath,
  ])
  return JSON.parse(text)
}

function postprocessJob({ taskId, outputDirectory, modality, operation, sourcePath, ...parameters }) {
  return {
    taskId,
    outputDirectory,
    modality,
    providerType: 'local',
    providerId: LOCAL_MEDIA_PROVIDER_ID,
    modelId: LOCAL_MEDIA_MODEL_ID,
    parameters: { operation, sourcePath, ...parameters },
  }
}

async function createTaskDirectory(root, taskId) {
  const outputDirectory = path.join(root, '.vibepaper', 'generated', taskId)
  await fs.mkdir(outputDirectory, { recursive: true })
  return outputDirectory
}

test('local media references are project scoped and modality checked', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-media-source-'))
  const projectDirectory = path.join(root, 'project')
  const filePath = path.join(projectDirectory, '.vibepaper', 'assets', 'hash', '00000000-0000-4000-8000-000000000001.png')
  const foreignPath = path.join(root, 'outside.png')
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.mkdir(path.join(projectDirectory, '.vibepaper', 'generated'), { recursive: true })
  await fs.writeFile(filePath, Buffer.from('png content'))
  await fs.writeFile(foreignPath, Buffer.from('png content'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const source = 'vibe://app/assets/00000000-0000-4000-8000-000000000001'
  const localCore = {
    request: async (method) => {
      assert.equal(method, 'asset:resolve')
      return { filePath, mimeType: 'image/png', sizeBytes: 11 }
    },
  }
  assert.equal(await resolveLocalMediaOperationSource(source, {
    localCore, projectId: 'project-1', projectDirectory, modality: 'image',
  }), filePath)
  await assert.rejects(resolveLocalMediaOperationSource(source, {
    localCore: { request: async () => ({ filePath: foreignPath, mimeType: 'image/png', sizeBytes: 11 }) },
    projectId: 'project-1', projectDirectory, modality: 'image',
  }), (error) => error instanceof MediaOperationFailure && error.code === 'LOCAL_MEDIA_SOURCE_INVALID')
  await assert.rejects(resolveLocalMediaOperationSource(source, {
    localCore, projectId: 'project-1', projectDirectory, modality: 'video',
  }), (error) => error instanceof MediaOperationFailure && error.code === 'LOCAL_MEDIA_SOURCE_INVALID')
  assert.deepEqual(parseLocalMediaReference('vibe://app/tasks/00000000-0000-4000-8000-000000000002/output?index=2'), {
    type: 'task', id: '00000000-0000-4000-8000-000000000002', outputIndex: 2,
  })
  assert.equal(parseLocalMediaReference('file:///outside.png'), null)
})

test('local crop and three-view transform the supplied image into readable outputs', {
  skip: !mediaToolsAvailable && 'FFmpeg/FFprobe are unavailable',
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-image-ops-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const sourcePath = path.join(root, 'source.png')
  runCommand(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=800x600:d=1', '-frames:v', '1', sourcePath])

  const cropId = '00000000-0000-4000-8000-000000000011'
  const cropDirectory = await createTaskDirectory(root, cropId)
  const crop = await runLocalImageOperation(postprocessJob({
    taskId: cropId, outputDirectory: cropDirectory, modality: 'image', operation: '裁剪',
    sourcePath, cropMode: '四宫格',
  }), { ffmpegPath, runFfmpeg })
  assert.equal(crop.outputPath, `generated/${cropId}/crop.jpg`)
  assert.deepEqual(crop.outputMeta, { index: 0, operation: '裁剪', outputType: 'image' })
  assert.deepEqual(probe(path.join(cropDirectory, 'crop.jpg')).streams[0], { width: 400, height: 300 })

  const threeId = '00000000-0000-4000-8000-000000000012'
  const threeDirectory = await createTaskDirectory(root, threeId)
  const three = await runLocalImageOperation(postprocessJob({
    taskId: threeId, outputDirectory: threeDirectory, modality: 'image', operation: '三视图',
    sourcePath, threeViewCategory: '产品',
  }), { ffmpegPath, runFfmpeg })
  assert.deepEqual(three.outputMeta, { index: 0, operation: '三视图', outputType: 'image', category: '产品' })
  assert.deepEqual(probe(path.join(threeDirectory, 'three-view.jpg')).streams[0], { width: 1024, height: 1024 })
})

test('video trim, frame extraction, and upscale use the source video', {
  skip: !mediaToolsAvailable && 'FFmpeg/FFprobe are unavailable',
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-video-ops-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const sourcePath = path.join(root, 'source.mp4')
  runCommand(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc=size=320x240:rate=10:duration=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', sourcePath,
  ])

  const trimId = '00000000-0000-4000-8000-000000000021'
  const trimDirectory = await createTaskDirectory(root, trimId)
  const trim = await runLocalVideoOperation(postprocessJob({
    taskId: trimId, outputDirectory: trimDirectory, modality: 'video', operation: '剪辑',
    sourcePath, start: 1, end: 2,
  }), { ffmpegPath, runFfmpeg })
  assert.equal(trim.outputMeta.outputType, 'video')
  const trimmedProbe = probe(path.join(trimDirectory, 'trim.mp4'))
  assert.deepEqual(trimmedProbe.streams[0], { width: 320, height: 240 })
  assert.ok(Number(trimmedProbe.format.duration) <= 1.2)

  const frameId = '00000000-0000-4000-8000-000000000022'
  const frameDirectory = await createTaskDirectory(root, frameId)
  const frame = await runLocalVideoOperation(postprocessJob({
    taskId: frameId, outputDirectory: frameDirectory, modality: 'video', operation: '提帧',
    sourcePath, frameAt: 1,
  }), { ffmpegPath, runFfmpeg })
  assert.deepEqual(frame.outputMeta, { index: 0, operation: '提帧', outputType: 'image' })
  assert.deepEqual(probe(path.join(frameDirectory, 'frame.jpg')).streams[0], { width: 320, height: 240 })

  const upscaleId = '00000000-0000-4000-8000-000000000023'
  const upscaleDirectory = await createTaskDirectory(root, upscaleId)
  const upscale = await runLocalVideoOperation(postprocessJob({
    taskId: upscaleId, outputDirectory: upscaleDirectory, modality: 'video', operation: '超分',
    sourcePath, resolution: '1920x1080',
  }), { ffmpegPath, runFfmpeg })
  assert.equal(upscale.outputMeta.outputType, 'video')
  assert.deepEqual(probe(path.join(upscaleDirectory, 'upscale.mp4')).streams[0], { width: 1920, height: 1080 })
})
