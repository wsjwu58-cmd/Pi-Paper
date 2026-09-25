const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const test = require('node:test')
const { createLocalProjectStore, validateGraph } = require('../src/project-store.cjs')

const EDGE_COMPATIBILITY = {
  text: new Set(['text', 'image', 'video', 'audio', 'director']),
  image: new Set(['image', 'video', 'director']),
  video: new Set(['video', 'compose']),
  audio: new Set(['audio', 'video']),
  compose: new Set(['video', 'compose']),
  director: new Set(['image', 'video']),
}

function node(id, type) {
  return { id, type, position: { x: 0, y: 0 }, data: {} }
}

async function openTestProject(t) {
  const parentDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-canvas-validation-'))
  const store = createLocalProjectStore()
  t.after(async () => {
    await store.close()
    await fs.rm(parentDirectory, { recursive: true, force: true })
  })

  const opened = await store.createProject(parentDirectory, 'Canvas Test')
  return { store, ...opened }
}

async function saveNodes(store, project, nodes) {
  await store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes,
    edges: [],
  })
}

test('project inspection verifies metadata and SQLite identity without changing the active project', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  assert.deepEqual((await store.inspectProject(directory)).project, project)
  assert.deepEqual(await store.inspectProject(directory, project), {
    project,
    directory: await fs.realpath(directory),
  })
  await assert.rejects(store.inspectProject(directory, {
    projectId: 'another-project',
    canvasId: project.canvasId,
  }), /最近项目身份已变化/u)

  const metadataPath = path.join(directory, '.vibepaper', 'project.json')
  const originalMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
  await fs.writeFile(metadataPath, JSON.stringify({ ...originalMetadata, projectId: 'catalog-tampered-id' }))
  await assert.rejects(store.inspectProject(directory, {
    projectId: 'catalog-tampered-id',
    canvasId: project.canvasId,
  }), /本地数据库与项目身份不匹配/u)
  await fs.writeFile(metadataPath, JSON.stringify(originalMetadata))

  const other = await store.createProject(path.dirname(directory), 'Another Project')
  const activeBefore = store.getActiveProject()
  await assert.rejects(store.openProject(directory, other.project), /最近项目身份已变化/u)
  assert.deepEqual(store.getActiveProject(), activeBefore)
})

test('canvas validation matches the legacy EdgeRules compatibility matrix', () => {
  const nodeTypes = Object.keys(EDGE_COMPATIBILITY)
  const nodes = nodeTypes.map((type) => node(`node-${type}`, type))
  const edges = []
  for (const sourceType of nodeTypes) {
    for (const targetType of nodeTypes) {
      edges.push({
        id: `edge-${sourceType}-${targetType}`,
        source: `node-${sourceType}`,
        target: `node-${targetType}`,
      })
    }
  }

  const graph = validateGraph(nodes, edges)
  for (const sourceType of nodeTypes) {
    for (const targetType of nodeTypes) {
      const edge = graph.edges.find((candidate) => candidate.id === `edge-${sourceType}-${targetType}`)
      const expectedValidity = EDGE_COMPATIBILITY[sourceType].has(targetType)
      assert.equal(edge.data.valid, expectedValidity, `${sourceType} -> ${targetType}`)
      assert.equal(edge.data.edge.valid, expectedValidity, `${sourceType} -> ${targetType} payload`)
      assert.equal(edge.data.edge.sourcePort, 'output')
      assert.equal(edge.data.edge.targetPort, 'input')
      assert.equal(edge.data.edge.dependencyType, 'reference')
    }
  }
})

test('canvas save drops dangling edges and reload retains incompatible edges as invalid', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  const nodes = [node('video-node', 'video'), node('text-node', 'text')]
  const edges = [
    { id: 'video-to-text', source: 'video-node', target: 'text-node' },
    { id: 'missing-source', source: 'missing-node', target: 'text-node' },
    { id: 'missing-target', source: 'video-node', target: 'missing-node' },
  ]
  await store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes,
    edges,
  })
  await store.close()
  await store.openProject(directory)

  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.equal(loaded.edges.length, 1)
  assert.equal(loaded.edges[0].data.valid, false)
  assert.equal(loaded.edges[0].data.edge.valid, false)
  assert.equal(loaded.edges[0].data.edge.sourceNodeId, 'video-node')
  assert.equal(loaded.edges[0].data.edge.targetNodeId, 'text-node')
})

test('full canvas saves preserve prior generation output, media params and successful status', async (t) => {
  const { store, project } = await openTestProject(t)
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const generatedNode = {
    ...node('generated-image', 'image'),
    data: {
      params: {
        prompt: '保持原提示词',
        url: 'vibe://app/tasks/task-1/output',
        lastOutputUrl: 'vibe://app/tasks/task-1/output',
        thumbnailUrl: 'vibe://app/assets/asset-1',
        output_url: 'vibe://app/tasks/task-1/output',
        lastOutputText: '已完成的说明',
      },
      output: { url: 'vibe://app/tasks/task-1/output', taskId: 'task-1' },
      status: 'succeeded',
      execStatus: 'succeeded',
    },
  }
  await store.saveCanvas({ ...base, expectedVersion: 0, nodes: [generatedNode], edges: [] })

  const staleRendererNode = {
    ...node('generated-image', 'image'),
    data: {
      params: {
        prompt: '保持原提示词',
        url: '',
        lastOutputUrl: null,
        thumbnailUrl: '',
        output_url: null,
        lastOutputText: '',
      },
      output: null,
      status: 'idle',
      execStatus: 'idle',
    },
  }
  await store.saveCanvas({ ...base, expectedVersion: 1, nodes: [staleRendererNode], edges: [] })

  let saved = store.loadCanvas(project.projectId, project.canvasId).nodes[0]
  assert.deepEqual(saved.data.output, {
    url: 'vibe://app/tasks/task-1/output',
    taskId: 'task-1',
  })
  assert.equal(saved.data.params.url, 'vibe://app/tasks/task-1/output')
  assert.equal(saved.data.params.lastOutputUrl, 'vibe://app/tasks/task-1/output')
  assert.equal(saved.data.params.thumbnailUrl, 'vibe://app/assets/asset-1')
  assert.equal(saved.data.params.output_url, 'vibe://app/tasks/task-1/output')
  assert.equal(saved.data.params.lastOutputText, '已完成的说明')
  assert.equal(saved.data.status, 'succeeded')
  assert.equal(saved.data.execStatus, 'succeeded')

  await store.saveCanvas({
    ...base,
    expectedVersion: 2,
    nodes: [{
      ...staleRendererNode,
      data: {
        ...staleRendererNode.data,
        params: { ...staleRendererNode.data.params, url: 'vibe://app/tasks/task-2/output' },
        output: { url: 'vibe://app/tasks/task-2/output', taskId: 'task-2' },
        status: 'queued',
        execStatus: 'queued',
      },
    }],
    edges: [],
  })
  saved = store.loadCanvas(project.projectId, project.canvasId).nodes[0]
  assert.equal(saved.data.output.taskId, 'task-2', 'explicit incoming output wins')
  assert.equal(saved.data.params.url, 'vibe://app/tasks/task-2/output', 'explicit incoming media URL wins')
  assert.equal(saved.data.status, 'queued', 'active generation states are not overwritten')
  assert.equal(saved.data.execStatus, 'queued')
})

test('canvas save rejects node types excluded by legacy EdgeRules', async (t) => {
  const { store, project } = await openTestProject(t)
  await assert.rejects(store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes: [node('unknown-node', 'unknown')],
    edges: [],
  }), /非法节点类型: unknown/u)

  assert.equal(store.loadCanvas(project.projectId, project.canvasId).version, 0)
})

test('saveCanvas supports durable optional idempotency replay before version and graph validation', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  const base = { projectId: project.projectId, canvasId: project.canvasId, idempotencyKey: 'save-command-1' }
  const saved = await store.saveCanvas({
    ...base,
    expectedVersion: 0,
    nodes: [node('saved-node', 'text')],
    edges: [],
  })
  assert.deepEqual(saved, { version: 1, replayed: false })

  await store.close()
  await store.openProject(directory)
  const replayed = await store.saveCanvas({
    ...base,
    expectedVersion: 0,
    nodes: [node('invalid-replay-node', 'unsupported')],
    edges: [],
  })
  assert.deepEqual(replayed, { version: 1, replayed: true })
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).nodes[0].id, 'saved-node')

  await assert.rejects(store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'save-command-1',
    expectedVersion: 1,
    type: 'text',
  }), /Idempotency-Key 已用于其他画布命令/u)
})

test('canvas validation rejects prototype property names as node types', () => {
  for (const type of ['toString', 'constructor', '__proto__']) {
    assert.throws(
      () => validateGraph([node('prototype-node', type)], []),
      new RegExp(`非法节点类型: ${type}`, 'u'),
    )
  }
})

test('exportCanvas emits legacy schema aliases, node/edge DTOs, groups, stacks and local asset references', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  const imagePath = path.join(directory, 'pixel.png')
  await fs.writeFile(imagePath, Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  ]))
  const asset = await store.importAsset(imagePath, project.projectId)
  const imageNode = node('export-image', 'image')
  imageNode.data = {
    assetId: asset.assetId,
    params: { assetId: asset.assetId, prompt: 'reference image' },
  }
  const nodes = [
    node('export-text', 'text'),
    imageNode,
    node('export-video', 'video'),
    node('export-audio', 'audio'),
    node('export-compose', 'compose'),
    node('export-director', 'director'),
  ]
  const missingAssetNode = node('missing-asset-image', 'image')
  missingAssetNode.data = { assetId: 'missing-asset', params: { assetId: 'missing-asset' } }
  await assert.rejects(store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes: [missingAssetNode],
    edges: [],
  }), /图片节点引用了不存在的本地素材/u)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).version, 0,
    'an invalid local asset reference rolls back the entire canvas save')

  await store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes,
    edges: [
      { id: 'export-compatible-edge', source: 'export-text', sourceHandle: 'source-port', target: 'export-image', targetHandle: 'target-port', dependencyType: 'input' },
      { id: 'export-invalid-edge', source: 'export-video', target: 'export-text', dependencyType: 'control' },
      { id: 'export-dangling-edge', source: 'export-text', target: 'missing-node' },
    ],
  })
  await assert.rejects(store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes: [],
    edges: [],
  }), /画布版本已变化/u)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).version, 1,
    'a stale canvas version cannot replace the saved graph')
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const group = await store.addGroup({ ...base, nodeIds: ['export-text', 'export-image'] })
  const stack = await store.addStack({ ...base, nodeIds: ['export-video', 'export-compose'] })

  await assert.rejects(store.exportCanvas(project.projectId, 'another-canvas'), /当前项目已更改/u)
  const document = await store.exportCanvas(project.projectId, project.canvasId)
  assert.equal(document.schema_version, '1.0.0')
  assert.equal(document.schemaVersion, '1.0.0')
  assert.equal(document.canvas.id, project.canvasId)
  assert.equal(document.canvas.name, 'Canvas Test')
  assert.equal(document.canvas.version, 1)
  assert.deepEqual(document.nodes.map((entry) => entry.type), ['text', 'image', 'video', 'audio', 'compose', 'director'])
  const exportedImage = document.nodes.find((entry) => entry.id === 'export-image')
  assert.equal(exportedImage.params.assetId, asset.assetId)
  assert.equal(exportedImage.groupId, group.id)
  assert.equal(exportedImage.stackId, null)
  assert.deepEqual(document.edges.map((entry) => entry.id), ['export-compatible-edge', 'export-invalid-edge'])
  assert.deepEqual(document.edges[0], {
    id: 'export-compatible-edge',
    sourceNodeId: 'export-text',
    sourcePort: 'source-port',
    targetNodeId: 'export-image',
    targetPort: 'target-port',
    valid: true,
    dependencyType: 'input',
  })
  assert.equal(document.edges[1].valid, false)
  assert.equal(document.edges[1].dependencyType, 'control')
  assert.deepEqual(document.groups, [group])
  assert.deepEqual(document.stacks, [stack])
})

test('connectEdge enforces identity, version, endpoints, self-connection and compatibility', async (t) => {
  const { store, project } = await openTestProject(t)
  await saveNodes(store, project, [node('text-node', 'text'), node('video-node', 'video')])

  const base = {
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 1,
    idempotencyKey: 'connect-invalid-command',
  }
  await assert.rejects(store.connectEdge({
    ...base,
    projectId: 'another-project',
    sourceNodeId: 'text-node',
    targetNodeId: 'video-node',
  }), /当前项目已更改/u)
  await assert.rejects(store.connectEdge({
    ...base,
    canvasId: 'another-canvas',
    sourceNodeId: 'text-node',
    targetNodeId: 'video-node',
  }), /当前项目已更改/u)
  await assert.rejects(store.connectEdge({
    ...base,
    expectedVersion: 0,
    sourceNodeId: 'text-node',
    targetNodeId: 'video-node',
  }), /画布已在其他会话更新/u)
  await assert.rejects(store.connectEdge({
    ...base,
    sourceNodeId: 'missing-node',
    targetNodeId: 'video-node',
  }), /节点不存在/u)
  await assert.rejects(store.connectEdge({
    ...base,
    sourceNodeId: 'text-node',
    targetNodeId: 'missing-node',
  }), /节点不存在/u)
  await assert.rejects(store.connectEdge({
    ...base,
    sourceNodeId: 'text-node',
    targetNodeId: 'text-node',
  }), /禁止自连接/u)
  await assert.rejects(store.connectEdge({
    ...base,
    sourceNodeId: 'video-node',
    targetNodeId: 'text-node',
  }), /连线不兼容/u)
  await assert.rejects(store.connectEdge({
    ...base,
    sourceNodeId: 'text-node',
    targetNodeId: 'video-node',
    dependencyType: 'unknown',
  }), /dependencyType 必须是/u)

  const unchanged = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(unchanged.version, 1)
  assert.equal(unchanged.edges.length, 0)
})

test('connectEdge saves a valid edge, advances the version and replays duplicate endpoints', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await saveNodes(store, project, [node('text-node', 'text'), node('video-node', 'video')])

  const connected = await store.connectEdge({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'connect-command-1',
    expectedVersion: 1,
    sourceNodeId: 'text-node',
    targetNodeId: 'video-node',
    sourcePort: 'output',
    targetPort: 'input',
    dependencyType: 'input',
  })
  assert.equal(connected.version, 2)
  assert.equal(connected.replayed, false)
  assert.equal(connected.edge.valid, true)
  assert.equal(connected.edge.sourceNodeId, 'text-node')
  assert.equal(connected.edge.targetNodeId, 'video-node')
  assert.equal(connected.edge.dependencyType, 'input')

  const replayed = await store.connectEdge({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'connect-command-2',
    expectedVersion: 1,
    sourceNodeId: 'text-node',
    targetNodeId: 'video-node',
    sourcePort: 'other-output',
  })
  assert.equal(replayed.version, 2)
  assert.equal(replayed.replayed, true)
  assert.deepEqual(replayed.edge, connected.edge)

  await store.close()
  await store.openProject(directory)
  const commandReplay = await store.connectEdge({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'connect-command-1',
    expectedVersion: 0,
    sourceNodeId: 'video-node',
    targetNodeId: 'text-node',
  })
  assert.equal(commandReplay.version, 2)
  assert.equal(commandReplay.replayed, true)
  assert.deepEqual(commandReplay.edge, connected.edge)

  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 2)
  assert.equal(loaded.edges.length, 1)
  assert.equal(loaded.edges[0].data.edge.id, connected.edge.id)
  assert.equal(loaded.edges[0].data.edge.sourcePort, 'output')
  assert.equal(loaded.edges[0].data.edge.targetPort, 'input')
})

test('connectEdge rejects an Idempotency-Key already owned by another graph command', async (t) => {
  const { store, project } = await openTestProject(t)
  await saveNodes(store, project, [node('text-node', 'text'), node('video-node', 'video')])
  await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'shared-create-key',
    expectedVersion: 1,
    type: 'text',
  })

  await assert.rejects(store.connectEdge({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'shared-create-key',
    expectedVersion: 2,
    sourceNodeId: 'text-node',
    targetNodeId: 'video-node',
  }), /Idempotency-Key 已用于其他画布命令/u)
  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 2)
  assert.equal(loaded.edges.length, 0)
})

test('connectEdge keeps the desktop IPC path working without an explicit command key', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await saveNodes(store, project, [node('ui-text-node', 'text'), node('ui-video-node', 'video')])

  const connected = await store.connectEdge({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 1,
    sourceNodeId: 'ui-text-node',
    targetNodeId: 'ui-video-node',
  })
  assert.equal(connected.version, 2)
  assert.equal(connected.replayed, false)

  const duplicate = await store.connectEdge({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    sourceNodeId: 'ui-text-node',
    targetNodeId: 'ui-video-node',
  })
  assert.equal(duplicate.version, 2)
  assert.equal(duplicate.replayed, true)
  assert.deepEqual(duplicate.edge, connected.edge)

  await store.close()
  await store.openProject(directory)
  const afterRestart = await store.connectEdge({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    sourceNodeId: 'ui-text-node',
    targetNodeId: 'ui-video-node',
  })
  assert.deepEqual(afterRestart.edge, connected.edge)
  assert.equal(afterRestart.version, 2)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).edges.length, 1)
})

test('deleteEdge matches the legacy no-version endpoint and persists only the edge removal', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  const nodes = [node('delete-edge-source', 'text'), node('delete-edge-target', 'video'), node('keep-edge-target', 'text')]
  await store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes,
    edges: [
      { id: 'edge-to-delete', source: nodes[0].id, target: nodes[1].id },
      { id: 'edge-to-keep', source: nodes[0].id, target: nodes[2].id },
    ],
  })
  const base = { projectId: project.projectId, canvasId: project.canvasId }

  await assert.rejects(store.deleteEdge({ ...base, projectId: 'another-project', edgeId: 'edge-to-delete' }), /当前项目已更改/u)
  await assert.rejects(store.deleteEdge({ ...base, canvasId: 'another-canvas', edgeId: 'edge-to-delete' }), /当前项目已更改/u)
  await assert.rejects(store.deleteEdge({ ...base, edgeId: 'missing-edge' }), /连线不存在/u)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).version, 1)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).edges.length, 2)

  assert.deepEqual(await store.deleteEdge({ ...base, edgeId: 'edge-to-delete' }), { status: 'ok' })
  const afterDelete = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(afterDelete.version, 1, 'legacy deleteEdge does not advance the canvas version')
  assert.deepEqual(afterDelete.edges.map((edge) => edge.id), ['edge-to-keep'])
  assert.equal(afterDelete.nodes.length, 3)

  await store.close()
  await store.openProject(directory)
  const afterRestart = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(afterRestart.version, 1)
  assert.deepEqual(afterRestart.edges.map((edge) => edge.id), ['edge-to-keep'])
  assert.equal(afterRestart.nodes.length, 3)
})

test('createNode applies legacy defaults, normalizes params and persists image prompt nodes', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  const created = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'create-image-1',
    expectedVersion: 0,
    type: 'image',
    x: null,
    y: 340,
    width: null,
    params: { title: 'A sunrise', model: 'legacy-model', quality: 'high' },
    modelRef: 'provider/image-model',
  })

  assert.equal(created.version, 1)
  assert.equal(created.replayed, false)
  assert.match(created.node.id, /^[0-9a-f-]{36}$/u)
  assert.equal(created.node.type, 'image')
  assert.deepEqual(created.node.position, { x: 120, y: 340 })
  assert.equal(created.node.width, 280)
  assert.equal(created.node.height, 220)
  assert.equal(created.node.data.label, 'A sunrise')
  assert.deepEqual(created.node.data.params, {
    title: 'A sunrise',
    model: 'provider/image-model',
    quality: 'high',
    prompt: 'A sunrise',
  })
  assert.equal(created.node.data.status, 'idle')
  assert.equal(created.node.data.execStatus, 'idle')
  assert.equal(created.node.data.stale, false)

  await store.close()
  await store.openProject(directory)
  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.equal(loaded.nodes.length, 1)
  assert.equal(loaded.nodes[0].id, created.node.id)
  assert.equal(loaded.nodes[0].data.label, 'A sunrise')
})

test('createNode performs version CAS, validates node types and replays by canvas idempotency key', async (t) => {
  const { store, project } = await openTestProject(t)
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const created = await store.createNode({
    ...base,
    idempotencyKey: 'node-command-1',
    expectedVersion: 0,
    type: 'text',
    params: { prompt: 'from params' },
    prompt: 'explicit prompt',
  })
  assert.equal(created.version, 1)
  assert.equal(created.node.data.label, 'explicit prompt')
  assert.equal(created.node.data.node.prompt, 'explicit prompt')
  assert.equal(created.node.data.params.prompt, 'explicit prompt')

  const replayed = await store.createNode({
    ...base,
    idempotencyKey: 'node-command-1',
    expectedVersion: 2147483647,
    type: 'unknown-but-replayed-before-validation',
  })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.version, 1)
  assert.deepEqual(replayed.node, created.node)

  await assert.rejects(store.createNode({
    ...base,
    idempotencyKey: 'node-command-2',
    expectedVersion: 0,
    type: 'text',
  }), /画布已在其他会话更新/u)
  await assert.rejects(store.createNode({
    ...base,
    idempotencyKey: 'node-command-3',
    expectedVersion: 1,
    type: 'unknown',
  }), /非法节点类型: unknown/u)
  await assert.rejects(store.createNode({
    ...base,
    idempotencyKey: 'node-command-4',
    expectedVersion: 1,
    type: 'toString',
  }), /非法节点类型: toString/u)
  await assert.rejects(store.createNode({
    ...base,
    idempotencyKey: ' ',
    expectedVersion: 1,
    type: 'text',
  }), /Idempotency-Key 必须为 1-128 个字符/u)
  await assert.rejects(store.createNode({
    ...base,
    idempotencyKey: 'node-command-5',
    expectedVersion: 1,
    type: 'text',
    params: [],
  }), /节点参数必须是对象/u)

  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.equal(loaded.nodes.length, 1)
  assert.equal(loaded.nodes[0].id, created.node.id)
})

test('createNode completes an empty command snapshot and rejects keys owned by another operation', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await store.close()

  const database = new DatabaseSync(path.join(directory, '.vibepaper', 'project.sqlite'))
  try {
    const insertCommand = database.prepare(`
      INSERT INTO canvas_graph_commands
        (canvas_id, idempotency_key, operation, result_snapshot, created_at)
      VALUES (?, ?, ?, '{}', ?)
    `)
    insertCommand.run(project.canvasId, 'unfinished-node-command', 'create_nodes', new Date().toISOString())
    insertCommand.run(project.canvasId, 'edge-command-key', 'connect_nodes', new Date().toISOString())
  } finally {
    database.close()
  }

  await store.openProject(directory)
  const created = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'unfinished-node-command',
    expectedVersion: null,
    type: 'text',
  })
  assert.equal(created.version, 1)
  assert.equal(created.replayed, false)
  const replayed = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'unfinished-node-command',
    expectedVersion: 0,
    type: 'unknown',
  })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.node.id, created.node.id)
  await assert.rejects(store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'edge-command-key',
    expectedVersion: 1,
    type: 'text',
  }), /Idempotency-Key 已用于其他画布命令/u)

  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.equal(loaded.nodes.length, 1)
})

test('updateNode applies legacy field, params, status and output synchronization semantics', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  const created = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'update-source-create',
    expectedVersion: 0,
    type: 'text',
    params: { prompt: 'initial', retained: 'before' },
    modelRef: 'model-before',
    prompt: 'initial',
  })
  const updated = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: created.node.id,
    idempotencyKey: 'update-source-config',
    expectedVersion: 1,
    x: 210,
    y: 320,
    width: 500,
    height: 260,
    params: { changed: true, url: null, lastOutputUrl: null },
    status: 'queued',
    currentOutputId: 'output-1',
    groupId: 'group-1',
    stackId: 'stack-1',
    creativeType: 'scene',
    stale: true,
    modelRef: 'model-after',
    prompt: 'updated prompt',
    output: { url: 'local-output://image-1' },
    execStatus: 'succeeded',
  })

  assert.equal(updated.version, 2)
  assert.equal(updated.replayed, false)
  assert.deepEqual(updated.node.position, { x: 210, y: 320 })
  assert.equal(updated.node.width, 500)
  assert.equal(updated.node.height, 260)
  assert.equal(updated.node.data.status, 'succeeded', 'execStatus overwrites status for recognized terminal states')
  assert.equal(updated.node.data.execStatus, 'succeeded')
  assert.equal(updated.node.data.currentOutputId, 'output-1')
  assert.equal(updated.node.data.groupId, 'group-1')
  assert.equal(updated.node.data.stackId, 'stack-1')
  assert.equal(updated.node.data.creativeType, 'scene')
  assert.equal(updated.node.data.stale, false, 'content changes clear the updated node stale flag')
  assert.equal(updated.node.data.modelRef, 'model-after')
  assert.equal(updated.node.data.prompt, 'updated prompt')
  assert.equal(updated.node.data.label, 'updated prompt')
  assert.deepEqual(updated.node.data.output, { url: 'local-output://image-1' })
  assert.deepEqual(updated.node.data.params, {
    changed: true,
    url: 'local-output://image-1',
    lastOutputUrl: 'local-output://image-1',
    model: 'model-after',
    prompt: 'updated prompt',
    output_url: 'local-output://image-1',
  })
  assert.equal(updated.node.data.node.prompt, 'updated prompt')

  const replayed = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: 'missing-node-after-success',
    idempotencyKey: 'update-source-config',
    expectedVersion: 0,
    status: 'failed',
  })
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.version, 2)
  assert.deepEqual(replayed.node, updated.node)

  await assert.rejects(store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: created.node.id,
    idempotencyKey: 'update-source-create',
    expectedVersion: 2,
    status: 'failed',
  }), /Idempotency-Key 已用于其他画布命令/u)
  await assert.rejects(store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: created.node.id,
    idempotencyKey: 'update-source-stale-version',
    expectedVersion: 1,
    prompt: 'must not apply',
  }), /画布已在其他会话更新/u)
  const retried = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: created.node.id,
    idempotencyKey: 'update-source-stale-version',
    expectedVersion: null,
    prompt: 'retry after rolled back conflict',
  })
  assert.equal(retried.version, 3, 'a failed CAS rolls back the command claim so the same key can be retried')
  assert.equal(retried.node.data.prompt, 'retry after rolled back conflict')
  await store.close()
  await store.openProject(directory)
  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 3)
  assert.deepEqual(loaded.nodes[0].data.params, retried.node.data.params)
})

test('updateNode propagates stale over input edges and preserves protected execution statuses', async (t) => {
  const { store, project } = await openTestProject(t)
  let version = 0
  const addNode = async (key, type) => {
    const result = await store.createNode({
      projectId: project.projectId,
      canvasId: project.canvasId,
      idempotencyKey: key,
      expectedVersion: version,
      type,
    })
    version = result.version
    return result.node
  }
  const addEdge = async (key, source, target, dependencyType) => {
    const result = await store.connectEdge({
      projectId: project.projectId,
      canvasId: project.canvasId,
      idempotencyKey: key,
      expectedVersion: version,
      sourceNodeId: source.id,
      targetNodeId: target.id,
      dependencyType,
    })
    version = result.version
  }

  const source = await addNode('stale-source', 'text')
  const middle = await addNode('stale-middle', 'video')
  const downstream = await addNode('stale-downstream', 'compose')
  const pending = await addNode('stale-pending', 'video')
  const referenceOnly = await addNode('stale-reference-only', 'image')
  await addEdge('input-source-middle', source, middle, 'input')
  await addEdge('input-middle-downstream', middle, downstream, 'input')
  await addEdge('input-source-pending', source, pending, 'input')
  await addEdge('reference-source-node', source, referenceOnly, 'reference')

  const middleStatus = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: middle.id,
    idempotencyKey: 'set-middle-succeeded',
    expectedVersion: version,
    status: 'succeeded',
    execStatus: 'succeeded',
  })
  version = middleStatus.version
  const downstreamStatus = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: downstream.id,
    idempotencyKey: 'set-downstream-ready',
    expectedVersion: version,
    status: 'ready',
    execStatus: 'ready',
  })
  version = downstreamStatus.version
  const pendingStatus = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: pending.id,
    idempotencyKey: 'set-pending-failed',
    expectedVersion: version,
    status: 'failed',
    execStatus: 'failed',
  })
  version = pendingStatus.version
  const statusOnly = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: source.id,
    idempotencyKey: 'set-source-status-only',
    expectedVersion: version,
    status: 'running',
    execStatus: 'running',
  })
  version = statusOnly.version
  const beforeContentChange = new Map(store.loadCanvas(project.projectId, project.canvasId).nodes.map((node) => [node.id, node]))
  assert.equal(beforeContentChange.get(middle.id).data.stale, false, 'status-only changes do not propagate stale')
  assert.equal(beforeContentChange.get(downstream.id).data.stale, false)
  assert.equal(beforeContentChange.get(pending.id).data.stale, false)

  const sourceStale = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: source.id,
    idempotencyKey: 'set-source-stale',
    expectedVersion: version,
    stale: true,
  })
  version = sourceStale.version

  const changed = await store.updateNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: source.id,
    idempotencyKey: 'change-source-prompt',
    expectedVersion: version,
    prompt: 'new upstream prompt',
  })
  version = changed.version
  const nodes = new Map(store.loadCanvas(project.projectId, project.canvasId).nodes.map((node) => [node.id, node]))
  assert.equal(nodes.get(source.id).data.stale, false)
  assert.equal(nodes.get(middle.id).data.stale, true)
  assert.equal(nodes.get(middle.id).data.execStatus, 'succeeded')
  assert.equal(nodes.get(middle.id).data.status, 'succeeded')
  assert.equal(nodes.get(downstream.id).data.stale, true)
  assert.equal(nodes.get(downstream.id).data.execStatus, 'ready')
  assert.equal(nodes.get(downstream.id).data.status, 'ready')
  assert.equal(nodes.get(pending.id).data.stale, true)
  assert.equal(nodes.get(pending.id).data.execStatus, 'stale')
  assert.equal(nodes.get(pending.id).data.status, 'failed')
  assert.equal(nodes.get(referenceOnly.id).data.stale, false)
  assert.equal(nodes.get(referenceOnly.id).data.execStatus, 'idle')
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).version, version)
})

test('deleteNode applies identity and version checks and reports direct downstream impact while removing every connected edge', async (t) => {
  const { store, project } = await openTestProject(t)
  const upstream = node('delete-upstream', 'text')
  const deleting = node('delete-target', 'text')
  const directVideo = node('delete-direct-video', 'video')
  directVideo.data = { status: 'succeeded', execStatus: 'succeeded', stale: false }
  const directImage = node('delete-direct-image', 'image')
  directImage.data = { status: 'ready', execStatus: 'ready', stale: false }
  const transitive = node('delete-transitive', 'compose')
  transitive.data = { status: 'ready', execStatus: 'ready', stale: false }
  const unrelatedSource = node('delete-unrelated-source', 'text')
  const unrelatedTarget = node('delete-unrelated-target', 'text')
  const edges = [
    { id: 'delete-incoming', source: upstream.id, target: deleting.id },
    { id: 'delete-outgoing-video', source: deleting.id, target: directVideo.id, dependencyType: 'input' },
    { id: 'delete-outgoing-image', source: deleting.id, target: directImage.id, dependencyType: 'reference' },
    { id: 'delete-transitive-edge', source: directVideo.id, target: transitive.id, dependencyType: 'input' },
    { id: 'delete-unrelated-edge', source: unrelatedSource.id, target: unrelatedTarget.id },
  ]
  await store.saveCanvas({
    projectId: project.projectId,
    canvasId: project.canvasId,
    expectedVersion: 0,
    nodes: [upstream, deleting, directVideo, directImage, transitive, unrelatedSource, unrelatedTarget],
    edges,
  })

  const base = {
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: deleting.id,
    idempotencyKey: 'delete-node-command',
  }
  await assert.rejects(store.deleteNode({ ...base, projectId: 'another-project', expectedVersion: 1 }), /当前项目已更改/u)
  await assert.rejects(store.deleteNode({ ...base, canvasId: 'another-canvas', expectedVersion: 1 }), /当前项目已更改/u)
  await assert.rejects(store.deleteNode({ ...base, expectedVersion: 0 }), /画布已在其他会话更新/u)
  await assert.rejects(store.deleteNode({ ...base, nodeId: 'missing-delete-node', expectedVersion: 1 }), /节点不存在/u)
  await assert.rejects(store.deleteNode({ ...base, idempotencyKey: ' ', expectedVersion: 1 }), /Idempotency-Key 必须为/u)

  const unchanged = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(unchanged.version, 1)
  assert.equal(unchanged.nodes.some((entry) => entry.id === deleting.id), true)
  assert.equal(unchanged.edges.length, 5)

  const impact = await store.deleteNode({ ...base, expectedVersion: 1 })
  assert.deepEqual(impact, {
    connectedEdges: ['delete-incoming', 'delete-outgoing-video', 'delete-outgoing-image'],
    downstreamNodes: [
      { id: directVideo.id, type: 'video', name: '视频节点' },
      { id: directImage.id, type: 'image', name: '图片节点' },
    ],
    deletedNodeId: deleting.id,
  })

  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 2)
  assert.equal(loaded.nodes.some((entry) => entry.id === deleting.id), false)
  assert.deepEqual(loaded.edges.map((edge) => edge.id), ['delete-transitive-edge', 'delete-unrelated-edge'])
  const directVideoAfter = loaded.nodes.find((entry) => entry.id === directVideo.id)
  const directImageAfter = loaded.nodes.find((entry) => entry.id === directImage.id)
  const transitiveAfter = loaded.nodes.find((entry) => entry.id === transitive.id)
  assert.equal(directVideoAfter.data.stale, false, 'legacy deletion reports direct impacts but does not propagate stale state')
  assert.equal(directVideoAfter.data.execStatus, 'succeeded')
  assert.equal(directImageAfter.data.stale, false)
  assert.equal(transitiveAfter.data.stale, false, 'impact summary does not recurse through downstream edges')
})

test('deleteNode replays its durable impact snapshot before version and node checks', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await saveNodes(store, project, [node('delete-replay-text', 'text'), node('delete-replay-video', 'video')])
  const deleted = await store.deleteNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: 'delete-replay-text',
    idempotencyKey: 'delete-replay-command',
    expectedVersion: 1,
  })
  assert.equal(deleted.deletedNodeId, 'delete-replay-text')
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).version, 2)

  await store.close()
  await store.openProject(directory)
  const replayed = await store.deleteNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    nodeId: 'missing-after-delete',
    idempotencyKey: 'delete-replay-command',
    expectedVersion: 0,
  })
  assert.deepEqual(replayed, deleted)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).version, 2)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).nodes.length, 1)

  await assert.rejects(store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'delete-replay-command',
    expectedVersion: 2,
    type: 'text',
  }), /Idempotency-Key 已用于其他画布命令/u)
})

test('project schema v3 migrates through v8 with a v3 backup and keeps existing canvas data', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await saveNodes(store, project, [node('existing-text', 'text')])
  await store.close()

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('DROP TABLE canvas_groups; DROP TABLE canvas_stacks; DROP TABLE canvas_graph_commands; PRAGMA user_version = 3')
  } finally {
    database.close()
  }

  await store.openProject(directory)
  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.deepEqual(loaded.nodes.map((entry) => entry.id), ['existing-text'])

  const backupDirectory = path.join(directory, '.vibepaper', 'backups')
  const backupName = (await fs.readdir(backupDirectory)).find((name) => name.startsWith('project-schema-v3-'))
  assert.ok(backupName, 'v3 database backup should exist before migration')
  const backupDatabase = new DatabaseSync(path.join(backupDirectory, backupName), { readOnly: true })
  try {
    assert.equal(Number(backupDatabase.prepare('PRAGMA user_version').get().user_version), 3)
    assert.equal(backupDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canvas_graph_commands'").get(), undefined)
  } finally {
    backupDatabase.close()
  }

  const created = await store.createNode({
    projectId: project.projectId,
    canvasId: project.canvasId,
    idempotencyKey: 'after-migration',
    expectedVersion: 1,
    type: 'text',
  })
  assert.equal(created.version, 2)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).nodes.length, 2)
})

test('addGroup, updateGroup and deleteGroup preserve legacy fields, membership and version behavior', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await saveNodes(store, project, [node('group-a', 'text'), node('group-b', 'image'), node('group-c', 'video')])
  const base = { projectId: project.projectId, canvasId: project.canvasId }

  await assert.rejects(store.addGroup({ ...base, nodeIds: ['group-a'] }), /编组至少需要 2 个节点/u)
  await assert.rejects(store.addGroup({ ...base, nodeIds: ['group-a', 'missing-node'] }), /节点不存在/u)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).groups.length, 0,
    'failed addGroup rolls back the inserted group')

  const added = await store.addGroup({ ...base, nodeIds: ['group-a', 'group-b'] })
  assert.match(added.id, /^[0-9a-f-]{36}$/u)
  assert.equal(added.name, '编组')
  assert.equal(added.color, '#8b5cf6')
  assert.equal(added.layout, 'free')
  assert.deepEqual(added.nodeIds, ['group-a', 'group-b'])
  let loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1, 'group commands do not advance canvas version')
  assert.equal(loaded.nodes.find((entry) => entry.id === 'group-a').data.groupId, added.id)
  assert.equal(loaded.nodes.find((entry) => entry.id === 'group-b').data.groupId, added.id)

  const updated = await store.updateGroup({
    ...base,
    groupId: added.id,
    name: 'Research',
    color: '#123456',
    layout: 'horizontal',
  })
  assert.deepEqual(updated, {
    id: added.id,
    name: 'Research',
    color: '#123456',
    layout: 'horizontal',
    nodeIds: ['group-a', 'group-b'],
  })
  await assert.rejects(store.updateGroup({ ...base, groupId: added.id, layout: 'diagonal' }),
    /布局类型必须是 free\/grid\/horizontal/u)
  await assert.rejects(store.updateGroup({ ...base, groupId: 'missing-group' }), /编组不存在/u)
  loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.equal(loaded.groups[0].layout, 'horizontal')

  await store.close()
  await store.openProject(directory)
  loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.groups[0].id, added.id)
  assert.equal(loaded.nodes.find((entry) => entry.id === 'group-a').data.groupId, added.id)

  assert.deepEqual(await store.deleteGroup({ ...base, groupId: added.id }), { status: 'ok' })
  await assert.rejects(store.deleteGroup({ ...base, groupId: added.id }), /编组不存在/u)
  loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.deepEqual(loaded.groups, [])
  assert.equal(loaded.nodes.find((entry) => entry.id === 'group-a').data.groupId, null)
  assert.equal(loaded.nodes.find((entry) => entry.id === 'group-b').data.groupId, null)
})

test('updateGroup replaces its listed node IDs without changing node memberships, as the legacy command does', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await saveNodes(store, project, [node('group-current-a', 'text'), node('group-current-b', 'image'), node('group-listed-only', 'video')])
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const group = await store.addGroup({ ...base, nodeIds: ['group-current-a', 'group-current-b'] })

  const updated = await store.updateGroup({ ...base, groupId: group.id, nodeIds: ['group-listed-only'] })
  assert.deepEqual(updated.nodeIds, ['group-listed-only'])
  let loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.nodes.find((entry) => entry.id === 'group-current-a').data.groupId, group.id)
  assert.equal(loaded.nodes.find((entry) => entry.id === 'group-listed-only').data.groupId ?? null, null)

  await store.close()
  await store.openProject(directory)
  loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.deepEqual(loaded.groups[0].nodeIds, ['group-listed-only'])
  assert.equal(loaded.nodes.find((entry) => entry.id === 'group-current-a').data.groupId, group.id)
})

test('stack commands persist, extract members, clean up memberships and leave canvas version unchanged', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await saveNodes(store, project, [node('stack-a', 'text'), node('stack-b', 'video'), node('stack-outside', 'image')])
  const base = { projectId: project.projectId, canvasId: project.canvasId }

  await assert.rejects(store.addStack({ ...base, nodeIds: ['stack-a'] }), /堆叠至少需要 2 个节点/u)
  await assert.rejects(store.addStack({ ...base, nodeIds: ['stack-a', 'missing-node'] }), /节点不存在/u)
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).stacks.length, 0)

  const stack = await store.addStack({ ...base, nodeIds: ['stack-a', 'stack-b'] })
  assert.match(stack.id, /^[0-9a-f-]{36}$/u)
  assert.equal(stack.collapsed, true)
  assert.deepEqual(stack.nodeIds, ['stack-a', 'stack-b'])
  assert.equal(store.loadCanvas(project.projectId, project.canvasId).nodes.find((entry) => entry.id === 'stack-a').data.stackId, stack.id)
  assert.deepEqual(await store.updateStack({ ...base, stackId: stack.id, collapsed: false }), {
    id: stack.id,
    collapsed: false,
    nodeIds: ['stack-a', 'stack-b'],
  })
  await assert.rejects(store.updateStack({ ...base, stackId: stack.id, collapsed: 'false' }), /collapsed 无效/u)
  await assert.rejects(store.extractFromStack({ ...base, stackId: stack.id, nodeId: 'stack-outside' }),
    /该节点不在堆叠中/u)
  await assert.rejects(store.extractFromStack({ ...base, stackId: 'missing-stack', nodeId: 'stack-a' }), /堆叠不存在/u)

  await store.close()
  await store.openProject(directory)
  const extractedA = await store.extractFromStack({ ...base, stackId: stack.id, nodeId: 'stack-a' })
  assert.equal(extractedA.id, 'stack-a')
  assert.equal(extractedA.stackId, null)
  let loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.deepEqual(loaded.stacks, [{ id: stack.id, collapsed: false, nodeIds: ['stack-b'] }])
  assert.equal(loaded.nodes.find((entry) => entry.id === 'stack-b').data.stackId, stack.id)

  const extractedB = await store.extractFromStack({ ...base, stackId: stack.id, nodeId: 'stack-b' })
  assert.equal(extractedB.stackId, null)
  assert.deepEqual(store.loadCanvas(project.projectId, project.canvasId).stacks, [],
    'extracting the final listed node deletes the stack')
  const deletedStack = await store.addStack({ ...base, nodeIds: ['stack-a', 'stack-b'] })
  assert.deepEqual(await store.deleteStack({ ...base, stackId: deletedStack.id }), { status: 'ok' })
  loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.deepEqual(loaded.stacks, [])
  assert.equal(loaded.nodes.find((entry) => entry.id === 'stack-a').data.stackId, null)
  assert.equal(loaded.nodes.find((entry) => entry.id === 'stack-b').data.stackId, null)
  await assert.rejects(store.deleteStack({ ...base, stackId: deletedStack.id }), /堆叠不存在/u)
})

test('full canvas saves that omit group and stack arrays preserve Store-only records', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await saveNodes(store, project, [node('roundtrip-a', 'text'), node('roundtrip-b', 'video')])
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const group = await store.addGroup({ ...base, nodeIds: ['roundtrip-a', 'roundtrip-b'] })
  const stack = await store.addStack({ ...base, nodeIds: ['roundtrip-a', 'roundtrip-b'] })

  const beforeSave = store.loadCanvas(project.projectId, project.canvasId)
  await store.saveCanvas({
    ...base,
    expectedVersion: beforeSave.version,
    nodes: beforeSave.nodes,
    edges: beforeSave.edges,
  })
  await store.close()
  await store.openProject(directory)

  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 2)
  assert.deepEqual(loaded.groups, [group])
  assert.deepEqual(loaded.stacks, [stack])
  assert.equal(loaded.nodes.find((entry) => entry.id === 'roundtrip-a').data.groupId, group.id)
  assert.equal(loaded.nodes.find((entry) => entry.id === 'roundtrip-a').data.stackId, stack.id)
})

test('full canvas saves replace explicit group and stack snapshots without changing their legacy shape', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  const nodes = [node('snapshot-a', 'text'), node('snapshot-b', 'video')]
  const group = { id: 'snapshot-group', name: '研究组', color: '#8b5cf6', layout: 'grid', nodeIds: ['snapshot-a', 'snapshot-b'] }
  const stack = { id: 'snapshot-stack', collapsed: false, nodeIds: ['snapshot-a', 'snapshot-b'] }
  const base = { projectId: project.projectId, canvasId: project.canvasId, nodes, edges: [] }

  await store.saveCanvas({ ...base, expectedVersion: 0, groups: [group], stacks: [stack] })
  let loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.deepEqual(loaded.groups, [group])
  assert.deepEqual(loaded.stacks, [stack])

  await store.saveCanvas({ ...base, expectedVersion: loaded.version, groups: [], stacks: [] })
  await store.close()
  await store.openProject(directory)
  loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.deepEqual(loaded.groups, [])
  assert.deepEqual(loaded.stacks, [])
})

test('deleteNode retains group and stack node ID lists exactly as the legacy GraphService does', async (t) => {
  const { store, project } = await openTestProject(t)
  await saveNodes(store, project, [node('legacy-delete-a', 'text'), node('legacy-delete-b', 'video')])
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const group = await store.addGroup({ ...base, nodeIds: ['legacy-delete-a', 'legacy-delete-b'] })
  const stack = await store.addStack({ ...base, nodeIds: ['legacy-delete-a', 'legacy-delete-b'] })

  await store.deleteNode({
    ...base,
    nodeId: 'legacy-delete-a',
    idempotencyKey: 'delete-grouped-node',
    expectedVersion: 1,
  })
  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 2)
  assert.equal(loaded.nodes.some((entry) => entry.id === 'legacy-delete-a'), false)
  assert.deepEqual(loaded.groups.find((entry) => entry.id === group.id).nodeIds,
    ['legacy-delete-a', 'legacy-delete-b'])
  assert.deepEqual(loaded.stacks.find((entry) => entry.id === stack.id).nodeIds,
    ['legacy-delete-a', 'legacy-delete-b'])
})

test('project backup and restore retain group and stack tables and node membership', async (t) => {
  const { store, project } = await openTestProject(t)
  const restoreParent = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-canvas-restore-'))
  t.after(() => fs.rm(restoreParent, { recursive: true, force: true }))
  await saveNodes(store, project, [node('backup-a', 'text'), node('backup-b', 'video')])
  const base = { projectId: project.projectId, canvasId: project.canvasId }
  const group = await store.addGroup({ ...base, nodeIds: ['backup-a', 'backup-b'] })
  const stack = await store.addStack({ ...base, nodeIds: ['backup-a', 'backup-b'] })

  const backup = await store.backupProject(restoreParent, project.projectId)
  const restored = await store.restoreBackup(backup.directory, restoreParent)
  const loaded = store.loadCanvas(restored.project.projectId, restored.project.canvasId)
  assert.deepEqual(loaded.groups, [group])
  assert.deepEqual(loaded.stacks, [stack])
  assert.equal(loaded.nodes.find((entry) => entry.id === 'backup-a').data.groupId, group.id)
  assert.equal(loaded.nodes.find((entry) => entry.id === 'backup-a').data.stackId, stack.id)
})

test('project schema v4 migrates through v8 after creating a rollback snapshot', async (t) => {
  const { store, directory, project } = await openTestProject(t)
  await saveNodes(store, project, [node('v4-existing-node', 'text')])
  await store.close()

  const databasePath = path.join(directory, '.vibepaper', 'project.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('DROP TABLE canvas_groups; DROP TABLE canvas_stacks; PRAGMA user_version = 4')
  } finally {
    database.close()
  }

  await store.openProject(directory)
  const loaded = store.loadCanvas(project.projectId, project.canvasId)
  assert.equal(loaded.version, 1)
  assert.deepEqual(loaded.nodes.map((entry) => entry.id), ['v4-existing-node'])
  assert.deepEqual(loaded.groups, [])
  assert.deepEqual(loaded.stacks, [])

  const backupDirectory = path.join(directory, '.vibepaper', 'backups')
  const backupName = (await fs.readdir(backupDirectory)).find((name) => name.startsWith('project-schema-v4-'))
  assert.ok(backupName, 'v4 database backup should exist before migration')
  const backupDatabase = new DatabaseSync(path.join(backupDirectory, backupName), { readOnly: true })
  try {
    assert.equal(Number(backupDatabase.prepare('PRAGMA user_version').get().user_version), 4)
    assert.equal(backupDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canvas_groups'").get(), undefined)
    assert.equal(backupDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canvas_stacks'").get(), undefined)
  } finally {
    backupDatabase.close()
  }
})
