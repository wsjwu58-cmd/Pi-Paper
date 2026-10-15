import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { canonicalCanvasEdges } from './canvasEdges'

function edge(
  id: string,
  source: string,
  target: string,
  dependencyType = 'reference',
  valid = true,
): Edge {
  return {
    id,
    source,
    target,
    data: { valid, edge: { dependencyType, valid } },
  }
}

const nodes: Pick<Node, 'id'>[] = [{ id: 'source' }, { id: 'target' }]

describe('canonicalCanvasEdges', () => {
  it('keeps one edge when connectEdge replays the same authoritative edge id', () => {
    const replay = edge('edge-1', 'source', 'target')
    const canonical = canonicalCanvasEdges(nodes, [replay, { ...replay }])

    expect(canonical).toEqual([replay])
    expect(canonical[0]).toBe(replay)
  })

  it('drops dangling references while preserving connected edges', () => {
    const connected = edge('edge-ok', 'source', 'target')

    expect(canonicalCanvasEdges(nodes, [
      edge('missing-source', 'gone', 'target'),
      edge('missing-target', 'source', 'gone'),
      connected,
    ])).toEqual([connected])
  })

  it('preserves domain-invalid edges for repair instead of rewriting business validity', () => {
    const invalid = edge('edge-invalid', 'source', 'target', 'reference', false)

    expect(canonicalCanvasEdges(nodes, [invalid])).toEqual([invalid])
    expect((canonicalCanvasEdges(nodes, [invalid])[0].data as { valid: boolean }).valid).toBe(false)
  })
})
