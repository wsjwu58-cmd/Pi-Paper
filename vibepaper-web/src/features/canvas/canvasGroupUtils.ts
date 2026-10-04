import { sid } from '@/lib/ids'
import type { GroupPayload, NodePayload } from '@/lib/types'
import type { FlowNode } from './canvasStore'
import { textNodeContent } from './nodes/textContent'

export interface CanvasGroupBounds {
  x: number
  y: number
  width: number
  height: number
}

export type CanvasGroupOrientation = 'horizontal' | 'vertical'

function nodeSize(node: FlowNode): { width: number; height: number } {
  return {
    width: node.measured?.width ?? node.width ?? 300,
    height: node.measured?.height ?? node.height ?? 240,
  }
}

export function getCanvasGroupBounds(
  group: Pick<GroupPayload, 'nodeIds'>,
  nodes: FlowNode[],
  padding = 16,
): CanvasGroupBounds | null {
  const members = group.nodeIds
    .map((id) => nodes.find((node) => sid(node.id) === sid(id)))
    .filter((node): node is FlowNode => Boolean(node))
  if (members.length === 0) return null

  const left = Math.min(...members.map((node) => node.position.x))
  const top = Math.min(...members.map((node) => node.position.y))
  const right = Math.max(...members.map((node) => node.position.x + nodeSize(node).width))
  const bottom = Math.max(...members.map((node) => node.position.y + nodeSize(node).height))
  return {
    x: left - padding,
    y: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  }
}

/** Return only real canvas node IDs from React Flow's selection callback. */
export function canvasGroupMemberIds(
  selectedNodes: Array<{ id: string }>,
  businessNodes: FlowNode[],
): string[] {
  const existing = new Set(businessNodes.map((node) => sid(node.id)))
  return [...new Set(selectedNodes.map((node) => sid(node.id)).filter((id) => existing.has(id)))]
}

export function moveCanvasGroupNodes(
  nodes: FlowNode[],
  nodeIds: Array<string | number>,
  deltaX: number,
  deltaY: number,
): FlowNode[] {
  const memberIds = new Set(nodeIds.map(sid))
  return nodes.map((node) => memberIds.has(sid(node.id))
    ? { ...node, position: { x: node.position.x + deltaX, y: node.position.y + deltaY } }
    : node)
}

export interface CanvasGroupDownloadCandidate {
  node: NodePayload
  mediaUrl?: string
  textContent?: string
}

export function getCanvasGroupDownloadCandidates(
  group: Pick<GroupPayload, 'nodeIds'>,
  nodes: FlowNode[],
): CanvasGroupDownloadCandidate[] {
  return group.nodeIds.flatMap<CanvasGroupDownloadCandidate>((id) => {
    const flowNode = nodes.find((node) => sid(node.id) === sid(id))
    if (!flowNode) return []
    const node = flowNode.data.node
    if (node.type === 'text') {
      const textContent = textNodeContent(node.output?.text, node.params)
      return textContent ? [{ node, textContent }] : []
    }
    const params = node.params ?? {}
    const output = node.output
    const mediaUrl = String(
      params.lastOutputUrl
      || params.url
      || params.thumbnailUrl
      || params.output_url
      || (typeof output?.url === 'string' ? output.url : ''),
    )
    return mediaUrl ? [{ node, mediaUrl }] : []
  })
}

export function arrangeCanvasGroupNodes(
  nodes: FlowNode[],
  nodeIds: Array<string | number>,
  orientation: CanvasGroupOrientation,
  gap = 28,
): FlowNode[] {
  const orderedIds = nodeIds.map(sid)
  const members = orderedIds
    .map((id) => nodes.find((node) => sid(node.id) === id))
    .filter((node): node is FlowNode => Boolean(node))
  if (members.length < 2) return nodes

  const originX = Math.min(...members.map((node) => node.position.x))
  const originY = Math.min(...members.map((node) => node.position.y))
  const positions = new Map<string, { x: number; y: number }>()
  let cursor = 0
  for (const node of members) {
    positions.set(sid(node.id), orientation === 'horizontal'
      ? { x: originX + cursor, y: originY }
      : { x: originX, y: originY + cursor })
    const size = nodeSize(node)
    cursor += (orientation === 'horizontal' ? size.width : size.height) + gap
  }
  return nodes.map((node) => {
    const position = positions.get(sid(node.id))
    return position ? { ...node, position } : node
  })
}

export function applyCanvasGroupMembership(nodes: FlowNode[], group: GroupPayload): FlowNode[] {
  const memberIds = new Set(group.nodeIds.map(sid))
  return nodes.map((node) => memberIds.has(sid(node.id))
    ? { ...node, data: { ...node.data, node: { ...node.data.node, groupId: group.id } } }
    : node)
}

export function clearCanvasGroupMembership(nodes: FlowNode[], group: GroupPayload): FlowNode[] {
  const memberIds = new Set(group.nodeIds.map(sid))
  return nodes.map((node) => memberIds.has(sid(node.id)) && sid(node.data.node.groupId) === sid(group.id)
    ? { ...node, data: { ...node.data, node: { ...node.data.node, groupId: undefined } } }
    : node)
}

export function removeCanvasGroup(groups: GroupPayload[], groupId: string | number): GroupPayload[] {
  const id = sid(groupId)
  return groups.filter((group) => sid(group.id) !== id)
}
