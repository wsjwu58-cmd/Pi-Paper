import type { Edge } from '@xyflow/react'
import type { NodePayload } from '@/lib/types'
import type { FlowNode } from './canvasStore'
import type { PosterLayout } from './creativePluginTypes'
import { canonicalCanvasEdges } from './canvasEdges'

// desktopNodePayload gives data.params precedence when a mirror exists.
const savedParams = (node: FlowNode) => node.data.params ?? node.data.node.params

/** Keep the renderer's mirrored parameters aligned with the node payload used for saves. */
export function withPosterLayout(node: FlowNode, layout: PosterLayout): FlowNode {
  const params = { ...savedParams(node), posterLayout: layout }
  return { ...node, data: { ...node.data, params, node: { ...node.data.node, params } } }
}

/** Keep edits made while the CAS was pending; never attach an old render to a changed source. */
export function mergePosterResult(input: {
  nodes: FlowNode[]; edges: Edge[]; source: FlowNode; sourceUrl: string
  output: FlowNode; edge: Edge; layout: PosterLayout
  mediaUrl: (node: NodePayload) => string
}) {
  const currentSource = input.nodes.find((item) => String(item.id) === String(input.source.id))
  const sourceRetained = Boolean(currentSource && input.mediaUrl({ ...currentSource.data.node, params: savedParams(currentSource) }) === input.sourceUrl
    && JSON.stringify(savedParams(currentSource).posterLayout) === JSON.stringify(savedParams(input.source).posterLayout))
  const nodes = [...input.nodes.map((item) => item === currentSource && sourceRetained
    ? withPosterLayout(item, input.layout) : item), input.output]
  const edges = canonicalCanvasEdges(nodes, [...input.edges, ...(sourceRetained ? [input.edge] : [])])
  return { nodes, edges, sourceRetained }
}
