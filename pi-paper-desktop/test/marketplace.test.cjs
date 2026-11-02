const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { validatePackage, listMarketplaceSkills, readState } = require('../src/marketplace-storage.cjs')
const { listProjectAgentSkills } = require('../src/project-agent-skills.cjs')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { snapshotDesktopAgentSkill } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/skill-context.ts')
const builtin = require('../src/marketplace-example.cjs')
const { registerMarketplaceIpc } = require('../src/marketplace-ipc.cjs')

const copy = (value) => JSON.parse(JSON.stringify(value))
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-test-')))
  const dirs = Object.fromEntries(['projects', 'userdata', 'backups', 'restores'].map((key) => [key, path.join(root, key)]))
  await Promise.all(Object.values(dirs).map((directory) => fs.mkdir(directory)))
  const store = createLocalProjectStore()
  const project = await store.createProject(dirs.projects, '市场项目')
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, dirs, store, project, service: createMarketplaceService(dirs.userdata) }
}
function custom(version = '1.0.0') {
  const manifest = copy(builtin)
  manifest.id = 'local-product-test'
  manifest.version = version
  manifest.name = '可升级商品工作流'
  return manifest
}

test('builtin three-scenario pack installs selected components and exposes project skills', async (t) => {
  const { service, project, store, root } = await fixture(t)
  const directory = project.directory
  assert.equal((await service.list()).find((item) => item.id === builtin.id).installed, false)
  const template = builtin.components.find((component) => component.type === 'template').data
  assert.equal(template.nodes.filter((node) => node.id.startsWith('result-')).length, 3)
  for (const result of template.nodes.filter((node) => node.id.startsWith('result-'))) {
    const incoming = template.edges.filter((edge) => edge.target === result.id)
    assert.equal(incoming.length, 2)
    assert.equal(incoming.filter((edge) => edge.source === 'product').length, 1)
    assert.equal(incoming.filter((edge) => edge.source === result.id.replace('result-', 'brief-')).length, 1)
  }
  let item = await service.install(directory, builtin.id, ['product-workflow', 'product-shooting', 'neutral-background'])
  assert.equal(item.installed, true)
  assert.equal(item.components.find((c) => c.id === 'studio-prompt').installed, false)
  const skill = (await listProjectAgentSkills(directory)).find((candidate) => candidate.name === '商品棚拍策划')
  assert.ok(skill?.enabled)
  assert.match(snapshotDesktopAgentSkill(skill).instructions, /商品参考/)
  item = await service.setEnabled(directory, builtin.id, 'product-shooting', false)
  assert.equal(item.components.find((c) => c.id === 'product-shooting').enabled, false)
  assert.equal((await listMarketplaceSkills(directory))[0].enabled, false)
  await service.setEnabled(directory, builtin.id, 'product-shooting', true)
  const asset = await service.getInstalledComponent(directory, builtin.id, 'neutral-background', 'asset')
  const source = path.join(root, 'studio.png')
  await fs.writeFile(source, Buffer.from(asset.data.base64, 'base64'))
  const imported = await store.importAsset(source, project.project.projectId, 'image')
  assert.ok(imported.assetId)
  await service.setEnabled(directory, builtin.id, 'neutral-background', false)
  await assert.rejects(service.getInstalledComponent(directory, builtin.id, 'neutral-background', 'asset'), /MARKETPLACE_COMPONENT_NOT_AVAILABLE/)
})

test('studio image component can be used without installing the workflow or Skill', async (t) => {
  const { service, project, store } = await fixture(t)
  const pack = await service.install(project.directory, builtin.id, ['studio-image'])
  assert.deepEqual(pack.components.filter((part) => part.enabled).map((part) => part.id), ['studio-image'])
  const component = await service.getInstalledComponent(project.directory, builtin.id, 'studio-image', 'node_definition')
  assert.equal(component.data.baseType, 'image')
  assert.deepEqual(component.data.fields.map((field) => field.id), ['feature', 'backdrop', 'lighting'])
  assert.deepEqual(await listMarketplaceSkills(project.directory), [])
  const canvas = store.loadCanvas(project.project.projectId, project.project.canvasId)
  assert.equal(canvas.nodes.length, 0)
})

test('updates retain installed snapshots and states, rollback swaps versions, other projects stay isolated', async (t) => {
  const { service, project, dirs, store } = await fixture(t)
  const directory = project.directory
  const v1 = custom()
  await service.importPackage(v1)
  await service.install(directory, v1.id, ['product-workflow', 'product-shooting'])
  await service.setEnabled(directory, v1.id, 'product-shooting', false)
  const other = await store.createProject(dirs.projects, '第二项目')
  assert.equal((await service.list(other.directory)).find((item) => item.id === v1.id).installed, false)
  const v2 = custom('2.0.0')
  v2.components.find((item) => item.type === 'skill').data.instructions = '新版 Skill 指令'
  await service.importPackage(v2)
  let item = (await service.list(directory)).find((value) => value.id === v1.id)
  assert.equal(item.installedVersion, '1.0.0')
  assert.equal(item.updateAvailable, true)
  assert.equal(item.components.find((value) => value.type === 'skill').data.instructions, v1.components.find((value) => value.type === 'skill').data.instructions)
  assert.equal((await service.exportPackage(directory, v1.id)).version, '1.0.0')
  item = await service.install(directory, v1.id, [])
  assert.equal(item.installedVersion, '2.0.0')
  assert.equal(item.rollbackVersion, '1.0.0')
  assert.equal(item.components.find((value) => value.type === 'skill').enabled, false)
  await service.setEnabled(directory, v1.id, 'product-shooting', true)
  item = await service.rollback(directory, v1.id)
  assert.equal(item.installedVersion, '1.0.0')
  assert.equal(item.rollbackVersion, '2.0.0')
  assert.equal(item.components.find((value) => value.type === 'skill').enabled, true)
  item = await service.rollback(directory, v1.id)
  assert.equal(item.installedVersion, '2.0.0')
  const changed = custom('3.0.0')
  changed.components = changed.components.filter((component) => component.id !== 'product-shooting')
  await service.importPackage(changed)
  assert.equal((await service.list(directory)).find((value) => value.id === v1.id).components.find((c) => c.id === 'product-shooting').updateConflict, 'removed')
  await assert.rejects(service.install(directory, v1.id, []), /MARKETPLACE_UPDATE_COMPONENT_REMOVED/)
  await service.uninstall(directory, v1.id, 'product-shooting')
  item = await service.rollback(directory, v1.id)
  assert.notEqual(item.components.find((value) => value.id === 'product-shooting')?.installed, true)
  item = await service.install(directory, v1.id, [])
  assert.equal(item.installedVersion, '3.0.0')
  await service.uninstall(directory, v1.id, 'product-workflow')
  assert.equal((await readState(directory)).packages.length, 0)
})

test('import rejects executable or unsafe packages and permits idempotent builtin export', async (t) => {
  const { service, project } = await fixture(t)
  const builtinExport = await service.exportPackage(project.directory, builtin.id)
  assert.equal((await service.importPackage(builtinExport)).id, builtin.id)
  const changedBuiltin = copy(builtinExport); changedBuiltin.description = 'tampered'
  await assert.rejects(service.importPackage(changedBuiltin), /MARKETPLACE_BUILTIN_COLLISION/)
  const executable = custom(); executable.components[0].script = 'require("child_process")'
  await assert.rejects(service.importPackage(executable), /MARKETPLACE_PACKAGE_INVALID/)
  const unsafe = custom(); unsafe.components[0].data.nodes[0].params.apiKey = 'secret'
  await assert.rejects(service.importPackage(unsafe), /MARKETPLACE_PACKAGE_INVALID/)
  const remote = custom(); remote.components[0].data.nodes[0].params.prompt = 'https://example.com/foo'
  await assert.rejects(service.importPackage(remote), /MARKETPLACE_PACKAGE_INVALID/)
  const cycle = custom(); cycle.components[0].data.edges.push({ source: 'result-clean', target: 'product' })
  await assert.rejects(service.importPackage(cycle), /MARKETPLACE_PACKAGE_INVALID/)
  const badImage = custom(); const image = Buffer.from(badImage.components[1].data.base64, 'base64'); image.writeUInt32BE(100_000, 16); badImage.components[1].data.base64 = image.toString('base64')
  await assert.rejects(service.importPackage(badImage), /MARKETPLACE_PACKAGE_INVALID/)
  const personal = await service.saveTemplate(project.directory, { name: '个人模板', data: builtin.components[0].data })
  const exported = await service.exportPackage(project.directory, personal.id)
  assert.equal(validatePackage(exported).name, '个人模板')
  assert.equal((await service.importPackage(exported)).id, personal.id)
  const collision = copy(exported); collision.components[0].name = '修改后的组件'
  await assert.rejects(service.importPackage(collision), /MARKETPLACE_VERSION_COLLISION/)
})

test('project backup and restore carries installed package and Skill without global catalog', async (t) => {
  const { service, project, dirs, store } = await fixture(t)
  const v1 = custom()
  await service.importPackage(v1)
  await service.install(project.directory, v1.id, ['product-shooting', 'product-workflow'])
  const backup = await store.backupProject(dirs.backups, project.project.projectId)
  const restored = await store.restoreBackup(backup.directory, dirs.restores)
  const cleanUserData = path.join(dirs.userdata, 'fresh')
  await fs.mkdir(cleanUserData)
  const offlineService = createMarketplaceService(cleanUserData)
  const recovered = (await offlineService.list(restored.directory)).find((item) => item.id === v1.id)
  assert.equal(recovered.installedVersion, v1.version)
  assert.equal(recovered.components.find((component) => component.id === 'product-shooting').enabled, true)
  assert.ok((await listProjectAgentSkills(restored.directory)).some((skill) => skill.name === '商品棚拍策划'))
})

test('IPC imports only an enabled bundled image to the authorized project', async (t) => {
  const { service, project, dirs, store } = await fixture(t)
  await service.install(project.directory, builtin.id, ['neutral-background'])
  const handlers = new Map()
  registerMarketplaceIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
    assertTrustedSender: (event) => { if (!event.trusted) throw new Error('UNTRUSTED') },
    withProject: async (id, action) => { if (id !== project.project.projectId) throw new Error('WRONG_PROJECT'); return action(project.directory) },
    dialog: {}, window: () => null, tempDirectory: () => dirs.userdata, userDataDirectory: dirs.userdata,
    importImage: (id, file) => store.importAsset(file, id, 'image'),
  })
  const handler = handlers.get('desktop:marketplace:import-asset')
  await assert.rejects(handler({ trusted: false }, project.project.projectId, builtin.id, 'neutral-background'), /UNTRUSTED/)
  await assert.rejects(handler({ trusted: true }, 'another-project', builtin.id, 'neutral-background'), /WRONG_PROJECT/)
  const asset = await handler({ trusted: true }, project.project.projectId, builtin.id, 'neutral-background')
  assert.ok(asset.assetId)
  assert.deepEqual((await fs.readdir(dirs.userdata)).filter((name) => name.startsWith('vibepaper-market-')), [])
})

test('preset defaults are versioned and independent of project overrides and package exports', async (t) => {
  const { service, project, store, dirs } = await fixture(t)
  const local = custom()
  await service.importPackage(local)
  const second = await store.createProject(dirs.projects, '其他项目')
  for (const item of [project, second]) await service.install(item.directory, local.id, ['studio-prompt'])
  const preset = async (directory) => (await service.list(directory)).find(item => item.id === local.id).components.find(item => item.id === 'studio-prompt')
  const write = (directory, scope, params, version = local.version) => service.savePresetPreferences(directory, scope, local.id, 'studio-prompt', version, params)
  await write(undefined, 'personal', { prompt: '柔和布光', ratio: '1:1' })
  await write(project.directory, 'project', { prompt: '夜景' })
  assert.deepEqual((await preset(project.directory)).data.params, { prompt: '夜景', ratio: '1:1' })
  assert.equal((await preset(second.directory)).data.params.prompt, '柔和布光')
  assert.deepEqual((await service.exportPackage(project.directory, local.id)), local)
  await assert.rejects(write(project.directory, 'project', { count: 999 }), /INVALID/)
  await assert.rejects(write(project.directory, 'project', { apiKey: 'invalid-fixture' }), /INVALID/)
  await assert.rejects(write(project.directory, 'project', { prompt: 'stale' }, '0.1.0'), /INVALID/)
  await write(project.directory, 'project', {})
  assert.equal((await preset(project.directory)).data.params.prompt, '柔和布光')
  await service.importPackage(custom('2.0.0'))
  await service.install(project.directory, local.id, [])
  assert.equal((await preset(project.directory)).data.params.prompt, local.components.find(c => c.id === 'studio-prompt').data.params.prompt)
  await service.rollback(project.directory, local.id)
  assert.equal((await preset(project.directory)).data.params.prompt, '柔和布光')
})
