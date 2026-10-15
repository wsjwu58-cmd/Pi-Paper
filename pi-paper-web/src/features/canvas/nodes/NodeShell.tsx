import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { LucideIcon } from 'lucide-react'
import {
  Download,
  Library,
  Check,
  ImageIcon,
  Type,
  Video,
  AudioLines,
  Clapperboard,
  Layers,
  Maximize2,
  X,
} from 'lucide-react'
import type { GenerationTask, ModelInfo, NodePayload } from '@/lib/types'
import { ModelBrandIcon } from '@/components/ui/ModelBrandIcon'
import { sid } from '@/lib/ids'
import { useAuthedMediaUrl } from '@/lib/media'
import { useCanvasStore } from '../canvasStore'
import { NodeEditorDialog, NodeFloatingToolbar } from './NodeEditorPanel'
import { SoftCollapse, useAnimatedNodeGeometry, useNodeArrival } from '../canvasMotion'

const typeMeta: Record<string, { label: string; icon: LucideIcon; color: string }> = {
  text: { label: '文本', icon: Type, color: '#6366f1' },
  image: { label: '图片', icon: ImageIcon, color: '#0ea5e9' },
  video: { label: '视频', icon: Video, color: '#f43f5e' },
  audio: { label: '音频', icon: AudioLines, color: '#10b981' },
  compose: { label: '合成', icon: Clapperboard, color: '#f59e0b' },
  director: { label: '导演台', icon: Layers, color: '#8b5cf6' },
}

export const NODE_COLORS = typeMeta

export function statusBadge(status: string): { text: string; cls: string } {
  switch (status) {
    case 'queued':
      return { text: '排队中', cls: 'bg-amber-100 text-amber-700' }
    case 'running':
      return { text: '执行中', cls: 'bg-blue-100 text-blue-700' }
    case 'succeeded':
      return { text: '成功', cls: 'bg-emerald-100 text-emerald-700' }
    case 'failed':
      return { text: '失败', cls: 'bg-red-100 text-red-700' }
    case 'cancelled':
      return { text: '已取消', cls: 'bg-slate-200 text-slate-600' }
    case 'expired':
      return { text: '已过期', cls: 'bg-slate-200 text-slate-600' }
    default:
      return { text: uiText("就绪"), cls: 'bg-slate-100 text-slate-500' }
  }
}

export function NodeShell({
  node,
  models,
  children,
  selected = false,
  wide = false,
  latest = null,
  mediaUrl,
  onSaveToLibrary,
  showEditor = true,
  extraSelected,
}: {
  node: NodePayload
  models: ModelInfo[]
  children: React.ReactNode
  selected?: boolean
  wide?: boolean
  latest?: GenerationTask | null
  mediaUrl?: string
  onSaveToLibrary?: () => void
  /** 文/图/音/视频节点使用新编辑器；合成/导演台可关 */
  showEditor?: boolean
  extraSelected?: React.ReactNode
}) {
  useUiLanguage()
  const meta = typeMeta[node.type] ?? typeMeta.text
  const shellRef = useRef<HTMLDivElement>(null)
  useAnimatedNodeGeometry(sid(node.id), shellRef)
  const arrivalClass = useNodeArrival(sid(node.id))
  const Icon = meta.icon
  const [fullscreen, setFullscreen] = useState(false)
  const authedMediaUrl = useAuthedMediaUrl(mediaUrl)
  const editingNodeId = useCanvasStore((s) => s.editingNodeId)
  const isEditing = editingNodeId === sid(node.id)
  const typeModels = models.filter((m) => m.modelType === node.type)
  const preferred =
    typeModels.find((m) => /agnes-image|agnes-video|agnes-2\.5/i.test(m.name)) ??
    typeModels.find((m) => /agnes|seedream|seedance|doubao-tts/i.test(m.name)) ??
    typeModels[0]
  const selectedModel =
    typeModels.find((m) => m.name === (node.params.model as string)) || preferred
  const modelLabel =
    selectedModel?.displayName ||
    (node.params.model as string) ||
    preferred?.displayName ||
    preferred?.name ||
    uiText("选择模型")

  // 文本：双击进入编辑；图/音/视频：选中即编辑
  const useNewEditor =
    showEditor &&
    (node.type === 'text'
      ? isEditing
      : selected && ['image', 'video', 'audio'].includes(node.type))

  return (
    <div ref={shellRef} className={`relative ${arrivalClass}`}>
      {useNewEditor && (node.type === 'image' || node.type === 'video') && (
        <NodeFloatingToolbar
          node={node}
          models={models}
          mediaUrl={authedMediaUrl ?? mediaUrl}
          onSaveToLibrary={onSaveToLibrary}
          onFullscreen={() => setFullscreen(true)}
        />
      )}
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold text-[#8e8e93]">
        <Icon size={12} />
        <span>{uiText(meta.label)}</span>
        <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${statusBadge(node.status).cls}`}>
          {statusBadge(node.status).text}
        </span>
      </div>
      <div
        className={`vp-node-shell overflow-hidden rounded-[20px] bg-white shadow-[0_8px_28px_rgba(15,23,42,0.10)] ring-1 ${
          selected || isEditing ? 'ring-[#111]/35' : 'ring-black/5'
        }`}
        style={{ width: wide || useNewEditor ? 400 : 300, outline: node.status === 'running' ? `2px solid ${meta.color}` : undefined }}
      >
        <Handle
          type="target"
          position={Position.Left}
          id="input"
          className="!h-3.5 !w-3.5 !border-2 !border-white !bg-[#c0c0c4]"
          onClick={(e) => {
            e.stopPropagation()
            window.dispatchEvent(
              new CustomEvent('vp-create-downstream-node', {
                detail: { nodeId: sid(node.id), x: e.clientX, y: e.clientY, direction: 'upstream' },
              }),
            )
          }}
        />
        <div className="p-3">
          {!useNewEditor && children}
          {useNewEditor && node.type !== 'text' && (
            <div className="mb-2 max-h-[160px] overflow-hidden rounded-xl">{children}</div>
          )}
          <SoftCollapse open={useNewEditor}>
            <NodeEditorDialog
              node={node}
              models={models}
              latest={latest}
              autoFocusPrompt={node.type === 'text'}
            />
          </SoftCollapse>
          <SoftCollapse open={selected && Boolean(extraSelected)}>{extraSelected}</SoftCollapse>
        </div>
        {!useNewEditor && (
          <div className="flex items-center gap-2 border-t border-black/6 bg-[#1a1a1a] px-2.5 py-2">
            {selectedModel ? <ModelBrandIcon model={selectedModel} size={16} desktop={Boolean(window.vibepaperDesktop)} /> : null}
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/90">{modelLabel}</span>
            <span className="shrink-0 text-[10px] font-bold text-white/40">
              {(node.params.aspect as string) || (node.params.resolution as string) || '1:1'}
            </span>
          </div>
        )}
        <Handle
          type="source"
          position={Position.Right}
          id="output"
          className="!h-3.5 !w-3.5 !border-2 !border-white !bg-[#c0c0c4]"
          onClick={(e) => {
            e.stopPropagation()
            window.dispatchEvent(
              new CustomEvent('vp-create-downstream-node', {
                detail: { nodeId: sid(node.id), x: e.clientX, y: e.clientY, direction: 'downstream' },
              }),
            )
          }}
        />
      </div>
      {fullscreen && (authedMediaUrl || mediaUrl) && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-6"
          onClick={() => setFullscreen(false)}
        >
          <button
            type="button"
            className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white"
            onClick={() => setFullscreen(false)}
          >
            <X size={18} />
          </button>
          {node.type === 'video' ? (
            <video
              src={authedMediaUrl ?? mediaUrl}
              controls
              autoPlay
              className="max-h-full max-w-full rounded-xl"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <img
              src={authedMediaUrl ?? mediaUrl}
              alt=""
              className="max-h-full max-w-full rounded-xl object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </div>
  )
}

export function OutputActions({
  taskId: _taskId,
  url,
  onSaveToLibrary,
  mediaType = 'image',
}: {
  taskId: string | number
  url?: string
  onSaveToLibrary: () => void
  mediaType?: 'image' | 'video' | 'audio' | 'text'
}) {
  useUiLanguage()
  const [fullscreen, setFullscreen] = useState(false)
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-black/5 px-2.5 text-[12px] font-bold text-[#333] hover:bg-black/10"
          >
            <Download size={13} /> {uiText("下载")}</a>
        ) : null}
        <button
          type="button"
          onClick={onSaveToLibrary}
          className="inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-black/5 px-2.5 text-[12px] font-bold whitespace-nowrap text-[#333] hover:bg-black/10"
        >
          <Library size={13} /> {uiText("存入素材库")}</button>
        {url && (mediaType === 'image' || mediaType === 'video') && (
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="inline-flex h-8 items-center justify-center rounded-lg bg-black/5 px-2 text-[#333] hover:bg-black/10"
            title={uiText("全屏展示")}
          >
            <Maximize2 size={13} />
          </button>
        )}
        <span className="ml-auto truncate rounded-md bg-emerald-50 px-1.5 py-1 text-[10px] font-bold text-emerald-700">
          <Check size={11} className="inline" /> {uiText("已生成")}</span>
      </div>
      {fullscreen && url && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/85 p-6" onClick={() => setFullscreen(false)}>
          <button type="button" className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white" onClick={() => setFullscreen(false)}>
            <X size={18} />
          </button>
          {mediaType === 'video' ? (
            <video src={url} controls autoPlay className="max-h-full max-w-full rounded-xl" onClick={(e) => e.stopPropagation()} />
          ) : (
            <img src={url} alt="fullscreen" className="max-h-full max-w-full rounded-xl object-contain" onClick={(e) => e.stopPropagation()} />
          )}
        </div>
      )}
    </>
  )
}
