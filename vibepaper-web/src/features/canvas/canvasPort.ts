import type { Edge, Node } from '@xyflow/react'
import { api } from '@/lib/api'
import { sid } from '@/lib/ids'
import type { AssetView, CanvasDetail, CanvasView, EdgePayload, GroupPayload, NodePayload, StackPayload } from '@/lib/types'
import type { DesktopAsset, DesktopCanvas, DesktopProject } from '@/desktop/desktop-bridge'
import type { DesktopCanvasGroup, DesktopCanvasStack } from '@/desktop/desktop-bridge'

export interface CanvasPortSnapshot {
  detail: CanvasDetail
  projectId?: string
}

export function isDesktopRuntime(): boolean {
  return Boolean(window.vibepaperDesktop) || window.location.protocol === 'vibe:'
}

export function desktopAssetView(asset: DesktopAsset): AssetView {
  const url = `vibe://app/assets/${asset.assetId}`
  return {
    id: asset.assetId,
    ownerId: 'local',
    name: asset.name,
    assetType: 'image',
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    url,
    thumbnailUrl: url,
    status: 'ready',
    certificationStatus: 'not_required',
    createdAt: asset.createdAt,
    updatedAt: asset.createdAt,
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function desktopNodePayload(node: Node): NodePayload {
  const data = record(node.data)
  const nested = record(data.node)
  const params = record(data.params ?? nested.params)
  const position = record(node.position)
  const payload = {
    ...nested,
    id: sid(node.id),
    type: String(node.type ?? nested.type ?? 'text'),
    x: typeof position.x === 'number' ? position.x : 120,
    y: typeof position.y === 'number' ? position.y : 120,
    ...(typeof node.width === 'number' ? { width: node.width } : {}),
    ...(typeof node.height === 'number' ? { height: node.height } : {}),
    params: { ...params },
    status: String(data.status ?? nested.status ?? 'idle'),
    currentOutputId: (data.currentOutputId ?? nested.currentOutputId) as string | number | undefined,
    groupId: (data.groupId ?? nested.groupId) as string | number | undefined,
    stackId: (data.stackId ?? nested.stackId) as string | number | undefined,
    creativeType: (data.creativeType ?? nested.creativeType) as string | undefined,
    stale: (data.stale ?? nested.stale) as boolean | undefined,
    modelRef: (data.modelRef ?? nested.modelRef) as string | undefined,
    prompt: (data.prompt ?? nested.prompt ?? params.prompt) as string | undefined,
    output: record(data.output ?? nested.output),
    execStatus: String(data.execStatus ?? nested.execStatus ?? 'idle'),
  }
  if (data.assetId !== undefined && payload.params.assetId === undefined) {
    payload.params.assetId = data.assetId
  }
  return payload
}

function detailFromDesktopCanvas(canvas: DesktopCanvas, project: DesktopProject): CanvasDetail {
  const canvasView: CanvasView = {
    id: canvas.canvasId,
    ownerId: 'local',
    name: project.name,
    schemaVersion: String((canvas as DesktopCanvas & { schemaVersion?: string | number }).schemaVersion ?? '1'),
    version: canvas.version,
    visibility: 'private',
    shareToken: '',
  }
  const groups = (canvas.groups ?? []) as GroupPayload[]
  const stacks = (canvas.stacks ?? []) as StackPayload[]
  return {
    canvas: canvasView,
    nodes: canvas.nodes.map(desktopNodePayload),
    edges: canvas.edges.map((edge) => {
      const data = record(edge.data)
      const nested = record(data.edge)
      return {
        ...nested,
        id: sid(edge.id),
        sourceNodeId: sid(edge.source ?? nested.sourceNodeId),
        sourcePort: String(edge.sourceHandle ?? nested.sourcePort ?? 'output'),
        targetNodeId: sid(edge.target ?? nested.targetNodeId),
        targetPort: String(edge.targetHandle ?? nested.targetPort ?? 'input'),
        valid: typeof data.valid === 'boolean' ? data.valid : nested.valid !== false,
      } as EdgePayload
    }),
    groups: groups.map((group) => ({ ...group, id: sid(group.id), nodeIds: group.nodeIds.map(sid) })),
    stacks: stacks.map((stack) => ({ ...stack, id: sid(stack.id), nodeIds: stack.nodeIds.map(sid) })),
  }
}

function desktopFlowNode(node: Node): Node {
  const data = record(node.data)
  const { onConfig: _onConfig, models: _models, ...renderData } = data
  const payload = desktopNodePayload(node)
  return {
    ...node,
    id: sid(node.id),
    type: String(node.type ?? payload.type),
    position: { x: payload.x ?? 120, y: payload.y ?? 120 },
    data: {
      ...renderData,
      node: payload,
      params: payload.params,
      status: payload.status,
      currentOutputId: payload.currentOutputId ?? null,
      groupId: payload.groupId ?? null,
      stackId: payload.stackId ?? null,
      creativeType: payload.creativeType ?? null,
      stale: payload.stale ?? false,
      modelRef: payload.modelRef ?? null,
      prompt: payload.prompt ?? null,
      output: payload.output ?? null,
      execStatus: payload.execStatus ?? 'idle',
      ...(typeof payload.prompt === 'string' ? { label: payload.prompt } : {}),
    },
  }
}

function desktopFlowEdge(edge: Edge): Edge {
  const data = record(edge.data)
  const old = record(data.edge)
  const { edge: _edge, ...renderData } = data
  return {
    ...edge,
    id: sid(edge.id),
    source: sid(edge.source),
    target: sid(edge.target),
    data: {
      ...renderData,
      edge: {
        ...old,
        id: sid(edge.id),
        sourceNodeId: sid(edge.source),
        sourcePort: String(edge.sourceHandle ?? old.sourcePort ?? 'output'),
        targetNodeId: sid(edge.target),
        targetPort: String(edge.targetHandle ?? old.targetPort ?? 'input'),
        valid: data.valid !== false,
      },
    },
  }
}

export async function loadCanvasPort(canvasId: string): Promise<CanvasPortSnapshot> {
  const bridge = window.vibepaperDesktop
  if (!isDesktopRuntime()) return { detail: await api<CanvasDetail>(`/canvases/${canvasId}`) }
  if (!bridge) throw new Error('桌面本地桥接不可用，已阻止调用旧 Web 服务。请重新启动桌面应用。')

  const project = await bridge.getActiveProject()
  if (!project) throw new Error('没有已打开的本地项目，请先从画布展示选择项目。')
  if (project.canvasId !== canvasId) throw new Error('当前本地项目与请求的画布不匹配，请从画布展示重新选择。')
  const canvas = await bridge.loadCanvas(project.projectId, project.canvasId)
  return { detail: detailFromDesktopCanvas(canvas, project), projectId: project.projectId }
}

export async function saveCanvasPort(input: {
  projectId: string
  canvasId: string
  expectedVersion: number
  nodes: Node[]
  edges: Edge[]
  groups: GroupPayload[]
  stacks: StackPayload[]
}): Promise<{ version: number }> {
  const bridge = window.vibepaperDesktop
  if (!bridge) throw new Error('本地画布保存接口不可用。')
  return bridge.saveCanvas({
    ...input,
    nodes: input.nodes.map(desktopFlowNode),
    edges: input.edges.map(desktopFlowEdge),
    groups: input.groups.map((group): DesktopCanvasGroup => ({
      ...group,
      id: sid(group.id),
      nodeIds: group.nodeIds.map(sid),
    })),
    stacks: input.stacks.map((stack): DesktopCanvasStack => ({
      ...stack,
      id: sid(stack.id),
      nodeIds: stack.nodeIds.map(sid),
    })),
  })
}

export async function createCanvasNodePort(input: {
  projectId?: string
  canvasId: string
  expectedVersion?: number
  type: string
  x: number
  y: number
  params: Record<string, unknown>
}): Promise<{ id: string; type: string; version?: number }> {
  const bridge = window.vibepaperDesktop
  if (!isDesktopRuntime()) {
    const created = await api<{ id: string | number; type: string }>(`/canvases/${input.canvasId}/nodes`, {
      method: 'POST',
      body: JSON.stringify({ type: input.type, x: input.x, y: input.y, params: input.params }),
    })
    return { id: sid(created.id), type: created.type }
  }
  if (!bridge) throw new Error('桌面本地桥接不可用，已阻止调用旧 Web 服务。请重新启动桌面应用。')
  if (!input.projectId || input.expectedVersion === undefined) throw new Error('本地画布身份或版本缺失。')
  const created = await bridge.createNode({
    projectId: input.projectId,
    canvasId: input.canvasId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: crypto.randomUUID(),
    type: input.type as 'text' | 'image' | 'video' | 'audio' | 'compose' | 'director',
    x: input.x,
    y: input.y,
    params: input.params,
  })
  return { id: sid(created.node.id), type: String(created.node.type ?? input.type), version: created.version }
}

export function desktopCanvasDetail(canvas: DesktopCanvas, project: DesktopProject): CanvasDetail {
  return detailFromDesktopCanvas(canvas, project)
}
