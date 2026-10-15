const test = require('node:test')
const assert = require('node:assert/strict')
const { deleteAgentNodes } = require('../src/agent-node-deletion.cjs')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createLocalProjectStore } = require('../src/project-store.cjs')

function fixture() {
  const input = { projectId: 'p', canvasId: 'c', expectedVersion: 3, idempotencyKey: 'delete-one', nodeIds: ['a', 'b'] }
  const calls = []
  let version = 3
  const deps = {
    loadCanvas: async () => ({ canvasId: 'c', version, nodes: [{ id: 'a', type: 'text' }, { id: 'b', type: 'image' }] }),
    confirm: async () => true, assertActive: async () => {},
    deleteNode: async (request) => { calls.push(request); return { version: ++version } },
  }
  return { input, deps, calls, changeVersion: () => version++ }
}

test('Agent deletion previews all nodes, then forwards versioned and distinct idempotent commands', async () => {
  const f = fixture()
  let labels
  f.deps.confirm = async (value) => { labels = value; return true }
  assert.equal((await deleteAgentNodes(f.input, f.deps)).canvasVersion, 5)
  assert.deepEqual(labels, ['text', 'image'])
  assert.deepEqual(f.calls.map((call) => call.expectedVersion), [3, 4])
  assert.notEqual(f.calls[0].idempotencyKey, f.calls[1].idempotencyKey)
})

test('Declined, expired, changed canvas or project never deletes', async () => {
  for (const mode of ['declined', 'expired', 'version', 'project']) {
    const f = fixture()
    let time = 0
    f.deps.now = () => time
    f.deps.confirm = async () => {
      if (mode === 'expired') time = 240_001
      if (mode === 'version') f.changeVersion()
      return mode !== 'declined'
    }
    if (mode === 'project') f.deps.assertActive = async () => { throw new Error('AGENT_PROJECT_CHANGED') }
    await assert.rejects(deleteAgentNodes(f.input, f.deps))
    assert.equal(f.calls.length, 0)
  }
})

test('Missing nodes and duplicate targets are rejected before preview', async () => {
  for (const ids of [['missing'], ['a', 'a']]) {
    const f = fixture()
    f.input.nodeIds = ids
    f.deps.confirm = async () => { assert.fail('invalid targets must not prompt') }
    await assert.rejects(deleteAgentNodes(f.input, f.deps))
    assert.equal(f.calls.length, 0)
  }
})

test('Completed deletion replays from the durable Local Core ledger after reopening', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-agent-delete-'))
  const store = createLocalProjectStore()
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const opened = await store.createProject(directory, 'Delete Replay')
  const scope = { projectId: opened.project.projectId, canvasId: opened.project.canvasId }
  await store.saveCanvas({ ...scope, expectedVersion: 0, nodes: ['a', 'b'].map((id) => ({ id, type: 'text', position: { x: 0, y: 0 }, data: {} })), edges: [] })
  await store.updateNode({ ...scope, nodeId: 'a', expectedVersion: 1, idempotencyKey: 'update-a', prompt: 'hello' })
  assert.equal(store.lookupAgentOperation({ ...scope, method: 'agent:core:update-node', idempotencyKey: 'update-a' }).node.id, 'a')
  assert.equal(store.lookupAgentOperation({ ...scope, method: 'agent:core:update-node', idempotencyKey: 'unknown' }), null)
  const input = { ...scope, expectedVersion: 2, idempotencyKey: 'delete-batch', nodeIds: ['a', 'b'] }
  const deps = {
    loadCanvas: async () => store.loadCanvas(scope.projectId, scope.canvasId),
    confirm: async () => true, assertActive: async () => {},
    lookupDeletedNode: async (request) => store.getDeletedNodeCommand(request),
    deleteNode: async (request) => { const result = await store.deleteNode(request); return { ...result, version: store.loadCanvas(scope.projectId, scope.canvasId).version } },
  }
  assert.equal((await deleteAgentNodes(input, deps)).canvasVersion, 4)
  await store.close()
  await store.openProject(opened.directory)
  deps.confirm = async () => assert.fail('completed command must only read its ledger')
  deps.deleteNode = async () => assert.fail('completed command must not mutate')
  assert.equal((await deleteAgentNodes(input, deps)).replayed, true)
  assert.equal(store.loadCanvas(scope.projectId, scope.canvasId).version, 4)
})
