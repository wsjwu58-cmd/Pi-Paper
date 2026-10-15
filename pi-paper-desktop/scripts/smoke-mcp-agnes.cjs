// Real account acceptance. The credential arrives only in an inherited,
// explicitly authorized environment variable supplied by a stdin-only parent.
// Never put its value in this script, arguments, exported config or evidence.
const { app, BrowserWindow, dialog, protocol, safeStorage } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { createLocalProjectStore } = require('../src/project-store.cjs')

const root = path.resolve(__dirname, '../..')
const resumePath = process.env.VIBEPAPER_ACCEPTANCE_RESUME_REPORT
delete process.env.VIBEPAPER_ACCEPTANCE_RESUME_REPORT
const previous = resumePath ? JSON.parse(require('node:fs').readFileSync(resumePath, 'utf8')) : null
if (previous && (!previous.isolatedProfile.startsWith(path.join(root, '.test-temp') + path.sep)
  || previous.provider !== 'agnes' || previous.results?.at(-1)?.status !== 'failed')) throw new Error('INVALID_RESUME_REPORT')
const runRoot = previous ? path.dirname(previous.isolatedProfile) : path.join(root, '.test-temp', `mcp-agnes-${Date.now()}`)
const profile = path.join(runRoot, 'VibePaper')
const evidence = path.join(root, 'docs/verification/2026-10-11-mcp-acceptance')
const envName = 'VIBEPAPER_ACCEPTANCE_AGNES_KEY'
let secret = process.env[envName]
delete process.env[envName]
const cleanupOnly = process.env.VIBEPAPER_ACCEPTANCE_CLEANUP_ONLY === '1'
delete process.env.VIBEPAPER_ACCEPTANCE_CLEANUP_ONLY
const originalGetPath = app.getPath.bind(app)
const originalSetPath = app.setPath.bind(app)
app.getPath = (name) => name === 'appData' ? runRoot : originalGetPath(name)
app.setPath = (name, value) => originalSetPath(name, name === 'userData' ? profile : value)
BrowserWindow.prototype.show = function () {}
protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
protocol.registerSchemesAsPrivileged = () => {}
let window
let client
let transport
let opened
let phase = 'prepare'
let savedRevision
let existingNodes
let bridgeDiagnostics = ''
let submittedTaskId
const acceptanceAttempt = previous ? (previous.acceptanceAttempt || 0) + 1 : 0
const results = previous ? [...previous.results] : []
const calls = []
const startedAt = new Date().toISOString()
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
dialog.showErrorBox = () => app.exit(1)
dialog.showMessageBox = async (_owner, suppliedOptions) => {
  const options = suppliedOptions || _owner
  const response = (options.buttons || []).findIndex(label => /批准|允许|approve|allow/iu.test(label))
  if (response < 0) throw new Error('UNEXPECTED_NATIVE_DIALOG')
  return { response, checkboxChecked: false }
}
app.on('browser-window-created', (_event, created) => {
  window = created
  created.webContents.setBackgroundThrottling(false)
})
const evaluate = source => window.webContents.executeJavaScript(source)
function scrub(value) {
  let text = JSON.stringify(value)
  if (secret) text = text.split(secret).join('[redacted]')
  return JSON.parse(text.replace(/cpk-[A-Za-z0-9_-]+/gu, '[redacted]'))
}
async function waitFor(source, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (window && !window.webContents.isLoading() && await evaluate(source).catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('DESKTOP_ACCEPTANCE_TIMEOUT')
}
async function navigate(url) {
  await evaluate(`history.pushState({}, '', ${JSON.stringify(url)}); dispatchEvent(new PopStateEvent('popstate'))`)
}
async function capture(name) {
  await fs.writeFile(path.join(evidence, name), (await window.webContents.capturePage(undefined,
    { stayHidden: true, stayAwake: true })).toPNG())
}
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })
  if (response.isError) throw new Error(response.structuredContent?.errorCode || 'MCP_TOOL_FAILED')
  calls.push({ name, status: response.structuredContent?.status, at: new Date().toISOString() })
  return response.structuredContent
}
function taskIds(value) {
  if (Array.isArray(value)) return value.flatMap(taskIds)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => key === 'taskId' && typeof child === 'string' ? [child] : taskIds(child))
}
async function poll(name, args, predicate, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await call(name, args)
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  throw new Error('TASK_ACCEPTANCE_TIMEOUT')
}
async function recordCredentialCleanup() {
  await fs.writeFile(path.join(evidence, 'credential-hygiene.json'), JSON.stringify({
    success: true, checkedAt: new Date().toISOString(), plaintextSecretScan: 'pending-parent-after-app-exit',
    providerCredentialClearedViaOriginalIpc: true, acceptanceGrantsRevoked: true,
    testProfile: profile, userProfileAccessed: false,
  }, null, 2))
}
async function persist(success, errorCode, errorDetails) {
  await fs.mkdir(evidence, { recursive: true })
  const report = scrub({ success, startedAt, completedAt: new Date().toISOString(), phase, errorCode, errorDetails,
    platform: process.platform, electron: process.versions.electron, node: process.versions.node,
    isolatedProfile: profile, projectDirectory: opened?.directory, provider: 'agnes',
    realAccountTest: true, credentialsInput: 'authorized_env', secureStorage: safeStorage.isEncryptionAvailable(),
    savedRevision, results, calls, bridgeDiagnostics, resumedVideoOnly: !!previous, acceptanceAttempt, submittedTaskId })
  await fs.writeFile(path.join(evidence, 'agnes-real-account.json'), JSON.stringify(report, null, 2))
}
async function main() {
  assert(typeof secret === 'string' && secret.length > 16, 'CREDENTIAL_INPUT_REQUIRED')
  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(evidence, { recursive: true })
  const store = createLocalProjectStore()
  const projectDirectory = path.join(runRoot, 'project')
  await fs.mkdir(projectDirectory, { recursive: true })
  try {
    opened = previous ? await store.openProject(previous.projectDirectory)
      : await store.createProject(projectDirectory, 'Agnes real account acceptance')
    if (previous) {
      const failed = await store.getTask(opened.project.projectId, previous.results.at(-1).taskId)
      assert(failed.status === 'failed' && failed.errorMessage?.includes('video queue is full'), 'RETRY_REQUIRES_EXPLICIT_QUEUE_REJECTION')
      existingNodes = store.loadCanvas(opened.project.projectId, opened.project.canvasId).nodes
      assert.equal(existingNodes.filter(node => node.type === 'video').length, 1)
      if (!cleanupOnly) await fs.writeFile(path.join(evidence, 'agnes-first-attempt.json'), JSON.stringify(previous, null, 2), { flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error
      })
    }
  }
  finally { await store.close() }
  await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: opened.directory }))
  require('../src/main.cjs')
  await app.whenReady()
  assert(safeStorage.isEncryptionAvailable(), 'SECURE_STORAGE_UNAVAILABLE')
  await waitFor("location.pathname === '/workspace' && document.querySelector('[role=button]')")
  if (cleanupOnly) {
    assert(previous, 'CLEANUP_REQUIRES_EXISTING_ACCEPTANCE_REPORT')
    phase = 'secret-scan-and-cleanup'
    const publicState = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
    const provider = publicState.providers.find(item => item.id === 'agnes')
    await evaluate(`window.vibepaperDesktop.clearProviderConfiguration('agnes', ${provider.revision})`)
    const cleared = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
    assert.equal(cleared.providers.find(item => item.id === 'agnes').configured, false)
    const state = await evaluate('window.vibepaperDesktop.getMcpState()')
    for (const item of state.clients) await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(item.clientId)})`)
    await recordCredentialCleanup()
    secret = undefined
    console.log('Acceptance credential cleanup passed; plaintext scan awaits application exit.')
    app.quit()
    return
  }
  await evaluate("document.querySelector('[role=button]').click()")
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
  const canvasPath = await evaluate('location.pathname')
  if (!previous) {
    await navigate('/settings/mcp')
    await waitFor("document.querySelector('[data-testid=mcp-settings-page]')")
  }
  await evaluate('window.vibepaperDesktop.setMcpEnabled(true)')
  const grant = await evaluate(`window.vibepaperDesktop.createMcpClientGrant(${JSON.stringify({
    clientName: 'codex', displayName: 'Agnes account acceptance SDK',
    permissions: ['canvas.read', 'canvas.write', 'generation.propose', 'task.read', 'media.read', 'provider.read', 'provider.configure'],
    providerGrants: [{ providerId: 'agnes', credentialFields: ['apiKey'], credentialInputModes: ['authorized_env'],
      authorizedEnv: [{ fieldName: 'apiKey', envVariableName: envName }] }],
    mediaTypes: ['image', 'video'], disclosureVersion: 'desktop-mcp-provider-disclosure-v1', accepted: true,
  })})`)
  const server = JSON.parse(grant.config.claudeCode).mcpServers.vibepaper
  assert(!JSON.stringify(server).includes(secret), 'SECRET_IN_EXPORTED_CONFIG')
  if (!previous) await navigate(canvasPath)
  await waitFor(`location.pathname === ${JSON.stringify(canvasPath)} && document.querySelector('[data-testid=mcp-canvas-page] .react-flow')`)
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
  client = new Client({ name: 'agnes-real-account-acceptance', version: '1.0.0' })
  transport = new StdioClientTransport({ ...server,
    env: { ...server.env, APPDATA: runRoot, [envName]: secret }, stderr: 'pipe' })
  transport.stderr?.on('data', chunk => {
    bridgeDiagnostics = scrub(String(chunk)).slice(-1500)
  })
  await client.connect(transport, { timeout: 150000 })
  await client.listTools()
  phase = 'configure-agnes-authorized-source'
  const directory = await call('list_provider_configuration', { providerId: 'agnes' })
  const image = directory.models.find(model => model.displayName === 'Agnes Image 2.5 Flash')
  const video = directory.models.find(model => model.displayName === 'Agnes Video 2.5 Flash')
  assert(image && video, 'AGNES_MODELS_UNAVAILABLE')
  const source = directory.credentialSources.find(item => item.fieldName === 'apiKey')
  assert(source, 'AUTHORIZED_SOURCE_UNAVAILABLE')
  const configuration = { providerId: 'agnes', operationId: previous ? `acceptance-agnes-configuration-${acceptanceAttempt}-${Date.now()}` : 'acceptance-agnes-configuration',
    expectedRevision: directory.provider.revision,
    publicConfig: { enabledModelIds: [image.id, video.id], defaultModelIds: { image: image.id, video: video.id },
      modelDefaults: { [image.id]: { size: '1K', ratio: '1:1' },
        [video.id]: { resolution: '720P', ratio: '16:9', duration: 4 } }, timeoutSeconds: 600 },
    credentialInput: { source: 'authorized_env', sourceRefs: { apiKey: source.sourceRef } } }
  if (!previous || !directory.provider.configured) {
    let saved = await call('configure_provider', configuration)
    if (saved.status === 'awaiting_disclosure') {
      await navigate('/settings/mcp')
      await waitFor("document.querySelector('[data-testid^=mcp-pending-] button:not(:disabled)')")
      await capture('agnes-provider-disclosure.png')
      await evaluate("document.querySelectorAll('[data-testid^=mcp-pending-] button')[1].click()")
      await waitFor('window.vibepaperDesktop.getMcpPendingActions().then(result => !result.actions.some(action => action.status === "awaiting_disclosure"))')
      saved = await call('configure_provider', configuration)
      await navigate(canvasPath)
    }
    assert.equal(saved.status, 'saved')
    savedRevision = saved.revision
  } else savedRevision = directory.provider.revision
  const detection = await call('test_provider_connection', { providerId: 'agnes', expectedRevision: savedRevision })
  assert.equal(detection.status, 'unsupported')
  if (!previous) {
  await navigate('/settings/providers?provider=agnes')
  await waitFor("document.querySelector('.provider-config-main') && !document.querySelector('.provider-config-main')?.textContent?.includes('加载中')")
  await new Promise(resolve => setTimeout(resolve, 1000))
  await capture('agnes-configured-models.png')
  await navigate(canvasPath)
  }
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
  await waitFor(`location.pathname === ${JSON.stringify(canvasPath)} && document.querySelector('[data-testid=mcp-canvas-page] .react-flow')`)
  await new Promise(resolve => setTimeout(resolve, 2000))
  const summary = await call('get_canvas_summary')
  const created = previous ? { createdNodes: existingNodes } : await call('create_nodes', { operationId: 'acceptance-agnes-targets', expectedVersion: summary.canvas.version,
    nodes: [{ type: 'image', params: { prompt: 'A small blue ceramic cube on a plain white studio background, soft natural shadow, no text.' } },
      { type: 'video', params: { prompt: 'A blue ceramic cube rotating slowly on a plain white studio background, static camera, no text.' } }] })
  assert.equal(created.createdNodes.length, 2)
  const models = (await call('list_models')).models
  for (const [index, modality] of ['image', 'video'].entries()) {
    if (previous && modality === 'image') continue
    phase = `generate-real-${modality}`
    console.log(`Agnes acceptance: preparing ${modality} through desktop confirmation.`)
    const selected = models.find(model => model.providerId === 'agnes' && model.displayName === (modality === 'image' ? 'Agnes Image 2.5 Flash' : 'Agnes Video 2.5 Flash'))
    assert(selected?.enabled, 'AGNES_BINDING_NOT_ENABLED')
    const before = await call('get_canvas_summary')
    const request = { operationId: `acceptance-agnes-${modality}${previous ? `-queue-retry-${acceptanceAttempt}-${Date.now()}` : ''}`, expectedVersion: before.canvas.version,
      generations: [{ nodeId: created.createdNodes[index].id, modelType: selected.bindingId,
        modelParams: modality === 'image' ? { prompt: created.createdNodes[index].params?.prompt || 'A blue ceramic cube on white background, no text.', size: '1K', ratio: '1:1', count: 1 }
          : { prompt: 'A blue ceramic cube rotating slowly on a white background, static camera, no text.', resolution: '720P', duration: 4, ratio: '16:9' }, overwrite: false }] }
    const proposal = await call('prepare_generation', request)
    assert.equal(proposal.status, 'awaiting_confirmation')
    await waitFor("document.querySelector('[data-testid=mcp-generation-confirmation] button:not(:disabled)')")
    await capture(`agnes-${modality}-before-confirmation.png`)
    await evaluate("document.querySelectorAll('[data-testid=mcp-generation-confirmation] button')[1].click()")
    const submitted = await poll('get_operation', { operationId: request.operationId }, record => taskIds(record).length > 0, 60000)
    const ids = [...new Set(taskIds(submitted))]
    assert.equal(ids.length, 1)
    submittedTaskId = ids[0]
    await persist(false)
    const completed = await poll('check_task_status', { taskId: ids[0] }, record => ['succeeded', 'failed', 'cancelled'].includes(record.status || record.task?.status), 16 * 60 * 1000)
    const status = completed.status || completed.task?.status
    results.push({ modality, taskId: ids[0], model: selected.name, status, errorCode: completed.errorCode || completed.task?.errorCode })
    await persist(false)
    assert.equal(status, 'succeeded', 'OFFICIAL_GENERATION_FAILED')
    await waitFor(`document.querySelector('[data-id="${created.createdNodes[index].id}"] img[src^="vibe://"], [data-id="${created.createdNodes[index].id}"] video[src^="vibe://"]')`)
    await capture(`agnes-${modality}-result-on-original-canvas.png`)
    // Obtain the already persisted result through the original renderer's media URL.
    const media = await evaluate(`(async () => {
      const node = document.querySelector('[data-id="${created.createdNodes[index].id}"]');
      const element = node.querySelector(${JSON.stringify(modality === 'image' ? 'img[src^="vibe://"]' : 'video[src^="vibe://"]')});
      const url = element.currentSrc || element.src;
      const response = await fetch(url); if (!response.ok) throw new Error('RESULT_UNREADABLE');
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { mimeType: response.headers.get('content-type'), bytes: Array.from(bytes) };
    })()`)
    const bytes = Buffer.from(media.bytes)
    assert(bytes.length > 0, 'EMPTY_RESULT')
    const filename = `agnes-real-${modality}.${modality === 'image' ? media.mimeType?.includes('png') ? 'png' : 'jpg' : 'mp4'}`
    await fs.writeFile(path.join(evidence, filename), bytes)
    Object.assign(results.at(-1), { filename, mimeType: media.mimeType, sizeBytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), desktopConfirmed: true, originalNodeVisible: true })
    await call('prepare_generation', request)
    console.log(`Agnes acceptance: ${modality} succeeded and persisted.`)
  }
  phase = 'secret-scan-and-cleanup'
  await evaluate(`window.vibepaperDesktop.clearProviderConfiguration('agnes', ${savedRevision})`)
  await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grant.clientId)})`)
  await client.close()
  await recordCredentialCleanup()
  phase = 'completed'
  await persist(true)
  secret = undefined
  console.log('Real Agnes image and video generation passed; plaintext scan awaits application exit.')
  app.quit()
}

main().catch(async error => {
  const errorCode = typeof error?.message === 'string' && /^[A-Z_]{3,80}$/u.test(error.message) ? error.message : 'ACCEPTANCE_FAILED'
  console.error(`Agnes acceptance stopped at ${phase}: ${errorCode}`)
  if (cleanupOnly) {
    await fs.writeFile(path.join(evidence, 'credential-hygiene.json'), JSON.stringify({
      success: false, phase, errorCode, errorDetails: scrub(String(error?.message || 'Acceptance failed')).slice(0, 500),
    }, null, 2)).catch(() => {})
  } else await persist(false, errorCode, scrub(String(error?.message || 'Acceptance failed')).slice(0, 500)).catch(() => {})
  await client?.close().catch(() => {})
  secret = undefined
  app.exit(1)
})
