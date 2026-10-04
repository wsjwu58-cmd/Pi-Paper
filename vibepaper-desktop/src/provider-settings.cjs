const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function failure(code, message) { return Object.assign(new Error(message), { code }) }
async function atomicWrite(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close(); handle = null
    await fs.rename(temp, file)
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

function createProviderSettings({ directory, safeStorage, catalog, legacyCredentials = {}, testOfficialProviderConnection }) {
  const settingsFile = path.join(directory, 'providers.json')
  let queue = Promise.resolve()
  const serialize = (fn) => { const next = queue.then(fn); queue = next.catch(() => {}); return next }
  const definition = (id) => {
    if (typeof id !== 'string') throw failure('PROVIDER_CONFIGURATION_INVALID', '未知模型提供方。')
    const provider = catalog().providers.find((p) => p.id === id)
    if (!provider || !/^[a-z0-9-]{1,80}$/u.test(id)) throw failure('PROVIDER_CONFIGURATION_INVALID', '未知模型提供方。')
    return provider
  }
  function legacyHandlers(id, provider = definition(id)) {
    const aliases = [id, provider.legacyCredentialId]
    if (id === 'volcengine-ark' || id === 'ark') aliases.push('volcengine', 'ark', 'volcengine-ark')
    if (id === 'agnes') aliases.push('agnes')
    return [...new Set(aliases.filter((value) => typeof value === 'string'))]
      .map((key) => legacyCredentials[key]).filter(Boolean)
  }
  const credentialFile = (id) => path.join(directory, 'credentials', `provider-${id}.bin`)
  async function storageAvailable() {
    const available = safeStorage.isAsyncEncryptionAvailable
      ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable()
    if (!available || process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw failure('SECURE_STORAGE_UNAVAILABLE', '系统安全凭据存储不可用，无法保存或读取官方 API 凭据。')
    }
  }
  async function readSettings() {
    let raw
    try { raw = JSON.parse(await fs.readFile(settingsFile, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, providers: {} }; throw failure('PROVIDER_SETTINGS_INVALID', '模型配置文件无法读取。') }
    if (raw.schemaVersion !== 1 || !raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
      throw failure('PROVIDER_SETTINGS_INVALID', '模型配置版本或格式无效。')
    }
    return raw
  }
  async function credentials(id) {
    definition(id)
    let bytes
    try { bytes = await fs.readFile(credentialFile(id)) }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure('CREDENTIAL_READ_FAILED', '无法读取官方 API 凭据。')
      for (const legacy of legacyHandlers(id)) {
        const key = await legacy.read?.()
        if (key) return validateCredentials(id, { apiKey: key }, { requireAll: false })
      }
      return {}
    }
    await storageAvailable()
    try {
      const plain = safeStorage.decryptStringAsync ? await safeStorage.decryptStringAsync(bytes) : safeStorage.decryptString(bytes)
      const data = JSON.parse(typeof plain === 'string' ? plain : plain.result)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
      return validateCredentials(id, data, { requireAll: false })
    } catch { throw failure('CREDENTIAL_READ_FAILED', '无法解密官方 API 凭据。') }
  }
  function normalize(input, previous = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('INVALID_INPUT', '模型配置无效。')
    const provider = definition(input.providerId)
    if (provider.configurable === false) throw failure('PROVIDER_UNAVAILABLE', provider.unavailableReason || '该厂商尚未完成官方接入。')
    const rawBaseUrl = input.baseUrl ?? previous.baseUrl ?? provider.baseUrl
    if (typeof rawBaseUrl !== 'string' || rawBaseUrl.length > 2048) {
      throw failure('PROVIDER_ENDPOINT_INVALID', '请使用该厂商官方 HTTPS API 地址。')
    }
    let url
    let defaultUrl
    try {
      const trimmedBaseUrl = rawBaseUrl.trim()
      if (!trimmedBaseUrl || trimmedBaseUrl.includes('?') || trimmedBaseUrl.includes('#')) throw new Error()
      url = new URL(trimmedBaseUrl)
      defaultUrl = new URL(provider.baseUrl)
    } catch {
      throw failure('PROVIDER_ENDPOINT_INVALID', '请使用该厂商官方 HTTPS API 地址。')
    }
    const allowedHosts = new Set([defaultUrl.hostname, ...(provider.allowedHosts || [])])
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.port && url.port !== '443' || !allowedHosts.has(url.hostname)) {
      throw failure('PROVIDER_ENDPOINT_INVALID', '请使用该厂商官方 HTTPS API 地址。')
    }
    const providerModels = catalog().models.filter((m) => m.providerId === provider.id)
    const modelIds = new Set(providerModels.map((m) => m.id))
    const enabled = input.enabledModelIds ?? previous.enabledModelIds ?? []
    if (!Array.isArray(enabled) || enabled.length > 200 || enabled.some((id) => typeof id !== 'string' || !modelIds.has(id))) {
      throw failure('PROVIDER_MODELS_INVALID', '启用列表包含未知模型。')
    }
    const defaults = input.defaultModelIds ?? previous.defaultModelIds ?? {}
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw failure('INVALID_INPUT', '默认模型无效。')
    for (const [modality, id] of Object.entries(defaults)) {
      if (!['text', 'image', 'video', 'audio'].includes(modality)
        || typeof id !== 'string' || !enabled.includes(id)
        || !providerModels.some((m) => m.id === id && m.modelType === modality)) {
        throw failure('PROVIDER_DEFAULT_INVALID', '默认模型必须属于已启用的对应类型。')
      }
    }
    const timeoutSeconds = input.timeoutSeconds ?? previous.timeoutSeconds ?? 180
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 600) throw failure('INVALID_INPUT', '请求超时须为 10–600 秒。')
    const rawModelDefaults = input.modelDefaults ?? previous.modelDefaults ?? {}
    if (!rawModelDefaults || typeof rawModelDefaults !== 'object' || Array.isArray(rawModelDefaults)
      || Object.keys(rawModelDefaults).length > 200) throw failure('PROVIDER_DEFAULT_INVALID', '模型默认参数无效。')
    const modelDefaults = Object.fromEntries(Object.entries(rawModelDefaults).map(([id, values]) => {
      const model = providerModels.find((m) => m.id === id && m.implemented)
      if (!model || !values || typeof values !== 'object' || Array.isArray(values)) throw failure('PROVIDER_DEFAULT_INVALID', '默认参数必须属于已实现的当前厂商模型。')
      const constraints = model.constraints || {}
      const validated = Object.fromEntries(Object.entries(values).map(([key, value]) => {
        let valid = false
        if (key === 'ratio') valid = typeof value === 'string' && (constraints.acceptedAspectRatios || [model.defaults?.ratio]).includes(value)
        if (key === 'size') valid = typeof value === 'string' && (constraints.acceptedSizes || [model.defaults?.size]).includes(value)
        if (key === 'resolution') valid = typeof value === 'string' && (constraints.acceptedResolutions || [model.defaults?.resolution]).includes(value)
        if (key === 'duration') valid = model.modelType === 'video' && Number.isInteger(value)
          && value >= (constraints.minimumDuration ?? model.defaults?.duration ?? 1)
          && value <= (constraints.maximumDuration ?? model.defaults?.duration ?? 1)
        if (key === 'generate_audio') valid = constraints.supportsGenerateAudio === true && typeof value === 'boolean'
        if (!valid) throw failure('PROVIDER_DEFAULT_INVALID', '默认参数超出已实现模型的能力范围。')
        return [key, value]
      }))
      const merged = { ...model.defaults, ...validated }
      const durations = constraints.durationByResolution?.[merged.resolution] || constraints.acceptedDurations
      if (Array.isArray(durations) && merged.duration !== undefined && !durations.includes(merged.duration)) {
        throw failure('PROVIDER_DEFAULT_INVALID', '默认时长与所选分辨率不匹配。')
      }
      return [id, validated]
    }))
    return { providerId: provider.id, baseUrl: url.toString().replace(/\/$/u, ''),
      enabledModelIds: [...new Set(enabled)], defaultModelIds: { ...defaults }, modelDefaults, timeoutSeconds }
  }
  function validateCredentials(id, values, { requireAll = true } = {}) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw failure('INVALID_INPUT', '凭据格式无效。')
    const fields = definition(id).credentialFields
    const result = {}
    for (const field of fields) {
      const value = values[field.name]
      if (value !== undefined && (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value))) {
        throw failure('INVALID_INPUT', '官方 API 凭据格式无效。')
      }
      if (typeof value === 'string' && value.trim()) result[field.name] = value.trim()
      else if (field.required && requireAll) throw failure('CLOUD_CREDENTIAL_MISSING', `请填写${field.label}。`)
    }
    if (id === 'kling') {
      const hasApiKey = Boolean(result.apiKey)
      const hasAccessKey = Boolean(result.accessKey)
      const hasSecretKey = Boolean(result.secretKey)
      if (hasAccessKey !== hasSecretKey || hasApiKey && (hasAccessKey || hasSecretKey)) {
        throw failure('CLOUD_CREDENTIAL_INVALID', 'Kling 请填写新版 API Key，或同时填写旧版 Access Key 与 Secret Key；两种方式不能混用。')
      }
      if (requireAll && !hasApiKey && !hasAccessKey) {
        throw failure('CLOUD_CREDENTIAL_MISSING', '请填写 Kling API Key，或填写完整的旧版 AK/SK。')
      }
    }
    if (id === 'alibaba-video' && (result.workspaceId && !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(result.workspaceId)
      || result.region && !['cn-beijing', 'ap-southeast-1', 'ap-northeast-1', 'eu-central-1', 'us-east-1', 'cn-hongkong'].includes(result.region))) {
      throw failure('PROVIDER_ENDPOINT_INVALID', '请填写有效的百炼 Workspace ID 和官方 Region。')
    }
    return result
  }
  function mergeCredentials(id, existing, supplied) {
    if (supplied === undefined) return validateCredentials(id, existing, { requireAll: false })
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw failure('INVALID_INPUT', '凭据格式无效。')
    const fields = new Set(definition(id).credentialFields.map((field) => field.name))
    const merged = { ...existing }
    for (const [name, value] of Object.entries(supplied)) {
      if (!fields.has(name)) throw failure('INVALID_INPUT', '凭据格式无效。')
      if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw failure('INVALID_INPUT', '官方 API 凭据格式无效。')
      }
      if (value.trim()) merged[name] = value.trim()
    }
    if (id === 'kling') {
      const hasSuppliedApiKey = typeof supplied.apiKey === 'string' && Boolean(supplied.apiKey.trim())
      const hasSuppliedAccessKey = typeof supplied.accessKey === 'string' && Boolean(supplied.accessKey.trim())
      const hasSuppliedSecretKey = typeof supplied.secretKey === 'string' && Boolean(supplied.secretKey.trim())
      if (hasSuppliedApiKey && (hasSuppliedAccessKey || hasSuppliedSecretKey)) {
        throw failure('CLOUD_CREDENTIAL_INVALID', 'Kling 请单独填写新版 API Key，不能同时提交旧版 AK/SK。')
      }
      if (hasSuppliedApiKey) {
        delete merged.accessKey
        delete merged.secretKey
      } else if (hasSuppliedAccessKey && hasSuppliedSecretKey) {
        delete merged.apiKey
      }
    }
    return validateCredentials(id, merged, { requireAll: false })
  }
  function hasRequiredCredentials(provider, secrets) {
    if (provider.id === 'kling') return Boolean(secrets.apiKey) || Boolean(secrets.accessKey && secrets.secretKey)
    return provider.credentialFields.filter((field) => field.required).every((field) => Boolean(secrets[field.name]))
  }
  function hasProbeCredentials(provider, secrets) {
    if (provider.id === 'kling') return Boolean(secrets.apiKey) || Boolean(secrets.accessKey && secrets.secretKey)
    return provider.credentialFields.filter((field) => field.required && field.secret).every((field) => Boolean(secrets[field.name]))
  }
  function sanitizeMessage(message, secrets) {
    let value = typeof message === 'string' ? message : ''
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length) value = value.split(secret).join('[已隐藏凭据]')
    }
    return value.replace(/\bBearer\s+[^\s"'<>]+/giu, 'Bearer [已隐藏凭据]')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ').trim().slice(0, 800)
  }
  async function snapshot() {
    const settings = await readSettings()
    const raw = catalog()
    const credentialsByProvider = new Map()
    const providers = await Promise.all(raw.providers.map(async (p) => {
      if (p.configurable === false) return { ...p, configured: false, enabledModelIds: [], defaultModelIds: {}, timeoutSeconds: 180 }
      const saved = settings.providers[p.id]
      const normalized = normalize({
        providerId: p.id,
        ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}),
      }, {})
      const secrets = await credentials(p.id)
      credentialsByProvider.set(p.id, secrets)
      const configured = hasRequiredCredentials(p, secrets)
      if (!saved && configured) {
        const compatible = raw.models.filter((model) => model.providerId === p.id && model.implemented
          && ['legacy-agnes', 'legacy-ark'].includes(model.route))
        normalized.enabledModelIds = compatible.map((model) => model.id)
        normalized.defaultModelIds = Object.fromEntries(compatible.map((model) => [model.modelType, model.id]))
      }
      return { ...p, ...normalized, configured }
    }))
    return { providers, models: raw.models.map((m) => {
      const p = providers.find((p) => p.id === m.providerId)
      const secrets = credentialsByProvider.get(m.providerId) || {}
      const missingCredentials = (m.requiredCredentials || []).some((name) => !secrets[name])
      return { ...m, defaults: { ...m.defaults, ...p?.modelDefaults?.[m.id] }, name: m.name || m.displayName || m.id, providerType: 'cloud',
        ...(missingCredentials ? { unavailableReason: '请补齐该模型所需的音色或账号配置。' } : {}),
        enabled: Boolean(m.implemented === true && p?.configured && !missingCredentials && p.enabledModelIds.includes(m.id)) }
    }) }
  }
  async function save(input) {
    return serialize(async () => {
      const settings = await readSettings()
      const saved = normalize(input, settings.providers[input?.providerId])
      const existing = await credentials(saved.providerId)
      const secrets = mergeCredentials(saved.providerId, existing, input.credentials)
      validateCredentials(saved.providerId, secrets)
      await storageAvailable()
      const bytes = safeStorage.encryptStringAsync ? await safeStorage.encryptStringAsync(JSON.stringify(secrets)) : safeStorage.encryptString(JSON.stringify(secrets))
      await atomicWrite(credentialFile(saved.providerId), bytes)
      settings.providers[saved.providerId] = saved
      await atomicWrite(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
      return snapshot()
    })
  }
  async function clear(id) {
    definition(id)
    return serialize(async () => {
      const settings = await readSettings()
      delete settings.providers[id]
      // Persist removal before removing credentials: a crash can never enable a removed connection.
      await atomicWrite(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
      await fs.rm(credentialFile(id), { force: true })
      for (const legacy of legacyHandlers(id)) await legacy.clear?.()
      return snapshot()
    })
  }
  async function resolve(providerId, modelId, modality) {
    const view = await snapshot()
    const model = view.models.find((m) => m.providerId === providerId && (m.id === modelId || m.apiModelId === modelId) && m.modelType === modality)
    if (!model?.enabled) throw failure('MODEL_UNAVAILABLE', model?.unavailableReason || '请先配置并启用该模型。')
    const p = view.providers.find((p) => p.id === providerId)
    const secrets = await credentials(providerId)
    let endpoint = p.baseUrl
    if (providerId === 'alibaba-video') {
      const regions = ['cn-beijing', 'ap-southeast-1', 'ap-northeast-1', 'eu-central-1', 'us-east-1', 'cn-hongkong']
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(secrets.workspaceId || '') || !regions.includes(secrets.region)) {
        throw failure('PROVIDER_ENDPOINT_INVALID', '请填写有效的百炼 Workspace ID 和官方 Region。')
      }
      endpoint = `https://${secrets.workspaceId}.${secrets.region}.maas.aliyuncs.com/api/v1`
    }
    if (model.apiBaseUrl) {
      const modelUrl = new URL(model.apiBaseUrl)
      const providerUrl = new URL(p.baseUrl)
      if (modelUrl.protocol !== 'https:' || modelUrl.username || modelUrl.password || modelUrl.search || modelUrl.hash
        || ![providerUrl.hostname, ...(p.allowedHosts || [])].includes(modelUrl.hostname)) {
        throw failure('PROVIDER_ENDPOINT_INVALID', '模型的官方 API 地址与配置厂商不匹配。')
      }
      // Some official vendors expose text and media under different API paths.
      providerUrl.pathname = modelUrl.pathname
      endpoint = providerUrl.toString().replace(/\/$/u, '')
    }
    return { providerId, providerType: 'cloud', modelId: model.id, apiModelId: model.apiModelId,
      endpoint, timeoutMs: p.timeoutSeconds * 1000, credentials: secrets, apiKey: secrets.apiKey, officialPi: true, model }
  }
  async function test(input) {
    const settings = await readSettings()
    const normalized = normalize(input, settings.providers[input?.providerId])
    const provider = definition(input.providerId)
    const existing = await credentials(input.providerId)
    const secrets = mergeCredentials(input.providerId, existing, input.credentials)
    validateCredentials(input.providerId, secrets, { requireAll: false })
    if (!hasProbeCredentials(provider, secrets)) {
      throw failure('CLOUD_CREDENTIAL_MISSING', `请填写${provider.name}所需的 API Key 或鉴权凭据。`)
    }
    const probe = provider.connectionTest
    if (!probe || probe.kind === 'format-only') {
      return { status: 'unsupported', success: false,
        message: `${provider.name} 暂无已核实的安全鉴权检测接口；未发送请求，当前无法确认 Key 是否有效。` }
    }
    if (typeof testOfficialProviderConnection !== 'function') {
      return { status: 'unsupported', success: false,
        message: `${provider.name} 的网络检测组件不可用；未发送请求，当前无法确认 Key 是否有效。` }
    }
    {
      try {
        const result = await testOfficialProviderConnection(provider.id, {
          apiKey: secrets.apiKey,
          credentials: secrets,
          baseUrl: normalized.baseUrl,
          timeoutMs: normalized.timeoutSeconds * 1000,
        })
        if (result?.status === 'unsupported' && result.success === false) {
          return { status: 'unsupported', success: false,
            message: sanitizeMessage(result.message, Object.values(secrets)) || '该提供方暂不支持安全的网络鉴权检测。' }
        }
        if (!result || result.success !== true || result.status !== 'connected') {
          throw failure('PROVIDER_TEST_FAILED', '官方连接验证失败。')
        }
        return { status: 'connected', success: true,
          message: sanitizeMessage(result.message, Object.values(secrets)) || '官方已接受凭据；未发送生成请求。' }
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(error.code)
          ? error.code : 'PROVIDER_TEST_FAILED'
        const message = code === 'NETWORK_ERROR'
          ? '无法连接厂商 API，请检查系统代理、网络和证书设置。请求未完成，尚不能判断 Key 是否有效。'
          : code === 'REQUEST_TIMEOUT'
            ? '连接厂商 API 超时，请检查系统代理与网络。尚不能判断 Key 是否有效。'
            : sanitizeMessage(error?.message, Object.values(secrets)) || '官方连接验证失败。'
        throw failure(code, message)
      }
    }
  }
  return { snapshot, save, clear, resolve, test, credentials }
}
module.exports = { createProviderSettings, atomicWrite }
