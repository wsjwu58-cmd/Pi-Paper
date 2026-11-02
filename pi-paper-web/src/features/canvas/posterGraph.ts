import type { Edge } from '@xyflow/react'
import type { NodePayload } from '@/lib/types'
import type { FlowNode } from './canvasStore'
import type { PosterLayout } from './creativePluginTypes'
import { canonicalCanvasEdges } from './canvasEdges'

/** Keep edits made while the CAS was pending; never attach an old render to a changed source. */
export function mergePosterResult(input: {
  nodes: FlowNode[]; edges: Edge[]; source: FlowNode; sourceUrl: string
  output: FlowNode; edge: Edge; layout: PosterLayout
  mediaUrl: (node: NodePayload) => string
}) {
  const currentSource = input.nodes.find((item) => String(item.id) === String(input.source.id))
  const sourceRetained = Boolean(currentSource && input.mediaUrl(currentSource.data.node) === input.sourceUrl
    && JSON.stringify(currentSource.data.node.params.posterLayout) === JSON.stringify(input.source.data.node.params.posterLayout))
  const nodes = [...input.nodes.map((item) => item === currentSource && sourceRetained
    ? { ...item, data: { ...item.data, node: { ...item.data.node, params: { ...item.data.node.params, posterLayout: input.layout } } } } : item), input.output]
  const edges = canonicalCanvasEdges(nodes, [...input.edges, ...(sourceRetained ? [input.edge] : [])])
  return { nodes, edges, sourceRetained }
}
