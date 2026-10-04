import { describe, expect, it } from 'vitest'
import type { GroupPayload, NodePayload } from '@/lib/types'
import type { FlowNode } from './canvasStore'
import {
  applyCanvasGroupMembership,
  arrangeCanvasGroupNodes,
  canvasGroupMemberIds,
  clearCanvasGroupMembership,
  getCanvasGroupBounds,
  getCanvasGroupDownloadCandidates,
  moveCanvasGroupNodes,
  removeCanvasGroup,
} from './canvasGroupUtils'

function flowNode(
  id: string,
  x: number,
  y: number,
  width = 300,
  height = 240,
  params: Record<string, unknown> = {},
  groupId?: string,
): FlowNode {
  const node: NodePayload = { id, type: 'image', params, status: 'idle', ...(groupId ? { groupId } : {}) }
  return {
    id,
    type: 'image',
    position: { x, y },
    measured: { width, height },
    data: { node, selected: false, onConfig: () => undefined, models: [] },
  }
}

const group: GroupPayload = {
  id: 'group-1',
  name: '裁剪结果',
  color: '#8b5cf6',
  layout: 'free',
  nodeIds: ['node-a', 'node-b'],
}

describe('canvas group view helpers', () => {
  it('uses measured member dimensions for the dashed frame bounds', () => {
    const nodes = [flowNode('node-a', 10, 20, 320, 180), flowNode('node-b', 380, 230, 260, 310)]

    expect(getCanvasGroupBounds(group, nodes, 16)).toEqual({ x: -6, y: 4, width: 662, height: 552 })
    expect(getCanvasGroupBounds({ nodeIds: ['missing'] }, nodes)).toBeNull()
  })

  it('filters React Flow synthetic selections out of group memberships', () => {
    const nodes = [flowNode('node-a', 0, 0), flowNode('node-b', 0, 0)]

    expect(canvasGroupMemberIds([
      { id: 'group-1' },
      { id: 'stack-badge-stack-1' },
      { id: 'node-a' },
      { id: 'node-a' },
      { id: 'missing-node' },
      { id: 'node-b' },
    ], nodes)).toEqual(['node-a', 'node-b'])
  })

  it('moves all group members together while leaving other nodes untouched', () => {
    const nodes = [flowNode('node-a', 10, 20), flowNode('node-b', 100, 120), flowNode('outside', 800, 700)]
    const moved = moveCanvasGroupNodes(nodes, group.nodeIds, -5, 12)

    expect(moved.map((node) => node.position)).toEqual([
      { x: 5, y: 32 },
      { x: 95, y: 132 },
      { x: 800, y: 700 },
    ])
    expect(moved[2]).toBe(nodes[2])
  })

  it('arranges group members horizontally or vertically in group order', () => {
    const nodes = [flowNode('node-a', 220, 330, 200, 100), flowNode('node-b', 80, 90, 120, 150), flowNode('outside', 900, 900)]
    const horizontal = arrangeCanvasGroupNodes(nodes, ['node-b', 'node-a'], 'horizontal', 20)
    const vertical = arrangeCanvasGroupNodes(nodes, ['node-b', 'node-a'], 'vertical', 10)

    expect(horizontal[0].position).toEqual({ x: 220, y: 90 })
    expect(horizontal[1].position).toEqual({ x: 80, y: 90 })
    expect(vertical[0].position).toEqual({ x: 80, y: 250 })
    expect(vertical[1].position).toEqual({ x: 80, y: 90 })
    expect(horizontal[2]).toBe(nodes[2])
    expect(vertical[2]).toBe(nodes[2])
  })

  it('adds and clears only this group membership, and removes the group entry', () => {
    const nodes = [flowNode('node-a', 0, 0), flowNode('node-b', 0, 0), flowNode('outside', 0, 0, 300, 240, {}, 'other-group')]
    const added = applyCanvasGroupMembership(nodes, group)
    const cleared = clearCanvasGroupMembership(added, group)

    expect(added.map((node) => node.data.node.groupId)).toEqual(['group-1', 'group-1', 'other-group'])
    expect(cleared.map((node) => node.data.node.groupId)).toEqual([undefined, undefined, 'other-group'])
    expect(removeCanvasGroup([group, { ...group, id: 'other' }], group.id).map((item) => item.id)).toEqual(['other'])
  })

  it('downloads only actual group members with an available text or media result', () => {
    const text = { ...flowNode('text', 0, 0), data: { ...flowNode('text', 0, 0).data, node: { ...flowNode('text', 0, 0).data.node, type: 'text', params: { lastOutputText: 'hello' } } } }
    const image = { ...flowNode('image', 0, 0), data: { ...flowNode('image', 0, 0).data, node: { ...flowNode('image', 0, 0).data.node, params: { lastOutputUrl: 'https://example.test/result.png' } } } }
    const empty = flowNode('empty', 0, 0)
    const candidates = getCanvasGroupDownloadCandidates({ nodeIds: ['text', 'image', 'empty', 'missing'] }, [text, image, empty])

    expect(candidates).toEqual([
      { node: text.data.node, textContent: 'hello' },
      { node: image.data.node, mediaUrl: 'https://example.test/result.png' },
    ])
  })
})
