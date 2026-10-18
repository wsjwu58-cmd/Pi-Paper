'use strict'

const { spawn, spawnSync } = require('node:child_process')

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const CLOSE_GRACE_MS = 1_000
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024
const ALLOWED_ELICITATION_ACTIONS = new Set(['accept', 'decline', 'cancel'])

function failure(code) {
  return Object.assign(new Error(code), { code })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key))
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`
}

function validRequestId(id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 256)
    || (Number.isSafeInteger(id) && id >= 0)
}

function isGenerationForm(params, threadId, turnId) {
  if (!isRecord(params) || params.serverName !== 'vibepaper' || params.mode !== 'form'
    || params.threadId !== threadId || (params.turnId != null && params.turnId !== turnId)
    || typeof params.message !== 'string' || params.message.length < 1 || params.message.length > 20_000) return false
  const schema = params.requestedSchema
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)
    || Object.keys(schema.properties).length !== 1 || !Object.hasOwn(schema.properties, 'confirm')) return false
  const confirm = schema.properties.confirm
  return isRecord(confirm) && confirm.type === 'boolean'
    && Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === 'confirm'
}

function normalizeElicitationResult(value) {
  if (!isRecord(value) || !ALLOWED_ELICITATION_ACTIONS.has(value.action)) {
    return { action: 'cancel', content: null }
  }
  if (value.action !== 'accept') return { action: value.action, content: null }
  if (!exactKeys(value.content, ['confirm']) || typeof value.content.confirm !== 'boolean') {
    return { action: 'cancel', content: null }
  }
  return { action: 'accept', content: { confirm: value.content.confirm } }
}

function normalizeItem(item) {
  if (!isRecord(item)) return item
  if (item.type === 'mcpToolCall') {
    return { ...item, type: 'mcp_tool_call', tool_name: item.tool }
  }
  if (item.type === 'agentMessage') return { ...item, type: 'agent_message' }
  return item
}

function traceEvent(message) {
  const method = message.method
  const params = message.params || {}
  if (method === 'thread/started') return { type: 'thread.started' }
  if (method === 'turn/started') return { type: 'turn.started' }
  if (method === 'item/started' || method === 'item/completed'
    || method === 'item/updated' || method === 'item/failed') {
    const suffix = method.slice('item/'.length)
    return { type: `item.${suffix}`, item: normalizeItem(params.item) }
  }
  if (method === 'turn/completed' || method === 'turn/failed') {
    const status = typeof params.turn?.status === 'string' ? params.turn.status : 'failed'
    return { type: method === 'turn/failed' || status !== 'completed' ? 'turn.failed' : 'turn.completed', status,
      ...(params.turn?.error ? { error: params.turn.error } : {}) }
  }
  // The QA caller classifies this in memory and persists only boolean/code
  // summaries; never write raw error messages or complete traces to evidence.
  if (method === 'error' || method === 'turn/error') return { type: 'turn.error', error: params.error ?? params }
  return null
}

function safeTurnResult(params) {
  const status = typeof params?.turn?.status === 'string' && params.turn.status.length <= 40
    ? params.turn.status : 'failed'
  return { status }
}

function configFailure() {
  return failure('CODEX_MCP_CONFIG_INVALID')
}

/**
 * Read only MCP server names from Codex config. Python's stdlib TOML parser
 * rejects duplicate or unknown syntax; config contents never go to argv,
 * stderr, or stdout.
 */
function createVibePaperOnlyOverride(serverValue, configText) {
  if (typeof serverValue !== 'string' || serverValue.length === 0 || typeof configText !== 'string') throw configFailure()
  const extractor = [
    'import json, sys, tomllib',
    'document = tomllib.loads(sys.stdin.read())',
    'servers = document.get("mcp_servers", {})',
    'profiles = document.get("profiles", {})',
    'if not isinstance(servers, dict) or not isinstance(profiles, dict): raise ValueError()',
    'result = {"global": list(servers.keys()), "profiles": {}}',
    'for name, profile in profiles.items():',
    '    if not isinstance(profile, dict): raise ValueError()',
    '    profile_servers = profile.get("mcp_servers", {})',
    '    if not isinstance(profile_servers, dict): raise ValueError()',
    '    if profile_servers: result["profiles"][name] = list(profile_servers.keys())',
    'sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(",", ":")))',
  ].join('\n')
  const pythonEnvironment = {}
  for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') pythonEnvironment[name] = process.env[name]
  }
  let parsed
  try {
    const python = spawnSync(process.platform === 'win32' ? 'python.exe' : 'python3', ['-I', '-c', extractor], {
      input: configText,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5_000,
      maxBuffer: 1_048_576,
      env: pythonEnvironment,
      shell: false,
    })
    if (python.error || python.status !== 0) throw configFailure()
    parsed = JSON.parse(python.stdout)
  } catch {
    throw configFailure()
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.global) || !isRecord(parsed.profiles)) throw configFailure()
  const names = [...parsed.global]
  const profiles = new Map()
  for (const name of names) if (typeof name !== 'string' || name.length === 0) throw configFailure()
  for (const [profileName, profileNames] of Object.entries(parsed.profiles)) {
    if (!profileName || !Array.isArray(profileNames)
      || profileNames.some((name) => typeof name !== 'string' || name.length === 0)) throw configFailure()
    profiles.set(profileName, new Set(profileNames))
  }

  const globalServers = new Map([['vibepaper', serverValue]])
  for (const name of new Set(names)) {
    if (name === 'vibepaper') continue
    globalServers.set(name, '{enabled=false}')
  }
  const overrides = [
    'features.plugins=false',
    'features.apps=false',
    'mcp_servers=' + inlineTable(globalServers),
  ]
  const profileOverrides = new Map()
  for (const [profileName, profileServers] of profiles) {
    const serverOverrides = new Map()
    for (const name of profileServers) {
      serverOverrides.set(name, name === 'vibepaper' ? serverValue : '{enabled=false}')
    }
    profileOverrides.set(profileName, new Map([['mcp_servers', inlineTable(serverOverrides)]]))
  }
  if (profileOverrides.size > 0) overrides.push('profiles=' + inlineTable(profileOverrides))
  return overrides
}

function inlineTable(entries) {
  return '{' + [...entries].map(([name, value]) => tomlKey(name) + '=' + tomlValue(value)).join(',') + '}'
}

function tomlValue(value) {
  return value instanceof Map ? inlineTable(value) : value
}

function tomlKey(value) {
  if (/^[A-Za-z0-9_-]+$/u.test(value)) return value
  return JSON.stringify(value)
}

function hasTools(entry) {
  if (entry.tools == null) return false
  if (Array.isArray(entry.tools)) return entry.tools.length > 0
  if (isRecord(entry.tools)) return Object.keys(entry.tools).length > 0
  return true
}

function validateMcpServerScope(response) {
  if (!isRecord(response) || !Array.isArray(response.data)
    || (response.nextCursor !== undefined && response.nextCursor !== null)) throw failure('CODEX_APP_SERVER_MCP_SCOPE_INVALID')
  const seen = new Set()
  let vibePaperCount = 0
  for (const entry of response.data) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.length === 0 || seen.has(entry.name)) {
      throw failure('CODEX_APP_SERVER_MCP_SCOPE_INVALID')
    }
    seen.add(entry.name)
    if (entry.name === 'vibepaper') {
      vibePaperCount += 1
      if (entry.runtimeStatus !== 'connected') throw failure('CODEX_APP_SERVER_MCP_SCOPE_INVALID')
    } else if (entry.runtimeStatus !== 'disabled' || hasTools(entry)) {
      throw failure('CODEX_APP_SERVER_MCP_SCOPE_INVALID')
    }
  }
  if (vibePaperCount !== 1) throw failure('CODEX_APP_SERVER_MCP_SCOPE_INVALID')
}

function summarizeMcpScope(response) {
  const statuses = new Set(['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'])
  const safeStatus = (value) => statuses.has(value) ? value : value == null ? 'missing' : 'unknown'
  const entries = Array.isArray(response?.data) ? response.data : []
  const others = entries.filter((entry) => entry?.name !== 'vibepaper')
  const otherStatuses = {}
  for (const entry of others) {
    const state = safeStatus(entry?.runtimeStatus)
    otherStatuses[state] = (otherStatuses[state] || 0) + 1
  }
  return {
    validShape: isRecord(response) && Array.isArray(response.data),
    paginated: response?.nextCursor != null,
    serverCount: entries.length,
    vibePaperStatuses: entries.filter((entry) => entry?.name === 'vibepaper').map((entry) => safeStatus(entry.runtimeStatus)),
    otherStatuses,
    otherWithTools: others.filter((entry) => isRecord(entry) && hasTools(entry)).length,
  }
}

/**
 * Run one ephemeral Codex app-server turn. `onElicitation` is a QA relay to a
 * user-facing host callback; this process does not display a Codex native UI or
 * infer acceptance. Only the exact VibePaper boolean confirmation form is
 * forwarded to that callback.
 */
async function startCodexAppServerTurn(options = {}) {
  const {
    executable, override, overrides, cwd, environment, prompt,
    onTrace = () => {}, onStderr = () => {}, onScope = () => {}, onRequestError = () => {}, onElicitation, useClientDefaultModel = false,
    timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn,
  } = options
  const configOverrides = Array.isArray(overrides) ? overrides
    : typeof override === 'string' ? [override] : []
  if (typeof executable !== 'string' || executable.length === 0
    || configOverrides.length === 0 || configOverrides.some((entry) => typeof entry !== 'string' || entry.length === 0)
    || typeof cwd !== 'string' || cwd.length === 0
    || !isRecord(environment) || typeof prompt !== 'string' || prompt.length === 0
    || typeof onTrace !== 'function' || typeof onStderr !== 'function' || typeof onScope !== 'function' || typeof onRequestError !== 'function'
    || typeof useClientDefaultModel !== 'boolean'
    || (onElicitation !== undefined && typeof onElicitation !== 'function')
    || typeof spawnImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw failure('CODEX_APP_SERVER_CONFIGURATION_INVALID')
  }

  const args = [...configOverrides.flatMap((entry) => ['-c', entry]), '--disable', 'shell_tool', 'app-server', '--listen', 'stdio://']
  let child
  try {
    child = spawnImpl(executable, args, {
      cwd,
      env: { ...environment },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    throw failure('CODEX_PROCESS_SPAWN_FAILED')
  }
  if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.once !== 'function') {
    try { child?.kill?.() } catch { /* best effort cleanup of an invalid child adapter */ }
    throw failure('CODEX_PROCESS_SPAWN_FAILED')
  }

  const pendingRequests = new Map()
  const pendingElicitations = new Map()
  let nextRequestId = 1
  let lineBuffer = ''
  let threadId = null
  let turnId = null
  let turnStartAcknowledged = false
  let deferredCompletion = null
  let resultSettled = false
  let turnCompleted = false
  let shuttingDown = false
  let timeoutHandle
  let terminationPromise = null
  let completionPromise = null
  let resolveResult
  let rejectResult
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  // The caller cannot receive `result` until startup completes; mark the promise
  // handled now so early process failure never becomes an unhandled rejection.
  result.catch(() => {})

  function invoke(callback, value) {
    try { callback(value) } catch { /* observation callbacks cannot control protocol state */ }
  }

  function rejectPendingRequests(code) {
    for (const request of pendingRequests.values()) {
      clearTimeout(request.timer)
      request.reject(failure(code))
    }
    pendingRequests.clear()
  }

  function writeMessage(message) {
    if (shuttingDown || child.stdin.destroyed || child.stdin.writableEnded) {
      return Promise.reject(failure('CODEX_APP_SERVER_DISCONNECTED'))
    }
    let line
    try { line = `${JSON.stringify(message)}\n` } catch { return Promise.reject(failure('CODEX_APP_SERVER_PROTOCOL_INVALID')) }
    return new Promise((resolve, reject) => {
      try {
        child.stdin.write(line, (error) => error ? reject(failure('CODEX_APP_SERVER_DISCONNECTED')) : resolve())
      } catch {
        reject(failure('CODEX_APP_SERVER_DISCONNECTED'))
      } finally {
        line = ''
      }
    })
  }

  function request(method, params) {
    const id = nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pendingRequests.delete(id)) return
        reject(failure('CODEX_APP_SERVER_TIMEOUT'))
      }, timeoutMs)
      pendingRequests.set(id, { resolve, reject, timer, method })
      void writeMessage({ method, id, params }).catch(() => {
        const pending = pendingRequests.get(id)
        if (!pending) return
        pendingRequests.delete(id)
        clearTimeout(pending.timer)
        pending.reject(failure('CODEX_APP_SERVER_DISCONNECTED'))
      })
    })
  }

  function sendResponse(id, resultValue) {
    return writeMessage({ id, result: resultValue })
  }

  function sendErrorResponse(id, code = -32601) {
    return writeMessage({ id, error: { code, message: 'This app-server request is not supported by the acceptance host.' } })
  }

  function settleElicitation(entry, response, send = true) {
    if (entry.settled) return Promise.resolve()
    entry.settled = true
    pendingElicitations.delete(requestKey(entry.id))
    entry.controller.abort()
    if (!send) return Promise.resolve()
    return sendResponse(entry.id, response).catch(() => {})
  }

  async function cancelPendingElicitations(turnFilter) {
    const entries = [...pendingElicitations.values()].filter((entry) =>
      turnFilter === undefined || entry.turnId === turnFilter)
    await Promise.all(entries.map((entry) => settleElicitation(entry, { action: 'cancel', content: null })))
  }

  async function terminateOwnedChild() {
    if (terminationPromise) return terminationPromise
    shuttingDown = true
    terminationPromise = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(forceTimer)
        child.removeListener?.('close', finish)
        resolve()
      }
      child.once('close', finish)
      const forceTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* process may have exited */ }
        finish()
      }, CLOSE_GRACE_MS)
      try { child.kill() } catch { finish() }
    })
    return terminationPromise
  }

  async function finishTurn(params) {
    if (completionPromise) return completionPromise
    resultSettled = true
    completionPromise = (async () => {
      turnCompleted = true
      await cancelPendingElicitations(turnId)
      clearTimeout(timeoutHandle)
      rejectPendingRequests('CODEX_APP_SERVER_DISCONNECTED')
      await terminateOwnedChild()
      resolveResult(safeTurnResult(params))
    })()
    return completionPromise
  }

  function failTurn(code) {
    if (resultSettled) return
    resultSettled = true
    clearTimeout(timeoutHandle)
    rejectPendingRequests(code)
    void cancelPendingElicitations(undefined).then(terminateOwnedChild)
    rejectResult(failure(code))
  }

  async function handleElicitation(message) {
    const id = message.id
    if (!validRequestId(id)) throw failure('CODEX_APP_SERVER_PROTOCOL_INVALID')
    const params = message.params
    if (!isGenerationForm(params, threadId, turnId)) {
      await sendResponse(id, { action: 'decline', content: null })
      return
    }
    const entry = { id, turnId, settled: false, controller: new AbortController() }
    pendingElicitations.set(requestKey(id), entry)
    const callbackResult = onElicitation
      ? Promise.resolve().then(() => onElicitation(params, { signal: entry.controller.signal }))
        .then(normalizeElicitationResult, () => ({ action: 'cancel', content: null }))
      : Promise.resolve({ action: 'decline', content: null })
    const aborted = new Promise((resolve) => {
      if (entry.controller.signal.aborted) return resolve({ action: 'cancel', content: null })
      entry.controller.signal.addEventListener('abort', () => resolve({ action: 'cancel', content: null }), { once: true })
    })
    const decision = await Promise.race([callbackResult, aborted])
    if (entry.settled) return
    await settleElicitation(entry, decision)
  }

  async function handleServerRequest(message) {
    if (!validRequestId(message.id) || !isRecord(message.params)) throw failure('CODEX_APP_SERVER_PROTOCOL_INVALID')
    switch (message.method) {
      case 'mcpServer/elicitation/request':
        await handleElicitation(message)
        return
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval':
        await sendResponse(message.id, { decision: 'cancel' })
        return
      case 'item/permissions/requestApproval':
        await sendResponse(message.id, { permissions: {}, scope: 'turn' })
        return
      default:
        await sendErrorResponse(message.id)
    }
  }

  async function handleNotification(message) {
    if (message.method === 'turn/completed' || message.method === 'turn/failed') {
      const params = isRecord(message.params) ? message.params : {}
      if ((params.threadId && threadId && params.threadId !== threadId)
        || (params.turn?.id && turnId && params.turn.id !== turnId)) return
      invoke(onTrace, traceEvent(message))
      deferredCompletion = params
      if (turnStartAcknowledged) await finishTurn(params)
      return
    }
    if (message.method === 'thread/started' && threadId && message.params?.thread?.id !== threadId) return
    if (message.method?.startsWith('item/') && message.params?.threadId && threadId
      && message.params.threadId !== threadId) return
    if (message.method === 'turn/started' && message.params?.threadId && threadId
      && message.params.threadId !== threadId) return
    const event = traceEvent(message)
    if (event) invoke(onTrace, event)
  }

  async function handleMessage(message) {
    if (!isRecord(message)) throw failure('CODEX_APP_SERVER_PROTOCOL_INVALID')
    if (typeof message.method === 'string' && Object.hasOwn(message, 'id')) {
      await handleServerRequest(message)
      return
    }
    if (typeof message.method === 'string' && !Object.hasOwn(message, 'id')) {
      await handleNotification(message)
      return
    }
    if (Object.hasOwn(message, 'id')) {
      const pending = pendingRequests.get(message.id)
      if (!pending) throw failure('CODEX_APP_SERVER_PROTOCOL_INVALID')
      pendingRequests.delete(message.id)
      clearTimeout(pending.timer)
      if (isRecord(message.error)) {
        invoke(onTrace, { type: 'turn.error', error: message.error })
        invoke(onRequestError, { method: pending.method, code: message.error.code })
        pending.reject(failure('CODEX_APP_SERVER_REQUEST_FAILED'))
      }
      else if (Object.hasOwn(message, 'result')) pending.resolve(message.result)
      else pending.reject(failure('CODEX_APP_SERVER_PROTOCOL_INVALID'))
      return
    }
    throw failure('CODEX_APP_SERVER_PROTOCOL_INVALID')
  }

  child.stdout.setEncoding?.('utf8')
  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    let offset = 0
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset)
      const end = newline < 0 ? text.length : newline
      const fragment = text.slice(offset, end)
      if (Buffer.byteLength(lineBuffer, 'utf8') + Buffer.byteLength(fragment, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
        lineBuffer = ''
        failTurn('CODEX_APP_SERVER_PROTOCOL_INVALID')
        return
      }
      lineBuffer += fragment
      if (newline < 0) return
      const line = lineBuffer.trim()
      lineBuffer = ''
      offset = newline + 1
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch {
        failTurn('CODEX_APP_SERVER_PROTOCOL_INVALID')
        return
      }
      void handleMessage(message).catch(() => {
        failTurn('CODEX_APP_SERVER_PROTOCOL_INVALID')
      })
    }
  })
  child.stdout.once('error', () => {
    failTurn('CODEX_APP_SERVER_DISCONNECTED')
  })
  child.stderr.on('data', (chunk) => invoke(onStderr, Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)))
  child.once('error', () => {
    failTurn('CODEX_PROCESS_SPAWN_FAILED')
  })
  child.once('close', () => {
    lineBuffer = ''
    if (!resultSettled && !shuttingDown) failTurn('CODEX_APP_SERVER_DISCONNECTED')
  })

  timeoutHandle = setTimeout(() => {
    failTurn('CODEX_APP_SERVER_TIMEOUT')
  }, timeoutMs)

  async function close() {
    if (!resultSettled) failTurn('CODEX_APP_SERVER_CLOSED')
    await cancelPendingElicitations(undefined)
    rejectPendingRequests('CODEX_APP_SERVER_CLOSED')
    clearTimeout(timeoutHandle)
    await terminateOwnedChild()
  }

  try {
    await request('initialize', {
      clientInfo: { name: 'vibepaper-acceptance-host', title: 'VibePaper acceptance host', version: '1.0.0' },
    })
    await writeMessage({ method: 'initialized', params: {} })
    let selectedModel
    if (useClientDefaultModel) {
      const catalog = await request('model/list', { includeHidden: false, limit: 100 })
      const defaults = Array.isArray(catalog?.data) ? catalog.data.filter((entry) => entry?.isDefault === true && entry.hidden !== true) : []
      if (catalog?.nextCursor != null || defaults.length !== 1 || typeof defaults[0].model !== 'string'
        || !/^[A-Za-z0-9._:/-]{1,200}$/u.test(defaults[0].model)) throw failure('CODEX_APP_SERVER_MODEL_UNAVAILABLE')
      selectedModel = defaults[0].model
    }
    const threadResponse = await request('thread/start', {
      cwd,
      ...(selectedModel ? { model: selectedModel } : {}),
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      ephemeral: true,
    })
    threadId = threadResponse?.thread?.id
    if (typeof threadId !== 'string' || threadId.length === 0) throw failure('CODEX_APP_SERVER_PROTOCOL_INVALID')
    const inventory = await request('mcpServerStatus/list', { threadId, detail: 'full', limit: 100 })
    invoke(onScope, summarizeMcpScope(inventory))
    validateMcpServerScope(inventory)
    const turnResponse = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    })
    turnId = turnResponse?.turn?.id
    if (typeof turnId !== 'string' || turnId.length === 0) throw failure('CODEX_APP_SERVER_PROTOCOL_INVALID')
    turnStartAcknowledged = true
    if (deferredCompletion) await finishTurn(deferredCompletion)
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'CODEX_APP_SERVER_REQUEST_FAILED'
    await close()
    throw failure(code)
  }

  return { child, result, close }
}

module.exports = { createVibePaperOnlyOverride, startCodexAppServerTurn }
