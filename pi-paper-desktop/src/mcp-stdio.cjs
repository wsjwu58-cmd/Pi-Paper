'use strict'

const path = require('node:path')
const fsConstants = require('node:fs').constants
const { createHash, randomUUID } = require('node:crypto')
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const {
  CallToolRequestSchema,
  CallToolResultSchema,
  ElicitResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} = require('@modelcontextprotocol/sdk/types.js')

const INSTANCE_SCHEMA_VERSION = 1
const BRIDGE_AUTH_SCHEMA_VERSION = 1
const PROTOCOL_VERSION = 1
const MAX_INSTANCE_BYTES = 4 * 1024
const MAX_BRIDGE_AUTH_BYTES = 4 * 1024
const MAX_HTTP_RESPONSE_BYTES = 12 * 1024 * 1024
const MAX_MCP_IMAGE_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_MCP_VIDEO_OUTPUT_BYTES = 8 * 1024 * 1024
const BOOTSTRAP_TIMEOUT_MS = 123_000
const RPC_TIMEOUT_MS = 310_000
const ELICITATION_TIMEOUT_MS = 120_000
const CLOSE_TIMEOUT_MS = 2_000
const REQUEST_CANCELLED_ERROR_CODE = -32800
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,160}$/u
const CREDENTIAL_FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const SOURCE_REF_RE = /^[A-Za-z0-9._:-]{8,160}$/u
const SAFE_CODE_RE = /^[A-Z0-9_]{1,120}$/u
const CREDENTIAL_INPUT_MODES = new Set(['authorized_env', 'inline', 'desktop_input'])

const ERROR_MESSAGES = Object.freeze({
  DESKTOP_NOT_RUNNING: 'VibePaper desktop is not running.',
  CANVAS_NOT_READY: 'Open the authorized canvas in VibePaper before connecting.',
  MCP_DISABLED: 'External Agent access is disabled in VibePaper.',
  CONNECTION_NOT_APPROVED: 'The desktop did not approve this connection.',
  MCP_BRIDGE_AUTH_INVALID: 'The local MCP bridge authorization is invalid. Restart VibePaper and reconnect.',
  CLIENT_CONFIRMATION_UNSUPPORTED: 'This MCP client does not support form confirmation required for generation.',
  GENERATION_CONFIRMATION_UNRESOLVED: 'Generation confirmation was not completed. No generation task was submitted.',
  GENERATION_CONFIRMATION_PENDING: 'This generation already has a pending client confirmation. Complete that form or check the original operation.',
  UNAUTHORIZED: 'The desktop connection is no longer authorized.',
  PROJECT_CHANGED: 'The authorized project or canvas changed.',
  PERMISSION_DENIED: 'The requested capability is not authorized.',
  RPC_RESULT_UNKNOWN: 'The desktop connection ended before the result was received. Check the operation before retrying.',
  CREDENTIAL_SOURCE_UNAVAILABLE: 'An authorized credential source is unavailable.',
  CREDENTIAL_SOURCE_INVALID: 'The credential source is not authorized for this connection.',
  PROVIDER_REVISION_CONFLICT: 'The provider configuration changed. Refresh it before retrying.',
  IDEMPOTENCY_CONFLICT: 'This operation ID was already used with different input.',
  UNSUPPORTED: 'This output modality is not available through the desktop connection.',
  TASK_OUTPUT_NOT_FOUND: 'The requested output index does not exist.',
  TASK_OUTPUT_UNAVAILABLE: 'The task output could not be safely read.',
  OUTPUT_TOO_LARGE: 'The task output exceeds the MCP preview size limit.',
  OUTPUT_MIME_MISMATCH: 'The task output content does not match its media type.',
  INVALID_INPUT: 'The desktop rejected the request.',
  MCP_RESPONSE_INVALID: 'The desktop returned an invalid response.',
})

const OFFLINE_CONTEXT_TOOL = Object.freeze({
  name: 'get_context',
  description: 'VibePaper is not running (DESKTOP_NOT_RUNNING). Start VibePaper and retry.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
})

class BridgeFailure extends Error {
  constructor(code, { retryable = false, cause } = {}) {
    super(code)
    this.name = 'BridgeFailure'
    this.code = SAFE_CODE_RE.test(code) ? code : 'MCP_REQUEST_FAILED'
    this.retryable = retryable
    if (cause) this.cause = cause
  }
}

function messageForCode(code) {
  return ERROR_MESSAGES[code] || 'The desktop request failed.'
}

function safeCode(value, fallback = 'MCP_REQUEST_FAILED') {
  return typeof value === 'string' && SAFE_CODE_RE.test(value) ? value : fallback
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.includes(key))
}

function normalizeClientInfo(server) {
  let version
  try { version = server.getClientVersion?.() } catch { version = undefined }
  const clean = (value, fallback) => {
    if (typeof value !== 'string') return fallback
    const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80)
    return normalized || fallback
  }
  return {
    name: clean(version?.name, 'MCP client'),
    version: clean(version?.version, 'unknown'),
  }
}

function fixedInstancePath(appDataPath) {
  if (typeof appDataPath !== 'string' || appDataPath.length === 0 || !path.isAbsolute(appDataPath)) {
    throw new BridgeFailure('MCP_LAUNCH_CONFIGURATION_INVALID')
  }
  return path.join(appDataPath, 'VibePaper', 'mcp-instance.json')
}

function fixedBridgeAuthPath(appDataPath) {
  if (typeof appDataPath !== 'string' || appDataPath.length === 0 || !path.isAbsolute(appDataPath)) {
    throw new BridgeFailure('MCP_LAUNCH_CONFIGURATION_INVALID')
  }
  return path.join(appDataPath, 'VibePaper', 'mcp-bridge-auth.json')
}

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function validateInstance(instance) {
  const keys = ['schemaVersion', 'instanceId', 'host', 'port', 'protocolVersion', 'pid']
  if (!exactKeys(instance, keys) || instance.schemaVersion !== INSTANCE_SCHEMA_VERSION
    || !UUID_RE.test(instance.instanceId) || instance.host !== '127.0.0.1'
    || !Number.isInteger(instance.port) || instance.port < 1 || instance.port > 65_535
    || instance.protocolVersion !== PROTOCOL_VERSION || !Number.isSafeInteger(instance.pid) || instance.pid < 1) {
    throw new BridgeFailure('DESKTOP_NOT_RUNNING')
  }
  return instance
}

async function readInstanceFile(instanceFilePath, appDataPath, fsImpl = require('node:fs/promises')) {
  const expected = fixedInstancePath(appDataPath)
  if (!samePath(instanceFilePath, expected)) throw new BridgeFailure('MCP_LAUNCH_CONFIGURATION_INVALID')
  try {
    const stat = await fsImpl.lstat(expected)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 2 || stat.size > MAX_INSTANCE_BYTES) {
      throw new BridgeFailure('DESKTOP_NOT_RUNNING')
    }
    const bytes = await fsImpl.readFile(expected)
    if (bytes.length > MAX_INSTANCE_BYTES) throw new BridgeFailure('DESKTOP_NOT_RUNNING')
    try {
      return validateInstance(JSON.parse(bytes.toString('utf8')))
    } finally {
      bytes.fill(0)
    }
  } catch (error) {
    if (error instanceof BridgeFailure) throw error
    throw new BridgeFailure('DESKTOP_NOT_RUNNING', { cause: error })
  }
}

function validateBridgeAuth(auth) {
  if (!exactKeys(auth, ['schemaVersion', 'instanceId', 'secret'])
    || auth.schemaVersion !== BRIDGE_AUTH_SCHEMA_VERSION
    || !UUID_RE.test(auth.instanceId)
    || typeof auth.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(auth.secret)) {
    throw new BridgeFailure('MCP_BRIDGE_AUTH_INVALID')
  }
  const decoded = Buffer.from(auth.secret, 'base64url')
  try {
    if (decoded.length !== 32 || decoded.toString('base64url') !== auth.secret) {
      throw new BridgeFailure('MCP_BRIDGE_AUTH_INVALID')
    }
  } finally {
    decoded.fill(0)
  }
  return auth
}

async function readBridgeAuthFile(authFilePath, appDataPath, fsImpl = require('node:fs/promises')) {
  const expected = fixedBridgeAuthPath(appDataPath)
  if (typeof authFilePath !== 'string' || !samePath(authFilePath, expected)) {
    throw new BridgeFailure('MCP_LAUNCH_CONFIGURATION_INVALID')
  }
  let handle
  let bytes
  let parsed
  try {
    const before = await fsImpl.lstat(expected)
    if (before.isSymbolicLink() || !before.isFile() || before.size < 2 || before.size > MAX_BRIDGE_AUTH_BYTES) {
      throw new BridgeFailure('MCP_BRIDGE_AUTH_INVALID')
    }
    if (process.platform !== 'win32') {
      if ((before.mode & 0o777) !== 0o600 || typeof process.getuid !== 'function' || before.uid !== process.getuid()) {
        throw new BridgeFailure('MCP_BRIDGE_AUTH_INVALID')
      }
    }
    const flags = fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0))
    handle = await fsImpl.open(expected, flags)
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size < 2 || opened.size > MAX_BRIDGE_AUTH_BYTES
      || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new BridgeFailure('MCP_BRIDGE_AUTH_INVALID')
    }
    if (process.platform !== 'win32'
      && ((opened.mode & 0o777) !== 0o600 || opened.uid !== process.getuid())) {
      throw new BridgeFailure('MCP_BRIDGE_AUTH_INVALID')
    }
    bytes = await handle.readFile()
    if (bytes.length > MAX_BRIDGE_AUTH_BYTES) throw new BridgeFailure('MCP_BRIDGE_AUTH_INVALID')
    parsed = JSON.parse(bytes.toString('utf8'))
    return { ...validateBridgeAuth(parsed) }
  } catch (error) {
    if (error instanceof BridgeFailure) throw error
    throw new BridgeFailure('MCP_BRIDGE_AUTH_INVALID', { cause: error })
  } finally {
    bytes?.fill(0)
    if (parsed && typeof parsed === 'object' && typeof parsed.secret === 'string') parsed.secret = ''
    try { await handle?.close() } catch { /* no diagnostics for credential file cleanup */ }
  }
}

function validateCredentialSources(value, sessionExpiresAt, now) {
  if (!Array.isArray(value) || value.length > 32) throw new BridgeFailure('MCP_RESPONSE_INVALID')
  const seen = new Set()
  return value.map((entry) => {
    if (!exactKeys(entry, ['sourceRef', 'providerId', 'fieldName', 'envVariableName', 'expiresAt'])
      || typeof entry.sourceRef !== 'string' || !SOURCE_REF_RE.test(entry.sourceRef)
      || seen.has(entry.sourceRef)
      || typeof entry.providerId !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(entry.providerId)
      || typeof entry.fieldName !== 'string' || !CREDENTIAL_FIELD_RE.test(entry.fieldName)
      || typeof entry.envVariableName !== 'string' || !ENV_NAME_RE.test(entry.envVariableName)
      || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= now || entry.expiresAt > sessionExpiresAt) {
      throw new BridgeFailure('MCP_RESPONSE_INVALID')
    }
    seen.add(entry.sourceRef)
    return { ...entry }
  })
}

function writeStderr(stderr, message) {
  if (!stderr || typeof stderr.write !== 'function') return
  try { stderr.write(`${message}\n`) } catch { /* diagnostics never affect the protocol */ }
}

function safeToolError(code) {
  const normalized = safeCode(code)
  const result = {
    content: [{ type: 'text', text: messageForCode(normalized) }],
    structuredContent: { errorCode: normalized },
    isError: true,
  }
  return CallToolResultSchema.parse(result)
}

function scrubString(input, secretValues) {
  let value = input
  const sorted = [...new Set(secretValues.filter((secret) => typeof secret === 'string' && secret.length > 0))]
    .sort((left, right) => right.length - left.length)
  for (const secret of sorted) {
    value = value.split(secret).join('[redacted]')
  }
  return value.slice(0, 20_000)
}

function scrubValue(value, secretValues, depth = 0, key = '') {
  if (depth > 24) return '[omitted]'
  if (key === 'credentialInputModes') {
    return Array.isArray(value) ? [...new Set(value.filter((entry) => CREDENTIAL_INPUT_MODES.has(entry)))].slice(0, 3) : undefined
  }
  if (key === 'allowedCredentialFields') {
    return Array.isArray(value) ? [...new Set(value.filter((entry) => typeof entry === 'string'
      && CREDENTIAL_FIELD_RE.test(entry)))].slice(0, 16) : undefined
  }
  if (key === 'credentialSources') {
    if (!Array.isArray(value)) return []
    const descriptorKeys = ['sourceRef', 'providerId', 'fieldName', 'sourceKind', 'envVariableName', 'expiresAt']
    return value.slice(0, 32).flatMap((source) => {
      if (!isPlainObject(source) || Object.keys(source).length !== descriptorKeys.length
        || Object.keys(source).some((sourceKey) => !descriptorKeys.includes(sourceKey))
        || typeof source.sourceRef !== 'string' || !SOURCE_REF_RE.test(source.sourceRef)
        || typeof source.providerId !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(source.providerId)
        || typeof source.fieldName !== 'string' || !CREDENTIAL_FIELD_RE.test(source.fieldName)
        || source.sourceKind !== 'authorized_env'
        || typeof source.envVariableName !== 'string' || !ENV_NAME_RE.test(source.envVariableName)
        || !Number.isSafeInteger(source.expiresAt) || source.expiresAt < 1) return []
      return [{ sourceRef: source.sourceRef, providerId: source.providerId, fieldName: source.fieldName,
        sourceKind: source.sourceKind, envVariableName: source.envVariableName, expiresAt: source.expiresAt }]
    })
  }
  if (/(?:api.?key|secret|password|authorization|access.?token|approval.?token|credentials?|private.?key)/iu.test(key)) {
    return '[redacted]'
  }
  if (typeof value === 'string') return scrubString(value, secretValues)
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => scrubValue(item, secretValues, depth + 1, key))
  if (isPlainObject(value)) {
    const safe = {}
    for (const [childKey, child] of Object.entries(value)) {
      const sanitized = scrubValue(child, secretValues, depth + 1, childKey)
      if (sanitized !== undefined) safe[childKey] = sanitized
    }
    return safe
  }
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value
  return undefined
}

function stripGenerationConfirmation(value, depth = 0) {
  if (depth > 24) return '[omitted]'
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => stripGenerationConfirmation(item, depth + 1))
  if (!isPlainObject(value)) return value
  const safe = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'generationConfirmation' || key === 'challenge' || key === 'challengeToken') continue
    safe[key] = stripGenerationConfirmation(entry, depth + 1)
  }
  return safe
}

function displayConfirmationValue(value) {
  let rendered
  if (typeof value === 'string') rendered = value
  else {
    try { rendered = JSON.stringify(value) } catch { throw new BridgeFailure('MCP_RESPONSE_INVALID') }
  }
  if (typeof rendered !== 'string' || rendered.length === 0) return '(none)'
  return rendered.length > 4_000 ? `${rendered.slice(0, 4_000)}…` : rendered
}

function validateGenerationConfirmation(value, now) {
  if (!exactKeys(value, ['proposalId', 'challengeToken', 'expiresAt', 'items'])
    || typeof value.proposalId !== 'string' || value.proposalId.length < 1 || value.proposalId.length > 200
    || typeof value.challengeToken !== 'string' || value.challengeToken.length < 16 || value.challengeToken.length > 512
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100) {
    throw new BridgeFailure('MCP_RESPONSE_INVALID')
  }
  const items = value.items.map((item) => {
    if (!exactKeys(item, ['target', 'model', 'input', 'overwrite'])
      || item.target === undefined || item.model === undefined || item.input === undefined
      || typeof item.overwrite !== 'boolean') {
      throw new BridgeFailure('MCP_RESPONSE_INVALID')
    }
    return {
      target: displayConfirmationValue(item.target),
      model: displayConfirmationValue(item.model),
      input: displayConfirmationValue(item.input),
      overwrite: item.overwrite,
    }
  })
  return { proposalId: value.proposalId, challengeToken: value.challengeToken, expiresAt: value.expiresAt, items }
}

function generationConfirmationMessage(items) {
  const details = items.map((item, index) => [
    `Item ${index + 1}`,
    `Target: ${item.target}`,
    `Model: ${item.model}`,
    `Input: ${item.input}`,
    `Overwrite existing content: ${item.overwrite ? 'Yes' : 'No'}`,
  ].join('\n')).join('\n\n')
  return [
    'Confirm this generation request. If the selected model is cloud-hosted, the listed input may be sent to its provider and provider fees may apply.',
    details,
  ].join('\n\n')
}

function decodeBoundedBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length < 4 || value.length > Math.ceil(maxBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new BridgeFailure('MCP_RESPONSE_INVALID')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString('base64') !== value) {
    bytes.fill(0)
    throw new BridgeFailure('MCP_RESPONSE_INVALID')
  }
  return bytes
}

function sanitizeTaskOutputResult(result, secretValues = []) {
  if (!isPlainObject(result) || !Array.isArray(result.content) || result.content.length !== 1
    || !isPlainObject(result.structuredContent)) throw new BridgeFailure('MCP_RESPONSE_INVALID')
  if (result.isError === true) {
    const safe = scrubValue(result, secretValues)
    return CallToolResultSchema.parse(safe)
  }
  const metadata = scrubValue(result.structuredContent, secretValues)
  if (!isPlainObject(metadata) || typeof metadata.taskId !== 'string' || metadata.taskId.length < 1
    || metadata.taskId.length > 128 || metadata.status !== 'succeeded'
    || !Number.isSafeInteger(metadata.outputIndex) || metadata.outputIndex < 0 || metadata.outputIndex > 3) {
    throw new BridgeFailure('MCP_RESPONSE_INVALID')
  }
  const allowedKeys = new Set(['taskId', 'status', 'modality', 'outputIndex', 'mode', 'output', 'offset',
    'nextOffset', 'totalCharacters', 'hasMore', 'mimeType', 'sizeBytes'])
  if (Object.keys(metadata).some((key) => !allowedKeys.has(key))) throw new BridgeFailure('MCP_RESPONSE_INVALID')
  const block = result.content[0]
  if (!isPlainObject(block)) throw new BridgeFailure('MCP_RESPONSE_INVALID')

  if (block.type === 'text') {
    if (Object.keys(block).some((key) => !['type', 'text'].includes(key))
      || typeof block.text !== 'string' || block.text.length > 20_000) throw new BridgeFailure('MCP_RESPONSE_INVALID')
    if (metadata.modality === 'text') {
      if (Object.keys(metadata).some((key) => !['taskId', 'status', 'modality', 'outputIndex', 'output',
        'offset', 'nextOffset', 'totalCharacters', 'hasMore'].includes(key))
        || metadata.outputIndex !== 0 || typeof metadata.output !== 'string' || metadata.output !== block.text
        || !Number.isSafeInteger(metadata.offset) || metadata.offset < 0
        || !Number.isSafeInteger(metadata.nextOffset) || metadata.nextOffset < metadata.offset
        || !Number.isSafeInteger(metadata.totalCharacters) || metadata.totalCharacters < metadata.nextOffset
        || typeof metadata.hasMore !== 'boolean' || metadata.hasMore !== (metadata.nextOffset < metadata.totalCharacters)) {
        throw new BridgeFailure('MCP_RESPONSE_INVALID')
      }
    } else if (!['image', 'video'].includes(metadata.modality) || metadata.mode !== 'metadata'
      || Object.keys(metadata).some((key) => !['taskId', 'status', 'modality', 'outputIndex', 'mode', 'sizeBytes'].includes(key))
      || (metadata.sizeBytes !== undefined && (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1))) {
      throw new BridgeFailure('MCP_RESPONSE_INVALID')
    }
    return CallToolResultSchema.parse({
      content: [{ type: 'text', text: scrubString(block.text, secretValues) }],
      structuredContent: metadata,
    })
  }

  if (metadata.mode !== 'preview' || Object.keys(metadata).some((key) => !['taskId', 'status', 'modality',
    'outputIndex', 'mode', 'mimeType', 'sizeBytes'].includes(key))
    || !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1
    || typeof metadata.mimeType !== 'string') throw new BridgeFailure('MCP_RESPONSE_INVALID')

  if (block.type === 'image') {
    if (Object.keys(block).some((key) => !['type', 'data', 'mimeType'].includes(key))
      || metadata.modality !== 'image' || block.mimeType !== metadata.mimeType
      || !['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType)) throw new BridgeFailure('MCP_RESPONSE_INVALID')
    const bytes = decodeBoundedBase64(block.data, MAX_MCP_IMAGE_OUTPUT_BYTES)
    try {
      if (metadata.sizeBytes !== bytes.length) throw new BridgeFailure('MCP_RESPONSE_INVALID')
    } finally { bytes.fill(0) }
    return CallToolResultSchema.parse({
      content: [{ type: 'image', data: block.data, mimeType: block.mimeType }],
      structuredContent: metadata,
    })
  }

  if (block.type === 'resource' && isPlainObject(block.resource)
    && Object.keys(block).every((key) => ['type', 'resource'].includes(key))
    && Object.keys(block.resource).every((key) => ['uri', 'mimeType', 'blob'].includes(key))
    && Object.keys(block.resource).length === 3
    && metadata.modality === 'video' && block.resource.mimeType === metadata.mimeType
    && ['video/mp4', 'video/quicktime', 'video/webm'].includes(block.resource.mimeType)
    && block.resource.uri === `vibepaper://task-output/${metadata.taskId}/${metadata.outputIndex}`) {
    const bytes = decodeBoundedBase64(block.resource.blob, MAX_MCP_VIDEO_OUTPUT_BYTES)
    try {
      if (metadata.sizeBytes !== bytes.length) throw new BridgeFailure('MCP_RESPONSE_INVALID')
    } finally { bytes.fill(0) }
    return CallToolResultSchema.parse({
      content: [{ type: 'resource', resource: { ...block.resource } }],
      structuredContent: metadata,
    })
  }
  throw new BridgeFailure('MCP_RESPONSE_INVALID')
}

function clearSensitiveCall(prepared) {
  if (!prepared) return
  for (const sourceRef of Object.keys(prepared.credentialValues || {})) prepared.credentialValues[sourceRef] = ''
  for (let index = 0; index < prepared.secretValues.length; index += 1) prepared.secretValues[index] = ''
  const fields = prepared.inlineCredentialFields || Object.keys(prepared.inlineCredentialObject || {})
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(prepared.inlineCredentialObject, field)
    if (descriptor && Object.hasOwn(descriptor, 'value') && descriptor.writable) {
      prepared.inlineCredentialObject[field] = ''
    }
  }
}

function clearInlineCredentialArguments(args) {
  const credentials = args?.credentialInput?.credentials
  if (!isPlainObject(credentials)) return
  for (const field of Object.keys(credentials)) {
    const descriptor = Object.getOwnPropertyDescriptor(credentials, field)
    if (descriptor && Object.hasOwn(descriptor, 'value') && descriptor.writable) credentials[field] = ''
  }
}

function prepareCredentialCall(args, { credentialSources = [], env = process.env, now = Date.now, randomId = randomUUID } = {}) {
  if (!isPlainObject(args)) throw new BridgeFailure('INVALID_INPUT')
  const credentialValues = {}
  const secretValues = []
  let inlineCredentialObject = null
  const input = args.credentialInput

  if (input === undefined) return { arguments: args, credentialValues, secretValues, inlineCredentialObject }
  if (!isPlainObject(input) || typeof input.source !== 'string') throw new BridgeFailure('INVALID_INPUT')

  // Desktop input is completed by the user's existing provider settings page.
  // It carries no secret through the bridge and is forwarded as a marker only.
  if (input.source === 'desktop_input') {
    if (!exactKeys(input, ['source'])) throw new BridgeFailure('INVALID_INPUT')
    return { arguments: args, credentialValues, secretValues, inlineCredentialObject }
  }

  if (input.source === 'inline') {
    if (!exactKeys(input, ['source', 'credentials']) || !isPlainObject(input.credentials)) {
      throw new BridgeFailure('INVALID_INPUT')
    }
    const supplied = input.credentials
    const fields = Object.keys(supplied)
    if (fields.length < 1 || fields.length > 16
      || fields.some((field) => !CREDENTIAL_FIELD_RE.test(field))) {
      throw new BridgeFailure('INVALID_INPUT')
    }
    inlineCredentialObject = supplied
    const sourceRefs = {}
    for (const field of fields) {
      const sourceRef = `inline-${randomId()}`
      sourceRefs[field] = sourceRef
    }
    args.credentialInput = { source: 'inline', sourceRefs }
    return { arguments: args, credentialValues, secretValues, inlineCredentialObject,
      inlineCredentialFields: fields, inlineSourceRefs: sourceRefs }
  }

  if (input.source === 'authorized_env') {
    if (!exactKeys(input, ['source', 'sourceRefs']) || !isPlainObject(input.sourceRefs)) {
      throw new BridgeFailure('INVALID_INPUT')
    }
    const providerId = args.providerId
    const requested = Object.entries(input.sourceRefs)
    if (requested.length < 1 || requested.length > 16) throw new BridgeFailure('INVALID_INPUT')
    const sourcesByRef = new Map(credentialSources.map((source) => [source.sourceRef, source]))
    const seenRefs = new Set()
    for (const [fieldName, sourceRef] of requested) {
      if (!CREDENTIAL_FIELD_RE.test(fieldName) || typeof sourceRef !== 'string' || seenRefs.has(sourceRef)) {
        throw new BridgeFailure('CREDENTIAL_SOURCE_INVALID')
      }
      const source = sourcesByRef.get(sourceRef)
      if (!source || source.providerId !== providerId || source.fieldName !== fieldName || source.expiresAt <= now()) {
        throw new BridgeFailure('CREDENTIAL_SOURCE_INVALID')
      }
      const value = env[source.envVariableName]
      if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
        throw new BridgeFailure('CREDENTIAL_SOURCE_UNAVAILABLE')
      }
      credentialValues[sourceRef] = value
      secretValues.push(value)
      seenRefs.add(sourceRef)
    }
    return { arguments: args, credentialValues, secretValues, inlineCredentialObject }
  }

  throw new BridgeFailure('INVALID_INPUT')
}

function readInlineCredentialValues(prepared) {
  if (!prepared || !isPlainObject(prepared.inlineCredentialObject)
    || !Array.isArray(prepared.inlineCredentialFields) || !isPlainObject(prepared.inlineSourceRefs)) {
    throw new BridgeFailure('INVALID_INPUT')
  }
  for (const field of prepared.inlineCredentialFields) {
    let value
    try { value = prepared.inlineCredentialObject[field] }
    catch { throw new BridgeFailure('INVALID_INPUT') }
    if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
      throw new BridgeFailure('INVALID_INPUT')
    }
    const sourceRef = prepared.inlineSourceRefs[field]
    prepared.credentialValues[sourceRef] = value
    prepared.secretValues.push(value)
    const descriptor = Object.getOwnPropertyDescriptor(prepared.inlineCredentialObject, field)
    if (descriptor && Object.hasOwn(descriptor, 'value') && descriptor.writable) {
      prepared.inlineCredentialObject[field] = ''
    }
  }
}

async function callProviderWithCredentialPreflight(callMain, prepared, signal) {
  const params = { name: 'configure_provider', arguments: prepared.arguments }
  if (!Array.isArray(prepared.inlineCredentialFields)) {
    return callMain('tools/call', params, prepared, signal)
  }
  let preflight
  let credentialsRequired = false
  try {
    preflight = await callMain('tools/call', params, prepared, signal)
  } catch (error) {
    if (error?.code !== 'CREDENTIAL_SOURCE_UNAVAILABLE') throw error
    credentialsRequired = true
  }
  if (preflight?.structuredContent?.status === 'awaiting_disclosure') return preflight
  const preflightCode = preflight?.structuredContent?.errorCode
  if (preflight?.isError && preflightCode && preflightCode !== 'CREDENTIAL_SOURCE_UNAVAILABLE') return preflight
  if (preflight?.isError && preflightCode === 'CREDENTIAL_SOURCE_UNAVAILABLE') credentialsRequired = true
  if (!credentialsRequired) {
    throw new BridgeFailure('MCP_RESPONSE_INVALID')
  }
  readInlineCredentialValues(prepared)
  return callMain('tools/call', params, prepared, signal)
}

function createMcpStdioBridge(options = {}) {
  const {
    instanceFilePath,
    appDataPath,
    authFilePath = fixedBridgeAuthPath(appDataPath),
    clientId,
    grantId,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    fetchImpl = globalThis.fetch,
    fsImpl = require('node:fs/promises'),
    now = Date.now,
    randomId = randomUUID,
    elicitationTimeoutMs = ELICITATION_TIMEOUT_MS,
    processLike = process,
    transportOverride,
  } = options

  if (typeof fetchImpl !== 'function' || typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)
    || typeof grantId !== 'string' || !CLIENT_ID_RE.test(grantId)) {
    throw new BridgeFailure('MCP_LAUNCH_CONFIGURATION_INVALID')
  }
  const expectedInstancePath = fixedInstancePath(appDataPath)
  if (typeof instanceFilePath !== 'string' || !samePath(instanceFilePath, expectedInstancePath)) {
    throw new BridgeFailure('MCP_LAUNCH_CONFIGURATION_INVALID')
  }
  const expectedAuthPath = fixedBridgeAuthPath(appDataPath)
  if (typeof authFilePath !== 'string' || !samePath(authFilePath, expectedAuthPath)
    || !Number.isSafeInteger(elicitationTimeoutMs) || elicitationTimeoutMs < 1) {
    throw new BridgeFailure('MCP_LAUNCH_CONFIGURATION_INVALID')
  }

  const server = new Server({ name: 'vibepaper-desktop-mcp', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } })
  const transport = transportOverride || new StdioServerTransport(stdin, stdout, { maxBufferSize: 1024 * 1024 })
  let instance = null
  let session = null
  let authFingerprint = null
  let credentialSources = []
  let bootstrapPromise = null
  let bootstrapFailureCode = null
  let offlineCatalogAdvertised = false
  let closed = false
  let closePromise = null
  let resolveStopped
  const stopped = new Promise((resolve) => { resolveStopped = resolve })

  function makeUrl(route) {
    if (!instance) throw new BridgeFailure('DESKTOP_NOT_RUNNING')
    return `http://127.0.0.1:${instance.port}${route}`
  }

  async function readResponse(response) {
    if (response.redirected || response.url && instance && response.url !== makeUrl(new URL(response.url).pathname)) {
      throw new BridgeFailure('MCP_RESPONSE_INVALID')
    }
    const headerSize = Number(response.headers?.get?.('content-length'))
    const contentType = response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json' || Number.isFinite(headerSize) && headerSize > MAX_HTTP_RESPONSE_BYTES) {
      try { await response.body?.cancel?.() } catch { /* reject without retaining an invalid body */ }
      throw new BridgeFailure('MCP_RESPONSE_INVALID')
    }
    const reader = response.body?.getReader?.()
    if (!reader) throw new BridgeFailure('MCP_RESPONSE_INVALID')
    const chunks = []
    let byteLength = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!(value instanceof Uint8Array)) throw new BridgeFailure('MCP_RESPONSE_INVALID')
        byteLength += value.byteLength
        if (byteLength > MAX_HTTP_RESPONSE_BYTES) {
          try { await reader.cancel() } catch { /* stop reading oversized bodies */ }
          throw new BridgeFailure('MCP_RESPONSE_INVALID')
        }
        chunks.push(Buffer.from(value))
      }
      const bytes = Buffer.concat(chunks, byteLength)
      try {
        return JSON.parse(bytes.toString('utf8'))
      } finally {
        bytes.fill(0)
      }
    } catch (error) {
      if (error instanceof BridgeFailure) throw error
      throw new BridgeFailure('MCP_RESPONSE_INVALID')
    } finally {
      for (const chunk of chunks) chunk.fill(0)
      try { reader.releaseLock() } catch { /* body may already be cancelled */ }
    }
  }

  async function post(route, payload, { token, timeoutMs, signal } = {}) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const body = Buffer.from(JSON.stringify(payload))
    let response
    try {
      response = await fetchImpl(makeUrl(route), {
        method: 'POST', headers, body, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      })
      const parsed = await readResponse(response)
      if (!response.ok) {
        const code = safeCode(parsed?.error?.code, 'MCP_REQUEST_FAILED')
        throw new BridgeFailure(code)
      }
      return parsed
    } catch (error) {
      if (error instanceof BridgeFailure) throw error
      if (route === '/bootstrap') {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw new BridgeFailure('CONNECTION_RESULT_UNKNOWN', { cause: error })
        }
        throw new BridgeFailure('DESKTOP_NOT_RUNNING', { retryable: true, cause: error })
      }
      if (route === '/rpc') throw new BridgeFailure(signal?.aborted ? 'REQUEST_CANCELLED' : 'RPC_RESULT_UNKNOWN', { cause: error })
      throw new BridgeFailure('DESKTOP_NOT_RUNNING', { cause: error })
    } finally {
      body.fill(0)
      response = null
    }
  }

  async function loadCurrentInstance() {
    const current = await readInstanceFile(instanceFilePath, appDataPath, fsImpl)
    const auth = await readBridgeAuthFile(authFilePath, appDataPath, fsImpl)
    if (auth.instanceId !== current.instanceId) {
      auth.secret = ''
      throw new BridgeFailure('MCP_BRIDGE_AUTH_INVALID')
    }
    const fingerprint = createHash('sha256').update(auth.secret).digest('hex')
    if (instance && (current.instanceId !== instance.instanceId || authFingerprint !== fingerprint)) {
      if (session) session.accessToken = ''
      session = null
      credentialSources = []
      bootstrapFailureCode = null
    }
    instance = current
    authFingerprint = fingerprint
    return auth
  }

  async function bootstrap() {
    if (closed) throw new BridgeFailure('UNAUTHORIZED')
    let authorization
    try {
      authorization = await loadCurrentInstance()
    } catch (error) {
      if (session) session.accessToken = ''
      session = null
      credentialSources = []
      authFingerprint = null
      throw error
    }
    if (session && session.expiresAt > now() && session.instanceId === instance?.instanceId) {
      authorization.secret = ''
      return session
    }
    if (bootstrapFailureCode) {
      authorization.secret = ''
      throw new BridgeFailure(bootstrapFailureCode)
    }
    if (bootstrapPromise) {
      authorization.secret = ''
      return bootstrapPromise
    }

    bootstrapPromise = (async () => {
      const payload = { clientId, grantId, clientInfo: normalizeClientInfo(server), bridgeSecret: authorization.secret }
      authorization.secret = ''
      let result
      try {
        const pending = post('/bootstrap', payload, { timeoutMs: BOOTSTRAP_TIMEOUT_MS })
        payload.bridgeSecret = ''
        result = await pending
      } catch (error) {
        if (error.retryable && error.code === 'DESKTOP_NOT_RUNNING') throw error
        bootstrapFailureCode = error.code
        throw error
      } finally {
        payload.bridgeSecret = ''
      }
      if (!isPlainObject(result) || !exactKeys(result, ['instanceId', 'connectionId', 'accessToken', 'expiresAt', 'credentialSources'])
        || result.instanceId !== instance.instanceId || typeof result.connectionId !== 'string' || !UUID_RE.test(result.connectionId)
        || typeof result.accessToken !== 'string' || result.accessToken.length < 32 || result.accessToken.length > 256
        || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now()) {
        bootstrapFailureCode = 'MCP_RESPONSE_INVALID'
        throw new BridgeFailure('MCP_RESPONSE_INVALID')
      }
      try { credentialSources = validateCredentialSources(result.credentialSources, result.expiresAt, now()) }
      catch (error) {
        bootstrapFailureCode = 'MCP_RESPONSE_INVALID'
        throw error
      }
      session = { instanceId: result.instanceId, connectionId: result.connectionId,
        accessToken: result.accessToken, expiresAt: result.expiresAt }
      bootstrapFailureCode = null
      return session
    })()
    try {
      return await bootstrapPromise
    } finally {
      bootstrapPromise = null
    }
  }

  async function callMain(method, params, prepared = null, signal) {
    const live = await bootstrap()
    const result = await callMainOnSession(method, params, live, prepared, signal)
    if (method !== 'tools/list' && result?.isError !== true && offlineCatalogAdvertised && !closed) {
      // A client may have cached the offline get_context-only catalogue. Once
      // an authenticated call succeeds, invite it to rediscover scoped tools.
      // This notification never retries the tool call or changes permissions.
      offlineCatalogAdvertised = false
      try { await server.sendToolListChanged() } catch { offlineCatalogAdvertised = true }
    }
    return result
  }

  async function callMainOnSession(method, params, live, prepared = null, signal) {
    if (signal?.aborted) throw new BridgeFailure('REQUEST_CANCELLED')
    if (closed || !live || session !== live || live.expiresAt <= now() || live.instanceId !== instance?.instanceId) {
      throw new BridgeFailure('UNAUTHORIZED')
    }
    const payload = { method, params }
    if (prepared && Object.keys(prepared.credentialValues).length > 0) payload.credentialValues = prepared.credentialValues
    return post('/rpc', payload, { token: live.accessToken, timeoutMs: RPC_TIMEOUT_MS, signal })
  }

  function clientSupportsFormElicitation() {
    const capabilities = server.getClientCapabilities?.()
    const elicitation = capabilities?.elicitation
    if (!isPlainObject(elicitation)) return false

    // Protocol 2025-11-25 treats an empty elicitation capability as the
    // legacy form capability. Keep this deliberately strict: URL-only,
    // unknown-only, or malformed form capability fields do not authorize confirmation.
    const keys = Object.keys(elicitation)
    if (keys.length === 0) return true
    if (!Object.prototype.hasOwnProperty.call(elicitation, 'form') || !isPlainObject(elicitation.form)) return false
    return !Object.prototype.hasOwnProperty.call(elicitation.form, 'applyDefaults')
      || typeof elicitation.form.applyDefaults === 'boolean'
  }

  async function assertGenerationSession(live, signal) {
    if (signal?.aborted) throw new BridgeFailure('REQUEST_CANCELLED')
    let authorization
    try {
      authorization = await loadCurrentInstance()
    } catch (error) {
      throw new BridgeFailure('GENERATION_CONFIRMATION_UNRESOLVED', { cause: error })
    } finally {
      if (authorization) authorization.secret = ''
    }
    if (signal?.aborted) throw new BridgeFailure('REQUEST_CANCELLED')
    if (closed || session !== live || !live || live.expiresAt <= now()
      || live.instanceId !== instance?.instanceId) {
      throw new BridgeFailure('GENERATION_CONFIRMATION_UNRESOLVED')
    }
  }

  async function rejectPendingGeneration(confirmation, live) {
    if (!confirmation?.challengeToken || closed || !live) return
    try {
      await assertGenerationSession(live)
      const pending = callMainOnSession('generation/confirm', {
        proposalId: confirmation.proposalId,
        challengeToken: confirmation.challengeToken,
        decision: 'reject',
      }, live)
      confirmation.challengeToken = ''
      await pending
    } catch {
      confirmation.challengeToken = ''
    }
  }

  async function confirmGeneration(result, signal, live) {
    if ((result?.structuredContent?.status ?? result?.status) !== 'awaiting_confirmation') {
      throw new BridgeFailure('MCP_RESPONSE_INVALID')
    }
    let confirmation
    try {
      confirmation = validateGenerationConfirmation(result.generationConfirmation, now())
    } finally {
      if (isPlainObject(result.generationConfirmation)
        && typeof result.generationConfirmation.challengeToken === 'string') {
        result.generationConfirmation.challengeToken = ''
      }
    }
    let elicitation
    try {
      if (!clientSupportsFormElicitation()) throw new BridgeFailure('CLIENT_CONFIRMATION_UNSUPPORTED')
      await assertGenerationSession(live, signal)
      // Server.elicitInput checks the SDK's private form capability field,
      // which rejects the protocol's legacy empty elicitation capability.
      // Use the public request API and public result schema instead, then
      // validate the requested confirmation field below.
      elicitation = await server.request({
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message: generationConfirmationMessage(confirmation.items),
          requestedSchema: {
            type: 'object',
            properties: { confirm: { type: 'boolean', title: '确认提交本次生成' } },
            required: ['confirm'],
          },
        },
      }, ElicitResultSchema, { signal, timeout: elicitationTimeoutMs })
      if (elicitation?.action === 'accept'
        && (!isPlainObject(elicitation.content) || typeof elicitation.content.confirm !== 'boolean')) {
        throw new BridgeFailure('GENERATION_CONFIRMATION_UNRESOLVED')
      }
    } catch (error) {
      await rejectPendingGeneration(confirmation, live)
      if (signal?.aborted) throw new BridgeFailure('REQUEST_CANCELLED', { cause: error })
      if (error?.code === 'GENERATION_CONFIRMATION_UNRESOLVED') throw error
      throw new BridgeFailure('GENERATION_CONFIRMATION_UNRESOLVED', { cause: error })
    }

    try {
      await assertGenerationSession(live, signal)
      const accepted = elicitation?.action === 'accept'
        && isPlainObject(elicitation.content) && elicitation.content.confirm === true
      const pending = callMainOnSession('generation/confirm', {
        proposalId: confirmation.proposalId,
        challengeToken: confirmation.challengeToken,
        decision: accepted ? 'approve' : 'reject',
      }, live, null, signal)
      confirmation.challengeToken = ''
      const resolved = await pending
      if (!isPlainObject(resolved) || !Array.isArray(resolved.content)) {
        throw new BridgeFailure('MCP_RESPONSE_INVALID')
      }
      return resolved
    } finally {
      confirmation.challengeToken = ''
    }
  }

  function toolDefinitions() {
    return [{ ...OFFLINE_CONTEXT_TOOL, inputSchema: { ...OFFLINE_CONTEXT_TOOL.inputSchema,
      properties: { ...OFFLINE_CONTEXT_TOOL.inputSchema.properties } } }]
  }

  async function listTools() {
    try {
      const result = await callMain('tools/list', {})
      if (!isPlainObject(result) || !Array.isArray(result.tools)) throw new BridgeFailure('MCP_RESPONSE_INVALID')
      offlineCatalogAdvertised = false
      return { tools: result.tools }
    } catch (error) {
      if (error.code === 'DESKTOP_NOT_RUNNING') {
        offlineCatalogAdvertised = true
        return { tools: toolDefinitions() }
      }
      const code = safeCode(error.code)
      throw new McpError(ErrorCode.InvalidRequest, `${code}: ${messageForCode(code)}`)
    }
  }

  async function callTool(request, extra = {}) {
    const params = request?.params
    const args = isPlainObject(params?.arguments) ? params.arguments : {}
    const name = typeof params?.name === 'string' ? params.name : ''
    const signal = extra?.signal
    let prepared = null
    let generationSession = null
    try {
      // Load the connection's current sourceRefs before resolving any secret.
      // This also makes a direct first call work when no tools/list preceded it.
      await bootstrap()
      if (signal?.aborted) throw new BridgeFailure('REQUEST_CANCELLED')
      if (name !== 'configure_provider' && args.credentialInput !== undefined) {
        throw new BridgeFailure('CREDENTIAL_SOURCE_INVALID')
      }
      if (name === 'prepare_generation' && !clientSupportsFormElicitation()) {
        throw new BridgeFailure('CLIENT_CONFIRMATION_UNSUPPORTED')
      }
      prepared = name === 'configure_provider'
        ? prepareCredentialCall(args, { credentialSources, env, now, randomId })
        : { arguments: args, credentialValues: {}, secretValues: [], inlineCredentialObject: null }
      let result
      if (name === 'configure_provider' && Array.isArray(prepared.inlineCredentialFields)) {
        result = await callProviderWithCredentialPreflight(callMain, prepared, signal)
      } else if (name === 'prepare_generation') {
        generationSession = await bootstrap()
        result = await callMainOnSession('tools/call', { name, arguments: prepared.arguments }, generationSession, prepared, signal)
      } else {
        result = await callMain('tools/call', { name, arguments: prepared.arguments }, prepared, signal)
      }
      if (name === 'prepare_generation') {
        const status = result?.structuredContent?.status ?? result?.status
        if (status === 'awaiting_confirmation' && !Object.prototype.hasOwnProperty.call(result, 'generationConfirmation')) {
          throw new BridgeFailure('MCP_RESPONSE_INVALID')
        }
        if (Object.prototype.hasOwnProperty.call(result || {}, 'generationConfirmation')) {
          result = await confirmGeneration(result, signal, generationSession)
        }
      }
      if (!isPlainObject(result) || !Array.isArray(result.content)) throw new BridgeFailure('MCP_RESPONSE_INVALID')
      const sanitized = name === 'read_task_output'
        ? sanitizeTaskOutputResult(stripGenerationConfirmation(result), prepared.secretValues)
        : scrubValue(stripGenerationConfirmation(result), prepared.secretValues)
      return CallToolResultSchema.parse(sanitized)
    } catch (error) {
      if (signal?.aborted || error?.code === 'REQUEST_CANCELLED') {
        throw new McpError(REQUEST_CANCELLED_ERROR_CODE, 'The MCP request was cancelled.')
      }
      return safeToolError(error?.code)
    } finally {
      if (prepared) clearSensitiveCall(prepared)
      else clearInlineCredentialArguments(args)
      generationSession = null
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => listTools())
  // Register through the SDK Protocol layer to avoid Server's second call-schema
  // parse copy holding inline credentials while the desktop request is pending.
  const protocolPrototype = Object.getPrototypeOf(Object.getPrototypeOf(server))
  protocolPrototype.setRequestHandler.call(server, CallToolRequestSchema, callTool)

  async function closeDesktopSession() {
    const closing = session
    session = null
    credentialSources = []
    authFingerprint = null
    if (!closing || closing.expiresAt <= now()) return
    try {
      await post('/close', { connectionId: closing.connectionId }, {
        token: closing.accessToken, timeoutMs: CLOSE_TIMEOUT_MS,
      })
    } catch { /* closing stdin is best-effort; never log bearer or request details */ }
    closing.accessToken = ''
  }

  function removeProcessListeners() {
    stdin.off?.('end', onInputEnd)
    processLike.off?.('SIGINT', onSignal)
    processLike.off?.('SIGTERM', onSignal)
  }

  function onInputEnd() { void close() }
  function onSignal() { void close() }

  function close() {
    if (closePromise) return closePromise
    closed = true
    closePromise = (async () => {
      removeProcessListeners()
      await closeDesktopSession()
      try { await server.close() } catch { /* transport may already be closed */ }
      resolveStopped()
    })()
    return closePromise
  }

  const priorOnClose = transport.onclose
  transport.onclose = () => {
    try { priorOnClose?.() } catch { /* no diagnostics on stdio close */ }
    void close()
  }
  transport.onerror = () => writeStderr(stderr, '[vibepaper-mcp] MCP transport error.')
  server.onerror = () => writeStderr(stderr, '[vibepaper-mcp] MCP protocol error.')
  server.oninitialized = () => {
    // Authenticate only after protocol initialization. Tool requests also join this promise.
    void bootstrap().catch((error) => {
      if (error.code !== 'DESKTOP_NOT_RUNNING') {
        const code = safeCode(error.code)
        writeStderr(stderr, `[vibepaper-mcp] ${messageForCode(code)}`)
      }
    })
  }

  async function start() {
    if (stdin && typeof stdin.once === 'function') stdin.once('end', onInputEnd)
    processLike.on?.('SIGINT', onSignal)
    processLike.on?.('SIGTERM', onSignal)
    try {
      await server.connect(transport)
    } catch (error) {
      removeProcessListeners()
      throw new BridgeFailure('MCP_START_FAILED', { cause: error })
    }
    return stopped
  }

  return { start, close, server, getSession: () => session && { ...session }, getInstance: () => instance }
}

async function runMcpStdioBridge(options) {
  const bridge = createMcpStdioBridge(options)
  await bridge.start()
}

module.exports = {
  BridgeFailure,
  callProviderWithCredentialPreflight,
  createMcpStdioBridge,
  fixedBridgeAuthPath,
  fixedInstancePath,
  prepareCredentialCall,
  readBridgeAuthFile,
  readInstanceFile,
  runMcpStdioBridge,
  safeCode,
  sanitizeTaskOutputResult,
  stripGenerationConfirmation,
  scrubValue,
  validateBridgeAuth,
  validateCredentialSources,
  validateGenerationConfirmation,
}
