const test = require('node:test')
const assert = require('node:assert/strict')
const { validatePackage } = require('../src/marketplace-storage.cjs')
const builtin = require('../src/marketplace-creative-example.cjs')
const copy = () => structuredClone(builtin)
const comp = (manifest, type) => manifest.components.find((item) => item.type === type)

test('built-in creative data passes the same package boundary as local imports', () => {
  assert.equal(validatePackage(copy()).components.length, 7)
  const invalid = [
    (manifest) => { comp(manifest, 'director_scene').data.objects[0].id = '/tmp/secret' },
    (manifest) => { comp(manifest, 'director_scene').data.objects[0].kind = '站立' },
    (manifest) => { comp(manifest, 'director_motion').data.to.distance = Infinity },
    (manifest) => { comp(manifest, 'poster_layout').data.image.x = -1 },
    (manifest) => { comp(manifest, 'poster_layout').data.title.text = 'file:///tmp/x' },
    (manifest) => { comp(manifest, 'selection_command').data.command = 'exec' },
    (manifest) => { comp(manifest, 'storyboard').data.fields.push('title') },
    (manifest) => { comp(manifest, 'media_tool').data.tool = 'shell' },
  ]
  for (const mutate of invalid) {
    const manifest = copy(); mutate(manifest)
    assert.throws(() => validatePackage(manifest), /MARKETPLACE_PACKAGE_INVALID/)
  }
})

test('creative node data, local image assets, ordinary text and edges survive a project reopen without tasks', async (t) => {
  const fs = require('node:fs/promises')
  const os = require('node:os')
  const path = require('node:path')
  const { createLocalProjectStore } = require('../src/project-store.cjs')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-creative-'))
  const store = createLocalProjectStore()
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  const { project, directory } = await store.createProject(root, 'Creative')
  const imagePath = path.join(root, 'source.png')
  await fs.writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
  const sourceAsset = await store.importAsset(imagePath, project.projectId)
  const posterAsset = await store.importAsset(imagePath, project.projectId)
  const layout = comp(copy(), 'poster_layout').data
  const motion = comp(copy(), 'director_motion').data
  const node = (id, type, params) => ({ id, type, position: { x: 0, y: 0 }, data: { params } })
  const nodes = [
    node('source', 'image', { assetId: sourceAsset.assetId, url: `vibe://app/assets/${sourceAsset.assetId}`, posterLayout: layout }),
    node('poster', 'image', { assetId: posterAsset.assetId, url: `vibe://app/assets/${posterAsset.assetId}` }),
    node('stage', 'director', { sceneObjects: [], camera: motion.from, motion }),
    node('source-text', 'text', { content: '原文' }),
    node('tool-result', 'text', { content: '工具结果' }),
  ]
  const edges = [{ id: 'poster-edge', source: 'source', target: 'poster' }, { id: 'text-edge', source: 'source-text', target: 'tool-result' }]
  await store.saveCanvas({ projectId: project.projectId, canvasId: project.canvasId, expectedVersion: 0, nodes, edges, groups: [], stacks: [] })
  await store.close()
  await store.openProject(directory)
  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.deepEqual(loaded.nodes.find((node) => node.id === 'source').data.params.posterLayout, layout)
  assert.deepEqual(loaded.nodes.find((node) => node.id === 'stage').data.params.motion, motion)
  assert.equal(loaded.nodes.find((node) => node.id === 'tool-result').data.params.content, '工具结果')
  assert.deepEqual(loaded.edges.map((edge) => [edge.source, edge.target, edge.data.valid]), [['source', 'poster', true], ['source-text', 'tool-result', true]])
  assert.equal((await store.listTasks(project.projectId)).length, 0)
})
