const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto')
const { createMcpControlStore } = require('./mcp-control-store.cjs')
const { createMcpProviderController } = require('./mcp-provider-controller.cjs')

const INSTANCE_SCHEMA_VERSION = 1
const PROTOCOL_VERSION = 1
const MAX_BODY_BYTES = 512 * 1024
const MAX_TASK_OUTPUT_PAGE_CHARACTERS = 5000
const MAX_MCP_IMAGE_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_MCP_VIDEO_OUTPUT_BYTES = 8 * 1024 * 1024
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const ACTION_TTL_MS = 10 * 60 * 1000
const DISCLOSURE_VERSION = 'desktop-mcp-provider-disclosure-v1'
const PERMISSIONS = new Set([
  'canvas.read', 'canvas.write', 'generation.propose', 'task.read', 'media.read', 'provider.read', 'provider.configure',
])
const INPUT_MODES = new Set(['authorized_env', 'desktop_input', 'inline'])
const CREDENTIAL_FIELD = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u
const TOOL_PERMISSION = new Map([
  ['get_canvas_summary', 'canvas.read'], ['get_selected_nodes', 'canvas.read'], ['get_node_detail', 'canvas.read'],
  ['list_models', 'canvas.read'], ['search_assets', 'canvas.read'],
  ['create_nodes', 'canvas.write'], ['update_node_config', 'canvas.write'], ['connect_nodes', 'canvas.write'], ['layout_nodes', 'canvas.write'],
  ['prepare_generation', 'generation.propose'], ['check_task_status', 'task.read'], ['read_task_output', 'task.read'],
  ['get_context', null], ['get_operation', null],
  ['list_provider_configuration', 'provider.read'], ['configure_provider', 'provider.configure'],
  ['test_provider_connection', 'provider.configure'], ['get_provider_operation', 'provider.configure'],
])

function createMcpMainService(options) {
  const {
    userDataDirectory, ipcMain, dialog, getMainWindow, assertTrustedSender,
    getActiveContext, getWorker, getProviderSettings, getModelDirectory,
    loadCanvas, getLocalCore, getProviderRevisions,
  } = options
  if (!userDataDirectory || !ipcMain || !dialog || typeof getActiveContext !== 'function') {
    throw new Error('MCP_MAIN_CONFIGURATION_INVALID')
  }
  const store = createMcpControlStore(userDataDirectory)
  const instanceId = randomUUID()
  const instanceFile = path.join(userDataDirectory, 'mcp-instance.json')
  const sessions = new Map()
  const pendingBootstrap = new Map()
  const activeCommands = new Map()
  const flushRequests = new Map()
  const requestCounts = new Map()
  const requestRate = new Map()
  const sessionRate = new Map()
  let server = null
  let port = 0
  let canvasReady = null
  let stopped = false
  let lastProjectId = null

  const now = () => Date.now()
  const event = (payload) => {
    const window = getMainWindow?.()
    if (!window || window.isDestroyed?.() || window.webContents?.isDestroyed?.()) return false
    try { window.webContents.send('desktop:mcp:event', payload); return true } catch { return false }
  }
  function notifyProviderConfigurationChanged(providerId, revision) {
    if (typeof providerId !== 'string' || !Number.isSafeInteger(revision) || revision < 0) return false
    return event({ type: 'provider.configuration.changed', providerId, revision })
  }
  const stateChanged = async () => event({ type: 'state.changed', state: await getState().catch(() => undefined) })
  const fixedError = (code, status = 400) => Object.assign(new Error(code), { code, status })

  function activeSessionsForClient(clientId) {
    return [...sessions.values()].filter((session) => session.clientId === clientId)
  }

  function clearSession(session) {
    if (!session) return
    sessions.delete(session.tokenHash)
    for (const command of activeCommands.values()) {
      if (command.connectionId === session.connectionId) command.revoked = true
    }
    for (const source of session.credentialSources) source.envVariableName = ''
  }

  function clearAllSessions() {
    for (const current of sessions.values()) clearSession(current)
    sessions.clear()
    activeCommands.clear()
  }

  function revokeCanvasCommands() {
    for (const command of activeCommands.values()) {
      if (command.permission !== 'provider.read' && command.permission !== 'provider.configure') command.revoked = true
    }
  }

  async function currentContext() {
    if (stopped) return null
    let current
    try { current = await getActiveContext() } catch { return null }
    if (!current || typeof current.projectId !== 'string' || typeof current.canvasId !== 'string'
      || !Number.isSafeInteger(current.version) || current.version < 0) return null
    if (lastProjectId !== null && lastProjectId !== current.projectId) {
      clearAllSessions()
      canvasReady = null
      store.revokeProject(lastProjectId)
      lastProjectId = current.projectId
      void stateChanged()
    } else if (lastProjectId === null) lastProjectId = current.projectId
    return current
  }

  async function isCanvasReady(context) {
    const current = context ?? await currentContext()
    return Boolean(current && canvasReady?.ready === true && canvasReady.projectId === current.projectId
      && canvasReady.canvasId === current.canvasId)
  }

  function getClientFromGrant(clientId, grantId) {
    const client = store.getClient(clientId)
    if (!client || client.grantId !== grantId || client.revokedAt !== null || client.expiresAt <= now()) return null
    return client
  }

  function assertClientScope(client, context, { requireReady = true } = {}) {
    if (!store.isEnabled()) throw fixedError('MCP_DISABLED', 503)
    if (!client || !context || client.projectId !== context.projectId || client.canvasId !== context.canvasId) {
      throw fixedError('PROJECT_CHANGED', 403)
    }
    if (requireReady && !canvasReady?.ready) throw fixedError('CANVAS_NOT_READY', 503)
    if (requireReady && (canvasReady.projectId !== context.projectId || canvasReady.canvasId !== context.canvasId)) {
      throw fixedError('PROJECT_CHANGED', 403)
    }
    return client
  }

  async function liveClient(clientId, grantId, { requireReady = true } = {}) {
    const context = await currentContext()
    const client = getClientFromGrant(clientId, grantId)
    return assertClientScope(client, context, { requireReady })
  }

  function publicClient(client, connected = activeSessionsForClient(client.clientId).length > 0) {
    return {
      clientId: client.clientId,
      clientName: client.clientName,
      displayName: client.displayName,
      permissions: [...client.permissions],
      projectId: client.projectId,
      canvasId: client.canvasId,
      providerGrants: client.providerGrants.map((grant) => ({
        providerId: grant.providerId,
        credentialFields: [...grant.credentialFields],
        credentialInputModes: [...grant.credentialInputModes],
        authorizedEnv: grant.authorizedEnv.map(({ fieldName, envVariableName }) => ({ fieldName, envVariableName })),
      })),
      mediaTypes: [...client.mediaTypes],
      disclosureVersion: client.disclosureVersion,
      createdAt: new Date(client.issuedAt).toISOString(),
      expiresAt: new Date(client.expiresAt).toISOString(),
      revokedAt: client.revokedAt ? new Date(client.revokedAt).toISOString() : null,
      connected,
    }
  }

  async function providerDescriptors() {
    const settings = getProviderSettings?.()
    if (!settings) return []
    const snapshot = await settings.snapshot()
    return (snapshot.providers || []).map((provider) => ({
      providerId: provider.id,
      name: provider.name || provider.displayName || provider.id,
      credentialFields: (provider.credentialFields || []).map((field) => typeof field === 'string'
        ? { name: field, configured: false }
        : { name: field.name, label: field.label || field.name, configured: field.configured === true }),
      modalities: [...new Set((snapshot.models || []).filter((model) => model.providerId === provider.id).map((model) => model.modelType))],
      revision: provider.revision,
      enabledModelNames: (snapshot.models || []).filter((model) => model.providerId === provider.id && model.enabled)
        .map((model) => model.name || model.id),
      disclosureVersion: DISCLOSURE_VERSION,
    }))
  }

  async function providerDisclosureScope(providerId, publicConfig) {
    const settings = getProviderSettings?.()
    if (!settings || typeof settings.snapshot !== 'function') throw fixedError('PROVIDER_UNAVAILABLE', 503)
    const snapshot = await settings.snapshot()
    const provider = (snapshot.providers || []).find((item) => item.id === providerId)
    if (!provider) throw fixedError('PROVIDER_NOT_FOUND', 404)
    let endpoint = publicConfig?.baseUrl || provider.baseUrl
    if (typeof endpoint !== 'string' || !endpoint) throw fixedError('PROVIDER_ENDPOINT_INVALID')
    let officialHost
    try {
      const parsed = new URL(endpoint)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid endpoint')
      const host = parsed.hostname.toLowerCase()
      if (Array.isArray(provider.allowedHosts) && provider.allowedHosts.length
        && !provider.allowedHosts.some((entry) => String(entry).toLowerCase() === host)) throw new Error('host not allowed')
      officialHost = host
    } catch { throw fixedError('PROVIDER_ENDPOINT_INVALID') }
    const configuredIds = Array.isArray(publicConfig?.enabledModelIds)
      ? publicConfig.enabledModelIds
      : Array.isArray(provider.enabledModelIds) ? provider.enabledModelIds : []
    const selectedIds = new Set(configuredIds)
    const modalities = [...new Set((snapshot.models || [])
      .filter((model) => model.providerId === providerId
        && (selectedIds.size === 0 ? model.enabled === true : selectedIds.has(model.id) || selectedIds.has(model.name)))
      .map((model) => model.modelType)
      .filter((value) => ['text', 'image', 'video', 'audio'].includes(value)))].sort()
    return { scope: { providerId, officialHost, modalities, disclosureVersion: DISCLOSURE_VERSION }, provider }
  }

  async function getState() {
    const context = await currentContext()
    const ready = await isCanvasReady(context)
    const enabled = store.isEnabled()
    return {
      enabled,
      status: !enabled ? 'disabled' : ready ? 'ready' : 'desktop_unavailable',
      canvasReady: ready,
      connectionDisclosureVersion: DISCLOSURE_VERSION,
      ...(context ? { activeCanvas: { projectId: context.projectId, canvasId: context.canvasId,
        ...(typeof context.name === 'string' ? { name: context.name } : {}), version: context.version } } : {}),
      clients: store.listClients().map((client) => publicClient(client)),
      providers: await providerDescriptors(),
    }
  }

  function safeConfig(client) {
    const nodeEntry = process.defaultApp === false && typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, 'app', 'src', 'mcp-node-entry.cjs')
      : path.join(__dirname, 'mcp-node-entry.cjs')
    const authorizedEnvNames = new Map()
    for (const provider of client.providerGrants) {
      for (const mapping of provider.authorizedEnv) {
        const name = mapping.envVariableName
        const normalized = name.toLowerCase()
        if (!authorizedEnvNames.has(normalized)) authorizedEnvNames.set(normalized, name)
      }
    }
    const args = [
      nodeEntry,
      '--mcp-stdio', '--mcp-instance-file', instanceFile,
      '--mcp-client-id', client.clientId, '--mcp-grant-id', client.grantId,
      ...[...authorizedEnvNames.values()]
        .flatMap((envVariableName) => ['--mcp-env-name', envVariableName]),
    ]
    const codex = [
      '[mcp_servers.vibepaper]',
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify(args)}`,
      'startup_timeout_sec = 150',
      '',
      '[mcp_servers.vibepaper.env]',
      'ELECTRON_RUN_AS_NODE = "1"',
      '',
    ].join('\n')
    const claudeCode = JSON.stringify({ mcpServers: { vibepaper: {
      command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: '1' },
    } } }, null, 2)
    return { codex, claudeCode }
  }

  function validateGrantInput(input, context, descriptors) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['clientName', 'displayName', 'permissions', 'providerGrants', 'mediaTypes', 'disclosureVersion', 'accepted'].includes(key))) {
      throw fixedError('INVALID_INPUT')
    }
    if (!['codex', 'claude-code', 'other'].includes(input.clientName) || input.accepted !== true
      || input.disclosureVersion !== DISCLOSURE_VERSION
      || !Array.isArray(input.permissions) || input.permissions.length < 1 || input.permissions.some((value) => !PERMISSIONS.has(value))
      || new Set(input.permissions).size !== input.permissions.length
      || !Array.isArray(input.providerGrants) || !Array.isArray(input.mediaTypes)
      || input.mediaTypes.some((value) => !['image', 'video', 'audio', 'text'].includes(value))
      || new Set(input.mediaTypes).size !== input.mediaTypes.length
      || (input.displayName !== undefined && (typeof input.displayName !== 'string' || input.displayName.length > 120))) {
      throw fixedError('INVALID_INPUT')
    }
    const descriptorById = new Map(descriptors.map((provider) => [provider.providerId, provider]))
    const providers = []
    const seen = new Set()
    for (const entry of input.providerGrants) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some((key) => !['providerId', 'credentialFields', 'credentialInputModes', 'authorizedEnv'].includes(key))
        || typeof entry.providerId !== 'string' || seen.has(entry.providerId)
        || !Array.isArray(entry.credentialFields) || !Array.isArray(entry.credentialInputModes) || !Array.isArray(entry.authorizedEnv)) {
        throw fixedError('INVALID_INPUT')
      }
      const descriptor = descriptorById.get(entry.providerId)
      if (!descriptor) throw fixedError('PROVIDER_NOT_FOUND')
      const allowedFields = new Set(descriptor.credentialFields.map((field) => field.name))
      if (entry.credentialFields.some((field) => typeof field !== 'string' || !CREDENTIAL_FIELD.test(field) || !allowedFields.has(field))
        || new Set(entry.credentialFields).size !== entry.credentialFields.length
        || entry.credentialInputModes.some((mode) => !INPUT_MODES.has(mode))
        || new Set(entry.credentialInputModes).size !== entry.credentialInputModes.length) throw fixedError('INVALID_INPUT')
      if (entry.credentialFields.length && !input.permissions.includes('provider.configure')) throw fixedError('PERMISSION_DENIED')
      if (entry.credentialInputModes.includes('authorized_env') && entry.authorizedEnv.length !== entry.credentialFields.length) throw fixedError('INVALID_INPUT')
      if (!entry.credentialInputModes.includes('authorized_env') && entry.authorizedEnv.length !== 0) throw fixedError('INVALID_INPUT')
      const envNames = new Set()
      const authorizedEnv = entry.authorizedEnv.map((mapping) => {
        if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)
          || Object.keys(mapping).some((key) => !['fieldName', 'envVariableName'].includes(key))
          || !entry.credentialFields.includes(mapping.fieldName)
          || typeof mapping.envVariableName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(mapping.envVariableName)
          || envNames.has(mapping.envVariableName)) throw fixedError('INVALID_INPUT')
        envNames.add(mapping.envVariableName)
        return { fieldName: mapping.fieldName, envVariableName: mapping.envVariableName }
      })
      seen.add(entry.providerId)
      providers.push({ providerId: entry.providerId, credentialFields: [...entry.credentialFields],
        credentialInputModes: [...entry.credentialInputModes], authorizedEnv })
    }
    if (providers.length && !input.permissions.some((permission) => permission === 'provider.configure' || permission === 'provider.read')) {
      throw fixedError('PERMISSION_DENIED')
    }
    return {
      clientName: input.clientName,
      displayName: (input.displayName?.trim() || input.clientName).slice(0, 120),
      permissions: [...input.permissions], providerGrants: providers, mediaTypes: [...input.mediaTypes],
      disclosureVersion: input.disclosureVersion, accepted: true,
      projectId: context.projectId, canvasId: context.canvasId,
      inlineCredentials: providers.some((provider) => provider.credentialInputModes.includes('inline')),
    }
  }

  function assertLivePermission(grant, permission, providerId, credentialFields) {
    const live = getClientFromGrant(grant?.clientId, grant?.grantId)
    if (!live || live.projectId !== grant.projectId || live.canvasId !== grant.canvasId) return { allowed: false }
    const contextPromise = currentContext()
    return contextPromise.then(async (context) => {
      const requireReady = permission !== 'provider.read' && permission !== 'provider.configure'
      if (!context || !store.isEnabled() || (requireReady && !await isCanvasReady(context))
        || context.projectId !== live.projectId || context.canvasId !== live.canvasId) return { allowed: false }
      if (permission && !live.permissions.includes(permission)) return { allowed: false }
      if (providerId) {
        const providerGrant = live.providerGrants.find((entry) => entry.providerId === providerId)
        if (!providerGrant) return { allowed: false }
        if (credentialFields?.some((field) => !providerGrant.credentialFields.includes(field))) return { allowed: false }
      }
      return { allowed: true }
    })
  }

  async function createProviderController(session, credentialValues, requestControl) {
    const live = await liveClient(session.clientId, session.grantId, { requireReady: false })
    const ledger = {
      begin: async (input) => store.beginOperation({
        operationId: input.operationId, clientId: input.clientId, grantId: live.grantId,
        projectId: live.projectId, canvasId: live.canvasId,
        kind: `provider:${input.providerId}:configure`, payloadDigest: input.payloadDigest,
      }),
      get: async (input) => {
        const record = store.getOperation({ operationId: input.operationId, clientId: input.clientId, grantId: live.grantId })
        if (!record) return undefined
        return { ...record, status: record.status === 'started' ? 'pending' : record.status,
          ...(record.result ? { publicResult: record.result } : {}) }
      },
      complete: async (input) => store.completeOperation({
        operationId: input.operationId, clientId: input.clientId, grantId: live.grantId,
        status: input.status, result: input.publicResult, errorCode: input.errorCode,
      }),
    }
    const sourceValues = credentialValues && typeof credentialValues === 'object' && !Array.isArray(credentialValues)
      ? credentialValues : {}
    const sourceResolver = async ({ grant, providerId, fieldName, sourceRef, envVariableName }) => {
      const source = session.credentialSources.find((entry) => entry.sourceRef === sourceRef
        && entry.providerId === providerId && entry.fieldName === fieldName
        && entry.envVariableName === envVariableName && entry.expiresAt > now())
      if (!source || !Object.hasOwn(sourceValues, sourceRef)) {
        throw fixedError('CREDENTIAL_SOURCE_UNAVAILABLE')
      }
      const value = sourceValues[sourceRef]
      sourceValues[sourceRef] = ''
      if (typeof value !== 'string' || value.length > 16_384) throw fixedError('CREDENTIAL_SOURCE_UNAVAILABLE')
      return { value }
    }
    const inlineSourceResolver = async ({ grant, providerId, fieldName, sourceRef }) => {
      if (requestControl?.cancelled || !/^inline-[A-Za-z0-9_-]{8,128}$/u.test(sourceRef)
        || !Object.hasOwn(sourceValues, sourceRef)) throw fixedError('CREDENTIAL_SOURCE_UNAVAILABLE')
      const current = getClientFromGrant(grant?.clientId, grant?.grantId)
      const scope = current?.providerGrants.find((entry) => entry.providerId === providerId)
      if (!current?.inlineCredentials || !scope?.credentialInputModes.includes('inline')
        || !scope.credentialFields.includes(fieldName)) throw fixedError('CREDENTIAL_SOURCE_UNAVAILABLE')
      const value = sourceValues[sourceRef]
      sourceValues[sourceRef] = ''
      if (typeof value !== 'string' || value.length > 16_384) throw fixedError('CREDENTIAL_SOURCE_UNAVAILABLE')
      return { value }
    }
    const requestDesktopCredentialInput = async (input) => {
      await liveClient(live.clientId, live.grantId, { requireReady: false })
      const proposalId = randomUUID()
      const action = store.createAction({
        proposalId, kind: 'provider_input', clientId: live.clientId, grantId: live.grantId,
        projectId: live.projectId, canvasId: live.canvasId, status: 'awaiting_desktop_input',
        providerOperationId: input.operationId,
        expiresAt: Math.min(live.expiresAt, now() + 15 * 60 * 1000),
        payload: { providerId: input.providerId, operationId: input.operationId,
          publicConfig: input.publicConfig, expectedRevision: input.expectedRevision,
          credentialFields: input.credentialFields },
      })
      const window = getMainWindow?.()
      if (!window || window.isDestroyed?.() || window.webContents?.isDestroyed?.()) throw fixedError('DESKTOP_INPUT_UNAVAILABLE', 503)
      window.webContents.send('desktop:mcp:provider-input', {
        proposalId, providerId: input.providerId, operationId: input.operationId,
        projectId: live.projectId, canvasId: live.canvasId,
        publicConfig: input.publicConfig, expectedRevision: input.expectedRevision,
        credentialFields: input.credentialFields,
      })
      const publicAction = toPublicAction(action, live)
      event({ type: 'pending-action.created', action: publicAction })
      return { proposalId }
    }
    const ensureDisclosureAuthorization = async (input) => {
      await liveClient(live.clientId, live.grantId, { requireReady: false })
      const disclosure = await providerDisclosureScope(input.providerId, input.publicConfig)
      const digest = sha256(stableJson(disclosure.scope))
      const prior = store.listActions({ clientId: live.clientId, projectId: live.projectId, canvasId: live.canvasId })
        .find((action) => action.kind === 'provider_disclosure'
          && action.payload?.providerId === input.providerId
          && action.payload?.disclosureScopeDigest === digest)
      if (prior?.status === 'authorized' && prior.expiresAt > now()) {
        return { status: 'authorized', disclosureVersion: DISCLOSURE_VERSION, consentRecordId: prior.proposalId }
      }
      if (prior?.status === 'rejected' || prior?.status === 'invalidated') {
        return { status: 'denied' }
      }
      if (prior?.status === 'awaiting_disclosure') return { status: 'awaiting_disclosure', pendingActionId: prior.proposalId }
      const proposalId = randomUUID()
      const action = store.createAction({
        proposalId, kind: 'provider_disclosure', clientId: live.clientId, grantId: live.grantId,
        projectId: live.projectId, canvasId: live.canvasId, status: 'awaiting_disclosure',
        providerOperationId: input.operationId,
        expiresAt: Math.min(live.expiresAt, now() + ACTION_TTL_MS),
        payload: { providerId: input.providerId, disclosureScopeDigest: digest,
          providerConfig: { ...input.publicConfig, officialHost: disclosure.scope.officialHost,
            modalities: disclosure.scope.modalities,
            dataTypes: disclosure.scope.modalities.map((modality) => ({
              text: '提示词和模型参数', image: '提示词、图像输入与参考素材',
              video: '提示词、视频参数与选定参考素材', audio: '提示词与音频输入',
            }[modality])), estimatedCost: '费用由该提供方按其规则收取。' } },
      })
      event({ type: 'pending-action.created', action: toPublicAction(action, live) })
      return { status: 'awaiting_disclosure', pendingActionId: proposalId }
    }
    return createMcpProviderController({
      providerSettings: getProviderSettings(),
      authorize: async ({ grant, projectId, canvasId, permission, providerId, credentialFields }) => requestControl?.cancelled
        ? { allowed: false } : assertLivePermission(grant, permission, providerId, credentialFields, projectId, canvasId),
      ensureDisclosureAuthorization,
      resolveAuthorizedCredentialSource: sourceResolver,
      resolveInlineCredentialSource: inlineSourceResolver,
      allowInlineCredentials: async ({ grant, providerId }) => {
        const current = getClientFromGrant(grant?.clientId, grant?.grantId)
        return Boolean(current?.inlineCredentials
          && current.providerGrants.some((entry) => entry.providerId === providerId && entry.credentialInputModes.includes('inline')))
      },
      providerOperationLedger: ledger,
      requestDesktopCredentialInput,
    })
  }

  function toPublicAction(action, client) {
    const payload = action.payload || {}
    const providerConfig = payload.providerConfig ? {
      providerId: payload.providerConfig.providerId,
      baseUrl: payload.providerConfig.baseUrl,
      enabledModelIds: payload.providerConfig.enabledModelIds,
      defaultModelIds: payload.providerConfig.defaultModelIds,
      modelDefaults: payload.providerConfig.modelDefaults,
      timeoutSeconds: payload.providerConfig.timeoutSeconds,
      officialHost: payload.providerConfig.officialHost,
      modalities: payload.providerConfig.modalities,
      dataTypes: payload.providerConfig.dataTypes,
      estimatedCost: payload.providerConfig.estimatedCost,
      expectedRevision: payload.providerConfig.expectedRevision,
    } : undefined
    return {
      proposalId: action.proposalId, kind: action.kind,
      ...(client ? { clientId: client.clientId, clientName: client.clientName, displayName: client.displayName } : {}),
      status: action.status, projectId: action.projectId, canvasId: action.canvasId,
      createdAt: new Date(action.createdAt).toISOString(), expiresAt: new Date(action.expiresAt).toISOString(),
      ...(action.kind === 'pairing' ? { shortCode: payload.shortCode } : {}),
      ...(payload.providerId ? { providerId: payload.providerId } : {}),
      ...(providerConfig ? { providerConfig } : {}),
      ...(Array.isArray(payload.payload) ? { payload: payload.payload } : {}),
      ...(typeof payload.target === 'string' ? { target: payload.target } : {}),
      ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
      ...(typeof payload.input === 'string' ? { input: payload.input } : {}),
      ...(typeof payload.impact === 'string' ? { impact: payload.impact } : {}),
    }
  }

  async function listActions() {
    const context = await currentContext()
    const localActions = store.listActions(context ? { projectId: context.projectId, canvasId: context.canvasId } : {})
      .filter((action) => action.expiresAt > now() || ['authorized', 'rejected', 'paired'].includes(action.status))
      .map((action) => toPublicAction(action, action.clientId ? store.getClient(action.clientId) : null))
    const worker = getWorker?.()
    let projectActions = []
    if (context && worker && agentProjectMatches(worker, context.projectId)) {
      const eligible = store.listClients().filter((client) => client.projectId === context.projectId
        && client.canvasId === context.canvasId && client.revokedAt === null && client.expiresAt > now()
        && client.permissions.includes('generation.propose'))
      const results = await Promise.allSettled(eligible.map((client) => worker.request('mcp:actions:list', {
        clientId: client.clientId, grantId: client.grantId,
        projectId: context.projectId, canvasId: context.canvasId,
      })))
      projectActions = results.flatMap((result, index) => result.status === 'fulfilled' && Array.isArray(result.value)
        ? result.value.map((action) => ({ ...action,
          clientId: eligible[index].clientId, grantId: eligible[index].grantId,
          clientName: eligible[index].clientName, displayName: eligible[index].displayName,
        })) : [])
    }
    const merged = [...localActions, ...(Array.isArray(projectActions) ? projectActions : [])]
    return { actions: merged.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) }
  }

  function agentProjectMatches(worker, projectId) {
    return typeof projectId === 'string' && getWorker?.() === worker
  }

  async function listMcpTools(session) {
    const client = await liveClient(session.clientId, session.grantId, { requireReady: false })
    const context = await currentContext()
    const worker = getWorker?.()
    if (!worker || !agentProjectMatches(worker, context?.projectId)) throw fixedError('AGENT_UNAVAILABLE', 503)
    const all = await worker.request('mcp:tools:list', {
      clientId: client.clientId, grantId: client.grantId, projectId: client.projectId,
      canvasId: client.canvasId, canvasVersion: context.version,
      permission: [...client.permissions], providerGrants: client.providerGrants,
    })
    if (!Array.isArray(all)) throw fixedError('MCP_TOOL_CATALOG_UNAVAILABLE', 503)
    return { tools: all.filter((tool) => {
      const permission = TOOL_PERMISSION.get(tool.name)
      return permission === null || (permission !== undefined && client.permissions.includes(permission))
    }) }
  }

  function requiredPermission(name) {
    const permission = TOOL_PERMISSION.get(name)
    if (permission === undefined) throw fixedError('MCP_TOOL_UNAVAILABLE', 404)
    return permission
  }

  async function assertCommandPermission(command, method, input) {
    const live = await liveClient(command.clientId, command.grantId)
    if (command.revoked || command.expiresAt <= now() || command.projectId !== live.projectId
      || command.canvasId !== live.canvasId) throw fixedError('PERMISSION_DENIED', 403)
    const methodPermission = ['agent:core:create-node', 'agent:core:update-node', 'agent:core:delete-nodes',
      'agent:core:connect-edge', 'agent:core:save-canvas', 'agent:core:create-generation-task'].includes(method)
      ? (method === 'agent:core:create-generation-task' ? 'generation.propose' : 'canvas.write')
      : method === 'agent:core:get-task' ? 'task.read'
        : method === 'agent:core:list-models' ? 'canvas.read'
          : null
    if (methodPermission && !live.permissions.includes(methodPermission)) {
      // Generation preparation reads model/canvas state under the generation scope.
      if (!(methodPermission === 'canvas.read' && live.permissions.includes('generation.propose'))
        && !(methodPermission === 'task.read' && live.permissions.includes('generation.propose'))) throw fixedError('PERMISSION_DENIED', 403)
    }
    if (method === 'agent:core:create-generation-task') {
      const snapshots = command.providerRevisions || {}
      const expected = snapshots[input?.providerId]
      const current = await getProviderRevisions?.()
      if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(current?.[input?.providerId])
        || expected !== current[input.providerId]) throw fixedError('PROVIDER_REVISION_CONFLICT', 409)
    }
    return live
  }

  async function authorizeAgentCoreRequest(commandId, method, input) {
    if (typeof commandId !== 'string') throw fixedError('PERMISSION_DENIED', 403)
    const command = activeCommands.get(commandId)
    if (!command) throw fixedError('PERMISSION_DENIED', 403)
    validateCoreMethodForCommand(command, method)
    await assertCommandPermission(command, method, input)
    if (!input || input.projectId !== command.projectId
      || (input.canvasId !== undefined && input.canvasId !== command.canvasId)) throw fixedError('PROJECT_CHANGED', 403)
    return true
  }

  async function flushRendererCanvas(context, requestId) {
    const window = getMainWindow?.()
    if (!window || window.isDestroyed?.() || window.webContents?.isDestroyed?.()) throw fixedError('CANVAS_NOT_READY', 503)
    if (!await isCanvasReady(context)) throw fixedError('CANVAS_NOT_READY', 503)
    const request = { requestId, projectId: context.projectId, canvasId: context.canvasId, expectedVersion: context.version }
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        flushRequests.delete(requestId)
        reject(fixedError('CANVAS_FLUSH_TIMEOUT', 409))
      }, 15_000)
      flushRequests.set(requestId, { request, timer, resolve, reject })
      try { window.webContents.send('desktop:mcp:canvas-flush', request) }
      catch {
        clearTimeout(timer)
        flushRequests.delete(requestId)
        reject(fixedError('CANVAS_FLUSH_FAILED', 409))
      }
    })
    if (result.status !== 'flushed' || !Number.isSafeInteger(result.persistedVersion)) throw fixedError('CANVAS_FLUSH_FAILED', 409)
    const latest = await getActiveContext()
    const canvas = await loadCanvas?.(context.projectId, context.canvasId)
    const version = canvas?.version ?? latest?.version
    if (!latest || latest.projectId !== context.projectId || latest.canvasId !== context.canvasId
      || version !== result.persistedVersion) throw fixedError('CANVAS_VERSION_CONFLICT', 409)
    return { ...latest, version, requestId }
  }

  function safeOutput(value, permissions = [], depth = 0, key = '', parentKey = '') {
    if (depth > 20) return '[已省略]'
    const safeCredentialMetadata = new Set([
      'credentialSources', 'credentialInputModes', 'allowedCredentialFields', 'sourceRef', 'sourceKind',
    ])
    if (!safeCredentialMetadata.has(key)
      && /(?:api.?key|secret|password|authorization|access.?token|approval.?token|credentials?|private.?key)/iu.test(key)) return undefined
    if (Array.isArray(value)) return value.slice(0, 500).map((item) => safeOutput(item, permissions, depth + 1, key, parentKey)).filter((item) => item !== undefined)
    if (value && typeof value === 'object') {
      const result = {}
      for (const [childKey, child] of Object.entries(value)) {
        if (/^(?:path|outputPath|filePath|absolutePath|localPath|base64|data)$/iu.test(childKey)) continue
        if (/^(?:sourceUrl|remoteUrl|outputUrl|signedUrl|downloadUrl|referenceUrls|referenceImages)$/iu.test(childKey)) continue
        if (childKey === 'url' && !/^(?:prompt|input|text|query|description)$/iu.test(key)
          && /^https?:\/\//iu.test(String(child))) continue
        const sanitized = safeOutput(child, permissions, depth + 1, childKey, key)
        if (sanitized !== undefined) result[childKey] = sanitized
      }
      return result
    }
    if (typeof value === 'string') {
      if (/^data:(?:image|video|audio)\//iu.test(value) || /(?:[?&](?:signature|sig|token|credential)=)/iu.test(value)) return '[媒体地址已省略]'
      return value.slice(0, 20_000)
    }
    if (value === null || ['boolean', 'number'].includes(typeof value)) return value
    return undefined
  }

  function publicToolResult(result, permissions = []) {
    const structuredContent = safeOutput(result?.structuredContent ?? {}, permissions) || {}
    const content = [{ type: 'text', text: typeof structuredContent === 'string' ? structuredContent : JSON.stringify(structuredContent).slice(0, 20_000) }]
    return { content, structuredContent, ...(result?.isError === true ? { isError: true } : {}) }
  }

  async function getOperation(session, params) {
    assertOperationArguments(params)
    if (typeof params.proposalId === 'string') {
      const worker = getWorker?.()
      if (!worker) throw fixedError('AGENT_UNAVAILABLE', 503)
      const result = await worker.request('mcp:proposal:get', { projectId: session.projectId,
        clientId: session.clientId, grantId: session.grantId, canvasId: session.canvasId,
        proposalId: params.proposalId })
      return publicToolResult({ structuredContent: result || { status: 'not_found' } }, session.permissions)
    }
    const worker = getWorker?.()
    if (!worker) throw fixedError('AGENT_UNAVAILABLE', 503)
    const result = await worker.request('mcp:operation:get', { projectId: session.projectId,
      clientId: session.clientId, grantId: session.grantId, canvasId: session.canvasId,
      operationId: params.operationId })
    return publicToolResult({ structuredContent: result || { status: 'not_found' } }, session.permissions)
  }

  async function readTaskOutput(client, args, requestControl) {
    const taskId = args.taskId
    const outputIndex = args.outputIndex ?? 0
    const mode = args.mode ?? 'metadata'
    if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)
    const core = getLocalCore?.()
    if (!core) throw fixedError('LOCAL_CORE_UNAVAILABLE', 503)
    const task = await core.request('task:get', { projectId: client.projectId, taskId })
    if (!task || task.taskId !== taskId || (task.projectId !== undefined && task.projectId !== client.projectId)
      || task.canvasId !== client.canvasId || task.status !== 'succeeded') throw fixedError('TASK_NOT_FOUND', 404)
    if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)

    if (task.modality === 'text') {
      if (outputIndex !== 0) throw fixedError('TASK_OUTPUT_NOT_FOUND', 404)
      const output = await core.request('task:read-output', { projectId: client.projectId, taskId: task.taskId })
      if (typeof output !== 'string') throw fixedError('TASK_OUTPUT_UNAVAILABLE', 422)
      if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)
      const characters = Array.from(output)
      const offset = args.offset ?? 0
      const limit = args.limit ?? MAX_TASK_OUTPUT_PAGE_CHARACTERS
      const page = characters.slice(offset, offset + limit).join('')
      const nextOffset = offset + Array.from(page).length
      const structuredContent = {
        taskId: task.taskId,
        status: task.status,
        modality: 'text',
        outputIndex,
        output: page,
        offset,
        nextOffset,
        totalCharacters: characters.length,
        hasMore: nextOffset < characters.length,
      }
      return { content: [{ type: 'text', text: page }], structuredContent }
    }

    const output = Array.isArray(task.outputs)
      ? task.outputs.find((entry) => entry && entry.index === outputIndex)
      : undefined
    const legacyOutput = outputIndex === 0 && !output && typeof task.outputPath === 'string'
      ? { index: 0, sizeBytes: task.outputSizeBytes, outputMeta: task.outputMeta }
      : undefined
    const taskOutput = output || legacyOutput
    if (!taskOutput) throw fixedError('TASK_OUTPUT_NOT_FOUND', 404)
    const outputType = taskOutput.outputMeta?.outputType || task.outputMeta?.outputType
      || (task.modality === 'compose' ? 'video' : task.modality)
    if (!['image', 'video'].includes(outputType)) throw fixedError('UNSUPPORTED', 422)
    if (!client.permissions.includes('media.read') || !client.mediaTypes.includes(outputType)) {
      throw fixedError('PERMISSION_DENIED', 403)
    }
    if ((args.offset !== undefined && args.offset !== 0)
      || (args.limit !== undefined && args.limit !== MAX_TASK_OUTPUT_PAGE_CHARACTERS)) throw fixedError('INVALID_INPUT')

    if (mode === 'metadata') {
      const structuredContent = {
        taskId: task.taskId,
        status: task.status,
        modality: outputType,
        outputIndex,
        mode,
        ...(Number.isSafeInteger(taskOutput.sizeBytes) && taskOutput.sizeBytes > 0
          ? { sizeBytes: taskOutput.sizeBytes } : {}),
      }
      return { content: [{ type: 'text', text: '媒体结果元数据；传入 mode="preview" 可在授权范围和大小上限内读取预览。' }], structuredContent }
    }

    const maxBytes = outputType === 'image' ? MAX_MCP_IMAGE_OUTPUT_BYTES : MAX_MCP_VIDEO_OUTPUT_BYTES
    let mediaResult
    let bytes
    try {
      if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)
      try {
        mediaResult = await core.request('task:read-output-media', {
          projectId: client.projectId, taskId: task.taskId, outputIndex,
        }, 15_000)
      } catch (error) {
        const code = ['OUTPUT_TOO_LARGE', 'OUTPUT_MIME_MISMATCH', 'PROJECT_CHANGED', 'TASK_NOT_FOUND',
          'TASK_OUTPUT_NOT_FOUND', 'INVALID_INPUT', 'UNSUPPORTED'].includes(error?.code)
          ? error.code : 'TASK_OUTPUT_UNAVAILABLE'
        throw fixedError(code, code === 'OUTPUT_TOO_LARGE' ? 413 : code === 'PROJECT_CHANGED' ? 403 : 422)
      }
      if (Buffer.isBuffer(mediaResult?.bytes)) bytes = mediaResult.bytes
      else if (mediaResult?.bytes instanceof Uint8Array) {
        bytes = Buffer.from(mediaResult.bytes.buffer, mediaResult.bytes.byteOffset, mediaResult.bytes.byteLength)
      }
      const mimeType = mediaResult?.mimeType
      const mimeAllowed = outputType === 'image'
        ? ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
        : ['video/mp4', 'video/quicktime', 'video/webm'].includes(mimeType)
      if (!bytes || bytes.length < 1 || bytes.length > maxBytes || mediaResult.sizeBytes !== bytes.length
        || mediaResult.outputIndex !== outputIndex || mediaResult.modality !== outputType || !mimeAllowed) {
        throw fixedError('TASK_OUTPUT_UNAVAILABLE', 422)
      }
      if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)
      const latestClient = await liveClient(client.clientId, client.grantId)
      if (!latestClient.permissions.includes('media.read') || !latestClient.mediaTypes.includes(outputType)) {
        throw fixedError('PERMISSION_DENIED', 403)
      }
      if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)
      const encoded = bytes.toString('base64')
      bytes.fill(0)
      bytes = null
      if (mediaResult.bytes instanceof Uint8Array) mediaResult.bytes.fill(0)
      const metadata = { taskId: task.taskId, status: task.status, modality: outputType,
        outputIndex, mode: 'preview', mimeType, sizeBytes: mediaResult.sizeBytes }
      if (outputType === 'image') {
        return { content: [{ type: 'image', data: encoded, mimeType }], structuredContent: metadata }
      }
      return {
        content: [{ type: 'resource', resource: {
          uri: `vibepaper://task-output/${task.taskId}/${outputIndex}`,
          mimeType,
          blob: encoded,
        } }],
        structuredContent: metadata,
      }
    } finally {
      bytes?.fill(0)
      if (mediaResult?.bytes instanceof Uint8Array) mediaResult.bytes.fill(0)
    }
  }

  function assertMainToolArguments(name, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fixedError('INVALID_INPUT')
    const keys = Object.keys(args)
    const allow = (permitted, required = []) => {
      if (keys.some((key) => !permitted.includes(key)) || required.some((key) => !Object.hasOwn(args, key))) {
        throw fixedError('INVALID_INPUT')
      }
    }
    const requireString = (field, max = 128) => {
      if (typeof args[field] !== 'string' || args[field].length < 1 || args[field].length > max) throw fixedError('INVALID_INPUT')
    }
    switch (name) {
      case 'get_context':
        allow([])
        return
      case 'get_operation':
        assertOperationArguments(args)
        return
      case 'read_task_output':
        allow(['taskId', 'outputIndex', 'mode', 'offset', 'limit'], ['taskId'])
        requireString('taskId')
        if (args.outputIndex !== undefined && (!Number.isSafeInteger(args.outputIndex) || args.outputIndex < 0 || args.outputIndex > 3)) {
          throw fixedError('INVALID_INPUT')
        }
        if (args.mode !== undefined && !['metadata', 'preview'].includes(args.mode)) throw fixedError('INVALID_INPUT')
        if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 1_000_000)) {
          throw fixedError('INVALID_INPUT')
        }
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1
          || args.limit > MAX_TASK_OUTPUT_PAGE_CHARACTERS)) throw fixedError('INVALID_INPUT')
        return
      case 'list_provider_configuration':
        allow(['providerId'], ['providerId']); requireString('providerId', 80); return
      case 'test_provider_connection':
        allow(['providerId', 'expectedRevision'], ['providerId', 'expectedRevision']); requireString('providerId', 80)
        if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) throw fixedError('INVALID_INPUT')
        return
      case 'get_provider_operation':
        allow(['providerId', 'operationId'], ['providerId', 'operationId']); requireString('providerId', 80); requireString('operationId'); return
      case 'configure_provider': {
        allow(['providerId', 'expectedRevision', 'operationId', 'publicConfig', 'credentialInput'],
          ['providerId', 'expectedRevision', 'operationId'])
        requireString('providerId', 80); requireString('operationId')
        if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0
          || (args.publicConfig !== undefined && (!args.publicConfig || typeof args.publicConfig !== 'object' || Array.isArray(args.publicConfig)))) throw fixedError('INVALID_INPUT')
        const credential = args.credentialInput
        if (credential !== undefined) {
          if (!credential || typeof credential !== 'object' || Array.isArray(credential)) throw fixedError('INVALID_INPUT')
          if (credential.source === 'inline') {
            if (Object.keys(credential).some((key) => !['source', 'sourceRefs'].includes(key))
              || !credential.sourceRefs || typeof credential.sourceRefs !== 'object' || Array.isArray(credential.sourceRefs)
              || Object.keys(credential.sourceRefs).length === 0 || Object.keys(credential.sourceRefs).length > 16
              || Object.values(credential.sourceRefs).some((value) => typeof value !== 'string' || value.length > 256)) throw fixedError('INVALID_INPUT')
          } else if (credential.source === 'authorized_env') {
            if (Object.keys(credential).some((key) => !['source', 'sourceRefs'].includes(key))
              || !credential.sourceRefs || typeof credential.sourceRefs !== 'object' || Array.isArray(credential.sourceRefs)) throw fixedError('INVALID_INPUT')
          } else if (credential.source !== 'desktop_input' || Object.keys(credential).some((key) => key !== 'source')) {
            throw fixedError('INVALID_INPUT')
          }
        }
        return
      }
      default:
        return
    }
  }

  function assertOperationArguments(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some((key) => !['operationId', 'proposalId'].includes(key))) throw fixedError('INVALID_INPUT')
    const hasOperation = typeof args.operationId === 'string' && args.operationId.length > 0 && args.operationId.length <= 128
    const hasProposal = typeof args.proposalId === 'string' && args.proposalId.length > 0 && args.proposalId.length <= 128
    if (hasOperation === hasProposal) throw fixedError('INVALID_INPUT')
  }

  async function executeTool(session, params, credentialValues, requestControl) {
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).some((key) => !['name', 'arguments'].includes(key))
      || typeof params.name !== 'string' || params.name.length > 80
      || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) throw fixedError('INVALID_INPUT')
    const name = params.name
    const permission = requiredPermission(name)
    const providerFlow = ['list_provider_configuration', 'configure_provider', 'test_provider_connection',
      'get_provider_operation', 'get_operation'].includes(name)
    const client = await liveClient(session.clientId, session.grantId, { requireReady: !providerFlow })
    if (permission && !client.permissions.includes(permission)) throw fixedError('PERMISSION_DENIED', 403)
    assertMainToolArguments(name, params.arguments)
    if (name === 'get_context') {
      const context = await currentContext()
      if (!context || context.projectId !== client.projectId || context.canvasId !== client.canvasId) throw fixedError('PROJECT_CHANGED', 403)
      return { content: [{ type: 'text', text: JSON.stringify({ projectId: context.projectId, canvasId: context.canvasId,
        name: context.name, version: context.version, canvasReady: await isCanvasReady(context) }) }],
      structuredContent: { projectId: context.projectId, canvasId: context.canvasId, ...(context.name ? { name: context.name } : {}), version: context.version, canvasReady: await isCanvasReady(context) } }
    }
    if (name === 'get_operation') return getOperation(session, params.arguments)

    if (name === 'list_provider_configuration' || name === 'configure_provider'
      || name === 'test_provider_connection' || name === 'get_provider_operation') {
      const providerId = params.arguments.providerId
      if (typeof providerId !== 'string' || providerId.length > 80) throw fixedError('INVALID_INPUT')
      const controller = await createProviderController(session, credentialValues, requestControl)
      const scoped = { grant: client, projectId: client.projectId, canvasId: client.canvasId, providerId }
      let result
      if (name === 'list_provider_configuration') result = await controller.getMcpProviderState(scoped)
      else if (name === 'configure_provider') result = await controller.configureMcpProvider({
        ...scoped, operationId: params.arguments.operationId,
        expectedRevision: params.arguments.expectedRevision, publicConfig: params.arguments.publicConfig || {},
        credentialInput: params.arguments.credentialInput,
      })
      else if (name === 'test_provider_connection') result = await controller.probeMcpProvider({
        ...scoped, expectedRevision: params.arguments.expectedRevision,
      })
      else result = await controller.getMcpProviderOperation({ ...scoped, operationId: params.arguments.operationId })
      if (name === 'list_provider_configuration') {
        const providerGrant = client.providerGrants.find((entry) => entry.providerId === providerId)
        const canConfigure = client.permissions.includes('provider.configure') && Boolean(providerGrant)
        const allowedCredentialFields = canConfigure ? [...providerGrant.credentialFields] : []
        const credentialInputModes = canConfigure ? [...providerGrant.credentialInputModes] : []
        const allowedFields = new Set(allowedCredentialFields)
        const credentialSources = canConfigure && credentialInputModes.includes('authorized_env')
          ? session.credentialSources.filter((source) => source.providerId === providerId
            && allowedFields.has(source.fieldName) && source.expiresAt > now())
            .map((source) => ({ sourceRef: source.sourceRef, providerId: source.providerId,
              fieldName: source.fieldName, sourceKind: 'authorized_env',
              envVariableName: source.envVariableName, expiresAt: source.expiresAt }))
          : []
        result = { ...result, credentialInputModes, allowedCredentialFields, credentialSources }
      }
      if (name === 'configure_provider' && result?.status === 'saved') {
        notifyProviderConfigurationChanged(providerId, result.revision)
      } else if (name === 'test_provider_connection') {
        notifyProviderConfigurationChanged(providerId, result?.revision)
      }
      return publicToolResult({ structuredContent: result }, client.permissions)
    }

    if (name === 'read_task_output') {
      if (!client.permissions.includes('task.read')) throw fixedError('PERMISSION_DENIED', 403)
      return readTaskOutput(client, params.arguments, requestControl)
    }

    const context = await currentContext()
    if (!context || context.projectId !== client.projectId || context.canvasId !== client.canvasId) throw fixedError('PROJECT_CHANGED', 403)
    const worker = getWorker?.()
    if (!worker || !agentProjectMatches(worker, client.projectId)) throw fixedError('AGENT_UNAVAILABLE', 503)
    const write = ['create_nodes', 'update_node_config', 'connect_nodes', 'layout_nodes', 'prepare_generation'].includes(name)
    const writeRequestId = write ? randomUUID() : null
    let priorOperation = null
    if (write && typeof params.arguments.operationId === 'string') {
      priorOperation = await worker.request('mcp:operation:get', {
        clientId: client.clientId, grantId: client.grantId,
        projectId: client.projectId, canvasId: client.canvasId,
        operationId: params.arguments.operationId,
      })
    }
    let commandContext = context
    let writeSettled = false
    const commandId = randomUUID()
    const command = { commandId, connectionId: session.connectionId, clientId: client.clientId,
      grantId: client.grantId, projectId: client.projectId, canvasId: client.canvasId,
      permission, expiresAt: now() + 5 * 60_000, revoked: false }
    activeCommands.set(commandId, command)
    if (requestControl) requestControl.commandId = commandId
    try {
      if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)
      if (write) {
        commandContext = await flushRendererCanvas(context, writeRequestId)
        if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)
        // Let the project ledger verify an exact retry before Main applies the
        // current canvas CAS. Runtime returns durable results without replaying
        // a committed side effect and rejects mismatched payloads by digest.
        if (!priorOperation && params.arguments.expectedVersion !== commandContext.version) {
          throw fixedError('CANVAS_VERSION_CONFLICT', 409)
        }
      }
      await assertCommandPermission(command, 'agent:core:load-canvas')
      if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)
      const providerSnapshot = await getProviderSettings()?.snapshot?.()
      const revisions = Object.fromEntries((providerSnapshot?.providers || []).map((provider) => [provider.id, provider.revision || 0]))
      const authoritativeRevisions = await getProviderRevisions?.()
      if (authoritativeRevisions) Object.assign(revisions, authoritativeRevisions)
      command.providerRevisions = revisions
      const workerResult = await worker.request('mcp:tool:execute', {
        toolName: name,
        arguments: params.arguments,
        clientId: client.clientId,
        grantId: client.grantId,
        projectId: client.projectId,
        canvasId: client.canvasId,
        canvasVersion: commandContext.version,
        mcpCommandId: commandId,
        providerRevisions: revisions,
      }, 300_000)
      if (workerResult?.proposal) {
        const proposal = workerResult.proposal
        const payload = (proposal.confirmationItems || []).map((item) => ({
          target: item.target || item.nodeLabel || '目标节点',
          model: item.model || item.modelName || '所选模型',
          input: item.input || item.prompt || '',
          impact: item.impact || (item.overwrite ? '将覆盖现有输出' : '创建新输出'),
        }))
        const display = payload.length === 1 ? payload[0] : undefined
        event({ type: 'pending-action.created', action: {
          proposalId: proposal.proposalId, kind: 'generation', clientId: client.clientId,
          clientName: client.clientName, displayName: client.displayName, status: 'awaiting_confirmation',
          projectId: client.projectId, canvasId: client.canvasId,
          expiresAt: new Date(proposal.action?.binding?.expiresAt || now() + ACTION_TTL_MS).toISOString(),
          ...(display || {}), payload,
        } })
        const latest = await loadCanvas?.(client.projectId, client.canvasId)
        event({ type: 'canvas.write-settled', requestId: writeRequestId, projectId: client.projectId,
          canvasId: client.canvasId, status: 'committed', version: latest?.version ?? commandContext.version })
        writeSettled = true
        return publicToolResult({ structuredContent: workerResult.structuredContent }, client.permissions)
      }
        const safe = publicToolResult(workerResult, client.permissions)
      if (write) {
        const canvas = await loadCanvas?.(client.projectId, client.canvasId)
        if (canvas) {
          event({ type: 'canvas.changed', projectId: client.projectId, canvasId: client.canvasId,
            version: canvas.version, operationId: params.arguments.operationId, source: 'external_mcp' })
          event({ type: 'canvas.write-settled', requestId: writeRequestId, projectId: client.projectId,
            canvasId: client.canvasId, status: 'committed', version: canvas.version })
          writeSettled = true
        } else event({ type: 'canvas.write-settled', requestId: writeRequestId, projectId: client.projectId,
          canvasId: client.canvasId, status: 'aborted', errorCode: 'CANVAS_UNAVAILABLE' })
        if (!writeSettled) writeSettled = true
      }
      return safe
    } catch (error) {
      if (writeRequestId && !writeSettled) {
        event({ type: 'canvas.write-settled', requestId: writeRequestId,
          projectId: client.projectId, canvasId: client.canvasId, status: 'aborted', errorCode: safeErrorCode(error) })
        writeSettled = true
      }
      throw error
    } finally {
      activeCommands.delete(commandId)
      if (requestControl?.commandId === commandId) requestControl.commandId = null
      if (credentialValues && typeof credentialValues === 'object') {
        for (const key of Object.keys(credentialValues)) credentialValues[key] = ''
      }
    }
  }

  async function listToolDefinitions(session) {
    const { tools } = await listMcpTools(session)
    return tools
  }

  async function rpc(session, body, requestControl) {
    const credentialValues = body?.credentialValues
    try { return await rpcBody(session, body, requestControl) }
    finally {
      if (credentialValues && typeof credentialValues === 'object' && !Array.isArray(credentialValues)) {
        for (const key of Object.keys(credentialValues)) {
          try { credentialValues[key] = '' } catch { /* request bodies are normally mutable JSON objects */ }
        }
      }
    }
  }

  async function rpcBody(session, body, requestControl) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['method', 'params', 'credentialValues'].includes(key))
      || !['tools/list', 'tools/call'].includes(body.method)) throw fixedError('INVALID_INPUT')
    if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) throw fixedError('INVALID_INPUT')
    const providerCall = body.method === 'tools/call'
      && ['list_provider_configuration', 'configure_provider', 'test_provider_connection', 'get_provider_operation']
        .includes(body.params?.name)
    const client = await liveClient(session.clientId, session.grantId, { requireReady: !providerCall })
    if (body.method === 'tools/list') {
      if (Object.keys(body).some((key) => key !== 'method' && key !== 'params')
        || Object.keys(body.params).length !== 0) throw fixedError('INVALID_INPUT')
      return { tools: await listToolDefinitions(session) }
    }
    if (body.credentialValues !== undefined && (!body.credentialValues || typeof body.credentialValues !== 'object'
      || Array.isArray(body.credentialValues) || Object.keys(body.credentialValues).length > 16
      || Object.keys(body.credentialValues).some((key) => key.length > 256))) {
      throw fixedError('INVALID_INPUT')
    }
    if (Object.keys(body.params).some((key) => !['name', 'arguments'].includes(key))
      || typeof body.params.name !== 'string' || body.params.name.length > 80
      || !body.params.arguments || typeof body.params.arguments !== 'object' || Array.isArray(body.params.arguments)) throw fixedError('INVALID_INPUT')
    requiredPermission(body.params.name)
    const credentialValues = body.credentialValues || {}
    const toolArguments = body.params.arguments
    const credentialInput = toolArguments.credentialInput
    const sourceValues = Object.keys(credentialValues)
    if (body.params.name !== 'configure_provider' && (sourceValues.length || credentialInput !== undefined)) throw fixedError('CREDENTIAL_SOURCE_INVALID', 403)
    if (credentialInput !== undefined && (typeof credentialInput !== 'object' || !credentialInput || Array.isArray(credentialInput))) throw fixedError('INVALID_INPUT')
    let forwarded = body.params
    if (body.params.name === 'configure_provider' && credentialInput?.source === 'inline') {
      if (Object.keys(credentialInput).some((key) => !['source', 'sourceRefs'].includes(key))
        || !credentialInput.sourceRefs || typeof credentialInput.sourceRefs !== 'object' || Array.isArray(credentialInput.sourceRefs)) throw fixedError('INVALID_INPUT')
      const scope = client.providerGrants.find((entry) => entry.providerId === toolArguments.providerId)
      if (!client.permissions.includes('provider.configure') || !scope?.credentialInputModes.includes('inline')) throw fixedError('PERMISSION_DENIED', 403)
      const references = new Set()
      const preflightOnly = Object.keys(credentialValues).length === 0
      for (const [field, sourceRef] of Object.entries(credentialInput.sourceRefs)) {
        if (!scope.credentialFields.includes(field) || typeof sourceRef !== 'string' || references.has(sourceRef)
          || !/^inline-[A-Za-z0-9_-]{8,128}$/u.test(sourceRef)
          || (!preflightOnly && !Object.hasOwn(credentialValues, sourceRef))) throw fixedError('CREDENTIAL_SOURCE_INVALID', 403)
        references.add(sourceRef)
      }
      // The stdio bridge first sends a secret-free request so Main can obtain
      // provider disclosure before any secret value is read. If disclosure is
      // already authorized, the controller's source resolver sees no value and
      // returns CREDENTIAL_SOURCE_UNAVAILABLE, which tells the bridge it may
      // now collect and resend the secret in the dedicated credentialValues
      // channel. Partial maps are never accepted.
      if (!preflightOnly && references.size !== Object.keys(credentialValues).length) throw fixedError('CREDENTIAL_SOURCE_INVALID', 403)
    } else if (body.params.name === 'configure_provider' && credentialInput?.source === 'authorized_env') {
      if (Object.keys(credentialInput).some((key) => !['source', 'sourceRefs'].includes(key))
        || !credentialInput.sourceRefs || typeof credentialInput.sourceRefs !== 'object' || Array.isArray(credentialInput.sourceRefs)) throw fixedError('INVALID_INPUT')
      const scope = client.providerGrants.find((entry) => entry.providerId === toolArguments.providerId)
      if (!client.permissions.includes('provider.configure') || !scope?.credentialInputModes.includes('authorized_env')) throw fixedError('PERMISSION_DENIED', 403)
      const refs = new Set()
      for (const [field, sourceRef] of Object.entries(credentialInput.sourceRefs)) {
        const source = session.credentialSources.find((entry) => entry.sourceRef === sourceRef
          && entry.providerId === toolArguments.providerId && entry.fieldName === field && entry.expiresAt > now())
        if (!scope.authorizedEnv.some((mapping) => mapping.fieldName === field)
          || !source || !Object.hasOwn(credentialValues, sourceRef)) {
          throw fixedError('CREDENTIAL_SOURCE_INVALID', 403)
        }
        refs.add(sourceRef)
      }
      if (refs.size !== sourceValues.length || sourceValues.some((sourceRef) => !refs.has(sourceRef))) throw fixedError('CREDENTIAL_SOURCE_INVALID', 403)
    } else if (sourceValues.length || (credentialInput !== undefined && credentialInput.source !== 'desktop_input')) {
      throw fixedError('CREDENTIAL_SOURCE_INVALID', 403)
    }
    return await executeTool(session, forwarded, credentialValues, requestControl)
  }

  async function beginBootstrap(body, requestControl) {
    if (requestControl?.cancelled) throw fixedError('REQUEST_CANCELLED', 499)
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['clientId', 'grantId', 'clientInfo', 'shortCode'].includes(key))
      || typeof body.clientId !== 'string' || typeof body.grantId !== 'string'
      || !body.clientInfo || typeof body.clientInfo !== 'object' || Array.isArray(body.clientInfo)
      || Object.keys(body.clientInfo).some((key) => !['name', 'version'].includes(key))
      || typeof body.clientInfo.name !== 'string' || body.clientInfo.name.length < 1 || body.clientInfo.name.length > 80
      || typeof body.clientInfo.version !== 'string' || body.clientInfo.version.length > 80
      || typeof body.shortCode !== 'string' || !/^\d{6}$/u.test(body.shortCode)) throw fixedError('INVALID_INPUT')
    if (pendingBootstrap.size >= 5) throw fixedError('PAIRING_BUSY', 429)
    const client = getClientFromGrant(body.clientId, body.grantId)
    const context = await currentContext()
    assertClientScope(client, context)
    if (!store.isEnabled()) throw fixedError('MCP_DISABLED', 503)
    const challengeId = randomUUID()
    const proposalId = randomUUID()
    const expiresAt = now() + 120_000
    const action = store.createAction({ proposalId, kind: 'pairing', clientId: client.clientId,
      grantId: client.grantId, projectId: client.projectId, canvasId: client.canvasId,
      status: 'awaiting_pairing', expiresAt,
      payload: { shortCode: body.shortCode, clientInfo: { name: body.clientInfo.name, version: body.clientInfo.version } } })
    const pending = { challengeId, proposalId, clientId: client.clientId, grantId: client.grantId,
      projectId: client.projectId, canvasId: client.canvasId, shortCode: body.shortCode,
      clientInfo: { name: body.clientInfo.name, version: body.clientInfo.version }, expiresAt,
      requestControl, cancelled: false }
    pendingBootstrap.set(challengeId, pending)
    if (requestControl) requestControl.bootstrapId = challengeId
    pending.timer = setTimeout(() => {
      if (pendingBootstrap.get(challengeId) !== pending) return
      pendingBootstrap.delete(challengeId)
      pending.cancelled = true
      if (requestControl?.bootstrapId === challengeId) requestControl.bootstrapId = null
      store.updateAction(proposalId, { status: 'expired' })
      event({ type: 'pending-action.updated', action: toPublicAction(store.getAction(proposalId), client) })
    }, 120_000)
    pending.timer.unref?.()
    event({ type: 'pending-action.created', action: toPublicAction(action, client) })
    const result = await dialog.showMessageBox(getMainWindow?.() || undefined, {
      type: 'question', title: '批准本地 MCP 连接',
      message: `${client.displayName} 正在请求连接此画布。`,
      detail: `请核对外部终端显示的 6 位短码：${body.shortCode}\n授权范围：${client.permissions.join('、')}\n项目与画布仅限当前桌面授权。`,
      buttons: ['批准本次连接', '拒绝'], defaultId: 1, cancelId: 1, noLink: true,
    })
    const stillPending = pendingBootstrap.get(challengeId)
    clearTimeout(pending.timer)
    if (!stillPending || pending.cancelled || requestControl?.cancelled) {
      throw fixedError('REQUEST_CANCELLED', 499)
    }
    if (stillPending.expiresAt <= now() || result.response !== 0) {
      pendingBootstrap.delete(challengeId)
      pending.cancelled = true
      if (requestControl?.bootstrapId === challengeId) requestControl.bootstrapId = null
      store.updateAction(proposalId, { status: result.response === 0 ? 'expired' : 'rejected' })
      event({ type: 'pending-action.updated', action: toPublicAction(store.getAction(proposalId), client) })
      throw fixedError('CONNECTION_NOT_APPROVED', 403)
    }
    await liveClient(client.clientId, client.grantId)
    if (requestControl?.cancelled || pendingBootstrap.get(challengeId) !== pending || pending.cancelled) {
      throw fixedError('REQUEST_CANCELLED', 499)
    }
    const token = randomBytes(32).toString('base64url')
    const tokenHash = sha256(token)
    const connectionId = randomUUID()
    const credentialSources = client.providerGrants.flatMap((providerGrant) =>
      providerGrant.credentialInputModes.includes('authorized_env')
        ? providerGrant.authorizedEnv.map(({ fieldName, envVariableName }) => ({ sourceRef: randomUUID(),
          providerId: providerGrant.providerId, fieldName, envVariableName, expiresAt: Math.min(client.expiresAt, now() + SESSION_TTL_MS) }))
        : [])
    const session = { tokenHash, connectionId, clientId: client.clientId, grantId: client.grantId,
      projectId: client.projectId, canvasId: client.canvasId, permissions: [...client.permissions],
      expiresAt: Math.min(client.expiresAt, now() + SESSION_TTL_MS), credentialSources }
    sessions.set(tokenHash, session)
    if (requestControl) requestControl.session = session
    pendingBootstrap.delete(challengeId)
    if (requestControl?.bootstrapId === challengeId) requestControl.bootstrapId = null
    store.updateAction(proposalId, { status: 'paired' })
    event({ type: 'pending-action.updated', action: toPublicAction(store.getAction(proposalId), client) })
    void stateChanged()
    return { instanceId, connectionId, accessToken: token, expiresAt: session.expiresAt, credentialSources }
  }

  async function readBody(req) {
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw fixedError('CONTENT_TYPE_INVALID', 415)
    const length = Number(req.headers['content-length'])
    if (req.headers['content-length'] !== undefined && (!Number.isSafeInteger(length) || length < 0)) throw fixedError('CONTENT_LENGTH_INVALID', 400)
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw fixedError('BODY_TOO_LARGE', 413)
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw fixedError('BODY_TOO_LARGE', 413)
      chunks.push(chunk)
    }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fixedError('JSON_INVALID') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fixedError('INVALID_INPUT')
    return value
  }

  function sendJson(res, status, body) {
    if (res.destroyed || res.writableEnded) return
    const bytes = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' })
    res.end(bytes)
  }

  function invalidatePendingBootstrap(pending) {
    if (!pending || pendingBootstrap.get(pending.challengeId) !== pending) return
    pendingBootstrap.delete(pending.challengeId)
    pending.cancelled = true
    clearTimeout(pending.timer)
    if (pending.requestControl?.bootstrapId === pending.challengeId) pending.requestControl.bootstrapId = null
    const action = store.getAction(pending.proposalId)
    if (action?.status === 'awaiting_pairing') {
      const updated = store.updateAction(pending.proposalId, { status: 'invalidated' })
      const client = store.getClient(pending.clientId)
      event({ type: 'pending-action.updated', action: toPublicAction(updated, client) })
    }
  }

  function sessionFromRequest(req) {
    const authorization = req.headers.authorization
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw fixedError('UNAUTHORIZED', 401)
    const token = authorization.slice(7)
    if (token.length < 32 || token.length > 256) throw fixedError('UNAUTHORIZED', 401)
    const tokenHash = sha256(token)
    const session = sessions.get(tokenHash)
    if (!session || session.expiresAt <= now()) {
      clearSession(session)
      throw fixedError('UNAUTHORIZED', 401)
    }
    const supplied = Buffer.from(tokenHash)
    const expected = Buffer.from(session.tokenHash)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fixedError('UNAUTHORIZED', 401)
    return session
  }

  function isLoopbackRequest(req) {
    const address = req.socket.remoteAddress
    return address === '127.0.0.1' || address === '::ffff:127.0.0.1'
  }

  async function handleRequest(req, res) {
    if (!isLoopbackRequest(req) || req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) {
      sendJson(res, 403, { error: { code: 'REQUEST_FORBIDDEN', message: 'Request is not allowed.' } }); return
    }
    if (req.method !== 'POST' || !['/bootstrap', '/rpc', '/close'].includes(req.url)) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }); return
    }
    const address = req.socket.remoteAddress || 'unknown'
    if (!consumeRate(requestRate, address, req.url === '/bootstrap' ? 8 : 120, 60_000)) {
      sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Request rate limit reached.' } }); return
    }
    if (requestCounts.size && totalRequests() >= 32) {
      sendJson(res, 429, { error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests are active.' } }); return
    }
    let session = null
    if (req.url !== '/bootstrap') {
      try { session = sessionFromRequest(req) }
      catch (error) {
        sendJson(res, Number.isInteger(error?.status) ? error.status : 401,
          { error: { code: safeErrorCode(error), message: publicErrorMessage(safeErrorCode(error)) } }); return
      }
      if (!consumeRate(sessionRate, session.connectionId, 60, 60_000)) {
        sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Request rate limit reached.' } }); return
      }
    }
    const requestId = randomUUID()
    requestCounts.set(requestId, true)
    const requestControl = { cancelled: false, commandId: null }
    const cancelRequest = () => {
      if (requestControl.cancelled) return
      requestControl.cancelled = true
      const pending = requestControl.bootstrapId && pendingBootstrap.get(requestControl.bootstrapId)
      if (pending) invalidatePendingBootstrap(pending)
      if (requestControl.session) {
        clearSession(requestControl.session)
        requestControl.session = null
      }
      const command = requestControl.commandId && activeCommands.get(requestControl.commandId)
      if (command) command.revoked = true
    }
    req.once('aborted', cancelRequest)
    res.once('close', () => { if (!res.writableFinished) cancelRequest() })
    try {
      const body = await readBody(req)
      if (req.url === '/bootstrap') {
        const result = await beginBootstrap(body, requestControl)
        if (requestControl.cancelled || res.destroyed) {
          if (requestControl.session) clearSession(requestControl.session)
          requestControl.session = null
          throw fixedError('REQUEST_CANCELLED', 499)
        }
        sendJson(res, 200, result)
        requestControl.session = null
        return
      }
      if (req.url === '/close') {
        if (Object.keys(body).some((key) => key !== 'connectionId') || body.connectionId !== session.connectionId) throw fixedError('INVALID_INPUT')
        clearSession(session)
        void stateChanged()
        sendJson(res, 200, { closed: true }); return
      }
      try {
        const result = await rpc(session, body, requestControl)
        sendJson(res, 200, result)
      } catch (error) {
        const code = safeErrorCode(error)
        sendJson(res, 200, { content: [{ type: 'text', text: publicErrorMessage(code) }],
          structuredContent: { errorCode: code }, isError: true })
      }
    } catch (error) {
      const code = safeErrorCode(error)
      const status = Number.isInteger(error?.status) ? error.status : 400
      sendJson(res, status, { error: { code, message: publicErrorMessage(code) } })
    } finally {
      requestCounts.delete(requestId)
    }
  }

  function consumeRate(map, key, limit, windowMs) {
    const timestamp = now()
    const current = map.get(key) || { startedAt: timestamp, count: 0 }
    if (timestamp - current.startedAt >= windowMs) {
      current.startedAt = timestamp
      current.count = 0
    }
    current.count += 1
    map.set(key, current)
    if (map.size > 2048) {
      for (const [entryKey, entry] of map) if (timestamp - entry.startedAt > windowMs) map.delete(entryKey)
    }
    return current.count <= limit
  }

  function totalRequests() { return requestCounts.size }

  function validateCoreMethodForCommand(command, method) {
    const writeMethods = new Set(['agent:core:create-node', 'agent:core:update-node', 'agent:core:delete-nodes', 'agent:core:connect-edge', 'agent:core:save-canvas'])
    const readMethods = new Set(['agent:core:load-canvas', 'agent:core:list-assets', 'agent:core:list-models', 'agent:core:get-task', 'agent:core:lookup-operation'])
    const generationMethods = new Set(['agent:core:create-generation-task'])
    if (writeMethods.has(method) && command.permission !== 'canvas.write') throw fixedError('PERMISSION_DENIED', 403)
    if (generationMethods.has(method) && command.permission !== 'generation.propose') throw fixedError('PERMISSION_DENIED', 403)
    if (readMethods.has(method) && !['canvas.read', 'canvas.write', 'generation.propose', 'task.read', 'provider.read', 'provider.configure'].includes(command.permission)) {
      throw fixedError('PERMISSION_DENIED', 403)
    }
    if (!writeMethods.has(method) && !readMethods.has(method) && !generationMethods.has(method)) throw fixedError('MCP_CORE_METHOD_FORBIDDEN', 403)
  }

  async function performActionResolution(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['proposalId', 'decision'].includes(key))
      || typeof input.proposalId !== 'string' || input.proposalId.length > 128
      || !['approve', 'reject'].includes(input.decision)) throw fixedError('INVALID_INPUT')
    const action = store.getAction(input.proposalId)
    if (action?.kind === 'pairing') throw fixedError('ACTION_NOT_FOUND', 404)
    if (action?.kind === 'provider_disclosure') {
      const client = action.clientId ? await liveClient(action.clientId, action.grantId, { requireReady: false }) : null
      if (!client) throw fixedError('PERMISSION_DENIED', 403)
      if (action.expiresAt <= now()) {
        store.updateAction(action.proposalId, { status: 'expired' })
        throw fixedError('ACTION_EXPIRED', 409)
      }
      const status = input.decision === 'approve' ? 'authorized' : 'rejected'
      const updated = store.updateAction(action.proposalId, { status })
      const publicAction = toPublicAction(updated, client)
      event({ type: 'pending-action.updated', action: publicAction })
      return { proposalId: action.proposalId, status }
    }
    const context = await currentContext()
    if (!context) throw fixedError('PROJECT_CHANGED', 403)
    const worker = getWorker?.()
    if (!worker || !agentProjectMatches(worker, context.projectId)) throw fixedError('AGENT_UNAVAILABLE', 503)
    const eligible = store.listClients().filter((candidate) => candidate.projectId === context.projectId
      && candidate.canvasId === context.canvasId && candidate.revokedAt === null && candidate.expiresAt > now()
      && candidate.permissions.includes('generation.propose'))
    let candidates = null
    let client = null
    for (const candidate of eligible) {
      const result = await worker.request('mcp:proposal:get', { projectId: context.projectId,
        canvasId: context.canvasId, clientId: candidate.clientId, grantId: candidate.grantId,
        proposalId: input.proposalId, includeScope: true })
      if (result) { candidates = result; client = candidate; break }
    }
    if (!candidates || !client || candidates.projectId !== context.projectId || candidates.canvasId !== context.canvasId
      || candidates.clientId !== client.clientId || candidates.grantId !== client.grantId) throw fixedError('ACTION_NOT_FOUND', 404)
    assertClientScope(client, context)
    if (candidates.status !== 'awaiting_confirmation') throw fixedError('ACTION_NOT_FOUND', 404)
    if (!Number.isFinite(candidates.expiresAt) || candidates.expiresAt <= now()) throw fixedError('ACTION_EXPIRED', 409)
    let commandContext = context
    const writeRequestId = input.decision === 'approve' ? randomUUID() : null
    let settled = false
    const commandId = randomUUID()
    const command = { commandId, connectionId: 'desktop-confirmation', clientId: client.clientId,
      grantId: client.grantId, projectId: client.projectId, canvasId: client.canvasId,
      permission: 'generation.propose', providerRevisions: candidates.providerRevisions || {},
      expiresAt: now() + 5 * 60_000, revoked: false }
    activeCommands.set(commandId, command)
    try {
      if (input.decision === 'approve') {
        if (!await isCanvasReady(context)) throw fixedError('CANVAS_NOT_READY', 503)
        commandContext = await flushRendererCanvas(context, writeRequestId)
      }
      const providerRevisions = await getProviderRevisions?.() || {}
      await assertCommandPermission(command, 'agent:core:load-canvas')
      const resolved = await worker.request('mcp:action:resolve', {
        projectId: client.projectId, canvasId: client.canvasId, clientId: client.clientId,
        grantId: client.grantId, proposalId: input.proposalId, decision: input.decision,
        currentCanvasVersion: commandContext.version, providerRevisions, mcpCommandId: commandId,
      }, 5 * 60_000)
      event({ type: 'pending-action.updated', action: { ...candidates, status: resolved.status } })
      if (resolved.status === 'submitted') {
        for (const task of resolved.tasks || []) event({ type: 'task.changed', projectId: client.projectId,
          canvasId: client.canvasId, taskId: task.taskId, status: task.status || 'queued' })
      }
      if (writeRequestId) {
        const latest = await loadCanvas?.(client.projectId, client.canvasId)
        event({ type: 'canvas.changed', projectId: client.projectId, canvasId: client.canvasId,
          version: latest?.version ?? commandContext.version, operationId: input.proposalId, source: 'external_mcp' })
        event({ type: 'canvas.write-settled', requestId: writeRequestId, projectId: client.projectId,
          canvasId: client.canvasId, status: 'committed', version: latest?.version ?? commandContext.version })
        settled = true
      }
      return { proposalId: input.proposalId, status: resolved.status }
    } catch (error) {
      if (writeRequestId && !settled) {
        event({ type: 'canvas.write-settled', requestId: writeRequestId, projectId: client.projectId,
          canvasId: client.canvasId, status: 'aborted', errorCode: safeErrorCode(error) })
        settled = true
      }
      throw error
    } finally { activeCommands.delete(commandId) }
  }

  function registerIpc() {
    const handle = (channel, callback) => ipcMain.handle(channel, async (eventObject, ...args) => {
      assertTrustedSender(eventObject)
      return callback(...args)
    })
    handle('desktop:mcp:state:get', () => getState())
    handle('desktop:mcp:enabled:set', async (enabled) => {
      if (typeof enabled !== 'boolean') throw fixedError('INVALID_INPUT')
      store.setEnabled(enabled)
      if (!enabled) {
        clearAllSessions()
        for (const action of store.listActions()) {
          if (['awaiting_pairing', 'awaiting_disclosure', 'awaiting_desktop_input'].includes(action.status)) {
            store.updateAction(action.proposalId, { status: 'invalidated' })
          }
        }
      }
      const result = await getState()
      event({ type: 'state.changed', state: result })
      return result
    })
    handle('desktop:mcp:client:create', async (input) => {
      const context = await currentContext()
      if (!context) throw fixedError('PROJECT_CHANGED', 403)
      const descriptors = await providerDescriptors()
      const normalized = validateGrantInput(input, context, descriptors)
      const grant = store.createClient(normalized)
      void stateChanged()
      return { clientId: grant.clientId, grant: publicClient(grant, false), config: safeConfig(grant) }
    })
    handle('desktop:mcp:client:revoke', async (clientId) => {
      if (typeof clientId !== 'string' || clientId.length > 128) throw fixedError('INVALID_INPUT')
      const revoked = store.revokeClient(clientId)
      for (const session of activeSessionsForClient(clientId)) clearSession(session)
      for (const action of store.listActions({ clientId })) {
        if (['awaiting_pairing', 'awaiting_disclosure', 'awaiting_desktop_input'].includes(action.status)) {
          store.updateAction(action.proposalId, { status: 'invalidated' })
        }
      }
      void stateChanged()
      return { clientId, revoked }
    })
    handle('desktop:mcp:actions:list', () => listActions())
    handle('desktop:mcp:actions:resolve', (input) => performActionResolution(input))
    handle('desktop:mcp:canvas-ready:set', async (input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['projectId', 'canvasId', 'ready', 'version'].includes(key))
        || typeof input.projectId !== 'string' || typeof input.canvasId !== 'string' || typeof input.ready !== 'boolean') throw fixedError('INVALID_INPUT')
      const context = await currentContext()
      if (!context || context.projectId !== input.projectId || context.canvasId !== input.canvasId
        || (input.version !== undefined && input.version !== context.version)) {
        canvasReady = null
        clearAllSessions()
        throw fixedError('PROJECT_CHANGED', 409)
      }
      canvasReady = input.ready ? { projectId: input.projectId, canvasId: input.canvasId, ready: true, version: context.version } : null
      if (!input.ready) revokeCanvasCommands()
      await stateChanged()
    })
    handle('desktop:mcp:canvas-flush:respond', (input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['requestId', 'projectId', 'canvasId', 'status', 'persistedVersion', 'errorCode'].includes(key))
        || typeof input.requestId !== 'string') throw fixedError('INVALID_INPUT')
      const pending = flushRequests.get(input.requestId)
      if (!pending || input.projectId !== pending.request.projectId || input.canvasId !== pending.request.canvasId
        || !['flushed', 'failed'].includes(input.status)
        || (input.status === 'flushed' && (!Number.isSafeInteger(input.persistedVersion) || input.persistedVersion < 0))) {
        throw fixedError('INVALID_INPUT')
      }
      clearTimeout(pending.timer)
      flushRequests.delete(input.requestId)
      pending.resolve(input)
    })
  }

  async function start() {
    if (server) return { instanceId, host: '127.0.0.1', port }
    registerIpc()
    server = http.createServer((req, res) => { void handleRequest(req, res) })
    server.requestTimeout = 125_000
    server.headersTimeout = 5_000
    server.maxHeadersCount = 32
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    port = server.address().port
    const instance = { schemaVersion: INSTANCE_SCHEMA_VERSION, instanceId,
      host: '127.0.0.1', port, protocolVersion: PROTOCOL_VERSION, pid: process.pid }
    const temp = `${instanceFile}.${randomUUID()}.tmp`
    await fs.writeFile(temp, `${JSON.stringify(instance)}\n`, { flag: 'wx', mode: 0o600 })
    await fs.rename(temp, instanceFile)
    await stateChanged()
    return instance
  }

  async function stop() {
    if (stopped) return
    stopped = true
    clearAllSessions()
    for (const pending of [...pendingBootstrap.values()]) {
      if (pending.requestControl) pending.requestControl.cancelled = true
      invalidatePendingBootstrap(pending)
    }
    for (const pending of flushRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(fixedError('CANVAS_NOT_READY', 503))
    }
    flushRequests.clear()
    if (server) {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve())).catch(() => {})
      server = null
    }
    try {
      const current = JSON.parse(await fs.readFile(instanceFile, 'utf8'))
      if (current.instanceId === instanceId) await fs.rm(instanceFile, { force: true })
    } catch { /* stale instance file is not ours or absent */ }
    store.close()
  }

  function invalidateForProjectTransition() {
    clearAllSessions()
    canvasReady = null
    const contextPromise = currentContext()
    void contextPromise.then(() => stateChanged()).catch(() => undefined)
  }

  function handleWindowClosed() {
    canvasReady = null
    clearAllSessions()
    void stateChanged()
  }

  async function authorizeProviderInputSave(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.mcpProposalId !== 'string') {
      throw fixedError('INVALID_INPUT')
    }
    const action = store.getAction(input.mcpProposalId)
    if (!action || action.kind !== 'provider_input' || action.status !== 'awaiting_desktop_input'
      || action.expiresAt <= now() || action.providerOperationId !== input.operationId
      || action.payload?.operationId !== input.operationId || action.payload?.providerId !== input.providerId
      || action.payload?.expectedRevision !== input.expectedRevision) throw fixedError('ACTION_NOT_FOUND', 404)
    const client = await liveClient(action.clientId, action.grantId, { requireReady: false })
    if (client.projectId !== action.projectId || client.canvasId !== action.canvasId) throw fixedError('PROJECT_CHANGED', 403)
    const providerGrant = client.providerGrants.find((entry) => entry.providerId === input.providerId)
    if (!client.permissions.includes('provider.configure') || !providerGrant?.credentialInputModes.includes('desktop_input')) {
      throw fixedError('PERMISSION_DENIED', 403)
    }
    const allowedFields = new Set(action.payload.credentialFields || [])
    if ((input.credentials && Object.keys(input.credentials).some((field) => !allowedFields.has(field) || !providerGrant.credentialFields.includes(field)))) {
      throw fixedError('PERMISSION_DENIED', 403)
    }
    const publicConfig = projectProviderPublicConfig(input)
    if (stableJson(publicConfig) !== stableJson(projectProviderPublicConfig(action.payload.publicConfig))) {
      throw fixedError('MCP_PROVIDER_INPUT_MISMATCH', 409)
    }
    const operation = store.getOperation({ operationId: input.operationId, clientId: client.clientId, grantId: client.grantId })
    if (!operation || operation.kind !== `provider:${input.providerId}:configure`
      || operation.status !== 'awaiting_desktop_input' || operation.result?.pendingActionId !== action.proposalId) {
      throw fixedError('MCP_PROVIDER_OPERATION_MISMATCH', 409)
    }
    const { mcpProposalId, ...cleanInput } = input
    return {
      client, action, cleanInput,
      assertAuthorized: async () => {
        const latestAction = store.getAction(action.proposalId)
        if (!latestAction || latestAction.status !== 'awaiting_desktop_input' || latestAction.expiresAt <= now()) {
          throw fixedError('ACTION_EXPIRED', 409)
        }
        await liveClient(client.clientId, client.grantId, { requireReady: false })
      },
    }
  }

  async function recordProviderUiSave({ proposalId, clientId, grantId, operationId, providerId, publicResult }) {
    if ([proposalId, clientId, grantId, operationId, providerId].some((value) => typeof value !== 'string')) return false
    const action = store.getAction(proposalId)
    if (!action || action.kind !== 'provider_input' || action.clientId !== clientId || action.grantId !== grantId
      || action.providerOperationId !== operationId || action.payload?.providerId !== providerId
      || action.status !== 'awaiting_desktop_input') return false
    const operation = store.getOperation({ operationId, clientId, grantId })
    if (!operation || operation.kind !== `provider:${providerId}:configure`
      || operation.status !== 'awaiting_desktop_input' || operation.result?.pendingActionId !== proposalId) return false
    store.completeOperation({ operationId, clientId, grantId, status: 'saved', result: safeOutput(publicResult) })
    const updated = store.updateAction(proposalId, { status: 'completed' })
    event({ type: 'pending-action.updated', action: toPublicAction(updated, store.getClient(clientId)) })
    return true
  }

  return {
    start, stop, getState, getStore: () => store,
    authorizeAgentCoreRequest, validateCoreMethodForCommand,
    invalidateForProjectTransition, handleWindowClosed,
    recordProviderUiSave, authorizeProviderInputSave,
    notifyProviderConfigurationChanged,
    setCanvasReady: (value) => { canvasReady = value },
    getCanvasReady: () => canvasReady,
    getInstanceFile: () => instanceFile,
    getActiveCommands: () => activeCommands,
  }
}

function safeErrorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,120}$/u.test(value) ? value : 'MCP_REQUEST_FAILED'
}

function publicErrorMessage(code) {
  const messages = {
    MCP_DISABLED: 'Desktop MCP is disabled.', CANVAS_NOT_READY: 'The authorized canvas is not ready.',
    PROJECT_CHANGED: 'The authorized project or canvas changed.', PERMISSION_DENIED: 'The requested capability is not authorized.',
    UNAUTHORIZED: 'Connection approval is required.', CONNECTION_NOT_APPROVED: 'The desktop did not approve this connection.',
    PROVIDER_REVISION_CONFLICT: 'Provider settings changed; refresh and retry.', CANVAS_VERSION_CONFLICT: 'Canvas changed; refresh and retry.',
    CANVAS_FLUSH_FAILED: 'Canvas changes could not be saved.', CANVAS_FLUSH_TIMEOUT: 'Canvas save did not finish in time.',
    MCP_TOOL_UNAVAILABLE: 'This tool is unavailable.', INVALID_INPUT: 'Request parameters are invalid.',
    UNSUPPORTED: 'This task output type is not supported by the MCP reader.',
    TASK_OUTPUT_NOT_FOUND: 'The requested output index does not exist.',
    TASK_OUTPUT_UNAVAILABLE: 'The task output could not be safely read.',
    OUTPUT_TOO_LARGE: 'The task output exceeds the MCP preview size limit.',
    OUTPUT_MIME_MISMATCH: 'The task output content does not match its media type.',
    REQUEST_CANCELLED: 'The MCP request was cancelled.',
    CREDENTIAL_SOURCE_INVALID: 'The authorized credential source is invalid.', CREDENTIAL_SOURCE_UNAVAILABLE: 'The authorized credential source is unavailable.',
    ACTION_EXPIRED: 'This desktop action has expired.', ACTION_NOT_FOUND: 'This desktop action is no longer available.',
  }
  return messages[code] || 'The local desktop request failed.'
}

function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function projectProviderPublicConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const fields = ['providerId', 'baseUrl', 'enabledModelIds', 'defaultModelIds', 'modelDefaults', 'timeoutSeconds']
  const result = {}
  for (const field of fields) if (Object.hasOwn(value, field)) result[field] = value[field]
  return result
}

module.exports = { createMcpMainService, MAX_BODY_BYTES, PROTOCOL_VERSION }
