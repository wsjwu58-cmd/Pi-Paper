const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const repositoryRoot = path.resolve(__dirname, '..', '..')
const desktopRoot = path.join(repositoryRoot, 'vibepaper-desktop')
const fixtureRoot = path.join(repositoryRoot, '.test-temp')
const pairingTitle = '批准本地 MCP 连接'
const pairingButton = '批准本次连接'
const connectionDisclosureVersion = 'desktop-mcp-provider-disclosure-v1'

function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function sha256(filePath) {
  const digest = crypto.createHash('sha256')
  for await (const chunk of require('node:fs').createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

async function reserveLoopbackPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function randomUUID() {
  return crypto.randomUUID()
}

function processExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
}

async function waitForExit(child, timeoutMs, label) {
  let timer
  const result = await Promise.race([
    processExit(child),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not exit in time.`)), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
  return result
}

async function fetchJson(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('Could not connect to the isolated Electron debugging port.')), { once: true })
  })

  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (!Number.isSafeInteger(message.id)) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message || 'Electron debugging command failed.'))
    else request.resolve(message.result || {})
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('The packaged app closed its debugging connection.'))
    }
    pending.clear()
  })

  function send(method, params = {}) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Timed out waiting for Electron debugging command ${method}.`))
      }, 15_000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || 'The packaged renderer evaluation failed.')
    }
    return response.result?.value
  }

  return { send, evaluate, close: () => socket.close() }
}

async function waitForRenderer(cdp, expression, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The packaged renderer did not reach the required state: ${expression}`)
}

function startPairingApprovalHelper(environment, appProcessPid, pairingCode) {
  const source = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$native = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class VibePaperWindowApproval {
  private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  public static int ProcessId(IntPtr window) {
    uint processId;
    GetWindowThreadProcessId(window, out processId);
    return (int)processId;
  }
  public static IntPtr[] FindTopLevelWindows(int[] processIds) {
    var allowed = new HashSet<int>(processIds);
    var windows = new List<IntPtr>();
    EnumWindows(delegate(IntPtr window, IntPtr parameter) {
      uint processId;
      GetWindowThreadProcessId(window, out processId);
      if (allowed.Contains((int)processId)) windows.Add(window);
      return true;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
  public static bool ClickAt(int x, int y) {
    if (!SetCursorPos(x, y)) return false;
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    return true;
  }
}
"@
Add-Type -TypeDefinition $native
$processes = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
$allowedProcessIds = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$allowedProcessIds.Add([int]${appProcessPid})
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($process in $processes) {
    $processIdentifier = [int]$process.ProcessId
    if (!$allowedProcessIds.Contains($processIdentifier) -and $allowedProcessIds.Contains([int]$process.ParentProcessId)) {
      [void]$allowedProcessIds.Add($processIdentifier)
      $changed = $true
    }
  }
}
$reportedWindowTree = $false
$targetProcessIds = @($allowedProcessIds | ForEach-Object { [int]$_ })
$expectedCode = '${pairingCode}'
$deadline = [DateTime]::UtcNow.AddSeconds(90)
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = [VibePaperWindowApproval]::FindTopLevelWindows($targetProcessIds)
  $scopedWindowDetails = @()
  foreach ($windowHandle in $windows) {
    try { $window = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle) } catch { continue }
    $windowInfo = $window.Current
    $windowProcessId = [VibePaperWindowApproval]::ProcessId($windowHandle)
    if ($allowedProcessIds.Contains($windowProcessId) -and $windowInfo.ControlType -eq [System.Windows.Automation.ControlType]::Window) {
      $titleMatches = $windowInfo.Name -ceq '${pairingTitle}'
      $codeMatches = $false
      $matchingControls = @()
      $buttonElement = $null
      $buttonInfo = $null
      $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($element in $elements) {
        try { $elementInfo = $element.Current } catch { continue }
        if (!$allowedProcessIds.Contains([int]$elementInfo.ProcessId)) { continue }
        if (![string]::IsNullOrEmpty($elementInfo.Name) -and $elementInfo.Name.Contains($expectedCode)) { $codeMatches = $true }
        if ($elementInfo.Name -ceq '${pairingButton}') {
          $buttonElement = $element
          $buttonInfo = $elementInfo
        }
      }
      if ($buttonElement) {
        $activation = 'unavailable'
        if ($titleMatches -and $codeMatches -and $buttonInfo.IsEnabled) {
          try { $buttonElement.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); exit 0 } catch { $activation = 'invoke-unavailable' }
          try { $buttonElement.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern).DoDefaultAction(); exit 0 } catch { $activation = 'legacy-unavailable' }
          try {
            $point = $buttonElement.GetClickablePoint()
            [void][VibePaperWindowApproval]::SetForegroundWindow($windowHandle)
            Start-Sleep -Milliseconds 100
            if ([VibePaperWindowApproval]::GetForegroundWindow() -eq $windowHandle) {
              if ([VibePaperWindowApproval]::ClickAt([int][Math]::Round($point.X), [int][Math]::Round($point.Y))) {
                $activation = 'uia-clickable-point'
                for ($attempt = 0; $attempt -lt 20; $attempt++) {
                  Start-Sleep -Milliseconds 100
                  $dialogStillOpen = $false
                  foreach ($candidateHandle in [VibePaperWindowApproval]::FindTopLevelWindows($targetProcessIds)) {
                    try {
                      $candidate = [System.Windows.Automation.AutomationElement]::FromHandle($candidateHandle)
                      if ($candidate.Current.Name -ceq '${pairingTitle}') { $dialogStillOpen = $true; break }
                    } catch {}
                  }
                  if (!$dialogStillOpen) { exit 0 }
                }
              }
            }
            $activation = 'click-unavailable'
          } catch { $activation = 'click-unavailable' }
        }
        $matchingControls += "$($buttonInfo.ControlType.ProgrammaticName);class=$($buttonInfo.ClassName);enabled=$($buttonInfo.IsEnabled);activation=$activation"
      }
      $scopedWindowDetails += "pid=$windowProcessId; titleMatch=$titleMatches; codeMatches=$codeMatches; control=$($windowInfo.ControlType.ProgrammaticName); matchingControls=$($matchingControls -join '|')"
    }
  }
  if (!$reportedWindowTree -and $scopedWindowDetails.Count -gt 0) {
    [Console]::Error.WriteLine("Scoped UIA windows: $($scopedWindowDetails -join ' || ')")
    $reportedWindowTree = $true
  }
  Start-Sleep -Milliseconds 200
}
exit 2
`
  const encoded = Buffer.from(source, 'utf16le').toString('base64')
  const helper = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  helper.__capturedOutput = ''
  for (const stream of [helper.stdout, helper.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => { helper.__capturedOutput = (helper.__capturedOutput + chunk).slice(-4000) })
  }
  return helper
}

async function saveRendererScreenshot(cdp, filePath) {
  const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await fs.writeFile(filePath, Buffer.from(capture.data, 'base64'))
}

async function prepareProject(runRoot, appDirectory) {
  const { createLocalProjectStore } = require(path.join(appDirectory, 'src', 'project-store.cjs'))
  const appDataDirectory = path.join(runRoot, 'appdata')
  const localAppDataDirectory = path.join(runRoot, 'local-appdata')
  const tempDirectory = path.join(runRoot, 'temp')
  const projectsDirectory = path.join(runRoot, 'projects')
  await Promise.all([appDataDirectory, localAppDataDirectory, tempDirectory, projectsDirectory]
    .map((directory) => fs.mkdir(directory, { recursive: true })))

  const store = createLocalProjectStore()
  let created
  try {
    created = await store.createProject(projectsDirectory, 'Installed MCP Acceptance')
  } finally {
    await store.close()
  }

  const userDataDirectory = path.join(appDataDirectory, 'VibePaper')
  await fs.mkdir(userDataDirectory, { recursive: true })
  await fs.writeFile(path.join(userDataDirectory, 'recent-project.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectDirectory: created.directory,
  })}\n`, { flag: 'wx' })

  return { appDataDirectory, localAppDataDirectory, tempDirectory, userDataDirectory, project: created.project, projectDirectory: created.directory }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The installed MCP smoke currently runs on Windows only.')
  const appExecutable = path.resolve(process.argv[2] || path.join(desktopRoot, 'release', 'win-unpacked', 'Pi-Paper.exe'))
  const installerPath = path.resolve(process.argv[3] || path.join(desktopRoot, 'release', 'Pi-Paper-0.1.0-win-x64.exe'))
  const executionSource = process.argv[4] || 'packaged runtime payload launched directly without installer registration'
  const installDirectory = path.dirname(appExecutable)
  const appDirectory = path.join(installDirectory, 'resources', 'app')
  await fs.access(appExecutable)
  await fs.access(installerPath)
  const [appPackage, installerHash, executableHash] = await Promise.all([
    fs.readFile(path.join(appDirectory, 'package.json'), 'utf8').then(JSON.parse),
    sha256(installerPath),
    sha256(appExecutable),
  ])
  if (process.arch !== 'x64') throw new Error(`Expected an x64 Windows runtime, found ${process.arch}.`)
  if (!path.basename(installerPath).includes(`${appPackage.version}-win-x64`)) {
    throw new Error('The installer version or architecture does not match the packaged application.')
  }
  const packagedFiles = [
    'src/main.cjs', 'src/preload.cjs', 'src/mcp-node-entry.cjs', 'src/project-store.cjs',
    'dist/mcp-launcher.cjs', 'dist/mcp-stdio.cjs', 'dist/pi-official-media.cjs', 'renderer/index.html',
  ]
  for (const file of packagedFiles) await fs.access(path.join(appDirectory, file))

  await fs.mkdir(fixtureRoot, { recursive: true })
  const runRoot = await fs.mkdtemp(path.join(fixtureRoot, 'installed-mcp-'))
  let appProcess
  let approvalHelper
  let cdp
  let client
  let transport
  let failed = true
  let appOutput = ''
  let bridgeOutput = ''
  try {
    const fixture = await prepareProject(runRoot, appDirectory)
    const debuggingPort = await reserveLoopbackPort()
    const appEnvironment = { ...process.env,
      APPDATA: fixture.appDataDirectory,
      LOCALAPPDATA: fixture.localAppDataDirectory,
      TEMP: fixture.tempDirectory,
      TMP: fixture.tempDirectory,
    }
    delete appEnvironment.ELECTRON_RUN_AS_NODE
    delete appEnvironment.VITE_DEV_SERVER_URL
    appProcess = spawn(appExecutable, [
      `--user-data-dir=${fixture.userDataDirectory}`,
      `--remote-debugging-port=${debuggingPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
    ], { cwd: installDirectory, env: appEnvironment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    appProcess.stdout.setEncoding('utf8')
    appProcess.stderr.setEncoding('utf8')
    appProcess.stdout.on('data', (chunk) => { appOutput = (appOutput + chunk).slice(-4000) })
    appProcess.stderr.on('data', (chunk) => { appOutput = (appOutput + chunk).slice(-4000) })
    appProcess.on('error', (error) => { appOutput = `${appOutput}\n${error.message}`.slice(-4000) })

    const debugDeadline = Date.now() + 60_000
    let target
    while (Date.now() < debugDeadline) {
      if (appProcess.exitCode !== null) throw new Error(`Packaged app exited during startup. ${appOutput}`)
      try {
        const targets = await fetchJson(`http://127.0.0.1:${debuggingPort}/json/list`)
        target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (target) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!target) throw new Error(`Packaged app did not expose its isolated renderer. ${appOutput}`)
    cdp = await connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await waitForRenderer(cdp, "location.pathname === '/workspace' && Boolean(window.vibepaperDesktop?.getMcpState)")
    const initialMcpState = await cdp.evaluate('window.vibepaperDesktop.getMcpState()')
    assert.equal(initialMcpState.activeCanvas?.projectId, fixture.project.projectId)
    assert.equal(initialMcpState.activeCanvas?.canvasId, fixture.project.canvasId)

    await cdp.evaluate("history.pushState({}, '', '/settings/mcp'); dispatchEvent(new PopStateEvent('popstate'))")
    await waitForRenderer(cdp, "Boolean(document.querySelector('[data-testid=mcp-settings-page]') && document.querySelector('[data-testid=mcp-enabled-toggle]:not(:disabled)'))")
    await cdp.evaluate(`(() => {
      const toggle = document.querySelector('[data-testid=mcp-enabled-toggle]')
      if (!toggle) throw new Error('MCP settings toggle is missing')
      if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click()
      const permissionLabel = [...document.querySelectorAll('label')].find(label => label.innerText.includes('编辑画布'))
      const permission = permissionLabel?.querySelector('input[type=checkbox]')
      if (!permission) throw new Error('Canvas write permission is missing')
      if (!permission.checked) permission.click()
      const disclosureLabel = [...document.querySelectorAll('label')].find(label => label.innerText.includes('我已了解上述外部读取与发送范围'))
      const disclosure = disclosureLabel?.querySelector('input[type=checkbox]')
      if (!disclosure) throw new Error('The MCP access disclosure is missing')
      if (!disclosure.checked) disclosure.click()
      return true
    })()`)
    await waitForRenderer(cdp, "document.querySelector('[data-testid=mcp-enabled-toggle]')?.getAttribute('aria-pressed') === 'true'")
    await waitForRenderer(cdp, "Boolean(document.querySelector('[data-testid=mcp-create-grant]:not(:disabled)'))")
    await saveRendererScreenshot(cdp, path.join(runRoot, 'mcp-settings.png'))
    const disclosure = await cdp.evaluate('window.vibepaperDesktop.getMcpState().then(state => state.connectionDisclosureVersion)')
    assert.equal(disclosure, connectionDisclosureVersion)
    await cdp.evaluate("document.querySelector('[data-testid=mcp-create-grant]').click()")
    await waitForRenderer(cdp, "document.querySelectorAll('[data-testid=mcp-client-config] textarea').length === 2")
    const configText = await cdp.evaluate("document.querySelectorAll('[data-testid=mcp-client-config] textarea')[1].value")
    const clientConfig = JSON.parse(configText)
    const mcpServer = clientConfig.mcpServers?.vibepaper
    assert(mcpServer && typeof mcpServer.command === 'string' && Array.isArray(mcpServer.args))
    assert.equal(path.resolve(mcpServer.command).toLowerCase(), appExecutable.toLowerCase())
    assert.equal(mcpServer.env?.ELECTRON_RUN_AS_NODE, '1')
    assert(mcpServer.args.includes('--mcp-stdio'))
    const entryArgument = mcpServer.args[0]
    assert.equal(path.resolve(entryArgument), path.join(appDirectory, 'src', 'mcp-node-entry.cjs'))

    const projectCardExpression = `(() => {
      const card = [...document.querySelectorAll('[role=button]')].find(element => element.innerText.includes(${JSON.stringify(fixture.project.name)}))
      if (!card) throw new Error('The local project card is missing from the original workspace page')
      card.click()
      return true
    })()`
    await cdp.evaluate(`history.pushState({}, '', '/workspace'); dispatchEvent(new PopStateEvent('popstate'))`)
    await waitForRenderer(cdp, "location.pathname === '/workspace'")
    await waitForRenderer(cdp, `([...document.querySelectorAll('[role=button]')].some(element => element.innerText.includes(${JSON.stringify(fixture.project.name)})))`)
    await cdp.evaluate(projectCardExpression)
    await waitForRenderer(cdp, `location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page]'))`, 60_000)
    await waitForRenderer(cdp, 'window.vibepaperDesktop.getMcpState().then(state => state.canvasReady === true)', 60_000)
    await fs.access(path.join(fixture.userDataDirectory, 'mcp-instance.json'))

    const bridgeEnvironment = { ...process.env,
      ...(mcpServer.env || {}),
      APPDATA: fixture.appDataDirectory,
      LOCALAPPDATA: fixture.localAppDataDirectory,
      TEMP: fixture.tempDirectory,
      TMP: fixture.tempDirectory,
    }
    delete bridgeEnvironment.VITE_DEV_SERVER_URL
    client = new Client({ name: 'vibepaper-installed-package-smoke', version: '1.0.0' })
    transport = new StdioClientTransport({ ...mcpServer, env: bridgeEnvironment, stderr: 'pipe' })
    let resolvePairingCode
    const pairingCodeReady = new Promise((resolve) => { resolvePairingCode = resolve })
    transport.stderr?.on('data', (chunk) => {
      bridgeOutput = (bridgeOutput + String(chunk)).slice(-4000)
      const pairingCode = bridgeOutput.match(/verify code (\d{6})/u)?.[1]
      if (pairingCode && resolvePairingCode) {
        resolvePairingCode(pairingCode)
        resolvePairingCode = null
      }
    })
    await client.connect(transport, { timeout: 60_000 })
    let pairingCodeTimer
    const pairingCode = await Promise.race([
      pairingCodeReady,
      new Promise((_, reject) => {
        pairingCodeTimer = setTimeout(() => reject(new Error('The isolated MCP bridge did not provide a pairing short code.')), 30_000)
        pairingCodeTimer.unref?.()
      }),
    ]).finally(() => clearTimeout(pairingCodeTimer))
    approvalHelper = startPairingApprovalHelper(bridgeEnvironment, appProcess.pid, pairingCode)
    const approvalExit = await waitForExit(approvalHelper, 100_000, 'The isolated connection approval helper')
    const approvalOutput = approvalHelper.__capturedOutput
    approvalHelper = null
    assert.equal(approvalExit.code, 0,
      `The test helper must approve exactly the expected local MCP pairing dialog. ${approvalOutput || ''}`)

    async function callTool(name, args = {}) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 })
      assert(!result.isError, `Packaged MCP tool ${name} failed: ${JSON.stringify(result.structuredContent || {})}`)
      assert(result.structuredContent && typeof result.structuredContent === 'object')
      return result.structuredContent
    }

    const definitions = await client.listTools()
    assert(definitions.tools.some((tool) => tool.name === 'create_nodes'))
    assert(definitions.tools.some((tool) => tool.name === 'connect_nodes'))
    const before = await callTool('get_canvas_summary')
    assert(Number.isSafeInteger(before.canvas?.version))
    const operationId = randomUUID()
    const creation = {
      operationId,
      expectedVersion: before.canvas.version,
      nodes: [
        { type: 'image', params: { prompt: 'Installed package MCP source fixture' } },
        { type: 'image', params: { prompt: 'Installed package MCP target fixture' } },
      ],
    }
    const created = await callTool('create_nodes', creation)
    assert.equal(created.createdNodes?.length, 2)
    assert.deepEqual(await callTool('create_nodes', creation), created)
    const refreshed = await callTool('get_canvas_summary')
    assert.equal(refreshed.nodes.length, before.nodes.length + 2)
    const sourceNodeId = created.createdNodes[0].id
    const targetNodeId = created.createdNodes[1].id
    await callTool('connect_nodes', {
      operationId: randomUUID(),
      expectedVersion: refreshed.canvas.version,
      sourceNodeId,
      targetNodeId,
    })
    const after = await callTool('get_canvas_summary')
    assert.equal(after.edges.length, before.edges.length + 1)
    assert(after.edges.some((edge) => (edge.sourceNodeId || edge.source) === sourceNodeId
      && (edge.targetNodeId || edge.target) === targetNodeId))
    await waitForRenderer(cdp, `document.querySelectorAll('.react-flow__node').length === ${after.nodes.length}
      && document.querySelectorAll('.react-flow__edge').length === ${after.edges.length}`)
    await saveRendererScreenshot(cdp, path.join(runRoot, 'canvas-after-mcp-write.png'))
    const finalMcpState = await cdp.evaluate('window.vibepaperDesktop.getMcpState()')
    assert.equal(finalMcpState.canvasReady, true)
    assert.equal(finalMcpState.activeCanvas?.projectId, fixture.project.projectId)

    await client.close()
    client = null
    transport = null
    await cdp.send('Browser.close').catch(() => undefined)
    cdp.close()
    cdp = null
    const firstProcess = appProcess
    const firstProcessId = firstProcess.pid
    await waitForExit(firstProcess, 20_000, 'The first isolated desktop app session')
    appProcess = null

    const reopenedDebuggingPort = await reserveLoopbackPort()
    appProcess = spawn(appExecutable, [
      `--user-data-dir=${fixture.userDataDirectory}`,
      `--remote-debugging-port=${reopenedDebuggingPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
    ], { cwd: installDirectory, env: appEnvironment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    appProcess.stdout.setEncoding('utf8')
    appProcess.stderr.setEncoding('utf8')
    appProcess.stdout.on('data', (chunk) => { appOutput = (appOutput + chunk).slice(-4000) })
    appProcess.stderr.on('data', (chunk) => { appOutput = (appOutput + chunk).slice(-4000) })
    appProcess.on('error', (error) => { appOutput = `${appOutput}\n${error.message}`.slice(-4000) })

    const reopenedDebugDeadline = Date.now() + 60_000
    let reopenedTarget
    while (Date.now() < reopenedDebugDeadline) {
      if (appProcess.exitCode !== null) throw new Error(`Packaged app exited during reopen. ${appOutput}`)
      try {
        const targets = await fetchJson(`http://127.0.0.1:${reopenedDebuggingPort}/json/list`)
        reopenedTarget = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
        if (reopenedTarget) break
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!reopenedTarget) throw new Error(`Packaged app did not expose its renderer after reopen. ${appOutput}`)
    cdp = await connectCdp(reopenedTarget.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await waitForRenderer(cdp, "location.pathname === '/workspace' && Boolean(window.vibepaperDesktop?.getMcpState)")
    await waitForRenderer(cdp, `([...document.querySelectorAll('[role=button]')].some(element => element.innerText.includes(${JSON.stringify(fixture.project.name)})))`)
    await cdp.evaluate(projectCardExpression)
    await waitForRenderer(cdp, `location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page]'))`, 60_000)
    await waitForRenderer(cdp, `document.querySelectorAll('.react-flow__node').length === ${after.nodes.length}
      && document.querySelectorAll('.react-flow__edge').length === ${after.edges.length}`, 60_000)
    const reopenedMcpState = await cdp.evaluate('window.vibepaperDesktop.getMcpState()')
    assert.equal(reopenedMcpState.activeCanvas?.projectId, fixture.project.projectId)
    assert.equal(reopenedMcpState.activeCanvas?.canvasId, fixture.project.canvasId)
    await saveRendererScreenshot(cdp, path.join(runRoot, 'canvas-after-reopen.png'))
    const reopenedCanvas = {
      firstProcessId,
      secondProcessId: appProcess.pid,
      restartedFromWorkspace: true,
      canvasRoute: `/canvas/${fixture.project.canvasId}`,
      nodeCountAfterRestart: after.nodes.length,
      edgeCountAfterRestart: after.edges.length,
      persistedCanvasIdentity: true,
    }

    const runtimeFiles = Object.fromEntries(await Promise.all(packagedFiles.map(async (file) => [
      file, await sha256(path.join(appDirectory, file)),
    ])))
    const evidence = {
      success: true,
      platform: 'win32',
      architecture: 'x64',
      appVersion: appPackage.version,
      installer: { path: installerPath, bytes: (await fs.stat(installerPath)).size, sha256: installerHash },
      runtime: { executable: appExecutable, sha256: executableHash, appDirectory: appDirectory, files: runtimeFiles },
      resourcesLayout: 'loose resources/app files; app.asar is disabled in electron-builder.cjs',
      execution: executionSource,
      renderer: { initialRoute: '/workspace', canvasRoute: `/canvas/${fixture.project.canvasId}`, originalCanvasPage: true },
      mcp: { protocol: 'stdio', packagedNodeEntry: entryArgument, electronRunAsNode: true,
        serverInfo: definitions.tools.length > 0, discoveredToolCount: definitions.tools.length,
        nodeCountBefore: before.nodes.length, nodeCountAfter: after.nodes.length,
        edgeCountAfter: after.edges.length, idempotentReplay: true, desktopProfileIsolated: true },
      reopen: reopenedCanvas,
      profile: { testRunDirectory: runRoot, userDataDirectory: fixture.userDataDirectory, explicitElectronSwitch: '--user-data-dir' },
      screenshots: ['mcp-settings.png', 'canvas-after-mcp-write.png', 'canvas-after-reopen.png'],
      modelCalls: { generationSubmitted: false, cloudProviderRequests: 0 },
      realCodexOrClaudeCodeSession: false,
    }
    await fs.writeFile(path.join(runRoot, 'installed-mcp-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
    failed = false
  } finally {
    if (client) await client.close().catch(() => undefined)
    if (approvalHelper?.__capturedOutput) {
      await fs.writeFile(path.join(runRoot, 'approval-helper-diagnostics.txt'), approvalHelper.__capturedOutput)
      process.stderr.write(`Scoped pairing UI diagnostics preserved at ${path.join(runRoot, 'approval-helper-diagnostics.txt')}\n`)
    }
    if (approvalHelper && approvalHelper.exitCode === null && approvalHelper.signalCode === null) approvalHelper.kill()
    if (cdp) {
      await cdp.send('Browser.close').catch(() => undefined)
      cdp.close()
    }
    if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
      await waitForExit(appProcess, 15_000, 'The packaged desktop app').catch(() => appProcess.kill())
    }
    if (!failed) {
      const resolvedBase = path.resolve(fixtureRoot)
      const resolvedRun = path.resolve(runRoot)
      if (!inside(resolvedBase, resolvedRun) || path.dirname(resolvedRun) !== resolvedBase
        || !path.basename(resolvedRun).startsWith('installed-mcp-')) {
        throw new Error('Refusing to remove a test directory outside the isolated package smoke root.')
      }
      process.stderr.write(`Isolated package smoke evidence preserved at ${resolvedRun}\n`)
    } else {
      process.stderr.write(`Isolated package smoke data preserved at ${runRoot}\n`)
      if (appOutput) process.stderr.write(`Packaged app output: ${appOutput}\n`)
      if (bridgeOutput) process.stderr.write(`Packaged MCP bridge output: ${bridgeOutput}\n`)
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
