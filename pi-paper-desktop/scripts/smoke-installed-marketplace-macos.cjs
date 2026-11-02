#!/usr/bin/env node
// Installed macOS ARM64 smoke. Run with Node 24 against an app copied from the DMG:
// node smoke-installed-marketplace-macos.cjs --app /absolute/Pi-Paper.app --output /absolute/evidence-directory [--dmg /absolute/release.dmg]
// The optional DMG is hashed for correlation; this script does not establish that
// the supplied bundle was copied from it. No test Electron or replacement Main is used.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const nativeFs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawn, execFileSync } = require('node:child_process')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PROJECT_NAME = 'Marketplace macOS Acceptance'
const REQUIREMENTS = ['--app', '--output']
const labels = ['读取画布', '编辑画布', '准备生成', '读取任务', '读取媒体', '读取模型配置', '配置模型']

function argumentsFrom(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    if (!['--app', '--output', '--dmg'].includes(key) || !argv[i + 1] || values[key]) throw new Error('INVALID_ARGUMENTS')
    values[key] = argv[i + 1]
  }
  if (REQUIREMENTS.some((key) => !values[key]) || Object.values(values).some((value) => !path.isAbsolute(value))) throw new Error('ABSOLUTE_PATHS_REQUIRED')
  return values
}
function requireCheck(value) { assert.ok(value) }
function relativeInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
async function sha256(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of nativeFs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
function readPlist(plist, key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}
function matchingMainProcesses(executable, profile) {
  // Inspect arguments only for the installed main executable.
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
  const matches = []
  for (const line of processes.split('\n')) {
    const row = line.match(/^\s*(\d+)\s+(.*)$/u)
    if (!row || row[2] !== executable) continue
    const pid = Number(row[1])
    let command
    try {
      command = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
    } catch { continue } // The process can exit between the two checks.
    if (command.startsWith(executable + ' ') && command.includes(`--user-data-dir=${profile} `)) matches.push({ pid })
  }
  return matches
}
function stillOurProcess(pid, executable, profile) {
  return matchingMainProcesses(executable, profile).some((process) => process.pid === pid)
}
async function waitUntil(check, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value } catch {}
    await sleep(200)
  }
  throw new Error('WAIT_TIMEOUT')
}
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(1800) })
  if (!response.ok) throw new Error('CDP_HTTP_FAILED')
  return response.json()
}
function loopbackWebSocket(url, port) {
  const parsed = new URL(url)
  requireCheck(parsed.protocol === 'ws:' && parsed.hostname === '127.0.0.1' && Number(parsed.port) === port)
  return parsed.href
}
async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP_CONNECT_TIMEOUT')), 10_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')) }, { once: true })
  })
  let next = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const current = pending.get(message.id)
    if (!current) return
    pending.delete(message.id)
    clearTimeout(current.timer)
    if (message.error) current.reject(new Error('CDP_COMMAND_FAILED'))
    else current.resolve(message.result || {})
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('CDP_CLOSED'))
    }
    pending.clear()
  })
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP_COMMAND_TIMEOUT')) }, 15_000)
      pending.set(id, { resolve, reject, timer })
      try { socket.send(JSON.stringify({ id, method, params })) } catch {
        clearTimeout(timer); pending.delete(id); reject(new Error('CDP_SEND_FAILED'))
      }
    })
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails || result.result?.subtype === 'error') throw new Error('RENDERER_EVALUATION_FAILED')
    return result.result?.value
  }
  return { send, evaluate, close: () => socket.close() }
}
async function until(cdp, expression, timeout) {
  await waitUntil(() => cdp.evaluate(expression), timeout)
}
async function screenshot(cdp, target) {
  await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.writeFile(target, Buffer.from(capture.data, 'base64'), { flag: 'wx', mode: 0o600 })
}
async function button(cdp, label, exact = false) {
  const predicate = exact ? `el.innerText.trim() === ${JSON.stringify(label)}` : `el.innerText.includes(${JSON.stringify(label)})`
  const lookup = `Array.from(document.querySelectorAll('button')).find(el => !el.disabled && (${predicate} || el.title === ${JSON.stringify(label)}))`
  await until(cdp, `Boolean(${lookup})`)
  await cdp.evaluate(`(${lookup}).click(); true`)
}
async function anchor(cdp, href) {
  const selector = JSON.stringify(`a[href="${href}"]`)
  await until(cdp, `Boolean(document.querySelector(${selector}))`)
  await cdp.evaluate(`document.querySelector(${selector}).click(); true`)
}
async function checkTasksAndMcp(cdp, projectId) {
  const result = await cdp.evaluate(`Promise.all([window.vibepaperDesktop.listTasks(${JSON.stringify(projectId)}), window.vibepaperDesktop.getMcpState()]).then(([tasks, state]) => ({ taskCount: tasks.length, enabled: state.enabled, clientCount: state.clients.length }))`)
  assert.deepEqual(result, { taskCount: 0, enabled: false, clientCount: 0 })
  return result
}
async function graph(cdp, project) {
  const result = await cdp.evaluate(`window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)}).then(canvas => ({
    projectMatches: canvas.projectId === ${JSON.stringify(project.projectId)},
    canvasMatches: canvas.canvasId === ${JSON.stringify(project.canvasId)},
    nodes: canvas.nodes.map(node => ({ id: node.id, type: node.type })),
    edges: canvas.edges.map(edge => ({ source: edge.source, target: edge.target, valid: edge.data?.valid }))
  }))`)
  requireCheck(result.projectMatches && result.canvasMatches)
  assert.equal(result.nodes.length, 7)
  assert.equal(result.edges.length, 6)
  const byId = new Map(result.nodes.map((node) => [node.id, node.type]))
  assert.equal(byId.size, 7)
  assert.equal(result.nodes.filter((node) => node.type === 'image').length, 4)
  assert.equal(result.nodes.filter((node) => node.type === 'text').length, 3)
  requireCheck(result.edges.every((edge) => edge.valid === true && byId.has(edge.source) && byId.get(edge.target) === 'image'))
  const sourceImages = result.nodes.filter((node) => node.type === 'image' && result.edges.some((edge) => edge.source === node.id))
  assert.equal(sourceImages.length, 1)
  const targets = result.nodes.filter((node) => node.type === 'image' && node.id !== sourceImages[0].id)
  for (const target of targets) {
    const incoming = result.edges.filter((edge) => edge.target === target.id)
    assert.equal(incoming.length, 2)
    assert.equal(incoming.filter((edge) => edge.source === sourceImages[0].id).length, 1)
    assert.equal(incoming.filter((edge) => byId.get(edge.source) === 'text').length, 1)
  }
  for (const node of result.nodes.filter((item) => item.type === 'text')) {
    assert.equal(result.edges.filter((edge) => edge.source === node.id).length, 1)
  }
  const nodes = result.nodes.sort((a, b) => a.id.localeCompare(b.id))
  const edges = result.edges.sort((a, b) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`))
  return crypto.createHash('sha256').update(JSON.stringify({ nodes, edges })).digest('hex')
}
async function marketplaceState(cdp, projectId, packageId) {
  return cdp.evaluate(`window.vibepaperDesktop.marketplace.list(${JSON.stringify(projectId)}).then(packages => {
    const item = packages.find(pkg => pkg.id === ${JSON.stringify(packageId)})
    return item && item.components.map(c => ({ id: c.id, installed: c.installed, enabled: c.enabled }))
  })`)
}
function checkSelection(items, selected, all) {
  requireCheck(Array.isArray(items) && items.length === all.length)
  for (const id of all) {
    const item = items.find((value) => value.id === id)
    requireCheck(item && item.installed === (id === selected))
    if (id === selected) requireCheck(item.enabled === true)
  }
}
async function selectOnly(cdp, componentName, total, onSelected) {
  await until(cdp, `document.querySelectorAll('input[type=checkbox]:enabled').length === ${total}`)
  const selector = JSON.stringify(`input[aria-label="选择组件 ${componentName}"]`)
  await cdp.evaluate(`(() => {
    const target = document.querySelector(${selector})
    if (!target || target.checked || document.querySelectorAll('input[type=checkbox]:checked').length) throw new Error('BAD_SELECTION')
    target.click()
    return true
  })()`)
  await until(cdp, "document.querySelectorAll('input[type=checkbox]:checked').length === 1")
  if (onSelected) await onSelected()
  await button(cdp, '安装所选组件')
  await until(cdp, "document.querySelector('[role=status]')?.innerText.includes('已安装')")
}
async function launch(app, executable, profile) {
  await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true })
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  delete environment.VITE_DEV_SERVER_URL
  const opener = spawn('/usr/bin/open', ['-n', '-W', '-a', app, '--args',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
  { env: environment, stdio: ['ignore', 'ignore', 'ignore'] })
  opener.on('error', () => {})
  const portFile = path.join(profile, 'DevToolsActivePort')
  try {
    const portData = await waitUntil(async () => {
      const data = await fs.readFile(portFile, 'utf8')
      const [portText, browserPath] = data.trim().split(/\r?\n/u)
      const port = Number(portText)
      return Number.isInteger(port) && port > 0 && port < 65536 && /^\/devtools\/browser\/[\w-]+$/u.test(browserPath || '') ? { port, browserPath } : null
    }, 75_000)
    const processes = await waitUntil(() => {
      const matches = matchingMainProcesses(executable, profile)
      return matches.length === 1 ? matches : null
    }, 10_000)
    const target = await waitUntil(async () => {
      const targets = await json(`http://127.0.0.1:${portData.port}/json/list`)
      return targets.find((entry) => entry.type === 'page' && entry.url.startsWith('vibe://app/') && entry.webSocketDebuggerUrl)
    }, 75_000)
    const renderer = await connectCdp(loopbackWebSocket(target.webSocketDebuggerUrl, portData.port))
    const browser = await connectCdp(loopbackWebSocket(`ws://127.0.0.1:${portData.port}${portData.browserPath}`, portData.port))
    await renderer.send('Page.enable')
    await renderer.send('Runtime.enable')
    return { opener, pid: processes[0].pid, renderer, browser, executable, profile }
  } catch (error) {
    // Make a failed launch available for scoped cleanup by the caller.
    error.launch = { opener, executable, profile }
    throw error
  }
}
async function waitProcessGone(instance, timeout) {
  return waitUntil(() => !stillOurProcess(instance.pid, instance.executable, instance.profile), timeout)
}
function requestPidScopedQuit(pid) {
  // NSRunningApplication requests termination for this PID without targeting any other app.
  const script = `ObjC.import('AppKit'); var target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (!target.terminate) throw new Error('Termination request rejected');`
  execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 8_000, stdio: 'ignore' })
}
async function closeNormally(instance) {
  // Browser.close is directed at this isolated browser's CDP socket.
  await instance.browser.send('Browser.close').catch(() => {})
  if (await waitProcessGone(instance, 5000).then(() => true, () => false)) {
    instance.renderer.close(); instance.browser.close(); return 'cdp-browser-close'
  }
  if (!stillOurProcess(instance.pid, instance.executable, instance.profile)) return 'cdp-browser-close'
  requestPidScopedQuit(instance.pid)
  await waitProcessGone(instance, 20_000)
  instance.renderer.close(); instance.browser.close()
  return 'pid-scoped-appkit-terminate'
}
async function cleanup(instance) {
  if (!instance) return
  instance.renderer?.close()
  instance.browser?.close()
  const matches = matchingMainProcesses(instance.executable, instance.profile)
  // A unique profile and exact packaged executable identify only this run's app.
  if (matches.length === 1 && (!instance.pid || matches[0].pid === instance.pid)) {
    try { process.kill(matches[0].pid, 'SIGTERM') } catch {}
    await waitUntil(() => !stillOurProcess(matches[0].pid, instance.executable, instance.profile), 8000).catch(() => {})
  }
}
async function main() {
  const args = argumentsFrom(process.argv.slice(2))
  requireCheck(process.platform === 'darwin' && process.arch === 'arm64' && Number(process.versions.node.split('.')[0]) === 24)
  const app = await fs.realpath(args['--app'])
  requireCheck(app.endsWith('.app'))
  const appRoot = path.join(app, 'Contents', 'Resources', 'app')
  const plist = path.join(app, 'Contents', 'Info.plist')
  const name = readPlist(plist, 'CFBundleExecutable')
  requireCheck(name && path.basename(name) === name)
  const executable = path.join(app, 'Contents', 'MacOS', name)
  execFileSync('/usr/bin/lipo', [executable, '-verify_arch', 'arm64'], { stdio: 'ignore' })
  const packageFile = path.join(appRoot, 'package.json')
  const projectStore = path.join(appRoot, 'src', 'project-store.cjs')
  for (const required of [executable, packageFile, projectStore, path.join(appRoot, 'src', 'main.cjs'), path.join(appRoot, 'renderer', 'index.html')]) await fs.access(required)
  const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'))
  requireCheck(typeof pkg.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/u.test(pkg.version))
  await fs.mkdir(args['--output'], { recursive: true, mode: 0o700 })
  const output = await fs.realpath(args['--output'])
  requireCheck(!relativeInside(app, output))
  const runRoot = await fs.mkdtemp(path.join(output, 'marketplace-macos-'))
  // Keep Chromium state and project files out of the publishable evidence directory.
  const fixture = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'pi-paper-mac-fixture-'))
  const profile = path.join(fixture, 'profile')
  const projects = path.join(fixture, 'projects')
  await Promise.all([profile, projects].map((directory) => fs.mkdir(directory, { mode: 0o700 })))
  const report = {
    schemaVersion: 1,
    purpose: 'isolated installed macOS ARM64 marketplace smoke',
    result: 'failed',
    runtime: { platform: process.platform, architecture: process.arch, nodeMajor: 24 },
    artifact: { appVersion: pkg.version, executableSha256: await sha256(executable), packageJsonSha256: await sha256(packageFile), dmgAssociationVerified: false },
    checks: {}, screenshots: [],
  }
  if (args['--dmg']) report.artifact.dmgSha256 = await sha256(await fs.realpath(args['--dmg']))
  let stage = 'fixture'
  let active
  const capture = async (cdp, name) => { await screenshot(cdp, path.join(runRoot, name)); report.screenshots.push(name) }
  try {
    const { createLocalProjectStore } = require(projectStore)
    const store = createLocalProjectStore()
    let created
    try { created = await store.createProject(projects, PROJECT_NAME) } finally { await store.close() }
    const project = created.project
    await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: created.directory }), { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(profile, 'ui-settings.json'), JSON.stringify({ schemaVersion: 1, language: 'zh' }), { flag: 'wx', mode: 0o600 })
    stage = 'first-launch'
    try { active = await launch(app, executable, profile) } catch (error) { active = error.launch; throw error }
    let cdp = active.renderer
    await until(cdp, "location.pathname === '/workspace' && Boolean(window.vibepaperDesktop?.marketplace)")
    await until(cdp, `window.vibepaperDesktop.getActiveProject().then(p => p?.projectId === ${JSON.stringify(project.projectId)} && p?.canvasId === ${JSON.stringify(project.canvasId)})`)
    await until(cdp, `Array.from(document.querySelectorAll('[role=button]')).some(el => el.innerText.includes(${JSON.stringify(PROJECT_NAME)}))`)
    await checkTasksAndMcp(cdp, project.projectId)
    await capture(cdp, '01-workspace.png')
    report.checks.originalWorkspace = true
    stage = 'selective-template-install'
    await anchor(cdp, '/marketplace')
    await until(cdp, "location.pathname === '/marketplace'")
    await button(cdp, '商品棚拍工作流')
    await until(cdp, "document.querySelector('h1')?.innerText === '商品棚拍工作流'")
    await selectOnly(cdp, '商品主图三案', 4, () => capture(cdp, '02-marketplace-template.png'))
    checkSelection(await marketplaceState(cdp, project.projectId, 'vibepaper-product-studio'), 'product-workflow', ['product-workflow', 'neutral-background', 'studio-prompt', 'product-shooting'])
    await checkTasksAndMcp(cdp, project.projectId)
    report.checks.templateOnlyInstalled = true
    stage = 'apply-original-canvas'
    await button(cdp, '返回画布')
    await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
    await button(cdp, '插件组件')
    await until(cdp, "document.querySelector('aside[aria-label=插件组件]')?.innerText.includes('商品主图三案')")
    await button(cdp, '插入', true)
    await until(cdp, `window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)}).then(c => c.nodes.length === 7 && c.edges.length === 6)`)
    const originalFingerprint = await graph(cdp, project)
    await until(cdp, "document.querySelectorAll('.react-flow__node').length === 7 && document.querySelectorAll('.react-flow__edge').length === 6")
    await checkTasksAndMcp(cdp, project.projectId)
    await button(cdp, '聚焦视图')
    await sleep(600)
    await capture(cdp, '03-canvas-applied.png')
    report.checks.canvas = { nodes: 7, edges: 6, topologyValidated: true }
    stage = 'connector-scope-prefill'
    await button(cdp, '返回画布展示')
    await until(cdp, "location.pathname === '/workspace'")
    await anchor(cdp, '/marketplace')
    await button(cdp, 'MCP 与本地工具连接')
    await until(cdp, "document.querySelector('h1')?.innerText === 'MCP 与本地工具连接'")
    await selectOnly(cdp, 'Codex 画布连接', 2)
    checkSelection(await marketplaceState(cdp, project.projectId, 'vibepaper-connectors'), 'codex-canvas', ['codex-canvas', 'local-text-tool'])
    await button(cdp, '检查 MCP 授权范围')
    await until(cdp, "location.pathname === '/settings/mcp' && document.querySelector('[role=status]')?.innerText.includes('已从已安装的连接器预填')")
    const scope = await cdp.evaluate(`(() => {
      const labels = ${JSON.stringify(labels)}
      const state = labels.map(name => {
        const label = Array.from(document.querySelectorAll('label')).find(el => el.querySelector('span > span')?.innerText === name)
        const input = label?.querySelector('input[type=checkbox]')
        return input ? { name, checked: input.checked } : null
      })
      const client = Array.from(document.querySelectorAll('label')).find(el => el.innerText.includes('客户端'))?.querySelector('select')?.value
      return { client, state, toggle: document.querySelector('[data-testid=mcp-enabled-toggle]')?.getAttribute('aria-pressed') }
    })()`)
    assert.equal(scope.client, 'codex')
    assert.equal(scope.toggle, 'false')
    assert.deepEqual(scope.state, labels.map((name, i) => ({ name, checked: i < 2 })))
    await checkTasksAndMcp(cdp, project.projectId)
    await capture(cdp, '04-mcp-prefill.png')
    report.checks.mcp = { prefilledClient: 'codex', prefilledPermissions: ['canvas.read', 'canvas.write'], enabled: false, clients: 0, tasks: 0 }
    stage = 'first-normal-exit'
    report.checks.firstExit = await closeNormally(active)
    active = null
    stage = 'restart-readback'
    try { active = await launch(app, executable, profile) } catch (error) { active = error.launch; throw error }
    cdp = active.renderer
    await until(cdp, "location.pathname === '/workspace' && Boolean(window.vibepaperDesktop?.marketplace)")
    await until(cdp, `Array.from(document.querySelectorAll('[role=button]')).some(el => el.innerText.includes(${JSON.stringify(PROJECT_NAME)}))`)
    await capture(cdp, '05-reopened-workspace.png')
    await cdp.evaluate(`Array.from(document.querySelectorAll('[role=button]')).find(el => el.innerText.includes(${JSON.stringify(PROJECT_NAME)})).click(); true`)
    await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
    await until(cdp, "document.querySelectorAll('.react-flow__node').length === 7 && document.querySelectorAll('.react-flow__edge').length === 6")
    assert.equal(await graph(cdp, project), originalFingerprint)
    checkSelection(await marketplaceState(cdp, project.projectId, 'vibepaper-product-studio'), 'product-workflow', ['product-workflow', 'neutral-background', 'studio-prompt', 'product-shooting'])
    checkSelection(await marketplaceState(cdp, project.projectId, 'vibepaper-connectors'), 'codex-canvas', ['codex-canvas', 'local-text-tool'])
    await checkTasksAndMcp(cdp, project.projectId)
    await capture(cdp, '06-reopened-canvas.png')
    report.checks.restart = { graphUnchanged: true, nodes: 7, edges: 6, installedComponentsPreserved: true, mcpEnabled: false, clients: 0, tasks: 0 }
    stage = 'second-normal-exit'
    report.checks.secondExit = await closeNormally(active)
    active = null
    report.result = 'passed'
  } catch (error) {
    report.failure = { stage, type: error?.code === 'ERR_ASSERTION' ? 'assertion-failed' : 'operation-failed' }
    await cleanup(active)
    active = null
  }
  await fs.writeFile(path.join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ result: report.result, evidenceDirectory: runRoot, ...(report.failure ? { failure: report.failure } : {}) }))
  if (report.result === 'passed') await fs.rm(fixture, { recursive: true, force: true })
  else process.exitCode = 1
}
main().catch(() => { console.error('Smoke setup failed. Verify absolute paths, Node 24 ARM64, app layout, and output permissions.'); process.exitCode = 1 })
