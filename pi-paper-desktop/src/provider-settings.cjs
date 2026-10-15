const fs = require('node:fs/promises')
const { constants: fsConstants } = require('node:fs')
const path = require('node:path')
const { createHmac, randomBytes, randomUUID } = require('node:crypto')

function failure(code, message) { return Object.assign(new Error(message), { code }) }
function safeStorageBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value)
  throw failure('SECURE_STORAGE_UNAVAILABLE', '系统安全凭据存储不可用，无法保存或读取官方 API 凭据。')
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function isUnsupportedDirectorySync(error) {
  return ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error?.code)
}
async function syncDirectory(directory) {
  let handle
  try { handle = await fs.open(directory, 'r'); await handle.sync() }
  catch (error) { if (!isUnsupportedDirectorySync(error)) throw error }
  finally { await handle?.close().catch(() => {}) }
}
async function atomicWrite(file, bytes, { beforeCommit } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close(); handle = null
    if (beforeCommit) await beforeCommit()
    await fs.rename(temp, file)
    await syncDirectory(path.dirname(file))
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

function createProviderSettings({ directory, safeStorage, catalog, legacyCredentials = {}, testOfficialProviderConnection, faultInjector = async () => {} }) {
  const settingsFile = path.join(directory, 'providers.json')
  const transactionFile = path.join(directory, 'provider-settings.transaction.json')
  const schemaOneBackupFile = path.join(directory, 'providers.v1.backup.json')
  const credentialsDirectory = path.join(directory, 'credentials')
  const operationHmacKeyFile = path.join(credentialsDirectory, 'provider-operation-hmac-key.bin')
  let queue = Promise.resolve()
  let recoveryBlocked = false
  const detectionByProvider = new Map()
  const serialize = (fn) => { const next = queue.then(fn); queue = next.catch(() => {}); return next }
  async function checkpoint(point) { await faultInjector(point) }
  const isInjectedCrash = (error) => error?.code === 'PROVIDER_SETTINGS_INJECTED_CRASH'
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
  const stagedCredentialFile = (id, reference) => {
    if (!/^[a-z0-9-]{1,80}$/u.test(id) || !/^[0-9a-f-]{36}$/iu.test(reference)) {
      throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置暂存引用无效，相关提供方已停用。')
    }
    return path.join(directory, 'credentials', `provider-${id}.${reference}.stage.bin`)
  }
  const rollbackCredentialFile = (id, reference) => {
    if (!/^[a-z0-9-]{1,80}$/u.test(id) || !/^[0-9a-f-]{36}$/iu.test(reference)) {
      throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置回滚引用无效，相关提供方已停用。')
    }
    return path.join(directory, 'credentials', `provider-${id}.${reference}.rollback.bin`)
  }
  async function ensureCredentialsDirectory() {
    try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }) }
    catch { throw failure('PROVIDER_STATE_INCOMPLETE', '模型凭据目录不可用，相关提供方已停用。') }
    let rootInfo
    try { rootInfo = await fs.lstat(directory) }
    catch { throw failure('PROVIDER_STATE_INCOMPLETE', '模型凭据目录不可用，相关提供方已停用。') }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置目录必须是固定的本地目录。')
    }
    try { await fs.mkdir(credentialsDirectory, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw failure('PROVIDER_STATE_INCOMPLETE', '模型凭据目录不可用，相关提供方已停用。') }
    let credentialInfo
    try { credentialInfo = await fs.lstat(credentialsDirectory) }
    catch { throw failure('PROVIDER_STATE_INCOMPLETE', '模型凭据目录不可用，相关提供方已停用。') }
    if (!credentialInfo.isDirectory() || credentialInfo.isSymbolicLink()) {
      throw failure('PROVIDER_STATE_INCOMPLETE', '模型凭据目录必须是固定的本地目录。')
    }
    return credentialsDirectory
  }
  async function readRegularFile(file, errorCode, message, { maxBytes = 16 * 1024 * 1024 } = {}) {
    let handle
    try {
      const noFollow = fsConstants.O_NOFOLLOW || 0
      handle = await fs.open(file, fsConstants.O_RDONLY | noFollow)
      const before = await handle.stat()
      const after = await fs.lstat(file)
      if (!before.isFile() || after.isSymbolicLink() || !after.isFile()
        || before.dev !== after.dev || before.ino !== after.ino || before.size > maxBytes) throw new Error('unsafe file')
      const bytes = await handle.readFile()
      if (bytes.length > maxBytes) throw new Error('oversized file')
      return bytes
    } catch (error) {
      if (error.code === 'ENOENT') throw error
      throw failure(errorCode, message)
    } finally { await handle?.close().catch(() => {}) }
  }
  async function assertNoSecretKeys(value, depth = 0) {
    if (depth > 16) throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置状态无效，相关提供方已停用。')
    if (Array.isArray(value)) { for (const item of value) await assertNoSecretKeys(item, depth + 1); return }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'credentialStageRef' && /(?:credential|api.?key|access.?key|secret|password|token)/iu.test(key)) {
        throw failure('PROVIDER_STATE_INCOMPLETE', '普通模型配置或恢复记录包含受限凭据字段。')
      }
      await assertNoSecretKeys(child, depth + 1)
    }
  }
  async function storageAvailable() {
    const available = safeStorage.isAsyncEncryptionAvailable
      ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable()
    if (!available || process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw failure('SECURE_STORAGE_UNAVAILABLE', '系统安全凭据存储不可用，无法保存或读取官方 API 凭据。')
    }
  }
  async function readSettingsFile() {
    let raw
    let rawText
    try { rawText = (await readRegularFile(settingsFile, 'PROVIDER_SETTINGS_INVALID', '模型配置文件无法读取。')).toString('utf8'); raw = JSON.parse(rawText) }
    catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 2, providers: {}, providerRevisions: {} }; throw failure('PROVIDER_SETTINGS_INVALID', '模型配置文件无法读取。') }
    if (![1, 2].includes(raw.schemaVersion) || !raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
      throw failure('PROVIDER_SETTINGS_INVALID', '模型配置版本或格式无效。')
    }
    await assertNoSecretKeys(raw)
    const providerRevisions = raw.schemaVersion === 2 && raw.providerRevisions
      && typeof raw.providerRevisions === 'object' && !Array.isArray(raw.providerRevisions)
      ? { ...raw.providerRevisions } : {}
    for (const [id, value] of Object.entries(raw.providers)) {
      const revision = Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0
      providerRevisions[id] = Number.isSafeInteger(providerRevisions[id]) && providerRevisions[id] >= 0
        ? providerRevisions[id] : revision
      if (value && typeof value === 'object' && !Array.isArray(value)) delete value.revision
    }
    const migrated = { schemaVersion: 2, providers: raw.providers, providerRevisions }
    if (raw.schemaVersion === 1) {
      let handle
      try {
        handle = await fs.open(schemaOneBackupFile, 'wx', 0o600)
        await handle.writeFile(rawText)
        await handle.sync()
        await handle.close(); handle = null
        await syncDirectory(directory)
      } catch (error) {
        if (error.code !== 'EEXIST') throw failure('PROVIDER_SETTINGS_MIGRATION_FAILED', '模型配置升级备份失败，原配置保持不变。')
        try {
          const existingBackup = await readRegularFile(schemaOneBackupFile, 'PROVIDER_SETTINGS_MIGRATION_FAILED', '模型配置升级备份无效。', { maxBytes: 16 * 1024 * 1024 })
          if (!existingBackup.equals(Buffer.from(rawText))) throw new Error('backup mismatch')
        } catch { throw failure('PROVIDER_SETTINGS_MIGRATION_FAILED', '模型配置升级备份无效，原配置保持不变。') }
      } finally { await handle?.close().catch(() => {}) }
      try { await atomicWrite(settingsFile, `${JSON.stringify(migrated, null, 2)}\n`) }
      catch { throw failure('PROVIDER_SETTINGS_MIGRATION_FAILED', '模型配置升级失败，可使用 providers.v1.backup.json 恢复。') }
    }
    return migrated
  }
  async function recoverTransaction() {
    if (recoveryBlocked) throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置恢复未完成，相关提供方已停用。')
    let raw
    try { raw = (await readRegularFile(transactionFile, 'PROVIDER_STATE_INCOMPLETE', '模型配置恢复未完成，相关提供方已停用。')).toString('utf8') }
    catch (error) {
      if (error.code === 'ENOENT') { await removeOrphanedStages(); return }
      throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置恢复未完成，相关提供方已停用。')
    }
    let transaction
    try { transaction = JSON.parse(raw) } catch { recoveryBlocked = true; throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置恢复记录无效，模型提供方已停用。') }
    const valid = transaction?.schemaVersion === 1
      && typeof transaction.providerId === 'string' && /^[a-z0-9-]{1,80}$/u.test(transaction.providerId)
      && Number.isSafeInteger(transaction.fromRevision) && transaction.fromRevision >= 0
      && Number.isSafeInteger(transaction.toRevision) && transaction.toRevision === transaction.fromRevision + 1
      && transaction.nextSettings?.schemaVersion === 2
      && transaction.nextSettings.providers && typeof transaction.nextSettings.providers === 'object'
      && transaction.nextSettings.providerRevisions?.[transaction.providerId] === transaction.toRevision
      && typeof transaction.credentialStageRef === 'string' && /^[0-9a-f-]{36}$/iu.test(transaction.credentialStageRef)
      && (transaction.authorizationRequired === undefined || typeof transaction.authorizationRequired === 'boolean')
      && Object.keys(transaction).every((key) => ['schemaVersion', 'providerId', 'fromRevision', 'toRevision', 'credentialStageRef', 'nextSettings', 'authorizationRequired'].includes(key))
    if (!valid) { recoveryBlocked = true; throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置恢复记录无效，模型提供方已停用。') }
    try {
      await ensureCredentialsDirectory()
      await assertNoSecretKeys(transaction.nextSettings)
      const stage = stagedCredentialFile(transaction.providerId, transaction.credentialStageRef)
      if (transaction.authorizationRequired) {
        // An interrupted MCP write must not be completed from a stale journal
        // after restart, because its live desktop grant no longer exists.
        // If the revision reached the commit point, the write is already done;
        // otherwise restore the encrypted pre-transaction credential snapshot.
        const currentSettings = await readSettingsFile()
        const current = currentRevision(currentSettings, transaction.providerId)
        if (current === transaction.fromRevision) {
          const rollback = await readRegularFile(rollbackCredentialFile(transaction.providerId, transaction.credentialStageRef),
            'PROVIDER_STATE_INCOMPLETE', '模型配置恢复未完成，相关提供方已停用。', { maxBytes: 1024 * 1024 })
          await atomicWrite(credentialFile(transaction.providerId), rollback)
        } else if (current !== transaction.toRevision) {
          throw new Error('unexpected provider revision')
        }
        await fs.rm(transactionFile, { force: true })
        await fs.rm(stage, { force: true }).catch(() => {})
        await fs.rm(rollbackCredentialFile(transaction.providerId, transaction.credentialStageRef), { force: true }).catch(() => {})
        return
      }
      const stageBytes = await readRegularFile(stage, 'PROVIDER_STATE_INCOMPLETE', '模型配置恢复未完成，相关提供方已停用。', { maxBytes: 1024 * 1024 })
      if (stageBytes.length < 1) throw new Error('empty stage')
      await atomicWrite(credentialFile(transaction.providerId), stageBytes)
      await atomicWrite(settingsFile, `${JSON.stringify(transaction.nextSettings, null, 2)}\n`)
      await fs.rm(transactionFile, { force: true })
      if (transaction.credentialStageRef) await fs.rm(stagedCredentialFile(transaction.providerId, transaction.credentialStageRef), { force: true }).catch(() => {})
      if (transaction.credentialStageRef) await fs.rm(rollbackCredentialFile(transaction.providerId, transaction.credentialStageRef), { force: true }).catch(() => {})
    } catch {
      // Keep the durable journal. Reads remain disabled until recovery can finish.
      throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置恢复未完成，相关提供方已停用。')
    }
  }
  async function removeOrphanedStages() {
    await ensureCredentialsDirectory()
    let entries
    try { entries = await fs.readdir(credentialsDirectory) }
    catch (error) { if (error.code === 'ENOENT') return; throw failure('PROVIDER_STATE_INCOMPLETE', '模型配置暂存目录无法恢复。') }
    for (const entry of entries) {
      if (/^provider-[a-z0-9-]{1,80}\.[0-9a-f-]{36}\.(?:stage|rollback)\.bin$/iu.test(entry)) {
        await fs.rm(path.join(credentialsDirectory, entry), { force: true }).catch(() => {})
      }
    }
  }
  async function readSettings() {
    await recoverTransaction()
    return readSettingsFile()
  }
  async function readCredentialRecord(id) {
    definition(id)
    let bytes
    await ensureCredentialsDirectory()
    try { bytes = await readRegularFile(credentialFile(id), 'CREDENTIAL_READ_FAILED', '无法读取官方 API 凭据。', { maxBytes: 1024 * 1024 }) }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure('CREDENTIAL_READ_FAILED', '无法读取官方 API 凭据。')
      for (const legacy of legacyHandlers(id)) {
        const key = await legacy.read?.()
        if (key) return { credentials: validateCredentials(id, { apiKey: key }, { requireAll: false }), revision: 0, legacy: true }
      }
      return { credentials: {}, revision: 0, legacy: false }
    }
    await storageAvailable()
    try {
      const plain = safeStorage.decryptStringAsync ? await safeStorage.decryptStringAsync(bytes) : safeStorage.decryptString(bytes)
      const data = JSON.parse(typeof plain === 'string' ? plain : plain.result)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
      if (data.schemaVersion === 1 && Number.isSafeInteger(data.revision) && data.revision >= 0
        && data.credentials && typeof data.credentials === 'object' && !Array.isArray(data.credentials)) {
        return { credentials: validateCredentials(id, data.credentials, { requireAll: false }), revision: data.revision, legacy: false }
      }
      // Existing encrypted credential files are revision zero and remain readable.
      return { credentials: validateCredentials(id, data, { requireAll: false }), revision: 0, legacy: true }
    } catch { throw failure('CREDENTIAL_READ_FAILED', '无法解密官方 API 凭据。') }
  }
  async function credentials(id) { return (await readCredentialRecord(id)).credentials }
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
      for (const [field, table] of [['size', constraints.sizesByAspectRatio], ['resolution', constraints.resolutionsByAspectRatio]]) {
        if (table && merged[field] !== undefined && !table[merged.ratio]?.includes(merged[field])) {
          throw failure('PROVIDER_DEFAULT_INVALID', '默认比例与所选尺寸或分辨率不匹配。')
        }
      }
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
    const allowedFields = new Set(fields.map((field) => field.name))
    if (Object.keys(values).some((name) => !allowedFields.has(name))) throw failure('INVALID_INPUT', '凭据格式无效。')
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
  async function snapshotInternal(providerFilter) {
    const settings = await readSettings()
    const catalogData = catalog()
    const raw = providerFilter
      ? { ...catalogData,
        providers: catalogData.providers.filter((provider) => provider.id === providerFilter),
        models: catalogData.models.filter((model) => model.providerId === providerFilter) }
      : catalogData
    const credentialsByProvider = new Map()
    const recordsByProvider = new Map()
    const providers = await Promise.all(raw.providers.map(async (p) => {
      const revision = settings.providerRevisions[p.id] || 0
      const detection = detectionByProvider.get(p.id)
      const detectionStatus = detection?.revision === revision ? detection.status : detection ? 'stale' : 'not_tested'
      if (p.configurable === false) return { ...p,
        credentialFields: (p.credentialFields || []).map((field) => typeof field === 'string'
          ? { name: field, configured: false } : { ...field, configured: false }),
        revision, detection: { status: detectionStatus, revision: detection?.revision }, configured: false, enabledModelIds: [], defaultModelIds: {}, timeoutSeconds: 180 }
      const saved = settings.providers[p.id]
      const normalized = normalize({
        providerId: p.id,
        ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}),
      }, {})
      const record = await readCredentialRecord(p.id)
      const secrets = record.credentials
      const consistent = record.revision === revision
      recordsByProvider.set(p.id, { ...record, consistent })
      credentialsByProvider.set(p.id, secrets)
      const configured = consistent && hasRequiredCredentials(p, secrets)
      if (!saved && configured) {
        const compatible = raw.models.filter((model) => model.providerId === p.id && model.implemented
          && ['legacy-agnes', 'legacy-ark'].includes(model.route))
        normalized.enabledModelIds = compatible.map((model) => model.id)
        normalized.defaultModelIds = Object.fromEntries(compatible.map((model) => [model.modelType, model.id]))
      }
      return { ...p, ...normalized,
        credentialFields: (p.credentialFields || []).map((field) => typeof field === 'string'
          ? { name: field, configured: Boolean(secrets[field]) } : { ...field, configured: Boolean(secrets[field.name]) }),
        revision, detection: { status: detectionStatus, revision: detection?.revision }, configured,
        ...(consistent ? {} : { recoveryState: 'incomplete', unavailableReason: '提供方配置版本不一致，已停用。请重新保存配置。', enabledModelIds: [], defaultModelIds: {} }) }
    }))
    return { providers, models: raw.models.map((m) => {
      const p = providers.find((p) => p.id === m.providerId)
      const secrets = credentialsByProvider.get(m.providerId) || {}
      const record = recordsByProvider.get(m.providerId)
      const missingCredentials = (m.requiredCredentials || []).some((name) => !secrets[name])
      return { ...m, defaults: { ...m.defaults, ...p?.modelDefaults?.[m.id] }, name: m.name || m.displayName || m.id, providerType: 'cloud',
        ...(missingCredentials ? { unavailableReason: '请补齐该模型所需的音色或账号配置。' } : {}),
        enabled: Boolean(m.implemented === true && p?.configured && record?.consistent !== false && !missingCredentials && p.enabledModelIds.includes(m.id)) }
    }) }
  }
  async function snapshot() { return serialize(() => snapshotInternal()) }
  async function snapshotProvider(providerId) {
    definition(providerId)
    return serialize(() => snapshotInternal(providerId))
  }
  function currentRevision(settings, id) { return settings.providerRevisions[id] || 0 }
  function assertExpectedRevision(settings, id, expectedRevision, required = false) {
    const current = currentRevision(settings, id)
    if (required && !Number.isSafeInteger(expectedRevision)) throw failure('PROVIDER_REVISION_REQUIRED', '请先刷新提供方配置版本后再提交。')
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current)) {
      throw failure('PROVIDER_REVISION_CONFLICT', '提供方配置已变化，请刷新后重试。')
    }
    return current
  }
  async function previewPublicConfiguration(input) {
    return serialize(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['providerId', 'baseUrl', 'enabledModelIds', 'defaultModelIds', 'modelDefaults', 'timeoutSeconds'].includes(key))) {
        throw failure('INVALID_INPUT', '模型配置包含未知字段。')
      }
      const providerId = input.providerId
      definition(providerId)
      const settings = await readSettings()
      return { ...normalize(input, settings.providers[providerId]), revision: currentRevision(settings, providerId) }
    })
  }
  async function prepareCredentialUpdate({ providerId, expectedRevision, credentials: supplied } = {}) {
    return serialize(async () => {
      const settings = await readSettings()
      const revision = assertExpectedRevision(settings, providerId, expectedRevision, true)
      const record = await readCredentialRecord(providerId)
      if (record.revision !== revision) {
        throw failure('PROVIDER_STATE_INCOMPLETE', '提供方配置版本不一致，请重新填写完整凭据后保存。')
      }
      const merged = mergeCredentials(providerId, record.credentials, supplied)
      validateCredentials(providerId, merged)
      return merged
    })
  }
  async function encryptedCredentials(revision, secrets) {
    await storageAvailable()
    const plain = JSON.stringify({ schemaVersion: 1, revision, credentials: secrets })
    const encrypted = safeStorage.encryptStringAsync ? await safeStorage.encryptStringAsync(plain) : safeStorage.encryptString(plain)
    return safeStorageBytes(encrypted)
  }
  async function commitProviderTransaction(settings, providerId, nextSettings, oldSecrets, nextSecrets, nextRevision, assertAuthorized) {
    const nextCiphertext = await encryptedCredentials(nextRevision, nextSecrets)
    const rollbackCiphertext = await encryptedCredentials(currentRevision(settings, providerId), oldSecrets)
    const stageReference = randomUUID()
    const stageFile = stagedCredentialFile(providerId, stageReference)
    const rollbackFile = rollbackCredentialFile(providerId, stageReference)
    const transaction = { schemaVersion: 1, providerId,
      fromRevision: currentRevision(settings, providerId), toRevision: nextRevision,
      credentialStageRef: stageReference, nextSettings,
      ...(assertAuthorized ? { authorizationRequired: true } : {}) }
    try {
      await ensureCredentialsDirectory()
      await assertNoSecretKeys(nextSettings)
      await checkpoint('before-stage-write')
      await atomicWrite(stageFile, nextCiphertext)
      await atomicWrite(rollbackFile, rollbackCiphertext)
      await checkpoint('after-stage-write')
      await checkpoint('before-journal-write')
      await atomicWrite(transactionFile, `${JSON.stringify(transaction)}\n`)
      await checkpoint('after-journal-write')
    } catch (error) {
      if (isInjectedCrash(error)) throw failure('PROVIDER_SAVE_FAILED', '提供方配置提交已中断，重新读取时将自动恢复。')
      await fs.rm(stageFile, { force: true }).catch(() => {})
      throw failure('PROVIDER_SAVE_FAILED', '提供方配置未能完整提交，请刷新状态后重试。')
    }
    try {
      await checkpoint('before-credential-write')
      if (assertAuthorized) await assertAuthorized()
      const stagedBytes = await readRegularFile(stageFile, 'PROVIDER_SAVE_FAILED', '提供方配置未能完整提交，请刷新状态后重试。', { maxBytes: 1024 * 1024 })
      await atomicWrite(credentialFile(providerId), stagedBytes)
      await checkpoint('after-credential-write')
      await checkpoint('before-settings-write')
      await atomicWrite(settingsFile, `${JSON.stringify(nextSettings, null, 2)}\n`, { beforeCommit: assertAuthorized })
      await checkpoint('after-settings-write')
      await checkpoint('before-journal-remove')
      await fs.rm(transactionFile, { force: true })
      await checkpoint('after-journal-remove')
      await checkpoint('before-stage-remove')
      await fs.rm(stageFile, { force: true })
      await fs.rm(rollbackFile, { force: true })
      await checkpoint('after-stage-remove')
    } catch (error) {
      if (isInjectedCrash(error)) throw failure('PROVIDER_SAVE_FAILED', '提供方配置提交已中断，重新读取时将自动恢复。')
      try {
        await checkpoint('before-rollback-credential')
        await atomicWrite(credentialFile(providerId), rollbackCiphertext)
        await checkpoint('before-rollback-settings')
        await atomicWrite(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
        await fs.rm(stageFile, { force: true })
        await fs.rm(rollbackFile, { force: true })
        await fs.rm(transactionFile, { force: true })
      } catch { /* durable transaction remains and the provider will fail closed */ }
      if (assertAuthorized && error?.code && error.code !== 'PROVIDER_SAVE_FAILED') throw error
      throw failure('PROVIDER_SAVE_FAILED', '提供方配置未能完整提交，请刷新状态后重试。')
    }
  }
  async function save(input, options = {}) {
    return serialize(async () => {
      if (options === null || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some((key) => key !== 'assertAuthorized')
        || options.assertAuthorized !== undefined && typeof options.assertAuthorized !== 'function') {
        throw failure('INVALID_INPUT', '模型配置提交选项无效。')
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['providerId', 'expectedRevision', 'operationId', 'baseUrl', 'enabledModelIds', 'defaultModelIds', 'modelDefaults', 'timeoutSeconds', 'credentials'].includes(key))) {
        throw failure('INVALID_INPUT', '模型配置包含未知字段。')
      }
      if (input.operationId !== undefined && (typeof input.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(input.operationId))) {
        throw failure('INVALID_INPUT', '模型配置操作标识无效。')
      }
      const settings = await readSettings()
      const providerId = input?.providerId
      definition(providerId)
      const previousRevision = assertExpectedRevision(settings, providerId, input.expectedRevision, true)
      const saved = normalize(input, settings.providers[providerId])
      let record = await readCredentialRecord(saved.providerId)
      if (record.revision !== previousRevision) {
        const supplied = input.credentials && validateCredentials(providerId, input.credentials, { requireAll: false })
        if (!supplied || !hasRequiredCredentials(definition(providerId), supplied)) {
          throw failure('PROVIDER_STATE_INCOMPLETE', '提供方配置版本不一致，请重新填写完整凭据后保存。')
        }
        record = { credentials: {}, revision: previousRevision }
      }
      const secrets = mergeCredentials(saved.providerId, record.credentials, input.credentials)
      validateCredentials(saved.providerId, secrets)
      const nextRevision = previousRevision + 1
      const nextSettings = { ...settings, schemaVersion: 2,
        providers: { ...settings.providers, [saved.providerId]: saved },
        providerRevisions: { ...settings.providerRevisions, [saved.providerId]: nextRevision } }
      await commitProviderTransaction(settings, saved.providerId, nextSettings, record.credentials, secrets, nextRevision, options.assertAuthorized)
      detectionByProvider.delete(saved.providerId)
      return snapshotInternal()
    })
  }
  async function clear(id, options = {}) {
    definition(id)
    return serialize(async () => {
      const settings = await readSettings()
      const expectedRevision = typeof options === 'number' ? options : options?.expectedRevision
      const previousRevision = assertExpectedRevision(settings, id, expectedRevision, true)
      const record = await readCredentialRecord(id)
      if (record.revision !== previousRevision) throw failure('PROVIDER_STATE_INCOMPLETE', '提供方配置版本不一致，无法安全清除。')
      const nextRevision = previousRevision + 1
      const nextSettings = { ...settings, schemaVersion: 2,
        providers: { ...settings.providers }, providerRevisions: { ...settings.providerRevisions, [id]: nextRevision } }
      delete nextSettings.providers[id]
      // Keep an encrypted empty record at the new revision. This tombstone stops
      // legacy credentials from being rediscovered after the configured file is cleared.
      await commitProviderTransaction(settings, id, nextSettings, record.credentials, {}, nextRevision)
      detectionByProvider.delete(id)
      for (const legacy of legacyHandlers(id)) {
        try { await legacy.clear?.() } catch { /* the tombstone keeps a stale legacy value unusable */ }
      }
      return snapshotInternal()
    })
  }
  async function resolve(providerId, modelId, modality) {
    return serialize(async () => {
    const settings = await readSettings()
    const view = await snapshotInternal()
    const model = view.models.find((m) => m.providerId === providerId && (m.id === modelId || m.apiModelId === modelId) && m.modelType === modality)
    if (!model?.enabled) throw failure('MODEL_UNAVAILABLE', model?.unavailableReason || '请先配置并启用该模型。')
    const p = view.providers.find((p) => p.id === providerId)
    const record = await readCredentialRecord(providerId)
    if (record.revision !== currentRevision(settings, providerId)) throw failure('PROVIDER_STATE_INCOMPLETE', '提供方配置版本不一致，已停用。')
    const secrets = record.credentials
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
    })
  }
  async function test(input) {
    return serialize(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['providerId', 'expectedRevision', 'operationId', 'baseUrl', 'enabledModelIds', 'defaultModelIds', 'modelDefaults', 'timeoutSeconds', 'credentials'].includes(key))) {
        throw failure('INVALID_INPUT', '模型配置包含未知字段。')
      }
      const settings = await readSettings()
      const providerId = input?.providerId
      const provider = definition(providerId)
      const revision = assertExpectedRevision(settings, providerId, input?.expectedRevision, true)
      const normalized = normalize(input, settings.providers[providerId])
      const record = await readCredentialRecord(providerId)
      if (record.revision !== revision) throw failure('PROVIDER_STATE_INCOMPLETE', '提供方配置版本不一致，已停用。')
      const secrets = mergeCredentials(providerId, record.credentials, input.credentials)
      validateCredentials(providerId, secrets, { requireAll: false })
      const suppliedSecret = Object.values(input.credentials || {}).some((value) => typeof value === 'string' && Boolean(value.trim()))
      try {
        const result = await probeProvider(provider, normalized, secrets)
        if (!suppliedSecret) detectionByProvider.set(providerId, { revision, status: result.status })
        return result
      } catch (error) {
        if (!suppliedSecret) detectionByProvider.set(providerId, { revision, status: 'failed' })
        throw error
      }
    })
  }
  async function testSaved(input) {
    return test({ providerId: input?.providerId, expectedRevision: input?.expectedRevision })
  }
  async function probeProvider(provider, normalized, secrets) {
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
  async function getCredentials(id) {
    return serialize(async () => {
      const settings = await readSettings()
      const record = await readCredentialRecord(id)
      if (record.revision !== currentRevision(settings, id)) throw failure('PROVIDER_STATE_INCOMPLETE', '提供方配置版本不一致，已停用。')
      return record.credentials
    })
  }
  async function loadOperationHmacKey() {
    await storageAvailable()
    await ensureCredentialsDirectory()
    let ciphertext
    try { ciphertext = await readRegularFile(operationHmacKeyFile, 'SECURE_STORAGE_UNAVAILABLE', '系统安全凭据存储不可用，无法安全记录配置操作。', { maxBytes: 4096 }) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const generated = randomBytes(32)
      let handle
      try {
        handle = await fs.open(operationHmacKeyFile, 'wx', 0o600)
        let encrypted
        if (safeStorage.encryptStringAsync) encrypted = await safeStorage.encryptStringAsync(generated.toString('base64url'))
        else encrypted = safeStorage.encryptString(generated.toString('base64url'))
        await handle.writeFile(safeStorageBytes(encrypted))
        await handle.sync()
        await handle.close(); handle = null
        await syncDirectory(credentialsDirectory)
        return generated
      } catch (createError) {
        generated.fill(0)
        if (createError.code !== 'EEXIST') throw failure('SECURE_STORAGE_UNAVAILABLE', '系统安全凭据存储不可用，无法安全记录配置操作。')
      } finally { await handle?.close().catch(() => {}) }
      return loadOperationHmacKey()
    }
    try {
      const decrypted = safeStorage.decryptStringAsync ? await safeStorage.decryptStringAsync(ciphertext) : safeStorage.decryptString(ciphertext)
      const encoded = typeof decrypted === 'string' ? decrypted : decrypted?.result
      const key = Buffer.from(encoded || '', 'base64url')
      if (key.length !== 32) throw new Error('invalid protected operation key')
      return key
    } catch { throw failure('SECURE_STORAGE_UNAVAILABLE', '系统安全凭据存储不可用，无法安全记录配置操作。') }
  }
  async function hmacProviderOperation({ providerId, expectedRevision, publicConfig = {}, credentials: suppliedCredentials = {}, credentialSource = null } = {}) {
    return serialize(async () => {
      definition(providerId)
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || !publicConfig || typeof publicConfig !== 'object' || Array.isArray(publicConfig)) {
        throw failure('PROVIDER_CONFIGURATION_INVALID', '提供方操作内容无效。')
      }
      const credentials = validateCredentials(providerId, suppliedCredentials, { requireAll: false })
      const key = await loadOperationHmacKey()
      try {
        const payload = stableJson({ providerId, expectedRevision, publicConfig, credentialSource, credentials })
        return createHmac('sha256', key).update(payload).digest('hex')
      } finally {
        key.fill(0)
        for (const field of Object.keys(credentials)) delete credentials[field]
      }
    })
  }
  return { snapshot, save, clear, resolve, test, testSaved, credentials: getCredentials,
    hmacProviderOperation, previewPublicConfiguration, prepareCredentialUpdate, snapshotProvider }
}
module.exports = { createProviderSettings, atomicWrite }
