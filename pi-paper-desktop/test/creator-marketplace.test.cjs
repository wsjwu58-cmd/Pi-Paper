const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { executeCreatorMarketplace } = require('../src/creator-marketplace.cjs')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { portableTemplateGraph } = require('../../pi-paper-web/src/features/canvas/pluginTemplateGraph.ts')

const draft = { name: '商品三视图', description: '', components: [{ id: 'three-views', type: 'template', name: '三视图', description: '', data: {
  nodes: ['front', 'side', 'back'].flatMap((name, index) => [
    { id: `${name}-text`, type: 'text', x: 0, y: index * 300, params: { content: `${name} shooting requirements` } },
    { id: `${name}-image`, type: 'image', x: 350, y: index * 300, params: {} },
  ]),
  edges: ['front', 'side', 'back'].map((name) => ({ source: `${name}-text`, target: `${name}-image` })),
} }] }

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creator-marketplace-')))
  const projects = path.join(root, 'projects'), userdata = path.join(root, 'userdata')
  await fs.mkdir(projects); await fs.mkdir(userdata)
  const store = createLocalProjectStore()
  const project = await store.createProject(projects, '作品项目')
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, projects, userdata, store, project, service: createMarketplaceService(userdata) }
}

test('project-only versions remain private, immutable, replayable and survive export/import to another project', async (t) => {
  const { service, project, projects, store } = await fixture(t)
  const preview = service.validateCreatorDraft(draft, true)
  assert.deepEqual(preview.components.map(({ nodeCount, edgeCount }) => [nodeCount, edgeCount]), [[6, 3]])
  const saved = await service.saveProjectDraft(project.directory, draft, { draftDigest: preview.draftDigest, operationKey: 'save-1' })
  assert.equal(saved.package.source, 'project')
  assert.equal(saved.package.installed, false)
  assert.equal((await service.list()).some((item) => item.id === saved.packageId), false)
  const replay = await service.saveProjectDraft(project.directory, draft, { draftDigest: preview.draftDigest, operationKey: 'save-1' })
  assert.equal(replay.packageId, saved.packageId); assert.equal(replay.replayed, true)
  await assert.rejects(service.saveProjectDraft(project.directory, { ...draft, name: 'changed' }, { draftDigest: preview.draftDigest, operationKey: 'save-1' }), /MARKETPLACE_DRAFT_CHANGED/)
  const revision = { ...draft, name: '三视图修订' }
  const revisionPreview = service.validateCreatorDraft(revision, true)
  const next = await service.saveProjectDraft(project.directory, revision, { draftDigest: revisionPreview.draftDigest, operationKey: 'save-2', base: { packageId: saved.packageId, digest: saved.digest } })
  assert.equal(next.version, '1.0.1'); assert.equal(next.parentDigest, saved.digest)
  await assert.rejects(service.saveProjectDraft(project.directory, revision, { draftDigest: revisionPreview.draftDigest, operationKey: 'save-3', base: { packageId: saved.packageId, digest: saved.digest } }), /MARKETPLACE_VERSION_CONFLICT/)
  const exported = await service.exportPackage(project.directory, saved.packageId)
  const other = await store.createProject(projects, '另一个项目')
  assert.equal((await service.list(other.directory)).some((item) => item.id === saved.packageId), false)
  await service.importPackage(exported)
  assert.equal((await service.list(project.directory)).find((item) => item.id === saved.packageId).source, 'project')
  assert.equal((await service.list(other.directory)).find((item) => item.id === saved.packageId).source, 'local')
  await service.install(other.directory, saved.packageId, ['three-views'])
  assert.equal((await service.list(project.directory)).find((item) => item.id === saved.packageId).installed, false)
})

test('creator creates and applies exactly three independent pairs through one idempotent canvas save', async (t) => {
  const { service, project, store } = await fixture(t)
  const directory = project.directory, projectId = project.project.projectId, canvasId = project.project.canvasId
  const digest = service.validateCreatorDraft(draft, true).draftDigest
  const saved = await service.saveProjectDraft(directory, draft, { draftDigest: digest, operationKey: 'save-1' })
  const installed = await service.installCreator(directory, saved.packageId, saved.digest, ['three-views'], () => {})
  assert.equal(installed.components[0].enabled, false)
  await service.setEnabledCreator(directory, saved.packageId, saved.digest, 'three-views', true, () => {})
  const core = (method, payload) => {
    if (method === 'canvas:load') return store.loadCanvas(payload.projectId, payload.canvasId)
    if (method === 'canvas:save') return store.saveCanvas(payload)
    if (method === 'agent:lookup-operation') return store.lookupAgentOperation(payload)
    throw new Error('unexpected core command')
  }
  const barrier = async (request, operation) => {
    const canvas = await store.loadCanvas(projectId, canvasId)
    if (canvas.version !== request.expectedVersion) throw new Error('CANVAS_VERSION_CONFLICT')
    return operation(canvas.version)
  }
  const run = (operationKey, expectedVersion) => executeCreatorMarketplace({ service, directory, projectId, canvasId, action: 'apply',
    input: { packageId: saved.packageId, digest: saved.digest, componentId: 'three-views', expectedVersion }, operationKey,
    authorize() {}, core, barrier, graph: portableTemplateGraph, trackApply() {} })
  const tasksBefore = await store.listTasks(projectId)
  const first = await run('a'.repeat(64), 0)
  assert.equal(first.nodeCount, 6); assert.equal(first.edgeCount, 3); assert.equal(first.generationTasksCreated, 0)
  let canvas = await store.loadCanvas(projectId, canvasId)
  assert.equal(canvas.nodes.length, 6); assert.equal(canvas.edges.length, 3)
  assert.equal(new Set(canvas.edges.map((edge) => edge.source)).size, 3)
  assert.equal(new Set(canvas.edges.map((edge) => edge.target)).size, 3)
  const replay = await run('a'.repeat(64), 0)
  assert.equal(replay.replayed, true)
  canvas = await store.loadCanvas(projectId, canvasId)
  assert.equal(canvas.nodes.length, 6); assert.equal(canvas.edges.length, 3)
  const second = await run('b'.repeat(64), canvas.version)
  assert.equal(second.nodeCount, 6); assert.equal(second.edgeCount, 3)
  canvas = await store.loadCanvas(projectId, canvasId)
  assert.equal(canvas.nodes.length, 12); assert.equal(canvas.edges.length, 6)
  assert.equal((await store.listTasks(projectId)).length, tasksBefore.length)
  await assert.rejects(run('c'.repeat(64), 0), /CANVAS_VERSION_CONFLICT/)
  assert.equal((await store.loadCanvas(projectId, canvasId)).nodes.length, 12)
})

test('lost canvas response is reconciled after restart even when the component is disabled', async (t) => {
  const { service, project, store, userdata } = await fixture(t)
  const directory = project.directory, projectId = project.project.projectId, canvasId = project.project.canvasId
  const digest = service.validateCreatorDraft(draft, true).draftDigest
  const saved = await service.saveProjectDraft(directory, draft, { draftDigest: digest, operationKey: 'save-recovery' })
  await service.installCreator(directory, saved.packageId, saved.digest, ['three-views'], () => {})
  await service.setEnabledCreator(directory, saved.packageId, saved.digest, 'three-views', true, () => {})
  let loseResponse = true
  const core = async (method, payload) => {
    if (method === 'canvas:load') return store.loadCanvas(payload.projectId, payload.canvasId)
    if (method === 'agent:lookup-operation') return store.lookupAgentOperation(payload)
    if (method === 'canvas:save') {
      const result = await store.saveCanvas(payload)
      if (loseResponse) { loseResponse = false; throw new Error('CONNECTION_LOST') }
      return result
    }
    throw new Error('unexpected core command')
  }
  const common = { service, directory, projectId, canvasId, authorize() {}, core, graph: portableTemplateGraph, trackApply() {},
    barrier: async (_request, operation) => operation((await store.loadCanvas(projectId, canvasId)).version) }
  const input = { packageId: saved.packageId, digest: saved.digest, componentId: 'three-views', expectedVersion: 0 }
  const key = 'd'.repeat(64)
  await assert.rejects(executeCreatorMarketplace({ ...common, action: 'apply', input, operationKey: key }), /CONNECTION_LOST/)
  assert.equal((await store.loadCanvas(projectId, canvasId)).nodes.length, 6)
  await service.setEnabledCreator(directory, saved.packageId, saved.digest, 'three-views', false, () => {})
  await store.close()
  await store.openProject(directory)
  const restarted = createMarketplaceService(userdata)
  const lookup = await executeCreatorMarketplace({ ...common, service: restarted, action: 'result', input: { operationKey: key }, operationKey: 'e'.repeat(64) })
  assert.equal(lookup.operations[0].status, 'completed')
  assert.equal(lookup.operations[0].receipt.nodeCount, 6)
  const replay = await executeCreatorMarketplace({ ...common, service: restarted, action: 'apply', input, operationKey: key })
  assert.equal(replay.replayed, true)
  assert.equal((await store.loadCanvas(projectId, canvasId)).nodes.length, 6)
  await assert.rejects(executeCreatorMarketplace({ ...common, service: restarted, action: 'apply', input: { ...input, componentId: 'other' }, operationKey: key }), /IDEMPOTENCY_CONFLICT/)
})

test('v1 marketplace migration repairs partial backup and project backup/restore preserves both states', async (t) => {
  const { root, service, project, store, userdata } = await fixture(t)
  const directory = project.directory
  await service.install(directory, 'vibepaper-product-studio', ['product-workflow'])
  const marketDirectory = path.join(directory, '.vibepaper', 'agent', 'skills', '.marketplace')
  await fs.writeFile(path.join(marketDirectory, 'state.v1.backup.json'), '{partial')
  const digest = service.validateCreatorDraft(draft, true).draftDigest
  const saved = await service.saveProjectDraft(directory, draft, { draftDigest: digest, operationKey: 'upgrade-save' })
  const backupState = JSON.parse(await fs.readFile(path.join(marketDirectory, 'state.v1.backup.json'), 'utf8'))
  assert.equal(backupState.schemaVersion, 1)
  const backupDir = path.join(root, 'backup'), restoreDir = path.join(root, 'restore')
  await fs.mkdir(backupDir); await fs.mkdir(restoreDir)
  const backup = await store.backupProject(backupDir, project.project.projectId)
  const restored = await store.restoreBackup(backup.directory, restoreDir)
  const freshService = createMarketplaceService(userdata)
  const restoredPackage = (await freshService.list(restored.directory)).find((item) => item.id === saved.packageId)
  assert.equal(restoredPackage.source, 'project'); assert.equal(restoredPackage.version, saved.version)
  assert.equal(JSON.parse(await fs.readFile(path.join(restored.directory, '.vibepaper', 'agent', 'skills', '.marketplace', 'state.v1.backup.json'), 'utf8')).schemaVersion, 1)
})

test('capability discovery returns metadata by default and exact component data only on request', async (t) => {
  const { service, project } = await fixture(t)
  const digest = service.validateCreatorDraft(draft, true).draftDigest
  const saved = await service.saveProjectDraft(project.directory, draft, { draftDigest: digest, operationKey: 'inspect-save' })
  const common = { service, directory: project.directory, projectId: project.project.projectId, canvasId: project.project.canvasId,
    action: 'inspect', operationKey: 'f'.repeat(64), authorize() {}, core() {}, barrier() {}, graph: portableTemplateGraph, trackApply() {} }
  const listing = await executeCreatorMarketplace({ ...common, input: {} })
  assert.equal(listing.packages.find((item) => item.id === saved.packageId).components[0].data, undefined)
  const detailed = await executeCreatorMarketplace({ ...common, input: { packageId: saved.packageId, componentId: 'three-views', componentType: 'template' } })
  assert.equal(detailed.packages[0].components[0].data.nodes.length, 6)
  assert.equal(detailed.schema.maxNodes, 20)
})

test('Agent-authored and manually authored node definitions share validation and create equivalent editable instances', async (t) => {
  const { service, project, store } = await fixture(t)
  const directory = project.directory, projectId = project.project.projectId, canvasId = project.project.canvasId
  const data = { schemaVersion: 1, baseType: 'image', promptTemplate: '商品 {{product}}，背景 {{background}}', fields: [
    { id: 'product', label: '商品', kind: 'text', default: '手表' },
    { id: 'background', label: '背景', kind: 'enum', default: '白色', options: ['白色', '黑色'] },
  ] }
  const manual = await service.saveNodeDefinition(directory, { name: '商品棚拍图', data })
  assert.equal(manual.installed, false)
  const nodeDraft = { name: 'Agent 商品棚拍图', description: '', components: [{ id: 'node', type: 'node_definition', name: '商品棚拍图', description: '', data }] }
  const digest = service.validateCreatorDraft(nodeDraft, true).draftDigest
  const saved = await service.saveProjectDraft(directory, nodeDraft, { draftDigest: digest, operationKey: 'node-save' })
  await service.installCreator(directory, saved.packageId, saved.digest, ['node'], () => {})
  await service.setEnabledCreator(directory, saved.packageId, saved.digest, 'node', true, () => {})
  const core = (method, payload) => {
    if (method === 'canvas:load') return store.loadCanvas(payload.projectId, payload.canvasId)
    if (method === 'canvas:create-node') return store.createNode(payload)
    if (method === 'agent:lookup-operation') return store.lookupAgentOperation(payload)
    throw new Error('unexpected core command')
  }
  const applied = await executeCreatorMarketplace({ service, directory, projectId, canvasId, action: 'apply', operationKey: '1'.repeat(64),
    input: { packageId: saved.packageId, componentId: 'node', digest: saved.digest, expectedVersion: 0, values: { product: '相机' } },
    authorize() {}, core, graph: portableTemplateGraph, trackApply() {}, barrier: async (request, operation) => operation(request.expectedVersion) })
  assert.equal(applied.nodeCount, 1)
  const canvas = await store.loadCanvas(projectId, canvasId)
  const instance = canvas.nodes[0].data.node.params.nodeDefinition
  assert.equal(instance.values.product, '相机')
  assert.deepEqual(instance.snapshot.data, data)
  assert.equal(canvas.nodes[0].type, 'image')
})

test('creator install checks Skill collisions locally without re-entering the active Worker', async (t) => {
  const { project, userdata } = await fixture(t)
  const { assertMarketplaceSkillCollisions } = require('../src/marketplace-skill-collisions.cjs')
  const service = createMarketplaceService(userdata, { checkSkills: assertMarketplaceSkillCollisions })
  const digest = service.validateCreatorDraft(draft, true).draftDigest
  const saved = await service.saveProjectDraft(project.directory, draft, { draftDigest: digest, operationKey: 'local-check' })
  const timer = new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('WORKER_REENTRY_DEADLOCK')), 1000); timeout.unref() })
  const installed = await Promise.race([service.installCreator(project.directory, saved.packageId, saved.digest, ['three-views'], () => {}), timer])
  assert.equal(installed.installed, true)
})

test('pre-dispatch version conflict is recorded as failed rather than uncertain', async (t) => {
  const { service, project, store } = await fixture(t)
  const directory = project.directory, projectId = project.project.projectId, canvasId = project.project.canvasId
  const digest = service.validateCreatorDraft(draft, true).draftDigest
  const saved = await service.saveProjectDraft(directory, draft, { draftDigest: digest, operationKey: 'fail-save' })
  await service.installCreator(directory, saved.packageId, saved.digest, ['three-views'], () => {})
  await service.setEnabledCreator(directory, saved.packageId, saved.digest, 'three-views', true, () => {})
  const core = (method, input) => method === 'agent:lookup-operation' ? store.lookupAgentOperation(input) : store.loadCanvas(projectId, canvasId)
  const key = '2'.repeat(64)
  await assert.rejects(executeCreatorMarketplace({ service, directory, projectId, canvasId, action: 'apply', operationKey: key,
    input: { packageId: saved.packageId, componentId: 'three-views', digest: saved.digest, expectedVersion: 9 },
    authorize() {}, core, graph: portableTemplateGraph, trackApply() {}, barrier: async () => { throw new Error('CANVAS_VERSION_CONFLICT') } }), /CANVAS_VERSION_CONFLICT/)
  const record = (await service.getCreatorOperations(directory, key))[0]
  assert.equal(record.status, 'failed'); assert.equal(record.errorCode, 'CANVAS_VERSION_CONFLICT')
  assert.equal((await store.loadCanvas(projectId, canvasId)).nodes.length, 0)
})
