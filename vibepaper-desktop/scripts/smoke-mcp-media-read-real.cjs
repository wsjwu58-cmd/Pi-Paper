// Read-only acceptance of an already persisted real Agnes image through Electron Main,
// the original CanvasPage, and the official MCP SDK stdio client. This deliberately
// uses a fresh profile with no provider configuration or saved credentials.
const { app, BrowserWindow, dialog, protocol } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const root = path.resolve(__dirname, '../..')
const evidenceDirectory = path.join(root, 'docs/verification/2026-10-11-mcp-acceptance')
const acceptanceReportPath = path.join(evidenceDirectory, 'agnes-real-account.json')
const runRoot = path.join(root, '.test-temp', `mcp-media-read-${Date.now()}`)
const profile = path.join(runRoot, 'VibePaper')
const evidencePath = path.join(evidenceDirectory, 'mcp-real-image-read.json')
const screenshotPath = path.join(evidenceDirectory, 'mcp-real-image-read-original-canvas.png')
const screenshotCandidatePath = path.join(evidenceDirectory, 'mcp-real-image-read-original-canvas-candidate.png')
const failureEvidencePath = path.join(evidenceDirectory, 'mcp-real-image-read-last-failure.json')
const originalGetPath = app.getPath.bind(app)
const originalSetPath = app.setPath.bind(app)
app.getPath = (name) => name === 'appData' ? runRoot : originalGetPath(name)
app.setPath = (name, value) => originalSetPath(name, name === 'userData' ? profile : value)
protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }])
protocol.registerSchemesAsPrivileged = () => {}

let window
let client
let grant
let phase = 'prepare-read-only-profile'
let bridgeDiagnostics = ''
const startedAt = new Date().toISOString()

dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
dialog.showErrorBox = () => app.exit(1)
dialog.showMessageBox = async (_owner, suppliedOptions) => {
  const options = suppliedOptions || _owner
  const response = (options.buttons || []).findIndex((label) => /批准|允许|approve|allow/iu.test(label))
  if (response < 0) throw new Error('UNEXPECTED_NATIVE_DIALOG')
  return { response, checkboxChecked: false }
}
app.on('browser-window-created', (_event, created) => {
  window = created
  created.webContents.setBackgroundThrottling(false)
})

const evaluate = (source) => window.webContents.executeJavaScript(source)
async function waitFor(source, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (window && !window.webContents.isLoading() && await evaluate(source).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error('MEDIA_READ_ACCEPTANCE_TIMEOUT')
}

async function navigate(url) {
  await evaluate(`history.pushState({}, '', ${JSON.stringify(url)}); dispatchEvent(new PopStateEvent('popstate'))`)
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function imageVisibilityProbeSource(nodeSelector) {
  return `(() => {
    const page = document.querySelector('[data-testid="mcp-canvas-page"]');
    const flow = page?.querySelector('.react-flow');
    const node = page?.querySelector(${JSON.stringify(nodeSelector)});
    const image = node?.querySelector('img[src^="vibe://"]');
    if (!page || !flow || !node || !image) return { visible: false, reason: 'missing-image-node' };
    const nodeRect = node.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    const flowRect = flow.getBoundingClientRect();
    const intersects = (a, b) => Math.max(a.left, b.left) < Math.min(a.right, b.right)
      && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
    const x = imageRect.left + imageRect.width / 2;
    const y = imageRect.top + imageRect.height / 2;
    const top = document.elementFromPoint(x, y);
    const unobscured = Boolean(top) && (top === image || image.contains(top));
    const ready = image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    const nodeInViewport = intersects(nodeRect, flowRect);
    const imageInViewport = intersects(imageRect, flowRect);
    return {
      visible: ready && nodeInViewport && imageInViewport && unobscured,
      ready, nodeInViewport, imageInViewport, unobscured,
      naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      nodeRect: { left: nodeRect.left, top: nodeRect.top, right: nodeRect.right, bottom: nodeRect.bottom },
      imageRect: { left: imageRect.left, top: imageRect.top, right: imageRect.right, bottom: imageRect.bottom },
      flowRect: { left: flowRect.left, top: flowRect.top, right: flowRect.right, bottom: flowRect.bottom },
    };
  })()`
}

async function readAcceptanceTarget() {
  const report = JSON.parse(await fs.readFile(acceptanceReportPath, 'utf8'))
  const image = Array.isArray(report.results)
    ? report.results.find((result) => result?.modality === 'image' && result?.status === 'succeeded')
    : null
  assert(image && typeof image.taskId === 'string' && /^[a-f0-9-]{36}$/iu.test(image.taskId), 'REAL_IMAGE_TASK_NOT_FOUND')
  assert(typeof report.projectDirectory === 'string' && report.projectDirectory.length > 0, 'REAL_PROJECT_NOT_FOUND')
  assert(typeof image.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(image.sha256), 'REAL_IMAGE_HASH_NOT_FOUND')
  return { projectDirectory: path.resolve(report.projectDirectory), taskId: image.taskId,
    evidenceSha256: image.sha256, evidenceFileName: image.filename }
}

async function readPersistedTaskOutput(target) {
  const databasePath = path.join(target.projectDirectory, '.vibepaper', 'project.sqlite')
  const projectMetadataPath = path.join(target.projectDirectory, '.vibepaper', 'project.json')
  const projectMetadata = JSON.parse(await fs.readFile(projectMetadataPath, 'utf8'))
  const database = new DatabaseSync(databasePath, { readOnly: true })
  let output
  try {
    output = database.prepare(`SELECT tasks.task_id, tasks.status, tasks.modality, tasks.canvas_id, tasks.node_id,
      task_outputs.output_path, task_outputs.output_sha256, task_outputs.output_size_bytes
      FROM tasks JOIN task_outputs ON task_outputs.task_id = tasks.task_id AND task_outputs.output_index = 0
      WHERE tasks.task_id = ?`).get(target.taskId)
  } finally {
    database.close()
  }
  assert(output, 'REAL_IMAGE_TASK_OUTPUT_NOT_FOUND')
  assert.match(projectMetadata.projectId, /^[a-f0-9-]{36}$/iu, 'REAL_PROJECT_ID_NOT_FOUND')
  assert.equal(output.canvas_id, projectMetadata.canvasId, 'REAL_IMAGE_CANVAS_ID_MISMATCH')
  assert.equal(output.status, 'succeeded', 'REAL_IMAGE_TASK_NOT_SUCCEEDED')
  assert.equal(output.modality, 'image', 'REAL_IMAGE_TASK_MODALITY_MISMATCH')
  assert.match(output.output_path, /^generated\/[a-f0-9-]{36}\/[a-z0-9][a-z0-9._-]*\.png$/iu)
  const outputPath = path.resolve(target.projectDirectory, '.vibepaper', ...output.output_path.split('/'))
  const relative = path.relative(path.join(target.projectDirectory, '.vibepaper'), outputPath)
  assert(!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'REAL_IMAGE_OUTPUT_PATH_ESCAPED')
  const bytes = await fs.readFile(outputPath)
  assert.equal(bytes.length, output.output_size_bytes, 'PERSISTED_OUTPUT_SIZE_MISMATCH')
  const sha256 = digest(bytes)
  assert.equal(sha256, output.output_sha256, 'PERSISTED_OUTPUT_DIGEST_MISMATCH')
  assert.equal(sha256, target.evidenceSha256, 'REAL_IMAGE_EVIDENCE_DIGEST_MISMATCH')
  return { ...output, outputPath, sha256, bytes, projectId: projectMetadata.projectId }
}

function createImageReadGrantInput() {
  return {
    clientName: 'other',
    displayName: 'Real image media read acceptance',
    permissions: ['canvas.read', 'task.read', 'media.read'],
    providerGrants: [],
    mediaTypes: ['image'],
    disclosureVersion: 'desktop-mcp-provider-disclosure-v1',
    accepted: true,
  }
}

async function main() {
  const target = await readAcceptanceTarget()
  const resolvedRoot = await fs.realpath(path.join(root, '.test-temp'))
  const projectRelative = path.relative(resolvedRoot, target.projectDirectory)
  const projectRun = projectRelative.split(path.sep)[0]
  assert(/^mcp-agnes-\d+$/u.test(projectRun)
    && !path.isAbsolute(projectRelative) && !projectRelative.startsWith(`..${path.sep}`),
  'PROJECT_IS_NOT_THE_REPORTED_ISOLATED_AGNES_PROJECT')
  assert.equal(path.basename(target.projectDirectory), 'Agnes real account acceptance')
  const persisted = await readPersistedTaskOutput(target)

  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(evidenceDirectory, { recursive: true })
  await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({
    schemaVersion: 1,
    projectDirectory: target.projectDirectory,
  }))

  phase = 'open-existing-project-in-original-canvas'
  require('../src/main.cjs')
  await app.whenReady()
  assert.equal(app.getPath('userData'), profile, 'MEDIA_READ_PROFILE_IS_NOT_ISOLATED')
  await waitFor("location.pathname === '/workspace' && document.querySelector('[role=button]')")
  await evaluate("document.querySelector('[role=button]').click()")
  const canvasUrl = `/canvas/${persisted.canvas_id}`
  const realNodeSelector = `[data-testid="mcp-canvas-page"] .react-flow__node[data-id="${persisted.node_id}"]`
  await waitFor(`location.pathname === ${JSON.stringify(canvasUrl)} && document.querySelector(${JSON.stringify(realNodeSelector)})`)
  await waitFor('document.querySelector(\'[data-testid="mcp-canvas-page"]\') !== null')
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
  await waitFor(`window.vibepaperDesktop.getMcpState().then(state => state.activeCanvas?.canvasId === ${JSON.stringify(persisted.canvas_id)})`)
  const visibilityDeadline = Date.now() + 10_000
  while (window && !window.isVisible() && Date.now() < visibilityDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(window?.isVisible(), 'ORIGINAL_CANVAS_WINDOW_NOT_VISIBLE')
  const canvasPath = await evaluate('location.pathname')
  assert.equal(canvasPath, canvasUrl, 'ORIGINAL_CANVAS_ROUTE_MISMATCH')
  const activeCanvasState = await evaluate('window.vibepaperDesktop.getMcpState()')
  assert.equal(activeCanvasState.activeCanvas.projectId, persisted.projectId, 'EXISTING_PROJECT_NOT_REOPENED')
  assert.equal(activeCanvasState.activeCanvas.canvasId, persisted.canvas_id, 'EXISTING_CANVAS_NOT_REOPENED')
  assert.equal(activeCanvasState.canvasReady, true, 'ORIGINAL_CANVAS_NOT_READY')
  assert.equal(activeCanvasState.status, 'disabled', 'FRESH_PROFILE_MCP_SHOULD_START_DISABLED')

  phase = 'enable-mcp-and-create-read-only-media-grant-on-original-canvas'
  await evaluate('window.vibepaperDesktop.setMcpEnabled(true)')
  await waitFor("window.vibepaperDesktop.getMcpState().then(state => state.status === 'ready')")
  const enabledMcpState = await evaluate('window.vibepaperDesktop.getMcpState()')
  assert.equal(enabledMcpState.activeCanvas.projectId, persisted.projectId, 'MCP_PROJECT_CHANGED_DURING_ENABLE')
  assert.equal(enabledMcpState.activeCanvas.canvasId, persisted.canvas_id, 'MCP_CANVAS_CHANGED_DURING_ENABLE')
  grant = await evaluate(`window.vibepaperDesktop.createMcpClientGrant(${JSON.stringify(createImageReadGrantInput())})`)
  assert(grant?.clientId && grant?.config?.claudeCode, 'READ_ONLY_MEDIA_GRANT_FAILED')
  assert.deepEqual(grant.grant.permissions, ['canvas.read', 'task.read', 'media.read'])
  assert.deepEqual(grant.grant.mediaTypes, ['image'])
  assert.deepEqual(grant.grant.providerGrants, [])

  phase = 'verify-original-canvas-and-capture'
  await waitFor(`location.pathname === ${JSON.stringify(canvasUrl)} && document.querySelector(${JSON.stringify(realNodeSelector)})`)
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.status === \'ready\' && state.canvasReady === true)')
  const screenshotCanvasState = await evaluate('window.vibepaperDesktop.getMcpState()')
  assert.equal(screenshotCanvasState.activeCanvas.projectId, persisted.projectId, 'SCREENSHOT_PROJECT_MISMATCH')
  assert.equal(screenshotCanvasState.activeCanvas.canvasId, persisted.canvas_id, 'SCREENSHOT_CANVAS_MISMATCH')
  const nodeVisible = await evaluate(`Boolean(document.querySelector(${JSON.stringify(realNodeSelector)}))`)
  assert(nodeVisible, 'REAL_IMAGE_NODE_NOT_VISIBLE_ON_ORIGINAL_CANVAS')
  phase = 'fit-original-canvas-to-real-image-result'
  const fitViewSelector = '[data-testid="mcp-canvas-page"] .react-flow__controls-fitview'
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(fitViewSelector)}))`)
  await evaluate(`document.querySelector(${JSON.stringify(fitViewSelector)}).click()`)
  const imageProbeSource = imageVisibilityProbeSource(realNodeSelector)
  await waitFor(`${imageProbeSource}.visible === true`)
  const imageVisibility = await evaluate(imageProbeSource)
  assert.equal(imageVisibility.ready, true, 'REAL_IMAGE_RESULT_NOT_DECODED')
  assert.equal(imageVisibility.nodeInViewport, true, 'REAL_IMAGE_NODE_OUTSIDE_CANVAS_VIEWPORT')
  assert.equal(imageVisibility.imageInViewport, true, 'REAL_IMAGE_OUTSIDE_CANVAS_VIEWPORT')
  assert.equal(imageVisibility.unobscured, true, 'REAL_IMAGE_COVERED_BY_OVERLAY')
  assert.equal(imageVisibility.visible, true, 'REAL_IMAGE_RESULT_NOT_VISIBLE')
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await new Promise((resolve) => setTimeout(resolve, 500))
  await fs.writeFile(screenshotCandidatePath, (await window.webContents.capturePage()).toPNG())

  phase = 'connect-official-sdk-stdio'
  const server = JSON.parse(grant.config.claudeCode).mcpServers.vibepaper
  assert.equal(server.env?.ELECTRON_RUN_AS_NODE, '1')
  client = new Client({ name: 'real-image-media-read-acceptance', version: '1.0.0' })
  const transport = new StdioClientTransport({ ...server,
    env: { ...server.env, APPDATA: runRoot }, stderr: 'pipe' })
  transport.stderr?.on('data', (chunk) => {
    bridgeDiagnostics = String(chunk).replace(/\b[0-9]{6}\b/gu, '[pairing-code]').slice(-1200)
  })
  await client.connect(transport, { timeout: 60_000 })
  const definitions = await client.listTools()
  assert(definitions.tools.some((tool) => tool.name === 'read_task_output'), 'READ_TASK_OUTPUT_TOOL_NOT_DISCOVERED')
  const canvasSummary = await client.callTool({ name: 'get_canvas_summary', arguments: {} })
  assert.equal(canvasSummary.isError, undefined, 'ORIGINAL_CANVAS_READ_FAILED')
  const summaryNodes = canvasSummary.structuredContent?.nodes
  assert(Array.isArray(summaryNodes) && summaryNodes.some((node) => node.id === persisted.node_id),
    'READ_ONLY_GRANT_DID_NOT_READ_THE_REAL_CANVAS')

  phase = 'read-image-metadata'
  const metadata = await client.callTool({ name: 'read_task_output', arguments: {
    taskId: target.taskId, outputIndex: 0, mode: 'metadata',
  } })
  assert.equal(metadata.isError, undefined, 'MEDIA_METADATA_READ_FAILED')
  assert.deepEqual(metadata.structuredContent, {
    taskId: target.taskId, status: 'succeeded', modality: 'image', outputIndex: 0, mode: 'metadata',
    sizeBytes: persisted.output_size_bytes,
  })
  assert.equal(metadata.content[0]?.type, 'text')
  assert(!JSON.stringify(metadata).includes(persisted.outputPath), 'MEDIA_METADATA_EXPOSED_LOCAL_PATH')

  phase = 'read-image-preview-through-local-core-ipc'
  const preview = await client.callTool({ name: 'read_task_output', arguments: {
    taskId: target.taskId, outputIndex: 0, mode: 'preview',
  } })
  assert.equal(preview.isError, undefined, 'MEDIA_PREVIEW_READ_FAILED')
  assert.equal(preview.content[0]?.type, 'image', 'MEDIA_PREVIEW_IS_NOT_MCP_IMAGE_CONTENT')
  assert.equal(preview.content[0]?.mimeType, 'image/png')
  assert.equal(preview.structuredContent?.sizeBytes, persisted.output_size_bytes)
  assert.equal(preview.structuredContent?.outputIndex, 0)
  const previewBytes = Buffer.from(preview.content[0].data, 'base64')
  const previewSha256 = digest(previewBytes)
  previewBytes.fill(0)
  assert.equal(previewSha256, persisted.sha256, 'MCP_PREVIEW_DIGEST_DOES_NOT_MATCH_TASK_OUTPUT_FILE')

  const report = {
    success: true,
    startedAt,
    completedAt: new Date().toISOString(),
    phase: 'completed',
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    profile,
    projectDirectory: target.projectDirectory,
    projectId: persisted.projectId,
    canvasId: persisted.canvas_id,
    taskId: target.taskId,
    nodeId: persisted.node_id,
    providerCredentialAccessed: false,
    cloudRequestMade: false,
    grant: { permissions: grant.grant.permissions, mediaTypes: grant.grant.mediaTypes,
      providerGrants: grant.grant.providerGrants },
    protocol: { transport: 'stdio', sdkVersion: '1.32.1', tool: 'read_task_output' },
    metadata: { mode: metadata.structuredContent.mode, modality: metadata.structuredContent.modality,
      sizeBytes: metadata.structuredContent.sizeBytes, contentType: metadata.content[0].type },
    preview: { mode: preview.structuredContent.mode, modality: preview.structuredContent.modality,
      mimeType: preview.content[0].mimeType, sizeBytes: preview.structuredContent.sizeBytes,
      contentType: preview.content[0].type, sha256: previewSha256 },
    persistedOutput: { relativePath: persisted.output_path, sha256: persisted.sha256,
      recordedSha256: persisted.output_sha256, sizeBytes: persisted.output_size_bytes },
    assertions: { previewMatchesPersistedFile: previewSha256 === persisted.sha256,
      persistedFileMatchesTaskStoreDigest: persisted.sha256 === persisted.output_sha256,
      persistedFileMatchesRealAccountEvidence: persisted.sha256 === target.evidenceSha256,
      originalCanvasOpen: activeCanvasState.canvasReady === true && screenshotCanvasState.status === 'ready', originalNodeVisible: nodeVisible,
      originalResultDomVisible: imageVisibility.visible,
      imageDecoded: imageVisibility.ready,
      imageNodeAndBoundsInsideCanvasViewport: imageVisibility.nodeInViewport && imageVisibility.imageInViewport,
      imageCenterUnobscured: imageVisibility.unobscured,
      existingProjectReopened: true, newGrantIsReadOnlyForMedia: true },
    imageVisibility: { naturalWidth: imageVisibility.naturalWidth, naturalHeight: imageVisibility.naturalHeight,
      nodeRect: imageVisibility.nodeRect, imageRect: imageVisibility.imageRect, flowRect: imageVisibility.flowRect },
    bridgeDiagnostics,
    screenshotCandidate: path.basename(screenshotCandidatePath),
  }
  await fs.writeFile(evidencePath, JSON.stringify(report, null, 2))

  phase = 'revoke-acceptance-grant'
  await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grant.clientId)})`)
  await client.close()
  client = null
  grant = null
  console.log(`Read-only MCP media acceptance passed for task ${target.taskId}; preview SHA-256 matches the persisted output.`)
  console.log(`Evidence: ${evidencePath}`)
  app.quit()
}

main().catch(async (error) => {
  const safeMessage = typeof error?.message === 'string' && /^[A-Z0-9_-]{3,100}$/u.test(error.message)
    ? error.message : 'MEDIA_READ_ACCEPTANCE_FAILED'
  const safeName = typeof error?.name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(error.name)
    ? error.name : 'Error'
  const safeCode = typeof error?.code === 'string' && /^[A-Z0-9_.-]{1,80}$/u.test(error.code)
    ? error.code : undefined
  const safeDetail = typeof error?.message === 'string'
    ? error.message.replace(/[A-Za-z]:\\[^\s"']+/gu, '[path]').replace(/\\\\[^\s"']+/gu, '[path]').slice(0, 500)
    : undefined
  console.error(`MCP media read acceptance stopped at ${phase}: ${safeMessage}`)
  console.error(JSON.stringify({ errorName: safeName, errorCode: safeCode, errorDetail: safeDetail }))
  await fs.mkdir(evidenceDirectory, { recursive: true }).catch(() => {})
  await fs.writeFile(failureEvidencePath, JSON.stringify({ success: false, startedAt,
    completedAt: new Date().toISOString(), phase, errorCode: safeMessage,
    profile, providerCredentialAccessed: false, cloudRequestMade: false, bridgeDiagnostics }, null, 2)).catch(() => {})
  if (client) await client.close().catch(() => {})
  if (grant?.clientId && window && !window.isDestroyed()) {
    await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grant.clientId)})`).catch(() => {})
  }
  app.exit(1)
})
