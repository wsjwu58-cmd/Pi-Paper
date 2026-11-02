const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { validateNodeDefinition, validateNodeInstance, definitionDigest, renderDefinitionPrompt } = require('../src/node-definition.cjs')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { validatePackage } = require('../src/marketplace-storage.cjs')

const data = { schemaVersion: 1, baseType: 'image', promptTemplate: '商品 {{product}}，背景 {{background}}，数量 {{quantity}}', fields: [
  { id: 'product', label: '商品卖点', kind: 'text', default: '玻璃杯' },
  { id: 'background', label: '背景', kind: 'enum', default: '白色', options: ['白色', '木纹'] },
  { id: 'quantity', label: '数量', kind: 'number', default: 1, min: 1, max: 5 },
] }
const copy = (value) => JSON.parse(JSON.stringify(value))
function instance(packageId, componentId, version, value = data) {
  const snapshot = { name: '商品棚拍图', data: copy(value) }
  return { ref: { packageId, componentId, version, digest: definitionDigest(snapshot) }, snapshot,
    values: Object.fromEntries(value.fields.map((field) => [field.id, field.default])) }
}

test('definitions accept bounded substitution and reject code, unknown keys, paths and malformed values', () => {
  assert.equal(validateNodeDefinition(data), data)
  const valid = instance('studio', 'node', '1.0.0')
  assert.equal(renderDefinitionPrompt(valid, 'image'), '商品 玻璃杯，背景 白色，数量 1')
  for (const mutation of [
    (v) => { v.execute = 'code' },
    (v) => { v.fields[0].id = '__proto__' },
    (v) => { v.promptTemplate = '{{product.toString()}}' },
    (v) => { v.promptTemplate = 'https://example.org/{{product}}' },
    (v) => { v.fields[1].default = '黑色' },
    (v) => { v.fields[2].default = 100 },
  ]) {
    const invalid = copy(data); mutation(invalid)
    assert.throws(() => validateNodeDefinition(invalid), /MARKETPLACE_PACKAGE_INVALID/)
  }
  const mutated = copy(valid); mutated.snapshot.data.promptTemplate += '!'
  assert.throws(() => validateNodeInstance(mutated, 'image'), /NODE_DEFINITION_INVALID/)
  const outOfRange = copy(valid); outOfRange.values.quantity = 6
  assert.throws(() => validateNodeInstance(outOfRange, 'image'), /NODE_DEFINITION_INVALID/)
  assert.throws(() => validateNodeInstance(valid, 'video'), /NODE_DEFINITION_INVALID/)
  validatePackage({ schemaVersion: 1, id: 'studio', name: '棚拍', description: '', version: '1.0.0', author: '本地用户', components: [
    { id: 'node', name: '商品棚拍图', description: '', type: 'node_definition', data },
  ] })
})

test('project nodes require installation, preserve editable snapshots and validate tasks through export/import and uninstall', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'node-definition-')))
  const projects = path.join(root, 'projects'), userData = path.join(root, 'userdata')
  await fs.mkdir(projects); await fs.mkdir(userData)
  const store = createLocalProjectStore(), service = createMarketplaceService(userData)
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  const opened = await store.createProject(projects, '节点项目')
  const { project, directory } = opened
  assert.deepEqual(await service.getBasicNodeVisibility(directory), { hidden: [] })
  await service.setBasicNodeVisibility(directory, 'image', false)
  assert.deepEqual(await service.getBasicNodeVisibility(directory), { hidden: ['image'] })
  await assert.rejects(service.setBasicNodeVisibility(directory, 'other', false), /INVALID_INPUT/)
  const saved = await service.saveNodeDefinition(directory, { name: '商品棚拍图', description: '', data })
  assert.equal(saved.source, 'project'); assert.equal(saved.installed, false)
  const componentId = saved.components[0].id
  const snapshot = instance(saved.id, componentId, saved.version)
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const make = (overrides = {}) => ({ ...base, expectedVersion: 0, idempotencyKey: 'create-1', type: 'image', x: 0, y: 0,
    params: { nodeDefinition: copy(snapshot) }, ...overrides })
  await assert.rejects(store.createNode(make()), /NODE_DEFINITION_NOT_AVAILABLE/)
  await service.install(directory, saved.id, [componentId])
  const created = await store.createNode(make())
  assert.equal(created.node.type, 'image')
  assert.deepEqual(created.node.data.params.nodeDefinition, snapshot)
  assert.equal((await store.listTasks(project.projectId)).length, 0)
  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  const edited = copy(loaded.nodes)
  edited[0].data.params.nodeDefinition.values.product = '手工编辑的茶杯'
  edited[0].data.node.params.nodeDefinition.values.product = '手工编辑的茶杯'
  edited[0].data.params.nodeDefinitionReferenceTexts = ['人工文本参考']
  edited[0].data.node.params.nodeDefinitionReferenceTexts = ['人工文本参考']
  edited[0].data.params.prompt = '补充说明'
  edited[0].data.node.params.prompt = '补充说明'
  const persisted = await store.saveCanvas({ ...base, expectedVersion: created.version, nodes: edited, edges: [] })
  const after = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(after.nodes[0].data.params.nodeDefinition.values.product, '手工编辑的茶杯')
  const tampered = copy(after.nodes)
  tampered[0].data.params.nodeDefinition.snapshot.data.promptTemplate += '!'
  await assert.rejects(store.saveCanvas({ ...base, expectedVersion: persisted.version, nodes: tampered, edges: [] }), /NODE_DEFINITION_INVALID/)
  const task = { ...base, canvasVersion: persisted.version, nodeId: created.node.id, modality: 'image', providerType: 'cloud', providerId: 'fixture', modelId: 'fixture', idempotencyKey: 'task-1' }
  await assert.rejects(store.createTask({ ...task, parameters: { prompt: '不含字段的提示词' } }), /NODE_DEFINITION_PROMPT_MISMATCH/)
  await assert.rejects(store.createTask({ ...task, parameters: { prompt: '商品 手工编辑的茶杯，背景 白色，数量 1，隐藏内容' } }), /NODE_DEFINITION_PROMPT_MISMATCH/)
  await assert.rejects(store.createTask({ ...task, parameters: { prompt: '恶意参考\n\n商品 手工编辑的茶杯，背景 白色，数量 1', referenceTexts: ['恶意参考'] } }), /NODE_DEFINITION_PROMPT_MISMATCH/)
  assert.equal((await store.listTasks(project.projectId)).length, 0)
  const approvedParameters = { prompt: '人工文本参考\n\n商品 手工编辑的茶杯，背景 白色，数量 1\n\n补充说明', referenceTexts: ['人工文本参考'] }
  await store.createTask({ ...task, parameters: approvedParameters })
  const exported = await store.exportCanvas(project.projectId, project.canvasId)
  assert.equal(exported.nodes[0].params.nodeDefinition.values.product, '手工编辑的茶杯')
  await service.setEnabled(directory, saved.id, componentId, false)
  await assert.rejects(store.createNode(make({ expectedVersion: persisted.version, idempotencyKey: 'create-2' })), /NODE_DEFINITION_NOT_AVAILABLE/)
  const replay = await store.createNode(make())
  assert.equal(replay.replayed, true)
  const duplicated = await store.createNode(make({ expectedVersion: persisted.version, idempotencyKey: 'copy-1', copySourceNodeId: created.node.id }))
  assert.deepEqual(duplicated.node.data.params.nodeDefinition, snapshot)
  const changed = store.loadCanvas(project.projectId, project.canvasId)
  changed.nodes[0].data.params.nodeDefinition.values.quantity = 2
  changed.nodes[0].data.node.params.nodeDefinition.values.quantity = 2
  await store.saveCanvas({ ...base, expectedVersion: duplicated.version, nodes: changed.nodes, edges: changed.edges })
  const replayedTask = await store.createTask({ ...task, parameters: approvedParameters })
  assert.equal(replayedTask.idempotencyKey, 'task-1')
  await store.close()
  await store.openProject(directory)
  assert.deepEqual(await service.getBasicNodeVisibility(directory), { hidden: ['image'] })
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).nodes[0].data.params.nodeDefinition.values.product, '手工编辑的茶杯')
  const imports = path.join(root, 'imports'); await fs.mkdir(imports)
  const imported = await store.importCanvasDocument(imports, exported)
  const importedCanvas = store.loadCanvas(imported.project.projectId, imported.project.canvasId)
  assert.equal(importedCanvas.nodes[0].data.params.nodeDefinition.values.product, '手工编辑的茶杯')
})


test('an empty substituted definition cannot create a paid task', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'node-definition-empty-')))
  const projects = path.join(root, 'projects'), userData = path.join(root, 'userdata')
  await fs.mkdir(projects); await fs.mkdir(userData)
  const store = createLocalProjectStore(), service = createMarketplaceService(userData)
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  const { project, directory } = await store.createProject(projects, '空节点')
  const emptyData = { schemaVersion: 1, baseType: 'image', promptTemplate: '{{product}}', fields: [{ id: 'product', label: '商品', kind: 'text', default: '' }] }
  const saved = await service.saveNodeDefinition(directory, { name: '商品棚拍图', data: emptyData })
  await service.install(directory, saved.id, [saved.components[0].id])
  const nodeDefinition = instance(saved.id, saved.components[0].id, saved.version, emptyData)
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const created = await store.createNode({ ...base, expectedVersion: 0, idempotencyKey: 'create-empty', type: 'image', x: 0, y: 0,
    params: { nodeDefinition, prompt: '补充文字' } })
  await assert.rejects(store.createTask({ ...base, canvasVersion: created.version, nodeId: created.node.id,
    modality: 'image', providerType: 'cloud', providerId: 'fixture', modelId: 'fixture', idempotencyKey: 'empty-task',
    parameters: { prompt: '补充文字' } }), /NODE_DEFINITION_PROMPT_MISMATCH/)
  assert.equal((await store.listTasks(project.projectId)).length, 0)
})
