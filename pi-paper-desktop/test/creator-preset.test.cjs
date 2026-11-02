const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { executeCreatorPreset } = require('../src/creator-preset.cjs')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const preset = require('../dist/plugin-preset.cjs')

async function fixture(t, presetParams, nodeParams = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creator-preset-')))
  const projects = path.join(root, 'projects'), userdata = path.join(root, 'userdata')
  await fs.mkdir(projects); await fs.mkdir(userdata)
  const store = createLocalProjectStore(), project = await store.createProject(projects, '预设项目')
  const projectId = project.project.projectId, canvasId = project.project.canvasId, directory = project.directory
  const service = createMarketplaceService(userdata)
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  const node = await store.createNode({ projectId, canvasId, expectedVersion: 0, idempotencyKey: 'node', type: 'image', x: 0, y: 0, params: nodeParams })
  const draft = { name: '预设', description: '', components: [{ id: 'preset', name: '预设', description: '', type: 'preset', data: { nodeType: 'image', params: presetParams } }] }
  const digest = service.validateCreatorDraft(draft, true).draftDigest
  const saved = await service.saveProjectDraft(directory, draft, { draftDigest: digest, operationKey: 'save-preset' })
  await service.installCreator(directory, saved.packageId, saved.digest, ['preset'], () => {})
  await service.setEnabledCreator(directory, saved.packageId, saved.digest, 'preset', true, () => {})
  const core = (method, input) => {
    if (method === 'canvas:load') return store.loadCanvas(input.projectId, input.canvasId)
    if (method === 'canvas:save') return store.saveCanvas(input)
    if (method === 'agent:lookup-operation') return store.lookupAgentOperation(input)
    throw new Error('unexpected core method')
  }
  const barrier = async (request, operation) => {
    const canvas = await store.loadCanvas(projectId, canvasId)
    if (canvas.version !== request.expectedVersion) throw new Error('CANVAS_VERSION_CONFLICT')
    return operation(canvas.version)
  }
  const base = { service, directory, projectId, canvasId, authorize() {}, core, barrier, previewBarrier: barrier, preset,
    providerConfiguration: async () => ({ providers: [], models: [] }) }
  const input = { packageId: saved.packageId, componentId: 'preset', digest: saved.digest, targetNodeId: node.node.id, expectedVersion: node.version }
  return { root, store, projectId, canvasId, service, saved, base, input }
}

test('preset preview is read-only, apply is version-bound, and undo preserves unrelated edits', async (t) => {
  const { store, projectId, canvasId, base, input } = await fixture(t, { prompt: '新提示词' }, { prompt: '旧提示词' })
  const preview = await executeCreatorPreset({ ...base, action: 'preset_preview', input, operationKey: 'a'.repeat(64) })
  assert.deepEqual(preview.changes.map(({ key, before, after }) => ({ key, before, after })), [{ key: 'prompt', before: '旧提示词', after: '新提示词' }])
  assert.equal((await store.loadCanvas(projectId, canvasId)).version, input.expectedVersion)
  const applied = await executeCreatorPreset({ ...base, action: 'preset_apply', input: { ...input, previewDigest: preview.previewDigest }, operationKey: 'b'.repeat(64) })
  let canvas = await store.loadCanvas(projectId, canvasId)
  assert.equal(canvas.nodes[0].data.node.params.prompt, '新提示词')
  await store.updateNode({ projectId, canvasId, nodeId: input.targetNodeId, expectedVersion: canvas.version, idempotencyKey: 'other-edit',
    params: { ...canvas.nodes[0].data.node.params, style: '保留' }, prompt: '新提示词' })
  canvas = await store.loadCanvas(projectId, canvasId)
  await executeCreatorPreset({ ...base, action: 'preset_undo', input: { targetNodeId: input.targetNodeId, originalOperationKey: applied.operationKey, expectedVersion: canvas.version }, operationKey: 'c'.repeat(64) })
  canvas = await store.loadCanvas(projectId, canvasId)
  assert.equal(canvas.nodes[0].data.node.params.prompt, '旧提示词')
  assert.equal(canvas.nodes[0].data.node.params.style, '保留')
  assert.equal((await store.listTasks(projectId)).length, 0)
})

test('preset rejects stale previews, unsupported model parameters, and undo of an edited field', async (t) => {
  const first = await fixture(t, { prompt: '新提示词' }, { prompt: '旧提示词' })
  const preview = await executeCreatorPreset({ ...first.base, action: 'preset_preview', input: first.input, operationKey: 'a'.repeat(64) })
  const applied = await executeCreatorPreset({ ...first.base, action: 'preset_apply', input: { ...first.input, previewDigest: preview.previewDigest }, operationKey: 'b'.repeat(64) })
  let canvas = await first.store.loadCanvas(first.projectId, first.canvasId)
  await first.store.updateNode({ projectId: first.projectId, canvasId: first.canvasId, nodeId: first.input.targetNodeId, expectedVersion: canvas.version,
    idempotencyKey: 'user-edit', params: { prompt: '用户新值' }, prompt: '用户新值' })
  canvas = await first.store.loadCanvas(first.projectId, first.canvasId)
  await assert.rejects(executeCreatorPreset({ ...first.base, action: 'preset_undo', input: { targetNodeId: first.input.targetNodeId, originalOperationKey: applied.operationKey, expectedVersion: canvas.version }, operationKey: 'c'.repeat(64) }), /UNDO_TARGET_CHANGED/)
  assert.equal((await first.store.loadCanvas(first.projectId, first.canvasId)).nodes[0].data.node.params.prompt, '用户新值')
  await assert.rejects(executeCreatorPreset({ ...first.base, action: 'preset_apply', input: { ...first.input, previewDigest: preview.previewDigest }, operationKey: 'd'.repeat(64) }), /CANVAS_VERSION_CONFLICT/)
  const second = await fixture(t, { ratio: '16:9' }, {})
  await assert.rejects(executeCreatorPreset({ ...second.base, action: 'preset_preview', input: second.input, operationKey: 'e'.repeat(64) }), /MARKETPLACE_MODEL_SELECTION_REQUIRED/)
  const third = await fixture(t, { ratio: '16:9' }, { model: 'test-model' })
  third.base.providerConfiguration = async () => ({ providers: [{ id: 'provider', configured: true, enabledModelIds: ['test-model'], defaultModelIds: {} }],
    models: [{ id: 'test-model', providerId: 'provider', enabled: true, implemented: true, modelType: 'image', inputModes: ['text'], defaults: { ratio: '1:1' }, constraints: { acceptedAspectRatios: ['1:1'] } }] })
  await assert.rejects(executeCreatorPreset({ ...third.base, action: 'preset_preview', input: third.input, operationKey: 'f'.repeat(64) }), /MARKETPLACE_MODEL_PARAMETERS_UNSUPPORTED/)
})

test('model configuration changes after preview invalidate the preset before dispatch', async (t) => {
  const target = await fixture(t, { ratio: '16:9' }, { model: 'test-model' })
  let revision = 1
  const configuration = () => ({ providers: [{ id: 'provider', configured: true, revision, enabledModelIds: ['test-model'], defaultModelIds: {} }],
    models: [{ id: 'test-model', providerId: 'provider', enabled: true, implemented: true, modelType: 'image', inputModes: ['text'],
      defaults: { ratio: '1:1' }, constraints: { acceptedAspectRatios: ['1:1', '16:9'] } }] })
  target.base.providerConfiguration = async () => configuration()
  target.base.withProviderConfiguration = async (callback) => callback(configuration())
  const preview = await executeCreatorPreset({ ...target.base, action: 'preset_preview', input: target.input, operationKey: 'a'.repeat(64) })
  let checks = 0
  const changing = { ...target.base, reauthorize: async () => { if (++checks === 1) revision = 2 } }
  await assert.rejects(executeCreatorPreset({ ...changing, action: 'preset_apply', input: { ...target.input, previewDigest: preview.previewDigest }, operationKey: 'b'.repeat(64) }), /PREVIEW_CHANGED/)
  const canvas = await target.store.loadCanvas(target.projectId, target.canvasId)
  assert.equal(canvas.version, target.input.expectedVersion)
  assert.equal(canvas.nodes[0].data.node.params.ratio, undefined)
  const record = (await target.service.getCreatorOperations(target.base.directory, 'b'.repeat(64)))[0]
  assert.equal(record.status, 'failed')
})
