'use strict'

// Optional installed-app smoke stage. The caller supplies a newly created local
// project in a fresh profile and invokes this only with explicit online opt-in.
// All catalog operations below are performed by clicking the real app UI.
const assert = require('node:assert/strict')

const PACKAGE = 'interview-two-camera'
const PACKAGE_NAME = '访谈双机位'
const VERSION = '1.0.0'
const DIGEST = '9a51b4be0dcbf61b77787ecc657b6773049a21a9f751379f94a1a6f754066530'
const COMPONENTS = [
  { id: 'interview-stage', name: '双人访谈场景', type: 'director_scene' },
  { id: 'left-view', name: '左侧访谈视角', type: 'director_camera' },
  { id: 'right-view', name: '右侧访谈视角', type: 'director_camera' },
  { id: 'orbit-between-views', name: '左右视角环绕', type: 'director_motion' },
]
const OBJECTS = [
  { category: 'character', kind: '坐', name: '采访者', position: [-1.35, 0.15, 0], rotation: 60, scale: 1, color: '#4b6a88' },
  { category: 'prop', kind: '椅子', name: '采访者座椅', position: [-1.35, 0, 0], rotation: 60, scale: 1, color: '#665b52' },
  { category: 'character', kind: '坐', name: '受访者', position: [1.35, 0.15, 0], rotation: -60, scale: 1, color: '#bc785e' },
  { category: 'prop', kind: '椅子', name: '受访者座椅', position: [1.35, 0, 0], rotation: -60, scale: 1, color: '#665b52' },
  { category: 'prop', kind: '桌子', name: '访谈桌', position: [0, 0, 0], rotation: 0, scale: 0.8, color: '#a78a70' },
  { category: 'prop', kind: '墙板', name: '背景墙', position: [0, 0, -1.8], rotation: 0, scale: 2.1, color: '#d8d2c9' },
]
const LEFT = { yaw: -30, pitch: 20, distance: 8.5 }
const RIGHT = { yaw: 30, pitch: 20, distance: 8.5 }
const MOTION = { from: LEFT, to: RIGHT, duration: 6 }

async function verifyPersistedDirector(cdp, project) {
  const saved = await cdp.evaluate(`window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)}).then(c => ({ nodes: c.nodes, edges: c.edges }))`)
  assert.equal(saved.nodes.length, 1)
  assert.equal(saved.nodes[0].type, 'director')
  assert.equal(saved.edges.length, 0)
  const params = saved.nodes[0].data.node.params
  assert.deepEqual(params.camera, RIGHT)
  assert.deepEqual(params.motion, MOTION)
  assert.equal(params.sceneObjects.length, OBJECTS.length)
  const ids = params.sceneObjects.map((object) => object.id)
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0))
  assert.equal(new Set(ids).size, OBJECTS.length)
  assert.deepEqual(params.sceneObjects.map(({ id, ...object }) => object), OBJECTS)
}

module.exports = async function runOnlineDirector({ cdp, project, helpers }) {
  const { button, anchor, until, selectComponents, checkTasksAndMcp, capture } = helpers
  assert.ok(cdp && project?.projectId && project?.canvasId)
  for (const fn of [button, anchor, until, selectComponents, checkTasksAndMcp, capture]) assert.equal(typeof fn, 'function')
  const pid = JSON.stringify(project.projectId)
  const cid = JSON.stringify(project.canvasId)
  const readCanvas = `window.vibepaperDesktop.loadCanvas(${pid}, ${cid})`
  const readPackage = `window.vibepaperDesktop.marketplace.list(${pid}).then(items => items.find(item => item.id === ${JSON.stringify(PACKAGE)}) || null)`

  let onlineStage = 'preconditions'
  try {
    await until(cdp, `location.pathname.startsWith('/canvas/') && window.vibepaperDesktop.getActiveProject().then(p => p?.projectId === ${pid} && p?.canvasId === ${cid})`)
    const initial = await cdp.evaluate(`${readCanvas}.then(c => ({ nodes: c.nodes.length, edges: c.edges.length }))`)
    assert.deepEqual(initial, { nodes: 0, edges: 0 })
    assert.equal(await cdp.evaluate('window.vibepaperDesktop.marketplace.onlineCached()'), null)
    assert.equal(await cdp.evaluate(readPackage), null)
    await checkTasksAndMcp(cdp, project.projectId)

    onlineStage = 'index'
    await button(cdp, '返回画布展示')
    await until(cdp, "location.pathname === '/workspace'")
    await anchor(cdp, '/marketplace')
    await until(cdp, "location.pathname === '/marketplace' && Boolean(document.querySelector('[aria-label=" + JSON.stringify('GitHub 在线目录') + "]'))")
    await button(cdp, '刷新在线目录')
    const article = `Array.from(document.querySelectorAll('section[aria-label="GitHub 在线目录"] article')).find(el => el.querySelector('h3')?.innerText.trim() === ${JSON.stringify(PACKAGE_NAME)})`
    await until(cdp, `Boolean(${article})`, 75_000)
    const catalog = await cdp.evaluate(`window.vibepaperDesktop.marketplace.onlineCached().then(c => c && ({ repository: c.repository, branch: c.branch, commit: c.commit, entry: c.entries.find(e => e.id === ${JSON.stringify(PACKAGE)}) }))`)
    assert.equal(catalog.repository, 'wsjwu58-cmd/Pi-Paper')
    assert.equal(catalog.branch, 'feat/desktop-local-migration')
    assert.match(catalog.commit, /^[a-f0-9]{40}$/u)
    if (process.env.PI_PAPER_EXPECTED_ONLINE_COMMIT) assert.equal(catalog.commit, process.env.PI_PAPER_EXPECTED_ONLINE_COMMIT)
    assert.equal(catalog.entry?.name, PACKAGE_NAME)
    assert.equal(catalog.entry?.version, VERSION)
    assert.equal(catalog.entry?.kind, 'package')
    assert.equal(catalog.entry?.sha256, DIGEST)
    assert.equal(catalog.entry?.size, 3468)
    assert.equal(catalog.entry?.compatible, true)
    await capture(cdp, '13-online-director-index.png')

    onlineStage = 'download'
    await until(cdp, `Boolean(${article} && Array.from(${article}.querySelectorAll('button')).find(b => !b.disabled && b.innerText.trim() === '下载并导入'))`)
    await cdp.evaluate(`(() => { const target = ${article}; const buttons = Array.from(target.querySelectorAll('button')).filter(b => !b.disabled && b.innerText.trim() === '下载并导入'); if (buttons.length !== 1) throw new Error('ONLINE_DOWNLOAD_BUTTON'); buttons[0].click(); return true })()`)
    await until(cdp, `document.querySelector('h1')?.innerText.trim() === ${JSON.stringify(PACKAGE_NAME)}`, 75_000)
    let item = await cdp.evaluate(readPackage)
    assert.equal(item?.source, 'online')
    assert.equal(item.version, VERSION)
    assert.equal(item.origin?.source, 'online')
    assert.equal(item.origin?.commit, catalog.commit)
    assert.equal(item.origin?.sha256, DIGEST)
    assert.equal(item.installed, false)
    assert.deepEqual(item.components.map(({ id, name, type }) => ({ id, name, type })), COMPONENTS)
    await checkTasksAndMcp(cdp, project.projectId)

    onlineStage = 'install'
    await selectComponents(cdp, COMPONENTS.map((component) => component.name), COMPONENTS.length)
    item = await cdp.evaluate(readPackage)
    assert.equal(item?.installedVersion, VERSION)
    assert.equal(item.components.length, COMPONENTS.length)
    assert.ok(COMPONENTS.every((expected) => item.components.some((component) => component.id === expected.id && component.type === expected.type && component.installed && component.enabled)))
    await checkTasksAndMcp(cdp, project.projectId)
    await capture(cdp, '14-online-director-installed.png')

    onlineStage = 'director'
    await button(cdp, '返回画布')
    await until(cdp, "location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('[data-testid=mcp-canvas-page] .react-flow'))")
    await button(cdp, '添加节点')
    const addDirector = "Array.from(document.querySelectorAll('[data-open=true] button')).find(el => el.querySelector('p')?.innerText.trim() === '导演台')"
    await until(cdp, `Boolean(${addDirector})`)
    await cdp.evaluate(`(${addDirector}).click(); true`)
    await until(cdp, `${readCanvas}.then(c => c.nodes.filter(n => n.type === 'director').length === 1 && c.nodes.length === 1)`)
    await until(cdp, "Boolean(document.querySelector('.react-flow__node-director'))")
    await cdp.evaluate("document.querySelector('.react-flow__node-director').click(); true")
    const edit = "Array.from(document.querySelectorAll('.react-flow__node-director button')).find(el => !el.disabled && el.innerText.trim() === '编辑')"
    await until(cdp, `Boolean(${edit})`)
    await cdp.evaluate(`(${edit}).click(); true`)
    await until(cdp, `Array.from(document.querySelectorAll('button')).some(b => !b.disabled && b.innerText.trim() === ${JSON.stringify(COMPONENTS[0].name)})`)
    await button(cdp, COMPONENTS[0].name, true)
    await until(cdp, "Array.from(document.querySelectorAll('button')).some(b => b.innerText.trim() === '撤销插件应用')")
    const yawIs = (value) => `Array.from(document.querySelectorAll('label')).some(label => label.querySelector('span')?.innerText === 'Yaw' && Number(label.querySelector('input[type=range]')?.value) === ${value})`
    await button(cdp, COMPONENTS[1].name, true)
    await until(cdp, yawIs(LEFT.yaw))
    await button(cdp, COMPONENTS[2].name, true)
    await until(cdp, yawIs(RIGHT.yaw))
    await button(cdp, COMPONENTS[3].name, true)
    await until(cdp, "Number(document.querySelector('input[aria-label=过渡时长]')?.value) === 6")
    await capture(cdp, '15-online-director-stage.png')
    onlineStage = 'save'
    const close = "Array.from(document.querySelectorAll('button[title=关闭]')).find(el => el.parentElement?.innerText.includes('导演台'))"
    await until(cdp, `Boolean(${close})`)
    await cdp.evaluate(`(${close}).click(); true`)
    await until(cdp, `${readCanvas}.then(c => c.nodes.some(n => n.type === 'director' && n.data?.node?.params?.sceneObjects?.length === 6 && n.data.node.params.motion?.duration === 6 && n.data.node.params.camera?.yaw === 30))`, 75_000)
    await verifyPersistedDirector(cdp, project)
    await checkTasksAndMcp(cdp, project.projectId)
    await capture(cdp, '16-online-director-saved.png')
    return {
      source: 'official-github-online', repository: catalog.repository, branch: catalog.branch,
      commit: catalog.commit, version: VERSION, sha256: DIGEST, size: catalog.entry.size,
      isolatedEmptyProject: true, freshCache: true, userRefreshAndDownload: true,
      componentCount: COMPONENTS.length, sceneObjects: OBJECTS.length,
      sceneVerified: true, leftCameraYawVerified: true, rightCameraVerified: true, motionVerified: true,
      persistedReadback: true, taskCount: 0, mcpEnabled: false, clientCount: 0,
    }
  } catch (error) {
    if (error && typeof error === 'object') error.onlineStage = onlineStage
    throw error
  }
}

module.exports.verifyPersistedDirector = verifyPersistedDirector
