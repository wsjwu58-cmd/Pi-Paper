const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

async function main() {
  if (!process.argv[2]) throw new Error('Usage: node scripts/smoke-package.cjs <packaged-app-directory>')
  const root = path.resolve(process.argv[2])
  for (const file of ['package.json', 'src/main.cjs', 'src/preload.cjs', 'src/local-core.cjs',
    'src/generation-worker.cjs', 'dist/agent-worker.cjs', 'dist/pi-official-media.cjs',
    'renderer/index.html', 'renderer/provider-documentation.json', 'assets/app-icon.png']) {
    await fs.access(path.join(root, file))
  }
  const catalog = require(path.join(root, 'dist', 'pi-official-media.cjs')).getOfficialProviderCatalog()
  assert.ok(catalog.providers.length > 0)
  assert.ok(catalog.models.length > 0)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-paper-package-smoke-'))
  let worker
  let nextId = 0
  function start() {
    return new Worker(`
      const { parentPort } = require('node:worker_threads')
      process.parentPort = parentPort
      require(${JSON.stringify(path.join(root, 'src', 'local-core.cjs'))})
    `, { eval: true })
  }
  function request(method, payload) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const cleanup = () => { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError) }
      const onError = (error) => { cleanup(); reject(error) }
      const onMessage = (message) => {
        if (message.id !== id) return
        cleanup()
        if (message.ok) resolve(message.result)
        else reject(new Error(message.error))
      }
      const timer = setTimeout(() => onError(new Error(`Timed out: ${method}`)), 15_000)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.postMessage({ id, method, payload })
    })
  }
  try {
    worker = start()
    const opened = await request('project:create', { parentDirectory: directory, name: 'Packaged app smoke' })
    const scope = { projectId: opened.project.projectId, canvasId: opened.project.canvasId }
    const created = await request('canvas:create-node', {
      ...scope, expectedVersion: 0, type: 'text', params: { content: 'Saved from a packaged app' },
      x: 120, y: 120, idempotencyKey: 'package-smoke-create',
    })
    await request('core:close', {})
    await worker.terminate()
    worker = start()
    await request('project:open', { directory: opened.directory })
    const canvas = await request('canvas:load', scope)
    assert.equal(canvas.nodes.length, 1)
    assert.equal(canvas.nodes[0].id, created.node.id)
    assert.equal(canvas.nodes[0].data.params.content, 'Saved from a packaged app')
    assert.equal(canvas.version, created.version)
    await request('core:close', {})
    console.log(`Packaged app: renderer resources, ${catalog.providers.length} providers, ${catalog.models.length} models, and SQLite canvas persistence across restart passed.`)
  } finally {
    if (worker) await worker.terminate()
    if (!path.basename(directory).startsWith('pi-paper-package-smoke-') || path.dirname(directory) !== os.tmpdir()) {
      throw new Error('Invalid smoke test cleanup directory.')
    }
    await fs.rm(directory, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1 })
