const { createHash } = require('node:crypto')

// A live, scoped preview consent. Nothing is persisted that could replay a
// deletion after restart; Local Core remains the version/idempotency authority.
function deletionKey(key, nodeId) {
  return `agent-${createHash('sha256').update(`${key}\0${nodeId}`).digest('hex').slice(0, 56)}`
}

async function deleteAgentNodes(input, { loadCanvas, confirm, deleteNode, lookupDeletedNode, assertActive, now = Date.now }) {
  const ids = input.nodeIds
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20
    || ids.some((id) => typeof id !== 'string' || !id || id.length > 256)
    || new Set(ids).size !== ids.length || !Number.isSafeInteger(input.expectedVersion)
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 255) {
    throw new Error('INVALID_INPUT')
  }
  if (lookupDeletedNode) {
    const previous = await Promise.all(ids.map((nodeId) => lookupDeletedNode({
      projectId: input.projectId, canvasId: input.canvasId, idempotencyKey: deletionKey(input.idempotencyKey, nodeId),
    })))
    if (previous.every((entry, index) => entry?.deletedNodeId === ids[index] && Number.isSafeInteger(entry.version))) {
      await assertActive()
      return { operation: 'delete_nodes', results: previous, canvasVersion: Math.max(...previous.map((entry) => entry.version)), replayed: true }
    }
  }
  const canvas = await loadCanvas()
  if (canvas.canvasId !== input.canvasId || canvas.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
  if (ids.some((id) => !canvas.nodes.some((node) => node.id === id))) throw new Error('NOT_FOUND')
  const deadline = now() + 240_000
  const accepted = await confirm(ids.map((id) => {
    const node = canvas.nodes.find((entry) => entry.id === id)
    return `${node.data?.label ?? node.type ?? '节点'}`
  }))
  if (!accepted) throw new Error('PERMISSION_DENIED')
  if (now() > deadline) throw new Error('CONFIRMATION_EXPIRED')
  await assertActive()
  const latest = await loadCanvas()
  if (latest.canvasId !== input.canvasId || latest.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
  let version = input.expectedVersion
  const results = []
  for (const nodeId of ids) {
    await assertActive()
    const result = await deleteNode({
      projectId: input.projectId, canvasId: input.canvasId, nodeId, expectedVersion: version,
      idempotencyKey: deletionKey(input.idempotencyKey, nodeId),
    })
    if (!Number.isSafeInteger(result.version)) throw new Error('INVALID_RESPONSE')
    version = result.version
    results.push(result)
  }
  return { operation: 'delete_nodes', results, canvasVersion: version }
}

module.exports = { deleteAgentNodes }
