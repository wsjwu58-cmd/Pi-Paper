const SAFE_MESSAGES = Object.freeze({
  PROVIDER_READ_FORBIDDEN: '当前桌面连接无权读取此提供方配置。',
  PROVIDER_CONFIGURE_FORBIDDEN: '当前桌面连接无权配置此提供方。',
  PROVIDER_FIELD_FORBIDDEN: '当前桌面连接无权写入所选凭据字段。',
  PROVIDER_INPUT_MODE_FORBIDDEN: '当前桌面连接未授权此凭据输入方式。',
  PROVIDER_DISCLOSURE_REQUIRED: '需要先在桌面确认此提供方的数据发送范围和费用披露。',
  PROVIDER_DISCLOSURE_DENIED: '桌面用户未授权此提供方的数据发送范围。',
  PROVIDER_DISCLOSURE_UNAVAILABLE: '桌面披露授权服务暂不可用。',
  PROVIDER_INPUT_REQUIRED: '请在桌面提供方配置页完成凭据输入。',
  CREDENTIAL_SOURCE_UNAVAILABLE: '已授权的本地凭据来源不可用。',
  CREDENTIAL_SOURCE_INVALID: '凭据来源与桌面授权不匹配。',
  IDEMPOTENCY_CONFLICT: '此操作标识已用于不同配置内容，请刷新状态后重试。',
  PROVIDER_REVISION_REQUIRED: '请刷新提供方配置版本后再提交。',
  PROVIDER_REVISION_CONFLICT: '提供方配置已变化，请刷新后重试。',
  PROVIDER_STATE_INCOMPLETE: '提供方配置正在恢复或版本不一致，暂不可用。',
  SECURE_STORAGE_UNAVAILABLE: '系统安全凭据存储不可用，未保存或检测凭据。',
  CLOUD_CREDENTIAL_MISSING: '缺少此提供方所需的凭据。',
  PROVIDER_TEST_FAILED: '官方连接检测失败。',
  PROVIDER_UNAVAILABLE: '此提供方当前不可配置。',
  INVALID_INPUT: '提供方配置请求无效。',
})

const SAFE_CODES = new Set(Object.keys(SAFE_MESSAGES).concat([
  'PROVIDER_CONFIGURATION_INVALID', 'PROVIDER_SETTINGS_INVALID', 'PROVIDER_SETTINGS_MIGRATION_FAILED',
  'PROVIDER_SAVE_FAILED', 'CLOUD_CREDENTIAL_INVALID', 'PROVIDER_ENDPOINT_INVALID',
  'PROVIDER_MODELS_INVALID', 'PROVIDER_DEFAULT_INVALID', 'NETWORK_ERROR', 'REQUEST_TIMEOUT',
]))

function failure(code, message = SAFE_MESSAGES[code] || '提供方操作失败。') {
  return Object.assign(new Error(message), { code })
}

function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key) }

function permissionAllowed(grant, permission) {
  const permissions = grant?.permissions
  return Array.isArray(permissions) ? permissions.includes(permission)
    : permissions instanceof Set ? permissions.has(permission)
      : Boolean(permissions && typeof permissions === 'object' && permissions[permission] === true)
}

function timestampMillis(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') return Date.parse(value)
  return Number.NaN
}

function providerGrantFor(grant, providerId) {
  const grants = grant?.providerGrants ?? grant?.providers
  if (Array.isArray(grants)) return grants.find((item) => item?.providerId === providerId)
  if (grants && typeof grants === 'object') {
    const entry = grants[providerId]
    if (entry === true) return { providerId, credentialFields: [], credentialInputModes: [] }
    if (entry && typeof entry === 'object') return { providerId, ...entry }
  }
  return undefined
}

function publicProvider(provider) {
  const allowed = ['id', 'name', 'providerType', 'baseUrl', 'allowedHosts', 'credentialFields', 'connectionTest',
    'configurable', 'unavailableReason', 'enabledModelIds', 'defaultModelIds', 'modelDefaults', 'timeoutSeconds',
    'revision', 'credentialRevision', 'commitState', 'configured', 'detection', 'recoveryState', 'disclosureVersion', 'consentRecordId']
  const output = {}
  for (const key of allowed) if (own(provider || {}, key)) output[key] = provider[key]
  if (Array.isArray(output.credentialFields)) {
    output.credentialFields = output.credentialFields.map((field) => {
      if (typeof field === 'string') return { name: field, secret: true }
      const safe = {}
      for (const key of ['name', 'label', 'required', 'secret', 'configured']) if (own(field || {}, key)) safe[key] = field[key]
      return safe
    })
  }
  return output
}

function publicModel(model) {
  const allowed = ['id', 'displayName', 'name', 'apiModelId', 'providerId', 'modelType', 'inputModes', 'implemented',
    'enabled', 'unavailableReason', 'defaults', 'constraints', 'toolCalling', 'streaming', 'cancellation', 'requiredCredentials']
  const output = {}
  for (const key of allowed) if (own(model || {}, key)) output[key] = model[key]
  return output
}

function safeOperationRecord(record, providerId, operationId) {
  if (!record || typeof record !== 'object') return undefined
  const normalized = normalizeLedgerRecord(record)
  const output = { providerId, operationId }
  for (const key of ['status', 'publicResult', 'errorCode', 'pendingActionId', 'updatedAt', 'createdAt']) {
    if (own(normalized, key)) output[key] = normalized[key]
  }
  if (output.publicResult && typeof output.publicResult === 'object') {
    output.publicResult = redactSecrets(output.publicResult)
  }
  return output
}

function normalizeLedgerRecord(record) {
  if (!record || typeof record !== 'object') return record
  const normalized = { ...record }
  // The desktop SQLite store names the public operation payload `result`; the
  // provider ledger contract names the same secret-free value `publicResult`.
  if (!own(normalized, 'publicResult') && own(normalized, 'result')) {
    normalized.publicResult = normalized.result
  }
  // SQLite's first durable state is `started`; the provider controller uses
  // `pending` for the same recoverable, not-yet-completed operation.
  if (normalized.status === 'started') normalized.status = 'pending'
  return normalized
}

function redactSecrets(value, depth = 0) {
  if (depth > 16) return undefined
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  const output = {}
  for (const [key, child] of Object.entries(value)) {
    if (/(?:credential|api.?key|access.?key|secret|password|token|ciphertext)/iu.test(key)) continue
    output[key] = redactSecrets(child, depth + 1)
  }
  return output
}

function normalizeError(error, fallbackCode = 'PROVIDER_SAVE_FAILED') {
  const code = SAFE_CODES.has(error?.code) ? error.code : fallbackCode
  return failure(code)
}

function validateOperationId(operationId) {
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(operationId)) {
    throw failure('INVALID_INPUT')
  }
}

function validateRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw failure('PROVIDER_REVISION_REQUIRED')
}

function validatePublicInput(publicConfig, providerId) {
  if (!publicConfig || typeof publicConfig !== 'object' || Array.isArray(publicConfig)) throw failure('INVALID_INPUT')
  const allowed = new Set(['providerId', 'baseUrl', 'enabledModelIds', 'defaultModelIds', 'modelDefaults', 'timeoutSeconds'])
  if (Object.keys(publicConfig).some((key) => !allowed.has(key))) throw failure('INVALID_INPUT')
  if (publicConfig.providerId !== undefined && publicConfig.providerId !== providerId) throw failure('INVALID_INPUT')
  return { ...publicConfig, providerId }
}

function normalizeCredentialInput(credentialInput) {
  if (credentialInput === undefined) return { source: 'preserve' }
  if (!credentialInput || typeof credentialInput !== 'object' || Array.isArray(credentialInput)
    || typeof credentialInput.source !== 'string') throw failure('INVALID_INPUT')
  const source = credentialInput.source
  if (source === 'desktop_input') {
    if (Object.keys(credentialInput).some((key) => key !== 'source')) throw failure('INVALID_INPUT')
    return { source }
  }
  if (source === 'inline') {
    if (Object.keys(credentialInput).some((key) => !['source', 'credentials', 'sourceRefs'].includes(key))
      || (credentialInput.credentials === undefined) === (credentialInput.sourceRefs === undefined)) {
      throw failure('INVALID_INPUT')
    }
    const values = credentialInput.credentials ?? credentialInput.sourceRefs
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw failure('INVALID_INPUT')
    return credentialInput.credentials !== undefined
      ? { source, credentials: credentialInput.credentials }
      : { source, sourceRefs: credentialInput.sourceRefs }
  }
  if (source === 'authorized_env') {
    if (Object.keys(credentialInput).some((key) => !['source', 'sourceRefs'].includes(key))
      || !credentialInput.sourceRefs || typeof credentialInput.sourceRefs !== 'object' || Array.isArray(credentialInput.sourceRefs)) {
      throw failure('INVALID_INPUT')
    }
    return { source, sourceRefs: credentialInput.sourceRefs }
  }
  throw failure('INVALID_INPUT')
}

function createMcpProviderController({
  providerSettings,
  authorize,
  ensureDisclosureAuthorization,
  resolveAuthorizedCredentialSource,
  resolveInlineCredentialSource,
  allowInlineCredentials = false,
  providerOperationLedger,
  requestDesktopCredentialInput,
  now = () => new Date().toISOString(),
} = {}) {
  if (!providerSettings || typeof providerSettings.snapshot !== 'function' || typeof providerSettings.save !== 'function') {
    throw new TypeError('providerSettings is required')
  }

  async function checkAuthorization({ grant, projectId, canvasId, permission, providerId, credentialFields }) {
    if (grant?.revoked === true || grant?.status === 'revoked' || grant?.revokedAt) {
      throw failure(permission === 'provider.read' ? 'PROVIDER_READ_FORBIDDEN' : 'PROVIDER_CONFIGURE_FORBIDDEN')
    }
    const issuedAt = timestampMillis(grant?.issuedAt)
    const expiry = timestampMillis(grant?.expiresAt)
    const current = timestampMillis(typeof now === 'function' ? now() : Date.now())
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiry) || !Number.isFinite(current)
      || issuedAt > current || expiry <= current || expiry <= issuedAt) {
      throw failure(permission === 'provider.read' ? 'PROVIDER_READ_FORBIDDEN' : 'PROVIDER_CONFIGURE_FORBIDDEN')
    }
    if (!permissionAllowed(grant, permission)) {
      throw failure(permission === 'provider.read' ? 'PROVIDER_READ_FORBIDDEN' : 'PROVIDER_CONFIGURE_FORBIDDEN')
    }
    if (providerId && !providerGrantFor(grant, providerId)) {
      throw failure(permission === 'provider.read' ? 'PROVIDER_READ_FORBIDDEN' : 'PROVIDER_CONFIGURE_FORBIDDEN')
    }
    if (typeof authorize !== 'function') {
      throw failure(permission === 'provider.read' ? 'PROVIDER_READ_FORBIDDEN' : 'PROVIDER_CONFIGURE_FORBIDDEN')
    }
    let result
    try { result = await authorize({ grant, projectId, canvasId, permission, providerId, credentialFields }) }
    catch { throw failure(permission === 'provider.read' ? 'PROVIDER_READ_FORBIDDEN' : 'PROVIDER_CONFIGURE_FORBIDDEN') }
    if (result?.allowed !== true) {
      throw failure(permission === 'provider.read' ? 'PROVIDER_READ_FORBIDDEN' : 'PROVIDER_CONFIGURE_FORBIDDEN')
    }
  }

  function assertCredentialScope(grant, providerId, fields) {
    const entry = providerGrantFor(grant, providerId)
    const permitted = new Set(Array.isArray(entry?.credentialFields) ? entry.credentialFields : [])
    if (fields.some((field) => !permitted.has(field))) throw failure('PROVIDER_FIELD_FORBIDDEN')
    const modes = new Set(Array.isArray(entry?.credentialInputModes) ? entry.credentialInputModes : [])
    return { entry, modes }
  }

  async function getMcpProviderState({ grant, projectId, canvasId, providerId } = {}) {
    await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.read', providerId })
    const providerGrants = grant?.providerGrants ?? grant?.providers
    let ids
    if (providerId) ids = [providerId]
    else if (Array.isArray(providerGrants)) ids = providerGrants.map((entry) => entry?.providerId).filter((id) => typeof id === 'string')
    else if (providerGrants && typeof providerGrants === 'object') ids = Object.keys(providerGrants)
    else ids = []
    if (!providerId && ids.length === 0) return { providers: [], models: [] }
    const states = []
    for (const id of [...new Set(ids)]) {
      await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.read', providerId: id })
      states.push(await loadProviderState(id))
    }
    const providers = states.map((state) => state.provider).filter(Boolean)
    const models = states.flatMap((state) => state.models)
    return providerId ? { provider: providers[0], models } : { providers, models }
  }

  async function loadProviderState(providerId) {
    let state
    try {
      state = typeof providerSettings.snapshotProvider === 'function'
        ? await providerSettings.snapshotProvider(providerId) : await providerSettings.snapshot()
    } catch (error) { throw normalizeError(error, 'PROVIDER_SETTINGS_INVALID') }
    const selected = (state?.providers || []).find((provider) => provider.id === providerId)
    return { provider: selected ? publicProvider(selected) : undefined,
      models: (state?.models || []).filter((model) => model.providerId === providerId).map(publicModel) }
  }

  async function getLedgerRecord(clientId, providerId, operationId) {
    if (!providerOperationLedger || typeof providerOperationLedger.get !== 'function') return undefined
    try {
      const result = await providerOperationLedger.get({ clientId, providerId, operationId })
      return normalizeLedgerRecord(result?.record || result)
    } catch { throw failure('PROVIDER_STATE_INCOMPLETE') }
  }

  async function completeOperation(key, status, publicResult, errorCode) {
    if (!providerOperationLedger || typeof providerOperationLedger.complete !== 'function') return
    try {
      await providerOperationLedger.complete({ ...key, status, publicResult: publicResult && redactSecrets(publicResult), errorCode })
    } catch { throw failure('PROVIDER_STATE_INCOMPLETE') }
  }

  async function beginOperation(key, payloadDigest) {
    if (!providerOperationLedger || typeof providerOperationLedger.begin !== 'function') {
      return { status: 'started', record: { status: 'pending', payloadDigest } }
    }
    let result
    try { result = await providerOperationLedger.begin({ ...key, payloadDigest }) }
    catch { throw failure('PROVIDER_STATE_INCOMPLETE') }
    if (result?.status === 'conflict') throw failure('IDEMPOTENCY_CONFLICT')
    if (!['started', 'replay'].includes(result?.status)) throw failure('PROVIDER_STATE_INCOMPLETE')
    return result?.record ? { ...result, record: normalizeLedgerRecord(result.record) } : result
  }

  async function disclosure({ grant, projectId, canvasId, providerId, operationId, publicConfig }) {
    if (typeof ensureDisclosureAuthorization !== 'function') throw failure('PROVIDER_DISCLOSURE_UNAVAILABLE')
    let result
    try { result = await ensureDisclosureAuthorization({ grant, projectId, canvasId, providerId, publicConfig, operationId }) }
    catch { throw failure('PROVIDER_DISCLOSURE_UNAVAILABLE') }
    if (result?.status === 'awaiting_disclosure') {
      return { status: 'awaiting_disclosure', providerId, operationId, pendingActionId: result.pendingActionId }
    }
    if (result?.status === 'denied' || result?.status === 'rejected') throw failure('PROVIDER_DISCLOSURE_DENIED')
    if (result?.status !== 'authorized') throw failure('PROVIDER_DISCLOSURE_UNAVAILABLE')
    return result
  }

  async function resolveCredentialInput({ input, grant, providerId, expectedRevision, publicConfig, operationId, projectId, canvasId }) {
    const normalized = normalizeCredentialInput(input)
    if (normalized.source === 'preserve') return { source: 'preserve', supplied: undefined, fields: [] }

    if (normalized.source === 'desktop_input') {
      const { entry, modes } = assertCredentialScope(grant, providerId, [])
      const writableFields = Array.isArray(entry?.credentialFields) ? [...entry.credentialFields] : []
      if (!modes.has(normalized.source) || writableFields.length === 0) throw failure('PROVIDER_INPUT_MODE_FORBIDDEN')
      return { source: 'desktop_input', supplied: undefined, fields: [], writableFields }
    }

    let fields
    if (normalized.source === 'inline') {
      fields = Object.keys(normalized.credentials ?? normalized.sourceRefs)
      if (fields.length === 0) throw failure('INVALID_INPUT')
    } else {
      fields = Object.keys(normalized.sourceRefs)
      if (fields.length === 0) throw failure('INVALID_INPUT')
    }
    const { entry, modes } = assertCredentialScope(grant, providerId, fields)
    if (!modes.has(normalized.source)) throw failure('PROVIDER_INPUT_MODE_FORBIDDEN')
    if (normalized.source === 'inline') {
      let enabled = allowInlineCredentials === true
      if (typeof allowInlineCredentials === 'function') {
        try { enabled = await allowInlineCredentials({ grant, providerId }) === true }
        catch { enabled = false }
      }
      if (!enabled) throw failure('PROVIDER_INPUT_MODE_FORBIDDEN')
    }

    // This function is called only after the trusted desktop disclosure check.
    const resolved = {}
    try {
      if (normalized.source === 'inline') {
        for (const field of fields) {
          let value
          if (normalized.credentials) {
            try { value = normalized.credentials[field] } catch { throw failure('INVALID_INPUT') }
          } else {
            const sourceRef = normalized.sourceRefs[field]
            if (typeof sourceRef !== 'string' || sourceRef.length < 1 || sourceRef.length > 256
              || typeof resolveInlineCredentialSource !== 'function') throw failure('CREDENTIAL_SOURCE_INVALID')
            let result
            try {
              result = await resolveInlineCredentialSource({ grant, providerId, fieldName: field,
                sourceRef, projectId, canvasId, operationId })
            } catch { throw failure('CREDENTIAL_SOURCE_UNAVAILABLE') }
            value = typeof result === 'string' ? result : result?.value
          }
          if (typeof value !== 'string') throw failure('INVALID_INPUT')
          if (value.trim()) resolved[field] = value
          // Remove the secret reference from the request object as soon as it
          // has crossed the authorization and disclosure boundary.
          if (normalized.credentials) {
            try { normalized.credentials[field] = '' } catch { /* frozen request objects are still never logged */ }
          }
        }
      } else {
        if (typeof resolveAuthorizedCredentialSource !== 'function') throw failure('CREDENTIAL_SOURCE_UNAVAILABLE')
        const authorizedEnv = Array.isArray(entry?.authorizedEnv) ? entry.authorizedEnv : []
        const mappings = new Map()
        for (const [field, sourceRef] of Object.entries(normalized.sourceRefs)) {
          const mapping = authorizedEnv.find((item) => item?.fieldName === field)
          if (!mapping || typeof mapping.envVariableName !== 'string' || !mapping.envVariableName) throw failure('CREDENTIAL_SOURCE_INVALID')
          if (typeof sourceRef !== 'string' || sourceRef.length < 1 || sourceRef.length > 256) throw failure('CREDENTIAL_SOURCE_INVALID')
          mappings.set(field, mapping)
        }
        for (const [field, sourceRef] of Object.entries(normalized.sourceRefs)) {
          const mapping = mappings.get(field)
          let result
          try {
            result = await resolveAuthorizedCredentialSource({ grant, providerId, fieldName: field,
              sourceRef, envVariableName: mapping.envVariableName, projectId, canvasId, operationId })
          } catch { throw failure('CREDENTIAL_SOURCE_UNAVAILABLE') }
          const value = typeof result === 'string' ? result : result?.value
          if (typeof value !== 'string' || !value.trim()) throw failure('CREDENTIAL_SOURCE_UNAVAILABLE')
          resolved[field] = value
        }
      }
      return { source: normalized.source, supplied: resolved, fields: [...fields].sort(),
        sourceRefs: normalized.source === 'authorized_env' ? { ...normalized.sourceRefs } : undefined }
    } catch (error) {
      clearPrepared(resolved)
      if (error?.code) throw error
      throw failure('INVALID_INPUT')
    }
  }

  async function configureMcpProvider(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['grant', 'projectId', 'canvasId', 'providerId', 'operationId', 'expectedRevision', 'publicConfig', 'credentialInput'].includes(key))) {
      throw failure('INVALID_INPUT')
    }
    const { grant, projectId, canvasId, providerId, operationId, expectedRevision } = input
    validateOperationId(operationId)
    validateRevision(expectedRevision)
    if (typeof providerId !== 'string') throw failure('INVALID_INPUT')
    await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId })

    const rawInput = normalizeCredentialInput(input.credentialInput)
    let fields = []
    let desktopWritableFields = []
    if (rawInput.source === 'inline') fields = Object.keys(rawInput.credentials ?? rawInput.sourceRefs)
    if (rawInput.source === 'authorized_env') fields = Object.keys(rawInput.sourceRefs)
    if (rawInput.source === 'desktop_input') {
      const scoped = assertCredentialScope(grant, providerId, [])
      desktopWritableFields = Array.isArray(scoped.entry?.credentialFields) ? [...scoped.entry.credentialFields].sort() : []
      if (!scoped.modes.has('desktop_input') || desktopWritableFields.length === 0) throw failure('PROVIDER_INPUT_MODE_FORBIDDEN')
      fields = desktopWritableFields
    } else if (fields.length) {
      assertCredentialScope(grant, providerId, fields)
    }
    if (fields.length) await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId, credentialFields: fields })

    const publicInput = validatePublicInput(input.publicConfig, providerId)
    let normalizedPublic
    try { normalizedPublic = await providerSettings.previewPublicConfiguration(publicInput) }
    catch (error) { throw normalizeError(error, 'INVALID_INPUT') }
    const publicConfig = { providerId, baseUrl: normalizedPublic.baseUrl, enabledModelIds: normalizedPublic.enabledModelIds,
      defaultModelIds: normalizedPublic.defaultModelIds, modelDefaults: normalizedPublic.modelDefaults,
      timeoutSeconds: normalizedPublic.timeoutSeconds }
    // Keep the original public patch for idempotency. A replay must hash the
    // same caller intent even when a later settings revision now exists.
    const publicIntent = { ...publicInput }

    const consent = await disclosure({ grant, projectId, canvasId, providerId, operationId, publicConfig })
    if (consent.status === 'awaiting_disclosure') return consent

    // Disclosure callbacks may wait on a desktop action. Recheck the live grant
    // before reading inline values or resolving an authorized source.
    await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId,
      credentialFields: fields.length ? fields : desktopWritableFields })
    const credential = await resolveCredentialInput({ input: input.credentialInput, grant, providerId, expectedRevision,
      publicConfig, operationId, projectId, canvasId })
    const clientId = grant?.clientId
    if (typeof clientId !== 'string' || !clientId) {
      clearPrepared(credential.supplied)
      throw failure('PROVIDER_CONFIGURE_FORBIDDEN')
    }
    const key = { clientId, providerId, operationId }

    try {
      const credentialSource = { mode: credential.source, fields: credential.fields,
        ...(credential.sourceRefs ? { sourceRefs: credential.sourceRefs } : {}) }
      let payloadDigest
      try {
        payloadDigest = await providerSettings.hmacProviderOperation({ providerId, expectedRevision,
          publicConfig: publicIntent, credentials: credential.supplied || {}, credentialSource })
      } catch (error) { throw normalizeError(error, 'SECURE_STORAGE_UNAVAILABLE') }
      const begun = await beginOperation(key, payloadDigest)
      const prior = begun.record || {}

      if (credential.source === 'desktop_input') {
        if (begun.status === 'replay' && ['awaiting_desktop_input', 'saved'].includes(prior.status)) {
          return prior.publicResult ? redactSecrets(prior.publicResult) : safeOperationRecord(prior, providerId, operationId)
        }
        if (begun.status === 'replay' && ['failed', 'denied'].includes(prior.status)) return safeOperationRecord(prior, providerId, operationId)
        if (typeof requestDesktopCredentialInput !== 'function') {
          await completeOperation(key, 'failed', undefined, 'PROVIDER_INPUT_REQUIRED')
          throw failure('PROVIDER_INPUT_REQUIRED')
        }
        await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId,
          credentialFields: desktopWritableFields })
        let pending
        try { pending = await requestDesktopCredentialInput({ grant, projectId, canvasId, providerId, operationId,
          expectedRevision, publicConfig, credentialFields: desktopWritableFields }) }
        catch {
          await completeOperation(key, 'failed', undefined, 'PROVIDER_INPUT_REQUIRED')
          throw failure('PROVIDER_INPUT_REQUIRED')
        }
        if (!pending || typeof pending.proposalId !== 'string') {
          await completeOperation(key, 'failed', undefined, 'PROVIDER_INPUT_REQUIRED')
          throw failure('PROVIDER_INPUT_REQUIRED')
        }
        const result = { status: 'awaiting_desktop_input', providerId, operationId, pendingActionId: pending.proposalId,
          publicConfig, expectedRevision, credentialFields: desktopWritableFields }
        await completeOperation(key, 'awaiting_desktop_input', result)
        return result
      }

      if (begun.status === 'replay') {
        if (prior.status === 'saved' && prior.publicResult) return redactSecrets(prior.publicResult)
        if (prior.status === 'awaiting_disclosure' || prior.status === 'awaiting_desktop_input') {
          return safeOperationRecord(prior, providerId, operationId)
        }
        if (prior.status === 'failed' || prior.status === 'denied') return safeOperationRecord(prior, providerId, operationId)
        if (!['pending', undefined].includes(prior.status)) throw failure('PROVIDER_STATE_INCOMPLETE')
        const state = await loadProviderState(providerId)
        const currentRevision = state.provider?.revision
        if (currentRevision === expectedRevision + 1 && publicPatchMatches(state.provider, publicIntent)) {
          const stored = typeof providerSettings.credentials === 'function'
            ? await providerSettings.credentials(providerId) : {}
          const supplied = credential.supplied || {}
          const credentialsMatch = Object.entries(supplied).every(([field, value]) => stored[field] === value.trim())
          if (credentialsMatch) {
            await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId,
              credentialFields: credential.fields })
            const result = { status: 'saved', providerId, operationId, revision: currentRevision,
              publicConfig: stateToPublicConfig(state.provider), provider: state.provider, models: state.models,
              disclosureVersion: consent.disclosureVersion, consentRecordId: consent.consentRecordId }
            await completeOperation(key, 'saved', result)
            return result
          }
          throw failure('IDEMPOTENCY_CONFLICT')
        }
        if (currentRevision !== expectedRevision) throw failure('PROVIDER_REVISION_CONFLICT')
      }

      if (normalizedPublic.revision !== expectedRevision) {
        await completeOperation(key, 'failed', undefined, 'PROVIDER_REVISION_CONFLICT')
        throw failure('PROVIDER_REVISION_CONFLICT')
      }
      const saveInput = { ...publicConfig, expectedRevision, operationId, credentials: credential.supplied }
      let settingsCommitted = false
      try {
        // The authorization service checks the current desktop session and
        // persisted grant. Provider settings also invokes this in-memory callback
        // after staging encrypted bytes, immediately before publishing the new
        // public revision as the transaction's commit point.
        await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId,
          credentialFields: credential.fields })
        await providerSettings.save(saveInput, { assertAuthorized: () => checkAuthorization({ grant, projectId, canvasId,
          permission: 'provider.configure', providerId, credentialFields: credential.fields }) })
        settingsCommitted = true
        const state = await loadProviderState(providerId)
        const result = { status: 'saved', providerId, operationId, revision: state.provider.revision,
          publicConfig: stateToPublicConfig(state.provider), provider: state.provider, models: state.models,
          disclosureVersion: consent.disclosureVersion, consentRecordId: consent.consentRecordId }
        await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId,
          credentialFields: credential.fields })
        await completeOperation(key, 'saved', result)
        return result
      } catch (error) {
        const safe = normalizeError(error)
        // A cross-file settings failure or a post-commit ledger failure may be
        // uncertain. Keep the operation pending so the next identical request
        // can recover from provider-settings' durable journal and current CAS.
        if (!settingsCommitted && safe.code !== 'PROVIDER_SAVE_FAILED') {
          await completeOperation(key, 'failed', undefined, safe.code).catch(() => {})
        }
        throw safe
      }
    } finally {
      clearPrepared(credential.supplied)
    }
  }

  async function probeMcpProvider({ grant, projectId, canvasId, providerId, expectedRevision } = {}) {
    if (typeof providerId !== 'string') throw failure('INVALID_INPUT')
    validateRevision(expectedRevision)
    await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId })
    try {
      const state = await loadProviderState(providerId)
      if (!state.provider || state.provider.revision !== expectedRevision) throw failure('PROVIDER_REVISION_CONFLICT')
      await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId })
      if (typeof providerSettings.testSaved !== 'function') return { providerId, revision: expectedRevision,
        status: 'unsupported', success: false, message: '当前版本不支持安全的官方鉴权检测；未发送请求。' }
      const result = await providerSettings.testSaved({ providerId, expectedRevision })
      if (result?.status === 'connected' && result.success === true) return { providerId, revision: expectedRevision,
        status: 'connected', success: true, message: '官方接受了此凭据；未发送生成请求。' }
      if (result?.status === 'unsupported') return { providerId, revision: expectedRevision,
        status: 'unsupported', success: false, message: '此提供方没有已核实的安全鉴权检测接口；未发送请求。' }
      return { providerId, revision: expectedRevision, status: 'failed', success: false,
        message: '官方连接检测未成功；未发送生成请求。' }
    } catch (error) { throw normalizeError(error, 'PROVIDER_TEST_FAILED') }
  }

  async function getMcpProviderOperation({ grant, projectId, canvasId, providerId, operationId } = {}) {
    validateOperationId(operationId)
    if (typeof providerId !== 'string') throw failure('INVALID_INPUT')
    await checkAuthorization({ grant, projectId, canvasId, permission: 'provider.configure', providerId })
    const clientId = grant?.clientId
    if (typeof clientId !== 'string' || !clientId) throw failure('PROVIDER_CONFIGURE_FORBIDDEN')
    const record = await getLedgerRecord(clientId, providerId, operationId)
    return safeOperationRecord(record, providerId, operationId) || { providerId, operationId, status: 'not_found' }
  }

  return { getMcpProviderState, configureMcpProvider, probeMcpProvider, getMcpProviderOperation }
}

function clearPrepared(value) {
  if (!value || typeof value !== 'object') return
  for (const key of Object.keys(value)) delete value[key]
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function publicPatchMatches(provider, patch) {
  if (!provider) return false
  for (const [key, expected] of Object.entries(patch)) {
    if (key === 'providerId') continue
    let actual = provider[key]
    let normalizedExpected = expected
    if (key === 'baseUrl' && typeof expected === 'string') {
      try { normalizedExpected = new URL(expected.trim()).toString().replace(/\/$/u, '') } catch { return false }
      if (typeof actual === 'string') actual = actual.replace(/\/$/u, '')
    }
    if (key === 'enabledModelIds' && Array.isArray(expected)) {
      normalizedExpected = [...new Set(expected)].sort()
      actual = [...(actual || [])].sort()
    }
    if (stableJson(actual) !== stableJson(normalizedExpected)) return false
  }
  return true
}

function stateToPublicConfig(provider) {
  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    enabledModelIds: provider.enabledModelIds || [],
    defaultModelIds: provider.defaultModelIds || {},
    modelDefaults: provider.modelDefaults || {},
    timeoutSeconds: provider.timeoutSeconds,
  }
}

module.exports = { createMcpProviderController }
