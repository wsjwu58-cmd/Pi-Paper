import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
  SelectionMode,
  useReactFlow,
} from '@xyflow/react'
import { Copy, Files, Trash2, Upload } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import { api, ApiError, uploadAsset } from '@/lib/api'
import { isValidEntityId, sid } from '@/lib/ids'
import type { AssetView, CanvasDetail, EdgePayload, GroupPayload, ModelInfo, NodePayload } from '@/lib/types'
import { buildFlow, createCanvasGroup, mergeHydrateFlow, nodeMediaUrl, removeCanvasGroupFromStore, toPayloads, toEdgePayloads, useCanvasStore, type FlowNode } from './canvasStore'
import { nodeTypes, useNodeTasks } from './nodes'
import { isGenerationInFlight } from './nodes/generation-progress'
import { textNodeContent } from './nodes/textContent'
import { pickLatestTask } from './nodes/generation-task-selection'
import { LocalMcpConnectorPanel } from '@/features/marketplace/LocalMcpConnectorPanel'
import { CanvasTopBar } from './CanvasTopBar'
import { CanvasToolbar } from './CanvasToolbar'
import { basicNodeCatalog, compatibleNodeType, createNodeDefinitionInstance, projectNodeCatalog, type ProjectNodeItem } from './nodeDefinitionCatalog'
import { CanvasPlugins } from './CanvasPlugins'
import { describeCreativeCommands, getCreativeCommandDescriptor } from './creativeCommandCatalog'
import { PosterEditor } from './PosterEditor'
import { mergePosterResult, withPosterLayout } from './posterGraph'
import { StoryboardEditor, type StoryboardRow } from './StoryboardEditor'
import { readMediaTool, readPosterLayout } from './creativePluginRuntime'
import type { PosterLayout, StoryboardField } from './creativePluginTypes'
import { buildPluginTemplateGraph, changedPluginPresetPatch, commitPluginTemplateGraph, isPluginModelParameter, overwrittenPluginPresetFields, pluginPresetPatch, readPluginTemplate, templateFromSelection } from './pluginComponents'
import { CanvasGroupView } from './CanvasGroupView'
import { arrangeCanvasGroupNodes, canvasGroupMemberIds, getCanvasGroupBounds, getCanvasGroupDownloadCandidates, moveCanvasGroupNodes, detachOutsideGroup, type CanvasGroupBounds } from './canvasGroupUtils'
import { GenerationReferenceEdge } from './GenerationReferenceEdge'
import { canonicalCanvasEdges } from './canvasEdges'
import { AgentMarkdown } from './AgentMarkdown'
import { downloadNodeOutput } from './nodes/nodeDownloads'
import { AssetLibrary } from './AssetLibrary'
import { AgentLauncher, AgentPanel } from './AgentPanel'
import { useDesktopAgentController } from './useDesktopAgentController'
import { SubscriptionMenu } from './SubscriptionMenu'
import { AccountSidePanels } from './AccountSidePanels'
import { CanvasWelcome } from './CanvasWelcome'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { Spinner } from '@/components/ui/Spinner'
import { applySavedCanvasStaleNodeIds, createCanvasNodePort, deleteCanvasEdgePort, desktopAssetView, desktopCanvasDetail, importedAssetNodePayload, isDesktopRuntime, loadCanvasPort, saveCanvasPort } from './canvasPort'
import {
  createMcpCanvasFlushResponse,
  flushCanvasPersistence,
  isFinalMcpCanvasImeInput,
  registerCanvasPersistence,
  settleMcpCanvasFlushRequest,
  shouldBlockMcpCanvasInput,
} from './canvasPersistence'
import type { DesktopCanvas, DesktopMcpCanvasFlushRequest, DesktopMcpEvent, DesktopMcpPendingAction, DesktopMcpProviderInputRequest, DesktopProviderConfiguration } from '@/desktop/desktop-bridge'
import { providerConfigurationRefreshQueryKeys } from '@/features/providers/providerConfigurationEvents'
import { canvasMotionDuration, CANVAS_MOTION, markNodeArrival, useLayoutMotion, useSoftValue } from './canvasMotion'
import { canvasPageQueryOptions, canHydrateCanvasPage } from './canvasPageQuery'

const saveDebounce = 500
const edgeTypes = { default: GenerationReferenceEdge }
let nodeClipboard: NodePayload[] = []
const MCP_TERMINAL_ACTION_STATUSES = new Set([
  'approved', 'rejected', 'expired', 'timed_out', 'timeout', 'cancelled', 'canceled', 'invalidated', 'submitted', 'submission_unknown', 'submission-unknown',
  'succeeded', 'completed', 'failed', 'denied',
])

function upsertMcpGenerationAction(actions: DesktopMcpPendingAction[], action: DesktopMcpPendingAction): DesktopMcpPendingAction[] {
  if (MCP_TERMINAL_ACTION_STATUSES.has(action.status)) return actions.filter((item) => item.proposalId !== action.proposalId)
  const index = actions.findIndex((item) => item.proposalId === action.proposalId)
  if (index < 0) return [...actions, action]
  return actions.map((item, itemIndex) => itemIndex === index ? action : item)
}

export function CanvasPage() {
  useUiLanguage()
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
  useUiLanguage()
  const navigate = useNavigate()
  const nodes = useCanvasStore((s) => s.nodes)
  const layoutMotion = useLayoutMotion(nodes)
  const [dragGroupBounds, setDragGroupBounds] = useState<Record<string, CanvasGroupBounds>>({})
  const dragBoundsRef = useRef<Record<string, CanvasGroupBounds>>({})
  const edges = useCanvasStore((s) => s.edges)
  const { tasks: generationTasks } = useNodeTasks()
  const canvasNodesById = useMemo(() => new Map(nodes.map((node) => [sid(node.id), node.data.node])), [nodes])
  const generationTasksById = useMemo(() => new Map(generationTasks.map((task) => [sid(task.taskId), task])), [generationTasks])
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
  const selectedGroupId = useCanvasStore((s) => s.selectedGroupId)
  const selectGroup = useCanvasStore((s) => s.selectGroup)
  const setEditingNodeId = useCanvasStore((s) => s.setEditingNodeId)
  const agentOpen = useCanvasStore((s) => s.agentOpen)
  const setAgentOpen = useCanvasStore((s) => s.setAgentOpen)
  const [mode, setMode] = useState<'select' | 'pan'>('select')
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [pluginTarget, setPluginTarget] = useState<{ nodeId: string; nodeType: string } | null>(null)
  const [pluginBusy, setPluginBusy] = useState(false)
  const [posterDraft, setPosterDraft] = useState<{ sourceNodeId: string; sourceNodeMediaUrl: string; sourceUrl: string; initial: PosterLayout } | null>(null)
  const [storyboardDraft, setStoryboardDraft] = useState<{ nodes: FlowNode[]; fields: StoryboardField[]; rows: StoryboardRow[] } | null>(null)
  const [lastArrangement, setLastArrangement] = useState<string | null>(null)
  const [connectorDraft, setConnectorDraft] = useState<{ packageId: string; componentId: string; nodeId: string } | null>(null)
  const generationTasksRef = useRef(generationTasks)
  generationTasksRef.current = generationTasks
  const pluginBusyRef = useRef(false)
  const [pluginConfirmation, setPluginConfirmation] = useState<{ message: string; confirmLabel: string; resolve: (confirmed: boolean) => void } | null>(null)
  const pluginConfirmationRef = useRef<{ resolve: (confirmed: boolean) => void } | null>(null)
  const [addMenu, setAddMenu] = useState<{
    x: number
    y: number
    flowX: number
    flowY: number
    sourceNodeId?: string
    direction?: 'upstream' | 'downstream'
  } | null>(null)
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number; nodeIds: string[] } | null>(null)
  const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const addMenuPresence = useSoftValue(addMenu)
  const nodeMenuPresence = useSoftValue(nodeMenu)
  const edgeMenuPresence = useSoftValue(edgeMenu)
  const animatedAddMenu = addMenuPresence.value
  const animatedNodeMenu = nodeMenuPresence.value
  const animatedEdgeMenu = edgeMenuPresence.value
  const [readingNodeId, setReadingNodeId] = useState<string | null>(null)
  const readingDialogRef = useRef<HTMLDivElement>(null)
  const readingCloseButtonRef = useRef<HTMLButtonElement>(null)
  const readingNode = nodes.find((node) => node.id === readingNodeId)?.data.node
  const readingPresence = useSoftValue(readingNode)
  useEffect(() => {
    if (!readingNodeId) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    readingCloseButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setReadingNodeId(null)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = readingDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')
      if (!focusable?.length) {
        event.preventDefault()
        return
      }
      const first = focusable.item(0)
      const last = focusable.item(focusable.length - 1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [readingNodeId])
  useEffect(() => {
    const openReader = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId
      if (nodeId) setReadingNodeId(sid(nodeId))
    }
    window.addEventListener('vp-read-text-node', openReader)
    return () => window.removeEventListener('vp-read-text-node', openReader)
  }, [])
  const [deleteConfirm, setDeleteConfirm] = useState<{
    nodeIds: string[]
    downstream: Array<{ id: string; type: string }>
  } | null>(null)
  const { fitView, screenToFlowPosition } = useReactFlow()
  const queryClient = useQueryClient()
  const saveTimer = useRef<number | null>(null)
  const positionSaveQueue = useRef<Promise<void>>(Promise.resolve())
  const externalSyncPending = useRef(false)
  const externalSyncTimer = useRef<number | null>(null)
  const hydratingRef = useRef(true)
  const [savedVersion, setSavedVersion] = useState<number | null>(null)
  const [mcpCanvasBarrierPhase, setMcpCanvasBarrierPhase] = useState<'idle' | 'pending' | 'active'>('idle')
  const mcpCanvasBarrierPhaseRef = useRef<'idle' | 'pending' | 'active'>('idle')
  const mcpCanvasBarrierRequestsRef = useRef(new Map<string, DesktopMcpCanvasFlushRequest>())
  const mcpCanvasFlushPromiseRef = useRef<Promise<number> | null>(null)
  const mcpCanvasInputSurfaceRef = useRef<HTMLDivElement>(null)
  const mcpActivePointerIdsRef = useRef(new Set<number>())
  const mcpComposingRef = useRef(false)
  const mcpAuthoritativeRefreshRef = useRef<{ targetVersion: number; promise: Promise<number> } | null>(null)
  const mcpAppliedCanvasScopeRef = useRef<string | null>(null)
  const mcpAppliedCanvasVersionRef = useRef(0)
  const mcpExactHydrateRef = useRef<string | null>(null)
  const [mcpGenerationConfirmations, setMcpGenerationConfirmations] = useState<DesktopMcpPendingAction[]>([])
  const [mcpProviderInput, setMcpProviderInput] = useState<DesktopMcpProviderInputRequest | null>(null)
  const [mcpProviderInputBusy, setMcpProviderInputBusy] = useState(false)
  const mcpProviderInputRef = useRef<DesktopMcpProviderInputRequest | null>(null)
  const mcpCanvasPageMountedRef = useRef(false)
  const skipNextSave = useRef(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pendingUploadPos = useRef<{ x: number; y: number } | null>(null)
  const pendingEdgeDelete = useRef<{ dirtyBefore: boolean; edgesBefore: Edge[] } | null>(null)

  useEffect(() => () => {
    pluginConfirmationRef.current?.resolve(false)
    pluginConfirmationRef.current = null
  }, [])

  useEffect(() => {
    const openNodePresets = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: string; nodeType?: string }>).detail
      if (!detail?.nodeId || !detail.nodeType) return
      setPluginTarget({ nodeId: sid(detail.nodeId), nodeType: detail.nodeType })
      setPluginsOpen(true)
    }
    window.addEventListener('vp-open-node-plugin-presets', openNodePresets)
    return () => window.removeEventListener('vp-open-node-plugin-presets', openNodePresets)
  }, [])

  const desktopMode = isDesktopRuntime()
  const [desktopHydratedCanvasId, setDesktopHydratedCanvasId] = useState<string | null>(null)
  const {
    data: loadedCanvas,
    isLoading,
    isError,
    isSuccess,
    isFetchedAfterMount,
    error,
    refetch,
  } = useQuery(canvasPageQueryOptions(canvasId, desktopMode, loadCanvasPort))
  // Cached snapshots remain useful to Web, but desktop must not display or
  // register one until this page's local-core read has completed successfully.
  const canHydrate = canHydrateCanvasPage(desktopMode, { isFetchedAfterMount, isSuccess })
  const detail = canHydrate ? loadedCanvas?.detail : undefined
  const desktopProjectId = canHydrate ? loadedCanvas?.projectId : undefined
  const { data: marketplacePackages = [] } = useQuery({
    queryKey: ['desktop-marketplace', desktopProjectId],
    enabled: Boolean(desktopMode && desktopProjectId && window.vibepaperDesktop?.marketplace),
    queryFn: () => window.vibepaperDesktop!.marketplace.list(desktopProjectId),
  })
  const projectNodes = useMemo(() => projectNodeCatalog(marketplacePackages), [marketplacePackages])
  useEffect(() => {
    const subscribe = window.vibepaperDesktop?.marketplace.subscribeMarketplaceChanges
    if (!desktopProjectId || !subscribe) return
    return subscribe((event) => { if (event.projectId === desktopProjectId) {
      void queryClient.invalidateQueries({ queryKey: ['desktop-marketplace', desktopProjectId] })
      void queryClient.invalidateQueries({ queryKey: ['desktop-basic-node-visibility', desktopProjectId] })
    } })
  }, [desktopProjectId, queryClient])
  const { data: basicVisibility } = useQuery({
    queryKey: ['desktop-basic-node-visibility', desktopProjectId],
    enabled: Boolean(desktopMode && desktopProjectId && window.vibepaperDesktop?.marketplace),
    queryFn: () => window.vibepaperDesktop!.marketplace.getBasicNodeVisibility(desktopProjectId!),
  })
  const basicNodes = basicNodeCatalog(basicVisibility?.hidden ?? []).filter((item) => item.visible && (!desktopMode || Boolean(basicVisibility)))
  const desktopCanvasMatches = !desktopMode || Boolean(desktopProjectId && detail && sid(detail.canvas.id) === canvasId)
  const desktopPageHydrated = !desktopMode || Boolean(canHydrate && desktopHydratedCanvasId === canvasId && desktopCanvasMatches)

  const changeMcpCanvasBarrierPhase = useCallback((phase: 'idle' | 'pending' | 'active') => {
    mcpCanvasBarrierPhaseRef.current = phase
    setMcpCanvasBarrierPhase(phase)
  }, [])

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
    const onGroupSnapshot = () => {
      // A one-member crop group is persisted through the existing full-canvas
      // snapshot because the legacy addGroup command requires two members.
      skipNextSave.current = false
    }
    window.addEventListener('vp-canvas-group-snapshot', onGroupSnapshot)
    return () => window.removeEventListener('vp-canvas-group-snapshot', onGroupSnapshot)
  }, [])

  useEffect(() => {
    if (!detail) return
    hydratingRef.current = true
    skipNextSave.current = true
    const previousCanvas = useCanvasStore.getState().canvas
    const existingNodeIds = new Set(useCanvasStore.getState().nodes.map((n) => sid(n.id)))
    const sameCanvas = previousCanvas && sid(previousCanvas.canvas.id) === sid(detail.canvas.id)
    const exactMcpHydrate = mcpExactHydrateRef.current === `${canvasId}:${detail.canvas.version}`
    if (exactMcpHydrate) mcpExactHydrateRef.current = null
    if (sameCanvas && externalSyncPending.current) {
      for (const node of detail.nodes) if (!existingNodeIds.has(sid(node.id))) markNodeArrival(sid(node.id))
    }
    setCanvas(detail)
    const flow = buildFlow(detail, selectNode)
    const merged = exactMcpHydrate ? flow.nodes : mergeHydrateFlow(flow.nodes, useCanvasStore.getState().nodes)
    setNodes(merged.map((n) => ({ ...n, data: { ...n.data, models: models ?? [] } })))
    setEdges(flow.edges)
    setGroups(detail.groups)
    selectGroup(null)
    setStacks(detail.stacks)
    setSavedVersion(detail.canvas.version)
    // Hydrating the authoritative server snapshot is not a local edit. Clear
    // any stale dirty flag so a refresh (or an Agent write) cannot trigger a
    // full-save/version bump loop immediately after hydration.
    setDirty(false)
    if (desktopMode && desktopCanvasMatches) setDesktopHydratedCanvasId(canvasId)
    window.setTimeout(() => {
      hydratingRef.current = false
    }, 0)
    // 仅在画布 detail 变化时整表 hydrate；models 单独注入，避免覆盖已编辑的 prompt
  }, [canvasId, detail, desktopCanvasMatches, desktopMode, setCanvas, setNodes, setEdges, setGroups, setStacks, setDirty, selectNode, selectGroup])

  useEffect(() => {
    if (!models) return
    const current = useCanvasStore.getState().nodes
    if (current.length === 0) return
    skipNextSave.current = true
    setNodes(current.map((n) => ({ ...n, data: { ...n.data, models } })))
  }, [models, setNodes])

  const desktopSaveInFlight = useRef<Promise<void> | null>(null)
  const desktopSaveIntent = useRef<{
    canvasId: string
    version: number
    nodes: typeof nodes
    edges: typeof edges
    groups: typeof groups
    stacks: typeof stacks
    key: string
  } | null>(null)
  const deletePresence = useSoftValue(deleteConfirm)
  const animatedDeleteConfirm = deletePresence.value

  const persistDesktopChanges = useCallback(async () => {
    if (!window.vibepaperDesktop) return
    while (true) {
      const snapshot = useCanvasStore.getState()
      if (!snapshot.dirty) return
      if (!snapshot.canvas || !desktopProjectId) throw new Error(uiText("没有可保存的本地画布。"))
      if (desktopSaveInFlight.current) {
        await desktopSaveInFlight.current
        continue
      }

      const pending = (async () => {
        setSaving(true)
        try {
          const canvasId = sid(snapshot.canvas!.canvas.id)
          const priorIntent = desktopSaveIntent.current
          const sameIntent = priorIntent?.canvasId === canvasId
            && priorIntent.version === snapshot.canvas!.canvas.version
            && priorIntent.nodes === snapshot.nodes
            && priorIntent.edges === snapshot.edges
            && priorIntent.groups === snapshot.groups
            && priorIntent.stacks === snapshot.stacks
          const key = sameIntent ? priorIntent.key : crypto.randomUUID()
          if (!sameIntent) desktopSaveIntent.current = {
            canvasId,
            version: snapshot.canvas!.canvas.version,
            nodes: snapshot.nodes,
            edges: snapshot.edges,
            groups: snapshot.groups,
            stacks: snapshot.stacks,
            key,
          }
          const result = await saveCanvasPort({
            projectId: desktopProjectId,
            canvasId,
            expectedVersion: snapshot.canvas!.canvas.version,
            idempotencyKey: key,
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
            const currentNodes = useCanvasStore.getState().nodes
            const nodesWithStaleOutputs = applySavedCanvasStaleNodeIds(currentNodes, result.staleNodeIds)
            if (nodesWithStaleOutputs !== currentNodes) setNodes(nodesWithStaleOutputs)
          }
          setDirty(sameGraph ? false : true)
          if (desktopSaveIntent.current?.key === key) desktopSaveIntent.current = null
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
  }, [desktopProjectId, setCanvas, setDirty, setNodes, setSavedVersion, setSaving])

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
  }, [persistDesktopChanges])

  useEffect(
    () => registerCanvasPersistence(desktopProjectId, canvasId, flushDesktopEdits),
    [canvasId, desktopProjectId, flushDesktopEdits],
  )

  useEffect(() => {
    mcpCanvasPageMountedRef.current = true
    return () => {
      mcpCanvasPageMountedRef.current = false
      mcpProviderInputRef.current = null
    }
  }, [])

  useEffect(() => {
    const bridge = window.vibepaperDesktop
    if (!desktopMode || !bridge || !desktopProjectId) return
    return bridge.subscribeMcpProviderInput((request) => {
      if (request.projectId !== desktopProjectId || request.canvasId !== canvasId) return
      mcpProviderInputRef.current = request
      setMcpProviderInput(request)
    })
  }, [canvasId, desktopMode, desktopProjectId])

  useEffect(() => {
    if (!desktopMode) return
    const activePointerIds = mcpActivePointerIdsRef.current
    let imeCommitTimer: number | null = null
    let imeCommitFrame: number | null = null
    let imeCommitPending = false
    const onCanvasInput = (event: Event) => {
      const phase = mcpCanvasBarrierPhaseRef.current
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target]
      const inMcpPage = path.some((target) => target instanceof Element && (
        target.matches('[data-testid="mcp-canvas-page"], [data-mcp-canvas-edit-portal]')
        || Boolean(target.closest('[data-testid="mcp-canvas-page"], [data-mcp-canvas-edit-portal]'))
      ))
      const editableTarget = event.target instanceof Element && Boolean(event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
      const pointerId = 'pointerId' in event && typeof event.pointerId === 'number' ? event.pointerId : undefined
      const isActivePointer = pointerId !== undefined && activePointerIds.has(pointerId)
      const isTypingEvent = ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'paste', 'cut', 'compositionstart', 'compositionupdate', 'compositionend'].includes(event.type)
      const relevant = inMcpPage || isActivePointer || mcpComposingRef.current || (phase !== 'idle' && isTypingEvent && (editableTarget || phase === 'active'))

      if (event.type === 'pointerdown' && phase === 'idle' && inMcpPage && pointerId !== undefined) {
        activePointerIds.add(pointerId)
      }
      if (event.type === 'compositionstart' && phase === 'idle' && (inMcpPage || editableTarget)) {
        mcpComposingRef.current = true
        imeCommitPending = false
        if (imeCommitTimer !== null) window.clearTimeout(imeCommitTimer)
        imeCommitTimer = null
        if (imeCommitFrame !== null) window.cancelAnimationFrame(imeCommitFrame)
        imeCommitFrame = null
      }

      if (relevant && shouldBlockMcpCanvasInput({
        phase,
        eventType: event.type,
        pointerId,
        activePointerIds,
        composing: mcpComposingRef.current,
      })) {
        event.preventDefault()
        event.stopPropagation()
        if ('stopImmediatePropagation' in event) event.stopImmediatePropagation()
      }

      if ((event.type === 'pointerup' || event.type === 'pointercancel') && pointerId !== undefined) {
        activePointerIds.delete(pointerId)
      }
      if (event.type === 'compositionend' && mcpComposingRef.current) {
        // Browsers may dispatch the final beforeinput/input after compositionend.
        // Keep the in-flight composition open until the final InputEvent has
        // passed through React, then release on the next frame. The timeout is
        // only a bounded fallback for browsers that omit that event.
        imeCommitPending = true
        if (imeCommitTimer !== null) window.clearTimeout(imeCommitTimer)
        imeCommitTimer = window.setTimeout(() => {
          imeCommitTimer = null
          imeCommitPending = false
          mcpComposingRef.current = false
        }, 250)
      }
      if (event.type === 'input' && imeCommitPending) {
        const inputEvent = event as InputEvent
        if (isFinalMcpCanvasImeInput({
          afterCompositionEnd: imeCommitPending,
          eventType: event.type,
          isComposing: inputEvent.isComposing,
          inputType: inputEvent.inputType,
        })) {
          imeCommitPending = false
          if (imeCommitTimer !== null) window.clearTimeout(imeCommitTimer)
          imeCommitTimer = null
          if (imeCommitFrame !== null) window.cancelAnimationFrame(imeCommitFrame)
          imeCommitFrame = window.requestAnimationFrame(() => {
            imeCommitFrame = null
            mcpComposingRef.current = false
          })
        }
      }
    }
    const inputEvents = [
      'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup',
      'touchstart', 'touchmove', 'touchend', 'touchcancel', 'click', 'auxclick', 'dblclick', 'contextmenu',
      'wheel', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'paste', 'cut', 'drop',
      'drag', 'dragstart', 'dragover', 'compositionstart', 'compositionupdate', 'compositionend',
    ]
    for (const type of inputEvents) document.addEventListener(type, onCanvasInput, true)
    return () => {
      for (const type of inputEvents) document.removeEventListener(type, onCanvasInput, true)
      activePointerIds.clear()
      mcpComposingRef.current = false
      imeCommitPending = false
      if (imeCommitTimer !== null) window.clearTimeout(imeCommitTimer)
      imeCommitTimer = null
      if (imeCommitFrame !== null) window.cancelAnimationFrame(imeCommitFrame)
      imeCommitFrame = null
    }
  }, [desktopMode])

  useEffect(() => {
    const bridge = window.vibepaperDesktop
    if (!desktopMode || !desktopPageHydrated || !bridge || !desktopProjectId) return
    let disposed = false
    const barrierRequests = mcpCanvasBarrierRequestsRef.current
    const scopeKey = `${desktopProjectId}:${canvasId}`
    if (mcpAppliedCanvasScopeRef.current !== scopeKey) {
      mcpAppliedCanvasScopeRef.current = scopeKey
      mcpAppliedCanvasVersionRef.current = 0
      mcpAuthoritativeRefreshRef.current = null
    }

    const matchesActiveCanvas = (projectId?: string, eventCanvasId?: string) => (
      projectId === desktopProjectId && eventCanvasId === canvasId
    )
    const applyAuthoritativeCanvas = (requiredVersion = 0): Promise<number> => {
      const currentRefresh = mcpAuthoritativeRefreshRef.current
      if (currentRefresh && currentRefresh.targetVersion >= requiredVersion) return currentRefresh.promise
      const previousRefresh = currentRefresh?.promise
      const job = (async () => {
        if (previousRefresh) await previousRefresh.catch(() => undefined)
        let activeProject: Awaited<ReturnType<typeof bridge.getActiveProject>> = null
        let desktopCanvas: DesktopCanvas | null = null
        for (let attempt = 0; attempt < 20; attempt += 1) {
          ;[activeProject, desktopCanvas] = await Promise.all([
            bridge.getActiveProject(),
            bridge.loadCanvas(desktopProjectId, canvasId),
          ])
          if (disposed || !activeProject || activeProject.projectId !== desktopProjectId || activeProject.canvasId !== canvasId) {
            throw new Error(uiText('当前项目或画布已切换。'))
          }
          if (desktopCanvas.version >= requiredVersion) break
          await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
        }
        if (!desktopCanvas || desktopCanvas.version < requiredVersion) throw new Error('CANVAS_VERSION_NOT_SETTLED')
        if (!activeProject || activeProject.projectId !== desktopProjectId || activeProject.canvasId !== canvasId) throw new Error(uiText('当前项目或画布已切换。'))
        if (desktopCanvas.version < mcpAppliedCanvasVersionRef.current) throw new Error('STALE_CANVAS_SNAPSHOT')
        const authoritative = desktopCanvasDetail(desktopCanvas, activeProject)
        const current = useCanvasStore.getState()
        if (current.dirty) throw new Error(uiText('画布在外部写入期间仍有未保存编辑，已保留本地内容。'))

        hydratingRef.current = true
        skipNextSave.current = true
        mcpAppliedCanvasVersionRef.current = authoritative.canvas.version
        mcpExactHydrateRef.current = `${canvasId}:${authoritative.canvas.version}`
        setCanvas(authoritative)
        const flow = buildFlow(authoritative, selectNode)
        setNodes(flow.nodes.map((node) => ({ ...node, data: { ...node.data, models: models ?? [] } })))
        setEdges(flow.edges)
        setGroups(authoritative.groups)
        selectGroup(null)
        setStacks(authoritative.stacks)
        setSavedVersion(authoritative.canvas.version)
        setDirty(false)
        queryClient.setQueryData(['canvas', canvasId], { detail: authoritative, projectId: desktopProjectId })
        window.setTimeout(() => { hydratingRef.current = false }, 0)
        // Let the exact hydrate render before the input barrier is lifted.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
        return authoritative.canvas.version
      })()
      let promise: Promise<number>
      promise = job.finally(() => {
        if (mcpAuthoritativeRefreshRef.current?.promise === promise) mcpAuthoritativeRefreshRef.current = null
      })
      mcpAuthoritativeRefreshRef.current = { targetVersion: requiredVersion, promise }
      return promise
    }

    const releaseBarrier = (requestId: string, projectId: string, settledCanvasId: string) => {
      if (!settleMcpCanvasFlushRequest(barrierRequests, { requestId, projectId, canvasId: settledCanvasId })) return
      if (barrierRequests.size === 0) {
        mcpCanvasFlushPromiseRef.current = null
        changeMcpCanvasBarrierPhase('idle')
      } else {
        changeMcpCanvasBarrierPhase('active')
      }
    }

    const onMcpEvent = (event: DesktopMcpEvent) => {
      if (event.type === 'provider.configuration.changed') {
        const configuration = queryClient.getQueryData<DesktopProviderConfiguration>(['desktop-provider-configuration'])
        const knownRevision = configuration?.providers.find((provider) => provider.id === event.providerId)?.revision
        const queryKeys = providerConfigurationRefreshQueryKeys(event, knownRevision)
        for (const queryKey of queryKeys) void queryClient.invalidateQueries({ queryKey })
        if (queryKeys.length) window.dispatchEvent(new Event('vp-desktop-model-catalog-changed'))
        return
      }
      if (event.type === 'pending-action.created' || event.type === 'pending-action.updated') {
        const action = event.action
        if (action.kind !== 'generation' || !matchesActiveCanvas(action.projectId, action.canvasId)) return
        setMcpGenerationConfirmations((current) => upsertMcpGenerationAction(current, action))
        if (!MCP_TERMINAL_ACTION_STATUSES.has(action.status)) setAgentOpen(true)
        return
      }
      if (event.type === 'task.changed' && matchesActiveCanvas(event.projectId, event.canvasId)) {
        window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { taskId: event.taskId, status: event.status } }))
        return
      }
      if (event.type === 'canvas.changed' && matchesActiveCanvas(event.projectId, event.canvasId)) {
        externalSyncPending.current = true
        void applyAuthoritativeCanvas(event.version).then(() => {
          externalSyncPending.current = false
        }).catch((error) => {
          externalSyncPending.current = false
          toastError(error instanceof Error ? error.message : uiText('外部画布变更同步失败。'))
        })
        return
      }
      if (event.type === 'canvas.write-settled'
        && barrierRequests.has(event.requestId)
        && matchesActiveCanvas(event.projectId, event.canvasId)) {
        if (event.status === 'aborted') {
          releaseBarrier(event.requestId, event.projectId, event.canvasId)
          if (event.errorCode) toastError(uiText('外部画布写入未完成：{0}', { 0: event.errorCode }))
          return
        }
        void applyAuthoritativeCanvas(event.version ?? 0).then(() => releaseBarrier(event.requestId, event.projectId, event.canvasId)).catch((error) => {
          toastError(error instanceof Error ? error.message : uiText('外部画布变更同步失败。'))
          releaseBarrier(event.requestId, event.projectId, event.canvasId)
        })
      }
    }

    const waitForActiveInput = async (timeoutMs: number) => {
      const started = Date.now()
      while (mcpActivePointerIdsRef.current.size > 0 || mcpComposingRef.current) {
        if (disposed || Date.now() - started >= timeoutMs) return false
        await new Promise<void>((resolve) => window.setTimeout(resolve, 25))
      }
      return true
    }

    const onCanvasFlush = (request: DesktopMcpCanvasFlushRequest) => {
      void (async () => {
        const sendFailure = async (errorCode: string) => {
          await bridge.respondMcpCanvasFlush(createMcpCanvasFlushResponse(request, { status: 'failed', errorCode })).catch(() => undefined)
        }
        if (disposed) {
          await sendFailure('CANVAS_CLOSED')
          return
        }
        const requests = barrierRequests
        if (!matchesActiveCanvas(request.projectId, request.canvasId) || requests.has(request.requestId) || requests.size >= 8) {
          await sendFailure('CANVAS_NOT_READY')
          return
        }
        requests.set(request.requestId, request)
        if (mcpCanvasFlushPromiseRef.current) {
          if (mcpCanvasBarrierPhaseRef.current === 'idle') changeMcpCanvasBarrierPhase('pending')
        } else {
          changeMcpCanvasBarrierPhase('pending')
          mcpCanvasFlushPromiseRef.current = (async () => {
            if (!await waitForActiveInput(5_000)) {
              throw new Error(disposed ? 'CANVAS_CLOSED' : 'CANVAS_INPUT_BUSY')
            }
            if (disposed) throw new Error('CANVAS_CLOSED')
            changeMcpCanvasBarrierPhase('active')
            await flushDesktopEdits()
            if (disposed) throw new Error('CANVAS_CLOSED')
            const snapshot = useCanvasStore.getState()
            if (snapshot.dirty || !snapshot.canvas) throw new Error('CANVAS_SAVE_INCOMPLETE')
            return snapshot.canvas.canvas.version
          })()
        }
        try {
          const persistedVersion = await mcpCanvasFlushPromiseRef.current
          if (persistedVersion === null) throw new Error('CANVAS_SAVE_INCOMPLETE')
          // Unmount already returned a closed acknowledgement for this request.
          // Do not let a late save completion overwrite it with a success ack.
          if (disposed || requests.get(request.requestId) !== request) return
          await bridge.respondMcpCanvasFlush(createMcpCanvasFlushResponse(request, { status: 'flushed', persistedVersion }))
        } catch (error) {
          if (requests.get(request.requestId) !== request) return
          const errorCode = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message) ? error.message : 'CANVAS_SAVE_FAILED'
          await sendFailure(errorCode)
          if (errorCode !== 'CANVAS_INPUT_BUSY') toastError(uiText('外部画布写入前保存失败，已保留未保存编辑。'))
          releaseBarrier(request.requestId, request.projectId, request.canvasId)
        }
      })()
    }

    const unsubscribeEvents = bridge.subscribeMcpEvents(onMcpEvent)
    const unsubscribeFlush = bridge.subscribeMcpCanvasFlush(onCanvasFlush)
    void bridge.getMcpPendingActions().then(({ actions }) => {
      if (disposed) return
      const relevant = actions.filter((action) => action.kind === 'generation' && matchesActiveCanvas(action.projectId, action.canvasId)
        && !MCP_TERMINAL_ACTION_STATUSES.has(action.status))
      setMcpGenerationConfirmations(relevant)
      if (relevant.length) setAgentOpen(true)
    }).catch(() => undefined)
    const currentCanvasVersion = useCanvasStore.getState().canvas?.canvas.version
    void bridge.setMcpCanvasReady({ projectId: desktopProjectId, canvasId, ready: true, version: currentCanvasVersion }).catch(() => {
      if (!disposed) toastError(uiText('MCP 画布同步未就绪，请重新打开画布。'))
    })

    return () => {
      disposed = true
      unsubscribeEvents()
      unsubscribeFlush()
      for (const pending of barrierRequests.values()) {
        if (pending.projectId === desktopProjectId && pending.canvasId === canvasId) {
          void bridge.respondMcpCanvasFlush(createMcpCanvasFlushResponse(pending, { status: 'failed', errorCode: 'CANVAS_CLOSED' })).catch(() => undefined)
        }
      }
      barrierRequests.clear()
      mcpCanvasFlushPromiseRef.current = null
      changeMcpCanvasBarrierPhase('idle')
      void bridge.setMcpCanvasReady({ projectId: desktopProjectId, canvasId, ready: false }).catch(() => undefined)
    }
  }, [
    canvasId, changeMcpCanvasBarrierPhase, desktopMode, desktopPageHydrated, desktopProjectId, flushDesktopEdits,
    models, queryClient, selectGroup, selectNode, setAgentOpen, setCanvas, setDirty, setEdges, setGroups, setNodes, setSavedVersion, setStacks,
  ])

  const resolveMcpGenerationConfirmation = useCallback(async (proposalId: string, decision: 'approve' | 'reject') => {
    const bridge = window.vibepaperDesktop
    if (!bridge) return
    setMcpGenerationConfirmations((current) => current.map((action) => action.proposalId === proposalId ? { ...action, status: 'submitting' } : action))
    try {
      const result = await bridge.resolveMcpPendingAction({ proposalId, decision })
      setMcpGenerationConfirmations((current) => current.map((action) => action.proposalId === proposalId
        ? { ...action, status: result.status }
        : action).filter((action) => !MCP_TERMINAL_ACTION_STATUSES.has(action.status)))
    } catch (error) {
      setMcpGenerationConfirmations((current) => current.map((action) => action.proposalId === proposalId ? { ...action, status: 'pending' } : action))
      toastError(error instanceof Error ? error.message : uiText('无法提交桌面确认。'))
    }
  }, [])

  const openMcpProviderConfiguration = useCallback(async () => {
    const bridge = window.vibepaperDesktop
    const request = mcpProviderInput
    if (!bridge || !request || !desktopProjectId || mcpProviderInputBusy) return
    setMcpProviderInputBusy(true)
    try {
      const before = await bridge.getActiveProject()
      const beforeCanvas = useCanvasStore.getState().canvas
      if (request.projectId !== desktopProjectId || request.canvasId !== canvasId
        || before?.projectId !== request.projectId || before.canvasId !== request.canvasId
        || !beforeCanvas || sid(beforeCanvas.canvas.id) !== request.canvasId) {
        throw new Error(uiText('当前项目或画布已变化；请让外部 Agent 重新准备配置。'))
      }

      // The user explicitly chose to open settings. Preserve any current prompt
      // or node edits before leaving the original canvas route.
      await flushDesktopEdits()

      const after = await bridge.getActiveProject()
      const latest = useCanvasStore.getState()
      if (after?.projectId !== request.projectId || after.canvasId !== request.canvasId
        || !latest.canvas || sid(latest.canvas.canvas.id) !== request.canvasId || latest.dirty) {
        throw new Error(uiText('画布仍有未保存编辑或项目已切换；内容已保留，请保存后重试。'))
      }
      if (!mcpCanvasPageMountedRef.current || mcpProviderInputRef.current?.proposalId !== request.proposalId) return
      navigate('/settings/providers', {
        state: { returnTo: `/canvas/${canvasId}`, mcpProviderInput: request },
      })
    } catch (error) {
      if (mcpCanvasPageMountedRef.current) toastError(error instanceof Error ? error.message : uiText('无法打开提供方配置页；画布内容已保留。'))
    } finally {
      if (mcpCanvasPageMountedRef.current) setMcpProviderInputBusy(false)
    }
  }, [canvasId, desktopProjectId, flushDesktopEdits, mcpProviderInput, mcpProviderInputBusy, navigate])

  const notifyDesktopAgentCanvasChanged = useCallback(() => {
    window.dispatchEvent(new Event('vp-agent-executed'))
  }, [])
  const desktopAgent = useDesktopAgentController({
    projectId: desktopMode ? desktopProjectId : undefined,
    canvasId,
    flushCanvas: flushDesktopEdits,
    onCanvasChanged: notifyDesktopAgentCanvasChanged,
  })

  const createNodeInCanvas = useCallback(async (type: string, x: number, y: number, params: Record<string, unknown>, copySourceNodeId?: string) => {
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
      ...(copySourceNodeId ? { copySourceNodeId } : {}),
    })
    if (window.vibepaperDesktop && sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) {
      throw new Error(uiText('当前画布已切换，请在原画布核实节点。'))
    }
    if (created.version !== undefined && current) {
      const latest = useCanvasStore.getState().canvas ?? current
      const wasEditedAgain = useCanvasStore.getState().dirty
      const nextCanvas = { ...latest, canvas: { ...latest.canvas, version: created.version } }
      setCanvas(nextCanvas)
      setSavedVersion(created.version)
      if (!wasEditedAgain) setDirty(false)
    }
    markNodeArrival(sid(created.id))
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
      // Desktop hydration is already guarded by the dirty flag. A lingering
      // view-only skip must never consume the first subsequent real edit.
      if (!desktopMode) return
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void saveRef.current()
    }, saveDebounce)
  }, [nodes, edges, groups, stacks, canvas, savedVersion, dirty, desktopMode])

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
      setNodes(applyNodeChanges(changes, useCanvasStore.getState().nodes) as FlowNode[])
      // React Flow emits internal replace/measurement/selection changes while
      // hydrating/rendering the graph. Dirty state is set by explicit edit
      // handlers (and drag-stop below), never by this reconciliation callback;
      // otherwise an Agent confirmation can become stale from view updates.
    },
    [nodes, setNodes, selectNode],
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
      const state = useCanvasStore.getState()
      const detached = detachOutsideGroup(state.groups, state.nodes, node, dragBoundsRef.current)
      dragBoundsRef.current = {}
      setDragGroupBounds({})
      if (detached.changed) {
        setGroups(detached.groups)
        setNodes(detached.nodes)
        setDirty(true)
        return
      }
      if (!useCanvasStore.getState().nodes.some((item) => sid(item.id) === sid(node.id))) return
      // When another graph edit is already pending, its existing full save
      // includes this position. Otherwise persist just this node, so a remote
      // Agent mutation cannot overwrite a drag with an older whole-canvas view.
      if (useCanvasStore.getState().dirty) {
        setDirty(true)
        return
      }
      persistNodePosition(node)
    },
    [persistNodePosition, setDirty, setGroups, setNodes],
  )

  const onSelectionEnd = useCallback((_event: ReactMouseEvent) => {
    if (mode !== 'select') return
    const selectionCanvasId = canvasId
    requestAnimationFrame(() => {
      if (mode !== 'select' || sid(useCanvasStore.getState().canvas?.canvas.id) !== selectionCanvasId) return
      const currentNodes = useCanvasStore.getState().nodes
      const selectedNodes = currentNodes.filter((node) => node.selected)
      const memberIds = canvasGroupMemberIds(selectedNodes, currentNodes)
      if (memberIds.length < 2) return
      void createCanvasGroup(memberIds).catch((error) => toastError((error as Error).message || uiText("编组失败")))
    })
  }, [canvasId, mode])

  const moveGroup = useCallback((groupId: string, deltaX: number, deltaY: number) => {
    const state = useCanvasStore.getState()
    const group = state.groups.find((item) => sid(item.id) === sid(groupId))
    if (!group) return
    setNodes(moveCanvasGroupNodes(state.nodes, group.nodeIds, deltaX, deltaY))
    setDirty(true)
    skipNextSave.current = false
    selectGroup(sid(group.id))
  }, [selectGroup, setDirty, setNodes])

  const arrangeGroup = useCallback(async (group: GroupPayload, orientation: 'horizontal' | 'vertical') => {
    const state = useCanvasStore.getState()
    const current = state.groups.find((item) => sid(item.id) === sid(group.id)) ?? group
    const layout = orientation === 'horizontal' ? 'horizontal' : 'free'
    try {
      let updated: GroupPayload = { ...current, layout }
      if (current.nodeIds.length > 1) {
        if (desktopMode) {
          const bridge = window.vibepaperDesktop
          if (!bridge || !desktopProjectId) throw new Error(uiText("本地项目未就绪，无法排列编组。"))
          const result = await bridge.updateGroup({
            projectId: desktopProjectId,
            canvasId,
            groupId: sid(current.id),
            layout,
          })
          if (sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) return
          const active = await bridge.getActiveProject()
          if (!active || active.projectId !== desktopProjectId || sid(active.canvasId) !== canvasId) return
          updated = { ...result, id: sid(result.id), nodeIds: result.nodeIds.map(sid) }
        } else {
          const result = await api<GroupPayload>(`/canvases/${canvasId}/groups/${sid(current.id)}`, {
            method: 'PUT',
            body: JSON.stringify({ layout }),
          })
          if (sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) return
          updated = { ...result, id: sid(result.id), nodeIds: result.nodeIds.map(sid) }
        }
      }
      const latestState = useCanvasStore.getState()
      if (sid(latestState.canvas?.canvas.id) !== canvasId) return
      setGroups(latestState.groups.map((item) => sid(item.id) === sid(updated.id) ? updated : item))
      setNodes(arrangeCanvasGroupNodes(latestState.nodes, updated.nodeIds, orientation))
      setDirty(true)
      skipNextSave.current = false
      selectGroup(sid(updated.id))
    } catch (error) {
      toastError((error as Error).message || uiText("编组排列失败"))
    }
  }, [canvasId, desktopMode, desktopProjectId, selectGroup, setDirty, setGroups, setNodes])

  const ungroup = useCallback(async (group: GroupPayload) => {
    try {
      if (group.nodeIds.length < 2) {
        skipNextSave.current = false
        removeCanvasGroupFromStore(group, true)
      } else {
        if (desktopMode) {
          const bridge = window.vibepaperDesktop
          if (!bridge || !desktopProjectId) throw new Error(uiText("本地项目未就绪，无法取消编组。"))
          await bridge.deleteGroup({ projectId: desktopProjectId, canvasId, groupId: sid(group.id) })
          if (sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) return
          const active = await bridge.getActiveProject()
          if (!active || active.projectId !== desktopProjectId || sid(active.canvasId) !== canvasId) return
        } else {
          await api(`/canvases/${canvasId}/groups/${sid(group.id)}`, { method: 'DELETE' })
          if (sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) return
        }
        removeCanvasGroupFromStore(group)
      }
      toastSuccess(uiText("已取消编组"))
    } catch (error) {
      toastError((error as Error).message || uiText("取消编组失败"))
    }
  }, [canvasId, desktopMode, desktopProjectId])

  const downloadGroup = useCallback(async (group: GroupPayload) => {
    try {
      if (desktopMode) {
        if (!desktopProjectId) throw new Error(uiText("本地项目未就绪，无法下载编组结果。"))
        const bridge = window.vibepaperDesktop as (NonNullable<typeof window.vibepaperDesktop> & {
          exportGroupOutputs?: (input: { projectId: string; canvasId: string; groupId: string }) => Promise<{
            status: 'saved' | 'cancelled'
            count?: number
          }>
        }) | undefined
        if (!bridge?.exportGroupOutputs) throw new Error(uiText("桌面编组下载接口尚未就绪。"))
        const projectBeforeFlush = await bridge.getActiveProject()
        if (!projectBeforeFlush || projectBeforeFlush.projectId !== desktopProjectId || sid(projectBeforeFlush.canvasId) !== canvasId) {
          throw new Error(uiText("当前项目或画布已更改，无法下载编组结果。"))
        }
        await flushCanvasPersistence(desktopProjectId, canvasId)
        if (sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) throw new Error(uiText("画布已切换，无法下载编组结果。"))
        const currentProject = await bridge.getActiveProject()
        if (!currentProject || currentProject.projectId !== desktopProjectId || sid(currentProject.canvasId) !== canvasId) {
          throw new Error(uiText("当前项目或画布已更改，无法下载编组结果。"))
        }
        const result = await bridge.exportGroupOutputs({ projectId: desktopProjectId, canvasId, groupId: sid(group.id) })
        if (result.status === 'cancelled') return
        toastSuccess(uiText("已保存 {0} 个组内结果", { 0: result.count ?? group.nodeIds.length }))
        return
      }

      const currentNodes = useCanvasStore.getState().nodes
      const candidates = getCanvasGroupDownloadCandidates(group, currentNodes)
      let saved = 0
      for (const candidate of candidates) {
        const status = await downloadNodeOutput(candidate)
        if (status === 'saved') saved += 1
      }
      if (saved === 0) toastError(uiText("组内没有可下载的输出内容"))
      else toastSuccess(uiText("已触发下载 {0} 个组内结果", { 0: saved }))
    } catch (error) {
      toastError((error as Error).message || uiText("编组下载失败"))
    }
  }, [canvasId, desktopMode, desktopProjectId])

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
          if (!desktopProjectId) throw new Error(uiText("没有已打开的本地项目，无法建立连线。"))
          const current = useCanvasStore.getState().canvas
          if (!current) throw new Error(uiText("画布尚未加载完成。"))
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
          setEdges(canonicalCanvasEdges(useCanvasStore.getState().nodes, [
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
          ]))
          const wasEditedAgain = useCanvasStore.getState().dirty
          const latest = useCanvasStore.getState().canvas ?? current
          setCanvas({ ...latest, canvas: { ...latest.canvas, version: result.version } })
          setSavedVersion(result.version)
          if (!wasEditedAgain) setDirty(false)
          toastSuccess(uiText("连线已建立"))
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
        toastSuccess(uiText("连线已建立"))
      } catch (e) {
        toastError(e instanceof ApiError ? e.message : uiText("连线失败"))
      }
    },
    [canvasId, desktopProjectId, edges, flushDesktopEdits, setCanvas, setDirty, setEdges],
  )

  const deleteEdgeById = useCallback(async (edgeId: string) => {
    try {
      // A pending full snapshot must land before the direct edge delete, or a
      // delayed save could put the removed edge back into the authoritative graph.
      if (isDesktopRuntime()) {
        if (saveTimer.current) {
          window.clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
        await persistDesktopChanges()
      }
      await deleteCanvasEdgePort({ projectId: desktopProjectId, canvasId, edgeId })
      const current = useCanvasStore.getState()
      if (sid(current.canvas?.canvas.id) === canvasId) {
        setEdges(current.edges.filter((edge) => sid(edge.id) !== sid(edgeId)))
      }
      toastSuccess(uiText("连线已删除"))
    } catch (error) {
      toastError(error instanceof Error ? error.message : uiText("无法删除连线。"))
      if (isDesktopRuntime()) void refetch()
    }
  }, [canvasId, desktopProjectId, persistDesktopChanges, refetch, setEdges])

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
        if (!desktopProjectId) throw new Error(uiText("没有已打开的本地项目，无法删除节点。"))
        let version = useCanvasStore.getState().canvas?.canvas.version
        if (version === undefined) throw new Error(uiText("画布尚未加载完成。"))
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
        if (!project || !resultCanvas) throw new Error(uiText("本地删除成功，但无法读取更新后的画布。"))
        const next = desktopCanvasDetail(resultCanvas, project)
        setCanvas(next)
        const flow = buildFlow(next, selectNode)
        setNodes(flow.nodes.map((node) => ({ ...node, data: { ...node.data, models: models ?? [] } })))
        setEdges(flow.edges)
        setGroups(next.groups)
        setStacks(next.stacks)
        setSavedVersion(next.canvas.version)
        if (!useCanvasStore.getState().dirty) setDirty(false)
        toastSuccess(uiText("已删除 {0} 个节点", { 0: ids.length }))
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
    toastSuccess(uiText("已删除 {0} 个节点", { 0: ids.length }))
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
            sid(src.id),
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
      toastSuccess(uiText("已创建 {0} 个副本", { 0: selected.length }))
      setNodeMenu(null)
    },
    [createNodeInCanvas, models, nodes, selectNode, setDirty, setNodes],
  )

  const copyNodes = useCallback(
    (ids: string[]) => {
      nodeClipboard = nodes.filter((n) => ids.includes(sid(n.id))).map((n) => ({ ...n.data.node, params: { ...n.data.node.params } }))
      toastSuccess(uiText("已复制 {0} 个节点", { 0: nodeClipboard.length }))
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
          sid(src.id),
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
    toastSuccess(uiText("已粘贴"))
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
          if (!desktopProjectId) throw new Error(uiText("没有已打开的本地项目，无法删除连线。"))
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
            const latestState = useCanvasStore.getState()
            const latest = latestState.canvas ?? current.canvas
            setCanvas({ ...latest, canvas: { ...latest.canvas, version: saved.version } })
            setSavedVersion(saved.version)
            const nodesWithStaleOutputs = applySavedCanvasStaleNodeIds(latestState.nodes, saved.staleNodeIds)
            if (nodesWithStaleOutputs !== latestState.nodes) setNodes(nodesWithStaleOutputs)
            setDirty(false)
          }
          for (const edge of deleted) {
            await bridge.deleteEdge({ projectId: desktopProjectId, canvasId, edgeId: sid(edge.id) })
          }
        })().catch((error: unknown) => {
          toastError(error instanceof Error ? error.message : uiText("无法删除本地连线。"))
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
    [canvasId, desktopProjectId, refetch, setCanvas, setDirty, setNodes],
  )

  const addNode = useCallback(
    async (
      type: string,
      x?: number,
      y?: number,
      connect?: { nodeId: string; direction: 'upstream' | 'downstream' },
      projectNode?: ProjectNodeItem,
    ) => {
      try {
        const model = models?.find((m) => m.modelType === type)
        const nodeX = x ?? 120
        const nodeY = y ?? 120
        const definition = projectNode ? await createNodeDefinitionInstance(projectNode) : undefined
        const params = { model: model?.name ?? '', ...(definition ? { nodeDefinition: definition } : {}) }
        const n = await createNodeInCanvas(type, nodeX, nodeY, params)
        const node: FlowNode = {
          id: sid(n.id),
          type,
          position: { x: nodeX, y: nodeY },
          data: {
            node: n.node ?? {
              id: sid(n.id),
              type: n.type,
              x: nodeX,
              y: nodeY,
              params,
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
            if (!desktopProjectId) throw new Error(uiText("没有已打开的本地项目，无法建立连线。"))
            const current = useCanvasStore.getState().canvas
            if (!current) throw new Error(uiText("画布尚未加载完成。"))
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
          toastSuccess(connect.direction === 'downstream' ? uiText("已创建下游节点并连线") : uiText("已创建上游节点并连线"))
        }
        if (!window.vibepaperDesktop) setDirty(true)
      } catch (e) {
        toastError((e as Error).message)
      }
    },
    [canvasId, createNodeInCanvas, desktopProjectId, models, selectNode, setCanvas, setEdges, setDirty, setNodes],
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
            node: importedAssetNodePayload(n, asset, x, y),
            selected: false,
            onConfig: selectNode,
            models: models ?? [],
          },
        },
      ])
      if (!window.vibepaperDesktop) setDirty(true)
      toastSuccess(uiText("素材已导入画布"))
    },
    [createNodeInCanvas, models, selectNode, setDirty, setNodes],
  )

  const askPluginConfirmation = useCallback((message: string, confirmLabel = uiText('应用')) => new Promise<boolean>((resolve) => {
    const request = { message, confirmLabel, resolve }
    pluginConfirmationRef.current = request
    setPluginConfirmation(request)
  }), [])

  const assertPluginContext = useCallback(async () => {
    const bridge = window.vibepaperDesktop
    if (!bridge?.marketplace || !desktopProjectId) throw new Error(uiText('本地插件服务尚未就绪。'))
    const project = await bridge.getActiveProject()
    if (!project || project.projectId !== desktopProjectId || project.canvasId !== canvasId
      || sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) {
      throw new Error(uiText('当前项目或画布已更改，请重新操作。'))
    }
    if (mcpCanvasBarrierPhaseRef.current !== 'idle') throw new Error(uiText('画布正在同步，请稍后重试。'))
    return bridge
  }, [canvasId, desktopProjectId])

  const enabledPluginComponent = useCallback(async (packageId: string, componentId: string) => {
    const bridge = await assertPluginContext()
    const packages = await bridge.marketplace.list(desktopProjectId!)
    await assertPluginContext()
    const component = packages.find((item) => item.id === packageId)?.components.find((item) => item.id === componentId)
    if (!component?.installed || !component.enabled) throw new Error(uiText('该组件已停用或卸载，请刷新后重试。'))
    return component
  }, [assertPluginContext, desktopProjectId])

  const currentPluginSelection = useCallback(() => {
    const state = useCanvasStore.getState()
    const selected = state.nodes.filter((node) => node.selected).map((node) => sid(node.id))
    return selected.length ? selected : state.selectedNodeId ? [state.selectedNodeId] : []
  }, [])

  const savePluginSelection = useCallback(async (name: string): Promise<boolean> => {
    if (pluginBusyRef.current) return false
    pluginBusyRef.current = true
    setPluginBusy(true)
    try {
      const bridge = await assertPluginContext()
      const snapshot = useCanvasStore.getState()
      const data = templateFromSelection(snapshot.nodes, snapshot.edges, currentPluginSelection())
      await bridge.marketplace.saveTemplate(desktopProjectId!, { name, data })
      toastSuccess(uiText('已保存本地模板，可在插件组件中使用。'))
      return true
    } catch (error) {
      toastError(error instanceof Error ? error.message : uiText('保存模板失败。'))
      return false
    } finally {
      pluginBusyRef.current = false
      setPluginBusy(false)
    }
  }, [assertPluginContext, currentPluginSelection, desktopProjectId])

  const applyPluginComponent = useCallback(async (packageId: string, componentId: string, selectionOverride?: string[]) => {
    if (pluginBusyRef.current) return
    pluginBusyRef.current = true
    setPluginBusy(true)
    const selectedIds = selectionOverride ?? (pluginTarget ? [pluginTarget.nodeId] : currentPluginSelection())
    try {
      const component = await enabledPluginComponent(packageId, componentId)
      const bridge = await assertPluginContext()
      const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      if (component.type === 'node_definition') {
        // Use the same installed-version snapshot and node-creation path as
        // the normal canvas add menu, after checking the current catalog again.
        const packages = await bridge.marketplace.list(desktopProjectId!)
        const item = projectNodeCatalog(packages).find((entry) => entry.packageId === packageId && entry.component.id === componentId)
        if (!item) throw new Error(uiText('该组件已停用或卸载，请刷新后重试。'))
        if (item.component.name !== component.name || JSON.stringify(item.component.data) !== JSON.stringify(component.data)) {
          throw new Error(uiText('组件内容已变更，请重新应用。'))
        }
        await assertPluginContext()
        await addNode(item.component.data.baseType, position.x, position.y, undefined, item)
        return
      }
      if (component.type === 'director_scene' || component.type === 'director_camera' || component.type === 'director_motion') {
        // The director editor owns application and undo of these components.
        // Create an ordinary director node; the panel explains the next step.
        await addNode('director', position.x, position.y)
        return
      }
      if (component.type === 'asset') {
        const asset = await bridge.marketplace.importAsset(desktopProjectId!, packageId, componentId)
        window.dispatchEvent(new Event('vp-assets-updated'))
        try {
          await assertPluginContext()
          await addAssetNode(desktopAssetView(asset), position.x, position.y)
        } catch (error) {
          throw new Error(uiText('素材已导入素材库；画布节点结果未确认：{0}', { 0: error instanceof Error ? error.message : String(error) }))
        }
        return
      }
      if (component.type === 'template') {
        const template = readPluginTemplate(component.data)
        // Portable packages currently contain text fields only. Keep the
        // capability check at the consumption boundary if that schema grows.
        const needsCatalog = template.nodes.some((node) => Object.keys(node.params).some(isPluginModelParameter))
        const configuration = needsCatalog ? await bridge.getProviderConfiguration() : { providers: [], models: [] }
        template.nodes = template.nodes.map((node) => ({ ...node, params: pluginPresetPatch({ nodeType: node.type, params: node.params }, node.type,
          typeof node.params.model === 'string' ? { model: node.params.model } : {}, configuration) }))
        const currentComponent = await enabledPluginComponent(packageId, componentId)
        if (JSON.stringify(currentComponent.data) !== JSON.stringify(component.data)) throw new Error(uiText('组件内容已变更，请重新应用。'))
        // This must be the final await before acquiring the save lock: edits
        // made while checking the component are flushed into the snapshot.
        await flushDesktopEdits()
        if (mcpCanvasBarrierPhaseRef.current !== 'idle') throw new Error(uiText('画布正在同步，请稍后重试。'))
        const snapshot = useCanvasStore.getState()
        if (!snapshot.canvas || sid(snapshot.canvas.canvas.id) !== canvasId) throw new Error(uiText('当前项目或画布已更改，请重新操作。'))
        const additions = buildPluginTemplateGraph(template, position, selectNode)
        const version = snapshot.canvas.canvas.version
        const idempotencyKey = crypto.randomUUID()
        // Make MCP flushes and debounced saves wait for this transaction.
        setDirty(true)
        let mergedInCurrentCanvas = false
        const pending = commitPluginTemplateGraph({ canvasId, snapshot, additions, getCurrent: useCanvasStore.getState,
          save: (nodes, edges) => saveCanvasPort({ projectId: desktopProjectId!, canvasId, expectedVersion: version,
            idempotencyKey, nodes, edges, groups: snapshot.groups, stacks: snapshot.stacks }),
          apply: ({ current, nodes, edges, version: saved, staleNodeIds, dirty: editedAgain }) => {
            if (!current.canvas) return
            setCanvas({ ...current.canvas, canvas: { ...current.canvas.canvas, version: saved } })
            setSavedVersion(saved)
            setNodes(applySavedCanvasStaleNodeIds(nodes, staleNodeIds))
            setEdges(edges)
            setDirty(editedAgain)
            for (const node of additions.nodes) markNodeArrival(sid(node.id))
          },
        }).then((merged) => { mergedInCurrentCanvas = merged })
        desktopSaveInFlight.current = pending
        try {
          await pending
        } catch (error) {
          const latest = useCanvasStore.getState()
          if (latest.canvas && sid(latest.canvas.canvas.id) === canvasId) {
            setDirty(latest.nodes !== snapshot.nodes || latest.edges !== snapshot.edges || latest.groups !== snapshot.groups || latest.stacks !== snapshot.stacks)
          }
          throw new Error(uiText('模板保存结果未确认，请先核实画布后重试：{0}', { 0: error instanceof Error ? error.message : String(error) }))
        } finally {
          if (desktopSaveInFlight.current === pending) desktopSaveInFlight.current = null
        }
        toastSuccess(mergedInCurrentCanvas ? uiText('模板已插入画布，可继续编辑。') : uiText('模板已保存，请在原项目中查看。'))
        return
      }
      if (component.type === 'connector' && component.data.kind === 'local-mcp') {
        const selected = useCanvasStore.getState().nodes.filter((node) => selectedIds.includes(sid(node.id)) && node.type === 'text')
        if (selected.length !== 1) throw new Error(uiText('请先选择一个文字节点。'))
        const latest = pickLatestTask(generationTasksRef.current.filter((task) => sid(task.nodeId) === sid(selected[0].id)))
        if (latest && isGenerationInFlight(latest.status)) throw new Error(uiText('节点正在生成，请完成后再使用工具。'))
        setConnectorDraft({ packageId, componentId, nodeId: sid(selected[0].id) })
        return
      }
      if (component.type === 'poster_layout') {
        const snapshot = useCanvasStore.getState()
        const targets = snapshot.nodes.filter((node) => selectedIds.includes(sid(node.id)) && node.type === 'image')
        if (targets.length !== 1) throw new Error(uiText('请先选择一个本地图片节点。'))
        const source = targets[0].data.node
        const sourceNodeMediaUrl = nodeMediaUrl(source)
        const sourceUrl = sourceNodeMediaUrl
        if (!sourceUrl.startsWith('vibe://')) throw new Error(uiText('海报需要当前项目中的本地图片。'))
        const initial = readPosterLayout(component.data)
        setPosterDraft({ sourceNodeId: sid(source.id), sourceNodeMediaUrl, sourceUrl, initial })
        return
      }
      if (component.type === 'workflow_recipe') {
        await flushDesktopEdits()
        const current = useCanvasStore.getState()
        if (!current.canvas || !desktopProjectId) throw new Error(uiText('本地画布尚未就绪。'))
        const packages = await bridge.marketplace.list(desktopProjectId)
        const installedDigest = packages.find((item) => item.id === packageId)?.installedDigest
        if (!installedDigest) throw new Error(uiText('该组件已停用或卸载，请刷新后重试。'))
        const request = { packageId, componentId, digest: installedDigest, selectionIds: selectedIds, expectedVersion: current.canvas.canvas.version }
        const preview = await bridge.marketplace.runCommand(desktopProjectId, canvasId, 'workflow_preview', request, crypto.randomUUID())
        if (!preview.previewDigest || !preview.steps) throw new Error(uiText('创作组件数据无效。'))
        const checks = preview.steps.filter((step) => step.kind === 'check_missing_prompt')
        const arrange = preview.steps.find((step) => step.kind === 'arrange')
        const storyboard = preview.steps.find((step) => step.kind === 'storyboard_preview')
        const warnings = checks.flatMap((step) => step.kind === 'check_missing_prompt' ? step.result.missing : [])
        const moves = arrange && arrange.kind === 'arrange' ? arrange.result.moves ?? [] : []
        if (arrange && !moves.length) throw new Error(uiText('创作组件数据无效。'))
        const changes = moves.map((move, index) => uiText('节点 {0}：({1}, {2}) → ({3}, {4})', { 0: index + 1,
          1: Math.round(move.from.x), 2: Math.round(move.from.y), 3: Math.round(move.to.x), 4: Math.round(move.to.y) })).join('\n')
        const message = [
          ...(checks.length ? [uiText('已检查 {0} 个选中节点；缺少提示词：{1}。', { 0: selectedIds.length, 1: warnings.length ? warnings.map((item) => item.title).join('、') : uiText('无') })] : []),
          ...(arrange ? [uiText('将排列 {0} 个节点：\n{1}', { 0: moves.length, 1: changes })] : []),
          ...(storyboard && storyboard.kind === 'storyboard_preview' ? [uiText('将打开包含 {0} 行的分镜预览。', { 0: storyboard.result.rows?.length ?? 0 })] : []),
          uiText('此流程不会创建生成任务。'),
        ].join('\n\n')
        if (!await askPluginConfirmation(message, arrange ? uiText('应用排列') : uiText('查看结果'))) return
        if (!selectionOverride && JSON.stringify([...currentPluginSelection()].sort()) !== JSON.stringify([...selectedIds].sort())) throw new Error(uiText('选区已变更，请重新操作。'))
        if (arrange) {
          const result = await bridge.marketplace.runCommand(desktopProjectId, canvasId, 'workflow_apply', { ...request, previewDigest: preview.previewDigest }, crypto.randomUUID())
          if (!result.operationKey) throw new Error(uiText('排列结果未确认，请先检查画布。'))
          setLastArrangement(result.operationKey)
          toastSuccess(uiText('流程已完成，镜头排列可撤销。'))
        }
        if (storyboard && storyboard.kind === 'storyboard_preview' && storyboard.result.fields && storyboard.result.rows) {
          const selected = useCanvasStore.getState().nodes.filter((node) => selectedIds.includes(sid(node.id)))
          setStoryboardDraft({ nodes: selected, fields: storyboard.result.fields, rows: storyboard.result.rows })
        }
        return
      }
      const commandDescriptor = getCreativeCommandDescriptor(component.type)
      if (commandDescriptor?.capabilityId === 'storyboard.preview' || commandDescriptor?.capabilityId === 'selection.arrange') {
        await flushDesktopEdits()
        const current = useCanvasStore.getState()
        if (!current.canvas || !desktopProjectId) throw new Error(uiText('本地画布尚未就绪。'))
        const packages = await bridge.marketplace.list(desktopProjectId)
        const installedDigest = packages.find((item) => item.id === packageId)?.installedDigest
        if (!installedDigest) throw new Error(uiText('该组件已停用或卸载，请刷新后重试。'))
        const request = { packageId, componentId, digest: installedDigest, selectionIds: selectedIds, expectedVersion: current.canvas.canvas.version }
        const preview = await bridge.marketplace.runCommand(desktopProjectId, canvasId, 'command_preview', request, crypto.randomUUID())
        if (!preview.previewDigest || preview.capabilityId !== commandDescriptor.capabilityId) throw new Error(uiText('创作组件数据无效。'))
        if (preview.capabilityId === 'storyboard.preview') {
          if (!preview.fields || !preview.rows) throw new Error(uiText('创作组件数据无效。'))
          const selected = useCanvasStore.getState().nodes.filter((node) => selectedIds.includes(sid(node.id)))
          setStoryboardDraft({ nodes: selected, fields: preview.fields, rows: preview.rows })
          return
        }
        if (!preview.moves || !preview.orientation) throw new Error(uiText('创作组件数据无效。'))
        const changes = preview.moves.map((move, index) => uiText('节点 {0}：({1}, {2}) → ({3}, {4})', { 0: index + 1,
          1: Math.round(move.from.x), 2: Math.round(move.from.y), 3: Math.round(move.to.x), 4: Math.round(move.to.y) })).join('\n')
        if (!await askPluginConfirmation(uiText('将{0}排列所选的 {1} 个节点。\n{2}', { 0: preview.orientation === 'horizontal' ? uiText('横向') : uiText('纵向'), 1: selectedIds.length, 2: changes }))) return
        if (!selectionOverride && JSON.stringify([...currentPluginSelection()].sort()) !== JSON.stringify([...selectedIds].sort())) throw new Error(uiText('选区已变更，请重新操作。'))
        const result = await bridge.marketplace.runCommand(desktopProjectId, canvasId, 'command_apply', { ...request, previewDigest: preview.previewDigest }, crypto.randomUUID())
        if (!result.operationKey) throw new Error(uiText('排列结果未确认，请先检查画布。'))
        setLastArrangement(result.operationKey)
        toastSuccess(uiText('已排列所选节点。'))
        return
      }
      if (component.type === 'media_tool') {
        const data = readMediaTool(component.data)
        const selected = useCanvasStore.getState().nodes.filter((node) => selectedIds.includes(sid(node.id)) && node.type === 'image')
        if (selected.length !== 1) throw new Error(uiText('请先选择一个本地图片节点。'))
        selectNode(sid(selected[0].id))
        window.dispatchEvent(new CustomEvent('vp-plugin-crop', { detail: { nodeId: sid(selected[0].id), mode: data.mode } }))
        return
      }
      if (component.type === 'preset') {
        const data = component.data as { nodeType?: unknown; params?: unknown }
        const snapshot = useCanvasStore.getState()
        const targets = snapshot.nodes.filter((node) => selectedIds.includes(sid(node.id)) && node.type === data?.nodeType)
        if (!targets.length) throw new Error(uiText('请先选择与预设类型匹配的节点。'))
        const params = data.params && typeof data.params === 'object' ? data.params as Record<string, unknown> : {}
        const needsCatalog = Object.keys(params).some(isPluginModelParameter)
        const configuration = needsCatalog ? await bridge.getProviderConfiguration() : { providers: [], models: [] }
        const patches = targets.map((node) => {
          const before = node.data.node.params
          const patch = pluginPresetPatch(component.data, node.data.node.type, before, configuration)
          return { id: sid(node.id), before, patch: changedPluginPresetPatch(before, patch) }
        }).filter((item) => Object.keys(item.patch).length)
        if (!patches.length) { toastSuccess(uiText('节点已与预设一致。')); return }
        const labels: Record<string, string> = { prompt: uiText('提示词'), content: uiText('内容'), title: uiText('标题'), style: uiText('风格'), camera: uiText('运镜'), model: uiText('模型'), aspect: uiText('比例'), ratio: uiText('比例'), size: uiText('尺寸'), resolution: uiText('分辨率'), resKey: uiText('分辨率'), duration: uiText('时长'), count: uiText('数量'), generate_audio: uiText('音频') }
        const conflicts = patches.flatMap((item, index) => overwrittenPluginPresetFields(item.before, item.patch)
          .map((key) => `${index + 1}. ${labels[key] ?? key}: ${String(item.before[key])} → ${String(item.patch[key])}`))
        if (conflicts.length && !await askPluginConfirmation(uiText('将更新 {0} 个节点的预设字段。请确认覆盖影响：\n{1}', { 0: patches.length, 1: conflicts.join('\n').slice(0, 3000) }))) return
        const currentComponent = await enabledPluginComponent(packageId, componentId)
        if (JSON.stringify(currentComponent.data) !== JSON.stringify(component.data)) throw new Error(uiText('组件内容已变更，请重新应用。'))
        const currentConfiguration = needsCatalog ? await bridge.getProviderConfiguration() : configuration
        await assertPluginContext()
        const latest = useCanvasStore.getState()
        if (patches.some((item) => latest.nodes.find((node) => sid(node.id) === item.id)?.data.node.params !== item.before)) {
          throw new Error(uiText('节点内容已变更，请重新检查预设。'))
        }
        for (const item of patches) {
          const node = latest.nodes.find((entry) => sid(entry.id) === item.id)!
          const fresh = pluginPresetPatch(currentComponent.data, node.data.node.type, node.data.node.params, currentConfiguration)
          const changed = changedPluginPresetPatch(item.before, fresh)
          if (JSON.stringify(changed) !== JSON.stringify(item.patch)) throw new Error(uiText('模型能力已变更，请重新检查预设。'))
        }
        setNodes(latest.nodes.map((node) => {
          const item = patches.find((patch) => patch.id === sid(node.id))
          return item ? { ...node, data: { ...node.data, node: { ...node.data.node, params: { ...item.before, ...item.patch } } } } : node
        }))
        setDirty(true)
        await persistDesktopChanges()
        toastSuccess(uiText('预设已应用到 {0} 个节点。', { 0: patches.length }))
        return
      }
      throw new Error(uiText('该组件不能在画布中使用。'))
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      toastError(message.includes('WORKFLOW_DEPENDENCY_UNAVAILABLE')
        ? uiText('请在插件市场安装并启用此流程需要的分镜表和排列组件。')
        : message.includes('CANVAS_VERSION_CONFLICT') || message.includes('PREVIEW_CHANGED')
          ? uiText('画布或选区已变更，请重新预览。')
          : message || uiText('使用插件组件失败。'))
    } finally {
      pluginBusyRef.current = false
      setPluginBusy(false)
    }
  }, [addAssetNode, addNode, askPluginConfirmation, assertPluginContext, canvasId, currentPluginSelection, desktopProjectId, enabledPluginComponent, flushDesktopEdits, persistDesktopChanges, pluginTarget, screenToFlowPosition, selectNode, setCanvas, setDirty, setEdges, setNodes])

  const undoLastArrangement = useCallback(async () => {
    if (!lastArrangement || !desktopProjectId || pluginBusyRef.current) return
    pluginBusyRef.current = true; setPluginBusy(true)
    try {
      const bridge = await assertPluginContext()
      await flushDesktopEdits()
      const version = useCanvasStore.getState().canvas?.canvas.version
      if (version === undefined) throw new Error(uiText('本地画布尚未就绪。'))
      await bridge.marketplace.runCommand(desktopProjectId, canvasId, 'command_undo', { originalOperationKey: lastArrangement, expectedVersion: version }, crypto.randomUUID())
      setLastArrangement(null)
      toastSuccess(uiText('已撤销上次排列。'))
    } catch (error) { toastError(error instanceof Error ? error.message : uiText('撤销排列失败。')) }
    finally { pluginBusyRef.current = false; setPluginBusy(false) }
  }, [assertPluginContext, canvasId, desktopProjectId, flushDesktopEdits, lastArrangement])

  const connectorSourceFor = useCallback((nodeId: string) => {
    const node = useCanvasStore.getState().nodes.find((item) => sid(item.id) === nodeId)?.data.node
    if (!node || node.type !== 'text') return null
    const latest = pickLatestTask(generationTasksRef.current.filter((task) => sid(task.nodeId) === nodeId))
    if (latest && isGenerationInFlight(latest.status)) return null
    return { id: nodeId, text: textNodeContent(latest?.outputs?.[0]?.meta?.text, node.params), taskId: String(latest?.taskId ?? '') }
  }, [])
  const applyConnectorText = useCallback(async (output: string, source: { id: string; text: string }) => {
    if (!connectorDraft || source.id !== connectorDraft.nodeId || !desktopProjectId) throw new Error('CONNECTOR_SELECTION_CHANGED')
    const valid = () => {
      const ids = currentPluginSelection()
      const current = connectorSourceFor(source.id)
      if (ids.length !== 1 || ids[0] !== source.id || !current || current.text !== source.text) throw new Error('CONNECTOR_SELECTION_CHANGED')
      return current
    }
    const before = valid()
    await flushDesktopEdits()
    try {
      await assertPluginContext()
      const component = await enabledPluginComponent(connectorDraft.packageId, connectorDraft.componentId)
      if (component.type !== 'connector' || component.data.kind !== 'local-mcp') throw new Error('invalid')
    } catch { throw new Error('CONNECTOR_CONTEXT_CHANGED') }
    const current = valid()
    if (current.taskId !== before.taskId) throw new Error('CONNECTOR_SELECTION_CHANGED')
    if (mcpCanvasBarrierPhaseRef.current !== 'idle') throw new Error('CONNECTOR_CONTEXT_CHANGED')
    const snapshot = useCanvasStore.getState()
    const original = snapshot.nodes.find((node) => sid(node.id) === source.id)
    if (!snapshot.canvas || sid(snapshot.canvas.canvas.id) !== canvasId || !original) throw new Error('CONNECTOR_CONTEXT_CHANGED')
    const x = original.position.x + 330, y = original.position.y, id = crypto.randomUUID()
    const node: FlowNode = { id, type: 'text', position: { x, y }, data: { node: { id, type: 'text', x, y, params: { content: output }, status: 'idle' }, selected: false, onConfig: selectNode, models: original.data.models ?? [] } }
    const edge: Edge = { id: crypto.randomUUID(), source: source.id, target: id, sourceHandle: 'output', targetHandle: 'input', style: { stroke: '#93c5fd', strokeWidth: 1.5 }, data: { valid: true } }
    setDirty(true)
    let merged = false
    const pending = commitPluginTemplateGraph({ canvasId, snapshot, additions: { nodes: [node], edges: [edge] }, getCurrent: useCanvasStore.getState,
      save: (nodes, edges) => saveCanvasPort({ projectId: desktopProjectId, canvasId, expectedVersion: snapshot.canvas!.canvas.version,
        idempotencyKey: crypto.randomUUID(), nodes, edges, groups: snapshot.groups, stacks: snapshot.stacks }),
      apply: ({ current: latest, nodes, edges, version, staleNodeIds, dirty }) => {
        if (!latest.canvas) return
        const latestSource = connectorSourceFor(source.id)
        const sameSource = Boolean(latestSource && latestSource.text === source.text && latestSource.taskId === before.taskId)
        setCanvas({ ...latest.canvas, canvas: { ...latest.canvas.canvas, version } })
        setSavedVersion(version); setNodes(applySavedCanvasStaleNodeIds(nodes, staleNodeIds)); setEdges(sameSource ? edges : edges.filter((item) => item.id !== edge.id)); setDirty(dirty || !sameSource); markNodeArrival(id)
      },
    }).then((value) => { merged = value })
    desktopSaveInFlight.current = pending
    try {
      await pending
      if (merged) toastSuccess(uiText('工具结果已保存为新的文字节点。'))
      else toastSuccess(uiText('结果已保存，请返回原画布查看。'))
    } catch {
      const latest = useCanvasStore.getState()
      if (latest.canvas && sid(latest.canvas.canvas.id) === canvasId) setDirty(latest.nodes !== snapshot.nodes || latest.edges !== snapshot.edges || latest.groups !== snapshot.groups || latest.stacks !== snapshot.stacks)
      throw new Error('CONNECTOR_APPLY_SAVE_UNCONFIRMED')
    } finally { if (desktopSaveInFlight.current === pending) desktopSaveInFlight.current = null }
  }, [assertPluginContext, canvasId, connectorDraft, connectorSourceFor, currentPluginSelection, desktopProjectId, enabledPluginComponent, flushDesktopEdits, selectNode, setCanvas, setDirty, setEdges, setNodes])

  const editSavedPoster = useCallback((event: Event) => {
    const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId
    const node = useCanvasStore.getState().nodes.find((item) => sid(item.id) === nodeId)?.data.node
    try {
      if (!node || node.type !== 'image' || !nodeMediaUrl(node).startsWith('vibe://')) throw new Error(uiText('海报源图片不可用。'))
      setPosterDraft({ sourceNodeId: sid(node.id), sourceNodeMediaUrl: nodeMediaUrl(node), sourceUrl: nodeMediaUrl(node), initial: readPosterLayout(node.params.posterLayout) })
    } catch (error) { toastError(error instanceof Error ? error.message : uiText('无法编辑海报。')) }
  }, [])
  useEffect(() => {
    window.addEventListener('vp-edit-poster', editSavedPoster)
    return () => window.removeEventListener('vp-edit-poster', editSavedPoster)
  }, [editSavedPoster])

  const exportPoster = useCallback(async (layout: PosterLayout, blob: Blob) => {
    if (!posterDraft || !desktopProjectId) throw new Error(uiText('海报编辑器已关闭。'))
    const checkSource = async () => {
      const bridge = await assertPluginContext()
      const source = useCanvasStore.getState().nodes.find((item) => sid(item.id) === posterDraft.sourceNodeId)
      if (!source || source.type !== 'image' || nodeMediaUrl(source.data.node) !== posterDraft.sourceNodeMediaUrl) {
        throw new Error(uiText('源图片已更改，请重新打开海报编辑器。'))
      }
      return { bridge, source }
    }
    await flushDesktopEdits()
    const { bridge } = await checkSource()
    const saved = await bridge.saveCanvasImage({ projectId: desktopProjectId, canvasId, nodeId: posterDraft.sourceNodeId,
      pngBytes: new Uint8Array(await blob.arrayBuffer()), name: '海报.png' })
    window.dispatchEvent(new Event('vp-assets-updated'))
    try {
      await checkSource()
      await flushDesktopEdits()
      await checkSource()
      if (mcpCanvasBarrierPhaseRef.current !== 'idle') throw new Error(uiText('画布正在同步，请稍后重试。'))
      const snapshot = useCanvasStore.getState()
      const source = snapshot.nodes.find((item) => sid(item.id) === posterDraft.sourceNodeId)
      if (!snapshot.canvas || sid(snapshot.canvas.canvas.id) !== canvasId || !source || nodeMediaUrl(source.data.node) !== posterDraft.sourceNodeMediaUrl) throw new Error(uiText('源图片已更改，请重新打开海报编辑器。'))
      const x = source.position.x + 330, y = source.position.y, id = crypto.randomUUID()
      const params = { assetId: saved.assetId, name: '海报.png', url: saved.url, lastOutputUrl: saved.url, thumbnailUrl: saved.url }
      const output: FlowNode = { id, type: 'image', position: { x, y }, data: {
        node: { id, type: 'image', x, y, params, status: 'idle' }, selected: false, onConfig: selectNode, models: source.data.models ?? [],
      } }
      const updatedSource = withPosterLayout(source, layout)
      const edge: Edge = { id: crypto.randomUUID(), source: posterDraft.sourceNodeId, target: id, sourceHandle: 'output', targetHandle: 'input', style: { stroke: '#93c5fd', strokeWidth: 1.5 }, data: { valid: true } }
      const submittedNodes = [...snapshot.nodes.map((item) => item === source ? updatedSource : item), output]
      const submittedEdges = canonicalCanvasEdges(submittedNodes, [...snapshot.edges, edge])
      setDirty(true)
      let merged = false
      let sourceRetained = false
      const pending = saveCanvasPort({ projectId: desktopProjectId, canvasId, expectedVersion: snapshot.canvas.canvas.version,
        idempotencyKey: crypto.randomUUID(), nodes: submittedNodes, edges: submittedEdges, groups: snapshot.groups, stacks: snapshot.stacks }).then((result) => {
        const current = useCanvasStore.getState()
        if (!current.canvas || sid(current.canvas.canvas.id) !== canvasId) return
        const unchanged = current.nodes === snapshot.nodes && current.edges === snapshot.edges && current.groups === snapshot.groups && current.stacks === snapshot.stacks
        const mergedGraph = mergePosterResult({ nodes: current.nodes, edges: current.edges, source, sourceUrl: posterDraft.sourceNodeMediaUrl,
          output, edge, layout, mediaUrl: nodeMediaUrl })
        const { nodes } = mergedGraph
        sourceRetained = mergedGraph.sourceRetained
        setCanvas({ ...current.canvas, canvas: { ...current.canvas.canvas, version: Math.max(current.canvas.canvas.version, result.version) } })
        setSavedVersion(result.version)
        setNodes(applySavedCanvasStaleNodeIds(nodes, result.staleNodeIds))
        setEdges(mergedGraph.edges)
        setDirty(!unchanged)
        markNodeArrival(id)
        merged = true
      })
      desktopSaveInFlight.current = pending
      try { await pending } catch (error) {
        const latest = useCanvasStore.getState()
        if (latest.canvas && sid(latest.canvas.canvas.id) === canvasId) setDirty(latest.nodes !== snapshot.nodes || latest.edges !== snapshot.edges || latest.groups !== snapshot.groups || latest.stacks !== snapshot.stacks)
        throw error
      } finally { if (desktopSaveInFlight.current === pending) desktopSaveInFlight.current = null }
      setPosterDraft(null)
      toastSuccess(!merged ? uiText('海报已保存，请返回原画布查看。') : sourceRetained ? uiText('海报已添加到画布；从源图片的「编辑海报」可继续修改。') : uiText('源图片已变化，海报结果已保存为独立节点。'))
    } catch (error) {
      throw new Error(uiText('PNG 已保存到素材库，画布节点结果未确认：{0}', { 0: error instanceof Error ? error.message : String(error) }))
    }
  }, [assertPluginContext, canvasId, desktopProjectId, flushDesktopEdits, posterDraft, selectNode, setCanvas, setDirty, setEdges, setNodes])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const point = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      if (e.dataTransfer.files?.length) {
        if (window.vibepaperDesktop) {
          toastError(uiText("桌面版文件拖放导入尚未接入，请使用画布上传入口选择素材。"))
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
    layoutMotion.animate(next)
    setNodes(next)
    setDirty(true)
    toastSuccess(uiText("已一键整理"))
  }, [nodes, setNodes, setDirty, layoutMotion.animate])

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
      if (e.target instanceof Element && e.target.closest('.react-flow__node, .react-flow__edge')) return
      openAddMenu(e.clientX, e.clientY)
    },
    [openAddMenu],
  )

  const uploadAt = useCallback(
    (flowX: number, flowY: number) => {
      pendingUploadPos.current = { x: flowX, y: flowY }
      if (window.vibepaperDesktop) {
        if (!desktopProjectId) {
          toastError(uiText("没有已打开的本地项目，无法导入素材。"))
          return
        }
        void window.vibepaperDesktop.importLocalAsset(desktopProjectId)
          .then((asset) => asset && addAssetNode(desktopAssetView(asset), flowX, flowY))
          .catch((error: unknown) => toastError(error instanceof Error ? error.message : uiText("无法导入本地素材。")))
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
            data: { label: uiText("堆叠拼图 · {0} 张（双击展开）", { 0: s.nodeIds.length }) },
            zIndex: 5,
            draggable: false,
            selectable: false,
            connectable: false,
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [stacks, nodes],
  )

  if (isLoading || (desktopMode && !isError && (!canHydrate || (desktopCanvasMatches && !desktopPageHydrated)))) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-[#f2f2f2]">
        <Spinner className="h-8 w-8" />
        <p className="text-[13px] text-[#888]">{uiText("正在打开画布…")}</p>
      </div>
    )
  }

  if (isError || !detail || !desktopCanvasMatches) {
    const msg = error instanceof Error ? error.message : uiText("画布加载失败")
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[#f2f2f2] px-6 text-center">
        <p className="text-[18px] font-bold text-[#111]">{uiText("无法打开画布")}</p>
        <p className="max-w-md text-[14px] text-[#666]">{msg}</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refetch()}
            className="h-10 rounded-full bg-[#111] px-5 text-[14px] font-semibold text-white"
          >
            {uiText("重试")}</button>
          <Link
            to="/workspace"
            className="inline-flex h-10 items-center rounded-full border border-black/10 bg-white px-5 text-[14px] font-semibold text-[#333]"
          >
            {uiText("返回画布管理")}</Link>
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid={desktopMode ? 'mcp-canvas-page' : undefined}
      className="vp-canvas-motion flex h-screen w-screen overflow-hidden bg-[var(--canvas-background)]"
      onPointerDownCapture={layoutMotion.cancel}
      onWheelCapture={layoutMotion.cancel}
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {desktopMode && mcpProviderInput && (
        <div className="fixed left-1/2 top-4 z-[250] flex w-[min(720px,calc(100vw-2rem))] -translate-x-1/2 flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950 shadow-lg" role="status" aria-live="polite" data-testid="mcp-provider-input-banner">
          <p className="min-w-0 flex-1 leading-5">
            {uiText('外部 Agent 已准备 {0} 提供方配置。请在原配置页检查公开设置并输入 Key；画布内容会先保存。', { 0: mcpProviderInput.providerId })}
          </p>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={() => { mcpProviderInputRef.current = null; setMcpProviderInput(null) }} disabled={mcpProviderInputBusy} className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-xs font-semibold text-blue-900 disabled:opacity-50">
              {uiText('稍后')}</button>
            <button type="button" onClick={() => void openMcpProviderConfiguration()} disabled={mcpProviderInputBusy} className="rounded-lg bg-blue-900 px-3 py-2 text-xs font-semibold text-white disabled:cursor-wait disabled:opacity-60">
              {mcpProviderInputBusy ? uiText('正在保存画布…') : uiText('打开原配置页')}</button>
          </div>
        </div>
      )}
      {pluginConfirmation && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-label={uiText('确认应用预设')}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
            <p className="text-base font-bold">{uiText('确认应用预设')}</p>
            <p className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-sm leading-6 text-[#555]">{pluginConfirmation.message}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg border border-black/15 px-4 py-2 text-sm" onClick={() => { pluginConfirmation.resolve(false); pluginConfirmationRef.current = null; setPluginConfirmation(null) }}>{uiText('取消')}</button>
              <button type="button" className="rounded-lg bg-[#222] px-4 py-2 text-sm font-semibold text-white" onClick={() => { pluginConfirmation.resolve(true); pluginConfirmationRef.current = null; setPluginConfirmation(null) }}>{pluginConfirmation.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
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
            if (files.length) toastError(uiText("桌面版文件选择请使用本地图片导入入口。"))
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
          onFitView={() => void fitView({ duration: canvasMotionDuration(CANVAS_MOTION.viewport) })}
          onAutoLayout={onAutoLayout}
          onAddNode={(t) => void addNode(t)}
          projectNodes={projectNodes}
          basicNodes={basicNodes}
          onAddProjectNode={(item) => void addNode(item.component.data.baseType, undefined, undefined, undefined, item)}
          onOpenPlugins={() => { setPluginTarget(null); setPluginsOpen(true) }}
          desktopMode={desktopMode}
          projectId={desktopProjectId}
        />
      </div>
      {desktopMode && <CanvasPlugins projectId={desktopProjectId} open={pluginsOpen} busy={pluginBusy} presetNodeType={pluginTarget?.nodeType} nodes={nodes} selectedIds={pluginTarget ? [pluginTarget.nodeId] : currentPluginSelection()}
        onClose={() => setPluginsOpen(false)} onUse={applyPluginComponent} onSaveSelection={savePluginSelection} />}
      {connectorDraft && desktopProjectId && <div role="dialog" aria-modal="true" aria-label={uiText('本地文本工具')} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"><div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white p-4"><div className="flex justify-between font-semibold"><span>{uiText('本地文本工具')}</span><button type="button" onClick={() => setConnectorDraft(null)}>{uiText('关闭')}</button></div><LocalMcpConnectorPanel projectId={desktopProjectId} packageId={connectorDraft.packageId} componentId={connectorDraft.componentId} source={currentPluginSelection().length === 1 && currentPluginSelection()[0] === connectorDraft.nodeId ? connectorSourceFor(connectorDraft.nodeId) ?? undefined : undefined} onApplyText={applyConnectorText} /></div></div>}
      {posterDraft && <PosterEditor initial={posterDraft.initial} sourceUrl={posterDraft.sourceUrl} onClose={() => setPosterDraft(null)} onExport={exportPoster} />}
      {storyboardDraft && <StoryboardEditor nodes={storyboardDraft.nodes} initialFields={storyboardDraft.fields} initialRows={storyboardDraft.rows} onClose={() => setStoryboardDraft(null)} />}
      {lastArrangement && <button type="button" disabled={pluginBusy} onClick={() => void undoLastArrangement()} className="absolute right-5 top-20 z-30 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-[#315a96] shadow-lg disabled:opacity-50">{uiText('撤销上次排列')}</button>}
      <AssetLibrary desktopMode={desktopMode} projectId={desktopProjectId} />
      {!agentOpen ? <AgentLauncher onOpen={() => setAgentOpen(true)} /> : null}
      {!desktopMode && <SubscriptionMenu />}
      {!desktopMode && <AccountSidePanels />}

      <div
        ref={mcpCanvasInputSurfaceRef}
        className="relative h-full w-full"
        data-mcp-canvas-input-surface={desktopMode ? '' : undefined}
        data-testid={desktopMode ? 'mcp-canvas-input-surface' : undefined}
        aria-busy={desktopMode && mcpCanvasBarrierPhase === 'active'}
      >
      {nodes.length === 0 && detail && <CanvasWelcome onCreate={(type) => void addNode(type)} availableTypes={desktopMode ? basicNodes.map((item) => item.type) : undefined} projectNodes={projectNodes} onCreateProjectNode={(item) => void addNode(item.component.data.baseType, undefined, undefined, undefined, item)} />}
      <ReactFlow
        nodes={[...stackBadges, ...layoutMotion.nodes] as FlowNode[]}
        edges={edges.map((e) => ({
          ...e,
          className: (() => {
            const edgeData = e.data as { valid?: boolean; edge?: { valid?: boolean } } | undefined
            if (edgeData?.valid === false || edgeData?.edge?.valid === false) return undefined
            const source = canvasNodesById.get(sid(e.source))
            const target = canvasNodesById.get(sid(e.target))
            if (!source || !target || target.currentOutputId == null) return undefined
            const params = target.params ?? {}
            const excludedIds = [
              ...(Array.isArray(params.excludedRefIds) ? params.excludedRefIds : []),
              ...(Array.isArray(params.excludedInputIds) ? params.excludedInputIds : []),
            ].map(sid)
            const sourceId = sid(source.id)
            if (
              excludedIds.includes(sid(e.id))
              || excludedIds.includes(`up-${sid(e.id)}`)
              || excludedIds.includes(sourceId)
            ) return undefined
            const task = generationTasksById.get(sid(target.currentOutputId))
            if (!task || sid(task.nodeId) !== sid(target.id) || !isGenerationInFlight(task.status)) return undefined
            const usableSource = source.type === 'text'
              ? Boolean(textNodeContent(source.output?.text, source.params))
              : Boolean(nodeMediaUrl(source))
            return usableSource ? 'vp-generation-reference-edge' : undefined
          })(),
          style: {
            stroke: e.selected ? 'var(--canvas-selected-edge)' : ((e.style?.stroke as string | undefined) ?? '#93c5fd'),
            strokeWidth: e.selected ? 2.5 : 1.5,
          },
        })).map((edge) => ({ ...edge, data: { ...edge.data, generationReference: edge.className === 'vp-generation-reference-edge' } }))}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        edgeTypes={edgeTypes}
        onNodeDragStart={() => {
          selectNode(null)
          const state = useCanvasStore.getState()
          const bounds: Record<string, CanvasGroupBounds> = {}
          for (const group of state.groups) {
            const rect = getCanvasGroupBounds(group, state.nodes)
            if (rect) bounds[sid(group.id)] = rect
          }
          dragBoundsRef.current = bounds
          setDragGroupBounds(bounds)
        }}
        onSelectionStart={() => selectNode(null)}
        onSelectionEnd={onSelectionEnd}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault()
          event.stopPropagation()
          setNodeMenu(null)
          setEdgeMenu({ x: Math.min(event.clientX, window.innerWidth - 160), y: Math.min(event.clientY, window.innerHeight - 60), id: sid(edge.id) })
        }}
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
          setEdgeMenu(null)
          setAddMenu(null)
          setNodeMenu(null)
          selectNode(null)
          selectGroup(null)
          const current = useCanvasStore.getState()
          setNodes(current.nodes.map((node) => ({ ...node, selected: false, data: { ...node.data, selected: false } })))
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
          if (!nodes.some((node) => sid(node.id) === sid(n.id))) return
          setNodeMenu(null)
          selectNode(sid(n.id))
        }}
        onNodeDoubleClick={(event, n) => {
          event.stopPropagation()
          if (!nodes.some((node) => sid(node.id) === sid(n.id))) return
          const id = sid(n.id)
          if (n.type === 'text') {
            setReadingNodeId(id)
            return
          }
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
              toastSuccess(uiText("堆叠已展开"))
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
                toastSuccess(uiText("堆叠已展开"))
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
        selectionMode={SelectionMode.Full}
        panOnScroll
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default' }}
        connectionRadius={28}
        className="vp-dot-grid"
      >
        <Background gap={20} size={1} color="var(--canvas-grid)" />
        <MiniMap pannable zoomable className="!bg-white" nodeStrokeColor="#111" />
        <Controls showInteractive={false} />
        <CanvasGroupView
          groups={groups}
          frozenBounds={dragGroupBounds}
          nodes={layoutMotion.nodes}
          selectedGroupId={selectedGroupId}
          onSelectGroup={selectGroup}
          onMoveGroup={moveGroup}
          onArrangeGroup={(group, orientation) => void arrangeGroup(group, orientation)}
          onUngroup={(group) => void ungroup(group)}
          onDownloadGroup={(group) => void downloadGroup(group)}
        />
      </ReactFlow>
      </div>

      {readingPresence.value && (
        <div ref={readingDialogRef} className="vp-soft-overlay fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={uiText("文本阅读")}
          data-open={readingPresence.visible} inert={!readingNode} aria-hidden={!readingNode}
          onClick={() => setReadingNodeId(null)} onDoubleClick={(event) => event.stopPropagation()}>
          <button ref={readingCloseButtonRef} type="button" aria-label={uiText("关闭文本阅读")} className="absolute right-5 top-5 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-2xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white" onClick={() => setReadingNodeId(null)}>×</button>
          <div role="document" aria-label={uiText("文本内容")} tabIndex={0} className="h-[80vh] w-[min(1000px,90vw)] overflow-auto rounded-2xl bg-white p-8 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <AgentMarkdown text={textNodeContent(readingPresence.value.output?.text, readingPresence.value.params)} className="select-text break-words" variant="document" />
          </div>
        </div>
      )}
      {animatedEdgeMenu && (
        <div role="menu" className="vp-soft-popover fixed z-[150] rounded-xl border border-black/10 bg-white p-1 shadow-xl"
          data-open={edgeMenuPresence.visible} inert={!edgeMenu} aria-hidden={!edgeMenu}
          style={{ left: animatedEdgeMenu.x, top: animatedEdgeMenu.y }}>
          <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-black/5" onClick={() => {
            const id = animatedEdgeMenu.id
            setEdgeMenu(null)
            void deleteEdgeById(id)
          }}><Trash2 size={18} />{uiText("删除连线")}</button>
        </div>
      )}
      {animatedAddMenu && (
        <div
          role="menu" data-open={addMenuPresence.visible} inert={!addMenu} aria-hidden={!addMenu}
          className="vp-soft-popover fixed z-40 max-h-[70vh] w-40 overflow-y-auto rounded-xl border border-black/10 bg-white p-1.5 shadow-xl"
          style={{
            left: Math.min(animatedAddMenu.x, window.innerWidth - 180),
            top: Math.min(animatedAddMenu.y, window.innerHeight - 320),
          }}
        >
          <p className="px-2.5 py-1 text-[11px] font-bold text-[#999]">
            {animatedAddMenu.direction === 'upstream' ? uiText("新建上游") : animatedAddMenu.direction === 'downstream' ? uiText("新建下游") : uiText("新建节点")}
          </p>
          <button
            type="button"
            onClick={() => uploadAt(animatedAddMenu.flowX, animatedAddMenu.flowY)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-[#444] hover:bg-black/[0.04]"
          >
            <Upload size={14} /> {uiText("上传")}</button>
          <div className="my-1 border-t border-black/6" />
          <p className="px-2.5 py-1 text-[11px] font-bold text-[#999]">{uiText('基础')}</p>
          {basicNodes.filter((item) => compatibleNodeType(animatedAddMenu.sourceNodeId ? nodes.find((node) => sid(node.id) === animatedAddMenu.sourceNodeId)?.data.node.type : undefined, item.type, animatedAddMenu.direction)).map(({ type: t }) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                void addNode(
                  t,
                  animatedAddMenu.flowX,
                  animatedAddMenu.flowY,
                  animatedAddMenu.sourceNodeId
                    ? { nodeId: animatedAddMenu.sourceNodeId, direction: animatedAddMenu.direction ?? 'downstream' }
                    : undefined,
                )
                setAddMenu(null)
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-semibold text-[#444] hover:bg-black/[0.04]"
            >
              {t === 'text'
                ? uiText("文本")
                : t === 'image'
                  ? uiText("图片")
                  : t === 'video'
                    ? uiText("视频")
                    : t === 'audio'
                      ? uiText("音频")
                      : t === 'compose'
                        ? uiText("合成")
                        : uiText("导演台")}
            </button>
          ))}
          {projectNodes.filter((item) => compatibleNodeType(animatedAddMenu.sourceNodeId ? nodes.find((node) => sid(node.id) === animatedAddMenu.sourceNodeId)?.data.node.type : undefined, item.component.data.baseType, animatedAddMenu.direction)).length > 0 && <p className="px-2.5 py-1 text-[11px] font-bold text-[#999]">{uiText('本项目')}</p>}
          {projectNodes.filter((item) => compatibleNodeType(animatedAddMenu.sourceNodeId ? nodes.find((node) => sid(node.id) === animatedAddMenu.sourceNodeId)?.data.node.type : undefined, item.component.data.baseType, animatedAddMenu.direction)).map((item) => <button key={`${item.packageId}/${item.component.id}`} type="button" className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold text-[#444] hover:bg-black/[0.04]" onClick={() => {
            void addNode(item.component.data.baseType, animatedAddMenu.flowX, animatedAddMenu.flowY,
              animatedAddMenu.sourceNodeId ? { nodeId: animatedAddMenu.sourceNodeId, direction: animatedAddMenu.direction ?? 'downstream' } : undefined, item)
            setAddMenu(null)
          }}>{uiText(item.component.name)}</button>)}
        </div>
      )}

      {animatedNodeMenu && (
        <div
          role="menu" data-open={nodeMenuPresence.visible} inert={!nodeMenu} aria-hidden={!nodeMenu}
          className="vp-soft-popover fixed z-40 w-44 overflow-hidden rounded-xl border border-black/10 bg-white py-1 shadow-xl"
          style={{
            left: Math.min(animatedNodeMenu.x, window.innerWidth - 190),
            top: Math.min(animatedNodeMenu.y, window.innerHeight - 160),
          }}
        >
          {describeCreativeCommands(marketplacePackages, nodes, animatedNodeMenu.nodeIds).filter((item) => item.installed && item.enabled).map((item) => <button key={`${item.packageId}/${item.componentId}`} type="button" disabled={!item.available || pluginBusy} title={!item.available ? item.reason === 'SELECTION_TOO_SMALL' ? uiText('请至少选择两个节点。') : uiText('请先选择要操作的节点。') : undefined} onClick={() => { setNodeMenu(null); void applyPluginComponent(item.packageId, item.componentId, animatedNodeMenu.nodeIds) }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[#333] hover:bg-black/[0.05] disabled:opacity-50">{uiText(item.name)}</button>)}
          <button
            type="button"
            onClick={() => copyNodes(animatedNodeMenu.nodeIds)}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-semibold text-[#333] hover:bg-black/[0.05]"
          >
            <Copy size={15} className="text-[#666]" />
            <span className="flex-1 text-left">{uiText("复制")}</span>
            <span className="text-[11px] font-medium text-[#aaa]">⌘C</span>
          </button>
          <button
            type="button"
            onClick={() => void duplicateNodes(animatedNodeMenu.nodeIds)}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-semibold text-[#333] hover:bg-black/[0.05]"
          >
            <Files size={15} className="text-[#666]" />
            <span className="flex-1 text-left">{uiText("副本")}</span>
            <span className="text-[11px] font-medium text-[#aaa]">⌘D</span>
          </button>
          <button
            type="button"
            onClick={() => requestDeleteNodes(animatedNodeMenu.nodeIds)}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-semibold text-[#333] hover:bg-black/[0.05]"
          >
            <Trash2 size={15} className="text-[#666]" />
            <span className="flex-1 text-left">{uiText("删除")}</span>
            <span className="text-[11px] font-medium text-[#aaa]">⌫</span>
          </button>
        </div>
      )}

      {animatedDeleteConfirm && (
        <div className="vp-soft-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          role="dialog" aria-modal="true" aria-label={uiText("确认删除节点")} data-open={deletePresence.visible} inert={!deleteConfirm} aria-hidden={!deleteConfirm}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <p className="text-[16px] font-bold text-[#111]">{uiText("确认删除节点？")}</p>
            <p className="mt-2 text-[13px] text-[#666]">
              {uiText("将删除 ")}{animatedDeleteConfirm.nodeIds.length} {uiText("个节点及其关联连线。")}</p>
            {animatedDeleteConfirm.downstream.length > 0 && (
              <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                <p className="font-bold">{uiText("影响下游节点：")}</p>
                <ul className="mt-1 list-disc pl-4">
                  {animatedDeleteConfirm.downstream.slice(0, 8).map((d) => (
                    <li key={d.id}>
                      {d.type} · {d.id.slice(-6)}
                    </li>
                  ))}
                </ul>
                {animatedDeleteConfirm.downstream.length > 8 && (
                  <p className="mt-1">{uiText("…等共 ")}{animatedDeleteConfirm.downstream.length} {uiText("个")}</p>
                )}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="h-9 rounded-full px-4 text-[13px] font-semibold text-[#555] hover:bg-black/[0.04]"
              >
                {uiText("取消")}</button>
              <button
                type="button"
                onClick={() => void confirmDeleteNodes()}
                className="h-9 rounded-full bg-[#111] px-4 text-[13px] font-bold text-white"
              >
                {uiText("确认删除")}</button>
            </div>
          </div>
        </div>
      )}
      </div>
      {desktopMode && mcpCanvasBarrierPhase !== 'idle' && (
        <div
          className={`fixed inset-0 z-[300] flex items-start justify-center pt-4 ${mcpCanvasBarrierPhase === 'active' ? 'pointer-events-auto' : 'pointer-events-none'}`}
          role="status"
          aria-live="polite"
          aria-label={uiText('正在同步外部画布更改')}
          data-testid="mcp-canvas-write-barrier"
          data-phase={mcpCanvasBarrierPhase}
        >
          <span className="rounded-full border border-black/10 bg-white/95 px-4 py-2 text-[12px] font-semibold text-[#444] shadow-lg">
            {uiText(mcpCanvasBarrierPhase === 'pending' ? '正在保存本地编辑…' : '正在同步外部画布更改…')}
          </span>
        </div>
      )}
      {!desktopMode
        ? <AgentPanel />
        : desktopProjectId && <AgentPanel
          desktopAdapter={desktopAgent}
          externalMcpConfirmations={mcpGenerationConfirmations.map((action) => ({
            proposalId: action.proposalId,
            clientName: action.displayName ?? action.clientName ?? uiText('未知 MCP 客户端'),
            generationItems: action.payload?.length
              ? action.payload.map((item) => ({
                target: item.target,
                model: item.model,
                input: item.input,
                overwrite: /覆盖|替换|overwrite/iu.test(item.impact),
                impact: item.impact,
              }))
              : [{
                target: action.target ?? uiText('未指定目标节点'),
                model: action.model ?? uiText('未指定模型'),
                input: action.input ?? '',
                overwrite: /覆盖|替换|overwrite/iu.test(action.impact ?? ''),
                impact: action.impact ?? '',
              }],
            status: action.status,
            expiresAt: action.expiresAt,
          }))}
          onResolveMcpConfirmation={resolveMcpGenerationConfirmation}
        />}
    </div>
  )
}
