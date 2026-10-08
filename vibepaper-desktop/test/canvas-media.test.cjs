const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { saveCanvasImage, exportGroupOutputs, normalizeCanvasPng } = require('../src/canvas-media.cjs')

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const assetId = '00000000-0000-4000-8000-000000000002'
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-canvas-media-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const project = path.join(directory, 'Project')
  const source = path.join(project, '.vibepaper', 'assets', 'test.png')
  await fs.mkdir(path.dirname(source), { recursive: true })
  await fs.writeFile(source, png)
  const canvas = { nodes: [{ id: 'image', type: 'image', params: { name: 'Crop 1.png', url: `vibe://app/assets/${assetId}` } },
    { id: 'text', type: 'text', params: { content: '剧本' } }],
  groups: [{ id: 'group', name: '裁剪编组', nodeIds: ['image', 'text'] }] }
  let active = true
  const dependencies = {
    assertActive: async () => { if (!active) throw new Error('PROJECT_CHANGED') },
    loadCanvas: async () => canvas,
    tempDirectory: () => directory,
    projectDirectory: () => project,
    importImage: async (file) => { assert.deepEqual(await fs.readFile(file), png); return { assetId } },
    renameAsset: async (_p, id, name) => { assert.equal(id, assetId); assert.equal(name, 'Crop 1.png') },
    resolveAsset: async () => ({ filePath: source, mimeType: 'image/png' }),
    showDirectoryDialog: async () => ({ canceled: false, filePaths: [directory] }),
  }
  return { directory, source, canvas, dependencies, setActive: (v) => { active = v } }
}

test('crop PNG saves a named local asset and removes only its temporary file', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await saveCanvasImage({ projectId: 'project', canvasId: 'canvas', nodeId: 'image', pngBytes: png, name: 'Crop 1' }, f.dependencies),
    { assetId, url: `vibe://app/assets/${assetId}` })
  assert.deepEqual(await fs.readdir(f.directory), ['Project'])
})

test('crop rejects invalid data, oversize image dimensions and non-image/missing sources', async (t) => {
  const f = await fixture(t)
  const input = { projectId: 'project', canvasId: 'canvas', nodeId: 'text', pngBytes: png, name: 'Crop 1' }
  await assert.rejects(saveCanvasImage(input, f.dependencies), /源图片节点/)
  assert.throws(() => normalizeCanvasPng(Buffer.alloc(40)), /PNG/)
  const oversized = Buffer.from(png)
  oversized.writeUInt32BE(20000, 16)
  assert.throws(() => normalizeCanvasPng(oversized), /尺寸/)
  f.setActive(false)
  await assert.rejects(saveCanvasImage({ ...input, nodeId: 'image' }, f.dependencies), /PROJECT_CHANGED/)
})

test('group download exports actual member files once with no extension duplication and preserves originals', async (t) => {
  const f = await fixture(t)
  const result = await exportGroupOutputs({ projectId: 'project', canvasId: 'canvas', groupId: 'group' }, f.dependencies)
  assert.deepEqual(result, { status: 'saved', count: 2 })
  const folder = (await fs.readdir(f.directory)).find((name) => name.startsWith('裁剪编组-'))
  assert.ok(folder)
  const files = await fs.readdir(path.join(f.directory, folder))
  assert.deepEqual(files, ['01-Crop 1.png', '02-text.txt'])
  assert.deepEqual(await fs.readFile(path.join(f.directory, folder, files[0])), png)
  assert.equal(await fs.readFile(path.join(f.directory, folder, files[1]), 'utf8'), '剧本')
  assert.deepEqual(await fs.readFile(f.source), png)
})

test('group cancellation, changed membership and internal project destination cannot publish files', async (t) => {
  const f = await fixture(t)
  const input = { projectId: 'project', canvasId: 'canvas', groupId: 'group' }
  f.dependencies.showDirectoryDialog = async () => ({ canceled: true })
  assert.deepEqual(await exportGroupOutputs(input, f.dependencies), { status: 'cancelled' })
  f.dependencies.showDirectoryDialog = async () => { f.canvas.groups[0].nodeIds = ['text']; return { filePaths: [f.directory] } }
  await assert.rejects(exportGroupOutputs(input, f.dependencies), /内容已更改/)
  f.dependencies.showDirectoryDialog = async () => ({ filePaths: [path.dirname(f.source)] })
  await assert.rejects(exportGroupOutputs(input, f.dependencies), /内部数据/)
  assert.deepEqual(await fs.readdir(f.directory), ['Project'])
})

test('group exports React Flow nodes restored from a full canvas save', async (t) => {
  const f = await fixture(t)
  f.canvas.nodes = f.canvas.nodes.map((node) => ({
    id: node.id, type: node.type, position: { x: 12, y: 24 },
    data: { node: { ...node }, params: node.params, output: {} },
  }))
  const result = await exportGroupOutputs({ projectId: 'project', canvasId: 'canvas', groupId: 'group' }, f.dependencies)
  assert.deepEqual(result, { status: 'saved', count: 2 })
  const folder = (await fs.readdir(f.directory)).find((name) => name.startsWith('裁剪编组-'))
  assert.deepEqual(await fs.readFile(path.join(f.directory, folder, '01-Crop 1.png')), png)
  assert.equal(await fs.readFile(path.join(f.directory, folder, '02-text.txt'), 'utf8'), '剧本')
})

test('changing projects during group dialog fails without copying any media', async (t) => {
  const f = await fixture(t)
  f.dependencies.showDirectoryDialog = async () => { f.setActive(false); return { filePaths: [f.directory] } }
  await assert.rejects(exportGroupOutputs({ projectId: 'project', canvasId: 'canvas', groupId: 'group' }, f.dependencies), /PROJECT_CHANGED/)
  assert.deepEqual(await fs.readdir(f.directory), ['Project'])
})
