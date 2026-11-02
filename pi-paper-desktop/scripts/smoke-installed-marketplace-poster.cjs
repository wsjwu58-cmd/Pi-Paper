'use strict'

// This helper operates only on the caller's isolated test project. It uses the
// ordinary marketplace and canvas UI, then reads the persisted project assets.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')

const TITLE = 'LOCAL POSTER'
const SOURCE_PROMPT = '原图提示词：保留棚拍背景'
const LAYOUT = {
  width: 1200, height: 1500, background: '#f3f0ea',
  image: { x: 80, y: 80, width: 920, height: 960, fit: 'contain' },
  title: { text: TITLE, x: 100, y: 1190, size: 72, color: '#252525' },
}
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu
const SHA = /^[a-f0-9]{64}$/u
const DIALOG = '[role="dialog"][aria-label="海报排版"]'

function validContext({ cdp, project, directory, output, helpers }) {
  assert.ok(cdp && project?.projectId && project?.canvasId)
  assert.ok(path.isAbsolute(directory) && path.isAbsolute(output))
  for (const name of ['button', 'until', 'clickComponent', 'capture', 'checkTasksAndMcp', 'imageMetadata', 'canvasDetails']) {
    assert.equal(typeof helpers?.[name], 'function', `missing helper ${name}`)
  }
}
function canvasExpression(project) {
  return `window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)})`
}
async function graph(cdp, project) {
  return cdp.evaluate(canvasExpression(project))
}
function withoutPosterLayout(params) {
  const { posterLayout, ...rest } = params
  return rest
}
function selectedNodeExpression(id) {
  return `document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${id}"]`)})`
}
async function selectSource(cdp, id, until) {
  await until(cdp, `Boolean(${selectedNodeExpression(id)})`)
  await cdp.evaluate("document.querySelector('.react-flow__pane').click(); true")
  await cdp.evaluate(`(${selectedNodeExpression(id)}).click(); true`)
}
async function setInput(cdp, until, label, value) {
  const selector = JSON.stringify(`${DIALOG} input[aria-label="${label}"]`)
  await until(cdp, `Boolean(document.querySelector(${selector}))`)
  await cdp.evaluate(`(() => {
    const input = document.querySelector(${selector})
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(String(value))})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  await until(cdp, `document.querySelector(${selector})?.value === ${JSON.stringify(String(value))}`)
}
async function assetBytes(directory, assetId, metadata) {
  assert.match(assetId, UUID)
  assert.match(metadata.sha256, SHA)
  const projectRoot = await fs.realpath(directory)
  const candidate = path.join(projectRoot, '.vibepaper', 'assets', metadata.sha256, `${assetId}.png`)
  assert.equal(await fs.realpath(candidate), candidate)
  const bytes = await fs.readFile(candidate)
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE))
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), metadata.sha256)
  return bytes
}
async function pixels(cdp, sourceAssetId, posterAssetId) {
  return cdp.evaluate(`(async () => {
    async function bitmap(id) {
      const response = await fetch('vibe://app/assets/' + encodeURIComponent(id))
      if (!response.ok) throw new Error('ASSET_READ_FAILED')
      return createImageBitmap(await response.blob())
    }
    const source = await bitmap(${JSON.stringify(sourceAssetId)})
    const poster = await bitmap(${JSON.stringify(posterAssetId)})
    const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = source.width; sourceCanvas.height = source.height
    const sc = sourceCanvas.getContext('2d'); if (!sc) throw new Error('CANVAS_UNAVAILABLE')
    sc.drawImage(source, 0, 0)
    const originalCenter = Array.from(sc.getImageData(Math.floor(source.width / 2), Math.floor(source.height / 2), 1, 1).data)
    const outputCanvas = document.createElement('canvas'); outputCanvas.width = poster.width; outputCanvas.height = poster.height
    const pc = outputCanvas.getContext('2d'); if (!pc) throw new Error('CANVAS_UNAVAILABLE')
    pc.drawImage(poster, 0, 0)
    const sample = (x, y) => Array.from(pc.getImageData(x, y, 1, 1).data)
    const title = pc.getImageData(90, 1090, 700, 110).data
    let darkTitlePixels = 0
    for (let i = 0; i < title.length; i += 4) if (title[i] < 100 && title[i + 1] < 100 && title[i + 2] < 100 && title[i + 3] > 200) darkTitlePixels++
    const value = { background: sample(10, 10), imageCenter: sample(540, 560), originalCenter, darkTitlePixels }
    source.close(); poster.close()
    return value
  })()`)
}
function validatePixels(value) {
  assert.deepEqual(value.background, [243, 240, 234, 255])
  assert.equal(value.imageCenter[3], 255)
  assert.equal(value.originalCenter[3], 255)
  for (let index = 0; index < 3; index++) assert.ok(Math.abs(value.imageCenter[index] - value.originalCenter[index]) <= 12)
  assert.ok(value.imageCenter.slice(0, 3).some((color, index) => Math.abs(color - value.background[index]) > 10))
  assert.ok(value.darkTitlePixels > 100)
}
function assertStoredGraph(current, expected) {
  const source = current.nodes.find((node) => node.id === expected.sourceId)
  const poster = current.nodes.find((node) => node.id === expected.posterId)
  assert.equal(source?.type, 'image')
  assert.equal(poster?.type, 'image')
  assert.equal(source.data.node.params.assetId, expected.sourceAssetId)
  assert.equal(poster.data.node.params.assetId, expected.posterAssetId)
  assert.deepEqual(withoutPosterLayout(source.data.node.params), expected.sourceParams)
  assert.equal(source.data.node.prompt, SOURCE_PROMPT)
  assert.deepEqual(source.data.node.params.posterLayout, LAYOUT)
  assert.ok(current.edges.some((edge) => edge.source === expected.sourceId && edge.target === expected.posterId && edge.data?.valid === true))
  for (const old of expected.baselineNodes) {
    const node = current.nodes.find((item) => item.id === old.id)
    assert.equal(node?.type, old.type)
    assert.deepEqual(node.data.node.params, old.params)
  }
  for (const edge of expected.baselineEdges) assert.ok(current.edges.some((item) => item.source === edge.source && item.target === edge.target))
}
async function assertResources(cdp, directory, project, helpers, expected) {
  const assets = await cdp.evaluate(`window.vibepaperDesktop.listAssets(${JSON.stringify(project.projectId)})`)
  assert.ok(assets.some((asset) => asset.assetId === expected.sourceAssetId && asset.mimeType === 'image/png'))
  assert.ok(assets.some((asset) => asset.assetId === expected.posterAssetId && asset.mimeType === 'image/png'))
  const [source, poster] = await helpers.imageMetadata(cdp, [expected.sourceAssetId, expected.posterAssetId])
  assert.deepEqual(source, expected.sourceMetadata)
  assert.deepEqual(poster, expected.posterMetadata)
  assert.deepEqual({ width: poster.width, height: poster.height }, { width: LAYOUT.width, height: LAYOUT.height })
  await assetBytes(directory, expected.sourceAssetId, source)
  await assetBytes(directory, expected.posterAssetId, poster)
  validatePixels(await pixels(cdp, expected.sourceAssetId, expected.posterAssetId))
}

async function runPoster(context) {
  validContext(context)
  const { cdp, project, directory, output, helpers } = context
  const { button, until, clickComponent, capture, checkTasksAndMcp, imageMetadata, canvasDetails } = helpers
  let posterStage = 'baseline'
  try {
    await until(cdp, `location.pathname.startsWith('/canvas/') && window.vibepaperDesktop.getActiveProject().then(p => p?.projectId === ${JSON.stringify(project.projectId)} && p?.canvasId === ${JSON.stringify(project.canvasId)})`)
    const initial = await graph(cdp, project)
    assert.ok(initial.nodes.filter((node) => node.type === 'text').length >= 2)
    const baselineNodes = initial.nodes.map((node) => ({ id: node.id, type: node.type, params: node.data.node.params }))
    const baselineEdges = initial.edges.map(({ source, target }) => ({ source, target }))
    await checkTasksAndMcp(cdp, project.projectId)

    posterStage = 'import-source'
    if (!await cdp.evaluate("Boolean(document.querySelector('aside[aria-label=插件组件]'))")) await button(cdp, '插件组件')
    await clickComponent(cdp, '中性灰棚拍背景', '导入画布')
    const oldIds = initial.nodes.map((node) => node.id)
    await until(cdp, `${canvasExpression(project)}.then(c => c.nodes.length === ${initial.nodes.length + 1} && c.nodes.some(n => !${JSON.stringify(oldIds)}.includes(n.id) && n.type === 'image' && n.data?.node?.params?.assetId))`)
    const imported = await graph(cdp, project)
    const source = imported.nodes.find((node) => !oldIds.includes(node.id))
    assert.equal(source?.type, 'image')
    const sourceId = source.id, sourceAssetId = source.data.node.params.assetId
    assert.match(sourceId, UUID); assert.match(sourceAssetId, UUID)
    const sourceParamsBeforeEdit = withoutPosterLayout(source.data.node.params)
    const [sourceMetadata] = await imageMetadata(cdp, [sourceAssetId])
    assert.ok(sourceMetadata.width >= 2 && sourceMetadata.height >= 2)
    await assetBytes(directory, sourceAssetId, sourceMetadata)
    await selectSource(cdp, sourceId, until)
    posterStage = 'edit-source-prompt'
    const promptInput = `${selectedNodeExpression(sourceId)}?.querySelector('textarea')`
    await until(cdp, `Boolean(${promptInput})`)
    await cdp.evaluate(`(() => {
      const input = ${promptInput}
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(SOURCE_PROMPT)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await until(cdp, `${canvasExpression(project)}.then(c => c.nodes.find(n => n.id === ${JSON.stringify(sourceId)})?.data?.node?.params?.prompt === ${JSON.stringify(SOURCE_PROMPT)})`, 75_000)
    const editedSource = (await graph(cdp, project)).nodes.find((node) => node.id === sourceId)
    const sourceParams = withoutPosterLayout(editedSource.data.node.params)
    const promptDiagnostic = {
      before: { paramsPrompt: sourceParamsBeforeEdit.prompt ?? null, nodePrompt: source.data.node.prompt ?? null },
      after: { paramsPrompt: sourceParams.prompt ?? null, nodePrompt: editedSource.data.node.prompt ?? null },
    }
    if (promptDiagnostic.after.nodePrompt !== SOURCE_PROMPT) {
      await fs.writeFile(path.join(await fs.realpath(output), 'poster-prompt-diagnostic.json'), `${JSON.stringify(promptDiagnostic, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    }
    assert.deepEqual(sourceParams, { ...sourceParamsBeforeEdit, prompt: SOURCE_PROMPT })
    assert.equal(editedSource.data.node.prompt, SOURCE_PROMPT)
    await checkTasksAndMcp(cdp, project.projectId)
    posterStage = 'open-poster'
    await clickComponent(cdp, '商品标题海报', '编辑海报')
    await until(cdp, `Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`)
    await until(cdp, `Array.from(document.querySelectorAll(${JSON.stringify(`${DIALOG} button`)})).some(b => !b.disabled && b.innerText.trim() === '生成 PNG 并添加到画布')`)

    posterStage = 'edit-layout'
    await setInput(cdp, until, '宽度', LAYOUT.width)
    await setInput(cdp, until, '高度', LAYOUT.height)
    await setInput(cdp, until, '标题文字', TITLE)
    await until(cdp, `(() => { const d = document.querySelector(${JSON.stringify(DIALOG)}), c = d?.querySelector('canvas'); return c?.width === ${LAYOUT.width} && c?.height === ${LAYOUT.height} && !d.querySelector('[role=alert]') && Array.from(d.querySelectorAll('button')).some(b => !b.disabled && b.innerText.trim() === '生成 PNG 并添加到画布') })()`)
    await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await capture(cdp, 'poster-editor.png')
    await button(cdp, '生成 PNG 并添加到画布', true)
    await until(cdp, `!document.querySelector(${JSON.stringify(DIALOG)}) && ${canvasExpression(project)}.then(c => c.nodes.length === ${initial.nodes.length + 2} && c.edges.some(e => e.source === ${JSON.stringify(sourceId)}))`, 75_000)
    const saved = await graph(cdp, project)
    const poster = saved.nodes.find((node) => !oldIds.includes(node.id) && node.id !== sourceId)
    assert.equal(poster?.type, 'image')
    const posterId = poster.id, posterAssetId = poster.data.node.params.assetId
    assert.match(posterId, UUID); assert.match(posterAssetId, UUID)
    assert.notEqual(sourceAssetId, posterAssetId)
    const [sourceAfter, posterMetadata] = await imageMetadata(cdp, [sourceAssetId, posterAssetId])
    assert.deepEqual(sourceAfter, sourceMetadata)
    const expected = { sourceId, sourceAssetId, sourceParams, sourceMetadata, posterId, posterAssetId, posterMetadata, baselineNodes, baselineEdges,
      summary: {
        source: { width: sourceMetadata.width, height: sourceMetadata.height, sha256: sourceMetadata.sha256, unchanged: true },
        png: { filename: 'poster-result.png', width: posterMetadata.width, height: posterMetadata.height, sha256: posterMetadata.sha256 },
        changedFields: ['width', 'height', 'title'], pixelChecks: ['background', 'source-center', 'title'], sourcePromptPreserved: true,
        sourceLinked: true, layoutPersisted: true, tasks: 0,
      },
    }
    posterStage = 'persisted-png'
    assertStoredGraph(saved, expected)
    await assertResources(cdp, directory, project, helpers, expected)
    const posterBytes = await assetBytes(directory, posterAssetId, posterMetadata)
    const outDir = await fs.realpath(output)
    await fs.writeFile(path.join(outDir, 'poster-result.png'), posterBytes, { flag: 'wx', mode: 0o600 })
    assert.deepEqual(await canvasDetails(cdp, project).then((value) => value.nodes.length), initial.nodes.length + 2)
    await checkTasksAndMcp(cdp, project.projectId)
    if (await cdp.evaluate("Boolean(document.querySelector('aside[aria-label=插件组件]'))")) {
      await cdp.evaluate("document.querySelector('aside[aria-label=插件组件] button[aria-label=关闭]').click(); true")
      await until(cdp, "!document.querySelector('aside[aria-label=插件组件]')")
    }
    await capture(cdp, 'poster-canvas.png')
    return expected
  } catch (error) {
    if (error && typeof error === 'object') error.posterStage = posterStage
    throw error
  }
}

async function verifyPoster(context, expected) {
  validContext(context)
  assert.ok(expected && typeof expected === 'object')
  const { cdp, project, directory, output, helpers } = context
  const { until, capture, checkTasksAndMcp } = helpers
  let posterStage = 'restart-readback'
  try {
    await until(cdp, `location.pathname.startsWith('/canvas/') && Boolean(${selectedNodeExpression(expected.sourceId)})`)
    assertStoredGraph(await graph(cdp, project), expected)
    await assertResources(cdp, directory, project, helpers, expected)
    const savedEvidence = await fs.readFile(path.join(await fs.realpath(output), 'poster-result.png'))
    assert.equal(crypto.createHash('sha256').update(savedEvidence).digest('hex'), expected.posterMetadata.sha256)
    await checkTasksAndMcp(cdp, project.projectId)
    posterStage = 'reopen-editor'
    if (await cdp.evaluate("Boolean(document.querySelector('aside[aria-label=插件组件]'))")) {
      await cdp.evaluate("document.querySelector('aside[aria-label=插件组件] button[aria-label=关闭]').click(); true")
    }
    await selectSource(cdp, expected.sourceId, until)
    const editButton = `${selectedNodeExpression(expected.sourceId)}?.querySelector('button[title="编辑海报"]')`
    await until(cdp, `Boolean(${editButton})`)
    await cdp.evaluate(`(${editButton}).click(); true`)
    await until(cdp, `Boolean(document.querySelector(${JSON.stringify(DIALOG)}))`)
    await until(cdp, `Array.from(document.querySelectorAll(${JSON.stringify(`${DIALOG} button`)})).some(b => !b.disabled && b.innerText.trim() === '生成 PNG 并添加到画布')`)
    const fields = await cdp.evaluate(`(() => { const d = document.querySelector(${JSON.stringify(DIALOG)}); return {
      width: d.querySelector('input[aria-label="宽度"]')?.value,
      height: d.querySelector('input[aria-label="高度"]')?.value,
      title: d.querySelector('input[aria-label="标题文字"]')?.value,
      saveEnabled: Array.from(d.querySelectorAll('button')).some(b => !b.disabled && b.innerText.trim() === '生成 PNG 并添加到画布')
    } })()`)
    assert.deepEqual(fields, { width: String(LAYOUT.width), height: String(LAYOUT.height), title: TITLE, saveEnabled: true })
    await capture(cdp, 'poster-reopened-editor.png')
    await setInput(cdp, until, '标题文字', 'REOPEN EDIT')
    await setInput(cdp, until, '标题文字', TITLE)
    await cdp.evaluate(`(() => { const d = document.querySelector(${JSON.stringify(DIALOG)}); const close = Array.from(d.querySelectorAll('button')).find(b => b.innerText.trim() === '关闭'); if (!close || close.disabled) throw new Error('POSTER_CLOSE_MISSING'); close.click(); return true })()`)
    await until(cdp, `!document.querySelector(${JSON.stringify(DIALOG)})`)
    assertStoredGraph(await graph(cdp, project), expected)
    await checkTasksAndMcp(cdp, project.projectId)
    return { editableAfterRestart: true, sourceAndOutputVerified: true, width: LAYOUT.width, height: LAYOUT.height, sha256: expected.posterMetadata.sha256, tasks: 0 }
  } catch (error) {
    if (error && typeof error === 'object') error.posterStage = posterStage
    throw error
  }
}

module.exports = { runPoster, verifyPoster }
