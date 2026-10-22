// Codex-only real-account acceptance harness. This file is QA tooling only:
// it launches the original Electron Main/Renderer and the installed Codex CLI,
// but never starts a provider generation by itself. Configuration has no manual
// gate; each generation requires client form elicitation. --configuration-only
// verifies the non-interactive CLI path without submitting media tasks.
// Evidence is restricted to state, counts, safe error codes, model labels,
// media MIME/size/hash and render visibility. No prompt, transcript, IDs,
// credentials, MCP bootstrap values, or screenshots are persisted.
'use strict'

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline')
const { spawn, execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '../..')
const evidenceDirectory = path.join(root, 'docs/verification/2026-10-11-mcp-acceptance')
const temporaryBase = path.join(root, '.test-temp')
const secretEnvName = 'VIBEPAPER_ACCEPTANCE_AGNES_KEY'
const safeStatuses = new Set([
  'aborted', 'authenticated', 'authorized', 'awaiting_confirmation', 'awaiting_disclosure', 'cancelled', 'completed', 'connected', 'disconnected', 'error', 'expired',
  'failed', 'invalidated', 'not_found', 'passed', 'pending', 'proposed', 'queued', 'rejected', 'running', 'success',
  'saved', 'submitted', 'submitting', 'succeeded', 'unsupported', 'uncertain', 'waiting_confirmation',
])
const safeErrorCodes = new Set([
  'AGENT_UNAVAILABLE', 'CANVAS_NOT_READY', 'CANVAS_VERSION_CONFLICT', 'CONFIRMATION_REQUIRED', 'CLOUD_CREDENTIAL_MISSING',
  'CLOUD_PROVIDER_UNAVAILABLE', 'CLOUD_RATE_LIMITED', 'CLOUD_REQUEST_FAILED',
  'CREDENTIAL_SOURCE_INVALID', 'CREDENTIAL_SOURCE_UNAVAILABLE', 'IDEMPOTENCY_CONFLICT', 'INVALID_INPUT',
  'MCP_OPERATION_RECOVERY_REQUIRED', 'MCP_OPERATION_STORE_UNAVAILABLE', 'MCP_TOOL_UNAVAILABLE',
  'MODEL_NOT_FOUND', 'PERMISSION_DENIED', 'PROJECT_CHANGED', 'PROVIDER_CONFIGURATION_INVALID',
  'PROVIDER_REVISION_CONFLICT', 'PROVIDER_REVISION_REQUIRED', 'PROVIDER_TEST_UNSUPPORTED',
  'REQUEST_TIMEOUT', 'SECURE_STORAGE_UNAVAILABLE', 'TASK_NOT_FOUND', 'TASK_OUTPUT_NOT_FOUND',
  'TASK_OUTPUT_UNAVAILABLE', 'OUTPUT_TOO_LARGE', 'OUTPUT_MIME_MISMATCH', 'UNSUPPORTED',
  'AGNES_KEY_UNAVAILABLE', 'AGNES_PROVIDER_NOT_CONFIGURED', 'AGNES_KEY_INPUT_TOO_LARGE', 'AGNES_KEY_INPUT_CANCELLED',
  'CODEX_CLI_NOT_FOUND', 'CODEX_NATIVE_BINARY_NOT_FOUND', 'CODEX_MCP_CONFIG_UNAVAILABLE',
  'CODEX_MCP_CONFIG_INVALID', 'MCP_GRANT_UNAVAILABLE', 'RENDERER_UNAVAILABLE', 'UI_STATE_TIMEOUT',
  'TEMP_PATH_OUTSIDE_ACCEPTANCE_ROOT', 'POST_EXIT_SECRET_SCAN_FAILED', 'CODEX_STAGE_TIMEOUT',
  'CODEX_TURN_FAILED', 'CODEX_PROCESS_SPAWN_FAILED', 'IMAGE_CHAIN_ASSERTION_FAILED',
  'VIDEO_CHAIN_ASSERTION_FAILED', 'MCP_MEDIA_PREVIEW_READBACK_INCOMPLETE',
  'MCP_MEDIA_PREVIEW_TASKSTORE_MISMATCH',
  'ORIGINAL_NODE_MEDIA_NOT_VISIBLE', 'CREDENTIAL_CLEANUP_FAILED', 'ELECTRON_WORKER_TIMEOUT',
  'ELECTRON_WORKER_FAILED', 'ELECTRON_SPAWN_ERROR', 'CONTROLLER_FAILED', 'QA_ASSERTION_FAILED',
  'AGNES_MODELS_NOT_ENABLED',
  'CLOUD_CREDENTIAL_INVALID', 'PROVIDER_GENERATION_FAILED', 'PROVIDER_REQUEST_FAILED', 'TASK_FAILED',
  'TASK_OUTPUT_INVALID', 'PROVIDER_TEST_FAILED', 'PROVIDER_SAVE_FAILED', 'OPERATOR_MEDIA_GATE_CANCELLED',
  'OPERATOR_MEDIA_GATE_TIMEOUT', 'OPERATOR_MEDIA_GATE_UNAVAILABLE',
  'PROVIDER_DISCLOSURE_REJECTED', 'PROVIDER_DISCLOSURE_UNRESOLVED', 'PROVIDER_DISCLOSURE_AMBIGUOUS',
  'MCP_CANVAS_REENTRY_TIMEOUT', 'PROVIDER_TEST_NOT_UNSUPPORTED',
  'GENERATION_CONFIRMATION_REJECTED', 'GENERATION_CONFIRMATION_UNRESOLVED',
  'GENERATION_ACTION_AMBIGUOUS', 'EXISTING_MEDIA_TASK_TIMEOUT',
  'GENERATION_SUBMISSION_UNCERTAIN',
  'GENERATION_CONFIRMATION_PENDING', 'TASK_CHECKPOINT_FAILED', 'TASK_CHECKPOINT_REQUIRED',
  'QA_MEDIA_SCOPE_EXCEEDED',
  'RESUME_MEDIA_TASK_INVALID', 'RESUME_MEDIA_TASK_AMBIGUOUS',
  'CODEX_APP_SERVER_TIMEOUT', 'CODEX_APP_SERVER_DISCONNECTED', 'CODEX_APP_SERVER_CLOSED',
  'CODEX_APP_SERVER_CONFIGURATION_INVALID', 'CODEX_APP_SERVER_PROTOCOL_INVALID',
  'CODEX_APP_SERVER_REQUEST_FAILED', 'CODEX_APP_SERVER_MCP_SCOPE_INVALID',
  'CODEX_APP_SERVER_MODEL_UNAVAILABLE',
  'CLIENT_CONFIRMATION_UNSUPPORTED', 'GENERATION_CONFIRMATION_UNRESOLVED',
  'PROVIDER_CONFIGURE_FORBIDDEN', 'PROVIDER_READ_FORBIDDEN', 'PROVIDER_DISCLOSURE_DENIED',
  'PROVIDER_DISCLOSURE_UNAVAILABLE', 'PROVIDER_FIELD_FORBIDDEN', 'PROVIDER_INPUT_MODE_FORBIDDEN',
  'PROVIDER_INPUT_REQUIRED', 'PROVIDER_STATE_INCOMPLETE', 'PROVIDER_DEFAULT_INVALID',
  'PROVIDER_ENDPOINT_INVALID', 'PROVIDER_MODELS_INVALID', 'PROVIDER_SETTINGS_INVALID',
  'PROVIDER_SETTINGS_MIGRATION_FAILED', 'PROVIDER_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'CREDENTIAL_READ_FAILED',
])
const safeJsonRpcErrorCodes = new Set([-32700, -32600, -32601, -32602, -32603])
const safeHttpStatusCodes = new Set([
  200, 201, 202, 204, 400, 401, 402, 403, 404, 405, 407, 408, 409, 413, 415, 422, 429,
  500, 501, 502, 503, 504, 507, 521, 522, 523, 524, 525, 529,
])
const diagnosticKeywordPatterns = {
  usage: /\busage\b|token usage/iu,
  limit: /\blimits?\b|rate[ _-]?limit|too many requests/iu,
  credits: /\bcredits?\b/iu,
  quota: /\bquota\b/iu,
  auth: /\bauth(?:entication|orization)?\b|unauthori[sz]ed|credential|oauth|logged in/iu,
  model: /\bmodels?\b/iu,
  schema: /\bschema\b/iu,
  tool: /\btools?\b|mcp tool/iu,
  approval: /\bapprov(?:al|e|ed|ing)\b|confirmation required/iu,
  policy: /\bpolicy\b|blocked by policy/iu,
  unsupported: /unsupported|not supported/iu,
  invalid: /\binvalid\b|malformed/iu,
  network: /network|connection (?:refused|reset|closed|timed out)|fetch failed|\beconn|\benotfound|\beai_again|proxy|dns|timed? out/iu,
}
const allowedTools = [
  'get_context', 'get_canvas_summary', 'get_selected_nodes', 'get_node_detail', 'list_models',
  'create_nodes', 'connect_nodes', 'prepare_generation', 'get_operation', 'check_task_status', 'read_task_output',
  'list_provider_configuration', 'configure_provider', 'test_provider_connection', 'get_provider_operation',
]
const envAllowlist = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'COMSPEC', 'CODEX_HOME',
]

function isAcceptanceHarnessEntry(moduleIsMain, runtime = process, argv = process.argv) {
  return moduleIsMain || Boolean(runtime.versions?.electron && runtime.type === 'browser' && argv.includes('--worker'))
}

function assertAcceptanceModeCompatibility(videoOnlyMode, resumeProjectArgument, isConfigurationOnly) {
  if (videoOnlyMode && (resumeProjectArgument || isConfigurationOnly)) {
    throw Object.assign(new Error('QA_ASSERTION_FAILED'), { code: 'QA_ASSERTION_FAILED' })
  }
}

function isVideoOnlyChainAccepted(snapshot, videoResult, previewMatchesTaskStore) {
  return snapshot?.imageTaskCount === 0 && snapshot?.imageNodeCount === 0
    && snapshot?.allImageTaskCount === 0 && snapshot?.videoTaskCount === 1
    && snapshot?.videoNodeCount === 1 && snapshot?.createdVideoNodeCount === 1
    && snapshot?.allVideoTaskCount === 1 && snapshot?.videoTaskSuccess === true
    && snapshot?.videoTaskOutputCount === 1 && snapshot?.videoReferencePresent === true
    && snapshot?.videoReferenceToTargetEdgeCount === 1
    && videoResult?.mediaRendered === true && videoResult?.visible === true
    && previewMatchesTaskStore === true
}

const codexDiagnosticMode = process.argv.includes('--diagnose-codex')
const configurationOnly = process.argv.includes('--configuration-only')
const appServerHost = process.argv.includes('--app-server-host')
const videoOnly = process.argv.includes('--video-only')
const executorPreauthorizedOneImageAndVideo = process.argv.includes('--allow-one-image-and-video')
const isEntry = isAcceptanceHarnessEntry(require.main === module)
let originalSecret = isEntry && !codexDiagnosticMode ? process.env[secretEnvName] : undefined
if (isEntry) delete process.env[secretEnvName]

async function readSecretFromStdin() {
  return new Promise((resolve, reject) => {
    let raw = ''
    const wasRaw = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function'
    const finish = (error, value) => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.pause()
      if (wasRaw) process.stdin.setRawMode(false)
      raw = ''
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') return finish(Object.assign(new Error('AGNES_KEY_INPUT_CANCELLED'), { code: 'AGNES_KEY_INPUT_CANCELLED' }))
        if (char === '\r' || char === '\n') return finish(null, raw)
        if (char === '\b' || char === '\u007f') raw = raw.slice(0, -1)
        else raw += char
        if (raw.length > 16_384) return finish(Object.assign(new Error('AGNES_KEY_INPUT_TOO_LARGE'), { code: 'AGNES_KEY_INPUT_TOO_LARGE' }))
      }
    }
    const onEnd = () => finish(null, raw.replace(/[\r\n]+$/u, ''))
    if (wasRaw) {
      process.stdin.setRawMode(true)
      process.stdout.write('QA_STATUS WAITING_CREDENTIAL_NO_ECHO\n')
    }
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.resume()
  })
}

function safeErrorCode(error, fallback = 'QA_ASSERTION_FAILED') {
  return typeof error?.code === 'string' && safeErrorCodes.has(error.code) ? error.code : fallback
}

function safeStatus(value) {
  return typeof value === 'string' && safeStatuses.has(value.toLowerCase()) ? value.toLowerCase() : null
}

function emptyDiagnosticKeywordFlags() {
  return Object.fromEntries(Object.keys(diagnosticKeywordPatterns).map((name) => [name, false]))
}

function classifyDiagnosticKeywords(value, flags) {
  const text = String(value || '').slice(-16_384)
  for (const [name, pattern] of Object.entries(diagnosticKeywordPatterns)) {
    if (pattern.test(text)) flags[name] = true
  }
}

function observeHttpStatuses(value, statuses) {
  const pattern = /\b(?:http(?:\/[0-9.]+)?|status(?:[_ ]?code)?|response[_ ]code)\s*[:= ]\s*(\d{3})\b/giu
  let unknown = false
  for (const match of String(value || '').matchAll(pattern)) {
    const status = Number(match[1])
    if (safeHttpStatusCodes.has(status)) statuses.add(status)
    else unknown = true
  }
  return unknown
}

function findInstalledCommand(command) {
  try {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
    const output = execFileSync(lookup, [command], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return output.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || null
  } catch { return null }
}

function resolveCodexExecutable() {
  const override = process.env.VIBEPAPER_ACCEPTANCE_CODEX_CLI
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim())
  const installed = findInstalledCommand('codex')
  if (!installed) throw Object.assign(new Error('CODEX_CLI_NOT_FOUND'), { code: 'CODEX_CLI_NOT_FOUND' })
  if (process.platform !== 'win32' || path.extname(installed).toLowerCase() === '.exe') return installed
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const native = path.join(path.dirname(installed), 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
    `codex-win32-${architecture}`, 'vendor', triple, 'bin', 'codex.exe')
  if (!fsSync.existsSync(native)) throw Object.assign(new Error('CODEX_NATIVE_BINARY_NOT_FOUND'), { code: 'CODEX_NATIVE_BINARY_NOT_FOUND' })
  return native
}

function safeProxyAddress(configured) {
  if (typeof configured !== 'string' || !configured.trim()) return null
  try {
    const value = configured.trim()
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`
    const proxy = new URL(candidate)
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol) || !proxy.hostname) return null
    // Do not forward embedded proxy credentials.
    if (proxy.username || proxy.password) return null
    return `${proxy.protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ''}`
  } catch { return null }
}

function systemProxyEnvironment() {
  if (process.platform !== 'win32') return {}
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  try {
    const enabled = execFileSync('reg.exe', ['query', key, '/v', 'ProxyEnable'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!/\b0x1\b/iu.test(enabled)) return {}
    const output = execFileSync('reg.exe', ['query', key, '/v', 'ProxyServer'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const raw = output.match(/ProxyServer\s+REG_SZ\s+(.+)$/imu)?.[1]?.trim()
    if (!raw) return {}
    const entries = raw.includes('=')
      ? Object.fromEntries(raw.split(';').map((part) => part.split(/=(.*)/su).slice(0, 2)).filter(([name, address]) => name && address))
      : { http: raw, https: raw }
    const result = {}
    for (const [name, keyName] of [['HTTP_PROXY', 'http'], ['HTTPS_PROXY', 'https']]) {
      const address = safeProxyAddress(entries[keyName])
      if (address) result[name] = address
    }
    return result
  } catch { return {} }
}

function buildCodexEnvironment(secret) {
  const environment = {}
  for (const name of envAllowlist) if (typeof process.env[name] === 'string') environment[name] = process.env[name]
  let systemProxyAddressProvided = false
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    const address = safeProxyAddress(process.env[name] || process.env[name.toLowerCase()])
    if (address) {
      environment[name] = address
      environment[name.toLowerCase()] = address
    }
  }
  const configuredSystemProxy = systemProxyEnvironment()
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY']) {
    if (environment[name] || !configuredSystemProxy[name]) continue
    environment[name] = configuredSystemProxy[name]
    environment[name.toLowerCase()] = configuredSystemProxy[name]
    systemProxyAddressProvided = true
  }
  for (const name of ['NO_PROXY', 'no_proxy']) if (typeof process.env[name] === 'string') environment[name] = process.env[name]
  // The key is inherited only by the Codex child so the stdio bridge can
  // resolve the explicitly granted environment mapping. It is never part of
  // the exported MCP config or any command-line argument.
  environment[secretEnvName] = secret
  return { environment, systemProxyAddressProvided }
}

function parseCodexConfig(configText) {
  const match = String(configText).match(/\[mcp_servers\.vibepaper\]([\s\S]*?)(?:\r?\n\[|$)/u)
  if (!match) throw Object.assign(new Error('CODEX_MCP_CONFIG_UNAVAILABLE'), { code: 'CODEX_MCP_CONFIG_UNAVAILABLE' })
  const command = match[1].match(/^command\s*=\s*(.+)$/mu)
  const args = match[1].match(/^args\s*=\s*(.+)$/mu)
  if (!command || !args) throw Object.assign(new Error('CODEX_MCP_CONFIG_INVALID'), { code: 'CODEX_MCP_CONFIG_INVALID' })
  const server = { command: JSON.parse(command[1]), args: JSON.parse(args[1]), env: {} }
  const env = String(configText).match(/\[mcp_servers\.vibepaper\.env\]([\s\S]*?)(?:\r?\n\[|$)/u)
  for (const line of (env?.[1] || '').split(/\r?\n/u)) {
    const entry = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/u)
    if (entry) server.env[entry[1]] = JSON.parse(entry[2])
  }
  const entryPath = path.join(root, 'pi-paper-desktop/src/mcp-node-entry.cjs')
  if (!path.isAbsolute(server.command) || !Array.isArray(server.args)
    || server.args[0] !== entryPath || server.env.ELECTRON_RUN_AS_NODE !== '1') {
    throw Object.assign(new Error('CODEX_MCP_CONFIG_INVALID'), { code: 'CODEX_MCP_CONFIG_INVALID' })
  }
  return server
}

function toolsForCodexStage(stage) {
  const readOnlyTools = allowedTools.filter((name) => ![
    'create_nodes', 'connect_nodes', 'prepare_generation', 'configure_provider', 'test_provider_connection',
  ].includes(name))
  if (['configuration', 'configuration-resume'].includes(stage)) {
    return [...readOnlyTools, 'configure_provider', 'test_provider_connection']
  }
  if (['image', 'video'].includes(stage)) return [...readOnlyTools, 'create_nodes', 'connect_nodes', 'prepare_generation']
  return readOnlyTools
}

function buildCodexOverride(server, fixtureRoot, stage) {
  const env = { ...server.env, APPDATA: fixtureRoot }
  for (const name of [
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AZURE_OPENAI_API_KEY', 'GOOGLE_API_KEY',
    'GEMINI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'ARK_API_KEY', 'DOUBAO_API_KEY', 'VIBEPAPER_PROVIDER_API_KEY',
  ]) env[name] = ''
  const envToml = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')
  const argsToml = server.args.map((value) => JSON.stringify(value)).join(',')
  const toolsToml = toolsForCodexStage(stage).map((value) => JSON.stringify(value)).join(',')
  const serverValue = `{command=${JSON.stringify(server.command)},args=[${argsToml}],env={${envToml}},env_vars=[${JSON.stringify(secretEnvName)}],enabled_tools=[${toolsToml}],required=true,startup_timeout_sec=150,tool_timeout_sec=660,default_tools_approval_mode="approve"}`
  return {
    override: `mcp_servers.vibepaper=${serverValue}`,
    bridgeAppDataIsolated: env.APPDATA === fixtureRoot,
  }
}

function createSafeStderrClassifier() {
  const keywordFlags = emptyDiagnosticKeywordFlags()
  const httpStatusCodes = new Set()
  let unknownHttpStatusCodeObserved = false
  const flags = {
    mcpStartupFailure: false,
    mcpHandshakeFailure: false,
    mcpHandshakeTimeout: false,
    mcpConfigurationFailure: false,
    mcpSchemaFailure: false,
    authenticationFailure: false,
    networkFailure: false,
    quotaOrBillingFailure: false,
  }
  let tail = ''

  function inspect(value) {
    const text = `${tail}${value}`.slice(-4096).toLowerCase()
    classifyDiagnosticKeywords(text, keywordFlags)
    unknownHttpStatusCodeObserved ||= observeHttpStatuses(text, httpStatusCodes)
    const handshakeMentioned = /(?:mcp.{0,80}(?:handshake|initiali[sz](?:e|ation))|(?:handshake|initiali[sz](?:e|ation)).{0,80}mcp)/u.test(text)
    const failed = /(?:fail(?:ed|ure)?|error|closed|disconnect(?:ed)?|reject(?:ed)?|crash(?:ed)?)/u.test(text)
    const timedOut = /(?:timed?\s*out|timeout|deadline exceeded)/u.test(text)
    const mcpMentioned = /\bmcp\b|mcp server|mcp_servers/u.test(text)

    if (mcpMentioned && /(?:server.{0,80}(?:start(?:up)?|spawn|launch|exit|fail|failure|error)|(?:start(?:up)?|spawn|launch|exit|fail|failure|error).{0,80}server)/u.test(text)) {
      flags.mcpStartupFailure = true
    }
    if (handshakeMentioned && timedOut) flags.mcpHandshakeTimeout = true
    if (handshakeMentioned && failed) flags.mcpHandshakeFailure = true
    if (/(?:invalid|malformed|parse|failed to read|could not read).{0,80}(?:mcp|server|config|configuration)|(?:mcp|server|config|configuration).{0,80}(?:invalid|malformed|parse error|failed to parse)/u.test(text)) {
      flags.mcpConfigurationFailure = true
    }
    if (/(?:schema.{0,80}(?:invalid|error|fail)|(?:invalid|malformed).{0,80}(?:tool|input|argument|schema)|validation error)/u.test(text)) {
      flags.mcpSchemaFailure = true
    }
    if (/(?:unauthori[sz]ed|authentication failed|authentication required|not logged in|invalid (?:api )?key|credential.{0,30}(?:missing|invalid|expired)|oauth.{0,30}(?:invalid|expired))/u.test(text)) {
      flags.authenticationFailure = true
    }
    if (/(?:econn(?:refused|reset|aborted)?|eai_again|enotfound|fetch failed|network error|connection (?:refused|reset|timed out)|dns.{0,30}(?:fail|error)|proxy.{0,30}(?:fail|error)|timed?\s*out)/u.test(text)) {
      flags.networkFailure = true
    }
    if (/(?:quota|insufficient[_ ]quota|billing|payment required|rate[ -]?limit|too many requests|out of credits)/u.test(text)) {
      flags.quotaOrBillingFailure = true
    }
    tail = text.slice(-1536)
  }

  return {
    accept(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')
      if (value) inspect(value)
    },
    summary() { return { ...flags, keywordFlags: { ...keywordFlags },
      httpStatusCodes: [...httpStatusCodes].sort((a, b) => a - b), unknownHttpStatusCodeObserved } },
    clear() { tail = '' },
  }
}

function createCodexDiagnosticCapture() {
  const keywordFlags = emptyDiagnosticKeywordFlags()
  const httpStatusCodes = new Set()
  const eventTypeCounts = Object.create(null)
  const allowedTypes = new Set(['turn.started', 'turn.completed', 'turn.failed', 'result', 'error',
    'turn.error', 'mcp_tool_call', 'mcp_tool_call.failed', 'item.started', 'item.completed', 'item.failed'])
  const tails = { stdout: '', stderr: '' }
  let stdoutBuffer = ''
  let unknownHttpStatusCodeObserved = false
  let stdoutParseTruncated = false
  let turnCompleted = false
  let errorEventSeen = false
  let assistantMessageObserved = false
  let toolEventObserved = false

  function scan(text, stream) {
    const combined = `${tails[stream]}${String(text || '')}`.slice(-16_384)
    classifyDiagnosticKeywords(combined, keywordFlags)
    unknownHttpStatusCodeObserved ||= observeHttpStatuses(combined, httpStatusCodes)
    tails[stream] = combined.slice(-4096)
  }

  function visitEvent(line) {
    try {
      const event = JSON.parse(line)
      const type = typeof event?.type === 'string' && allowedTypes.has(event.type) ? event.type : 'other'
      eventTypeCounts[type] = (eventTypeCounts[type] || 0) + 1
      if (type === 'turn.completed' || type === 'result') turnCompleted = true
      if (['error', 'turn.error', 'turn.failed'].includes(type)
        || (type === 'result' && (event.is_error === true || event.isError === true))) errorEventSeen = true
      if (type === 'mcp_tool_call' || type === 'mcp_tool_call.failed'
        || ['item.started', 'item.completed', 'item.failed'].includes(type) && event.item?.type === 'mcp_tool_call') {
        toolEventObserved = true
      }
      if (['item.started', 'item.completed', 'item.failed'].includes(type)
        && ['agent_message', 'assistant_message'].includes(event.item?.type)) assistantMessageObserved = true
    } catch { /* Structured event details are never retained. */ }
  }

  function acceptStdout(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')
    scan(text, 'stdout')
    stdoutBuffer += text
    let index
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      visitEvent(stdoutBuffer.slice(0, index).trim())
      stdoutBuffer = stdoutBuffer.slice(index + 1)
    }
    if (stdoutBuffer.length > 2_000_000) {
      stdoutBuffer = stdoutBuffer.slice(-1_000_000)
      stdoutParseTruncated = true
    }
  }

  return {
    acceptStdout,
    acceptStderr(chunk) {
      scan(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''), 'stderr')
    },
    finish() {
      if (stdoutBuffer.trim()) visitEvent(stdoutBuffer.trim())
      stdoutBuffer = ''
    },
    summary() {
      return {
        keywordFlags: { ...keywordFlags },
        httpStatusCodes: [...httpStatusCodes].sort((a, b) => a - b),
        unknownHttpStatusCodeObserved,
        turnCompleted,
        errorEventSeen,
        assistantMessageObserved,
        toolEventObserved,
        eventTypeCounts: { ...eventTypeCounts },
        stdoutParseTruncated,
      }
    },
  }
}

function assertCodexDiagnosticDirectory(candidate) {
  const basePath = path.resolve(temporaryBase)
  const candidatePath = path.resolve(candidate)
  if (path.dirname(candidatePath) !== basePath || !path.basename(candidatePath).startsWith('codex-diagnostic-')) {
    throw Object.assign(new Error('TEMP_PATH_OUTSIDE_ACCEPTANCE_ROOT'), { code: 'TEMP_PATH_OUTSIDE_ACCEPTANCE_ROOT' })
  }
  return candidatePath
}

async function runCodexDiagnostic() {
  originalSecret = undefined
  delete process.env[secretEnvName]
  const diagnosticDirectory = assertCodexDiagnosticDirectory(
    path.join(temporaryBase, `codex-diagnostic-${randomUUID()}`))
  let directoryCreated = false
  let child = null
  let timedOut = false
  let processSpawnError = false
  let exitCode = null
  let terminationSignal = null
  let capture = createCodexDiagnosticCapture()
  let systemProxyAddressProvided = false
  try {
    await fs.mkdir(temporaryBase, { recursive: true })
    await fs.mkdir(diagnosticDirectory, { recursive: false })
    directoryCreated = true
    const executable = resolveCodexExecutable()
    const builtEnvironment = buildCodexEnvironment('')
    const environment = builtEnvironment.environment
    systemProxyAddressProvided = builtEnvironment.systemProxyAddressProvided
    delete environment[secretEnvName]
    const args = [
      '--ask-for-approval', 'on-request',
      'exec', '--ignore-user-config', '--ephemeral', '--disable', 'shell_tool',
      '--sandbox', 'read-only', '--json', '--skip-git-repo-check', '--cd', diagnosticDirectory,
      '请仅回复连接正常',
    ]
    child = spawn(executable, args, { cwd: diagnosticDirectory, env: environment,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    let timeout
    const result = await new Promise((resolve) => {
      const finish = (code, signal, spawnError) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        capture.finish()
        exitCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null
        terminationSignal = ['SIGINT', 'SIGTERM', 'SIGKILL', 'spawn-error'].includes(signal) ? signal : null
        processSpawnError = spawnError === true
        resolve(capture.summary())
      }
      child.stdout?.on('data', (chunk) => capture.acceptStdout(chunk))
      child.stderr?.on('data', (chunk) => capture.acceptStderr(chunk))
      child.once('error', () => finish(null, 'spawn-error', true))
      child.once('close', (code, signal) => finish(code, signal, false))
      timeout = setTimeout(() => {
        timedOut = true
        if (process.platform === 'win32' && Number.isInteger(child.pid)) {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.unref()
        } else child.kill('SIGTERM')
      }, 120_000)
      timeout.unref()
    })
    console.log(JSON.stringify({ diagnostic: 'codex-cli-connectivity', ...result,
      exitCode, terminationSignal, timedOut, processSpawnError, systemProxyAddressProvided,
      rawOutputSaved: false, promptSaved: false, environmentValuesSaved: false,
      mediaKeyProvided: false, electronStarted: false, mcpServerConfigured: false }))
  } catch {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    console.log(JSON.stringify({ diagnostic: 'codex-cli-connectivity', ...capture.summary(),
      exitCode, terminationSignal, timedOut, processSpawnError: true, systemProxyAddressProvided,
      rawOutputSaved: false, promptSaved: false, environmentValuesSaved: false,
      mediaKeyProvided: false, electronStarted: false, mcpServerConfigured: false }))
    process.exitCode = 1
  } finally {
    if (directoryCreated) await fs.rm(diagnosticDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

function createSafeTraceParser() {
  const toolNames = new Set()
  const toolCalls = Object.create(null)
  const toolStatuses = Object.create(null)
  const toolIsErrors = Object.create(null)
  const errorCodes = new Set()
  const jsonRpcErrorCodes = new Set()
  const httpStatusCodes = new Set()
  const seenCallIds = new Set()
  const seenPreviewCallIds = new Set()
  const eventTypeCounts = Object.create(null)
  const allowedEventTypes = new Set([
    'thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.completed',
    'item.updated', 'item.failed', 'error', 'turn.error', 'result', 'mcp_tool_call', 'mcp_tool_call.failed',
    'tool_use', 'assistant.message',
  ])
  const assistantMessageFlags = {
    messageObserved: false,
    noToolsAvailable: false,
    needsKey: false,
    awaitingUserAction: false,
  }
  const toolFailureFlags = {
    timeout: false,
    unknownSourceRef: false,
    environmentValueMissing: false,
    credentialSourceUnavailable: false,
    validationFailure: false,
    approvalDenied: false,
    transportFailure: false,
    otherFailure: false,
    policyBlocked: false,
    toolCallRejected: false,
    notPermitted: false,
    unsupported: false,
  }
  const cliErrorEventFlags = { ...toolFailureFlags }
  const toolErrorKeywordFlags = emptyDiagnosticKeywordFlags()
  const cliErrorKeywordFlags = emptyDiagnosticKeywordFlags()
  let eventCount = 0
  let turnCompleted = false
  let errorEventSeen = false
  let unknownJsonRpcErrorCode = false
  let unknownHttpStatusCodeObserved = false
  let previewReadCalls = 0

  function observeJsonRpcErrorCode(value) {
    const candidates = [value?.error?.code, value?.result?.error?.code,
      value?.structuredContent?.error?.code, value?.structured_content?.error?.code,
      value?.result?.structuredContent?.error?.code, value?.result?.structured_content?.error?.code,
      value?.item?.error?.code]
    const numericCode = candidates.find((candidate) => Number.isInteger(candidate))
    if (numericCode === undefined) return
    if (safeJsonRpcErrorCodes.has(numericCode)) jsonRpcErrorCodes.add(numericCode)
    else unknownJsonRpcErrorCode = true
  }

  function classifyFailure(value, flags, keywordFlags) {
    const parts = []
    const visitError = (entry, depth = 0) => {
      if (depth > 3 || parts.length >= 16 || entry === null || entry === undefined) return
      if (typeof entry === 'string') { parts.push(entry.slice(0, 2048)); return }
      if (typeof entry !== 'object') return
      if (Array.isArray(entry)) { for (const child of entry.slice(0, 8)) visitError(child, depth + 1); return }
      for (const key of ['code', 'type', 'name', 'message', 'error', 'data', 'cause', 'details']) {
        if (Object.hasOwn(entry, key)) visitError(entry[key], depth + 1)
      }
    }
    visitError(value)
    const text = parts.join(' ').toLowerCase()
    const eventKeywordFlags = emptyDiagnosticKeywordFlags()
    classifyDiagnosticKeywords(text, eventKeywordFlags)
    for (const [name, matched] of Object.entries(eventKeywordFlags)) if (matched) keywordFlags[name] = true
    const keywordMatched = Object.values(eventKeywordFlags).some(Boolean)
    unknownHttpStatusCodeObserved ||= observeHttpStatuses(text, httpStatusCodes)
    const code = typeof value?.code === 'string' ? value.code.toUpperCase() : ''
    let classified = keywordMatched
    if (/(?:timeout|timed out|deadline exceeded|etimedout)/u.test(text) || ['REQUEST_TIMEOUT', 'CODEX_STAGE_TIMEOUT'].includes(code)) {
      flags.timeout = true; classified = true
    }
    if (/(?:unknown|invalid|expired).{0,40}(?:credential )?source(?:ref)?|source(?:ref)?.{0,40}(?:unknown|invalid|expired)/u.test(text)
      || code === 'CREDENTIAL_SOURCE_INVALID') { flags.unknownSourceRef = true; classified = true }
    if (/(?:environment|env) variable.{0,40}(?:missing|not set|empty|unavailable)|(?:missing|not set|empty).{0,40}(?:environment|env) variable/u.test(text)) {
      flags.environmentValueMissing = true; classified = true
    }
    if (/(?:credential source unavailable|credential.{0,30}(?:missing|unavailable|empty))/u.test(text)
      || code === 'CREDENTIAL_SOURCE_UNAVAILABLE') { flags.credentialSourceUnavailable = true; classified = true }
    if (/(?:invalid[_ ]input|invalid argument|validation(?: error| failed)?|schema.{0,30}(?:invalid|error)|malformed.{0,30}(?:argument|input)|missing required)/u.test(text)
      || ['INVALID_INPUT', 'PROVIDER_CONFIGURATION_INVALID'].includes(code)) { flags.validationFailure = true; classified = true }
    if (/(?:approval|disclosure).{0,40}(?:denied|rejected|declined)|(?:permission|authorization).{0,40}(?:denied|rejected|forbidden)|not approved/u.test(text)
      || ['PERMISSION_DENIED', 'PROVIDER_DISCLOSURE_DENIED', 'CONNECTION_NOT_APPROVED'].includes(code)) { flags.approvalDenied = true; classified = true }
    if (/(?:transport|network|fetch failed|connection (?:refused|reset|closed|timed out)|socket|rpc.{0,30}(?:failed|error)|http.{0,20}(?:failed|error)|econn|enotfound|eai_again)/u.test(text)
      || ['CLOUD_REQUEST_FAILED', 'MCP_REQUEST_FAILED', 'MCP_TRANSPORT_FAILED'].includes(code)) { flags.transportFailure = true; classified = true }
    if (/(?:blocked|rejected|denied|prevented).{0,50}(?:policy|approval policy)|(?:policy|approval policy).{0,50}(?:blocked|rejected|denied|prevented)/u.test(text)) {
      flags.policyBlocked = true; classified = true
    }
    if (/(?:tool.{0,24}(?:call|invocation).{0,40}(?:reject|denied|failed)|(?:reject|denied).{0,40}tool.{0,24}(?:call|invocation))/u.test(text)) {
      flags.toolCallRejected = true; classified = true
    }
    if (/(?:not permitted|not allowed|forbidden|permission denied)/u.test(text)) {
      flags.notPermitted = true; classified = true
    }
    if (/(?:unsupported|not supported|does not support)/u.test(text)) {
      flags.unsupported = true; classified = true
    }
    return classified
  }

  function record(name, item, eventType = '') {
    const normalized = typeof name === 'string' && name.startsWith('mcp__vibepaper__')
      ? name.slice('mcp__vibepaper__'.length) : name
    if (!allowedTools.includes(normalized)) return
    toolNames.add(normalized)
    const callId = [item.id, item.call_id, item.tool_call_id].find((value) => typeof value === 'string' && value.length <= 160)
    const callKey = callId ? `${normalized}:${callId}` : null
    const isCallStart = !eventType || eventType === 'mcp_tool_call' || eventType === 'tool_use' || eventType === 'item.started'
    if (callKey) {
      if (isCallStart && !seenCallIds.has(callKey)) {
        seenCallIds.add(callKey)
        toolCalls[normalized] = (toolCalls[normalized] || 0) + 1
      }
    } else if (isCallStart) toolCalls[normalized] = (toolCalls[normalized] || 0) + 1
    if (normalized === 'read_task_output') {
      let args = item.arguments || item.input || item.params?.arguments
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = null } }
      if (args?.mode === 'preview' && (callKey ? !seenPreviewCallIds.has(callKey) : isCallStart)) {
        if (callKey) seenPreviewCallIds.add(callKey)
        previewReadCalls += 1
      }
    }
    const status = safeStatus(item.status || item.result?.status || item.structuredContent?.status)
    if (status) toolStatuses[normalized] = status
    const isError = [item.isError, item.is_error, item.result?.isError, item.result?.is_error,
      item.structuredContent?.isError, item.structuredContent?.is_error].find((value) => typeof value === 'boolean')
    if (typeof isError === 'boolean') toolIsErrors[normalized] = isError
    const code = [item.errorCode, item.error_code, item.error?.code, item.result?.errorCode,
      item.structuredContent?.errorCode].find((value) => safeErrorCodes.has(value))
    if (code) errorCodes.add(code)
    if (status === 'failed' || item.error !== undefined) {
      if (!classifyFailure(item.error ?? item, toolFailureFlags, toolErrorKeywordFlags)) toolFailureFlags.otherFailure = true
    }
  }

  function recordAssistantMessage(item) {
    if (!item || !['agent_message', 'assistant_message', 'assistant.message', 'assistant'].includes(item.type)) return
    const text = [item.text, item.content, item.output_text]
      .filter((value) => typeof value === 'string')
      .join('\n')
      .slice(0, 16_384)
      .toLowerCase()
    assistantMessageFlags.messageObserved = true
    if (/(?:\bno tools? available\b|\bno mcp tools?\b|没有可用工具|无法使用工具|未提供.{0,8}工具)/u.test(text)) {
      assistantMessageFlags.noToolsAvailable = true
    }
    if (/(?:\b(?:api[ _-]?key|credential).{0,40}\b(?:required|missing|provide|needed)\b|\b(?:need|needs|require|requires).{0,40}(?:api[ _-]?key|credential)|(?:需要|缺少|提供).{0,8}(?:api[ _-]?key|凭据|密钥))/u.test(text)) {
      assistantMessageFlags.needsKey = true
    }
    if (/(?:\bwaiting for.{0,40}(?:approval|confirmation|user action)\b|\bplease (?:approve|confirm)\b|\bawaiting.{0,40}(?:approval|confirmation)\b|等待.{0,12}(?:确认|批准)|请在桌面.{0,16}确认)/u.test(text)) {
      assistantMessageFlags.awaitingUserAction = true
    }
  }

  function visit(value) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    observeJsonRpcErrorCode(value)
    const type = typeof value.type === 'string' ? value.type : ''
    if (type === 'turn.completed' || type === 'result') turnCompleted = true
    if (type === 'error' || type === 'turn.error' || type === 'turn.failed'
      || (type === 'result' && (value.is_error === true || value.isError === true))) errorEventSeen = true
    if (type === 'mcp_tool_call' || type === 'mcp_tool_call.failed' || type === 'tool_use') {
      record(value.tool_name || value.toolName || value.name || value.tool, value, type)
      if (type === 'mcp_tool_call.failed'
        && !classifyFailure(value.error ?? value, toolFailureFlags, toolErrorKeywordFlags)) toolFailureFlags.otherFailure = true
    }
    if (['item.started', 'item.completed', 'item.updated', 'item.failed'].includes(type) && value.item?.type === 'mcp_tool_call') {
      const nested = value.item
      record(nested.tool_name || nested.toolName || nested.name || nested.tool, nested, type)
      if (nested.status === 'failed' || nested.error !== undefined) {
        if (!classifyFailure(nested.error ?? nested, toolFailureFlags, toolErrorKeywordFlags)) toolFailureFlags.otherFailure = true
      }
    }
    if (['error', 'turn.error', 'turn.failed'].includes(type)
      && !classifyFailure(value.error ?? value.message ?? value, cliErrorEventFlags, cliErrorKeywordFlags)) {
      cliErrorEventFlags.otherFailure = true
    }
    if (['item.started', 'item.completed', 'item.updated', 'item.failed'].includes(type)) recordAssistantMessage(value.item)
    for (const child of Object.values(value)) visit(child)
  }

  return {
    accept(line) {
      if (typeof line !== 'string' || line.length > 2_000_000) return
      let event
      try { event = JSON.parse(line) } catch { return }
      eventCount += 1
      const rawType = typeof event?.type === 'string' ? event.type : 'other'
      const safeType = allowedEventTypes.has(rawType) ? rawType : 'other'
      eventTypeCounts[safeType] = (eventTypeCounts[safeType] || 0) + 1
      if (safeType === 'assistant.message') recordAssistantMessage(event)
      visit(event)
    },
    summary() {
      return {
        toolNames: [...toolNames].sort(), toolCalls: { ...toolCalls }, toolStatuses: { ...toolStatuses },
        toolIsErrors: { ...toolIsErrors }, errorCodes: [...errorCodes].sort(), previewReadCalls, eventCount,
        jsonRpcErrorCodes: [...jsonRpcErrorCodes].sort((a, b) => a - b), unknownJsonRpcErrorCode,
        httpStatusCodes: [...httpStatusCodes].sort((a, b) => a - b), unknownHttpStatusCodeObserved,
        turnCompleted, errorEventSeen, eventTypeCounts: { ...eventTypeCounts },
        assistantMessageFlags: { ...assistantMessageFlags }, toolFailureFlags: { ...toolFailureFlags },
        cliErrorEventFlags: { ...cliErrorEventFlags }, toolErrorKeywordFlags: { ...toolErrorKeywordFlags },
        cliErrorKeywordFlags: { ...cliErrorKeywordFlags },
      }
    },
  }
}

function ensureWithinTemporaryBase(candidate) {
  const basePath = path.resolve(temporaryBase)
  const candidatePath = path.resolve(candidate)
  const relative = path.relative(basePath, candidatePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(candidatePath).startsWith('mcp-codex-agnes-')) {
    throw Object.assign(new Error('TEMP_PATH_OUTSIDE_ACCEPTANCE_ROOT'), { code: 'TEMP_PATH_OUTSIDE_ACCEPTANCE_ROOT' })
  }
  return candidatePath
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

function describeResumeMediaProjectPath(candidate, workspaceRoot = root) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null
  const workspace = path.resolve(workspaceRoot)
  const acceptanceRoot = path.join(workspace, '.test-temp')
  const projectDirectory = path.resolve(candidate)
  const relative = path.relative(acceptanceRoot, projectDirectory)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const segments = relative.split(path.sep)
  if (segments.length !== 3 || !/^mcp-codex-agnes-[A-Za-z0-9._-]+$/iu.test(segments[0])
    || segments[1].toLowerCase() !== 'project' || !segments[2] || segments[2] === '.' || segments[2] === '..') return null
  return {
    projectDirectory,
    runRoot: path.join(acceptanceRoot, segments[0]),
    sourceRunName: segments[0],
  }
}

function invalidResumeMediaProjectPath() {
  throw Object.assign(new Error('TEMP_PATH_OUTSIDE_ACCEPTANCE_ROOT'), { code: 'TEMP_PATH_OUTSIDE_ACCEPTANCE_ROOT' })
}

async function assertRealDirectory(directory) {
  const info = await fs.lstat(directory).catch(() => null)
  if (!info?.isDirectory() || info.isSymbolicLink()) invalidResumeMediaProjectPath()
  const real = await fs.realpath(directory).catch(() => null)
  if (!real || !samePath(real, directory)) invalidResumeMediaProjectPath()
}

async function assertSafeProjectFile(filePath, required) {
  const info = await fs.lstat(filePath).catch((error) => error?.code === 'ENOENT' ? null : invalidResumeMediaProjectPath())
  if (!info) {
    if (required) invalidResumeMediaProjectPath()
    return false
  }
  if (!info.isFile() || info.isSymbolicLink()) invalidResumeMediaProjectPath()
  const real = await fs.realpath(filePath).catch(() => null)
  if (!real || !samePath(real, filePath)) invalidResumeMediaProjectPath()
  return true
}

async function validateResumeMediaProjectPath(candidate, workspaceRoot = root) {
  const description = describeResumeMediaProjectPath(candidate, workspaceRoot)
  if (!description) invalidResumeMediaProjectPath()

  const workspace = path.resolve(workspaceRoot)
  const relative = path.relative(workspace, description.projectDirectory)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) invalidResumeMediaProjectPath()
  let current = workspace
  await assertRealDirectory(current)
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    await assertRealDirectory(current)
  }

  const dataDirectory = path.join(description.projectDirectory, '.vibepaper')
  await assertRealDirectory(dataDirectory)
  await assertSafeProjectFile(path.join(dataDirectory, 'project.json'), true)
  const hasDatabase = await assertSafeProjectFile(path.join(dataDirectory, 'project.sqlite'), false)
  const hasLegacyCanvas = await assertSafeProjectFile(path.join(dataDirectory, 'canvas.json'), false)
  if (!hasDatabase && !hasLegacyCanvas) invalidResumeMediaProjectPath()
  for (const storageName of ['project.lock', 'project.lock.recovery', 'project.sqlite-wal', 'project.sqlite-shm']) {
    await assertSafeProjectFile(path.join(dataDirectory, storageName), false)
  }
  return description
}

function readResumeMediaProjectArgument(argv = process.argv) {
  const matches = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--resume-media-project') matches.push(index)
  }
  if (matches.length === 0) return null
  if (matches.length !== 1) invalidResumeMediaProjectPath()
  const index = matches[0]
  const value = argv[index + 1]
  if (typeof value !== 'string' || !value || value.startsWith('--')) invalidResumeMediaProjectPath()
  return value
}

function classifyResumeMediaSnapshot(canvas, tasks) {
  const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : []
  const edges = Array.isArray(canvas?.edges) ? canvas.edges : []
  const allTasks = Array.isArray(tasks) ? tasks : []
  if (allTasks.length >= 500) {
    throw Object.assign(new Error('RESUME_MEDIA_TASK_AMBIGUOUS'), { code: 'RESUME_MEDIA_TASK_AMBIGUOUS' })
  }
  const imageTasks = allTasks.filter((task) => task?.modality === 'image')
  const videoTasks = allTasks.filter((task) => task?.modality === 'video')
  const outputIsValid = (task) => {
    if (!Array.isArray(task?.outputs) || task.outputs.length !== 1) return false
    const output = task.outputs[0]
    return /^[a-f0-9]{64}$/iu.test(output?.sha256 || '')
      && Number.isSafeInteger(output?.sizeBytes) && output.sizeBytes > 0
  }
  if (imageTasks.length !== 1 || imageTasks[0]?.status !== 'succeeded' || !outputIsValid(imageTasks[0])) {
    throw Object.assign(new Error('RESUME_MEDIA_TASK_INVALID'), { code: 'RESUME_MEDIA_TASK_INVALID' })
  }
  const imageTask = imageTasks[0]
  const imageNodes = nodes.filter((node) => node?.type === 'image')
  const imageNode = nodes.find((node) => node?.id === imageTask.nodeId && node?.type === 'image')
  const incomingEdges = edges.filter((edge) => (edge?.targetNodeId || edge?.target) === imageTask.nodeId)
  const referenceNode = incomingEdges.length === 1
    ? nodes.find((node) => node?.id === (incomingEdges[0].sourceNodeId || incomingEdges[0].source))
    : null
  if (imageNodes.length !== 1 || !imageNode || referenceNode?.type !== 'text') {
    throw Object.assign(new Error('RESUME_MEDIA_TASK_INVALID'), { code: 'RESUME_MEDIA_TASK_INVALID' })
  }

  if (videoTasks.length > 1) {
    throw Object.assign(new Error('RESUME_MEDIA_TASK_AMBIGUOUS'), { code: 'RESUME_MEDIA_TASK_AMBIGUOUS' })
  }
  const videoTask = videoTasks[0] || null
  const videoNode = videoTask
    ? nodes.find((node) => node?.id === videoTask.nodeId && node?.type === 'video')
    : null
  const videoNodes = nodes.filter((node) => node?.type === 'video')
  if (videoTask) {
    const status = videoTask.status
    if (videoNodes.length !== 1 || !videoNode || !['queued', 'running', 'succeeded'].includes(status)
      || status === 'succeeded' && !outputIsValid(videoTask)) {
      throw Object.assign(new Error('RESUME_MEDIA_TASK_AMBIGUOUS'), { code: 'RESUME_MEDIA_TASK_AMBIGUOUS' })
    }
  } else if (videoNodes.length > 1) {
    throw Object.assign(new Error('RESUME_MEDIA_TASK_AMBIGUOUS'), { code: 'RESUME_MEDIA_TASK_AMBIGUOUS' })
  }

  return {
    existingMediaTaskCount: imageTasks.length + videoTasks.length,
    imageTaskStatus: imageTask.status,
    videoTaskPresent: Boolean(videoTask),
    videoTaskStatus: videoTask?.status || null,
    videoStage: videoTask ? 'query' : 'submit',
    imageTaskKey: imageTask.taskId || imageTask.id || null,
    videoTaskKey: videoTask?.taskId || videoTask?.id || null,
  }
}

async function scanForPlaintextSecret(directory, needle) {
  if (!Buffer.isBuffer(needle) || needle.length < 8) return false
  const stack = [directory]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try { entries = await fs.readdir(current, { withFileTypes: true }) } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw Object.assign(new Error('POST_EXIT_SECRET_SCAN_FAILED'), { code: 'POST_EXIT_SECRET_SCAN_FAILED' })
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) { stack.push(file); continue }
      if (!entry.isFile()) continue
      let handle
      try {
        handle = await fs.open(file, 'r')
        const stat = await handle.stat()
        const overlap = Math.max(0, needle.length - 1)
        const chunkSize = 1024 * 1024
        let position = 0
        let carry = Buffer.alloc(0)
        while (position < stat.size) {
          const buffer = Buffer.alloc(Math.min(chunkSize, stat.size - position))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
          const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
          if (data.indexOf(needle) >= 0) return true
          carry = Buffer.from(data.subarray(Math.max(0, data.length - overlap)))
          position += bytesRead
          buffer.fill(0)
        }
      } catch { throw Object.assign(new Error('POST_EXIT_SECRET_SCAN_FAILED'), { code: 'POST_EXIT_SECRET_SCAN_FAILED' }) }
      finally { await handle?.close().catch(() => {}) }
    }
  }
  return false
}

async function runController() {
  originalSecret = undefined
  const resumeMediaProjectArgument = readResumeMediaProjectArgument()
  if (resumeMediaProjectArgument && configurationOnly) {
    throw Object.assign(new Error('QA_ASSERTION_FAILED'), { code: 'QA_ASSERTION_FAILED' })
  }
  assertAcceptanceModeCompatibility(videoOnly, resumeMediaProjectArgument, configurationOnly)
  const resumeProject = resumeMediaProjectArgument
    ? await validateResumeMediaProjectPath(resumeMediaProjectArgument) : null
  let secretInputTransport = 'stdin'
  let secret = await readSecretFromStdin()
  if (typeof secret !== 'string' || secret.length < 8) {
    console.error('Codex Agnes acceptance requires an API key through stdin.')
    process.exitCode = 2
    return
  }
  await fs.mkdir(temporaryBase, { recursive: true })
  await fs.mkdir(evidenceDirectory, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const runRoot = ensureWithinTemporaryBase(path.join(temporaryBase, `mcp-codex-agnes-${timestamp}-${randomUUID()}`))
  const profile = path.join(runRoot, 'VibePaper')
  const projectDirectory = resumeProject?.projectDirectory || path.join(runRoot, 'project')
  const resultPath = path.join(runRoot, 'worker-result.json')
  const reportPath = path.join(evidenceDirectory, `codex-agnes-acceptance-${timestamp}.json`)
  const workerPath = path.join(__dirname, 'smoke-mcp-codex-agnes.cjs')
  const electronPath = path.join(root, 'pi-paper-desktop/node_modules/electron/dist/electron.exe')
  const needle = Buffer.from(secret, 'utf8')
  await fs.mkdir(runRoot, { recursive: true })
  await fs.mkdir(profile, { recursive: true, mode: 0o700 })
  // The QA profile lives in the checkout, whose inherited Windows ACL may be
  // broader than normal AppData. Protect this new, isolated directory before
  // Main writes its temporary connection credential. Never change daily data.
  if (process.platform === 'win32') {
    const aclScript = 'try {\n' + [
      '$ErrorActionPreference = "Stop"',
      '$target = $env:VIBEPAPER_QA_PRIVATE_PROFILE',
      '$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
      '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
      '$acl.SetAccessRuleProtection($true, $false)',
      '$acl.SetOwner($owner)',
      'foreach ($sid in @($owner, (New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")), (New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")))) {',
      '  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")',
      '  $acl.AddAccessRule($rule)',
      '}',
      'Set-Acl -LiteralPath $target -AclObject $acl',
      'if (!(Get-Acl -LiteralPath $target).AreAccessRulesProtected) { throw "QA_PROFILE_ACL_FAILED" }',
      'Write-Output "QA_PROFILE_PRIVATE"',
    ].join('\n') + '\nexit 0\n} catch { exit 1 }\n\n'
    const aclEnvironment = { VIBEPAPER_QA_PRIVATE_PROFILE: profile }
    for (const name of ['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
      if (process.env[name]) aclEnvironment[name] = process.env[name]
    }
    const aclOutput = execFileSync(path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: aclScript,
        env: aclEnvironment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' })
    if (!aclOutput.includes('QA_PROFILE_PRIVATE')) throw Object.assign(new Error('QA_ASSERTION_FAILED'), { code: 'QA_ASSERTION_FAILED' })
  }
  // Use the same sanitized network environment as the no-key CLI diagnostic.
  // Dropping the parent's explicit proxy here would make the Electron-hosted
  // CLI silently use a different WinINET fallback route.
  const { environment: childEnvironment } = buildCodexEnvironment(secret)
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  const workerArgs = [workerPath, '--worker', '--run-root', runRoot,
    ...(configurationOnly ? ['--configuration-only'] : []),
    ...(resumeProject ? ['--resume-media-project', resumeProject.projectDirectory] : []),
    ...(videoOnly ? ['--video-only'] : []),
    ...(appServerHost ? ['--app-server-host'] : [])]
  const child = spawn(electronPath, workerArgs, {
    cwd: root, env: childEnvironment, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
  })
  childEnvironment[secretEnvName] = ''
  secret = undefined
  originalSecret = undefined
  let outputBuffer = ''
  let operatorGateStarted = false
  let pendingClientConfirmation = null
  let clientConfirmationInputBuffer = ''
  let clientConfirmationDataListener = null
  let clientConfirmationEndListener = null
  function sendWorkerControlMessage(message) {
    if (!child.connected || typeof child.send !== 'function') return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => finish(false), 3_000)
      const finish = (sent) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(sent)
      }
      try { child.send(message, (error) => finish(!error)) }
      catch { finish(false) }
    })
  }

  function stopClientConfirmationInput() {
    if (clientConfirmationDataListener) process.stdin.removeListener('data', clientConfirmationDataListener)
    if (clientConfirmationEndListener) process.stdin.removeListener('end', clientConfirmationEndListener)
    clientConfirmationDataListener = null
    clientConfirmationEndListener = null
    clientConfirmationInputBuffer = ''
    process.stdin.pause()
  }
  function settleClientConfirmation(requestId, accept, writeResponse = true) {
    if (!pendingClientConfirmation || pendingClientConfirmation.qaRequestId !== requestId) return false
    clearTimeout(pendingClientConfirmation.timer)
    pendingClientConfirmation = null
    stopClientConfirmationInput()
    if (writeResponse) void sendWorkerControlMessage({ type: 'qa-client-confirmation', requestId, accept })
    return true
  }
  function handleClientConfirmationLine(line) {
    const match = line.trim().match(/^(approve|reject):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu)
    if (!match || !pendingClientConfirmation || match[2].toLowerCase() !== pendingClientConfirmation.qaRequestId) return
    settleClientConfirmation(pendingClientConfirmation.qaRequestId, match[1].toLowerCase() === 'approve')
  }
  function startClientConfirmationInput() {
    if (clientConfirmationDataListener) return
    clientConfirmationDataListener = (chunk) => {
      clientConfirmationInputBuffer += String(chunk)
      if (clientConfirmationInputBuffer.length > 512) {
        clientConfirmationInputBuffer = ''
        return
      }
      let newline
      while ((newline = clientConfirmationInputBuffer.search(/[\r\n]/u)) >= 0) {
        const line = clientConfirmationInputBuffer.slice(0, newline)
        clientConfirmationInputBuffer = clientConfirmationInputBuffer.slice(newline + 1).replace(/^\n/u, '')
        handleClientConfirmationLine(line)
      }
    }
    clientConfirmationEndListener = () => {
      if (pendingClientConfirmation) settleClientConfirmation(pendingClientConfirmation.qaRequestId, false)
    }
    process.stdin.on('data', clientConfirmationDataListener)
    process.stdin.once('end', clientConfirmationEndListener)
    process.stdin.resume()
  }
  function relayClientGenerationConfirmation(payload) {
    const keys = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Object.keys(payload).sort().join(',') : ''
    const valid = keys === 'message,qaRequestId,stage'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(payload.qaRequestId || '')
      && ['image', 'video'].includes(payload.stage)
      && typeof payload.message === 'string' && payload.message.length > 0 && payload.message.length <= 20_000
    if (!valid) {
      console.log('QA_STATUS GENERATION_CONFIRMATION_INVALID')
      return
    }
    if (pendingClientConfirmation) {
      void sendWorkerControlMessage({ type: 'qa-client-confirmation', requestId: payload.qaRequestId, accept: false })
      console.log('QA_STATUS GENERATION_CONFIRMATION_CONCURRENTLY_REJECTED')
      return
    }
    const qaRequestId = payload.qaRequestId.toLowerCase()
    const timer = setTimeout(() => {
      if (pendingClientConfirmation?.qaRequestId !== qaRequestId) return
      settleClientConfirmation(qaRequestId, false)
      console.log('QA_STATUS GENERATION_CONFIRMATION_EXPIRED')
    }, 120_000)
    pendingClientConfirmation = { qaRequestId, stage: payload.stage, timer }
    startClientConfirmationInput()
    console.log(`QA_GENERATION_CONFIRMATION ${JSON.stringify({ qaRequestId, stage: payload.stage, message: payload.message })}`)
  }
  const removeChildSignalHandlers = () => {
    process.off('SIGINT', handleParentInterrupt)
    process.off('SIGTERM', handleParentTermination)
  }
  const killOwnedElectronTree = () => {
    if (!Number.isInteger(child.pid)) return child.kill('SIGTERM')
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.unref()
    } else child.kill('SIGTERM')
  }
  const handleParentInterrupt = () => killOwnedElectronTree()
  const handleParentTermination = () => killOwnedElectronTree()
  process.once('SIGINT', handleParentInterrupt)
  process.once('SIGTERM', handleParentTermination)
  let operatorInterface = null
  const requestPaidStageApproval = async () => {
    // The caller must have the user's authorization for this explicit scope.
    // Each generation form still requires the human user; this controls only
    // the extra QA executor gate, never a provider or generation approval.
    if (executorPreauthorizedOneImageAndVideo) {
      console.log('QA_STATUS EXECUTOR_PREAUTHORIZED_ONE_IMAGE_AND_VIDEO')
      return sendWorkerControlMessage({ type: 'qa-operator-media-gate', approved: true })
    }
    if (!process.stdin.isTTY || !child.connected) {
      await sendWorkerControlMessage({ type: 'qa-operator-media-gate', approved: false })
      return false
    }
    process.stdin.setRawMode?.(false)
    process.stdin.resume()
    const interfaceHandle = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    operatorInterface = interfaceHandle
    return new Promise((resolve) => {
      let settled = false
      const finish = (approved) => {
        if (settled) return
        settled = true
        interfaceHandle.close()
        operatorInterface = null
        void sendWorkerControlMessage({ type: 'qa-operator-media-gate', approved })
          .then((sent) => resolve(approved && sent))
      }
      const paidScope = resumeProject ? '最多一次视频生成' : '最多一次图片和一次视频生成'
      const ask = () => interfaceHandle.question(`配置和启用型号已核验。输入 continue 开始${paidScope}，输入 cancel 停止：`,
        (answer) => {
          const decision = answer.trim().toLowerCase()
          if (!decision) return ask()
          finish(decision === 'continue')
        })
      ask()
      interfaceHandle.once('close', () => { if (!settled) finish(false) })
    })
  }
  child.stdout?.on('data', (chunk) => {
    outputBuffer += String(chunk)
    let index
    while ((index = outputBuffer.indexOf('\n')) >= 0) {
      const line = outputBuffer.slice(0, index).trim()
      outputBuffer = outputBuffer.slice(index + 1)
      if (line.startsWith('QA_GENERATION_CONFIRMATION ')) {
        try {
          if (line.length > 130_000) throw new Error('oversized confirmation line')
          relayClientGenerationConfirmation(JSON.parse(line.slice('QA_GENERATION_CONFIRMATION '.length)))
        }
        catch { console.log('QA_STATUS GENERATION_CONFIRMATION_INVALID') }
        continue
      }
      if (/^QA_STATUS [A-Z0-9_ -]{1,100}$/u.test(line)) {
        console.log(line)
        if (line === 'QA_STATUS CONFIGURATION_VERIFIED_WAITING_FOR_PAID_MEDIA' && !operatorGateStarted) {
          operatorGateStarted = true
          void requestPaidStageApproval().catch(() => sendWorkerControlMessage({ type: 'qa-operator-media-gate', approved: false }))
        }
      }
    }
    if (outputBuffer.length > 132_000) outputBuffer = ''
  })
  let timedOut = false
  const workerResult = await new Promise((resolve) => {
    let settled = false
    const finish = async (code, signal, spawnErrorCode = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      removeChildSignalHandlers()
      if (pendingClientConfirmation) settleClientConfirmation(pendingClientConfirmation.qaRequestId, false, false)
      else stopClientConfirmationInput()
      operatorInterface?.close()
      const summary = await fs.readFile(resultPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null)
      resolve({ code, signal, spawnErrorCode, summary })
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && Number.isInteger(child.pid)) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.unref()
      } else child.kill('SIGTERM')
    }, 55 * 60 * 1000)
    child.once('error', (error) => {
      const code = /^[A-Z0-9_]{1,80}$/u.test(error?.code || '') ? error.code : 'ELECTRON_SPAWN_ERROR'
      finish(null, 'spawn-error', code)
    })
    child.once('close', finish)
  })
  const runRootPlaintextKeyFound = await scanForPlaintextSecret(runRoot, needle).catch(() => null)
  const sourceProjectPlaintextKeyFound = resumeProject
    ? await scanForPlaintextSecret(resumeProject.projectDirectory, needle).catch(() => null) : false
  const plaintextKeyFound = [runRootPlaintextKeyFound, sourceProjectPlaintextKeyFound].includes(true)
    ? true : [runRootPlaintextKeyFound, sourceProjectPlaintextKeyFound].includes(null) ? null : false
  needle.fill(0)
  const summary = workerResult.summary || {
    schemaVersion: 1, success: false, phase: 'electron-worker', errorCode: timedOut ? 'ELECTRON_WORKER_TIMEOUT' : workerResult.spawnErrorCode || 'ELECTRON_WORKER_FAILED',
    resumed: Boolean(resumeProject), resumedFromRun: resumeProject?.sourceRunName || null,
    resumeProjectIdentityPreserved: false, existingTasksReusedCount: 0, viewportFocusedForInspection: false,
    confirmationPolicy: 'client-form-generation-only-2026-10-17',
    clientHost: appServerHost ? 'codex-app-server-qa-relay' : 'codex-cli-exec',
    nativeCodexPopupAccepted: false, generationConfirmationsObserved: 0,
    generationConfirmationResponses: 0, generationConfirmationsConfirmed: 0,
    cliExitCodes: [], providerConfigurationSaved: false, imageTaskStatus: null, videoTaskStatus: null,
  }
  const final = {
    ...summary,
    videoOnly,
    videoChainAccepted: summary.videoChainAccepted === true,
    combinedFullMediaChain: videoOnly ? false : summary.combinedFullMediaChain === true,
    resumed: Boolean(resumeProject),
    resumedFromRun: resumeProject?.sourceRunName || null,
    resumeProjectIdentityPreserved: summary.resumeProjectIdentityPreserved === true,
    existingTasksReusedCount: Number.isSafeInteger(summary.existingTasksReusedCount) ? summary.existingTasksReusedCount : 0,
    viewportFocusedForInspection: summary.viewportFocusedForInspection === true,
    secretInputTransport,
    executorPreauthorizedOneImageAndVideo,
    configurationOnly,
    postExitPlaintextKeyFound: plaintextKeyFound,
    credentialHygiene: {
      suppliedByTemporaryEnvironment: true,
      suppliedViaStdin: true,
      environmentRemovedBeforeHarnessWork: true,
      postExitPlaintextScanCompleted: plaintextKeyFound !== null,
      plaintextFound: plaintextKeyFound,
      credentialsClearedViaDesktopIpc: summary.credentialsClearedViaDesktopIpc === true,
      testGrantRevoked: summary.testGrantRevoked === true,
      rawClientTranscriptSaved: false,
      promptSaved: false,
      apiKeySavedInEvidence: false,
      mcpBootstrapSaved: false,
    },
    finishedAt: new Date().toISOString(),
  }
  await fs.writeFile(reportPath, JSON.stringify(final, null, 2))
  console.log(`Codex Agnes acceptance: ${final.success ? 'PASS' : `STOPPED (${final.errorCode || final.phase})`}`)
  console.log(`Evidence: ${reportPath}`)
  if (resumeProject) console.log(`Resumed original project from run: ${resumeProject.sourceRunName}`)
  else console.log(`Retained isolated project: ${projectDirectory}`)
  if (!final.success || plaintextKeyFound !== false) process.exitCode = 1
}

function createAcceptanceMediaSubmissionGuard(getActiveStage = () => null, options = {}) {
  const proposals = new Map()
  const attemptedModalities = new Set()
  const startedStages = new Set()
  let videoNodeCreationAttempted = false
  let videoConnectionAttempted = false
  const scopeKeys = ['projectId', 'canvasId', 'clientId', 'grantId']
  const reject = () => { throw Object.assign(new Error('QA_MEDIA_SCOPE_EXCEEDED'), { code: 'QA_MEDIA_SCOPE_EXCEEDED' }) }
  const parseArguments = (payload) => {
    let args = payload?.arguments
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = null } }
    return args && typeof args === 'object' && !Array.isArray(args) ? args : null
  }
  const nonEmpty = (value) => {
    if (value === null || value === undefined || value === false) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === 'object') return Object.keys(value).length > 0
    return true
  }
  const allowedModelParams = (modality, value) => {
    if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) return false
    const params = value || {}
    const aliases = (names, predicate) => names.every((name) => !Object.hasOwn(params, name) || predicate(params[name]))
    if (!aliases(['count', 'n', 'num_images', 'num_videos'], (entry) => entry === 1)) return false
    if (modality === 'image') {
      return true
    }
    if (modality !== 'video') return false
    return aliases(['duration', 'seconds'], (entry) => entry === 4)
      && aliases(['resolution', 'size', 'resKey'], (entry) => typeof entry === 'string' && entry.trim().toUpperCase() === '720P')
      && aliases(['ratio', 'aspect', 'aspectRatio', 'aspect_ratio'], (entry) => typeof entry === 'string' && entry.trim() === '16:9')
      && ['firstFrameUrl', 'lastFrameUrl', 'imageUrl', 'referenceImages', 'referenceUrls', 'videoUrl', 'refVideoUrl']
        .every((name) => !Object.hasOwn(params, name) || !nonEmpty(params[name]))
  }
  return async function guardedRequest(invoke, method, payload) {
    if (options.videoOnly && method === 'mcp:tool:execute') {
      const stage = getActiveStage()
      if (['image', 'image-query'].includes(stage)) reject()
      if (['create_nodes', 'connect_nodes'].includes(payload?.toolName) && stage !== 'video') reject()
      if (payload?.toolName === 'create_nodes') {
        const args = parseArguments(payload)
        if (videoNodeCreationAttempted || !Array.isArray(args?.nodes)
          || args.nodes.length !== 1 || args.nodes[0]?.type !== 'video') reject()
        videoNodeCreationAttempted = true
      }
      if (payload?.toolName === 'connect_nodes') {
        const args = parseArguments(payload)
        if (videoConnectionAttempted || !Array.isArray(args?.nodeIds) || args.nodeIds.length !== 2
          || new Set(args.nodeIds).size !== 2) reject()
        videoConnectionAttempted = true
      }
    }
    if (options.resumeMode && method === 'mcp:tool:execute'
      && ['create_nodes', 'connect_nodes'].includes(payload?.toolName)
      && ['configuration', 'image-query', 'video-query', 'readback'].includes(getActiveStage())) reject()
    if (method === 'mcp:action:resolve' && payload?.decision === 'approve') {
      const prepared = proposals.get(payload.proposalId)
      if (!prepared || scopeKeys.some((key) => prepared[key] !== payload[key])
        || prepared.approved) reject()
      // Reserve approval before dispatch, including uncertain results.
      prepared.approved = true
    }
    let stageForPreparation = null
    if (method === 'mcp:tool:execute' && payload?.toolName === 'prepare_generation') {
      const args = parseArguments(payload)
      stageForPreparation = getActiveStage()
      const requestedModelType = args?.generations?.[0]?.modelType
      const requestedModality = typeof requestedModelType === 'string'
        ? options.resolveModelModality?.(requestedModelType) : null
      if (options.resumeMode) {
        if (!requestedModality || !['image', 'video'].includes(requestedModality)
          || requestedModality === 'image'
          || requestedModality === 'video' && options.hasExistingVideoTask?.()) reject()
      }
      if (options.videoOnly && (stageForPreparation !== 'video' || requestedModality !== 'video')) reject()
      if (['image', 'video'].includes(stageForPreparation)) {
        if (attemptedModalities.has(stageForPreparation) || startedStages.has(stageForPreparation)) reject()
        // Even a malformed or failed prepare consumes this stage's one attempt.
        startedStages.add(stageForPreparation)
      }
      if (!args || !Array.isArray(args.generations) || args.generations.length !== 1
        || !['image', 'video'].includes(stageForPreparation)
        || !allowedModelParams(stageForPreparation, args.generations[0]?.modelParams)) reject()
    }
    const result = await invoke()
    if (method === 'mcp:tool:execute' && payload?.toolName === 'prepare_generation') {
      const content = result?.structuredContent
      if (content?.status !== 'awaiting_confirmation') return result
      const items = content.items
      const label = items?.[0]?.model
      const modality = label === 'Agnes Image 2.5 Flash' ? 'image'
        : label === 'Agnes Video 2.5 Flash' ? 'video' : null
      if (typeof content.proposalId !== 'string' || !Array.isArray(items) || items.length !== 1 || !modality
        || modality !== stageForPreparation || attemptedModalities.has(modality)) reject()
      // Reserve before a client decision or uncertain follow-up. Retain only
      // scope, stage, modality, and one-use state; never retain prompt or params.
      attemptedModalities.add(modality)
      proposals.set(content.proposalId, { ...Object.fromEntries(scopeKeys.map((key) => [key, payload[key]])), modality,
        stage: stageForPreparation, approved: false })
    }
    return result
  }
}

async function workerMain() {
  const { createQaWorkerControl } = require('./qa-worker-ipc.cjs')
  const qaWorkerControl = createQaWorkerControl(process)
  const { app, BrowserWindow, dialog, protocol, safeStorage } = require('electron')
  // Electron requires privileged schemes before ready. Resume validation does
  // asynchronous filesystem work, so registration must precede that first await.
  protocol.registerSchemesAsPrivileged([{
    scheme: 'vibe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }])
  protocol.registerSchemesAsPrivileged = () => {}
  const { createLocalProjectStore } = require('../src/project-store.cjs')
  const { spawn: childSpawn } = require('node:child_process')

  const runRootArg = process.argv[process.argv.indexOf('--run-root') + 1]
  const runRoot = ensureWithinTemporaryBase(runRootArg)
  const profile = path.join(runRoot, 'VibePaper')
  const resumeMediaProjectArgument = readResumeMediaProjectArgument()
  if (resumeMediaProjectArgument && configurationOnly) {
    throw Object.assign(new Error('QA_ASSERTION_FAILED'), { code: 'QA_ASSERTION_FAILED' })
  }
  assertAcceptanceModeCompatibility(videoOnly, resumeMediaProjectArgument, configurationOnly)
  const resumeProject = resumeMediaProjectArgument
    ? await validateResumeMediaProjectPath(resumeMediaProjectArgument) : null
  const resumeMode = Boolean(resumeProject)
  const projectDirectory = resumeProject?.projectDirectory || path.join(runRoot, 'project')
  const resultPath = path.join(runRoot, 'worker-result.json')
  const secret = originalSecret
  originalSecret = undefined
  delete process.env[secretEnvName]
  if (typeof secret !== 'string' || secret.length < 8) throw Object.assign(new Error('AGNES_KEY_UNAVAILABLE'), { code: 'AGNES_KEY_UNAVAILABLE' })
  const secretBytes = Buffer.from(secret, 'utf8')
  let secretValue = secret
  const originalGetPath = app.getPath.bind(app)
  const originalSetPath = app.setPath.bind(app)
  app.setPath = (name, value) => originalSetPath(name, name === 'userData' ? profile : value)
  app.getPath = (name) => name === 'appData' ? runRoot : originalGetPath(name)

  let window
  let opened
  let resumePlan = null
  let resumeIdentityPreserved = false
  let imageTaskReused = false
  let videoTaskReused = false
  let grantClientId
  let clientConfig
  let cliChild
  let cliHostClose = null
  let phase = 'prepare-isolated-profile'
  let pairedConnections = 0
  let nativeApprovalDialogsObserved = 0
  let providerDisclosureObserved = false
  let providerDisclosureConfirmed = false
  let providerDisclosureCardObserved = false
  let providerDisclosureDecisionStatus = null
  let providerDisclosureCandidateCount = 0
  let configurationContinuationAttempted = false
  let canvasReadyAfterDisclosureReturn = null
  let generationConfirmationsObserved = 0
  let generationConfirmationResponses = 0
  let generationConfirmationsConfirmed = 0
  let providerConfigured = false
  let providerCredentialCleared = false
  let grantRevoked = false
  let imageResult = null
  let videoResult = null
  let viewportFocusedForInspection = false
  let configurationVerified = false
  let paidMediaAuthorizedByOperator = false
  let latestCanvasSummary = null
  let previewMatchesTaskStore = { image: null, video: null }
  let cliTurns = []
  let activeGenerationStage = null
  let providerConnectionTestStatus = null
  let mcpDiagnostics = { toolNames: [], calls: Object.create(null), statusByTool: Object.create(null), errorCodes: new Set(),
    jsonRpcErrorCodes: new Set(), rpcResponses: [], unknownPublicErrorCode: false,
    unknownJsonRpcErrorCode: false, unknownHttpStatusCodeObserved: false, previewReads: [], mediaReads: [] }
  let publicModelReferences = []
  const generationModelReferenceChecks = []
  const startedAt = new Date().toISOString()

  function status(message) { console.log(`QA_STATUS ${message}`) }

  async function relayCodexGenerationElicitation(params, stage, signal) {
    if (!appServerHost || !['image', 'video'].includes(stage)
      || typeof params?.message !== 'string' || params.message.length === 0 || params.message.length > 20_000) {
      return { action: 'decline', content: null }
    }
    const qaRequestId = randomUUID()
    generationConfirmationsObserved += 1
    const decision = qaWorkerControl.waitForClientConfirmation(qaRequestId, { signal, timeoutMs: 120_000 })
    process.stdout.write(`QA_GENERATION_CONFIRMATION ${JSON.stringify({ qaRequestId, stage, message: params.message })}\n`)
    const response = await decision
    if (response.answered) generationConfirmationResponses += 1
    if (response.accepted) {
      generationConfirmationsConfirmed += 1
      return { action: 'accept', content: { confirm: true } }
    }
    return { action: 'decline', content: null }
  }

  function safeCliTurnSummaries() {
    return cliTurns.map((turn) => ({
      stage: ['configuration', 'configuration-resume', 'image', 'image-query', 'video', 'video-query', 'readback'].includes(turn.stage) ? turn.stage : 'unknown',
      exitCode: Number.isInteger(turn.exitCode) ? turn.exitCode : null,
      terminationSignal: [null, 'SIGINT', 'SIGTERM', 'SIGKILL', 'spawn-error'].includes(turn.terminationSignal)
        ? turn.terminationSignal : null,
      turnCompleted: turn.turnCompleted === true,
      errorEventSeen: turn.errorEventSeen === true,
      systemProxyAddressProvided: turn.systemProxyAddressProvided === true,
      codexCliAppDataPreserved: turn.codexCliAppDataPreserved === true,
      mcpBridgeAppDataIsolated: turn.mcpBridgeAppDataIsolated === true,
      eventTypeCounts: { ...(turn.trace?.eventTypeCounts || {}) },
      assistantMessageFlags: { ...(turn.trace?.assistantMessageFlags || {}) },
      toolFailureFlags: { ...(turn.trace?.toolFailureFlags || {}) },
      cliErrorEventFlags: { ...(turn.trace?.cliErrorEventFlags || {}) },
      toolErrorKeywordFlags: { ...(turn.trace?.toolErrorKeywordFlags || {}) },
      cliErrorKeywordFlags: { ...(turn.trace?.cliErrorKeywordFlags || {}) },
      jsonRpcErrorCodes: [...(turn.trace?.jsonRpcErrorCodes || [])],
      unknownJsonRpcErrorCode: turn.trace?.unknownJsonRpcErrorCode === true,
      httpStatusCodes: [...(turn.trace?.httpStatusCodes || [])],
      unknownHttpStatusCodeObserved: turn.trace?.unknownHttpStatusCodeObserved === true,
      stderrDiagnostics: { ...(turn.stderrDiagnostics || {}) },
      toolNames: [...(turn.trace?.toolNames || [])],
      toolStatuses: { ...(turn.trace?.toolStatuses || {}) },
      toolIsErrors: { ...(turn.trace?.toolIsErrors || {}) },
      errorCodes: [...(turn.trace?.errorCodes || [])],
    }))
  }

  function installPublicDiagnostics() {
    const http = require('node:http')
    const serviceModule = require('../src/mcp-main-service.cjs')
    const originalFactory = serviceModule.createMcpMainService
    const workerProxies = new WeakMap()
    const guardMediaSubmission = createAcceptanceMediaSubmissionGuard(() => activeGenerationStage, {
      resumeMode,
      videoOnly,
      hasExistingVideoTask: () => resumePlan?.videoTaskPresent === true,
      resolveModelModality: (modelType) => publicModelReferences.find((entry) =>
        entry.name === modelType || entry.id === modelType || entry.bindingId === modelType)?.modelType || null,
    })
    const recordMedia = (summary) => {
      if (!summary || !['image', 'video'].includes(summary.modality)
        || !['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm'].includes(summary.mimeType)
        || !Number.isSafeInteger(summary.sizeBytes) || summary.sizeBytes < 1 || !/^[a-f0-9]{64}$/u.test(summary.sha256)) return
      if (mcpDiagnostics.mediaReads.some((entry) => entry.modality === summary.modality && entry.sha256 === summary.sha256)) return
      mcpDiagnostics.mediaReads.push({ modality: summary.modality, mimeType: summary.mimeType,
        sizeBytes: summary.sizeBytes, sha256: summary.sha256 })
    }
    const hashMedia = (content) => {
      if (typeof content !== 'string' || content.length > 12 * 1024 * 1024) return null
      const isImage = content.match(/"type"\s*:\s*"image"[\s\S]{0,300}?"data"\s*:\s*"([A-Za-z0-9+/=]+)"[\s\S]{0,200}?"mimeType"\s*:\s*"([^"]+)"/u)
      const isVideo = content.match(/"type"\s*:\s*"resource"[\s\S]{0,500}?"mimeType"\s*:\s*"([^"]+)"[\s\S]{0,300}?"blob"\s*:\s*"([A-Za-z0-9+/=]+)"/u)
      let modality, mimeType, encoded
      if (isImage) { modality = 'image'; encoded = isImage[1]; mimeType = isImage[2] }
      else if (isVideo) { modality = 'video'; mimeType = isVideo[1]; encoded = isVideo[2] }
      else return null
      const bytes = Buffer.from(encoded, 'base64')
      const result = { modality, mimeType, sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
      bytes.fill(0)
      return result
    }
    const parsePublicResponse = (content) => {
      try {
        const parsed = JSON.parse(content)
        const errorCode = [parsed?.error?.code, parsed?.error?.data?.code, parsed?.errorCode, parsed?.error_code,
          parsed?.structuredContent?.error?.code, parsed?.structuredContent?.errorCode,
          parsed?.structuredContent?.error_code, parsed?.structured_content?.error_code,
          parsed?.result?.error?.code, parsed?.result?.errorCode, parsed?.result?.error_code,
          parsed?.result?.structuredContent?.error?.code, parsed?.result?.structuredContent?.errorCode,
          parsed?.result?.structuredContent?.error_code, parsed?.result?.structured_content?.error_code,
          parsed?.result?.content?.[0]?.structuredContent?.errorCode,
          parsed?.result?.content?.[0]?.structured_content?.error_code]
          .find((candidate) => safeErrorCodes.has(candidate)) || null
        const structures = [parsed?.structuredContent, parsed?.structured_content,
          parsed?.result?.structuredContent, parsed?.result?.structured_content,
          parsed?.result?.content?.[0]?.structuredContent, parsed?.result?.content?.[0]?.structured_content]
        const numericErrorCode = [parsed?.error?.code, parsed?.result?.error?.code,
          parsed?.structuredContent?.error?.code, parsed?.structured_content?.error?.code,
          parsed?.result?.structuredContent?.error?.code, parsed?.result?.structured_content?.error?.code]
          .find((candidate) => Number.isInteger(candidate))
        const jsonRpcErrorCode = safeJsonRpcErrorCodes.has(numericErrorCode) ? numericErrorCode : null
        const status = [parsed?.status, ...structures.map((entry) => entry?.status), parsed?.result?.status]
          .map(safeStatus).find(Boolean) || null
        const errorValue = parsed?.error || parsed?.errorCode || parsed?.error_code || parsed?.result?.error
          || parsed?.result?.errorCode || parsed?.result?.error_code || structures.find((entry) => entry?.error
          || entry?.errorCode || entry?.error_code) || parsed?.result?.content?.[0]?.isError
          || parsed?.result?.content?.[0]?.is_error
        const isError = [parsed?.isError, parsed?.is_error, parsed?.result?.isError, parsed?.result?.is_error,
          parsed?.result?.content?.[0]?.isError, parsed?.result?.content?.[0]?.is_error]
          .find((candidate) => typeof candidate === 'boolean')
        return { errorCode, status, isError: typeof isError === 'boolean' ? isError : Boolean(errorValue),
          unknownPublicErrorCode: Boolean(errorValue && !errorCode), jsonRpcErrorCode,
          unknownJsonRpcErrorCode: numericErrorCode !== undefined && jsonRpcErrorCode === null }
      } catch { return { errorCode: null, status: null, isError: false, unknownPublicErrorCode: false,
        jsonRpcErrorCode: null, unknownJsonRpcErrorCode: false } }
    }
    const originalCreateServer = http.createServer
    const safeToolNameFromPrefix = (prefix) => {
      const match = prefix.match(/^\s*\{\s*"method"\s*:\s*"tools\/call"\s*,\s*"params"\s*:\s*\{\s*"name"\s*:\s*"([a-z_]+)"/u)
      return match && allowedTools.includes(match[1]) ? match[1] : null
    }
    const createServerWithSafeDiagnostics = function (...serverArgs) {
      const listenerIndex = serverArgs.findIndex((argument) => typeof argument === 'function')
      if (listenerIndex < 0) return Reflect.apply(originalCreateServer, this, serverArgs)
      const originalListener = serverArgs[listenerIndex]
      const args = [...serverArgs]
      args[listenerIndex] = function (request, response) {
        const isRpc = request?.url === '/rpc' && response && typeof response.end === 'function'
        if (!isRpc) return Reflect.apply(originalListener, this, [request, response])
        let chunks = []
        let bytes = 0
        let requestPrefix = Buffer.alloc(256)
        let requestPrefixLength = 0
        let requestToolName = null
        const originalEmit = request.emit
        request.emit = function (eventName, ...eventArgs) {
          if (eventName === 'data' && requestPrefix && requestPrefixLength < requestPrefix.length) {
            const chunk = eventArgs[0]
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ''))
            const copied = Math.min(buffer.length, requestPrefix.length - requestPrefixLength)
            buffer.copy(requestPrefix, requestPrefixLength, 0, copied)
            requestPrefixLength += copied
            if (!Buffer.isBuffer(chunk)) buffer.fill(0)
          } else if (eventName === 'end' && requestPrefix) {
            requestToolName = safeToolNameFromPrefix(requestPrefix.subarray(0, requestPrefixLength).toString('utf8'))
            requestPrefix.fill(0)
            requestPrefix = null
            request.emit = originalEmit
          }
          return Reflect.apply(originalEmit, this, [eventName, ...eventArgs])
        }
        request.once('close', () => {
          if (requestPrefix) requestPrefix.fill(0)
          requestPrefix = null
          if (request.emit !== originalEmit) request.emit = originalEmit
        })
        const originalWrite = response.write
        const originalEnd = response.end
        const collect = (chunk) => {
          if (chunks === null || chunk === undefined || chunk === null) return
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
          bytes += buffer.length
          if (bytes > 12 * 1024 * 1024) { chunks = null; return }
          chunks.push(Buffer.from(buffer))
        }
        response.write = function (chunk, ...writeArgs) {
          collect(chunk)
          return Reflect.apply(originalWrite, this, [chunk, ...writeArgs])
        }
        response.end = function (chunk, ...endArgs) {
          collect(chunk)
          try {
            const body = chunks ? Buffer.concat(chunks, bytes).toString('utf8') : ''
            const publicResponse = body ? parsePublicResponse(body)
              : { errorCode: null, status: null, isError: false, unknownPublicErrorCode: false,
                jsonRpcErrorCode: null, unknownJsonRpcErrorCode: false }
            const rawHttpStatusCode = Number.isInteger(response.statusCode) ? response.statusCode : null
            const httpStatusCode = safeHttpStatusCodes.has(rawHttpStatusCode) ? rawHttpStatusCode : null
            const unknownHttpStatusCode = rawHttpStatusCode !== null && httpStatusCode === null
            mcpDiagnostics.rpcResponses.push({ toolName: requestToolName, httpStatusCode, errorCode: publicResponse.errorCode,
              status: publicResponse.status, isError: publicResponse.isError,
              unknownPublicErrorCode: publicResponse.unknownPublicErrorCode,
              jsonRpcErrorCode: publicResponse.jsonRpcErrorCode,
              unknownJsonRpcErrorCode: publicResponse.unknownJsonRpcErrorCode, unknownHttpStatusCode })
            mcpDiagnostics.unknownPublicErrorCode ||= publicResponse.unknownPublicErrorCode
            mcpDiagnostics.unknownJsonRpcErrorCode ||= publicResponse.unknownJsonRpcErrorCode
            mcpDiagnostics.unknownHttpStatusCodeObserved ||= unknownHttpStatusCode
            if (publicResponse.errorCode) mcpDiagnostics.errorCodes.add(publicResponse.errorCode)
            if (publicResponse.jsonRpcErrorCode !== null) mcpDiagnostics.jsonRpcErrorCodes.add(publicResponse.jsonRpcErrorCode)
            if (requestToolName === 'test_provider_connection') {
              if (publicResponse.status && ['unsupported', 'connected', 'failed', 'error'].includes(publicResponse.status)) {
                providerConnectionTestStatus = publicResponse.status
              } else if (publicResponse.errorCode === 'PROVIDER_TEST_UNSUPPORTED') {
                providerConnectionTestStatus = 'unsupported'
              }
            }
            const media = hashMedia(body)
            if (media) recordMedia(media)
          } catch { /* Diagnostics intentionally retain only public summaries. */ }
          finally {
            for (const item of chunks || []) item.fill(0)
            chunks = null
          }
          return Reflect.apply(originalEnd, this, [chunk, ...endArgs])
        }
        return Reflect.apply(originalListener, this, [request, response])
      }
      return Reflect.apply(originalCreateServer, this, args)
    }
    serviceModule.createMcpMainService = function (options) {
      const originalGetWorker = options.getWorker
      const wrappedOptions = { ...options,
        getWorker() {
          const worker = Reflect.apply(originalGetWorker, options, [])
          if (!worker || typeof worker !== 'object') return worker
          const cachedProxy = workerProxies.get(worker)
          if (cachedProxy) return cachedProxy
          const originalRequest = worker.request
          if (typeof originalRequest !== 'function') return worker
          const proxy = new Proxy(worker, {
            get(target, property) {
              if (property === 'request') return function (...args) {
                const [method, payload] = args
                if (method === 'mcp:tool:execute' && allowedTools.includes(payload?.toolName)) {
                  mcpDiagnostics.calls[payload.toolName] = (mcpDiagnostics.calls[payload.toolName] || 0) + 1
                  if (!mcpDiagnostics.toolNames.includes(payload.toolName)) mcpDiagnostics.toolNames.push(payload.toolName)
                }
                return guardMediaSubmission(async () => {
                  if (method === 'mcp:tool:execute' && payload?.toolName === 'prepare_generation') {
                    const supplied = payload.arguments?.generations?.[0]?.modelType
                    // Persist only comparisons against public directory fields, never the
                    // supplied arguments, directory contents, prompts, or credentials.
                    generationModelReferenceChecks.push({
                      stage: ['image', 'video'].includes(activeGenerationStage) ? activeGenerationStage : 'unknown',
                      directoryEntryCount: publicModelReferences.length,
                      referenceIsString: typeof supplied === 'string',
                      ...Object.fromEntries(['name', 'id', 'bindingId', 'apiModelId', 'displayName', 'modelType']
                        .map((field) => [field, typeof supplied === 'string'
                          && publicModelReferences.some((entry) => entry[field] === supplied)])),
                    })
                  }
                  const result = await Reflect.apply(originalRequest, target, args)
                  if (method === 'mcp:tool:execute' && payload?.toolName === 'list_models') {
                    const models = result?.structuredContent?.models
                    publicModelReferences = Array.isArray(models) ? models.map((entry) => Object.fromEntries(
                      ['name', 'id', 'bindingId', 'apiModelId', 'displayName', 'modelType']
                        .filter((field) => typeof entry?.[field] === 'string').map((field) => [field, entry[field]]))) : []
                  }
                  return result
                }, method, payload)
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          workerProxies.set(worker, proxy)
          return proxy
        },
      }
      const service = Reflect.apply(originalFactory, this, [wrappedOptions])
      const originalStart = service.start
      service.start = async function (...args) {
        http.createServer = createServerWithSafeDiagnostics
        try { return await Reflect.apply(originalStart, service, args) }
        finally { http.createServer = originalCreateServer }
      }
      return service
    }
  }

  const originalDialogShow = dialog.showMessageBox.bind(dialog)
  dialog.showMessageBox = async function (...args) {
    const options = args.length === 1 ? args[0] : args[1]
    const buttons = Array.isArray(options?.buttons) ? options.buttons : []
    const approveIndex = buttons.findIndex((label) => /批准|允许|approve|allow/iu.test(label))
    if (approveIndex >= 0) {
      nativeApprovalDialogsObserved += 1
      const owner = args.length > 1 && args[0]?.webContents ? args[0] : window
      if (owner && !owner.isDestroyed()) {
        if (owner.isMinimized()) owner.restore()
        owner.show()
        owner.focus()
      }
      status('NATIVE_PAIRING_WAITING')
    }
    const result = await originalDialogShow(...args)
    if (approveIndex >= 0 && result?.response === approveIndex) pairedConnections += 1
    return result
  }
  app.on('browser-window-created', (_event, created) => {
    window = created
    created.webContents.setBackgroundThrottling(false)
  })

  async function evaluate(source) {
    if (!window || window.isDestroyed()) throw Object.assign(new Error('RENDERER_UNAVAILABLE'), { code: 'RENDERER_UNAVAILABLE' })
    return window.webContents.executeJavaScript(source)
  }

  async function waitFor(source, timeout = 60_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (window && !window.isDestroyed() && !window.webContents.isLoading()
        && await evaluate(source).catch(() => false)) return
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw Object.assign(new Error('UI_STATE_TIMEOUT'), { code: 'UI_STATE_TIMEOUT' })
  }

  async function readProviderDisclosureSummary() {
    return evaluate(`(async () => {
      const response = await window.vibepaperDesktop.getMcpPendingActions()
      const actions = Array.isArray(response) ? response : (response?.actions || [])
      const matching = actions.filter((action) => action?.kind === 'provider_disclosure'
        && action.clientName === 'codex' && action.displayName === 'Codex Agnes full-chain acceptance'
        && action.projectId === ${JSON.stringify(opened.project.projectId)}
        && action.canvasId === ${JSON.stringify(opened.project.canvasId)}
        && (action.providerConfig?.providerId === 'agnes' || action.providerId === 'agnes'))
      const allowed = new Set(['awaiting_disclosure', 'authorized', 'rejected', 'expired', 'invalidated'])
      const counts = { awaiting_disclosure: 0, authorized: 0, rejected: 0, expired: 0, invalidated: 0, other: 0 }
      for (const action of matching) {
        const status = allowed.has(action.status) ? action.status : 'other'
        counts[status] += 1
      }
      return { candidateCount: matching.length, counts }
    })()`)
  }

  async function navigateWithinRenderer(route) {
    await evaluate(`(() => {
      history.pushState({}, '', ${JSON.stringify(route)})
      window.dispatchEvent(new PopStateEvent('popstate'))
      return true
    })()`)
  }

  async function waitForProviderDisclosureResolution() {
    const configureRequestedDisclosure = mcpDiagnostics.rpcResponses.some((entry) =>
      entry.toolName === 'configure_provider' && entry.status === 'awaiting_disclosure')
    const initialWaitMs = configureRequestedDisclosure ? 12 * 60_000 : 5_000
    const deadline = Date.now() + initialWaitMs
    let settingsRouteOpened = false
    let waitingStatusSent = false
    let sawMatchingAction = false
    while (Date.now() < deadline) {
      const summary = await readProviderDisclosureSummary().catch(() => null)
      if (summary && Number.isSafeInteger(summary.candidateCount)) {
        providerDisclosureCandidateCount = summary.candidateCount
        if (summary.candidateCount > 0) {
          sawMatchingAction = true
          providerDisclosureObserved = true
        }
        if (summary.candidateCount > 1) {
          providerDisclosureDecisionStatus = 'ambiguous'
          throw Object.assign(new Error('PROVIDER_DISCLOSURE_AMBIGUOUS'), { code: 'PROVIDER_DISCLOSURE_AMBIGUOUS' })
        }
        if (summary.counts.rejected > 0 || summary.counts.expired > 0 || summary.counts.invalidated > 0) {
          providerDisclosureDecisionStatus = summary.counts.rejected > 0 ? 'rejected'
            : summary.counts.expired > 0 ? 'expired' : 'invalidated'
          throw Object.assign(new Error('PROVIDER_DISCLOSURE_REJECTED'), { code: 'PROVIDER_DISCLOSURE_REJECTED' })
        }
        if (summary.candidateCount === 1 && summary.counts.authorized === 1) {
          providerDisclosureDecisionStatus = 'authorized'
          providerDisclosureConfirmed = true
          status('PROVIDER_DISCLOSURE_AUTHORIZED_BY_PUBLIC_PENDING_STATE')
          return true
        }
        if (summary.candidateCount === 1 && summary.counts.awaiting_disclosure === 1) {
          providerDisclosureDecisionStatus = 'awaiting_disclosure'
          if (!settingsRouteOpened) {
            await navigateWithinRenderer('/settings/mcp')
            await waitFor('location.pathname === "/settings/mcp" && Boolean(document.querySelector("[data-testid=mcp-settings-page]"))')
            settingsRouteOpened = true
          }
          const cardVisible = await evaluate('Boolean(document.querySelector("[data-testid^=\\"mcp-pending-\\"]"))').catch(() => false)
          if (cardVisible) providerDisclosureCardObserved = true
          if (!waitingStatusSent) {
            waitingStatusSent = true
            status('WAITING_FOR_PROVIDER_DISCLOSURE_IN_MCP_SETTINGS')
          }
        }
      }
      if (!configureRequestedDisclosure && !sawMatchingAction && Date.now() + 500 >= deadline) {
        providerDisclosureDecisionStatus = null
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (sawMatchingAction || configureRequestedDisclosure) {
      providerDisclosureDecisionStatus ||= 'not_found'
      throw Object.assign(new Error('PROVIDER_DISCLOSURE_UNRESOLVED'), { code: 'PROVIDER_DISCLOSURE_UNRESOLVED' })
    }
    return false
  }

  async function returnToOriginalCanvasAfterDisclosure() {
    const route = `/canvas/${opened.project.canvasId}`
    try {
      await navigateWithinRenderer(route)
      await waitFor(`location.pathname === ${JSON.stringify(route)} && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))`)
      await waitFor(`window.vibepaperDesktop.getMcpState().then((state) => state.canvasReady === true
        && state.activeCanvas?.projectId === ${JSON.stringify(opened.project.projectId)}
        && state.activeCanvas?.canvasId === ${JSON.stringify(opened.project.canvasId)})`)
      canvasReadyAfterDisclosureReturn = true
      status('ORIGINAL_CANVAS_READY_AFTER_PROVIDER_DISCLOSURE')
    } catch {
      canvasReadyAfterDisclosureReturn = false
      throw Object.assign(new Error('MCP_CANVAS_REENTRY_TIMEOUT'), { code: 'MCP_CANVAS_REENTRY_TIMEOUT' })
    }
  }

  async function readScopedGenerationActions() {
    return evaluate(`(async () => {
      const response = await window.vibepaperDesktop.getMcpPendingActions()
      const actions = Array.isArray(response) ? response : (response?.actions || [])
      return actions.filter((action) => action?.kind === 'generation'
        && action.clientId === ${JSON.stringify(grantClientId)}
        && action.projectId === ${JSON.stringify(opened.project.projectId)}
        && action.canvasId === ${JSON.stringify(opened.project.canvasId)})
        .map((action) => ({ proposalId: action.proposalId, status: action.status }))
    })()`)
  }

  async function settleExistingMediaTask(modality) {
    const deadline = Date.now() + 35 * 60_000
    let noTaskDeadline = Date.now() + 30_000
    const taskCountKey = `${modality}TaskCount`
    const taskStatusKey = `${modality}TaskStatus`
    while (Date.now() < deadline) {
      const canvas = await inspectFinalCanvas()
      latestCanvasSummary = canvas
      if (canvas[taskCountKey] > 1) throw Object.assign(new Error('GENERATION_ACTION_AMBIGUOUS'), { code: 'GENERATION_ACTION_AMBIGUOUS' })
      if (canvas[taskCountKey] === 1) {
        if (resumeMode && ['failed', 'cancelled'].includes(canvas[taskStatusKey])) {
          throw Object.assign(new Error('RESUME_MEDIA_TASK_INVALID'), { code: 'RESUME_MEDIA_TASK_INVALID' })
        }
        if (resumeMode && !['queued', 'running', 'succeeded'].includes(canvas[taskStatusKey])) {
          throw Object.assign(new Error('RESUME_MEDIA_TASK_AMBIGUOUS'), { code: 'RESUME_MEDIA_TASK_AMBIGUOUS' })
        }
        if (['succeeded', 'failed', 'cancelled'].includes(canvas[taskStatusKey])) return canvas
      } else {
        const actions = await readScopedGenerationActions()
        if (actions.length > 1) throw Object.assign(new Error('GENERATION_ACTION_AMBIGUOUS'), { code: 'GENERATION_ACTION_AMBIGUOUS' })
        const pending = actions[0]
        if (pending && ['rejected', 'cancelled', 'expired', 'invalidated', 'denied'].includes(pending.status)) {
          throw Object.assign(new Error('GENERATION_CONFIRMATION_REJECTED'), { code: 'GENERATION_CONFIRMATION_REJECTED' })
        }
        if (pending && ['submission_unknown', 'submission-unknown'].includes(pending.status)) {
          throw Object.assign(new Error('GENERATION_SUBMISSION_UNCERTAIN'), { code: 'GENERATION_SUBMISSION_UNCERTAIN' })
        }
        if (pending?.status === 'awaiting_confirmation') {
          throw Object.assign(new Error('GENERATION_CONFIRMATION_UNRESOLVED'), { code: 'GENERATION_CONFIRMATION_UNRESOLVED' })
        }
        if (Date.now() >= noTaskDeadline) break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw Object.assign(new Error('EXISTING_MEDIA_TASK_TIMEOUT'), { code: 'EXISTING_MEDIA_TASK_TIMEOUT' })
  }

  async function waitForOperatorContinue() {
    const decision = qaWorkerControl.waitForOperatorMediaGate({ timeoutMs: 55 * 60_000 })
    status('CONFIGURATION_VERIFIED_WAITING_FOR_PAID_MEDIA')
    const approved = await decision
    if (!approved) throw Object.assign(new Error('OPERATOR_MEDIA_GATE_CANCELLED'), { code: 'OPERATOR_MEDIA_GATE_CANCELLED' })
    status('OPERATOR_APPROVED_PAID_MEDIA')
    return true
  }

  async function stopOwnedCli() {
    if (cliHostClose) {
      const close = cliHostClose
      cliHostClose = null
      await close().catch(() => {})
      return
    }
    if (!cliChild || cliChild.exitCode !== null || cliChild.signalCode !== null || !Number.isInteger(cliChild.pid)) return
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = childSpawn('taskkill.exe', ['/PID', String(cliChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.once('error', resolve)
        killer.once('close', resolve)
        setTimeout(resolve, 3_000).unref()
      })
    } else cliChild.kill('SIGTERM')
  }

  async function startCodexTurn(stage, prompt) {
    const desktopState = await evaluate('window.vibepaperDesktop.getMcpState()')
    status(`CODEX_DESKTOP_CANVAS_READY_${desktopState?.canvasReady === true ? 'YES' : 'NO'}`)
    const server = parseCodexConfig(clientConfig)
    const { override, bridgeAppDataIsolated } = buildCodexOverride(server, runRoot, stage)
    const executable = resolveCodexExecutable()
    const { environment, systemProxyAddressProvided } = buildCodexEnvironment(secretValue)
    const codexCliAppDataPreserved = environment.APPDATA === process.env.APPDATA
    const cwd = projectDirectory
    const trace = createSafeTraceParser()
    const stderrDiagnostics = createSafeStderrClassifier()
    status(`CODEX_STAGE_${stage.toUpperCase()}_STARTED`)
    if (appServerHost) {
      const prefix = 'mcp_servers.vibepaper='
      if (!override.startsWith(prefix)) throw Object.assign(new Error('CODEX_MCP_CONFIG_INVALID'), { code: 'CODEX_MCP_CONFIG_INVALID' })
      const configHome = environment.CODEX_HOME || path.join(environment.USERPROFILE || os.homedir(), '.codex')
      let configText = ''
      try { configText = fsSync.readFileSync(path.join(configHome, 'config.toml'), 'utf8') }
      catch (error) { if (error?.code !== 'ENOENT') throw Object.assign(new Error('CODEX_MCP_CONFIG_INVALID'), { code: 'CODEX_MCP_CONFIG_INVALID' }) }
      const { createVibePaperOnlyOverride, startCodexAppServerTurn } = require('./codex-app-server-acceptance-host.cjs')
      const appServerOverrides = createVibePaperOnlyOverride(override.slice(prefix.length), configText)
      const host = await startCodexAppServerTurn({
        executable,
        overrides: appServerOverrides,
        useClientDefaultModel: true,
        cwd,
        environment,
        prompt,
        timeoutMs: 37 * 60_000,
        onTrace: (event) => trace.accept(JSON.stringify(event)),
        onStderr: (chunk) => stderrDiagnostics.accept(chunk),
        onRequestError: ({ method, code }) => {
          const safeMethod = ['initialize', 'model/list', 'thread/start', 'mcpServerStatus/list', 'turn/start'].includes(method)
            ? method.replaceAll('/', '_').toUpperCase() : 'OTHER'
          status(`CODEX_RPC_${safeMethod}_ERROR_${safeJsonRpcErrorCodes.has(code) ? code : 'OTHER'}`)
        },
        onScope: (summary) => {
          status(`CODEX_SCOPE_SERVERS_${summary.serverCount}`)
          status(`CODEX_SCOPE_PAGINATED_${summary.paginated ? 'YES' : 'NO'}`)
          for (const state of summary.vibePaperStatuses) status(`CODEX_SCOPE_VIBE_${state.toUpperCase()}`)
          for (const [state, count] of Object.entries(summary.otherStatuses)) status(`CODEX_SCOPE_OTHER_${state.toUpperCase()}_${count}`)
          status(`CODEX_SCOPE_OTHER_WITH_TOOLS_${summary.otherWithTools}`)
        },
        onElicitation: (params, { signal }) => relayCodexGenerationElicitation(params, stage, signal),
      }).catch((error) => {
        environment[secretEnvName] = ''
        finishAppServerTurn('failed')
        throw error
      })
      environment[secretEnvName] = ''
      cliChild = host.child
      cliHostClose = host.close
      function finishAppServerTurn(turnStatus) {
        const summary = trace.summary()
        const output = { stage, exitCode: turnStatus === 'completed' ? 0 : 1, terminationSignal: null,
          turnCompleted: turnStatus === 'completed' && summary.turnCompleted,
          errorEventSeen: summary.errorEventSeen, trace: summary, systemProxyAddressProvided,
          codexCliAppDataPreserved, mcpBridgeAppDataIsolated: bridgeAppDataIsolated,
          stderrDiagnostics: stderrDiagnostics.summary() }
        cliTurns.push(output)
        stderrDiagnostics.clear()
        return output
      }
      const result = host.result.then((turn) => finishAppServerTurn(turn?.status), (error) => {
        finishAppServerTurn('failed')
        throw error
      })
      return { child: host.child, result, trace, close: host.close }
    }
    const args = [
      '--ask-for-approval', 'on-request', '-c', override,
      'exec', '--ignore-user-config', '--ephemeral', '--disable', 'shell_tool',
      '--sandbox', 'read-only', '--json', '--skip-git-repo-check', '--cd', cwd, prompt,
    ]
    const child = spawn(executable, args, { cwd, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    environment[secretEnvName] = ''
    cliChild = child
    let stdoutBuffer = ''
    let settled = false
    let timeout
    const result = new Promise((resolve, reject) => {
      const finish = (code, signal, spawnError) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (stdoutBuffer.trim()) trace.accept(stdoutBuffer.trim())
        const summary = trace.summary()
        const stderrSummary = stderrDiagnostics.summary()
        const output = { stage, exitCode: Number.isInteger(code) ? code : null, terminationSignal: signal || null,
          turnCompleted: summary.turnCompleted, errorEventSeen: summary.errorEventSeen, trace: summary,
          systemProxyAddressProvided, codexCliAppDataPreserved,
          mcpBridgeAppDataIsolated: bridgeAppDataIsolated,
          stderrDiagnostics: stderrSummary }
        cliTurns.push(output)
        stderrDiagnostics.clear()
        stdoutBuffer = ''
        if (spawnError) reject(Object.assign(new Error('CODEX_PROCESS_SPAWN_FAILED'), { code: 'CODEX_PROCESS_SPAWN_FAILED' }))
        else resolve(output)
      }
      child.stdout?.on('data', (chunk) => {
        stdoutBuffer += String(chunk)
        let index
        while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, index).trim()
          stdoutBuffer = stdoutBuffer.slice(index + 1)
          trace.accept(line)
        }
        if (stdoutBuffer.length > 2_000_000) stdoutBuffer = stdoutBuffer.slice(-1_000_000)
      })
      child.stderr?.on('data', (chunk) => stderrDiagnostics.accept(chunk))
      child.once('error', () => finish(null, 'spawn-error', true))
      child.once('close', (code, signal) => finish(code, signal, false))
      timeout = setTimeout(() => {
        if (process.platform === 'win32' && Number.isInteger(child.pid)) {
          const killer = childSpawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.unref()
        } else child.kill('SIGTERM')
      }, 38 * 60_000)
    })
    return { child, result, trace }
  }

  async function runCodexStage(stage, prompt) {
    activeGenerationStage = stage
    try {
      const turn = await startCodexTurn(stage, prompt)
      const result = await turn.result
      if (result.exitCode !== 0 || !result.turnCompleted) {
        throw Object.assign(new Error(`CODEX_TURN_FAILED_${stage.toUpperCase()}`), { code: 'CODEX_TURN_FAILED' })
      }
      status(`CODEX_STAGE_${stage.toUpperCase()}_COMPLETED`)
      return result
    } finally {
      cliChild = null
      cliHostClose = null
      activeGenerationStage = null
    }
  }

  function aggregateToolTrace() {
    const names = new Set()
    const counts = Object.create(null)
    const statuses = Object.create(null)
    const isErrors = Object.create(null)
    const errorCodes = new Set()
    const jsonRpcErrorCodes = new Set()
    const httpStatusCodes = new Set()
    let unknownJsonRpcErrorCode = false
    let unknownHttpStatusCodeObserved = false
    const toolFailureFlags = {
      timeout: false, unknownSourceRef: false, environmentValueMissing: false,
      credentialSourceUnavailable: false, validationFailure: false, approvalDenied: false, transportFailure: false,
      otherFailure: false, policyBlocked: false, toolCallRejected: false, notPermitted: false, unsupported: false,
    }
    const cliErrorEventFlags = { ...toolFailureFlags }
    const toolErrorKeywordFlags = emptyDiagnosticKeywordFlags()
    const cliErrorKeywordFlags = emptyDiagnosticKeywordFlags()
    for (const turn of cliTurns) {
      for (const name of turn.trace.toolNames) names.add(name)
      for (const [name, count] of Object.entries(turn.trace.toolCalls)) counts[name] = (counts[name] || 0) + count
      Object.assign(statuses, turn.trace.toolStatuses)
      Object.assign(isErrors, turn.trace.toolIsErrors)
      for (const code of turn.trace.errorCodes) errorCodes.add(code)
      for (const code of turn.trace.jsonRpcErrorCodes || []) jsonRpcErrorCodes.add(code)
      unknownJsonRpcErrorCode ||= turn.trace.unknownJsonRpcErrorCode === true
      for (const code of turn.trace.httpStatusCodes || []) httpStatusCodes.add(code)
      unknownHttpStatusCodeObserved ||= turn.trace.unknownHttpStatusCodeObserved === true
      for (const key of Object.keys(toolFailureFlags)) {
        toolFailureFlags[key] ||= turn.trace.toolFailureFlags?.[key] === true
        cliErrorEventFlags[key] ||= turn.trace.cliErrorEventFlags?.[key] === true
      }
      for (const key of Object.keys(toolErrorKeywordFlags)) {
        toolErrorKeywordFlags[key] ||= turn.trace.toolErrorKeywordFlags?.[key] === true
        cliErrorKeywordFlags[key] ||= turn.trace.cliErrorKeywordFlags?.[key] === true
      }
    }
    return { toolNames: [...names].sort(), callCounts: { ...counts }, statuses: { ...statuses },
      isErrors: { ...isErrors }, errorCodes: [...errorCodes].sort(),
      jsonRpcErrorCodes: [...jsonRpcErrorCodes].sort((a, b) => a - b), unknownJsonRpcErrorCode,
      httpStatusCodes: [...httpStatusCodes].sort((a, b) => a - b), unknownHttpStatusCodeObserved,
      toolFailureFlags, cliErrorEventFlags, toolErrorKeywordFlags, cliErrorKeywordFlags }
  }

  async function getCanvasState() {
    const current = await evaluate('window.vibepaperDesktop.getActiveProject()')
    const mcpState = await evaluate('window.vibepaperDesktop.getMcpState()')
    const projectId = current?.project?.projectId || current?.projectId || opened.project.projectId
    const canvasId = mcpState?.activeCanvas?.canvasId || opened.project.canvasId
    const loaded = await evaluate(`window.vibepaperDesktop.loadCanvas(${JSON.stringify(projectId)}, ${JSON.stringify(canvasId)})`)
    const taskLimit = resumeMode ? 500 : 100
    const taskResponse = await evaluate(`window.vibepaperDesktop.listTasks(${JSON.stringify(projectId)}, ${taskLimit})`)
    const tasks = Array.isArray(taskResponse) ? taskResponse : taskResponse?.tasks || []
    return { projectId, canvasId, loaded, tasks }
  }

  function nodeHasText(node, marker) { return JSON.stringify(node).includes(marker) }

  async function focusCanvasForMediaInspection() {
    const focused = await evaluate(`(() => {
      const root = document.querySelector('[data-testid=mcp-canvas-page] .react-flow')
      if (!root) return false
      const button = root.querySelector('.react-flow__controls-fitview')
        || [...root.querySelectorAll('button')].find((candidate) => {
          const label = candidate.getAttribute('aria-label') || candidate.title || ''
          return /^(?:fit view|聚焦视图|适应视图|适应画布)$/iu.test(label.trim())
        })
      if (!button || button.disabled) return false
      button.click()
      return true
    })()`)
    if (!focused) throw Object.assign(new Error('UI_STATE_TIMEOUT'), { code: 'UI_STATE_TIMEOUT' })
    viewportFocusedForInspection = true
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  async function waitForMediaNode(nodeId, modality) {
    await focusCanvasForMediaInspection()
    const selector = modality === 'image' ? 'img[src^="vibe://"]' : 'video[src^="vibe://"]'
    const condition = `(() => {
      const root = document.querySelector('[data-testid=mcp-canvas-page]')
      const node = root?.querySelector('.react-flow__node[data-id="${nodeId}"]')
      const element = node?.querySelector(${JSON.stringify(selector)})
      if (!root || !node || !element) return false
      const rect = node.getBoundingClientRect(), rootRect = root.getBoundingClientRect()
      const style = getComputedStyle(node)
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
        && rect.width > 0 && rect.height > 0 && rect.right > Math.max(0, rootRect.left)
        && rect.left < Math.min(innerWidth, rootRect.right) && rect.bottom > Math.max(0, rootRect.top)
        && rect.top < Math.min(innerHeight, rootRect.bottom)
      ${modality === 'image'
        ? 'return visible && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0'
        : 'return visible && element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0 && Number.isFinite(element.duration) && element.duration > 0'}
    })()`
    await waitFor(condition, modality === 'video' ? 4 * 60_000 : 2 * 60_000)
    return evaluate(`(() => {
      const root = document.querySelector('[data-testid=mcp-canvas-page]')
      const node = root?.querySelector('.react-flow__node[data-id="${nodeId}"]')
      const element = node?.querySelector(${JSON.stringify(selector)})
      if (!root || !node || !element) return { nodeRendered: Boolean(node), mediaRendered: false, visible: false }
      const rect = node.getBoundingClientRect(), rootRect = root.getBoundingClientRect()
      const style = getComputedStyle(node)
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
        && rect.width > 0 && rect.height > 0 && rect.right > Math.max(0, rootRect.left)
        && rect.left < Math.min(innerWidth, rootRect.right) && rect.bottom > Math.max(0, rootRect.top)
        && rect.top < Math.min(innerHeight, rootRect.bottom)
      return { nodeRendered: true, mediaRendered: element.currentSrc.startsWith('vibe://'), visible,
        complete: ${modality === 'image' ? 'element.complete' : 'element.readyState >= 2'},
        modality: ${JSON.stringify(modality)} }
    })()`)
  }

  async function readConfiguredModelSnapshot() {
    const state = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
    const provider = state.providers.find((item) => item.id === 'agnes')
    const expectedModels = [
      { modality: 'image', label: 'Agnes Image 2.5 Flash' },
      { modality: 'video', label: 'Agnes Video 2.5 Flash' },
    ]
    const configuredModels = expectedModels.map(({ modality, label }) => {
      const model = (state.models || []).find((entry) => entry.providerId === 'agnes' && entry.modelType === modality
        && String(entry.displayName || entry.name || '').trim().toLowerCase() === label.toLowerCase())
      const enabled = Boolean(model?.enabled && provider.enabledModelIds?.includes(model.id)
        && provider.defaultModelIds?.[modality] === model.id)
      return { modality, label, enabled }
    })
    return { provider, configuredModels }
  }

  async function assertConfiguredModels() {
    const { provider, configuredModels } = await readConfiguredModelSnapshot()
    if (!provider?.configured) throw Object.assign(new Error('AGNES_PROVIDER_NOT_CONFIGURED'), { code: 'AGNES_PROVIDER_NOT_CONFIGURED' })
    if (configuredModels.some((entry) => !entry.enabled)) {
      throw Object.assign(new Error('AGNES_MODELS_NOT_ENABLED'), { code: 'AGNES_MODELS_NOT_ENABLED' })
    }
    if (providerConnectionTestStatus !== 'unsupported') {
      throw Object.assign(new Error('PROVIDER_TEST_NOT_UNSUPPORTED'), { code: 'PROVIDER_TEST_NOT_UNSUPPORTED' })
    }
    return { provider, configuredModels }
  }

  async function createFixture() {
    await fs.mkdir(profile, { recursive: true })
    await fs.mkdir(projectDirectory, { recursive: true })
    const store = createLocalProjectStore()
    try {
      opened = await store.createProject(projectDirectory, 'Codex Agnes media acceptance')
      await store.createNode({ projectId: opened.project.projectId, canvasId: opened.project.canvasId,
        expectedVersion: 0, type: 'text', params: { content: videoOnly
          ? '蓝色陶瓷方块在白色影棚背景中缓慢旋转，固定镜头，无文字。'
          : 'Agnes media acceptance canvas' },
        x: 100, y: 100, idempotencyKey: `codex-agnes-seed-${randomUUID()}` })
    } finally { await store.close() }
    await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: opened.directory }))
  }

  async function openResumeProjectForPreflight() {
    const validated = await validateResumeMediaProjectPath(projectDirectory)
    if (validated.sourceRunName !== resumeProject.sourceRunName
      || !samePath(validated.projectDirectory, resumeProject.projectDirectory)) invalidResumeMediaProjectPath()
    const store = createLocalProjectStore()
    try {
      opened = await store.openProject(validated.projectDirectory)
      if (!samePath(opened.directory, validated.projectDirectory)) invalidResumeMediaProjectPath()
      const canvas = store.loadCanvas(opened.project.projectId, opened.project.canvasId)
      const tasks = await store.listTasks(opened.project.projectId, 100)
      resumePlan = classifyResumeMediaSnapshot(canvas, tasks)
    } finally {
      await store.close()
    }
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({
      schemaVersion: 1,
      projectDirectory: opened.directory,
    }))
  }

  async function verifyResumeProjectAfterDesktopOpen() {
    const state = await getCanvasState()
    if (state.projectId !== opened.project.projectId || state.canvasId !== opened.project.canvasId) {
      throw Object.assign(new Error('QA_ASSERTION_FAILED'), { code: 'QA_ASSERTION_FAILED' })
    }
    const currentPlan = classifyResumeMediaSnapshot(state.loaded, state.tasks)
    if (currentPlan.imageTaskKey !== resumePlan?.imageTaskKey
      || currentPlan.videoTaskKey !== resumePlan?.videoTaskKey) {
      throw Object.assign(new Error('RESUME_MEDIA_TASK_AMBIGUOUS'), { code: 'RESUME_MEDIA_TASK_AMBIGUOUS' })
    }
    resumePlan = currentPlan
    resumeIdentityPreserved = true
  }

  async function setupApplication() {
    if (resumeMode) await openResumeProjectForPreflight()
    else await createFixture()
    installPublicDiagnostics()
    require('../src/main.cjs')
    await app.whenReady()
    if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('SECURE_STORAGE_UNAVAILABLE'), { code: 'SECURE_STORAGE_UNAVAILABLE' })
    await waitFor("location.pathname === '/workspace' && document.querySelector('[role=button]')")
    await evaluate("document.querySelector('[role=button]').click()")
    await waitFor(`location.pathname === ${JSON.stringify(`/canvas/${opened.project.canvasId}`)} && document.querySelector('[data-testid=mcp-canvas-page] .react-flow')`)
    await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
    if (resumeMode) await verifyResumeProjectAfterDesktopOpen()
    await evaluate('window.vibepaperDesktop.setMcpEnabled(true)')
    const mcpState = await evaluate('window.vibepaperDesktop.getMcpState()')
    const grant = await evaluate(`window.vibepaperDesktop.createMcpClientGrant(${JSON.stringify({
      clientName: 'codex', displayName: 'Codex Agnes full-chain acceptance',
      permissions: ['canvas.read', 'canvas.write', 'generation.propose', 'task.read', 'media.read', 'provider.read', 'provider.configure'],
      providerGrants: [{ providerId: 'agnes', credentialFields: ['apiKey'], credentialInputModes: ['authorized_env'],
        authorizedEnv: [{ fieldName: 'apiKey', envVariableName: secretEnvName }] }],
      mediaTypes: ['image', 'video'],
      disclosureVersion: mcpState.connectionDisclosureVersion || 'desktop-mcp-provider-disclosure-v1',
      accepted: true,
    })})`)
    clientConfig = grant?.config?.codex
    if (typeof clientConfig !== 'string') throw Object.assign(new Error('CODEX_MCP_CONFIG_UNAVAILABLE'), { code: 'CODEX_MCP_CONFIG_UNAVAILABLE' })
    const state = await evaluate('window.vibepaperDesktop.getMcpState()')
    const client = state.clients.find((entry) => entry.clientName === 'codex' && !entry.revokedAt)
    if (!client) throw Object.assign(new Error('MCP_GRANT_UNAVAILABLE'), { code: 'MCP_GRANT_UNAVAILABLE' })
    grantClientId = client.clientId
    if (!window || window.isDestroyed()) throw Object.assign(new Error('RENDERER_UNAVAILABLE'), { code: 'RENDERER_UNAVAILABLE' })
    window.show()
    window.focus()
    status('ISOLATED_DESKTOP_READY')
  }

  const prompts = {
    configure: [
      '请通过已连接的 Pi-Paper 操作当前授权画布并读取可用模型/Agnes 配置。桌面已授权本次提供方配置及只写入的本地凭据来源，无需向我索取或展示Key明文。',
      '使用当前 Agnes 配置列出的本地授权凭据来源，选择可用来源并将其关联到对应的密钥凭据字段；不要索要或展示密钥正文。启用并分别设置默认图片型号“Agnes Image 2.5 Flash”和视频型号“Agnes Video 2.5 Flash”。请按模型目录中的官方能力和默认参数配置；图片用 1K、1:1，视频用文本模式、4 秒、720P、16:9。',
      '请执行可用的连接检测；若系统明确返回不支持，请如实报告“不支持检测”，不要把它说成鉴权成功。配置和安全检测不要求人工批准。此阶段只配置和检测，不提交图片或视频生成。',
      '只根据当前画布和模型目录的信息操作，不运行命令、不读取文件、不复述任何凭据。用简短中文报告配置状态、检测状态和显示型号。',
    ].join('\n'),
    configureResume: [
      'Agnes 配置范围已授权并自动记录发送信息，系统核对当前仍未保存本次密钥和默认模型。请完成尚未保存的配置：先重新读取当前 Agnes 公开配置、可用型号和本轮授权凭据来源。若已有完整配置则保留并核验。',
      '本轮已授权通过本地凭据来源写入密钥，请使用公开配置返回的来源引用完成保存；保存动作无需读取或显示密钥正文。请把来源关联到对应密钥字段，并启用及设置默认图片型号“Agnes Image 2.5 Flash”和视频型号“Agnes Video 2.5 Flash”，参数按目录配置为图片 1K、1:1，视频文本模式、4 秒、720P、16:9。',
      '请先完成保存并重新读取公开配置确认，再执行不创建生成任务的连接检测；如结果为不支持，请明确报告“不支持检测”，不得说成鉴权成功。不要索要密钥正文，不要创建节点、图片、视频或任何媒体任务，不运行命令，不读取文件。',
    ].join('\n'),
    image: [
      '请重新读取当前画布、Agnes 提供方配置和已有任务，完成本阶段的图片创作；已经存在的节点或已提交任务不要重复创建或再次提交。',
      '在画布里创建一个文字参考节点，内容描述蓝色陶瓷方块置于白色影棚背景、柔和自然阴影、无文字，并命名为“蓝色陶瓷方块参考说明”；再创建一个图片目标节点，命名为“蓝色陶瓷方块海报”，只连接该文字参考节点到图片目标节点一次。只对图片目标节点使用“Agnes Image 2.5 Flash”生成一张 1K、1:1 图片。',
      '生成时在当前客户端请求用户确认，不能自动批准或改为桌面确认；若当前客户端不支持确认，请报告该限制并结束。批准后查询这次任务，再通过授权预览读取已保存图片并核对原目标节点。若提交结果不确定，先查询现有操作和任务，不得重新提交；若生成任务或厂商请求明确失败，请如实报告并结束，不要重试。',
      '普通画布写入若提示版本已更新，先重新读取当前画布并核对该操作是否已经生效；只有确认没有写入时，才可按最新版本继续该普通操作，最多重试一次。生成提案和生成提交只能尝试一次，不得重放。',
      '不要生成视频，不要输出任何内部标识或凭据。结束时简要报告显示型号、任务状态、预览读取及原节点显示状态。',
    ].join('\n'),
    imageQuery: '请只查询当前授权画布上已经提交的图片任务并读取其已保存的授权图片预览，核对原图片节点结果。不要创建或修改任何节点，不要准备或提交生成，不要重新生成或重试；如任务失败请如实报告。不要运行命令、读取文件或输出内部标识与凭据。',
    video: [
      '请重新读取当前画布、Agnes 提供方配置和已有任务，完成本阶段的视频创作；先查询已有内容，绝不要重复图片生成，也不要重复已提交的视频任务。',
      '如果画布上已有唯一且没有视频任务的空视频节点，就复用该节点；如果没有视频节点，才新增一个独立视频节点。若出现多个视频节点或已有视频任务，停止并报告，不要创建节点或提交。目标内容为蓝色陶瓷方块在白色影棚背景中缓慢旋转、固定镜头、无文字；不使用参考图片或其他媒体输入。只使用“Agnes Video 2.5 Flash”，文本模式，4 秒、720P、16:9，生成一条视频。',
      '生成时在当前客户端请求用户确认，不能自动批准或改为桌面确认；若当前客户端不支持确认，请报告该限制并结束。批准后查询这次任务，再通过授权预览读取已保存视频并核对原视频节点。若提交结果不确定，先查询现有操作和任务，不得重新提交；若生成任务或厂商请求明确失败，请如实报告并结束，不要重试。',
      '普通画布写入若提示版本已更新，先重新读取当前画布并核对该操作是否已经生效；只有确认没有写入时，才可按最新版本继续该普通操作，最多重试一次。生成提案和生成提交只能尝试一次，不得重放。',
      '不要生成图片，不要输出任何内部标识或凭据。结束时简要报告显示型号、任务状态、预览读取及原节点显示状态。',
    ].join('\n'),
    videoOnly: [
      '请读取当前授权画布、模型目录和任务。当前隔离项目只有一个文字参考节点，没有媒体节点和媒体任务。此模式只验收视频链路，不生成图片。',
      '复用现有文字参考节点，创建且只创建一个视频目标节点，命名为“蓝色陶瓷方块旋转视频”，只将文字参考节点连接到该视频节点一次。不要创建其他节点、不要创建图片节点。画面为蓝色陶瓷方块在白色影棚背景中缓慢旋转、固定镜头、无文字，不使用图片或其他媒体输入。只使用 Agnes Video 2.5 Flash，文本模式，4 秒、720P、16:9，生成一条视频。',
      '生成前必须通过当前 Codex 客户端的 MCP form elicitation 请求本次用户确认；不得自动批准或改用桌面确认。若客户端不支持确认，报告限制并停止。确认后查询本次视频任务并读取授权视频预览，核对结果显示在刚创建的原视频节点。若提交状态不确定，先查账本；不得重新提交。若生成失败，如实报告并停止，不要重试。',
      '普通节点或连线写入若出现版本冲突，先重读画布，确认尚未生效后最多重试一次。生成提案和任务只允许一次。不要生成图片，不要输出提示词、内部标识或凭据。',
    ].join('\n'),
    videoOnlyReadback: [
      '请重新读取当前画布和任务，只核对本轮唯一的视频任务及其结果。',
      '读取已成功视频任务的授权预览，确认显示型号、结果类型和完成状态，并检查视频确实显示在原视频节点。不得创建节点或提交任何生成。',
      '用简短中文总结视频任务状态、预览读取及原节点显示状态；不要生成图片，不要输出提示词、节点/任务标识或凭据。',
    ].join('\n'),
    videoQuery: '请只查询当前授权画布上已经提交的视频任务并读取其已保存的授权视频预览，核对原视频节点结果。不要创建或修改任何节点，不要准备或提交生成，不要重新生成或重试；如任务失败请如实报告。不要运行命令、读取文件或输出内部标识与凭据。',
    readback: [
      '请重新读取当前画布、可用模型配置和已有任务，核对本次 Agnes 图片与视频结果，不要创建节点或提交任何生成。',
      '分别读取已成功图片和视频任务的授权预览，确认模型显示名称、结果类型和完成状态；检查图片与视频确实显示在各自原节点。只使用当前已存在的任务，若任何结果失败或不确定就如实说明，不要重试。',
      '用简短中文总结配置/连接检测状态、图片和视频任务状态及各自预览读取状态；不要输出提示词、节点/任务标识或凭据。',
    ].join('\n'),
  }

  async function cleanupCredentials() {
    if (!window || window.isDestroyed()) return
    try {
      const state = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
      const provider = state.providers.find((entry) => entry.id === 'agnes')
      if (provider?.configured) {
        const result = await evaluate(`window.vibepaperDesktop.clearProviderConfiguration('agnes', ${provider.revision})`)
        providerCredentialCleared = result?.configured === false || result?.status === 'cleared'
        if (!providerCredentialCleared) {
          const after = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
          providerCredentialCleared = after.providers.find((entry) => entry.id === 'agnes')?.configured === false
        }
      } else providerCredentialCleared = true
    } catch { providerCredentialCleared = false }
    try {
      if (grantClientId) {
        await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grantClientId)})`)
        const state = await evaluate('window.vibepaperDesktop.getMcpState()')
        const grant = state.clients.find((entry) => entry.clientId === grantClientId)
        grantRevoked = Boolean(grant?.revokedAt && grant.connected === false)
      } else grantRevoked = true
    } catch { grantRevoked = false }
  }

  async function inspectFinalCanvas() {
    const state = await getCanvasState()
    const nodes = Array.isArray(state.loaded?.nodes) ? state.loaded.nodes : []
    const edges = Array.isArray(state.loaded?.edges) ? state.loaded.edges : []
    const allImageTasks = state.tasks.filter((task) => task.modality === 'image')
    const allVideoTasks = state.tasks.filter((task) => task.modality === 'video')
    const markedImages = nodes.filter((node) => node.type === 'image' && nodeHasText(node, '蓝色陶瓷方块海报'))
    const imageNodes = nodes.filter((node) => node.type === 'image')
    const imageTaskNode = allImageTasks.length === 1
      ? nodes.find((node) => node.id === allImageTasks[0].nodeId && node.type === 'image') : null
    const targetImage = videoOnly ? null : resumeMode
      ? imageNodes.length === 1 && allImageTasks.length === 1 ? imageTaskNode : null
      : markedImages.length === 1 ? markedImages[0] : null
    const markedReference = nodes.find((node) => node.type === 'text' && nodeHasText(node, '蓝色陶瓷方块参考说明'))
    const edgeSource = (edge) => edge.sourceNodeId || edge.source
    const edgeTarget = (edge) => edge.targetNodeId || edge.target
    const targetIncomingEdges = targetImage ? edges.filter((edge) => edgeTarget(edge) === targetImage.id) : []
    const edgeReference = targetIncomingEdges.length === 1
      ? nodes.find((node) => node.id === edgeSource(targetIncomingEdges[0]) && node.type === 'text') : null
    const referenceImage = videoOnly ? null : resumeMode ? edgeReference : markedReference || edgeReference
    const videoOnlyReference = videoOnly
      ? nodes.find((node) => node.type === 'text' && nodeHasText(node, '蓝色陶瓷方块在白色影棚背景中缓慢旋转')) : null
    const markedVideoNodes = nodes.filter((node) => node.type === 'video' && nodeHasText(node, '蓝色陶瓷方块')
      && (nodeHasText(node, '缓慢旋转') || nodeHasText(node, '固定镜头')))
    const videoTaskNode = allVideoTasks.length === 1
      ? nodes.find((node) => node.id === allVideoTasks[0].nodeId && node.type === 'video') : null
    const videoNodes = nodes.filter((node) => node.type === 'video')
    const videoOnlyNodes = videoOnly
      ? videoNodes.filter((node) => nodeHasText(node, '蓝色陶瓷方块旋转视频')) : []
    const videoNode = videoOnly
      ? videoNodes.length === 1 && videoOnlyNodes.length === 1 ? videoOnlyNodes[0] : null
      : resumeMode
      ? videoNodes.length === 1 && allVideoTasks.length <= 1 ? videoTaskNode || videoNodes[0] : null
      : markedVideoNodes.length === 1 ? markedVideoNodes[0] : null
    const expectedEdges = referenceImage && targetImage
      ? edges.filter((edge) => edgeSource(edge) === referenceImage.id && edgeTarget(edge) === targetImage.id)
      : []
    const touchingEdges = edges.filter((edge) => [edgeSource(edge), edgeTarget(edge)]
      .some((id) => [referenceImage?.id, targetImage?.id, videoOnlyReference?.id, videoNode?.id].includes(id)))
    const tasksFor = (node, modality) => state.tasks.filter((task) => task.nodeId === node?.id && task.modality === modality)
    const imageTasks = tasksFor(targetImage, 'image')
    const videoTasks = tasksFor(videoNode, 'video')
    const imageTask = imageTasks[0]
    const videoTask = videoTasks[0]
    const outputFingerprint = (task) => {
      const output = Array.isArray(task?.outputs) ? task.outputs[0] : null
      if (!output || !/^[a-f0-9]{64}$/u.test(output.sha256 || '')
        || !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes < 1) return null
      return { sha256: output.sha256, sizeBytes: output.sizeBytes }
    }
    return {
      loadedNodeCount: nodes.length,
      imageNodeCount: imageNodes.length,
      videoNodeCount: videoNodes.length,
      createdImageNodeCount: resumeMode
        ? targetImage && allImageTasks.length === 1 ? 1 : 0
        : videoOnly ? imageNodes.length : markedImages.length,
      createdVideoNodeCount: videoOnly ? videoNodes.length : markedVideoNodes.length,
      imageReferencePresent: Boolean(referenceImage),
      imageTargetPresent: Boolean(targetImage),
      videoReferencePresent: Boolean(videoOnlyReference),
      videoTargetPresent: Boolean(videoNode),
      imageTaskCount: imageTasks.length,
      videoTaskCount: videoTasks.length,
      allImageTaskCount: allImageTasks.length,
      allVideoTaskCount: allVideoTasks.length,
      imageReferenceToTargetEdgeCount: expectedEdges.length,
      videoReferenceToTargetEdgeCount: videoOnly && videoOnlyReference && videoNode
        ? edges.filter((edge) => edgeSource(edge) === videoOnlyReference.id && edgeTarget(edge) === videoNode.id).length : 0,
      edgesTouchingAcceptanceNodes: touchingEdges.length,
      imageTaskStatus: safeStatus(imageTask?.status || imageTask?.state),
      videoTaskStatus: safeStatus(videoTask?.status || videoTask?.state),
      imageTaskOutputCount: Array.isArray(imageTask?.outputs) ? imageTask.outputs.length : null,
      videoTaskOutputCount: Array.isArray(videoTask?.outputs) ? videoTask.outputs.length : null,
      imageTaskOutputFingerprint: outputFingerprint(imageTask),
      videoTaskOutputFingerprint: outputFingerprint(videoTask),
      imageTaskErrorCode: safeErrorCode({ code: imageTask?.errorCode }, null),
      videoTaskErrorCode: safeErrorCode({ code: videoTask?.errorCode }, null),
      imageTaskSuccess: Boolean(imageTask && (imageTask.status === 'succeeded' || imageTask.state === 'succeeded')),
      videoTaskSuccess: Boolean(videoTask && (videoTask.status === 'succeeded' || videoTask.state === 'succeeded')),
      imageNodeId: targetImage?.id || null,
      videoNodeId: videoNode?.id || null,
      referenceNodeId: referenceImage?.id || null,
      imageTaskId: imageTask?.taskId || imageTask?.id || null,
      videoTaskId: videoTask?.taskId || videoTask?.id || null,
    }
  }

  try {
    status('STARTING_ISOLATED_DESKTOP')
    await setupApplication()
    phase = 'codex-natural-language-provider-configuration'
    await runCodexStage('configuration', prompts.configure)
    const configured = await assertConfiguredModels()
    providerConfigured = true
    configurationVerified = configured.provider.configured && configured.configuredModels.every((entry) => entry.enabled)
    if (!configurationVerified) throw Object.assign(new Error('AGNES_MODELS_NOT_ENABLED'), { code: 'AGNES_MODELS_NOT_ENABLED' })
    if (configurationOnly) {
      const current = await inspectFinalCanvas()
      const authority = await getCanvasState()
      if (current.imageTaskCount !== 0 || current.videoTaskCount !== 0 || authority.tasks.length !== 0
        || nativeApprovalDialogsObserved !== 0 || pairedConnections !== 0) {
        throw Object.assign(new Error('QA_ASSERTION_FAILED'), { code: 'QA_ASSERTION_FAILED' })
      }
      const pending = await evaluate('window.vibepaperDesktop.getMcpPendingActions()')
      if ((Array.isArray(pending) ? pending : pending?.actions || []).some((action) =>
        ['awaiting_pairing', 'awaiting_disclosure'].includes(action.status))) {
        throw Object.assign(new Error('QA_ASSERTION_FAILED'), { code: 'QA_ASSERTION_FAILED' })
      }
      await cleanupCredentials()
      if (!providerCredentialCleared || !grantRevoked) throw Object.assign(new Error('CREDENTIAL_CLEANUP_FAILED'), { code: 'CREDENTIAL_CLEANUP_FAILED' })
      const trace = aggregateToolTrace()
      await fs.writeFile(resultPath, JSON.stringify({ schemaVersion: 1, success: true,
        testType: appServerHost ? 'real Codex app-server provider configuration without manual approval'
          : 'real Codex CLI natural-language provider configuration without manual approval',
        confirmationPolicy: 'client-form-generation-only-2026-10-17',
        clientHost: appServerHost ? 'codex-app-server-qa-relay' : 'codex-cli-exec',
        nativeCodexPopupAccepted: false,
        generationConfirmationsObserved, generationConfirmationResponses, generationConfirmationsConfirmed,
        phase: 'configuration-completed', provider: 'Agnes', providerConfigurationSaved: true,
        providerModelsEnabled: true, providerConnectionTestStatus, pairedConnectionCount: pairedConnections,
        nativeApprovalDialogsObserved,
        desktopPairingOrDisclosureApprovalRequired: false, fullMediaChainAccepted: false,
        taskStoreSubmittedMediaTaskCount: 0, toolNamesObserved: trace.toolNames,
        mainWorkerToolCallCounts: { ...mcpDiagnostics.calls }, publicRpcResponses: mcpDiagnostics.rpcResponses,
        generationModelReferenceChecks,
        cliExitCodes: cliTurns.map((turn) => turn.exitCode), cliTurnSummaries: safeCliTurnSummaries(),
        credentialsClearedViaDesktopIpc: providerCredentialCleared, testGrantRevoked: grantRevoked,
        rawClientTranscriptSaved: false, apiKeySavedInEvidence: false, startedAt, completedAt: new Date().toISOString(),
      }, null, 2))
      secretValue = undefined
      secretBytes.fill(0)
      status('COMPLETE_CONFIGURATION_SUCCESS')
      app.quit()
      return
    }
    let canvas
    if (videoOnly) {
      paidMediaAuthorizedByOperator = await waitForOperatorContinue()
      phase = 'codex-natural-language-video-generation'
      await runCodexStage('video', prompts.videoOnly)
      canvas = await settleExistingMediaTask('video')
      latestCanvasSummary = canvas
    } else if (resumeMode) {
      // The image task is authoritative and already succeeded. Resume may query
      // and inspect it, but never enters the image preparation stage.
      phase = 'codex-natural-language-image-query'
      await runCodexStage('image-query', prompts.imageQuery)
      canvas = await settleExistingMediaTask('image')
      latestCanvasSummary = canvas
      imageTaskReused = true
      if (canvas.createdImageNodeCount !== 1 || canvas.imageNodeCount !== 1 || canvas.allImageTaskCount !== 1
        || !canvas.imageReferencePresent || !canvas.imageTargetPresent
        || canvas.imageReferenceToTargetEdgeCount !== 1 || canvas.imageTaskCount !== 1
        || !canvas.imageTaskSuccess || canvas.imageTaskOutputCount !== 1) {
        throw Object.assign(new Error('IMAGE_CHAIN_ASSERTION_FAILED'), { code: 'IMAGE_CHAIN_ASSERTION_FAILED' })
      }
      imageResult = await waitForMediaNode(canvas.imageNodeId, 'image')

      if (resumePlan.videoTaskPresent) {
        phase = 'codex-natural-language-video-query'
        await runCodexStage('video-query', prompts.videoQuery)
        canvas = await settleExistingMediaTask('video')
        latestCanvasSummary = canvas
        videoTaskReused = true
      } else {
        paidMediaAuthorizedByOperator = await waitForOperatorContinue()
        phase = 'codex-natural-language-video-generation'
        await runCodexStage('video', prompts.video)
        canvas = await settleExistingMediaTask('video')
        latestCanvasSummary = canvas
      }
    } else {
      paidMediaAuthorizedByOperator = await waitForOperatorContinue()
      phase = 'codex-natural-language-image-generation'
      await runCodexStage('image', prompts.image)
      canvas = await settleExistingMediaTask('image')
      latestCanvasSummary = canvas
      if (canvas.createdImageNodeCount !== 1 || !canvas.imageReferencePresent || !canvas.imageTargetPresent
        || canvas.imageReferenceToTargetEdgeCount !== 1 || canvas.imageTaskCount !== 1
        || !canvas.imageTaskSuccess || canvas.imageTaskOutputCount !== 1) {
        throw Object.assign(new Error('IMAGE_CHAIN_ASSERTION_FAILED'), { code: 'IMAGE_CHAIN_ASSERTION_FAILED' })
      }
      if (!mcpDiagnostics.mediaReads.some((entry) => entry.modality === 'image')) {
        await runCodexStage('image-query', prompts.imageQuery)
      }
      imageResult = await waitForMediaNode(canvas.imageNodeId, 'image')
      phase = 'codex-natural-language-video-generation'
      await runCodexStage('video', prompts.video)
      canvas = await settleExistingMediaTask('video')
      latestCanvasSummary = canvas
    }
    if (!canvas.videoTargetPresent || canvas.videoTaskCount !== 1 || !canvas.videoTaskSuccess || canvas.videoTaskOutputCount !== 1
      || canvas.edgesTouchingAcceptanceNodes !== 1 || resumeMode && canvas.videoNodeCount !== 1
      || resumeMode && canvas.allVideoTaskCount !== 1
      || videoOnly && (canvas.videoNodeCount !== 1 || canvas.createdVideoNodeCount !== 1
        || canvas.loadedNodeCount !== 2 || canvas.allVideoTaskCount !== 1 || canvas.allImageTaskCount !== 0
        || canvas.imageNodeCount !== 0 || canvas.imageTaskCount !== 0 || !canvas.videoReferencePresent
        || canvas.videoReferenceToTargetEdgeCount !== 1)) {
      throw Object.assign(new Error('VIDEO_CHAIN_ASSERTION_FAILED'), { code: 'VIDEO_CHAIN_ASSERTION_FAILED' })
    }
    if (videoOnly || !resumePlan?.videoTaskPresent && !mcpDiagnostics.mediaReads.some((entry) => entry.modality === 'video')) {
      await runCodexStage('video-query', prompts.videoQuery)
    }
    videoResult = await waitForMediaNode(canvas.videoNodeId, 'video')
    phase = 'codex-natural-language-media-readback'
    await runCodexStage('readback', videoOnly ? prompts.videoOnlyReadback : prompts.readback)
    const current = await inspectFinalCanvas()
    latestCanvasSummary = current
    const imageRead = mcpDiagnostics.mediaReads.find((entry) => entry.modality === 'image') || null
    const videoRead = mcpDiagnostics.mediaReads.find((entry) => entry.modality === 'video') || null
    const readPreviewCount = cliTurns.reduce((count, turn) => count + turn.trace.previewReadCalls, 0)
    if (readPreviewCount < (videoOnly ? 1 : 2) || (!videoOnly && !imageRead) || !videoRead) {
      throw Object.assign(new Error('MCP_MEDIA_PREVIEW_READBACK_INCOMPLETE'), { code: 'MCP_MEDIA_PREVIEW_READBACK_INCOMPLETE' })
    }
    if ((!videoOnly && (!imageResult?.mediaRendered || !imageResult?.visible))
      || !videoResult?.mediaRendered || !videoResult?.visible) {
      throw Object.assign(new Error('ORIGINAL_NODE_MEDIA_NOT_VISIBLE'), { code: 'ORIGINAL_NODE_MEDIA_NOT_VISIBLE' })
    }
    const imageMatchesTaskStore = videoOnly ? null : Boolean(current.imageTaskOutputFingerprint && imageRead
      && current.imageTaskOutputFingerprint.sha256 === imageRead.sha256
      && current.imageTaskOutputFingerprint.sizeBytes === imageRead.sizeBytes)
    const videoMatchesTaskStore = Boolean(current.videoTaskOutputFingerprint && videoRead
      && current.videoTaskOutputFingerprint.sha256 === videoRead.sha256
      && current.videoTaskOutputFingerprint.sizeBytes === videoRead.sizeBytes)
    previewMatchesTaskStore = { image: imageMatchesTaskStore, video: videoMatchesTaskStore }
    if ((!videoOnly && !imageMatchesTaskStore) || !videoMatchesTaskStore) {
      throw Object.assign(new Error('MCP_MEDIA_PREVIEW_TASKSTORE_MISMATCH'), { code: 'MCP_MEDIA_PREVIEW_TASKSTORE_MISMATCH' })
    }
    const trace = aggregateToolTrace()
    phase = 'credential-cleanup'
    await cleanupCredentials()
    if (!providerCredentialCleared || !grantRevoked) throw Object.assign(new Error('CREDENTIAL_CLEANUP_FAILED'), { code: 'CREDENTIAL_CLEANUP_FAILED' })
    secretValue = undefined
    secretBytes.fill(0)
    const output = {
      schemaVersion: 1,
      testType: videoOnly
        ? appServerHost ? 'real Codex app-server Agnes video-only MCP acceptance' : 'real Codex CLI natural-language Agnes video-only MCP acceptance'
        : appServerHost ? 'real Codex app-server Agnes image and video MCP acceptance'
          : 'real Codex CLI natural-language Agnes image and video MCP acceptance',
      confirmationPolicy: 'client-form-generation-only-2026-10-17',
      clientHost: appServerHost ? 'codex-app-server-qa-relay' : 'codex-cli-exec',
      nativeCodexPopupAccepted: false,
      success: true,
      phase: 'completed',
      resumed: resumeMode,
      resumedFromRun: resumeProject?.sourceRunName || null,
      resumeProjectIdentityPreserved: resumeIdentityPreserved,
      existingTasksReusedCount: Number(imageTaskReused) + Number(videoTaskReused),
      viewportFocusedForInspection,
      provider: 'Agnes',
      configuredModels: configurationVerified ? ['Agnes Image 2.5 Flash', 'Agnes Video 2.5 Flash'] : [],
      providerConfigurationSaved: providerConfigured,
      providerModelsEnabled: configurationVerified,
      providerConnectionTestStatus: providerConnectionTestStatus || 'not_observed',
      pairedConnectionCount: pairedConnections,
      providerDisclosureObserved,
      providerDisclosureCardObserved,
      providerDisclosureConfirmed,
      providerDisclosureDecisionStatus: providerDisclosureDecisionStatus || 'not_observed',
      providerDisclosureCandidateCount,
      configurationContinuationAttempted,
      canvasReadyAfterDisclosureReturn,
      generationConfirmationsObserved,
      generationConfirmationResponses,
      generationConfirmationsConfirmed,
      paidMediaAuthorizedByOperator,
      toolNamesObserved: trace.toolNames,
      toolCallCounts: trace.callCounts,
      toolResultStatuses: trace.statuses,
      toolResultIsError: trace.isErrors,
      cliToolErrorCodes: trace.errorCodes,
      toolFailureFlags: trace.toolFailureFlags,
      cliErrorEventFlags: trace.cliErrorEventFlags,
      toolErrorKeywordFlags: trace.toolErrorKeywordFlags,
      cliErrorKeywordFlags: trace.cliErrorKeywordFlags,
      cliJsonRpcErrorCodes: trace.jsonRpcErrorCodes,
      unknownCliJsonRpcErrorCodeObserved: trace.unknownJsonRpcErrorCode,
      cliHttpStatusCodes: trace.httpStatusCodes,
      unknownCliHttpStatusCodeObserved: trace.unknownHttpStatusCodeObserved,
      mainWorkerToolCallCounts: { ...mcpDiagnostics.calls },
      generationModelReferenceChecks,
      publicRpcResponses: mcpDiagnostics.rpcResponses,
      unknownPublicErrorCodeObserved: mcpDiagnostics.unknownPublicErrorCode,
      unknownMcpHttpStatusCodeObserved: mcpDiagnostics.unknownHttpStatusCodeObserved,
      safeJsonRpcErrorCodes: [...mcpDiagnostics.jsonRpcErrorCodes].sort((a, b) => a - b),
      unknownJsonRpcErrorCodeObserved: mcpDiagnostics.unknownJsonRpcErrorCode,
      safeMcpErrorCodes: [...mcpDiagnostics.errorCodes].filter((candidate) => safeErrorCodes.has(candidate)).sort(),
      cliTurnCount: cliTurns.length,
      cliExitCodes: cliTurns.map((turn) => turn.exitCode),
      cliTurnCompletedCount: cliTurns.filter((turn) => turn.turnCompleted).length,
      cliTurnSummaries: safeCliTurnSummaries(),
      mcpPreviewReadCalls: readPreviewCount,
      mcpMediaReads: [imageRead, videoRead].filter(Boolean),
      imageTaskStatus: current.imageTaskStatus,
      videoTaskStatus: current.videoTaskStatus,
      imageTaskErrorCode: current.imageTaskErrorCode,
      videoTaskErrorCode: current.videoTaskErrorCode,
      imageTaskCount: current.imageTaskCount,
      videoTaskCount: current.videoTaskCount,
      imageTaskOutputFingerprint: current.imageTaskOutputFingerprint,
      videoTaskOutputFingerprint: current.videoTaskOutputFingerprint,
      imageOutputCount: current.imageTaskOutputCount,
      videoOutputCount: current.videoTaskOutputCount,
      taskStoreSuccessfulMediaTaskCount: Number(current.imageTaskSuccess) + Number(current.videoTaskSuccess),
      taskStoreSubmittedMediaTaskCount: current.imageTaskCount + current.videoTaskCount,
      videoOnly,
      videoChainAccepted: videoOnly && isVideoOnlyChainAccepted(current, videoResult, videoMatchesTaskStore),
      combinedFullMediaChain: videoOnly ? false : current.imageTaskSuccess && current.videoTaskSuccess,
      actualProviderHttpRequestCount: null,
      actualProviderHttpRequestCountRecorded: false,
      mcpPreviewMatchesTaskStore: previewMatchesTaskStore,
      imageOriginalNode: imageResult,
      videoOriginalNode: videoResult,
      imageAndVideoEachSucceededOnce: current.imageTaskSuccess && current.videoTaskSuccess
        && current.imageTaskOutputCount === 1 && current.videoTaskOutputCount === 1,
      imageReferenceToTargetEdgeCount: current.imageReferenceToTargetEdgeCount,
      videoReferenceToTargetEdgeCount: current.videoReferenceToTargetEdgeCount,
      credentialsClearedViaDesktopIpc: providerCredentialCleared,
      testGrantRevoked: grantRevoked,
      rawClientTranscriptSaved: false,
      promptSaved: false,
      apiKeySavedInEvidence: false,
      mcpBootstrapSaved: false,
      startedAt,
      completedAt: new Date().toISOString(),
      internalPhase: 'completed',
      errorCode: null,
    }
    await fs.writeFile(resultPath, JSON.stringify(output, null, 2))
    status('COMPLETE_SUCCESS')
    app.quit()
  } catch (error) {
    await stopOwnedCli().catch(() => {})
    latestCanvasSummary = window && !window.isDestroyed()
      ? await inspectFinalCanvas().catch(() => latestCanvasSummary) : latestCanvasSummary
    await cleanupCredentials().catch(() => {})
    const code = safeErrorCode(error)
    const trace = aggregateToolTrace()
    const lastCanvas = latestCanvasSummary
    secretValue = undefined
    secretBytes.fill(0)
    const output = {
      schemaVersion: 1,
      testType: appServerHost ? 'real Codex app-server Agnes image and video MCP acceptance'
        : 'real Codex CLI natural-language Agnes image and video MCP acceptance',
      confirmationPolicy: 'client-form-generation-only-2026-10-17',
      clientHost: appServerHost ? 'codex-app-server-qa-relay' : 'codex-cli-exec',
      nativeCodexPopupAccepted: false,
      success: false,
      phase,
      errorCode: code,
      videoOnly,
      videoChainAccepted: false,
      combinedFullMediaChain: false,
      resumed: resumeMode,
      resumedFromRun: resumeProject?.sourceRunName || null,
      resumeProjectIdentityPreserved: resumeIdentityPreserved,
      existingTasksReusedCount: Number(imageTaskReused) + Number(videoTaskReused),
      viewportFocusedForInspection,
      provider: 'Agnes',
      configuredModels: configurationVerified ? ['Agnes Image 2.5 Flash', 'Agnes Video 2.5 Flash'] : [],
      providerConfigurationSaved: providerConfigured,
      providerModelsEnabled: configurationVerified,
      providerConnectionTestStatus: providerConnectionTestStatus || 'not_observed',
      pairedConnectionCount: pairedConnections,
      providerDisclosureObserved,
      providerDisclosureCardObserved,
      providerDisclosureConfirmed,
      providerDisclosureDecisionStatus: providerDisclosureDecisionStatus || 'not_observed',
      providerDisclosureCandidateCount,
      configurationContinuationAttempted,
      canvasReadyAfterDisclosureReturn,
      generationConfirmationsObserved,
      generationConfirmationResponses,
      generationConfirmationsConfirmed,
      paidMediaAuthorizedByOperator,
      toolNamesObserved: trace.toolNames,
      toolCallCounts: trace.callCounts,
      toolResultStatuses: trace.statuses,
      toolResultIsError: trace.isErrors,
      cliToolErrorCodes: trace.errorCodes,
      toolFailureFlags: trace.toolFailureFlags,
      cliErrorEventFlags: trace.cliErrorEventFlags,
      toolErrorKeywordFlags: trace.toolErrorKeywordFlags,
      cliErrorKeywordFlags: trace.cliErrorKeywordFlags,
      cliJsonRpcErrorCodes: trace.jsonRpcErrorCodes,
      unknownCliJsonRpcErrorCodeObserved: trace.unknownJsonRpcErrorCode,
      cliHttpStatusCodes: trace.httpStatusCodes,
      unknownCliHttpStatusCodeObserved: trace.unknownHttpStatusCodeObserved,
      mainWorkerToolCallCounts: { ...mcpDiagnostics.calls },
      generationModelReferenceChecks,
      publicRpcResponses: mcpDiagnostics.rpcResponses,
      unknownPublicErrorCodeObserved: mcpDiagnostics.unknownPublicErrorCode,
      unknownMcpHttpStatusCodeObserved: mcpDiagnostics.unknownHttpStatusCodeObserved,
      safeJsonRpcErrorCodes: [...mcpDiagnostics.jsonRpcErrorCodes].sort((a, b) => a - b),
      unknownJsonRpcErrorCodeObserved: mcpDiagnostics.unknownJsonRpcErrorCode,
      safeMcpErrorCodes: [...mcpDiagnostics.errorCodes].filter((candidate) => safeErrorCodes.has(candidate)).sort(),
      cliTurnCount: cliTurns.length,
      cliExitCodes: cliTurns.map((turn) => turn.exitCode),
      cliTurnCompletedCount: cliTurns.filter((turn) => turn.turnCompleted).length,
      cliTurnSummaries: safeCliTurnSummaries(),
      mcpPreviewReadCalls: cliTurns.reduce((count, turn) => count + turn.trace.previewReadCalls, 0),
      mcpMediaReads: mcpDiagnostics.mediaReads,
      imageTaskStatus: lastCanvas?.imageTaskStatus || null,
      videoTaskStatus: lastCanvas?.videoTaskStatus || null,
      imageTaskErrorCode: lastCanvas?.imageTaskErrorCode || null,
      videoTaskErrorCode: lastCanvas?.videoTaskErrorCode || null,
      imageTaskCount: lastCanvas?.imageTaskCount ?? null,
      videoTaskCount: lastCanvas?.videoTaskCount ?? null,
      imageNodeCount: lastCanvas?.imageNodeCount ?? null,
      videoNodeCount: lastCanvas?.videoNodeCount ?? null,
      allImageTaskCount: lastCanvas?.allImageTaskCount ?? null,
      allVideoTaskCount: lastCanvas?.allVideoTaskCount ?? null,
      videoReferenceToTargetEdgeCount: lastCanvas?.videoReferenceToTargetEdgeCount ?? null,
      imageTaskOutputCount: lastCanvas?.imageTaskOutputCount ?? null,
      videoTaskOutputCount: lastCanvas?.videoTaskOutputCount ?? null,
      imageTaskOutputFingerprint: lastCanvas?.imageTaskOutputFingerprint || null,
      videoTaskOutputFingerprint: lastCanvas?.videoTaskOutputFingerprint || null,
      taskStoreSuccessfulMediaTaskCount: lastCanvas
        ? Number(lastCanvas.imageTaskSuccess) + Number(lastCanvas.videoTaskSuccess) : null,
      taskStoreSubmittedMediaTaskCount: lastCanvas ? lastCanvas.imageTaskCount + lastCanvas.videoTaskCount : null,
      actualProviderHttpRequestCount: null,
      actualProviderHttpRequestCountRecorded: false,
      mcpPreviewMatchesTaskStore: previewMatchesTaskStore,
      imageOriginalNode: imageResult,
      videoOriginalNode: videoResult,
      credentialsClearedViaDesktopIpc: providerCredentialCleared,
      testGrantRevoked: grantRevoked,
      rawClientTranscriptSaved: false,
      promptSaved: false,
      apiKeySavedInEvidence: false,
      mcpBootstrapSaved: false,
      startedAt,
      internalPhase: phase,
    }
    await fs.writeFile(resultPath, JSON.stringify(output, null, 2)).catch(() => {})
    status(`STOPPED_${code}`)
    app.exit(1)
  }
}

if (!isEntry) {
  module.exports = {
    classifyResumeMediaSnapshot,
    createAcceptanceMediaSubmissionGuard,
    describeResumeMediaProjectPath,
    isAcceptanceHarnessEntry,
    assertAcceptanceModeCompatibility,
    isVideoOnlyChainAccepted,
    readResumeMediaProjectArgument,
    validateResumeMediaProjectPath,
  }
} else if (codexDiagnosticMode) {
  runCodexDiagnostic().catch(() => {
    console.log(JSON.stringify({ diagnostic: 'codex-cli-connectivity', processSpawnError: true,
      rawOutputSaved: false, promptSaved: false, environmentValuesSaved: false,
      mediaKeyProvided: false, electronStarted: false, mcpServerConfigured: false }))
    process.exitCode = 1
  })
} else if (process.argv.includes('--worker')) {
  workerMain().catch(async (error) => {
    const code = safeErrorCode(error, 'ELECTRON_WORKER_FAILED')
    const failureLine = String(error?.stack || '').split(/\r?\n/u).slice(1)
      .map((line) => line.match(/smoke-mcp-codex-agnes\.cjs:(\d+):\d+\)?$/u)?.[1]).find(Boolean)
    const runRoot = process.argv[process.argv.indexOf('--run-root') + 1]
    const resultPath = path.join(runRoot, 'worker-result.json')
    const summary = { schemaVersion: 1, success: false, phase: 'electron-worker-bootstrap', errorCode: code,
      bootstrapErrorKind: ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError'].includes(error?.name)
        ? error.name : 'other', bootstrapFailureLine: failureLine ? Number(failureLine) : null,
      resumed: process.argv.includes('--resume-media-project'), resumedFromRun: null,
      videoOnly, videoChainAccepted: false, combinedFullMediaChain: false,
      resumeProjectIdentityPreserved: false, existingTasksReusedCount: 0, viewportFocusedForInspection: false,
      confirmationPolicy: 'client-form-generation-only-2026-10-17',
      clientHost: appServerHost ? 'codex-app-server-qa-relay' : 'codex-cli-exec',
      nativeCodexPopupAccepted: false, generationConfirmationsObserved: 0,
      generationConfirmationResponses: 0, generationConfirmationsConfirmed: 0,
      credentialsClearedViaDesktopIpc: false, testGrantRevoked: false, rawClientTranscriptSaved: false,
      promptSaved: false, apiKeySavedInEvidence: false, mcpBootstrapSaved: false }
    await fs.writeFile(resultPath, JSON.stringify(summary, null, 2)).catch(() => {})
    console.error(`QA_STATUS STOPPED_${code}`)
    process.exitCode = 1
    // No Main/profile setup has completed at this boundary. Electron otherwise
    // keeps its event loop alive after a rejected bootstrap, hiding the failure.
    try { require('electron').app?.exit(1) } catch { /* Node exits with the code above. */ }
  })
} else {
  runController().catch((error) => {
    const code = safeErrorCode(error, 'CONTROLLER_FAILED')
    console.error(`Codex Agnes acceptance stopped: ${code}`)
    process.exitCode = 1
  })
}
