const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { Worker } = require('node:worker_threads')

async function smokePackagedMcpNodeEntry(root, directory) {
  const entryPath = path.join(root, 'src', 'mcp-node-entry.cjs')
  const entry = require(entryPath)
  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const home = path.join(directory, 'mcp-entry-home')
  if (process.platform === 'win32') childEnv.APPDATA = path.join(directory, 'mcp-entry-appdata')
  else if (process.platform === 'darwin') childEnv.HOME = home
  else childEnv.XDG_CONFIG_HOME = path.join(directory, 'mcp-entry-config')

  const appDataPath = entry.resolveAppDataPath(childEnv, process.platform, home)
  assert.equal(entry.resolveLauncherPath(), path.join(root, 'dist', 'mcp-launcher.cjs'))
  const instanceId = randomUUID()
  const connectionId = randomUUID()
  const accessToken = 'package-smoke-local-fixture-token-0123456789'
  const requests = []
  const fixtureErrors = []
  const tool = {
    name: 'fixture_echo',
    description: 'Returns a local fixture response.',
    inputSchema: {
      type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false,
    },
  }
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'INVALID_INPUT' } }))
        return
      }
      requests.push({ route: request.url, body, authorization: request.headers.authorization })
      let result
      if (request.url === '/bootstrap') {
        result = { instanceId, connectionId, accessToken, expiresAt: Date.now() + 60_000, credentialSources: [] }
      } else if (request.url === '/rpc' && body.method === 'tools/list') {
        result = { tools: [tool] }
      } else if (request.url === '/rpc' && body.method === 'tools/call') {
        if (body.params?.name !== 'fixture_echo' || body.params?.arguments?.message !== 'packaged node entry') {
          fixtureErrors.push('Unexpected local fixture tool call.')
        }
        result = { content: [{ type: 'text', text: 'local MCP fixture passed' }] }
      } else if (request.url === '/close') {
        if (body.connectionId !== connectionId) fixtureErrors.push('Close used an unexpected connection id.')
        result = {}
      } else {
        fixtureErrors.push(`Unexpected local fixture route: ${request.url}`)
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'INVALID_INPUT' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const instanceDirectory = path.join(appDataPath, 'VibePaper')
  await fs.mkdir(instanceDirectory, { recursive: true })
  const instanceFilePath = path.join(instanceDirectory, 'mcp-instance.json')
  await fs.writeFile(instanceFilePath, `${JSON.stringify({
    schemaVersion: 1, instanceId, host: '127.0.0.1', port: server.address().port,
    protocolVersion: 1, pid: process.pid,
  })}\n`, { flag: 'wx', mode: 0o600 })

  let child
  let stderr = ''
  let stdoutBuffer = ''
  let processError = null
  const waiters = new Map()
  let exitResolve
  const exited = new Promise((resolve) => { exitResolve = resolve })

  function rejectWaiters(error) {
    for (const pending of waiters.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    waiters.clear()
  }

  function waitForResponse(id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(`Timed out waiting for packaged MCP response ${id}. ${stderr}`))
      }, 10_000)
      waiters.set(id, { resolve, reject, timer })
      if (processError) rejectWaiters(processError)
    })
  }

  function sendRequest(id, method, params) {
    const responsePromise = waitForResponse(id)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return responsePromise
  }

  try {
    child = spawn(process.execPath, [entryPath, '--mcp-stdio', '--mcp-instance-file', instanceFilePath,
      '--mcp-client-id', 'package-smoke-client', '--mcp-grant-id', 'package-smoke-grant'], {
      env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      while (true) {
        const newline = stdoutBuffer.indexOf('\n')
        if (newline < 0) break
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) }
        catch (error) { rejectWaiters(new Error(`Packaged MCP wrote invalid JSON to stdout: ${error.message}`)); continue }
        const pending = waiters.get(message.id)
        if (!pending) continue
        waiters.delete(message.id)
        clearTimeout(pending.timer)
        pending.resolve(message)
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { processError = error; rejectWaiters(error) })
    child.on('exit', (code, signal) => {
      const result = { code, signal }
      if (code !== 0) {
        const error = new Error(`Packaged MCP Node entry exited (${code ?? signal}). ${stderr}`)
        processError = error
        rejectWaiters(error)
      }
      exitResolve(result)
    })

    const initialized = await sendRequest(1, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'package-smoke', version: '1.0.0' },
    })
    assert.equal(initialized.error, undefined)
    assert.equal(initialized.result?.serverInfo?.name, 'vibepaper-desktop-mcp')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    const listed = await sendRequest(2, 'tools/list', {})
    assert.deepEqual(listed.result?.tools?.map((entry) => entry.name), ['fixture_echo'])
    const called = await sendRequest(3, 'tools/call', {
      name: 'fixture_echo', arguments: { message: 'packaged node entry' },
    })
    assert.equal(called.result?.content?.[0]?.text, 'local MCP fixture passed')
    child.stdin.end()
    let exitTimer
    const exit = await Promise.race([exited, new Promise((_, reject) => {
      exitTimer = setTimeout(() => reject(new Error(`Packaged MCP did not exit cleanly. ${stderr}`)), 10_000)
    })]).finally(() => clearTimeout(exitTimer))
    assert.deepEqual(exit, { code: 0, signal: null })
    assert.deepEqual(fixtureErrors, [])
    assert.deepEqual(requests.map((item) => item.route), ['/bootstrap', '/rpc', '/rpc', '/close'])
    assert.equal(requests[1].body.method, 'tools/list')
    assert.equal(requests[2].body.method, 'tools/call')
    assert.ok(requests.slice(1).every((item) => item.authorization === `Bearer ${accessToken}`))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

async function main() {
  if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-package.cjs <packaged-app-directory>')
  const root = path.resolve(process.argv[2])
  for (const file of ['package.json', 'src/main.cjs', 'src/preload.cjs', 'src/mcp-node-entry.cjs', 'src/local-core.cjs',
    'src/generation-worker.cjs', 'src/ui-language.cjs', 'src/ui-english.cjs', 'dist/agent-worker.cjs', 'dist/pi-official-media.cjs',
    'dist/mcp-launcher.cjs', 'dist/mcp-stdio.cjs',
    'renderer/index.html', 'renderer/provider-documentation.json', 'assets/app-icon.png']) {
    await fs.access(path.join(root, file))
  }
  // Requiring the launcher also loads its sibling stdio bundle and embedded SDK;
  // this catches accidental runtime dependence on an unpackaged node_modules tree.
  const Module = require('node:module')
  const originalLoad = Module._load
  Module._load = function loadPackagedModule(request, parent, isMain) {
    if (request === '@modelcontextprotocol/sdk' || request.startsWith('@modelcontextprotocol/sdk/')) {
      throw new Error('Packaged MCP bridge must not resolve the SDK from node_modules.')
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  let mcpLauncher
  let mcpStdio
  try {
    mcpLauncher = require(path.join(root, 'dist', 'mcp-launcher.cjs'))
    mcpStdio = require(path.join(root, 'dist', 'mcp-stdio.cjs'))
  } finally {
    Module._load = originalLoad
  }
  assert.equal(typeof mcpLauncher.runMcpLauncher, 'function')
  assert.equal(typeof mcpStdio.runMcpStdioBridge, 'function')
  const catalog = require(path.join(root, 'dist', 'pi-official-media.cjs')).getOfficialProviderCatalog()
  assert.ok(catalog.providers.length > 0)
  assert.ok(catalog.models.length > 0)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-paper-package-smoke-'))
  let worker
  let nextId = 0
  function start() {
    return new Worker(`
      const { parentPort } = require('node:worker_threads')
      process.parentPort = parentPort
      require(${JSON.stringify(path.join(root, 'src', 'local-core.cjs'))})
    `, { eval: true })
  }
  function request(method, payload) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const cleanup = () => { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError) }
      const onError = (error) => { cleanup(); reject(error) }
      const onMessage = (message) => {
        if (message.id !== id) return
        cleanup()
        if (message.ok) resolve(message.result)
        else reject(new Error(message.error))
      }
      const timer = setTimeout(() => onError(new Error(`Timed out: ${method}`)), 15_000)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.postMessage({ id, method, payload })
    })
  }
  try {
    await smokePackagedMcpNodeEntry(root, directory)
    worker = start()
    const opened = await request('project:create', { parentDirectory: directory, name: 'Packaged app smoke' })
    const scope = { projectId: opened.project.projectId, canvasId: opened.project.canvasId }
    const created = await request('canvas:create-node', {
      ...scope, expectedVersion: 0, type: 'text', params: { content: 'Saved from a packaged app' },
      x: 120, y: 120, idempotencyKey: 'package-smoke-create',
    })
    await request('core:close', {})
    await worker.terminate()
    worker = start()
    await request('project:open', { directory: opened.directory })
    const canvas = await request('canvas:load', scope)
    assert.equal(canvas.nodes.length, 1)
    assert.equal(canvas.nodes[0].id, created.node.id)
    assert.equal(canvas.nodes[0].data.params.content, 'Saved from a packaged app')
    assert.equal(canvas.version, created.version)
    await request('core:close', {})
    console.log(`Packaged app: renderer resources, standalone MCP Node entry with local fixture, ${catalog.providers.length} providers, ${catalog.models.length} models, and SQLite canvas persistence across restart passed.`)
  } finally {
    if (worker) await worker.terminate()
    if (!path.basename(directory).startsWith('pi-paper-package-smoke-') || path.dirname(directory) !== os.tmpdir()) {
      throw new Error('Invalid smoke test cleanup directory.')
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1 })
