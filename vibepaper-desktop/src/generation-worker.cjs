const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const parentPort = process.parentPort
const { normalizeLocalTextModelConfig } = require('./local-model-catalog.cjs')
const { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID } = require('./agnes-model-catalog.cjs')
const { composeVideos: runComposeVideos, ComposeFailure } = require('./compose-provider.cjs')

if (!parentPort) throw new Error('Generation Worker must run as an Electron utility process.')

const MAX_PROMPT_CHARS = 200_000
const MAX_OUTPUT_CHARS = 20_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000
const AGNES_VIDEO_POLL_INTERVAL_MS = 10_000
const AGNES_VIDEO_TIMEOUT_MS = 15 * 60 * 1000
const MAX_MEDIA_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024

class WorkerFailure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function postJson(endpoint, payload, apiKey = null, timeoutMs = REQUEST_TIMEOUT_MS) {
  const url = new URL(endpoint)
  const transport = url.protocol === 'https:' ? require('node:https') : require('node:http')
  const body = Buffer.from(JSON.stringify(payload), 'utf8')

  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': body.length,
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      if (response.statusCode !== 200 && response.statusCode !== 201 && response.statusCode !== 202) {
        response.resume()
        reject(new WorkerFailure(apiKey ? 'CLOUD_REQUEST_FAILED' : 'LOCAL_MODEL_REQUEST_FAILED', `模型服务返回 HTTP ${response.statusCode ?? '错误'}。`))
        return
      }

      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new WorkerFailure(apiKey ? 'CLOUD_INVALID_RESPONSE' : 'LOCAL_MODEL_INVALID_RESPONSE', '模型响应过大。'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new WorkerFailure(apiKey ? 'CLOUD_INVALID_RESPONSE' : 'LOCAL_MODEL_INVALID_RESPONSE', '模型服务返回了无法读取的响应。'))
        }
      })
    })

    request.on('timeout', () => request.destroy(new WorkerFailure(apiKey ? 'CLOUD_REQUEST_TIMEOUT' : 'LOCAL_MODEL_UNAVAILABLE', '模型请求超时。')))
    request.on('error', (error) => {
      if (error instanceof WorkerFailure) reject(error)
      else reject(new WorkerFailure(apiKey ? 'CLOUD_PROVIDER_UNAVAILABLE' : 'LOCAL_MODEL_UNAVAILABLE', '无法连接模型服务。'))
    })
    request.end(body)
  })
}

function extractText(response) {
  const content = response?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content.map((part) => part && part.type === 'text' && typeof part.text === 'string' ? part.text : '')
    if (parts.some(Boolean)) return parts.join('')
  }
  throw new WorkerFailure('LOCAL_MODEL_INVALID_RESPONSE', '本地模型没有返回文本结果。')
}

async function writeOutput(outputDirectory, taskId, fileName, output) {
  const directory = path.resolve(outputDirectory)
  if (path.basename(directory) !== taskId || path.basename(path.dirname(directory)) !== 'generated') {
    throw new WorkerFailure('LOCAL_MODEL_OUTPUT_INVALID', '本地任务输出目录无效。')
  }
  const rootInfo = await fs.lstat(path.dirname(directory)).catch(() => null)
  const directoryInfo = await fs.lstat(directory).catch(() => null)
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()
    || !directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()
    || path.relative(directory, await fs.realpath(directory)) !== '') {
    throw new WorkerFailure('LOCAL_MODEL_OUTPUT_INVALID', '本地任务输出目录缺失或路径无效。')
  }

  if (!/^(?:result\.txt|result\.(?:png|jpg|webp|mp4|webm))$/u.test(fileName)
    || !Buffer.isBuffer(output) || output.length === 0 || output.length > MAX_MEDIA_OUTPUT_BYTES) {
    throw new WorkerFailure('MODEL_OUTPUT_INVALID', '模型结果为空、格式无效或超过本地保存上限。')
  }

  if (fileName === 'result.txt' && output.length > MAX_OUTPUT_BYTES) {
    throw new WorkerFailure('LOCAL_MODEL_INVALID_RESPONSE', '文本结果超过本地保存上限。')
  }
  const outputPath = path.join(directory, fileName)
  const temporaryPath = path.join(directory, `.result.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(output)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, outputPath)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw new WorkerFailure('LOCAL_MODEL_OUTPUT_INVALID', '无法保存本地模型结果文件。')
  }
  return `generated/${taskId}/${fileName}`
}

async function writeTextOutput(outputDirectory, taskId, text) {
  return writeOutput(outputDirectory, taskId, 'result.txt', Buffer.from(text, 'utf8'))
}

async function runTextTask(job) {
  const taskId = job?.taskId
  const prompt = job?.prompt
  if (typeof taskId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(taskId)
    || typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS) {
    throw new WorkerFailure('LOCAL_MODEL_INPUT_INVALID', '本地文本任务输入无效。')
  }

  const cloud = job?.providerType === 'cloud'
  let endpoint
  let modelId
  if (cloud) {
    assertAgnesJob(job, 'text')
    endpoint = `${AGNES_API_BASE_URL}/chat/completions`
    modelId = AGNES_MODELS.text
  } else {
    try {
      const model = normalizeLocalTextModelConfig({ endpoint: job.endpoint, modelId: job.modelId })
      endpoint = `${model.endpoint}/chat/completions`
      modelId = model.modelId
    } catch {
      throw new WorkerFailure('LOCAL_MODEL_CONFIGURATION_INVALID', '本地文本模型配置无效。')
    }
  }
  const response = await postJson(endpoint, {
    model: modelId,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  }, cloud ? job.apiKey : null)
  let content
  try {
    content = extractText(response)
  } catch (error) {
    if (cloud && error instanceof WorkerFailure) {
      throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 未返回可用的文本结果。')
    }
    throw error
  }
  if (content.length > MAX_OUTPUT_CHARS || Buffer.byteLength(content, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new WorkerFailure(cloud ? 'CLOUD_INVALID_RESPONSE' : 'LOCAL_MODEL_INVALID_RESPONSE', '模型结果超过本地保存上限。')
  }
  const outputPath = await writeTextOutput(job.outputDirectory, taskId, content)
  return { outputPath }
}

function assertAgnesJob(job, modality) {
  if (job?.providerType !== 'cloud' || job?.providerId !== AGNES_PROVIDER_ID
    || job?.modelId !== AGNES_MODELS[modality] || job?.endpoint !== AGNES_API_BASE_URL
    || typeof job?.apiKey !== 'string' || job.apiKey.length < 16 || job.apiKey.length > 1024
    || /\s|[\u0000-\u001f\u007f]/u.test(job.apiKey)) {
    throw new WorkerFailure('CLOUD_CONFIGURATION_INVALID', 'Agnes 云端模型配置无效。')
  }
}

function agnesMediaUrl(value) {
  if (typeof value !== 'string') {
    throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回的媒体地址无效。')
  }
  if (value.startsWith('data:')) {
    if (value.length > MAX_RESPONSE_BYTES) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回的媒体数据过大。')
    return value
  }
  if (value.length > 4096) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回的媒体地址无效。')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回的媒体地址无效。')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !(url.hostname === 'apihub.agnes-ai.com' || url.hostname.endsWith('.agnes-ai.com'))) {
    throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了不受信任的媒体地址。')
  }
  return url.toString()
}

function getAgnesResponse(urlValue, apiKey, timeoutMs = 60_000) {
  const url = new URL(agnesMediaUrl(urlValue))
  const headers = apiKey ? { authorization: `Bearer ${apiKey}`, accept: 'application/json' } : { accept: '*/*' }
  return new Promise((resolve, reject) => {
    const request = require('node:https').get(url, { headers, timeout: timeoutMs }, (response) => resolve(response))
    request.on('timeout', () => request.destroy(new WorkerFailure('CLOUD_REQUEST_TIMEOUT', 'Agnes 请求超时。')))
    request.on('error', (error) => reject(error instanceof WorkerFailure
      ? error
      : new WorkerFailure('CLOUD_PROVIDER_UNAVAILABLE', '无法连接 Agnes 服务。')))
  })
}

async function downloadAgnesOutput(urlValue, outputDirectory, taskId, modality) {
  const mediaUrl = agnesMediaUrl(urlValue)
  if (mediaUrl.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=]+)$/iu.exec(mediaUrl)
    if (!match) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了无法保存的媒体数据。')
    const encoded = match[2].replace(/=+$/u, '')
    const buffer = Buffer.from(encoded, 'base64')
    if (encoded.length % 4 === 1 || buffer.toString('base64').replace(/=+$/u, '') !== encoded) {
      throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了无效的媒体数据。')
    }
    const ext = extensionForMediaType(match[1], modality)
    return writeOutput(outputDirectory, taskId, `result.${ext}`, buffer)
  }

  const response = await getAgnesResponse(mediaUrl, null, 180_000)
  if (response.statusCode !== 200) {
    response.resume()
    throw new WorkerFailure('CLOUD_MEDIA_DOWNLOAD_FAILED', '无法从 Agnes 下载生成结果。')
  }
  const extension = extensionForMediaType(response.headers['content-type'], modality, mediaUrl)
  const directory = path.resolve(outputDirectory)
  if (path.basename(directory) !== taskId || path.basename(path.dirname(directory)) !== 'generated') {
    response.destroy()
    throw new WorkerFailure('MODEL_OUTPUT_INVALID', '本地任务输出目录无效。')
  }
  const directoryInfo = await fs.lstat(directory).catch(() => null)
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()
    || path.relative(directory, await fs.realpath(directory)) !== '') {
    response.destroy()
    throw new WorkerFailure('MODEL_OUTPUT_INVALID', '本地任务输出目录无效。')
  }
  const finalPath = path.join(directory, `result.${extension}`)
  const temporaryPath = path.join(directory, `.result.${randomUUID()}.tmp`)
  let handle
  let totalBytes = 0
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    for await (const chunkValue of response) {
      const chunk = Buffer.from(chunkValue)
      totalBytes += chunk.length
      if (totalBytes > MAX_MEDIA_OUTPUT_BYTES) {
        response.destroy()
        throw new WorkerFailure('CLOUD_OUTPUT_TOO_LARGE', 'Agnes 媒体结果超过本地保存上限。')
      }
      let offset = 0
      while (offset < chunk.length) {
        const write = await handle.write(chunk, offset, chunk.length - offset)
        offset += write.bytesWritten
      }
    }
    if (totalBytes === 0) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了空媒体文件。')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, finalPath)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    if (error instanceof WorkerFailure) throw error
    throw new WorkerFailure('MODEL_OUTPUT_INVALID', '无法保存 Agnes 媒体结果。')
  }
  return `generated/${taskId}/result.${extension}`
}

function extensionForMediaType(contentType, modality, fallbackUrl = '') {
  const type = typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : ''
  if (modality === 'image') {
    if (type === 'image/png' || (!type && /\.png(?:$|[?#])/iu.test(fallbackUrl))) return 'png'
    if (type === 'image/jpeg' || (!type && /\.jpe?g(?:$|[?#])/iu.test(fallbackUrl))) return 'jpg'
    if (type === 'image/webp' || (!type && /\.webp(?:$|[?#])/iu.test(fallbackUrl))) return 'webp'
  }
  if (modality === 'video') {
    if (type === 'video/mp4' || (!type && /\.mp4(?:$|[?#])/iu.test(fallbackUrl))) return 'mp4'
    if (type === 'video/webm' || (!type && /\.webm(?:$|[?#])/iu.test(fallbackUrl))) return 'webm'
  }
  throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了不支持的媒体格式。')
}

async function runImageTask(job) {
  assertAgnesJob(job, 'image')
  assertTaskOutputTarget(job)
  const prompt = typeof job.prompt === 'string' ? job.prompt.trim() : ''
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw new WorkerFailure('CLOUD_INPUT_INVALID', '图像生成提示词无效。')
  const parameters = job.parameters && typeof job.parameters === 'object' ? job.parameters : {}
  const size = ['1K', '2K', '3K', '4K'].includes(String(parameters.size ?? '').toUpperCase())
    ? String(parameters.size).toUpperCase() : '2K'
  const ratio = parameters.ratio ?? parameters.aspectRatio ?? '1:1'
  if (!['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', '2:3', '3:2'].includes(ratio)) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Agnes 图像比例无效。')
  }
  const response = await postJson(`${AGNES_API_BASE_URL}/images/generations`, {
    model: AGNES_MODELS.image,
    prompt: prompt.slice(0, 2000),
    n: 1,
    size,
    ratio,
    extra_body: { response_format: 'url' },
  }, job.apiKey, 6 * 60 * 1000)
  const candidates = [response?.data?.[0], response?.data, response]
  let url = null
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    if (typeof candidate.url === 'string') {
      url = candidate.url
      break
    }
    if (typeof candidate.b64_json === 'string') {
      url = `data:image/jpeg;base64,${candidate.b64_json}`
      break
    }
  }
  if (!url) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 未返回图像结果。')
  return { outputPath: await downloadAgnesOutput(url, job.outputDirectory, job.taskId, 'image') }
}

function buildAgnesVideoRequest(job) {
  const parameters = job.parameters && typeof job.parameters === 'object' ? job.parameters : {}
  const prompt = typeof job.prompt === 'string' ? job.prompt.trim() : ''
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw new WorkerFailure('CLOUD_INPUT_INVALID', '视频生成提示词无效。')
  const rawSeconds = Number(parameters.seconds ?? parameters.duration ?? 5)
  const seconds = Number.isFinite(rawSeconds) ? Math.floor(rawSeconds) : 0
  if (seconds < 4 || seconds > 12) throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Agnes 视频时长必须在 4 到 12 秒之间。')
  const aspectRatio = parameters.aspect_ratio ?? parameters.aspectRatio ?? parameters.ratio ?? '16:9'
  if (!['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(aspectRatio)) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Agnes 视频比例无效。')
  }
  return {
    model: AGNES_MODELS.video,
    prompt: prompt.slice(0, 2000),
    mode: 'text',
    seconds: String(seconds),
    size: '720P',
    aspect_ratio: aspectRatio,
    n: 1,
  }
}

function extractVideoUrl(payload) {
  const candidates = [
    payload?.metadata,
    payload?.output,
    payload?.data?.content,
    payload?.data?.[0],
    payload?.data,
    payload,
  ]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const values = Array.isArray(candidate) ? candidate : [candidate]
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      for (const key of ['url', 'video_url', 'output_url']) {
        if (typeof value[key] === 'string') return value[key]
        if (value[key] && typeof value[key] === 'object' && typeof value[key].url === 'string') {
          return value[key].url
        }
      }
    }
  }
  return null
}

async function runVideoTask(job) {
  assertAgnesJob(job, 'video')
  assertTaskOutputTarget(job)
  const body = buildAgnesVideoRequest(job)
  const created = await postJson(`${AGNES_API_BASE_URL}/videos`, body, job.apiKey, 60_000)
  const videoId = created?.video_id ?? created?.id ?? created?.task_id
  if (typeof videoId !== 'string' && typeof videoId !== 'number') {
    throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 未返回视频任务标识。')
  }
  const deadline = Date.now() + AGNES_VIDEO_TIMEOUT_MS
  let lastStatus = ''
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, AGNES_VIDEO_POLL_INTERVAL_MS))
    const pollUrl = `https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(String(videoId))}&model_name=${encodeURIComponent(AGNES_MODELS.video)}`
    let status
    try {
      status = await getAgnesResponse(pollUrl, job.apiKey, 60_000)
    } catch {
      continue
    }
    if (status.statusCode === 429 || (status.statusCode >= 500 && status.statusCode < 600)) {
      status.resume()
      continue
    }
    if (status.statusCode !== 200) {
      status.resume()
      throw new WorkerFailure('CLOUD_REQUEST_FAILED', 'Agnes 视频状态查询失败。')
    }
    const chunks = []
    let size = 0
    for await (const chunk of status) {
      size += chunk.length
      if (size > MAX_RESPONSE_BYTES) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 视频状态响应过大。')
      chunks.push(chunk)
    }
    let payload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new WorkerFailure('CLOUD_INVALID_RESPONSE', '无法读取 Agnes 视频状态。')
    }
    lastStatus = typeof payload?.status === 'string' ? payload.status.toLowerCase() : ''
    if (['failed', 'error', 'cancelled', 'canceled'].includes(lastStatus)) {
      throw new WorkerFailure('CLOUD_GENERATION_FAILED', 'Agnes 视频生成失败。')
    }
    if (['completed', 'succeeded', 'success', 'done'].includes(lastStatus)) {
      const videoUrl = extractVideoUrl(payload)
      if (!videoUrl) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 视频任务已完成，但没有返回视频地址。')
      return { outputPath: await downloadAgnesOutput(videoUrl, job.outputDirectory, job.taskId, 'video') }
    }
  }
  throw new WorkerFailure('CLOUD_REQUEST_TIMEOUT', `Agnes 视频任务超时（最后状态：${lastStatus || '未知'}）。`)
}

function assertTaskOutputTarget(job) {
  if (typeof job?.taskId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(job.taskId)
    || typeof job?.outputDirectory !== 'string') {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', '生成任务标识无效。')
  }
}

let running = false
parentPort.on('message', async (event) => {
  const request = event?.data ?? event
  if (!request || !Number.isSafeInteger(request.id)
    || !['generate:text', 'generate:image', 'generate:video', 'generate:compose'].includes(request.method)) return
  if (running) {
    parentPort.postMessage({ id: request.id, ok: false, errorCode: 'WORKER_BUSY' })
    return
  }
  running = true
  try {
    const result = request.method === 'generate:text' ? await runTextTask(request.payload)
      : request.method === 'generate:image' ? await runImageTask(request.payload)
        : request.method === 'generate:video' ? await runVideoTask(request.payload)
          : await runComposeVideos(request.payload)
    parentPort.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      errorCode: error instanceof WorkerFailure || error instanceof ComposeFailure
        ? error.code : 'LOCAL_MODEL_EXECUTION_FAILED',
    })
  } finally {
    running = false
  }
})
