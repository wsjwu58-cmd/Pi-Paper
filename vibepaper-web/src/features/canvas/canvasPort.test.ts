import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { FlowNode } from './canvasStore'

let applySavedCanvasStaleNodeIds: typeof import('./canvasPort').applySavedCanvasStaleNodeIds

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  ;({ applySavedCanvasStaleNodeIds } = await import('./canvasPort'))
})

function flowNode(id: string, execStatus: string): FlowNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      node: { id, type: 'image', params: {}, status: execStatus, execStatus },
      selected: false,
      onConfig: () => undefined,
      models: [],
    },
  }
}

describe('applySavedCanvasStaleNodeIds', () => {
  it('immediately marks saved stale descendants and preserves protected task states', () => {
    const running = flowNode('running', 'running')
    const succeeded = flowNode('succeeded', 'succeeded')
    const idle = flowNode('idle', 'idle')
    const untouched = flowNode('untouched', 'ready')
    const nodes = [running, succeeded, idle, untouched]

    const updated = applySavedCanvasStaleNodeIds(
      nodes,
      ['running', 'succeeded', 'idle', 'missing'],
    )

    expect(updated[0].data.node).toMatchObject({ stale: true, execStatus: 'running' })
    expect(updated[1].data.node).toMatchObject({ stale: true, execStatus: 'succeeded' })
    expect(updated[2].data.node).toMatchObject({ stale: true, execStatus: 'stale' })
    expect(updated[3]).toBe(untouched)
    expect(updated).not.toBe(nodes)
  })

  it('preserves the original nodes array when the receipt has no matching node', () => {
    const nodes = [flowNode('one', 'idle')]
    expect(applySavedCanvasStaleNodeIds(nodes, ['missing'])).toBe(nodes)
    expect(applySavedCanvasStaleNodeIds(nodes, [])).toBe(nodes)
  })
})
