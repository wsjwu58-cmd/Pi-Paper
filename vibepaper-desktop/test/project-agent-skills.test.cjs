const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { afterEach, test } = require('node:test')

const {
  createProjectAgentSkill,
  deleteProjectAgentSkill,
  importProjectAgentSkill,
  listProjectAgentSkills,
  updateProjectAgentSkill,
} = require('../src/project-agent-skills.cjs')
const { loadSkillsFromDir } = require('../../pi-main/packages/coding-agent/src/core/skill-loader.ts')

const temporaryDirectories = []

async function createProject() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-project-skills-'))
  temporaryDirectories.push(directory)
  await fs.mkdir(path.join(directory, '.vibepaper', 'agent'), { recursive: true })
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

test('creates editable project skills that the original Pi loader discovers only in that project', async () => {
  const projectA = await createProject()
  const projectB = await createProject()

  const created = await createProjectAgentSkill(projectA, {
    name: '镜头设计',
    description: '按镜头拆解画面',
    instructions: '# 镜头设计\n先明确主体和机位。',
    category: 'video',
  })

  assert.equal(created.source, 'project')
  assert.equal(created.name, '镜头设计')
  assert.equal(created.category, 'video')
  assert.equal(created.version, 1)
  assert.equal(created.enabled, true)
  assert.equal((await listProjectAgentSkills(projectB)).length, 0)

  const projectSkillsDirectory = path.join(projectA, '.vibepaper', 'agent', 'skills')
  const loaded = loadSkillsFromDir({ dir: projectSkillsDirectory, source: 'project' })
  assert.equal(loaded.skills.length, 1)
  assert.equal(loaded.skills[0].name, created.id)

  const document = await fs.readFile(path.join(projectSkillsDirectory, `${created.id}.md`), 'utf8')
  assert.match(document, /schemaVersion: 1/u)
  assert.match(document, /version: 1/u)
  assert.match(document, /先明确主体和机位/u)
})

test('imports Markdown, versions edits and toggles without exposing archived revisions as skills', async () => {
  const project = await createProject()
  const imported = await importProjectAgentSkill(
    project,
    'story-helper.md',
    '# Story helper\n\nList the character goal before drafting.',
  )
  assert.equal(imported.name, 'story-helper')
  assert.match(imported.instructions, /character goal/u)

  const updated = await updateProjectAgentSkill(project, imported.id, {
    name: '故事助手',
    description: '帮助整理故事目标',
    instructions: '先列出人物目标，再开始写作。',
    category: 'text',
    enabled: false,
  })
  assert.equal(updated.name, '故事助手')
  assert.equal(updated.version, 2)
  assert.equal(updated.enabled, false)
  assert.match(updated.instructions, /人物目标/u)

  const skillsDirectory = path.join(project, '.vibepaper', 'agent', 'skills')
  const history = await fs.readFile(path.join(skillsDirectory, '.versions', `${imported.id}-v1.md`), 'utf8')
  assert.match(history, /character goal/u)
  assert.deepEqual(loadSkillsFromDir({ dir: skillsDirectory, source: 'project' }).skills.map((skill) => skill.name), [imported.id])
})

test('archives deleted Skills within the same project and rejects duplicate reserved names', async () => {
  const project = await createProject()
  await assert.rejects(
    createProjectAgentSkill(project, { name: 'Canvas Cookbook', instructions: 'Do things.' }, ['Canvas Cookbook']),
    /SKILL_NAME_COLLISION/u,
  )

  const created = await createProjectAgentSkill(project, {
    name: 'Local Draft',
    description: 'A project only Skill',
    instructions: 'Write a useful draft.',
  })
  assert.deepEqual(await deleteProjectAgentSkill(project, created.id), { status: 'ok' })
  assert.deepEqual(await listProjectAgentSkills(project), [])

  const archived = await fs.readdir(path.join(project, '.vibepaper', 'agent', 'skills', '.deleted'))
  assert.equal(archived.length, 1)
  assert.match(await fs.readFile(path.join(project, '.vibepaper', 'agent', 'skills', '.deleted', archived[0]), 'utf8'), /Write a useful draft/u)
})

test('rejects skill directory symlinks before invoking the Pi loader', async () => {
  const project = await createProject()
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-skills-outside-'))
  temporaryDirectories.push(outside)
  const skillsDirectory = path.join(project, '.vibepaper', 'agent', 'skills')
  await fs.mkdir(skillsDirectory, { recursive: true })
  await fs.symlink(outside, path.join(skillsDirectory, 'external'), 'junction')

  await assert.rejects(listProjectAgentSkills(project), /SKILL_SYMLINK_UNSUPPORTED/u)
})
