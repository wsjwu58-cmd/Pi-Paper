// Build the renderer first, then run with Electron. Uses the original Agent panel,
// an isolated profile and fixture callbacks; never submits model requests.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const { build } = require('esbuild')

const root = path.resolve(__dirname, '../..')
const webRoot = path.join(root, 'pi-paper-web')
const fixtureRoot = path.join(root, '.test-temp', `agent-confirmation-${Date.now()}`)
const evidence = path.join(root, 'docs', 'verification', '2026-10-09-agent-confirmation')
const stylesheetOverride = process.argv.find((argument) => argument.startsWith('--stylesheet='))?.slice('--stylesheet='.length)
app.setPath('userData', path.join(fixtureRoot, 'profile'))
let window
const networkRequests = []
const evaluate = (source) => window.webContents.executeJavaScript(source)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(source) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await evaluate(source)) return
    await delay(50)
  }
  throw new Error(`Timed out: ${source}`)
}

async function main() {
  await fs.mkdir(fixtureRoot, { recursive: true })
  await fs.mkdir(evidence, { recursive: true })
  const assetRoot = path.join(webRoot, 'dist', 'assets')
  const styles = stylesheetOverride
    ? [path.resolve(stylesheetOverride)]
    : (await fs.readdir(assetRoot)).filter((file) => file.endsWith('.css')).map((file) => path.join(assetRoot, file))
  assert(styles.length, 'Build the renderer before running this check')
  const entry = path.join(fixtureRoot, 'fixture.tsx')
  const source = `
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentPanel } from ${JSON.stringify(path.join(webRoot, 'src/features/canvas/AgentPanel.tsx'))}
import { setUiLanguage } from ${JSON.stringify(path.join(webRoot, 'src/lib/i18n.ts'))}
const root = createRoot(document.getElementById('root')!)
const client = new QueryClient()
let options = { status: 'pending', kind: 'generation', count: 1, language: 'zh' }
let finish: (() => void) | null = null
const actions: any[] = []
const prompt = '精致的水晶香水瓶特写，瓶身通透如钻石切割，内部是淡淡的粉色玫瑰香水液体，瓶身上方有一朵半透明的玻璃玫瑰装饰，产品广告质感，奢华优雅，电影感光影，9:16竖屏。'.repeat(8)
const confirmation = () => ({
  actionId: 'fixture-action', approvalToken: 'fixture-approval', canvasVersion: 0,
  status: options.status, kind: options.kind,
  tool: options.kind === 'canvas_delete' ? 'delete_nodes' : 'submit_generation',
  summary: '确认提交生成', affectedNodeCount: options.count,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  generationItems: options.kind === 'generation' ? Array.from({length: options.count}, (_, index) => ({
    target: prompt + index + 'reference'.repeat(30), model: 'Agnes Image', input: prompt, overwrite: false,
  })) : undefined,
  nodeLabels: [prompt], connectedEdgeCount: 3, downstreamNodeCount: 1,
  affectedGroupCount: 1, affectedStackCount: 0,
})
function render() {
  const adapter = {
    projectId: 'fixture-project', activeSessionId: 'fixture-session',
    sessions: [{ sessionId: 'fixture-session', title: '我想生成香水的广告', createdAt: 0, modifiedAt: 0 }],
    messages: [{ id: 'fixture-message', role: 'assistant', type: 'text', content: '',
      meta: { confirmation: confirmation(), requiresConfirmation: options.status === 'pending' } }],
    draft: '下一步创作', sending: false, creating: false, configured: true, modelLabel: 'Agnes 2.5 Flash', error: '',
    onDraftChange: () => {}, onNewSession: async () => {}, onSelectSession: async () => {},
    onSend: async () => {}, onConfigure: () => {}, onClose: () => {},
    onConfirm: async (value, accept) => {
      actions.push({ accept, actionId: value.actionId, approvalToken: value.approvalToken })
      options.status = 'submitting'; render()
      await new Promise<void>((resolve) => { finish = resolve })
      options.status = accept ? 'accepted' : 'rejected'; render()
    },
  }
  root.render(<QueryClientProvider client={client}><AgentPanel desktopAdapter={adapter as any} /></QueryClientProvider>)
}
window.confirmationSmoke = {
  set: async (next) => { options = { ...options, ...next }; await setUiLanguage(options.language as any); render() },
  finish: () => finish?.(), actions,
}
render()
`
  await fs.writeFile(entry, source)
  await build({
    entryPoints: [entry], outfile: path.join(fixtureRoot, 'fixture.js'), bundle: true,
    platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(webRoot, 'src') }, nodePaths: [path.join(webRoot, 'node_modules')],
    define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' },
  })
  await fs.writeFile(path.join(fixtureRoot, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
${styles.map((file) => `<link rel="stylesheet" href="${pathToFileURL(file).href}">`).join('\n')}
<style>html,body,#root{height:100%;margin:0}#root{display:flex;justify-content:flex-end;overflow:hidden}</style>
</head><body><div id="root"></div><script src="./fixture.js"></script></body></html>`)
  await app.whenReady()
  window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { backgroundThrottling: false } })
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => {
    networkRequests.push(request.url)
    callback({ cancel: true })
  })
  window.webContents.on('console-message', (event) => { if (event.message.includes('Error')) console.error(event.message) })
  await window.loadFile(path.join(fixtureRoot, 'index.html'))
  await waitFor('document.querySelector("section button") !== null')
  await delay(400)
  const results = []
  for (const zoom of [1, 1.5]) {
    window.webContents.setZoomFactor(zoom)
    for (const language of ['zh', 'en']) {
      for (const width of [300, 380, 720]) {
        for (const kind of ['generation', 'canvas_delete']) {
          const count = kind === 'generation' && width === 380 ? 24 : 1
          await evaluate(`window.confirmationSmoke.set(${JSON.stringify({ language, kind, count, status: 'pending' })})`)
          await evaluate(`(() => {
            const handle = document.querySelector('aside [role=separator]');
            handle.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, button:0, pointerId:1, clientX:0}));
          })()`)
          await evaluate(`(() => {
            const panel = document.querySelector('aside'), handle = panel.querySelector('[role=separator]');
            const current = parseFloat(panel.style.width);
            handle.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerId:1, clientX:current - ${width}}));
          })()`)
          await waitFor(`parseFloat(document.querySelector('aside').style.width) === ${width}`)
          await evaluate(`(() => {
            const handle = document.querySelector('aside [role=separator]');
            handle.dispatchEvent(new PointerEvent('pointerup', {bubbles:true, pointerId:1}));
          })()`)
          await delay(400)
          // Hidden windows need a compositor capture to advance CSS motion.
          await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
          await delay(350)
          await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
          const metrics = await evaluate(`(() => {
            const panel = document.querySelector('aside').getBoundingClientRect();
            const card = document.querySelector('section');
            const buttons = [...card.querySelectorAll('button')].map(button => {
              const rect = button.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return { label:button.innerText, left:rect.left, right:rect.right, width:rect.width,
                visible: rect.left >= panel.left && rect.right <= panel.right && rect.top >= 0 && rect.bottom <= innerHeight,
                clickable: hit === button || button.contains(hit), disabled:button.disabled };
            });
            return { panelWidth:panel.width, panelStyle:document.querySelector('aside').style.width,
              panelComputed:getComputedStyle(document.querySelector('aside')).width,
              cardWidth:card.clientWidth, cardScrollWidth:card.scrollWidth, buttons };
          })()`)
          const result = { zoom, language, width, kind, count, ...metrics }
          results.push(result)
          if (metrics.buttons.length !== 2 || !metrics.buttons.every((button) => button.visible && button.clickable && !button.disabled)
              || metrics.cardScrollWidth > metrics.cardWidth + 1) {
            await fs.writeFile(path.join(evidence, 'layout-failure.png'), (await window.webContents.capturePage(undefined, {stayHidden:true})).toPNG())
            await fs.writeFile(path.join(evidence, 'layout-failure.json'), JSON.stringify(result, null, 2))
            throw new Error(`Confirmation buttons leave the panel: ${JSON.stringify(result)}`)
          }
          assert.equal(Math.round(metrics.panelWidth), width, JSON.stringify(result))
        }
      }
    }
  }
  await evaluate("window.confirmationSmoke.set({language:'zh', kind:'generation', count:1, status:'pending'})")
  await delay(400)
  await fs.writeFile(path.join(evidence, stylesheetOverride ? 'installed-confirmation-fixed.png' : 'confirmation-fixed.png'), (await window.webContents.capturePage(undefined, {stayHidden:true})).toPNG())
  for (const accept of [true, false]) {
    await evaluate("window.confirmationSmoke.set({status:'pending'})")
    await waitFor('document.querySelectorAll("section button").length === 2')
    await evaluate(`document.querySelectorAll('section button')[${accept ? 1 : 0}].click()`)
    await waitFor('[...document.querySelectorAll("section button")].every(button => button.disabled)')
    const actionCount = await evaluate('window.confirmationSmoke.actions.length')
    await evaluate("document.querySelectorAll('section button')[1].click()")
    assert.equal(await evaluate('window.confirmationSmoke.actions.length'), actionCount, 'Submitting approval must not be sent again')
    await evaluate('window.confirmationSmoke.finish()')
    await waitFor('document.querySelector("section button") === null')
    await waitFor('!document.querySelector("button[type=submit]").disabled')
  }
  const actions = await evaluate('window.confirmationSmoke.actions')
  assert.deepEqual(actions.map((action) => action.accept), [true, false])
  assert(actions.every((action) => action.actionId === 'fixture-action' && action.approvalToken === 'fixture-approval'))
  assert.deepEqual(networkRequests, [], 'The UI fixture must not make network requests')
  await fs.writeFile(path.join(evidence, stylesheetOverride ? 'installed-smoke.json' : 'smoke.json'), JSON.stringify({ success:true, styles, results, actions, networkRequests }, null, 2))
  console.log('Agent confirmation smoke passed: 24 layout cases, confirm/cancel, submitting lock, and composer unlock. No network requests.')
  app.quit()
}
main().catch((error) => { console.error(error.stack); app.exit(1) })
