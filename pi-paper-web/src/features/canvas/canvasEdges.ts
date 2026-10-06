import type { Edge, Node } from '@xyflow/react'

/**
 * Remove stale view duplicates and dangling references before saving a snapshot.
 * Domain validation (including endpoint compatibility) stays in the canvas core;
 * persisted invalid edges remain visible here so the user can repair them.
 */
export function canonicalCanvasEdges(nodes: Pick<Node, 'id'>[], edges: Edge[]): Edge[] {
  const nodeIds = new Set(nodes.map((node) => String(node.id)))
  const ids = new Set<string>()
  const connections = new Set<string>()
  return edges.filter((edge) => {
    if (!edge.id || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return false
    const data = edge.data as { edge?: { dependencyType?: string } } | undefined
    const key = JSON.stringify([edge.source, edge.sourceHandle ?? 'output', edge.target, edge.targetHandle ?? 'input', data?.edge?.dependencyType ?? 'reference'])
    if (ids.has(edge.id) || connections.has(key)) return false
    ids.add(edge.id)
    connections.add(key)
    return true
  })
}
