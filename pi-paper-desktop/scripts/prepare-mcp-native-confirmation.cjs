// Prepare an isolated, visible VibePaper Main/Canvas instance for a manual
// Codex MCP form-elicitation check. This script never calls prepare_generation
// or answers a client confirmation. The generated TOML contains no API key.
const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { spawn, execFileSync } = require('node:child_process')

const repositoryRoot = path.resolve(__dirname, '../..')
const desktopRoot = path.join(repositoryRoot, 'pi-paper-desktop')
const temporaryRoot = path.join(repositoryRoot, '.test-temp')
const serverName = 'vibepaper_native_acceptance'
const acceptancePermissions = ['canvas.read', 'canvas.write', 'generation.propose', 'task.read']
const enabledTools = [
  'get_context', 'get_operation', 'get_canvas_summary', 'get_selected_nodes', 'get_node_detail',
  'list_models', 'create_nodes', 'update_node_config', 'connect_nodes', 'layout_nodes',
  'prepare_generation', 'check_task_status', 'read_task_output',
]
const defaultTimeoutMs = 10 * 60 * 1000
const maxRuntimeMs = 30 * 60 * 1000

function assertRunDirectory(candidate) {
  const root = path.resolve(temporaryRoot)
  const resolved = path.resolve(candidate)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(resolved).startsWith('vibepaper-native-form-')) {
    throw new Error('unsafe_test_directory')
  }
  return resolved
}

function parseTimeout(argv) {
  const index = argv.indexOf('--timeout-ms')
  if (index < 0) return defaultTimeoutMs
  const value = Number(argv[index + 1])
  if (index + 2 !== argv.length || !Number.isSafeInteger(value) || value < 60_000 || value > maxRuntimeMs) {
    throw new Error('timeout_must_be_between_60000_and_1800000_ms')
  }
  return value
}

function safeEnvironment(appDataRoot) {
  const environment = {}
  for (const name of [
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP',
  ]) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name]
  }
  environment.APPDATA = appDataRoot
  environment.LOCALAPPDATA = path.join(appDataRoot, 'LocalAppData')
  environment.TEMP = path.join(appDataRoot, 'Temp')
  environment.TMP = path.join(appDataRoot, 'Temp')
  return environment
}

function tomlString(value) {
  return JSON.stringify(value)
}

function parseDesktopCodexConfig(configText) {
  const section = String(configText).match(/^\[mcp_servers\.vibepaper\][ \t]*\r?\n([\s\S]*?)^\[mcp_servers\.vibepaper\.env\][ \t]*$/mu)
  if (!section) throw new Error('desktop_codex_config_invalid')
  const commandLine = section[1].match(/^command\s*=\s*(.+)$/mu)?.[1]
  const argsLine = section[1].match(/^args\s*=\s*(.+)$/mu)?.[1]
  if (!commandLine || !argsLine) throw new Error('desktop_codex_config_invalid')
  let command
  let args
  try {
    command = JSON.parse(commandLine)
    args = JSON.parse(argsLine)
  } catch {
    throw new Error('desktop_codex_config_invalid')
  }
  if (typeof command !== 'string' || !path.isAbsolute(command) || !Array.isArray(args)
    || args.some((argument) => typeof argument !== 'string')) {
    throw new Error('desktop_codex_config_invalid')
  }
  const instanceIndex = args.indexOf('--mcp-instance-file')
  if (instanceIndex < 0 || !path.isAbsolute(args[instanceIndex + 1] || '')) {
    throw new Error('mcp_instance_path_invalid')
  }
  return { command, args }
}

function createCodexToml({ command, args, appDataRoot }) {
  const argsToml = args.map(tomlString).join(', ')
  const toolsToml = enabledTools.map(tomlString).join(', ')
  return [
    '# Local MCP form-elicitation acceptance only. No provider key is configured.',
    '# APPDATA points to this run\'s isolated profile so the production bridge can validate its instance file.',
    `[mcp_servers.${serverName}]`,
    `command = ${tomlString(command)}`,
    `args = [${argsToml}]`,
    `enabled_tools = [${toolsToml}]`,
    'default_tools_approval_mode = "approve"',
    'tool_timeout_sec = 660',
    'startup_timeout_sec = 150',
    '',
    `[mcp_servers.${serverName}.env]`,
    'ELECTRON_RUN_AS_NODE = "1"',
    `APPDATA = ${tomlString(appDataRoot)}`,
    '',
  ].join('\n')
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  return fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), { flag: 'wx' })
    .then(() => fs.rename(temporaryPath, filePath))
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
  } else {
    child.kill('SIGTERM')
  }
}

async function controllerMain() {
  const timeoutMs = parseTimeout(process.argv.slice(2))
  await fs.mkdir(temporaryRoot, { recursive: true })
  const runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`
  const resumeIndex = process.argv.indexOf('--resume-run')
  const resume = resumeIndex >= 0
  const runRoot = assertRunDirectory(resume ? process.argv[resumeIndex + 1]
    : path.join(temporaryRoot, `vibepaper-native-form-${runId}`))
  const appDataRoot = runRoot
  const readyPath = path.join(runRoot, 'ready.json')
  const statusPath = path.join(runRoot, 'status.json')
  const resultPath = path.join(runRoot, 'result.json')
  const stopPath = path.join(runRoot, 'stop.request')
  if (resume) {
    if (fsSync.lstatSync(runRoot).isSymbolicLink() || path.relative(runRoot, fsSync.realpathSync(runRoot)) !== '') {
      throw new Error('unsafe_resume_directory')
    }
    if (fsSync.existsSync(resultPath) || fsSync.existsSync(stopPath)) throw new Error('completed_fixture_cannot_resume')
    await fs.access(path.join(runRoot, 'codex-native-confirmation.toml'))
    await fs.rm(readyPath, { force: true })
  } else {
    await fs.mkdir(runRoot, { recursive: true })
    protectRunDirectory(runRoot)
  }

  let electronPath
  try { electronPath = await resolveElectronPath() } catch (error) {
    console.error(error.message)
    process.exitCode = 1
    return
  }

  const workerPath = path.resolve(__filename)
  const environment = safeEnvironment(appDataRoot)
  const child = spawn(electronPath, [workerPath, '--worker', ...(resume ? ['--resume-run', runRoot] : []), '--run-root', runRoot,
    '--timeout-ms', String(timeoutMs)], {
    cwd: desktopRoot,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  })

  let exitResult = null
  const closed = new Promise((resolve) => child.once('close', (code, signal) => {
    exitResult = { code, signal }
    resolve(exitResult)
  }))
  const requestStop = () => { void fs.writeFile(stopPath, 'stop\n').catch(() => {}) }
  process.once('SIGINT', requestStop)
  process.once('SIGTERM', requestStop)

  try {
    const ready = await Promise.race([
      waitForFile(readyPath, 180_000),
      closed.then(async () => {
        const failed = await fs.readFile(resultPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null)
        if (failed) return { startupFailure: failed.errorCode || 'desktop_worker_exited_early' }
        throw new Error('desktop_worker_exited_before_ready')
      }),
    ])
    if (ready.startupFailure) throw new Error(ready.startupFailure)
    console.log('Isolated VibePaper Main/Canvas is open and ready for the manual Codex check.')
    console.log(`Profile: ${ready.profilePath}`)
    console.log(`Fixture canvas: ${ready.projectPath}`)
    console.log(`Secret-free Codex TOML: ${ready.codexTomlPath}`)
    console.log(`Codex MCP server name: ${serverName}`)
    console.log('The MCP server has only canvas.read, canvas.write, generation.propose, and task.read.')
    console.log('Use the snippet in the intended project-local Codex MCP configuration, restart only this server, then ask the assistant to prepare one local text proposal.')
    console.log('When the native Codex form appears, choose Reject or cancel. Do not accept the generation.')
    console.log('The original VibePaper window stays visible. This harness records counts and states only; stop with Ctrl+C, or wait for the timeout.')

    const timeoutGuard = setTimeout(requestStop, timeoutMs + 30_000)
    timeoutGuard.unref()
    await closed
    clearTimeout(timeoutGuard)
    const result = await fs.readFile(resultPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null)
    if (result) {
      console.log(`Result: ${resultPath}`)
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(JSON.stringify({ success: false, errorCode: 'desktop_worker_exit_without_result', ...exitResult }))
      process.exitCode = 1
    }
  } catch (error) {
    requestStop()
    const settled = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))])
    if (!settled) await stopProcessTree(child)
    console.error(error?.message && /^[a-z0-9_-]{1,80}$/iu.test(error.message) ? error.message : 'native_form_harness_failed')
    process.exitCode = 1
  } finally {
    process.off('SIGINT', requestStop)
    process.off('SIGTERM', requestStop)
  }
}

function protectRunDirectory(runRoot) {
  const resolved = path.resolve(runRoot)
  if (path.dirname(resolved) !== temporaryRoot
    || !/^(vibepaper-native-form-|mcp-video-recovery-)/u.test(path.basename(resolved))
    || fsSync.lstatSync(resolved).isSymbolicLink()
    || path.relative(resolved, fsSync.realpathSync(resolved)) !== '') {
    throw new Error('unsafe_private_test_directory')
  }
  // This checkout may inherit broader access than AppData. Restrict only this
  // newly created QA directory before Main writes a connection credential.
  if (process.platform === 'win32') {
    const script = `try {
$ErrorActionPreference = 'Stop'
$target = $env:VIBEPAPER_QA_PRIVATE_PROFILE
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($owner)
foreach ($sid in @($owner, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target -AclObject $acl
if (!(Get-Acl -LiteralPath $target).AreAccessRulesProtected) { throw 'private_profile_failed' }
Write-Output 'QA_PROFILE_PRIVATE'
exit 0
} catch { exit 1 }

`
    const output = execFileSync(path.join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', '-'], { input: script,
        env: { ...safeEnvironment(runRoot), VIBEPAPER_QA_PRIVATE_PROFILE: runRoot },
        windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    if (!output.includes('QA_PROFILE_PRIVATE')) throw new Error('private_profile_failed')
  }

}

function workerMain() {
  const args = process.argv.slice(2)
  const runRoot = path.resolve(args[args.indexOf('--run-root') + 1] || '')
  assertRunDirectory(runRoot)
  const timeoutMs = Number(args[args.indexOf('--timeout-ms') + 1])
  const resume = args.includes('--resume-run')
  if (!runRoot || !Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > maxRuntimeMs) {
    throw new Error('worker_arguments_invalid')
  }

  const electron = require('electron')
  const { app, BrowserWindow, dialog, protocol } = electron
  const { createServer } = require('node:http')
  const assert = require('node:assert/strict')
  const { createLocalProjectStore } = require('../src/project-store.cjs')

  const profilePath = path.join(runRoot, 'VibePaper')
  const projectPath = path.join(runRoot, 'project')
  const readyPath = path.join(runRoot, 'ready.json')
  const statusPath = path.join(runRoot, 'status.json')
  const resultPath = path.join(runRoot, 'result.json')
  const stopPath = path.join(runRoot, 'stop.request')
  const originalGetPath = app.getPath.bind(app)
  app.setPath('userData', profilePath)
  app.getPath = (name) => name === 'appData' ? runRoot : originalGetPath(name)
  protocol.registerSchemesAsPrivileged([{
    scheme: 'vibe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }])
  // Main is loaded after asynchronous fixture preparation, past Electron ready.
  // The exact production scheme has already been registered synchronously.
  protocol.registerSchemesAsPrivileged = () => {}

  let window = null
  let localModelServer = null
  let grantClientId = null
  let fixtureGenerationRequests = 0
  let fixtureModelListRequests = 0
  let desktopConfirmationVisibleAtAnyPoint = false
  let grantRevoked = false
  let mcpDisabled = false
  let fixtureListenerClosed = false
  let ready = false
  let closing = false
  let allowQuit = false
  let timer = null
  let stopPoll = null
  let project = null
  let observedStatus = {
    taskStatusCounts: {},
    pendingDesktopActionCount: 0,
    codexGrantConnected: false,
    desktopConfirmationVisibleAtAnyPoint: false,
    fixtureGenerationRequests: 0,
    fixtureModelListRequests: 0,
  }
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

  async function waitFor(source, timeoutMs = 150_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (window && !window.isDestroyed() && !window.webContents.isLoading()
        && await evaluate(source).catch(() => false)) return
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('original_canvas_wait_timeout')
  }

  async function prepareProject() {
    if (resume) {
      if (fsSync.lstatSync(runRoot).isSymbolicLink() || path.relative(runRoot, fsSync.realpathSync(runRoot)) !== '') {
        throw new Error('unsafe_resume_directory')
      }
      const recent = JSON.parse(await fs.readFile(path.join(profilePath, 'recent-project.json'), 'utf8'))
      if (path.dirname(path.resolve(recent.projectDirectory)) !== projectPath) throw new Error('unsafe_resume_project')
      const { DatabaseSync } = require('node:sqlite')
      const database = new DatabaseSync(path.join(recent.projectDirectory, '.vibepaper/project.sqlite'), { readOnly: true })
      try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0) } finally { database.close() }
      const store = createLocalProjectStore()
      try { project = (await store.openProject(recent.projectDirectory)).project } finally { await store.close() }
      return
    }
    await fs.mkdir(profilePath, { recursive: true })
    await fs.mkdir(projectPath, { recursive: true })
    const store = createLocalProjectStore()
    try {
      const opened = await store.createProject(projectPath, 'Native Codex Form Local Fixture')
      await store.createNode({
        projectId: opened.project.projectId,
        canvasId: opened.project.canvasId,
        expectedVersion: 0,
        type: 'text',
        params: { content: 'Native Codex form local fixture target' },
        x: 180,
        y: 180,
        idempotencyKey: `native-form-seed-${randomUUID()}`,
      })
      project = opened.project
      await fs.writeFile(path.join(profilePath, 'recent-project.json'), JSON.stringify({
        schemaVersion: 1,
        projectDirectory: opened.directory,
      }))
    } finally {
      await store.close()
    }
  }

  async function startLocalTextFixture() {
    localModelServer = createServer((request, response) => {
      const handle = async () => {
        if (request.method === 'GET' && request.url === '/v1/models') {
          fixtureModelListRequests += 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ object: 'list', data: [{ id: 'native-confirmation-fixture-text', object: 'model' }] }))
          return
        }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          response.writeHead(404)
          response.end()
          return
        }
        let receivedBytes = 0
        for await (const chunk of request) {
          receivedBytes += chunk.length
          if (receivedBytes > 1024 * 1024) {
            response.writeHead(413)
            response.end()
            return
          }
        }
        fixtureGenerationRequests += 1
        const content = 'Local acceptance fixture: fixed text only.'
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: 'native-form-fixture',
          object: 'chat.completion',
          model: 'native-confirmation-fixture-text',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
      }
      void handle().catch(() => {
        if (!response.destroyed && !response.writableEnded) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 'LOCAL_FIXTURE_FAILED' } }))
        }
      })
    })
    await new Promise((resolve, reject) => {
      localModelServer.once('error', reject)
      localModelServer.listen(0, '127.0.0.1', resolve)
    })
    return `http://127.0.0.1:${localModelServer.address().port}/v1`
  }

  async function statusSnapshot() {
    let taskStatusCounts = {}
    let pendingDesktopActionCount = 0
    let codexGrantConnected = false
    let desktopConfirmationVisible = false
    try {
      const tasksResponse = await evaluate(`window.vibepaperDesktop.listTasks(${JSON.stringify(project.projectId)}, 100)`)
      const tasks = Array.isArray(tasksResponse) ? tasksResponse : tasksResponse?.tasks || []
      for (const task of tasks) {
        const status = typeof task?.status === 'string' ? task.status : typeof task?.state === 'string' ? task.state : 'unknown'
        const safeStatus = ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status) ? status : 'unknown'
        taskStatusCounts[safeStatus] = (taskStatusCounts[safeStatus] || 0) + 1
      }
    } catch { taskStatusCounts = {} }
    try {
      const actionsResponse = await evaluate('window.vibepaperDesktop.getMcpPendingActions()')
      const actions = Array.isArray(actionsResponse) ? actionsResponse : actionsResponse?.actions || []
      pendingDesktopActionCount = actions.filter((action) => ['awaiting_pairing', 'awaiting_disclosure', 'awaiting_desktop_input']
        .includes(action?.status)).length
    } catch { pendingDesktopActionCount = 0 }
    try {
      const state = await evaluate('window.vibepaperDesktop.getMcpState()')
      codexGrantConnected = Boolean(state?.clients?.some((client) => client.clientName === 'codex'
        && client.displayName === 'Native Codex Form Acceptance' && !client.revokedAt && client.connected === true))
    } catch { codexGrantConnected = false }
    try {
      desktopConfirmationVisible = Boolean(await evaluate(`(() => {
        const element = document.querySelector('[data-testid="mcp-generation-confirmation"]')
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
          && rect.width > 0 && rect.height > 0
      })()`))
    } catch { desktopConfirmationVisible = false }
    desktopConfirmationVisibleAtAnyPoint ||= desktopConfirmationVisible
    observedStatus = {
      taskStatusCounts,
      pendingDesktopActionCount,
      codexGrantConnected,
      desktopConfirmationVisibleAtAnyPoint,
      fixtureGenerationRequests,
      fixtureModelListRequests,
    }
    return observedStatus
  }

  async function writeStatus(final = false, reason = null, cleanup = {}) {
    const snapshot = await statusSnapshot().catch(() => observedStatus)
    const result = {
      schemaVersion: 1,
      testType: 'manual-native-codex-mcp-form-elicitation',
      status: final ? 'finished' : ready ? 'waiting_for_manual_codex_action' : 'preparing',
      finishReason: final ? reason : null,
      startedAt,
      finishedAt: final ? new Date().toISOString() : null,
      serverName,
      profileIsolated: true,
      originalMainCanvas: true,
      fixtureModelSource: '127.0.0.1-localhost-fixed-text-substitute',
      apiKeyConfigured: false,
      providerGrantCount: 0,
      grantedPermissions: [...acceptancePermissions],
      realProviderRequests: 0,
      fixtureGenerationRequests,
      fixtureModelListRequests,
      taskStatusCounts: snapshot.taskStatusCounts,
      pendingDesktopActionCount: snapshot.pendingDesktopActionCount,
      codexGrantConnected: snapshot.codexGrantConnected,
      desktopConfirmationVisibleAtAnyPoint,
      nativeClientFormObserved: null,
      challengeTokenSaved: false,
      conversationSaved: false,
      credentialMaterialSavedToEvidence: false,
      cleanup: final ? cleanup : null,
    }
    await writeJsonAtomically(final ? resultPath : statusPath, result)
    return result
  }

  async function closeFixtureServer() {
    if (!localModelServer) { fixtureListenerClosed = true; return }
    const current = localModelServer
    localModelServer = null
    try { current.closeAllConnections?.() } catch { /* continue shutdown */ }
    await new Promise((resolve) => current.close(resolve))
    fixtureListenerClosed = true
  }

  async function cleanup(reason) {
    if (closing) return
    closing = true
    if (timer) clearTimeout(timer)
    if (stopPoll) clearInterval(stopPoll)
    let revokeVerified = false
    let disableVerified = false
    if (window && !window.isDestroyed() && grantClientId) {
      try {
        await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(grantClientId)})`)
        const state = await evaluate('window.vibepaperDesktop.getMcpState()')
        const revoked = state?.clients?.find((client) => client.clientId === grantClientId)
        revokeVerified = Boolean(revoked?.revokedAt && revoked.connected === false)
      } catch { revokeVerified = false }
      try {
        await evaluate('window.vibepaperDesktop.setMcpEnabled(false)')
        const state = await evaluate('window.vibepaperDesktop.getMcpState()')
        disableVerified = state?.enabled === false
      } catch { disableVerified = false }
    }
    grantRevoked = revokeVerified || !grantClientId
    mcpDisabled = disableVerified || !grantClientId
    await closeFixtureServer().catch(() => { fixtureListenerClosed = false })
    await writeStatus(true, reason, { grantRevoked, mcpDisabled, fixtureListenerClosed })
    allowQuit = true
    app.quit()
  }

  app.on('before-quit', (event) => {
    if (!allowQuit && !closing) {
      event.preventDefault()
      void cleanup('application_window_closed')
    }
  })

  async function run() {
    await prepareProject()
    const localEndpoint = await startLocalTextFixture()
    require('../src/main.cjs')
    await app.whenReady()
    assert.equal(app.getPath('userData'), profilePath)
    await waitFor("location.pathname === '/workspace' && document.querySelector('[role=button]')")
    await evaluate("document.querySelector('[role=button]').click()")
    const expectedCanvasPath = `/canvas/${project.canvasId}`
    await waitFor(`location.pathname === ${JSON.stringify(expectedCanvasPath)} && document.querySelector('[data-testid=mcp-canvas-page] .react-flow__node')`)
    assert.equal(await evaluate('location.pathname'), expectedCanvasPath)
    assert(await evaluate("Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow__node'))"))
    await waitFor('Boolean(window.vibepaperDesktop?.getMcpState)')
    await waitFor('window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)')

    const savedModel = await evaluate(`window.vibepaperDesktop.saveLocalTextModel(${JSON.stringify({
      endpoint: localEndpoint,
      modelId: 'native-confirmation-fixture-text',
    })})`)
    assert.equal(savedModel?.modelId, 'native-confirmation-fixture-text')
    const enabled = await evaluate('window.vibepaperDesktop.setMcpEnabled(true)')
    assert.equal(enabled?.enabled, true)
    const state = await evaluate('window.vibepaperDesktop.getMcpState()')
    assert.equal(state?.canvasReady, true)
    assert.equal(state?.activeCanvas?.projectId, project.projectId)
    assert.equal(state?.activeCanvas?.canvasId, project.canvasId)
    const created = resume ? null : await evaluate(`window.vibepaperDesktop.createMcpClientGrant(${JSON.stringify({
      clientName: 'codex',
      displayName: 'Native Codex Form Acceptance',
      permissions: acceptancePermissions,
      providerGrants: [],
      mediaTypes: [],
      disclosureVersion: state.connectionDisclosureVersion || 'desktop-mcp-provider-disclosure-v1',
      accepted: true,
    })})`)
    if (!resume && typeof created?.config?.codex !== 'string') throw new Error('codex_config_export_missing')
    const grantState = await evaluate('window.vibepaperDesktop.getMcpState()')
    const grant = grantState.clients.find((client) => client.clientName === 'codex'
      && client.displayName === 'Native Codex Form Acceptance' && !client.revokedAt)
    assert(grant, 'isolated_codex_grant_missing')
    assert.deepEqual([...grant.permissions].sort(), [...acceptancePermissions].sort())
    assert.deepEqual(grant.providerGrants, [])
    grantClientId = grant.clientId
    const codexTomlPath = path.join(runRoot, 'codex-native-confirmation.toml')
    if (resume) {
      const oldArgs = JSON.parse((await fs.readFile(codexTomlPath, 'utf8')).match(/^args = (.+)$/mu)[1])
      assert.equal(oldArgs[oldArgs.indexOf('--mcp-client-id') + 1], grant.clientId)
      // Public state intentionally omits grantId. The unchanged bridge args are
      // authenticated by Main; never reconstruct or un-revoke a grant here.
    } else {
      const exported = parseDesktopCodexConfig(created.config.codex)
      const expectedInstanceFile = path.join(runRoot, 'VibePaper', 'mcp-instance.json')
      const instanceArgument = exported.args.indexOf('--mcp-instance-file')
      if (instanceArgument < 0 || path.resolve(exported.args[instanceArgument + 1] || '') !== path.resolve(expectedInstanceFile)) {
        throw new Error('isolated_appdata_bridge_path_mismatch')
      }
      await fs.writeFile(codexTomlPath, createCodexToml({ command: exported.command, args: exported.args, appDataRoot: runRoot }), { flag: 'wx' })
    }
    ready = true
    await writeStatus(false)
    await writeJsonAtomically(readyPath, {
      profilePath,
      projectPath,
      codexTomlPath,
      serverName,
      timeoutMs,
    })
    timer = setTimeout(() => { void cleanup('timeout') }, timeoutMs)
    timer.unref()
    stopPoll = setInterval(async () => {
      try {
        await fs.access(stopPath)
        void cleanup('operator_stopped')
      } catch {
        await writeStatus(false).catch(() => {})
      }
    }, 1500)
    stopPoll.unref()
  }

  run().catch(async (error) => {
    const code = error?.message && /^[a-z0-9_-]{1,80}$/iu.test(error.message)
      ? error.message : 'desktop_worker_failed'
    if (!ready) {
      await writeJsonAtomically(resultPath, {
        schemaVersion: 1,
        status: 'failed',
        errorCode: code,
        errorKind: ['Error', 'TypeError', 'ReferenceError', 'AssertionError'].includes(error?.name) ? error.name : 'other',
        failureLine: String(error?.stack || '').split(/\r?\n/u).map(line => line.match(/prepare-mcp-native-confirmation\.cjs:(\d+):\d+/u)?.[1]).find(Boolean) || null,
        profileIsolated: true,
        apiKeyConfigured: false,
        credentialMaterialSavedToEvidence: false,
      }).catch(() => {})
      await closeFixtureServer().catch(() => {})
      allowQuit = true
      app.exit(1)
      return
    }
    await cleanup(code)
  })
}

if (process.versions?.electron && process.type === 'browser' && process.argv.includes('--worker')) workerMain()
else if (require.main !== module) module.exports = { protectRunDirectory, safeEnvironment }
else controllerMain().catch((error) => {
  const message = error?.message && /^[a-z0-9_-]{1,80}$/iu.test(error.message) ? error.message : 'native_form_harness_failed'
  console.error(message)
  process.exitCode = 1
})
