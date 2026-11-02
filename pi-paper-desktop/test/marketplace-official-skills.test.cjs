const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { build } = require('esbuild')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { createLocalProjectStore } = require('../src/project-store.cjs')
const { readState, writeState } = require('../src/marketplace-storage.cjs')
const { createProjectAgentSkill, getOfficialSkillDefinitions, listAgentSkillsWithOfficialState, updateProjectAgentSkill } = require('../src/project-agent-skills.cjs')
const { createDesktopAgentSkillContext, listDesktopAgentSkills, listDesktopAgentSessionSkills, snapshotDesktopAgentSkill } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/skill-context.ts')
const { createLoadSkillTool } = require('../../pi-main/packages/vibepaper-agent-service/src/tools/skill-tools.ts')

const officialId = '@vibepaper/official-skills'

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'official-skills-')))
  const projects = path.join(root, 'projects')
  const userdata = path.join(root, 'userdata')
  const backups = path.join(root, 'backups')
  const restores = path.join(root, 'restores')
  await Promise.all([projects, userdata, backups, restores].map((directory) => fs.mkdir(directory)))
  const store = createLocalProjectStore()
  const project = await store.createProject(projects, 'Skill 项目')
  await fs.mkdir(path.join(project.directory, '.vibepaper', 'agent'), { recursive: true })
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, projects, userdata, backups, restores, store, project, market: createMarketplaceService(userdata) }
}

test('official registry preserves 23 keys, isolates project state and retains it in backups', async (t) => {
  const { market, project, store, projects, backups, restores } = await fixture(t)
  const second = await store.createProject(projects, '其他项目')
  const definitions = getOfficialSkillDefinitions()
  const catalog = (await market.list(project.directory)).find((item) => item.id === officialId)
  assert.equal(catalog.components.length, 23)
  assert.deepEqual(new Set(catalog.components.map((item) => item.id)), new Set(definitions.map((skill) => skill.key)))
  assert.equal(catalog.components.filter((item) => item.systemRequired).length, 2)
  assert.ok(catalog.components.every((item) => item.enabled))
  assert.equal((await readState(project.directory)).disabledOfficialSkillIds, undefined)
  await assert.rejects(market.setEnabled(project.directory, officialId, 'canvas-cookbook', false), /MARKETPLACE_SYSTEM_REQUIRED/)
  await market.setEnabled(project.directory, officialId, 'product-visual', false)
  assert.equal((await market.list(project.directory)).find((item) => item.id === officialId).components.find((item) => item.id === 'product-visual').enabled, false)
  assert.equal((await market.list(second.directory)).find((item) => item.id === officialId).components.find((item) => item.id === 'product-visual').enabled, true)
  const state = await readState(project.directory)
  state.disabledOfficialSkillIds.push('canvas-cookbook')
  await writeState(project.directory, state)
  assert.equal((await listDesktopAgentSkills(undefined, await listAgentSkillsWithOfficialState(project.directory))).find((item) => item.id === 'canvas-cookbook').enabled, true)
  await store.openProject(project.directory)
  const backup = await store.backupProject(backups, project.project.projectId)
  const restored = await store.restoreBackup(backup.directory, restores)
  assert.equal((await market.list(restored.directory)).find((item) => item.id === officialId).components.find((item) => item.id === 'product-visual').enabled, false)
  await market.setEnabled(project.directory, officialId, 'product-visual', true)
  assert.equal((await readState(project.directory)).disabledOfficialSkillIds.includes('product-visual'), false)
})

test('disabled Skills cannot be reloaded from old snapshots or a previously built tool', async (t) => {
  const { market, project } = await fixture(t)
  const directory = project.directory
  const original = await listAgentSkillsWithOfficialState(directory)
  const skill = listDesktopAgentSkills(undefined, original).find((item) => item.id === 'product-visual')
  const snapshots = [snapshotDesktopAgentSkill(skill)]
  const loaded = []
  const control = {
    getSessionSkillSnapshots: () => snapshots,
    getLoadedSkillIds: () => loaded,
    markSkillLoaded: (_session, id) => { if (!loaded.includes(id)) loaded.push(id) },
  }
  const before = createDesktopAgentSkillContext(control, 'old-session', undefined, original)
  const [oldTool] = createLoadSkillTool(before.skills, before.loadedSkillIds, before.onLoad, before.validateSkill)
  await oldTool.execute('first', { skill: 'product-visual' })
  await market.setEnabled(directory, officialId, 'product-visual', false)
  await assert.rejects(oldTool.execute('again', { skill: 'product-visual' }), /SKILL_NOT_FOUND/)
  const updated = await listAgentSkillsWithOfficialState(directory)
  const after = createDesktopAgentSkillContext(control, 'old-session', undefined, updated)
  assert.ok(!after.indexLines.some((line) => line.includes('product-visual')))
  assert.ok(!after.skills.some((item) => item.id === 'product-visual'))
  assert.ok(!after.loadedSkillIds.includes('product-visual'))
  assert.ok(after.unavailableSkillIds.includes('product-visual'))
  assert.throws(() => createDesktopAgentSkillContext(control, 'old-session', 'product-visual', updated), /SKILL_NOT_FOUND/)
  const historical = listDesktopAgentSessionSkills(control, 'old-session', undefined, updated)
  assert.equal(historical.items.find((item) => item.id === 'product-visual').enabled, false)
  assert.equal(historical.items.find((item) => item.id === 'product-visual').instructions, skill.instructions)
  assert.ok(historical.loadedSkillIds.includes('product-visual'))
})

test('project Skill files appear in the market without replacing their editor', async (t) => {
  const { market, project } = await fixture(t)
  const created = await createProjectAgentSkill(project.directory, { name: '拍摄备忘', description: '镜头检查', instructions: '检查机位。', category: 'video' })
  const catalog = (await market.list(project.directory)).find((item) => item.projectSkillCatalog)
  assert.equal(catalog.components.find((item) => item.id === created.id).data.instructions, '检查机位。')
  await assert.rejects(market.setEnabled(project.directory, catalog.id, created.id, false), /MARKETPLACE_PROJECT_SKILL_MANAGED_IN_PANEL/)
})

test('legacy project filename colliding with an official key keeps a distinct editable identity and snapshot', async (t) => {
  const { market, project } = await fixture(t)
  const root = path.join(project.directory, '.vibepaper', 'agent', 'skills')
  await fs.mkdir(root)
  const file = path.join(root, 'story-bible.md')
  await fs.writeFile(file, '---\nname: story-bible\ndescription: old project notes\n---\n\n旧项目正文。\n')
  const entries = await listAgentSkillsWithOfficialState(project.directory)
  const projectSkill = entries.find((item) => item.source === 'project' && item.legacyId === 'story-bible')
  assert.match(projectSkill.id, /^project-legacy-[a-f0-9]{24}$/u)
  const listed = listDesktopAgentSkills(undefined, entries)
  assert.equal(listed.filter((item) => item.id === 'story-bible').length, 1)
  assert.ok(listed.some((item) => item.id === projectSkill.id))
  const snapshot = snapshotDesktopAgentSkill({ ...projectSkill, id: 'story-bible', key: 'story-bible' })
  const control = { getSessionSkillSnapshots: () => [snapshot], getLoadedSkillIds: () => ['story-bible'], markSkillLoaded() {} }
  let context = createDesktopAgentSkillContext(control, 'legacy', undefined, entries)
  assert.match(context.skills.find((item) => item.id === projectSkill.id).instructions, /旧项目正文/)
  assert.notEqual(context.skills.find((item) => item.id === 'story-bible').instructions, snapshot.instructions)
  assert.ok(listDesktopAgentSessionSkills(control, 'legacy', undefined, entries).loadedSkillIds.includes(projectSkill.id))
  await market.setEnabled(project.directory, officialId, 'story-bible', false)
  context = createDesktopAgentSkillContext(control, 'legacy', undefined, await listAgentSkillsWithOfficialState(project.directory))
  assert.ok(!context.skills.some((item) => item.id === 'story-bible'))
  assert.ok(context.skills.some((item) => item.id === projectSkill.id))
  const updated = await updateProjectAgentSkill(project.directory, projectSkill.id, { instructions: '用户修改后的项目正文。' })
  assert.match(updated.instructions, /用户修改后/)
  assert.match(await fs.readFile(file, 'utf8'), /用户修改后/)
  assert.equal((await fs.readdir(root)).some((name) => name === `${projectSkill.id}.md`), false)
})

test('standalone copied market uses bundled generated registry without the source tree', async (t) => {
  const { root, userdata } = await fixture(t)
  const source = path.resolve(__dirname, '../src')
  const staging = path.join(root, 'standalone')
  await fs.mkdir(staging)
  for (const file of await fs.readdir(source)) {
    if (file.endsWith('.cjs') && file !== 'project-agent-skills.cjs') await fs.copyFile(path.join(source, file), path.join(staging, file))
  }
  await build({ entryPoints: [path.join(source, 'project-agent-skills.cjs')], outfile: path.join(staging, 'project-agent-skills.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22.19', external: ['node:*'], legalComments: 'none' })
  const staged = require(path.join(staging, 'marketplace.cjs')).createMarketplaceService(userdata)
  const catalog = (await staged.list()).find((item) => item.id === officialId)
  assert.deepEqual(new Set(catalog.components.map((item) => item.id)), new Set(getOfficialSkillDefinitions().map((item) => item.key)))
})
