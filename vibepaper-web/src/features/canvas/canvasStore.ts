import { create } from 'zustand'
import type { Edge, Node } from '@xyflow/react'
import { api } from '@/lib/api'
import { sid } from '@/lib/ids'
import type { CanvasDetail, EdgePayload, GroupPayload, Id, NodePayload, StackPayload } from '@/lib/types'
import { applyCanvasGroupMembership, clearCanvasGroupMembership } from './canvasGroupUtils'

export interface CreateCanvasGroupOptions {
  name?: string
  color?: string
  layout?: 'free' | 'grid' | 'horizontal'
  /** The normal group command requires two members; local crop groups may contain one. */
  allowSingle?: boolean
}

export interface FlowNode extends Node {
  data: {
    node: NodePayload
    selected: boolean
    onConfig: (nodeId: string) => void
    models: import('@/lib/types').ModelInfo[]
  }
}

interface CanvasState {
  canvas: CanvasDetail | null
  nodes: FlowNode[]
  edges: Edge[]
  groups: GroupPayload[]
  stacks: StackPayload[]
  dirty: boolean
  saving: boolean
  selectedNodeId: string | null
  selectedGroupId: string | null
  /** 双击进入节点编辑（文本等） */
  editingNodeId: string | null
  agentOpen: boolean
  agentPanelWidth: number
  assetOpen: boolean
  /** 画布右上角账户弹层：订阅 / 奖励 / 邀请 / 公告 */
  accountPanel: null | 'subscription' | 'rewards' | 'invites' | 'announcements'
  setCanvas: (c: CanvasDetail) => void
  setNodes: (n: FlowNode[]) => void
  setEdges: (e: Edge[]) => void
  setDirty: (d: boolean) => void
  setSaving: (s: boolean) => void
  selectNode: (id: string | null) => void
  selectGroup: (id: string | null) => void
  setEditingNodeId: (id: string | null) => void
  setAgentOpen: (v: boolean) => void
  setAgentPanelWidth: (w: number) => void
  setAssetOpen: (v: boolean) => void
  setAccountPanel: (v: CanvasState['accountPanel']) => void
  updateNodePayload: (id: Id, patch: Partial<NodePayload>) => void
  setGroups: (g: GroupPayload[]) => void
  setStacks: (s: StackPayload[]) => void
}

export const useCanvasStore = create<CanvasState>((set) => ({
  canvas: null,
  nodes: [],
  edges: [],
  groups: [],
  stacks: [],
  dirty: false,
  saving: false,
  selectedNodeId: null,
  selectedGroupId: null,
  editingNodeId: null,
  agentOpen: true,
  agentPanelWidth: 380,
  assetOpen: false,
  accountPanel: null,

  setCanvas(c) {
    set({ canvas: c })
  },
  setNodes(n) {
    set({ nodes: n })
  },
  setEdges(e) {
    set({ edges: e })
  },
  setDirty(d) {
    set({ dirty: d })
  },
  setSaving(s) {
    set({ saving: s })
  },
  selectNode(id) {
    const next = id == null ? null : sid(id)
    set((s) => ({
      selectedNodeId: next,
      // 切换选中时退出其他节点的编辑态
      editingNodeId: next && s.editingNodeId === next ? s.editingNodeId : null,
    }))
  },
  selectGroup(id) {
    set((state) => ({
      selectedGroupId: id == null ? null : sid(id),
      ...(id == null ? {} : {
        selectedNodeId: null,
        editingNodeId: null,
        nodes: state.nodes.map((node) => ({ ...node, selected: false, data: { ...node.data, selected: false } })),
      }),
    }))
  },
  setEditingNodeId(id) {
    set({ editingNodeId: id == null ? null : sid(id) })
  },
  setAgentOpen(v) {
    set({ agentOpen: v })
  },
  setAgentPanelWidth(w) {
    set({ agentPanelWidth: w })
  },
  setAssetOpen(v) {
    set({ assetOpen: v })
  },
  setAccountPanel(v) {
    set({ accountPanel: v })
  },
  updateNodePayload(id, patch) {
    set((s) => ({
      dirty: true,
      nodes: s.nodes.map((n) =>
        sid(n.id) === sid(id) ? { ...n, data: { ...n.data, ...patch, node: { ...n.data.node, ...patch } } } : n,
      ),
    }))
  },
  setGroups(g) {
    set({ groups: g })
  },
  setStacks(s) {
    set({ stacks: s })
  },
}))

/** Create a persisted group from current business nodes and keep Renderer state in sync. */
export async function createCanvasGroup(
  requestedNodeIds: Array<string | number>,
  options: CreateCanvasGroupOptions = {},
): Promise<GroupPayload | null> {
  const snapshot = useCanvasStore.getState()
  const existingIds = new Set(snapshot.nodes.map((node) => sid(node.id)))
  const nodeIds = [...new Set(requestedNodeIds.map(sid).filter((id) => existingIds.has(id)))]
  const minimum = options.allowSingle ? 1 : 2
  if (nodeIds.length < minimum) return null
  if (!snapshot.canvas) throw new Error('画布尚未加载完成，无法编组。')
  const canvasId = sid(snapshot.canvas.canvas.id)
  const assertCanvasCurrent = () => {
    if (sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) {
      throw new Error('画布已切换，编组未写入当前画布。')
    }
  }

  const sameMembers = (group: GroupPayload) => {
    const currentIds = [...new Set(group.nodeIds.map(sid))].sort()
    return currentIds.length === nodeIds.length && currentIds.every((id, index) => id === [...nodeIds].sort()[index])
  }
  const existing = snapshot.groups.find(sameMembers)
  if (existing) {
    useCanvasStore.getState().selectGroup(sid(existing.id))
    return existing
  }

  const group: GroupPayload = {
    id: nodeIds.length === 1 ? crypto.randomUUID() : '',
    name: options.name ?? '编组',
    color: options.color ?? '#111111',
    layout: options.layout ?? 'free',
    nodeIds,
  }

  if (nodeIds.length === 1) {
    if (!options.allowSingle) return null
    useCanvasStore.setState((current) => ({
      groups: [...current.groups, group],
      nodes: applyCanvasGroupMembership(current.nodes, group).map((node) => ({ ...node, selected: false, data: { ...node.data, selected: false } })),
      selectedNodeId: null,
      editingNodeId: null,
      selectedGroupId: sid(group.id),
      dirty: true,
    }))
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('vp-canvas-group-snapshot'))
    return group
  }

  let created: GroupPayload
  const bridge = typeof window === 'undefined' ? undefined : window.vibepaperDesktop
  if (bridge) {
    const project = await bridge.getActiveProject()
    assertCanvasCurrent()
    if (!project || sid(project.canvasId) !== canvasId) {
      throw new Error('当前本地项目与画布不匹配，无法编组。')
    }
    const assertProjectCurrent = async () => {
      assertCanvasCurrent()
      const currentProject = await bridge.getActiveProject()
      assertCanvasCurrent()
      if (!currentProject || currentProject.projectId !== project.projectId || sid(currentProject.canvasId) !== canvasId) {
        throw new Error('当前本地项目已更改，编组未写入当前画布。')
      }
    }
    created = await bridge.addGroup({
      projectId: project.projectId,
      canvasId,
      nodeIds,
      color: group.color,
    })
    await assertProjectCurrent()
    if (group.name !== created.name || group.layout !== created.layout) {
      created = await bridge.updateGroup({
        projectId: project.projectId,
        canvasId,
        groupId: sid(created.id),
        name: group.name,
        layout: group.layout,
      })
      await assertProjectCurrent()
    }
  } else {
    const response = await api<{ id: string | number; nodeIds: Array<string | number>; name?: string; color?: string; layout?: string }>(
      `/canvases/${canvasId}/groups`,
      { method: 'POST', body: JSON.stringify({ nodeIds, color: group.color }) },
    )
    assertCanvasCurrent()
    created = {
      id: sid(response.id),
      name: response.name ?? '编组',
      color: response.color ?? group.color,
      layout: response.layout ?? 'free',
      nodeIds: response.nodeIds.map(sid),
    }
    if (group.name !== created.name || group.layout !== created.layout) {
      created = await api<GroupPayload>(`/canvases/${canvasId}/groups/${sid(created.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: group.name, layout: group.layout }),
      })
      assertCanvasCurrent()
    }
  }

  assertCanvasCurrent()
  const normalized: GroupPayload = {
    ...created,
    id: sid(created.id),
    nodeIds: created.nodeIds.map(sid),
  }
  useCanvasStore.setState((current) => ({
    groups: [...current.groups.filter((item) => sid(item.id) !== sid(normalized.id)), normalized],
    nodes: applyCanvasGroupMembership(current.nodes, normalized).map((node) => ({ ...node, selected: false, data: { ...node.data, selected: false } })),
    selectedNodeId: null,
    editingNodeId: null,
    selectedGroupId: sid(normalized.id),
  }))
  return normalized
}

export function removeCanvasGroupFromStore(group: GroupPayload, persistSnapshot = false): void {
  useCanvasStore.setState((current) => ({
    groups: current.groups.filter((item) => sid(item.id) !== sid(group.id)),
    nodes: clearCanvasGroupMembership(current.nodes, group),
    selectedGroupId: current.selectedGroupId === sid(group.id) ? null : current.selectedGroupId,
    ...(persistSnapshot ? { dirty: true } : {}),
  }))
  if (persistSnapshot && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('vp-canvas-group-snapshot'))
  }
}

/** 从后端负载构建 React Flow 图 */
export function buildFlow(
  detail: CanvasDetail,
  onConfig: (nodeId: string) => void,
): { nodes: FlowNode[]; edges: Edge[] } {
  const nodes: FlowNode[] = detail.nodes.map((n) => ({
    id: sid(n.id),
    type: n.type,
    position: { x: n.x ?? 120, y: n.y ?? 120 },
    data: { node: { ...n, id: sid(n.id) }, selected: false, onConfig, models: [] },
  }))
  const edges: Edge[] = detail.edges.map((e) => ({
    id: sid(e.id),
    source: sid(e.sourceNodeId),
    target: sid(e.targetNodeId),
    animated: false,
    label: e.valid ? undefined : '无效',
    labelStyle: e.valid ? undefined : { fill: '#888', fontSize: 10, fontWeight: 700 },
    style: { stroke: e.valid ? '#93c5fd' : '#c0c0c0', strokeWidth: 1.5 },
    data: { valid: e.valid, edge: e },
  }))
  return { nodes, edges }
}

const TERMINAL_STATUS = new Set(['succeeded', 'failed', 'cancelled', 'expired'])

const TERMINAL_OK = new Set(['succeeded', 'success', 'ready', 'failed', 'cancelled', 'expired'])

export function nodeMediaUrl(n: NodePayload | undefined): string {
  if (!n) return ''
  const p = n.params || {}
  const out = n.output
  const fromOut = out && typeof out.url === 'string' ? out.url : ''
  return String(p.lastOutputUrl || p.url || p.thumbnailUrl || p.output_url || fromOut || '')
}

export function mergeHydrateNode(server: NodePayload, local?: NodePayload): NodePayload {
  if (!local) return server
  const sUrl = nodeMediaUrl(server)
  const lUrl = nodeMediaUrl(local)
  const params = { ...(server.params || {}) }
  if (!sUrl && lUrl) {
    params.url = (local.params?.url as string) || lUrl
    params.lastOutputUrl = (local.params?.lastOutputUrl as string) || lUrl
    if (local.params?.thumbnailUrl) params.thumbnailUrl = local.params.thumbnailUrl
    if (local.params?.output_url) params.output_url = local.params.output_url
  }
  const sText = String(server.params?.lastOutputText || '')
  const lText = String(local.params?.lastOutputText || '')
  if (!sText && lText) params.lastOutputText = lText
  const output =
    server.output && Object.keys(server.output).length > 0 ? server.output : (local.output ?? server.output)
  const localExec = String(local.execStatus || local.status || '').toLowerCase()
  const serverExec = String(server.execStatus || server.status || '').toLowerCase()
  let execStatus = server.execStatus
  let status = server.status
  if (TERMINAL_OK.has(localExec) && ['idle', 'stale', ''].includes(serverExec)) {
    execStatus = local.execStatus || local.status
    status = local.status || local.execStatus || status
  }
  return { ...server, params, output: output ?? server.output, execStatus, status }
}

export function mergeHydrateFlow(server: FlowNode[], local: FlowNode[]): FlowNode[] {
  const byId = new Map(local.map((n) => [sid(n.id), n]))
  return server.map((n) => {
    const loc = byId.get(sid(n.id))
    if (!loc) return n
    return { ...n, data: { ...n.data, node: mergeHydrateNode(n.data.node, loc.data.node) } }
  })
}

export function toPayloads(nodes: FlowNode[]): NodePayload[] {
  return nodes.map((n) => {
    const node = { ...n.data.node, id: sid(n.id), x: n.position.x, y: n.position.y }
    const status = String(node.status || '')
    let execStatus = String(node.execStatus || '')
    if (execStatus === 'ready') execStatus = 'succeeded'
    if (TERMINAL_STATUS.has(status) && (!execStatus || ['queued', 'running', 'ready'].includes(execStatus))) {
      execStatus = status
    }
    const url = nodeMediaUrl(node)
    const params = { ...(node.params || {}) }
    if (url) {
      if (!params.url) params.url = url
      if (!params.lastOutputUrl) params.lastOutputUrl = url
    }
    const output =
      node.output && Object.keys(node.output).length > 0 ? node.output : url ? { ...node.output, url } : node.output
    return { ...node, params, output, execStatus: execStatus || node.execStatus }
  })
}

export function toEdgePayloads(edges: Edge[]): EdgePayload[] {
  return edges.map((e) => {
    const old = (e.data as { edge?: EdgePayload } | undefined)?.edge
    return {
      id: sid(e.id),
      sourceNodeId: sid(e.source),
      sourcePort: old?.sourcePort ?? 'output',
      targetNodeId: sid(e.target),
      targetPort: old?.targetPort ?? 'input',
      valid: old?.valid ?? true,
    }
  })
}
