const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const {
  MAX_REFERENCE_IMAGE_BYTES,
  parseLocalReference,
  resolveGenerationImageReferences,
} = require('../src/reference-media.cjs')
const {
  WorkerFailure,
  buildAgnesImageRequest,
  buildAgnesVideoRequest,
  runImageTask,
} = require('../src/generation-worker.cjs')
const { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID } = require('../src/agnes-model-catalog.cjs')

const ASSET_ID = '22222222-2222-4222-8222-222222222222'
const OUTPUT_ID = '33333333-3333-4333-8333-333333333333'
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
  assert.deepEqual(videoRequest.extra_body, {
    image: [assetDataUrl, taskDataUrl],
    mode: 'keyframes',
  })

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

test('Agnes image request rejects unsupported data-image MIME types and mismatched signatures', () => {
  const job = generationJob('image', { imageUrl: 'data:image/gif;base64,R0lGODlh' })
  assert.throws(() => buildAgnesImageRequest(job), (error) => error instanceof WorkerFailure && error.code === 'CLOUD_INPUT_INVALID')
  const wrongSignature = `data:image/jpeg;base64,${PNG_BYTES.toString('base64')}`
  assert.throws(() => buildAgnesImageRequest(generationJob('image', { imageUrl: wrongSignature })),
    (error) => error instanceof WorkerFailure && error.code === 'CLOUD_INPUT_INVALID')
})
