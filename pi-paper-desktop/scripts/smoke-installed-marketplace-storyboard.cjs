'use strict'
// Real installed-app storyboard smoke. Call seedStoryboard before opening the
// fixture; invoke runStoryboard on its canvas, then verifyStoryboard after restart.
// CSV bytes are retained even when a later assertion fails (e.g. old app builds).
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const FIRST = { title: '=镜头甲,"特写"', content: '第一行，中文\n第二行 "原样"', prompt: ' -1+2', camera: '静态文本' }
const SECOND = { title: '镜头乙', content: '\t+SUM(2,3)\n下一行 "你好"', prompt: '正常提示', camera: ' @HYPERLINK("x")' }
const VIEW = { yaw: 30, pitch: 20, distance: 8.5 }
const MOTION = { from: { yaw: -30, pitch: 20, distance: 8.5 }, to: VIEW, duration: 6 }
const STATIC = { title: '静态机位', camera: VIEW }
const DIRECTOR = { title: '导演镜头', camera: VIEW, motion: MOTION }
const TEXT_CSV = '\ufeff"序号","提示词","运镜","内容","标题"\r\n"1","正常提示","\' @HYPERLINK(""x"")","\'\t+SUM(2,3)\n下一行 ""你好""","镜头乙"\r\n"2","\' -1+2","静态文本","第一行，中文\n第二行 ""原样""","\'=镜头甲,""特写"""\r\n'
const STATIC_CAMERA = '机位：方向 30°，俯仰 20°，距离 8.5'
const MOVING_CAMERA = `${STATIC_CAMERA}；运镜：方向 -30°，俯仰 20°，距离 8.5 → 方向 30°，俯仰 20°，距离 8.5，6 秒`
const cameraCsv = (value) => `\ufeff"序号","运镜"\r\n"1","${value}"\r\n`
const FILES = { text: 'storyboard-text.csv', director: 'storyboard-director-motion.csv', static: 'storyboard-director-static.csv' }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')

async function seedStoryboard(store, project) {
  assert.ok(store && project?.projectId && project?.canvasId)
  const initial = await store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(initial.version, 0)
  assert.equal(initial.nodes.length, 0)
  const specs = [
    { key: 'firstId', type: 'text', x: 100, y: 100, params: FIRST },
    { key: 'secondId', type: 'text', x: 100, y: 500, params: SECOND },
    { key: 'directorId', type: 'director', x: 650, y: 100, params: DIRECTOR },
    { key: 'staticDirectorId', type: 'director', x: 650, y: 500, params: STATIC },
  ]
  let version = 0
  const fixture = {}
  for (const spec of specs) {
    const created = await store.createNode({ projectId: project.projectId, canvasId: project.canvasId,
      expectedVersion: version, idempotencyKey: crypto.randomUUID(), type: spec.type, x: spec.x, y: spec.y, params: spec.params })
    assert.equal(created.version, version + 1)
    assert.equal(created.node.type, spec.type)
    assert.equal(typeof created.node.id, 'string')
    fixture[spec.key] = created.node.id
    version = created.version
  }
  assert.equal(new Set(Object.values(fixture)).size, 4)
  return fixture
}
function validFixture(fixture) {
  assert.ok(fixture && ['firstId', 'secondId', 'directorId', 'staticDirectorId'].every(key => typeof fixture[key] === 'string' && fixture[key]))
  assert.equal(new Set([fixture.firstId, fixture.secondId, fixture.directorId, fixture.staticDirectorId]).size, 4)
}
function validContext(ctx) {
  assert.ok(ctx?.cdp && ctx?.browser && ctx?.project?.projectId && ctx?.project?.canvasId)
  assert.ok(path.isAbsolute(ctx.directory) && path.isAbsolute(ctx.output))
  for (const key of ['button', 'until', 'clickComponent', 'capture', 'checkTasksAndMcp', 'selectTwoNodes']) assert.equal(typeof ctx.helpers?.[key], 'function')
}
async function sourceSnapshot(cdp, project, fixture) {
  const ids = [fixture.firstId, fixture.secondId, fixture.directorId, fixture.staticDirectorId]
  const nodes = await cdp.evaluate(`window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)}).then(canvas =>
    ${JSON.stringify(ids)}.map(id => {
      const node = canvas.nodes.find(item => item.id === id)
      const params = node?.data?.node?.params
      return node && { id: node.id, type: node.type, title: params?.title, content: params?.content, prompt: params?.prompt, camera: params?.camera, motion: params?.motion }
    }))`)
  assert.equal(nodes.length, 4)
  assert.ok(nodes.every(Boolean))
  assert.deepEqual(nodes[0], { id: fixture.firstId, type: 'text', ...FIRST })
  assert.deepEqual(nodes[1], { id: fixture.secondId, type: 'text', ...SECOND })
  assert.deepEqual(nodes[2], { id: fixture.directorId, type: 'director', ...DIRECTOR, prompt: DIRECTOR.title })
  assert.deepEqual(nodes[3], { id: fixture.staticDirectorId, type: 'director', ...STATIC, prompt: STATIC.title })
  return digest(JSON.stringify(nodes))
}
async function ensureStoryboardComponent(ctx) {
  const state = await ctx.cdp.evaluate(`window.vibepaperDesktop.marketplace.list(${JSON.stringify(ctx.project.projectId)}).then(items => {
    const component = items.find(item => item.id === 'creative-studio')?.components.find(item => item.id === 'shots')
    return component && ({ installed: component.installed, enabled: component.enabled })
  })`)
  assert.deepEqual(state, { installed: true, enabled: true }, 'STORYBOARD_COMPONENT_UNAVAILABLE')
}
async function reopenCanvas(ctx) {
  const { cdp, project, helpers: { button, until } } = ctx
  assert.ok(typeof project.name === 'string' && project.name)
  await button(cdp, '返回画布展示')
  const card = `Array.from(document.querySelectorAll('[role=button]')).find(el => el.innerText.includes(${JSON.stringify(project.name)}))`
  await until(cdp, `location.pathname === '/workspace' && Boolean(${card})`)
  await cdp.evaluate(`(${card}).click(); true`)
  await until(cdp, `location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))
    && window.vibepaperDesktop.getActiveProject().then(p => p?.projectId === ${JSON.stringify(project.projectId)} && p?.canvasId === ${JSON.stringify(project.canvasId)})`)
  await until(cdp, "document.querySelectorAll('.react-flow__node.selected').length === 0")
  await until(cdp, `window.vibepaperDesktop.getMcpState().then(state => state.canvasReady
    && state.activeCanvas?.projectId === ${JSON.stringify(project.projectId)} && state.activeCanvas?.canvasId === ${JSON.stringify(project.canvasId)})`, 10_000)
  assert.equal(await cdp.evaluate("document.body.innerText.includes('MCP 画布同步未就绪，请重新打开画布。')"), false)
}
async function openPanel(ctx) {
  if (!await ctx.cdp.evaluate("Boolean(document.querySelector('aside[aria-label=插件组件]'))")) await ctx.helpers.button(ctx.cdp, '插件组件')
  await ctx.helpers.until(ctx.cdp, "Boolean(document.querySelector('aside[aria-label=插件组件]'))")
}
async function closeDialog(ctx) {
  const selector = '[role="dialog"][aria-label="导出分镜表"]'
  await ctx.helpers.until(ctx.cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  await ctx.cdp.evaluate(`(() => { const dialog = document.querySelector(${JSON.stringify(selector)}); const close = [...dialog.querySelectorAll('button')].find(b => b.innerText.trim() === '关闭'); if (!close) throw new Error('STORYBOARD_CLOSE'); close.click(); return true })()`)
  await ctx.helpers.until(ctx.cdp, `!document.querySelector(${JSON.stringify(selector)})`)
}
async function openDialog(ctx) {
  await openPanel(ctx)
  await ctx.helpers.clickComponent(ctx.cdp, '分镜表', '导出选区')
  await ctx.helpers.until(ctx.cdp, "Boolean(document.querySelector('[role=dialog][aria-label=导出分镜表]'))")
}
async function selectSingle(ctx, nodeId) {
  const selector = `.react-flow__node[data-id="${nodeId}"]`
  await reopenCanvas(ctx)
  await ctx.helpers.until(ctx.cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  await ctx.cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`)
  await ctx.helpers.until(ctx.cdp, `(() => { const nodes = document.querySelectorAll('.react-flow__node.selected'); return nodes.length === 1 && nodes[0].getAttribute('data-id') === ${JSON.stringify(nodeId)} })()`)
}
async function setField(ctx, label, checked) {
  const lookup = `(() => { const d = document.querySelector('[role=dialog][aria-label=导出分镜表]');
    const l = [...d.querySelectorAll('label')].find(el => el.innerText.trim() === ${JSON.stringify(label)}); return l?.querySelector('input[type=checkbox]') })()`
  await ctx.helpers.until(ctx.cdp, `Boolean(${lookup})`)
  await ctx.cdp.evaluate(`(() => { const box = ${lookup}; if (box.checked !== ${JSON.stringify(checked)}) box.click(); return true })()`)
  await ctx.helpers.until(ctx.cdp, `${lookup}?.checked === ${JSON.stringify(checked)}`)
}
async function configureDownload(ctx, exportDirectory) {
  try {
    await ctx.browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: exportDirectory })
    return 'browser'
  } catch {
    await ctx.cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: exportDirectory })
    return 'page'
  }
}
async function downloadCsv(ctx, exportDirectory, name) {
  const original = path.join(exportDirectory, '分镜表.csv')
  const target = path.join(exportDirectory, name)
  await assert.rejects(fs.access(original))
  await assert.rejects(fs.access(target))
  const lookup = "[...document.querySelectorAll('[role=dialog][aria-label=导出分镜表] button')].find(el => !el.disabled && el.innerText.trim() === '下载 CSV')"
  await ctx.helpers.until(ctx.cdp, `Boolean(${lookup})`)
  await ctx.cdp.evaluate(`(${lookup}).click(); true`)
  let previous = -1, stable = 0
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const stat = await fs.stat(original).catch(() => null)
    const partial = await fs.stat(`${original}.crdownload`).catch(() => null)
    if (stat?.isFile() && stat.size > 0 && !partial) {
      stable = stat.size === previous ? stable + 1 : 0
      if (stable >= 2) break
      previous = stat.size
    }
    await wait(100)
  }
  assert.ok(stable >= 2, 'STORYBOARD_DOWNLOAD_TIMEOUT')
  const bytes = await fs.readFile(original)
  await fs.rename(original, target)
  return bytes
}
function assertBytes(actual, expected) {
  assert.deepEqual(actual, Buffer.from(expected, 'utf8'))
}
async function runStoryboard(ctx, fixture) {
  validContext(ctx); validFixture(fixture)
  const { cdp, project, output, helpers } = ctx
  let stage = 'preconditions'
  try {
    await helpers.until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
    const originalSourceHash = await sourceSnapshot(cdp, project, fixture)
    await helpers.checkTasksAndMcp(cdp, project.projectId)
    const exportDirectory = path.join(output, 'storyboard-exports')
    await fs.mkdir(exportDirectory, { mode: 0o700 })
    const downloadControl = await configureDownload(ctx, exportDirectory)
    stage = 'install-component'
    await ensureStoryboardComponent(ctx)
    stage = 'reopen-canvas'
    await reopenCanvas(ctx)
    assert.equal(await sourceSnapshot(cdp, project, fixture), originalSourceHash)
    stage = 'text-selection'
    await helpers.selectTwoNodes(cdp, [fixture.firstId, fixture.secondId])
    await openDialog(ctx)
    const dialog = '[role="dialog"][aria-label="导出分镜表"]'
    await helpers.until(cdp, `(() => { const rows = document.querySelectorAll(${JSON.stringify(dialog + ' ol li')});
      return rows.length === 2 && rows[0].innerText.includes(${JSON.stringify(FIRST.title)}) && rows[1].innerText.includes(${JSON.stringify(SECOND.title)}) })()`)
    stage = 'text-fields-and-order'
    for (const label of ['标题', '类型']) await setField(ctx, label, false)
    await setField(ctx, '标题', true) // The final selection order is 提示词, 运镜, 内容, 标题.
    await cdp.evaluate(`(() => { const rows = document.querySelectorAll(${JSON.stringify(dialog + ' ol li')});
      const up = [...rows[1].querySelectorAll('button')].find(b => b.innerText.trim() === '上移' && !b.disabled)
      if (!up) throw new Error('STORYBOARD_ROW_ORDER'); up.click(); return true })()`)
    await helpers.until(cdp, `(() => { const rows = document.querySelectorAll(${JSON.stringify(dialog + ' ol li')});
      return rows.length === 2 && rows[0].innerText.includes(${JSON.stringify(SECOND.title)}) && rows[1].innerText.includes(${JSON.stringify(FIRST.title)}) })()`)
    await helpers.capture(cdp, '17-storyboard-text.png')
    stage = 'text-download'
    const textBytes = await downloadCsv(ctx, exportDirectory, FILES.text)
    assertBytes(textBytes, TEXT_CSV)
    await closeDialog(ctx)
    stage = 'director-selection'
    await selectSingle(ctx, fixture.directorId)
    await openDialog(ctx)
    await helpers.until(cdp, `(() => { const rows = document.querySelectorAll(${JSON.stringify(dialog + ' ol li')}); return rows.length === 1 && rows[0].innerText.includes(${JSON.stringify(DIRECTOR.title)}) })()`)
    for (const label of ['标题', '类型', '提示词', '内容']) await setField(ctx, label, false)
    await helpers.capture(cdp, '18-storyboard-director.png')
    stage = 'director-download'
    const directorBytes = await downloadCsv(ctx, exportDirectory, FILES.director)
    assertBytes(directorBytes, cameraCsv(MOVING_CAMERA))
    await closeDialog(ctx)
    stage = 'static-director-selection'
    await selectSingle(ctx, fixture.staticDirectorId)
    await openDialog(ctx)
    await helpers.until(cdp, `(() => { const rows = document.querySelectorAll(${JSON.stringify(dialog + ' ol li')}); return rows.length === 1 && rows[0].innerText.includes(${JSON.stringify(STATIC.title)}) })()`)
    for (const label of ['标题', '类型', '提示词', '内容']) await setField(ctx, label, false)
    stage = 'static-director-download'
    const staticBytes = await downloadCsv(ctx, exportDirectory, FILES.static)
    assertBytes(staticBytes, cameraCsv(STATIC_CAMERA))
    await closeDialog(ctx)
    assert.equal(await sourceSnapshot(cdp, project, fixture), originalSourceHash)
    await helpers.checkTasksAndMcp(cdp, project.projectId)
    return {
      summary: { textCsv: `storyboard-exports/${FILES.text}`, directorCsv: `storyboard-exports/${FILES.director}`,
        staticCsv: `storyboard-exports/${FILES.static}`,
        csvSha256: { text: digest(textBytes), director: digest(directorBytes), static: digest(staticBytes) },
        csvBytes: { text: textBytes.length, director: directorBytes.length, static: staticBytes.length },
        textRows: 2, selectedOnly: true, rowAndFieldOrder: true, canvasReadyOnReopen: true,
        utf8Bom: true, formulaEscaping: true, csvQuoting: true, multiline: true, directorCamera: true, directorMotion: true,
        staticCamera: true, taskCount: 0, mcpEnabled: false, clientCount: 0, downloadControl },
      sourceHash: originalSourceHash,
      fileHashes: { [FILES.text]: digest(textBytes), [FILES.director]: digest(directorBytes), [FILES.static]: digest(staticBytes) },
    }
  } catch (error) {
    if (error && typeof error === 'object') error.storyboardStage = stage
    throw error
  }
}
async function verifyStoryboard(ctx, fixture, expected) {
  validContext(ctx); validFixture(fixture)
  assert.ok(expected?.summary && expected?.fileHashes && typeof expected.sourceHash === 'string')
  await ctx.helpers.until(ctx.cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
  assert.equal(await sourceSnapshot(ctx.cdp, ctx.project, fixture), expected.sourceHash)
  for (const [name, text] of [[FILES.text, TEXT_CSV], [FILES.director, cameraCsv(MOVING_CAMERA)], [FILES.static, cameraCsv(STATIC_CAMERA)]]) {
    const bytes = await fs.readFile(path.join(ctx.output, 'storyboard-exports', name))
    assertBytes(bytes, text)
    assert.equal(digest(bytes), expected.fileHashes[name])
  }
  await ctx.helpers.checkTasksAndMcp(ctx.cdp, ctx.project.projectId)
  return { sourceUnchanged: true, csvFilesUnchanged: true, taskCount: 0, mcpEnabled: false, clientCount: 0 }
}
module.exports = { seedStoryboard, runStoryboard, verifyStoryboard }
