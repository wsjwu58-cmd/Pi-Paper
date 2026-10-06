const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { exportNodeOutput } = require('../src/node-export.cjs')

const taskId = '00000000-0000-4000-8000-000000000001'
const assetId = '00000000-0000-4000-8000-000000000002'

async function fixture(t, type, source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-node-export-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const projectDirectory = path.join(directory, 'Project')
  const dataDirectory = path.join(projectDirectory, '.vibepaper')
  await fs.mkdir(dataDirectory, { recursive: true })
  const ext = { image: '.png', director: '.png', video: '.mp4', compose: '.mp4', audio: '.wav', text: '.txt' }[type]
  const original = path.join(dataDirectory, `result${ext}`)
  const bytes = Buffer.from(`existing-${type}-result`)
  await fs.writeFile(original, bytes)
  const node = { id: 'node-1', type, params: { content: '猫抓老鼠的剧本', url: `vibe://app/assets/${assetId}` } }
  const input = { projectId: 'project-1', canvasId: 'canvas-1', nodeId: node.id, nodeType: type, source, suggestedName: '作品' }
  const destination = path.join(directory, `download${ext}`)
  let active = true
  const dependencies = {
    assertActive: async () => { if (!active) throw new Error('PROJECT_CHANGED') },
    projectDirectory: () => projectDirectory,
    loadCanvas: async () => ({ nodes: [node] }),
    getTask: async () => ({ status: 'succeeded', nodeId: node.id, canvasId: input.canvasId }),
    resolveTask: async () => ({ filePath: original, mimeType: { '.png': 'image/png', '.mp4': 'video/mp4', '.wav': 'audio/wav' }[ext] }),
    resolveAsset: async () => ({ filePath: original, mimeType: 'image/png' }),
    showSaveDialog: async () => ({ canceled: false, filePath: destination }),
  }
  return { input, dependencies, destination, original, bytes, node, directory, setActive: (value) => { active = value } }
}

for (const type of ['image', 'audio', 'video', 'compose']) {
  test(`${type} task download saves existing bytes and leaves its project result intact`, async (t) => {
    const f = await fixture(t, type, { kind: 'task', taskId })
    assert.deepEqual(await exportNodeOutput(f.input, f.dependencies), { status: 'saved' })
    assert.deepEqual(await fs.readFile(f.destination), f.bytes)
    assert.deepEqual(await fs.readFile(f.original), f.bytes)
  })
}

test('text and director photo downloads save the current authority content', async (t) => {
  const text = await fixture(t, 'text', { kind: 'text', content: '猫抓老鼠的剧本' })
  await exportNodeOutput(text.input, text.dependencies)
  assert.equal(await fs.readFile(text.destination, 'utf8'), '猫抓老鼠的剧本')
  const director = await fixture(t, 'director', { kind: 'asset', assetId })
  await exportNodeOutput(director.input, director.dependencies)
  assert.deepEqual(await fs.readFile(director.destination), director.bytes)
})

test('fresh text task output is downloadable before node params synchronize, with scope and content checks', async (t) => {
  const f = await fixture(t, 'text', { kind: 'text', content: '刚生成的小猫故事' })
  f.node.currentOutputId = taskId
  const task = { taskId, canvasId: f.input.canvasId, nodeId: f.input.nodeId, modality: 'text', status: 'succeeded' }
  f.dependencies.listTasks = async () => [task]
  f.dependencies.readTextTask = async (_projectId, id) => {
    assert.equal(id, taskId)
    return '刚生成的小猫故事'
  }
  await exportNodeOutput(f.input, f.dependencies)
  assert.equal(await fs.readFile(f.destination, 'utf8'), '刚生成的小猫故事')
  await assert.rejects(exportNodeOutput({ ...f.input, source: { kind: 'text', content: '伪造的结果' } }, f.dependencies), /尚未保存/)
  f.dependencies.listTasks = async () => [{ ...task, canvasId: 'other-canvas' }]
  await assert.rejects(exportNodeOutput(f.input, f.dependencies), /尚未保存/)
})

test('cancel does not save a file; switching projects in the save dialog rejects the download', async (t) => {
  const f = await fixture(t, 'image', { kind: 'task', taskId })
  f.dependencies.showSaveDialog = async () => ({ canceled: true })
  assert.deepEqual(await exportNodeOutput(f.input, f.dependencies), { status: 'cancelled' })
  assert.equal(await fs.stat(f.destination).catch(() => null), null)
  f.dependencies.showSaveDialog = async () => { f.setActive(false); return { canceled: false, filePath: f.destination } }
  await assert.rejects(exportNodeOutput(f.input, f.dependencies), /PROJECT_CHANGED/)
  assert.equal(await fs.stat(f.destination).catch(() => null), null)
})

test('unrelated task/asset, changed text, and internal project destinations are rejected', async (t) => {
  const f = await fixture(t, 'image', { kind: 'task', taskId })
  f.dependencies.getTask = async () => ({ status: 'succeeded', nodeId: 'other-node', canvasId: 'canvas-1' })
  await assert.rejects(exportNodeOutput(f.input, f.dependencies), /不属于/)
  f.node.params.url = `vibe://app/tasks/${taskId}/output`
  await exportNodeOutput(f.input, f.dependencies) // Copies can reference an existing task.
  await assert.rejects(exportNodeOutput({ ...f.input, source: { kind: 'asset', assetId } }, f.dependencies), /不属于/)
  f.dependencies.showSaveDialog = async () => ({ canceled: false, filePath: f.original })
  await assert.rejects(exportNodeOutput(f.input, f.dependencies), /内部数据/)
  const text = await fixture(t, 'text', { kind: 'text', content: '尚未保存的新文字' })
  await assert.rejects(exportNodeOutput(text.input, text.dependencies), /尚未保存/)
})
