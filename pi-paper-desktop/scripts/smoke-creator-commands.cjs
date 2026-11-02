// Isolated Electron UI smoke for project-authored nodes and shared canvas commands.
// Build staging first, then run: electron scripts/smoke-creator-commands.cjs --staged
// This is a staging/runtime smoke, not an installed-package acceptance test.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, dialog, protocol } = require('electron')
const staged = process.argv.includes('--staged')
const appRoot = path.join(__dirname, staged ? '../dist/app' : '..')
if (staged) Object.defineProperty(app, 'isPackaged', { value: true })
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paper-creator-ui-')))
const profile = path.join(root, 'profile')
fs.mkdirSync(profile)
app.commandLine.appendSwitch('user-data-dir', profile)
app.setPath('userData', profile)
protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
protocol.registerSchemesAsPrivileged = () => {}
BrowserWindow.prototype.show = function () {}
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1) }
let window
app.on('browser-window-created', (_event, host) => { window = host; host.webContents.setBackgroundThrottling(false) })
const evaluate = (code) => window.webContents.executeJavaScript(code)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(expression) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (window && !window.webContents.isLoading() && await evaluate(expression).catch(() => false)) return
    await sleep(100)
  }
  throw new Error(`Missing: ${expression}\n${window ? await evaluate('document.body.innerText').catch(() => '') : 'No window'}`)
}
async function click(label) {
  const lookup = `Array.from(document.querySelectorAll('button')).find(el => !el.disabled && (el.innerText.includes(${JSON.stringify(label)}) || el.title === ${JSON.stringify(label)}))`
  await until(`${lookup} !== undefined`)
  await evaluate(`${lookup}.click()`)
}
async function screenshot(name) {
  const option = process.argv.find((arg) => arg.startsWith('--evidence='))
  if (!option) return
  const directory = path.resolve(option.slice('--evidence='.length))
  fs.mkdirSync(directory, { recursive: true })
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  fs.writeFileSync(path.join(directory, name), image.toPNG())
}
async function selectTwo(ids) {
  await evaluate("document.activeElement?.blur(); document.querySelector('.react-flow__pane').click()")
  if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 55, modifiers: 4 })
  await sleep(150)
  try {
    const unwanted = await evaluate(`[...document.querySelectorAll('.react-flow__node.selected')].map(el => el.getAttribute('data-id')).filter(id => !${JSON.stringify(ids)}.includes(id))`)
    for (const id of unwanted) { await evaluate(`document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${id}"]`)}).click()`); await sleep(150) }
    for (const id of ids) {
      const selector = JSON.stringify(`.react-flow__node[data-id="${id}"]`)
      await until(`Boolean(document.querySelector(${selector}))`)
      await evaluate(`document.querySelector(${selector}).click()`)
      await sleep(150)
    }
  } finally { await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 55, modifiers: 0 }).catch(() => {}) }
  console.log('Selected after multi-select:', await evaluate("[...document.querySelectorAll('.react-flow__node.selected')].map(el => el.getAttribute('data-id'))"))
  await until(`JSON.stringify([...document.querySelectorAll('.react-flow__node.selected')].map(el => el.getAttribute('data-id')).sort()) === JSON.stringify(${JSON.stringify([...ids].sort())})`)
}
async function useComponent(name, action) {
  const lookup = `(() => { const aside = document.querySelector('aside[aria-label="插件组件"]');
    const title = [...(aside?.querySelectorAll('p') || [])].find(el => el.innerText.trim() === ${JSON.stringify(name)});
    const button = title?.parentElement?.querySelector('button'); return button && !button.disabled && button.innerText.trim() === ${JSON.stringify(action)} ? button : null })()`
  await until(`Boolean(${lookup})`)
  await evaluate(`${lookup}.click()`)
}
async function main() {
  const { createLocalProjectStore } = require(path.join(appRoot, 'src/project-store.cjs'))
  const { createMarketplaceService } = require(path.join(appRoot, 'src/marketplace.cjs'))
  const store = createLocalProjectStore()
  const { project, directory } = await store.createProject(root, 'Creator command smoke')
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const node = (id, type, x, y, params) => ({ id, type, width: 100, height: 80, position: { x, y }, data: { node: { id, type, x, y, params, status: 'idle' }, params } })
  await store.saveCanvas({ ...base, expectedVersion: 0, nodes: [node('first', 'text', 0, 20, { title: '第一镜', prompt: '开场' }),
    node('second', 'image', 400, 100, { title: '第二镜', prompt: '特写' })], edges: [] })
  await store.close()
  const service = createMarketplaceService(profile)
  await service.install(directory, 'creative-studio', ['horizontal', 'shots'])
  fs.writeFileSync(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: directory }))
  fs.writeFileSync(path.join(profile, 'ui-settings.json'), JSON.stringify({ schemaVersion: 1, language: 'zh' }))
  require(path.join(appRoot, 'src/main.cjs'))
  await until('Boolean(document.querySelector(\'a[href="/marketplace"]\'))')
  await evaluate('document.querySelector(\'a[href="/marketplace"]\').click()')
  await click('创建节点')
  await until('Boolean(document.querySelector(\'section[aria-label="创建节点定义"]\'))')
  await evaluate(`(() => { const section = document.querySelector('section[aria-label="创建节点定义"]');
    const label = [...section.querySelectorAll('label')].find(el => el.textContent.includes('节点名称'));
    const input = label.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '手工棚拍节点');
    input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await click('保存到本项目')
  await until("document.querySelector('h1')?.innerText === '手工棚拍节点'")
  await evaluate("[...document.querySelectorAll('summary')].find(el => el.innerText.includes('预览组件内容')).click()")
  await until("Boolean(document.querySelector('fieldset legend') && document.querySelector('input[aria-label=分辨率]'))")
  await evaluate(`(() => { const fieldset = [...document.querySelectorAll('fieldset')].find(el => el.querySelector('legend')?.innerText === '参考输入');
    [...fieldset.querySelectorAll('label')].find(el => el.innerText.trim() === '图片').querySelector('input').click();
    const input = document.querySelector('input[aria-label=分辨率]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1K');
    input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await click('检查模型能力')
  await until("document.body.innerText.includes('满足条件的已配置模型：0')")
  await screenshot('model-capabilities.png')
  const selector = 'input[aria-label="选择组件 手工棚拍节点"]'
  await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await click('安装所选组件')
  await until("document.querySelector('[role=status]')?.innerText.includes('已安装')")
  await click('返回画布')
  await until("location.pathname.startsWith('/canvas/') && Boolean(document.querySelector('.react-flow'))")
  await click('添加节点')
  await click('手工棚拍节点')
  const read = `window.vibepaperDesktop.loadCanvas(${JSON.stringify(project.projectId)}, ${JSON.stringify(project.canvasId)})`
  await until(`${read}.then(canvas => canvas.nodes.some(node => node.data.node.params.nodeDefinition?.snapshot.name === '手工棚拍节点'))`)
  let canvas = await evaluate(read)
  const custom = canvas.nodes.find((node) => node.data.node.params.nodeDefinition?.snapshot.name === '手工棚拍节点')
  assert.equal(custom.type, 'image')
  await evaluate(`document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${custom.id}"]`)}).click()`)
  await until("[...document.querySelectorAll('.react-flow__node.selected label')].some(el => el.textContent.includes('商品卖点'))")
  await evaluate(`(() => { const label = [...document.querySelectorAll('.react-flow__node.selected label')].find(el => el.textContent.includes('商品卖点'));
    const input = label.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '手工编辑的玻璃杯');
    input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await until(`${read}.then(canvas => canvas.nodes.find(node => node.id === ${JSON.stringify(custom.id)})?.data.node.params.nodeDefinition.values.product === '手工编辑的玻璃杯')`)
  await screenshot('creator-node.png')
  await click('返回画布展示')
  await until('Boolean(document.querySelector(\'a[href="/marketplace"]\'))')
  await evaluate('document.querySelector(\'a[href="/marketplace"]\').click()')
  await until("[...document.querySelectorAll('button')].some(el => el.innerText.trim() === '节点')")
  await evaluate("[...document.querySelectorAll('button')].find(el => el.innerText.trim() === '节点').click()")
  const imageToggle = 'input[aria-label="新建菜单显示图片"]'
  await until(`Boolean(document.querySelector(${JSON.stringify(imageToggle)}))`)
  await evaluate(`document.querySelector(${JSON.stringify(imageToggle)}).click()`)
  await until(`window.vibepaperDesktop.marketplace.getBasicNodeVisibility(${JSON.stringify(project.projectId)}).then(state => state.hidden.includes('image'))`)
  await click('返回画布')
  await until("location.pathname.startsWith('/canvas/') && document.querySelectorAll('.react-flow__node').length === 3")
  await click('添加节点')
  assert.equal(await evaluate("[...document.querySelector('button[title=添加节点]').parentElement.querySelectorAll('button')].some(el => el.innerText.trim() === '图片')"), false)
  assert.equal(await evaluate("[...document.querySelector('button[title=添加节点]').parentElement.querySelectorAll('button')].some(el => el.innerText.trim() === '手工棚拍节点')"), true)
  await click('添加节点')
  assert.equal(await evaluate("Boolean(document.querySelector('.react-flow__node[data-id=second]'))"), true)
  await screenshot('basic-node-visibility.png')
  await selectTwo(['first', 'second'])
  await click('插件组件')
  await useComponent('分镜表', '导出选区')
  await until("Boolean(document.querySelector('[role=dialog][aria-label=导出分镜表]'))")
  assert.equal(await evaluate("document.querySelectorAll('[role=dialog][aria-label=导出分镜表] ol li').length"), 2)
  await screenshot('storyboard-preview.png')
  await evaluate("document.querySelector('[role=dialog][aria-label=导出分镜表] button').click()")
  await useComponent('横向排列', '应用到选中节点')
  await until("document.querySelector('[role=dialog][aria-label=确认应用预设]')?.innerText.includes('排列所选的 2 个节点')")
  await evaluate("[...document.querySelectorAll('[role=dialog][aria-label=确认应用预设] button')].find(el => el.innerText.trim() === '应用').click()")
  await until(`${read}.then(canvas => { const a = canvas.nodes.find(n => n.id === 'first'), b = canvas.nodes.find(n => n.id === 'second'); return a && b && a.position.y === b.position.y && b.position.x < 400 })`)
  await screenshot('selection-arranged.png')
  await until("document.querySelector('[data-testid=mcp-canvas-input-surface]')?.getAttribute('aria-busy') === 'false'")
  await click('撤销上次排列')
  await until(`${read}.then(canvas => { const a = canvas.nodes.find(n => n.id === 'first'), b = canvas.nodes.find(n => n.id === 'second'); return a?.position.x === 0 && a?.position.y === 20 && b?.position.x === 400 && b?.position.y === 100 })`)
  canvas = await evaluate(read)
  assert.equal(canvas.nodes.find((node) => node.id === custom.id).data.node.params.nodeDefinition.values.product, '手工编辑的玻璃杯')
  assert.deepEqual(await evaluate(`window.vibepaperDesktop.listTasks(${JSON.stringify(project.projectId)})`), [])
  window.webContents.reload()
  await until(`document.querySelectorAll('.react-flow__node').length === 3 && ${read}.then(canvas => canvas.nodes.find(node => node.id === ${JSON.stringify(custom.id)})?.data.node.params.nodeDefinition.values.product === '手工编辑的玻璃杯')`)
  assert.deepEqual(await evaluate(`window.vibepaperDesktop.marketplace.getBasicNodeVisibility(${JSON.stringify(project.projectId)})`), { hidden: ['image'] })
  console.log('PASS: isolated staged Electron UI manually saved and installed a custom node, inspected model capabilities, edited its persisted field, hid a basic creation entry without removing nodes, previewed storyboard, arranged and undid selection, and reloaded; no generation tasks.')
  app.quit()
}
main().catch((error) => { console.error(error.stack); app.exit(1) })
