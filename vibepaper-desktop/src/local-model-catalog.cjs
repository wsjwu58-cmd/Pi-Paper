const http = require('node:http')
const https = require('node:https')

const MODEL_LIST_TIMEOUT_MS = 5_000
const MAX_MODEL_LIST_BYTES = 1024 * 1024

function normalizeLocalModelEndpoint(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new Error('本地模型服务地址无效。')
  }

  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('本地模型服务地址无效。')
  }

  const host = url.hostname.toLowerCase()
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)
    || !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) {
    throw new Error('本地模型服务只能使用 localhost、127.0.0.1 或 ::1，且不能在地址中包含凭据。')
  }

  const basePath = url.pathname.replace(/\/+$/u, '') || '/'
  if (!['/', '/v1', '/api/v1'].includes(basePath)) {
    throw new Error('本地模型服务地址路径仅支持 /、/v1 或 /api/v1。')
  }
  return `${url.protocol}//${url.host}${basePath === '/' ? '' : basePath}`
}

function normalizeLocalTextModelConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('本地文本模型配置无效。')
  }
  const endpoint = normalizeLocalModelEndpoint(input.endpoint)
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : ''
  if (!modelId || modelId.length > 200 || /[\u0000-\u001f\u007f]/u.test(modelId)) {
    throw new Error('请选择有效的本地模型。')
  }
  if (/^(?:sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9_]{30,}|xox[baprs]-)/u.test(modelId)) {
    throw new Error('此字段只接受模型标识，不能保存 API Key 或其他凭据。')
  }
  return {
    providerId: 'local-openai-compatible',
    providerType: 'local',
    endpoint,
    modelId,
    modalities: ['text'],
    inputModes: ['text'],
    toolCalling: false,
    streaming: false,
    cancellation: false,
  }
}

function discoverLocalModels(endpointValue) {
  const baseUrl = normalizeLocalModelEndpoint(endpointValue)
  const url = new URL(`${baseUrl}/models`)
  const transport = url.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const request = transport.get(url, {
      headers: { accept: 'application/json' },
      timeout: MODEL_LIST_TIMEOUT_MS,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`本地模型服务返回 HTTP ${response.statusCode ?? '错误'}。`))
        return
      }

      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_MODEL_LIST_BYTES) {
          request.destroy(new Error('本地模型列表响应过大。'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        let payload
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          reject(new Error('本地模型服务返回了无法读取的模型列表。'))
          return
        }
        if (!payload || !Array.isArray(payload.data)) {
          reject(new Error('本地模型服务未返回兼容的模型列表。'))
          return
        }
        const models = [...new Set(payload.data
          .map((item) => item && typeof item.id === 'string' ? item.id.trim() : '')
          .filter((id) => id && id.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(id)))].slice(0, 200)
        resolve(models)
      })
    })

    request.on('timeout', () => request.destroy(new Error('连接本地模型服务超时。')))
    request.on('error', (error) => {
      if (error instanceof Error && /^(?:本地模型|连接本地模型)/u.test(error.message)) {
        reject(error)
        return
      }
      reject(new Error('无法连接本地模型服务，请确认服务已启动并且地址正确。'))
    })
  })
}

module.exports = {
  discoverLocalModels,
  normalizeLocalModelEndpoint,
  normalizeLocalTextModelConfig,
}
