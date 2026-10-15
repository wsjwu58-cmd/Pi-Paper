// Real Codex CLI and Claude Code acceptance against an isolated Electron
// profile. Raw client output and exported launch credentials stay in memory
// or inside a disposable test directory; evidence records only tool names,
// counts, status, and fixture assertions.
const path = require('node:path')
const fsSync = require('node:fs')
const readline = require('node:readline')
const fs = require('node:fs/promises')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const evidenceDirectory = path.join(root, 'docs/verification/2026-10-11-mcp-acceptance')
const allowedTools = [
  'get_context', 'get_canvas_summary', 'get_selected_nodes', 'get_node_detail', 'list_models',
  'create_nodes', 'connect_nodes', 'prepare_generation', 'get_operation', 'check_task_status', 'read_task_output',
]
const requiredTrace = ['get_canvas_summary', 'list_models', 'create_nodes', 'connect_nodes', 'prepare_generation', 'read_task_output']
const safeFieldName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u
const clients = {
  codex: {
    display: 'Codex CLI', target: 'Codex fixture target',
    targetNodeContent: 'Codex fixture target',
  },
  'claude-code': {
    display: 'Claude Code', target: 'Claude fixture target',
    targetNodeContent: 'Claude fixture target',
  },
}

function safeDiagnosticErrorCode(error) {
  for (const candidate of [error?.code, error?.message]) {
    if (typeof candidate === 'string' && /^[A-Z0-9_]{1,120}$/u.test(candidate)) return candidate
  }
  return null
}

function diagnosticFieldNames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value).filter((name) => safeFieldName.test(name)).sort()
}

function readSafeJsonCode(buffer, property) {
  if (!Buffer.isBuffer(buffer)) return null
  const marker = Buffer.from(`"${property}":"`)
  let offset = 0
  while (offset < buffer.length) {
    const markerIndex = buffer.indexOf(marker, offset)
    if (markerIndex < 0) return null
    const start = markerIndex + marker.length
    const end = buffer.indexOf(0x22, start)
    if (end < 0 || end - start > 120) return null
    const value = buffer.toString('ascii', start, end)
    if (/^[A-Z0-9_]{1,120}$/u.test(value)) return value
    offset = end + 1
  }
  return null
}

function summarizeMcpWorkerPayload(payload) {
  const toolName = allowedTools.includes(payload?.toolName) ? payload.toolName : 'unlisted'
  const args = payload?.arguments && typeof payload.arguments === 'object' && !Array.isArray(payload.arguments)
    ? payload.arguments : null
  const summary = {
    method: 'mcp:tool:execute',
    toolName,
    argumentFields: diagnosticFieldNames(args),
  }
  if (Number.isSafeInteger(args?.expectedVersion) && args.expectedVersion >= 0) {
    summary.expectedVersion = args.expectedVersion
  }
  if (toolName === 'prepare_generation') {
    const generations = Array.isArray(args?.generations) ? args.generations : []
    summary.generationCount = generations.length
    summary.generations = generations.map((generation) => {
      const params = generation?.modelParams && typeof generation.modelParams === 'object'
        && !Array.isArray(generation.modelParams) ? generation.modelParams : null
      return {
        modelType: typeof generation?.modelType === 'string' && generation.modelType.length <= 256
          ? generation.modelType : null,
        modelParamsFields: diagnosticFieldNames(params),
        promptPresent: Boolean(params && Object.hasOwn(params, 'prompt')),
        overwrite: typeof generation?.overwrite === 'boolean' ? generation.overwrite : null,
      }
    })
  }
  return summary
}

function findInstalledCommand(command) {
  try {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
    const output = execFileSync(lookup, [command], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return output.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || null
  } catch { return null }
}

function resolveClientExecutable(clientKey) {
  const overrideName = clientKey === 'codex' ? 'VIBEPAPER_ACCEPTANCE_CODEX_CLI' : 'VIBEPAPER_ACCEPTANCE_CLAUDE_CLI'
  const override = process.env[overrideName]
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim())

  const command = clientKey === 'codex' ? 'codex' : 'claude'
  const installedCommand = findInstalledCommand(command)
  if (clientKey === 'claude-code') {
    if (installedCommand) return installedCommand
    const fallback = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
    if (fsSync.existsSync(fallback)) return fallback
    throw new Error('claude_cli_not_found')
  }

  if (!installedCommand) throw new Error('codex_cli_not_found')
  if (process.platform !== 'win32') return installedCommand
  if (path.extname(installedCommand).toLowerCase() === '.exe') return installedCommand

  // On Windows the global codex.ps1 wrapper can corrupt quoted -c values.
  // Resolve the package's native binary beside the wrapper and pass argv directly.
  const wrapperDirectory = path.dirname(installedCommand)
  const packageArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64'
  const targetTriple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const nativeBinary = path.join(wrapperDirectory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai',
    `codex-win32-${packageArchitecture}`, 'vendor', targetTriple, 'bin', 'codex.exe')
  if (fsSync.existsSync(nativeBinary)) return nativeBinary
  throw new Error('codex_native_binary_not_found')
}

function assertTemporaryPath(base, candidate) {
  const basePath = path.resolve(base)
  const candidatePath = path.resolve(candidate)
  const relative = path.relative(basePath, candidatePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(candidatePath).startsWith('vibepaper-mcp-client-')) {
    throw new Error('Refusing to operate outside the unique MCP client test directory')
  }
  return candidatePath
}

function classifyFailure(text, exitCode, signal, timedOut) {
  const value = String(text || '').toLowerCase()
  if (timedOut) return 'client_turn_timeout'
  if (/not logged in|please log in|authentication required|unauthorized|invalid[_ ]credential|oauth.*(expired|invalid)|login required/u.test(value)) {
    return 'authentication_required'
  }
  if (/econn|network|fetch failed|failed to connect|connection refused|dns|timed out|timeout/u.test(value)) {
    return 'network_or_provider_blocked'
  }
  if (/unknown (option|flag)|unrecognized option|invalid.*config|config.*(parse|invalid)|unsupported.*flag/u.test(value)) {
    return 'client_configuration_blocked'
  }
  if (/model[^\r\n]{0,80}(not found|unavailable|unsupported)|no model configured/u.test(value)) return 'model_configuration_blocked'
  if (signal) return 'client_process_terminated'
  if (exitCode !== 0) return 'client_turn_failed'
  return 'client_turn_incomplete'
}

function createTraceParser(clientKey) {
  const names = new Set()
  const toolResults = []
  const summarizedResultItems = new WeakSet()
  const resultIndexesByCallId = new Map()
  const resultStatuses = new Set([
    'aborted', 'awaiting_confirmation', 'cancelled', 'completed', 'expired', 'failed', 'invalidated',
    'not_found', 'pending', 'proposed', 'queued', 'rejected', 'running', 'submission_unknown',
    'submitted', 'submitting', 'succeeded', 'uncertain', 'waiting_confirmation',
  ])
  const stableToolErrorCodes = new Set([
    'AGENT_UNAVAILABLE', 'CANVAS_NOT_READY', 'CANVAS_VERSION_CONFLICT', 'CONFIRMATION_REQUIRED',
    'IDEMPOTENCY_CONFLICT', 'INVALID_INPUT', 'MCP_OPERATION_RECOVERY_REQUIRED',
    'MCP_OPERATION_STORE_UNAVAILABLE', 'MCP_TOOL_UNAVAILABLE', 'MODEL_NOT_FOUND',
    'PERMISSION_DENIED', 'PROJECT_CHANGED', 'PROVIDER_REVISION_UNAVAILABLE',
  ])
  const publicGenerationPaths = new Set([
    'operationId', 'expectedVersion', 'generations', 'generations.*.nodeId',
    'generations.*.modelType', 'generations.*.modelParams', 'generations.*.overwrite',
    'generations.*.prompt',
  ])
  let assistantReplySeen = false
  let completedEventSeen = false
  let errorEventSeen = false
  let eventCount = 0

  function rememberToolResult(name, item, eventPath = null) {
    if (typeof name !== 'string') return
    if (!item || typeof item !== 'object' || summarizedResultItems.has(item)) return
    const normalized = name.startsWith('mcp__vibepaper__') ? name.slice('mcp__vibepaper__'.length) : name
    if (!allowedTools.includes(normalized)) return
    const roots = [item?.result, item?.response, item?.output, item?.structuredContent, item?.error]
      .filter((value) => value !== undefined)
    const toolCallStatus = typeof item.status === 'string' ? item.status.toLowerCase() : null
    if (!roots.length && item?.isError !== true && item?.is_error !== true && toolCallStatus !== 'failed') return
    const summary = {
      isError: item?.isError === true || item?.is_error === true || toolCallStatus === 'failed' || Boolean(item?.error),
      errorCode: null,
      status: resultStatuses.has(toolCallStatus) ? toolCallStatus : null,
    }
    const fieldPaths = new Set()
    const errorFieldPaths = new Set()
    const toolCallFields = normalized === 'prepare_generation' ? Object.keys(item).filter((key) => /^[A-Za-z][A-Za-z0-9_]*$/u.test(key)).sort() : undefined
    const clientPolicyOutcomes = new Set()
    const rememberCode = (candidate) => {
      if (typeof candidate === 'string' && stableToolErrorCodes.has(candidate)) summary.errorCode = candidate
      else if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate <= -32000 && candidate >= -32768) {
        summary.errorCode = `JSONRPC_${candidate}`
      }
    }
    const inspectErrorMessage = (message) => {
      if (typeof message !== 'string') return
      if (/approval.{0,40}(?:required|needed|prompt|request)|(?:requires|needs).{0,40}approval/iu.test(message)) clientPolicyOutcomes.add('approval_required')
      else if (/approval.{0,40}(?:denied|rejected|cancelled|canceled)|not approved/iu.test(message)) clientPolicyOutcomes.add('approval_denied')
      else if (/approval/iu.test(message)) clientPolicyOutcomes.add('approval_related')
      if (/permission.{0,40}(?:denied|refused)|\bdenied\b/iu.test(message)) clientPolicyOutcomes.add('permission_denied')
      if (/not allowed/iu.test(message)) clientPolicyOutcomes.add('not_allowed')
      if (/\brejected\b/iu.test(message)) clientPolicyOutcomes.add('rejected')
      if (/(?:user\s+)?cancel(?:l)?ed/iu.test(message)) clientPolicyOutcomes.add('cancelled')
      for (const code of stableToolErrorCodes) {
        if (new RegExp(`\\b${code}\\b`, 'u').test(message)) summary.errorCode = code
      }
      const terms = []
      if (/additional propert/iu.test(message)) terms.push('additional_properties')
      if (/unknown(?:\s+(?:field|argument|property|parameter))?/iu.test(message)) terms.push('unknown_field')
      if (/missing required|required (?:field|argument|property|parameter)/iu.test(message)) terms.push('required_field')
      if (/binding/iu.test(message)) terms.push('binding_error')
      if (/\btype\b/iu.test(message)) terms.push('type_mismatch')
      if (/schema|invalid (?:params|arguments|parameter)|validation|does not match|input.*invalid/iu.test(message)) terms.push('schema_validation')
      if (terms.length) {
        summary.schemaValidation = true
        summary.validationKinds = [...new Set(terms)].sort()
        const pathPattern = /(?:\$\.?\/?|(?:arguments|input|params)[./])?(?:operationId|expectedVersion|generations)(?:(?:\.\d+|\[\d+\]|\/\d+))?(?:(?:\.|\/)(?:nodeId|modelType|modelParams|overwrite|prompt))?/gu
        for (const match of message.matchAll(pathPattern)) {
          const candidate = match[0].replace(/^\$\.?\/?/u, '').replace(/^(?:arguments|input|params)[./]/u, '')
            .replace(/\/(\d+)(?=\/|$)/gu, '.$1').replace(/\[(\d+)\]/gu, '.$1').replace(/\//gu, '.')
          const parts = candidate.split('.').filter(Boolean)
          const normalized = parts.map((part) => /^\d+$/u.test(part) ? '*' : part).join('.')
          if (publicGenerationPaths.has(normalized)) fieldPaths.add(normalized)
        }
        if (!summary.errorCode) summary.errorCode = 'SCHEMA_VALIDATION'
      }
    }
    const visitResult = (value, depth = 0) => {
      if (depth > 10 || value === null || value === undefined) return
      if (typeof value === 'string') {
        try { visitResult(JSON.parse(value), depth + 1) } catch { /* Text bodies are deliberately not persisted. */ }
        return
      }
      if (Array.isArray(value)) {
        for (const child of value) visitResult(child, depth + 1)
        return
      }
      if (typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if ((key === 'isError' || key === 'is_error') && child === true) summary.isError = true
        if (key === 'errorCode' || key === 'error_code' || key === 'code') rememberCode(child)
        if (key === 'status' && typeof child === 'string' && resultStatuses.has(child.toLowerCase())) summary.status = child.toLowerCase()
        if (key === 'message') inspectErrorMessage(child)
        if (key === 'error' && typeof child === 'string') inspectErrorMessage(child)
        if (['result', 'response', 'output', 'structuredContent', 'content', 'data', 'message', 'text'].includes(key)) {
          visitResult(child, depth + 1)
        }
      }
    }
    if (typeof item.error === 'string') inspectErrorMessage(item.error)
    for (const rootValue of roots) {
      if (toolCallStatus === 'failed' && typeof rootValue === 'string') inspectErrorMessage(rootValue)
      visitResult(rootValue)
    }
    if (normalized === 'prepare_generation') {
      const inspectErrorShape = (value, prefix = 'item', depth = 0, inError = false) => {
        if (depth > 10 || value === null || typeof value !== 'object') return
        if (Array.isArray(value)) {
          value.forEach((child, index) => inspectErrorShape(child, `${prefix}[${index}]`, depth + 1, inError))
          return
        }
        for (const [key, child] of Object.entries(value)) {
          const childPath = `${prefix}.${key}`
          if (key === 'error') errorFieldPaths.add(childPath)
          if (inError && /^[A-Za-z][A-Za-z0-9_]*$/u.test(key)) errorFieldPaths.add(childPath)
          inspectErrorShape(child, childPath, depth + 1, inError || key === 'error')
        }
      }
      inspectErrorShape(item)
    }
    if (roots.length || summary.isError || summary.errorCode || summary.status) {
      summarizedResultItems.add(item)
      if (summary.schemaValidation) summary.fieldPaths = [...fieldPaths].sort()
      if (normalized === 'prepare_generation') {
        summary.eventPath = eventPath
        summary.toolCallFields = toolCallFields
        summary.errorFieldPaths = [...errorFieldPaths].sort()
        summary.errorValueKind = item.error === undefined ? 'missing' : item.error === null ? 'null' : Array.isArray(item.error) ? 'array' : typeof item.error
        summary.resultValueKind = item.result === undefined ? 'missing' : item.result === null ? 'null' : Array.isArray(item.result) ? 'array' : typeof item.result
        if (clientPolicyOutcomes.size) summary.clientPolicyOutcomes = [...clientPolicyOutcomes].sort()
      }
      const callId = [item.id, item.call_id, item.callId, item.tool_call_id]
        .find((value) => typeof value === 'string' && value.length > 0)
      const callKey = callId ? `${normalized}:${callId}` : null
      const existingIndex = callKey ? resultIndexesByCallId.get(callKey) : undefined
      if (existingIndex !== undefined) {
        const previous = toolResults[existingIndex]
        previous.isError ||= summary.isError
        previous.errorCode ||= summary.errorCode
        previous.status ||= summary.status
        if (normalized === 'prepare_generation') {
          previous.eventPath ||= summary.eventPath
          previous.toolCallFields ||= summary.toolCallFields
          previous.errorFieldPaths = [...new Set([...(previous.errorFieldPaths || []), ...(summary.errorFieldPaths || [])])].sort()
          previous.errorValueKind ||= summary.errorValueKind
          previous.resultValueKind ||= summary.resultValueKind
          if (summary.clientPolicyOutcomes?.length) previous.clientPolicyOutcomes = [...new Set([...(previous.clientPolicyOutcomes || []), ...summary.clientPolicyOutcomes])].sort()
          if (summary.validationKinds?.length) previous.validationKinds = [...new Set([...(previous.validationKinds || []), ...summary.validationKinds])].sort()
        }
        if (summary.schemaValidation) {
          previous.schemaValidation = true
          previous.fieldPaths = [...new Set([...(previous.fieldPaths || []), ...summary.fieldPaths])].sort()
        }
      } else {
        const result = { tool: normalized, ...summary }
        if (callKey) resultIndexesByCallId.set(callKey, toolResults.length)
        toolResults.push(result)
      }
    }
  }

  function acceptLine(line) {
    if (!line || line.length > 2_000_000) return
    let value
    try { value = JSON.parse(line) } catch { return }
    eventCount += 1
    const eventType = typeof value?.type === 'string' ? value.type : ''
    if (eventType === 'turn.completed' || eventType === 'result') completedEventSeen = true
    if (eventType === 'error' || eventType === 'result' && value.is_error === true) errorEventSeen = true

    const visit = (item, eventPath = '$') => {
      if (!item || typeof item !== 'object') return
      if (Array.isArray(item)) { item.forEach((child, index) => visit(child, `${eventPath}[${index}]`)); return }
      const kind = typeof item.type === 'string' ? item.type : ''
      if (kind === 'agent_message' && typeof item.text === 'string' && item.text.trim()) assistantReplySeen = true
      if (kind === 'assistant' && item.message && Array.isArray(item.message.content)) {
        if (item.message.content.some((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())) assistantReplySeen = true
      }
      if (kind === 'result' && typeof item.result === 'string' && item.result.trim()) assistantReplySeen = true
      if (kind === 'mcp_tool_call' || kind === 'tool_use') {
        const name = item.tool_name || item.toolName || item.name || item.tool
        if (typeof name === 'string') {
          const normalized = name.startsWith('mcp__vibepaper__') ? name.slice('mcp__vibepaper__'.length) : name
          if (allowedTools.includes(normalized)) {
            names.add(normalized)
          rememberToolResult(normalized, item, eventPath)
          }
        }
      }
      if (kind === 'item.started' || kind === 'item.completed' || kind === 'item.updated') {
        const nested = item.item
        if (nested && typeof nested === 'object' && nested.type === 'mcp_tool_call') {
          const name = nested.tool_name || nested.toolName || nested.name || nested.tool
          if (typeof name === 'string') {
            const normalized = name.startsWith('mcp__vibepaper__') ? name.slice('mcp__vibepaper__'.length) : name
            if (allowedTools.includes(normalized)) {
              names.add(normalized)
              rememberToolResult(normalized, nested, `${eventPath}.item`)
            }
          }
        }
      }
      for (const [key, child] of Object.entries(item)) visit(child, `${eventPath}.${key}`)
    }
    visit(value)
  }

  return {
    acceptLine,
    summary() {
      return {
        toolCallsObserved: [...names],
        distinctToolCount: names.size,
        toolResults: [...toolResults],
        toolResultCount: toolResults.length,
        assistantReplySeen,
        completedEventSeen,
        errorEventSeen,
        jsonEventCount: eventCount,
        client: clientKey,
      }
    },
  }
}

function parseCodexConfig(configText) {
  const match = String(configText).match(/\[mcp_servers\.vibepaper\]([\s\S]*?)(?:\r?\n\[|$)/u)
  if (!match) throw new Error('The desktop did not export a Codex MCP server section')
  const body = match[1]
  const commandMatch = body.match(/^command\s*=\s*(.+)$/mu)
  const argsMatch = body.match(/^args\s*=\s*(.+)$/mu)
  if (!commandMatch || !argsMatch) throw new Error('The desktop Codex configuration is incomplete')
  const server = { command: JSON.parse(commandMatch[1]), args: JSON.parse(argsMatch[1]), env: {} }
  const envMatch = String(configText).match(/\[mcp_servers\.vibepaper\.env\]([\s\S]*?)(?:\r?\n\[|$)/u)
  for (const line of (envMatch?.[1] || '').split(/\r?\n/u)) {
    const entry = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/u)
    if (entry) server.env[entry[1]] = JSON.parse(entry[2])
  }
  if (!path.isAbsolute(server.command) || !Array.isArray(server.args)
    || server.args[0] !== path.join(root, 'vibepaper-desktop/src/mcp-node-entry.cjs')
    || server.env.ELECTRON_RUN_AS_NODE !== '1') {
    throw new Error('The desktop-exported Codex stdio entry did not match the local development runtime')
  }
  return server
}

function parseClaudeConfig(configText) {
  const decoded = typeof configText === 'string' ? JSON.parse(configText) : configText
  const servers = decoded?.mcpServers || decoded
  const server = servers?.vibepaper
  if (!server || !path.isAbsolute(server.command) || !Array.isArray(server.args)
    || server.args[0] !== path.join(root, 'vibepaper-desktop/src/mcp-node-entry.cjs')
    || server.env?.ELECTRON_RUN_AS_NODE !== '1') {
    throw new Error('The desktop-exported Claude Code stdio entry did not match the local development runtime')
  }
  return server
}

function tomlString(value) { return JSON.stringify(value) }

function normalizeProxyAddress(configured) {
  if (typeof configured !== 'string' || !configured.trim()) return null
  try {
    const value = configured.trim()
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`
    const proxy = new URL(candidate)
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(proxy.protocol) || !proxy.hostname) return null
    return `${proxy.protocol}//${proxy.hostname}${proxy.port ? `:${proxy.port}` : ''}`
  } catch { return null }
}

function readWinInetProxyEnvironment() {
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
    const environment = {}
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY']) {
      const configured = entries[name === 'HTTP_PROXY' ? 'http' : 'https']
      const address = normalizeProxyAddress(configured)
      if (address) environment[name] = address
    }
    return environment
  } catch { return {} }
}

function buildCliEnvironment(clientKey) {
  // Keep the normal user profile/config paths available to each CLI while
  // excluding unrelated provider credentials from this real acceptance turn.
  const environment = {}
  for (const name of [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'COMSPEC',
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME',
  ]) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name]
  }
  let systemProxyAddressProvided = false
  if (clientKey === 'codex' || clientKey === 'claude-code') {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      const configured = process.env[name] || process.env[name.toLowerCase()]
      const safeAddress = normalizeProxyAddress(configured)
      if (!safeAddress) continue
      environment[name] = safeAddress
      environment[name.toLowerCase()] = safeAddress
    }
    const systemProxy = readWinInetProxyEnvironment()
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY']) {
      if (environment[name] || !systemProxy[name]) continue
      environment[name] = systemProxy[name]
      environment[name.toLowerCase()] = systemProxy[name]
      systemProxyAddressProvided = true
    }
    if (typeof process.env.NO_PROXY === 'string') environment.NO_PROXY = process.env.NO_PROXY
    if (typeof process.env.no_proxy === 'string') environment.no_proxy = process.env.no_proxy
  }
  if (clientKey === 'claude-code' && typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === 'string'
    && process.env.CLAUDE_CODE_OAUTH_TOKEN.length > 0) {
    // Claude Code's normal first-party OAuth environment is scoped to its CLI
    // process only; the bridge launcher filters it from the MCP child.
    environment.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN
  }
  Object.defineProperty(environment, 'systemProxyAddressProvided', { value: systemProxyAddressProvided })
  return environment
}

function summarizeDiagnostic(text) {
  const value = String(text || '')
  const classes = [
    'ConnectTimeoutError', 'APIConnectionTimeoutError', 'APIConnectionError', 'ConnectionRefusedError',
    'ConnectionError', 'ProxyError', 'FetchError', 'TypeError', 'APIError', 'HTTPError', 'AbortError',
    'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN',
  ]
  let errorClass = classes.find((candidate) => new RegExp(`\\b${candidate}\\b`, 'iu').test(value)) || null
  let httpStatus = null
  let targetHostname = null
  const errorKinds = new Set([
    'api_connection_error', 'api_connection_timeout_error', 'authentication_error', 'connection_error',
    'invalid_request_error', 'network_error', 'not_found_error', 'overloaded_error', 'permission_error',
    'rate_limit_error', 'service_unavailable_error', 'timeout_error', 'api_error', 'http_error',
  ])
  const acceptUrl = (candidate) => {
    try {
      const hostname = new URL(candidate).hostname
      if (hostname && !targetHostname) targetHostname = hostname
    } catch { /* A malformed URL is never copied to evidence. */ }
  }
  const visitDiagnostic = (item, key = '', depth = 0) => {
    if (!item || depth > 8) return
    if (typeof item === 'object') {
      if (Array.isArray(item)) {
        for (const child of item) visitDiagnostic(child, key, depth + 1)
        return
      }
      for (const [childKey, child] of Object.entries(item)) {
        const normalizedKey = childKey.toLowerCase().replace(/[^a-z0-9]/gu, '')
        if (typeof child === 'number' && /^(?:http)?status(?:code)?$/u.test(normalizedKey)
          && child >= 400 && child <= 599 && httpStatus === null) httpStatus = child
        if (typeof child === 'string' && /^(?:http)?status(?:code)?$/u.test(normalizedKey)) {
          const status = Number(child)
          if (Number.isInteger(status) && status >= 400 && status <= 599 && httpStatus === null) httpStatus = status
        }
        if (typeof child === 'string' && /^(?:url|requesturl|targeturl)$/u.test(normalizedKey)) acceptUrl(child)
        if (typeof child === 'string' && /^(?:name|type|class|errorclass|errortype)$/u.test(normalizedKey)) {
          const normalizedKind = child.toLowerCase().replace(/[^a-z0-9_]/gu, '')
          if (!errorClass && errorKinds.has(normalizedKind)) errorClass = normalizedKind
        }
        visitDiagnostic(child, childKey, depth + 1)
      }
      return
    }
    if (typeof item === 'string' && /^(?:url|requesturl|targeturl)$/iu.test(key)) acceptUrl(item)
  }
  for (const line of value.split(/\r?\n/u)) {
    try {
      const event = JSON.parse(line)
      const eventType = typeof event?.type === 'string' ? event.type : ''
      const isErrorEvent = ['error', 'turn.error', 'turn.failed'].includes(eventType)
        || (eventType === 'result' && (event.is_error === true || event.isError === true))
        || (eventType === 'turn.completed' && (event.error || event.is_error === true || event.isError === true))
      if (isErrorEvent) visitDiagnostic(event)
    } catch { /* Stderr and partial JSON may help classify status, never a target hostname. */ }
  }
  if (httpStatus === null) {
    const statusMatch = value.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:[_ -]?code)?\s*[:=]?\s*|code\s*[:=]\s*|API\s+Error\s*[:=]?\s*)([45]\d{2})\b/iu)
      || value.match(/\b(?:HTTP|status|code)\b[^\r\n]{0,24}\b([45]\d{2})\b/iu)
    if (statusMatch) httpStatus = Number(statusMatch[1])
  }
  if (!errorClass) {
    if (/timeout|timed out|ETIMEDOUT|ConnectTimeout/iu.test(value)) errorClass = 'timeout_error'
    else if (httpStatus !== null) errorClass = 'http_error'
    else if (/econn|eai_again|enotfound|fetch failed|failed to connect|connection refused|network/iu.test(value)) errorClass = 'network_error'
    else if (/unknown (option|flag)|unrecognized option|invalid.{0,20}config|config.{0,20}(parse|invalid)/iu.test(value)) errorClass = 'client_configuration_error'
    else if (/not logged in|log[ -]?in required|authentication|unauthorized|oauth|credential/iu.test(value)) errorClass = 'authentication_error'
  }
  return {
    errorClass,
    httpStatus,
    targetHostname,
    timeout: /timeout|timed out|ETIMEDOUT|ConnectTimeout/iu.test(value),
  }
}

function summarizeFailureReason(text, httpStatus, timedOut) {
  const value = String(text || '').toLowerCase()
  if (/insufficient (?:account )?(?:balance|funds)|out of credits|billing|payment required|quota exceeded|usage limit/u.test(value)) return 'billing_or_quota'
  if (httpStatus === 429 || /rate[ -]?limit|too many requests/u.test(value)) return 'rate_limited'
  if (httpStatus === 401 || /not logged in|authentication required|unauthorized|invalid[_ ]credential|oauth.*(expired|invalid)/u.test(value)) return 'authentication_rejected'
  if (httpStatus === 403 || /forbidden|permission denied|not authorized/u.test(value)) return 'authorization_rejected'
  if (/model.{0,40}(unavailable|not found|unsupported)|no model configured|unknown model/u.test(value)) return 'model_configuration'
  if (httpStatus === 404 || /endpoint.{0,30}(not found|unavailable)/u.test(value)) return 'endpoint_not_found'
  if (httpStatus !== null && httpStatus >= 500) return 'provider_http_error'
  if (httpStatus !== null && httpStatus >= 400) return 'request_rejected'
  if (timedOut || /timeout|timed out|ETIMEDOUT|ConnectTimeout/iu.test(value)) return 'request_timeout'
  if (/econn|eai_again|enotfound|fetch failed|failed to connect|connection refused|network/u.test(value)) return 'network_transport_error'
  if (/unknown (option|flag)|unrecognized option|invalid.{0,20}config|config.{0,20}(parse|invalid)/u.test(value)) return 'client_configuration_error'
  if (/error|failed|failure/u.test(value)) return 'client_or_provider_error'
  return 'no_safe_reason_detected'
}

function buildCodexOverride(server, fixtureRoot, clientCwd) {
  const env = { ...server.env, APPDATA: fixtureRoot }
  for (const name of [
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AZURE_OPENAI_API_KEY',
    'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN', 'ARK_API_KEY', 'DOUBAO_API_KEY', 'VIBEPAPER_PROVIDER_API_KEY',
  ]) env[name] = ''
  const envToml = Object.entries(env).map(([key, value]) => `${key}=${tomlString(value)}`).join(',')
  const argsToml = server.args.map(tomlString).join(',')
  const toolsToml = allowedTools.map(tomlString).join(',')
  const serverValue = `{command=${tomlString(server.command)},args=[${argsToml}],env={${envToml}},enabled_tools=[${toolsToml}],default_tools_approval_mode="auto",tools={prepare_generation={approval_mode="approve"}}}`
  return {
    override: `mcp_servers.vibepaper=${serverValue}`,
    clientCwd,
  }
}

async function readCodexMcpIsolationOverrides() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  let configFilePresent = false
  try { await fs.access(configPath); configFilePresent = true } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('codex_user_config_unavailable')
  }
  if (!configFilePresent) return {
    configFilePresent: false, configuredMcpCount: 0, otherMcpCount: 0, otherMcpEnabledCount: 0,
  }

  const servers = new Map()
  let currentServer = null
  const stream = fsSync.createReadStream(configPath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('[')) {
        const section = trimmed.match(/^\[mcp_servers\.(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/u)
        if (section) {
          let name
          try { name = section[1] === undefined ? section[2] : JSON.parse(`"${section[1]}"`) } catch {
            throw new Error('codex_mcp_settings_unrecognized')
          }
          if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(name)) {
            throw new Error('codex_mcp_settings_unrecognized')
          }
          currentServer = name
          if (!servers.has(name)) servers.set(name, null)
          continue
        }
        if (/^\[mcp_servers\./u.test(trimmed) && !/^\[mcp_servers\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\]\s*(?:#.*)?$/u.test(trimmed)) {
          throw new Error('codex_mcp_settings_unrecognized')
        }
        currentServer = null
        continue
      }
      if (!currentServer && /^\s*mcp_servers\s*=/u.test(line)) throw new Error('codex_mcp_settings_unrecognized')
      if (!currentServer) continue
      const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/iu)
      if (enabled) servers.set(currentServer, enabled[1].toLowerCase() === 'true')
    }
  } finally {
    lines.close()
    stream.destroy()
  }

  const otherMcpEntries = [...servers.entries()].filter(([name]) => name !== 'vibepaper')
  return {
    configFilePresent: true,
    configuredMcpCount: servers.size,
    otherMcpCount: otherMcpEntries.length,
    otherMcpEnabledCount: otherMcpEntries.filter(([, enabled]) => enabled !== false).length,
  }
}

async function startClientProcess(clientKey, exportedConfig, fixtureRoot, clientCwd, prompt) {
  const target = clients[clientKey]
  const executablePath = resolveClientExecutable(clientKey)
  const trace = createTraceParser(clientKey)
  const diagnostics = { tail: '', rawChunkCount: 0 }
  const environment = buildCliEnvironment(clientKey)
  let executable
  let args
  let userConfigSummary = null

  if (clientKey === 'codex') {
    const server = parseCodexConfig(exportedConfig)
    const { override } = buildCodexOverride(server, fixtureRoot, clientCwd)
    const userConfig = await readCodexMcpIsolationOverrides()
    userConfigSummary = {
      configFilePresent: userConfig.configFilePresent,
      configuredMcpCount: userConfig.configuredMcpCount,
      otherMcpCount: userConfig.otherMcpCount,
      otherMcpEnabledCount: userConfig.otherMcpEnabledCount,
    }
    executable = executablePath
    args = [
      '--ask-for-approval', 'on-request', '-c', override,
      'exec', '--ignore-user-config', '--ephemeral', '--disable', 'shell_tool',
      '--sandbox', 'read-only', '--json', '--skip-git-repo-check', '--cd', clientCwd, prompt,
    ]
  } else {
    const server = parseClaudeConfig(exportedConfig)
    const configPath = path.join(fixtureRoot, 'claude-mcp-config.json')
    const mcpEnvironment = { ...server.env, APPDATA: fixtureRoot }
    for (const name of [
      'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AZURE_OPENAI_API_KEY',
      'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN', 'ARK_API_KEY', 'DOUBAO_API_KEY', 'VIBEPAPER_PROVIDER_API_KEY',
    ]) mcpEnvironment[name] = ''
    const config = { mcpServers: { vibepaper: { ...server, env: mcpEnvironment } } }
    executable = executablePath
    args = [
      '--strict-mcp-config', '--mcp-config', configPath,
      '--tools', '', '--allowedTools', allowedTools.map((name) => `mcp__vibepaper__${name}`).join(','),
      '--permission-mode', 'default', '--no-session-persistence', '--verbose', '--output-format', 'stream-json',
      '-p', prompt,
    ]
    // The configuration is written only under this unique disposable directory.
    await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
  }

  const child = spawn(executable, args, {
    cwd: clientCwd,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdoutBuffer = ''
  let finished = false
  let timedOut = false
  let timeout

  const appendDiagnostics = (chunk) => {
    diagnostics.rawChunkCount += 1
      diagnostics.tail = (diagnostics.tail + String(chunk) + '\n').slice(-16000)
  }
  const consumeStdout = (chunk) => {
    stdoutBuffer += String(chunk)
    let newline
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim()
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      trace.acceptLine(line)
      appendDiagnostics(line)
    }
    if (stdoutBuffer.length > 2_000_000) stdoutBuffer = stdoutBuffer.slice(-1_000_000)
  }

  const result = new Promise((resolve) => {
    const settle = (code, signal) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (stdoutBuffer.trim()) {
        trace.acceptLine(stdoutBuffer.trim())
        appendDiagnostics(stdoutBuffer.trim())
      }
      const traceSummary = trace.summary()
      const category = code === 0 && !signal && traceSummary.completedEventSeen
        ? null : classifyFailure(diagnostics.tail, code, signal, timedOut)
      resolve({
        exitCode: Number.isInteger(code) ? code : null,
        terminationSignal: signal || null,
        timedOut,
        success: code === 0 && !signal && !timedOut && traceSummary.completedEventSeen,
        failureCategory: category,
        trace: traceSummary,
      })
    }

    child.stdout?.on('data', consumeStdout)
    child.stderr?.on('data', appendDiagnostics)
    child.once('error', (error) => {
      appendDiagnostics(error?.message || 'process_spawn_failed')
      settle(null, 'spawn-error')
    })
    child.once('close', settle)
    timeout = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && Number.isInteger(child.pid)) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.unref()
      } else child.kill('SIGTERM')
    }, 240_000)
  })

  return {
    child, trace, result, diagnostics,
    userConfigSummary,
    environmentSummary: {
      cliOAuthEnvironmentProvided: clientKey === 'claude-code' && typeof environment.CLAUDE_CODE_OAUTH_TOKEN === 'string'
        && environment.CLAUDE_CODE_OAUTH_TOKEN.length > 0,
      sanitizedProxyEnvironmentProvided: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].some((name) =>
        Boolean(environment[name] || environment[name.toLowerCase()])),
      systemProxyAddressProvided: environment.systemProxyAddressProvided === true,
    },
  }
}

function naturalLanguagePrompt(clientKey) {
  const client = clients[clientKey]
  return [
    '请直接使用当前 VibePaper 画布完成下面的工作，并用简短中文汇报结果。',
    '先查看当前画布和可用模型；在画布中创建两个图片节点：参考“' + clientKey + ' 参考：晨雾森林”和目标“' + clientKey + ' 目标：森林横幅”。只建立一条从这个参考节点到这个目标节点的连线。',
    '然后在现有文字节点“' + client.targetNodeContent + '”上，使用目录中可用的本地文字模型生成一句简短说明，保留原内容作为输入。只准备提案，必须由桌面用户明确确认后才能提交。不要生成图片或视频，也不要自行批准桌面上的生成确认。',
    '如果画布版本冲突或出现参数错误，请根据返回的字段规则修正文字提案并重试一次；不要重复创建已完成的节点或连线。',
    '桌面操作者会很快批准这个本地文字提案。请继续查看这次提案和任务状态，直到任务成功；然后读取生成的文字结果并简要汇报，读取后结束本次操作，不要只停在等待确认的状态。',
    '只操作当前已授权的画布；不要运行终端命令、读取磁盘文件或调用其他外部服务。',
  ].join('\n')
}

function workerMain() {
  const electron = require('electron')
  const { app, BrowserWindow, dialog, protocol } = electron
  const fs = require('node:fs/promises')
  const { createServer } = require('node:http')
  const assert = require('node:assert/strict')
  const { createLocalProjectStore } = require('../src/project-store.cjs')

  const workerArgs = process.argv.slice(2)
  const clientKey = workerArgs[workerArgs.indexOf('--client') + 1]
  const fixtureRoot = path.resolve(workerArgs[workerArgs.indexOf('--fixture-root') + 1])
  const permanentEvidence = path.resolve(workerArgs[workerArgs.indexOf('--evidence-dir') + 1])
  const target = clients[clientKey]
  if (!target || !fixtureRoot || !permanentEvidence) throw new Error('Invalid isolated client-worker arguments')

  const profile = path.join(fixtureRoot, 'VibePaper')
  const projectDirectory = path.join(fixtureRoot, 'project')
  const clientCwd = assertTemporaryPath(os.tmpdir(), path.join(os.tmpdir(), `vibepaper-mcp-client-cwd-${randomUUID()}`))
  const originalSetPath = app.setPath.bind(app)
  const originalGetPath = app.getPath.bind(app)
  app.setPath = (name, value) => originalSetPath(name, name === 'userData' ? profile : value)
  app.getPath = (name) => name === 'appData' ? fixtureRoot : originalGetPath(name)
  BrowserWindow.prototype.show = function () {}
  protocol.registerSchemesAsPrivileged([{
    scheme: 'vibe',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }])
  protocol.registerSchemesAsPrivileged = () => {}

  let window
  let localModelServer
  let opened
  let cliRun
  let phase = 'prepare-isolated-profile'
  let localModelRequestCount = 0
  let pairingDialogCount = 0
  let grantClientId
  let clientConfig
  let pendingOperationId
  let generationConfirmationObserved = false
  let taskSucceeded = false
  let resultRead = false
  let canvasAssertions
  let rendererLoadFailureCode = null
  let rendererConsoleErrorCount = 0
  let rendererLoadFinished = false
  const startedAt = new Date().toISOString()
  const resultPath = path.join(fixtureRoot, 'worker-result.json')
  const mcpDiagnostics = { workerCalls: [], rpcErrors: [] }

  function installMcpDiagnostics() {
    const http = require('node:http')
    const serviceModule = require('../src/mcp-main-service.cjs')
    const originalFactory = serviceModule.createMcpMainService
    const workerProxies = new WeakMap()
    const wrapWorker = (worker) => {
      if (!worker || typeof worker !== 'object') return worker
      const cached = workerProxies.get(worker)
      if (cached) return cached
      const wrappedMethods = new Map()
      const proxy = new Proxy(worker, {
        get(targetObject, property) {
          const value = Reflect.get(targetObject, property, targetObject)
          if (typeof value !== 'function') return value
          const existing = wrappedMethods.get(property)
          if (existing) return existing
          const wrapped = property === 'request' ? function (...args) {
            const [method, payload] = args
            if (method !== 'mcp:tool:execute' || !payload || typeof payload !== 'object') {
              return Reflect.apply(value, targetObject, args)
            }
            const record = summarizeMcpWorkerPayload(payload)
            record.status = 'pending'
            mcpDiagnostics.workerCalls.push(record)
            const succeeded = (result) => {
              record.status = 'resolved'
              record.isError = result?.isError === true
              const code = result?.structuredContent?.errorCode
              record.errorCode = typeof code === 'string' && /^[A-Z0-9_]{1,120}$/u.test(code) ? code : null
              return result
            }
            const failed = (error) => {
              record.status = 'rejected'
              record.errorCode = safeDiagnosticErrorCode(error)
              throw error
            }
            try {
              const result = Reflect.apply(value, targetObject, args)
              return result && typeof result.then === 'function'
                ? result.then(succeeded, failed)
                : succeeded(result)
            } catch (error) {
              return failed(error)
            }
          } : value.bind(targetObject)
          wrappedMethods.set(property, wrapped)
          return wrapped
        },
      })
      workerProxies.set(worker, proxy)
      return proxy
    }
    const originalCreateServer = http.createServer
    const createServerWithRpcDiagnostics = function (...serverArgs) {
      const listenerIndex = serverArgs.findIndex((argument) => typeof argument === 'function')
      if (listenerIndex < 0) return Reflect.apply(originalCreateServer, this, serverArgs)
      const originalListener = serverArgs[listenerIndex]
      const args = [...serverArgs]
      args[listenerIndex] = function (request, response) {
        if (request?.url === '/rpc' && response && typeof response.end === 'function') {
          const originalEnd = response.end
          response.end = function (...endArgs) {
            try {
              const chunk = endArgs[0]
              if (Buffer.isBuffer(chunk) && chunk.length <= 600_000) {
                const isError = chunk.indexOf(Buffer.from('"isError":true')) >= 0
                const errorCode = readSafeJsonCode(chunk, 'errorCode')
                  || (response.statusCode >= 400 ? readSafeJsonCode(chunk, 'code') : null)
                if (errorCode || isError || response.statusCode >= 400) {
                  mcpDiagnostics.rpcErrors.push({
                    status: Number.isInteger(response.statusCode) ? response.statusCode : null,
                    isError,
                    errorCode,
                  })
                }
              }
            } catch { /* Only the public status/code summary is retained. */ }
            return Reflect.apply(originalEnd, this, endArgs)
          }
        }
        return Reflect.apply(originalListener, this, [request, response])
      }
      return Reflect.apply(originalCreateServer, this, args)
    }
    serviceModule.createMcpMainService = function (options) {
      const originalGetWorker = options.getWorker
      const wrappedOptions = {
        ...options,
        getWorker() {
          const worker = Reflect.apply(originalGetWorker, options, [])
          return wrapWorker(worker)
        },
      }
      const service = Reflect.apply(originalFactory, this, [wrappedOptions])
      const originalStart = service.start
      service.start = async function (...args) {
        http.createServer = createServerWithRpcDiagnostics
        try {
          return await Reflect.apply(originalStart, service, args)
        } finally {
          http.createServer = originalCreateServer
        }
      }
      return service
    }
  }

  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  dialog.showErrorBox = () => app.exit(1)
  dialog.showMessageBox = async (_owner, suppliedOptions) => {
    const options = suppliedOptions || _owner
    const approve = (options.buttons || []).findIndex((label) => /批准|允许|approve|allow/iu.test(label))
    if (approve < 0) throw new Error('unexpected_native_dialog')
    pairingDialogCount += 1
    return { response: approve, checkboxChecked: false }
  }
  app.on('browser-window-created', (_event, created) => {
    window = created
    created.webContents.setBackgroundThrottling(false)
    created.webContents.on('did-finish-load', () => { rendererLoadFinished = true })
    created.webContents.on('did-fail-load', (_loadEvent, errorCode) => { rendererLoadFailureCode = errorCode })
    created.webContents.on('console-message', (_consoleEvent, level) => {
      if (level >= 2) rendererConsoleErrorCount += 1
    })
  })

  async function evaluate(source) { return window.webContents.executeJavaScript(source) }
  async function waitFor(source, timeout = 35000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (window && !window.webContents.isLoading() && await evaluate(source).catch(() => false)) return
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('ui_state_timeout')
  }
  async function waitForGenerationCard(timeout = 225000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (window && !window.isDestroyed() && !window.webContents.isLoading()) {
        const ready = await evaluate("Boolean(document.querySelector('[data-testid=mcp-generation-confirmation] button:not(:disabled)'))").catch(() => false)
        if (ready) return
      }
      if (cliRun?.result) {
        const settled = await Promise.race([cliRun.result, new Promise((resolve) => setTimeout(() => resolve(null), 20))])
        if (settled) throw new Error(`generation_proposal_not_created:${settled.failureCategory || 'client_turn_completed'}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('generation_confirmation_card_timeout')
  }
  async function stopOwnedClientProcess() {
    const child = cliRun?.child
    if (!child || child.exitCode !== null || child.signalCode !== null || !Number.isInteger(child.pid)) return
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        })
        killer.once('error', resolve)
        killer.once('close', resolve)
        setTimeout(resolve, 3000).unref()
      })
    } else {
      child.kill('SIGTERM')
    }
    await Promise.race([cliRun.result, new Promise((resolve) => setTimeout(resolve, 2000))])
  }
  async function screenshot(name) {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await fs.writeFile(path.join(permanentEvidence, name), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
  }
  async function readCanvasFailureSnapshot() {
    if (!window || window.isDestroyed() || !opened?.project) return null
    const projectId = opened.project.projectId
    const canvasId = opened.project.canvasId
    const loaded = await evaluate(`window.vibepaperDesktop.loadCanvas(${JSON.stringify(projectId)}, ${JSON.stringify(canvasId)})`).catch(() => null)
    const nodes = Array.isArray(loaded?.nodes) ? loaded.nodes : []
    const edges = Array.isArray(loaded?.edges) ? loaded.edges : []
    const nodeText = (node) => JSON.stringify(node)
    const reference = nodes.find((node) => nodeText(node).includes(`${clientKey} 参考：晨雾森林`))
    const destination = nodes.find((node) => nodeText(node).includes(`${clientKey} 目标：森林横幅`))
    const markedNodes = nodes.filter((node) => nodeText(node).includes(`${clientKey} 参考：`)
      || nodeText(node).includes(`${clientKey} 目标：`))
    const markedImageNodes = markedNodes.filter((node) => node.type === 'image')
    const originalTextNode = nodes.find((node) => node.type === 'text' && nodeText(node).includes(target.targetNodeContent))
    const markedImageNodeIds = markedImageNodes.map((node) => node.id).filter((id) => typeof id === 'string')
    const edgeSource = (edge) => edge.sourceNodeId || edge.source
    const edgeTarget = (edge) => edge.targetNodeId || edge.target
    const referenceToTargetEdgeCount = reference && destination
      ? edges.filter((edge) => edgeSource(edge) === reference.id && edgeTarget(edge) === destination.id).length
      : 0
    const edgesTouchingMarkedNodes = edges.filter((edge) => [edgeSource(edge), edgeTarget(edge)]
      .some((id) => markedNodes.some((node) => node.id === id)))
    const originalTextNodePresent = Boolean(originalTextNode)
    const renderer = await evaluate(`(() => {
      const root = document.querySelector('[data-testid=mcp-canvas-page]')
      const elements = [...(root?.querySelectorAll('.react-flow__node[data-id]') || [])]
      const elementsById = new Map(elements.map((element) => [element.getAttribute('data-id'), element]))
      const expected = {
        markedImageIds: ${JSON.stringify(markedImageNodeIds)},
        referenceId: ${JSON.stringify(typeof reference?.id === 'string' ? reference.id : null)},
        targetId: ${JSON.stringify(typeof destination?.id === 'string' ? destination.id : null)},
        originalTextId: ${JSON.stringify(typeof originalTextNode?.id === 'string' ? originalTextNode.id : null)},
      }
      const isVisible = (element) => {
        if (!element || !root) return false
        const rect = element.getBoundingClientRect()
        const rootRect = root.getBoundingClientRect()
        const style = getComputedStyle(element)
        const left = Math.max(0, rootRect.left)
        const right = Math.min(innerWidth, rootRect.right)
        const top = Math.max(0, rootRect.top)
        const bottom = Math.min(innerHeight, rootRect.bottom)
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
          && rect.width > 0 && rect.height > 0 && rect.right > left && rect.left < right
          && rect.bottom > top && rect.top < bottom
      }
      const elementFor = (id) => typeof id === 'string' ? elementsById.get(id) || null : null
      const visibleMarkedImageNodeCount = expected.markedImageIds
        .filter((id) => isVisible(elementFor(id))).length
      return {
        canvasRootPresent: Boolean(root),
        canvasPathMatches: location.pathname === ${JSON.stringify(`/canvas/${opened.project.canvasId}`)},
        renderedNodeCount: elements.length,
        renderedMarkedImageNodeCount: expected.markedImageIds.filter((id) => elementFor(id)).length,
        visibleMarkedImageNodeCount,
        renderedReferenceNodePresent: Boolean(elementFor(expected.referenceId)),
        visibleReferenceNode: isVisible(elementFor(expected.referenceId)),
        renderedTargetNodePresent: Boolean(elementFor(expected.targetId)),
        visibleTargetNode: isVisible(elementFor(expected.targetId)),
        renderedOriginalTextNodePresent: Boolean(elementFor(expected.originalTextId)),
        visibleOriginalTextNode: isVisible(elementFor(expected.originalTextId)),
      }
    })()`).catch(() => null)
    return {
      canvasPath: `/canvas/${canvasId}`,
      loadedNodeCount: nodes.length,
      markedNodeCount: markedNodes.length,
      markedImageNodeCount: markedImageNodes.length,
      referenceNodePresent: Boolean(reference),
      targetNodePresent: Boolean(destination),
      referenceToTargetEdgeCount,
      edgesTouchingMarkedNodes: edgesTouchingMarkedNodes.length,
      originalTextNodePresent,
      renderer,
    }
  }
  async function prepareFixture() {
    await fs.mkdir(profile, { recursive: true })
    await fs.mkdir(projectDirectory, { recursive: true })
    await fs.mkdir(clientCwd, { recursive: true })
    const store = createLocalProjectStore()
    try {
      opened = await store.createProject(projectDirectory, `Real ${target.display} MCP fixture`)
      await store.createNode({
        projectId: opened.project.projectId,
        canvasId: opened.project.canvasId,
        expectedVersion: 0,
        type: 'text',
        params: { content: target.targetNodeContent },
        x: 180, y: 180,
        idempotencyKey: `real-client-${clientKey}-seed`,
      })
    } finally { await store.close() }
    await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({
      schemaVersion: 1, projectDirectory: opened.directory,
    }))
  }
  async function startLocalModelFixture() {
    localModelServer = createServer((request, response) => {
      const handleRequest = async () => {
        if (request.url === '/v1/models' && request.method === 'GET') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ object: 'list', data: [{ id: 'mcp-client-fixture-text', object: 'model' }] }))
          return
        }
        if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
          response.writeHead(404); response.end(); return
        }
        let raw = ''
        for await (const chunk of request) {
          raw += chunk
          if (raw.length > 65536) { response.writeHead(413); response.end(); return }
        }
        let input
        try { input = JSON.parse(raw) } catch { response.writeHead(400); response.end(); return }
        localModelRequestCount += 1
        const content = `本地验收文字：${target.targetNodeContent}已完成。`
        if (input.stream === true) {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'mcp-client-fixture-text',
            choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        } else {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'mcp-client-fixture-text',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
        }
      }
      void handleRequest().catch(() => {
        if (response.destroyed || response.writableEnded) return
        if (response.headersSent) {
          response.destroy()
          return
        }
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'LOCAL_FIXTURE_FAILED' } }))
      })
    })
    await new Promise((resolve, reject) => {
      localModelServer.once('error', reject)
      localModelServer.listen(0, '127.0.0.1', resolve)
    })
    return `http://127.0.0.1:${localModelServer.address().port}/v1`
  }
  async function run() {
    await prepareFixture()
    phase = 'launch-isolated-electron-original-canvas'
    installMcpDiagnostics()
    require('../src/main.cjs')
    await app.whenReady()
    assert.equal(app.getPath('userData'), profile)
    phase = 'wait-original-workspace'
    await waitFor("location.pathname === '/workspace' && document.querySelector('[role=button]')")
    await evaluate("document.querySelector('[role=button]').click()")
    phase = 'wait-original-canvas'
    const expectedCanvasPath = `/canvas/${opened.project.canvasId}`
    await waitFor(`location.pathname === ${JSON.stringify(expectedCanvasPath)} && document.querySelector('[data-testid=mcp-canvas-page] .react-flow__node')`)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    assert.equal(await evaluate('location.pathname'), expectedCanvasPath, 'The original CanvasPage must remain active after loading')
    assert(await evaluate("Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow__node'))"),
      'The original canvas must render its seeded node before client authorization begins')
    phase = 'wait-mcp-preflight'
    await waitFor('Boolean(window.vibepaperDesktop?.getMcpState)')
    phase = 'wait-authorized-canvas-ready'
    await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')

    phase = 'configure-local-text-fixture'
    const endpoint = await startLocalModelFixture()
    await evaluate(`window.vibepaperDesktop.saveLocalTextModel(${JSON.stringify({ endpoint, modelId: 'mcp-client-fixture-text' })})`)
    await waitFor("window.vibepaperDesktop.getLocalTextModel().then(value => value?.modelId === 'mcp-client-fixture-text').catch(() => false)")
    phase = 'enable-mcp-and-create-isolated-grant'
    const enabledState = await evaluate('window.vibepaperDesktop.setMcpEnabled(true)')
    assert.equal(enabledState?.enabled, true, 'The isolated MCP service must be enabled before creating a client grant')
    const grantInput = {
      clientName: clientKey,
      permissions: ['canvas.read', 'canvas.write', 'generation.propose', 'task.read'],
      providerGrants: [],
      mediaTypes: [],
      disclosureVersion: (await evaluate('window.vibepaperDesktop.getMcpState()')).connectionDisclosureVersion || 'desktop-mcp-provider-disclosure-v1',
      accepted: true,
    }
    const grantResult = await evaluate(`window.vibepaperDesktop.createMcpClientGrant(${JSON.stringify(grantInput)})`)
    clientConfig = clientKey === 'codex' ? grantResult?.config?.codex : grantResult?.config?.claudeCode
    assert.equal(typeof clientConfig, 'string', 'The public desktop bridge must export a client-specific MCP configuration')
    const clientState = await evaluate('window.vibepaperDesktop.getMcpState()')
    const grant = clientState.clients.find((entry) => entry.clientName === clientKey)
    assert(grant, 'The desktop did not persist the requested client grant')
    assert.deepEqual([...grant.permissions].sort(), ['canvas.read', 'canvas.write', 'generation.propose', 'task.read'].sort())
    grantClientId = grant.clientId
    await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
    assert.equal(await evaluate('location.pathname'), expectedCanvasPath, 'Client setup must leave the original CanvasPage active')

    phase = 'real-client-natural-language-mcp-turn'
    const prompt = naturalLanguagePrompt(clientKey)
    cliRun = await startClientProcess(clientKey, clientConfig, fixtureRoot, clientCwd, prompt)
    const beforeConfirmationRequests = localModelRequestCount
    await waitForGenerationCard()
    generationConfirmationObserved = true
    const traceBeforeApproval = cliRun.trace.summary()
    assert(traceBeforeApproval.toolCallsObserved.includes('prepare_generation'), 'The real CLI did not call the generation proposal tool')
    assert.equal(localModelRequestCount, beforeConfirmationRequests, 'No local model request may start before desktop confirmation')
    pendingOperationId = null
    phase = 'desktop-confirms-local-fixture-only'
    await screenshot(`${clientKey}-generation-before-confirmation.png`)
    await evaluate("document.querySelectorAll('[data-testid=mcp-generation-confirmation] button')[1].click()")

    const cliResult = await cliRun.result
    phase = 'verify-client-trace-and-original-canvas'
    assert.equal(cliResult.exitCode, 0, `The genuine ${target.display} turn did not exit successfully (${cliResult.failureCategory || 'unknown'})`)
    assert(cliResult.trace.completedEventSeen, 'The CLI did not report completion of the actual model turn')
    const missingTrace = requiredTrace.filter((name) => !cliResult.trace.toolCallsObserved.includes(name))
    assert.deepEqual(missingTrace, [], `The real client did not use required MCP tools: ${missingTrace.join(',')}`)
    assert(pairingDialogCount >= 1, 'The real CLI did not establish a newly paired stdio connection')
    assert.equal(localModelRequestCount, 1, 'The local fixture must be called exactly once after desktop confirmation')

    const active = await evaluate('window.vibepaperDesktop.getActiveProject()')
    const state = await evaluate('window.vibepaperDesktop.getMcpState()')
    const projectId = active?.project?.projectId || active?.projectId || opened.project.projectId
    const canvasId = state?.activeCanvas?.canvasId || opened.project.canvasId
    const loaded = await evaluate(`window.vibepaperDesktop.loadCanvas(${JSON.stringify(projectId)}, ${JSON.stringify(canvasId)})`)
    const nodes = loaded?.nodes || []
    const edges = loaded?.edges || []
    const markedNodes = nodes.filter((node) => JSON.stringify(node).includes(`${clientKey} 参考：`)
      || JSON.stringify(node).includes(`${clientKey} 目标：`))
    assert.equal(markedNodes.length, 2, 'The real client must create exactly two image nodes')
    const source = markedNodes.find((node) => JSON.stringify(node).includes(`${clientKey} 参考：晨雾森林`))
    const destination = markedNodes.find((node) => JSON.stringify(node).includes(`${clientKey} 目标：森林横幅`))
    assert(source && destination, 'The real client must preserve the requested reference and target')
    const expectedEdgeKey = `${source.id}->${destination.id}`
    assert.equal(edges.filter((edge) => (edge.sourceNodeId || edge.source) === source.id
      && (edge.targetNodeId || edge.target) === destination.id).length, 1,
    'The client must connect the reference to its target exactly once')
    const touchedEdges = edges.filter((edge) => [edge.sourceNodeId || edge.source, edge.targetNodeId || edge.target]
      .some((id) => markedNodes.some((node) => node.id === id)))
    const actualEdgeKeys = touchedEdges.map((edge) => `${edge.sourceNodeId || edge.source}->${edge.targetNodeId || edge.target}`)
    assert.equal(touchedEdges.length, 1, 'The two image nodes must have exactly one total edge')
    assert.deepEqual(actualEdgeKeys, [expectedEdgeKey], 'The client must not create any extra edge')

    const tasks = await evaluate(`window.vibepaperDesktop.listTasks(${JSON.stringify(projectId)}, 100)`)
    const fixtureTasks = Array.isArray(tasks) ? tasks : tasks?.tasks || []
    const targetNode = nodes.find((node) => JSON.stringify(node).includes(target.targetNodeContent) && node.type === 'text')
    assert(targetNode, 'The initial text target must remain in the original canvas')
    const task = fixtureTasks.find((entry) => entry.nodeId === targetNode.id && (entry.status === 'succeeded' || entry.state === 'succeeded'))
    assert(task, 'The original text node must have a completed local task')
    taskSucceeded = true
    const output = await evaluate(`window.vibepaperDesktop.readTaskOutput(${JSON.stringify(projectId)}, ${JSON.stringify(task.taskId || task.id)})`)
    const outputText = JSON.stringify(output)
    assert(outputText.includes(`本地验收文字：${target.targetNodeContent}已完成。`), 'The local fixture output must be readable from the completed task')
    await waitFor(`document.querySelector('[data-testid=mcp-canvas-page]').innerText.includes(${JSON.stringify(`本地验收文字：${target.targetNodeContent}已完成。`)})`)
    resultRead = true
    await screenshot(`${clientKey}-result-on-original-canvas.png`)

    await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grantClientId)})`)
    const afterRevoke = await evaluate('window.vibepaperDesktop.getMcpState()')
    const revokedClient = afterRevoke.clients.find((entry) => entry.clientId === grantClientId)
    assert(revokedClient?.revokedAt && revokedClient.connected === false,
      'The isolated test grant must be revoked and disconnected')
    return {
      success: true,
      client: clientKey,
      cliVersionPreviouslyObserved: clientKey === 'codex' ? '0.154.0' : '2.1.170',
      naturalLanguageTurn: true,
      cliExitCode: cliResult.exitCode,
      actualCliTurnCompleted: cliResult.exitCode === 0 && cliResult.trace.completedEventSeen,
      cliAssistantReplySeen: cliResult.trace.assistantReplySeen,
      authorizedConnectionEstablished: pairingDialogCount >= 1,
      toolCallsObserved: cliResult.trace.toolCallsObserved,
      distinctToolCount: cliResult.trace.distinctToolCount,
      generationConfirmationObserved,
      taskSucceeded,
      resultRead,
      mcpToolTrace: cliResult.trace.toolCallsObserved,
      mcpToolResults: cliResult.trace.toolResults,
      mcpToolResultCount: cliResult.trace.toolResultCount,
      mcpDiagnostics: {
        workerCalls: [...mcpDiagnostics.workerCalls],
        rpcErrors: [...mcpDiagnostics.rpcErrors],
      },
      codexUserConfigFilePresent: cliRun.userConfigSummary?.configFilePresent || false,
      codexUserConfigIgnoredByCli: clientKey === 'codex',
      codexUserConfigModified: false,
      codexMcpApprovalPolicy: clientKey === 'codex' ? {
        cliAskForApproval: 'on-request',
        defaultToolsApprovalMode: 'auto',
        prepareGenerationApprovalMode: 'approve',
        shellToolDisabled: true,
        sandbox: 'read-only',
      } : null,
      configuredMcpEntryCount: cliRun.userConfigSummary?.configuredMcpCount ?? null,
      excludedOtherMcpCount: cliRun.userConfigSummary?.otherMcpCount ?? null,
      excludedEnabledOtherMcpCount: cliRun.userConfigSummary?.otherMcpEnabledCount ?? null,
      systemProxyAddressProvided: cliRun.environmentSummary?.systemProxyAddressProvided || false,
      toolTraceComplete: missingTrace.length === 0,
      pairedConnectionCount: pairingDialogCount,
      grantedPermissions: [...grant.permissions].sort(),
      createdMarkedNodes: markedNodes.length,
      oneToOneEdges: touchedEdges.length,
      localFixtureRequests: localModelRequestCount,
      localTaskSucceeded: task.status || task.state,
      localOutputReadable: true,
      resultVisibleInOriginalCanvas: true,
      realMediaProviderRequests: 0,
      realImageOrVideoGeneration: false,
      isolatedProfile: true,
      exportedConfigurationUsed: true,
      rawClientTranscriptSaved: false,
      secretsReadOrWrittenToEvidence: false,
      startedAt,
      evidenceFiles: [
        `${clientKey}-generation-before-confirmation.png`,
        `${clientKey}-result-on-original-canvas.png`,
      ],
      cliJsonEventCount: cliResult.trace.jsonEventCount,
      cliAssistantReplySeen: cliResult.trace.assistantReplySeen,
    }
  }

  run().then(async (summary) => {
    if (localModelServer) await new Promise((resolve) => localModelServer.close(resolve))
    await fs.rm(clientCwd, { recursive: true, force: true })
    await fs.writeFile(resultPath, JSON.stringify(summary, null, 2))
    app.quit()
  }).catch(async (error) => {
    if (localModelServer) await new Promise((resolve) => localModelServer.close(resolve)).catch(() => {})
    await stopOwnedClientProcess().catch(() => {})
    await fs.rm(clientCwd, { recursive: true, force: true }).catch(() => {})
    if (window && !window.isDestroyed()) await new Promise((resolve) => setTimeout(resolve, 750))
    const canvasFailureSnapshot = await readCanvasFailureSnapshot().catch(() => null)
    const pageState = window && !window.isDestroyed()
      ? await evaluate('({ pathname: location.pathname, readyState: document.readyState, bodyPresent: Boolean(document.body) })').catch(() => null)
      : null
    const failureScreenshot = window && !window.isDestroyed() ? `${clientKey}-failure-${Date.now()}.png` : null
    if (failureScreenshot) {
      await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
        .then((image) => fs.writeFile(path.join(permanentEvidence, failureScreenshot), image.toPNG()))
        .catch(() => {})
    }
    const trace = cliRun?.trace?.summary?.() || null
    const cliResult = cliRun?.result
      ? await Promise.race([cliRun.result, new Promise((resolve) => setTimeout(() => resolve(null), 0))])
      : null
    const diagnosticText = cliRun?.diagnostics?.tail || ''
    const safeError = error?.message && /^[a-z0-9_:-]+$/iu.test(error.message) ? error.message : 'client_acceptance_assertion_failed'
    const failure = {
      success: false,
      client: clientKey,
      failureCategory: cliResult?.failureCategory || classifyFailure(diagnosticText, cliResult?.exitCode, cliResult?.terminationSignal, cliResult?.timedOut) || safeError,
      phase,
      pageState,
      rendererDiagnostics: {
        loadFinished: rendererLoadFinished,
        loadFailureCode: rendererLoadFailureCode,
        consoleErrorCount: rendererConsoleErrorCount,
      },
      failureScreenshot,
      mcpToolTrace: trace?.toolCallsObserved || [],
      cliJsonEventCount: trace?.jsonEventCount || 0,
      cliExitCode: cliResult?.exitCode ?? null,
      cliTerminationSignal: cliResult?.terminationSignal || null,
      actualCliTurnCompleted: cliResult?.exitCode === 0 && trace?.completedEventSeen === true,
      cliAssistantReplySeen: trace?.assistantReplySeen || false,
      authorizedConnectionEstablished: pairingDialogCount >= 1,
      toolCallsObserved: trace?.toolCallsObserved || [],
      generationConfirmationObserved,
      taskSucceeded,
      resultRead,
      cliTrace: trace ? {
        assistantReplySeen: trace.assistantReplySeen,
        completedEventSeen: trace.completedEventSeen,
        errorEventSeen: trace.errorEventSeen,
        toolCallsObserved: trace.toolCallsObserved,
        distinctToolCount: trace.distinctToolCount,
        toolResultCount: trace.toolResultCount,
        toolResults: trace.toolResults,
      } : null,
      mcpToolResults: trace?.toolResults || [],
      mcpDiagnostics: {
        workerCalls: [...mcpDiagnostics.workerCalls],
        rpcErrors: [...mcpDiagnostics.rpcErrors],
      },
      diagnosticHints: {
        authenticationLike: /not logged in|log[ -]?in required|authentication|unauthorized|oauth|credential/u.test(diagnosticText.toLowerCase()),
        networkLike: /econn|network|fetch failed|connect|dns|timed out|timeout/u.test(diagnosticText.toLowerCase()),
        modelLike: /model.{0,40}(unavailable|not found|unsupported)|no model configured/u.test(diagnosticText.toLowerCase()),
        configurationLike: /unknown (option|flag|feature)|unrecognized option|invalid.{0,20}config|config.{0,20}(parse|invalid)/u.test(diagnosticText.toLowerCase()),
      },
      safeNetworkDiagnostic: summarizeDiagnostic(diagnosticText),
      safeFailureReason: summarizeFailureReason(diagnosticText, summarizeDiagnostic(diagnosticText).httpStatus, cliResult?.timedOut || false),
      cliOAuthEnvironmentProvided: cliRun?.environmentSummary?.cliOAuthEnvironmentProvided || false,
      sanitizedProxyEnvironmentProvided: cliRun?.environmentSummary?.sanitizedProxyEnvironmentProvided || false,
      systemProxyAddressProvided: cliRun?.environmentSummary?.systemProxyAddressProvided || false,
      codexUserConfigFilePresent: cliRun?.userConfigSummary?.configFilePresent || false,
      codexUserConfigIgnoredByCli: clientKey === 'codex',
      codexUserConfigModified: false,
      codexMcpApprovalPolicy: clientKey === 'codex' ? {
        cliAskForApproval: 'on-request',
        defaultToolsApprovalMode: 'auto',
        prepareGenerationApprovalMode: 'approve',
        shellToolDisabled: true,
        sandbox: 'read-only',
      } : null,
      configuredMcpEntryCount: cliRun?.userConfigSummary?.configuredMcpCount ?? null,
      excludedOtherMcpCount: cliRun?.userConfigSummary?.otherMcpCount ?? null,
      excludedEnabledOtherMcpCount: cliRun?.userConfigSummary?.otherMcpEnabledCount ?? null,
      pairedConnectionCount: pairingDialogCount,
      localFixtureRequests: localModelRequestCount,
      canvasFailureSnapshot,
      exportedConfigurationUsed: Boolean(clientConfig),
      isolatedProfile: true,
      rawClientTranscriptSaved: false,
      secretsReadOrWrittenToEvidence: false,
      errorCode: safeError,
      startedAt,
    }
    await fs.writeFile(resultPath, JSON.stringify(failure, null, 2)).catch(() => {})
    app.exit(1)
  })
}

async function controllerMain() {
  const temporaryBase = path.join(root, '.test-temp')
  await fs.mkdir(temporaryBase, { recursive: true })
  await fs.mkdir(evidenceDirectory, { recursive: true })
  const outcomes = []
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const runId = randomUUID()

  const clientKeys = process.argv.includes('--codex-only') ? ['codex'] : ['codex', 'claude-code']
  for (const clientKey of clientKeys) {
    const fixtureRoot = assertTemporaryPath(temporaryBase, path.join(temporaryBase, `vibepaper-mcp-client-${timestamp}-${runId}-${clientKey}`))
    const resultPath = path.join(fixtureRoot, 'worker-result.json')
    await fs.mkdir(fixtureRoot, { recursive: true })
    const electronPath = path.join(root, 'vibepaper-desktop/node_modules/electron/dist/electron.exe')
    const electronEnvironment = buildCliEnvironment()
    delete electronEnvironment.ELECTRON_RUN_AS_NODE
    const worker = spawn(electronPath, [
      path.join(__dirname, 'smoke-mcp-clients.cjs'), '--worker', '--client', clientKey,
      '--fixture-root', fixtureRoot, '--evidence-dir', evidenceDirectory,
    ], {
      cwd: root,
      env: electronEnvironment,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let workerTimedOut = false
    const workerResult = await new Promise((resolve) => {
      let settled = false
      const finish = async (code, signal, spawnErrorCode = null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const summary = await fs.readFile(resultPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null)
        resolve({ code, signal, spawnErrorCode, summary })
      }
      const timer = setTimeout(() => {
        workerTimedOut = true
        if (process.platform === 'win32' && Number.isInteger(worker.pid)) {
          const killer = spawn('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.unref()
        } else worker.kill('SIGTERM')
      }, 390_000)
      worker.once('error', (error) => {
        const spawnErrorCode = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code)
          ? error.code : 'SPAWN_ERROR'
        finish(null, 'spawn-error', spawnErrorCode)
      })
      worker.once('close', finish)
    })
    const summary = workerResult.summary || {
      success: false, client: clientKey, isolatedProfile: true, failureCategory: workerTimedOut ? 'electron_worker_timeout' : 'electron_worker_failed',
      electronWorkerExitCode: Number.isInteger(workerResult.code) ? workerResult.code : null,
      electronWorkerTerminationSignal: workerResult.signal || null,
      electronWorkerSpawnErrorCode: workerResult.spawnErrorCode,
      exportedConfigurationUsed: false, rawClientTranscriptSaved: false, secretsReadOrWrittenToEvidence: false,
    }
    outcomes.push(summary)
    console.log(`${clientKey}: ${summary.success ? 'PASS' : `BLOCKED (${summary.failureCategory || 'acceptance_failed'})`}`)
    await fs.rm(assertTemporaryPath(temporaryBase, fixtureRoot), { recursive: true, force: true })
  }

  const combined = {
    schemaVersion: 1,
    testType: 'real installed CLI natural-language MCP acceptance against isolated Electron development runtime',
    date: new Date().toISOString(),
    success: outcomes.length > 0 && outcomes.every((entry) => entry.success === true),
    clientResults: outcomes,
    scope: {
      realCodexCliTurn: outcomes.some((entry) => entry.client === 'codex' && entry.actualCliTurnCompleted === true),
      realClaudeCodeTurn: outcomes.some((entry) => entry.client === 'claude-code' && entry.actualCliTurnCompleted === true),
      actualCliTurnCompleted: outcomes.some((entry) => entry.actualCliTurnCompleted === true),
      authorizedConnectionEstablished: outcomes.some((entry) => entry.authorizedConnectionEstablished === true),
      toolCallsObserved: outcomes.some((entry) => Array.isArray(entry.toolCallsObserved) && entry.toolCallsObserved.length > 0),
      generationConfirmationObserved: outcomes.some((entry) => entry.generationConfirmationObserved === true),
      taskSucceeded: outcomes.some((entry) => entry.taskSucceeded === true),
      resultRead: outcomes.some((entry) => entry.resultRead === true),
      realCloudMediaRequests: 0,
      localFixtureGenerationOnly: true,
      desktopGenerationConfirmationUsed: outcomes.some((entry) => entry.generationConfirmationObserved === true && entry.localFixtureRequests > 0),
      authMaterialReadOrCopied: false,
      rawClientOutputPersisted: false,
      temporaryMcpConfigurationsRemoved: true,
      packagedApplicationTested: false,
    },
  }
  const outputPath = path.join(evidenceDirectory, `client-acceptance-${timestamp}.json`)
  await fs.writeFile(outputPath, JSON.stringify(combined, null, 2))
  console.log(`evidence: ${path.relative(root, outputPath)}`)
  if (!combined.success) process.exitCode = 1
}

if (process.argv.includes('--worker')) workerMain()
else controllerMain().catch((error) => {
  console.error(error?.message && /^[a-z0-9_:-]+$/iu.test(error.message) ? error.message : 'client_acceptance_controller_failed')
  process.exitCode = 1
})
