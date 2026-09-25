import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X, Clapperboard, RotateCcw, Square, Play } from 'lucide-react'
import type { NodeProps } from '@xyflow/react'
import { api, uploadAsset } from '@/lib/api'
import { fetchAuthedBlob, resolveMediaUrl, useAuthedMediaUrl } from '@/lib/media'
import { sid } from '@/lib/ids'
import type { GenerationTask, Id, ModelInfo, NodePayload, PageResult } from '@/lib/types'
import type { DesktopTask } from '@/desktop/desktop-bridge'
import { useCanvasStore, nodeMediaUrl, type FlowNode } from '../canvasStore'
import { NODE_COLORS, statusBadge } from './NodeShell'
import { NodeEditorDialog, NodeFloatingToolbar } from './NodeEditorPanel'
import { SplitNodeLayout } from './SplitNodeLayout'
import { textNodeContent } from './textContent'
import { persistNodeExec, submitComposeNodeTask, submitNodeTask, syncExecFields } from './taskActions'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { DirectorNodeView } from '../director'
import { desktopAssetView, isDesktopRuntime } from '../canvasPort'

function useNodeData(nodeId: string) {
  return useCanvasStore((s) => s.nodes.find((n) => sid(n.id) === sid(nodeId))?.data.node)
}

function useNodeTasks(nodeId: string) {
  const qc = useQueryClient()
  const canvasId = useCanvasStore((s) => s.canvas?.canvas.id)
  const canvasKey = canvasId == null ? '' : sid(canvasId)
  const isDesktop = isDesktopRuntime()
  const { data: activeProject } = useQuery({
    queryKey: ['desktop-active-project'],
    queryFn: () => window.vibepaperDesktop?.getActiveProject() ?? Promise.resolve(null),
    enabled: isDesktop,
    staleTime: 1_000,
  })
  const projectId = activeProject?.projectId
  const queryKey = ['canvas-tasks', isDesktop ? projectId ?? 'desktop-no-project' : canvasKey] as const
  const { data = [] } = useQuery<GenerationTask[]>({
    // All cards on a canvas share one task feed. Previously every visible node
    // opened its own two-second poll, which multiplied traffic as a workflow
    // grew and could trip the gateway's global limiter.
    queryKey,
    queryFn: async () => {
      if (isDesktop) {
        const bridge = window.vibepaperDesktop
        if (!bridge || !projectId) return []
        const localTasks = await bridge.listTasks(projectId, 100)
        return Promise.all(localTasks.map((task) => loadDesktopTask(bridge, projectId, canvasKey, task)))
      }
      return api<PageResult<GenerationTask>>(
        `/tasks?canvas_id=${encodeURIComponent(canvasKey)}&canvasId=${encodeURIComponent(canvasKey)}&page=1&pageSize=100`,
      ).then((r) => r.items ?? [])
    },
    enabled: Boolean(nodeId && canvasKey && (!isDesktop || projectId)),
    refetchInterval: (query) => {
      const items = query.state.data
      if (items?.some((t) => ['queued', 'running'].includes(t.status))) return 2000
      const hasActiveNode = useCanvasStore.getState().nodes.some((n) => {
        const state = String(n.data.node.execStatus || n.data.node.status || '')
        return ['queued', 'running'].includes(state)
      })
      if (hasActiveNode) return 2000
      return false
    },
  })

  useEffect(() => {
    const items = data.filter((t) => sid(t.nodeId) === sid(nodeId))
    const latest = pickLatestTask(items)
    if (!latest) return
    const node = useCanvasStore.getState().nodes.find((n) => sid(n.id) === sid(nodeId))
    if (!node) return
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(latest.status)) {
      const out = latest.outputs?.[0]
      const url = resolveMediaUrl(out?.url, out?.meta as Record<string, unknown>)
      const text = out?.meta?.text != null ? String(out.meta.text) : undefined
      const patch: Record<string, unknown> = {}
      const exec = String(node.data.node.execStatus || '')
      if (
        node.data.node.status !== latest.status ||
        exec !== latest.status ||
        ['queued', 'running', 'ready'].includes(exec)
      ) {
        Object.assign(patch, syncExecFields(latest.status))
      }
      if (latest.status === 'succeeded' && (url || text)) {
        patch.params = {
          ...node.data.node.params,
          ...(url ? { url, lastOutputUrl: url } : {}),
          ...(text ? { lastOutputText: text } : {}),
        }
      }
      if (Object.keys(patch).length) {
        useCanvasStore.getState().updateNodePayload(nodeId, patch as never)
        // generation-service already writes terminal task state to canvas-service
        // with an optimistic version retry. Do not duplicate that write once per
        // rendered card; the local full save remains a fallback for UI-only data.
      }
    }
  }, [data, nodeId])

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ nodeId?: string }>).detail
      if (!detail?.nodeId || sid(detail.nodeId) !== sid(nodeId)) return
      void qc.invalidateQueries({ queryKey })
    }
    window.addEventListener('vp-task-updated', handler)
    return () => window.removeEventListener('vp-task-updated', handler)
  }, [canvasKey, nodeId, qc, queryKey])

  const currentId = useCanvasStore(
    (s) => s.nodes.find((n) => sid(n.id) === sid(nodeId))?.data.node.currentOutputId,
  )
  const latest = useMemo(() => {
    const items = data.filter((t) => sid(t.nodeId) === sid(nodeId))
    return pickLatestTask(items, currentId)
  }, [currentId, data, nodeId])

  return { tasks: data, latest }
}

async function loadDesktopTask(
  bridge: NonNullable<Window['vibepaperDesktop']>,
  projectId: string,
  canvasId: string,
  task: DesktopTask,
): Promise<GenerationTask> {
  const snapshot = await bridge.getTaskInput(projectId, task.taskId).catch(() => null)
  const parameters = snapshot?.parameters ?? {}
  const status = task.status === 'interrupted' ? 'failed' : task.status
  let outputs: GenerationTask['outputs'] = []
  if (status === 'succeeded') {
    if (task.modality === 'text') {
      const text = await bridge.readTaskOutput(projectId, task.taskId).catch(() => '')
      outputs = [{ id: task.taskId, outputType: 'text', meta: { text } }]
    } else if (task.modality === 'audio') {
      outputs = [{
        id: task.taskId,
        outputType: 'audio',
        contentType: 'audio/wav',
        url: `vibe://app/tasks/${task.taskId}/output`,
        meta: { ...task.outputMeta, outputType: 'audio' },
      }]
    } else if (task.modality === 'image' || task.modality === 'video' || task.modality === 'compose') {
      outputs = [{
        id: task.taskId,
        outputType: task.modality === 'compose' ? 'video' : task.modality,
        url: `vibe://app/tasks/${task.taskId}/output`,
      }]
    }
  }
  return {
    taskId: task.taskId,
    userId: 'local',
    nodeId: task.nodeId ?? undefined,
    canvasId,
    modelType: task.modelId ?? task.modality,
    modelParams: parameters,
    estimatedCost: 0,
    actualCost: 0,
    status,
    errorCode: task.errorCode ?? undefined,
    errorMessage: task.errorCode ? `本地任务失败：${task.errorCode}` : undefined,
    retryable: ['failed', 'interrupted'].includes(task.status),
    source: 'desktop',
    outputs,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

async function saveOutputToLibrary(taskId: string | number, url?: string, remoteUrl?: string) {
  try {
    if (isDesktopRuntime()) {
      const bridge = window.vibepaperDesktop
      if (!bridge?.saveTaskOutputToLibrary) throw new Error('桌面本地素材服务尚未就绪。')
      const project = await bridge.getActiveProject()
      if (!project) throw new Error('没有打开的本地项目，无法存入素材库。')
      const asset = await bridge.saveTaskOutputToLibrary(project.projectId, sid(taskId))
      if (!asset?.assetId) throw new Error('本地音频素材未保存成功。')
      window.dispatchEvent(new Event('vp-assets-updated'))
      toastSuccess('已存入素材库')
      return
    }

    let blob: Blob
    if (remoteUrl?.startsWith('http')) {
      blob = await (await fetch(remoteUrl)).blob()
    } else {
      blob = await fetchAuthedBlob(url)
    }
    const type = blob.type.startsWith('image')
      ? 'image'
      : blob.type.startsWith('video')
        ? 'video'
        : blob.type.startsWith('audio')
          ? 'audio'
          : 'text'
    const file = new File(
      [blob],
      `task-${sid(taskId)}-output.${type === 'image' ? 'jpg' : type === 'audio' ? 'wav' : 'mp4'}`,
      { type: blob.type || 'application/octet-stream' },
    )
    await uploadAsset(file, type)
    toastSuccess('已存入素材库')
    window.dispatchEvent(new Event('vp-assets-updated'))
  } catch (e) {
    toastError((e as Error).message)
  }
}

function MediaContent({
  url,
  meta,
  large = false,
  outputType,
  naturalSize = false,
}: {
  url?: string
  meta?: Record<string, unknown>
  large?: boolean
  outputType?: string
  /** Preserve the media's dimensions and let the node match its aspect ratio. */
  naturalSize?: boolean
}) {
  const resolvedMeta = { ...meta, outputType: meta?.outputType ?? outputType }
  const raw = resolveMediaUrl(url, resolvedMeta)
  const src = useAuthedMediaUrl(raw)
  const [videoError, setVideoError] = useState(false)
  useEffect(() => {
    setVideoError(false)
  }, [src])
  if (!src) return null
  const box = naturalSize ? 'h-auto w-full' : large ? 'h-full max-h-[108px] min-h-[72px] w-full' : 'max-h-[72px] w-full'
  const isImage =
    outputType === 'image' ||
    /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(raw ?? '') ||
    Boolean(raw?.includes('/assets/file') && outputType !== 'video' && outputType !== 'audio')
  if (isImage || (!outputType && raw)) {
    return <img src={src} alt="" className={`${box} ${naturalSize ? '' : 'rounded-xl'} bg-[#f4f4f9] object-contain`} />
  }
  if (outputType === 'video' || /\.(mp4|webm|mov)(\?|$)/i.test(raw ?? '')) {
    if (videoError) {
      return (
        <div className={`${box} flex items-center justify-center ${naturalSize ? '' : 'rounded-xl'} bg-[#1a1a2e] px-3 text-center text-[11px] font-semibold text-[#f87171]`}>
          视频无法播放，请重新生成
        </div>
      )
    }
    const videoSrc = src.startsWith('blob:') || src.includes('#') ? src : `${src}#t=0.001`
    return (
      <video
        src={videoSrc}
        controls
        playsInline
        preload="metadata"
        className={`${box} ${naturalSize ? '' : 'rounded-xl'} bg-black/5 object-contain`}
        onError={() => setVideoError(true)}
      />
    )
  }
  if (outputType === 'audio' || /\.(wav|mp3|ogg)(\?|$)/i.test(raw ?? '')) {
    return <audio src={src} controls className="w-full" />
  }
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-[13px] leading-relaxed text-[#333]">
      {String(meta?.text ?? '')}
    </div>
  )
}

function OutputGrid({
  outputs,
}: {
  outputs: Array<{ url?: string; outputType?: string; meta?: Record<string, unknown> }>
}) {
  if (outputs.length <= 1) {
    const o = outputs[0]
    return (
      <MediaContent
        url={o?.url}
        meta={o?.meta}
        outputType={o?.outputType}
        naturalSize
      />
    )
  }
  const cols = outputs.length <= 4 ? 2 : 3
  return (
    <div className={`grid w-full gap-1 ${cols === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
      {outputs.map((o, i) => (
        <div key={i} className="overflow-hidden rounded-lg bg-[#f4f4f9]">
          <MediaContent url={o.url} meta={o.meta} outputType={o.outputType} naturalSize />
        </div>
      ))}
    </div>
  )
}

function ImageIconPlaceholder({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex flex-col items-center text-[#b0b0b8] ${compact ? 'gap-1 py-2' : 'gap-2'}`}>
      <div className={`flex items-center justify-center rounded-2xl bg-white shadow-sm ${compact ? 'h-8 w-8' : 'h-12 w-12'}`}>
        <svg width={compact ? 16 : 22} height={compact ? 16 : 22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <circle cx="9" cy="9" r="1.5" />
          <path d="M3 16l5-4 4 3 4-5 5 6" />
        </svg>
      </div>
      {!compact && <span className="text-[11px] font-semibold">生成结果将展示在此处</span>}
    </div>
  )
}

/** 多结果历史 + 重试/取消（P0 F-34 / AC-13） */
function TaskHistoryBar({
  nodeId,
  tasks,
  latest,
}: {
  nodeId: Id
  tasks: GenerationTask[]
  latest: GenerationTask | null
}) {
  const succeeded = tasks.filter((t) => t.status === 'succeeded' && (t.outputs?.length ?? 0) > 0)
  const busy = latest && ['queued', 'running'].includes(latest.status)
  const failed = latest?.status === 'failed'

  const setCurrent = (taskId: Id) => {
    useCanvasStore.getState().updateNodePayload(nodeId, {
      currentOutputId: taskId,
      ...syncExecFields('succeeded'),
      params: {
        ...(useCanvasStore.getState().nodes.find((n) => sid(n.id) === sid(nodeId))?.data.node.params ?? {}),
      },
    })
    window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { nodeId: sid(nodeId), taskId: sid(taskId) } }))
  }

  const cancel = async () => {
    if (!latest) return
    try {
      if (isDesktopRuntime()) {
        const bridge = window.vibepaperDesktop
        if (!bridge) throw new Error('本地任务接口不可用。')
        const project = await bridge.getActiveProject()
        if (!project) throw new Error('没有打开的本地项目，无法取消任务。')
        await bridge.cancelTask(project.projectId, sid(latest.taskId))
      } else {
        await api(`/tasks/${latest.taskId}/cancel`, { method: 'POST' })
      }
      useCanvasStore.getState().updateNodePayload(nodeId, syncExecFields('cancelled'))
      void persistNodeExec(nodeId, syncExecFields('cancelled'))
      toastSuccess('任务已取消')
      window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { nodeId: sid(nodeId), taskId: sid(latest.taskId) } }))
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const retry = async () => {
    if (!latest) return
    if (isDesktopRuntime()) {
      try {
        const bridge = window.vibepaperDesktop
        if (!bridge) throw new Error('本地任务接口不可用。')
        const project = await bridge.getActiveProject()
        if (!project) throw new Error('没有打开的本地项目，无法重试任务。')
        const snapshot = await bridge.getTaskInput(project.projectId, sid(latest.taskId))
        if (!snapshot) throw new Error('本地任务输入已不可用，无法重试。')
        if (snapshot.task.modality === 'compose') {
          const inputNodeIds = Array.isArray(snapshot.parameters.inputNodeIds)
            ? snapshot.parameters.inputNodeIds.filter((id): id is string => typeof id === 'string')
            : []
          await submitComposeNodeTask(nodeId, inputNodeIds)
        } else {
          await submitNodeTask(
            nodeId,
            snapshot.task.modelId ?? latest.modelType,
            snapshot.parameters,
            0,
            { providerType: snapshot.task.providerType },
          )
        }
        toastSuccess('已重新提交')
        window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { nodeId: sid(nodeId) } }))
      } catch (e) {
        toastError((e as Error).message)
      }
      return
    }
    try {
      await api(`/tasks/${latest.taskId}/retry`, { method: 'POST' })
      useCanvasStore.getState().updateNodePayload(nodeId, {
        ...syncExecFields('queued'),
        currentOutputId: latest.taskId,
      })
      void persistNodeExec(nodeId, { ...syncExecFields('queued'), currentOutputId: latest.taskId })
      toastSuccess('已重新提交')
      window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { nodeId: sid(nodeId), taskId: sid(latest.taskId) } }))
    } catch {
      try {
        await submitNodeTask(
          nodeId,
          latest.modelType,
          (latest.modelParams as Record<string, unknown>) ?? {},
          latest.estimatedCost || 8,
        )
        toastSuccess('已重新提交')
      } catch (e) {
        toastError((e as Error).message)
      }
    }
  }

  if (!succeeded.length && !busy && !failed) return null

  return (
    <div className="mt-2 space-y-1.5">
      {failed && (
        <div className="rounded-lg bg-red-50 px-2 py-1.5 text-[11px] font-semibold text-red-700">
          {latest?.errorMessage || latest?.errorCode || '生成失败'}
          {latest?.retryable !== false && (
            <button type="button" onClick={() => void retry()} className="ml-2 inline-flex items-center gap-0.5 underline">
              <RotateCcw size={11} /> 重试
            </button>
          )}
        </div>
      )}
      {busy && (
        <button
          type="button"
          onClick={() => void cancel()}
          className="inline-flex h-7 items-center gap-1 rounded-lg bg-black/5 px-2 text-[11px] font-bold text-[#555] hover:bg-black/10"
        >
          <Square size={10} /> 取消任务
        </button>
      )}
      {succeeded.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {succeeded.slice(0, 9).map((t) => {
            const thumb = resolveMediaUrl(t.outputs?.[0]?.url, t.outputs?.[0]?.meta as Record<string, unknown>)
            const active = latest && sid(t.taskId) === sid(latest.taskId)
            return (
              <button
                key={sid(t.taskId)}
                type="button"
                title="设为当前输出"
                onClick={() => setCurrent(t.taskId)}
                className={`h-10 w-10 overflow-hidden rounded-md border-2 ${active ? 'border-[#111]' : 'border-transparent opacity-70 hover:opacity-100'}`}
              >
                {thumb && (t.outputs?.[0]?.outputType === 'image' || /\.(jpg|png|webp)/i.test(thumb)) ? (
                  <HistoryThumb url={thumb} />
                ) : (
                  <span className="flex h-full items-center justify-center bg-slate-100 text-[9px] font-bold text-[#888]">
                    {String(t.outputs?.[0]?.outputType ?? 'out')[0]}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function HistoryThumb({ url }: { url: string }) {
  const src = useAuthedMediaUrl(url)
  if (!src) return <div className="h-full w-full bg-slate-200" />
  return <img src={src} alt="" className="h-full w-full object-cover" />
}

async function uploadNodeOutput(nodeId: Id, node: NodePayload, file: File) {
  try {
    if (isDesktopRuntime()) {
      throw new Error('桌面版请使用本地图片导入；视频和音频素材导入尚未接入。')
    }
    const canvasId = useCanvasStore.getState().canvas?.canvas.id
    const assetType = node.type === 'audio' ? 'audio' : node.type === 'video' ? 'video' : 'image'
    const asset = (await uploadAsset(file, assetType, canvasId, nodeId)) as { url?: string }
    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === sid(nodeId))?.data.node
    useCanvasStore.getState().updateNodePayload(nodeId, {
      params: {
        ...(current?.params ?? node.params),
        url: asset.url,
        lastOutputUrl: asset.url,
        ...(assetType === 'image' ? { thumbnailUrl: asset.url } : {}),
      },
    })
    toastSuccess('素材已上传')
  } catch (e) {
    toastError((e as Error).message)
  }
}

async function importDesktopImageToNode(nodeId: Id, fallbackNode: NodePayload) {
  try {
    const bridge = window.vibepaperDesktop
    const project = await bridge?.getActiveProject()
    if (!bridge || !project) throw new Error('请先打开本地项目，再导入图片。')

    const asset = await bridge.importImage(project.projectId)
    if (!asset) return

    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === sid(nodeId))?.data.node
    if (!current) {
      window.dispatchEvent(new Event('vp-assets-updated'))
      throw new Error('节点已不存在，图片已导入本地素材库。')
    }

    const view = desktopAssetView(asset)
    useCanvasStore.getState().updateNodePayload(nodeId, {
      params: {
        ...(current.params ?? fallbackNode.params),
        assetId: view.id,
        name: view.name,
        url: view.url,
        lastOutputUrl: view.url,
        thumbnailUrl: view.url,
      },
    })
    window.dispatchEvent(new Event('vp-assets-updated'))
    toastSuccess('图片已导入本地素材库并应用到节点')
  } catch (e) {
    toastError((e as Error).message)
  }
}

function pickLatestTask(items: GenerationTask[], currentId?: Id): GenerationTask | null {
  if (currentId) {
    const pinned = items.find((t) => sid(t.taskId) === sid(currentId))
    if (pinned) return pinned
  }
  const inflight = items.find((t) => t.status === 'running' || t.status === 'queued')
  const succeeded = items.find((t) => t.status === 'succeeded' && (t.outputs?.length ?? 0) > 0)
    ?? items.find((t) => t.status === 'succeeded')
  if (inflight && succeeded) {
    const inflightAt = Date.parse(inflight.createdAt || '') || 0
    const doneAt = Date.parse(succeeded.createdAt || '') || 0
    // 更早的僵尸 running 不应盖住已经成功的产物
    return inflightAt > doneAt ? inflight : succeeded
  }
  return inflight ?? succeeded ?? items[0] ?? null
}

function nodeHasPreview(node: NodePayload, latest: GenerationTask | null): boolean {
  if ((latest?.outputs?.length ?? 0) > 0) return true
  const p = node.params || {}
  return Boolean(p.url || p.lastOutputUrl || p.thumbnailUrl || p.lastOutputText)
}

function nodeBusy(node: NodePayload, latest: GenerationTask | null) {
  const inFlight =
    node.status === 'queued' ||
    node.status === 'running' ||
    latest?.status === 'queued' ||
    latest?.status === 'running'
  if (!inFlight) return false
  // 已有画面时不要整图盖「生成中」
  return !nodeHasPreview(node, latest)
}

function SplitNodeEditor({
  node,
  models,
  latest,
  selected,
}: {
  node: NodePayload
  models: ModelInfo[]
  latest: GenerationTask | null
  selected: boolean
}) {
  return (
    <NodeEditorDialog
      node={node}
      models={models}
      latest={latest}
      autoFocusPrompt={selected && node.type === 'text'}
      layout="split"
    />
  )
}

const TextNodeView = memo(function TextNodeView(props: NodeProps<FlowNode>) {
  const nodeId = sid(props.id)
  const node = useNodeData(nodeId)
  const { tasks, latest } = useNodeTasks(nodeId)
  const [outputDraft, setOutputDraft] = useState('')

  const outputText = textNodeContent(latest?.outputs?.[0]?.meta?.text, node?.params)

  useEffect(() => {
    setOutputDraft(textNodeContent(latest?.outputs?.[0]?.meta?.text, node?.params))
  }, [latest?.outputs, node?.params, nodeId])

  if (!node) return null

  const displayOutput = props.selected ? outputDraft || outputText : outputText
  const busy = nodeBusy(node, latest)
  const meta = NODE_COLORS.text

  const persistOutput = (value: string) => {
    setOutputDraft(value)
    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
    useCanvasStore.getState().updateNodePayload(nodeId, {
      params: { ...(current?.params ?? node.params), lastOutputText: value },
    })
  }

  return (
    <SplitNodeLayout
      node={node}
      selected={props.selected}
      busy={busy}
      accentColor={meta.color}
      label="Text"
      icon={meta.icon}
      topMinHeight="min-h-[72px]"
      topMinHeightCollapsed="min-h-0"
      topContent={
        props.selected ? (
          <textarea
            className="nodrag nowheel h-full max-h-[108px] w-full resize-none whitespace-pre-wrap bg-transparent px-0 py-0 text-[12px] leading-relaxed text-[#222] outline-none placeholder:text-[#b0b0b8]"
            value={displayOutput}
            placeholder="生成结果…"
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => persistOutput(e.target.value)}
          />
        ) : displayOutput ? (
          <div className="w-full line-clamp-4 px-0 py-0 text-[12px] leading-relaxed text-[#222]">{displayOutput}</div>
        ) : (
          <div className="px-0 py-0 text-[12px] text-[#b0b0b8]">点击编辑文本</div>
        )
      }
      bottom={<SplitNodeEditor node={node} models={props.data.models ?? []} latest={latest} selected={props.selected} />}
      extra={props.selected ? <TaskHistoryBar nodeId={node.id} tasks={tasks} latest={latest} /> : null}
    />
  )
})

const ImageNodeView = memo(function ImageNodeView(props: NodeProps<FlowNode>) {
  const nodeId = sid(props.id)
  const node = useNodeData(nodeId)
  const { tasks, latest } = useNodeTasks(nodeId)
  const assetFallback = nodeMediaUrl(node) || undefined
  const outputs = latest?.outputs ?? []
  const mediaUrl =
    resolveMediaUrl(outputs[0]?.url, outputs[0]?.meta as Record<string, unknown>) ?? assetFallback
  const remote = typeof outputs[0]?.meta?.remoteUrl === 'string' ? String(outputs[0].meta.remoteUrl) : undefined
  const authedMediaUrl = useAuthedMediaUrl(mediaUrl)
  if (!node) return null
  const busy = nodeBusy(node, latest)
  const meta = NODE_COLORS.image

  return (
    <div className="relative">
      {props.selected && (
        <NodeFloatingToolbar
          node={node}
          models={props.data.models ?? []}
          mediaUrl={authedMediaUrl ?? mediaUrl}
          onSaveToLibrary={
            latest?.status === 'succeeded'
              ? () => void saveOutputToLibrary(latest.taskId, outputs[0]?.url, remote)
              : undefined
          }
        />
      )}
      <SplitNodeLayout
        node={node}
        selected={props.selected}
        busy={busy}
        accentColor={meta.color}
        label="Image"
        icon={meta.icon}
        topUpload={{
          accept: 'image/*',
          onUpload: (f) => uploadNodeOutput(node.id, node, f),
          onDesktopImport: () => importDesktopImageToNode(node.id, node),
        }}
        mediaFrame={outputs.length > 0 || mediaUrl ? 'natural' : undefined}
        topMinHeight="min-h-[72px]"
        topMinHeightCollapsed="min-h-[72px]"
        topContent={
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[#f4f4f9]">
            {outputs.length > 0 ? (
              <OutputGrid outputs={outputs} />
            ) : mediaUrl ? (
              <MediaContent url={mediaUrl} outputType="image" naturalSize />
            ) : (
              <ImageIconPlaceholder compact={!props.selected} />
            )}
          </div>
        }
        bottom={<SplitNodeEditor node={node} models={props.data.models ?? []} latest={latest} selected={props.selected} />}
        extra={props.selected ? <TaskHistoryBar nodeId={node.id} tasks={tasks} latest={latest} /> : null}
      />
    </div>
  )
})

const VideoNodeView = memo(function VideoNodeView(props: NodeProps<FlowNode>) {
  const nodeId = sid(props.id)
  const node = useNodeData(nodeId)
  const { tasks, latest } = useNodeTasks(nodeId)
  const assetFallback = nodeMediaUrl(node) || undefined
  const out = latest?.outputs?.[0]
  const mediaUrl = resolveMediaUrl(out?.url, out?.meta as Record<string, unknown>) ?? assetFallback
  const remote = typeof out?.meta?.remoteUrl === 'string' ? String(out.meta.remoteUrl) : undefined
  const authedMediaUrl = useAuthedMediaUrl(mediaUrl)
  if (!node) return null
  const busy = nodeBusy(node, latest)
  const meta = NODE_COLORS.video

  return (
    <div className="relative">
      {props.selected && (
        <NodeFloatingToolbar
          node={node}
          models={props.data.models ?? []}
          mediaUrl={authedMediaUrl ?? mediaUrl}
          onSaveToLibrary={
            latest?.status === 'succeeded'
              ? () => void saveOutputToLibrary(latest.taskId, out?.url, remote)
              : undefined
          }
        />
      )}
      <SplitNodeLayout
        node={node}
        selected={props.selected}
        busy={busy}
        accentColor={meta.color}
        label="Video"
        icon={meta.icon}
        topUpload={{
          accept: 'video/*',
          onUpload: (f) => uploadNodeOutput(node.id, node, f),
          unavailableReason: isDesktopRuntime() ? '桌面本地暂不支持导入视频素材' : undefined,
        }}
        mediaFrame={mediaUrl ? 'natural' : undefined}
        topMinHeight="min-h-[72px]"
        topMinHeightCollapsed="min-h-[72px]"
        topContent={
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-[#111]/90">
            {mediaUrl ? (
              <MediaContent
                url={out?.url ?? assetFallback}
                meta={out?.meta as Record<string, unknown>}
                outputType="video"
                naturalSize
              />
            ) : (
              <ImageIconPlaceholder compact={!props.selected} />
            )}
          </div>
        }
        bottom={<SplitNodeEditor node={node} models={props.data.models ?? []} latest={latest} selected={props.selected} />}
        extra={props.selected ? <TaskHistoryBar nodeId={node.id} tasks={tasks} latest={latest} /> : null}
      />
    </div>
  )
})

const AudioNodeView = memo(function AudioNodeView(props: NodeProps<FlowNode>) {
  const nodeId = sid(props.id)
  const node = useNodeData(nodeId)
  const { tasks, latest } = useNodeTasks(nodeId)
  const out = latest?.outputs?.[0]
  const assetFallback = nodeMediaUrl(node) || (node?.params.referenceUrl as string) || undefined
  const mediaUrl = resolveMediaUrl(out?.url, out?.meta as Record<string, unknown>) ?? assetFallback
  if (!node) return null
  const busy = nodeBusy(node, latest)
  const meta = NODE_COLORS.audio

  return (
    <SplitNodeLayout
      node={node}
      selected={props.selected}
      busy={busy}
      accentColor={meta.color}
      label="Audio"
      icon={meta.icon}
      topMinHeight="min-h-[72px]"
      topMinHeightCollapsed="min-h-[48px]"
      topUpload={{
        accept: 'audio/*',
        onUpload: (f) => uploadNodeOutput(node.id, node, f),
        unavailableReason: isDesktopRuntime() ? '桌面本地暂不支持导入音频素材' : undefined,
      }}
      topContent={
        mediaUrl || out ? (
          <MediaContent url={out?.url ?? assetFallback} meta={out?.meta as Record<string, unknown>} outputType="audio" />
        ) : (
          <div className="text-[12px] text-[#b0b0b8]">点击编辑音频</div>
        )
      }
      bottom={<SplitNodeEditor node={node} models={props.data.models ?? []} latest={latest} selected={props.selected} />}
      extra={
        props.selected ? (
          <>
            {latest?.status === 'succeeded' && out?.url ? (
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => void saveOutputToLibrary(latest.taskId, out.url)}
                  className="rounded-lg bg-black/5 px-2.5 py-1.5 text-[11px] font-bold text-[#333] hover:bg-black/10"
                >
                  存入素材库
                </button>
              </div>
            ) : null}
            <TaskHistoryBar nodeId={node.id} tasks={tasks} latest={latest} />
          </>
        ) : null
      }
    />
  )
})

const ComposeNodeView = memo(function ComposeNodeView(props: NodeProps<FlowNode>) {
  const nodeId = sid(props.id)
  const node = useNodeData(nodeId)
  const edges = useCanvasStore((s) => s.edges)
  const allNodes = useCanvasStore((s) => s.nodes)
  const { tasks, latest } = useNodeTasks(nodeId)
  const [busySubmit, setBusySubmit] = useState(false)
  const [estimate, setEstimate] = useState<number | null>(null)
  const [err, setErr] = useState('')

  const excluded = useMemo(() => {
    const raw = (node?.params.excludedInputIds as string[] | undefined) ?? []
    return new Set(raw.map(String))
  }, [node?.params.excludedInputIds])

  const videoInputs = useMemo(() => {
    if (!node) return [] as Array<{ id: string; payload: NodePayload; url?: string; status: string }>
    const desktopMode = isDesktopRuntime()
    const incoming = edges
      .filter((e) => sid(e.target) === sid(node.id) && (!desktopMode || e.data?.valid !== false))
      .map((e) => allNodes.find((n) => sid(n.id) === sid(e.source)))
      .filter((n): n is FlowNode => !!n && n.data.node.type === 'video')

    const savedOrder = ((node.params.inputOrder as string[]) ?? []).map(String)
    const byId = new Map(incoming.map((n) => [sid(n.id), n]))
    const orderedIds = [
      ...savedOrder.filter((id) => byId.has(id)),
      ...incoming.map((n) => sid(n.id)).filter((id) => !savedOrder.includes(id)),
    ]

    return orderedIds
      .filter((id) => !excluded.has(id))
      .map((id) => {
        const payload = byId.get(id)!.data.node
        const p = payload.params ?? {}
        const localVideoTask = desktopMode
          ? pickLatestTask(tasks.filter((task) => sid(task.nodeId) === id), payload.currentOutputId)
          : null
        const url = desktopMode
          ? localVideoTask?.status === 'succeeded' && localVideoTask.outputs?.[0]?.outputType === 'video'
            ? resolveMediaUrl(localVideoTask.outputs[0].url, localVideoTask.outputs[0].meta as Record<string, unknown>) || undefined
            : undefined
          : resolveMediaUrl((p.lastOutputUrl as string) || (p.url as string) || undefined, undefined) || undefined
        return { id, payload, url, status: desktopMode ? localVideoTask?.status ?? payload.status : payload.status }
      })
  }, [allNodes, edges, excluded, node, tasks])

  useEffect(() => {
    if (!node) return
    const ids = videoInputs.map((c) => c.id)
    const prev = ((node.params.inputOrder as string[]) ?? []).map(String)
    if (ids.length === prev.length && ids.every((id, i) => id === prev[i])) return
    useCanvasStore.getState().updateNodePayload(nodeId, {
      params: { ...node.params, inputOrder: ids },
    })
  }, [node, nodeId, videoInputs])

  useEffect(() => {
    if (isDesktopRuntime()) {
      setEstimate(null)
      return
    }
    let cancelled = false
    void api<{ estimatedCost: number }>('/models/estimate', {
      method: 'POST',
      body: JSON.stringify({
        modelType: 'compose',
        modelParams: { operation: 'compose', count: 1 },
        count: 1,
      }),
    })
      .then((res) => {
        if (!cancelled && typeof res.estimatedCost === 'number') setEstimate(res.estimatedCost)
      })
      .catch(() => {
        if (!cancelled) setEstimate(15)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!node) return null

  const out = latest?.outputs?.[0]
  const mediaUrl =
    resolveMediaUrl(out?.url, out?.meta as Record<string, unknown>) ||
    (node.params.url as string | undefined) ||
    (node.params.lastOutputUrl as string | undefined)
  const busy = nodeBusy(node, latest) || busySubmit
  const meta = NODE_COLORS.compose
  const readyClips = videoInputs.filter((c) => Boolean(c.url))
  const desktopMode = isDesktopRuntime()
  const desktopComposeReady = !desktopMode || typeof window.vibepaperDesktop?.composeVideos === 'function'
  const canCompose = readyClips.length >= 2 && !busy && desktopComposeReady
  const cost = estimate ?? 15

  const removeClip = (clipId: string) => {
    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
    const prev = ((current?.params.excludedInputIds as string[]) ?? []).map(String)
    if (prev.includes(clipId)) return
    useCanvasStore.getState().updateNodePayload(nodeId, {
      params: {
        ...(current?.params ?? node.params),
        excludedInputIds: [...prev, clipId],
        inputOrder: ((current?.params.inputOrder as string[]) ?? []).filter((id) => sid(id) !== clipId),
      },
    })
  }

  const doCompose = async () => {
    if (!canCompose) {
      setErr(readyClips.length < 2 ? '至少需要 2 个就绪的视频输入' : '任务进行中')
      return
    }
    setBusySubmit(true)
    setErr('')
    try {
      if (desktopMode) {
        await submitComposeNodeTask(node.id, readyClips.map((c) => c.id))
      } else {
        await submitNodeTask(
          node.id,
          'compose-1.0',
          {
            operation: 'compose',
            inputNodeIds: readyClips.map((c) => c.id),
            inputUrls: readyClips.map((c) => c.url).filter(Boolean),
            count: 1,
          },
          cost,
        )
      }
      toastSuccess('合成任务已提交')
    } catch (e) {
      const message = (e as Error).message
      setErr(message)
      toastError(message)
    } finally {
      setBusySubmit(false)
    }
  }

  return (
    <div className="relative">
      {props.selected && mediaUrl && (
        <NodeFloatingToolbar node={node} models={props.data.models ?? []} mediaUrl={mediaUrl} />
      )}
      <SplitNodeLayout
        node={node}
        selected={props.selected}
        busy={busy}
        accentColor={meta.color}
        label="Compose"
        icon={Clapperboard}
        topMinHeight="min-h-[88px]"
        topMinHeightCollapsed="min-h-[72px]"
        mediaFrame={mediaUrl ? 'natural' : undefined}
        topContent={
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-[#111]/90">
            {mediaUrl ? (
              <MediaContent
                url={out?.url ?? (node.params.url as string | undefined)}
                meta={out?.meta as Record<string, unknown>}
                outputType="video"
                naturalSize
              />
            ) : (
              <div className="flex flex-col items-center gap-1 text-[#b0b0b8]">
                <Clapperboard size={22} />
                <span className="text-[11px] font-semibold">连接视频后合成</span>
              </div>
            )}
            {videoInputs.length > 0 && (
              <span className="absolute right-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {videoInputs.length}
              </span>
            )}
          </div>
        }
        bottom={
          <div className="nodrag nowheel flex flex-col">
            <div className="flex items-center justify-between border-b border-black/6 px-3.5 py-2.5">
              <span className="text-[13px] font-bold text-[#222]">时间线</span>
              <div className="flex items-center gap-2 text-[11px] font-semibold text-[#888]">
                <Play size={12} />
                <span>
                  {readyClips.length}/{Math.max(videoInputs.length, 2)}
                </span>
              </div>
            </div>

            <div className="max-h-[280px] space-y-2 overflow-y-auto px-3 py-2.5">
              {videoInputs.length === 0 && (
                <p className="py-4 text-center text-[12px] text-[#999]">将至少 2 个视频节点连到本节点</p>
              )}
              {videoInputs.map((clip, i) => (
                <ComposeClipRow key={clip.id} index={i} url={clip.url} status={clip.status} onRemove={() => removeClip(clip.id)} />
              ))}
            </div>

            {err && (
              <div className="mx-3 mb-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] font-semibold text-red-700">{err}</div>
            )}

            <div className="flex items-center gap-2 border-t border-black/6 px-3.5 py-2.5">
              <span className={`flex-1 text-[12px] font-semibold ${canCompose ? 'text-emerald-600' : 'text-[#999]'}`}>
                {desktopMode && !desktopComposeReady
                  ? '桌面本地合成服务尚未接入'
                  : canCompose
                    ? '可以合成'
                    : readyClips.length < 2
                      ? `还差 ${2 - readyClips.length} 个就绪视频`
                      : '请稍候…'}
              </span>
              {!desktopMode && <span className="text-[11px] font-bold text-[#888]">~{cost}</span>}
              <button
                type="button"
                disabled={!canCompose}
                onClick={() => void doCompose()}
                className="h-9 min-w-[72px] rounded-xl bg-[#111] px-4 text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:bg-[#ccc]"
              >
                {busy ? '合成中' : '合成'}
              </button>
            </div>
          </div>
        }
        extra={props.selected ? <TaskHistoryBar nodeId={node.id} tasks={tasks} latest={latest} /> : null}
      />
    </div>
  )
})

function ComposeClipRow({
  index,
  url,
  status,
  onRemove,
}: {
  index: number
  url?: string
  status: string
  onRemove: () => void
}) {
  const src = useAuthedMediaUrl(url)
  const [duration, setDuration] = useState<number | null>(null)
  const ready = Boolean(url)
  const badge = statusBadge(status)

  useEffect(() => {
    if (!src) {
      setDuration(null)
      return
    }
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.src = src
    const onMeta = () => {
      if (Number.isFinite(video.duration)) setDuration(video.duration)
    }
    video.addEventListener('loadedmetadata', onMeta)
    return () => {
      video.removeEventListener('loadedmetadata', onMeta)
      video.src = ''
    }
  }, [src])

  return (
    <div className="rounded-xl bg-[#f7f7f9] px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-white text-[11px] font-bold text-[#555] ring-1 ring-black/6">
          {index + 1}
        </span>
        <span className="text-[12px] font-bold text-[#333]">Video</span>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
            ready ? 'bg-emerald-100 text-emerald-700' : badge.cls
          }`}
        >
          {ready ? '就绪' : badge.text}
        </span>
        <span className="ml-auto text-[11px] font-semibold text-[#888]">
          {duration != null ? `${duration.toFixed(1)}s` : '—'}
        </span>
        <button
          type="button"
          className="nodrag rounded-md p-0.5 text-[#aaa] hover:bg-black/5 hover:text-[#666]"
          title="从时间线移除"
          onClick={onRemove}
        >
          <X size={13} />
        </button>
      </div>
      <ComposeFilmstrip url={url} />
    </div>
  )
}

function ComposeFilmstrip({ url }: { url?: string }) {
  const src = useAuthedMediaUrl(url)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setReady(false)
    if (!src) return
    let cancelled = false
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = src

    const drawFrames = async () => {
      const canvas = canvasRef.current
      if (!canvas || cancelled) return
      const count = 6
      const fw = 72
      const fh = 40
      canvas.width = fw * count
      canvas.height = fh
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1
      try {
        for (let i = 0; i < count; i++) {
          const t = Math.min(duration * ((i + 0.15) / count), Math.max(0, duration - 0.05))
          await new Promise<void>((resolve) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked)
              resolve()
            }
            video.addEventListener('seeked', onSeeked)
            try {
              video.currentTime = t
            } catch {
              resolve()
            }
          })
          if (cancelled) return
          ctx.drawImage(video, i * fw, 0, fw, fh)
        }
        if (!cancelled) setReady(true)
      } catch {
        /* canvas may be tainted; fall through to video fallback */
      }
    }

    const onLoaded = () => {
      void drawFrames()
    }
    video.addEventListener('loadeddata', onLoaded)
    video.load()
    return () => {
      cancelled = true
      video.removeEventListener('loadeddata', onLoaded)
      video.src = ''
    }
  }, [src])

  if (!src) return <div className="h-10 w-full rounded-lg bg-[#e8e8ec]" />
  return (
    <div className="relative h-10 w-full overflow-hidden rounded-lg bg-[#111]">
      <canvas ref={canvasRef} className={`h-full w-full object-cover ${ready ? 'opacity-100' : 'opacity-0'}`} />
      {!ready && <video src={src} muted playsInline className="absolute inset-0 h-full w-full object-cover opacity-80" />}
    </div>
  )
}

export const nodeTypes = {
  text: TextNodeView,
  image: ImageNodeView,
  video: VideoNodeView,
  audio: AudioNodeView,
  compose: ComposeNodeView,
  director: DirectorNodeView,
}
