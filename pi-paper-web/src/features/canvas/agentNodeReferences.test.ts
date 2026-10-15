import { describe, expect, it } from 'vitest'
import type { FlowNode } from './canvasStore'
import {
  consumeSentNodeRefs,
  newlySelectedComposerRefs,
  nodeReferencesForComposer,
  type ComposerRef,
} from './agentNodeReferences'

function flowNode(
  id: string,
  type: string,
  params: Record<string, unknown>,
  selected = false,
): FlowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    selected,
    data: {
      node: { id, type, params, status: 'ready' },
      selected,
      onConfig: () => undefined,
      models: [],
    },
  } as FlowNode
}

describe('agent node references', () => {
  it('builds immutable message references in composer order', () => {
    const nodes = [
      flowNode('11', 'text', { title: '分镜表：第 1 集', content: '第一镜：雨夜' }),
      flowNode('12', 'image', { title: '橘猫角色卡', lastOutputUrl: '/outputs/file/cat.png' }),
    ]
    const refs: ComposerRef[] = [
      { id: '12', kind: 'node', nodeType: 'image', title: '橘猫角色卡' },
      { id: 'skill:x', kind: 'skill', title: 'x' },
    ]

    expect(nodeReferencesForComposer(refs, nodes)).toEqual([
      {
        nodeId: '12',
        nodeType: 'image',
        title: '橘猫角色卡',
        status: 'ready',
        previewUrl: '/outputs/file/cat.png',
      },
    ])
  })

  it('adds only false-to-true selection transitions', () => {
    const nodes = [flowNode('11', 'text', { title: '分镜表' }, true)]

    expect(newlySelectedComposerRefs(nodes, new Set()).added).toMatchObject([{ id: '11', kind: 'node' }])
    expect(newlySelectedComposerRefs(nodes, new Set(['11'])).added).toEqual([])
    expect(newlySelectedComposerRefs(nodes, new Set()).selectedIds).toEqual(new Set(['11']))
  })

  it('consumes only node references sent in the accepted turn', () => {
    const refs: ComposerRef[] = [
      { id: '11', kind: 'node', title: '旧节点' },
      { id: 'skill:x', kind: 'skill', title: 'x' },
      { id: '12', kind: 'node', title: '发送期间新节点' },
    ]

    expect(consumeSentNodeRefs(refs, new Set(['11']))).toEqual([
      { id: 'skill:x', kind: 'skill', title: 'x' },
      { id: '12', kind: 'node', title: '发送期间新节点' },
    ])
  })
})
