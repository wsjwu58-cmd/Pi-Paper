// Prepare a private, visible VibePaper Main/Canvas for a human-operated
// Codex TUI Agnes media acceptance. This host never submits a generation or
// answers MCP form elicitation. The API key is saved through the desktop IPC
// backed by Electron safeStorage, then cleared from the worker environment.
'use strict'

const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const {
  protectRunDirectory, safeEnvironment, createCodexToml, parseDesktopCodexConfig,
} = require('./prepare-mcp-native-confirmation.cjs')

const root = path.resolve(__dirname, '../..')
const desktopRoot = path.join(root, 'pi-paper-desktop')
const tempRoot = path.join(root, '.test-temp')
const evidenceRoot = path.join(root, 'docs/verification/2026-11-01-mcp-native-agnes')
const serverName = 'vibepaper_native_agnes_media'
const keyEnvName = 'VIBEPAPER_QA_AGNES_SETUP_KEY'
const enabledTools = [
  'get_context', 'get_canvas_summary', 'get_selected_nodes', 'get_node_detail', 'list_models',
  'create_nodes', 'connect_nodes', 'prepare_generation', 'get_operation', 'check_task_status',
  'read_task_output', 'list_provider_configuration', 'list_canvas_tasks',
]
const defaultTimeoutMs = 30 * 60 * 1000
const maxTimeoutMs = 6 * 60 * 60 * 1000

const publicFailureCodes = new Set([
  'AGNES_KEY_INPUT_CANCELLED', 'AGNES_KEY_INPUT_REQUIRES_HIDDEN_TTY', 'AGNES_KEY_INPUT_TOO_LARGE',
  'AGNES_KEY_INVALID', 'AGNES_MODELS_NOT_ENABLED', 'AGNES_MODELS_UNAVAILABLE', 'CODEX_CONFIG_MISSING',
  'DESKTOP_PREPARE_TIMEOUT', 'DESKTOP_WORKER_EXIT_WITHOUT_RESULT', 'DESKTOP_WORKER_EXITED_BEFORE_READY',
  'ELECTRON_RUNTIME_NOT_FOUND', 'MCP_ENABLE_FAILED', 'MCP_GRANT_MISSING', 'MCP_INSTANCE_PATH_INVALID',
  'ORIGINAL_CANVAS_WAIT_TIMEOUT', 'PRIVATE_PROFILE_PATH_INVALID', 'SECRET_FOUND_IN_CODEX_CONFIG',
  'SECURE_STORAGE_UNAVAILABLE', 'TIMEOUT_MUST_BE_BETWEEN_60000_AND_21600000_MS',
  'UNEXPECTED_NATIVE_DIALOG', 'UNKNOWN_ARGUMENT', 'UNSAFE_PRIVATE_TEST_DIRECTORY',
  'WORKER_ARGUMENTS_INVALID', 'EACCES', 'EPERM', 'ENOENT', 'EEXIST',
])
function safeError(error, fallback = 'native_agnes_host_failed') {
  const code = error?.code || error?.message
  return typeof code === 'string' && publicFailureCodes.has(code.toUpperCase()) ? code.toUpperCase() : fallback
}

function safeErrorMetadata(error, stage) {
  const line = String(error?.stack || '').split(/\r?\n/u)
    .map((entry) => entry.match(/prepare-mcp-native-agnes-media\.cjs:(\d+):\d+/u)?.[1]).find(Boolean)
  return { failureStage: stage, failureLine: line ? Number(line) : null,
    errorKind: ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'AssertionError'].includes(error?.name)
      ? error.name : 'other' }
}

function assertIsolatedRunRoot(runRoot) {
  const resolved = path.resolve(runRoot)
  if (path.dirname(resolved) !== path.resolve(tempRoot)
    || !path.basename(resolved).startsWith('vibepaper-native-form-agnes-')
    || fsSync.lstatSync(resolved).isSymbolicLink()
    || path.relative(resolved, fsSync.realpathSync(resolved)) !== '') {
    throw new Error('unsafe_private_test_directory')
  }
}

function parseTimeout(argv) {
  const index = argv.indexOf('--timeout-ms')
  if (index < 0) return defaultTimeoutMs
  const value = Number(argv[index + 1])
  if (index + 1 >= argv.length || !Number.isSafeInteger(value) || value < 60_000 || value > maxTimeoutMs) {
    throw new Error('timeout_must_be_between_60000_and_21600000_ms')
  }
  return value
}

function readSecretNoEcho() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('AGNES_KEY_INPUT_REQUIRES_HIDDEN_TTY')
  }
  return new Promise((resolve, reject) => {
    let raw = ''
    const finish = (error, value) => {
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.pause()
      process.stdin.setRawMode(false)
      process.stdout.write('\n')
      raw = ''
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') return finish(new Error('AGNES_KEY_INPUT_CANCELLED'))
        if (char === '\r' || char === '\n') return finish(null, raw)
        if (char === '\b' || char === '\u007f') raw = raw.slice(0, -1)
        else raw += char
        if (raw.length > 8192) return finish(new Error('AGNES_KEY_INPUT_TOO_LARGE'))
      }
    }
    const onEnd = () => finish(new Error('AGNES_KEY_INPUT_CANCELLED'))
    process.stdout.write('Enter the already-authorized Agnes API key (input is hidden): ')
    process.stdin.setRawMode(true)
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.resume()
  })
}

async function resolveElectronPath() {
  let executable
  try { executable = require(path.join(desktopRoot, 'node_modules', 'electron')) } catch {
    throw new Error('electron_runtime_not_found')
  }
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || !fsSync.existsSync(executable)) {
    throw new Error('electron_runtime_not_found')
  }
  return executable
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')) } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('desktop_prepare_timeout')
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !Number.isInteger(child.pid)) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore',
    })
    await new Promise((resolve) => {
      killer.once('error', resolve)
      killer.once('close', resolve)
      setTimeout(resolve, 3000).unref()
    })
  } else child.kill('SIGTERM')
}

function safeKey(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 8192
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

async function controllerMain() {
  let controllerPhase = 'parse-options'
  const args = process.argv.slice(2)
  const timeoutMs = parseTimeout(args)
  if (args.some((value, index) => value !== '--timeout-ms' && args[index - 1] !== '--timeout-ms')) {
    throw new Error('unknown_argument')
  }
  controllerPhase = 'collect-hidden-key'
  let secret = await readSecretNoEcho()
  if (!safeKey(secret)) { secret = ''; throw new Error('AGNES_KEY_INVALID') }

  await fs.mkdir(tempRoot, { recursive: true })
  await fs.mkdir(evidenceRoot, { recursive: true })
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`
  const runRoot = path.join(tempRoot, `vibepaper-native-form-agnes-${runId}`)
  const readyPath = path.join(runRoot, 'ready.json')
  const statusPath = path.join(runRoot, 'status.json')
  const resultPath = path.join(runRoot, 'result.json')
  const stopPath = path.join(runRoot, 'stop.request')
  const decisionsPath = path.join(runRoot, 'confirmation-decisions.json')
  const reportPath = path.join(evidenceRoot, `${runId}.json`)
  controllerPhase = 'prepare-private-run-directory'
  await fs.mkdir(runRoot, { recursive: true })
  protectRunDirectory(runRoot)
  await Promise.all([
    fs.mkdir(path.join(runRoot, 'VibePaper'), { recursive: true }),
    fs.mkdir(path.join(runRoot, 'Temp'), { recursive: true }),
    fs.mkdir(path.join(runRoot, 'LocalAppData'), { recursive: true }),
  ])

  let electronPath
  try { controllerPhase = 'resolve-electron'; electronPath = await resolveElectronPath() } catch (error) {
    secret = ''
    throw error
  }
  const childEnvironment = safeEnvironment(runRoot)
  childEnvironment.VIBEPAPER_QA_PRIVATE_PROFILE = runRoot
  childEnvironment[keyEnvName] = secret
  const child = spawn(electronPath, [path.resolve(__filename), '--worker', '--run-root', runRoot,
    '--timeout-ms', String(timeoutMs)], {
    cwd: desktopRoot, env: childEnvironment, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
  })
  childEnvironment[keyEnvName] = ''
  secret = ''
  let exit = null
  const closed = new Promise((resolve) => child.once('close', (code, signal) => {
    exit = { code, signal }
    resolve(exit)
  }))
  const requestStop = () => { void fs.writeFile(stopPath, 'stop\n').catch(() => {}) }
  process.once('SIGINT', requestStop)
  process.once('SIGTERM', requestStop)

  try {
    controllerPhase = 'wait-for-worker-ready'
    const ready = await Promise.race([
      waitForFile(readyPath, 180_000),
      closed.then(async () => {
        const failed = await fs.readFile(resultPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null)
        if (failed) throw new Error(failed.errorCode || 'desktop_worker_exited_early')
        throw new Error('desktop_worker_exited_before_ready')
      }),
    ])
    if (ready.startupFailure) throw new Error(ready.startupFailure)
    console.log('Isolated VibePaper Agnes media host is ready; no generation was started.')
    console.log(`Ready file: ${readyPath}`)
    console.log(`Project: ${ready.projectPath}`)
    console.log(`Secret-free Codex TOML: ${ready.codexTomlPath}`)
    console.log(`Codex MCP server name: ${ready.serverName}`)
    console.log('The Agnes key was saved through the desktop secure-storage IPC. Natural-language provider configuration was not tested.')
    console.log('Use the returned TOML in the isolated project-local Codex config, then start the real Codex TUI manually.')
    console.log('After the TUI exits, optionally write image/video decisions to confirmation-decisions.json; then create stop.request or press Ctrl+C here.')
    const timeoutGuard = setTimeout(requestStop, timeoutMs + 30_000)
    timeoutGuard.unref()
    controllerPhase = 'wait-for-stop-or-timeout'
    await closed
    clearTimeout(timeoutGuard)
    const result = await fs.readFile(resultPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null)
    if (!result) throw new Error('desktop_worker_exit_without_result')
    controllerPhase = 'write-summary-report'
    await fs.writeFile(reportPath, `${JSON.stringify({ ...result, reportPath }, null, 2)}\n`, { flag: 'wx' })
    console.log(`Acceptance summary: ${reportPath}`)
    console.log(JSON.stringify({ ...result, reportPath, isolatedRunRetainedForRecovery: true }, null, 2))
    if (exit?.code !== 0) process.exitCode = 1
  } catch (error) {
    requestStop()
    const settled = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))])
    if (!settled) await stopProcessTree(child)
    const safe = safeError(error)
    const workerResult = await fs.readFile(resultPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null)
    const failureReport = workerResult || { schemaVersion: 1, status: 'failed', errorCode: safe,
      profileIsolated: true, providerKeyInEvidence: false, keyInToml: false, generationSubmissionStartedByHost: false,
      failure: { errorCode: safe, ...safeErrorMetadata(error, controllerPhase) } }
    if (!fsSync.existsSync(reportPath)) {
      await fs.writeFile(reportPath, `${JSON.stringify({ ...failureReport, reportPath }, null, 2)}\n`, { flag: 'wx' }).catch(() => {})
    }
    if (fsSync.existsSync(runRoot) && path.dirname(path.resolve(runRoot)) === path.resolve(tempRoot)
      && path.basename(runRoot).startsWith('vibepaper-native-form-agnes-')
      && !fsSync.lstatSync(runRoot).isSymbolicLink()
      && path.relative(path.resolve(runRoot), fsSync.realpathSync(runRoot)) === '') {
      console.error(`Isolated run retained for recovery: ${runRoot}`)
    }
    console.error(`Acceptance summary: ${reportPath}`)
    console.error(safe)
    process.exitCode = 1
  } finally {
    process.off('SIGINT', requestStop)
    process.off('SIGTERM', requestStop)
  }
}

function workerMain() {
  const { app, BrowserWindow, dialog, protocol, safeStorage } = require('electron')
  const { createLocalProjectStore } = require('../src/project-store.cjs')
  const args = process.argv.slice(2)
  const runRoot = path.resolve(args[args.indexOf('--run-root') + 1] || '')
  const timeoutMs = Number(args[args.indexOf('--timeout-ms') + 1])
  let setupKey = process.env[keyEnvName]
  const profilePath = path.join(runRoot, 'VibePaper')
  const projectParent = path.join(runRoot, 'project')
  let projectDirectory = null
  let projectDataDirectory = null
  const readyPath = path.join(runRoot, 'ready.json')
  const statusPath = path.join(runRoot, 'status.json')
  const resultPath = path.join(runRoot, 'result.json')
  const stopPath = path.join(runRoot, 'stop.request')
  const decisionsPath = path.join(runRoot, 'confirmation-decisions.json')
  const originalGetPath = app.getPath.bind(app)
  if (!runRoot.startsWith(`${path.resolve(tempRoot)}${path.sep}`)
    || !path.basename(runRoot).startsWith('vibepaper-native-form-agnes-')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > maxTimeoutMs
    || !safeKey(setupKey)) throw new Error('worker_arguments_invalid')
  delete process.env[keyEnvName]
  assertIsolatedRunRoot(runRoot)
  for (const directory of [profilePath, path.join(runRoot, 'Temp'), path.join(runRoot, 'LocalAppData')]) {
    const stat = fsSync.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, fsSync.realpathSync(directory)) !== '') {
      throw new Error('private_profile_path_invalid')
    }
  }
  app.setPath('userData', profilePath)
  app.getPath = (name) => name === 'appData' ? runRoot : originalGetPath(name)
  protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: {
    standard: true, secure: true, supportFetchAPI: true, stream: true,
  } }])
  protocol.registerSchemesAsPrivileged = () => {}

  let window = null
  let project = null
  let grantClientId = null
  let providerModelIds = { image: null, video: null }
  let mcpEnabled = false
  let providerConfigured = false
  let closing = false
  let ready = false
  let allowQuit = false
  let timer = null
  let stopPoll = null
  let phase = 'worker-bootstrap'
  let failureDetails = null
  const startedAt = new Date().toISOString()
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  for (const method of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox']) {
    dialog[method] = () => { throw new Error('unexpected_native_dialog') }
  }
  app.on('browser-window-created', (_event, created) => { window = created })

  async function evaluate(source) {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null
    return window.webContents.executeJavaScript(source)
  }
  async function waitFor(source, ms = 180_000) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (window && !window.isDestroyed() && !window.webContents.isLoading()
        && await evaluate(source).catch(() => false)) return
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('original_canvas_wait_timeout')
  }
  async function prepareProject() {
    await fs.mkdir(profilePath, { recursive: true })
    await fs.mkdir(projectParent, { recursive: true })
    const store = createLocalProjectStore()
    try {
      const opened = await store.createProject(projectParent, 'Codex Agnes Native Media Acceptance')
      await store.createNode({ projectId: opened.project.projectId, canvasId: opened.project.canvasId,
        expectedVersion: 0, type: 'text', params: { content: 'Agnes native media acceptance reference: blue ceramic cube in a white studio, soft natural shadow, no text.' },
        x: 180, y: 180, idempotencyKey: `native-agnes-seed-${randomUUID()}` })
      project = opened.project
      projectDirectory = opened.directory
      projectDataDirectory = path.join(opened.directory, '.vibepaper')
      await fs.writeFile(path.join(profilePath, 'recent-project.json'), JSON.stringify({
        schemaVersion: 1, projectDirectory: opened.directory,
      }))
    } finally { await store.close() }
  }
  async function saveProviderKeyAndDefaults() {
    let key = setupKey
    try {
      // The preload IPC validates the trusted renderer and provider-settings
      // encrypts credentials with Electron safeStorage. Do not persist input.
      await evaluate(`window.vibepaperDesktop.saveAgnesApiKey(${JSON.stringify(key)})`)
    } finally { key = ''; setupKey = '' }
    const current = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
    const provider = current?.providers?.find((item) => item.id === 'agnes')
    const image = current?.models?.find((item) => item.providerId === 'agnes'
      && item.modelType === 'image' && (item.displayName || item.name) === 'Agnes Image 2.5 Flash')
    const video = current?.models?.find((item) => item.providerId === 'agnes'
      && item.modelType === 'video' && (item.displayName || item.name) === 'Agnes Video 2.5 Flash')
    if (!provider || !image?.implemented || !video?.implemented
      || (image.displayName || image.name) !== 'Agnes Image 2.5 Flash'
      || (video.displayName || video.name) !== 'Agnes Video 2.5 Flash') throw new Error('AGNES_MODELS_UNAVAILABLE')
    const enabledModelIds = [...new Set([...(provider.enabledModelIds || []), image.id, video.id])]
    const saved = await evaluate(`window.vibepaperDesktop.saveProviderConfiguration(${JSON.stringify({
      providerId: 'agnes', expectedRevision: provider.revision, baseUrl: provider.baseUrl,
      enabledModelIds, defaultModelIds: { ...(provider.defaultModelIds || {}), image: image.id, video: video.id },
      modelDefaults: provider.modelDefaults || {}, timeoutSeconds: provider.timeoutSeconds || 180,
    })})`)
    const verifiedProvider = saved?.providers?.find((item) => item.id === 'agnes')
    const verified = ['image', 'video'].every((modality) => {
      const id = modality === 'image' ? image.id : video.id
      return verifiedProvider?.enabledModelIds?.includes(id) && verifiedProvider?.defaultModelIds?.[modality] === id
        && saved.models?.some((item) => item.id === id && item.enabled)
    })
    if (!verified || !verifiedProvider?.configured) throw new Error('AGNES_MODELS_NOT_ENABLED')
    providerConfigured = true
    providerModelIds = { image: image.id, video: video.id }
    return { imageModel: image.displayName || image.name, imageModelId: image.id,
      videoModel: video.displayName || video.name, videoModelId: video.id }
  }
  async function inspectOriginalNodeMedia(nodeId, modality) {
    if (!nodeId || !['image', 'video'].includes(modality)) return { nodeRendered: false, mediaElementPresent: false,
      displayedInOriginalNode: false }
    const expression = `(() => {
      const root = document.querySelector('[data-testid=mcp-canvas-page]')
      const nodeSelector = '.react-flow__node[data-id="' + CSS.escape(${JSON.stringify(String(nodeId))}) + '"]'
      const node = root?.querySelector(nodeSelector)
      const selector = ${JSON.stringify(modality === 'image' ? 'img[src^="vibe://"]' : 'video[src^="vibe://"]')}
      const element = node?.querySelector(selector)
      if (!root || !node || !element) return { nodeRendered: Boolean(node), mediaElementPresent: Boolean(element), displayedInOriginalNode: false }
      const rect = node.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      const style = getComputedStyle(node)
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
        && rect.width > 0 && rect.height > 0 && rect.right > Math.max(0, rootRect.left)
        && rect.left < Math.min(innerWidth, rootRect.right) && rect.bottom > Math.max(0, rootRect.top)
        && rect.top < Math.min(innerHeight, rootRect.bottom)
      const mediaLoaded = ${modality === 'image'
        ? 'element.complete && element.naturalWidth > 0 && element.naturalHeight > 0'
        : 'element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0 && Number.isFinite(element.duration) && element.duration > 0'}
      return { nodeRendered: true, mediaElementPresent: true, displayedInOriginalNode: Boolean(visible && mediaLoaded),
        mediaLoaded: Boolean(mediaLoaded), currentSrcIsVibeScheme: element.currentSrc.startsWith('vibe://'),
        ${modality === 'image' ? 'complete: element.complete, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight'
          : 'readyState: element.readyState, videoWidth: element.videoWidth, videoHeight: element.videoHeight, duration: Number.isFinite(element.duration) ? element.duration : null'} }
    })()`
    try { return await evaluate(expression) || { nodeRendered: false, mediaElementPresent: false, displayedInOriginalNode: false } }
    catch { return { nodeRendered: false, mediaElementPresent: false, displayedInOriginalNode: false } }
  }
  async function canvasAndTaskSnapshot() {
    let loaded = null
    let tasks = []
    try {
      loaded = await evaluate(`window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)})`)
    } catch { /* final summary reports empty/unavailable state */ }
    try {
      const response = await evaluate(`window.vibepaperDesktop.listTasks(${JSON.stringify(project.projectId)}, 500)`)
      tasks = Array.isArray(response) ? response : response?.tasks || []
    } catch { tasks = [] }
    const nodes = Array.isArray(loaded?.nodes) ? loaded.nodes : []
    const edges = Array.isArray(loaded?.edges) ? loaded.edges : []
    const safeNodes = nodes.map((node) => ({ nodeId: node.id, type: node.type }))
    const safeTasks = []
    for (const task of tasks) {
      const outputs = []
      for (const output of Array.isArray(task.outputs) ? task.outputs : []) {
        const relativePath = typeof output.outputPath === 'string' ? output.outputPath : null
        let file = { verified: false }
        if (relativePath && !path.isAbsolute(relativePath) && !relativePath.split(/[\\/]/u).includes('..')) {
          const absolute = path.resolve(projectDataDirectory, relativePath)
          const relative = path.relative(projectDataDirectory, absolute)
          if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            try {
              const stat = await fs.lstat(absolute)
              if (stat.isFile() && !stat.isSymbolicLink()) {
                const digest = crypto.createHash('sha256')
                for await (const chunk of fsSync.createReadStream(absolute)) digest.update(chunk)
                const sha256 = digest.digest('hex')
                file = { verified: sha256 === output.sha256 && stat.size === output.sizeBytes,
                  filename: path.basename(absolute), sizeBytes: stat.size, sha256 }
              }
            } catch { file = { verified: false } }
          }
        }
        outputs.push({ index: Number.isSafeInteger(output.index) ? output.index : outputs.length, ...file })
      }
      safeTasks.push({ taskId: task.taskId || task.id || null, nodeId: task.nodeId || null,
        modality: ['image', 'video'].includes(task.modality) ? task.modality : 'unknown',
        providerId: task.providerId === 'agnes' ? 'agnes' : null,
        modelId: Object.values(providerModelIds).includes(task.modelId) ? task.modelId : null,
        status: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.status) ? task.status : 'unknown',
        errorCode: typeof task.errorCode === 'string' && /^[A-Z0-9_-]{1,80}$/u.test(task.errorCode) ? task.errorCode : null,
        outputs, originalNodeMedia: await inspectOriginalNodeMedia(task.nodeId, task.modality) })
    }
    return { nodes: safeNodes, edgeCount: edges.length, tasks: safeTasks }
  }
  async function readConfirmationDecisions(tasks) {
    let parsed = null
    try { parsed = JSON.parse(await fs.readFile(decisionsPath, 'utf8')) } catch { /* optional launcher report */ }
    const valid = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).every((key) => ['image', 'video'].includes(key))
      && ['image', 'video'].every((key) => parsed[key] === undefined
        || ['accepted', 'rejected', 'uncompleted'].includes(parsed[key]))
    return Object.fromEntries(['image', 'video'].map((modality) => {
      const taskCount = tasks.filter((task) => task.modality === modality).length
      const explicit = valid && parsed[modality]
      return [modality, { decision: explicit || (taskCount ? 'not_observed' : 'uncompleted'),
        evidence: explicit ? 'launcher_or_operator_report' : taskCount ? 'persisted_task_submission' : 'no_task_submission_observed',
        taskCount }]
    }))
  }
  async function writeStatus(final = false, reason = null, cleanup = {}) {
    const snapshot = await canvasAndTaskSnapshot().catch(() => ({ nodes: [], edgeCount: 0, tasks: [] }))
    const value = { schemaVersion: 1, testType: 'manual-codex-tui-agnes-image-video-media-acceptance-host',
      status: final ? (['operator_stopped', 'timeout', 'application_window_closed'].includes(reason) ? 'finished' : 'failed')
        : ready ? 'waiting_for_manual_codex_tui' : 'preparing',
      startedAt, finishedAt: final ? new Date().toISOString() : null, finishReason: final ? reason : null,
      provider: 'agnes', models: providerModelIds,
      modelLabels: { image: 'Agnes Image 2.5 Flash', video: 'Agnes Video 2.5 Flash' },
      providerKeyInput: 'hidden_stdin_to_desktop_safeStorage_ipc', providerCredentialSaved: providerConfigured,
      naturalLanguageProviderConfigurationAcceptance: false, providerConnectionTest: 'not_run_no_network_request',
      realGenerationRequestsStartedByHost: 0, generationSubmissionStartedByHost: false,
      profileIsolated: true, projectIsolated: true, serverName, keyInToml: false,
      nodes: snapshot.nodes, edgeCount: snapshot.edgeCount, tasks: snapshot.tasks,
      confirmationDecisions: final ? await readConfirmationDecisions(snapshot.tasks) : null,
      failure: failureDetails, cleanup: final ? cleanup : null }
    const target = final ? resultPath : statusPath
    const temporary = `${target}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    await fs.rename(temporary, target)
    return value
  }
  async function cleanup(reason) {
    if (closing) return
    closing = true
    if (timer) clearTimeout(timer)
    if (stopPoll) clearInterval(stopPoll)
    let credentialCleared = false
    let grantRevoked = false
    let mcpDisabled = false
    if (window && !window.isDestroyed()) {
      try {
        const current = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
        const provider = current?.providers?.find((item) => item.id === 'agnes')
        if (provider?.configured) {
          await evaluate(`window.vibepaperDesktop.clearProviderConfiguration('agnes', ${provider.revision})`)
          const after = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
          credentialCleared = after?.providers?.find((item) => item.id === 'agnes')?.configured === false
        } else credentialCleared = true
      } catch { credentialCleared = false }
      try {
        const state = await evaluate('window.vibepaperDesktop.getMcpState()')
        const candidates = state?.clients?.filter((entry) => entry.clientName === 'codex'
          && entry.displayName === 'Codex native Agnes media acceptance' && !entry.revokedAt) || []
        if (grantClientId && !candidates.some((entry) => entry.clientId === grantClientId)) {
          candidates.push({ clientId: grantClientId })
        }
        for (const candidate of candidates) {
          await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(candidate.clientId)})`)
        }
        const after = await evaluate('window.vibepaperDesktop.getMcpState()')
        grantRevoked = (after?.clients || []).filter((entry) => entry.clientName === 'codex'
          && entry.displayName === 'Codex native Agnes media acceptance').every((entry) => Boolean(entry.revokedAt))
      } catch { grantRevoked = false }
      try {
        await evaluate('window.vibepaperDesktop.setMcpEnabled(false)')
        mcpDisabled = (await evaluate('window.vibepaperDesktop.getMcpState()'))?.enabled === false
      } catch { mcpDisabled = false }
    } else {
      credentialCleared = false
      grantRevoked = !grantClientId
      mcpDisabled = !mcpEnabled
    }
    const result = await writeStatus(true, reason, { providerCredentialCleared: credentialCleared,
      grantRevoked, mcpDisabled, isolatedProfileRetainedForRecovery: true })
    allowQuit = true
    app.quit()
    return result
  }
  app.on('before-quit', (event) => {
    if (!allowQuit && !closing) { event.preventDefault(); void cleanup('application_window_closed') }
  })

  async function run() {
    phase = 'prepare-project'
    await prepareProject()
    phase = 'load-desktop-main'
    require('../src/main.cjs')
    phase = 'wait-for-app-ready'
    await app.whenReady()
    phase = 'check-secure-storage'
    if (!safeStorage.isEncryptionAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE')
    phase = 'wait-for-original-canvas'
    await waitFor("location.pathname === '/workspace' && document.querySelector('[role=button]')")
    await evaluate("document.querySelector('[role=button]').click()")
    await waitFor(`location.pathname === ${JSON.stringify(`/canvas/${project.canvasId}`)} && document.querySelector('[data-testid=mcp-canvas-page] .react-flow__node')`)
    await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')
    phase = 'save-key-through-safe-storage-ipc-and-enable-models'
    const configuredModels = await saveProviderKeyAndDefaults()
    phase = 'enable-mcp'
    const enabled = await evaluate('window.vibepaperDesktop.setMcpEnabled(true)')
    if (enabled?.enabled !== true) throw new Error('MCP_ENABLE_FAILED')
    mcpEnabled = true
    phase = 'create-scoped-client-grant'
    const state = await evaluate('window.vibepaperDesktop.getMcpState()')
    const grant = await evaluate(`window.vibepaperDesktop.createMcpClientGrant(${JSON.stringify({
      clientName: 'codex', displayName: 'Codex native Agnes media acceptance',
      permissions: ['canvas.read', 'canvas.write', 'generation.propose', 'task.read', 'media.read', 'provider.read'],
      providerGrants: [{ providerId: 'agnes', credentialFields: [], credentialInputModes: [], authorizedEnv: [] }],
      mediaTypes: ['image', 'video'], disclosureVersion: state.connectionDisclosureVersion || 'desktop-mcp-provider-disclosure-v1',
      accepted: true,
    })})`)
    if (typeof grant?.config?.codex !== 'string') throw new Error('CODEX_CONFIG_MISSING')
    const clientState = await evaluate('window.vibepaperDesktop.getMcpState()')
    const client = clientState?.clients?.find((entry) => entry.clientName === 'codex'
      && entry.displayName === 'Codex native Agnes media acceptance' && !entry.revokedAt)
    if (!client) throw new Error('MCP_GRANT_MISSING')
    grantClientId = client.clientId
    phase = 'write-secret-free-codex-config'
    const exported = parseDesktopCodexConfig(grant.config.codex)
    const expectedInstance = path.join(runRoot, 'VibePaper', 'mcp-instance.json')
    const instanceIndex = exported.args.indexOf('--mcp-instance-file')
    if (instanceIndex < 0 || path.resolve(exported.args[instanceIndex + 1] || '') !== path.resolve(expectedInstance)) {
      throw new Error('MCP_INSTANCE_PATH_INVALID')
    }
    const codexConfigDirectory = path.join(projectDirectory, '.codex')
    await fs.mkdir(codexConfigDirectory, { recursive: true })
    const codexTomlPath = path.join(codexConfigDirectory, 'config.toml')
    await fs.writeFile(codexTomlPath, createCodexToml({ command: exported.command, args: exported.args,
      appDataRoot: runRoot, serverName, tools: enabledTools }), { flag: 'wx' })
    const toml = await fs.readFile(codexTomlPath, 'utf8')
    if (/api.?key|secret|password|credential\s*=|VIBEPAPER_QA_AGNES_SETUP_KEY/iu.test(toml)) {
      throw new Error('SECRET_FOUND_IN_CODEX_CONFIG')
    }
    ready = true
    const readyValue = { schemaVersion: 1, startedAt, runId: path.basename(runRoot),
      profilePath, projectPath: projectDirectory, projectDataPath: projectDataDirectory,
      projectId: project.projectId, canvasId: project.canvasId,
      codexTomlPath, serverName, timeoutMs, keyInputTransport: 'hidden_stdin_to_desktop_safeStorage_ipc',
      keyInToml: false, provider: 'agnes', configuredModels,
      naturalLanguageProviderConfigurationAcceptance: false,
      providerConnectionTest: 'not_run_no_network_request', realGenerationRequestsStartedByHost: 0,
      generationSubmissionStartedByHost: false, stopPath, confirmationDecisionsPath: decisionsPath,
      confirmationDecisionFormat: { image: 'accepted|rejected|uncompleted', video: 'accepted|rejected|uncompleted' } }
    await fs.writeFile(readyPath, `${JSON.stringify(readyValue, null, 2)}\n`, { flag: 'wx' })
    await writeStatus(false)
    phase = 'waiting-for-stop-or-timeout'
    timer = setTimeout(() => { void cleanup('timeout') }, timeoutMs)
    timer.unref()
    stopPoll = setInterval(async () => {
      try { await fs.access(stopPath); void cleanup('operator_stopped') }
      catch { await writeStatus(false).catch(() => {}) }
    }, 1500)
    stopPoll.unref()
  }
  run().catch(async (error) => {
    const errorCode = safeError(error)
    failureDetails = { errorCode, ...safeErrorMetadata(error, phase) }
    await cleanup(errorCode)
    if (!ready) app.exit(1)
  })
}

function isDirectElectronWorkerEntry() {
  if (!process.versions?.electron || process.type !== 'browser' || !process.argv.includes('--worker')) return false
  try { return fsSync.realpathSync(process.argv[1]) === fsSync.realpathSync(__filename) } catch { return false }
}

if (isDirectElectronWorkerEntry()) {
  try { workerMain() } catch (error) {
    const runRoot = path.resolve(process.argv[process.argv.indexOf('--run-root') + 1] || '')
    const code = safeError(error)
    if (runRoot.startsWith(`${path.resolve(tempRoot)}${path.sep}`)
      && path.basename(runRoot).startsWith('vibepaper-native-form-agnes-')) {
      fsSync.writeFileSync(path.join(runRoot, 'result.json'), `${JSON.stringify({ schemaVersion: 1,
        status: 'failed', errorCode: code, profileIsolated: true, keyInToml: false,
        providerKeyInEvidence: false, failure: { errorCode: code,
          ...safeErrorMetadata(error, 'worker-bootstrap-sync') } }, null, 2)}\n`)
    }
    try { require('electron').app?.exit(1) } catch { process.exitCode = 1 }
  }
}
else if (require.main === module) controllerMain().catch((error) => {
  console.error(safeError(error))
  process.exitCode = 1
})
else module.exports = { parseTimeout, safeKey, readSecretNoEcho }
