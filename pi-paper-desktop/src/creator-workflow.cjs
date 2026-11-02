const { createHash } = require('node:crypto')
const { executeCreatorCommand } = require('./creator-command.cjs')

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/u
const TYPES = { check_missing_prompt: 'storyboard', arrange: 'selection_command', storyboard_preview: 'storyboard' }
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')

function validateWorkflowRecipe(data) {
  if (!record(data) || Object.keys(data).some((key) => key !== 'steps') || !Array.isArray(data.steps)
    || data.steps.length < 1 || data.steps.length > 3) throw new Error('MARKETPLACE_PACKAGE_INVALID')
  const seen = new Set()
  for (const step of data.steps) {
    if (!record(step) || Object.keys(step).some((key) => !['kind', 'componentId'].includes(key))
      || !Object.hasOwn(TYPES, step.kind) || typeof step.componentId !== 'string' || !ID.test(step.componentId)
      || seen.has(step.kind)) throw new Error('MARKETPLACE_PACKAGE_INVALID')
    seen.add(step.kind)
  }
  return data
}

/** Executes a bounded recipe using only existing host command handlers. */
async function executeCreatorWorkflow(common) {
  const { service, directory, projectId, canvasId, action, input, operationKey, core, authorize, reauthorize = async () => {} } = common
  if (!record(input) || Object.keys(input).some((key) => !['packageId', 'componentId', 'digest', 'selectionIds', 'expectedVersion', 'previewDigest'].includes(key))
    || typeof input.packageId !== 'string' || !ID.test(input.packageId)
    || typeof input.componentId !== 'string' || !ID.test(input.componentId)
    || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.digest)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
    || !Array.isArray(input.selectionIds) || input.selectionIds.length < 1 || input.selectionIds.length > 500
    || new Set(input.selectionIds).size !== input.selectionIds.length
    || input.selectionIds.some((id) => typeof id !== 'string' || !id || id.length > 256)
    || typeof operationKey !== 'string' || !operationKey || operationKey.length > 128
    || !['workflow_preview', 'workflow_apply'].includes(action)) throw new Error('INVALID_INPUT')
  const write = action === 'workflow_apply'
  authorize(write ? 'canvas_write' : 'read')
  if (write) {
    if (typeof input.previewDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.previewDigest)) throw new Error('INVALID_INPUT')
    const previous = await core('agent:lookup-operation', { projectId, canvasId, method: 'agent:core:arrange-nodes', idempotencyKey: operationKey })
    if (previous) {
      if (previous.undoOf || previous.previewDigest !== input.previewDigest) throw new Error('IDEMPOTENCY_CONFLICT')
      return { status: 'applied', canvasVersion: previous.version, operationKey, replayed: true, generationTasksCreated: 0 }
    }
  }
  const snapshot = await service.getInstalledSnapshot(directory, input.packageId, input.componentId)
  if (snapshot.digest !== input.digest || snapshot.component.type !== 'workflow_recipe') throw new Error('MARKETPLACE_VERSION_CONFLICT')
  const recipe = validateWorkflowRecipe(snapshot.component.data)
  const verifyDependencies = async () => {
    // Read all component statuses from one project snapshot, including at the
    // final dispatch boundary. Separate reads could mix two installations.
    const { readState, digestValue } = require('./marketplace-storage.cjs')
    const state = await readState(directory)
    const entry = state.packages.find((item) => item.manifest.id === input.packageId)
    const current = entry?.manifest.components.find((item) => item.id === input.componentId)
    const enabled = (id) => entry?.components.some((item) => item.id === id && item.enabled)
    if (!entry || !enabled(input.componentId) || digestValue(entry.manifest) !== snapshot.digest
      || JSON.stringify(current) !== JSON.stringify(snapshot.component)) throw new Error('MARKETPLACE_VERSION_CONFLICT')
    for (const step of recipe.steps) {
      const component = entry.manifest.components.find((item) => item.id === step.componentId)
      if (!enabled(step.componentId) || component?.type !== TYPES[step.kind]) throw new Error('WORKFLOW_DEPENDENCY_UNAVAILABLE')
    }
  }
  await verifyDependencies()
  const steps = []
  const projectedPositions = new Map()
  for (const step of recipe.steps) {
    // Later read-only steps see the result of earlier proposed moves without
    // mutating the authoritative canvas. All steps remain bound to one version.
    const projectedCore = async (method, payload) => {
      const result = await core(method, payload)
      if (method !== 'canvas:load' || projectedPositions.size === 0) return result
      return { ...result, nodes: result.nodes.map((node) => {
        const position = projectedPositions.get(String(node.id))
        if (!position) return node
        const data = { ...node.data }
        if (record(data.node)) data.node = { ...data.node, x: position.x, y: position.y }
        return { ...node, position: { ...position }, data }
      }) }
    }
    const preview = await executeCreatorCommand({ ...common, core: projectedCore, action: 'command_preview', input: {
      packageId: input.packageId, componentId: step.componentId, digest: input.digest,
      selectionIds: input.selectionIds, expectedVersion: input.expectedVersion,
    } })
    const result = step.kind === 'check_missing_prompt'
      ? { capabilityId: preview.capabilityId, missing: preview.rows.filter((row) => !row.values.prompt.trim()).map((row) => ({ id: row.id, title: row.values.title })) }
      : preview
    steps.push({ kind: step.kind, componentId: step.componentId, result })
    if (step.kind === 'arrange') for (const move of preview.moves) projectedPositions.set(move.id, move.to)
  }
  await verifyDependencies()
  await reauthorize()
  authorize(write ? 'canvas_write' : 'read')
  const previewDigest = hash({ projectId, canvasId, version: input.expectedVersion, packageId: input.packageId,
    componentId: input.componentId, digest: input.digest, selectionIds: input.selectionIds, steps })
  if (!write) return { status: 'preview', canvasVersion: input.expectedVersion, previewDigest, steps, generationTasksCreated: 0 }
  if (input.previewDigest !== previewDigest) throw new Error('PREVIEW_CHANGED')
  const arrange = steps.find((step) => step.kind === 'arrange')
  if (!arrange) return { status: 'completed', canvasVersion: input.expectedVersion, steps, generationTasksCreated: 0 }
  const applied = await executeCreatorCommand({ ...common, action: 'command_apply', receiptDigest: previewDigest,
    input: { packageId: input.packageId, componentId: arrange.componentId, digest: input.digest,
      selectionIds: input.selectionIds, expectedVersion: input.expectedVersion, previewDigest: arrange.result.previewDigest },
    reauthorize: async () => { await reauthorize(); await verifyDependencies() },
  })
  return { status: 'applied', canvasVersion: applied.canvasVersion, operationKey, steps, generationTasksCreated: 0 }
}

module.exports = { validateWorkflowRecipe, executeCreatorWorkflow }
