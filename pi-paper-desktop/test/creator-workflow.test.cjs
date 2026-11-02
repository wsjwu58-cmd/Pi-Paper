const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { executeCreatorWorkflow, validateWorkflowRecipe } = require('../src/creator-workflow.cjs')
const { executeCreatorCommand } = require('../src/creator-command.cjs')

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-recipe-')))
  const projects = path.join(root, 'projects'), userdata = path.join(root, 'userdata')
  await fs.mkdir(projects); await fs.mkdir(userdata)
  const store = createLocalProjectStore(), service = createMarketplaceService(userdata)
  const commands = await import(pathToFileURL(path.resolve(__dirname, '../../pi-paper-web/src/features/canvas/pluginTemplateGraph.ts')).href)
  const { project, directory } = await store.createProject(projects, '工作流')
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const node = (id, x, y, title, prompt) => ({ id, type: 'text', width: 100, height: 80, position: { x, y },
    data: { node: { id, type: 'text', x, y, params: { title, prompt }, status: 'idle' }, params: { title, prompt } } })
  await store.saveCanvas({ ...base, expectedVersion: 0, nodes: [node('a', 0, 300, 'A', 'first'), node('b', 500, 0, 'B', '')], edges: [] })
  const manifest = { schemaVersion: 1, id: 'workflow-test', name: '镜头工作流', description: '', version: '1.0.0', author: 'Test', components: [
    { id: 'arrange', type: 'selection_command', name: '水平排列', description: '', data: { command: 'arrange', orientation: 'horizontal', gap: 28 } },
    { id: 'storyboard', type: 'storyboard', name: '分镜', description: '', data: { fields: ['title', 'prompt'] } },
    { id: 'workflow', type: 'workflow_recipe', name: '准备', description: '', data: { steps: [
      { kind: 'arrange', componentId: 'arrange' }, { kind: 'storyboard_preview', componentId: 'storyboard' },
      { kind: 'check_missing_prompt', componentId: 'storyboard' },
    ] } },
  ] }
  await service.importPackage(manifest)
  await service.install(directory, manifest.id, ['arrange', 'storyboard', 'workflow'])
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
  const snapshot = await service.getInstalledSnapshot(directory, manifest.id, 'workflow')
  const input = { packageId: manifest.id, componentId: 'workflow', digest: snapshot.digest, selectionIds: ['a', 'b'], expectedVersion: 1 }
  const execute = (action, request = input, operationKey = 'workflow-1', overrides = {}) => executeCreatorWorkflow({
    service, directory, ...base, action, input: request, operationKey, authorize: () => {}, reauthorize: async () => {},
    core, barrier, previewBarrier: barrier, commands, ...overrides,
  })
  return { store, service, directory, base, commands, execute, input, core, barrier }
}

test('recipe preview projects earlier moves into later steps, then applies once and can be undone', async (t) => {
  const { store, service, directory, base, commands, execute, input, core, barrier } = await fixture(t)
  const original = store.loadCanvas(base.projectId, base.canvasId)
  const component = await service.getInstalledSnapshot(directory, input.packageId, 'storyboard')
  assert.deepEqual(commands.previewCreativeCommand(component.component, original.nodes, input.selectionIds).rows.map((row) => row.values.title), ['B', 'A'])
  const preview = await execute('workflow_preview')
  assert.deepEqual(preview.steps.find((step) => step.kind === 'storyboard_preview').result.rows.map((row) => row.values.title), ['A', 'B'])
  assert.deepEqual(preview.steps.find((step) => step.kind === 'check_missing_prompt').result.missing.map((row) => row.title), ['B'])
  assert.equal(store.loadCanvas(base.projectId, base.canvasId).version, 1)
  assert.equal((await store.listTasks(base.projectId)).length, 0)
  const applied = await execute('workflow_apply', { ...input, previewDigest: preview.previewDigest })
  assert.equal(applied.canvasVersion, 2)
  assert.deepEqual(commands.previewCreativeCommand(component.component, store.loadCanvas(base.projectId, base.canvasId).nodes, input.selectionIds).rows.map((row) => row.values.title), ['A', 'B'])
  await service.setEnabled(directory, input.packageId, 'workflow', false)
  const replay = await execute('workflow_apply', { ...input, previewDigest: preview.previewDigest })
  assert.equal(replay.replayed, true)
  await assert.rejects(execute('workflow_apply', { ...input, previewDigest: '0'.repeat(64) }), /IDEMPOTENCY_CONFLICT/)
  const undo = await executeCreatorCommand({ service, directory, ...base, action: 'command_undo', input: { originalOperationKey: 'workflow-1', expectedVersion: 2 },
    operationKey: 'undo-workflow', authorize: () => {}, core, barrier, previewBarrier: barrier, commands })
  assert.equal(undo.canvasVersion, 3)
  assert.deepEqual(store.loadCanvas(base.projectId, base.canvasId).nodes.map((node) => node.position), original.nodes.map((node) => node.position))
  assert.equal((await store.listTasks(base.projectId)).length, 0)
})

test('recipe refuses disabled dependencies, stale previews, and revocation at the write barrier', async (t) => {
  const { store, service, directory, base, execute, input, core } = await fixture(t)
  const preview = await execute('workflow_preview')
  await service.setEnabled(directory, input.packageId, 'storyboard', false)
  await assert.rejects(execute('workflow_apply', { ...input, previewDigest: preview.previewDigest }), /WORKFLOW_DEPENDENCY_UNAVAILABLE/)
  assert.equal(store.loadCanvas(base.projectId, base.canvasId).version, 1)
  await service.setEnabled(directory, input.packageId, 'storyboard', true)
  await assert.rejects(execute('workflow_apply', { ...input, previewDigest: preview.previewDigest }, 'revoke', {
    barrier: async (request, operation) => {
      await service.setEnabled(directory, input.packageId, 'workflow', false)
      return operation(request.expectedVersion)
    },
  }), /MARKETPLACE_VERSION_CONFLICT/)
  assert.equal(store.loadCanvas(base.projectId, base.canvasId).version, 1)
  await service.setEnabled(directory, input.packageId, 'workflow', true)
  const canvas = await core('canvas:load', base)
  await store.saveCanvas({ ...base, expectedVersion: 1, nodes: canvas.nodes, edges: canvas.edges })
  await assert.rejects(execute('workflow_apply', { ...input, previewDigest: preview.previewDigest }, 'stale'), /CANVAS_VERSION_CONFLICT/)
})

test('recipe schema rejects unsupported, duplicate or executable steps', () => {
  assert.throws(() => validateWorkflowRecipe({ steps: [{ kind: 'execute', componentId: 'shell' }] }), /MARKETPLACE_PACKAGE_INVALID/)
  assert.throws(() => validateWorkflowRecipe({ steps: [{ kind: 'arrange', componentId: 'x', command: 'rm' }] }), /MARKETPLACE_PACKAGE_INVALID/)
  assert.throws(() => validateWorkflowRecipe({ steps: [{ kind: 'arrange', componentId: 'x' }, { kind: 'arrange', componentId: 'y' }] }), /MARKETPLACE_PACKAGE_INVALID/)
})
