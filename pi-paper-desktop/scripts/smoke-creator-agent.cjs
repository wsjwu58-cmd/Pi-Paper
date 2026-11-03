// Exercise the packaged Renderer → Main → Worker → Main → Local Core round trip.
// Only the text provider is replaced. The OS profile and project are isolated.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, dialog, protocol } = require('electron')
const { startCreatorModelFixture } = require('../test/fixtures/creator-model.cjs')

const resources = path.resolve(__dirname, '../dist/app')
const sourceRoot = process.argv.find((arg) => arg.startsWith('--resources='))?.slice('--resources='.length)
const staged = sourceRoot ? path.resolve(sourceRoot) : resources
Object.defineProperty(app, 'isPackaged', { value: true })
protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
protocol.registerSchemesAsPrivileged = () => {}
BrowserWindow.prototype.show = function () {}
dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1) }
let window
app.on('browser-window-created', (_event, host) => { window = host; host.webContents.setBackgroundThrottling(false) })
const evaluate = (code) => window.webContents.executeJavaScript(code)
async function until(expression) {
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (window && !window.webContents.isLoading() && await evaluate(expression).catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Creator smoke timed out waiting for ' + expression)
}

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-creator-agent-')))
  const profile = path.join(root, 'profile')
  await fs.mkdir(profile)
  app.commandLine.appendSwitch('user-data-dir', profile)
  app.setPath('userData', profile)
  const store = require(path.join(staged, 'src/project-store.cjs')).createLocalProjectStore()
  const { project, directory } = await store.createProject(root, 'Creator integration')
  await store.close()
  await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: directory }))
  await fs.writeFile(path.join(profile, 'ui-settings.json'), JSON.stringify({ schemaVersion: 1, language: 'zh' }))
  const fixture = await startCreatorModelFixture()
  try {
    const model = { id: 'fixture-model', apiModelId: 'fixture-model', name: 'fixture-model', displayName: 'Fixture',
      providerId: 'fixture', provider: 'fixture', api: 'openai-completions', modelType: 'text', implemented: true,
      toolCalling: true, enabled: true, inputModes: ['text'], reasoning: false, input: ['text'],
      baseUrl: 'http://127.0.0.1:' + fixture.server.address().port + '/v1', contextWindow: 128000, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
    const settings = require(path.join(staged, 'src/provider-settings.cjs'))
    const createSettings = settings.createProviderSettings
    settings.createProviderSettings = (...args) => {
      const original = createSettings(...args)
      return { ...original,
        snapshot: async () => {
          const data = await original.snapshot()
          return { ...data, models: [...data.models, model], providers: [...data.providers, { id: 'fixture', name: 'Fixture' }] }
        },
        resolve: async (providerId, ...rest) => providerId === 'fixture'
          ? { providerId, apiModelId: model.id, apiKey: 'fixture-only', credentials: {}, endpoint: model.baseUrl }
          : original.resolve(providerId, ...rest),
      }
    }
    const mediaPath = require.resolve(path.join(staged, 'dist/pi-official-media.cjs'))
    const media = require(mediaPath)
    require.cache[mediaPath].exports = { ...media, resolveOfficialTextModel: (input, options) => input.providerId === 'fixture'
      ? { model } : media.resolveOfficialTextModel(input, options) }
    let dockIcon
    if (process.platform === 'darwin') {
      const setIcon = app.dock.setIcon.bind(app.dock)
      app.dock.setIcon = (icon) => {
        setIcon(icon)
        dockIcon = icon
      }
    }
    require(path.join(staged, 'src/main.cjs'))
    await until('Boolean(document.querySelector(\'a[href="/marketplace"]\'))')
    if (process.platform === 'darwin') assert.equal(dockIcon, path.join(staged, 'assets/app-icon.mac.png'))
    await evaluate('document.querySelector(\'a[href="/marketplace"]\').click()')
    const back = "Array.from(document.querySelectorAll('button')).find((el) => !el.disabled && el.innerText.includes('返回画布'))"
    await until(back + ' !== undefined')
    await evaluate(back + '.click()')
    await until("location.pathname.startsWith('/canvas/') && !!document.querySelector('.react-flow')")
    const pid = JSON.stringify(project.projectId), cid = JSON.stringify(project.canvasId)
    const session = await evaluate(`window.vibepaperDesktop.createAgentSession(${pid}, '商品三视图')`)
    const sid = JSON.stringify(session.sessionId)
    await evaluate(`window.vibepaperDesktop.setAgentSessionModel(${pid}, ${sid}, 'fixture-model')`)
    await evaluate(`window.vibepaperDesktop.setAgentSessionMode(${pid}, ${sid}, 'creator')`)
    await evaluate(`window.vibepaperDesktop.sendAgentMessage(${pid}, ${sid}, '做一个商品三视图插件，分别写好正面、侧面和背面的拍摄要求，保存下来，在当前画布用一次。', undefined, 'fixture-model')`)
    const graph = await evaluate(`window.vibepaperDesktop.loadCanvas(${pid}, ${cid})`)
    assert.equal(graph.nodes.length, 6)
    assert.equal(graph.edges.length, 3)
    assert.equal(new Set(graph.edges.flatMap((edge) => [edge.source, edge.target])).size, 6)
    assert.equal((await evaluate(`window.vibepaperDesktop.listTasks(${pid})`)).length, 0)
    await until("document.querySelectorAll('.react-flow__node').length === 6")
    const evidence = process.argv.find((arg) => arg.startsWith('--screenshot='))?.slice('--screenshot='.length)
    if (evidence) await fs.writeFile(evidence, (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
    console.log('PASS: real Electron Main, packaged Agent Worker, loopback model, project plugin, six live canvas nodes, three independent edges and zero generation tasks.')
  } finally {
    fixture.server.closeAllConnections()
    await new Promise((resolve) => fixture.server.close(resolve))
  }
  app.quit()
}
main().catch((error) => { console.error(error); app.exit(1) })
