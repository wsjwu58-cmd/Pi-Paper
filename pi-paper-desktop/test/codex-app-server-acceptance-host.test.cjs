'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const test = require('node:test')

const { createVibePaperOnlyOverride, startCodexAppServerTurn } = require('../scripts/codex-app-server-acceptance-host.cjs')

class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.exitCode = null
    this.signalCode = null
    this.outgoing = []
    this.waiters = []
    this.killed = []
    this.stdin.setEncoding('utf8')
    let buffer = ''
    this.stdin.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const message = JSON.parse(line)
        this.outgoing.push(message)
        for (const waiter of [...this.waiters]) {
          if (!waiter.predicate(message)) continue
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          clearTimeout(waiter.timer)
          waiter.resolve(message)
        }
      }
    })
  }

  next(predicate, timeoutMs = 1_000) {
    const existing = this.outgoing.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1)
          reject(new Error('Timed out waiting for app-server message'))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
  }

  respond(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  kill(signal = 'SIGTERM') {
    this.killed.push(signal)
    if (this.exitCode !== null || this.signalCode !== null) return true
    this.signalCode = signal
    queueMicrotask(() => {
      this.stdin.end()
      this.stdout.end()
      this.stderr.end()
      this.emit('close', null, signal)
    })
    return true
  }
}

const baseOptions = {
  executable: 'codex.exe',
  override: 'mcp_servers.vibepaper.command="node"',
  cwd: 'E:\\VibePaperProject',
  environment: { PATH: 'test-path' },
  prompt: '请创建一个用于验收的空白画布节点。',
  timeoutMs: 5_000,
}

async function startHarness(overrides = {}) {
  const {
    modelCatalog = { data: [{ model: 'client-default-fixture', isDefault: true, hidden: false }], nextCursor: null },
    inventoryResponse = {
      data: [
        { name: 'vibepaper', runtimeStatus: 'connected', authStatus: 'unknown', resourceTemplates: [], resources: [], tools: {} },
        { name: 'legacy-disabled', runtimeStatus: 'disabled', tools: {} },
      ],
      nextCursor: null,
    },
    ...hostOverrides
  } = overrides
  const child = new FakeChild()
  let spawnCall
  const started = startCodexAppServerTurn({
    ...baseOptions,
    ...hostOverrides,
    spawnImpl: (executable, args, options) => {
      spawnCall = { executable, args, options }
      return child
    },
  })

  const initialize = await child.next((message) => message.method === 'initialize')
  child.respond({ id: initialize.id, result: { userAgent: 'Codex test fixture' } })
  const initialized = await child.next((message) => message.method === 'initialized')
  assert.deepEqual(initialized.params, {})
  if (hostOverrides.useClientDefaultModel) {
    const modelRequest = await child.next((message) => message.method === 'model/list')
    child.respond({ id: modelRequest.id, result: modelCatalog })
  }
  const threadStart = await child.next((message) => message.method === 'thread/start')
  child.respond({ id: threadStart.id, result: { thread: { id: 'thread-test-1', ephemeral: true } } })
  const inventoryRequest = await child.next((message) => message.method === 'mcpServerStatus/list')
  child.respond({ id: inventoryRequest.id, result: inventoryResponse })
  let turnStart
  try {
    turnStart = await Promise.race([
      child.next((message) => message.method === 'turn/start'),
      started.then(() => { throw new Error('Turn start should be observable before startup resolves') }),
    ])
  } catch (error) {
    error.fakeChild = child
    throw error
  }
  child.respond({ id: turnStart.id, result: { turn: { id: 'turn-test-1', status: 'inProgress' } } })
  const host = await started
  return { child, host, spawnCall, threadStart, inventoryRequest, turnStart }
}

function formParams(overrides = {}) {
  return {
    serverName: 'vibepaper',
    threadId: 'thread-test-1',
    turnId: 'turn-test-1',
    mode: 'form',
    message: '将向 Agnes 发送这段提示词并可能产生费用，请确认目标与模型。',
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', title: '确认提交本次生成' } },
      required: ['confirm'],
    },
    ...overrides,
  }
}

function completeTurn(child) {
  child.respond({
    method: 'turn/completed',
    params: { threadId: 'thread-test-1', turn: { id: 'turn-test-1', status: 'completed' } },
  })
}

test('uses the same client catalog default only for an explicitly opted-in QA thread', async (t) => {
  const { child, host, threadStart } = await startHarness({ useClientDefaultModel: true })
  t.after(() => host.close())
  assert.equal(threadStart.params.model, 'client-default-fixture')
  completeTurn(child)
  assert.equal((await host.result).status, 'completed')
})

test('does not start a model turn for a missing, ambiguous, hidden or paginated client default', async () => {
  const catalogs = [
    { data: [], nextCursor: null },
    { data: [{ model: 'hidden', isDefault: true, hidden: true }], nextCursor: null },
    { data: [{ model: 'a', isDefault: true }, { model: 'b', isDefault: true }], nextCursor: null },
    { data: [{ model: 'a', isDefault: true }], nextCursor: 'more' },
  ]
  for (const catalog of catalogs) {
    const child = new FakeChild()
    const started = startCodexAppServerTurn({ ...baseOptions, useClientDefaultModel: true, spawnImpl: () => child })
    const rejected = assert.rejects(started, { code: 'CODEX_APP_SERVER_MODEL_UNAVAILABLE' })
    const initialize = await child.next((message) => message.method === 'initialize')
    child.respond({ id: initialize.id, result: {} })
    const request = await child.next((message) => message.method === 'model/list')
    child.respond({ id: request.id, result: catalog })
    await rejected
    assert.equal(child.outgoing.some((message) => message.method === 'thread/start' || message.method === 'turn/start'), false)
  }
})

test('starts an ephemeral read-only turn, adapts safe trace events, and closes on completion', async (t) => {
  const traces = []
  const { child, host, spawnCall, threadStart, inventoryRequest, turnStart } = await startHarness({ onTrace: (event) => traces.push(event) })
  t.after(() => host.close())

  assert.deepEqual(spawnCall.args, ['-c', baseOptions.override, '--disable', 'shell_tool', 'app-server', '--listen', 'stdio://'])
  assert.equal(spawnCall.executable, baseOptions.executable)
  assert.equal(spawnCall.options.cwd, baseOptions.cwd)
  assert.deepEqual(spawnCall.options.env, baseOptions.environment)
  assert.equal(spawnCall.options.shell, false)
  assert.deepEqual(threadStart.params, {
    cwd: baseOptions.cwd,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    ephemeral: true,
  })
  assert.deepEqual(inventoryRequest.params, { threadId: 'thread-test-1', detail: 'full', limit: 100 })
  assert.equal(turnStart.params.threadId, 'thread-test-1')
  assert.deepEqual(turnStart.params.input, [{ type: 'text', text: baseOptions.prompt, text_elements: [] }])

  child.respond({ method: 'thread/started', params: { thread: { id: 'thread-test-1' } } })
  child.respond({ method: 'turn/started', params: { threadId: 'thread-test-1', turn: { id: 'turn-test-1' } } })
  child.respond({ method: 'item/started', params: { item: { id: 'item-1', type: 'mcpToolCall', tool: 'prepare_generation' } } })
  child.respond({ method: 'item/completed', params: { item: { id: 'item-2', type: 'agentMessage', text: '完成。' } } })
  completeTurn(child)

  assert.deepEqual(await host.result, { status: 'completed' })
  assert.deepEqual(child.killed, ['SIGTERM'])
  assert.deepEqual(traces, [
    { type: 'thread.started' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'item-1', type: 'mcp_tool_call', tool: 'prepare_generation', tool_name: 'prepare_generation' } },
    { type: 'item.completed', item: { id: 'item-2', type: 'agent_message', text: '完成。' } },
    { type: 'turn.completed', status: 'completed' },
  ])
})

test('speaks JSONL to a local fake app-server process and checks runtime scope before turn/start', async (t) => {
  const inventory = {
    data: [
      { name: 'vibepaper', runtimeStatus: 'connected', tools: { get_context: {} } },
      { name: 'unrelated-server', runtimeStatus: 'disabled', tools: {} },
    ],
    nextCursor: null,
  }
  const script = [
    'const readline = require("node:readline")',
    'const inventory = ' + JSON.stringify(inventory),
    'const threadId = "fake-thread"',
    'const turnId = "fake-turn"',
    'const output = (message) => process.stdout.write(JSON.stringify(message) + String.fromCharCode(10))',
    'readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {',
    '  const message = JSON.parse(line)',
    '  if (message.method === "initialize") output({ id: message.id, result: { userAgent: "local fake" } })',
    '  else if (message.method === "thread/start") output({ id: message.id, result: { thread: { id: threadId, ephemeral: true } } })',
    '  else if (message.method === "mcpServerStatus/list") output({ id: message.id, result: inventory })',
    '  else if (message.method === "turn/start") {',
    '    output({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } })',
    '    output({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } })',
    '  }',
    '})',
  ].join('\n')
  let launched
  const environment = {}
  for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name]
  }
  const host = await startCodexAppServerTurn({
    ...baseOptions,
    environment,
    spawnImpl: (executable, args, options) => {
      launched = { executable, args }
      return spawn(process.execPath, ['-e', script], options)
    },
  })
  t.after(() => host.close())

  assert.equal(launched.executable, baseOptions.executable)
  assert.deepEqual(launched.args, ['-c', baseOptions.override, '--disable', 'shell_tool', 'app-server', '--listen', 'stdio://'])
  assert.deepEqual(await host.result, { status: 'completed' })
})

test('turn completion remains authoritative when close races its cleanup', async (t) => {
  const { child, host } = await startHarness()
  t.after(() => host.close())

  completeTurn(child)
  await host.close()
  assert.deepEqual(await host.result, { status: 'completed' })
})

test('fails closed on active or ambiguous MCP entries, pagination, or a missing VibePaper server', async (t) => {
  const invalidInventories = [
    { data: [
      { name: 'vibepaper', runtimeStatus: 'connected' },
      { name: 'unrelated-server', runtimeStatus: 'connected', tools: { dangerous: {} } },
    ], nextCursor: null },
    { data: [{ name: 'vibepaper', runtimeStatus: 'connected' }], nextCursor: 'next-page' },
    { data: [{ name: 'vibepaper', runtimeStatus: 'connected' }, { name: 'unrelated-server', runtimeStatus: 'starting', tools: {} }], nextCursor: null },
    { data: [{ name: 'vibepaper', runtimeStatus: 'connected' }, { name: 'unrelated-server', runtimeStatus: 'disabled', tools: { hidden: {} } }], nextCursor: null },
    { data: [{ name: 'vibepaper', runtimeStatus: 'connected' }, { name: 'vibepaper', runtimeStatus: 'connected' }], nextCursor: null },
    { data: [{ name: 'vibepaper', runtimeStatus: 'disabled' }], nextCursor: null },
    { data: [{ name: 'unrelated-server', runtimeStatus: 'disabled', tools: {} }], nextCursor: null },
    { data: [], nextCursor: null },
  ]

  for (const inventoryResponse of invalidInventories) {
    await assert.rejects(startHarness({ inventoryResponse }), (error) => {
      assert.equal(error.code, 'CODEX_APP_SERVER_MCP_SCOPE_INVALID')
      assert.ok(error.fakeChild)
      assert.equal(error.fakeChild.outgoing.some((message) => message.method === 'turn/start'), false)
      return true
    })
  }
})

test('builds global and per-profile disable overrides from TOML names only', () => {
  const config = [
    'description = """A fake [mcp_servers.not-a-server] header in text.',
    'The parser must treat it as a string."""',
    'labels = [',
    '  "one", # an inline comment',
    '  "two",',
    ']',
    'mcp_servers."dotted.assignment".enabled = true',
    '[mcp_servers."global.service"]',
    'command = "private-command-value"',
    'args = ["a", "b"]',
    '[profiles."work.profile".mcp_servers."profile.service"]',
    'env = { API_KEY = "private-key-value" }',
    '[profiles.other]',
    'mcp_servers = { "inline.service" = { enabled = true } }',
  ].join('\n')
  const overrides = createVibePaperOnlyOverride('{command="node"}', config)
  assert.deepEqual(overrides, [
    'features.plugins=false',
    'features.apps=false',
    'mcp_servers={vibepaper={command="node"},"dotted.assignment"={enabled=false},"global.service"={enabled=false}}',
    'profiles={"work.profile"={mcp_servers={"profile.service"={enabled=false}}},other={mcp_servers={"inline.service"={enabled=false}}}}',
  ])
  assert.equal(overrides.join('\n').includes('private-command-value'), false)
  assert.equal(overrides.join('\n').includes('private-key-value'), false)
})

test('fails closed on duplicate, malformed, or unsupported Codex TOML configuration', () => {
  const invalidConfigs = [
    'mcp_servers.foo.enabled = true\nmcp_servers.foo.enabled = false',
    'mcp_servers = { "broken" = ',
    'profiles = []',
    '[mcp_servers."unclosed] ',
  ]
  for (const config of invalidConfigs) {
    assert.throws(() => createVibePaperOnlyOverride('{command="node"}', config), { code: 'CODEX_MCP_CONFIG_INVALID' })
  }
})

test('accepts an 8 MiB app-server line within the 16 MiB protocol bound', async (t) => {
  let observeTrace
  const traceObserved = new Promise((resolve) => { observeTrace = resolve })
  const { child, host } = await startHarness({ onTrace: observeTrace })
  t.after(() => host.close())

  child.respond({
    method: 'thread/started',
    params: { thread: { id: 'thread-test-1', padding: 'x'.repeat(8 * 1024 * 1024) } },
  })
  assert.deepEqual(await traceObserved, { type: 'thread.started' })
  completeTurn(child)
  assert.deepEqual(await host.result, { status: 'completed' })
})

test('rejects an app-server protocol line that exceeds 16 MiB', async (t) => {
  const { child, host } = await startHarness()
  t.after(() => host.close())

  child.respond({
    method: 'thread/started',
    params: { thread: { id: 'thread-test-1', padding: 'x'.repeat(16 * 1024 * 1024 + 1) } },
  })
  await assert.rejects(host.result, { code: 'CODEX_APP_SERVER_PROTOCOL_INVALID' })
})

test('forwards the generation form and returns only an explicit accepted decision', async (t) => {
  let forwarded
  let callbackStarted
  const callbackWait = new Promise((resolve) => { callbackStarted = resolve })
  const { child, host } = await startHarness({
    onElicitation: async (params) => {
      forwarded = params
      callbackStarted()
      return { action: 'accept', content: { confirm: true } }
    },
  })
  t.after(() => host.close())

  child.respond({ jsonrpc: '2.0', id: 'elicitation-1', method: 'mcpServer/elicitation/request', params: formParams() })
  await callbackWait
  const reply = await child.next((message) => message.id === 'elicitation-1')
  assert.equal(forwarded.message, formParams().message)
  assert.deepEqual(reply.result, { action: 'accept', content: { confirm: true } })
  completeTurn(child)
  assert.deepEqual(await host.result, { status: 'completed' })
})

test('returns an explicit user decline for a valid generation form', async (t) => {
  let callbackCount = 0
  const { child, host } = await startHarness({ onElicitation: async () => {
    callbackCount += 1
    return { action: 'decline', content: null }
  } })
  t.after(() => host.close())

  child.respond({ id: 61, method: 'mcpServer/elicitation/request', params: formParams() })
  const response = await child.next((message) => message.id === 61)
  assert.deepEqual(response.result, { action: 'decline', content: null })
  assert.equal(callbackCount, 1)
  completeTurn(child)
  assert.deepEqual(await host.result, { status: 'completed' })
})

test('declines malformed or foreign elicitation and denies shell, file, and permission requests', async (t) => {
  let callbackCount = 0
  const { child, host } = await startHarness({ onElicitation: async () => {
    callbackCount += 1
    return { action: 'accept', content: { confirm: true } }
  } })
  t.after(() => host.close())

  const cases = [
    ['bad-schema', formParams({ requestedSchema: { type: 'object', properties: { confirm: { type: 'string' } }, required: ['confirm'] } })],
    ['foreign-server', formParams({ serverName: 'another-server' })],
    ['non-form', formParams({ mode: 'url' })],
  ]
  for (const [id, params] of cases) {
    child.respond({ id, method: 'mcpServer/elicitation/request', params })
    const response = await child.next((message) => message.id === id)
    assert.deepEqual(response.result, { action: 'decline', content: null })
  }
  assert.equal(callbackCount, 0)

  const approvals = [
    ['command', 'item/commandExecution/requestApproval', { decision: 'cancel' }],
    ['file', 'item/fileChange/requestApproval', { decision: 'cancel' }],
    ['permissions', 'item/permissions/requestApproval', { permissions: {}, scope: 'turn' }],
  ]
  for (const [id, method, expected] of approvals) {
    child.respond({ id, method, params: {} })
    const response = await child.next((message) => message.id === id)
    assert.deepEqual(response.result, expected)
  }
  completeTurn(child)
  assert.deepEqual(await host.result, { status: 'completed' })
})

test('never treats malformed callback output as acceptance', async (t) => {
  const { child, host } = await startHarness({ onElicitation: async () => ({
    action: 'accept', content: { confirm: true, extra: 'discard me' },
  }) })
  t.after(() => host.close())

  child.respond({ id: 71, method: 'mcpServer/elicitation/request', params: formParams() })
  const response = await child.next((message) => message.id === 71)
  assert.deepEqual(response.result, { action: 'cancel', content: null })
  completeTurn(child)
  assert.deepEqual(await host.result, { status: 'completed' })
})

test('cancels a pending form and rejects the turn on timeout', async (t) => {
  let callbackStarted
  const callbackWait = new Promise((resolve) => { callbackStarted = resolve })
  let callbackSignal
  const { child, host } = await startHarness({
    timeoutMs: 300,
    onElicitation: (_params, { signal }) => {
      callbackSignal = signal
      callbackStarted()
      return new Promise(() => {})
    },
  })
  t.after(() => host.close())

  child.respond({ id: 88, method: 'mcpServer/elicitation/request', params: formParams() })
  await callbackWait
  await assert.rejects(host.result, { code: 'CODEX_APP_SERVER_TIMEOUT' })
  const response = await child.next((message) => message.id === 88)
  assert.deepEqual(response.result, { action: 'cancel', content: null })
  assert.equal(callbackSignal.aborted, true)
  if (child.signalCode === null) await new Promise((resolve) => child.once('close', resolve))
  assert.deepEqual(child.killed, ['SIGTERM'])
})

test('rejects a disconnected turn and aborts its pending confirmation callback', async (t) => {
  let callbackStarted
  const callbackWait = new Promise((resolve) => { callbackStarted = resolve })
  let callbackSignal
  const { child, host, spawnCall } = await startHarness({
    onElicitation: (_params, { signal }) => {
      callbackSignal = signal
      callbackStarted()
      return new Promise(() => {})
    },
  })
  t.after(() => host.close())

  child.respond({ id: 99, method: 'mcpServer/elicitation/request', params: formParams() })
  await callbackWait
  child.stdin.destroy()
  child.stdout.end()
  child.stderr.end()
  child.exitCode = 0
  child.emit('close', 0, null)

  await assert.rejects(host.result, { code: 'CODEX_APP_SERVER_DISCONNECTED' })
  assert.equal(callbackSignal.aborted, true)
  assert.deepEqual(spawnCall.args.slice(-3), ['app-server', '--listen', 'stdio://'])
  assert.deepEqual(child.killed, [])
})
