'use strict'
// QA-only transparent stdio observer. Never answers requests or records payloads,
// tool arguments, results, environment variables, or credential material.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')
const specification = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const workspace = path.resolve(__dirname, '../..')
const root = path.resolve(__dirname, '../../.test-temp')
const output = path.resolve(specification.evidencePath)
function isWithinOrSame(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
let realRoot
let realWorkspace
let realOutputParent
try {
  realWorkspace = fs.realpathSync(workspace)
  realRoot = fs.realpathSync(root)
  realOutputParent = fs.realpathSync(path.dirname(output))
} catch {
  throw new Error('QA_OUTPUT_PATH_INVALID')
}
const relativeOutput = path.relative(root, output)
if (!relativeOutput || path.relative(realWorkspace, realRoot).toLowerCase() !== '.test-temp'
  || !isWithinOrSame(root, path.dirname(output)) || !isWithinOrSame(realRoot, realOutputParent)) {
  throw new Error('QA_OUTPUT_OUTSIDE_TEMP')
}
let outputStat
try { outputStat = fs.lstatSync(output) } catch (error) {
  if (error.code !== 'ENOENT') throw new Error('QA_OUTPUT_PATH_INVALID')
}
if (outputStat) {
  let realOutput
  try { realOutput = fs.realpathSync(output) } catch { throw new Error('QA_OUTPUT_PATH_INVALID') }
  if (!isWithinOrSame(realRoot, realOutput)) throw new Error('QA_OUTPUT_OUTSIDE_TEMP')
}
const events = []
const pending = new Map()
let telemetryWriteFailed = false
let shutdownRequestedSignal = null
function save() {
  try {
    fs.writeFileSync(output, JSON.stringify({ schemaVersion: 1, testType: 'transparent-stdio-observation',
      payloadsRecorded: false, observerAnswersRequests: false, events }, null, 2))
  } catch {
    telemetryWriteFailed = true
  }
}
function safeClientLabel(value) {
  if (typeof value !== 'string') return 'other'
  const normalized = value.trim().toLowerCase()
  const labels = new Map([
    ['codex', 'Codex'], ['codex-cli', 'Codex'], ['codex_cli_rs', 'Codex'],
    ['claude code', 'Claude Code'], ['claude-code', 'Claude Code'],
    ['cursor', 'Cursor'], ['workbuddy', 'WorkBuddy'], ['trae', 'TRAE'],
  ])
  return labels.get(normalized) || 'other'
}
function observe(line, direction) {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (events.length >= 300) return
  const event = { at: new Date().toISOString(), direction }
  if (message.method === 'initialize' && direction === 'client-to-server') {
    event.method = 'initialize'
    const info = message.params?.clientInfo || {}
    const elicitation = message.params?.capabilities?.elicitation
    const isElicitationObject = elicitation !== null && typeof elicitation === 'object' && !Array.isArray(elicitation)
    const legacyEmptyElicitation = isElicitationObject && Object.keys(elicitation).length === 0
    // Handshake identity strings are peer-controlled too; retain only a fixed
    // label and whether a version was present, never the arbitrary value.
    event.clientName = safeClientLabel(info.name)
    event.clientVersionPresent = typeof info.version === 'string' && info.version.length > 0
    event.protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(message.params?.protocolVersion) ? message.params.protocolVersion : null
    event.formElicitation = Boolean(elicitation?.form)
    event.legacyEmptyElicitation = legacyEmptyElicitation
    event.effectiveFormElicitation = event.formElicitation || legacyEmptyElicitation
    event.urlElicitation = Boolean(elicitation?.url)
    event.legacyElicitation = Boolean(elicitation)
  } else if (['notifications/initialized', 'tools/list', 'tools/call', 'elicitation/create', 'notifications/tools/list_changed'].includes(message.method)) {
    event.method = message.method
    if (message.method === 'tools/call') {
      const name = message.params?.name
      if (/^[a-z_]{1,80}$/.test(name || '')) event.toolName = name
    }
  } else if (message.id !== undefined && pending.has(`${direction}:${message.id}`)) {
    event.responseTo = pending.get(`${direction}:${message.id}`)
    pending.delete(`${direction}:${message.id}`)
    event.isError = Boolean(message.error || message.result?.isError)
    if (event.responseTo === 'tools/list') event.toolCount = message.result?.tools?.length ?? null
    if (event.responseTo === 'elicitation/create') event.action = ['accept', 'decline', 'cancel'].includes(message.result?.action) ? message.result.action : 'other'
  } else return
  if (message.method && message.id !== undefined) pending.set(`${direction === 'client-to-server' ? 'server-to-client' : 'client-to-server'}:${message.id}`, message.method)
  events.push(event)
}
function mirror(input, outputStream, direction) {
  const decoder = new StringDecoder('utf8')
  let lineBuffer = ''
  let lineBytes = 0
  let droppingOversizedLine = false
  const maxObservedLineBytes = 2 * 1024 * 1024
  const consume = text => {
    let start = 0
    let end
    while ((end = text.indexOf('\n', start)) >= 0) {
      const segment = text.slice(start, end)
      const segmentBytes = Buffer.byteLength(segment, 'utf8')
      if (!droppingOversizedLine && lineBytes + segmentBytes <= maxObservedLineBytes) {
        lineBuffer += segment
        observe(lineBuffer, direction)
      }
      lineBuffer = ''
      lineBytes = 0
      droppingOversizedLine = false
      start = end + 1
    }
    if (start < text.length && !droppingOversizedLine) {
      const remainder = text.slice(start)
      lineBytes += Buffer.byteLength(remainder, 'utf8')
      if (lineBytes <= maxObservedLineBytes) lineBuffer += remainder
      else {
        lineBuffer = ''
        droppingOversizedLine = true
      }
    }
  }
  input.on('data', chunk => {
    if (!outputStream.write(chunk)) input.pause()
    consume(decoder.write(chunk))
  })
  outputStream.on('drain', () => input.resume())
  input.on('end', () => consume(decoder.end()))
}
const child = spawn(specification.command, specification.args, { env: { ...process.env, ...specification.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
mirror(process.stdin, child.stdin, 'client-to-server')
mirror(child.stdout, process.stdout, 'server-to-client')
// Production bridge diagnostics have fixed messages, but omit them altogether.
child.stderr.resume()
child.stdin.on('error', () => {})
process.stdout.on('error', () => child.kill())
process.stdin.on('end', () => child.stdin.end())
process.on('SIGTERM', () => { shutdownRequestedSignal = 'SIGTERM'; child.kill('SIGTERM') })
process.on('SIGINT', () => { shutdownRequestedSignal = 'SIGINT'; child.kill('SIGINT') })
child.on('error', () => { events.push({ event: 'spawn_failed' }); save(); process.exitCode = 1 })
child.on('close', (code, signal) => {
  let observerExitCode = Number.isInteger(code) ? code : shutdownRequestedSignal ? 0 : 1
  if (telemetryWriteFailed) observerExitCode = 1
  events.push({ event: 'bridge_closed', childExitCode: code, childExitSignal: signal, observerExitCode })
  save()
  if (telemetryWriteFailed) observerExitCode = 1
  process.stdin.destroy()
  process.exitCode = observerExitCode
})
