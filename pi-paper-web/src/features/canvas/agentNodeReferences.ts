import type { NodePayload } from '@/lib/types'
import type { AgentNodeReference } from './agentTypes'
import type { FlowNode } from './canvasStore'

const MAX_TEXT_LENGTH = 4_000
const MAX_PROMPT_LENGTH = 2_000
const MAX_URL_LENGTH = 2_048
const MAX_LABEL_LENGTH = 240

export type ComposerRef = {
  id: string
  kind: 'node' | 'skill'
  nodeType?: string
  title: string
}

export function refFromNode(node: NodePayload): ComposerRef {
  const params = node.params || {}
  const title = boundedString(params.title, MAX_LABEL_LENGTH) || node.creativeType || node.type || '节点'
  return { id: String(node.id), kind: 'node', nodeType: node.type, title }
}

export function upsertRefs(list: ComposerRef[], add: ComposerRef[], cap = 8): ComposerRef[] {
  const out = [...list]
  for (const item of add) {
    if (!item.id) continue
    const index = out.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id)
    if (index >= 0) out[index] = { ...out[index], ...item }
    else out.push(item)
  }
  return out.slice(-cap)
}

export function newlySelectedComposerRefs(
  nodes: readonly FlowNode[],
  previousSelectedIds: ReadonlySet<string>,
): { selectedIds: Set<string>; added: ComposerRef[] } {
  const selectedIds = new Set<string>()
  const added: ComposerRef[] = []
  for (const flowNode of nodes) {
    if (!flowNode.selected) continue
    const id = String(flowNode.data.node.id ?? flowNode.id)
    selectedIds.add(id)
    if (!previousSelectedIds.has(id)) added.push(refFromNode(flowNode.data.node))
  }
  return { selectedIds, added }
}

export function nodeReferencesForComposer(
  refs: readonly ComposerRef[],
  nodes: readonly FlowNode[],
): AgentNodeReference[] {
  const nodeById = new Map<string, NodePayload>()
  for (const flowNode of nodes) {
    nodeById.set(String(flowNode.data.node.id), flowNode.data.node)
    nodeById.set(String(flowNode.id), flowNode.data.node)
  }

  const references: AgentNodeReference[] = []
  for (const ref of refs) {
    if (ref.kind !== 'node') continue
    const node = nodeById.get(ref.id)
    references.push(node ? nodeReferenceFromNode(node) : fallbackReference(ref))
  }
  return references
}

export function consumeSentNodeRefs(
  refs: readonly ComposerRef[],
  sentNodeIds: ReadonlySet<string>,
): ComposerRef[] {
  return refs.filter((ref) => ref.kind !== 'node' || !sentNodeIds.has(ref.id))
}

export function nodeReferenceFromNode(node: NodePayload): AgentNodeReference {
  const params = node.params || {}
  const output = node.output || {}
  const creativeType = boundedString(node.creativeType, MAX_LABEL_LENGTH)
  const nodeType = boundedString(node.type, MAX_LABEL_LENGTH) || 'unknown'
  const title = boundedString(params.title, MAX_LABEL_LENGTH) || creativeType || nodeType || '节点'
  const status = boundedString(node.status, MAX_LABEL_LENGTH) || 'ready'
  const previewUrl = firstBoundedString(
    [output.url, params.lastOutputUrl, params.url, params.thumbnailUrl, params.imageUrl],
    MAX_URL_LENGTH,
  )
  const textContent = firstBoundedString(
    [output.text, output.content, params.lastOutputText, params.content, params.text],
    MAX_TEXT_LENGTH,
  )
  const prompt = firstBoundedString([node.prompt, params.prompt], MAX_PROMPT_LENGTH)

  return {
    nodeId: String(node.id),
    nodeType,
    ...(creativeType ? { creativeType } : {}),
    title,
    status,
    ...(previewUrl ? { previewUrl } : {}),
    ...(textContent ? { textContent } : {}),
    ...(prompt ? { prompt } : {}),
  }
}

function fallbackReference(ref: ComposerRef): AgentNodeReference {
  return {
    nodeId: ref.id,
    nodeType: ref.nodeType || 'unknown',
    title: ref.title || '节点',
    status: 'ready',
  }
}

function firstBoundedString(values: readonly unknown[], maxLength: number): string | undefined {
  for (const value of values) {
    const normalized = boundedString(value, maxLength)
    if (normalized) return normalized
  }
  return undefined
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const normalized = String(value).replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}
