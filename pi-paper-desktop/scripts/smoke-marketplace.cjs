// Run with this project's Electron after building the renderer and Agent worker.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, dialog, protocol } = require('electron')
const staged = process.argv.includes('--staged')
const appRoot = path.join(__dirname, staged ? '../dist/app' : '..')
if (staged) Object.defineProperty(app, 'isPackaged', { value: true })

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-paper-marketplace-')))
const profile = path.join(root, 'profile')
fs.mkdirSync(profile)
app.commandLine.appendSwitch('user-data-dir', profile)
app.setPath('userData', profile)
protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }])
protocol.registerSchemesAsPrivileged = () => {}
BrowserWindow.prototype.show = function () {}
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1) }
const { createLocalProjectStore } = require(path.join(appRoot, 'src/project-store.cjs'))
let window
app.on('browser-window-created', (_event, host) => {
  window = host
  host.webContents.setBackgroundThrottling(false)
})
function evaluate(code) {
  return window.webContents.executeJavaScript(code)
}
async function until(expression) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (window && !window.webContents.isLoading() && await evaluate(expression).catch(() => false)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Missing: ${expression}\n${window ? await evaluate('document.body.innerText').catch(() => '') : 'No window'}`)
}
async function clickButton(label) {
  const lookup = `Array.from(document.querySelectorAll('button')).find(el => !el.disabled && (el.innerText.includes(${JSON.stringify(label)}) || el.title === ${JSON.stringify(label)}))`
  await until(lookup + ' !== undefined')
  await evaluate(lookup + '.click()')
}
async function captureIfRequested() {
  const output = process.argv.find(arg => arg.startsWith('--screenshot='))
  if (!output) return
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  fs.writeFileSync(path.resolve(output.slice('--screenshot='.length)), image.toPNG())
}
async function main() {
  const store = createLocalProjectStore()
  const { project, directory } = await store.createProject(root, 'Marketplace smoke')
  await store.close()
  fs.writeFileSync(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: directory }))
  fs.writeFileSync(path.join(profile, 'ui-settings.json'), JSON.stringify({ schemaVersion: 1, language: 'zh' }))
  require(path.join(appRoot, 'src/main.cjs'))
  await until(`document.querySelector('a[href="/marketplace"]') !== null`)
  await evaluate(`document.querySelector('a[href="/marketplace"]').click()`)
  await clickButton('查看详情')
  await until("document.querySelectorAll('input[type=checkbox]:enabled').length === 4")
  await captureIfRequested()
  await evaluate("document.querySelectorAll('input[type=checkbox]').forEach(box => box.click())")
  await clickButton('安装所选组件')
  await until("document.querySelector('[role=status]')?.innerText.includes('已安装')")
  const pid = JSON.stringify(project.projectId)
  const skills = await evaluate(`window.vibepaperDesktop.listAgentSkills(${pid})`)
  assert.ok(skills.items.some(s => s.name === '商品棚拍策划' && s.enabled))
  await clickButton('返回画布')
  await until("location.pathname.startsWith('/canvas/') && document.querySelector('.react-flow')")
  await clickButton('插件组件')
  await clickButton('插入')
  const readCanvas = `window.vibepaperDesktop.loadCanvas(${pid}, ${JSON.stringify(project.canvasId)})`
  await until(`${readCanvas}.then(canvas => canvas.nodes.length > 0 && canvas.edges.length > 0)`)
  const inserted = await evaluate(readCanvas)
  assert.equal(inserted.nodes.length, 7)
  assert.equal(inserted.edges.length, 6)
  assert.ok(inserted.edges.every(edge => edge.data.valid))
  await clickButton('导入画布')
  await until(`${readCanvas}.then(canvas => canvas.nodes.length === ${inserted.nodes.length + 1})`)
  const expectedPrompt = '保留商品外观与品牌标识，使用柔和棚拍布光、浅灰背景，主体清晰，真实材质。'
  const referenceId = inserted.nodes.find(node => node.type === 'image' && inserted.edges.some(edge => edge.source === node.id)).id
  const nodeSelector = JSON.stringify(`.react-flow__node[data-id="${referenceId}"]`)
  await evaluate(`document.querySelector(${nodeSelector}).click()`)
  await clickButton('应用到选中节点')
  const confirmPreset = "[...document.querySelectorAll('[role=dialog] button')].find(button => button.innerText === '应用')"
  await until(confirmPreset + ' !== undefined')
  await evaluate(confirmPreset + '.click()')
  await until(`${readCanvas}.then(canvas => canvas.nodes.find(node => node.id === ${JSON.stringify(referenceId)}).data.node.params.prompt === ${JSON.stringify(expectedPrompt)})`)
  window.webContents.reload()
  await until(`document.querySelectorAll('.react-flow__node').length === ${inserted.nodes.length + 1}`)
  assert.deepEqual(await evaluate(`window.vibepaperDesktop.listTasks(${pid})`), [])
  console.log(`PASS: installed four components, found the Agent Skill, inserted ${inserted.nodes.length} nodes and ${inserted.edges.length} edges, imported an asset, applied the preset and reloaded the saved graph with zero generation tasks.`)
  app.quit()
}
main().catch(error => { console.error(error.stack); app.exit(1) })
