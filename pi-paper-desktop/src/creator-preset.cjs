const { digestValue } = require('./marketplace-storage.cjs')

const MODEL_KEYS = new Set(['model', 'aspect', 'ratio', 'size', 'resolution', 'resKey', 'duration', 'count', 'generate_audio'])
const sensitive = (value) => typeof value === 'string' && /\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token)\s*[:=]/iu.test(value)
const paramsOf = (node) => node.data?.params ?? node.data?.node?.params ?? {}
function withParams(node, params) {
  const data = { ...node.data, params }
  if (data.node) data.node = { ...data.node, params }
  return { ...node, data }
}

async function executeCreatorPreset({ service, directory, projectId, canvasId, action, input, operationKey, authorize,
  reauthorize = async () => {}, core, barrier, previewBarrier, preset, providerConfiguration, withProviderConfiguration }) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 0 || typeof input.targetNodeId !== 'string' || !input.targetNodeId || input.targetNodeId.length > 256) throw new Error('INVALID_INPUT')
  const write = action !== 'preset_preview'
  authorize(write ? 'canvas_write' : 'read')
  const beforeCommit = async () => { await reauthorize(); authorize(write ? 'canvas_write' : 'read') }
  beforeCommit.assertSync = authorize
  const loadPreview = async (version, lockedSnapshot, lockedConfiguration) => {
    const snapshot = lockedSnapshot ?? await service.getInstalledSnapshot(directory, input.packageId, input.componentId)
    if (snapshot.component.type !== 'preset' || snapshot.digest !== input.digest) throw new Error('MARKETPLACE_VERSION_CONFLICT')
    const canvas = await core('canvas:load', { projectId, canvasId })
    if (canvas.version !== version) throw new Error('CANVAS_VERSION_CONFLICT')
    const node = canvas.nodes.find((item) => item.id === input.targetNodeId)
    if (!node || node.type !== snapshot.component.data.nodeType) throw new Error('MARKETPLACE_PRESET_TARGET_MISMATCH')
    const before = paramsOf(node)
    const needsModel = Object.keys(snapshot.component.data.params).some((key) => MODEL_KEYS.has(key))
    if (needsModel && (typeof before.model !== 'string' || !before.model)) throw new Error('MARKETPLACE_MODEL_SELECTION_REQUIRED')
    const configuration = needsModel ? lockedConfiguration ?? await providerConfiguration() : { providers: [], models: [] }
    let patch
    try { patch = preset.changedPluginPresetPatch(before, preset.pluginPresetPatch(snapshot.component.data, node.type, before, configuration)) }
    catch { throw new Error('MARKETPLACE_MODEL_PARAMETERS_UNSUPPORTED') }
    const changes = Object.entries(patch).map(([key, after]) => ({ key, existed: Object.hasOwn(before, key), before: before[key] ?? null, after }))
    if (changes.some(({ before: previous, after }) => sensitive(previous) || sensitive(after))) throw new Error('MARKETPLACE_SECRET_REJECTED')
    const previewDigest = digestValue({ projectId, canvasId, version, packageId: input.packageId, componentId: input.componentId,
      digest: input.digest, targetNodeId: input.targetNodeId, changes, configuration })
    return { canvasVersion: version, previewDigest, changes, node, canvas }
  }
  if (action === 'preset_preview') {
    return previewBarrier({ projectId, canvasId, expectedVersion: input.expectedVersion }, async (version) => {
      const preview = await loadPreview(version)
      await reauthorize(); authorize('read')
      return { canvasVersion: version, previewDigest: preview.previewDigest, targetNodeId: input.targetNodeId,
        changes: preview.changes, generationTasksCreated: 0 }
    })
  }
  const inputHash = digestValue({ action, input })
  const existing = (await service.getCreatorOperations(directory, operationKey))[0]
  if (existing) {
    if (existing.inputHash !== inputHash || !['preset_apply', 'preset_undo'].includes(existing.kind)) throw new Error('IDEMPOTENCY_CONFLICT')
    if (existing.status === 'completed') return { ...existing.receipt, operationKey, replayed: true }
    const known = await core('agent:lookup-operation', { projectId, canvasId, method: 'agent:core:save-canvas', idempotencyKey: operationKey })
    if (!known) throw new Error(existing.status === 'failed' ? 'OPERATION_FAILED' : 'OPERATION_UNCERTAIN')
    const receipt = { applied: true, canvasVersion: known.version, targetNodeId: existing.targetNodeId,
      changes: existing.changes, generationTasksCreated: 0 }
    await service.completeCreatorOperation(directory, operationKey, inputHash, receipt)
    return { ...receipt, operationKey, replayed: true }
  }
  let planned
  if (action === 'preset_apply') {
    if (typeof input.previewDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.previewDigest)) throw new Error('PREVIEW_REQUIRED')
    planned = await previewBarrier({ projectId, canvasId, expectedVersion: input.expectedVersion }, async (version) => {
      const preview = await loadPreview(version)
      if (preview.previewDigest !== input.previewDigest) throw new Error('PREVIEW_CHANGED')
      await reauthorize(); authorize('read')
      return preview
    })
  } else if (action === 'preset_undo') {
    if (typeof input.originalOperationKey !== 'string' || !input.originalOperationKey) throw new Error('INVALID_INPUT')
    const original = (await service.getCreatorOperations(directory, input.originalOperationKey))[0]
    if (!original || original.kind !== 'preset_apply' || original.status !== 'completed'
      || original.targetNodeId !== input.targetNodeId || !Array.isArray(original.changes)) throw new Error('UNDO_UNAVAILABLE')
    planned = { changes: original.changes.map((change) => ({ key: change.key, existed: true, before: change.after,
      after: change.before, deleteAfter: !change.existed })) }
  } else throw new Error('PERMISSION_DENIED')
  if (planned.changes.length === 0) return { applied: false, reason: 'already_matches', canvasVersion: input.expectedVersion, generationTasksCreated: 0 }
  const prepared = await service.prepareCreatorOperation(directory, operationKey, inputHash, {
    kind: action, targetNodeId: input.targetNodeId, expectedVersion: input.expectedVersion, changes: planned.changes,
    ...(action === 'preset_undo' ? { originalOperationKey: input.originalOperationKey } : {}),
  }, beforeCommit)
  if (!prepared.created) throw new Error('OPERATION_UNCERTAIN')
  let dispatched = false
  try {
    return await barrier({ projectId, canvasId, expectedVersion: input.expectedVersion }, async (version) => {
      const dispatch = async (lockedSnapshot) => {
        const needsModel = action === 'preset_apply' && Object.keys(lockedSnapshot.component.data.params).some((key) => MODEL_KEYS.has(key))
        const commitWithConfiguration = async (configuration) => {
        await reauthorize(); authorize('canvas_write')
        const canvas = await core('canvas:load', { projectId, canvasId })
        if (canvas.version !== version) throw new Error('CANVAS_VERSION_CONFLICT')
        const node = canvas.nodes.find((item) => item.id === input.targetNodeId)
        if (!node) throw new Error('MARKETPLACE_PRESET_TARGET_MISMATCH')
        const before = paramsOf(node)
        if (action === 'preset_apply') {
          const fresh = await loadPreview(version, lockedSnapshot, configuration)
          if (fresh.previewDigest !== input.previewDigest) throw new Error('PREVIEW_CHANGED')
        } else if (planned.changes.some((change) => !Object.hasOwn(before, change.key) || !Object.is(before[change.key], change.before))) {
          throw new Error('UNDO_TARGET_CHANGED')
        }
        const params = { ...before }
        for (const change of planned.changes) {
          if (change.deleteAfter) delete params[change.key]; else params[change.key] = change.after
        }
        const nodes = canvas.nodes.map((item) => item.id === node.id ? withParams(item, params) : item)
        await reauthorize(); authorize('canvas_write')
        dispatched = true
        const saved = await core('canvas:save', { projectId, canvasId, expectedVersion: version, idempotencyKey: operationKey, nodes, edges: canvas.edges })
        return { saved, nodeId: node.id }
        }
        if (needsModel) {
          if (typeof withProviderConfiguration !== 'function') throw new Error('MARKETPLACE_MODEL_PARAMETERS_UNSUPPORTED')
          return withProviderConfiguration(commitWithConfiguration)
        }
        return commitWithConfiguration(undefined)
      }
      const { saved, nodeId } = action === 'preset_apply'
        ? await service.withInstalledSnapshot(directory, input.packageId, input.componentId, dispatch)
        : await dispatch()
      const receipt = { applied: true, canvasVersion: saved.version, targetNodeId: nodeId, changes: planned.changes, generationTasksCreated: 0 }
      await service.completeCreatorOperation(directory, operationKey, inputHash, receipt)
      return { ...receipt, operationKey, replayed: Boolean(saved.replayed) }
    })
  } catch (error) {
    if (!dispatched) await service.failCreatorOperation(directory, operationKey, inputHash, error.message)
    throw error
  }
}
module.exports = { executeCreatorPreset }
