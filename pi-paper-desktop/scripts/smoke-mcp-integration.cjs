// Root reviewer integration smoke. Run with Electron after bundling the renderer
// and MCP runtime. All state belongs to this newly created test profile.
const { app, BrowserWindow, dialog, protocol } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { createLocalProjectStore } = require('../src/project-store.cjs')

const root = path.resolve(__dirname, '../..')
const fixtureRoot = path.join(root, '.test-temp', `mcp-integration-${Date.now()}`)
const profile = path.join(fixtureRoot, 'VibePaper')
const evidence = path.join(root, 'docs/verification/2026-10-10-desktop-mcp')
const originalSetPath = app.setPath.bind(app)
const originalGetPath = app.getPath.bind(app)
app.setPath = (name, value) => originalSetPath(name, name === 'userData' ? profile : value)
app.getPath = (name) => name === 'appData' ? fixtureRoot : originalGetPath(name)
BrowserWindow.prototype.show = function () {}
protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
protocol.registerSchemesAsPrivileged = () => {}
let window
let opened
const pairingDialogs = []
const localModelRequests = []
let localModelServer
let client
let transport
let phase = 'prepare-isolated-profile'
let bridgeDiagnostics = ''
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
dialog.showErrorBox = () => app.exit(1)
dialog.showMessageBox = async (_owner, suppliedOptions) => {
  const options = suppliedOptions || _owner
  const approve = (options.buttons || []).findIndex((label) => /批准|允许|approve|allow/iu.test(label))
  if (approve < 0) throw new Error('Unexpected native dialog in the isolated MCP fixture')
  pairingDialogs.push({ title: options.title, button: approve })
  return { response: approve, checkboxChecked: false }
}
app.on('browser-window-created', (_event, created) => {
  window = created
  created.webContents.setBackgroundThrottling(false)
})

async function evaluate(source) { return window.webContents.executeJavaScript(source) }
async function waitFor(source, timeout = 25000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (window && !window.webContents.isLoading() && await evaluate(source).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('MCP integration fixture timed out')
}

async function prepareFixture() {
  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(evidence, { recursive: true })
  const projectDirectory = path.join(fixtureRoot, 'project')
  await fs.mkdir(projectDirectory, { recursive: true })
  const store = createLocalProjectStore()
  try {
    opened = await store.createProject(projectDirectory, 'MCP review fixture')
    await store.createNode({ projectId: opened.project.projectId, canvasId: opened.project.canvasId,
      expectedVersion: 0, type: 'text', params: { content: 'Existing local user content' },
      x: 180, y: 180, idempotencyKey: 'mcp-review-initial' })
  } finally { await store.close() }
  await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({
    schemaVersion: 1, projectDirectory: opened.directory,
  }))
}

async function startLocalModelFixture() {
  localModelServer = createServer(async (request, response) => {
    if (request.url === '/v1/models' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'mcp-review-text', object: 'model' }] }))
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
    localModelRequests.push({ method: request.method, path: request.url, model: input.model })
    const content = 'MCP local fixture result'
    if (input.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'mcp-review-text',
        choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'mcp-review-text',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
  })
  await new Promise((resolve, reject) => {
    localModelServer.once('error', reject)
    localModelServer.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${localModelServer.address().port}/v1`
}

function exportedServer(config) {
  const decoded = typeof config === 'string' ? JSON.parse(config) : config
  const servers = decoded.mcpServers || decoded
  const selected = Object.values(servers).find((entry) => entry && typeof entry.command === 'string')
  assert(selected && Array.isArray(selected.args), 'The desktop must export a usable standard stdio configuration')
  return selected
}

async function callTool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 })
  assert(!result.isError, `MCP tool ${name} failed with ${JSON.stringify(result.structuredContent || {})}`)
  assert(result.structuredContent && typeof result.structuredContent === 'object')
  return result.structuredContent
}

async function beginClient(config) {
  const server = exportedServer(config)
  assert.equal(server.args[0], path.join(root, 'pi-paper-desktop/src/mcp-node-entry.cjs'))
  assert.equal(server.env?.ELECTRON_RUN_AS_NODE, '1')
  client = new Client({ name: 'vibepaper-isolated-review', version: '1.0.0' })
  transport = new StdioClientTransport({ ...server, env: { ...server.env, APPDATA: fixtureRoot }, stderr: 'pipe' })
  transport.stderr?.on('data', (chunk) => { bridgeDiagnostics = (bridgeDiagnostics + String(chunk)).slice(-4000) })
  await client.connect(transport, { timeout: 60000 })
  const definitions = await client.listTools()
  return definitions
}

function taskIdsFrom(value) {
  if (Array.isArray(value)) return value.flatMap(taskIdsFrom)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => key === 'taskId' && typeof child === 'string' ? [child] : taskIdsFrom(child))
}

async function waitForTool(name, args, predicate, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await callTool(name, args)
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`MCP ${name} did not reach the required state`)
}

async function screenshot(name) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await fs.writeFile(path.join(evidence, name), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
}

async function main() {
  await prepareFixture()
  phase = 'open-original-canvas'
  require('../src/main.cjs')
  await app.whenReady()
  assert.equal(app.getPath('userData'), profile, 'The integration smoke must use its isolated profile')
  await waitFor("location.pathname === '/workspace' && document.querySelector('[role=button]')")
  await evaluate("document.querySelector('[role=button]').click()")
  await waitFor("location.pathname.startsWith('/canvas/') && document.querySelector('.react-flow__node')")
  await waitFor('Boolean(window.vibepaperDesktop?.getMcpState)')
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
  const endpoint = await startLocalModelFixture()
  await evaluate(`window.vibepaperDesktop.saveLocalTextModel(${JSON.stringify({ endpoint, modelId: 'mcp-review-text' })})`)
  const canvasPath = await evaluate('location.pathname')
  phase = 'configure-mcp-in-original-settings'
  await evaluate("history.pushState({}, '', '/settings/mcp'); dispatchEvent(new PopStateEvent('popstate'))")
  await waitFor("document.querySelector('[data-testid=mcp-settings-page]') && document.querySelector('[data-testid=mcp-enabled-toggle]:not(:disabled)')")
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === false)')
  await evaluate("document.querySelector('[data-testid=mcp-enabled-toggle]').click()")
  await waitFor("document.querySelector('[data-testid=mcp-enabled-toggle][aria-pressed=true]:not(:disabled)')")
  for (const label of ['准备生成', '读取任务', '读取模型配置']) {
    await evaluate(`Array.from(document.querySelectorAll('label')).find(label => label.innerText.trim().startsWith(${JSON.stringify(label)})).querySelector('input[type=checkbox]').click()`)
  }
  await waitFor("document.querySelector('[data-testid^=mcp-provider-]')")
  await evaluate("document.querySelectorAll('[data-testid^=mcp-provider-]').forEach(section => section.querySelector('input[type=checkbox]').click())")
  await evaluate("Array.from(document.querySelectorAll('label')).find(label => label.innerText.includes('我已了解')).querySelector('input[type=checkbox]').click()")
  await waitFor("document.querySelector('[data-testid=mcp-create-grant]:not(:disabled)')")
  await evaluate("document.querySelector('[data-testid=mcp-create-grant]').click()")
  await waitFor("document.querySelectorAll('[data-testid=mcp-client-config] textarea').length === 2")
  const config = await evaluate("document.querySelectorAll('[data-testid=mcp-client-config] textarea')[1].value")
  const grant = (await evaluate('window.vibepaperDesktop.getMcpState()')).clients[0]
  assert(grant && grant.permissions.includes('generation.propose'))
  await screenshot('original-mcp-settings-and-client-config.png')
  await evaluate(`history.pushState({}, '', ${JSON.stringify(canvasPath)}); dispatchEvent(new PopStateEvent('popstate'))`)
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
  phase = 'connect-official-sdk-stdio'
  const definitions = await beginClient(config)
  assert(definitions.tools.some((tool) => tool.name === 'create_nodes'))
  for (const name of ['get_context', 'get_operation', 'read_task_output', 'list_provider_configuration']) {
    assert(definitions.tools.some(tool => tool.name === name), `Tool discovery must include ${name}`)
  }
  assert(!definitions.tools.some((tool) => ['submit_generation', 'submit_generation_batch', 'delete_nodes'].includes(tool.name)))
  const providerDirectory = await callTool('list_provider_configuration', { providerId: 'openai' })
  assert.deepEqual(providerDirectory.credentialSources, [], 'Read-only grants must not expose write sources')
  assert.deepEqual(providerDirectory.allowedCredentialFields, [])
  assert.deepEqual(providerDirectory.credentialInputModes, [])
  const context = await callTool('get_context')
  const before = await callTool('get_canvas_summary')
  const version = before.canvas?.version ?? context.version ?? context.canvasVersion ?? context.activeCanvas?.version
  assert(Number.isSafeInteger(version))
  const creation = { operationId: 'review-three-pairs', expectedVersion: version,
    nodes: Array.from({ length: 6 }, (_, index) => ({ type: 'image', params: { prompt: `Fixture image ${index + 1}` } })) }
  phase = 'write-and-replay-nodes'
  const created = await callTool('create_nodes', creation)
  assert.equal(created.createdNodes?.length, 6)
  const replay = await callTool('create_nodes', creation)
  assert.deepEqual(replay, created)
  const ids = created.createdNodes.map((node) => node.id)
  for (let index = 0; index < 3; index += 1) {
    const summary = await callTool('get_canvas_summary')
    await callTool('connect_nodes', { operationId: `review-pair-${index}`, expectedVersion: summary.canvas.version,
      sourceNodeId: ids[index], targetNodeId: ids[index + 3] })
  }
  const after = await callTool('get_canvas_summary')
  assert.equal(after.nodes.length, 7)
  assert.equal(after.edges.length, 3)
  for (let index = 0; index < 3; index += 1) {
    assert(after.edges.some((edge) => (edge.sourceNodeId || edge.source) === ids[index]
      && (edge.targetNodeId || edge.target) === ids[index + 3]))
  }
  await waitFor("document.querySelectorAll('.react-flow__node').length >= 7 && !document.querySelector('[data-testid=mcp-canvas-write-barrier]')")
  const modelDirectory = await callTool('list_models')
  phase = 'prepare-local-generation'
  const localModel = modelDirectory.models.find((model) => model.providerId === 'local-openai-compatible' && model.name === 'mcp-review-text')
  assert(localModel && localModel.enabled, 'The MCP directory must include the actual configured local model')
  const textNode = after.nodes.find((node) => node.type === 'text')
  assert(textNode)
  const preparation = { operationId: 'review-local-generation', expectedVersion: after.canvas.version,
    generations: [{ nodeId: textNode.id, modelType: localModel.bindingId, modelParams: { prompt: 'Return the local fixture response' }, overwrite: false }] }
  const proposal = await callTool('prepare_generation', preparation)
  assert.equal(proposal.status, 'awaiting_confirmation')
  assert.equal(localModelRequests.length, 0, 'Preparing a proposal must not send any model request')
  await waitFor("document.querySelector('[data-testid=mcp-generation-confirmation] button:not(:disabled)')")
  await screenshot('generation-before-confirmation.png')
  phase = 'desktop-confirm-local-generation'
  await evaluate("document.querySelectorAll('[data-testid=mcp-generation-confirmation] button')[1].click()")
  const submitted = await waitForTool('get_operation', { operationId: preparation.operationId }, (record) => taskIdsFrom(record).length > 0)
  const taskIds = [...new Set(taskIdsFrom(submitted))]
  assert.equal(taskIds.length, 1)
  const completed = await waitForTool('check_task_status', { taskId: taskIds[0] }, (record) => record.status === 'succeeded' || record.task?.status === 'succeeded')
  assert.equal(localModelRequests.length, 1)
  const output = await callTool('read_task_output', { taskId: taskIds[0] })
  assert(JSON.stringify(output).includes('MCP local fixture result'))
  await waitFor("document.querySelector('[data-testid=mcp-canvas-page]').innerText.includes('MCP local fixture result')")
  await screenshot('generation-result-on-original-canvas.png')
  await callTool('prepare_generation', preparation)
  assert.equal(localModelRequests.length, 1, 'A completed proposal replay must not submit a second request')
  phase = 'revoke-live-client'
  await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grant.clientId)})`)
  let revoked = false
  try {
    const denied = await client.callTool({ name: 'get_context', arguments: {} })
    revoked = denied.isError === true
  } catch { revoked = true }
  assert(revoked, 'Revoking the grant must invalidate the live bridge')
  await client.close()
  await fs.writeFile(path.join(evidence, 'integration.json'), JSON.stringify({
    success: true, isolatedProfile: true, fixtureProfile: profile, officialSdk: '1.32.1',
    protocol: 'stdio', nodeCount: after.nodes.length, oneToOneEdges: after.edges.length,
    localModelRequests: localModelRequests.length, taskStatus: completed.status || completed.task?.status,
    realCloudProviderRequests: 0, realCodexClaudeSessions: false, packagedApplication: false,
    exportedConfigurationUsed: true,
  }, null, 2))
  localModelServer.close()
  console.log('Isolated MCP stdio, original canvas and desktop-confirmed local generation passed.')
  app.quit()
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : 'MCP integration smoke failed')
  await fs.mkdir(evidence, { recursive: true }).catch(() => {})
  await fs.writeFile(path.join(evidence, 'integration-failure.json'), JSON.stringify({
    success: false, error: error instanceof Error ? error.message : 'MCP integration smoke failed',
    fixtureProfile: profile, pairingDialogCount: pairingDialogs.length, phase, bridgeDiagnostics,
    ui: window && !window.isDestroyed() ? await evaluate("window.vibepaperDesktop.getMcpState().then(state => ({pathname: location.pathname, state, text: document.body.innerText.slice(0, 6000), testIds: Array.from(document.querySelectorAll('[data-testid]')).map(el => ({id:el.getAttribute('data-testid'),disabled:el.disabled,pressed:el.getAttribute('aria-pressed')}))}))").catch(() => null) : null,
  }, null, 2)).catch(() => {})
  await client?.close().catch(() => {})
  localModelServer?.close()
  app.exit(1)
})
