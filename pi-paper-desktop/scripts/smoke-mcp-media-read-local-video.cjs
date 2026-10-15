// Verify a local, playable MP4 fixture through the real project TaskStore,
// Electron Main/Local Core IPC, and the official MCP SDK stdio client.
// This uses a new project and profile and never reads provider credentials.
const { app, BrowserWindow, dialog, protocol } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { createLocalProjectStore } = require('../src/project-store.cjs')

const root = path.resolve(__dirname, '../..')
const evidenceDirectory = path.join(root, 'docs/verification/2026-10-11-mcp-acceptance')
const runRoot = path.join(root, '.test-temp', `mcp-local-video-read-${Date.now()}`)
const profile = path.join(runRoot, 'VibePaper')
const projectsDirectory = path.join(runRoot, 'projects')
const projectName = 'Local MP4 media acceptance'
const sourceVideoPath = path.join(runRoot, 'one-second-blue.mp4')
const evidencePath = path.join(evidenceDirectory, 'mcp-local-video-read.json')
const originalGetPath = app.getPath.bind(app)
const originalSetPath = app.setPath.bind(app)
app.getPath = (name) => name === 'appData' ? runRoot : originalGetPath(name)
app.setPath = (name, value) => originalSetPath(name, name === 'userData' ? profile : value)
BrowserWindow.prototype.show = function () {}
protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }])
protocol.registerSchemesAsPrivileged = () => {}

let window
let client
let grant
let phase = 'prepare-isolated-local-video-project'
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
  throw new Error('LOCAL_VIDEO_READ_ACCEPTANCE_TIMEOUT')
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

async function prepareFixture() {
  await fs.mkdir(projectsDirectory, { recursive: true })
  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(evidenceDirectory, { recursive: true })

  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=2:d=1',
    '-t', '1', '-an', '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', sourceVideoPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 })
  const sourceBytes = await fs.readFile(sourceVideoPath)
  assert(sourceBytes.length > 64, 'LOCAL_MP4_FIXTURE_EMPTY')
  assert(sourceBytes.subarray(4, 8).toString('ascii') === 'ftyp', 'LOCAL_MP4_FIXTURE_MISSING_FTYP')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', sourceVideoPath, '-f', 'null', '-'], {
    stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000,
  })

  const store = createLocalProjectStore()
  try {
    const created = await store.createProject(projectsDirectory, projectName)
    const project = created.project
    const nodeResult = await store.createNode({
      projectId: project.projectId,
      canvasId: project.canvasId,
      idempotencyKey: 'mcp-local-video-media-read-node',
      expectedVersion: 0,
      type: 'video',
      x: 180,
      y: 140,
      params: { prompt: 'One-second local MP4 media read fixture' },
    })
    const task = await store.createTask({
      projectId: project.projectId,
      canvasId: project.canvasId,
      canvasVersion: nodeResult.version,
      nodeId: nodeResult.node.id,
      modality: 'video',
      providerType: 'local',
      providerId: 'local-mcp-media-fixture',
      modelId: 'one-second-mpeg4-fixture',
      idempotencyKey: 'mcp-local-video-media-read-task',
      parameters: { prompt: 'One-second local MP4 media read fixture' },
    })
    const claimed = await store.claimNextTask(project.projectId)
    assert.equal(claimed?.task.taskId, task.taskId, 'LOCAL_MP4_TASK_NOT_CLAIMED')
    const outputPath = `generated/${task.taskId}/result.mp4`
    await fs.copyFile(sourceVideoPath, path.join(claimed.outputDirectory, 'result.mp4'))
    const succeeded = await store.recordTaskSucceeded(project.projectId, task.taskId, outputPath)
    assert.equal(succeeded.status, 'succeeded', 'LOCAL_MP4_TASKSTORE_SAVE_FAILED')
    assert.equal(succeeded.outputSha256, digest(sourceBytes), 'TASKSTORE_MP4_DIGEST_MISMATCH')
    assert.equal(succeeded.outputSizeBytes, sourceBytes.length, 'TASKSTORE_MP4_SIZE_MISMATCH')
    await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({
      schemaVersion: 1,
      projectDirectory: created.directory,
    }))
    return {
      projectDirectory: created.directory,
      projectId: project.projectId,
      canvasId: project.canvasId,
      nodeId: nodeResult.node.id,
      taskId: task.taskId,
      outputPath,
      outputSha256: succeeded.outputSha256,
      outputSizeBytes: succeeded.outputSizeBytes,
      sourceSha256: digest(sourceBytes),
      sourceSizeBytes: sourceBytes.length,
      sourceDurationSeconds: 1,
    }
  } finally {
    await store.close()
  }
}

function createVideoReadGrantInput() {
  return {
    clientName: 'other',
    displayName: 'Local MP4 media read acceptance',
    permissions: ['canvas.read', 'task.read', 'media.read'],
    providerGrants: [],
    mediaTypes: ['video'],
    disclosureVersion: 'desktop-mcp-provider-disclosure-v1',
    accepted: true,
  }
}

async function main() {
  const target = await prepareFixture()
  phase = 'open-local-video-project-in-original-canvas'
  require('../src/main.cjs')
  await app.whenReady()
  assert.equal(app.getPath('userData'), profile, 'LOCAL_VIDEO_PROFILE_IS_NOT_ISOLATED')
  await waitFor("location.pathname === '/workspace' && document.querySelector('[role=button]')")
  await evaluate("document.querySelector('[role=button]').click()")
  const canvasUrl = `/canvas/${target.canvasId}`
  const nodeSelector = `[data-testid="mcp-canvas-page"] .react-flow__node[data-id="${target.nodeId}"]`
  await waitFor(`location.pathname === ${JSON.stringify(canvasUrl)} && document.querySelector(${JSON.stringify(nodeSelector)})`)
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
  const initialState = await evaluate('window.vibepaperDesktop.getMcpState()')
  assert.equal(initialState.activeCanvas.projectId, target.projectId, 'LOCAL_VIDEO_PROJECT_NOT_REOPENED')
  assert.equal(initialState.activeCanvas.canvasId, target.canvasId, 'LOCAL_VIDEO_CANVAS_NOT_REOPENED')
  assert.equal(initialState.status, 'disabled', 'LOCAL_VIDEO_PROFILE_MCP_SHOULD_START_DISABLED')
  assert(await evaluate(`Boolean(document.querySelector(${JSON.stringify(nodeSelector)}))`), 'LOCAL_VIDEO_NODE_NOT_VISIBLE')

  phase = 'create-video-only-read-grant'
  await evaluate('window.vibepaperDesktop.setMcpEnabled(true)')
  await waitFor("window.vibepaperDesktop.getMcpState().then(state => state.status === 'ready')")
  grant = await evaluate(`window.vibepaperDesktop.createMcpClientGrant(${JSON.stringify(createVideoReadGrantInput())})`)
  assert(grant?.clientId && grant?.config?.claudeCode, 'LOCAL_VIDEO_READ_GRANT_FAILED')
  assert.deepEqual(grant.grant.permissions, ['canvas.read', 'task.read', 'media.read'])
  assert.deepEqual(grant.grant.mediaTypes, ['video'])
  assert.deepEqual(grant.grant.providerGrants, [])

  phase = 'connect-official-sdk-stdio'
  const server = JSON.parse(grant.config.claudeCode).mcpServers.vibepaper
  assert.equal(server.env?.ELECTRON_RUN_AS_NODE, '1')
  client = new Client({ name: 'local-video-media-read-acceptance', version: '1.0.0' })
  const transport = new StdioClientTransport({ ...server,
    env: { ...server.env, APPDATA: runRoot }, stderr: 'pipe' })
  transport.stderr?.on('data', (chunk) => {
    bridgeDiagnostics = String(chunk).replace(/\b[0-9]{6}\b/gu, '[pairing-code]').slice(-1200)
  })
  await client.connect(transport, { timeout: 60_000 })
  const definitions = await client.listTools()
  assert(definitions.tools.some((tool) => tool.name === 'read_task_output'), 'READ_TASK_OUTPUT_TOOL_NOT_DISCOVERED')
  const canvasSummary = await client.callTool({ name: 'get_canvas_summary', arguments: {} })
  assert.equal(canvasSummary.isError, undefined, 'LOCAL_VIDEO_CANVAS_READ_FAILED')
  assert(canvasSummary.structuredContent?.nodes?.some((node) => node.id === target.nodeId),
    'LOCAL_VIDEO_CANVAS_NODE_NOT_READ_THROUGH_MCP')

  phase = 'read-video-metadata'
  const metadata = await client.callTool({ name: 'read_task_output', arguments: {
    taskId: target.taskId, outputIndex: 0, mode: 'metadata',
  } })
  assert.equal(metadata.isError, undefined, 'LOCAL_VIDEO_METADATA_READ_FAILED')
  assert.deepEqual(metadata.structuredContent, {
    taskId: target.taskId, status: 'succeeded', modality: 'video', outputIndex: 0,
    mode: 'metadata', sizeBytes: target.outputSizeBytes,
  })
  assert.equal(metadata.content[0]?.type, 'text')

  phase = 'read-video-resource-through-local-core-ipc'
  const preview = await client.callTool({ name: 'read_task_output', arguments: {
    taskId: target.taskId, outputIndex: 0, mode: 'preview',
  } })
  assert.equal(preview.isError, undefined, 'LOCAL_VIDEO_PREVIEW_READ_FAILED')
  assert.equal(preview.content[0]?.type, 'resource', 'LOCAL_VIDEO_PREVIEW_IS_NOT_MCP_RESOURCE')
  const resource = preview.content[0].resource
  assert.equal(resource.mimeType, 'video/mp4', 'LOCAL_VIDEO_RESOURCE_MIME_MISMATCH')
  assert.equal(resource.uri, `vibepaper://task-output/${target.taskId}/0`, 'LOCAL_VIDEO_RESOURCE_URI_MISMATCH')
  assert.equal(preview.structuredContent?.sizeBytes, target.outputSizeBytes)
  assert.equal(preview.structuredContent?.modality, 'video')
  const previewBytes = Buffer.from(resource.blob, 'base64')
  const previewSha256 = digest(previewBytes)
  assert.equal(previewBytes.length, target.outputSizeBytes, 'MCP_VIDEO_RESOURCE_SIZE_MISMATCH')
  assert.equal(previewSha256, target.outputSha256, 'MCP_VIDEO_RESOURCE_DIGEST_DOES_NOT_MATCH_TASKSTORE')
  assert.equal(previewSha256, target.sourceSha256, 'MCP_VIDEO_RESOURCE_DIGEST_DOES_NOT_MATCH_FIXTURE')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'null', '-'], {
    input: previewBytes, stdio: ['pipe', 'ignore', 'pipe'], timeout: 30_000,
  })
  previewBytes.fill(0)

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
    projectId: target.projectId,
    canvasId: target.canvasId,
    taskId: target.taskId,
    nodeId: target.nodeId,
    providerCredentialAccessed: false,
    cloudRequestMade: false,
    fixture: { kind: 'local-generated-mp4', durationSeconds: target.sourceDurationSeconds,
      decodedByFfmpeg: true, sha256: target.sourceSha256, sizeBytes: target.sourceSizeBytes },
    taskStore: { status: 'succeeded', relativePath: target.outputPath,
      sha256: target.outputSha256, sizeBytes: target.outputSizeBytes },
    grant: { permissions: grant.grant.permissions, mediaTypes: grant.grant.mediaTypes,
      providerGrants: grant.grant.providerGrants },
    protocol: { transport: 'stdio', sdkVersion: '1.32.1', tool: 'read_task_output' },
    metadata: { mode: metadata.structuredContent.mode, modality: metadata.structuredContent.modality,
      sizeBytes: metadata.structuredContent.sizeBytes, contentType: metadata.content[0].type },
    preview: { mode: preview.structuredContent.mode, modality: preview.structuredContent.modality,
      mimeType: resource.mimeType, uri: resource.uri, sizeBytes: preview.structuredContent.sizeBytes,
      contentType: preview.content[0].type, sha256: previewSha256, decodedByFfmpeg: true },
    assertions: { validMp4FixtureDecoded: true,
      previewMatchesTaskStoreDigest: previewSha256 === target.outputSha256,
      previewMatchesFixtureDigest: previewSha256 === target.sourceSha256,
      originalCanvasOpen: initialState.canvasReady === true,
      originalNodeVisible: true, existingProjectReopened: true,
      videoOnlyReadGrant: grant.grant.mediaTypes.length === 1 && grant.grant.mediaTypes[0] === 'video' },
    bridgeDiagnostics,
  }
  await fs.writeFile(evidencePath, JSON.stringify(report, null, 2))

  phase = 'revoke-acceptance-grant'
  await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grant.clientId)})`)
  await client.close()
  client = null
  grant = null
  console.log(`Local MP4 MCP media acceptance passed for task ${target.taskId}; SDK resource bytes decode and match TaskStore.`)
  console.log(`Evidence: ${evidencePath}`)
  app.quit()
}

main().catch(async (error) => {
  const safeMessage = typeof error?.message === 'string' && /^[A-Z0-9_-]{3,100}$/u.test(error.message)
    ? error.message : 'LOCAL_VIDEO_READ_ACCEPTANCE_FAILED'
  const safeName = typeof error?.name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(error.name)
    ? error.name : 'Error'
  const safeCode = typeof error?.code === 'string' && /^[A-Z0-9_.-]{1,80}$/u.test(error.code)
    ? error.code : undefined
  const safeDetail = typeof error?.message === 'string'
    ? error.message.replace(/[A-Za-z]:\\[^\s"']+/gu, '[path]').replace(/\\\\[^\s"']+/gu, '[path]').slice(0, 500)
    : undefined
  console.error(`Local MP4 MCP media acceptance stopped at ${phase}: ${safeMessage}`)
  console.error(JSON.stringify({ errorName: safeName, errorCode: safeCode, errorDetail: safeDetail }))
  await fs.mkdir(evidenceDirectory, { recursive: true }).catch(() => {})
  await fs.writeFile(evidencePath, JSON.stringify({ success: false, startedAt,
    completedAt: new Date().toISOString(), phase, errorCode: safeMessage, profile,
    providerCredentialAccessed: false, cloudRequestMade: false, bridgeDiagnostics }, null, 2)).catch(() => {})
  if (client) await client.close().catch(() => {})
  if (grant?.clientId && window && !window.isDestroyed()) {
    await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grant.clientId)})`).catch(() => {})
  }
  app.exit(1)
})
