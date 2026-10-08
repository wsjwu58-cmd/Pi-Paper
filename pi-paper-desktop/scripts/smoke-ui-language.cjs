// Run with Electron after building the renderer. Uses an isolated profile and no model requests.
const { app, BrowserWindow, dialog, protocol } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const appDirectoryArgument = process.argv.find(value => value.startsWith('--app-dir='))
const appDirectory = appDirectoryArgument ? path.resolve(appDirectoryArgument.slice('--app-dir='.length)) : path.resolve(__dirname, '..')
const { createLocalProjectStore } = require(path.join(appDirectory, 'src', 'project-store.cjs'))
// Exercise the staged packaged resources with the installed matching Electron runtime.
if (appDirectoryArgument) Object.defineProperty(app, 'isPackaged', { value: true })

const root = path.resolve(__dirname, '../..')
const profile = path.join(root, '.test-temp', 'ui-language-smoke-profile')
const evidence = path.join(root, 'docs', 'verification', '2026-10-08-ui-language')
const resume = process.argv.includes('--resume')
const setPath = app.setPath.bind(app)
app.setPath = (name, value) => setPath(name, name === 'userData' ? profile : value)
app.commandLine.appendSwitch('lang', 'fr')
// Linux's message locale takes priority over Chromium's locale.
process.env.LC_ALL = 'fr_FR.UTF-8'
BrowserWindow.prototype.show = function () {}
protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
protocol.registerSchemesAsPrivileged = () => {}
let window
let opened
let imageNode
const dialogs = []
dialog.showOpenDialog = async (_window, options) => { dialogs.push(options); return { canceled: true, filePaths: [] } }
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1) }
app.on('browser-window-created', (_event, created) => {
  window = created
  created.webContents.setBackgroundThrottling(false)
})

async function waitFor(expression) {
  const end = Date.now() + 25000
  while (Date.now() < end) {
    if (window && !window.webContents.isLoading() && await window.webContents.executeJavaScript(expression).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`UI language check timed out: ${expression}`)
}
async function evaluate(expression) { return window.webContents.executeJavaScript(expression) }
async function capture(name) {
  // Let route transitions, CSS motion and the compositor finish before capturing.
  await new Promise((resolve) => setTimeout(resolve, 800))
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await fs.writeFile(path.join(evidence, name), (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
}
async function chooseLanguage(preference, expected) {
  await evaluate(`(() => {
    const select = [...document.querySelectorAll('select')].find(el => el.querySelector('option[value="system"]'));
    if (!select) throw new Error('Language picker missing');
    select.value = ${JSON.stringify(preference)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await waitFor(`document.documentElement.lang === ${JSON.stringify(expected)} && [...document.querySelectorAll('select')].some(el => el.value === ${JSON.stringify(preference)} && el.querySelector('option[value="system"]'))`)
}

async function main() {
  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(evidence, { recursive: true })
  await fs.unlink(path.join(evidence, 'failure.json')).catch((error) => { if (error.code !== 'ENOENT') throw error })
  if (!resume) {
    // Start with system mode on every fresh smoke run; never touch the user's profile.
    await fs.writeFile(path.join(profile, 'ui-settings.json'), JSON.stringify({ schemaVersion: 1, language: 'system' }))
    await fs.unlink(path.join(profile, 'recent-projects.json')).catch((error) => { if (error.code !== 'ENOENT') throw error })
    const projectDirectory = path.join(profile, `fixture-${Date.now()}`)
    await fs.mkdir(projectDirectory, { recursive: true })
    const store = createLocalProjectStore()
    opened = await store.createProject(projectDirectory, '中文项目 — user content')
    const scope = { projectId: opened.project.projectId, canvasId: opened.project.canvasId }
    imageNode = await store.createNode({ ...scope, expectedVersion: 0, type: 'image', params: {}, x: 180, y: 180, idempotencyKey: 'smoke-image' })
    await store.createNode({ ...scope, expectedVersion: imageNode.version, type: 'text', params: { content: '用户的中文内容保持原样' }, x: 560, y: 180, idempotencyKey: 'smoke-text' })
    await store.close()
    await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: opened.directory }))
  }
  require(path.join(appDirectory, 'src', 'main.cjs'))
  await app.whenReady()
  await waitFor("location.pathname === '/workspace' && document.querySelector('a[href=\"/history\"]')")
  if (resume) {
    await waitFor("document.documentElement.lang === 'zh-CN' && document.body.innerText.includes('新建本地项目')")
    assert.equal((await evaluate('window.vibepaperDesktop.getUiLanguage()')).preference, 'zh')
    await capture('workspace-zh-after-restart.png')
    await fs.writeFile(path.join(evidence, 'restart.json'), JSON.stringify({ success: true, systemLocale: app.getLocale(), language: 'zh', preference: 'zh' }, null, 2))
    console.log('Saved Chinese preference survives restart in a non-Chinese locale.')
    app.quit()
    return
  }
  await waitFor("document.documentElement.lang === 'en-US' && document.body.innerText.includes('New local project')")
  await waitFor("document.body.innerText.includes('中文项目 — user content')")
  await capture('workspace-en.png')
  await chooseLanguage('zh', 'zh-CN')
  await waitFor("document.body.innerText.includes('新建本地项目')")
  await capture('workspace-zh.png')
  await chooseLanguage('en', 'en-US')
  await waitFor("document.body.innerText.includes('New local project')")
  await chooseLanguage('system', 'en-US')
  await evaluate("window.vibepaperDesktop.openProject()")
  assert.equal(dialogs.at(-1).title, 'Open a Pi-Paper local project')
  await evaluate("document.querySelector('a[href=\"/history\"]').click()")
  await waitFor("location.pathname === '/history' && document.body.innerText.includes('All statuses')")
  await capture('history-en.png')
  await evaluate("document.querySelector('a[href=\"/settings/providers\"]').click()")
  await waitFor("location.pathname === '/settings/providers' && document.body.innerText.includes('Model providers') && document.body.innerText.includes('Agnes')")
  await capture('providers-en.png')
  await evaluate("document.querySelector('a[href=\"/workspace\"]').click()")
  await waitFor("location.pathname === '/workspace' && document.querySelector('[role=button]')")
  await evaluate("document.querySelector('[role=button]').click()")
  await waitFor("location.pathname.startsWith('/canvas/') && document.querySelectorAll('.react-flow__node').length === 2")
  await waitFor("document.body.innerText.includes('用户的中文内容保持原样')")
  await capture('canvas-en.png')
  // The original canvas opens Agent by default; avoid toggling it closed.
  await evaluate("(() => { const button = document.querySelector('button[title=\"Agent\"]'); if (!button.classList.contains('text-white')) button.click() })()")
  await waitFor("document.body.innerText.includes('Review ideas and next steps')")
  await capture('agent-en.png')
  await evaluate("document.querySelector('button[title=\"Agent\"]').click()")
  await waitFor("![...document.querySelectorAll('button')].some(el => el.innerText.includes('Review ideas and next steps'))")
  await evaluate("document.querySelector('button[title=\"Asset library\"]').click()")
  await waitFor("document.body.innerText.includes('Local asset library')")
  await capture('assets-en.png')
  await chooseLanguage('zh', 'zh-CN')
  await evaluate("window.vibepaperDesktop.openProject()")
  assert.equal(dialogs.at(-1).title, '打开 Pi-Paper 本地项目')
  const canvas = await evaluate(`window.vibepaperDesktop.loadCanvas(${JSON.stringify(opened.project.projectId)}, ${JSON.stringify(opened.project.canvasId)})`)
  assert.equal(canvas.nodes.find((node) => node.data.node.type === 'text').data.node.params.content, '用户的中文内容保持原样')
  await fs.writeFile(path.join(evidence, 'smoke.json'), JSON.stringify({ success: true, systemLocale: app.getLocale(), defaultLanguage: 'en', manualSwitch: true, systemSwitch: true, nativeDialogs: dialogs.map(({ title }) => title), userContentPreserved: true, modelRequests: 0 }, null, 2))
  console.log('Desktop language smoke passed: workspace, history, providers, canvas, Agent, assets, native dialogs, and preserved user content.')
  app.quit()
}
main().catch(async (error) => {
  console.error(error.stack)
  await fs.mkdir(evidence, { recursive: true }).catch(() => {})
  await fs.writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ error: error.message, stack: error.stack }, null, 2)).catch(() => {})
  app.exit(1)
})
