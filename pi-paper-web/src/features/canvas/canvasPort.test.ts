import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Node } from '@xyflow/react'
import type { FlowNode } from './canvasStore'
import { promptEditPatch } from './nodes/promptEdit'

let applySavedCanvasStaleNodeIds: typeof import('./canvasPort').applySavedCanvasStaleNodeIds
let desktopNodePayload: typeof import('./canvasPort').desktopNodePayload
let deleteCanvasEdgePort: typeof import('./canvasPort').deleteCanvasEdgePort
let createCanvasNodePort: typeof import('./canvasPort').createCanvasNodePort
let importedAssetNodePayload: typeof import('./canvasPort').importedAssetNodePayload
let useCanvasStore: typeof import('./canvasStore').useCanvasStore

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  ;({ applySavedCanvasStaleNodeIds, desktopNodePayload, deleteCanvasEdgePort, createCanvasNodePort, importedAssetNodePayload } = await import('./canvasPort'))
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

  it('preserves the local core asset parameters when a poster edit saves the canvas', async () => {
    const asset = { id: 'asset-1', assetType: 'image', name: 'source.png', url: 'vibe://app/assets/asset-1' }
    const params = { assetId: asset.id, name: asset.name, url: asset.url, prompt: '', model: 'image-binding', custom: { strength: 0.5 } }
    const payload = { id: 'node-1', type: 'image', x: 42, y: 84, params, status: 'idle', modelRef: 'image-binding' }
    const bridge = { createNode: vi.fn().mockResolvedValue({ node: { id: payload.id, type: payload.type,
      position: { x: 42, y: 84 }, data: { node: payload, params, status: 'idle', modelRef: 'image-binding' } }, version: 2 }) }
    vi.stubGlobal('window', { vibepaperDesktop: bridge, location: { protocol: 'vibe:' } })
    try {
      const created = await createCanvasNodePort({ projectId: 'project-1', canvasId: 'canvas-1', expectedVersion: 1,
        type: 'image', x: 42, y: 84, params: { assetId: asset.id, name: asset.name, url: asset.url, prompt: '' } })
      const imported = importedAssetNodePayload(created, asset, 42, 84)
      expect(imported.params).toEqual(params)
      expect(imported.modelRef).toBe('image-binding')
      const edited = { ...imported, params: { ...imported.params, posterLayout: { width: 1200, height: 1500 } } }
      const toSave = desktopNodePayload({ id: created.id, type: 'image', position: { x: 42, y: 84 }, data: { node: edited } } as Node)
      expect(toSave.params).toEqual({ ...params, posterLayout: { width: 1200, height: 1500 } })
      expect(toSave.prompt).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retains the existing Web asset payload when the legacy create API only returns an ID', () => {
    const asset = { id: 'asset-1', assetType: 'image', name: 'source.png', url: '/assets/asset-1' }
    expect(importedAssetNodePayload({ id: 'web-1' }, asset, 42, 84)).toEqual({ id: 'web-1', type: 'image', x: 42, y: 84,
      params: { assetId: 'asset-1', name: 'source.png', url: '/assets/asset-1' }, status: 'idle' })
  })

  it('keeps a desktop source prompt synchronized through a poster save without changing Web edits', async () => {
    const { withPosterLayout } = await import('./posterGraph')
    const initial = flowNode('source', 'idle')
    initial.data.node.params = { assetId: 'asset-1', prompt: '', model: 'image-binding' }
    initial.data.node.prompt = ''
    useCanvasStore.setState({ nodes: [initial], dirty: false })
    const text = '原图提示词：保留棚拍背景'
    useCanvasStore.getState().updateNodePayload('source', promptEditPatch(initial.data.node.params, text, true))
    const edited = useCanvasStore.getState().nodes[0]
    const layout = { width: 1200, height: 1500, background: '#f3f0ea', image: { x: 80, y: 80, width: 920, height: 960, fit: 'contain' as const },
      title: { text: 'LOCAL POSTER', x: 100, y: 1190, size: 72, color: '#252525' } }
    const toSave = desktopNodePayload(withPosterLayout(edited, layout))
    expect(toSave.prompt).toBe(text)
    expect(toSave.params).toEqual({ assetId: 'asset-1', prompt: text, model: 'image-binding', posterLayout: layout })
    expect(promptEditPatch(initial.data.node.params, text, false)).toEqual({ params: { assetId: 'asset-1', prompt: text, model: 'image-binding' } })
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
