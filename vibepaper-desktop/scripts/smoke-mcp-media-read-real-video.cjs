// Read-only acceptance of an already persisted real Agnes video through Electron Main,
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
const evidencePath = path.join(evidenceDirectory, 'mcp-real-video-read.json')
const screenshotPath = path.join(evidenceDirectory, 'mcp-real-video-read-original-canvas.png')
const debugPath = path.join(runRoot, 'mcp-real-video-read-debug.json')
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

function videoVisibilityProbeSource(nodeSelector, taskId) {
  return `(() => {
    const page = document.querySelector('[data-testid="mcp-canvas-page"]');
    const flow = page?.querySelector('.react-flow');
    const node = page?.querySelector(${JSON.stringify(nodeSelector)});
    const video = node?.querySelector('video');
    if (!page || !flow || !node || !video) return { visible: false, reason: 'missing-video-node' };
    const nodeRect = node.getBoundingClientRect();
    const videoRect = video.getBoundingClientRect();
    const flowRect = flow.getBoundingClientRect();
    const intersects = (a, b) => Math.max(a.left, b.left) < Math.min(a.right, b.right)
      && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom);
    const x = videoRect.left + videoRect.width / 2;
    const y = videoRect.top + videoRect.height / 2;
    const top = document.elementFromPoint(x, y);
    const unobscured = Boolean(top) && (top === video || video.contains(top));
    const style = getComputedStyle(video);
    const visibleStyle = style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) > 0 && videoRect.width > 0 && videoRect.height > 0;
    const ready = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && video.videoWidth > 0 && video.videoHeight > 0;
    const nodeInViewport = intersects(nodeRect, flowRect);
    const videoInViewport = intersects(videoRect, flowRect);
    return {
      visible: ready && visibleStyle && nodeInViewport && videoInViewport && unobscured,
      ready, visibleStyle, nodeInViewport, videoInViewport, unobscured,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      duration: video.duration, currentTime: video.currentTime, paused: video.paused,
      readyState: video.readyState, sourceIsTaskOutput: video.currentSrc.includes('/tasks/')
        && video.currentSrc.includes(${JSON.stringify(taskId)}) && video.currentSrc.includes('/output'),
      nodeRect: { left: nodeRect.left, top: nodeRect.top, right: nodeRect.right, bottom: nodeRect.bottom },
      videoRect: { left: videoRect.left, top: videoRect.top, right: videoRect.right, bottom: videoRect.bottom },
      flowRect: { left: flowRect.left, top: flowRect.top, right: flowRect.right, bottom: flowRect.bottom },
    };
  })()`
}

async function readAcceptanceTarget() {
  const report = JSON.parse(await fs.readFile(acceptanceReportPath, 'utf8'))
  const video = Array.isArray(report.results)
    ? report.results.find((result) => result?.taskId === '55bffcd0-b59b-4e95-94b0-763937a61c15'
      && result?.modality === 'video' && result?.status === 'succeeded')
    : null
  assert(video && typeof video.taskId === 'string' && /^[a-f0-9-]{36}$/iu.test(video.taskId), 'REAL_VIDEO_TASK_NOT_FOUND')
  assert(typeof report.projectDirectory === 'string' && report.projectDirectory.length > 0, 'REAL_PROJECT_NOT_FOUND')
  assert(typeof video.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(video.sha256), 'REAL_VIDEO_HASH_NOT_FOUND')
  assert(video.filename === 'agnes-real-video.mp4' && video.mimeType === 'video/mp4', 'REAL_VIDEO_IDENTITY_MISMATCH')
  assert(video.sizeBytes === 1_070_236, 'REAL_VIDEO_SIZE_EVIDENCE_MISMATCH')
  return { projectDirectory: path.resolve(report.projectDirectory), taskId: video.taskId,
    evidenceSha256: video.sha256, evidenceSizeBytes: video.sizeBytes, evidenceFileName: video.filename }
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
  assert(output, 'REAL_VIDEO_TASK_OUTPUT_NOT_FOUND')
  assert.match(projectMetadata.projectId, /^[a-f0-9-]{36}$/iu, 'REAL_PROJECT_ID_NOT_FOUND')
  assert.equal(output.canvas_id, projectMetadata.canvasId, 'REAL_VIDEO_CANVAS_ID_MISMATCH')
  assert.equal(output.status, 'succeeded', 'REAL_VIDEO_TASK_NOT_SUCCEEDED')
  assert.equal(output.modality, 'video', 'REAL_VIDEO_TASK_MODALITY_MISMATCH')
  assert.equal(output.task_id, target.taskId, 'REAL_VIDEO_TASK_ID_MISMATCH')
  assert.match(output.output_path, new RegExp(`^generated/${target.taskId}/[a-z0-9][a-z0-9._-]*\\.mp4$`, 'iu'))
  const dataDirectory = path.join(target.projectDirectory, '.vibepaper')
  const outputPath = path.resolve(dataDirectory, ...output.output_path.split('/'))
  const relative = path.relative(dataDirectory, outputPath)
  assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'REAL_VIDEO_OUTPUT_PATH_ESCAPED')
  const projectRealPath = await fs.realpath(target.projectDirectory)
  const outputRealPath = await fs.realpath(outputPath)
  const realRelative = path.relative(projectRealPath, outputRealPath)
  assert(realRelative && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative), 'REAL_VIDEO_OUTPUT_REALPATH_ESCAPED')
  const fileStat = await fs.lstat(outputPath)
  assert(fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.size > 0 && fileStat.size <= 8 * 1024 * 1024,
    'REAL_VIDEO_FILE_NOT_REGULAR_OR_WITHIN_LIMIT')
  assert.equal(fileStat.size, output.output_size_bytes, 'REAL_VIDEO_DB_SIZE_MISMATCH')
  assert.equal(fileStat.size, target.evidenceSizeBytes, 'REAL_VIDEO_EVIDENCE_SIZE_MISMATCH')
  const noFollow = fs.constants.O_NOFOLLOW || 0
  const handle = await fs.open(outputPath, fs.constants.O_RDONLY | noFollow)
  let bytes
  let sha256
  try {
    const openedStat = await handle.stat()
    assert(openedStat.isFile() && openedStat.size === fileStat.size
      && (fileStat.dev === undefined || openedStat.dev === fileStat.dev)
      && (fileStat.ino === undefined || openedStat.ino === fileStat.ino), 'REAL_VIDEO_FILE_CHANGED_BEFORE_OPEN')
    bytes = Buffer.alloc(output.output_size_bytes)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      assert(bytesRead > 0, 'REAL_VIDEO_FILE_READ_INCOMPLETE')
      offset += bytesRead
    }
    const afterStat = await handle.stat()
    assert(afterStat.size === openedStat.size, 'REAL_VIDEO_FILE_CHANGED_DURING_READ')
    assert.equal(bytes.length, output.output_size_bytes, 'PERSISTED_OUTPUT_SIZE_MISMATCH')
    sha256 = digest(bytes)
  } finally {
    bytes?.fill(0)
    await handle.close()
  }
  assert.equal(sha256, output.output_sha256, 'PERSISTED_OUTPUT_DIGEST_MISMATCH')
  assert.equal(sha256, target.evidenceSha256, 'REAL_VIDEO_EVIDENCE_DIGEST_MISMATCH')
  const evidenceBytes = await fs.readFile(path.join(evidenceDirectory, target.evidenceFileName))
  assert.equal(evidenceBytes.length, target.evidenceSizeBytes, 'REAL_VIDEO_COPY_SIZE_MISMATCH')
  assert.equal(digest(evidenceBytes), sha256, 'REAL_VIDEO_COPY_DIGEST_MISMATCH')
  return { ...output, outputPath, sha256, projectId: projectMetadata.projectId }
}

function createVideoReadGrantInput() {
  return {
    clientName: 'other',
    displayName: 'Real video media read acceptance',
    permissions: ['canvas.read', 'task.read', 'media.read'],
    providerGrants: [],
    mediaTypes: ['video'],
    disclosureVersion: 'desktop-mcp-provider-disclosure-v1',
    accepted: true,
  }
}

async function main() {
  const target = await readAcceptanceTarget()
  const resolvedRoot = await fs.realpath(path.join(root, '.test-temp'))
  const projectInfo = await fs.lstat(target.projectDirectory)
  assert(projectInfo.isDirectory() && !projectInfo.isSymbolicLink(), 'REAL_PROJECT_DIRECTORY_IS_NOT_REGULAR')
  const realProjectDirectory = await fs.realpath(target.projectDirectory)
  const projectRelative = path.relative(resolvedRoot, realProjectDirectory)
  const projectRun = projectRelative.split(path.sep)[0]
  assert(/^mcp-agnes-\d+$/u.test(projectRun)
    && !path.isAbsolute(projectRelative) && !projectRelative.startsWith(`..${path.sep}`),
  'PROJECT_IS_NOT_THE_REPORTED_ISOLATED_AGNES_PROJECT')
  assert.equal(path.basename(realProjectDirectory), 'Agnes real account acceptance')
  target.projectDirectory = realProjectDirectory
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
  grant = await evaluate(`window.vibepaperDesktop.createMcpClientGrant(${JSON.stringify(createVideoReadGrantInput())})`)
  assert(grant?.clientId && grant?.config?.claudeCode, 'READ_ONLY_MEDIA_GRANT_FAILED')
  assert.deepEqual(grant.grant.permissions, ['canvas.read', 'task.read', 'media.read'])
  assert.deepEqual(grant.grant.mediaTypes, ['video'])
  assert.deepEqual(grant.grant.providerGrants, [])

  phase = 'verify-original-canvas-and-capture'
  await waitFor(`location.pathname === ${JSON.stringify(canvasUrl)} && document.querySelector(${JSON.stringify(realNodeSelector)})`)
  await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.status === \'ready\' && state.canvasReady === true)')
  const screenshotCanvasState = await evaluate('window.vibepaperDesktop.getMcpState()')
  assert.equal(screenshotCanvasState.activeCanvas.projectId, persisted.projectId, 'SCREENSHOT_PROJECT_MISMATCH')
  assert.equal(screenshotCanvasState.activeCanvas.canvasId, persisted.canvas_id, 'SCREENSHOT_CANVAS_MISMATCH')
  const nodeVisible = await evaluate(`Boolean(document.querySelector(${JSON.stringify(realNodeSelector)}))`)
  assert(nodeVisible, 'REAL_VIDEO_NODE_NOT_VISIBLE_ON_ORIGINAL_CANVAS')
  phase = 'fit-original-canvas-to-real-video-result'
  const fitViewSelector = '[data-testid="mcp-canvas-page"] .react-flow__controls-fitview'
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(fitViewSelector)}))`)
  await evaluate(`document.querySelector(${JSON.stringify(fitViewSelector)}).click()`)
  const videoSelector = `${realNodeSelector} video`
  const videoProbeSource = videoVisibilityProbeSource(realNodeSelector, target.taskId)
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(videoSelector)}))`)
  await waitFor(`(() => { const video = document.querySelector(${JSON.stringify(videoSelector)}); return Boolean(video && video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth > 0); })()`)
  const metadataBeforePlayback = await evaluate(videoProbeSource)
  assert.equal(metadataBeforePlayback.readyState >= 1, true, 'ORIGINAL_CANVAS_VIDEO_METADATA_NOT_LOADED')
  assert.equal(metadataBeforePlayback.videoWidth, 1280, 'ORIGINAL_CANVAS_VIDEO_WIDTH_MISMATCH')
  assert.equal(metadataBeforePlayback.videoHeight, 720, 'ORIGINAL_CANVAS_VIDEO_HEIGHT_MISMATCH')
  assert.equal(metadataBeforePlayback.sourceIsTaskOutput, true, 'ORIGINAL_CANVAS_VIDEO_NOT_TASK_OUTPUT')
  const playback = await evaluate(`(async () => {
    const video = document.querySelector(${JSON.stringify(videoSelector)});
    if (!video || video.readyState < HTMLMediaElement.HAVE_METADATA) throw new Error('ORIGINAL_CANVAS_VIDEO_NOT_READY');
    video.muted = true;
    const originalControls = video.controls;
    video.currentTime = Math.min(0.05, Math.max(0, video.duration / 100));
    let presentedFrames = 0;
    let lastFrame = null;
    let stopFrames = false;
    const captureFrame = (_now, metadata) => {
      presentedFrames += 1;
      lastFrame = { mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames,
        width: metadata.width, height: metadata.height };
      if (!stopFrames) video.requestVideoFrameCallback(captureFrame);
    };
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(captureFrame);
    const playbackStartedAt = performance.now();
    await video.play();
    await new Promise(resolve => setTimeout(resolve, 700));
    stopFrames = true;
    const result = { playedMilliseconds: Math.round(performance.now() - playbackStartedAt),
      currentTime: video.currentTime, pausedBeforeStop: video.paused, presentedFrames, lastFrame,
      readyState: video.readyState, videoWidth: video.videoWidth, videoHeight: video.videoHeight,
      duration: video.duration, sourceIsTaskOutput: video.currentSrc.includes('/tasks/')
        && video.currentSrc.includes(${JSON.stringify(target.taskId)}) && video.currentSrc.includes('/output') };
    video.pause();
    video.controls = originalControls;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    result.pausedAfterCapture = video.paused;
    return result;
  })()`)
  assert.equal(playback.pausedBeforeStop, false, 'ORIGINAL_CANVAS_VIDEO_DID_NOT_PLAY')
  assert.equal(playback.pausedAfterCapture, true, 'ORIGINAL_CANVAS_VIDEO_NOT_PAUSED_AFTER_CAPTURE')
  assert(playback.playedMilliseconds >= 600, 'ORIGINAL_CANVAS_VIDEO_PLAYBACK_TOO_SHORT')
  assert(playback.currentTime >= 0.35, 'ORIGINAL_CANVAS_VIDEO_PLAYHEAD_DID_NOT_ADVANCE')
  assert(playback.presentedFrames >= 2, 'ORIGINAL_CANVAS_VIDEO_DID_NOT_PRESENT_REAL_FRAMES')
  assert(playback.lastFrame?.mediaTime > 0 && playback.lastFrame.width === 1280 && playback.lastFrame.height === 720,
    'ORIGINAL_CANVAS_VIDEO_FRAME_DIMENSIONS_OR_TIME_INVALID')
  assert.equal(playback.sourceIsTaskOutput, true, 'ORIGINAL_CANVAS_VIDEO_NOT_TASK_OUTPUT')
  await waitFor(`${videoProbeSource}.visible === true`)
  const videoVisibility = await evaluate(videoProbeSource)
  assert.equal(videoVisibility.ready, true, 'REAL_VIDEO_RESULT_NOT_DECODED')
  assert.equal(videoVisibility.nodeInViewport, true, 'REAL_VIDEO_NODE_OUTSIDE_CANVAS_VIEWPORT')
  assert.equal(videoVisibility.videoInViewport, true, 'REAL_VIDEO_OUTSIDE_CANVAS_VIEWPORT')
  assert.equal(videoVisibility.visibleStyle, true, 'REAL_VIDEO_HAS_NO_VISIBLE_STYLE')
  assert.equal(videoVisibility.unobscured, true, 'REAL_VIDEO_COVERED_BY_OVERLAY')
  assert.equal(videoVisibility.visible, true, 'REAL_VIDEO_RESULT_NOT_VISIBLE')
  assert(videoVisibility.videoRect.right - videoVisibility.videoRect.left >= 100,
    'REAL_VIDEO_ELEMENT_TOO_SMALL_TO_REVIEW')
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await new Promise((resolve) => setTimeout(resolve, 500))
  await fs.writeFile(screenshotPath, (await window.webContents.capturePage()).toPNG())

  phase = 'connect-official-sdk-stdio'
  const server = JSON.parse(grant.config.claudeCode).mcpServers.vibepaper
  assert.equal(server.env?.ELECTRON_RUN_AS_NODE, '1')
  client = new Client({ name: 'real-video-media-read-acceptance', version: '1.0.0' })
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

  phase = 'read-video-metadata'
  const metadata = await client.callTool({ name: 'read_task_output', arguments: {
    taskId: target.taskId, outputIndex: 0, mode: 'metadata',
  } })
  assert.equal(metadata.isError, undefined, 'MEDIA_METADATA_READ_FAILED')
  assert.deepEqual(metadata.structuredContent, {
    taskId: target.taskId, status: 'succeeded', modality: 'video', outputIndex: 0, mode: 'metadata',
    sizeBytes: persisted.output_size_bytes,
  })
  assert.equal(metadata.content[0]?.type, 'text')
  assert(!JSON.stringify(metadata).includes(persisted.outputPath), 'MEDIA_METADATA_EXPOSED_LOCAL_PATH')

  phase = 'read-video-preview-resource-through-local-core-ipc'
  const preview = await client.callTool({ name: 'read_task_output', arguments: {
    taskId: target.taskId, outputIndex: 0, mode: 'preview',
  } })
  assert.equal(preview.isError, undefined, 'MEDIA_PREVIEW_READ_FAILED')
  assert.equal(preview.content[0]?.type, 'resource', 'MEDIA_PREVIEW_IS_NOT_MCP_RESOURCE_CONTENT')
  assert.equal(preview.content[0]?.resource?.mimeType, 'video/mp4', 'MEDIA_PREVIEW_MIME_MISMATCH')
  assert.equal(preview.content[0]?.resource?.uri, `vibepaper://task-output/${target.taskId}/0`, 'MEDIA_RESOURCE_URI_MISMATCH')
  assert.equal(preview.structuredContent?.sizeBytes, persisted.output_size_bytes)
  assert.equal(preview.structuredContent?.outputIndex, 0)
  const encodedBlob = preview.content[0].resource.blob
  assert.equal(typeof encodedBlob, 'string', 'MEDIA_RESOURCE_BLOB_MISSING')
  assert(encodedBlob.length <= Math.ceil((8 * 1024 * 1024) / 3) * 4, 'MEDIA_RESOURCE_BLOB_EXCEEDS_LIMIT')
  const previewBytes = Buffer.from(encodedBlob, 'base64')
  assert.equal(previewBytes.toString('base64'), encodedBlob, 'MEDIA_RESOURCE_BLOB_BASE64_INVALID')
  assert.equal(previewBytes.length, persisted.output_size_bytes, 'MCP_PREVIEW_SIZE_DOES_NOT_MATCH_TASK_OUTPUT_FILE')
  const previewSha256 = digest(previewBytes)
  previewBytes.fill(0)
  assert.equal(previewSha256, persisted.sha256, 'MCP_PREVIEW_DIGEST_DOES_NOT_MATCH_TASK_OUTPUT_FILE')

  phase = 'probe-video-and-decode-persisted-output'
  const ffprobe = require('node:child_process').spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,duration', '-of', 'json', persisted.outputPath,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1_000_000 })
  assert.equal(ffprobe.error, undefined, 'FFPROBE_FAILED_TO_START')
  assert.equal(ffprobe.status, 0, 'FFPROBE_REJECTED_PERSISTED_VIDEO')
  const probe = JSON.parse(ffprobe.stdout)
  const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video')
  const durationSeconds = Number(probe.format?.duration ?? videoStream?.duration)
  assert(videoStream, 'FFPROBE_VIDEO_STREAM_MISSING')
  assert.equal(videoStream.width, 1280, 'FFPROBE_WIDTH_NOT_720P')
  assert.equal(videoStream.height, 720, 'FFPROBE_HEIGHT_NOT_720P')
  assert(durationSeconds >= 3.5 && durationSeconds <= 5.0, 'FFPROBE_DURATION_NOT_APPROX_FOUR_SECONDS')
  const ffmpeg = require('node:child_process').spawnSync('ffmpeg', [
    '-v', 'error', '-xerror', '-i', persisted.outputPath, '-f', 'null', '-',
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1_000_000 })
  assert.equal(ffmpeg.error, undefined, 'FFMPEG_FAILED_TO_START')
  assert.equal(ffmpeg.status, 0, 'FFMPEG_COULD_NOT_DECODE_PERSISTED_VIDEO')

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
      mimeType: preview.content[0].resource.mimeType, resourceUri: preview.content[0].resource.uri,
      sizeBytes: preview.structuredContent.sizeBytes, contentType: preview.content[0].type,
      base64Bytes: encodedBlob.length, sha256: previewSha256 },
    persistedOutput: { relativePath: persisted.output_path, sha256: persisted.sha256,
      recordedSha256: persisted.output_sha256, sizeBytes: persisted.output_size_bytes },
    videoProbe: { formatDurationSeconds: durationSeconds, streamWidth: videoStream.width,
      streamHeight: videoStream.height, streams: probe.streams.map((stream) => ({ codecType: stream.codec_type,
        ...(Number.isFinite(Number(stream.width)) ? { width: Number(stream.width) } : {}),
        ...(Number.isFinite(Number(stream.height)) ? { height: Number(stream.height) } : {}),
        ...(Number.isFinite(Number(stream.duration)) ? { durationSeconds: Number(stream.duration) } : {}) })) },
    originalCanvasVideo: { ...videoVisibility, playback: { playedMilliseconds: playback.playedMilliseconds,
      currentTime: playback.currentTime, presentedFrames: playback.presentedFrames,
      lastFrame: playback.lastFrame }, screenshot: path.basename(screenshotPath),
      windowVisible: Boolean(window?.isVisible()) },
    decoding: { ffprobeExitCode: ffprobe.status, ffmpegExitCode: ffmpeg.status, ffmpegDecodeSucceeded: true },
    assertions: { previewMatchesPersistedFile: previewSha256 === persisted.sha256,
      persistedFileMatchesTaskStoreDigest: persisted.sha256 === persisted.output_sha256,
      persistedFileMatchesRealAccountEvidence: persisted.sha256 === target.evidenceSha256,
      persistedSizeMatchesTaskStoreAndEvidence: persisted.output_size_bytes === target.evidenceSizeBytes,
      originalCanvasOpen: activeCanvasState.canvasReady === true && screenshotCanvasState.status === 'ready', originalNodeVisible: nodeVisible,
      originalResultDomVisible: videoVisibility.visible,
      originalVideoMetadataLoaded: metadataBeforePlayback.readyState >= 1,
      originalVideoDecoded: videoVisibility.ready,
      originalVideoNodeAndElementInsideCanvasViewport: videoVisibility.nodeInViewport && videoVisibility.videoInViewport,
      originalVideoCenterUnobscured: videoVisibility.unobscured,
      originalVideoPlaybackFramesPresented: playback.presentedFrames >= 2,
      ffprobeConfirmedApproximatelyFourSeconds720p: durationSeconds >= 3.5 && durationSeconds <= 5.0
        && videoStream.width === 1280 && videoStream.height === 720,
      ffmpegDecodedEntirePersistedVideo: true,
      existingProjectReopened: true, newGrantIsReadOnlyForMedia: true },
    videoVisibility: { videoWidth: videoVisibility.videoWidth, videoHeight: videoVisibility.videoHeight,
      duration: videoVisibility.duration, currentTime: videoVisibility.currentTime,
      readyState: videoVisibility.readyState, nodeRect: videoVisibility.nodeRect,
      videoRect: videoVisibility.videoRect, flowRect: videoVisibility.flowRect },
    bridgeDiagnostics,
    screenshot: path.basename(screenshotPath),
  }
  await fs.writeFile(evidencePath, JSON.stringify(report, null, 2))

  phase = 'revoke-acceptance-grant'
  await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grant.clientId)})`)
  await client.close()
  client = null
  grant = null
  console.log(`Read-only MCP video media acceptance passed for task ${target.taskId}; stdio resource, TaskStore digest, and decoded video match.`)
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
  await fs.mkdir(runRoot, { recursive: true }).catch(() => {})
  await fs.writeFile(debugPath, JSON.stringify({ phase, errorName: safeName, errorCode: safeCode,
    message: safeDetail, stack: typeof error?.stack === 'string'
      ? error.stack.replace(/[A-Za-z]:\\[^\s"']+/gu, '[path]').slice(0, 4000) : undefined,
    renderer: window && !window.isDestroyed()
      ? await evaluate(`({ pathname: location.pathname, readyState: document.readyState,
          mcpState: await window.vibepaperDesktop?.getMcpState?.() })`).catch(() => null)
      : null }, null, 2)).catch(() => {})
  await fs.writeFile(evidencePath, JSON.stringify({ success: false, startedAt,
    completedAt: new Date().toISOString(), phase, errorCode: safeMessage,
    profile, providerCredentialAccessed: false, cloudRequestMade: false, bridgeDiagnostics }, null, 2)).catch(() => {})
  if (grant?.clientId && window && !window.isDestroyed()) {
    await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grant.clientId)})`).catch(() => {})
  }
  if (client) await client.close().catch(() => {})
  app.exit(1)
})
