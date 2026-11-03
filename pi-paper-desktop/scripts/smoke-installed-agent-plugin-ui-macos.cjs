'use strict'
// Offline macOS packaged-app UI regression. Run with Node 24 on macOS arm64:
// node scripts/smoke-installed-agent-plugin-ui-macos.cjs <absolute-app-path> <absolute-evidence-dir>
// Uses a fresh profile and project in a unique private temp directory. Never touches /Applications or a user's project.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const nativeFs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn, execFileSync } = require('node:child_process')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const NAME = 'Agent and plugin UI isolated fixture'
const PRODUCT = '商品棚拍场景'
async function waitUntil(check, timeout = 35000) {
  const end = Date.now() + timeout
  let lastError
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result } catch (error) { lastError = error }
    await sleep(160)
  }
  throw new Error(`WAIT_TIMEOUT${lastError ? ': ' + lastError.message : ''}`)
}
async function hash(file) {
  const h = crypto.createHash('sha256')
  for await (const chunk of nativeFs.createReadStream(file)) h.update(chunk)
  return h.digest('hex')
}
async function readJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
  if (!response.ok) throw new Error('CDP_HTTP_FAILED')
  return response.json()
}
function loopback(url, port) {
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'ws:')
  assert.equal(parsed.hostname, '127.0.0.1')
  assert.equal(Number(parsed.port), port)
  return parsed.href
}
async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP_CONNECT_TIMEOUT')), 10000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')) }, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id); clearTimeout(item.timer)
    if (message.error) item.reject(new Error(`${message.error.message}`))
    else item.resolve(message.result || {})
  })
  socket.addEventListener('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('CDP_CLOSED')) }
    pending.clear()
  })
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP_TIMEOUT ${method}`)) }, 15000)
      pending.set(id, { resolve, reject, timer })
      try { socket.send(JSON.stringify({ id, method, params })) } catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
    })
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails || result.result?.subtype === 'error') throw new Error(`EVALUATION_FAILED ${result.exceptionDetails?.text || ''}`)
    return result.result?.value
  }
  return { send, evaluate, close: () => socket.close() }
}
async function launch(app, executable, profile) {
  await fs.rm(path.join(profile, 'DevToolsActivePort'), { force: true })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192) })
  let spawnError
  child.on('error', error => { spawnError = error })
  const partial = { executable, profile, child }
  try {
    const portData = await waitUntil(async () => {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) return { failure: `${spawnError?.message || ''} APP_EXITED code=${child.exitCode} signal=${child.signalCode} ${stderr}` }

      const [p, browserPath] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/u)
      const port = Number(p)
      return Number.isInteger(port) && port > 0 && port < 65536 && /^\/devtools\/browser\/[\w-]+$/u.test(browserPath || '') ? { port, browserPath } : null
    }, 75000)
    if (portData.failure) throw new Error(portData.failure)
    const target = await waitUntil(async () => (await readJson(`http://127.0.0.1:${portData.port}/json/list`)).find(x => x.type === 'page' && x.url.startsWith('vibe://app/') && x.webSocketDebuggerUrl), 60000)
    const renderer = await connect(loopback(target.webSocketDebuggerUrl, portData.port))
    const browser = await connect(loopback(`ws://127.0.0.1:${portData.port}${portData.browserPath}`, portData.port))
    await renderer.send('Page.enable'); await renderer.send('Runtime.enable')
    return { ...partial, renderer, browser }
  } catch (error) { error.instance = partial; throw error }
}
async function close(instance) {
  if (!instance) return
  await instance.browser?.send('Browser.close').catch(() => {})
  const child = instance.child
  if (child && child.exitCode === null && child.signalCode === null) await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 7000).catch(() => {})
  instance.renderer?.close(); instance.browser?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 8000).catch(() => {})
  }
}
async function until(cdp, expression, timeout) {
  try { return await waitUntil(() => cdp.evaluate(expression), timeout) }
  catch (error) { throw new Error(`${error.message}: ${expression}`) }
}
async function click(cdp, selector) {
  await until(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`)
}
async function clickAt(cdp, selector) {
  await until(cdp, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.width > 0 && r.height > 0 && Boolean(hit && (hit === el || el.contains(hit))) })()` )
  const point = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, reachable: Boolean(hit && (hit === el || el.contains(hit))) } })()`)
  assert.equal(point.reachable, true, `POINTER_TARGET_OBSTRUCTED: ${selector}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
}
async function button(cdp, label) {
  const lookup = `Array.from(document.querySelectorAll('button')).find(el => !el.disabled && (el.innerText.trim() === ${JSON.stringify(label)} || el.title === ${JSON.stringify(label)} || el.getAttribute('aria-label') === ${JSON.stringify(label)}))`
  await until(cdp, `Boolean(${lookup})`)
  await cdp.evaluate(`(${lookup}).click(); true`)
}
async function main() {
  const [rawApp, output] = process.argv.slice(2)
  assert.ok(rawApp && output && path.isAbsolute(rawApp) && path.isAbsolute(output), 'absolute app and output paths are required')
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64'); assert.equal(Number(process.versions.node.split('.')[0]), 24)
  const app = await fs.realpath(rawApp)
  assert.ok(app.endsWith('.app') && !app.startsWith('/Applications/'), 'Use an isolated build artifact, never the installed app')
  const appRoot = path.join(app, 'Contents/Resources/app')
  const executableName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim()
  assert.equal(path.basename(executableName), executableName)
  const executable = path.join(app, 'Contents/MacOS', executableName)
  execFileSync('/usr/bin/lipo', [executable, '-verify_arch', 'arm64'], { stdio: 'ignore' })
  const storePath = path.join(appRoot, 'src/project-store.cjs')
  for (const file of [executable, storePath, path.join(appRoot, 'renderer/index.html'), path.join(appRoot, 'package.json')]) await fs.access(file)
  await fs.mkdir(output, { recursive: true, mode: 0o700 })
  const evidence = await fs.mkdtemp(path.join(await fs.realpath(output), 'corrective-ui-'))
  const fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pi-paper-corrective-fixture-'))
  const profile = path.join(fixture, 'profile'), projects = path.join(fixture, 'projects')
  await fs.mkdir(profile, { mode: 0o700 }); await fs.mkdir(projects, { mode: 0o700 })
  const report = { result: 'failed', stage: 'fixture', artifact: { app, executableSha256: await hash(executable), rendererIndexSha256: await hash(path.join(appRoot, 'renderer/index.html')) }, isolation: { profile, fixture }, checks: {}, screenshots: [] }
  let instance
  function setStage(name) { report.stage = name; console.log(`stage=${name}`) }
  async function capture(name) {
    await sleep(1200) // Allow popover animation and the first rendered WebGL frame to settle.
    await instance.renderer.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const data = await instance.renderer.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await fs.writeFile(path.join(evidence, name), Buffer.from(data.data, 'base64'), { flag: 'wx', mode: 0o600 }); report.screenshots.push(name)
  }
  try {
    const { createLocalProjectStore } = require(storePath)
    const store = createLocalProjectStore()
    let opened
    try { opened = await store.createProject(projects, NAME) } finally { await store.close() }
    const { project } = opened, pid = JSON.stringify(project.projectId), cid = JSON.stringify(project.canvasId)
    const canvas = `window.vibepaperDesktop.loadCanvas(${pid}, ${cid})`
    const packageState = `window.vibepaperDesktop.marketplace.list(${pid}).then(pkgs => pkgs.find(p => p.id === 'creative-studio'))`
    await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: opened.directory }), { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(profile, 'ui-settings.json'), JSON.stringify({ schemaVersion: 1, language: 'zh' }), { flag: 'wx', mode: 0o600 })
    setStage('launch')
    try { instance = await launch(app, executable, profile) } catch (error) { instance = error.instance; throw error }
    let cdp = instance.renderer
    await until(cdp, `location.pathname === '/workspace' && window.vibepaperDesktop.getActiveProject().then(p => p?.projectId === ${pid} && p?.canvasId === ${cid})`)
    const projectCard = `Array.from(document.querySelectorAll('[role=button]')).find(el => el.innerText.includes(${JSON.stringify(NAME)}))`
    await until(cdp, `Boolean(${projectCard})`); await cdp.evaluate(`(${projectCard}).click(); true`)
    await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
    await until(cdp, "Boolean(document.querySelector('button[aria-label=\"选择 Agent 思考模型\"]'))")
    setStage('cat')
    const catSelector = 'img[src$="paper-agent-cat.svg"]'
    await until(cdp, `Boolean(document.querySelector(${JSON.stringify(catSelector)}))`)
    await until(cdp, `(() => { const el = document.querySelector(${JSON.stringify(catSelector)}); return el.complete && el.naturalWidth > 0 && el.naturalHeight > 0 && el.getBoundingClientRect().width > 0 })()`)
    report.checks.cat = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(catSelector)}); return { src: el.currentSrc, complete: el.complete, naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight, visibleWidth: el.getBoundingClientRect().width } })()`)
    await capture('01-agent-welcome.png')
    setStage('composer-hit-targets')
    const hitExpression = `(() => {
      const selectors = ['button[aria-label="添加 Skill"]', 'button[aria-label="生成偏好"]', 'select[aria-label="会话模式"]', 'select[aria-label="会话角色"]', 'button[aria-label="选择 Agent 思考模型"]', 'button[aria-label="发送"]'];
      const panel = document.querySelector('.vp-agent-motion [role=separator][aria-orientation=vertical]')?.parentElement;
      return { panelWidth: panel?.getBoundingClientRect().width, items: selectors.map(selector => {
        const el = document.querySelector(selector); if (!el) return { selector, missing: true };
        const r = el.getBoundingClientRect(); const inset = Math.min(5, r.width / 4);
        const samples = [r.x + inset, r.x + r.width / 2, r.right - inset].map(x => {
          const hit = document.elementFromPoint(x, r.y + r.height / 2);
          return { x, reachable: Boolean(hit && (hit === el || el.contains(hit))), hitTag: hit?.tagName, hitLabel: hit?.getAttribute('aria-label') || hit?.getAttribute('title') || '' };
        });
        return { selector, x: r.x, y: r.y, width: r.width, height: r.height, samples };
      }) };
    })()`
    async function assertHitTargets(expectedWidth) {
      await until(cdp, `Math.abs(document.querySelector('.vp-agent-motion [role=separator][aria-orientation=vertical]').parentElement.getBoundingClientRect().width - ${expectedWidth}) < 1`)
      const result = await cdp.evaluate(hitExpression)
      report.checks.composerHitTargets ||= {}
      report.checks.composerHitTargets[String(expectedWidth)] = result
      assert.ok(result.items.every(item => item.width > 0 && item.height > 0 && item.samples.every(sample => sample.reachable)), `COMPOSER_CONTROLS_OVERLAP_${expectedWidth}`)
      await capture(`01b-composer-${expectedWidth}px.png`)
    }
    async function dragPanel(delta) {
      const handle = await cdp.evaluate(`(() => { const r = document.querySelector('.vp-agent-motion [role=separator][aria-orientation=vertical]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(150, r.height / 2) } })()`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + delta, y: handle.y, button: 'left', buttons: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + delta, y: handle.y, button: 'left', buttons: 0, clickCount: 1 })
    }
    async function dragTo(width) {
      await until(cdp, "document.querySelector('.vp-agent-motion [role=separator][aria-orientation=vertical]')?.parentElement.getBoundingClientRect().width >= 299")
      await sleep(500)
      const current = await cdp.evaluate("document.querySelector('.vp-agent-motion [role=separator][aria-orientation=vertical]').parentElement.getBoundingClientRect().width")
      if (Math.abs(current - width) > 1) await dragPanel(current - width)
      await until(cdp, `Math.abs(document.querySelector('.vp-agent-motion [role=separator][aria-orientation=vertical]').parentElement.getBoundingClientRect().width - ${width}) < 1`)
    }
    async function assertHeaderTargets(width) {
      const result = await cdp.evaluate(`(() => {
        const panel = document.querySelector('.vp-agent-motion'); const nav = document.querySelector('[data-testid="desktop-agent-header-navigation"]');
        const pr = panel?.getBoundingClientRect(); const nr = nav?.getBoundingClientRect();
        const summarize = el => { if (!el) return null; const r = el.getBoundingClientRect(), inset = Math.min(5, r.width / 4);
          const samples = [r.x + inset, r.x + r.width / 2, r.right - inset].map(x => { const hit = document.elementFromPoint(x, r.y + r.height / 2); return { x, reachable: Boolean(hit && (hit === el || el.contains(hit))), hitTag: hit?.tagName, hitLabel: hit?.getAttribute('aria-label') || '' } });
          return { label: el.getAttribute('aria-label') || el.title || '', x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom,
            insideViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
            insidePanel: Boolean(pr && r.left >= pr.left - 1 && r.right <= pr.right + 1),
            insideNav: Boolean(nr && r.left >= nr.left - 1 && r.right <= nr.right + 1), samples };
        };
        return { panel: pr && { left: pr.left, right: pr.right, width: pr.width }, nav: nr && { left: nr.left, right: nr.right, width: nr.width, clientWidth: nav.clientWidth, scrollWidth: nav.scrollWidth },
          settings: summarize(document.querySelector('button[aria-label="模型设置"]')), close: summarize(document.querySelector('button[aria-label="关闭对话"]')),
          navButtons: Array.from(nav?.querySelectorAll('button') || []).map(summarize) };
      })()`)
      report.checks.headerHitTargets ||= {}
      report.checks.headerHitTargets[String(width)] = result
      const targetOK = item => item && item.insideViewport && item.insidePanel && item.width > 0 && item.height > 0 && item.samples.every(sample => sample.reachable)
      assert.ok(targetOK(result.settings) && targetOK(result.close), `AGENT_HEADER_HIDDEN_OR_OBSTRUCTED_${width}`)
      assert.equal(result.navButtons.length, 7, `AGENT_HEADER_NAV_COUNT_${width}`)
      assert.ok(result.navButtons.every(item => targetOK(item) && item.insideNav), `AGENT_HEADER_NAV_CLIPPED_${width}`)
    }
    async function exerciseHeader(width) {
      await assertHeaderTargets(width)
      console.log(`header-settings-${width}`)
      await clickAt(cdp, 'button[aria-label="模型设置"]')
      await until(cdp, "location.pathname === '/settings/providers'")
      await button(cdp, '取消')
      await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('button[aria-label=\"选择 Agent 思考模型\"]'))")
      await dragTo(width)
      await assertHeaderTargets(width)
      console.log(`header-close-${width}`)
      await clickAt(cdp, 'button[aria-label="关闭对话"]')
      await until(cdp, "Boolean(document.querySelector('button[aria-label=\"打开对话\"]'))")
      await sleep(1000) // The launcher moves as the panel closing animation expands the canvas.
      await clickAt(cdp, 'button[aria-label="打开对话"]')
      await until(cdp, "Boolean(document.querySelector('button[aria-label=\"选择 Agent 思考模型\"]'))")
      await dragTo(width)
      report.checks.headerHitTargets[String(width)].pointerSettingsAndCloseWorked = true
      console.log(`header-reopen-${width}`)
    }
    await assertHitTargets(380)
    await exerciseHeader(380)
    await dragTo(300)
    await assertHitTargets(300)
    await clickAt(cdp, 'button[aria-label="选择 Agent 思考模型"]')
    await until(cdp, "document.querySelector('.vp-soft-popover[data-open=true]')?.innerText.includes('自定义配置')")
    await clickAt(cdp, 'button[aria-label="选择 Agent 思考模型"]')
    await clickAt(cdp, 'button[aria-label="生成偏好"]')
    await until(cdp, "document.body.innerText.includes('偏好设置') && document.body.innerText.includes('配置默认模型与参数')")
    await capture('01c-preferences-300px.png')
    await clickAt(cdp, 'button[title="对话"]')
    await until(cdp, "Boolean(document.querySelector('button[aria-label=\"选择 Agent 思考模型\"]'))")
    report.checks.composerHitTargets['300'].modelAndPreferencesPointerClicks = true
    await exerciseHeader(300)
    await dragTo(380)
    setStage('model-selector')
    await clickAt(cdp, 'button[aria-label="选择 Agent 思考模型"]')
    await until(cdp, "Boolean(document.querySelector('.vp-soft-popover[data-open=true]')) && document.querySelector('.vp-soft-popover[data-open=true]').innerText.includes('自定义配置')")
    const modelText = await cdp.evaluate("document.querySelector('.vp-soft-popover[data-open=true]').innerText")
    assert.ok(!modelText.includes('偏好设置') && !modelText.includes('图片模型'))
    report.checks.modelSelector = { text: modelText, providerMenu: true, preferencesContentAbsent: true }
    await capture('02-agent-model-selector.png')
    await clickAt(cdp, 'button[aria-label="选择 Agent 思考模型"]')
    setStage('generation-preferences')
    await clickAt(cdp, 'button[aria-label="生成偏好"]')
    await until(cdp, "document.body.innerText.includes('偏好设置') && document.body.innerText.includes('配置默认模型与参数') && ['文本模型','图片模型','视频模型'].every(x => document.body.innerText.includes(x))")
    assert.equal(await cdp.evaluate("Boolean(document.querySelector('.vp-soft-popover[data-open=true]'))"), false)
    assert.equal(await cdp.evaluate("document.body.innerText.includes('Agent 对话默认走 DeepSeek')"), false)
    report.checks.preferences = { textImageVideoDefaults: true, providerConfigurationEntry: true, legacyWebDefaultsAbsent: true, modelMenuClosed: true }
    await capture('03-generation-preferences.png')
    await button(cdp, '返回画布展示')
    await until(cdp, "location.pathname === '/workspace'")
    setStage('install-scene-only')
    await click(cdp, 'a[href="/marketplace"]')
    await until(cdp, "location.pathname === '/marketplace'")
    const card = "Array.from(document.querySelectorAll('button')).find(el => el.querySelector('h3')?.innerText.trim() === '创作工作室')"
    await until(cdp, `Boolean(${card})`); await cdp.evaluate(`(${card}).click(); true`)
    await until(cdp, "document.querySelector('h1')?.innerText.trim() === '创作工作室'")
    const selector = 'input[type=checkbox][aria-label^="选择组件 "]'
    await until(cdp, `document.querySelectorAll(${JSON.stringify(selector)}).length === 8`)
    const target = 'input[type=checkbox][aria-label="选择组件 商品棚拍场景"]'
    assert.equal(await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(selector)} + ':checked').length`), 0)
    await click(cdp, target)
    assert.equal(await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(selector)} + ':checked').length`), 1)
    const installButton = "Array.from(document.querySelectorAll('button')).find(el => !el.disabled && el.innerText.includes('安装所选组件'))"
    await until(cdp, `Boolean(${installButton})`); await cdp.evaluate(`(${installButton}).click(); true`)
    await until(cdp, `${packageState}.then(p => p?.components.find(c => c.id === 'product-stage')?.enabled)`)
    const state = await cdp.evaluate(`${packageState}.then(p => p.components.map(c => ({id: c.id, type: c.type, installed: c.installed, enabled: c.enabled})))`)
    assert.equal(state.filter(c => c.installed || c.enabled).length, 1)
    assert.deepEqual(state.find(c => c.id === 'product-stage'), { id: 'product-stage', type: 'director_scene', installed: true, enabled: true })
    report.checks.sceneOnly = state
    await capture('04-only-scene-installed.png')
    await button(cdp, '返回画布')
    await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
    setStage('canvas-plugin-panel')
    await button(cdp, '插件组件')
    await until(cdp, "document.querySelector('aside[aria-label=插件组件]')?.innerText.includes('商品棚拍场景')")
    const pluginText = await cdp.evaluate("document.querySelector('aside[aria-label=插件组件]').innerText")
    assert.ok(pluginText.includes('新建导演台') && !pluginText.includes('暂无已启用组件'))
    assert.ok(!pluginText.includes('商品三分之四机位') && !pluginText.includes('缓慢推近'))
    report.checks.canvasPanel = { productStageVisible: true, createDirectorAvailable: true, falseEmptyAbsent: true, disabledItemsAbsent: true }
    await capture('05-canvas-plugin-panel.png')
    await button(cdp, '新建导演台')
    await until(cdp, `${canvas}.then(c => c.nodes.length === 1 && c.nodes[0].type === 'director')`)
    await until(cdp, "Boolean(document.querySelector('.react-flow__node-director'))")
    await cdp.evaluate("document.querySelector('.react-flow__node-director').click(); true")
    const edit = "Array.from(document.querySelectorAll('.react-flow__node-director button')).find(el => !el.disabled && el.innerText.trim() === '编辑')"
    await until(cdp, `Boolean(${edit})`); await cdp.evaluate(`(${edit}).click(); true`)
    setStage('apply-scene')
    await until(cdp, `Array.from(document.querySelectorAll('button')).some(b => !b.disabled && b.innerText.trim() === ${JSON.stringify(PRODUCT)})`)
    await button(cdp, PRODUCT)
    await until(cdp, "Array.from(document.querySelectorAll('button')).some(b => b.innerText.trim() === '撤销插件应用')")
    const yaw = "Array.from(document.querySelectorAll('label')).find(l => l.querySelector('span')?.innerText === 'Yaw')?.querySelector('input[type=range]')?.value"
    await until(cdp, `Number(${yaw}) === 35`)
    await capture('06-director-scene-applied.png')
    const closeEditor = "Array.from(document.querySelectorAll('button[title=关闭]')).find(el => el.parentElement?.innerText.includes('导演台'))"
    await until(cdp, `Boolean(${closeEditor})`); await cdp.evaluate(`(${closeEditor}).click(); true`)
    await until(cdp, `${canvas}.then(c => c.nodes[0]?.data?.node?.params?.sceneObjects?.length === 2 && c.nodes[0].data.node.params.camera?.yaw === 35)`, 75000)
    const params = await cdp.evaluate(`${canvas}.then(c => c.nodes[0].data.node.params)`)
    assert.deepEqual(params.sceneObjects.map(({ id, ...obj }) => obj), [
      { category: 'prop', kind: '桌子', name: '展示桌', position: [0,0,0], rotation: 0, scale: 1, color: '#8b6914' },
      { category: 'prop', kind: '灯', name: '侧光', position: [-2,0,1], rotation: 25, scale: 1, color: '#f5d76e' },
    ])
    assert.deepEqual(params.camera, { yaw: 35, pitch: 25, distance: 8 })
    report.checks.appliedScene = { objectNames: params.sceneObjects.map(o => o.name), camera: params.camera, savedToCanvas: true }
    setStage('model-settings-return')
    await until(cdp, "Boolean(document.querySelector('button[aria-label=移除参考]')) && Boolean(document.querySelector('textarea'))")
    const refsBefore = await cdp.evaluate("Array.from(document.querySelectorAll('button[aria-label=移除参考]')).map(b => b.parentElement.innerText)")
    assert.ok(refsBefore.length > 0)
    const draft = '隔离验收草稿'
    await cdp.evaluate(`(() => { const input = document.querySelector('textarea'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(draft)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await until(cdp, `document.querySelector('textarea')?.value === ${JSON.stringify(draft)}`)
    await clickAt(cdp, 'button[aria-label="选择 Agent 思考模型"]')
    await until(cdp, "document.querySelector('.vp-soft-popover[data-open=true]')?.innerText.includes('自定义配置')")
    await button(cdp, '自定义配置')
    await until(cdp, "location.pathname === '/settings/providers'")
    await button(cdp, '取消')
    await until(cdp, `location.pathname.startsWith('/canvas/') && document.querySelector('textarea')?.value === ${JSON.stringify(draft)} && Boolean(document.querySelector('button[aria-label=移除参考]'))`)
    const refsAfter = await cdp.evaluate("Array.from(document.querySelectorAll('button[aria-label=移除参考]')).map(b => b.parentElement.innerText)")
    assert.deepEqual(refsAfter, refsBefore)
    report.checks.modelSettingsReturn = { draftPreserved: true, referenceCount: refsAfter.length, referencesPreserved: true }
    await capture('07-model-settings-return.png')
    setStage('restart-and-reopen')
    await close(instance); instance = null
    try { instance = await launch(app, executable, profile) } catch (error) { instance = error.instance; throw error }
    cdp = instance.renderer
    await until(cdp, `location.pathname === '/workspace' && window.vibepaperDesktop.getActiveProject().then(p => p?.projectId === ${pid})`)
    await until(cdp, `Boolean(${projectCard})`); await cdp.evaluate(`(${projectCard}).click(); true`)
    await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('.react-flow__node-director'))")
    await cdp.evaluate("document.querySelector('.react-flow__node-director').click(); true")
    await until(cdp, `Boolean(${edit})`); await cdp.evaluate(`(${edit}).click(); true`)
    await until(cdp, `Number(${yaw}) === 35`)
    const restored = await cdp.evaluate(`${canvas}.then(c => c.nodes[0].data.node.params)`)
    assert.deepEqual(restored.sceneObjects.map(o => o.name), ['展示桌', '侧光'])
    assert.deepEqual(restored.camera, { yaw: 35, pitch: 25, distance: 8 })
    report.checks.restart = { sceneObjectsRestored: true, editorCameraRestored: true }
    await capture('08-director-reopened-after-restart.png')
    const tasks = await cdp.evaluate(`window.vibepaperDesktop.listTasks(${pid})`)
    const mcp = await cdp.evaluate('window.vibepaperDesktop.getMcpState()')
    assert.equal(tasks.length, 0); assert.equal(mcp.enabled, false); assert.equal(mcp.clients.length, 0)
    report.checks.sideEffects = { generationTasks: 0, mcpEnabled: false, mcpClients: 0, credentialsProvided: false }
    report.result = 'passed'; setStage('complete')
  } catch (error) {
    report.failure = { message: error.message, stack: error.stack }
    if (instance?.renderer) await capture('failure.png').catch(() => {})
  } finally { await close(instance).catch(() => {}) }
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  if (report.result === 'passed') await fs.rm(fixture, { recursive: true, force: true })
  console.log(JSON.stringify({ result: report.result, stage: report.stage, evidence, failure: report.failure?.message }))
  if (report.result !== 'passed') process.exitCode = 1
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
