const { createHash } = require('node:crypto')
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const validIds = (ids) => Array.isArray(ids) && ids.length <= 500 && new Set(ids).size === ids.length
  && ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)

/** Shared host command runner. The caller supplies project/run authority and canvas barriers. */
async function executeCreatorCommand({ service, directory, projectId, canvasId, action, input, operationKey,
  authorize, reauthorize = async () => {}, core, barrier, previewBarrier, commands, format, receiptDigest }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_INPUT')
  if (receiptDigest !== undefined && (typeof receiptDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(receiptDigest))) throw new Error('INVALID_INPUT')
  const write = action === 'command_apply' || action === 'command_undo'
  authorize(write ? 'canvas_write' : 'read')
  if (action === 'command_inspect') {
    if (!validIds(input.selectionIds ?? [])) throw new Error('INVALID_INPUT')
    const packages = await service.list(directory)
    const canvas = await core('canvas:load', { projectId, canvasId })
    await reauthorize()
    authorize('read')
    return { canvasVersion: canvas.version, commands: commands.describeCreativeCommands(packages, canvas.nodes, input.selectionIds ?? []) }
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error('INVALID_INPUT')
  if (action === 'command_undo') {
    if (typeof input.originalOperationKey !== 'string' || !input.originalOperationKey || input.originalOperationKey.length > 128) throw new Error('INVALID_INPUT')
    const previous = await core('agent:lookup-operation', { projectId, canvasId, method: 'agent:core:arrange-nodes', idempotencyKey: operationKey })
    if (previous) {
      if (previous.undoOf !== input.originalOperationKey) throw new Error('IDEMPOTENCY_CONFLICT')
      return { ...previous, canvasVersion: previous.version, operationKey, replayed: true }
    }
    const original = await core('agent:lookup-operation', { projectId, canvasId, method: 'agent:core:arrange-nodes', idempotencyKey: input.originalOperationKey })
    if (!original || original.undoOf || !Array.isArray(original.moves)) throw new Error('UNDO_UNAVAILABLE')
    return barrier({ projectId, canvasId, expectedVersion: input.expectedVersion }, async (version) => {
      await reauthorize()
      authorize('canvas_write')
      const moves = original.moves.map((move) => ({ id: move.id, from: move.to, to: move.from }))
      const result = await core('canvas:arrange-nodes', { projectId, canvasId, expectedVersion: version, idempotencyKey: operationKey,
        previewDigest: original.previewDigest, undoOf: input.originalOperationKey, moves })
      return { ...result, canvasVersion: result.version, operationKey }
    })
  }
  if (!['command_preview', 'command_apply'].includes(action) || typeof input.packageId !== 'string'
    || typeof input.componentId !== 'string' || !/^[a-f0-9]{64}$/u.test(input.digest ?? '') || !validIds(input.selectionIds)) throw new Error('INVALID_INPUT')
  if (action === 'command_apply') {
    if (!/^[a-f0-9]{64}$/u.test(input.previewDigest ?? '')) throw new Error('INVALID_INPUT')
    const previous = await core('agent:lookup-operation', { projectId, canvasId, method: 'agent:core:arrange-nodes', idempotencyKey: operationKey })
    if (previous) {
      if (previous.undoOf || previous.previewDigest !== (receiptDigest ?? input.previewDigest)) throw new Error('IDEMPOTENCY_CONFLICT')
      return { ...previous, canvasVersion: previous.version, operationKey, replayed: true }
    }
  }
  const run = action === 'command_preview' ? previewBarrier : barrier
  return run({ projectId, canvasId, expectedVersion: input.expectedVersion }, async (version) => service.withInstalledSnapshot(directory, input.packageId, input.componentId, async (snapshot) => {
    authorize(write ? 'canvas_write' : 'read')
    if (snapshot.digest !== input.digest) throw new Error('MARKETPLACE_VERSION_CONFLICT')
    const canvas = await core('canvas:load', { projectId, canvasId })
    if (canvas.version !== version) throw new Error('CANVAS_VERSION_CONFLICT')
    const preview = commands.previewCreativeCommand(snapshot.component, canvas.nodes, input.selectionIds, format)
    const previewDigest = digest({ projectId, canvasId, version, packageId: input.packageId, componentId: input.componentId,
      digest: snapshot.digest, selectionIds: input.selectionIds, preview })
    if (action === 'command_preview') { await reauthorize(); authorize('read'); return { ...preview, canvasVersion: version, previewDigest, packageDigest: snapshot.digest } }
    if (preview.capabilityId !== 'selection.arrange') throw new Error('COMMAND_READ_ONLY')
    if (input.previewDigest !== previewDigest) throw new Error('PREVIEW_CHANGED')
    await reauthorize()
    authorize('canvas_write')
    const result = await core('canvas:arrange-nodes', { projectId, canvasId, expectedVersion: version, idempotencyKey: operationKey,
      previewDigest: receiptDigest ?? previewDigest, moves: preview.moves })
    return { ...result, canvasVersion: result.version, operationKey, generationTasksCreated: 0 }
  }))
}
module.exports = { executeCreatorCommand }
