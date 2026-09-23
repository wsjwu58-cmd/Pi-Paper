const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const parentPort = process.parentPort
const { normalizeLocalTextModelConfig } = require('./local-model-catalog.cjs')

if (!parentPort) throw new Error('Generation Worker must run as an Electron utility process.')

const MAX_PROMPT_CHARS = 200_000
const MAX_OUTPUT_CHARS = 20_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000

class WorkerFailure extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function postJson(endpoint, payload) {
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
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new WorkerFailure('LOCAL_MODEL_REQUEST_FAILED', `本地模型服务返回 HTTP ${response.statusCode ?? '错误'}。`))
        return
      }

      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new WorkerFailure('LOCAL_MODEL_INVALID_RESPONSE', '本地模型响应过大。'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new WorkerFailure('LOCAL_MODEL_INVALID_RESPONSE', '本地模型服务返回了无法读取的响应。'))
        }
      })
    })

    request.on('timeout', () => request.destroy(new WorkerFailure('LOCAL_MODEL_UNAVAILABLE', '本地模型请求超时。')))
    request.on('error', (error) => {
      if (error instanceof WorkerFailure) reject(error)
      else reject(new WorkerFailure('LOCAL_MODEL_UNAVAILABLE', '无法连接本地模型服务。'))
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

async function writeOutput(outputDirectory, taskId, text) {
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

  const output = Buffer.from(text, 'utf8')
  if (output.length === 0 || output.length > MAX_OUTPUT_BYTES) {
    throw new WorkerFailure('LOCAL_MODEL_INVALID_RESPONSE', '本地模型结果为空或超过本地保存上限。')
  }

  const outputPath = path.join(directory, 'result.txt')
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
  return `generated/${taskId}/result.txt`
}

async function runTextTask(job) {
  const taskId = job?.taskId
  const prompt = job?.prompt
  if (typeof taskId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(taskId)
    || typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS) {
    throw new WorkerFailure('LOCAL_MODEL_INPUT_INVALID', '本地文本任务输入无效。')
  }

  let model
  try {
    model = normalizeLocalTextModelConfig({ endpoint: job.endpoint, modelId: job.modelId })
  } catch {
    throw new WorkerFailure('LOCAL_MODEL_CONFIGURATION_INVALID', '本地文本模型配置无效。')
  }
  const response = await postJson(`${model.endpoint}/chat/completions`, {
    model: model.modelId,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  })
  const content = extractText(response)
  if (content.length > MAX_OUTPUT_CHARS || Buffer.byteLength(content, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new WorkerFailure('LOCAL_MODEL_INVALID_RESPONSE', '本地模型结果超过本地保存上限。')
  }
  const outputPath = await writeOutput(job.outputDirectory, taskId, content)
  return { outputPath }
}

let running = false
parentPort.on('message', async (event) => {
  const request = event?.data ?? event
  if (!request || !Number.isSafeInteger(request.id) || request.method !== 'generate:text') return
  if (running) {
    parentPort.postMessage({ id: request.id, ok: false, errorCode: 'WORKER_BUSY' })
    return
  }
  running = true
  try {
    const result = await runTextTask(request.payload)
    parentPort.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      errorCode: error instanceof WorkerFailure ? error.code : 'LOCAL_MODEL_EXECUTION_FAILED',
    })
  } finally {
    running = false
  }
})
