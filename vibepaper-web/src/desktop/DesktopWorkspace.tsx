import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowUpFromLine, AudioLines, Clapperboard, Files, Grid2X2, Image as ImageIcon, Layers, List, Mic, Trash2, Type, Upload, Video, X } from 'lucide-react'
import { CanvasWelcome } from '@/features/canvas/CanvasWelcome'
import { AgentLauncher, AgentPanel, type AgentPanelDesktopAdapter } from '@/features/canvas/AgentPanel'
import { reduceAgentEvent, type AgentEventState } from '@/features/canvas/agentEventEnvelope'
import { isChatVisibleMessage } from '@/features/canvas/agentEventHandlers'
import { SplitNodeLayout } from '@/features/canvas/nodes/SplitNodeLayout'
import type { AgentConfirmation, AgentChatMsg } from '@/features/canvas/agentTypes'
import type { NodePayload } from '@/lib/types'
import { DesktopCanvasChrome } from './DesktopCanvasChrome'
import type { DesktopAgnesModelCatalog, DesktopAgentMessage, DesktopAgentSession, DesktopAsset, DesktopCanvas, DesktopCreateNodeInput, DesktopDeleteNodeResult, DesktopEdgePayload, DesktopLocalTextModel, DesktopProject, DesktopTask, DesktopUpdateNodeResult } from './desktop-bridge'

const bridge = window.vibepaperDesktop

function toAgentChatMessages(messages: DesktopAgentMessage[]): AgentChatMsg[] {
  return messages.map((message, index) => ({
    id: message.id ?? `${message.createdAt}-${index}`,
    role: message.role,
    type: message.type ?? 'text',
    content: message.content,
    meta: message.meta ?? {},
  })).filter(isChatVisibleMessage)
}

function createAgentEventState(messages: AgentChatMsg[]): AgentEventState {
  return {
    messages,
    seenEventIds: new Set(),
    runStatus: 'running',
    messageIdByRun: new Map(),
    persistedAssistantRunIds: new Set(messages.flatMap((message) =>
      message.role === 'assistant' && message.content.trim() && message.meta?.runId ? [message.meta.runId] : [],
    )),
  }
}

export function DesktopWorkspace() {
  const { canvasId: requestedCanvasId } = useParams<{ canvasId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<DesktopProject | null>(null)
  const [canvas, setCanvas] = useState<DesktopCanvas | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const activateProject = useCallback(async (nextProject: DesktopProject | null) => {
    if (!nextProject) return
    setLoading(true)
    setError('')
    setProject(nextProject)
    setCanvas(null)
    try {
      const loadedCanvas = await bridge?.loadCanvas(nextProject.projectId, nextProject.canvasId)
      if (!loadedCanvas) throw new Error('桌面项目接口不可用。')
      setCanvas(loadedCanvas)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取项目画布。')
      setProject(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setProject(null)
    setCanvas(null)
    setError('')
    if (!bridge) {
      setError('桌面项目接口不可用。')
      setLoading(false)
      return () => { cancelled = true }
    }
    void bridge.getActiveProject().then(async (activeProject) => {
      if (cancelled) return
      if (!activeProject) {
        setError('没有已打开的本地项目，请返回画布展示选择项目。')
        setLoading(false)
        return
      }
      if (activeProject.canvasId !== requestedCanvasId) {
        setError('当前打开的本地项目与此画布不匹配，请返回画布展示重新选择。')
        setLoading(false)
        return
      }
      await activateProject(activeProject)
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '无法恢复上次打开的项目。')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [activateProject, requestedCanvasId])

  const openProject = async () => {
    setError('')
    try {
      const selectedProject = await bridge?.openProject()
      if (selectedProject) navigate(`/canvas/${encodeURIComponent(selectedProject.canvasId)}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开项目。')
    }
  }

  if (loading) return <LoadingScreen />
  if (!project || !canvas) {
    return <CanvasRouteError error={error} onOpen={openProject} onBack={() => navigate('/workspace')} />
  }
  return (
    <ReactFlowProvider>
      <LocalCanvas
        key={project.projectId}
        project={project}
        initialCanvas={canvas}
        error={error}
        onOpenProject={openProject}
        onProjectRestored={activateProject}
      />
    </ReactFlowProvider>
  )
}

function generationFailureLabel(errorCode?: string | null) {
  if (!errorCode) return '生成未完成，请检查模型配置或网络。'
  if (errorCode.includes('CREDENTIAL')) return 'API Key 不可用，请检查模型配置。'
  if (errorCode.includes('TIMEOUT')) return '模型响应超时，请重试。'
  if (errorCode.includes('UNAVAILABLE')) return '模型服务暂不可用，请检查连接。'
  if (errorCode.includes('UNSUPPORTED')) return '当前模型不支持这种生成类型。'
  return '生成失败，请检查模型配置或网络。'
}

function CanvasRouteError({ error, onOpen, onBack }: { error: string; onOpen: () => Promise<void>; onBack: () => void }) {
  const [busy, setBusy] = useState(false)
  const open = async () => {
    setBusy(true)
    try { await onOpen() } finally { setBusy(false) }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f7f8] px-6 text-[#171717]">
      <section className="w-full max-w-lg rounded-3xl border border-black/8 bg-white p-8 shadow-[0_18px_60px_rgba(0,0,0,0.08)]">
        <h1 className="text-xl font-black">无法打开画布</h1>
        <p role="alert" className="mt-3 text-sm leading-6 text-[#666]">{error || '请从画布展示模块选择一个本地项目。'}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onBack} className="h-10 rounded-xl border border-black/12 px-4 text-sm font-semibold">返回画布展示</button>
          <button type="button" disabled={busy} onClick={() => void open()} className="h-10 rounded-xl bg-[#171717] px-4 text-sm font-bold text-white disabled:opacity-50">{busy ? '请稍候…' : '打开已有项目'}</button>
        </div>
      </section>
    </main>
  )
}

function generationStateMessage(status?: DesktopTask['status'], errorCode?: string | null) {
  if (status === 'failed') return generationFailureLabel(errorCode)
  if (status === 'cancelled') return '任务已取消。'
  if (status === 'interrupted') return '应用关闭时任务仍在执行；未自动重复提交。'
  return ''
}

function comparable(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function mergeLocalObjectChanges<T extends Record<string, unknown>>(base: T, local: T, remote: T): T {
  const merged: Record<string, unknown> = { ...remote }
  const keys = new Set([...Object.keys(base), ...Object.keys(local)])
  for (const key of keys) {
    if (comparable(base[key]) === comparable(local[key])) continue
    if (Object.hasOwn(local, key)) merged[key] = local[key]
    else delete merged[key]
  }
  return merged as T
}

function mergeLocalNodeChanges(base: Node, local: Node, remote: Node): Node {
  const merged = mergeLocalObjectChanges(base as unknown as Record<string, unknown>, local as unknown as Record<string, unknown>, remote as unknown as Record<string, unknown>) as unknown as Node
  const baseData = base.data as Record<string, unknown>
  const localData = local.data as Record<string, unknown>
  const remoteData = remote.data as Record<string, unknown>
  const data = mergeLocalObjectChanges(baseData, localData, remoteData)
  const baseParams = baseData.params && typeof baseData.params === 'object' && !Array.isArray(baseData.params)
    ? baseData.params as Record<string, unknown>
    : {}
  const localParams = localData.params && typeof localData.params === 'object' && !Array.isArray(localData.params)
    ? localData.params as Record<string, unknown>
    : {}
  const remoteParams = remoteData.params && typeof remoteData.params === 'object' && !Array.isArray(remoteData.params)
    ? remoteData.params as Record<string, unknown>
    : {}
  if (comparable(baseData.params) !== comparable(localData.params)) {
    data.params = mergeLocalObjectChanges(baseParams, localParams, remoteParams)
  }
  merged.data = data
  return merged
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function TextNode({ id, data, selected }: NodeProps<Node<{ label?: string; output?: string; outputOverride?: boolean; taskId?: string; taskStatus?: DesktopTask['status']; taskError?: string | null }>>) {
  const actions = useContext(TextNodeContext)
  const [providerType, setProviderType] = useState<'local' | 'cloud'>('cloud')
  const label = typeof data.label === 'string' ? data.label : ''
  const savedOutput = data.outputOverride && typeof data.output === 'string' ? data.output : ''
  const taskOutput = data.taskId && actions.taskOutputs[id]?.taskId === data.taskId ? actions.taskOutputs[id].text : ''
  const output = data.outputOverride ? savedOutput : taskOutput
  const node: NodePayload = { id, type: 'text', params: { prompt: label }, status: data.taskStatus ?? 'ready' }
  const availableProvider = providerType === 'cloud' && actions.agnesAvailable ? 'cloud' : actions.localModelAvailable ? 'local' : actions.agnesAvailable ? 'cloud' : null
  const taskMessage = generationStateMessage(data.taskStatus, data.taskError) || actions.generationErrors[id] || ''
  return (
    <SplitNodeLayout node={node} selected={Boolean(selected)} busy={actions.pendingNodeId === id || data.taskStatus === 'queued' || data.taskStatus === 'running'} accentColor="#6366f1" label="Text" icon={Type}
      topContent={selected
        ? <div className="h-full w-full"><textarea aria-label="生成结果" className="nodrag nowheel h-full max-h-[108px] w-full resize-none whitespace-pre-wrap bg-transparent text-[12px] leading-relaxed text-[#222] outline-none placeholder:text-[#b0b0b8]" value={output} placeholder="生成结果…" onMouseDown={(event) => event.stopPropagation()} onChange={(event) => actions.updateNodeData(id, { output: event.target.value, outputOverride: true })} /></div>
        : <div className="w-full text-[12px] leading-relaxed text-[#222]">{output ? <div className="line-clamp-4">{output}</div> : <span className="text-[#b0b0b8]">点击编辑文本</span>}</div>}
      bottom={<div className="nodrag nowheel flex flex-col rounded-[20px]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex flex-col gap-3 p-4">
          <div><p className="mb-1.5 text-[12px] font-bold text-[#333]">参考</p><div className="flex items-center gap-2"><span className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#f0f0f2] text-[#888] ring-1 ring-black/6"><Type size={16} /></span><span className="text-[11px] text-[#aaa]">连接上游节点后自动出现在此</span></div></div>
          <textarea aria-label="文本节点内容" className="min-h-[220px] w-full resize-none rounded-xl border border-black/10 bg-white px-3.5 py-3 text-[13px] leading-relaxed text-[#222] outline-none placeholder:text-[#b0b0b8]" value={label} maxLength={20_000} placeholder="旧句未歇纸上，新意已在心间" onChange={(event) => actions.updateText(id, event.target.value)} onBlur={(event) => actions.updateText(id, event.currentTarget.value, true)} />
          {taskMessage && <p role="status" className="rounded-lg bg-red-50 px-2.5 py-2 text-[11px] leading-5 text-red-700">{taskMessage}</p>}
        </div>
        <div className="flex items-center gap-2 border-t border-white/10 bg-[#1a1a1a] px-3.5 py-2.5">
          {availableProvider ? <select aria-label="文本生成模型" value={availableProvider} onChange={(event) => setProviderType(event.target.value as 'local' | 'cloud')} className="max-w-[200px] rounded-lg bg-white/10 px-2 py-1.5 text-[11px] font-bold text-white outline-none"><option value="local" disabled={!actions.localModelAvailable}>本地文本模型</option><option value="cloud" disabled={!actions.agnesAvailable}>Agnes 2.5 Flash</option></select> : <button type="button" onClick={actions.openModelSettings} className="rounded-lg bg-white/10 px-2 py-1.5 text-[11px] font-bold text-white">配置模型</button>}
          <button type="button" aria-label="生成文本" title="生成" disabled={!availableProvider || !label.trim() || actions.pendingNodeId === id} onClick={() => { if (availableProvider) actions.generate(id, label, availableProvider, 'text') }} className="ml-auto flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-white disabled:opacity-40">→</button>
        </div>
      </div>}
    />
  )
}

function MediaPromptEditor({ id, modality, label, taskStatus, taskError, settings }: { id: string; modality: 'image' | 'video'; label: string; taskStatus?: DesktopTask['status']; taskError?: string | null; settings: { size?: string; aspectRatio?: string; seconds?: number } }) {
  const actions = useContext(TextNodeContext)
  const size = settings.size ?? '2K'
  const aspectRatio = settings.aspectRatio ?? (modality === 'image' ? '1:1' : '16:9')
  const seconds = settings.seconds ?? 5
  const taskMessage = generationStateMessage(taskStatus, taskError) || actions.generationErrors[id] || ''
  return <div className="nodrag nowheel flex flex-col rounded-[20px]" onMouseDown={(event) => event.stopPropagation()}>
    <div className="flex flex-col gap-3 p-4">
      <div><p className="mb-1.5 text-[12px] font-bold text-[#333]">{modality === 'video' ? '首尾帧' : '参考'}</p><div className="flex items-center gap-2"><span className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#f0f0f2] text-[#888] ring-1 ring-black/6"><ImageIcon size={16} /></span><span className="text-[11px] text-[#aaa]">连接上游节点后自动出现在此</span></div></div>
      <textarea aria-label={`${modality === 'image' ? '图片' : '视频'}节点提示词`} className="min-h-[220px] w-full resize-none rounded-xl border border-black/10 bg-white px-3.5 py-3 text-[13px] leading-relaxed text-[#222] outline-none placeholder:text-[#b0b0b8]" value={label} maxLength={20_000} placeholder={modality === 'video' ? '描述你要生成的视频内容…' : '墨痕未落纸上，山水已在眼前'} onChange={(event) => actions.updateText(id, event.target.value)} onBlur={(event) => actions.updateText(id, event.currentTarget.value, true)} />
      {taskMessage && <p role="status" className="rounded-lg bg-red-50 px-2.5 py-2 text-[11px] leading-5 text-red-700">{taskMessage}</p>}
    </div>
    <div className="flex items-center gap-2 border-t border-white/10 bg-[#1a1a1a] px-3.5 py-2.5">
      {actions.agnesAvailable ? <span className="rounded-lg bg-white/10 px-2 py-1.5 text-[11px] font-bold text-white">{modality === 'image' ? 'Agnes Image 2.5 Flash' : 'Agnes Video 2.5 Flash'}</span> : <button type="button" onClick={actions.openModelSettings} className="rounded-lg bg-white/10 px-2 py-1.5 text-[11px] font-bold text-white">配置模型</button>}
      {modality === 'image' ? <select aria-label="图像尺寸" value={size} onChange={(event) => actions.updateNodeData(id, { size: event.target.value })} className="max-w-[56px] rounded-lg bg-white/10 px-1.5 py-1.5 text-[10px] font-bold text-white outline-none">{['1K', '2K', '3K', '4K'].map((value) => <option key={value} value={value}>{value}</option>)}</select> : <select aria-label="视频时长" value={seconds} onChange={(event) => actions.updateNodeData(id, { seconds: Number(event.target.value) })} className="max-w-[54px] rounded-lg bg-white/10 px-1.5 py-1.5 text-[10px] font-bold text-white outline-none">{[4, 5, 6, 8, 10, 12].map((value) => <option key={value} value={value}>{value}s</option>)}</select>}
      <select aria-label="画面比例" value={aspectRatio} onChange={(event) => actions.updateNodeData(id, { aspectRatio: event.target.value })} className="max-w-[62px] rounded-lg bg-white/10 px-1.5 py-1.5 text-[10px] font-bold text-white outline-none">{(modality === 'image' ? ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', '2:3', '3:2'] : ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']).map((value) => <option key={value} value={value}>{value}</option>)}</select>
      <button type="button" aria-label={`生成${modality === 'image' ? '图片' : '视频'}`} title="生成" disabled={!actions.agnesAvailable || !label.trim() || actions.pendingNodeId === id} onClick={() => actions.generate(id, label, 'cloud', modality, modality === 'image' ? { size, ratio: aspectRatio } : { seconds, aspectRatio })} className="ml-auto flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-white disabled:opacity-40">→</button>
    </div>
  </div>
}

function ImageNode({ id, data, selected }: NodeProps<Node<{ assetId?: string; taskId?: string; name?: string; label?: string; size?: string; aspectRatio?: string; params?: Record<string, unknown>; taskStatus?: DesktopTask['status']; taskError?: string | null }>>) {
  const [imageUnavailable, setImageUnavailable] = useState(false)
  const assetId = typeof data.assetId === 'string' ? data.assetId : ''
  const taskId = typeof data.taskId === 'string' ? data.taskId : ''
  const source = taskId && (!data.taskStatus || data.taskStatus === 'succeeded') ? `vibe://app/tasks/${taskId}/output` : assetId ? `vibe://app/assets/${assetId}` : ''
  useEffect(() => setImageUnavailable(false), [source])
  const label = typeof data.label === 'string' ? data.label : ''
  const name = typeof data.name === 'string' ? data.name : '图片素材'
  const params = data.params && typeof data.params === 'object' && !Array.isArray(data.params) ? data.params : {}
  const size = data.size ?? (typeof params.size === 'string' ? params.size : undefined)
  const aspectRatio = data.aspectRatio ?? (typeof params.aspectRatio === 'string' ? params.aspectRatio : undefined)
  const node: NodePayload = { id, type: 'image', params: { url: source }, status: data.taskStatus ?? 'ready' }
  return (
    <SplitNodeLayout node={node} selected={Boolean(selected)} busy={data.taskStatus === 'queued' || data.taskStatus === 'running'} accentColor="#0ea5e9" label="Image" icon={ImageIcon} mediaFrame={source ? 'natural' : undefined}
      topContent={source && !imageUnavailable ? <img className="pointer-events-none max-h-[240px] w-full object-contain" src={source} alt={name} draggable={false} onError={() => setImageUnavailable(true)} /> : <div className="flex min-h-24 w-full flex-col items-center justify-center bg-[#f4f4f9] px-2 text-xs text-[#b0b0b8]"><span>{label || '点击编辑图片描述'}</span>{generationStateMessage(data.taskStatus, data.taskError) && <span className="mt-2 text-red-600">{generationStateMessage(data.taskStatus, data.taskError)}</span>}</div>}
      bottom={<MediaPromptEditor id={id} modality="image" label={label} taskStatus={data.taskStatus} taskError={data.taskError} settings={{ size, aspectRatio }} />}
    />
  )
}

function VideoNode({ id, data, selected }: NodeProps<Node<{ taskId?: string; name?: string; label?: string; aspectRatio?: string; seconds?: number; params?: Record<string, unknown>; taskStatus?: DesktopTask['status']; taskError?: string | null }>>) {
  const taskId = typeof data.taskId === 'string' ? data.taskId : ''
  const source = taskId && (!data.taskStatus || data.taskStatus === 'succeeded') ? `vibe://app/tasks/${taskId}/output` : ''
  const label = typeof data.label === 'string' ? data.label : ''
  const params = data.params && typeof data.params === 'object' && !Array.isArray(data.params) ? data.params : {}
  const aspectRatio = data.aspectRatio ?? (typeof params.aspectRatio === 'string' ? params.aspectRatio : undefined)
  const seconds = data.seconds ?? (typeof params.seconds === 'number' ? params.seconds : undefined)
  const node: NodePayload = { id, type: 'video', params: { url: source }, status: data.taskStatus ?? 'ready' }
  return (
    <SplitNodeLayout node={node} selected={Boolean(selected)} busy={data.taskStatus === 'queued' || data.taskStatus === 'running'} accentColor="#f43f5e" label="Video" icon={Video} mediaFrame={source ? 'natural' : undefined}
      topContent={source ? <video className="nodrag nowheel max-h-[240px] w-full bg-black" src={source} controls preload="metadata" /> : <div className="flex min-h-24 w-full flex-col items-center justify-center bg-[#f4f4f9] px-2 text-xs text-[#b0b0b8]"><span>{label || '点击编辑视频描述'}</span>{generationStateMessage(data.taskStatus, data.taskError) && <span className="mt-2 text-red-600">{generationStateMessage(data.taskStatus, data.taskError)}</span>}</div>}
      bottom={<MediaPromptEditor id={id} modality="video" label={label} taskStatus={data.taskStatus} taskError={data.taskError} settings={{ seconds, aspectRatio }} />}
    />
  )
}

type DesktopExtendedNodeData = {
  label?: string
  taskId?: string
  taskStatus?: DesktopTask['status']
  taskError?: string | null
  params?: Record<string, unknown>
}

type DesktopAudioReference = {
  id: string
  sourceNodeId: string
  kind: 'image' | 'video' | 'audio' | 'text'
  label: string
  url?: string
  text?: string
  local?: boolean
}

function DesktopAudioReferenceThumb({ reference, onRemove }: { reference: DesktopAudioReference; onRemove: () => void }) {
  const Icon = reference.kind === 'text' ? Type : reference.kind === 'video' ? Video : reference.kind === 'audio' ? AudioLines : ImageIcon
  return <div className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-[#f0f0f2] ring-1 ring-black/8" title={reference.text || reference.label}>
    {reference.kind === 'image' && reference.url
      ? <img src={reference.url} alt="" className="h-full w-full object-cover" />
      : reference.kind === 'video' && reference.url
        ? <video src={reference.url} muted className="h-full w-full object-cover" />
        : <div className="flex h-full flex-col items-center justify-center gap-1 p-1 text-[#555]"><Icon size={18} strokeWidth={1.75} /><span className="max-w-full truncate text-[9px]">{reference.label}</span></div>}
    <button type="button" onClick={(event) => { event.stopPropagation(); onRemove() }} className="absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 text-white opacity-100 hover:bg-black" title="移除参考" aria-label="移除参考"><X size={10} /></button>
  </div>
}

function AudioNodeEditor({ id, label, params, references, taskStatus, taskError }: {
  id: string
  label: string
  params: Record<string, unknown>
  references: DesktopAudioReference[]
  taskStatus?: DesktopTask['status']
  taskError?: string | null
}) {
  const actions = useContext(TextNodeContext)
  const [localReferences, setLocalReferences] = useState<DesktopAudioReference[]>([])
  const excludedIds = new Set(Array.isArray(params.excludedRefIds) ? params.excludedRefIds.map(String) : [])
  const visibleReferences = references.filter((reference) => reference.local || !excludedIds.has(reference.id))
  const allReferences = [...visibleReferences, ...localReferences]
  const unavailableReason = '桌面本地任务目前不支持音频生成；上传音频参考的 Local Core 接口也尚未迁移。'
  const stateMessage = generationStateMessage(taskStatus, taskError) || actions.generationErrors[id]

  const addTextReference = () => {
    const text = window.prompt('输入参考文本')
    if (!text?.trim()) return
    setLocalReferences((previous) => [...previous, {
      id: `local-text-${crypto.randomUUID()}`,
      sourceNodeId: '',
      kind: 'text' as const,
      label: '文本',
      text: text.trim(),
      local: true,
    }])
  }

  const removeReference = (reference: DesktopAudioReference) => {
    if (reference.local) {
      setLocalReferences((previous) => previous.filter((item) => item.id !== reference.id))
      return
    }
    actions.updateNodeParams(id, { excludedRefIds: [...excludedIds, reference.id] })
  }

  return <div className="nodrag nowheel flex flex-col rounded-[20px]" onMouseDown={(event) => event.stopPropagation()}>
    <div className="flex flex-col gap-3 p-4">
      <div>
        <p className="mb-1.5 text-[12px] font-bold text-[#333]">参考</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled title={unavailableReason} aria-label="上传音频参考（桌面版尚未接入）" className="flex h-14 w-14 cursor-not-allowed flex-col items-center justify-center rounded-xl bg-[#f0f0f2] text-[#aaa] ring-1 ring-black/6"><ArrowUpFromLine size={16} /></button>
          <button type="button" title="添加文本参考" onClick={addTextReference} className="flex h-14 w-14 flex-col items-center justify-center rounded-xl bg-[#f0f0f2] text-[#888] ring-1 ring-black/6 hover:bg-[#e8e8ec]"><Type size={16} /></button>
          {visibleReferences.length > 0 && <div className="mx-0.5 h-10 w-px shrink-0 bg-black/10" />}
          {allReferences.map((reference) => <DesktopAudioReferenceThumb key={reference.id} reference={reference} onRemove={() => removeReference(reference)} />)}
          {allReferences.length === 0 && <span className="text-[11px] text-[#aaa]">连接上游节点后自动出现在此</span>}
        </div>
        <p className="mt-2 text-[10px] leading-4 text-amber-800">桌面 Local Core 尚未提供音频文件导入接口，音频上传入口暂不可用；可连接上游节点或添加本地文本参考。</p>
      </div>
      <textarea aria-label="音频节点提示词" className="min-h-[220px] w-full resize-none rounded-xl border border-black/10 bg-white px-3.5 py-3 text-[13px] leading-relaxed text-[#222] outline-none placeholder:text-[#b0b0b8]" value={label} maxLength={20_000} placeholder="描述你要生成的音频内容…" onChange={(event) => actions.updateText(id, event.target.value)} onBlur={(event) => actions.updateText(id, event.currentTarget.value, true)} />
      <p role="status" className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-5 text-amber-800">{unavailableReason}</p>
      {stateMessage && <p role="status" className="rounded-lg bg-red-50 px-2.5 py-2 text-[11px] leading-5 text-red-700">{stateMessage}</p>}
    </div>
    <div className="flex items-center gap-2 border-t border-white/10 bg-[#1a1a1a] px-3.5 py-2.5">
      <span className="max-w-[200px] truncate rounded-lg bg-white/10 px-2 py-1.5 text-[11px] font-bold text-white/50" title="桌面版暂无音频模型">音频模型暂未接入</span>
      <button type="button" aria-label="生成音频" title={unavailableReason} disabled className="ml-auto flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-white/40">→</button>
    </div>
  </div>
}

function AudioNode({ id, data, selected }: NodeProps<Node<DesktopExtendedNodeData>>) {
  const actions = useContext(TextNodeContext)
  const label = typeof data.label === 'string' ? data.label : ''
  const params = isRecord(data.params) ? data.params : {}
  const references = actions.getUpstreamReferences(id)
  const storedUrl = typeof params.lastOutputUrl === 'string' ? params.lastOutputUrl
    : typeof params.url === 'string' ? params.url
      : typeof params.referenceUrl === 'string' ? params.referenceUrl : ''
  const assetUrl = typeof params.assetId === 'string' ? `vibe://app/assets/${params.assetId}` : ''
  const source = data.taskId && data.taskStatus === 'succeeded' ? `vibe://app/tasks/${data.taskId}/output` : storedUrl || assetUrl
  const node: NodePayload = { id, type: 'audio', params, status: data.taskStatus ?? 'ready' }
  const uploadUnavailable = '桌面 Local Core 尚未提供音频文件导入能力，音频文件未上传。'
  return <SplitNodeLayout node={node} selected={Boolean(selected)} busy={data.taskStatus === 'queued' || data.taskStatus === 'running'} accentColor="#10b981" label="Audio" icon={AudioLines}
    topMinHeight="min-h-[72px]" topMinHeightCollapsed="min-h-[48px]"
    topUpload={{ accept: 'audio/*', onUpload: () => {}, unavailableReason: uploadUnavailable }}
    topContent={source ? <audio className="nodrag nowheel w-full" src={source} controls preload="metadata" /> : <div className="flex flex-col items-center gap-2 text-[12px] text-[#b0b0b8]"><AudioLines size={22} /><span>{label || '点击编辑音频'}</span><span className="text-center text-[10px] text-amber-800">音频文件导入暂不可用</span>{generationStateMessage(data.taskStatus, data.taskError) && <span className="text-red-600">{generationStateMessage(data.taskStatus, data.taskError)}</span>}</div>}
    bottom={<AudioNodeEditor id={id} label={label} params={params} references={references} taskStatus={data.taskStatus} taskError={data.taskError} />}
    extra={selected && data.taskStatus === 'succeeded' && source ? <div className="mt-2 flex justify-end"><button type="button" disabled title="桌面 Local Core 尚未提供音频素材入库接口" className="rounded-lg bg-black/5 px-2.5 py-1.5 text-[11px] font-bold text-[#999]">存入素材库暂不可用</button></div> : null}
  />
}

function ComposeNode({ id, data, selected }: NodeProps<Node<DesktopExtendedNodeData>>) {
  const label = typeof data.label === 'string' ? data.label : ''
  const params = data.params && typeof data.params === 'object' ? data.params : {}
  const node: NodePayload = { id, type: 'compose', params, status: data.taskStatus ?? 'ready' }
  const reason = '桌面版本地核心尚未接入视频合成任务；已创建的合成节点和连线仍会保存在本地画布。'
  return <SplitNodeLayout node={node} selected={Boolean(selected)} busy={data.taskStatus === 'queued' || data.taskStatus === 'running'} accentColor="#f59e0b" label="Compose" icon={Clapperboard}
    topMinHeight="min-h-[88px]" topMinHeightCollapsed="min-h-[72px]"
    topContent={<div className="flex flex-col items-center gap-2 rounded-xl bg-[#111]/90 px-4 py-5 text-white/70"><Clapperboard size={22} /><span className="text-[11px] font-semibold">连接视频后合成</span></div>}
    bottom={<div className="nodrag nowheel flex flex-col" onMouseDown={(event) => event.stopPropagation()}>
      <div className="border-b border-black/6 px-3.5 py-2.5 text-[13px] font-bold text-[#222]">时间线</div>
      <p className="px-3.5 py-4 text-center text-[12px] text-[#999]">将至少 2 个视频节点连接到本节点</p>
      <p role="status" className="mx-3.5 mb-3 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-5 text-amber-800">{reason}</p>
      {label.trim() && <p className="border-t border-black/6 px-3.5 py-2 text-[11px] text-[#777]">备注：{label}</p>}
    </div>}
  />
}

function DirectorNode({ id, data, selected }: NodeProps<Node<DesktopExtendedNodeData>>) {
  const label = typeof data.label === 'string' ? data.label : ''
  const params = data.params && typeof data.params === 'object' ? data.params : {}
  const node: NodePayload = { id, type: 'director', params, status: data.taskStatus ?? 'ready' }
  const reason = '桌面版导演台 3D 场景编辑、截图生成与场景持久化尚未迁移。'
  return <SplitNodeLayout node={node} selected={Boolean(selected)} busy={false} accentColor="#6366f1" label="Director" icon={Layers}
    topMinHeight="min-h-[112px]" topMinHeightCollapsed="min-h-[88px]"
    topContent={<div className="flex flex-col items-center gap-2 rounded-xl bg-[#f7f7f9] px-4 py-5 text-[#999]"><Layers size={24} strokeWidth={1.5} /><span className="text-[11px] font-semibold">导演台场景预览</span></div>}
    bottom={<div className="nodrag nowheel flex flex-col gap-3 p-4" onMouseDown={(event) => event.stopPropagation()}>
      <p className="text-[12px] leading-5 text-[#777]">{reason}</p>
      <button type="button" disabled title={reason} className="flex h-10 items-center justify-center gap-2 rounded-full bg-[#1a1a2e] text-[12px] font-bold text-white/50"><Clapperboard size={15} />导演台编辑器暂不可用</button>
      {label.trim() && <p className="text-[11px] text-[#888]">备注：{label}</p>}
    </div>}
  />
}

interface TextNodeContextValue {
  updateText: (id: string, label: string, immediate?: boolean) => void
  updateNodeData: (id: string, patch: Record<string, unknown>) => void
  updateNodeParams: (id: string, patch: Record<string, unknown>) => void
  getUpstreamReferences: (id: string) => DesktopAudioReference[]
  generate: (id: string, prompt: string, providerType: 'local' | 'cloud', modality: 'text' | 'image' | 'video', parameters?: Record<string, unknown>) => void
  openModelSettings: () => void
  pendingNodeId: string | null
  generationErrors: Record<string, string>
  taskOutputs: Record<string, { taskId: string; text: string }>
  localModelAvailable: boolean
  agnesAvailable: boolean
}

const TextNodeContext = createContext<TextNodeContextValue>({
  updateText: () => {},
  updateNodeData: () => {},
  updateNodeParams: () => {},
  getUpstreamReferences: () => [],
  generate: () => {},
  openModelSettings: () => {},
  pendingNodeId: null,
  generationErrors: {},
  taskOutputs: {},
  localModelAvailable: false,
  agnesAvailable: false,
})
const nodeTypes = { text: TextNode, image: ImageNode, video: VideoNode, audio: AudioNode, compose: ComposeNode, director: DirectorNode }

const DESKTOP_NODE_MENU = [
  { type: 'text', label: '文本', icon: Type },
  { type: 'image', label: '图片', icon: ImageIcon },
  { type: 'video', label: '视频', icon: Video },
  { type: 'audio', label: '音频', icon: Mic },
  { type: 'compose', label: '合成', icon: Clapperboard },
  { type: 'director', label: '导演台', icon: Layers },
] as const

const EDGE_COMPATIBLE_TARGET_TYPES: Record<string, ReadonlySet<string>> = {
  text: new Set(['text', 'image', 'video', 'audio', 'director']),
  image: new Set(['image', 'video', 'director']),
  video: new Set(['video', 'compose']),
  audio: new Set(['audio', 'video']),
  compose: new Set(['video', 'compose']),
  director: new Set(['image', 'video']),
}

function isEdgeTypeCompatible(sourceType?: string, targetType?: string) {
  return Boolean(sourceType && targetType && EDGE_COMPATIBLE_TARGET_TYPES[sourceType]?.has(targetType))
}

function LoadingScreen() {
  return <div className="flex min-h-screen items-center justify-center bg-[#f7f7f8] text-sm text-[#666]">正在打开本地项目…</div>
}

function LocalCanvas({
  project,
  initialCanvas,
  error,
  onOpenProject,
  onProjectRestored,
}: {
  project: DesktopProject
  initialCanvas: DesktopCanvas
  error: string
  onOpenProject: () => Promise<void>
  onProjectRestored: (project: DesktopProject | null) => Promise<void>
}) {
  const [nodes, setNodes] = useState<Node[]>(initialCanvas.nodes)
  const [edges, setEdges] = useState<Edge[]>(initialCanvas.edges)
  const [assets, setAssets] = useState<DesktopAsset[]>([])
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [assetMode, setAssetMode] = useState<'grid' | 'list'>('grid')
  const [agentOpen, setAgentOpen] = useState(true)
  const [mode, setMode] = useState<'select' | 'pan'>('select')
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number; kind: 'pane' | 'node'; nodeId?: string; sourceNodeId?: string; direction?: 'upstream' | 'downstream' } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ nodeId: string; downstream: Array<{ id: string; type: string }> } | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const { screenToFlowPosition } = useReactFlow()
  const [assetError, setAssetError] = useState('')
  const [assetPending, setAssetPending] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [saveError, setSaveError] = useState('')
  const [backupMessage, setBackupMessage] = useState('')
  const [backupPending, setBackupPending] = useState(false)
  const [restorePending, setRestorePending] = useState(false)
  const [agentSessions, setAgentSessions] = useState<DesktopAgentSession[]>([])
  const [activeAgentSessionId, setActiveAgentSessionId] = useState<string | null>(null)
  const [agentMessages, setAgentMessages] = useState<AgentChatMsg[]>([])
  const [agentDraft, setAgentDraft] = useState('')
  const [agentSessionCreating, setAgentSessionCreating] = useState(false)
  const [agentReplyPending, setAgentReplyPending] = useState(false)
  const [agentSessionError, setAgentSessionError] = useState('')
  const [canvasActionError, setCanvasActionError] = useState('')
  const [generationErrors, setGenerationErrors] = useState<Record<string, string>>({})
  const [taskOutputs, setTaskOutputs] = useState<Record<string, { taskId: string; text: string }>>({})
  const [submittingNode, setSubmittingNode] = useState<string | null>(null)
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false)
  const [localTextModel, setLocalTextModel] = useState<DesktopLocalTextModel | null>(null)
  const [agnesModels, setAgnesModels] = useState<DesktopAgnesModelCatalog | null>(null)
  const [modelLoadError, setModelLoadError] = useState('')
  const version = useRef(initialCanvas.version)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nodeUpdateTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const nodeEditRevisions = useRef(new Map<string, number>())
  const nodePersistedRevisions = useRef(new Map<string, number>())
  const nodeUpdateInFlight = useRef(new Map<string, { revision: number; promise: Promise<void> }>())
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const saveFailure = useRef<string | null>(null)
  const pendingEdgeDeletes = useRef(new Set<string>())
  const createNodeCommandsPending = useRef(0)
  const persistDeferredDuringNodeCreation = useRef(false)
  const agentReplyPendingRef = useRef(false)
  const agentEventStatesRef = useRef(new Map<string, AgentEventState>())
  const agentEventSequencesRef = useRef(new Map<string, number>())
  const taskOutputsRef = useRef(taskOutputs)
  taskOutputsRef.current = taskOutputs

  const refreshAgentSessions = useCallback(async (preferredSessionId?: string) => {
    if (!bridge) return
    setAgentSessionError('')
    try {
      const sessions = await bridge.listAgentSessions(project.projectId)
      setAgentSessions(sessions)
      const sessionId = preferredSessionId && sessions.some((session) => session.sessionId === preferredSessionId)
        ? preferredSessionId
        : sessions[0]?.sessionId ?? null
      setActiveAgentSessionId(sessionId)
      if (!sessionId) {
        setAgentMessages([])
        return
      }
      if (bridge.getAgentSessionSnapshot) {
        const snapshot = await bridge.getAgentSessionSnapshot(project.projectId, sessionId)
        let state = createAgentEventState(toAgentChatMessages(snapshot.messages))
        for (const event of snapshot.events) state = reduceAgentEvent(state, event)
        agentEventStatesRef.current.set(sessionId, state)
        agentEventSequencesRef.current.set(sessionId, snapshot.lastEventSeq)
        setAgentMessages(state.messages)
      } else {
        const messages = toAgentChatMessages(await bridge.getAgentMessages(project.projectId, sessionId))
        agentEventStatesRef.current.set(sessionId, createAgentEventState(messages))
        agentEventSequencesRef.current.set(sessionId, 0)
        setAgentMessages(messages)
      }
    } catch (cause) {
      setAgentSessionError(cause instanceof Error ? cause.message : '无法读取本地 Agent 会话。')
    }
  }, [project.projectId])

  const loadAgentSession = useCallback(async (sessionId: string) => {
    if (!bridge) return
    setActiveAgentSessionId(sessionId)
    setAgentSessionError('')
    try {
      if (bridge.getAgentSessionSnapshot) {
        const snapshot = await bridge.getAgentSessionSnapshot(project.projectId, sessionId)
        let state = createAgentEventState(toAgentChatMessages(snapshot.messages))
        for (const event of snapshot.events) state = reduceAgentEvent(state, event)
        agentEventStatesRef.current.set(sessionId, state)
        agentEventSequencesRef.current.set(sessionId, snapshot.lastEventSeq)
        setAgentMessages(state.messages)
      } else {
        const messages = toAgentChatMessages(await bridge.getAgentMessages(project.projectId, sessionId))
        agentEventStatesRef.current.set(sessionId, createAgentEventState(messages))
        agentEventSequencesRef.current.set(sessionId, 0)
        setAgentMessages(messages)
      }
    } catch (cause) {
      setAgentSessionError(cause instanceof Error ? cause.message : '无法读取此会话的消息。')
    }
  }, [project.projectId])

  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])
  useEffect(() => {
    let cancelled = false
    void bridge?.listAssets(project.projectId).then((items) => {
      if (!cancelled) setAssets(items)
    }).catch((cause: unknown) => {
      if (!cancelled) setAssetError(cause instanceof Error ? cause.message : '无法读取本地素材。')
    })
    return () => { cancelled = true }
  }, [project.projectId])
  useEffect(() => {
    let cancelled = false
    void Promise.allSettled([bridge?.getLocalTextModel(), bridge?.getAgnesModels()]).then(([localResult, cloudResult]) => {
      if (!cancelled) {
        if (localResult.status === 'fulfilled') setLocalTextModel(localResult.value ?? null)
        if (cloudResult.status === 'fulfilled') {
          setAgnesModels(cloudResult.value ?? null)
        }
        const errors = [localResult, cloudResult]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason instanceof Error ? result.reason.message : '无法读取模型配置。')
        setModelLoadError(errors.join(' '))
      }
    })
    return () => { cancelled = true }
  }, [])
  useEffect(() => { void refreshAgentSessions() }, [refreshAgentSessions])
  const persist = useCallback((nextNodes: Node[], nextEdges: Edge[]) => {
    if (!bridge) return
    // A save can wait behind create/update/connect commands. Read refs when it
    // reaches the queue so it cannot replay a pre-reconciliation snapshot.
    void nextNodes
    void nextEdges
    if (createNodeCommandsPending.current > 0) {
      persistDeferredDuringNodeCreation.current = true
      return
    }
    setSaveState('saving')
    setSaveError('')
    saveFailure.current = null
    saveQueue.current = saveQueue.current.then(async () => {
      const result = await bridge.saveCanvas({
        projectId: project.projectId,
        canvasId: project.canvasId,
        expectedVersion: version.current,
        nodes: nodesRef.current,
        edges: edgesRef.current,
      })
      version.current = result.version
      saveFailure.current = null
      setSaveState('saved')
    }).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : '保存画布失败。'
      saveFailure.current = message
      setSaveState('error')
      setSaveError(message)
    })
  }, [project.canvasId, project.projectId])

  const schedulePersist = useCallback((nextNodes: Node[], nextEdges: Edge[], immediate = false) => {
    if (timer.current) clearTimeout(timer.current)
    if (immediate) {
      timer.current = null
      persist(nextNodes, nextEdges)
      return
    }
    timer.current = setTimeout(() => {
      timer.current = null
      persist(nodesRef.current, edgesRef.current)
    }, 400)
  }, [persist])

  const flushNodeUpdate = useCallback((nodeId: string): Promise<void> => {
    const scheduled = nodeUpdateTimers.current.get(nodeId)
    if (scheduled) {
      clearTimeout(scheduled)
      nodeUpdateTimers.current.delete(nodeId)
    }
    const revision = nodeEditRevisions.current.get(nodeId) ?? 0
    if (!bridge || revision <= (nodePersistedRevisions.current.get(nodeId) ?? 0)) return Promise.resolve()

    const inFlight = nodeUpdateInFlight.current.get(nodeId)
    if (inFlight) {
      return inFlight.revision >= revision
        ? inFlight.promise
        : inFlight.promise.then(() => flushNodeUpdate(nodeId))
    }

    const command = saveQueue.current.then(async () => {
      const currentNode = nodesRef.current.find((node) => node.id === nodeId)
      if (!currentNode) return
      const submittedRevision = nodeEditRevisions.current.get(nodeId) ?? 0
      if (submittedRevision <= (nodePersistedRevisions.current.get(nodeId) ?? 0)) return

      const label = typeof currentNode.data.label === 'string' ? currentNode.data.label : ''
      const currentParams = currentNode.data.params && typeof currentNode.data.params === 'object' && !Array.isArray(currentNode.data.params)
        ? currentNode.data.params as Record<string, unknown>
        : {}
      const params = { ...currentParams, prompt: label }
      setSaveState('saving')
      setSaveError('')
      const result: DesktopUpdateNodeResult = await bridge.updateNode({
        projectId: project.projectId,
        canvasId: project.canvasId,
        expectedVersion: version.current,
        idempotencyKey: crypto.randomUUID(),
        nodeId,
        prompt: label,
        params,
      })
      version.current = result.version
      nodePersistedRevisions.current.set(nodeId, submittedRevision)

      const backendStates = new Map<string, Record<string, unknown>>()
      for (const state of result.staleNodes) {
        backendStates.set(state.id, {
          stale: state.stale,
          execStatus: state.execStatus,
          ...(state.nested ? { node: state.nested } : {}),
        })
      }
      backendStates.set(result.node.id, result.node.data)
      const reconcileStatus = (node: Node, storedData: Record<string, unknown>, includeContent: boolean): Node => {
        const currentData = node.data ?? {}
        const storedNested = storedData.node && typeof storedData.node === 'object' && !Array.isArray(storedData.node)
          ? storedData.node as Record<string, unknown>
          : null
        const currentNested = currentData.node && typeof currentData.node === 'object' && !Array.isArray(currentData.node)
          ? currentData.node as Record<string, unknown>
          : null
        const data: Record<string, unknown> = {
          ...currentData,
          stale: storedData.stale,
          execStatus: storedData.execStatus,
          ...(storedNested ? { node: currentNested
            ? { ...currentNested, stale: storedNested.stale, execStatus: storedNested.execStatus }
            : storedNested } : {}),
        }
        if (includeContent) {
          for (const key of ['label', 'params', 'status', 'currentOutputId', 'groupId', 'stackId', 'creativeType', 'modelRef', 'prompt']) {
            if (Object.hasOwn(storedData, key)) data[key] = storedData[key]
          }
          if (storedNested) data.node = storedNested
        }
        return { ...node, data }
      }
      const latestRevision = nodeEditRevisions.current.get(nodeId) ?? 0
      const next = nodesRef.current.map((node) => {
        const storedData = backendStates.get(node.id)
        if (!storedData) return node
        return reconcileStatus(node, storedData, node.id === nodeId && latestRevision === submittedRevision)
      })
      nodesRef.current = next
      setNodes(next)
      saveFailure.current = null
      if (latestRevision <= submittedRevision) {
        setSaveState('saved')
        setSaveError('')
      }
    }).catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : '保存节点修改失败。'
      saveFailure.current = message
      setSaveState('error')
      setSaveError(message)
      throw cause
    })
    const tracked = command.finally(() => {
      if (nodeUpdateInFlight.current.get(nodeId)?.promise === tracked) nodeUpdateInFlight.current.delete(nodeId)
    })
    nodeUpdateInFlight.current.set(nodeId, { revision, promise: tracked })
    saveQueue.current = tracked.then(() => undefined, () => undefined)
    return tracked
  }, [project.canvasId, project.projectId])

  const scheduleNodeUpdate = useCallback((nodeId: string, immediate = false) => {
    const previous = nodeUpdateTimers.current.get(nodeId)
    if (previous) clearTimeout(previous)
    nodeUpdateTimers.current.delete(nodeId)
    if (immediate) {
      void flushNodeUpdate(nodeId).catch(() => undefined)
      return
    }
    const scheduled = setTimeout(() => {
      nodeUpdateTimers.current.delete(nodeId)
      void flushNodeUpdate(nodeId).catch(() => undefined)
    }, 400)
    nodeUpdateTimers.current.set(nodeId, scheduled)
  }, [flushNodeUpdate])

  const flushPendingNodeUpdates = useCallback(async () => {
    const nodeIds = new Set([...nodeUpdateTimers.current.keys(), ...nodeUpdateInFlight.current.keys()])
    await Promise.all([...nodeIds].map((nodeId) => flushNodeUpdate(nodeId)))
    await saveQueue.current
  }, [flushNodeUpdate])

  const refreshCanvasAfterAgent = useCallback(async (baselineNodes: Node[], baselineEdges: Edge[]) => {
    if (!bridge) return
    const clearDebounces = () => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      for (const pendingTimer of nodeUpdateTimers.current.values()) clearTimeout(pendingTimer)
      nodeUpdateTimers.current.clear()
    }

    let authoritative: DesktopCanvas | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      clearDebounces()
      const versionBeforeRead = version.current
      await saveQueue.current
      const loaded = await bridge.loadCanvas(project.projectId, project.canvasId)
      clearDebounces()
      await saveQueue.current
      if (version.current === versionBeforeRead) {
        authoritative = loaded
        break
      }
    }
    if (!authoritative) authoritative = await bridge.loadCanvas(project.projectId, project.canvasId)

    const baselineById = new Map(baselineNodes.map((node) => [node.id, node]))
    const localById = new Map(nodesRef.current.map((node) => [node.id, node]))
    const remoteById = new Map(authoritative.nodes.map((node) => [node.id, node]))
    const contentNodeIds = new Set<string>()
    let needsCanvasSave = false
    const nextNodes: Node[] = []

    const promptOf = (node: Node | undefined) => {
      if (!node) return ''
      if (typeof node.data.label === 'string') return node.data.label
      if (typeof node.data.prompt === 'string') return node.data.prompt
      const params = isRecord(node.data.params) ? node.data.params : {}
      return typeof params.prompt === 'string' ? params.prompt : ''
    }
    const paramsOf = (node: Node | undefined) => node && isRecord(node.data.params) ? node.data.params : {}
    const contentDiffers = (local: Node, remote: Node) => {
      if (promptOf(local) !== promptOf(remote)) return true
      const localParams = paramsOf(local)
      const remoteParams = paramsOf(remote)
      return ['size', 'aspectRatio', 'seconds'].some((key) =>
        (local.data[key] ?? localParams[key]) !== (remote.data[key] ?? remoteParams[key]))
    }
    const hasNonContentNodeDiff = (local: Node, remote: Node) => {
      if (comparable(local.position) !== comparable(remote.position)
        || local.width !== remote.width || local.height !== remote.height) return true
      const ignoredDataKeys = new Set(['label', 'prompt', 'params', 'size', 'aspectRatio', 'seconds', 'stale', 'execStatus', 'selected'])
      const keys = new Set([...Object.keys(local.data), ...Object.keys(remote.data)])
      for (const key of keys) {
        if (!ignoredDataKeys.has(key) && comparable(local.data[key]) !== comparable(remote.data[key])) return true
      }
      const localParams = paramsOf(local)
      const remoteParams = paramsOf(remote)
      const paramKeys = new Set([...Object.keys(localParams), ...Object.keys(remoteParams)])
      for (const key of paramKeys) {
        if (!['prompt', 'size', 'aspectRatio', 'seconds'].includes(key)
          && comparable(localParams[key]) !== comparable(remoteParams[key])) return true
      }
      return false
    }

    for (const remote of authoritative.nodes) {
      const baseline = baselineById.get(remote.id)
      const local = localById.get(remote.id)
      if (!baseline && local) {
        nextNodes.push(local)
        if (hasNonContentNodeDiff(local, remote)) needsCanvasSave = true
        if (contentDiffers(local, remote)) contentNodeIds.add(remote.id)
        continue
      }
      if (baseline && !local) {
        needsCanvasSave = true
        continue
      }
      if (!baseline || !local) {
        nextNodes.push(remote)
        continue
      }
      const merged = mergeLocalNodeChanges(baseline, local, remote)
      nextNodes.push(merged)
      if (comparable(merged) !== comparable(remote) && hasNonContentNodeDiff(merged, remote)) needsCanvasSave = true
      if (contentDiffers(merged, remote)) contentNodeIds.add(remote.id)
    }
    for (const local of nodesRef.current) {
      if (remoteById.has(local.id)) continue
      const baseline = baselineById.get(local.id)
      if (!baseline || comparable(baseline) !== comparable(local)) {
        nextNodes.push(local)
        needsCanvasSave = true
      }
    }

    const baselineEdgesById = new Map(baselineEdges.map((edge) => [edge.id, edge]))
    const localEdgesById = new Map(edgesRef.current.map((edge) => [edge.id, edge]))
    const remoteEdgesById = new Map(authoritative.edges.map((edge) => [edge.id, edge]))
    const nextEdges: Edge[] = []
    for (const remote of authoritative.edges) {
      const baseline = baselineEdgesById.get(remote.id)
      const local = localEdgesById.get(remote.id)
      if (baseline && !local) {
        needsCanvasSave = true
        continue
      }
      if (!baseline && local) {
        nextEdges.push(local)
        if (comparable(local) !== comparable(remote)) needsCanvasSave = true
        continue
      }
      if (!baseline || !local) {
        nextEdges.push(remote)
        continue
      }
      const merged = mergeLocalObjectChanges(baseline as unknown as Record<string, unknown>, local as unknown as Record<string, unknown>, remote as unknown as Record<string, unknown>) as unknown as Edge
      nextEdges.push(merged)
      if (comparable(merged) !== comparable(remote)) needsCanvasSave = true
    }
    for (const local of edgesRef.current) {
      if (remoteEdgesById.has(local.id)) continue
      if (!baselineEdgesById.has(local.id)) {
        nextEdges.push(local)
        needsCanvasSave = true
      }
    }

    version.current = authoritative.version
    nodesRef.current = nextNodes
    edgesRef.current = nextEdges
    setNodes(nextNodes)
    setEdges(nextEdges)
    saveFailure.current = null
    setSaveError('')

    for (const nodeId of contentNodeIds) {
      const persistedRevision = nodePersistedRevisions.current.get(nodeId) ?? 0
      const currentRevision = nodeEditRevisions.current.get(nodeId) ?? 0
      if (currentRevision <= persistedRevision) nodeEditRevisions.current.set(nodeId, persistedRevision + 1)
    }
    await Promise.all([...contentNodeIds].map((nodeId) => flushNodeUpdate(nodeId)))
    if (needsCanvasSave) {
      schedulePersist(nodesRef.current, edgesRef.current, true)
      await saveQueue.current
      if (saveFailure.current) throw new Error(saveFailure.current)
    } else if (contentNodeIds.size === 0) {
      setSaveState('saved')
    }
  }, [flushNodeUpdate, project.canvasId, project.projectId, schedulePersist])

  useEffect(() => {
    const sessionId = activeAgentSessionId
    if (!bridge?.subscribeAgentEvents || !sessionId) return
    let active = true
    const afterSeq = agentEventSequencesRef.current.get(sessionId) ?? 0
    const unsubscribe = bridge.subscribeAgentEvents(project.projectId, sessionId, afterSeq, (event) => {
      if (!active || event.sessionId !== sessionId) return
      const previous = agentEventStatesRef.current.get(sessionId) ?? createAgentEventState([])
      const next = reduceAgentEvent(previous, event)
      agentEventStatesRef.current.set(sessionId, next)
      agentEventSequencesRef.current.set(sessionId, Math.max(agentEventSequencesRef.current.get(sessionId) ?? afterSeq, event.eventSeq))
      setAgentMessages(next.messages)

      if (event.type === 'confirmation_required' || event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_aborted') {
        agentReplyPendingRef.current = false
        setAgentReplyPending(false)
      } else if (event.type === 'task_status') {
        const status = String(event.data.status ?? '')
        const taskStillActive = status === 'queued' || status === 'running'
        agentReplyPendingRef.current = taskStillActive
        setAgentReplyPending(taskStillActive)
      } else {
        agentReplyPendingRef.current = true
        setAgentReplyPending(true)
      }

      if (event.type === 'tool_completed' || (event.type === 'task_status' && String(event.data.status ?? '') === 'succeeded')) {
        const baselineNodes = nodesRef.current
        const baselineEdges = edgesRef.current
        void refreshCanvasAfterAgent(baselineNodes, baselineEdges).catch((cause) => {
          setAgentSessionError(cause instanceof Error ? `画布刷新失败：${cause.message}` : '画布刷新失败。')
        })
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [activeAgentSessionId, project.projectId, refreshCanvasAfterAgent])

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    let refreshing = false
    let taskDetailCursor = 0
    const terminalTaskIds = new Set<string>()
    const taskDetailFailures = new Map<string, { attempts: number; retryAt: number }>()
    const outputReadAttempts = new Map<string, { attempts: number; retryAt: number }>()
    const maxTaskDetailsPerPoll = 16
    const maxOutputReadsPerPoll = 8
    const maxTaskDetailAttempts = 3
    const maxOutputReadAttempts = 3
    const taskDetailRetryDelays = [5_000, 30_000]
    const outputRetryDelays = [5_000, 30_000]
    const refreshNodeTasks = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const recent = await bridge.listTasks(project.projectId, 100)
        if (cancelled) return
        const latestByNode = new Map<string, DesktopTask>()
        for (const task of recent) {
          if (task.nodeId && !latestByNode.has(task.nodeId)) latestByNode.set(task.nodeId, task)
        }
        const currentNodes = nodesRef.current
        const nodesById = new Map(currentNodes.map((node) => [node.id, node]))
        const recentTaskIds = new Set(recent.map((task) => task.taskId))
        const savedTaskIds = [...new Set(currentNodes
          .map((node) => typeof node.data.taskId === 'string' ? node.data.taskId : '')
          .filter(Boolean))]
        const activeTaskIds = new Set([...recentTaskIds, ...savedTaskIds])
        for (const taskId of terminalTaskIds) {
          if (!activeTaskIds.has(taskId)) terminalTaskIds.delete(taskId)
        }
        for (const taskId of taskDetailFailures.keys()) {
          if (!activeTaskIds.has(taskId)) taskDetailFailures.delete(taskId)
        }
        for (const task of recent) {
          if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted') {
            terminalTaskIds.add(task.taskId)
          }
        }

        // Recent tasks provide status cheaply. For task IDs still saved on canvas
        // but outside that window, query a rotating, bounded batch of details.
        const now = Date.now()
        const detailCandidates = savedTaskIds.filter((taskId) => !recentTaskIds.has(taskId) && !terminalTaskIds.has(taskId))
        const eligibleDetails = detailCandidates.filter((taskId) => {
          const state = taskDetailFailures.get(taskId)
          return !state || (state.attempts < maxTaskDetailAttempts && now >= state.retryAt)
        })
        const detailCount = Math.min(eligibleDetails.length, maxTaskDetailsPerPoll)
        const detailStart = eligibleDetails.length > 0 ? taskDetailCursor % eligibleDetails.length : 0
        const detailIds = Array.from({ length: detailCount }, (_, index) => eligibleDetails[(detailStart + index) % eligibleDetails.length])
        if (eligibleDetails.length > 0) taskDetailCursor = (detailStart + detailCount) % eligibleDetails.length
        const detailResults = await Promise.all(detailIds.map(async (taskId) => {
          try {
            const task = await bridge.getTask(project.projectId, taskId)
            if (task) {
              taskDetailFailures.delete(taskId)
              if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted') {
                terminalTaskIds.add(task.taskId)
              }
              return task
            }
            taskDetailFailures.set(taskId, { attempts: maxTaskDetailAttempts, retryAt: Number.POSITIVE_INFINITY })
          } catch {
            const attempts = (taskDetailFailures.get(taskId)?.attempts ?? 0) + 1
            const retryDelay = taskDetailRetryDelays[attempts - 1]
            taskDetailFailures.set(taskId, {
              attempts,
              retryAt: retryDelay ? Date.now() + retryDelay : Number.POSITIVE_INFINITY,
            })
          }
          return null
        }))
        for (const task of detailResults) {
          if (!task?.nodeId || latestByNode.has(task.nodeId)) continue
          const node = nodesById.get(task.nodeId)
          if (node?.data.taskId === task.taskId) latestByNode.set(node.id, task)
        }

        const outputRequests = new Map<string, { nodeId: string; taskId: string }>()
        for (const [nodeId, task] of latestByNode) {
          const node = nodesById.get(nodeId)
          if (node?.type === 'text' && task.status === 'succeeded' && !node.data.outputOverride && taskOutputsRef.current[nodeId]?.taskId !== task.taskId) {
            outputRequests.set(task.taskId, { nodeId, taskId: task.taskId })
          }
        }
        // The recent task window is only for status polling. A canvas node's saved taskId
        // remains the source of truth for recovering older text results after restart.
        for (const node of currentNodes) {
          const taskId = typeof node.data.taskId === 'string' ? node.data.taskId : ''
          const latestTask = latestByNode.get(node.id)
          if (node.type === 'text' && taskId && node.data.taskStatus === 'succeeded'
            && (!latestTask || latestTask.taskId === taskId)
            && !node.data.outputOverride && taskOutputsRef.current[node.id]?.taskId !== taskId) {
            outputRequests.set(taskId, { nodeId: node.id, taskId })
          }
        }

        const dueOutputRequests = [...outputRequests.values()].filter(({ taskId }) => {
          const state = outputReadAttempts.get(taskId)
          return !state || (state.attempts < maxOutputReadAttempts && now >= state.retryAt)
        }).slice(0, maxOutputReadsPerPoll)
        const activeOutputTaskIds = new Set(outputRequests.keys())
        for (const taskId of outputReadAttempts.keys()) {
          if (!activeOutputTaskIds.has(taskId)) outputReadAttempts.delete(taskId)
        }
        const textOutputs = new Map<string, { taskId: string; text: string }>()
        await Promise.all(dueOutputRequests.map(async ({ nodeId, taskId }) => {
          const previous = outputReadAttempts.get(taskId)
          const attempts = (previous?.attempts ?? 0) + 1
          const retryDelay = outputRetryDelays[attempts - 1]
          outputReadAttempts.set(taskId, { attempts, retryAt: retryDelay ? Date.now() + retryDelay : Number.POSITIVE_INFINITY })
          try {
            const text = await bridge.readTaskOutput(project.projectId, taskId)
            textOutputs.set(nodeId, { taskId, text })
          } catch {
            // A missing or unreadable output gets at most three bounded attempts.
          }
        }))
        if (cancelled) return
        if (textOutputs.size > 0) {
          const nextOutputs = { ...taskOutputsRef.current, ...Object.fromEntries(textOutputs) }
          taskOutputsRef.current = nextOutputs
          setTaskOutputs(nextOutputs)
        }
        let changed = false
        const next = nodesRef.current.map((node) => {
          const task = latestByNode.get(node.id)
          if (!task || (node.data.taskId === task.taskId && node.data.taskStatus === task.status && node.data.taskError === task.errorCode)) return node
          changed = true
          return { ...node, data: { ...node.data, taskId: task.taskId, taskStatus: task.status, taskError: task.errorCode } }
        })
        if (changed) {
          nodesRef.current = next
          setNodes(next)
          schedulePersist(next, edgesRef.current)
        }
      } catch {
        // Task status is shown on its associated node; polling failures must
        // not interrupt canvas editing.
      } finally {
        refreshing = false
      }
    }
    void refreshNodeTasks()
    const interval = setInterval(() => { void refreshNodeTasks() }, 2500)
    return () => { cancelled = true; clearInterval(interval) }
  }, [project.projectId, schedulePersist])

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const next = applyNodeChanges(changes, nodesRef.current)
    nodesRef.current = next
    setNodes(next)
    if (changes.some((change) => change.type === 'position' || change.type === 'remove' || change.type === 'add' || change.type === 'replace')) {
      schedulePersist(next, edgesRef.current)
    }
  }, [schedulePersist])

  const updateText = useCallback((id: string, label: string, immediate = false) => {
    let changed = false
    const next = nodesRef.current.map((node) => {
      if (node.id !== id) return node
      if (node.data.label === label) return node
      changed = true
      const params = node.data.params && typeof node.data.params === 'object' && !Array.isArray(node.data.params)
        ? node.data.params as Record<string, unknown>
        : {}
      return { ...node, data: { ...node.data, label, prompt: label, params: { ...params, prompt: label } } }
    })
    nodesRef.current = next
    setNodes(next)
    if (changed) {
      nodeEditRevisions.current.set(id, (nodeEditRevisions.current.get(id) ?? 0) + 1)
      scheduleNodeUpdate(id, immediate)
    } else if (immediate) {
      scheduleNodeUpdate(id, true)
    }
  }, [scheduleNodeUpdate])

  const updateNodeData = useCallback((id: string, patch: Record<string, unknown>) => {
    const configKeys = new Set(['size', 'aspectRatio', 'seconds'])
    const configUpdate = Object.keys(patch).length > 0 && Object.keys(patch).every((key) => configKeys.has(key))
    let changed = false
    const next = nodesRef.current.map((node) => {
      if (node.id !== id) return node
      changed = Object.entries(patch).some(([key, value]) => node.data[key] !== value)
      if (!changed) return node
      const data = { ...node.data, ...patch }
      if (configUpdate) {
        const params = node.data.params && typeof node.data.params === 'object' && !Array.isArray(node.data.params)
          ? node.data.params as Record<string, unknown>
          : {}
        const prompt = typeof data.label === 'string' ? data.label : ''
        data.params = { ...params, ...patch, prompt }
        data.prompt = prompt
      }
      return { ...node, data }
    })
    if (!changed) return
    nodesRef.current = next
    setNodes(next)
    if (configUpdate) {
      nodeEditRevisions.current.set(id, (nodeEditRevisions.current.get(id) ?? 0) + 1)
      scheduleNodeUpdate(id)
    } else {
      schedulePersist(next, edgesRef.current)
    }
  }, [scheduleNodeUpdate, schedulePersist])

  const updateNodeParams = useCallback((id: string, patch: Record<string, unknown>) => {
    let changed = false
    const next = nodesRef.current.map((node) => {
      if (node.id !== id) return node
      const currentParams = isRecord(node.data.params) ? node.data.params : {}
      const params = { ...currentParams, ...patch }
      if (comparable(params) === comparable(currentParams)) return node
      changed = true
      const nested = isRecord(node.data.node) ? node.data.node : {}
      return {
        ...node,
        data: {
          ...node.data,
          params,
          node: { ...nested, params },
        },
      }
    })
    if (!changed) return
    nodesRef.current = next
    setNodes(next)
    nodeEditRevisions.current.set(id, (nodeEditRevisions.current.get(id) ?? 0) + 1)
    scheduleNodeUpdate(id)
  }, [scheduleNodeUpdate])

  const getUpstreamReferences = useCallback((id: string): DesktopAudioReference[] => {
    return edgesRef.current.flatMap((edge) => {
      if (edge.target !== id) return []
      const edgeData = edge.data as { valid?: boolean; edge?: { valid?: boolean } } | undefined
      if (edgeData?.valid === false || edgeData?.edge?.valid === false) return []
      const source = nodesRef.current.find((node) => node.id === edge.source)
      if (!source) return []
      const data = source.data ?? {}
      const nested = isRecord(data.node) ? data.node : {}
      const params = isRecord(data.params) ? data.params : isRecord(nested.params) ? nested.params : {}
      const rawType = typeof source.type === 'string' ? source.type : nested.type
      if (rawType !== 'image' && rawType !== 'video' && rawType !== 'audio' && rawType !== 'text') return []
      const kind = rawType
      const taskId = typeof data.taskId === 'string' ? data.taskId : ''
      const taskStatus = data.taskStatus
      const url = (taskId && taskStatus === 'succeeded' ? `vibe://app/tasks/${taskId}/output`
        : typeof params.lastOutputUrl === 'string' ? params.lastOutputUrl
          : typeof params.url === 'string' ? params.url
            : typeof params.thumbnailUrl === 'string' ? params.thumbnailUrl
              : typeof params.referenceUrl === 'string' ? params.referenceUrl
                : typeof params.assetId === 'string' ? `vibe://app/assets/${params.assetId}`
                  : typeof data.assetId === 'string' ? `vibe://app/assets/${data.assetId}` : undefined)
      const textValue = params.lastOutputText ?? params.prompt ?? params.text ?? params.content ?? data.label
      const text = textValue !== undefined && String(textValue).trim() ? String(textValue) : undefined
      return [{
        id: `up-${edge.id}`,
        sourceNodeId: edge.source,
        kind,
        label: kind === 'text' ? '文本' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片',
        ...(url ? { url } : {}),
        ...(kind === 'text' ? { text: text || '上游文本' } : text ? { text } : {}),
      }]
    })
  }, [])

  const handleEdgesChange = useCallback((changes: EdgeChange[]) => {
    // The legacy endpoint deletes edges separately from canvas saves and does
    // not advance the canvas version. Ignore React Flow's optimistic removals;
    // onEdgesDelete performs the authoritative single-edge commands below.
    const next = applyEdgeChanges(changes.filter((change) => change.type !== 'remove'), edgesRef.current)
    edgesRef.current = next
    setEdges(next)
    if (changes.some((change) => change.type === 'add')) {
      schedulePersist(nodesRef.current, next)
    }
  }, [schedulePersist])

  const handleEdgesDelete = useCallback((deleted: Edge[]) => {
    const edgeIds = Array.from(new Set(deleted.map((edge) => edge.id)))
      .filter((edgeId) => edgesRef.current.some((edge) => edge.id === edgeId))
    if (edgeIds.length > 0 && timer.current) {
      clearTimeout(timer.current)
      timer.current = null
      // Flush pending graph edits while the soon-to-be-deleted edges are still present.
      persist(nodesRef.current, edgesRef.current)
    }
    for (const edgeId of edgeIds) {
      if (!bridge || pendingEdgeDeletes.current.has(edgeId)) continue
      pendingEdgeDeletes.current.add(edgeId)
      setCanvasActionError('')
      const deletePromise = saveQueue.current.then(async () => {
        await bridge.deleteEdge({ projectId: project.projectId, canvasId: project.canvasId, edgeId })
        edgesRef.current = edgesRef.current.filter((edge) => edge.id !== edgeId)
        setEdges(edgesRef.current)
      })
      saveQueue.current = deletePromise.then(() => undefined, () => undefined)
      void deletePromise.then(() => {
        pendingEdgeDeletes.current.delete(edgeId)
      }, (cause: unknown) => {
        pendingEdgeDeletes.current.delete(edgeId)
        const message = cause instanceof Error ? cause.message : '删除连线失败。'
        setCanvasActionError(`删除连线失败：${message}`)
      })
    }
    if (edgeIds.length > 0 && !bridge) {
      setCanvasActionError('桌面项目接口不可用，无法删除连线。')
    }
  }, [persist, project.canvasId, project.projectId])

  const handleConnect = useCallback(async (connection: Connection) => {
    if (!bridge || !connection.source || !connection.target) {
      setCanvasActionError('无法连接：找不到连线两端的节点。')
      return
    }
    const source = nodesRef.current.find((node) => node.id === connection.source)
    const target = nodesRef.current.find((node) => node.id === connection.target)
    if (!source || !target) {
      setCanvasActionError('无法连接：找不到连线两端的节点。')
      return
    }

    setCanvasActionError('')
    try {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        persist(nodesRef.current, edgesRef.current)
      }
      await flushPendingNodeUpdates()
      const connectPromise = saveQueue.current.then(async () => {
        if (saveFailure.current) throw new Error(saveFailure.current)
        const sourcePort = connection.sourceHandle ?? 'output'
        const targetPort = connection.targetHandle ?? 'input'
        const result = await bridge.connectEdge({
          projectId: project.projectId,
          canvasId: project.canvasId,
          expectedVersion: version.current,
          idempotencyKey: crypto.randomUUID(),
          sourceNodeId: source.id,
          targetNodeId: target.id,
          sourcePort,
          targetPort,
          dependencyType: 'reference',
        })
        version.current = result.version

        const payload: DesktopEdgePayload = result.edge
        const flowEdge: Edge = {
          id: payload.id,
          source: payload.sourceNodeId,
          sourceHandle: payload.sourcePort,
          target: payload.targetNodeId,
          targetHandle: payload.targetPort,
          label: payload.valid ? undefined : '无效',
          labelStyle: payload.valid ? undefined : { fill: '#888', fontSize: 10, fontWeight: 700 },
          style: { stroke: payload.valid ? '#93c5fd' : '#c0c0c0', strokeWidth: 1.5 },
          data: { valid: payload.valid, edge: payload },
        }
        if (!edgesRef.current.some((edge) => edge.id === flowEdge.id)) {
          const next = addEdge(flowEdge, edgesRef.current)
          if (next !== edgesRef.current) {
            edgesRef.current = next
            setEdges(next)
          }
        }
        saveFailure.current = null
        setSaveError('')
        setSaveState('saved')
      })
      saveQueue.current = connectPromise.then(() => undefined, () => undefined)
      await connectPromise
    } catch (cause) {
      setCanvasActionError(cause instanceof Error ? cause.message : '建立连线失败。')
    }
  }, [flushPendingNodeUpdates, persist, project.canvasId, project.projectId])

  useEffect(() => {
    const createAdjacentNode = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: string; x?: number; y?: number; direction?: 'upstream' | 'downstream' }>).detail
      if (!detail?.nodeId) return
      setCanvasMenu({
        x: detail.x ?? window.innerWidth / 2,
        y: detail.y ?? window.innerHeight / 2,
        kind: 'pane',
        sourceNodeId: detail.nodeId,
        direction: detail.direction,
      })
    }
    window.addEventListener('vp-create-downstream-node', createAdjacentNode)
    return () => window.removeEventListener('vp-create-downstream-node', createAdjacentNode)
  }, [schedulePersist])

  const insertPromptNode = async (
    label: string,
    type: DesktopCreateNodeInput['type'] = 'text',
    position?: { x: number; y: number },
    connection?: { nodeId: string; direction: 'upstream' | 'downstream' },
    options: Pick<DesktopCreateNodeInput, 'params' | 'width' | 'height' | 'modelRef' | 'creativeType'> = {},
  ) => {
    if (label.length > 20_000) {
      setCanvasActionError('生成结果超过单个文本节点的长度上限。')
      return
    }
    if (!bridge) {
      setCanvasActionError('桌面项目接口不可用，无法创建节点。')
      return
    }
    const nodePosition = position ?? { x: 160 + nodesRef.current.length * 24, y: 120 + nodesRef.current.length * 24 }
    const sourceNode = connection ? nodesRef.current.find((node) => node.id === connection.nodeId) : undefined
    if (connection && (!sourceNode || !isEdgeTypeCompatible(
      connection.direction === 'upstream' ? type : sourceNode.type,
      connection.direction === 'upstream' ? sourceNode.type : type,
    ))) {
      setCanvasActionError(sourceNode
        ? `无法连接：${connection.direction === 'upstream' ? type : sourceNode.type} 节点不能作为 ${connection.direction === 'upstream' ? sourceNode.type : type} 节点的输入。`
        : '无法连接：找不到连线节点。')
      return
    }
    setCanvasActionError('')
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
      persist(nodesRef.current, edgesRef.current)
    }
    try {
      await flushPendingNodeUpdates()
    } catch (cause) {
      setCanvasActionError(cause instanceof Error ? cause.message : '保存节点修改失败。')
      return
    }

    createNodeCommandsPending.current += 1
    let createdNodeId: string | undefined
    const createPromise = saveQueue.current.then(async () => {
      let commandError: unknown = null
      try {
        if (saveFailure.current) throw new Error(saveFailure.current)
        setSaveState('saving')
        setSaveError('')
        const result = await bridge.createNode({
          projectId: project.projectId,
          canvasId: project.canvasId,
          expectedVersion: version.current,
          idempotencyKey: crypto.randomUUID(),
          type,
          x: nodePosition.x,
          y: nodePosition.y,
          ...options,
          params: { ...options.params, prompt: label },
          prompt: label,
        })
        version.current = result.version
        createdNodeId = result.node.id
        if (!nodesRef.current.some((node) => node.id === result.node.id)) {
          const nextNodes = [...nodesRef.current, result.node]
          nodesRef.current = nextNodes
          setNodes(nextNodes)
        }
        saveFailure.current = null
        setSaveState('saved')
        setSaveError('')
      } catch (cause) {
        commandError = cause
      } finally {
        createNodeCommandsPending.current = Math.max(0, createNodeCommandsPending.current - 1)
        if (createNodeCommandsPending.current === 0 && persistDeferredDuringNodeCreation.current) {
          persistDeferredDuringNodeCreation.current = false
          if (timer.current) {
            clearTimeout(timer.current)
            timer.current = null
          }
          try {
            const saved = await bridge.saveCanvas({
              projectId: project.projectId,
              canvasId: project.canvasId,
              expectedVersion: version.current,
              nodes: nodesRef.current,
              edges: edgesRef.current,
            })
            version.current = saved.version
            saveFailure.current = null
            setSaveState('saved')
            setSaveError('')
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : '保存画布失败。'
            saveFailure.current = message
            setSaveState('error')
            setSaveError(message)
            if (!commandError) commandError = cause
          }
        }
      }
      if (commandError) throw commandError
    })
    saveQueue.current = createPromise.then(() => undefined, () => undefined)
    try {
      await createPromise
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '创建画布节点失败。'
      setSaveState('error')
      setSaveError(message)
      setCanvasActionError(message)
      return
    }

    if (connection && createdNodeId) {
      await handleConnect({
        source: connection.direction === 'upstream' ? createdNodeId : connection.nodeId,
        target: connection.direction === 'upstream' ? connection.nodeId : createdNodeId,
        sourceHandle: 'output',
        targetHandle: 'input',
      })
    }
    setCanvasMenu(null)
    return createdNodeId
  }

  const addTextNode = () => insertPromptNode('')
  const addImagePromptNode = () => insertPromptNode('', 'image')
  const addVideoPromptNode = () => insertPromptNode('', 'video')
  const addAudioNode = () => insertPromptNode('', 'audio')
  const addComposeNode = () => insertPromptNode('', 'compose')
  const addDirectorNode = () => insertPromptNode('', 'director')

  const duplicateNode = (id: string) => {
    const source = nodesRef.current.find((node) => node.id === id)
    if (!source) return
    if (!source.type || !Object.hasOwn(EDGE_COMPATIBLE_TARGET_TYPES, source.type)) {
      setCanvasActionError('此节点类型暂不支持创建副本。')
      return
    }
    const sourceParams = source.data.params
    const params = sourceParams && typeof sourceParams === 'object' && !Array.isArray(sourceParams)
      ? { ...(sourceParams as Record<string, unknown>) }
      : {}
    if (typeof source.data.assetId === 'string') params.assetId = source.data.assetId
    if (typeof source.data.name === 'string') params.name = source.data.name
    const prompt = typeof source.data.label === 'string'
      ? source.data.label
      : typeof source.data.prompt === 'string' ? source.data.prompt : ''
    void insertPromptNode(prompt, source.type as DesktopCreateNodeInput['type'], {
      x: source.position.x + 32,
      y: source.position.y + 32,
    }, undefined, {
      params,
      width: source.width,
      height: source.height,
      modelRef: typeof source.data.modelRef === 'string' ? source.data.modelRef : null,
      creativeType: typeof source.data.creativeType === 'string' ? source.data.creativeType : null,
    })
    setCanvasMenu(null)
  }

  const requestDeleteNode = (id: string) => {
    const downstream = edgesRef.current
      .filter((edge) => edge.source === id)
      .map((edge) => {
        const target = nodesRef.current.find((node) => node.id === edge.target)
        const nestedType = target && isRecord(target.data.node) ? target.data.node.type : undefined
        return target ? { id: target.id, type: String(target.type ?? nestedType ?? '节点') } : null
      })
      .filter((node): node is { id: string; type: string } => node !== null && node.id !== id)
    const unique = Array.from(new Map(downstream.map((node) => [node.id, node])).values())
    setDeleteConfirm({ nodeId: id, downstream: unique })
    setCanvasMenu(null)
  }

  const deleteNode = async (id: string) => {
    if (!bridge || deletePending) return
    setDeletePending(true)
    setCanvasActionError('')
    try {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        persist(nodesRef.current, edgesRef.current)
      }
      await flushPendingNodeUpdates()
      await saveQueue.current
      if (saveFailure.current) throw new Error(saveFailure.current)

      const deletePromise = saveQueue.current.then(async () => {
        setSaveState('saving')
        setSaveError('')
        const result: DesktopDeleteNodeResult = await bridge.deleteNode({
          projectId: project.projectId,
          canvasId: project.canvasId,
          expectedVersion: version.current,
          idempotencyKey: crypto.randomUUID(),
          nodeId: id,
        })
        version.current = result.version
        const nextNodes = result.canvas.nodes
        const nextEdges = result.canvas.edges
        nodesRef.current = nextNodes
        edgesRef.current = nextEdges
        setNodes(nextNodes)
        setEdges(nextEdges)
        setTaskOutputs((current) => Object.fromEntries(Object.entries(current).filter(([nodeId]) => nodeId !== id)))
        saveFailure.current = null
        setSaveState('saved')
        setSaveError('')
        setDeleteConfirm(null)
      })
      saveQueue.current = deletePromise.then(() => undefined, () => undefined)
      await deletePromise
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '删除画布节点失败。'
      saveFailure.current = message
      setSaveState('error')
      setSaveError(message)
      setCanvasActionError(message)
    } finally {
      setDeletePending(false)
    }
  }

  const autoLayout = () => {
    const sorted = [...nodesRef.current].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    const next = sorted.map((node, index) => ({
      ...node,
      position: { x: 120 + (index % 4) * 330, y: 120 + Math.floor(index / 4) * 280 },
    }))
    nodesRef.current = next
    setNodes(next)
    schedulePersist(next, edgesRef.current, true)
  }

  const createAgentSession = async () => {
    if (!bridge || agentSessionCreating) return
    setAgentSessionCreating(true)
    setAgentSessionError('')
    try {
      const created = await bridge.createAgentSession(project.projectId, '新对话')
      await refreshAgentSessions(created.sessionId)
    } catch (cause) {
      setAgentSessionError(cause instanceof Error ? cause.message : '无法创建本地 Agent 会话。')
    } finally {
      setAgentSessionCreating(false)
    }
  }

  const sendAgentMessage = async () => {
    const content = agentDraft.trim()
    let sessionId = activeAgentSessionId
    if (!bridge || !content || agentReplyPendingRef.current) return
    let canvasBaseline: { nodes: Node[]; edges: Edge[] } | null = null
    let eventDrivenRun = false
    let operationError = ''
    let canvasRefreshError = ''
    agentReplyPendingRef.current = true
    setAgentReplyPending(true)
    setAgentSessionError('')
    try {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        schedulePersist(nodesRef.current, edgesRef.current, true)
      }
      await flushPendingNodeUpdates()
      await saveQueue.current
      if (saveFailure.current) throw new Error(`画布还有未保存的修改，尚未发送给 Agent：${saveFailure.current}`)
      canvasBaseline = { nodes: nodesRef.current, edges: edgesRef.current }
      if (!sessionId) {
        const created = await bridge.createAgentSession(project.projectId, '新对话')
        sessionId = created.sessionId
        setActiveAgentSessionId(sessionId)
      }
      if (bridge.startAgentRun) {
        await bridge.startAgentRun({
          projectId: project.projectId,
          canvasId: project.canvasId,
          canvasVersion: version.current,
          sessionId,
          content,
          selectedNodeIds: nodesRef.current.filter((node) => node.selected).map((node) => node.id),
          idempotencyKey: crypto.randomUUID(),
        })
        eventDrivenRun = true
        await loadAgentSession(sessionId)
      } else {
        await bridge.sendAgentMessage(project.projectId, sessionId, content)
      }
      setAgentDraft('')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Agent 回复失败。'
      operationError = agentSendErrorLabel(message)
    } finally {
      if (canvasBaseline && !eventDrivenRun) {
        try {
          await refreshCanvasAfterAgent(canvasBaseline.nodes, canvasBaseline.edges)
        } catch (cause) {
          canvasRefreshError = cause instanceof Error ? `画布刷新失败：${cause.message}` : '画布刷新失败。'
        }
      }
      if (sessionId && !eventDrivenRun) await refreshAgentSessions(sessionId)
      if (operationError || canvasRefreshError) {
        setAgentSessionError([operationError, canvasRefreshError].filter(Boolean).join(' '))
      }
      if (!eventDrivenRun) {
        agentReplyPendingRef.current = false
        setAgentReplyPending(false)
      }
    }
  }

  const generateTask = async (nodeId: string, prompt: string, providerType: 'local' | 'cloud', modality: 'text' | 'image' | 'video', parameters?: Record<string, unknown>) => {
    if ((providerType === 'local' && !localTextModel) || (providerType === 'cloud' && !agnesModels?.apiKeyConfigured)) {
      setModelSettingsOpen(true)
      return
    }
    if (!bridge || submittingNode || !prompt.trim()) return
    setSubmittingNode(nodeId)
    setCanvasActionError('')
    setGenerationErrors((current) => {
      const next = { ...current }
      delete next[nodeId]
      return next
    })
    try {
      if (modality === 'text') {
        const next = nodesRef.current.map((node) => node.id === nodeId
          ? { ...node, data: { ...node.data, output: undefined, outputOverride: false } }
          : node)
        nodesRef.current = next
        setNodes(next)
        schedulePersist(next, edgesRef.current, true)
      }
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        schedulePersist(nodesRef.current, edgesRef.current, true)
      }
      await flushPendingNodeUpdates()
      await saveQueue.current
      if (saveFailure.current) throw new Error(saveFailure.current)
      const task = await bridge.createGenerationTask({
        projectId: project.projectId,
        canvasId: project.canvasId,
        canvasVersion: version.current,
        nodeId,
        prompt,
        idempotencyKey: crypto.randomUUID(),
        providerType,
        modality,
        parameters: {
          ...(modality === 'image' ? { size: '2K', ratio: '1:1' } : modality === 'video' ? { seconds: 5, aspectRatio: '16:9' } : {}),
          ...parameters,
        },
      })
      if (task) updateNodeData(nodeId, { taskId: task.taskId, taskStatus: task.status, taskError: task.errorCode })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '无法提交生成任务。'
      setGenerationErrors((current) => ({ ...current, [nodeId]: message }))
    } finally {
      setSubmittingNode(null)
    }
  }

  const addImageNode = (asset: DesktopAsset) => {
    void insertPromptNode('', 'image', {
      x: 160 + nodesRef.current.length * 24,
      y: 120 + nodesRef.current.length * 24,
    }, undefined, {
      params: { assetId: asset.assetId, name: asset.name },
    })
  }

  const importImage = async () => {
    if (assetPending) return
    setAssetPending(true)
    setAssetError('')
    try {
      const imported = await bridge?.importImage(project.projectId)
      if (imported) setAssets((current) => [imported, ...current.filter((asset) => asset.assetId !== imported.assetId)])
    } catch (cause) {
      setAssetError(cause instanceof Error ? cause.message : '导入本地图片失败。')
    } finally {
      setAssetPending(false)
    }
  }

  const openOtherProject = async () => {
    try {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        persist(nodesRef.current, edgesRef.current)
      }
      await flushPendingNodeUpdates()
      await saveQueue.current
      if (saveFailure.current) return
      await onOpenProject()
    } catch (cause) {
      setCanvasActionError(cause instanceof Error ? cause.message : '保存画布修改失败。')
    }
  }

  const confirmAgentAction = async (confirmation: AgentConfirmation, accept: boolean) => {
    const sessionId = activeAgentSessionId
    if (!bridge || !sessionId) return
    if (!bridge.confirmAgentAction) {
      setAgentSessionError('本地 Agent 确认接口尚未接入。')
      return
    }
    setAgentSessionError('')
    try {
      await bridge.confirmAgentAction({
        projectId: project.projectId,
        canvasId: project.canvasId,
        sessionId,
        actionId: confirmation.actionId,
        approvalToken: confirmation.approvalToken,
        accept,
        canvasVersion: confirmation.canvasVersion ?? version.current,
      })
      // Refresh only from the authoritative local session store. The renderer
      // does not mark an action accepted or invent a submitted task itself.
      await refreshAgentSessions(sessionId)
    } catch (cause) {
      setAgentSessionError(cause instanceof Error ? cause.message : '确认 Agent 操作失败。')
    }
  }

  const createBackup = async () => {
    if (backupPending) return
    setBackupPending(true)
    setBackupMessage('')
    try {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        persist(nodesRef.current, edgesRef.current)
      }
      await flushPendingNodeUpdates()
      await saveQueue.current
      if (saveFailure.current) {
        setBackupMessage(saveFailure.current)
        return
      }
      const backup = await bridge?.backupProject(project.projectId)
      if (backup) setBackupMessage(`备份完成：${backup.name}`)
    } catch (cause) {
      setBackupMessage(cause instanceof Error ? cause.message : '创建项目备份失败。')
    } finally {
      setBackupPending(false)
    }
  }

  const restoreBackup = async () => {
    if (restorePending || backupPending || assetPending) return
    setRestorePending(true)
    setBackupMessage('')
    try {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
        persist(nodesRef.current, edgesRef.current)
      }
      await flushPendingNodeUpdates()
      await saveQueue.current
      if (saveFailure.current) {
        setBackupMessage(saveFailure.current)
        return
      }
      const restored = await bridge?.restoreBackup()
      if (restored) await onProjectRestored(restored)
    } catch (cause) {
      setBackupMessage(cause instanceof Error ? cause.message : '恢复项目备份失败。')
    } finally {
      setRestorePending(false)
    }
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    for (const pendingTimer of nodeUpdateTimers.current.values()) clearTimeout(pendingTimer)
    nodeUpdateTimers.current.clear()
  }, [])

  return (
    <main className="flex h-screen w-screen overflow-hidden bg-[#f2f2f2] text-[#171717]">
      <section className="relative min-h-0 min-w-0 flex-1" onDoubleClick={(event) => {
        const target = event.target as HTMLElement | null
        if (!target?.closest('.react-flow__pane') || target.closest('.react-flow__node, button, input, textarea')) return
        event.preventDefault()
        setCanvasMenu({ x: event.clientX, y: event.clientY, kind: 'pane' })
      }}>
        <DesktopCanvasChrome
          project={project}
          saveLabel={saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已保存'}
          saveError={saveError}
          backupMessage={backupMessage}
          assetsOpen={assetsOpen}
          agentOpen={agentOpen}
          mode={mode}
          onModeChange={setMode}
          onAssetsChange={setAssetsOpen}
          onAgentChange={setAgentOpen}
          onAddText={addTextNode}
          onAddImage={addImagePromptNode}
          onAddVideo={addVideoPromptNode}
          onAddAudio={addAudioNode}
          onAddCompose={addComposeNode}
          onAddDirector={addDirectorNode}
          onAutoLayout={autoLayout}
          onImportImage={() => void importImage()}
          onOpenModels={() => setModelSettingsOpen(true)}
          onBackup={() => void createBackup()}
          onRestore={() => void restoreBackup()}
          onSwitchProject={() => void openOtherProject()}
        />
        {!agentOpen && <AgentLauncher onOpen={() => setAgentOpen(true)} />}
        {error && <p role="alert" className="absolute left-1/2 top-20 z-40 -translate-x-1/2 rounded-lg bg-red-50 px-5 py-2 text-xs text-red-700 shadow">{error}</p>}
        {canvasActionError && <p role="alert" className="absolute left-1/2 top-32 z-40 -translate-x-1/2 rounded-lg bg-red-50 px-5 py-2 text-xs text-red-700 shadow">{canvasActionError}</p>}
        {agentSessionError && <p role="alert" className="absolute left-1/2 top-20 z-40 -translate-x-1/2 rounded-lg bg-red-50 px-5 py-2 text-xs text-red-700 shadow">{agentSessionError}</p>}
        {nodes.length === 0 && <CanvasWelcome availableTypes={DESKTOP_NODE_MENU.map(({ type }) => type)} onCreate={(type) => {
          if (Object.hasOwn(EDGE_COMPATIBLE_TARGET_TYPES, type)) void insertPromptNode('', type as DesktopCreateNodeInput['type'])
        }} />}
        <TextNodeContext.Provider value={{
          updateText,
          updateNodeData,
          updateNodeParams,
          getUpstreamReferences,
          generate: (nodeId, prompt, providerType, modality, parameters) => { void generateTask(nodeId, prompt, providerType, modality, parameters) },
          openModelSettings: () => setModelSettingsOpen(true),
          pendingNodeId: submittingNode,
          generationErrors,
          taskOutputs,
          localModelAvailable: localTextModel !== null,
          agnesAvailable: agnesModels?.apiKeyConfigured === true,
        }}>
          <ReactFlow
            nodes={nodes}
            edges={edges.map((edge) => {
              const edgeData = edge.data as { valid?: boolean; edge?: { valid?: boolean } } | undefined
              const invalid = edgeData?.valid === false || edgeData?.edge?.valid === false
              return {
                ...edge,
                label: invalid ? '无效' : edge.label,
                labelStyle: invalid ? { fill: '#888', fontSize: 10, fontWeight: 700 } : edge.labelStyle,
                style: {
                  stroke: edge.selected ? '#111111' : invalid ? '#c0c0c0' : ((edge.style?.stroke as string | undefined) ?? '#93c5fd'),
                  strokeWidth: edge.selected ? 2.5 : 1.5,
                },
              }
            })}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onEdgesDelete={handleEdgesDelete}
            onBeforeDelete={async ({ nodes: deletingNodes }) => deletingNodes.length === 0}
            onConnect={handleConnect}
            onNodeDragStop={() => schedulePersist(nodesRef.current, edgesRef.current, true)}
            onPaneClick={() => setCanvasMenu(null)}
            onPaneContextMenu={(event) => { event.preventDefault(); setCanvasMenu({ x: event.clientX, y: event.clientY, kind: 'pane' }) }}
            onNodeContextMenu={(event, node) => { event.preventDefault(); setCanvasMenu({ x: event.clientX, y: event.clientY, kind: 'node', nodeId: node.id }) }}
            fitView
            minZoom={0.1}
            maxZoom={2.5}
            panOnDrag={mode === 'pan'}
            selectionOnDrag={mode === 'select'}
            panOnScroll
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'default' }}
            connectionRadius={28}
            className="vp-dot-grid"
          >
            <Background color="#c8c8c8" gap={20} size={1} />
            <MiniMap pannable zoomable className="!bg-white" nodeStrokeColor="#111" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </TextNodeContext.Provider>
        {canvasMenu && <div className="fixed z-50 min-w-44 overflow-hidden rounded-xl border border-black/10 bg-white py-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.18)]" style={{ left: Math.min(canvasMenu.x, window.innerWidth - 190), top: Math.min(canvasMenu.y, window.innerHeight - 180) }}>
          {canvasMenu.kind === 'pane' ? <>
            <p className="px-3 py-1 text-[11px] font-bold text-[#999]">添加节点</p>
            {DESKTOP_NODE_MENU.map(({ type, label, icon: Icon }) => <button key={type} type="button" onClick={() => {
              const position = screenToFlowPosition({ x: canvasMenu.x, y: canvasMenu.y })
              const connection = canvasMenu.sourceNodeId && canvasMenu.direction
                ? { nodeId: canvasMenu.sourceNodeId, direction: canvasMenu.direction }
                : undefined
              insertPromptNode('', type, position, connection)
              setCanvasMenu(null)
            }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[#333] hover:bg-black/[0.05]"><Icon size={15} />{label}</button>)}
          </> : <>
            <button type="button" onClick={() => duplicateNode(canvasMenu.nodeId!)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[#333] hover:bg-black/[0.05]"><Files size={15} />副本</button>
            <button type="button" onClick={() => { if (canvasMenu.nodeId) requestDeleteNode(canvasMenu.nodeId) }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-semibold text-[#333] hover:bg-black/[0.05]"><Trash2 size={15} />删除</button>
          </>}
        </div>}
        {deleteConfirm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"><div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"><p className="text-[16px] font-bold text-[#111]">确认删除节点？</p><p className="mt-2 text-[13px] text-[#666]">将删除该节点及其关联连线。</p>{deleteConfirm.downstream.length > 0 && <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800"><p className="font-bold">影响下游节点：</p><ul className="mt-1 list-disc pl-4">{deleteConfirm.downstream.slice(0, 8).map((node) => <li key={node.id}>{node.type} · {node.id.slice(-6)}</li>)}</ul>{deleteConfirm.downstream.length > 8 && <p className="mt-1">…等共 {deleteConfirm.downstream.length} 个</p>}</div>}<div className="mt-5 flex justify-end gap-2"><button type="button" disabled={deletePending} onClick={() => setDeleteConfirm(null)} className="rounded-lg px-4 py-2 text-[13px] font-semibold text-[#666] hover:bg-black/5 disabled:opacity-50">取消</button><button type="button" disabled={deletePending} onClick={() => void deleteNode(deleteConfirm.nodeId)} className="rounded-lg bg-[#111] px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50">{deletePending ? '正在删除…' : '确认删除'}</button></div></div></div>}
        {assetsOpen && <div className="absolute left-[72px] top-20 z-40 flex h-[calc(100%-104px)] w-80 flex-col rounded-2xl border border-black/8 bg-white shadow-[0_16px_48px_rgba(15,23,42,0.18)]">
          <div className="flex items-center justify-between border-b border-black/6 px-3 py-2.5"><p className="text-[14px] font-bold text-[#111]">本地素材库</p><div className="flex items-center gap-1"><button type="button" title="网格视图" onClick={() => setAssetMode('grid')} className={`rounded-lg p-1.5 ${assetMode === 'grid' ? 'bg-black/8 text-[#111]' : 'text-[#999]'}`}><Grid2X2 size={14} /></button><button type="button" title="列表视图" onClick={() => setAssetMode('list')} className={`rounded-lg p-1.5 ${assetMode === 'list' ? 'bg-black/8 text-[#111]' : 'text-[#999]'}`}><List size={14} /></button><button type="button" title="关闭素材库" onClick={() => setAssetsOpen(false)} className="ml-1 rounded-lg p-1.5 text-[#888] hover:bg-black/5"><X size={14} /></button></div></div>
          <div className="flex items-center justify-between px-3 py-2"><button type="button" onClick={() => void importImage()} disabled={assetPending} className="flex items-center gap-1.5 rounded-lg bg-[#111] px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"><Upload size={13} />{assetPending ? '正在导入…' : '上传'}</button><span className="text-[11px] text-[#999]">{assets.length} 个素材</span></div>
          <div className="min-h-0 flex-1 overflow-auto p-3">{assets.length === 0 ? <p className="py-10 text-center text-[13px] text-[#999]">暂无素材，上传后加入画布</p> : assetMode === 'grid' ? <div className="grid grid-cols-2 gap-2">{assets.map((asset) => <button key={asset.assetId} type="button" onClick={() => addImageNode(asset)} title={`${asset.name} · ${asset.referenceCount} 个引用`} className="overflow-hidden rounded-xl border border-black/8 text-left"><img src={`vibe://app/assets/${asset.assetId}`} alt="" className="aspect-square w-full object-cover" /><p className="truncate bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold text-white">{asset.name}</p></button>)}</div> : <div className="flex flex-col gap-1">{assets.map((asset) => <button key={asset.assetId} type="button" onClick={() => addImageNode(asset)} title={`${asset.name} · ${asset.referenceCount} 个引用`} className="flex items-center gap-2 rounded-lg border border-black/6 px-2 py-1.5 text-left"><img src={`vibe://app/assets/${asset.assetId}`} alt="" className="h-10 w-10 rounded object-cover" /><span className="truncate text-[12px] font-semibold text-[#444]">{asset.name}</span></button>)}</div>}</div>
          {assetError && <p role="alert" className="border-t border-red-100 px-3 py-2 text-xs text-red-600">{assetError}</p>}
        </div>}
      </section>
      {agentOpen && <AgentPanel desktopAdapter={{
        sessions: agentSessions,
        activeSessionId: activeAgentSessionId,
        messages: agentMessages,
        draft: agentDraft,
        sending: agentReplyPending,
        creating: agentSessionCreating,
        configured: agnesModels?.apiKeyConfigured === true,
        modelLabel: 'Agnes 2.5 Flash',
        error: agentSessionError,
        onDraftChange: setAgentDraft,
        onNewSession: createAgentSession,
        onSelectSession: loadAgentSession,
        onSend: sendAgentMessage,
        onConfirm: confirmAgentAction,
        onConfigure: () => setModelSettingsOpen(true),
        onClose: () => setAgentOpen(false),
      } satisfies AgentPanelDesktopAdapter} />}
      {modelSettingsOpen && (
        <DesktopModelSettings
          initialConfig={localTextModel}
          agnesConfigured={agnesModels?.apiKeyConfigured === true}
          loadError={modelLoadError}
          onSavedLocal={(config) => {
            setLocalTextModel(config)
            setModelLoadError('')
          }}
          onClearedLocal={() => {
            setLocalTextModel(null)
          }}
          onSavedAgnes={(catalog) => setAgnesModels(catalog)}
          onClearedAgnes={(catalog) => setAgnesModels(catalog)}
          onClose={() => setModelSettingsOpen(false)}
        />
      )}
    </main>
  )
}

function agentSendErrorLabel(message: string) {
  if (message.includes('CLOUD_CREDENTIAL_MISSING')) return '先在“模型与 API Key”中安全保存 Agnes API Key。'
  if (message.includes('AGENT_MODEL_TIMEOUT')) return 'Agnes 响应超时。用户消息已保存在本地会话中。'
  if (message.includes('AGENT_RUN_ALREADY_PROCESSED')) return '这条消息已处理过，请检查会话记录后再继续。'
  if (message.includes('AGENT_MESSAGE_INVALID')) return '消息不能为空，且不能超过 20,000 个字符。'
  return '发送失败。请检查 Agnes Key 和网络连接；用户消息已保存在本地会话中。'
}

function DesktopModelSettings({
  initialConfig,
  agnesConfigured,
  loadError,
  onSavedLocal,
  onClearedLocal,
  onSavedAgnes,
  onClearedAgnes,
  onClose,
}: {
  initialConfig: DesktopLocalTextModel | null
  agnesConfigured: boolean
  loadError: string
  onSavedLocal: (config: DesktopLocalTextModel) => void
  onClearedLocal: () => void
  onSavedAgnes: (catalog: DesktopAgnesModelCatalog) => void
  onClearedAgnes: (catalog: DesktopAgnesModelCatalog) => void
  onClose: () => void
}) {
  const [endpoint, setEndpoint] = useState(initialConfig?.endpoint ?? 'http://127.0.0.1:1234/v1')
  const [modelId, setModelId] = useState(initialConfig?.modelId ?? '')
  const [models, setModels] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState(loadError)
  const [message, setMessage] = useState('')

  const discover = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const discovered = await bridge.discoverLocalModels(endpoint)
      setModels(discovered)
      if (discovered.length === 0) setMessage('服务可连接，但没有公布可选模型。')
      else {
        if (!discovered.includes(modelId)) setModelId(discovered[0])
        setMessage(`找到 ${discovered.length} 个文本模型。`)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本地模型列表。')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      onSavedLocal(await bridge.saveLocalTextModel({ endpoint, modelId }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存本地模型配置失败。')
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setError('')
    try {
      await bridge.clearLocalTextModel()
      onClearedLocal()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移除本地模型配置失败。')
    } finally {
      setBusy(false)
    }
  }

  const saveAgnesKey = async () => {
    if (!bridge || busy || !apiKey.trim()) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      onSavedAgnes(await bridge.saveAgnesApiKey(apiKey))
      setApiKey('')
      setMessage('Agnes API Key 已安全保存。选择 Agnes 生成或发送 Agent 消息后，请求会直接发给 Agnes。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存 Agnes API Key 失败。')
    } finally {
      setBusy(false)
    }
  }

  const clearAgnesKey = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      onClearedAgnes(await bridge.clearAgnesApiKey())
      setApiKey('')
      setMessage('Agnes API Key 已从此设备移除。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '移除 Agnes API Key 失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-5" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="local-model-settings-title">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="local-model-settings-title" className="text-lg font-bold">模型与 API Key</h2>
            <p className="mt-1 text-xs leading-5 text-[#777]">本地模型请求不联网。选择云端模型并发起生成或 Agent 对话时直接调用对应供应商。</p>
          </div>
          <button onClick={onClose} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold">关闭</button>
        </div>
        <section className="mt-5 rounded-xl border border-black/8 bg-[#fbfaff] p-4">
          <h3 className="text-sm font-bold">Agnes 云端模型</h3>
          <p className="mt-1 text-xs leading-5 text-[#666]">API 地址：<span className="font-mono">https://apihub.agnes-ai.com/v1</span></p>
          <ul className="mt-2 space-y-1 text-xs text-[#666]">
            <li>文本：agnes-2.5-flash</li>
            <li>图像：agnes-image-2.5-flash</li>
            <li>视频：agnes-video-2.5-flash</li>
          </ul>
          <p className="mt-2 text-xs leading-5 text-amber-800">选择 Agnes 并提交生成任务，将发送当前提示词及生成参数；向 Agent 发送消息，将发送消息、当前会话历史和当前画布只读摘要。请求由 Agnes 处理，可能产生供应商费用；不会额外弹出逐次发送确认，也不会上传本地媒体文件或项目路径。</p>
          <label htmlFor="agnes-api-key" className="mt-4 block text-xs font-semibold">Agnes API Key</label>
          <input
            id="agnes-api-key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            maxLength={1024}
            placeholder={agnesConfigured ? '已配置；输入新 Key 可替换' : '粘贴 API Key'}
            className="mt-2 h-10 w-full rounded-lg border border-black/12 bg-white px-3 text-sm outline-none focus:border-[#8a72e8]"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-[#777]">{agnesConfigured ? '此设备已配置 Key' : '尚未配置 Key'}</span>
            <div className="flex gap-2">
              {agnesConfigured && <button onClick={() => void clearAgnesKey()} disabled={busy} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-50">移除 Key</button>}
              <button onClick={() => void saveAgnesKey()} disabled={busy || !apiKey.trim()} className="rounded-lg bg-[#6d55c9] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busy ? '请稍候…' : '安全保存 Key'}</button>
            </div>
          </div>
        </section>
        <div className="my-5 border-t border-black/8" />
        <h3 className="text-sm font-bold">本地文本模型</h3>
        <label htmlFor="local-model-endpoint" className="mt-4 block text-sm font-semibold">OpenAI 兼容服务地址</label>
        <input
          id="local-model-endpoint"
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          maxLength={500}
          placeholder="http://127.0.0.1:1234/v1"
          className="mt-2 h-11 w-full rounded-xl border border-black/12 px-3 text-sm outline-none focus:border-[#8a72e8]"
        />
        <p className="mt-2 text-xs leading-5 text-[#888]">地址必须使用 localhost、127.0.0.1 或 ::1。点击“读取模型”时会向该服务的 /models 路径发起本地请求。</p>
        <button onClick={() => void discover()} disabled={busy || !endpoint.trim()} className="mt-4 rounded-lg border border-black/12 px-3 py-2 text-xs font-bold disabled:opacity-50">
          {busy ? '请稍候…' : '读取模型'}
        </button>
        <label htmlFor="local-model-id" className="mt-4 block text-sm font-semibold">模型</label>
        {models.length > 0
          ? <select id="local-model-id" value={modelId} onChange={(event) => setModelId(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-black/12 bg-white px-3 text-sm outline-none focus:border-[#8a72e8]">
            {models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          : <input
            id="local-model-id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            maxLength={200}
            placeholder="先读取模型，或输入服务提供的模型 ID"
            className="mt-2 h-11 w-full rounded-xl border border-black/12 px-3 text-sm outline-none focus:border-[#8a72e8]"
          />}
        {message && <p role="status" className="mt-3 text-xs text-[#666]">{message}</p>}
        {(error || loadError) && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error || loadError}</p>}
        <div className="mt-6 flex justify-end gap-2">
          {initialConfig && <button onClick={() => void clear()} disabled={busy} className="mr-auto rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-50">移除本地配置</button>}
          <button onClick={onClose} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold">取消</button>
          <button onClick={() => void save()} disabled={busy || !modelId.trim()} className="rounded-lg bg-[#171717] px-4 py-2 text-xs font-bold text-white disabled:opacity-50">保存配置</button>
        </div>
      </section>
    </div>
  )
}
