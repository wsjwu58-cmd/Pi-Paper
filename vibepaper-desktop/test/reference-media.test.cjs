const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const {
  MAX_REFERENCE_IMAGE_BYTES,
  parseLocalReference,
  resolveGenerationMediaReferences,
  resolveGenerationImageReferences,
} = require('../src/reference-media.cjs')
const {
  WorkerFailure,
  buildAgnesImageRequest,
  buildAgnesVideoRequest,
  buildArkVideoRequest,
  runImageTask,
} = require('../src/generation-worker.cjs')
const { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID } = require('../src/agnes-model-catalog.cjs')
const { ARK_MODELS, ARK_PROVIDER_ID } = require('../src/ark-model-catalog.cjs')
const { createDramaBatchTaskInput } = require('../src/drama-render-batch.cjs')

const ASSET_ID = '22222222-2222-4222-8222-222222222222'
const OUTPUT_ID = '33333333-3333-4333-8333-333333333333'

test('voice conversion can upload bounded local WAV only through the explicit audio capability', async (t) => {
  const { store, directory, project } = await openProject(t)
  const bytes = Buffer.alloc(46)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(38, 4); bytes.write('WAVE', 8)
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(2, 40); bytes.writeInt16LE(100, 44)
  const source = path.join(directory, 'voice.wav')
  await fs.writeFile(source, bytes)
  const asset = await store.importAsset(source, project.projectId, 'local')
  const parameters = { referenceAudios: [`vibe://app/assets/${asset.assetId}`] }
  const options = { projectId: project.projectId, projectDirectory: directory, localCore: { request: (_method, payload) => store.resolveAsset(payload.assetId) } }
  await assert.rejects(resolveGenerationMediaReferences(parameters, options), (error) => error.code === 'CLOUD_REFERENCE_UPLOAD_UNAVAILABLE')
  const resolved = await resolveGenerationMediaReferences(parameters, { ...options, allowInlineAudio: true })
  assert.deepEqual(resolved.referenceAudios, [`data:audio/wav;base64,${bytes.toString('base64')}`])
  const stored = await store.resolveAsset(asset.assetId)
  await fs.writeFile(stored.absolutePath || stored.filePath || stored.path, Buffer.alloc(bytes.length))
  await assert.rejects(resolveGenerationMediaReferences(parameters, { ...options, allowInlineAudio: true }), (error) => error.code === 'CLOUD_INPUT_INVALID')
})
const PNG_BYTES = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('actual local image reference bytes'),
])
const RESULT_BYTES = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('actual task output image bytes'),
])

async function openProject(t) {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-reference-media-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })
  const opened = await store.createProject(parentDirectory, 'Reference Media Test')
  return { store, ...opened }
}

function generationJob(modality, parameters) {
  return {
    taskId: '99999999-9999-4999-8999-999999999999',
    modality,
    providerType: 'cloud',
    providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS[modality],
    endpoint: AGNES_API_BASE_URL,
    apiKey: 'mock-cloud-key-not-a-secret',
    prompt: 'reference payload contract',
    parameters,
    outputDirectory: path.join('test-project', '.vibepaper', 'generated', '99999999-9999-4999-8999-999999999999'),
  }
}

test('local asset and task-output URIs resolve to their actual bounded image bytes and provider payloads', async (t) => {
  const { store, directory, project } = await openProject(t)
  const assetSource = path.join(directory, 'source.png')
  await fs.writeFile(assetSource, PNG_BYTES)
  const asset = await store.importAsset(assetSource, project.projectId)
  const task = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 0,
    nodeId: null,
    modality: 'image',
    providerType: 'cloud',
    providerId: 'test-provider',
    modelId: 'test-image-model',
    idempotencyKey: 'reference-output-fixture',
    parameters: { prompt: 'output fixture' },
  })
  const claimed = await store.claimNextTask(project.projectId)
  assert.equal(claimed.task.taskId, task.taskId)
  await fs.writeFile(path.join(claimed.outputDirectory, 'result.png'), RESULT_BYTES)
  await store.recordTaskSucceeded(project.projectId, task.taskId, `generated/${task.taskId}/result.png`)

  const assetUri = `vibe://app/assets/${asset.assetId}`
  const taskUri = `vibe://app/tasks/${task.taskId}/output`
  const localCore = {
    request(method, payload) {
      if (method === 'asset:resolve') return store.resolveAsset(payload.assetId)
      if (method === 'task:resolve-output-preview') {
        return store.resolveTaskOutputForPreview(payload.projectId, payload.taskId)
      }
      throw new Error(`Unexpected Local Core method: ${method}`)
    },
  }
  const parameters = await resolveGenerationImageReferences({
    imageUrl: assetUri,
    firstFrameUrl: assetUri,
    lastFrameUrl: taskUri,
    referenceImages: [assetUri],
    referenceUrls: [assetUri],
  }, { localCore, projectId: project.projectId, projectDirectory: directory })

  const assetDataUrl = `data:image/png;base64,${PNG_BYTES.toString('base64')}`
  const taskDataUrl = `data:image/png;base64,${RESULT_BYTES.toString('base64')}`
  assert.equal(parameters.imageUrl, assetDataUrl)
  assert.equal(parameters.firstFrameUrl, assetDataUrl)
  assert.equal(parameters.lastFrameUrl, taskDataUrl)
  assert.deepEqual(parameters.referenceImages, [assetDataUrl])
  assert.deepEqual(parameters.referenceUrls, [assetDataUrl])
  assert.deepEqual(Buffer.from(parameters.imageUrl.slice(parameters.imageUrl.indexOf(',') + 1), 'base64'), PNG_BYTES)
  assert.deepEqual(Buffer.from(parameters.lastFrameUrl.slice(parameters.lastFrameUrl.indexOf(',') + 1), 'base64'), RESULT_BYTES)

  const videoRequest = buildAgnesVideoRequest(generationJob('video', parameters))
  assert.equal(videoRequest.mode, 'keyframe')
  assert.equal(videoRequest.first_frame, assetDataUrl)
  assert.equal(videoRequest.last_frame, taskDataUrl)
  assert.equal(Object.hasOwn(videoRequest, 'extra_body'), false)

  const imageRequest = buildAgnesImageRequest(generationJob('image', parameters))
  assert.deepEqual(imageRequest.extra_body, {
    response_format: 'url',
    image: [PNG_BYTES.toString('base64')],
  })

  let sentRequest
  await runImageTask(generationJob('image', parameters), {
    postJson: async (url, payload) => {
      sentRequest = { url, payload }
      return { data: [{ url: 'https://media.example-cdn.net/result.png' }] }
    },
    downloadAgnesOutput: async () => `generated/${task.taskId}/image.png`,
  })
  assert.equal(sentRequest.url, `${AGNES_API_BASE_URL}/images/generations`)
  assert.deepEqual(sentRequest.payload.extra_body, imageRequest.extra_body)
})

test('confirmed batch first-frame task URI resolves for Agnes and Ark video requests', async (t) => {
  const { store, directory, project } = await openProject(t)
  await store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes: [
      { id: 'keyframe-node', type: 'image', position: { x: 0, y: 0 }, data: { creativeType: 'keyframe', params: {} } },
      { id: 'video-node', type: 'video', position: { x: 200, y: 0 }, data: { creativeType: 'clip', params: {} } },
    ],
    edges: [],
  })
  const keyframeTask = await store.createTask({
    projectId: project.projectId,
    canvasId: project.canvasId,
    canvasVersion: 1,
    nodeId: 'keyframe-node',
    modality: 'image',
    providerType: 'cloud',
    providerId: AGNES_PROVIDER_ID,
    modelId: AGNES_MODELS.image,
    idempotencyKey: 'accepted-keyframe-task',
    parameters: { prompt: 'accepted keyframe fixture' },
  })
  const claimed = await store.claimNextTask(project.projectId)
  assert.equal(claimed.task.taskId, keyframeTask.taskId)
  await fs.writeFile(path.join(claimed.outputDirectory, 'result.png'), RESULT_BYTES)
  await store.recordTaskSucceeded(project.projectId, keyframeTask.taskId, `generated/${keyframeTask.taskId}/result.png`)

  const taskInput = createDramaBatchTaskInput({
    projectId: project.projectId,
    canvasId: project.canvasId,
    batchId: 'batch-1',
    canvasVersion: 1,
    job: {
      id: 'job-1', attempt: 0, canvasNodeId: 'video-node', keyframeRenderId: keyframeTask.taskId,
      providerType: 'cloud', providerId: AGNES_PROVIDER_ID, modelId: AGNES_MODELS.video,
      modelParams: { prompt: 'Continue the accepted frame', seconds: 4, aspect_ratio: '9:16' },
    },
  })
  assert.equal(taskInput.idempotencyKey, 'drama-batch:batch-1:job:job-1:attempt:0')
  assert.equal(taskInput.parameters.firstFrameUrl, `vibe://app/tasks/${keyframeTask.taskId}/output`)

  const localCore = {
    request(method, payload) {
      if (method === 'task:resolve-output-preview') {
        return store.resolveTaskOutputForPreview(payload.projectId, payload.taskId)
      }
      throw new Error(`Unexpected Local Core method: ${method}`)
    },
  }
  const resolvedParameters = await resolveGenerationMediaReferences(taskInput.parameters, {
    localCore,
    projectId: project.projectId,
    projectDirectory: directory,
  })
  const expectedImage = `data:image/png;base64,${RESULT_BYTES.toString('base64')}`
  assert.equal(resolvedParameters.firstFrameUrl, expectedImage)

  const agnesRequest = buildAgnesVideoRequest({
    ...generationJob('video', resolvedParameters),
    parameters: resolvedParameters,
  })
  assert.equal(agnesRequest.mode, 'keyframe')
  assert.equal(agnesRequest.first_frame, expectedImage)
  assert.equal(Object.hasOwn(agnesRequest, 'extra_body'), false)

  const arkRequest = buildArkVideoRequest({
    ...generationJob('video', resolvedParameters),
    providerId: ARK_PROVIDER_ID,
    modelId: ARK_MODELS.video,
    parameters: { ...resolvedParameters, seconds: 4 },
  })
  assert.equal(arkRequest.content[1].type, 'image_url')
  assert.equal(arkRequest.content[1].image_url.url, expectedImage)
  assert.doesNotMatch(arkRequest.content[1].image_url.url, /^vibe:/u)
})

test('local reference resolver rejects forged URLs, untrusted paths, MIME mismatches, and oversized images', async (t) => {
  const { directory, project } = await openProject(t)
  const assetId = ASSET_ID
  const contentHash = 'a'.repeat(64)
  const assetDirectory = path.join(directory, '.vibepaper', 'assets', contentHash)
  await fs.mkdir(assetDirectory, { recursive: true })
  const imagePath = path.join(assetDirectory, `${assetId}.png`)
  await fs.writeFile(imagePath, PNG_BYTES)
  const localCore = {
    request: async (_method, { assetId: requestedId }) => ({
      filePath: requestedId === assetId ? imagePath : path.join(os.tmpdir(), 'outside.png'),
      mimeType: 'image/jpeg',
    }),
  }

  for (const value of [
    `vibe://evil/assets/${assetId}`,
    `vibe://app/assets/${assetId}?download=1`,
    `vibe://app/assets/${assetId}/../${assetId}`,
    'file:///C:/Users/example/image.png',
  ]) {
    if (value.startsWith('vibe:')) {
      await assert.rejects(
        resolveGenerationImageReferences({ imageUrl: value }, { localCore, projectId: project.projectId, projectDirectory: directory }),
        (error) => error.code === 'CLOUD_REFERENCE_UNAVAILABLE',
      )
    } else {
      const { normalizeAgnesVideoReference } = require('../src/generation-worker.cjs')
      assert.throws(() => normalizeAgnesVideoReference(value), (error) => error.code === 'CLOUD_REFERENCE_UNAVAILABLE')
    }
  }

  await assert.rejects(
    resolveGenerationImageReferences({ imageUrl: `vibe://app/assets/${assetId}` }, { localCore, projectId: project.projectId, projectDirectory: directory }),
    (error) => error.code === 'CLOUD_INPUT_INVALID' && /格式不匹配/u.test(error.message),
  )

  const oversizedPath = path.join(assetDirectory, `${OUTPUT_ID}.png`)
  const handle = await fs.open(oversizedPath, 'w')
  try {
    await handle.write(PNG_BYTES.subarray(0, 8), 0, 8, 0)
    await handle.truncate(MAX_REFERENCE_IMAGE_BYTES + 1)
  } finally {
    await handle.close()
  }
  localCore.request = async () => ({
    filePath: oversizedPath,
    mimeType: 'image/png',
    sizeBytes: MAX_REFERENCE_IMAGE_BYTES + 1,
  })
  await assert.rejects(
    resolveGenerationImageReferences({ imageUrl: `vibe://app/assets/${OUTPUT_ID}` }, { localCore, projectId: project.projectId, projectDirectory: directory }),
    (error) => error.code === 'CLOUD_INPUT_INVALID' && /20 MiB/u.test(error.message),
  )
})

test('local media URL parser only accepts exact app asset and successful-output forms', () => {
  assert.deepEqual(parseLocalReference(`vibe://app/assets/${ASSET_ID}`), { type: 'asset', id: ASSET_ID })
  assert.deepEqual(parseLocalReference(`vibe://app/tasks/${OUTPUT_ID}/output`), { type: 'task-output', id: OUTPUT_ID })
  assert.throws(() => parseLocalReference(`vibe://app/tasks/${OUTPUT_ID}/output/extra`), /地址无效/u)
})

test('local video references are ownership and metadata checked, then visibly blocked without an Ark upload contract', async (t) => {
  const { store, directory, project } = await openProject(t)
  const videoSource = path.join(directory, 'reference.mp4')
  const mp4Header = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0])
  await fs.writeFile(videoSource, mp4Header)
  const asset = await store.importAsset(videoSource, project.projectId, 'local')
  const localCore = {
    request(method, payload) {
      if (method === 'asset:resolve') return store.resolveAsset(payload.assetId)
      throw new Error(`Unexpected Local Core method: ${method}`)
    },
  }
  await assert.rejects(
    resolveGenerationMediaReferences({ referenceVideos: [`vibe://app/assets/${asset.assetId}`] }, {
      localCore, projectId: project.projectId, projectDirectory: directory,
    }),
    (error) => error.code === 'CLOUD_REFERENCE_UPLOAD_UNAVAILABLE'
      && /HTTPS 媒体地址/u.test(error.message)
      && /未发送本地路径或文件内容/u.test(error.message),
  )
})

test('the same local URI is rechecked when it is reused under a different reference kind', async (t) => {
  const { store, directory, project } = await openProject(t)
  const imageSource = path.join(directory, 'reference.png')
  await fs.writeFile(imageSource, PNG_BYTES)
  const asset = await store.importAsset(imageSource, project.projectId)
  let resolves = 0
  const localCore = {
    request(method, payload) {
      if (method === 'asset:resolve') {
        resolves += 1
        return store.resolveAsset(payload.assetId)
      }
      throw new Error(`Unexpected Local Core method: ${method}`)
    },
  }
  const uri = `vibe://app/assets/${asset.assetId}`
  await assert.rejects(
    resolveGenerationMediaReferences({ referenceImages: [uri], referenceVideos: [uri] }, {
      localCore, projectId: project.projectId, projectDirectory: directory,
    }),
    (error) => error.code === 'CLOUD_INPUT_INVALID' && /类型与引用字段不匹配/u.test(error.message),
  )
  assert.equal(resolves, 2)
})

test('Agnes image request rejects unsupported data-image MIME types and mismatched signatures', () => {
  const job = generationJob('image', { imageUrl: 'data:image/gif;base64,R0lGODlh' })
  assert.throws(() => buildAgnesImageRequest(job), (error) => error instanceof WorkerFailure && error.code === 'CLOUD_INPUT_INVALID')
  const wrongSignature = `data:image/jpeg;base64,${PNG_BYTES.toString('base64')}`
  assert.throws(() => buildAgnesImageRequest(generationJob('image', { imageUrl: wrongSignature })),
    (error) => error instanceof WorkerFailure && error.code === 'CLOUD_INPUT_INVALID')
})
