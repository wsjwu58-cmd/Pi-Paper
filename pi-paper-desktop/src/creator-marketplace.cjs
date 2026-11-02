const { createHash } = require('node:crypto')
const { digestValue } = require('./marketplace-storage.cjs')
const { definitionDigest, validateNodeInstance } = require('./node-definition.cjs')

const MODEL_KEYS = new Set(['model', 'aspect', 'ratio', 'size', 'resolution', 'resKey', 'duration', 'count', 'generate_audio'])

function receiptFromKnown(record, known) {
  if (record.method === 'agent:core:create-node') {
    if (typeof known.node?.id !== 'string') throw new Error('OPERATION_UNCERTAIN')
    return { applied: true, canvasVersion: known.version, nodeIds: [known.node.id], edgeIds: [], nodeCount: 1, edgeCount: 0, generationTasksCreated: 0 }
  }
  const makeId = deterministicIds(record.operationKey)
  const nodeIds = Array.from({ length: record.nodeCount }, () => makeId())
  const edgeIds = Array.from({ length: record.edgeCount }, () => makeId())
  return { applied: true, canvasVersion: known.version, nodeIds, edgeIds, nodeCount: nodeIds.length, edgeCount: edgeIds.length, generationTasksCreated: 0 }
}

function deterministicIds(key) {
  let index = 0
  return () => {
    const hash = createHash('sha256').update(`${key}\0${index++}`).digest('hex')
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  }
}

/** Main-only dispatcher. All project and run authority comes from its caller. */
async function executeCreatorMarketplace({ service, directory, projectId, canvasId, action, input, operationKey, authorize, reauthorize = async () => {}, core, barrier, graph, basicNodeCatalog, discoverModels, trackApply }) {
  authorize()
  const beforeCommit = async () => { await reauthorize(); authorize() }
  beforeCommit.assertSync = authorize
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_INPUT')
  if (action === 'model_inspect') {
    if (typeof discoverModels !== 'function') throw new Error('MODEL_UNAVAILABLE')
    const result = await discoverModels(input)
    await reauthorize(); authorize()
    return result
  }
  if (action === 'inspect') {
    if (Object.keys(input).some((key) => !['componentType', 'packageId', 'componentId'].includes(key))
      || (input.componentId !== undefined && typeof input.packageId !== 'string')) throw new Error('INVALID_INPUT')
    const supported = {
      template: { maxNodes: 20, nodeTypes: ['text', 'image', 'video', 'audio', 'compose', 'director'],
        note: 'data 必须含 nodes 和 edges。可应用的模板 params 使用 content、prompt、title、style、camera；模型、画幅和分辨率在应用后设置。',
        fields: { nodes: [{ id: 'brief', type: 'text', x: 0, y: 0, params: { content: '拍摄要求' } },
          { id: 'result', type: 'image', x: 350, y: 0, params: {} }], edges: [{ source: 'brief', target: 'result' }] } },
      preset: { nodeTypes: ['text', 'image', 'video', 'audio'], fields: { nodeType: 'image', params: { prompt: '柔光' } } },
      node_definition: { baseTypes: ['text', 'image', 'video', 'audio'], fields: ['schemaVersion', 'baseType', 'promptTemplate', 'fields'],
        example: { schemaVersion: 1, baseType: 'image', promptTemplate: '{{subject}}，{{lighting}}',
          fields: [{ id: 'subject', label: '主体', kind: 'text', default: '陶瓷瓶' },
            { id: 'lighting', label: '光线', kind: 'enum', options: ['柔光', '侧光'], default: '柔光' }] } },
      agent_role: { profiles: ['canvas-general', 'vertical-short-drama', 'asset-assistant', 'audit-readonly'], fields: ['profile', 'tools', 'skills', 'contexts', 'instructions'], note: '角色权限只能收窄宿主权限。' },
      workflow_recipe: { fields: ['steps'], stepKinds: ['check_missing_prompt', 'arrange', 'storyboard_preview'], note: '只能引用同包内已启用组件。' },
      storyboard: { example: { fields: ['title', 'type', 'prompt', 'camera', 'content'] } },
      selection_command: { example: { command: 'arrange', orientation: 'vertical', gap: 28 } },
    }
    if (input.componentType !== undefined && !Object.hasOwn(supported, input.componentType)) throw new Error('INVALID_INPUT')
    const packages = await service.list(directory)
    const visibility = basicNodeCatalog ? await service.getBasicNodeVisibility(directory) : null
    authorize()
    return {
      ...(visibility ? { basicNodes: basicNodeCatalog(visibility.hidden) } : {}),
      ...(input.componentType ? { schema: supported[input.componentType] } : { types: Object.keys(supported) }),
      packages: packages.filter((item) => input.packageId === undefined || item.id === input.packageId)
        .map(({ id, name, description, version, source, digest, installedVersion, installedDigest, components }) => ({
          id, name, description, version, source, digest, installedVersion, installedDigest,
          components: components.filter((item) => Object.hasOwn(supported, item.type)
            && (input.componentType === undefined || input.componentType === item.type)
            && (input.componentId === undefined || input.componentId === item.id))
            .map(({ id: componentId, name: componentName, type, description: componentDescription, installed, enabled, data }) =>
              ({ id: componentId, name: componentName, type, description: componentDescription, installed, enabled,
                ...(input.componentId ? { data } : {}) })),
        })).filter((item) => item.components.length),
    }
  }
  if (action === 'result') {
    const records = await service.getCreatorOperations(directory, input.operationKey)
    const resolved = []
    for (const record of records) {
      if (['apply', 'preset_apply', 'preset_undo'].includes(record.kind) && record.status === 'prepared') {
        const known = await core('agent:lookup-operation', { projectId, canvasId, method: record.method ?? 'agent:core:save-canvas', idempotencyKey: record.operationKey })
        if (known) {
          const receipt = record.kind === 'apply' ? receiptFromKnown(record, known)
            : { applied: true, canvasVersion: known.version, targetNodeId: record.targetNodeId, changes: record.changes, generationTasksCreated: 0 }
          const operation = await service.prepareCreatorOperation(directory, record.operationKey, record.inputHash, {}, authorize)
          await service.completeCreatorOperation(directory, record.operationKey, record.inputHash, receipt)
          resolved.push({ ...operation.result, operationKey: record.operationKey, status: 'completed', receipt })
          continue
        }
        resolved.push({ ...record, status: 'uncertain' })
      } else resolved.push(record)
    }
    return { operations: resolved }
  }
  if (action === 'validate') return service.validateCreatorDraft(input.draft, true)
  if (action === 'save') return { ...await service.saveProjectDraft(directory, input.draft, {
    draftDigest: input.draftDigest, ...(input.base ? { base: input.base } : {}), operationKey, authorize: beforeCommit,
  }), operationKey }
  if (action === 'install') return { ...await service.installCreator(directory, input.packageId, input.digest, input.componentIds, beforeCommit,
    { key: operationKey, inputHash: digestValue({ action, input }), kind: action }), operationKey }
  if (action === 'enable') return { ...await service.setEnabledCreator(directory, input.packageId, input.digest, input.componentId, input.enabled, beforeCommit,
    { key: operationKey, inputHash: digestValue({ action, input }), kind: action }), operationKey }
  if (action !== 'apply') throw new Error('PERMISSION_DENIED')
  const inputHash = digestValue({ action, input })
  const existing = (await service.getCreatorOperations(directory, operationKey))[0]
  if (existing) {
    if (existing.inputHash !== inputHash || existing.kind !== 'apply') throw new Error('IDEMPOTENCY_CONFLICT')
    if (existing.status === 'completed') return { ...existing.receipt, operationKey, replayed: true }
    if (existing.status === 'failed') throw new Error('OPERATION_FAILED')
    const known = await core('agent:lookup-operation', { projectId, canvasId, method: existing.method ?? 'agent:core:save-canvas', idempotencyKey: operationKey })
    if (!known) throw new Error('OPERATION_UNCERTAIN')
    const receipt = receiptFromKnown(existing, known)
    await service.completeCreatorOperation(directory, operationKey, inputHash, receipt)
    return { ...receipt, operationKey, replayed: true }
  }
  const snapshot = await service.getInstalledSnapshot(directory, input.packageId, input.componentId)
  if (snapshot.digest !== input.digest) throw new Error('MARKETPLACE_VERSION_CONFLICT')
  if (!['template', 'node_definition'].includes(snapshot.component.type)) throw new Error('MARKETPLACE_COMPONENT_NOT_AVAILABLE')
  if (snapshot.component.type === 'template' && snapshot.component.data.nodes.some((node) => Object.keys(node.params).some((key) => MODEL_KEYS.has(key)))) {
    throw new Error('MARKETPLACE_MODEL_PARAMETERS_UNSUPPORTED')
  }
  let instance = null
  if (snapshot.component.type === 'node_definition') {
    const definition = { name: snapshot.component.name, data: snapshot.component.data }
    instance = { ref: { packageId: input.packageId, componentId: input.componentId, version: snapshot.version, digest: definitionDigest(definition) },
      snapshot: definition, values: Object.fromEntries(definition.data.fields.map((field) => [field.id, input.values?.[field.id] ?? field.default])) }
    if (input.values && Object.keys(input.values).some((key) => !Object.hasOwn(instance.values, key))) throw new Error('NODE_DEFINITION_INVALID')
    validateNodeInstance(instance, definition.data.baseType)
  }
  const isNode = snapshot.component.type === 'node_definition'
  const prepared = await service.prepareCreatorOperation(directory, operationKey, inputHash, { packageId: input.packageId, componentId: input.componentId,
    digest: input.digest, expectedVersion: input.expectedVersion, method: isNode ? 'agent:core:create-node' : 'agent:core:save-canvas',
    nodeCount: isNode ? 1 : snapshot.component.data.nodes.length, edgeCount: isNode ? 0 : snapshot.component.data.edges.length }, beforeCommit)
  if (!prepared.created) throw new Error('OPERATION_UNCERTAIN')
  let dispatched = false
  try {
    return await barrier({ projectId, canvasId, expectedVersion: input.expectedVersion }, async (version) => {
      const written = await service.withInstalledSnapshot(directory, input.packageId, input.componentId, async (latest) => {
        authorize()
        if (latest.digest !== snapshot.digest || JSON.stringify(latest.component) !== JSON.stringify(snapshot.component)) throw new Error('MARKETPLACE_VERSION_CONFLICT')
        const canvas = await core('canvas:load', { projectId, canvasId })
        if (canvas.version !== version) throw new Error('CANVAS_VERSION_CONFLICT')
        trackApply(operationKey, isNode ? 1 : snapshot.component.data.nodes.length)
        const maxX = canvas.nodes.reduce((max, node) => Math.max(max, Number(node.position?.x) || 0), -200)
        const additions = isNode ? null : graph(snapshot.component.data, { x: maxX + 360, y: 180 }, deterministicIds(operationKey))
        await reauthorize()
        authorize()
        dispatched = true
        const saved = isNode
          ? await core('canvas:create-node', { projectId, canvasId, expectedVersion: version, idempotencyKey: operationKey,
            type: snapshot.component.data.baseType, x: maxX + 360, y: 180, params: { nodeDefinition: instance } })
          : await core('canvas:save', { projectId, canvasId, expectedVersion: version, idempotencyKey: operationKey,
            nodes: [...canvas.nodes, ...additions.nodes], edges: [...canvas.edges, ...additions.edges] })
        return { saved, additions }
      })
      const { saved, additions } = written
      const readback = await core('canvas:load', { projectId, canvasId })
      const nodeIds = isNode ? [saved.node.id] : additions.nodes.map((node) => node.id)
      const edgeIds = isNode ? [] : additions.edges.map((edge) => edge.id)
      if (readback.version < saved.version || nodeIds.some((id) => !readback.nodes.some((node) => node.id === id))
        || edgeIds.some((id) => !readback.edges.some((edge) => edge.id === id))) throw new Error('OPERATION_UNCERTAIN')
      const receipt = { applied: true, canvasVersion: saved.version, nodeIds, edgeIds,
        nodeCount: nodeIds.length, edgeCount: edgeIds.length, generationTasksCreated: 0 }
      await service.completeCreatorOperation(directory, operationKey, inputHash, receipt)
      return { ...receipt, operationKey, replayed: Boolean(saved.replayed) }
    })
  } catch (error) {
    if (!dispatched) await service.failCreatorOperation(directory, operationKey, inputHash, error.message)
    throw error
  }
}
module.exports = { executeCreatorMarketplace, deterministicIds }
