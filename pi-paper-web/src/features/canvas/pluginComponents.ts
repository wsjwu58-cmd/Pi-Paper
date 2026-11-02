import { t as uiText } from '@/lib/i18n'
import { sid } from '@/lib/ids'
import type { DesktopProviderConfiguration, MarketplaceTemplateData } from '@/desktop/desktop-bridge'
import { defaultDesktopModelId, toAvailableDesktopModels } from '@/desktop/providerModels'
import type { Edge } from '@xyflow/react'
import type { CanvasDetail, GroupPayload, StackPayload } from '@/lib/types'
import type { FlowNode } from './canvasStore'
import { canonicalCanvasEdges } from './canvasEdges'
import { getNodeResolutionMap, getVideoDurationCapability, resolveNodeResolution } from './nodes/videoNodeParameters'

export type PluginTemplate = MarketplaceTemplateData

const nodeTypes = new Set(['text', 'image', 'video', 'audio', 'compose', 'director'])
const compatibleTargets: Record<string, string[]> = {
  text: ['text', 'image', 'video', 'audio', 'director'],
  image: ['image', 'video', 'director'],
  video: ['video', 'compose'], audio: ['audio', 'video'],
  compose: ['video', 'compose'], director: ['image', 'video'],
}
const reusableTextKeys = new Set(['title', 'prompt', 'content', 'style', 'camera'])
const specificationKeys = new Set(['model', 'aspect', 'ratio', 'size', 'resolution', 'resKey', 'duration', 'count', 'generate_audio'])
export function isPluginModelParameter(key: string): boolean { return specificationKeys.has(key) }

export function changedPluginPresetPatch(before: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => !Object.is(before[key], value)))
}

export function overwrittenPluginPresetFields(before: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((key) => before[key] !== undefined && before[key] !== null && before[key] !== '')
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function safeParams(value: unknown, includeSpecification: boolean): Record<string, unknown> {
  const input = object(value)
  if (!input) throw new Error(uiText('插件组件参数无效。'))
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(input)) {
    if (reusableTextKeys.has(key)) {
      if (typeof item !== 'string' || item.length > 20_000) throw new Error(uiText('插件组件的文本参数无效。'))
      result[key] = item
    } else if (includeSpecification && specificationKeys.has(key)) {
      result[key] = item
    } else {
      throw new Error(uiText('插件组件包含不支持的参数：{0}', { 0: key }))
    }
  }
  return result
}

/** Validate the whole graph before the first write. IDs are references within the template only. */
export function readPluginTemplate(value: unknown): PluginTemplate {
  const input = object(value)
  if (!input || !Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > 20 || !Array.isArray(input.edges) || input.edges.length > 100) {
    throw new Error(uiText('模板节点或连线数量无效。'))
  }
  const ids = new Map<string, string>()
  const nodes = input.nodes.map((raw) => {
    const node = object(raw)
    if (!node || typeof node.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(node.id) || ids.has(node.id)
      || typeof node.type !== 'string' || !nodeTypes.has(node.type)
      || typeof node.x !== 'number' || !Number.isFinite(node.x) || Math.abs(node.x) > 100_000
      || typeof node.y !== 'number' || !Number.isFinite(node.y) || Math.abs(node.y) > 100_000) {
      throw new Error(uiText('模板包含无效或重复的节点。'))
    }
    ids.set(node.id, node.type)
    return { id: node.id, type: node.type as PluginTemplate['nodes'][number]['type'], x: node.x, y: node.y, params: safeParams(node.params ?? {}, true) }
  })
  const edgeKeys = new Set<string>()
  const edges = input.edges.map((raw) => {
    const edge = object(raw)
    if (!edge || typeof edge.source !== 'string' || typeof edge.target !== 'string'
      || edge.source === edge.target || !ids.has(edge.source) || !ids.has(edge.target)
      || !compatibleTargets[ids.get(edge.source)!]?.includes(ids.get(edge.target)!)
      || (edge.sourcePort !== undefined && (typeof edge.sourcePort !== 'string' || !edge.sourcePort.trim() || edge.sourcePort.length > 80))
      || (edge.targetPort !== undefined && (typeof edge.targetPort !== 'string' || !edge.targetPort.trim() || edge.targetPort.length > 80))) {
      throw new Error(uiText('模板包含无效的连线。'))
    }
    const key = `${edge.source}\0${edge.target}`
    if (edgeKeys.has(key)) throw new Error(uiText('模板包含重复连线。'))
    edgeKeys.add(key)
    return { source: edge.source, target: edge.target,
      ...(typeof edge.sourcePort === 'string' ? { sourcePort: edge.sourcePort } : {}),
      ...(typeof edge.targetPort === 'string' ? { targetPort: edge.targetPort } : {}) }
  })
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(uiText('模板连线不能形成循环。'))
    if (visited.has(id)) return
    visiting.add(id)
    for (const edge of edges) if (edge.source === id) visit(edge.target)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids.keys()) visit(id)
  return { nodes, edges }
}

/** Model-dependent fields must be accepted by the selected, available model's current capability catalog. */
export function pluginPresetPatch(
  raw: unknown, nodeType: string, current: Record<string, unknown>, configuration: DesktopProviderConfiguration,
): Record<string, unknown> {
  const data = object(raw)
  if (!data || data.nodeType !== nodeType) throw new Error(uiText('预设与所选节点类型不匹配。'))
  const params = safeParams(data.params, true)
  const specifications = Object.keys(params).filter((key) => specificationKeys.has(key))
  if (!specifications.length) return params
  if (!['image', 'video'].includes(nodeType)) throw new Error(uiText('此节点类型的模型参数暂不支持插件预设。'))
  const currentId = typeof current.model === 'string' && current.model ? current.model : defaultDesktopModelId(configuration, nodeType)
  if ('model' in params && (typeof params.model !== 'string' || params.model !== currentId)) {
    throw new Error(uiText('请先在节点中选择预设要求的模型。'))
  }
  const model = toAvailableDesktopModels(configuration, nodeType).find((item) => item.id === currentId)
  if (!model) throw new Error(uiText('请先为该节点选择可用模型，再应用模型参数。'))
  const constraints = model.constraints ?? {}
  const defaults = model.defaultParams ?? {}
  const patch: Record<string, unknown> = { ...params }
  const ratio = params.ratio ?? params.aspect
  if (params.ratio !== undefined && params.aspect !== undefined && params.ratio !== params.aspect) throw new Error(uiText('预设比例不一致。'))
  if (ratio !== undefined) {
    const allowed = Array.isArray(constraints.acceptedAspectRatios) ? constraints.acceptedAspectRatios : [defaults.ratio]
    if (typeof ratio !== 'string' || !allowed.includes(ratio)) throw new Error(uiText('预设比例不受当前模型支持。'))
    patch.ratio = ratio
    patch.aspect = ratio
  }
  const activeRatio = typeof ratio === 'string' ? ratio : typeof current.ratio === 'string' ? current.ratio : typeof current.aspect === 'string' ? current.aspect : undefined
  const resolutions = getNodeResolutionMap(nodeType, model, true, activeRatio)
  const chosen = params.resolution ?? params.size ?? params.resKey
  const specified = [params.resolution, params.size, params.resKey].filter((item) => item !== undefined)
  if (chosen !== undefined) {
    if (typeof chosen !== 'string') throw new Error(uiText('预设分辨率无效。'))
    const entry = Object.entries(resolutions).find(([key, value]) => [key.toLowerCase(), value.toLowerCase()].includes(chosen.toLowerCase()))
    if (!entry || specified.some((item) => typeof item !== 'string' || ![entry[0].toLowerCase(), entry[1].toLowerCase()].includes(item.toLowerCase()))) {
      throw new Error(uiText('预设分辨率不受当前模型支持。'))
    }
    Object.assign(patch, resolveNodeResolution(nodeType, model, entry[0], true, activeRatio))
  } else if (ratio !== undefined && (current.resolution !== undefined || current.size !== undefined || current.resKey !== undefined)) {
    const saved = current.resolution ?? current.size ?? current.resKey
    if (typeof saved !== 'string' || !Object.entries(resolutions).some(([key, value]) => [key.toLowerCase(), value.toLowerCase()].includes(saved.toLowerCase()))) {
      throw new Error(uiText('当前分辨率与预设比例不兼容，请先调整节点。'))
    }
  }
  if (params.count !== undefined) {
    const maximum = typeof constraints.maximumOutputs === 'number' ? Math.min(4, constraints.maximumOutputs) : 1
    if (nodeType !== 'image' || !Number.isSafeInteger(params.count) || Number(params.count) < 1 || Number(params.count) > maximum) throw new Error(uiText('预设数量不受当前模型支持。'))
  }
  if (params.duration !== undefined || nodeType === 'video' && (ratio !== undefined || chosen !== undefined) && current.duration !== undefined) {
    const resolution = String(patch.resolution ?? current.resolution ?? defaults.resolution ?? '')
    const capability = getVideoDurationCapability(constraints, resolution, defaults.duration)
    const value = params.duration ?? current.duration
    const valid = nodeType === 'video' && typeof value === 'number' && Number.isFinite(value) && capability && (
      capability.kind === 'fixed' ? value === capability.value
        : capability.kind === 'discrete' ? capability.values.includes(value)
          : value >= capability.minimum && value <= capability.maximum && Math.abs((value - capability.minimum) / capability.step - Math.round((value - capability.minimum) / capability.step)) < 1e-8)
    if (!valid) throw new Error(uiText('预设时长不受当前模型支持。'))
  }
  if (params.generate_audio !== undefined && (nodeType !== 'video' || typeof params.generate_audio !== 'boolean' || constraints.supportsGenerateAudio !== true)) {
    throw new Error(uiText('预设音频选项不受当前模型支持。'))
  }
  return patch
}

/** Export only portable editable fields and edges whose endpoints are both selected. */
export function templateFromSelection(nodes: FlowNode[], edges: Edge[], ids: string[]): PluginTemplate {
  const selected = nodes.filter((node) => ids.includes(sid(node.id)) && nodeTypes.has(node.data.node.type))
  if (!selected.length) throw new Error(uiText('请先选择要保存的节点。'))
  const x = Math.min(...selected.map((node) => node.position.x))
  const y = Math.min(...selected.map((node) => node.position.y))
  const localIds = new Map(selected.map((node, index) => [sid(node.id), `node-${index + 1}`]))
  for (const node of selected) {
    for (const [key, value] of Object.entries(node.data.node.params ?? {})) {
      if (reusableTextKeys.has(key) && typeof value === 'string'
        && /(?:https?|file|vibe):\/\/|(?:[a-z]:\\|\/(?:Users|home|private|tmp)\/)/iu.test(value)) {
        throw new Error(uiText('节点文本含网址或本地路径，无法保存为可移植模板。'))
      }
    }
  }
  return readPluginTemplate({
    nodes: selected.map((node) => ({
      id: localIds.get(sid(node.id)), type: node.data.node.type,
      x: node.position.x - x, y: node.position.y - y,
      params: Object.fromEntries(Object.entries(node.data.node.params ?? {}).filter(([key, value]) => reusableTextKeys.has(key) && typeof value === 'string')),
    })),
    edges: edges.filter((edge) => localIds.has(sid(edge.source)) && localIds.has(sid(edge.target))).map((edge) => ({
      source: localIds.get(sid(edge.source)), target: localIds.get(sid(edge.target)),
      ...(edge.sourceHandle ? { sourcePort: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetPort: edge.targetHandle } : {}),
    })),
  })
}

/** Prepare a graph entirely in memory; the caller commits it in one canvas CAS. */
export function buildPluginTemplateGraph(template: PluginTemplate, origin: { x: number; y: number },
  onConfig: (id: string) => void, makeId: () => string = () => crypto.randomUUID()): { nodes: FlowNode[]; edges: Edge[] } {
  const ids = new Map(template.nodes.map((node) => [node.id, makeId()]))
  const minX = Math.min(...template.nodes.map((node) => node.x))
  const minY = Math.min(...template.nodes.map((node) => node.y))
  const nodes = template.nodes.map((node): FlowNode => {
    const id = ids.get(node.id)!
    const x = origin.x + node.x - minX
    const y = origin.y + node.y - minY
    return { id, type: node.type, position: { x, y }, data: {
      node: { id, type: node.type, x, y, params: { ...node.params }, status: 'idle' },
      selected: false, onConfig, models: [],
    } }
  })
  const edges = template.edges.map((edge): Edge => ({
    id: makeId(), source: ids.get(edge.source)!, target: ids.get(edge.target)!,
    sourceHandle: edge.sourcePort ?? 'output', targetHandle: edge.targetPort ?? 'input',
    style: { stroke: '#93c5fd', strokeWidth: 1.5 }, data: { valid: true },
  }))
  return { nodes, edges }
}

export interface PluginGraphSnapshot {
  canvas: CanvasDetail | null
  nodes: FlowNode[]
  edges: Edge[]
  groups: GroupPayload[]
  stacks: StackPayload[]
}

/** Perform one atomic save and merge only the new graph into any edits made while it was pending. */
export async function commitPluginTemplateGraph(input: {
  canvasId: string
  snapshot: PluginGraphSnapshot
  additions: { nodes: FlowNode[]; edges: Edge[] }
  save: (nodes: FlowNode[], edges: Edge[]) => Promise<{ version: number; staleNodeIds: string[] }>
  getCurrent: () => PluginGraphSnapshot
  apply: (result: { current: PluginGraphSnapshot; nodes: FlowNode[]; edges: Edge[]; version: number; staleNodeIds: string[]; dirty: boolean }) => void
}): Promise<boolean> {
  const { snapshot, additions } = input
  const submittedNodes = [...snapshot.nodes, ...additions.nodes]
  const result = await input.save(submittedNodes, canonicalCanvasEdges(submittedNodes, [...snapshot.edges, ...additions.edges]))
  const current = input.getCurrent()
  if (!current.canvas || sid(current.canvas.canvas.id) !== input.canvasId) return false
  const unchanged = current.nodes === snapshot.nodes && current.edges === snapshot.edges
    && current.groups === snapshot.groups && current.stacks === snapshot.stacks
  const nodes = [...current.nodes, ...additions.nodes]
  input.apply({ current, nodes, edges: canonicalCanvasEdges(nodes, [...current.edges, ...additions.edges]),
    version: Math.max(current.canvas.canvas.version, result.version), staleNodeIds: result.staleNodeIds, dirty: !unchanged })
  return true
}
