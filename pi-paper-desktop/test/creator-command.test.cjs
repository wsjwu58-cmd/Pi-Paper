const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { executeCreatorCommand } = require('../src/creator-command.cjs')
const { pathToFileURL } = require('node:url')
const commandModule = pathToFileURL(path.resolve(__dirname, '../../pi-paper-web/src/features/canvas/pluginTemplateGraph.ts')).href

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creative-command-')))
  const projects = path.join(root, 'projects'), userData = path.join(root, 'userdata')
  await fs.mkdir(projects); await fs.mkdir(userData)
  const store = createLocalProjectStore(), service = createMarketplaceService(userData), commands = await import(commandModule)
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  const { project, directory } = await store.createProject(projects, '共享命令')
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const node = (id, type, x, y, params) => ({ id, type, width: 100, height: 80, position: { x, y }, data: { node: { id, type, x, y, params, status: 'idle' }, params } })
  await store.saveCanvas({ ...base, expectedVersion: 0, nodes: [node('a', 'text', 0, 20, { title: '镜头一', content: '内容', prompt: '首个' }),
    node('b', 'image', 300, 10, { title: '镜头二' })], edges: [] })
  await service.install(directory, 'creative-studio', ['horizontal', 'shots'])
  const core = async (method, input) => {
    if (method === 'canvas:load') return store.loadCanvas(input.projectId, input.canvasId)
    if (method === 'canvas:arrange-nodes') return store.arrangeCreativeNodes(input)
    if (method === 'agent:lookup-operation') return store.lookupAgentOperation(input)
    throw new Error(`unexpected ${method}`)
  }
  const barrier = async (request, fn) => {
    const canvas = await core('canvas:load', base)
    if (canvas.version !== request.expectedVersion) throw new Error('CANVAS_VERSION_CONFLICT')
    return fn(canvas.version)
  }
  const execute = (action, input, operationKey = 'operation-1', authorize = () => {}, reauthorize = async () => {}) => executeCreatorCommand({
    service, directory, ...base, action, input, operationKey, authorize, reauthorize, core, barrier, previewBarrier: barrier, commands,
  })
  const snapshot = await service.getInstalledSnapshot(directory, 'creative-studio', 'horizontal')
  const selection = { packageId: 'creative-studio', componentId: 'horizontal', digest: snapshot.digest, selectionIds: ['a', 'b'], expectedVersion: 1 }
  return { execute, service, store, directory, project, base, selection, commands }
}

test('one catalog exposes installed command availability and the same storyboard preview to host and canvas', async (t) => {
  const { execute, service, directory, store, base, commands } = await fixture(t)
  const catalog = await execute('command_inspect', { selectionIds: ['a'] })
  assert.equal(catalog.commands.find((entry) => entry.componentId === 'horizontal').reason, 'SELECTION_TOO_SMALL')
  assert.equal(catalog.commands.find((entry) => entry.componentId === 'shots').available, true)
  const snapshot = await service.getInstalledSnapshot(directory, 'creative-studio', 'shots')
  const input = { packageId: 'creative-studio', componentId: 'shots', digest: snapshot.digest, selectionIds: ['a', 'b'], expectedVersion: 1 }
  const preview = await execute('command_preview', input)
  const canvas = store.loadCanvas(base.projectId, base.canvasId)
  assert.deepEqual(preview.rows, commands.previewCreativeCommand(snapshot.component, canvas.nodes, input.selectionIds).rows)
  assert.equal(preview.fields.includes('prompt'), true)
  assert.ok(preview.missing.some((entry) => entry.id === 'b' && entry.fields.includes('prompt')))
  await assert.rejects(execute('command_apply', { ...input, previewDigest: preview.previewDigest }), /COMMAND_READ_ONLY/)
  assert.equal((await store.listTasks(base.projectId)).length, 0)
})

test('arrangement requires exact preview, persists undo, rejects changed positions, and replays after disable', async (t) => {
  const { execute, service, store, directory, base, selection } = await fixture(t)
  const preview = await execute('command_preview', selection)
  assert.equal(preview.capabilityId, 'selection.arrange')
  assert.deepEqual(preview.moves.map((move) => move.to), [{ x: 0, y: 10 }, { x: 128, y: 10 }])
  await assert.rejects(execute('command_apply', { ...selection, previewDigest: '0'.repeat(64) }), /PREVIEW_CHANGED/)
  await assert.rejects(execute('command_apply', { ...selection, previewDigest: preview.previewDigest }, 'denied', (effect) => {
    if (effect === 'canvas_write') throw new Error('PERMISSION_DENIED')
  }), /PERMISSION_DENIED/)
  const applied = await execute('command_apply', { ...selection, previewDigest: preview.previewDigest })
  assert.equal(applied.canvasVersion, 2); assert.equal(applied.generationTasksCreated, 0)
  assert.deepEqual(store.loadCanvas(base.projectId, base.canvasId).nodes.map((node) => node.position), preview.moves.map((move) => move.to))
  await service.setEnabled(directory, 'creative-studio', 'horizontal', false)
  const replay = await execute('command_apply', { ...selection, previewDigest: preview.previewDigest })
  assert.equal(replay.replayed, true); assert.equal(replay.canvasVersion, 2)
  const undo = await execute('command_undo', { originalOperationKey: 'operation-1', expectedVersion: 2 }, 'undo-1')
  assert.equal(undo.canvasVersion, 3)
  assert.deepEqual(store.loadCanvas(base.projectId, base.canvasId).nodes.map((node) => node.position), preview.moves.map((move) => move.from))
  assert.equal((await execute('command_undo', { originalOperationKey: 'operation-1', expectedVersion: 2 }, 'undo-1')).replayed, true)
  assert.equal((await store.listTasks(base.projectId)).length, 0)
})

test('undo never overwrites a later move and stale previews cannot be applied', async (t) => {
  const { execute, store, base, selection } = await fixture(t)
  const preview = await execute('command_preview', selection)
  await execute('command_apply', { ...selection, previewDigest: preview.previewDigest })
  const canvas = store.loadCanvas(base.projectId, base.canvasId)
  canvas.nodes[0].position.x += 10
  await store.saveCanvas({ ...base, expectedVersion: 2, nodes: canvas.nodes, edges: canvas.edges })
  await assert.rejects(execute('command_undo', { originalOperationKey: 'operation-1', expectedVersion: 3 }, 'undo-2'), /SELECTION_CHANGED/)
  await assert.rejects(execute('command_apply', { ...selection, previewDigest: preview.previewDigest }, 'other-operation'), /CANVAS_VERSION_CONFLICT/)
  assert.equal(store.loadCanvas(base.projectId, base.canvasId).version, 3)
})


test('disable and dispatch serialize, and a completed disable blocks subsequent operations', async (t) => {
  const { execute, service, directory, selection, store, base } = await fixture(t)
  const preview = await execute('command_preview', selection)
  let release, entered
  const waiting = new Promise((resolve) => { release = resolve })
  const ready = new Promise((resolve) => { entered = resolve })
  const applying = execute('command_apply', { ...selection, previewDigest: preview.previewDigest }, 'locked-apply', () => {}, async () => { entered(); await waiting })
  await ready
  let disabled = false
  const disabling = service.setEnabled(directory, 'creative-studio', 'horizontal', false).then(() => { disabled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(disabled, false)
  release()
  assert.equal((await applying).canvasVersion, 2)
  await disabling
  await assert.rejects(execute('command_preview', { ...selection, expectedVersion: 2 }), /MARKETPLACE_COMPONENT_NOT_AVAILABLE/)
  assert.equal((await store.listTasks(base.projectId)).length, 0)
})
