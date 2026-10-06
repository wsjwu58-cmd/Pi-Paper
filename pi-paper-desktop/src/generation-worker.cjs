const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const dns = require('node:dns').promises
const net = require('node:net')
const parentPort = process.parentPort
const { initializeWorkerProxy } = require('./worker-network.cjs')
if (parentPort) initializeWorkerProxy()
const { imageMimeFromBytes, MAX_REFERENCE_IMAGE_BYTES, MAX_REFERENCE_PAYLOAD_BYTES } = require('./reference-media.cjs')
const { normalizeLocalTextModelConfig } = require('./local-model-catalog.cjs')
const { AGNES_API_BASE_URL, AGNES_MODELS, AGNES_PROVIDER_ID } = require('./agnes-model-catalog.cjs')
const { ARK_API_BASE_URL, ARK_MODELS, ARK_PROVIDER_ID } = require('./ark-model-catalog.cjs')
const { composeVideos: runComposeVideos, ComposeFailure } = require('./compose-provider.cjs')
const { MODEL_ID: SAPI_MODEL_ID, PROVIDER_ID: SAPI_PROVIDER_ID, runWindowsSapiTts, SapiFailure } = require('./sapi-tts.cjs')
const { MediaOperationFailure, runLocalMediaOperation } = require('./media-postprocess.cjs')

if (!parentPort && require.main === module) throw new Error('Generation Worker must run as an Electron utility process.')

const MAX_PROMPT_CHARS = 200_000
const MAX_OUTPUT_CHARS = 20_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_PROVIDER_ERROR_BYTES = 16 * 1024
const MAX_PROVIDER_ERROR_MESSAGE_CHARS = 800
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000
const AGNES_VIDEO_POLL_INTERVAL_MS = 10_000
const AGNES_VIDEO_TIMEOUT_MS = 15 * 60 * 1000
const AGNES_VIDEO_MAX_CONSECUTIVE_POLL_FAILURES = 5
const AGNES_TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504])
const MAX_MEDIA_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024
const MAX_AGNES_MEDIA_REDIRECTS = 5
const ARK_VIDEO_POLL_INTERVAL_MS = 3_000
const ARK_VIDEO_TIMEOUT_MS = 10 * 60 * 1000
const MAX_ARK_REFERENCE_URL_CHARS = 4096
const MAX_ARK_REFERENCE_COUNT = 50

class WorkerFailure extends Error {
  constructor(code, message, statusCode = undefined) {
    super(message)
    this.code = code
    if (Number.isInteger(statusCode)) this.statusCode = statusCode
  }
}

function postJson(endpoint, payload, apiKey = null, timeoutMs = REQUEST_TIMEOUT_MS, providerName = 'Agnes') {
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
        const statusCode = response.statusCode
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          if (size >= MAX_PROVIDER_ERROR_BYTES) return
          const bytes = Buffer.from(chunk)
          const remaining = MAX_PROVIDER_ERROR_BYTES - size
          chunks.push(bytes.subarray(0, remaining))
          size += Math.min(bytes.length, remaining)
        })
        response.on('error', () => reject(new WorkerFailure(
          apiKey ? 'CLOUD_REQUEST_FAILED' : 'LOCAL_MODEL_REQUEST_FAILED',
          `模型服务返回 HTTP ${statusCode ?? '错误'}。`,
          statusCode,
        )))
        response.on('end', () => {
          const detail = providerErrorDetail(Buffer.concat(chunks).toString('utf8'), apiKey, {
            redactUrls: providerName === '火山方舟',
          })
          const provider = apiKey ? providerName : '本地模型服务'
          const message = detail
            ? `${provider}请求失败 HTTP ${statusCode ?? '错误'}：${detail}`
            : `${provider}请求失败 HTTP ${statusCode ?? '错误'}。`
          reject(new WorkerFailure(
            apiKey ? 'CLOUD_REQUEST_FAILED' : 'LOCAL_MODEL_REQUEST_FAILED',
            message,
            statusCode,
          ))
        })
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

    request.on('timeout', () => request.destroy(new WorkerFailure(apiKey ? 'CLOUD_REQUEST_TIMEOUT' : 'LOCAL_MODEL_UNAVAILABLE', `${apiKey ? providerName : '本地模型服务'}请求超时。`)))
    request.on('error', (error) => {
      if (error instanceof WorkerFailure) reject(error)
      else reject(new WorkerFailure(apiKey ? 'CLOUD_PROVIDER_UNAVAILABLE' : 'LOCAL_MODEL_UNAVAILABLE', `无法连接${apiKey ? providerName : '本地模型服务'}。`))
    })
    request.end(body)
  })
}

function getJson(endpoint, apiKey, timeoutMs = REQUEST_TIMEOUT_MS, providerName = '火山方舟') {
  const url = new URL(endpoint)
  if (url.protocol !== 'https:') throw new WorkerFailure('CLOUD_REQUEST_FAILED', '云端模型轮询地址必须使用 HTTPS。')
  return new Promise((resolve, reject) => {
    const request = require('node:https').get(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new WorkerFailure('CLOUD_INVALID_RESPONSE', '云端任务状态响应过大。'))
          return
        }
        chunks.push(Buffer.from(chunk))
      })
      response.on('error', reject)
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const detail = providerErrorDetail(raw, apiKey, { redactUrls: providerName === '火山方舟' })
          reject(new WorkerFailure(response.statusCode === 429 ? 'CLOUD_RATE_LIMITED' : 'CLOUD_REQUEST_FAILED',
            detail ? `${providerName}任务查询失败 HTTP ${response.statusCode}：${detail}` : `${providerName}任务查询失败 HTTP ${response.statusCode}。`,
            response.statusCode))
          return
        }
        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new WorkerFailure('CLOUD_INVALID_RESPONSE', '无法读取云端任务状态。'))
        }
      })
    })
    request.on('timeout', () => request.destroy(new WorkerFailure('CLOUD_REQUEST_TIMEOUT', `${providerName}任务查询超时。`)))
    request.on('error', (error) => reject(error instanceof WorkerFailure
      ? error : new WorkerFailure('CLOUD_PROVIDER_UNAVAILABLE', `无法连接${providerName}。`)))
  })
}

function providerErrorDetail(body, apiKey = null, { redactUrls = false } = {}) {
  const clean = (value) => {
    if (typeof value !== 'string') return ''
    let message = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').trim()
    if (apiKey) message = message.split(apiKey).join('[已隐藏凭据]')
    message = message.replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [已隐藏凭据]')
    if (redactUrls) message = message.replace(/\bhttps?:\/\/[^\s"'<>]+/giu, '[已隐藏媒体地址]')
    return message.slice(0, MAX_PROVIDER_ERROR_MESSAGE_CHARS)
  }

  const text = clean(body)
  if (!text) return ''
  try {
    const payload = JSON.parse(text)
    const candidates = [
      payload?.error?.message,
      payload?.error?.detail,
      typeof payload?.error === 'string' ? payload.error : null,
      payload?.message,
      payload?.detail,
      payload?.msg,
      payload?.error_description,
      payload?.reason,
      payload?.errors?.[0]?.message,
    ]
    for (const candidate of candidates) {
      const message = clean(candidate)
      if (message) return message
    }
    return clean(JSON.stringify(payload))
  } catch {
    return text.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_PROVIDER_ERROR_MESSAGE_CHARS)
  }
}

async function readResponseErrorDetail(response, apiKey = null) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response) {
      if (size >= MAX_PROVIDER_ERROR_BYTES) continue
      const bytes = Buffer.from(chunk)
      const remaining = MAX_PROVIDER_ERROR_BYTES - size
      chunks.push(bytes.subarray(0, remaining))
      size += Math.min(bytes.length, remaining)
    }
  } catch {
    response.resume?.()
  }
  response.resume?.()
  return providerErrorDetail(Buffer.concat(chunks).toString('utf8'), apiKey)
}

async function postAgnesJson(endpoint, payload, apiKey, timeoutMs, dependencies = {}) {
  const requestJson = dependencies.postJson || postJson
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  let delayMs = 3_000
  let lastError
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await requestJson(endpoint, payload, apiKey, timeoutMs)
    } catch (error) {
      lastError = error
      if (!AGNES_TRANSIENT_HTTP_STATUSES.has(error?.statusCode) || attempt === 5) {
        if (error?.statusCode === 429) {
          throw new WorkerFailure('CLOUD_RATE_LIMITED', error.message || 'Agnes 请求过于频繁，请稍后重试。', 429)
        }
        throw error
      }
      await sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 30_000)
    }
  }
  throw lastError
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

  if (!/^(?:result\.txt|result(?:-[1-3])?\.(?:png|jpg|webp|mp4|webm|wav|mp3|ogg|m4a))$/u.test(fileName)
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

function hasMediaSignature(extension, bytes) {
  if (!Buffer.isBuffer(bytes)) return false
  if (extension === 'png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (extension === 'jpg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (extension === 'webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (extension === 'mp4') return bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp'
  if (extension === 'webm') return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  if (extension === 'wav') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
  if (extension === 'mp3') return bytes.length >= 3 && (bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  if (extension === 'ogg') return bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS'
  if (extension === 'm4a') return bytes.length >= 8 && bytes.toString('ascii', 4, 8) === 'ftyp'
  return false
}

function assertMediaSignature(extension, bytes) {
  if (!hasMediaSignature(extension, bytes)) {
    throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回的媒体内容格式无效。')
  }
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
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')
    || (net.isIP(hostname) && !isPublicAddress(hostname))) {
    throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了不受信任的媒体地址。')
  }
  return url.toString()
}

function isPublicAddress(address) {
  const family = net.isIP(address)
  if (family === 4) {
    const octets = address.split('.').map(Number)
    const [a, b, c] = octets
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false
    if (a === 192 && b === 0 && c === 2) return false
    if (a === 198 && ((b === 18 || b === 19) || (b === 51 && c === 100))) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split('%', 1)[0]
    const first = Number.parseInt(normalized.split(':', 1)[0] || '0', 16)
    // Only global unicast (2000::/3) is valid for provider media. This also
    // rejects loopback, link-local, unique-local, mapped IPv4, and multicast.
    if (first < 0x2000 || first > 0x3fff) return false
    if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0000:') || normalized.startsWith('2001:0:')) return false
    return true
  }
  return false
}

async function resolvePublicAddress(hostname) {
  const literal = hostname.replace(/^\[|\]$/gu, '')
  const addresses = net.isIP(literal)
    ? [{ address: literal, family: net.isIP(literal) }]
    : await dns.lookup(literal, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了不受信任的媒体地址。')
  }
  return addresses
}

function requestAgnesUrl(url, options) {
  return new Promise((resolve, reject) => {
    const request = require('node:https').get(url, options, (response) => resolve(response))
    request.on('timeout', () => request.destroy(new WorkerFailure('CLOUD_REQUEST_TIMEOUT', 'Agnes 请求超时。')))
    request.on('error', (error) => reject(error instanceof WorkerFailure
      ? error
      : new WorkerFailure('CLOUD_PROVIDER_UNAVAILABLE', '无法连接 Agnes 服务。')))
  })
}

async function getAgnesResponse(urlValue, apiKey, timeoutMs = 60_000, dependencies = {}) {
  const requestUrl = dependencies.requestAgnesUrl || requestAgnesUrl
  const resolveAddress = dependencies.resolvePublicAddress || resolvePublicAddress
  let url = new URL(agnesMediaUrl(urlValue))
  const initialHost = url.host
  for (let redirects = 0; ; redirects += 1) {
    let addresses
    try {
      addresses = await resolveAddress(url.hostname)
    } catch (error) {
      if (error instanceof WorkerFailure) throw error
      throw new WorkerFailure(apiKey ? 'CLOUD_PROVIDER_UNAVAILABLE' : 'CLOUD_MEDIA_DOWNLOAD_FAILED', '无法连接 Agnes 服务。')
    }
    const sendCredentials = Boolean(apiKey) && redirects === 0 && url.host === initialHost
    const headers = { accept: sendCredentials ? 'application/json' : '*/*' }
    // Redirected responses never receive the Agnes API Key, even if they
    // point back to the initial host.
    if (sendCredentials) headers.authorization = `Bearer ${apiKey}`
    const response = await requestUrl(url, {
      headers,
      timeout: timeoutMs,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, addresses)
        else {
          const selected = addresses.find((entry) => !options?.family || entry.family === options.family)
          if (!selected) callback(new Error('No public address for requested address family'))
          else callback(null, selected.address, selected.family)
        }
      },
    })
    const location = response.headers?.location
    if (![301, 302, 303, 307, 308].includes(response.statusCode) || typeof location !== 'string' || !location.trim()) {
      return response
    }
    response.resume()
    if (redirects >= MAX_AGNES_MEDIA_REDIRECTS) {
      throw new WorkerFailure(apiKey ? 'CLOUD_REQUEST_FAILED' : 'CLOUD_MEDIA_DOWNLOAD_FAILED', 'Agnes 媒体地址重定向次数过多。')
    }
    let redirectedUrl
    try {
      redirectedUrl = new URL(location, url)
    } catch {
      throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了无效的媒体重定向地址。')
    }
    url = new URL(agnesMediaUrl(redirectedUrl.toString()))
  }
}

async function downloadAgnesOutput(urlValue, outputDirectory, taskId, modality, dependencies = {}, outputIndex = 0) {
  const mediaUrl = agnesMediaUrl(urlValue)
  if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 3) {
    throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了无效的结果序号。')
  }
  const fileName = (extension) => `result${outputIndex === 0 ? '' : `-${outputIndex}`}.${extension}`
  if (mediaUrl.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=]+)$/iu.exec(mediaUrl)
    if (!match) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了无法保存的媒体数据。')
    const encoded = match[2].replace(/=+$/u, '')
    const buffer = Buffer.from(encoded, 'base64')
    if (encoded.length % 4 === 1 || buffer.toString('base64').replace(/=+$/u, '') !== encoded) {
      throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了无效的媒体数据。')
    }
    const ext = extensionForMediaType(match[1], modality)
    assertMediaSignature(ext, buffer)
    return writeOutput(outputDirectory, taskId, fileName(ext), buffer)
  }

  const getResponse = dependencies.getAgnesResponse || getAgnesResponse
  const response = await getResponse(mediaUrl, null, 180_000, dependencies.getAgnesResponseDependencies)
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
  const finalPath = path.join(directory, fileName(extension))
  const temporaryPath = path.join(directory, `.result.${randomUUID()}.tmp`)
  let handle
  let totalBytes = 0
  let signatureBytes = Buffer.alloc(0)
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    for await (const chunkValue of response) {
      const chunk = Buffer.from(chunkValue)
      totalBytes += chunk.length
      if (totalBytes > MAX_MEDIA_OUTPUT_BYTES) {
        response.destroy()
        throw new WorkerFailure('CLOUD_OUTPUT_TOO_LARGE', 'Agnes 媒体结果超过本地保存上限。')
      }
      if (signatureBytes.length < 12) {
        signatureBytes = Buffer.concat([signatureBytes, chunk.subarray(0, 12 - signatureBytes.length)])
      }
      let offset = 0
      while (offset < chunk.length) {
        const write = await handle.write(chunk, offset, chunk.length - offset)
        offset += write.bytesWritten
      }
    }
    if (totalBytes === 0) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了空媒体文件。')
    assertMediaSignature(extension, signatureBytes)
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
  return `generated/${taskId}/${fileName(extension)}`
}

function extensionForMediaType(contentType, modality, fallbackUrl = '') {
  const type = typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : ''
  if (modality === 'image') {
    if (type === 'image/png') return 'png'
    if (type === 'image/jpeg' || type === 'image/jpg') return 'jpg'
    if (type === 'image/webp') return 'webp'
  }
  if (modality === 'video') {
    if (type === 'video/mp4') return 'mp4'
    if (type === 'video/webm') return 'webm'
  }
  if (modality === 'audio') {
    if (['audio/mpeg', 'audio/mp3'].includes(type)) return 'mp3'
    if (['audio/wav', 'audio/x-wav'].includes(type)) return 'wav'
    if (type === 'audio/ogg') return 'ogg'
    if (['audio/mp4', 'audio/x-m4a'].includes(type)) return 'm4a'
  }
  if (!type || ['application/octet-stream', 'binary/octet-stream', 'application/download'].includes(type)) {
    if (modality === 'image' && /\.png(?:$|[?#])/iu.test(fallbackUrl)) return 'png'
    if (modality === 'image' && /\.jpe?g(?:$|[?#])/iu.test(fallbackUrl)) return 'jpg'
    if (modality === 'image' && /\.webp(?:$|[?#])/iu.test(fallbackUrl)) return 'webp'
    if (modality === 'video' && /\.mp4(?:$|[?#])/iu.test(fallbackUrl)) return 'mp4'
    if (modality === 'video' && /\.webm(?:$|[?#])/iu.test(fallbackUrl)) return 'webm'
    // Match the legacy Agnes adapter's output defaults for opaque signed URLs.
    if (modality === 'image') return 'jpg'
    if (modality === 'video') return 'mp4'
  }
  throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 返回了不支持的媒体格式。')
}

function sizeFromImageParameters(parameters) {
  const explicit = String(parameters.size ?? parameters.resKey ?? '').toUpperCase()
  if (['1K', '2K', '3K', '4K'].includes(explicit)) return explicit
  const resolution = String(parameters.resolution ?? '').toLowerCase()
  const resolutionSize = {
    '512x512': '1K',
    '768x768': '1K',
    '1024x1024': '1K',
    '1280x720': '2K',
    '1920x1080': '2K',
    '2048x2048': '2K',
    '3840x2160': '4K',
  }[resolution]
  return resolutionSize || '2K'
}

function ratioFromParameters(parameters, fallback = '1:1') {
  return parameters.ratio ?? parameters.aspectRatio ?? parameters.aspect ?? fallback
}

function normalizeAgnesVideoReference(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const reference = value.trim()
  if (/^(?:vibe|file|blob):/iu.test(reference)) {
    throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', '本地画布媒体参考尚未接入 Agnes 视频输入，请移除首尾帧或图片参考后重试。')
  }
  if (reference.startsWith('data:')) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/iu.exec(reference)
    if (!match || match[2].length > Math.ceil((MAX_REFERENCE_IMAGE_BYTES * 4) / 3)) {
      throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Agnes 视频图片参考数据无效或过大。')
    }
    const encoded = match[2].replace(/=+$/u, '')
    const decoded = Buffer.from(encoded, 'base64')
    if (encoded.length % 4 === 1 || decoded.length === 0 || decoded.length > MAX_REFERENCE_IMAGE_BYTES
      || decoded.toString('base64').replace(/=+$/u, '') !== encoded || imageMimeFromBytes(decoded) !== match[1].toLowerCase()) {
      throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Agnes 视频图片参考数据无效或过大。')
    }
    return reference
  }
  let url
  try {
    url = new URL(reference)
  } catch {
    throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', 'Agnes 视频参考必须是可公开访问的媒体 URL。')
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal')
    || (net.isIP(hostname) && !isPublicAddress(hostname))) {
    throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', 'Agnes 视频参考必须是可公开访问的媒体 URL。')
  }
  return url.toString()
}

function normalizeAgnesImageReference(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = normalizeAgnesVideoReference(value)
  if (!normalized) return null
  if (!normalized.startsWith('data:')) return normalized
  return normalized.slice(normalized.indexOf(',') + 1)
}

function normalizeReferenceList(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : []
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
}

function firstAgnesImageReference(parameters) {
  for (const key of ['image', 'imageUrl', 'image_url', 'referenceUrl', 'sourceUrl', 'firstFrameUrl']) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const key of ['referenceImages', 'reference_images', 'referenceUrls']) {
    const first = normalizeReferenceList(parameters[key])[0]
    if (first) return first
  }
  return null
}

function buildAgnesImageRequest(job) {
  const parameters = job.parameters && typeof job.parameters === 'object' ? job.parameters : {}
  if (normalizeReferenceList(parameters.referenceVideos ?? parameters.reference_videos).length
    || normalizeReferenceList(parameters.referenceAudios ?? parameters.reference_audios).length) {
    throw new WorkerFailure('UNSUPPORTED_REFERENCE_MEDIA', 'Agnes 图像模型不支持视频或音频参考；请移除这些参考素材。')
  }
  const operation = typeof parameters.operation === 'string' ? parameters.operation.trim() : ''
  if (['裁剪', '三视图', 'crop_image', 'three_view'].includes(operation)) {
    throw new WorkerFailure('UNSUPPORTED_IMAGE_OPERATION', '桌面本地暂不支持图片裁剪或三视图处理。')
  }
  const operationPrompts = {
    '扩图': '扩展画面边缘，保持主体完整',
    outpaint_image: '扩展画面边缘，保持主体完整',
    '超分': '提升清晰度与细节',
    upscale_image: '提升清晰度与细节',
  }
  if (operation && !Object.hasOwn(operationPrompts, operation)) {
    throw new WorkerFailure('UNSUPPORTED_IMAGE_OPERATION', '桌面本地暂不支持此图片处理操作。')
  }
  const rawPrompt = typeof job.prompt === 'string' ? job.prompt.trim() : ''
  let prompt = rawPrompt
  if (operation === '扩图' || operation === 'outpaint_image') {
    prompt = `${prompt || operationPrompts[operation]}，outpainting，扩图`
  } else if (operation === '超分' || operation === 'upscale_image') {
    prompt = `${prompt || operationPrompts[operation]}，高清超分，保留原构图`
  }
  if (typeof parameters.style === 'string' && parameters.style.trim()) {
    prompt = `${prompt}\n风格：${parameters.style.trim()}`
  }
  if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', '图像生成提示词无效。')
  }
  const size = sizeFromImageParameters(parameters)
  const ratio = ratioFromParameters(parameters)
  if (!['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', '2:3', '3:2'].includes(ratio)) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Agnes 图像比例无效。')
  }

  const images = []
  let dataImageBytes = 0
  const append = (value) => {
    const image = normalizeAgnesImageReference(value)
    if (!image || images.includes(image)) return
    if (value.trim().startsWith('data:')) {
      const encoded = value.slice(value.indexOf(',') + 1)
      dataImageBytes += Buffer.from(encoded, 'base64').length
    }
    images.push(image)
  }
  const primary = firstAgnesImageReference(parameters)
  if (primary) append(primary)
  for (const key of ['referenceImages', 'reference_images', 'referenceUrls']) {
    for (const item of normalizeReferenceList(parameters[key])) append(item)
  }
  if (dataImageBytes > MAX_REFERENCE_PAYLOAD_BYTES) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', '图片参考总大小超过本地请求上限。')
  }

  const extraBody = { response_format: 'url' }
  if (images.length) extraBody.image = images
  return {
    model: AGNES_MODELS.image,
    prompt: prompt.slice(0, 2000),
    n: 1,
    size,
    ratio,
    extra_body: extraBody,
  }
}

async function runImageTask(job, dependencies = {}) {
  assertAgnesJob(job, 'image')
  assertTaskOutputTarget(job)
  const downloadOutput = dependencies.downloadAgnesOutput || downloadAgnesOutput
  const parameters = job.parameters && typeof job.parameters === 'object' ? job.parameters : {}
  const count = parameters.count === undefined ? 1 : parameters.count
  if (!Number.isSafeInteger(count) || count < 1 || count > 4) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', '图片生成数量必须为 1–4。')
  }
  const request = buildAgnesImageRequest(job)
  const outputPaths = []
  try {
    for (let index = 0; index < count; index += 1) {
      const response = await postAgnesJson(`${AGNES_API_BASE_URL}/images/generations`,
        request, job.apiKey, 6 * 60 * 1000, dependencies)
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
      if (!url) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', `Agnes 未返回第 ${index + 1} 张图像结果。`)
      outputPaths.push(await downloadOutput(url, job.outputDirectory, job.taskId, 'image', dependencies, index))
    }
  } catch (error) {
    for (const outputPath of outputPaths) {
      const resolvedOutput = path.resolve(job.outputDirectory, path.basename(outputPath))
      if (path.dirname(resolvedOutput) === path.resolve(job.outputDirectory)) {
        await fs.rm(resolvedOutput, { force: true }).catch(() => undefined)
      }
    }
    throw error
  }
  return { outputPath: outputPaths[0], outputPaths }
}

function buildAgnesVideoRequest(job) {
  const parameters = job.parameters && typeof job.parameters === 'object' ? job.parameters : {}
  if (normalizeReferenceList(parameters.referenceVideos ?? parameters.reference_videos).length
    || normalizeReferenceList(parameters.referenceAudios ?? parameters.reference_audios).length) {
    throw new WorkerFailure('UNSUPPORTED_REFERENCE_MEDIA', 'Agnes 视频模型不支持视频或音频参考；请移除这些参考素材。')
  }
  const prompt = typeof job.prompt === 'string' ? job.prompt.trim() : ''
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw new WorkerFailure('CLOUD_INPUT_INVALID', '视频生成提示词无效。')
  const rawSeconds = Number(parameters.seconds ?? parameters.duration ?? 5)
  const seconds = Number.isFinite(rawSeconds) ? Math.floor(rawSeconds) : 0
  if (seconds < 4 || seconds > 12) throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Agnes 视频时长必须在 4 到 12 秒之间。')
  const aspectRatio = ratioFromParameters(parameters, '16:9')
  const aspect_ratio = parameters.aspect_ratio ?? aspectRatio
  if (!['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(aspect_ratio)) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Agnes 视频比例无效。')
  }
  const firstFrameValue = ['firstFrameUrl', 'imageUrl', 'image_url', 'image', 'referenceUrl', 'sourceUrl']
    .map((key) => parameters[key])
    .find((value) => typeof value === 'string' && value.trim())
  const firstFrame = normalizeAgnesVideoReference(firstFrameValue)
  const lastFrame = normalizeAgnesVideoReference(parameters.lastFrameUrl)
  const rawReferences = parameters.referenceImages || parameters.reference_images || parameters.referenceUrls || []
  const references = Array.isArray(rawReferences)
    ? [...new Set(rawReferences.map(normalizeAgnesVideoReference).filter(Boolean))]
    : typeof rawReferences === 'string' ? [normalizeAgnesVideoReference(rawReferences)].filter(Boolean) : []
  if (references.length > 5) throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Agnes Video 2.5 Flash 最多支持 5 张参考图。')

  const mode = firstFrame || lastFrame ? 'keyframe' : references.length ? 'reference' : 'text'
  const requestImages = mode === 'keyframe' ? [firstFrame, lastFrame].filter(Boolean) : references
  const dataImageBytes = requestImages.reduce((total, image) => {
    if (!image.startsWith('data:')) return total
    return total + Buffer.from(image.slice(image.indexOf(',') + 1), 'base64').length
  }, 0)
  if (dataImageBytes > MAX_REFERENCE_PAYLOAD_BYTES) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', '视频图片参考总大小超过本地请求上限。')
  }
  const body = {
    model: AGNES_MODELS.video,
    prompt: prompt.slice(0, 2000),
    mode,
    seconds: String(seconds),
    size: '720P',
    aspect_ratio,
    n: 1,
  }
  if (mode === 'keyframe') {
    if (firstFrame) body.first_frame = firstFrame
    if (lastFrame) body.last_frame = lastFrame
  } else if (mode === 'reference') {
    body.images = references
  }
  return body
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

async function runVideoTask(job, dependencies = {}) {
  assertAgnesJob(job, 'video')
  assertTaskOutputTarget(job)
  const body = buildAgnesVideoRequest(job)
  const getResponse = dependencies.getAgnesResponse || getAgnesResponse
  const downloadOutput = dependencies.downloadAgnesOutput || downloadAgnesOutput
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const now = dependencies.now || Date.now
  const pollIntervalMs = dependencies.pollIntervalMs ?? AGNES_VIDEO_POLL_INTERVAL_MS
  const timeoutMs = dependencies.timeoutMs ?? AGNES_VIDEO_TIMEOUT_MS
  const created = await postAgnesJson(`${AGNES_API_BASE_URL}/videos`, body, job.apiKey, 60_000, dependencies)
  const videoId = created?.video_id ?? created?.id ?? created?.task_id
  if (typeof videoId !== 'string' && typeof videoId !== 'number') {
    throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 未返回视频任务标识。')
  }
  const deadline = now() + timeoutMs
  let lastStatus = ''
  let nextPollDelayMs = pollIntervalMs
  let consecutivePollFailures = 0
  let lastTransientPollFailure = null
  while (now() < deadline) {
    await sleep(nextPollDelayMs)
    const pollUrl = `https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(String(videoId))}&model_name=${encodeURIComponent(AGNES_MODELS.video)}`
    let status
    try {
      status = await getResponse(pollUrl, job.apiKey, 60_000)
    } catch (error) {
      consecutivePollFailures += 1
      lastTransientPollFailure = error instanceof WorkerFailure
        ? error
        : new WorkerFailure('CLOUD_PROVIDER_UNAVAILABLE', '无法连接 Agnes 服务。')
      if (consecutivePollFailures >= AGNES_VIDEO_MAX_CONSECUTIVE_POLL_FAILURES) {
        throw lastTransientPollFailure
      }
      nextPollDelayMs = Math.min(60_000, Math.max(nextPollDelayMs * 2, pollIntervalMs * 2))
      continue
    }
    if (AGNES_TRANSIENT_HTTP_STATUSES.has(status.statusCode)) {
      const detail = await readResponseErrorDetail(status, job.apiKey)
      const code = status.statusCode === 429 ? 'CLOUD_RATE_LIMITED' : 'CLOUD_REQUEST_FAILED'
      const message = detail
        ? `Agnes 视频状态查询失败 HTTP ${status.statusCode}：${detail}`
        : `Agnes 视频状态查询失败 HTTP ${status.statusCode}。`
      consecutivePollFailures += 1
      lastTransientPollFailure = new WorkerFailure(code, message, status.statusCode)
      if (consecutivePollFailures >= AGNES_VIDEO_MAX_CONSECUTIVE_POLL_FAILURES) {
        throw lastTransientPollFailure
      }
      nextPollDelayMs = Math.min(60_000, Math.max(nextPollDelayMs * 2, pollIntervalMs * 2))
      continue
    }
    if (status.statusCode < 200 || status.statusCode >= 300) {
      const detail = await readResponseErrorDetail(status, job.apiKey)
      throw new WorkerFailure('CLOUD_REQUEST_FAILED', detail
        ? `Agnes 视频状态查询失败 HTTP ${status.statusCode}：${detail}`
        : `Agnes 视频状态查询失败 HTTP ${status.statusCode}。`, status.statusCode)
    }
    consecutivePollFailures = 0
    lastTransientPollFailure = null
    nextPollDelayMs = pollIntervalMs
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
      const detail = providerErrorDetail(JSON.stringify(payload), job.apiKey)
      throw new WorkerFailure('CLOUD_GENERATION_FAILED', detail
        ? `Agnes 视频生成失败：${detail}`
        : 'Agnes 视频生成失败。')
    }
    if (['completed', 'succeeded', 'success', 'done'].includes(lastStatus)) {
      const videoUrl = extractVideoUrl(payload)
      if (!videoUrl) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', 'Agnes 视频任务已完成，但没有返回视频地址。')
      return { outputPath: await downloadOutput(videoUrl, job.outputDirectory, job.taskId, 'video') }
    }
  }
  if (lastTransientPollFailure) throw lastTransientPollFailure
  throw new WorkerFailure('CLOUD_REQUEST_TIMEOUT', `Agnes 视频任务超时（最后状态：${lastStatus || '未知'}）。`)
}

function normalizeArkHttpsReference(reference) {
  if (typeof reference !== 'string' || !reference.trim() || reference.length > MAX_ARK_REFERENCE_URL_CHARS) {
    throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', 'Ark 视频或音频参考地址无效或过长。')
  }
  let url
  try {
    url = new URL(reference.trim())
  } catch {
    throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', 'Ark 视频或音频参考必须是可公开访问的 HTTPS 地址。')
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase().replace(/\.$/u, '')
  if (url.protocol !== 'https:' || url.username || url.password || !hostname
    || url.port && url.port !== '443'
    || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || hostname.endsWith('.test')
    || (net.isIP(hostname) && !isPublicAddress(hostname))) {
    throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', 'Ark 视频或音频参考必须是可公开访问的 HTTPS 地址；不允许本机、内网或凭据 URL。')
  }
  return url.toString()
}

function normalizeArkImageReference(reference) {
  if (typeof reference !== 'string' || !reference.trim()) return null
  const source = reference.trim()
  if (source.startsWith('data:')) return normalizeAgnesVideoReference(source)
  return normalizeArkHttpsReference(source)
}

function listReferenceValues(value) {
  return normalizeReferenceList(value)
}

function buildArkVideoRequest(job) {
  if (job?.providerType !== 'cloud' || job?.providerId !== ARK_PROVIDER_ID || job?.modality !== 'video'
    || job?.modelId !== ARK_MODELS.video) {
    throw new WorkerFailure('MODEL_UNAVAILABLE', '火山方舟 Seedance 视频模型配置无效。')
  }
  const parameters = job.parameters && typeof job.parameters === 'object' ? job.parameters : {}
  const prompt = typeof job.prompt === 'string' ? job.prompt.trim() : ''
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw new WorkerFailure('CLOUD_INPUT_INVALID', '视频生成提示词无效。')

  const ratioByResolution = {
    '1280x720': '16:9', '1920x1080': '16:9', '720x1280': '9:16',
    '1080x1920': '9:16', '1024x1024': '1:1',
  }
  const first = typeof parameters.firstFrameUrl === 'string' ? parameters.firstFrameUrl.trim() : ''
  const last = typeof parameters.lastFrameUrl === 'string' ? parameters.lastFrameUrl.trim() : ''
  const hasKeyframes = Boolean(first || last)
  const ratio = hasKeyframes ? 'adaptive'
    : String(parameters.ratio || ratioByResolution[String(parameters.resolution || '')] || '16:9')
  if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'].includes(ratio)) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', '火山方舟视频比例无效。')
  }
  const resolutionValue = String(parameters.size ?? parameters.resolution ?? '720p').trim().toLowerCase()
  const resolution = /^(480|720|1080)p$/u.test(resolutionValue) ? resolutionValue
    : ({ '854x480': '480p', '480x854': '480p', '1280x720': '720p', '720x1280': '720p',
      '1920x1080': '1080p', '1080x1920': '1080p' })[resolutionValue]
  if (!resolution) throw new WorkerFailure('CLOUD_INPUT_INVALID', '火山方舟视频分辨率无效。')
  const durationValue = Number(parameters.duration ?? parameters.seconds ?? 5)
  const duration = Number.isFinite(durationValue) ? Math.floor(durationValue) : 0
  if (duration < 4 || duration > 30) throw new WorkerFailure('CLOUD_INPUT_INVALID', '火山方舟 Seedance 2.5 视频时长必须在 4 到 30 秒之间。')

  let promptText = prompt
  if (typeof parameters.camera === 'string' && parameters.camera.trim()) promptText += `\n运镜：${parameters.camera.trim()}`
  if (typeof parameters.style === 'string' && parameters.style.trim()) promptText += `\n风格：${parameters.style.trim()}`
  const content = [{ type: 'text', text: promptText.slice(0, 2000) }]
  const images = []
  const appendImage = (value, role = 'reference_image') => {
    const image = normalizeArkImageReference(value)
    if (!image || images.some((entry) => entry.url === image)) return
    images.push({ url: image, role })
  }
  if (first) appendImage(first, 'first_frame')
  if (last) appendImage(last, 'last_frame')
  for (const key of ['referenceImages', 'reference_images', 'referenceUrls']) {
    for (const value of listReferenceValues(parameters[key])) appendImage(value)
  }
  const single = parameters.imageUrl ?? parameters.image_url ?? parameters.referenceUrl
  if (!images.length && typeof single === 'string' && single.trim()) appendImage(single)
  if (images.length > MAX_ARK_REFERENCE_COUNT) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', `Ark 视频图片参考数量超过 ${MAX_ARK_REFERENCE_COUNT} 个。`)
  }
  for (const image of images) content.push({
    type: 'image_url', image_url: { url: image.url }, role: image.role,
  })

  for (const [kind, typeName, fieldNames] of [
    ['video', 'video_url', ['referenceVideos', 'reference_videos']],
    ['audio', 'audio_url', ['referenceAudios', 'reference_audios']],
  ]) {
    const references = [...new Set(fieldNames.flatMap((field) => listReferenceValues(parameters[field]))
      .map(normalizeArkHttpsReference))]
    if (references.length > MAX_ARK_REFERENCE_COUNT) {
      throw new WorkerFailure('CLOUD_INPUT_INVALID', `Ark 视频${kind === 'video' ? '视频' : '音频'}参考数量超过 ${MAX_ARK_REFERENCE_COUNT} 个。`)
    }
    for (const url of references) {
      const property = kind === 'video' ? 'video_url' : 'audio_url'
      content.push({ type: typeName, [property]: { url }, role: kind === 'video' ? 'reference_video' : 'reference_audio' })
    }
  }
  if (content.length > 1 + MAX_ARK_REFERENCE_COUNT) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', 'Ark 媒体参考数量超过本地请求上限。')
  }
  const dataImageBytes = images.reduce((total, image) => {
    if (!image.url.startsWith('data:image/')) return total
    return total + Buffer.from(image.url.slice(image.url.indexOf(',') + 1), 'base64').length
  }, 0)
  if (dataImageBytes > MAX_REFERENCE_PAYLOAD_BYTES) {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', '视频图片参考总大小超过本地请求上限。')
  }
  return {
    model: ARK_MODELS.video,
    content,
    generate_audio: parameters.generate_audio !== false,
    resolution,
    ratio,
    duration,
    watermark: parameters.watermark === true,
  }
}

function arkReferenceUrls(body) {
  const urls = []
  for (const entry of body.content) {
    if (entry.type === 'image_url') urls.push(entry.image_url.url)
    if (entry.type === 'video_url') urls.push(entry.video_url.url)
    if (entry.type === 'audio_url') urls.push(entry.audio_url.url)
  }
  return urls.filter((url) => !url.startsWith('data:'))
}

async function assertArkReferenceHosts(body, dependencies = {}) {
  const resolver = dependencies.resolveReferenceHost || dependencies.resolvePublicAddress || (async (hostname) => {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true })
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
      throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', 'Ark 参考媒体域名解析到非公网地址。')
    }
    return addresses
  })
  const hostnames = [...new Set(arkReferenceUrls(body).map((value) => new URL(value).hostname))]
  for (const hostname of hostnames) {
    try {
      const addresses = await resolver(hostname)
      if (Array.isArray(addresses) && (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address ?? entry)))) {
        throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', 'Ark 参考媒体域名解析到非公网地址。')
      }
    } catch (error) {
      if (error instanceof WorkerFailure) throw error
      throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', '无法确认 Ark 参考媒体域名可公开访问。')
    }
  }
}

function extractArkVideoUrl(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload
  const content = data?.content
  const candidates = Array.isArray(content) ? content : [content]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    for (const value of [candidate.video_url, candidate.url, candidate.output_url]) {
      if (typeof value === 'string' && value.startsWith('https://')) return value
      if (value && typeof value === 'object' && typeof value.url === 'string' && value.url.startsWith('https://')) return value.url
    }
  }
  for (const value of [data?.video_url, data?.url, data?.output_url, data?.output?.video_url, data?.output?.url]) {
    if (typeof value === 'string' && value.startsWith('https://')) return value
    if (value && typeof value === 'object' && typeof value.url === 'string' && value.url.startsWith('https://')) return value.url
  }
  return null
}

function redactArkReferenceUrls(message, body) {
  let result = message
  for (const url of arkReferenceUrls(body)) result = result.split(url).join('[已隐藏参考地址]')
  return result
}

async function runArkVideoTask(job, dependencies = {}) {
  assertTaskOutputTarget(job)
  if (typeof job?.apiKey !== 'string' || !job.apiKey.trim()) {
    throw new WorkerFailure('CLOUD_CREDENTIAL_MISSING', '尚未配置火山方舟 API Key。')
  }
  const body = buildArkVideoRequest(job)
  await assertArkReferenceHosts(body, dependencies)
  const createUrl = `${ARK_API_BASE_URL}/contents/generations/tasks`
  const post = dependencies.postArkJson || dependencies.postJson
    || ((url, payload, key, timeout) => postJson(url, payload, key, timeout, '火山方舟'))
  const get = dependencies.getArkJson || ((url, key, timeout) => getJson(url, key, timeout, '火山方舟'))
  const downloadOutput = dependencies.downloadArkOutput || dependencies.downloadAgnesOutput || downloadAgnesOutput
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const now = dependencies.now || Date.now
  const pollIntervalMs = dependencies.pollIntervalMs ?? ARK_VIDEO_POLL_INTERVAL_MS
  const timeoutMs = dependencies.timeoutMs ?? ARK_VIDEO_TIMEOUT_MS
  let lastStatus = ''
  try {
    const created = await post(createUrl, body, job.apiKey, 60_000)
    const taskId = created?.id ?? created?.task_id ?? created?.data?.id ?? created?.data?.task_id
    if ((typeof taskId !== 'string' && typeof taskId !== 'number') || !String(taskId).trim()
      || String(taskId).length > 200 || !/^[a-z0-9_-]+$/iu.test(String(taskId))) {
      throw new WorkerFailure('CLOUD_INVALID_RESPONSE', '火山方舟未返回有效的视频任务标识。')
    }
    const deadline = now() + timeoutMs
    while (now() < deadline) {
      await sleep(pollIntervalMs)
      const statusPayload = await get(`${ARK_API_BASE_URL}/contents/generations/tasks/${encodeURIComponent(String(taskId))}`, job.apiKey, 60_000)
      const data = statusPayload?.data && typeof statusPayload.data === 'object' ? statusPayload.data : statusPayload
      lastStatus = String(data?.status ?? statusPayload?.status ?? '').toLowerCase()
      if (['failed', 'error', 'cancelled', 'canceled'].includes(lastStatus)) {
        const detail = providerErrorDetail(JSON.stringify(data), job.apiKey, { redactUrls: true })
        throw new WorkerFailure('CLOUD_GENERATION_FAILED', detail
          ? `火山方舟视频生成失败：${detail}` : '火山方舟视频生成失败。')
      }
      if (['succeeded', 'success', 'completed', 'done'].includes(lastStatus)) {
        const videoUrl = extractArkVideoUrl(statusPayload)
        if (!videoUrl) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', '火山方舟任务已完成，但没有返回视频地址。')
        normalizeArkHttpsReference(videoUrl)
        await assertArkReferenceHosts({ content: [{ type: 'video_url', video_url: { url: videoUrl } }] }, dependencies)
        return { outputPath: await downloadOutput(videoUrl, job.outputDirectory, job.taskId, 'video', dependencies) }
      }
    }
    throw new WorkerFailure('CLOUD_REQUEST_TIMEOUT', `火山方舟视频任务超时（最后状态：${lastStatus || '未知'}）。`)
  } catch (error) {
    if (error instanceof WorkerFailure) error.message = redactArkReferenceUrls(error.message, body)
    throw error
  }
}

async function runAudioTask(job) {
  assertTaskOutputTarget(job)
  if (job?.providerType !== 'local' || job?.providerId !== SAPI_PROVIDER_ID || job?.modelId !== SAPI_MODEL_ID) {
    throw new WorkerFailure('MODEL_UNAVAILABLE', '当前本地音频模型不可用。')
  }
  return runWindowsSapiTts(job)
}

function assertTaskOutputTarget(job) {
  if (typeof job?.taskId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(job.taskId)
    || typeof job?.outputDirectory !== 'string') {
    throw new WorkerFailure('CLOUD_INPUT_INVALID', '生成任务标识无效。')
  }
}

let running = false
let checkpointSequence = 0
const checkpointWaiters = new Map()
function checkpointToMain(requestId, checkpoint) {
  const sequence = ++checkpointSequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { checkpointWaiters.delete(sequence); reject(new WorkerFailure('TASK_CHECKPOINT_FAILED', '无法持久化官方任务状态，已停止后续请求。')) }, 30_000)
    checkpointWaiters.set(sequence, { resolve, reject, timer })
    parentPort.postMessage({ id: requestId, sequence, type: 'provider-checkpoint', checkpoint })
  })
}

function officialReferences(parameters = {}) {
  const refs = []
  const add = (value, type, role) => {
    for (const item of Array.isArray(value) ? value : value ? [value] : []) {
      if (typeof item !== 'string') throw new WorkerFailure('CLOUD_INPUT_INVALID', '参考素材格式无效。')
      if (/^(?:file|vibe|blob):/iu.test(item)) throw new WorkerFailure('CLOUD_REFERENCE_UNAVAILABLE', '该参考素材尚未完成安全读取。')
      const data = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(item)
      const reference = data ? { type, base64: data[2], mimeType: data[1], role } : { type, url: item, role }
      if (!refs.some((existing) => existing.type === type && existing.role === role
        && existing.url === reference.url && existing.base64 === reference.base64)) refs.push(reference)
    }
  }
  add(parameters.firstFrameUrl, 'image', 'first_frame')
  add(parameters.lastFrameUrl, 'image', 'last_frame')
  for (const field of ['referenceImages', 'reference_images', 'referenceUrls', 'image', 'imageUrl', 'image_url', 'referenceUrl', 'sourceUrl']) {
    add(parameters[field], 'image', 'reference')
  }
  add(parameters.maskUrl, 'image', 'mask')
  add(parameters.referenceVideos ?? parameters.reference_videos, 'video', 'reference')
  add(parameters.referenceAudios ?? parameters.reference_audios, 'audio', 'reference')
  return refs
}

async function runOfficialTask(job, dependencies = {}) {
  assertTaskOutputTarget(job)
  const api = dependencies.api || require(path.join(__dirname, '..', 'dist', 'pi-official-media.cjs'))
  const params = { ...(job.parameters || {}) }
  const instructions = ['style', 'camera'].flatMap((field) => typeof params[field] === 'string' && params[field].trim()
    ? [`${field === 'style' ? 'Style' : 'Camera'}: ${params[field].trim()}`] : [])
  for (const field of ['prompt', 'model', 'resKey', 'style', 'camera', 'referenceTexts', 'upstreamNodeIds',
    'referenceImages', 'reference_images', 'referenceUrls', 'image', 'imageUrl', 'image_url', 'referenceUrl', 'sourceUrl',
    'firstFrameUrl', 'lastFrameUrl', 'maskUrl', 'referenceVideos', 'reference_videos', 'referenceAudios', 'reference_audios']) delete params[field]
  if (params.aspect !== undefined) {
    if (params.ratio !== undefined && params.ratio !== params.aspect) throw new WorkerFailure('CLOUD_INPUT_INVALID', '画幅参数不一致。')
    params.ratio ??= params.aspect
    delete params.aspect
  }
  if (job.modality === 'video' && params.size !== undefined) {
    if (params.resolution !== undefined && String(params.resolution).toLowerCase() !== String(params.size).toLowerCase()) throw new WorkerFailure('CLOUD_INPUT_INVALID', '分辨率参数不一致。')
    params.resolution ??= params.size
    delete params.size
  }
  if (job.modality !== 'image' && params.count !== undefined) {
    if (params.count !== 1) throw new WorkerFailure('CLOUD_INPUT_INVALID', '此媒体任务只支持一次生成一个结果。')
    delete params.count
  }
  if (job.modality === 'audio' || job.modality === 'text') {
    // These fields are visual editor controls, not speech or chat parameters.
    delete params.ratio
    delete params.resolution
    delete params.size
  }
  const input = { providerId: job.providerId, modelId: job.apiModelId, modality: job.modality,
    prompt: [job.prompt || '', ...instructions].filter(Boolean).join('\n\n'), params, operation: job.operation,
    pluginKey: job.pluginKey, references: officialReferences(job.parameters), remoteTaskId: job.remoteTaskId }
  if (Array.isArray(job.inputModes) && input.references.some((reference) => !job.inputModes.includes(reference.type))) {
    throw new WorkerFailure('UNSUPPORTED_INPUT_MODE', '该模型不支持本次使用的参考素材类型。')
  }
    const checkpoint = dependencies.checkpoint || (async () => {
      throw new WorkerFailure('TASK_CHECKPOINT_REQUIRED', '异步生成需要持久化任务检查点。')
    })
  const result = await api.executeOfficialGeneration(input, {
    apiKey: job.apiKey, credentials: job.credentials, baseUrl: job.endpoint, timeoutMs: job.timeoutMs,
    onSubmitting: async () => checkpoint({ phase: 'submitting' }),
    onSubmitted: async (value) => {
      const remoteTaskId = typeof value === 'string' ? value : value?.remoteTaskId || value?.taskId
      if (!remoteTaskId) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', '官方服务未返回任务标识。')
      await checkpoint({ phase: 'submitted', remoteTaskId })
    },
  })
  if (job.modality === 'text') {
    if (typeof result.text !== 'string' || !result.text.trim()) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', '官方模型没有返回文本。')
    return { outputPath: await writeTextOutput(job.outputDirectory, job.taskId, result.text) }
  }
  const outputPaths = []
  if (!Array.isArray(result.outputs) || !result.outputs.length || result.outputs.length > 4) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', '官方模型没有返回可保存的媒体结果。')
  for (const [index, output] of result.outputs.entries()) {
    if (output.base64) {
      const bytes = Buffer.from(output.base64, 'base64')
      if (bytes.toString('base64').replace(/=+$/u, '') !== output.base64.replace(/=+$/u, '')) throw new WorkerFailure('CLOUD_INVALID_RESPONSE', '媒体数据无效。')
      const ext = extensionForMediaType(output.mimeType, job.modality)
      assertMediaSignature(ext, bytes)
      outputPaths.push(await writeOutput(job.outputDirectory, job.taskId, `result${index ? `-${index}` : ''}.${ext}`, bytes))
    } else if (output.url) {
      outputPaths.push(await (dependencies.download || downloadAgnesOutput)(output.url, job.outputDirectory, job.taskId, job.modality, {}, index))
    } else throw new WorkerFailure('CLOUD_INVALID_RESPONSE', '媒体结果没有内容或下载地址。')
  }
  return { outputPath: outputPaths[0], outputPaths }
}
if (parentPort) parentPort.on('message', async (event) => {
  const request = event?.data ?? event
  if (request?.type === 'provider-checkpoint-ack') {
    const waiter = checkpointWaiters.get(request.sequence)
    if (waiter) { clearTimeout(waiter.timer); checkpointWaiters.delete(request.sequence)
      request.ok ? waiter.resolve() : waiter.reject(new WorkerFailure('TASK_CHECKPOINT_FAILED', '官方任务状态保存失败。')) }
    return
  }
  if (!request || !Number.isSafeInteger(request.id)
    || !['generate:official', 'generate:text', 'generate:image', 'generate:audio', 'generate:video', 'generate:compose', 'postprocess:image', 'postprocess:video'].includes(request.method)) return
  if (running) {
    parentPort.postMessage({ id: request.id, ok: false, errorCode: 'WORKER_BUSY' })
    return
  }
  running = true
  try {
    const result = request.method === 'generate:official' ? await runOfficialTask(request.payload, { checkpoint: (value) => checkpointToMain(request.id, value) })
      : request.method === 'generate:text' ? await runTextTask(request.payload)
      : request.method === 'generate:image' ? await runImageTask(request.payload)
          : request.method === 'generate:audio' ? await runAudioTask(request.payload)
          : request.method === 'generate:video' ? request.payload?.providerId === ARK_PROVIDER_ID
            ? await runArkVideoTask(request.payload) : await runVideoTask(request.payload)
            : request.method === 'generate:compose' ? await runComposeVideos(request.payload)
              : await runLocalMediaOperation(request.payload)
    parentPort.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    const networkFailure = request.payload?.providerType === 'cloud' && /fetch failed|ECONNRESET|ETIMEDOUT|connect timeout/i.test(error?.message || '')
    const errorCode = error instanceof WorkerFailure || error instanceof ComposeFailure || error instanceof SapiFailure
      || error instanceof MediaOperationFailure
      ? error.code : networkFailure ? 'CLOUD_PROVIDER_UNAVAILABLE' : typeof error?.code === 'string' && /^[A-Z0-9_]{1,120}$/u.test(error.code) ? error.code : 'LOCAL_MODEL_EXECUTION_FAILED'
    const apiKey = typeof request.payload?.apiKey === 'string' ? request.payload.apiKey : ''
    parentPort.postMessage({
      id: request.id,
      ok: false,
      errorCode,
      errorMessage: networkFailure
        ? '无法连接云端模型服务，请检查网络与系统代理。请求结果尚未确认，请勿连续重复提交。'
        : sanitizeWorkerErrorMessage(error?.message, apiKey, errorCode),
    })
  } finally {
    running = false
  }
})

function sanitizeWorkerErrorMessage(value, apiKey = '', fallback = '生成任务执行失败。') {
  let message = typeof value === 'string' ? value : ''
  if (apiKey) message = message.split(apiKey).join('[已隐藏凭据]')
  message = message.replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [已隐藏凭据]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
  return (message || fallback).slice(0, MAX_PROVIDER_ERROR_MESSAGE_CHARS)
}

module.exports = {
  WorkerFailure,
  agnesMediaUrl,
  buildAgnesImageRequest,
  buildAgnesVideoRequest,
  buildArkVideoRequest,
  downloadAgnesOutput,
  extensionForMediaType,
  getAgnesResponse,
  getJson,
  hasMediaSignature,
  isPublicAddress,
  normalizeAgnesVideoReference,
  postJson,
  providerErrorDetail,
  runImageTask,
  runOfficialTask,
  runArkVideoTask,
  runVideoTask,
  sizeFromImageParameters,
}
