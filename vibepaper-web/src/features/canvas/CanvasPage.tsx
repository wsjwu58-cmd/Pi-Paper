import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnNodeDrag,
  useReactFlow,
} from '@xyflow/react'
import { Copy, Files, Trash2, Upload } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import { api, ApiError, uploadAsset } from '@/lib/api'
import { isValidEntityId, sid } from '@/lib/ids'
import type { AssetView, CanvasDetail, EdgePayload, ModelInfo, NodePayload } from '@/lib/types'
import { buildFlow, mergeHydrateFlow, toPayloads, toEdgePayloads, useCanvasStore, type FlowNode } from './canvasStore'
import { nodeTypes } from './nodes'
import { CanvasTopBar } from './CanvasTopBar'
import { CanvasToolbar } from './CanvasToolbar'
import { AssetLibrary } from './AssetLibrary'
import { AgentLauncher, AgentPanel } from './AgentPanel'
import { useDesktopAgentController } from './useDesktopAgentController'
import { SubscriptionMenu } from './SubscriptionMenu'
import { AccountSidePanels } from './AccountSidePanels'
import { CanvasWelcome } from './CanvasWelcome'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { Spinner } from '@/components/ui/Spinner'
import { createCanvasNodePort, desktopAssetView, desktopCanvasDetail, isDesktopRuntime, loadCanvasPort, saveCanvasPort } from './canvasPort'
import type { DesktopCanvas } from '@/desktop/desktop-bridge'

const saveDebounce = 500
let nodeClipboard: NodePayload[] = []

export function CanvasPage() {
  const params = useParams()
  const id = params.id ?? params.canvasId
  const canvasId = sid(id)
  const validDesktopId = isDesktopRuntime()
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(canvasId)
  if (!isValidEntityId(canvasId) && !validDesktopId) {
    return <Navigate to="/workspace" replace />
  }
  return (
    <ReactFlowProvider>
      <CanvasPageInner canvasId={canvasId} />
    </ReactFlowProvider>
  )
}

function CanvasPageInner({ canvasId }: { canvasId: string }) {
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)
  const groups = useCanvasStore((s) => s.groups)
  const stacks = useCanvasStore((s) => s.stacks)
  const canvas = useCanvasStore((s) => s.canvas)
  const setNodes = useCanvasStore((s) => s.setNodes)
  const setEdges = useCanvasStore((s) => s.setEdges)
  const setCanvas = useCanvasStore((s) => s.setCanvas)
  const setGroups = useCanvasStore((s) => s.setGroups)
  const setStacks = useCanvasStore((s) => s.setStacks)
  const dirty = useCanvasStore((s) => s.dirty)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const setSaving = useCanvasStore((s) => s.setSaving)
  const selectNode = useCanvasStore((s) => s.selectNode)
  const setEditingNodeId = useCanvasStore((s) => s.setEditingNodeId)
  const agentOpen = useCanvasStore((s) => s.agentOpen)
  const setAgentOpen = useCanvasStore((s) => s.setAgentOpen)
  const [mode, setMode] = useState<'select' | 'pan'>('select')
  const [addMenu, setAddMenu] = useState<{
    x: number
    y: number
    flowX: number
    flowY: number
    sourceNodeId?: string
    direction?: 'upstream' | 'downstream'
  } | null>(null)
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; nodeIds: string[] } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{
    nodeIds: string[]
    downstream: Array<{ id: string; type: string }>
  } | null>(null)
  const { fitView, screenToFlowPosition } = useReactFlow()
  const saveTimer = useRef<number | null>(null)
  const positionSaveQueue = useRef<Promise<void>>(Promise.resolve())
  const externalSyncPending = useRef(false)
  const externalSyncTimer = useRef<number | null>(null)
  const hydratingRef = useRef(true)
  const [savedVersion, setSavedVersion] = useState<number | null>(null)
  const skipNextSave = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingUploadPos = useRef<{ x: number; y: number } | null>(null)
  const pendingEdgeDelete = useRef<{ dirtyBefore: boolean; edgesBefore: Edge[] } | null>(null)

  const {
    data: loadedCanvas,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['canvas', canvasId],
    queryFn: () => loadCanvasPort(canvasId),
    retry: 1,
  })
  const detail = loadedCanvas?.detail
  const desktopProjectId = loadedCanvas?.projectId
  const desktopMode = isDesktopRuntime()

  const { data: models } = useQuery({
    queryKey: ['models'],
    queryFn: () => desktopMode
      ? Promise.resolve([] as ModelInfo[])
      : api<{ items: ModelInfo[] }>('/models').then((r) => r.items),
    enabled: !desktopMode,
  })

  useEffect(() => {
    const onAgentExecuted = () => {
      // Agent writes are authoritative remote mutations. Do not let a pending
      // local full-save race them with an old canvas version; hydrate the
      // resulting graph immediately instead of waiting for a page refresh.
      externalSyncPending.current = true
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      skipNextSave.current = true
      if (externalSyncTimer.current != null) window.clearTimeout(externalSyncTimer.current)
      externalSyncTimer.current = window.setTimeout(() => {
        externalSyncTimer.current = null
        void refetch().finally(() => {
          externalSyncPending.current = false
        })
      }, 250)
    }
    window.addEventListener('vp-agent-executed', onAgentExecuted)
    return () => {
      window.removeEventListener('vp-agent-executed', onAgentExecuted)
      if (externalSyncTimer.current != null) window.clearTimeout(externalSyncTimer.current)
    }
  }, [refetch])

  useEffect(() => {
    if (!detail) return
    hydratingRef.current = true
    skipNextSave.current = true
    setCanvas(detail)
    const flow = buildFlow(detail, selectNode)
    const merged = mergeHydrateFlow(flow.nodes, useCanvasStore.getState().nodes)
    setNodes(merged.map((n) => ({ ...n, data: { ...n.data, models: models ?? [] } })))
    setEdges(flow.edges)
    setGroups(detail.groups)
    setStacks(detail.stacks)
    setSavedVersion(detail.canvas.version)
    // Hydrating the authoritative server snapshot is not a local edit. Clear
    // any stale dirty flag so a refresh (or an Agent write) cannot trigger a
    // full-save/version bump loop immediately after hydration.
    setDirty(false)
    window.setTimeout(() => {
      hydratingRef.current = false
    }, 0)
    // 仅在画布 detail 变化时整表 hydrate；models 单独注入，避免覆盖已编辑的 prompt
  }, [detail, setCanvas, setNodes, setEdges, setGroups, setStacks, setDirty, selectNode])

  useEffect(() => {
    if (!models) return
    const current = useCanvasStore.getState().nodes
    if (current.length === 0) return
    skipNextSave.current = true
    setNodes(current.map((n) => ({ ...n, data: { ...n.data, models } })))
  }, [models, setNodes])

  const desktopSaveInFlight = useRef<Promise<void> | null>(null)

  const persistDesktopChanges = useCallback(async () => {
    if (!window.vibepaperDesktop) return
    while (true) {
      const snapshot = useCanvasStore.getState()
      if (!snapshot.dirty) return
      if (!snapshot.canvas || !desktopProjectId) throw new Error('没有可保存的本地画布。')
      if (desktopSaveInFlight.current) {
        await desktopSaveInFlight.current
        continue
      }

      const pending = (async () => {
        setSaving(true)
        try {
          const result = await saveCanvasPort({
            projectId: desktopProjectId,
            canvasId: sid(snapshot.canvas!.canvas.id),
            expectedVersion: snapshot.canvas!.canvas.version,
            nodes: snapshot.nodes,
            edges: snapshot.edges,
            groups: snapshot.groups,
            stacks: snapshot.stacks,
          })
          const latest = useCanvasStore.getState()
          const latestCanvas = latest.canvas
          const sameGraph = latest.nodes === snapshot.nodes
            && latest.edges === snapshot.edges
            && latest.groups === snapshot.groups
            && latest.stacks === snapshot.stacks
          if (latestCanvas && sid(latestCanvas.canvas.id) === sid(snapshot.canvas!.canvas.id)) {
            const version = Math.max(latestCanvas.canvas.version, result.version)
            setCanvas({ ...latestCanvas, canvas: { ...latestCanvas.canvas, version } })
            setSavedVersion(version)
          }
          setDirty(sameGraph ? false : true)
        } catch (error) {
          setDirty(true)
          throw error
        } finally {
          setSaving(false)
        }
      })()
      desktopSaveInFlight.current = pending
      try {
        await pending
      } finally {
        if (desktopSaveInFlight.current === pending) desktopSaveInFlight.current = null
      }
    }
  }, [desktopProjectId, setCanvas, setDirty, setSavedVersion, setSaving])

  const save = useCallback(async () => {
    if (!canvas || externalSyncPending.current) return
    if (window.vibepaperDesktop) {
      try {
        await persistDesktopChanges()
      } catch (e) {
        if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
          void refetch()
        } else {
          setDirty(true)
        }
      }
      return
    }
    setSaving(true)
    try {
      const res = await api<CanvasDetail>(`/canvases/${sid(canvas.canvas.id)}/save`, {
        method: 'POST',
        body: JSON.stringify({
          version: canvas.canvas.version,
          nodes: toPayloads(nodes),
          edges: toEdgePayloads(edges),
          groups,
          stacks,
        }),
      })
      setSavedVersion(res.canvas.version)
      setCanvas(res)
      setGroups(res.groups)
      setStacks(res.stacks)
      setDirty(false)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        // Agent/terminal callbacks can legitimately advance the canvas between
        // a local debounce and its full save. Refresh silently: this is an
        // internal synchronization race, not an actionable creator error.
        void refetch()
      } else {
        setDirty(true)
      }
    } finally {
      setSaving(false)
    }
  }, [canvas, nodes, edges, groups, stacks, persistDesktopChanges, setCanvas, setGroups, setStacks, setDirty, setSaving, refetch])

  const saveRef = useRef(save)
  saveRef.current = save

  const flushDesktopEdits = useCallback(async () => {
    if (!window.vibepaperDesktop) return
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    await persistDesktopChanges()
    skipNextSave.current = true
  }, [persistDesktopChanges])

  const notifyDesktopAgentCanvasChanged = useCallback(() => {
    window.dispatchEvent(new Event('vp-agent-executed'))
  }, [])
  const desktopAgent = useDesktopAgentController({
    projectId: desktopMode ? desktopProjectId : undefined,
    canvasId,
    flushCanvas: flushDesktopEdits,
    onCanvasChanged: notifyDesktopAgentCanvasChanged,
  })

  const createNodeInCanvas = useCallback(async (type: string, x: number, y: number, params: Record<string, unknown>) => {
    await flushDesktopEdits()
    const current = useCanvasStore.getState().canvas
    const created = await createCanvasNodePort({
      projectId: desktopProjectId,
      canvasId,
      expectedVersion: current?.canvas.version,
      type,
      x,
      y,
      params,
    })
    if (created.version !== undefined && current) {
      const latest = useCanvasStore.getState().canvas ?? current
      const wasEditedAgain = useCanvasStore.getState().dirty
      const nextCanvas = { ...latest, canvas: { ...latest.canvas, version: created.version } }
      setCanvas(nextCanvas)
      setSavedVersion(created.version)
      if (!wasEditedAgain) setDirty(false)
    }
    return created
  }, [canvasId, desktopProjectId, flushDesktopEdits, setCanvas, setDirty])

  // 防抖自动保存（300-500ms 增量落盘 + 乐观锁）；跳过初次 hydrate
  useEffect(() => {
    // A successful full save replaces `canvas` with the server response. Do
    // not treat that authoritative response as a new edit: without this
    // dirty guard, changing the canvas version retriggers the effect forever
    // and can advance the optimistic-lock version hundreds of times.
    if (!canvas || savedVersion === null || !dirty) return
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void saveRef.current()
    }, saveDebounce)
  }, [nodes, edges, groups, stacks, canvas, savedVersion, dirty])

  // 离开画布 / 关闭页面前冲掉未落盘的防抖保存（含提示词）
  useEffect(() => {
    const flush = () => {
      if (!saveTimer.current) return
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
      void saveRef.current()
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [])

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes(applyNodeChanges(changes, nodes) as FlowNode[])
      const sel = changes.filter((c) => c.type === 'select').pop() as { selected?: boolean; id?: string } | undefined
      if (sel?.id) selectNode(sel.selected ? sid(sel.id) : null)
      // React Flow emits internal replace/measurement/selection changes while
      // hydrating/rendering the graph. Dirty state is set by explicit edit
      // handlers (and drag-stop below), never by this reconciliation callback;
      // otherwise an Agent confirmation can become stale from view updates.
    },
    [nodes, setNodes, selectNode, setDirty],
  )

  const persistNodePosition = useCallback(
    (node: FlowNode) => {
      positionSaveQueue.current = positionSaveQueue.current
        .catch(() => undefined)
      .then(async () => {
          const position = { x: node.position.x, y: node.position.y }
          if (window.vibepaperDesktop) {
            setDirty(true)
            return
          }
          let lastError: unknown
          // A position is an independent, low-risk edit. Retrying it against
          // the newest canvas version prevents an Agent status update from
          // reverting a completed drag during a full-graph refresh.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const current = useCanvasStore.getState().canvas
            if (!current) return
            try {
              await api(`/canvases/${sid(current.canvas.id)}/nodes/${sid(node.id)}`, {
                method: 'PUT',
                body: JSON.stringify({ ...position, expectedVersion: current.canvas.version }),
              })
              const latest = useCanvasStore.getState().canvas
              if (latest && sid(latest.canvas.id) === sid(current.canvas.id)) {
                const version = current.canvas.version + 1
                setCanvas({ ...latest, canvas: { ...latest.canvas, version } })
                setSavedVersion(version)
              }
              return
            } catch (error) {
              lastError = error
              if (!(error instanceof ApiError) || error.code !== 'VERSION_CONFLICT') break
              const fresh = await api<CanvasDetail>(`/canvases/${sid(current.canvas.id)}`)
              setCanvas(fresh)
              setSavedVersion(fresh.canvas.version)
            }
          }
          // Keep the graph dirty as a final fallback. The normal debounced save
          // will retry later, but avoid a red toast for a transient background
          // version race.
          if (lastError) setDirty(true)
        })
    },
    [setCanvas, setDirty],
  )

  const onNodeDragStop: OnNodeDrag<FlowNode> = useCallback(
    (_event, node) => {
      // When another graph edit is already pending, its existing full save
      // includes this position. Otherwise persist just this node, so a remote
      // Agent mutation cannot overwrite a drag with an older whole-canvas view.
      if (useCanvasStore.getState().dirty) {
        setDirty(true)
        return
      }
      persistNodePosition(node)
    },
    [persistNodePosition, setDirty],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removed = changes.filter((change) => change.type === 'remove').map((change) => change.id)
      if (window.vibepaperDesktop && removed.length > 0) {
        pendingEdgeDelete.current = {
          dirtyBefore: useCanvasStore.getState().dirty,
          edgesBefore: edges,
        }
      }
      setEdges(applyEdgeChanges(changes, edges))
      // Edge reconciliation is likewise view state; explicit connect/delete
      // handlers below mark real edge edits dirty.
    },
    [edges, setEdges, setDirty],
  )

  const onConnect = useCallback(
    async (conn: Connection) => {
      try {
        if (window.vibepaperDesktop) {
          await flushDesktopEdits()
          if (!desktopProjectId) throw new Error('没有已打开的本地项目，无法建立连线。')
          const current = useCanvasStore.getState().canvas
          if (!current) throw new Error('画布尚未加载完成。')
          const result = await window.vibepaperDesktop.connectEdge({
            projectId: desktopProjectId,
            canvasId,
            expectedVersion: current.canvas.version,
            idempotencyKey: crypto.randomUUID(),
            sourceNodeId: sid(conn.source),
            targetNodeId: sid(conn.target),
            sourcePort: conn.sourceHandle ?? 'output',
            targetPort: conn.targetHandle ?? 'input',
          })
          const edge = result.edge
          setEdges([
            ...useCanvasStore.getState().edges,
            {
              id: sid(edge.id),
              source: sid(edge.sourceNodeId),
              target: sid(edge.targetNodeId),
              sourceHandle: edge.sourcePort,
              targetHandle: edge.targetPort,
              style: { stroke: '#93c5fd', strokeWidth: 1.5 },
              data: { valid: edge.valid, edge },
            },
          ])
          const wasEditedAgain = useCanvasStore.getState().dirty
          const latest = useCanvasStore.getState().canvas ?? current
          setCanvas({ ...latest, canvas: { ...latest.canvas, version: result.version } })
          setSavedVersion(result.version)
          if (!wasEditedAgain) setDirty(false)
          toastSuccess('连线已建立')
          return
        }
        const edge = await api<{ id: string | number }>(`/canvases/${canvasId}/edges`, {
          method: 'POST',
          body: JSON.stringify({
            sourceNodeId: sid(conn.source),
            targetNodeId: sid(conn.target),
            sourcePort: conn.sourceHandle ?? 'output',
            targetPort: conn.targetHandle ?? 'input',
          }),
        })
        setEdges([
          ...edges,
          {
            id: sid(edge.id),
            source: sid(conn.source),
            target: sid(conn.target),
            style: { stroke: '#93c5fd', strokeWidth: 1.5 },
          },
        ])
        toastSuccess('连线已建立')
      } catch (e) {
        toastError(e instanceof ApiError ? e.message : '连线失败')
      }
    },
    [canvasId, desktopProjectId, edges, flushDesktopEdits, setCanvas, setDirty, setEdges],
  )

  const requestDeleteNodes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      const downstream = edges
        .filter((e) => ids.includes(sid(e.source)))
        .map((e) => {
          const t = nodes.find((n) => sid(n.id) === sid(e.target))
          return t ? { id: sid(t.id), type: String(t.type ?? t.data.node.type) } : null
        })
        .filter((x): x is { id: string; type: string } => Boolean(x))
      const unique = Array.from(new Map(downstream.map((d) => [d.id, d])).values()).filter(
        (d) => !ids.includes(d.id),
      )
      setDeleteConfirm({ nodeIds: ids, downstream: unique })
      setNodeMenu(null)
    },
    [edges, nodes],
  )

  const confirmDeleteNodes = useCallback(async () => {
    if (!deleteConfirm) return
    const ids = deleteConfirm.nodeIds
    setDeleteConfirm(null)
    if (window.vibepaperDesktop) {
      try {
        await flushDesktopEdits()
        if (!desktopProjectId) throw new Error('没有已打开的本地项目，无法删除节点。')
        let version = useCanvasStore.getState().canvas?.canvas.version
        if (version === undefined) throw new Error('画布尚未加载完成。')
        let resultCanvas: DesktopCanvas | null = null
        for (const nodeId of ids) {
          const result = await window.vibepaperDesktop.deleteNode({
            projectId: desktopProjectId,
            canvasId,
            expectedVersion: version,
            idempotencyKey: crypto.randomUUID(),
            nodeId,
          })
          version = result.version
          resultCanvas = result.canvas
        }
        const project = await window.vibepaperDesktop.getActiveProject()
        if (!project || !resultCanvas) throw new Error('本地删除成功，但无法读取更新后的画布。')
        const next = desktopCanvasDetail(resultCanvas, project)
        setCanvas(next)
        const flow = buildFlow(next, selectNode)
        setNodes(flow.nodes.map((node) => ({ ...node, data: { ...node.data, models: models ?? [] } })))
        setEdges(flow.edges)
        setGroups(next.groups)
        setStacks(next.stacks)
        setSavedVersion(next.canvas.version)
        if (!useCanvasStore.getState().dirty) setDirty(false)
        toastSuccess(`已删除 ${ids.length} 个节点`)
      } catch (e) {
        toastError((e as Error).message)
        void refetch()
      }
      return
    }
    setNodes(nodes.filter((n) => !ids.includes(sid(n.id))))
    setEdges(edges.filter((e) => !ids.includes(sid(e.source)) && !ids.includes(sid(e.target))))
    setDirty(true)
    for (const id of ids) {
      try {
        await api(`/canvases/${canvasId}/nodes/${id}`, { method: 'DELETE' })
      } catch (e) {
        toastError((e as Error).message)
      }
    }
    toastSuccess(`已删除 ${ids.length} 个节点`)
  }, [canvasId, deleteConfirm, desktopProjectId, edges, flushDesktopEdits, models, nodes, refetch, selectNode, setCanvas, setDirty, setEdges, setGroups, setNodes, setStacks])

  const onNodesDelete = useCallback((_deleted: FlowNode[]) => {
    // 删除改由确认弹窗处理（deleteKeyCode 已关闭）
  }, [])

  const duplicateNodes = useCallback(
    async (ids: string[]) => {
      const selected = nodes.filter((n) => ids.includes(sid(n.id)))
      for (const n of selected) {
        const src = n.data.node
        try {
          const created = await createNodeInCanvas(
            src.type,
            (src.x ?? n.position.x) + 40,
            (src.y ?? n.position.y) + 40,
            { ...src.params },
          )
          const node: FlowNode = {
            id: sid(created.id),
            type: created.type,
            position: { x: (src.x ?? n.position.x) + 40, y: (src.y ?? n.position.y) + 40 },
            data: {
              node: {
                ...src,
                id: sid(created.id),
                x: (src.x ?? n.position.x) + 40,
                y: (src.y ?? n.position.y) + 40,
                status: 'idle',
                currentOutputId: undefined,
              },
              selected: false,
              onConfig: selectNode,
              models: models ?? [],
            },
          }
          setNodes([...useCanvasStore.getState().nodes, node])
        } catch (e) {
          toastError((e as Error).message)
        }
      }
      if (!window.vibepaperDesktop) setDirty(true)
      toastSuccess(`已创建 ${selected.length} 个副本`)
      setNodeMenu(null)
    },
    [createNodeInCanvas, models, nodes, selectNode, setDirty, setNodes],
  )

  const copyNodes = useCallback(
    (ids: string[]) => {
      nodeClipboard = nodes.filter((n) => ids.includes(sid(n.id))).map((n) => ({ ...n.data.node, params: { ...n.data.node.params } }))
      toastSuccess(`已复制 ${nodeClipboard.length} 个节点`)
      setNodeMenu(null)
    },
    [nodes],
  )

  const pasteNodes = useCallback(async () => {
    if (nodeClipboard.length === 0) return
    for (const src of nodeClipboard) {
      try {
        const created = await createNodeInCanvas(
          src.type,
          (src.x ?? 120) + 48,
          (src.y ?? 120) + 48,
          { ...src.params },
        )
        const node: FlowNode = {
          id: sid(created.id),
          type: created.type,
          position: { x: (src.x ?? 120) + 48, y: (src.y ?? 120) + 48 },
          data: {
            node: {
              ...src,
              id: sid(created.id),
              x: (src.x ?? 120) + 48,
              y: (src.y ?? 120) + 48,
              status: 'idle',
              currentOutputId: undefined,
            },
            selected: false,
            onConfig: selectNode,
            models: models ?? [],
          },
        }
        setNodes([...useCanvasStore.getState().nodes, node])
      } catch (e) {
        toastError((e as Error).message)
      }
    }
    if (!window.vibepaperDesktop) setDirty(true)
    toastSuccess('已粘贴')
  }, [createNodeInCanvas, models, selectNode, setDirty, setNodes])

  const onEdgesDelete = useCallback(
    (deleted: Array<{ id: string }>) => {
      if (window.vibepaperDesktop) {
        const bridge = window.vibepaperDesktop
        const snapshot = pendingEdgeDelete.current
        pendingEdgeDelete.current = null
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
        void (async () => {
          if (!desktopProjectId) throw new Error('没有已打开的本地项目，无法删除连线。')
          const current = useCanvasStore.getState()
          if (snapshot?.dirtyBefore && current.canvas) {
            const saved = await saveCanvasPort({
              projectId: desktopProjectId,
              canvasId: sid(current.canvas.canvas.id),
              expectedVersion: current.canvas.canvas.version,
              nodes: current.nodes,
              edges: snapshot.edgesBefore,
              groups: current.groups,
              stacks: current.stacks,
            })
            const latest = useCanvasStore.getState().canvas ?? current.canvas
            setCanvas({ ...latest, canvas: { ...latest.canvas, version: saved.version } })
            setSavedVersion(saved.version)
            setDirty(false)
          }
          for (const edge of deleted) {
            await bridge.deleteEdge({ projectId: desktopProjectId, canvasId, edgeId: sid(edge.id) })
          }
        })().catch((error: unknown) => {
          toastError(error instanceof Error ? error.message : '无法删除本地连线。')
          void refetch()
        })
        return
      }
      for (const e of deleted) {
        void api(`/canvases/${canvasId}/edges/${sid(e.id)}`, { method: 'DELETE' }).catch((err) =>
          toastError((err as Error).message),
        )
      }
    },
    [canvasId, desktopProjectId, refetch, setCanvas, setDirty],
  )

  const addNode = useCallback(
    async (
      type: string,
      x?: number,
      y?: number,
      connect?: { nodeId: string; direction: 'upstream' | 'downstream' },
    ) => {
      try {
        const model = models?.find((m) => m.modelType === type)
        const nodeX = x ?? 120
        const nodeY = y ?? 120
        const n = await createNodeInCanvas(type, nodeX, nodeY, { model: model?.name ?? '' })
        const node: FlowNode = {
          id: sid(n.id),
          type,
          position: { x: nodeX, y: nodeY },
          data: {
            node: {
              id: sid(n.id),
              type: n.type,
              x: nodeX,
              y: nodeY,
              params: { model: model?.name ?? '' },
              status: 'idle',
            },
            selected: false,
            onConfig: selectNode,
            models: models ?? [],
          },
        }
        setNodes([...useCanvasStore.getState().nodes, node])
        if (connect?.nodeId) {
          const sourceNodeId = connect.direction === 'downstream' ? connect.nodeId : sid(n.id)
          const targetNodeId = connect.direction === 'downstream' ? sid(n.id) : connect.nodeId
          let edgeId: string
          let edgeData: Record<string, unknown> = { valid: true }
          if (window.vibepaperDesktop) {
            if (!desktopProjectId) throw new Error('没有已打开的本地项目，无法建立连线。')
            const current = useCanvasStore.getState().canvas
            if (!current) throw new Error('画布尚未加载完成。')
            const result = await window.vibepaperDesktop.connectEdge({
              projectId: desktopProjectId,
              canvasId,
              expectedVersion: current.canvas.version,
              idempotencyKey: crypto.randomUUID(),
              sourceNodeId,
              targetNodeId,
              sourcePort: 'output',
              targetPort: 'input',
            })
            edgeId = sid(result.edge.id)
            edgeData = { valid: result.edge.valid, edge: result.edge as unknown as EdgePayload }
            setCanvas({ ...current, canvas: { ...current.canvas, version: result.version } })
            setSavedVersion(result.version)
          } else {
            const edge = await api<{ id: string | number }>(`/canvases/${canvasId}/edges`, {
              method: 'POST',
              body: JSON.stringify({ sourceNodeId, targetNodeId, sourcePort: 'output', targetPort: 'input' }),
            })
            edgeId = sid(edge.id)
          }
          setEdges([
            ...useCanvasStore.getState().edges,
            {
              id: edgeId,
              source: sourceNodeId,
              target: targetNodeId,
              style: { stroke: '#93c5fd', strokeWidth: 1.5 },
              data: edgeData,
            },
          ])
          toastSuccess(connect.direction === 'downstream' ? '已创建下游节点并连线' : '已创建上游节点并连线')
        }
        if (!window.vibepaperDesktop) setDirty(true)
      } catch (e) {
        toastError((e as Error).message)
      }
    },
    [canvasId, createNodeInCanvas, desktopProjectId, models, setCanvas, setEdges, setDirty, setNodes],
  )

  const addAssetNode = useCallback(
    async (asset: AssetView, x: number, y: number) => {
      const params = { assetId: sid(asset.id), prompt: '', name: asset.name, url: asset.url }
      const n = await createNodeInCanvas(asset.assetType, x, y, params)
      setNodes([
        ...useCanvasStore.getState().nodes,
        {
          id: sid(n.id),
          type: asset.assetType,
          position: { x, y },
          data: {
            node: {
              id: sid(n.id),
              type: asset.assetType,
              x,
              y,
              params: { assetId: sid(asset.id), name: asset.name, url: asset.url },
              status: 'idle',
            },
            selected: false,
            onConfig: selectNode,
            models: models ?? [],
          },
        },
      ])
      if (!window.vibepaperDesktop) setDirty(true)
      toastSuccess('素材已导入画布')
    },
    [createNodeInCanvas, models, selectNode, setDirty, setNodes],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const point = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (e.dataTransfer.files?.length) {
        if (window.vibepaperDesktop) {
          toastError('桌面版文件拖放导入尚未接入，请使用画布上传入口选择图片。')
          return
        }
        void (async () => {
          for (const file of Array.from(e.dataTransfer.files)) {
            const asset = (await uploadAsset(file, undefined, canvasId)) as AssetView
            await addAssetNode(asset, point.x, point.y)
          }
        })().catch((err) => toastError((err as Error).message))
        return
      }
      const raw = e.dataTransfer.getData('application/json')
      if (!raw) return
      try {
        const asset = JSON.parse(raw) as AssetView
        void addAssetNode(asset, point.x, point.y).catch((err) => toastError((err as Error).message))
      } catch {
        /* ignore */
      }
    },
    [addAssetNode, canvasId, screenToFlowPosition],
  )

  const onAutoLayout = useCallback(() => {
    const sorted = [...nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    const next = sorted.map((n, i) => ({
      ...n,
      position: { x: 120 + (i % 4) * 330, y: 120 + Math.floor(i / 4) * 280 },
    }))
    setNodes(next)
    setDirty(true)
    toastSuccess('已一键整理')
  }, [nodes, setNodes, setDirty])

  const openAddMenu = useCallback(
    (x: number, y: number, connect?: { nodeId: string; direction: 'upstream' | 'downstream' }) => {
      const point = screenToFlowPosition({ x, y })
      setNodeMenu(null)
      setAddMenu({
        x,
        y,
        flowX: point.x,
        flowY: point.y,
        sourceNodeId: connect?.nodeId,
        direction: connect?.direction,
      })
    },
    [screenToFlowPosition],
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      openAddMenu(e.clientX, e.clientY)
    },
    [openAddMenu],
  )

  const uploadAt = useCallback(
    (flowX: number, flowY: number) => {
      pendingUploadPos.current = { x: flowX, y: flowY }
      if (window.vibepaperDesktop) {
        if (!desktopProjectId) {
          toastError('没有已打开的本地项目，无法导入素材。')
          return
        }
        void window.vibepaperDesktop.importImage(desktopProjectId)
          .then((asset) => asset && addAssetNode(desktopAssetView(asset), flowX, flowY))
          .catch((error: unknown) => toastError(error instanceof Error ? error.message : '无法导入本地图片。'))
        setAddMenu(null)
        return
      }
      fileInputRef.current?.click()
      setAddMenu(null)
    },
    [addAssetNode, desktopProjectId],
  )

  useEffect(() => {
    const onAddAsset = (e: Event) => {
      const asset = (e as CustomEvent<AssetView>).detail
      if (!asset) return
      const point = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      void addAssetNode(asset, point.x, point.y).catch((err) => toastError((err as Error).message))
    }
    const onCreateDownstream = (e: Event) => {
      const detail = (e as CustomEvent<{ nodeId: string | number; x: number; y: number; direction?: string }>).detail
      if (!detail) return
      openAddMenu(detail.x, detail.y, {
        nodeId: sid(detail.nodeId),
        direction: detail.direction === 'upstream' ? 'upstream' : 'downstream',
      })
    }
    window.addEventListener('vp-add-asset-node', onAddAsset)
    window.addEventListener('vp-create-downstream-node', onCreateDownstream)
    return () => {
      window.removeEventListener('vp-add-asset-node', onAddAsset)
      window.removeEventListener('vp-create-downstream-node', onCreateDownstream)
    }
  }, [addAssetNode, openAddMenu, screenToFlowPosition])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const mod = e.metaKey || e.ctrlKey
      const selectedIds = nodes.filter((n) => n.selected).map((n) => sid(n.id))
      if (mod && e.key.toLowerCase() === 'c' && selectedIds.length) {
        e.preventDefault()
        copyNodes(selectedIds)
      } else if (mod && e.key.toLowerCase() === 'd' && selectedIds.length) {
        e.preventDefault()
        void duplicateNodes(selectedIds)
      } else if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void pasteNodes()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length) {
        e.preventDefault()
        requestDeleteNodes(selectedIds)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copyNodes, duplicateNodes, nodes, pasteNodes, requestDeleteNodes])

  const groupNodes: any[] = useMemo(
    () =>
      groups
        .map((g) => {
          const members = g.nodeIds.map((nid) => nodes.find((n) => n.id === sid(nid))).filter(Boolean) as FlowNode[]
          if (members.length === 0) return null
          const minX = Math.min(...members.map((m) => m.position.x)) - 14
          const minY = Math.min(...members.map((m) => m.position.y)) - 14
          const maxX = Math.max(...members.map((m) => m.position.x + (m.width ?? 300))) + 14
          const maxY = Math.max(...members.map((m) => m.position.y + (m.height ?? 240))) + 14
          return {
            id: `group-${sid(g.id)}`,
            type: 'group',
            position: { x: minX, y: minY },
            style: {
              width: maxX - minX,
              height: maxY - minY,
              border: `2px dashed ${g.color}`,
              borderRadius: 16,
              background: `${g.color}0d`,
            },
            data: { label: g.name },
            zIndex: -1,
          }
        })
        .filter((g): g is NonNullable<typeof g> => g !== null),
    [groups, nodes],
  )

  /** 堆叠折叠态：在首节点上叠加拼图预览徽章 */
  const stackBadges: any[] = useMemo(
    () =>
      stacks
        .filter((s) => s.collapsed)
        .map((s) => {
          const first = nodes.find((n) => sid(n.id) === sid(s.nodeIds[0]))
          if (!first) return null
          return {
            id: `stack-badge-${sid(s.id)}`,
            type: 'group',
            position: { x: first.position.x - 8, y: first.position.y - 28 },
            style: {
              width: Math.max(120, (first.width ?? 300) + 24),
              height: 22,
              border: 'none',
              background: 'transparent',
              pointerEvents: 'none',
            },
            data: { label: `堆叠拼图 · ${s.nodeIds.length} 张（双击展开）` },
            zIndex: 5,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [stacks, nodes],
  )

  if (isLoading) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-[#f2f2f2]">
        <Spinner className="h-8 w-8" />
        <p className="text-[13px] text-[#888]">正在打开画布…</p>
      </div>
    )
  }

  if (isError || !detail) {
    const msg = error instanceof Error ? error.message : '画布加载失败'
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[#f2f2f2] px-6 text-center">
        <p className="text-[18px] font-bold text-[#111]">无法打开画布</p>
        <p className="max-w-md text-[14px] text-[#666]">{msg}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refetch()}
            className="h-10 rounded-full bg-[#111] px-5 text-[14px] font-semibold text-white"
          >
            重试
          </button>
          <Link
            to="/workspace"
            className="inline-flex h-10 items-center rounded-full border border-black/10 bg-white px-5 text-[14px] font-semibold text-[#333]"
          >
            返回画布管理
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex h-screen w-screen overflow-hidden bg-[#f2f2f2]"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="relative min-h-0 min-w-0 flex-1">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,audio/*,text/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          const pos = pendingUploadPos.current ?? { x: 160, y: 160 }
          pendingUploadPos.current = null
          e.target.value = ''
          if (window.vibepaperDesktop) {
            if (files.length) toastError('桌面版文件选择请使用本地图片导入入口。')
            return
          }
          void (async () => {
            for (const file of files) {
              const asset = (await uploadAsset(file, undefined, canvasId)) as AssetView
              await addAssetNode(asset, pos.x, pos.y)
              pos.x += 40
              pos.y += 40
            }
          })().catch((err) => toastError((err as Error).message))
        }}
      />
      <CanvasTopBar desktopMode={desktopMode} />
      <div className="absolute left-4 top-1/2 z-20 -translate-y-1/2">
        <CanvasToolbar
          mode={mode}
          setMode={setMode}
          onFitView={() => void fitView()}
          onAutoLayout={onAutoLayout}
          onAddNode={(t) => void addNode(t)}
          desktopMode={desktopMode}
          projectId={desktopProjectId}
        />
      </div>
      <AssetLibrary desktopMode={desktopMode} projectId={desktopProjectId} />
      {!agentOpen ? <AgentLauncher onOpen={() => setAgentOpen(true)} /> : null}
      {!desktopMode && <SubscriptionMenu />}
      {!desktopMode && <AccountSidePanels />}

      <div className="relative h-full w-full">
      {nodes.length === 0 && detail && <CanvasWelcome onCreate={(type) => void addNode(type)} />}
      <ReactFlow
        nodes={[...groupNodes, ...stackBadges, ...nodes] as FlowNode[]}
        edges={edges.map((e) => ({
          ...e,
          style: {
            stroke: e.selected ? '#111111' : ((e.style?.stroke as string | undefined) ?? '#93c5fd'),
            strokeWidth: e.selected ? 2.5 : 1.5,
          },
        }))}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onDoubleClick={onDoubleClick}
        onPaneContextMenu={(e) => {
          e.preventDefault()
          openAddMenu(e.clientX, e.clientY)
        }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault()
          const id = sid(n.id)
          const selectedIds = nodes.filter((x) => x.selected).map((x) => sid(x.id))
          const ids = selectedIds.includes(id) && selectedIds.length > 0 ? selectedIds : [id]
          selectNode(id)
          setAddMenu(null)
          setNodeMenu({ x: e.clientX, y: e.clientY, nodeIds: ids })
        }}
        onPaneClick={() => {
          setAddMenu(null)
          setNodeMenu(null)
          selectNode(null)
          // 指南：点空白收起已展开的堆叠
          const expanded = stacks.filter((s) => !s.collapsed)
          if (expanded.length && canvas) {
            if (!window.vibepaperDesktop) {
              for (const s of expanded) {
                void api(`/canvases/${sid(canvas.canvas.id)}/stacks/${sid(s.id)}`, {
                  method: 'PUT',
                  body: JSON.stringify({ collapsed: true }),
                }).catch(() => undefined)
              }
            }
            const nextStacks = stacks.map((s) => ({ ...s, collapsed: true }))
            setStacks(nextStacks)
            // 折叠视觉：除首张外叠放
            let nextNodes = [...nodes]
            for (const s of nextStacks) {
              const ids = s.nodeIds.map(sid)
              const base = nextNodes.find((n) => sid(n.id) === ids[0])
              if (!base) continue
              nextNodes = nextNodes.map((n) => {
                const idx = ids.indexOf(sid(n.id))
                if (idx <= 0) return n
                return { ...n, position: { x: base.position.x + idx * 12, y: base.position.y + idx * 12 } }
              })
            }
            setNodes(nextNodes)
            setDirty(true)
          }
        }}
        onNodeClick={(_e, n) => {
          setNodeMenu(null)
          selectNode(sid(n.id))
        }}
        onNodeDoubleClick={(_e, n) => {
          const id = sid(n.id)
          selectNode(id)
          setEditingNodeId(id)
          // 指南：双击堆叠卡片展开
          const stack = stacks.find((s) => s.collapsed && s.nodeIds.map(sid).includes(id))
          if (stack && canvas) {
            if (window.vibepaperDesktop) {
              const ids = stack.nodeIds.map(sid)
              const base = nodes.find((x) => ids.includes(sid(x.id)) && sid(x.id) === ids[0])
              if (base) {
                setNodes(nodes.map((x) => {
                  const idx = ids.indexOf(sid(x.id))
                  if (idx < 0) return x
                  return { ...x, position: { x: base.position.x + (idx % 3) * 330, y: base.position.y + Math.floor(idx / 3) * 280 } }
                }))
                setDirty(true)
              }
              setStacks(stacks.map((item) => sid(item.id) === sid(stack.id) ? { ...item, collapsed: false } : item))
              setDirty(true)
              toastSuccess('堆叠已展开')
              return
            }
            void api(`/canvases/${sid(canvas.canvas.id)}/stacks/${sid(stack.id)}`, {
              method: 'PUT',
              body: JSON.stringify({ collapsed: false }),
            })
              .then(() => {
                const ids = stack.nodeIds.map(sid)
                const base = nodes.find((x) => sid(x.id) === ids[0])
                if (base) {
                  setNodes(
                    nodes.map((x) => {
                      const idx = ids.indexOf(sid(x.id))
                      if (idx < 0) return x
                      return {
                        ...x,
                        position: {
                          x: base.position.x + (idx % 3) * 330,
                          y: base.position.y + Math.floor(idx / 3) * 280,
                        },
                      }
                    }),
                  )
                  setDirty(true)
                }
                setStacks(stacks.map((s) => (sid(s.id) === sid(stack.id) ? { ...s, collapsed: false } : s)))
                toastSuccess('堆叠已展开')
              })
              .catch((e) => toastError((e as Error).message))
          }
        }}
        nodeTypes={nodeTypes as never}
        fitView
        minZoom={0.1}
        maxZoom={2.5}
        panOnDrag={mode === 'pan'}
        selectionOnDrag={mode === 'select'}
        panOnScroll
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default' }}
        connectionRadius={28}
        className="vp-dot-grid"
      >
        <Background gap={20} size={1} color="#c8c8c8" />
        <MiniMap pannable zoomable className="!bg-white" nodeStrokeColor="#111" />
        <Controls showInteractive={false} />
      </ReactFlow>
      </div>

      {addMenu && (
        <div
          className="fixed z-40 w-40 rounded-xl border border-black/10 bg-white p-1.5 shadow-xl"
          style={{
            left: Math.min(addMenu.x, window.innerWidth - 180),
            top: Math.min(addMenu.y, window.innerHeight - 320),
          }}
        >
          <p className="px-2.5 py-1 text-[11px] font-bold text-[#999]">
            {addMenu.direction === 'upstream' ? '新建上游' : addMenu.direction === 'downstream' ? '新建下游' : '新建节点'}
          </p>
          <button
            type="button"
            onClick={() => uploadAt(addMenu.flowX, addMenu.flowY)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-[#444] hover:bg-black/[0.04]"
          >
            <Upload size={14} /> 上传
          </button>
          <div className="my-1 border-t border-black/6" />
          {['text', 'image', 'video', 'audio', 'compose', 'director'].map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                void addNode(
                  t,
                  addMenu.flowX,
                  addMenu.flowY,
                  addMenu.sourceNodeId
                    ? { nodeId: addMenu.sourceNodeId, direction: addMenu.direction ?? 'downstream' }
                    : undefined,
                )
                setAddMenu(null)
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-[#444] hover:bg-black/[0.04]"
            >
              {t === 'text'
                ? '文本'
                : t === 'image'
                  ? '图片'
                  : t === 'video'
                    ? '视频'
                    : t === 'audio'
                      ? '音频'
                      : t === 'compose'
                        ? '合成'
                        : '导演台'}
            </button>
          ))}
        </div>
      )}

      {nodeMenu && (
        <div
          className="fixed z-40 w-44 overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-xl"
          style={{
            left: Math.min(nodeMenu.x, window.innerWidth - 190),
            top: Math.min(nodeMenu.y, window.innerHeight - 160),
          }}
        >
          <button
            type="button"
            onClick={() => copyNodes(nodeMenu.nodeIds)}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-semibold text-[#333] hover:bg-black/[0.05]"
          >
            <Copy size={15} className="text-[#666]" />
            <span className="flex-1 text-left">复制</span>
            <span className="text-[11px] font-medium text-[#aaa]">⌘C</span>
          </button>
          <button
            type="button"
            onClick={() => void duplicateNodes(nodeMenu.nodeIds)}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-semibold text-[#333] hover:bg-black/[0.05]"
          >
            <Files size={15} className="text-[#666]" />
            <span className="flex-1 text-left">副本</span>
            <span className="text-[11px] font-medium text-[#aaa]">⌘D</span>
          </button>
          <button
            type="button"
            onClick={() => requestDeleteNodes(nodeMenu.nodeIds)}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-semibold text-[#333] hover:bg-black/[0.05]"
          >
            <Trash2 size={15} className="text-[#666]" />
            <span className="flex-1 text-left">删除</span>
            <span className="text-[11px] font-medium text-[#aaa]">⌫</span>
          </button>
        </div>
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <p className="text-[16px] font-bold text-[#111]">确认删除节点？</p>
            <p className="mt-2 text-[13px] text-[#666]">
              将删除 {deleteConfirm.nodeIds.length} 个节点及其关联连线。
            </p>
            {deleteConfirm.downstream.length > 0 && (
              <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                <p className="font-bold">影响下游节点：</p>
                <ul className="mt-1 list-disc pl-4">
                  {deleteConfirm.downstream.slice(0, 8).map((d) => (
                    <li key={d.id}>
                      {d.type} · {d.id.slice(-6)}
                    </li>
                  ))}
                </ul>
                {deleteConfirm.downstream.length > 8 && (
                  <p className="mt-1">…等共 {deleteConfirm.downstream.length} 个</p>
                )}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="h-9 rounded-full px-4 text-[13px] font-semibold text-[#555] hover:bg-black/[0.04]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteNodes()}
                className="h-9 rounded-full bg-[#111] px-4 text-[13px] font-bold text-white"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
      {!desktopMode
        ? <AgentPanel />
        : agentOpen && desktopProjectId && <AgentPanel desktopAdapter={desktopAgent} />}
      {desktopMode && desktopAgent.settingsDialog}
    </div>
  )
}
