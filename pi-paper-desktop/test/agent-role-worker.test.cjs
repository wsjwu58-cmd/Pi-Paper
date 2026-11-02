const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const test = require('node:test')
const { build } = require('esbuild')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { createLocalProjectStore } = require('../src/project-store.cjs')

test('bundled Worker enforces selected role on native reads and write plan steps across restart', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-role-worker-')))
  const projects = path.join(root, 'projects'), userdata = path.join(root, 'userdata')
  await Promise.all([fs.mkdir(projects), fs.mkdir(userdata)])
  const store = createLocalProjectStore()
  const { directory, project } = await store.createProject(projects, '角色测试')
  const market = createMarketplaceService(userdata)
  await market.install(directory, 'short-drama-workbench', ['shot-reviewer', 'storyboard-director'])
  const bundle = path.join(root, 'agent-worker.cjs'), desktop = path.resolve(__dirname, '..')
  await build({ entryPoints: [path.join(desktop, 'src/agent-worker.cjs')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22.19', external: ['node:*'],
    nodePaths: [path.resolve(desktop, '../pi-main/node_modules')], legalComments: 'none' })
  let worker, nextId = 0
  const calls = []
  const request = (method, payload) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker timed out: ${method}`)) }, 15_000)
    function cleanup() { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError) }
    function onError(error) { cleanup(); reject(error) }
    function onMessage(message) {
      if (message?.id !== id) return
      cleanup(); message.ok ? resolve(message.result) : reject(new Error(message.error))
    }
    worker.on('message', onMessage); worker.on('error', onError); worker.postMessage({ id, method, payload })
  })
  const start = async () => {
    worker = new Worker(`const { parentPort } = require('node:worker_threads'); process.parentPort = { on: (...a) => parentPort.on(...a), postMessage: (...a) => parentPort.postMessage(...a) }; require(${JSON.stringify(bundle)})`, { eval: true })
    worker.on('message', async (message) => {
      if (message?.kind !== 'agent-local-core-request') return
      calls.push(message.method)
      try {
        if (message.method !== 'agent:core:load-canvas') throw new Error('AGENT_LOCAL_CORE_METHOD_UNSUPPORTED')
        const result = await store.loadCanvas(message.payload.projectId, message.payload.canvasId)
        worker.postMessage({ kind: 'agent-local-core-response', requestId: message.requestId, ok: true, result })
      } catch (error) {
        worker.postMessage({ kind: 'agent-local-core-response', requestId: message.requestId, ok: false, errorCode: error.message })
      }
    })
    await request('agent:open', { projectDirectory: directory, userDataDirectory: userdata })
  }
  t.after(async () => {
    if (worker) { await request('agent:close', {}).catch(() => {}); await worker.terminate() }
    await store.close(); await fs.rm(root, { recursive: true, force: true })
  })
  await start()
  const session = await request('agent:create-session', { projectId: project.projectId, canvasId: project.canvasId, title: '审片员' })
  const payload = { projectId: project.projectId, sessionId: session.sessionId }
  const roles = await request('agent:list-roles', { projectId: project.projectId })
  const reviewer = roles.items.find((item) => item.binding.componentId === 'shot-reviewer')
  assert.ok(reviewer)
  await request('agent:set-role', { ...payload, binding: reviewer.binding })
  assert.deepEqual((await request('agent:get-role', payload)).binding, reviewer.binding)
  const runStep = async (id, tool, input) => {
    await request('agent:plan:create', { projectId: project.projectId, id: session.sessionId, canvasId: project.canvasId,
      input: { profile: 'canvas-general', plan: { id, version: 1, canvasVersion: 0, steps: [
        { id: 'step', tool, input, inputHash: `hash-${id}`, dependsOn: [] },
      ] } } })
    return request('agent:plan:execute', { projectId: project.projectId, id, canvasId: project.canvasId, input: { profile: 'canvas-general' } })
  }
  assert.equal((await runStep('1930000001', 'get_canvas_summary', {})).state, 'completed')
  assert.equal((await runStep('1930000002', 'create_nodes', { nodes: [{ type: 'text', prompt: 'forbidden' }] })).state, 'failed')
  assert.ok(!calls.includes('agent:core:create-node'))
  assert.equal((await store.loadCanvas(project.projectId, project.canvasId)).nodes.length, 0)

  await request('agent:close', {}); await worker.terminate(); worker = null
  await start()
  assert.deepEqual((await request('agent:get-role', payload)).binding, reviewer.binding)
  await market.setEnabled(directory, 'short-drama-workbench', 'shot-reviewer', false)
  assert.equal((await runStep('1930000003', 'get_canvas_summary', {})).state, 'failed')
  assert.deepEqual((await request('agent:get-role', payload)).binding, reviewer.binding)
  assert.equal((await request('agent:set-role', { ...payload, binding: null })).binding, null)
})
