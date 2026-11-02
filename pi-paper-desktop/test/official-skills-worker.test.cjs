const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const test = require('node:test')
const { build } = require('esbuild')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { createLocalProjectStore } = require('../src/project-store.cjs')

test('bundled Worker honors official Skill availability before and after restart', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'official-skill-worker-')))
  const projects = path.join(root, 'projects')
  const userdata = path.join(root, 'userdata')
  await Promise.all([fs.mkdir(projects), fs.mkdir(userdata)])
  const store = createLocalProjectStore()
  const { directory, project } = await store.createProject(projects, 'Skill Worker')
  const bundle = path.join(root, 'agent-worker.cjs')
  const desktop = path.resolve(__dirname, '..')
  const pi = path.resolve(desktop, '../pi-main')
  await build({ entryPoints: [path.join(desktop, 'src/agent-worker.cjs')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22.19', external: ['node:*'],
    nodePaths: [path.join(pi, 'node_modules')], legalComments: 'none' })
  let worker
  let nextId = 0
  const request = (method, payload) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker timed out: ${method}`)) }, 15_000)
    function cleanup() { clearTimeout(timer); worker.off('message', onMessage); worker.off('error', onError) }
    function onError(error) { cleanup(); reject(error) }
    function onMessage(message) {
      if (message?.id !== id) return
      cleanup()
      if (message.ok) resolve(message.result)
      else reject(new Error(message.error))
    }
    worker.on('message', onMessage); worker.on('error', onError)
    worker.postMessage({ id, method, payload })
  })
  const start = async () => {
    worker = new Worker(`const { parentPort } = require('node:worker_threads'); process.parentPort = { on: (...a) => parentPort.on(...a), postMessage: (...a) => parentPort.postMessage(...a) }; require(${JSON.stringify(bundle)})`, { eval: true })
    worker.on('message', async (message) => {
      if (message?.kind !== 'agent-local-core-request') return
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
    await store.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  await start()
  const session = await request('agent:create-session', { projectId: project.projectId, canvasId: project.canvasId, title: 'Skill 续接' })
  const payload = { projectId: project.projectId, sessionId: session.sessionId }
  let listing = await request('agent:list-skills', payload)
  assert.equal(listing.items.filter((skill) => skill.source === 'builtin' || skill.source === 'system_dynamic').length, 23)
  assert.ok(listing.items.every((skill) => !Object.hasOwn(skill, 'isAvailable')))
  await request('agent:set-session-skills', { ...payload, input: ['product-visual'] })

  const executeSkill = async (id) => {
    await request('agent:plan:create', { projectId: project.projectId, id: session.sessionId, canvasId: project.canvasId,
      input: { profile: 'canvas-general', plan: { id, version: 1, canvasVersion: 0, steps: [
        { id: 'load', tool: 'load_skill', input: { skill: 'product-visual' }, inputHash: `hash-${id}`, dependsOn: [] },
      ] } } })
    return request('agent:plan:execute', { projectId: project.projectId, id, canvasId: project.canvasId, input: { profile: 'canvas-general' } })
  }
  assert.equal((await executeSkill('1920000001')).state, 'completed')
  const market = createMarketplaceService(userdata)
  await market.setEnabled(directory, '@vibepaper/official-skills', 'product-visual', false)
  assert.equal((await executeSkill('1920000002')).state, 'failed')
  listing = await request('agent:list-skills', payload)
  assert.equal(listing.items.find((skill) => skill.id === 'product-visual').enabled, false)
  assert.ok(listing.loadedSkillIds.includes('product-visual'))
  await assert.rejects(request('agent:set-session-skills', { ...payload, input: ['product-visual'] }), /SKILL_NOT_FOUND/)

  await request('agent:close', {})
  await worker.terminate()
  worker = null
  await start()
  listing = await request('agent:list-skills', payload)
  assert.equal(listing.items.find((skill) => skill.id === 'product-visual').enabled, false)
  assert.ok(listing.loadedSkillIds.includes('product-visual'))
  assert.equal((await executeSkill('1920000003')).state, 'failed')
})
