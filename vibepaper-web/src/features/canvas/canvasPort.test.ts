import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Node } from '@xyflow/react'
import type { FlowNode } from './canvasStore'

let applySavedCanvasStaleNodeIds: typeof import('./canvasPort').applySavedCanvasStaleNodeIds
let desktopNodePayload: typeof import('./canvasPort').desktopNodePayload
let deleteCanvasEdgePort: typeof import('./canvasPort').deleteCanvasEdgePort
let useCanvasStore: typeof import('./canvasStore').useCanvasStore

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  ;({ applySavedCanvasStaleNodeIds, desktopNodePayload, deleteCanvasEdgePort } = await import('./canvasPort'))
  ;({ useCanvasStore } = await import('./canvasStore'))
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

describe('desktop node payload synchronization', () => {
  it('mirrors task status and currentOutputId into the fields read by desktop saves', () => {
    const initial = flowNode('node-1', 'succeeded')
    initial.data.node.currentOutputId = 'task-old'
    useCanvasStore.setState({ nodes: [initial], dirty: false })

    useCanvasStore.getState().updateNodePayload('node-1', {
      currentOutputId: 'task-new',
      status: 'running',
      execStatus: 'running',
    })

    const updated = useCanvasStore.getState().nodes[0]
    expect(updated.data.node).toMatchObject({ currentOutputId: 'task-new', status: 'running', execStatus: 'running' })
    expect(desktopNodePayload(updated as Node)).toMatchObject({
      currentOutputId: 'task-new',
      status: 'running',
      execStatus: 'running',
    })
    expect(useCanvasStore.getState().dirty).toBe(true)
  })
})

describe('canvas edge deletion port', () => {
  it('deletes through the local authority when running in the desktop renderer', async () => {
    const bridge = { deleteEdge: vi.fn().mockResolvedValue({ status: 'ok' }) }
    vi.stubGlobal('window', { vibepaperDesktop: bridge, location: { protocol: 'vibe:' } })
    try {
      await deleteCanvasEdgePort({ projectId: 'project-1', canvasId: 'canvas-1', edgeId: 'edge-1' })

      expect(bridge.deleteEdge).toHaveBeenCalledWith({
        projectId: 'project-1',
        canvasId: 'canvas-1',
        edgeId: 'edge-1',
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
