#!/usr/bin/env node
// Installed macOS ARM64 smoke. Run with Node 24 against an app copied from the DMG:
// node smoke-installed-marketplace-macos.cjs --app /absolute/Pi-Paper.app --output /absolute/evidence-directory [--dmg /absolute/release.dmg] [--online-director | --exports]
// --exports verifies saved PNG/CSV files and project content after restart.
// --online-director uses a fresh isolated profile to refresh the official GitHub catalog.
// Optionally set PI_PAPER_EXPECTED_ONLINE_COMMIT to require one specific catalog commit.
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
let arrangeDetail = 'none'
let arrangeFacts = null
const labels = ['读取画布', '编辑画布', '准备生成', '读取任务', '读取媒体', '读取模型配置', '配置模型']

function argumentsFrom(argv) {
  const values = {}
  for (let i = 0; i < argv.length;) {
    const key = argv[i++]
    if (key === '--online-director' || key === '--exports') {
      if (values['--online-director'] || values['--exports']) throw new Error('INVALID_ARGUMENTS')
      values[key] = true
      continue
    }
    if (!['--app', '--output', '--dmg'].includes(key) || !argv[i] || values[key]) throw new Error('INVALID_ARGUMENTS')
    values[key] = argv[i++]
  }
  if (REQUIREMENTS.some((key) => !values[key]) || Object.values(values).some(value => typeof value === 'string' && !path.isAbsolute(value))) throw new Error('ABSOLUTE_PATHS_REQUIRED')
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
async function selectComponents(cdp, names, total) {
  await until(cdp, `document.querySelectorAll('input[type=checkbox]:enabled').length === ${total}`)
  await cdp.evaluate(`(() => {
    if (document.querySelectorAll('input[type=checkbox]:checked').length) throw new Error('BAD_SELECTION')
    for (const name of ${JSON.stringify(names)}) {
      const target = Array.from(document.querySelectorAll('input[type=checkbox]')).find(box => box.getAttribute('aria-label') === '选择组件 ' + name)
      if (!target || target.disabled || target.checked) throw new Error('COMPONENT_MISSING')
      target.click()
    }
    return true
  })()`)
  await until(cdp, `document.querySelectorAll('input[type=checkbox]:checked').length === ${names.length}`)
  await button(cdp, '安装所选组件')
  await until(cdp, "document.querySelector('[role=status]')?.innerText.includes('已安装')")
}
async function clickComponent(cdp, name, action) {
  const lookup = `(() => {
    const aside = document.querySelector('aside[aria-label="插件组件"]')
    const title = Array.from(aside?.querySelectorAll('p') || []).find(el => el.innerText.trim() === ${JSON.stringify(name)})
    const candidate = title?.parentElement?.querySelector('button')
    return candidate && !candidate.disabled && candidate.innerText.trim() === ${JSON.stringify(action)} ? candidate : null
  })()`
  await until(cdp, `Boolean(${lookup})`)
  await cdp.evaluate(`(${lookup}).click(); true`)
}
async function canvasDetails(cdp, project) {
  return cdp.evaluate(`window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)}).then(canvas => ({
    nodes: canvas.nodes.map(n => ({ id: n.id, type: n.type, position: n.position,
      assetId: n.data?.node?.params?.assetId, cropMode: n.data?.node?.params?.cropMode,
      cropIndex: n.data?.node?.params?.cropIndex })),
    edges: canvas.edges.map(e => ({ source: e.source, target: e.target, valid: e.data?.valid })),
    groups: canvas.groups.map(g => ({ nodeIds: g.nodeIds }))
  }))`)
}
async function imageMetadata(cdp, assetIds) {
  return cdp.evaluate(`Promise.all(${JSON.stringify(assetIds)}.map(async assetId => {
    const response = await fetch('vibe://app/assets/' + encodeURIComponent(assetId))
    if (!response.ok) throw new Error('ASSET_READ_FAILED')
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob)
    const bytes = await blob.arrayBuffer()
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
    const result = { assetId, width: bitmap.width, height: bitmap.height, sha256: digest }
    bitmap.close()
    return result
  }))`)
}
function fingerprintSubset(canvas, baseIds) {
  const ids = new Set(baseIds)
  const nodes = canvas.nodes.filter(n => ids.has(n.id)).map(({ id, type }) => ({ id, type })).sort((a, b) => a.id.localeCompare(b.id))
  const edges = canvas.edges.filter(e => ids.has(e.source) && ids.has(e.target))
    .sort((a, b) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`))
  assert.equal(nodes.length, 7)
  assert.equal(edges.length, 6)
  return crypto.createHash('sha256').update(JSON.stringify({ nodes, edges })).digest('hex')
}
function assertCropReadback(canvas, assets, sourceId, sourceAssetId, cropAssetIds) {
  const source = canvas.nodes.find(n => n.id === sourceId)
  requireCheck(source?.type === 'image' && source.assetId === sourceAssetId)
  const crops = canvas.nodes.filter(n => n.cropMode === 'four' && cropAssetIds.includes(n.assetId))
  assert.equal(crops.length, 4)
  assert.deepEqual(crops.map(n => n.cropIndex).sort(), [1, 2, 3, 4])
  requireCheck(canvas.groups.some(group => crops.every(node => group.nodeIds.includes(node.id))))
  requireCheck([sourceAssetId, ...cropAssetIds].every(id => assets.some(asset => asset.assetId === id && asset.mimeType === 'image/png')))
}
async function selectTwoNodes(cdp, ids) {
  await cdp.evaluate("document.querySelector('.react-flow__pane').click(); true")
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 55, modifiers: 4 })
  await sleep(250)
  try {
    for (const id of ids) {
      const selector = `.react-flow__node[data-id="${id}"]`
      await until(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)
      await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`)
      await sleep(200)
    }
  } finally {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 55, modifiers: 0 }).catch(() => {})
  }
  await until(cdp, `(() => {
    const selected = Array.from(document.querySelectorAll('.react-flow__node.selected')).map(el => el.getAttribute('data-id')).sort()
    return JSON.stringify(selected) === JSON.stringify(${JSON.stringify([...ids].sort())})
  })()`)
}
async function arrangeSelected(cdp, project, ids, component, direction, gap, capture, captureAfter) {
  arrangeDetail = 'read-before'
  const before = await canvasDetails(cdp, project)
  arrangeDetail = 'click-component'
  await clickComponent(cdp, component, '应用到选中节点')
  arrangeDetail = 'wait-confirmation'
  await until(cdp, `document.querySelector('[role=dialog][aria-label="确认应用预设"]')?.innerText.includes(${JSON.stringify(`将${direction}排列所选的 2 个节点`)})`)
  if (capture) await capture()
  arrangeDetail = 'measure-before'
  const ordered = ids.map(id => before.nodes.find(node => node.id === id)).sort((a, b) => direction === '横向'
    ? a.position.x - b.position.x || a.position.y - b.position.y
    : a.position.y - b.position.y || a.position.x - b.position.x)
  const first = ordered[0]
  const measured = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${first.id}"]`)})
    const transform = getComputedStyle(document.querySelector('.react-flow__viewport')).transform
    const zoom = transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a
    const bounds = element.getBoundingClientRect()
    return { width: bounds.width / zoom, height: bounds.height / zoom }
  })()`)
  const dialogButton = "[...document.querySelectorAll('[role=dialog][aria-label=确认应用预设] button')].find(el => el.innerText.trim() === '应用')"
  await until(cdp, `Boolean(${dialogButton})`)
  await cdp.evaluate(`(${dialogButton}).click(); true`)
  await sleep(700)
  arrangeFacts = await cdp.evaluate(`({
    canvasRoute: location.pathname.startsWith('/canvas/'),
    selectedCount: document.querySelectorAll('.react-flow__node.selected').length,
    selectionChanged: document.body.innerText.includes('选区已变更'),
    contextChanged: document.body.innerText.includes('当前项目或画布已更改'),
    componentChanged: document.body.innerText.includes('组件内容已变更'),
    saved: document.body.innerText.includes('已排列所选节点'),
    dialogOpen: Boolean(document.querySelector('[role=dialog][aria-label="确认应用预设"]'))
  })`)
  if (captureAfter) await captureAfter()
  if (arrangeFacts.selectionChanged || arrangeFacts.contextChanged || arrangeFacts.componentChanged) {
    arrangeDetail = 'rejected-after-confirmation'
    throw new Error('ARRANGEMENT_REJECTED')
  }
  arrangeDetail = 'wait-persist'
  await until(cdp, `window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)}).then(canvas => {
    const nodes = canvas.nodes.filter(n => ${JSON.stringify(ids)}.includes(n.id))
    return nodes.length === 2 && ${direction === '横向' ? 'Math.abs(nodes[0].position.y - nodes[1].position.y) < 0.01' : 'Math.abs(nodes[0].position.x - nodes[1].position.x) < 0.01'}
      && nodes.some(n => { const old = ${JSON.stringify(before.nodes.filter(n => ids.includes(n.id)))}.find(x => x.id === n.id); return old && (Math.abs(old.position.x - n.position.x) > 0.1 || Math.abs(old.position.y - n.position.y) > 0.1) })
  })`, 60_000)
  arrangeDetail = 'check-coordinates'
  const after = await canvasDetails(cdp, project)
  const firstAfter = after.nodes.find(node => node.id === ordered[0].id)
  const secondAfter = after.nodes.find(node => node.id === ordered[1].id)
  if (direction === '横向') {
    assert.ok(Math.abs(firstAfter.position.y - secondAfter.position.y) < 0.01)
    assert.ok(Math.abs(secondAfter.position.x - firstAfter.position.x - measured.width - gap) < 3)
  } else {
    assert.ok(Math.abs(firstAfter.position.x - secondAfter.position.x) < 0.01)
    assert.ok(Math.abs(secondAfter.position.y - firstAfter.position.y - measured.height - gap) < 3)
  }
  return ids.map(id => ({ id, position: after.nodes.find(node => node.id === id).position }))
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
    purpose: args['--online-director'] ? 'isolated installed macOS ARM64 online director smoke' : 'isolated installed macOS ARM64 marketplace smoke',
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
    let storyboardFixture
    try {
      created = await store.createProject(projects, PROJECT_NAME)
      if (args['--exports']) {
        storyboardFixture = await require('./smoke-installed-marketplace-storyboard.cjs').seedStoryboard(store, created.project)
      }
    } finally {
      await store.close()
    }
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
    if (args['--exports']) {
      const poster = require('./smoke-installed-marketplace-poster.cjs')
      const storyboard = require('./smoke-installed-marketplace-storyboard.cjs')
      const helpers = { button, until, clickComponent, capture, checkTasksAndMcp, imageMetadata, canvasDetails, selectTwoNodes }
      const context = () => ({ cdp, browser: active.browser, project, directory: created.directory, output: runRoot, helpers })
      stage = 'install-export-components'
      await anchor(cdp, '/marketplace')
      await button(cdp, '商品棚拍工作流')
      await selectComponents(cdp, ['中性灰棚拍背景'], 4)
      await button(cdp, '返回插件市场')
      await button(cdp, '创作工作室')
      await selectComponents(cdp, ['商品标题海报', '分镜表'], 8)
      await button(cdp, '返回画布')
      await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('.react-flow'))")
      stage = 'poster-png'
      const posterResult = await poster.runPoster(context())
      report.checks.poster = posterResult.summary
      stage = 'storyboard-csv'
      const csvResult = await storyboard.runStoryboard(context(), storyboardFixture)
      report.checks.storyboard = csvResult.summary
      await checkTasksAndMcp(cdp, project.projectId)
      stage = 'export-restart'
      report.checks.firstExit = await closeNormally(active)
      active = null
      try { active = await launch(app, executable, profile) } catch (error) { active = error.launch; throw error }
      cdp = active.renderer
      const card = `Array.from(document.querySelectorAll('[role=button]')).find(el => el.innerText.includes(${JSON.stringify(PROJECT_NAME)}))`
      await until(cdp, `location.pathname === '/workspace' && Boolean(${card})`)
      await cdp.evaluate(`(${card}).click(); true`)
      await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('.react-flow'))")
      stage = 'poster-readback'
      await poster.verifyPoster(context(), posterResult)
      stage = 'csv-readback'
      await storyboard.verifyStoryboard(context(), storyboardFixture, csvResult)
      await checkTasksAndMcp(cdp, project.projectId)
      report.checks.restart = { posterVerified: true, csvVerified: true, tasks: 0, mcpEnabled: false, clients: 0 }
      stage = 'final-exit'
      report.checks.secondExit = await closeNormally(active)
      active = null
      report.result = 'passed'
    } else if (args['--online-director']) {
      stage = 'online-open-project'
      await cdp.evaluate(`Array.from(document.querySelectorAll('[role=button]')).find(el => el.innerText.includes(${JSON.stringify(PROJECT_NAME)})).click(); true`)
      await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
      stage = 'online-director'
      const onlineDirector = require('./smoke-installed-marketplace-online-director.cjs')
      report.checks.onlineDirector = await onlineDirector({ cdp, project, helpers: { button, anchor, until, selectComponents, checkTasksAndMcp, capture } })
      stage = 'online-first-exit'
      report.checks.onlineFirstExit = await closeNormally(active)
      active = null
      stage = 'online-restart'
      try { active = await launch(app, executable, profile) } catch (error) { active = error.launch; throw error }
      cdp = active.renderer
      await until(cdp, "location.pathname === '/workspace' && Boolean(window.vibepaperDesktop?.marketplace)")
      await until(cdp, `Array.from(document.querySelectorAll('[role=button]')).some(el => el.innerText.includes(${JSON.stringify(PROJECT_NAME)}))`)
      await cdp.evaluate(`Array.from(document.querySelectorAll('[role=button]')).find(el => el.innerText.includes(${JSON.stringify(PROJECT_NAME)})).click(); true`)
      await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('.react-flow__node-director'))")
      await onlineDirector.verifyPersistedDirector(cdp, project)
      const restored = await cdp.evaluate(`window.vibepaperDesktop.marketplace.list(${JSON.stringify(project.projectId)}).then(items => items.find(item => item.id === 'interview-two-camera'))`)
      assert.equal(restored.source, 'online')
      assert.equal(restored.installedVersion, report.checks.onlineDirector.version)
      assert.equal(restored.origin?.commit, report.checks.onlineDirector.commit)
      assert.equal(restored.origin?.sha256, report.checks.onlineDirector.sha256)
      assert.equal(restored.components.filter(item => item.installed && item.enabled).length, 4)
      await checkTasksAndMcp(cdp, project.projectId)
      await capture(cdp, '17-online-director-reopened.png')
      report.checks.onlineRestart = { sceneVerified: true, cameraVerified: true, motionVerified: true, componentsEnabled: 4, tasks: 0, mcpEnabled: false, clients: 0 }
      stage = 'online-final-exit'
      report.checks.onlineFinalExit = await closeNormally(active)
      active = null
      report.result = 'passed'
    } else {
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
    const baseline = await canvasDetails(cdp, project)
    const baseIds = baseline.nodes.map(node => node.id)
    assert.equal(fingerprintSubset(baseline, baseIds), originalFingerprint)
    stage = 'install-media-and-skill'
    await button(cdp, '返回画布展示')
    await until(cdp, "location.pathname === '/workspace'")
    await anchor(cdp, '/marketplace')
    await button(cdp, '商品棚拍工作流')
    await until(cdp, "document.querySelector('h1')?.innerText === '商品棚拍工作流'")
    await selectComponents(cdp, ['中性灰棚拍背景', '商品棚拍策划'], 3)
    const studioComponents = await marketplaceState(cdp, project.projectId, 'vibepaper-product-studio')
    for (const id of ['product-workflow', 'neutral-background', 'product-shooting']) {
      requireCheck(studioComponents.some(component => component.id === id && component.installed && component.enabled))
    }
    requireCheck(studioComponents.some(component => component.id === 'studio-prompt' && !component.installed))
    await button(cdp, '返回插件市场')
    await button(cdp, '创作工作室')
    await until(cdp, "document.querySelector('h1')?.innerText === '创作工作室'")
    const creative = await cdp.evaluate(`window.vibepaperDesktop.marketplace.list(${JSON.stringify(project.projectId)}).then(items => {
      const item = items.find(entry => entry.id === 'creative-studio')
      return item && { version: item.version, count: item.components.length }
    })`)
    assert.equal(creative.version, '1.1.0')
    assert.equal(creative.count, 8)
    await selectComponents(cdp, ['四宫格裁剪', '横向排列', '纵向分镜排列'], 8)
    const creativeComponents = await marketplaceState(cdp, project.projectId, 'creative-studio')
    for (const id of ['four-crop', 'horizontal', 'vertical-storyboard']) {
      requireCheck(creativeComponents.some(component => component.id === id && component.installed && component.enabled))
    }
    assert.equal(creativeComponents.filter(component => component.installed).length, 3)
    await checkTasksAndMcp(cdp, project.projectId)
    await button(cdp, '返回画布')
    await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
    stage = 'select-marketplace-skill'
    await until(cdp, `window.vibepaperDesktop.listAgentSkills(${JSON.stringify(project.projectId)}).then(result => result.items.some(skill => skill.name === '商品棚拍策划' && skill.enabled && skill.source === 'marketplace'))`)
    if (!await cdp.evaluate("Boolean(document.querySelector('button[title=Skills]'))")) await button(cdp, 'Agent')
    await button(cdp, 'Skills')
    await button(cdp, '商品棚拍策划')
    await until(cdp, "Array.from(document.querySelectorAll('a')).some(a => a.innerText.includes('在插件市场管理'))")
    await capture(cdp, '07-marketplace-skill.png')
    await button(cdp, '应用', true)
    await until(cdp, "Boolean(document.querySelector('form span[title=商品棚拍策划]'))")
    await checkTasksAndMcp(cdp, project.projectId)
    await button(cdp, 'Agent')
    report.checks.skill = { installed: true, source: 'marketplace', selectableInAgent: true }
    stage = 'marketplace-asset-import'
    assert.deepEqual(await cdp.evaluate(`window.vibepaperDesktop.listAssets(${JSON.stringify(project.projectId)})`), [])
    await button(cdp, '插件组件')
    await clickComponent(cdp, '中性灰棚拍背景', '导入画布')
    await until(cdp, `window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)}).then(canvas => canvas.nodes.length === 8 && canvas.nodes.filter(n => n.data?.node?.params?.assetId).length === 1)`)
    let afterImport = await canvasDetails(cdp, project)
    const source = afterImport.nodes.find(node => node.assetId)
    requireCheck(source?.type === 'image' && typeof source.assetId === 'string')
    const sourceId = source.id
    const sourceAssetId = source.assetId
    const assetsAfterImport = await cdp.evaluate(`window.vibepaperDesktop.listAssets(${JSON.stringify(project.projectId)})`)
    assert.equal(assetsAfterImport.length, 1)
    requireCheck(assetsAfterImport[0].assetId === sourceAssetId && assetsAfterImport[0].mimeType === 'image/png')
    const [sourceBefore] = await imageMetadata(cdp, [sourceAssetId])
    requireCheck(sourceBefore.width >= 2 && sourceBefore.height >= 2)
    assert.equal(fingerprintSubset(afterImport, baseIds), originalFingerprint)
    await checkTasksAndMcp(cdp, project.projectId)
    report.checks.asset = { importedPng: true, width: sourceBefore.width, height: sourceBefore.height }
    stage = 'crop-marketplace-source'
    await until(cdp, `Boolean(document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${sourceId}"]`)}))`)
    await cdp.evaluate(`document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${sourceId}"]`)}).click(); true`)
    await clickComponent(cdp, '四宫格裁剪', '打开工具')
    await until(cdp, "Boolean(document.querySelector('img[alt=待裁剪图片]')?.naturalWidth && document.querySelector('button[aria-label=确认裁剪]:not(:disabled)'))")
    requireCheck(await cdp.evaluate("Array.from(document.querySelectorAll('button')).some(b => b.innerText.trim() === '四宫格' && b.getAttribute('aria-pressed') === 'true')"))
    await capture(cdp, '08-crop-preview.png')
    await button(cdp, '确认裁剪')
    await until(cdp, `window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)}).then(canvas => {
      const crops = canvas.nodes.filter(n => n.data?.node?.params?.cropMode === 'four')
      return crops.length === 4 && canvas.groups.some(group => crops.every(n => group.nodeIds.includes(n.id)))
    })`, 90_000)
    const cropped = await canvasDetails(cdp, project)
    assert.equal(cropped.nodes.length, 12)
    assert.equal(cropped.edges.length, 6)
    const cropNodes = cropped.nodes.filter(node => node.cropMode === 'four').sort((a, b) => a.cropIndex - b.cropIndex)
    const cropAssetIds = cropNodes.map(node => node.assetId)
    assert.equal(new Set(cropAssetIds).size, 4)
    requireCheck(cropAssetIds.every(id => typeof id === 'string' && id !== sourceAssetId))
    const assetsAfterCrop = await cdp.evaluate(`window.vibepaperDesktop.listAssets(${JSON.stringify(project.projectId)})`)
    assert.equal(assetsAfterCrop.length, 5)
    assertCropReadback(cropped, assetsAfterCrop, sourceId, sourceAssetId, cropAssetIds)
    const [sourceAfter, ...cropImages] = await imageMetadata(cdp, [sourceAssetId, ...cropAssetIds])
    assert.equal(sourceAfter.sha256, sourceBefore.sha256)
    assert.equal(sourceAfter.width, sourceBefore.width)
    assert.equal(sourceAfter.height, sourceBefore.height)
    const left = Math.floor(sourceBefore.width * 0.04)
    const top = Math.floor(sourceBefore.height * 0.04)
    const right = Math.ceil(sourceBefore.width * (0.04 + 0.92))
    const bottom = Math.ceil(sourceBefore.height * (0.04 + 0.92))
    const cropWidth = right - left
    const cropHeight = bottom - top
    const expectedSizes = [0, 1, 2, 3].map(index => {
      const column = index % 2
      const row = Math.floor(index / 2)
      return { width: Math.floor(cropWidth * (column + 1) / 2) - Math.floor(cropWidth * column / 2),
        height: Math.floor(cropHeight * (row + 1) / 2) - Math.floor(cropHeight * row / 2) }
    })
    assert.deepEqual(cropImages.map(({ width, height }) => ({ width, height })), expectedSizes)
    assert.equal(fingerprintSubset(cropped, baseIds), originalFingerprint)
    await checkTasksAndMcp(cdp, project.projectId)
    await button(cdp, '聚焦视图')
    await sleep(600)
    await capture(cdp, '09-crop-result.png')
    report.checks.crop = { mode: 'four', outputCount: 4, sizes: expectedSizes, sourceUnchanged: true, allAssetsReadable: true, grouped: true }
    stage = 'arrange-selection'
    await cdp.evaluate("document.querySelector('aside[aria-label=插件组件] button[aria-label=关闭]').click(); true")
    const textNodes = baseline.nodes.filter(node => node.type === 'text').sort((a, b) => a.position.y - b.position.y)
    assert.equal(textNodes.length, 3)
    const selectedIds = textNodes.slice(0, 2).map(node => node.id)
    await selectTwoNodes(cdp, selectedIds)
    await button(cdp, '插件组件')
    stage = 'arrange-horizontal'
    await arrangeSelected(cdp, project, selectedIds, '横向排列', '横向', 28,
      () => capture(cdp, '10-horizontal-confirmation.png'), () => capture(cdp, '10-horizontal-after.png'))
    stage = 'arrange-vertical'
    const arrangedPositions = await arrangeSelected(cdp, project, selectedIds, '纵向分镜排列', '纵向', 28,
      () => capture(cdp, '10-vertical-confirmation.png'))
    await checkTasksAndMcp(cdp, project.projectId)
    await button(cdp, '聚焦视图')
    await sleep(600)
    await capture(cdp, '11-vertical-result.png')
    report.checks.arrangement = { selectedNodes: 2, horizontal: true, vertical: true, gap: 28 }
    stage = 'second-normal-exit'
    report.checks.secondExit = await closeNormally(active)
    active = null
    stage = 'extended-restart-readback'
    try { active = await launch(app, executable, profile) } catch (error) { active = error.launch; throw error }
    cdp = active.renderer
    await until(cdp, "location.pathname === '/workspace' && Boolean(window.vibepaperDesktop?.marketplace)")
    await until(cdp, `Array.from(document.querySelectorAll('[role=button]')).some(el => el.innerText.includes(${JSON.stringify(PROJECT_NAME)}))`)
    await cdp.evaluate(`Array.from(document.querySelectorAll('[role=button]')).find(el => el.innerText.includes(${JSON.stringify(PROJECT_NAME)})).click(); true`)
    await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
    await until(cdp, "document.querySelectorAll('.react-flow__node').length === 12 && document.querySelectorAll('.react-flow__edge').length === 6")
    const reopened = await canvasDetails(cdp, project)
    const reopenedAssets = await cdp.evaluate(`window.vibepaperDesktop.listAssets(${JSON.stringify(project.projectId)})`)
    assert.equal(reopened.nodes.length, 12)
    assert.equal(reopened.edges.length, 6)
    assertCropReadback(reopened, reopenedAssets, sourceId, sourceAssetId, cropAssetIds)
    assert.equal(fingerprintSubset(reopened, baseIds), originalFingerprint)
    for (const expected of arrangedPositions) {
      const actual = reopened.nodes.find(node => node.id === expected.id)
      requireCheck(actual && Math.abs(actual.position.x - expected.position.x) < 0.001 && Math.abs(actual.position.y - expected.position.y) < 0.001)
    }
    const restoredMedia = await imageMetadata(cdp, [sourceAssetId, ...cropAssetIds])
    assert.deepEqual(restoredMedia.map(({ width, height, sha256 }) => ({ width, height, sha256 })), [sourceAfter, ...cropImages].map(({ width, height, sha256 }) => ({ width, height, sha256 })))
    await until(cdp, `window.vibepaperDesktop.listAgentSkills(${JSON.stringify(project.projectId)}).then(result => result.items.some(skill => skill.name === '商品棚拍策划' && skill.enabled && skill.source === 'marketplace'))`)
    await checkTasksAndMcp(cdp, project.projectId)
    await button(cdp, '聚焦视图')
    await sleep(600)
    await capture(cdp, '12-extended-reopened.png')
    report.checks.extendedRestart = { nodes: 12, edges: 6, sourceAndCropsReadable: true, cropGroupPreserved: true, positionsPreserved: true, skillAvailable: true, clients: 0, tasks: 0 }
    stage = 'third-normal-exit'
    report.checks.thirdExit = await closeNormally(active)
    active = null
    report.result = 'passed'
    }
  } catch (error) {
    report.failure = { stage, type: error?.code === 'ERR_ASSERTION' ? 'assertion-failed' : 'operation-failed' }
    if (args['--exports']) {
      const caller = /smoke-installed-marketplace-(poster|storyboard)\.cjs:(\d+):\d+/.exec(error?.stack ?? '')
      if (caller) report.failure.check = caller[1] + ':' + caller[2]
    }
    if (stage.startsWith('arrange-')) { report.failure.step = arrangeDetail; report.failure.state = arrangeFacts }
    if (stage === 'online-director' && ['preconditions', 'index', 'download', 'install', 'director', 'save'].includes(error?.onlineStage)) report.failure.step = error.onlineStage
    if (active?.renderer) await capture(active.renderer, 'failure-state.png').catch(() => {})
    await cleanup(active)
    active = null
  }
  await fs.writeFile(path.join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ result: report.result, evidenceDirectory: runRoot, ...(report.failure ? { failure: report.failure } : {}) }))
  if (report.result === 'passed') await fs.rm(fixture, { recursive: true, force: true })
  else process.exitCode = 1
}
main().catch(() => { console.error('Smoke setup failed. Verify absolute paths, Node 24 ARM64, app layout, and output permissions.'); process.exitCode = 1 })
