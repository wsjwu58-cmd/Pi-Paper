import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { CanvasDetail, GroupPayload, NodePayload } from '@/lib/types'
import { createCanvasGroup, removeCanvasGroupFromStore, useCanvasStore, type FlowNode } from './canvasStore'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const mockedApi = vi.mocked(api)

function flowNode(id: string): FlowNode {
  const node: NodePayload = { id, type: 'image', params: {}, status: 'idle' }
  return {
    id,
    type: 'image',
    position: { x: 10, y: 20 },
    data: { node, selected: false, onConfig: () => undefined, models: [] },
  }
}

function resetStore(nodeIds = ['node-a', 'node-b']) {
  const detail = { canvas: { id: 'canvas-1', version: 1 } } as unknown as CanvasDetail
  useCanvasStore.setState({
    canvas: detail,
    nodes: nodeIds.map(flowNode),
    groups: [],
    dirty: false,
    selectedGroupId: null,
  })
}

describe('canvas group store commands', () => {
  beforeEach(() => {
    mockedApi.mockReset()
    resetStore()
  })

  it('creates an API group from existing nodes and updates local memberships', async () => {
    mockedApi.mockResolvedValueOnce({
      id: 'group-1',
      name: '编组',
      color: '#8b5cf6',
      layout: 'free',
      nodeIds: ['node-a', 'node-b'],
    })
    mockedApi.mockResolvedValueOnce({
      id: 'group-1',
      name: '裁剪结果',
      color: '#8b5cf6',
      layout: 'free',
      nodeIds: ['node-a', 'node-b'],
    })

    const created = await createCanvasGroup(['node-a', 'node-b', 'group-1'], { name: '裁剪结果' })

    expect(created?.name).toBe('裁剪结果')
    expect(mockedApi).toHaveBeenNthCalledWith(1, '/canvases/canvas-1/groups', expect.objectContaining({ method: 'POST' }))
    expect(useCanvasStore.getState().groups).toEqual([created])
    expect(useCanvasStore.getState().nodes.map((node) => node.data.node.groupId)).toEqual(['group-1', 'group-1'])
    expect(useCanvasStore.getState().dirty).toBe(false)
  })

  it('reuses a group when the same nodes are selected again', async () => {
    mockedApi.mockResolvedValueOnce({
      id: 'group-1',
      name: '编组',
      color: '#8b5cf6',
      layout: 'free',
      nodeIds: ['node-a', 'node-b'],
    })

    const first = await createCanvasGroup(['node-a', 'node-b'])
    const second = await createCanvasGroup(['node-b', 'node-a'])

    expect(second).toEqual(first)
    expect(mockedApi).toHaveBeenCalledTimes(1)
    expect(useCanvasStore.getState().groups).toHaveLength(1)
    expect(useCanvasStore.getState().selectedGroupId).toBe('group-1')
  })

  it('does not apply a pending group to the store after the canvas changes', async () => {
    let resolveAddGroup!: (group: GroupPayload) => void
    const bridge = {
      getActiveProject: vi.fn().mockResolvedValue({ projectId: 'project-1', canvasId: 'canvas-1' }),
      addGroup: vi.fn(() => new Promise<GroupPayload>((resolve) => { resolveAddGroup = resolve })),
    }
    vi.stubGlobal('window', { vibepaperDesktop: bridge })
    try {
      const pending = createCanvasGroup(['node-a', 'node-b'])
      await vi.waitFor(() => expect(bridge.addGroup).toHaveBeenCalledTimes(1))
      const newCanvas = { canvas: { id: 'canvas-2', version: 1 } } as unknown as CanvasDetail
      useCanvasStore.setState({ canvas: newCanvas, nodes: [flowNode('new-a'), flowNode('new-b')], groups: [], dirty: false })
      resolveAddGroup({ id: 'group-old', name: '编组', color: '#8b5cf6', layout: 'free', nodeIds: ['node-a', 'node-b'] })

      await expect(pending).rejects.toThrow('画布已切换')
      expect(useCanvasStore.getState().canvas?.canvas.id).toBe('canvas-2')
      expect(useCanvasStore.getState().groups).toEqual([])
      expect(useCanvasStore.getState().nodes.map((node) => node.data.node.groupId)).toEqual([undefined, undefined])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('persists a crop singleton through the full canvas snapshot path', async () => {
    resetStore(['crop-node'])

    const created = await createCanvasGroup(['crop-node'], { allowSingle: true, name: '单图裁剪' })

    expect(created?.nodeIds).toEqual(['crop-node'])
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/iu)
    expect(mockedApi).not.toHaveBeenCalled()
    expect(useCanvasStore.getState().groups).toEqual([created])
    expect(useCanvasStore.getState().nodes[0].data.node.groupId).toBe(created?.id)
    expect(useCanvasStore.getState().dirty).toBe(true)
  })

  it('requires two members for marquee groups and clears membership when a group is removed', async () => {
    resetStore(['single-node'])
    expect(await createCanvasGroup(['single-node'])).toBeNull()
    expect(useCanvasStore.getState().groups).toEqual([])

    const group = await createCanvasGroup(['single-node'], { allowSingle: true })
    expect(group).not.toBeNull()
    removeCanvasGroupFromStore(group!)
    expect(useCanvasStore.getState().groups).toEqual([])
    expect(useCanvasStore.getState().nodes[0].data.node.groupId).toBeUndefined()
  })
})
