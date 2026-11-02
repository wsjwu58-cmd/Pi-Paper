import type { MarketplaceTemplateData } from '@/desktop/desktop-bridge'

/** Shared data-only mapping used by the canvas and the trusted desktop host. */
export function portableTemplateGraph(template: MarketplaceTemplateData, origin: { x: number; y: number }, makeId: () => string) {
  const ids = new Map(template.nodes.map((node) => [node.id, makeId()]))
  const minX = Math.min(...template.nodes.map((node) => node.x))
  const minY = Math.min(...template.nodes.map((node) => node.y))
  const nodes = template.nodes.map((node) => {
    const id = ids.get(node.id)!
    const x = origin.x + node.x - minX
    const y = origin.y + node.y - minY
    return { id, type: node.type, position: { x, y }, data: {
      node: { id, type: node.type, x, y, params: { ...node.params }, status: 'idle' },
      selected: false, models: [],
    } }
  })
  const edges = template.edges.map((edge) => ({
    id: makeId(), source: ids.get(edge.source)!, target: ids.get(edge.target)!,
    sourceHandle: edge.sourcePort ?? 'output', targetHandle: edge.targetPort ?? 'input',
    style: { stroke: '#93c5fd', strokeWidth: 1.5 }, data: { valid: true },
  }))
  return { nodes, edges }
}

// The desktop host and original canvas consume the same command definitions.
export { CREATIVE_COMMAND_DESCRIPTORS, getCreativeCommandDescriptor, describeCreativeCommands, previewCreativeCommand } from './creativeCommandCatalog'
