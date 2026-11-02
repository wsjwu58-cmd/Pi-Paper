// Run with this project's Electron after building the renderer and Agent worker.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, dialog, protocol } = require('electron')
const staged = process.argv.includes('--staged')
const resources = process.argv.find(arg => arg.startsWith('--resources='))?.slice('--resources='.length)
const appRoot = resources ? path.resolve(resources) : path.join(__dirname, staged ? '../dist/app' : '..')
if (staged || resources) Object.defineProperty(app, 'isPackaged', { value: true })

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
async function captureIfRequested(option = '--screenshot=') {
  const output = process.argv.find(arg => arg.startsWith(option))
  if (!output) return
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const image = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
  fs.writeFileSync(path.resolve(output.slice(option.length)), image.toPNG())
}
async function main() {
  const store = createLocalProjectStore()
  const { project, directory } = await store.createProject(root, 'Marketplace smoke')
  await store.close()
  const skillFile = path.join(root, 'SKILL.md')
  fs.writeFileSync(skillFile, '---\nname: smoke-storyboard\ndescription: Write a short storyboard brief.\n---\n\nWrite one sentence for each shot.\n')
  dialog.showOpenDialog = async (_host, options) => {
    if (options.title === '导入独立 Pi Skill') return { canceled: false, filePaths: [skillFile] }
    return { canceled: true, filePaths: [] }
  }
  fs.writeFileSync(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: directory }))
  fs.writeFileSync(path.join(profile, 'ui-settings.json'), JSON.stringify({ schemaVersion: 1, language: 'zh' }))
  require(path.join(appRoot, 'src/main.cjs'))
  await until(`document.querySelector('a[href="/marketplace"]') !== null`)
  await evaluate(`document.querySelector('a[href="/marketplace"]').click()`)
  await clickButton('导入独立 Skill')
  await until("document.querySelector('h1')?.innerText === 'smoke-storyboard'")
  await clickButton('返回插件市场')
  if (process.argv.includes('--online')) {
    await clickButton('刷新在线目录')
    await clickButton('下载并导入')
    await until("document.querySelector('h1')?.innerText === '场景构图灵感'")
    await clickButton('返回插件市场')
  }
  await clickButton('MCP 与本地工具连接')
  await until("document.querySelectorAll('input[type=checkbox]:enabled').length === 2")
  await evaluate("document.querySelectorAll('input[type=checkbox]').forEach(box => box.click())")
  await clickButton('安装所选组件')
  await clickButton('检查 MCP 授权范围')
  await until("location.pathname === '/settings/mcp' && document.body.innerText.includes('已从已安装的连接器预填')")
  const mcp = await evaluate('window.vibepaperDesktop.getMcpState()')
  assert.equal(mcp.enabled, false)
  assert.equal(mcp.clients.length, 0)
  await window.loadURL('vibe://app/marketplace')
  await clickButton('创作工作室')
  await until("document.querySelectorAll('input[type=checkbox]:enabled').length === 7")
  await evaluate("document.querySelectorAll('input[type=checkbox]').forEach(box => box.click())")
  await clickButton('安装所选组件')
  await until("document.body.innerText.includes('组件已安装并启用')")
  await clickButton('返回插件市场')
  await clickButton('商品棚拍工作流')
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
  const source = (await evaluate(readCanvas)).nodes.find(node => node.data.node.params.assetId)
  await evaluate(`document.querySelector(${JSON.stringify(`.react-flow__node[data-id="${source.id}"]`)}).click()`)
  await clickButton('插件组件')
  await clickButton('编辑海报')
  await until("document.querySelector('[role=dialog][aria-label=海报排版] canvas') !== null")
  await until("Array.from(document.querySelectorAll('button')).some(el => !el.disabled && el.innerText.includes('生成 PNG 并添加到画布'))")
  await captureIfRequested('--poster-screenshot=')
  await clickButton('生成 PNG 并添加到画布')
  await until(`${readCanvas}.then(canvas => canvas.nodes.length === 9 && canvas.nodes.some(node => node.data.node.params.posterLayout))`)
  const poster = await evaluate(readCanvas)
  assert.ok(poster.edges.some(edge => edge.source === source.id && poster.nodes.find(node => node.id === edge.target)?.data.node.params.assetId))
  await clickButton('导出选区')
  const csv = path.join(root, 'storyboard.csv')
  window.webContents.session.once('will-download', (_event, item) => item.setSavePath(csv))
  await clickButton('下载 CSV')
  const csvDeadline = Date.now() + 10000
  while (!fs.existsSync(csv) && Date.now() < csvDeadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.match(fs.readFileSync(csv, 'utf8'), /"序号"/)
  await evaluate("document.querySelector('[aria-label=导出分镜表] button').click()")
  await clickButton('添加节点')
  await clickButton('导演台')
  await until(`${readCanvas}.then(canvas => canvas.nodes.some(node => node.type === 'director'))`)
  await evaluate("document.querySelector('.react-flow__node-director').click()")
  await until("Array.from(document.querySelectorAll('.react-flow__node-director button')).some(el => el.innerText === '编辑')")
  await evaluate("Array.from(document.querySelectorAll('.react-flow__node-director button')).find(el => el.innerText === '编辑').click()")
  await clickButton('商品棚拍场景')
  await clickButton('商品三分之四机位')
  await clickButton('缓慢推近')
  await clickButton('播放')
  await until("Array.from(document.querySelectorAll('button')).some(el => el.innerText === '停止')")
  await clickButton('停止')
  await evaluate("Array.from(document.querySelectorAll('button[title=关闭]')).find(el => el.parentElement.innerText.includes('导演台')).click()")
  await until(`${readCanvas}.then(canvas => canvas.nodes.some(node => node.type === 'director' && node.data.node.params.sceneObjects?.length === 2 && node.data.node.params.motion?.duration === 4))`)
  assert.deepEqual(await evaluate(`window.vibepaperDesktop.listTasks(${pid})`), [])
  console.log('PASS: standalone Skill import, scoped MCP prefill without grants, four-component workflow, local asset and preset, editable poster and PNG on canvas, storyboard CSV and saved director motion; zero generation tasks.')
  app.quit()
}
main().catch(error => { console.error(error.stack); app.exit(1) })
