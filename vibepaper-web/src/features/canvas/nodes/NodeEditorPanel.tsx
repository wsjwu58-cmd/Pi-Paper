import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeftRight,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  Crop,
  Download,
  Expand,
  FileText,
  Film,
  Library,
  Link2,
  Loader2,
  Maximize2,
  Music2,
  Ratio,
  Scan,
  Settings2,
  Type,
  X,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { uploadAsset } from '@/lib/api'
import { resolveMediaUrl, useAuthedMediaUrl } from '@/lib/media'
import { sid } from '@/lib/ids'
import type { GenerationTask, Id, ModelInfo, NodePayload } from '@/lib/types'
import type { DesktopLocalAudioModel, DesktopProviderConfiguration } from '@/desktop/desktop-bridge'
import { defaultDesktopModelId, desktopProviderNameMap, toAvailableDesktopModels, type DesktopModelInfo } from '@/desktop/providerModels'
import { ModelPicker } from '@/components/ui/ModelPicker'
import { useCanvasStore, type FlowNode } from '../canvasStore'
import { useSoftPresence } from '../canvasMotion'
import { isDesktopRuntime } from '../canvasPort'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { MediaSpecificationPicker } from './MediaSpecificationPicker'
import { buildMediaReferenceParameters, getNodeResolutionMap, getVideoDurationCapability, getVideoFrameReferences, normalizeRemoteMediaReferenceUrl, resolveNodeResolution } from './videoNodeParameters'
import { downloadNodeOutput } from './nodeDownloads'
import type { CropMode } from './cropGeometry'

const STYLE_PRESETS = ['赛博朋克', '水彩', '写实', '动漫', '电影感', '产品渲染', '三视图']
const DESKTOP_MEDIA_TOOL_MODEL_ID = 'ffmpeg-media-1'
const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4']

const LEGACY_REFERENCE_FIDELITY_PROMPTS = [
  '严格参考输入图片的主体、构图与风格，仅按提示词做有限调整，勿整体重绘成另一张图。',
  '严格保持与参考首帧同一主体、构图、服装与色调；只描述运动与镜头变化，勿重新创造形象。',
]

function stripLegacyReferenceFidelity(prompt: string): string {
  return LEGACY_REFERENCE_FIDELITY_PROMPTS.reduce(
    (current, legacy) => current.replaceAll(legacy, ''),
    prompt,
  ).replace(/\n{3,}/g, '\n\n').trim()
}

export interface UpstreamRef {
  id: string
  sourceNodeId: string
  kind: 'image' | 'video' | 'audio' | 'text'
  label: string
  url?: string
  text?: string
}

function isUsableUpstreamEdge(edge: { data?: unknown }): boolean {
  const data = edge.data && typeof edge.data === 'object' && !Array.isArray(edge.data)
    ? edge.data as { valid?: unknown; edge?: { valid?: unknown } }
    : undefined
  return data?.valid !== false && data?.edge?.valid !== false
}

/** 读取连入当前节点的上游素材（有效连线优先） */
export function useUpstreamRefs(nodeId: string): UpstreamRef[] {
  const nid = sid(nodeId)
  // 用签名订阅，避免数组引用导致无更新 / 过度渲染
  const signature = useCanvasStore((s) => {
    const parts: string[] = []
    for (const e of s.edges) {
      if (!isUsableUpstreamEdge(e)) continue
      const target =
        sid(e.target) ||
        sid((e.data as { edge?: { targetNodeId?: unknown } } | undefined)?.edge?.targetNodeId)
      if (target !== nid) continue
      const sourceId =
        sid(e.source) ||
        sid((e.data as { edge?: { sourceNodeId?: unknown } } | undefined)?.edge?.sourceNodeId)
      const src = s.nodes.find((n) => sid(n.id) === sourceId)
      if (!src) {
        parts.push(`${sid(e.id)}:${sourceId}:missing`)
        continue
      }
      const p = src.data.node.params ?? {}
      parts.push(
        [
          sid(e.id),
          sourceId,
          src.data.node.type,
          p.lastOutputUrl,
          p.url,
          p.thumbnailUrl,
          p.referenceUrl,
          p.lastOutputText,
          p.prompt,
          p.text,
          p.content,
        ].join('\x1f'),
      )
    }
    return parts.join('\x1e')
  })

  return useMemo(() => {
    const s = useCanvasStore.getState()
    const refs: UpstreamRef[] = []
    for (const e of s.edges) {
      if (!isUsableUpstreamEdge(e)) continue
      const target =
        sid(e.target) ||
        sid((e.data as { edge?: { targetNodeId?: unknown } } | undefined)?.edge?.targetNodeId)
      if (target !== nid) continue
      const sourceId =
        sid(e.source) ||
        sid((e.data as { edge?: { sourceNodeId?: unknown } } | undefined)?.edge?.sourceNodeId)
      const src = s.nodes.find((n) => sid(n.id) === sourceId)
      if (!src) continue
      const payload = src.data.node
      const p = payload.params ?? {}
      const kind = (
        payload.type === 'image' ||
        payload.type === 'video' ||
        payload.type === 'audio' ||
        payload.type === 'text'
          ? payload.type
          : 'image'
      ) as UpstreamRef['kind']
      const url =
        resolveMediaUrl(
          (p.lastOutputUrl as string) ||
            (p.url as string) ||
            (p.thumbnailUrl as string) ||
            (p.referenceUrl as string) ||
            undefined,
          undefined,
        ) || undefined
      const textRaw =
        p.lastOutputText ?? p.prompt ?? p.text ?? p.content ?? (kind === 'text' ? '' : undefined)
      const text = textRaw != null && String(textRaw).trim() !== '' ? String(textRaw) : undefined
      refs.push({
        id: `up-${sid(e.id) || sourceId}`,
        sourceNodeId: sourceId,
        kind,
        label: kind === 'text' ? '文本' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片',
        url,
        text: kind === 'text' ? text || '上游文本' : text,
      })
    }
    return refs
    // signature 变化即重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nid, signature])
}

function RefThumb({
  url,
  kind,
  text,
  label,
  onRemove,
}: {
  url?: string
  kind: UpstreamRef['kind']
  text?: string
  label?: string
  onRemove?: () => void
}) {
  const src = useAuthedMediaUrl(url)
  return (
    <div className="group relative h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-[#f0f0f2] ring-1 ring-black/8">
      {kind === 'text' ? (
        <div className="flex h-full flex-col items-center justify-center gap-0.5 p-1 text-[#555]" title={text}>
          <Type size={18} strokeWidth={1.75} />
        </div>
      ) : kind === 'video' && src ? (
        <video src={src} className="h-full w-full object-cover" muted />
      ) : src ? (
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center text-[10px] font-bold text-[#aaa]">{label ?? kind}</div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          className="absolute right-0.5 top-0.5 rounded-full bg-black/70 p-0.5 text-white opacity-100 hover:bg-black"
          title="移除参考"
        >
          <X size={10} />
        </button>
      )}
    </div>
  )
}

/** 节点上方浮动操作栏（裁剪/扩图等） */
export function NodeFloatingToolbar({
  node,
  models,
  mediaUrl,
  onSaveToLibrary,
  onDownload,
  onFullscreen,
  onCropModeSelect,
}: {
  node: NodePayload
  models: ModelInfo[]
  mediaUrl?: string
  onSaveToLibrary?: () => void
  onDownload?: () => void | Promise<unknown>
  onFullscreen?: () => void
  onCropModeSelect?: (mode: CropMode) => void
}) {
  const desktopMode = isDesktopRuntime()
  const [busy, setBusy] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [menu, setMenu] = useState<'crop' | 'upscale' | 'three' | null>(null)
  const { data: desktopProviderConfiguration } = useQuery({
    queryKey: ['desktop-provider-configuration'],
    enabled: desktopMode,
    staleTime: 5_000,
    queryFn: async () => {
      const bridge = window.vibepaperDesktop
      if (!bridge) throw new Error('桌面模型配置接口尚未接入。')
      return bridge.getProviderConfiguration()
    },
  })
  const imageModel = desktopMode ? undefined :
    models.find((m) => m.modelType === 'image' && /agnes-image/i.test(m.name))?.name ??
    models.find((m) => m.modelType === 'image' && /agnes|seedream/i.test(m.name))?.name ??
    models.find((m) => m.modelType === 'image')?.name
  const videoModel = desktopMode ? undefined :
    models.find((m) => m.modelType === 'video' && /agnes-video/i.test(m.name))?.name ??
    models.find((m) => m.modelType === 'video' && /agnes|seedance/i.test(m.name))?.name ??
    models.find((m) => m.modelType === 'video')?.name

  const runOp = async (op: string, extra: Record<string, unknown> = {}) => {
    if (busy) return
    const localPostprocess = desktopMode && (
      node.type === 'image' && ['裁剪', '三视图'].includes(op)
      || node.type === 'video' && ['剪辑', '提帧', '超分'].includes(op)
    )
    if (desktopMode && !localPostprocess && !['扩图', '超分'].includes(op)) {
      toastError('桌面本地暂不支持此媒体操作。')
      return
    }
    setBusy(true)
    try {
      const { submitNodeTask } = await import('./taskActions')
      let model = node.type === 'video' ? videoModel : imageModel
      let desktopOptions: { providerType: 'local' | 'cloud'; providerId?: string; modelId?: string } | undefined
      if (localPostprocess) {
        if (!mediaUrl?.startsWith('vibe://')) {
          throw new Error('本地后处理需要当前项目中的素材或已完成任务结果。')
        }
        model = DESKTOP_MEDIA_TOOL_MODEL_ID
      } else if (desktopMode) {
        const bridge = window.vibepaperDesktop
        if (!bridge) throw new Error('桌面本地模型接口不可用。')
        const modality = node.type === 'video' ? 'video' : 'image'
        const configuration = desktopProviderConfiguration ?? await bridge.getProviderConfiguration()
        const available = toAvailableDesktopModels(configuration, modality)
        const preferredId = typeof node.params.model === 'string'
          ? node.params.model
          : defaultDesktopModelId(configuration, modality)
        const selected = available.find((candidate) => candidate.id === preferredId)
        if (!selected) throw new Error(`请先在模型配置中启用已适配的${modality === 'video' ? '视频' : '图片'}模型。`)
        model = selected.id
        desktopOptions = {
          providerType: 'cloud',
          providerId: selected.providerId,
          modelId: selected.id,
        }
      } else {
        desktopOptions = undefined
      }
      if (!model) throw new Error('无可用模型')
      if (localPostprocess) desktopOptions = { providerType: 'local' }
      await submitNodeTask(
        node.id,
        model,
        { operation: op, count: 1, sourceUrl: mediaUrl, ...extra },
        desktopMode ? 0 : 8,
        desktopOptions,
      )
      toastSuccess(`${op}已提交`)
      setMenu(null)
    } catch (e) {
      toastError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const supportsMediaTools = node.type === 'image' || node.type === 'video'
  const supportsDownload = Boolean(onDownload || mediaUrl)
  if (!supportsMediaTools && !supportsDownload) return null

  const download = async () => {
    if (downloadBusy || !supportsDownload) return
    setDownloadBusy(true)
    try {
      if (onDownload) await onDownload()
      else await downloadNodeOutput({ node, mediaUrl })
    } catch (cause) {
      toastError(cause instanceof Error ? cause.message : '下载节点结果失败。')
    } finally {
      setDownloadBusy(false)
    }
  }

  return (
    <div
      className="nodrag absolute left-1/2 top-0 z-30 flex -translate-x-1/2 -translate-y-[calc(100%+8px)] items-center gap-0.5 rounded-2xl border border-black/8 bg-white px-1.5 py-1 shadow-[0_8px_28px_rgba(15,23,42,0.14)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {node.type === 'image' && (
        <>
          <ToolIcon title={desktopMode ? '桌面本地裁剪' : '裁剪'} disabled={busy || desktopMode && !mediaUrl} active={menu === 'crop'} onClick={() => setMenu(menu === 'crop' ? null : 'crop')}>
            <Crop size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地扩图' : '扩图'} disabled={busy || desktopMode && !mediaUrl} onClick={() => void runOp('扩图')}>
            <Expand size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地超分' : '超分'} disabled={busy} active={menu === 'upscale'} onClick={() => setMenu(menu === 'upscale' ? null : 'upscale')}>
            <Scan size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地三视图' : '三视图'} disabled={busy || desktopMode && !mediaUrl} active={menu === 'three'} onClick={() => setMenu(menu === 'three' ? null : 'three')}>
            <Ratio size={15} />
          </ToolIcon>
        </>
      )}
      {node.type === 'video' && (
        <>
          <ToolIcon title={desktopMode ? '桌面本地剪辑' : '剪辑'} disabled={busy || desktopMode && !mediaUrl} onClick={() => void runOp('剪辑', { start: 0, end: 5 })}>
            <Crop size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地提帧' : '提帧'} disabled={busy || desktopMode && !mediaUrl} onClick={() => void runOp('提帧', { frameAt: 1 })}>
            <Film size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地视频超分' : '超分'} disabled={busy || desktopMode && !mediaUrl} onClick={() => void runOp('超分', { resolution: '1920x1080' })}>
            <Expand size={15} />
          </ToolIcon>
          <ToolIcon
            title={desktopMode ? '桌面本地未接入：Seedance 认证' : 'Seedance 认证'}
            disabled={desktopMode}
            onClick={() => {
              toastSuccess('已提交 Seedance 认证申请')
            }}
          >
            <Check size={15} />
          </ToolIcon>
        </>
      )}
      <div className="mx-1 h-5 w-px bg-black/10" />
      {supportsDownload && (
        <ToolIcon title={downloadBusy ? '保存中…' : '下载'} disabled={downloadBusy} onClick={() => void download()}>
          <Download size={15} />
        </ToolIcon>
      )}
      {onSaveToLibrary && !desktopMode && (
        <ToolIcon title="存入素材库" onClick={onSaveToLibrary}>
          <Library size={15} />
        </ToolIcon>
      )}
      {desktopMode && (node.type === 'image' || node.type === 'video') && (
        <ToolIcon title="桌面本地未接入：保存生成结果到素材库" disabled onClick={() => undefined}>
          <Library size={15} />
        </ToolIcon>
      )}
      {onFullscreen && mediaUrl && (
        <ToolIcon title="全屏" onClick={onFullscreen}>
          <Maximize2 size={15} />
        </ToolIcon>
      )}

      {menu === 'crop' && (
        <PopMenu>
          {[
            ['single', '单图裁剪'],
            ['four', '四宫格裁剪'],
            ['nine', '九宫格裁剪'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] font-semibold text-[#444] hover:bg-black/[0.04]"
              onClick={() => {
                if (desktopMode && onCropModeSelect) {
                  onCropModeSelect(id as CropMode)
                  setMenu(null)
                  return
                }
                void runOp('裁剪', { cropMode: id === 'four' ? '四宫格' : id === 'nine' ? '九宫格' : id })
              }}
            >
              {label}
            </button>
          ))}
        </PopMenu>
      )}
      {menu === 'upscale' && (
        <PopMenu>
          {['2048x2048', '1920x1080', '3840x2160'].map((r) => (
            <button
              key={r}
              type="button"
              className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] font-semibold text-[#444] hover:bg-black/[0.04]"
              onClick={() => void runOp('超分', { resolution: r })}
            >
              {r}
            </button>
          ))}
        </PopMenu>
      )}
      {menu === 'three' && (
        <PopMenu>
          {['人物', '场景', '产品'].map((c) => (
            <button
              key={c}
              type="button"
              className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] font-semibold text-[#444] hover:bg-black/[0.04]"
              onClick={() =>
                void runOp('三视图', {
                  style: '三视图',
                  threeViewCategory: c,
                  prompt: `基于当前图片生成${c}三视图`,
                })
              }
            >
              {c}
            </button>
          ))}
        </PopMenu>
      )}
    </div>
  )
}

function ToolIcon({
  title,
  onClick,
  children,
  active,
  disabled,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-xl disabled:opacity-40 ${
        active ? 'bg-black/[0.08] text-[#111]' : 'text-[#444] hover:bg-black/[0.05]'
      }`}
    >
      {children}
    </button>
  )
}

function PopMenu({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute left-0 top-full z-40 mt-1 w-36 rounded-xl border border-black/8 bg-white p-1 shadow-xl">
      {children}
    </div>
  )
}

/** 画布节点底栏用：避免 React Flow transform 下原生 select 下拉错位 */
function SplitFooterSelect({
  value,
  options,
  onChange,
  className = '',
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)?.label ?? value

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={rootRef} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 max-w-[170px] items-center gap-1 rounded-lg bg-white/10 px-2.5 text-[11px] font-bold text-white/90 hover:bg-white/15"
      >
        <span className="truncate">{current || '选择模型'}</span>
        <span className="shrink-0 text-[10px] text-white/50">▾</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-[100] mb-1 max-h-44 min-w-full overflow-auto rounded-xl border border-black/10 bg-white py-1 shadow-xl">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`block w-full px-3 py-1.5 text-left text-[11px] font-semibold hover:bg-black/[0.04] ${
                o.value === value ? 'bg-black/[0.05] text-[#111]' : 'text-[#444]'
              }`}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type LocalRef = UpstreamRef & { local?: boolean }

function DesktopTextReferencePrompt({ onCancel, onSubmit }: {
  onCancel: () => void
  onSubmit: (text: string) => void
}) {
  const [text, setText] = useState('')
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30" onMouseDown={onCancel}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label="输入参考文本"
        className="w-[min(420px,calc(100vw-32px))] rounded-xl border border-black/10 bg-white p-5 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}
        onSubmit={(event) => {
          event.preventDefault()
          if (text.trim()) onSubmit(text)
        }}
      >
        <label htmlFor="desktop-reference-text" className="mb-3 block text-sm font-semibold text-[#222]">输入参考文本</label>
        <textarea
          id="desktop-reference-text"
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="min-h-24 w-full resize-y rounded-lg border border-black/15 p-2 text-sm outline-none focus:border-[#7c6ce7]"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-[#555] hover:bg-black/5">取消</button>
          <button type="submit" disabled={!text.trim()} className="rounded-lg bg-[#111] px-3 py-1.5 text-sm text-white disabled:opacity-40">确定</button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

function DesktopMediaUrlReferencePrompt({ kind, onCancel, onSubmit }: {
  kind: 'video' | 'audio'
  onCancel: () => void
  onSubmit: (url: string) => void
}) {
  const [url, setUrl] = useState('')
  const mediaName = kind === 'video' ? '视频' : '音频'
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/30" onMouseDown={onCancel}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={`添加 HTTPS ${mediaName}参考`}
        className="w-[min(460px,calc(100vw-32px))] rounded-xl border border-black/10 bg-white p-5 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}
        onSubmit={(event) => {
          event.preventDefault()
          if (url.trim()) onSubmit(url.trim())
        }}
      >
        <label htmlFor={`desktop-reference-${kind}-url`} className="mb-2 block text-sm font-semibold text-[#222]">
          输入模型可访问的 HTTPS {mediaName}地址
        </label>
        <input
          id={`desktop-reference-${kind}-url`}
          type="url"
          autoFocus
          required
          maxLength={4096}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/media"
          className="h-10 w-full rounded-lg border border-black/15 px-3 text-sm outline-none focus:border-[#7c6ce7]"
        />
        <p className="mt-2 text-xs leading-5 text-[#777]">火山方舟会根据此地址读取参考媒体；请使用无需本机登录、可由供应商访问的公网链接。</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-[#555] hover:bg-black/5">取消</button>
          <button type="submit" disabled={!url.trim()} className="rounded-lg bg-[#111] px-3 py-1.5 text-sm text-white disabled:opacity-40">添加参考</button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

function PortalChoiceSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  dark = false,
  disabled = false,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
  dark?: boolean
  disabled?: boolean
}) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 12, top: 12 })
  const presence = useSoftPresence(open)
  const selected = options.find((option) => option.value === value)

  const toggle = () => {
    if (disabled) return
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) {
      const width = Math.min(260, window.innerWidth - 24)
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
      const top = rect.bottom + 8 + 210 < window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - 8 - 210)
      setPosition({ left, top })
    }
    setOpen((current) => !current)
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div className="vp-audio-choice relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
        className={`flex h-8 max-w-[190px] items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold disabled:opacity-50 ${dark ? 'text-white/90 hover:bg-white/10' : 'text-[#444] hover:bg-black/[0.05]'}`}
      >
        <span className="truncate">{selected?.label ?? label}</span>
        <ChevronDown size={12} className="shrink-0 opacity-60" />
      </button>
      {presence.present && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={label}
          aria-hidden={!open}
          inert={!open}
          data-open={presence.visible}
          className={`vp-soft-popover vp-editor-popover fixed z-[10050] min-w-48 rounded-xl border border-black/8 bg-white p-1.5 shadow-xl ${presence.visible ? '' : 'pointer-events-none'}`}
          style={position}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={option.value === value}
              onClick={() => { onChange(option.value); setOpen(false) }}
              className={`block w-full rounded-lg px-3 py-2 text-left text-[12px] ${option.value === value ? 'bg-black/[0.06] font-semibold text-[#111]' : 'text-[#555] hover:bg-black/[0.04]'}`}
            >
              {option.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

type DesktopAudioMode = 'speech' | 'music'
type MusicLyricsMode = 'auto' | 'manual' | 'instrumental'

function desktopAudioModeForModel(model?: DesktopModelInfo): DesktopAudioMode | undefined {
  if (model?.operation === 'music') return 'music'
  if (model?.operation === 'speech' || model?.operation === 'text-to-speech' || model?.operation === 'tts'
    || model?.providerId === 'local-sapi-tts') return 'speech'
  return undefined
}

function isDesktopSpeechModel(model?: DesktopModelInfo): boolean {
  return desktopAudioModeForModel(model) === 'speech'
}

function isDesktopMusicModel(model?: DesktopModelInfo): boolean {
  return desktopAudioModeForModel(model) === 'music'
}

function getDesktopAudioVoiceOptions(model?: DesktopModelInfo): Array<{ id: string; label: string }> {
  const values = model?.constraints?.voices
  if (!Array.isArray(values)) return []
  return values.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [{ id: item, label: item }]
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const value = item as Record<string, unknown>
    const id = [value.voiceId, value.id, value.value].find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    if (!id) return []
    const label = [value.label, value.name, value.displayName].find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    return [{ id, label: label ?? id }]
  })
}

function withoutModelSpecification(params: Record<string, unknown>): Record<string, unknown> {
  const next = { ...params }
  for (const key of ['aspect', 'ratio', 'resKey', 'resolution', 'size', 'duration', 'generate_audio']) delete next[key]
  return next
}

function durationForCapability(
  capability: ReturnType<typeof getVideoDurationCapability>,
  preferred: unknown,
  previous: number,
): number | undefined {
  if (!capability) return undefined
  if (capability.kind === 'fixed') return capability.value
  if (capability.kind === 'discrete') {
    return typeof preferred === 'number' && capability.values.includes(preferred)
      ? preferred
      : capability.values.includes(previous) ? previous : capability.values[0]
  }
  const candidate = typeof preferred === 'number' && Number.isFinite(preferred) ? preferred : previous
  return Math.min(capability.maximum, Math.max(capability.minimum, candidate))
}

function aspectOptionsForModel(model: DesktopModelInfo | undefined, desktopMode: boolean): string[] {
  if (!desktopMode) return ASPECTS
  const accepted = model?.constraints?.acceptedAspectRatios
  if (Array.isArray(accepted)) return accepted.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const defaultRatio = model?.defaultParams?.ratio
  return typeof defaultRatio === 'string' && defaultRatio.trim() ? [defaultRatio] : []
}

/** 选中编辑对话框：参考区 + 提示词 + 底栏生成 */
export function NodeEditorDialog({
  node,
  models,
  latest,
  autoFocusPrompt = false,
  layout = 'default',
}: {
  node: NodePayload
  models: ModelInfo[]
  latest?: GenerationTask | null
  autoFocusPrompt?: boolean
  /** default：参考/提示词分框；split：合并在同一底栏卡片（双框节点布局） */
  layout?: 'default' | 'text' | 'split'
}) {
  const navigate = useNavigate()
  const nodeId = sid(node.id)
  const desktopMode = Boolean(window.vibepaperDesktop)
  const { data: desktopCatalog = {
    models: [] as DesktopModelInfo[],
    localAudio: null as DesktopLocalAudioModel | null,
    configuration: null as DesktopProviderConfiguration | null,
    providerNames: {} as Record<string, string>,
  }, refetch: refetchDesktopCatalog, error: desktopCatalogError } = useQuery({
    queryKey: ['desktop-node-models'],
    enabled: desktopMode,
    staleTime: 5_000,
    queryFn: async (): Promise<{
      models: DesktopModelInfo[]
      localAudio: DesktopLocalAudioModel | null
      configuration: DesktopProviderConfiguration | null
      providerNames: Record<string, string>
    }> => {
      const providerBridge = window.vibepaperDesktop
      if (!providerBridge) return { models: [], localAudio: null, configuration: null, providerNames: {} }
      const [configurationResult, localResult, localAudioResult] = await Promise.allSettled([
        providerBridge.getProviderConfiguration(),
        providerBridge.getLocalTextModel(),
        typeof providerBridge.getLocalAudioModel === 'function' ? providerBridge.getLocalAudioModel() : Promise.resolve(null),
      ])
      if (configurationResult.status === 'rejected') throw configurationResult.reason
      const configuration = configurationResult.status === 'fulfilled' ? configurationResult.value : null
      const available: DesktopModelInfo[] = configuration ? toAvailableDesktopModels(configuration) : []
      const providerNames = configuration ? desktopProviderNameMap(configuration) : {}
      if (localResult.status === 'fulfilled' && localResult.value) {
        const local = localResult.value
        available.push({
          id: local.modelId,
          name: local.modelId,
          modelType: 'text',
          displayName: local.modelId,
          provider: 'local',
          providerId: 'local-openai-compatible',
          providerType: 'local',
          brandId: 'local',
          apiModelId: local.modelId,
          inputModes: ['text'],
          enabled: true,
          basePrice: null as unknown as number,
        })
      }
      const localAudio = localAudioResult.status === 'fulfilled' ? localAudioResult.value : null
      if (localAudio?.available && localAudio.modelId === 'local-sapi-tts') {
        available.push({
          id: localAudio.modelId,
          name: localAudio.modelId,
          modelType: 'audio',
          operation: 'speech',
          displayName: localAudio.modelId,
          provider: 'local',
          providerId: 'local-sapi-tts',
          providerType: 'local',
          brandId: 'local',
          apiModelId: localAudio.modelId,
          inputModes: ['text'],
          enabled: true,
          basePrice: null as unknown as number,
        })
      }
      providerNames.local = '本地模型'
      return { models: available, localAudio, configuration, providerNames }
    },
  })
  useEffect(() => {
    const refresh = () => { void refetchDesktopCatalog() }
    window.addEventListener('vp-desktop-model-catalog-changed', refresh)
    return () => window.removeEventListener('vp-desktop-model-catalog-changed', refresh)
  }, [refetchDesktopCatalog])
  const desktopModels = desktopCatalog.models
  const upstream = useUpstreamRefs(nodeId)
  const excludedIds = useMemo(
    () => new Set(((node.params.excludedRefIds as string[]) ?? []).map(String)),
    [node.params.excludedRefIds],
  )
  const [localRefs, setLocalRefs] = useState<LocalRef[]>([])
  const [desktopReferencePromptOpen, setDesktopReferencePromptOpen] = useState<'text' | 'video-url' | 'audio-url' | null>(null)
  const [frameOrder, setFrameOrder] = useState<'asc' | 'swap'>('asc')
  const [prompt, setPrompt] = useState(stripLegacyReferenceFidelity((node.params.prompt as string) ?? ''))
  const [model, setModel] = useState((node.params.model as string) ?? '')
  const [audioMode, setAudioMode] = useState<DesktopAudioMode>(() =>
    node.params.audioMode === 'music' || node.params.is_instrumental === true
      || typeof node.params.lyrics === 'string' || node.params.lyrics_optimizer === true
      ? 'music'
      : 'speech',
  )
  const [lyricsMode, setLyricsMode] = useState<MusicLyricsMode>(() =>
    node.params.is_instrumental === true
      ? 'instrumental'
      : node.params.lyrics_optimizer === false && typeof node.params.lyrics === 'string' && node.params.lyrics.length > 0
        ? 'manual'
        : 'auto',
  )
  const [lyrics, setLyrics] = useState(typeof node.params.lyrics === 'string' ? node.params.lyrics : '')
  const [voiceId, setVoiceId] = useState(typeof node.params.voiceId === 'string' ? node.params.voiceId : '')
  const [aspect, setAspect] = useState((node.params.aspect as string) || '1:1')
  const [resKey, setResKey] = useState((node.params.resKey as string) || (node.type === 'video' && desktopMode ? '720P' : '2K'))
  const [style, setStyle] = useState((node.params.style as string) ?? '')
  const [camera, setCamera] = useState((node.params.camera as string) ?? '')
  const [duration, setDuration] = useState(Number(node.params.duration) || 4)
  const [generateAudio, setGenerateAudio] = useState(node.params.generate_audio !== false)
  const storedCount = Number(node.params.count)
  const initialCount = Number.isSafeInteger(storedCount) && storedCount > 0 ? storedCount : 1
  const [count, setCount] = useState(desktopMode && node.type === 'image' ? Math.min(initialCount, 4) : initialCount)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const editorModels = desktopMode ? desktopModels : models
  const modalityModels = useMemo(
    () =>
      editorModels.filter(
        (m) => m.modelType === node.type && !/兼容别名|已停用/.test(String(m.description || '')),
      ),
    [editorModels, node.type],
  )
  const desktopAudioModels = desktopMode && node.type === 'audio'
    ? modalityModels as DesktopModelInfo[]
    : []
  const speechModels = useMemo(() => desktopAudioModels.filter(isDesktopSpeechModel), [desktopAudioModels])
  const musicModels = useMemo(() => desktopAudioModels.filter(isDesktopMusicModel), [desktopAudioModels])
  const typeModels = desktopMode && node.type === 'audio'
    ? audioMode === 'music' ? musicModels : speechModels
    : modalityModels
  useEffect(() => {
    if (!desktopMode || node.type !== 'audio' || node.params.audioMode === 'music' || audioMode !== 'speech') return
    const storedModel = desktopModels.find((candidate) => candidate.id === node.params.model)
    if (desktopAudioModeForModel(storedModel) === 'music') setAudioMode('music')
  }, [audioMode, desktopMode, desktopModels, node.params.audioMode, node.params.model, node.type])
  const configuredDefault = desktopMode
    ? desktopCatalog.configuration?.providers
      .map((provider) => provider.defaultModelIds?.[node.type])
      .find((id): id is string => Boolean(id && typeModels.some((candidate) => candidate.name === id)))
    : undefined
  const preferred =
    configuredDefault ??
    (desktopMode && node.type === 'text' ? typeModels.find((m) => (m as DesktopModelInfo).providerType === 'local')?.name : undefined) ??
    (desktopMode && node.type === 'audio' ? typeModels.find((m) => (m as DesktopModelInfo).providerId === 'local-sapi-tts')?.name : undefined) ??
    (desktopMode ? typeModels.find((m) => m.displayName === ({ text: 'Claude Fable 5.1', image: 'Seedream 5.0 Pro', video: 'Seedance 2.5' } as Record<string, string>)[node.type])?.name : undefined) ??
    typeModels[0]?.name
  const selectedModel = typeModels.find((item) => item.name === (model || preferred))
  const selectedDesktopModel = desktopMode && selectedModel ? selectedModel as DesktopModelInfo : undefined
  const resolutionMap = getNodeResolutionMap(node.type, selectedModel, desktopMode, aspect)
  const selectedResKey = resolutionMap[resKey] ? resKey : Object.keys(resolutionMap)[0] ?? resKey
  const resolutionKeys = Object.keys(resolutionMap)
  const resolutionOptions = resolutionKeys.map((key) => ({ key, value: resolutionMap[key] }))
  const durationResolutionValue = resolutionMap[selectedResKey] ?? selectedResKey
  const durationCapability = useMemo(
    () => desktopMode && node.type === 'video'
      ? getVideoDurationCapability(selectedDesktopModel?.constraints, durationResolutionValue, selectedDesktopModel?.defaultParams?.duration)
      : null,
    [desktopMode, durationResolutionValue, node.type, selectedDesktopModel?.constraints, selectedDesktopModel?.defaultParams?.duration],
  )
  useEffect(() => {
    if (!durationCapability) return
    const nextDuration = durationForCapability(durationCapability, duration, duration)
    if (nextDuration !== undefined && nextDuration !== duration) setDuration(nextDuration)
  }, [durationCapability, duration, selectedDesktopModel?.defaultParams?.duration])
  const aspectOptions = aspectOptionsForModel(selectedDesktopModel, desktopMode)
  const supportsAudioOption = desktopMode && selectedDesktopModel?.constraints?.supportsGenerateAudio === true
  const isMusicModel = desktopMode && node.type === 'audio' && isDesktopMusicModel(selectedDesktopModel)
  const musicParams = isMusicModel ? {
    is_instrumental: lyricsMode === 'instrumental',
    lyrics_optimizer: lyricsMode === 'auto',
    ...(lyricsMode === 'manual' && lyrics.trim() ? { lyrics: lyrics.trim() } : {}),
  } : {}
  const voiceOptions = desktopMode && node.type === 'audio' ? getDesktopAudioVoiceOptions(selectedDesktopModel) : []
  const maximumOutputs = desktopMode && node.type === 'image' ? Math.min(4, Number(selectedDesktopModel?.constraints?.maximumOutputs) || 4) : 4
  useEffect(() => {
    if (!desktopMode || !selectedDesktopModel) return
    const defaults = selectedDesktopModel.defaultParams ?? {}
    const savedRatio = node.params.ratio ?? node.params.aspect
    const ratio = aspectOptions.includes(String(savedRatio))
      ? String(savedRatio)
      : aspectOptions.includes(String(defaults.ratio)) ? String(defaults.ratio) : aspectOptions[0]
    if (ratio) setAspect((current) => current === ratio ? current : ratio)

    const defaultResolution = defaults.resolution ?? defaults.size
    const defaultResolutionKey = typeof defaultResolution === 'string'
      ? Object.entries(resolutionMap).find(([, value]) => value.toLowerCase() === defaultResolution.toLowerCase())?.[0]
      : undefined
    const savedResolutionKey = typeof node.params.resKey === 'string' && resolutionMap[node.params.resKey]
      ? node.params.resKey
      : undefined
    const nextResolutionKey = savedResolutionKey ?? defaultResolutionKey ?? resolutionKeys[0]
    if (nextResolutionKey) setResKey((current) => current === nextResolutionKey ? current : nextResolutionKey)

    if (durationCapability) {
      const savedDuration = typeof node.params.duration === 'number' ? node.params.duration : undefined
      const nextDuration = durationForCapability(durationCapability, savedDuration ?? defaults.duration, duration)
      if (nextDuration !== undefined) setDuration((current) => current === nextDuration ? current : nextDuration)
    }
    if (supportsAudioOption && typeof (node.params.generate_audio ?? defaults.generate_audio) === 'boolean') {
      setGenerateAudio(Boolean(node.params.generate_audio ?? defaults.generate_audio))
    }
  }, [aspectOptions, desktopMode, durationCapability, node.params.aspect, node.params.duration, node.params.generate_audio, node.params.resKey, node.params.ratio, resolutionKeys, resolutionMap, selectedDesktopModel, supportsAudioOption])

  // 上游变化时合并进参考（保留本地上传；尊重用户删除的上游）
  useEffect(() => {
    setLocalRefs((prev) => {
      const locals = prev.filter((r) => r.local)
      const up = upstream
        .filter((r) => !excludedIds.has(r.id))
        .map((r) => ({ ...r, local: false as const }))
      return [...up, ...locals]
    })
  }, [upstream, excludedIds])

  useEffect(() => {
    setPrompt(stripLegacyReferenceFidelity((node.params.prompt as string) ?? ''))
    const raw = (node.params.model as string) || preferred || ''
    const allowed = typeModels.some((m) => m.name === raw) ? raw : preferred || ''
    setModel(allowed)
  }, [desktopMode, node.id, node.params.prompt, node.params.model, preferred, typeModels])

  useEffect(() => {
    const next = Number(node.params.count)
    if (!Number.isSafeInteger(next) || next < 1) return
    setCount(desktopMode && node.type === 'image' ? Math.min(next, 4) : next)
  }, [desktopMode, node.id, node.params.count, node.type])

  useEffect(() => {
    if (!autoFocusPrompt) return
    const t = window.setTimeout(() => {
      promptRef.current?.focus()
      const el = promptRef.current
      if (el) {
        const len = el.value.length
        el.setSelectionRange(len, len)
      }
    }, 30)
    return () => window.clearTimeout(t)
  }, [autoFocusPrompt, nodeId])

  const refsForUi = useMemo(() => {
    if (node.type !== 'video') return localRefs
    const images = localRefs.filter((r) => r.kind === 'image' || !desktopMode && r.kind === 'video')
    if (frameOrder === 'swap' && images.length >= 2) {
      const [a, b, ...rest] = images
      const remainingReferences = localRefs.filter((r) => desktopMode
        ? r.kind !== 'image'
        : r.kind === 'text' || r.kind === 'audio')
      return [b, a, ...rest, ...remainingReferences]
    }
    return localRefs
  }, [desktopMode, frameOrder, localRefs, node.type])

  const { firstFrame, lastFrame } = getVideoFrameReferences(refsForUi, desktopMode)
  const frameAspect = desktopMode && node.type === 'video'
    ? firstFrame && lastFrame ? selectedDesktopModel?.constraints?.firstLastFrameAspectRatio
      : firstFrame ? selectedDesktopModel?.constraints?.imageAspectRatio : undefined
    : undefined
  const effectiveAspect = typeof frameAspect === 'string' ? frameAspect : aspect
  const effectiveAspectOptions = typeof frameAspect === 'string' ? [frameAspect] : aspectOptions

  const persistPrompt = (value: string) => {
    setPrompt(value)
    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
    useCanvasStore.getState().updateNodePayload(nodeId, {
      params: { ...(current?.params ?? node.params), prompt: value },
    })
  }

  const persistNodeParams = (patch: Record<string, unknown>, remove: string[] = []) => {
    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
    const params = { ...(current?.params ?? node.params) }
    for (const key of remove) delete params[key]
    useCanvasStore.getState().updateNodePayload(node.id, { params: { ...params, ...patch } })
  }

  const changeAspect = (value: string) => {
    setAspect(value)
    if (desktopMode) {
      const nextMap = getNodeResolutionMap(node.type, selectedModel, true, value)
      const nextKey = nextMap[resKey] ? resKey : Object.keys(nextMap)[0]
      if (nextKey) setResKey(nextKey)
      persistNodeParams({ aspect: value, ratio: value, ...(nextKey ? resolveNodeResolution(node.type, selectedModel, nextKey, true, value) : {}) })
    }
    else persistNodeParams({ aspect: value })
  }

  const changeResolution = (value: string) => {
    setResKey(value)
    if (desktopMode) persistNodeParams(resolveNodeResolution(node.type, selectedModel, value, true, effectiveAspect))
  }

  const changeDuration = (value: number) => {
    setDuration(value)
    if (desktopMode && node.type === 'video') persistNodeParams({ duration: value })
  }

  const changeLyrics = (value: string) => {
    setLyrics(value)
    persistNodeParams({ lyrics: value })
  }

  const changeLyricsMode = (value: MusicLyricsMode) => {
    setLyricsMode(value)
    const patch = value === 'instrumental'
      ? { is_instrumental: true, lyrics_optimizer: false }
      : value === 'manual'
        ? { is_instrumental: false, lyrics_optimizer: false }
        : { is_instrumental: false, lyrics_optimizer: true }
    persistNodeParams(patch)
  }

  const changeVoice = (value: string) => {
    setVoiceId(value)
    persistNodeParams({ voiceId: value })
  }

  const chooseDesktopAudioMode = (value: DesktopAudioMode) => {
    setAudioMode(value)
    const choices = value === 'music' ? musicModels : speechModels
    if (value === audioMode && choices.some((candidate) => candidate.name === model)) return
    const configured = desktopCatalog.configuration?.providers
      .map((provider) => provider.defaultModelIds?.audio)
      .find((id): id is string => Boolean(id && choices.some((candidate) => candidate.name === id)))
    const selected = choices.find((candidate) => candidate.name === model) ?? choices.find((candidate) => candidate.name === configured) ?? choices[0]
    if (selected) applyDesktopModel(selected.name)
    else {
      setModel('')
      persistNodeParams({ audioMode: value }, ['model'])
    }
  }

  const applyDesktopModel = (value: string) => {
    const chosen = modalityModels.find((candidate) => candidate.name === value) as DesktopModelInfo | undefined
    setModel(value)
    if (!desktopMode || !chosen) {
      persistNodeParams({ model: value })
      return
    }

    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
    const params = withoutModelSpecification(current?.params ?? node.params)
    if (!isDesktopMusicModel(chosen)) {
      for (const key of ['lyrics', 'lyrics_optimizer', 'is_instrumental']) delete params[key]
    }
    delete params.voiceId
    delete params.voice
    params.model = value
    if (node.type === 'audio') params.audioMode = desktopAudioModeForModel(chosen) ?? audioMode

    const defaults = chosen.defaultParams ?? {}
    const nextAspects = aspectOptionsForModel(chosen, true)
    const nextAspect = nextAspects.includes(String(defaults.ratio))
      ? String(defaults.ratio)
      : nextAspects[0]
    if (nextAspect) {
      params.aspect = nextAspect
      params.ratio = nextAspect
      setAspect(nextAspect)
    } else setAspect('')

    const nextMap = getNodeResolutionMap(node.type, chosen, true, nextAspect)
    const defaultResolution = defaults.resolution ?? defaults.size
    const defaultKey = typeof defaultResolution === 'string'
      ? Object.entries(nextMap).find(([, item]) => item.toLowerCase() === defaultResolution.toLowerCase())?.[0]
      : undefined
    const nextResolutionKey = defaultKey ?? Object.keys(nextMap)[0]
    if (nextResolutionKey) {
      setResKey(nextResolutionKey)
      Object.assign(params, resolveNodeResolution(node.type, chosen, nextResolutionKey, true, nextAspect))
    } else setResKey('')

    if (node.type === 'video') {
      const nextDurationCapability = getVideoDurationCapability(chosen.constraints, nextMap[nextResolutionKey ?? ''] ?? nextResolutionKey ?? '', defaults.duration)
      const nextDuration = durationForCapability(nextDurationCapability, defaults.duration, duration)
      if (nextDuration !== undefined) {
        params.duration = nextDuration
        setDuration(nextDuration)
      }
      if (chosen.constraints?.supportsGenerateAudio === true) {
        const nextGenerateAudio = typeof defaults.generate_audio === 'boolean' ? defaults.generate_audio : false
        params.generate_audio = nextGenerateAudio
        setGenerateAudio(nextGenerateAudio)
      } else setGenerateAudio(false)
    }
    if (node.type === 'image') {
      params.count = 1
      setCount(1)
    }
    if (node.type === 'audio') {
      const voices = getDesktopAudioVoiceOptions(chosen)
      const voice = voices.find((item) => item.id === voiceId)?.id ?? voices[0]?.id
      if (voice) {
        params.voiceId = voice
        setVoiceId(voice)
      } else setVoiceId('')
    }
    useCanvasStore.getState().updateNodePayload(node.id, { params })
  }

  const removeRef = (ref: LocalRef) => {
    if (ref.local) {
      setLocalRefs((prev) => prev.filter((x) => x.id !== ref.id))
      return
    }
    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
    const prevExcluded = ((current?.params.excludedRefIds as string[]) ?? []).map(String)
    if (prevExcluded.includes(ref.id)) return
    useCanvasStore.getState().updateNodePayload(nodeId, {
      params: {
        ...(current?.params ?? node.params),
        excludedRefIds: [...prevExcluded, ref.id],
      },
    })
    setLocalRefs((prev) => prev.filter((x) => x.id !== ref.id))
  }

  const onUploadRef = async (file?: File) => {
    try {
      if (isDesktopRuntime()) {
        const voiceChange = node.type === 'audio' && selectedDesktopModel?.operation === 'voice-change'
        if (!['image', 'video'].includes(node.type) && !voiceChange) {
          throw new Error('当前模型不支持上传媒体参考。')
        }
        const bridge = window.vibepaperDesktop
        if (!bridge) throw new Error('桌面本地素材接口不可用。')
        const project = await bridge.getActiveProject()
        const canvasId = useCanvasStore.getState().canvas?.canvas.id
        if (!project || (canvasId && project.canvasId !== sid(canvasId))) {
          throw new Error('没有匹配的本地项目，无法添加节点参考。')
        }
        const asset = await bridge.importLocalAsset(project.projectId)
        if (!asset) return
        const kind = asset.assetType
        if (kind === 'text' || node.type === 'image' && kind !== 'image' || voiceChange && kind !== 'audio') {
          throw new Error(voiceChange ? '变声模型需要音频参考。' : '图片节点仅接受图片参考；视频节点可选择图片、视频或音频参考。')
        }
        setLocalRefs((prev) => [
          ...prev,
          {
            id: `local-${asset.assetId}`,
            sourceNodeId: '',
            kind,
            label: asset.name || (kind === 'video' ? '视频参考' : kind === 'audio' ? '音频参考' : '图片参考'),
            url: `vibe://app/assets/${asset.assetId}`,
            local: true,
          },
        ])
        return
      }
      if (!file) return
      const canvasId = useCanvasStore.getState().canvas?.canvas.id
      const asset = (await uploadAsset(file, undefined, canvasId, node.id)) as {
        id?: Id
        url?: string
        name?: string
        assetType?: string
      }
      const kind = (asset.assetType === 'video' || asset.assetType === 'audio' || asset.assetType === 'text'
        ? asset.assetType
        : 'image') as UpstreamRef['kind']
      setLocalRefs((prev) => [
        ...prev,
        {
          id: `local-${sid(asset.id ?? crypto.randomUUID())}`,
          sourceNodeId: '',
          kind,
          label: asset.name || '上传',
          url: asset.url,
          local: true,
        },
      ])
      toastSuccess('参考已添加')
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const doSubmit = async () => {
    if (desktopMode && (desktopCatalogError || !selectedModel)) {
      setErr(desktopCatalogError instanceof Error ? desktopCatalogError.message : '所选模型已不可用，请重新选择或配置模型。')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const { submitNodeTask } = await import('./taskActions')
      const referenceParameters = buildMediaReferenceParameters(refsForUi, node.type, desktopMode)
      const refTexts = referenceParameters.referenceTexts
      const trimmedPrompt = stripLegacyReferenceFidelity(prompt)
      const effectivePrompt =
        trimmedPrompt && refTexts.length
          ? `${refTexts.join('\n')}\n\n${trimmedPrompt}`
          : trimmedPrompt || refTexts.join('\n')
      if (!effectivePrompt.trim() && !(desktopMode && selectedDesktopModel?.operation === 'voice-change' && refsForUi.some((ref) => ref.kind === 'audio' && ref.url))) {
        setErr('请填写提示词或添加参考')
        setBusy(false)
        return
      }
      const resolutionParameters = resolveNodeResolution(node.type, selectedModel, selectedResKey, desktopMode, effectiveAspect)
      const outputCount = (isSplitLayout && node.type === 'text') || (desktopMode && node.type === 'image') ? count : 1
      if (desktopMode && node.type === 'image' && outputCount > maximumOutputs) throw new Error(`所选模型最多生成 ${maximumOutputs} 张图片，请调整数量。`)
      if (desktopMode) {
        const mediaRefs = refsForUi.filter((ref) => Boolean(ref.url) && ['image', 'video', 'audio'].includes(ref.kind))
        const unsupportedRef = mediaRefs.find((ref) => !selectedDesktopModel?.inputModes.includes(ref.kind))
        if (unsupportedRef) throw new Error(`所选模型尚未适配${unsupportedRef.kind === 'image' ? '图片' : unsupportedRef.kind === 'video' ? '视频' : '音频'}参考输入。`)
        if (selectedDesktopModel?.providerId === 'volcengine-ark'
          && mediaRefs.some((ref) => (ref.kind === 'video' || ref.kind === 'audio') && ref.url?.startsWith('vibe://'))) {
          throw new Error('火山方舟需要可访问的 HTTPS 视频/音频地址；本地参考尚无供应商上传链，未发送本地文件。')
        }
      }
      const audioParams = desktopMode && node.type === 'audio' && !isMusicModel
        ? {
            ...(voiceId ? { voiceId } : {}),
            ...(typeof node.params.voice === 'string' && node.params.voice ? { voice: node.params.voice } : {}),
            ...(typeof node.params.language === 'string' && node.params.language ? { language: node.params.language } : {}),
            ...(typeof node.params.speed === 'number' ? { speed: node.params.speed } : {}),
            ...(typeof node.params.tone === 'string' && node.params.tone ? { tone: node.params.tone } : {}),
          }
        : {}
      await submitNodeTask(
        node.id,
        model || preferred || node.type,
        {
          // References are supplied as separate model inputs. Never append
          // hidden fidelity instructions to the creator's prompt.
          prompt: effectivePrompt,
          ...(desktopMode ? selectedModel?.defaultParams ?? {} : {}),
          ...(desktopMode && node.type === 'video' ? { duration, ...(supportsAudioOption ? { generate_audio: generateAudio } : {}) } : {}),
          ...resolutionParameters,
          ...(!desktopMode || node.type === 'image' || node.type === 'video' ? { aspect: effectiveAspect, ...(desktopMode && effectiveAspect ? { ratio: effectiveAspect } : {}) } : {}),
          style,
          camera,
          count: outputCount,
          ...referenceParameters,
          ...audioParams,
          ...musicParams,
        },
        10,
        {
          providerType: selectedDesktopModel?.providerType ?? (selectedModel?.provider === 'local' ? 'local' : 'cloud'),
          ...(selectedDesktopModel?.providerType !== 'local' && selectedDesktopModel?.providerId
            ? { providerId: selectedDesktopModel.providerId, modelId: selectedModel?.name }
            : {}),
        },
      )
      const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
      useCanvasStore.getState().updateNodePayload(node.id, {
        params: {
          ...(current?.params ?? node.params),
          prompt: trimmedPrompt || effectivePrompt,
          model: model || preferred,
          ...musicParams,
          ...(desktopMode && node.type === 'video' ? { duration, generate_audio: generateAudio } : {}),
          ...resolutionParameters,
          aspect: effectiveAspect,
          ...(desktopMode ? { ratio: effectiveAspect } : {}),
          style,
          camera,
          count: outputCount,
          ...audioParams,
        },
      })
      toastSuccess('生成任务已提交')
    } catch (e) {
      const message = (e as Error).message
      setErr(message)
      if (/点数不足|INSUFFICIENT/i.test(message)) {
        window.dispatchEvent(new CustomEvent('vp-open-subscription'))
      }
    } finally {
      setBusy(false)
    }
  }

  const isSplitLayout = layout === 'text' || layout === 'split'
  const refTitle = node.type === 'video' ? '首尾帧' : '参考'
  const promptPlaceholder =
    node.type === 'video'
      ? '描述你要生成的视频内容…'
      : node.type === 'text'
        ? '旧句未歇纸上，新意已在心间'
        : node.type === 'audio'
          ? desktopMode ? audioMode === 'speech' ? '输入需要朗读的文字…' : '描述曲风、情绪、乐器与场景，例如：夏日公路旅行的轻快华语流行，木吉他与明亮鼓点' : '描述你要生成的音频内容…'
          : '墨痕未落纸上，山水已在眼前'

  const addTextReference = (text: string) => {
    if (!text.trim()) return
    setLocalRefs((prev) => [
      ...prev,
      {
        id: `local-text-${crypto.randomUUID()}`,
        sourceNodeId: '',
        kind: 'text',
        label: '文本',
        text,
        local: true,
      },
    ])
  }

  const addRemoteMediaReference = (kind: 'video' | 'audio', value: string) => {
    let normalizedUrl: string
    try {
      normalizedUrl = normalizeRemoteMediaReferenceUrl(value)
    } catch (error) {
      toastError(error instanceof Error ? error.message : '参考地址无效。')
      return
    }
    setLocalRefs((prev) => [...prev, {
      id: `remote-${kind}-${crypto.randomUUID()}`,
      sourceNodeId: '',
      kind,
      label: `${kind === 'video' ? '视频' : '音频'} HTTPS 参考`,
      url: normalizedUrl,
      local: true,
    }])
  }

  const desktopReferencePrompt = desktopReferencePromptOpen === 'text' ? (
    <DesktopTextReferencePrompt
      onCancel={() => setDesktopReferencePromptOpen(null)}
      onSubmit={(text) => {
        addTextReference(text)
        setDesktopReferencePromptOpen(null)
      }}
    />
  ) : desktopReferencePromptOpen === 'video-url' || desktopReferencePromptOpen === 'audio-url' ? (
    <DesktopMediaUrlReferencePrompt
      kind={desktopReferencePromptOpen === 'video-url' ? 'video' : 'audio'}
      onCancel={() => setDesktopReferencePromptOpen(null)}
      onSubmit={(url) => {
        addRemoteMediaReference(desktopReferencePromptOpen === 'video-url' ? 'video' : 'audio', url)
        setDesktopReferencePromptOpen(null)
      }}
    />
  ) : null

  const refSection = (
    <>
      <p className="mb-1.5 text-[12px] font-bold text-[#333]">{refTitle}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label
          title={desktopMode
            ? node.type === 'image'
              ? '添加本地图片参考；云端生成会向所选模型供应商发送参考图片。'
              : node.type === 'video'
                ? '视频节点可选本地图片、视频或音频；当前只有本地图片可直接发送，视频和音频需使用 Ark 可访问的 HTTPS 地址。'
                : selectedDesktopModel?.operation === 'voice-change'
                  ? '添加本地参考音频；变声生成会向 ElevenLabs 发送该音频。'
                  : '当前模型不支持上传媒体参考。'
            : '上传参考媒体'}
          aria-label="添加参考媒体"
          role={desktopMode ? 'button' : undefined}
          tabIndex={desktopMode ? 0 : undefined}
          onClick={desktopMode ? (event) => { event.preventDefault(); void onUploadRef() } : undefined}
          onKeyDown={desktopMode ? (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              void onUploadRef()
            }
          } : undefined}
          className={`flex h-14 w-14 flex-col items-center justify-center rounded-xl bg-[#f0f0f2] text-[#888] ring-1 ring-black/6 ${desktopMode ? ['image', 'video'].includes(node.type) || selectedDesktopModel?.operation === 'voice-change' ? 'cursor-pointer hover:bg-[#e8e8ec]' : 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-[#e8e8ec]'}`}
        >
          <ArrowUpFromLine size={16} />
          <input
            type="file"
            accept={node.type === 'video' ? 'image/*,video/*,audio/*' : 'image/*,video/*,audio/*,text/*'}
            className="hidden"
            disabled={desktopMode}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onUploadRef(f)
            }}
          />
        </label>
        {desktopMode && node.type === 'video' && (
          <>
            <button type="button" title="添加 Ark 可访问的 HTTPS 视频参考" onClick={() => setDesktopReferencePromptOpen('video-url')}
              className="flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-xl bg-[#f0f0f2] text-[9px] font-semibold text-[#777] ring-1 ring-black/6 hover:bg-[#e8e8ec]">
              <Link2 size={15} />视频 URL
            </button>
            <button type="button" title="添加 Ark 可访问的 HTTPS 音频参考" onClick={() => setDesktopReferencePromptOpen('audio-url')}
              className="flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-xl bg-[#f0f0f2] text-[9px] font-semibold text-[#777] ring-1 ring-black/6 hover:bg-[#e8e8ec]">
              <Link2 size={15} />音频 URL
            </button>
          </>
        )}
        {node.type !== 'video' && (
          <button
            type="button"
            title="添加文本参考"
            onClick={() => {
              if (desktopMode) {
                setDesktopReferencePromptOpen('text')
                return
              }
              const t = window.prompt('输入参考文本')
              if (!t) return
              addTextReference(t)
            }}
            className="flex h-14 w-14 flex-col items-center justify-center rounded-xl bg-[#f0f0f2] text-[#888] ring-1 ring-black/6 hover:bg-[#e8e8ec]"
          >
            <Type size={16} />
          </button>
        )}

        {(refsForUi.length > 0 || node.type === 'video') && (
          <div className="mx-0.5 h-10 w-px shrink-0 bg-black/10" />
        )}

        {node.type === 'video' ? (
          <>
            {firstFrame ? (
              <RefThumb
                url={firstFrame.url}
                kind={firstFrame.kind}
                label="首帧"
                onRemove={() => removeRef(firstFrame as LocalRef)}
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-black/15 text-[10px] font-bold text-[#bbb]">
                首帧
              </div>
            )}
            <button
              type="button"
              title="交换首尾帧"
              onClick={() => setFrameOrder((v) => (v === 'asc' ? 'swap' : 'asc'))}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-black/[0.05] text-[#555]"
            >
              <ArrowLeftRight size={14} />
            </button>
            {lastFrame ? (
              <RefThumb
                url={lastFrame.url}
                kind={lastFrame.kind}
                label="尾帧"
                onRemove={() => removeRef(lastFrame as LocalRef)}
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-black/15 text-[10px] font-bold text-[#bbb]">
                尾帧
              </div>
            )}
            {refsForUi
              .filter((r) => desktopMode
                ? r.kind !== 'image'
                : r.kind === 'text' || r.kind === 'audio')
              .map((r) => (
                <RefThumb
                  key={r.id}
                  url={r.url}
                  kind={r.kind}
                  text={r.text}
                  label={r.label}
                  onRemove={() => removeRef(r)}
                />
              ))}
          </>
        ) : (
          refsForUi.map((r) => (
            <RefThumb
              key={r.id}
              url={r.url}
              kind={r.kind}
              text={r.text}
              label={r.label}
              onRemove={() => removeRef(r)}
            />
          ))
        )}
        {refsForUi.length === 0 && node.type !== 'video' && (
          <span className="text-[11px] text-[#aaa]">连接上游节点后自动出现在此</span>
        )}
      </div>
    </>
  )

  const promptField = (
    <textarea
      ref={promptRef}
      className={
        isSplitLayout
          ? 'min-h-[220px] w-full resize-none rounded-xl border border-black/10 bg-white px-3.5 py-3 text-[13px] leading-relaxed text-[#222] outline-none placeholder:text-[#b0b0b8]'
          : 'min-h-[88px] w-full resize-none bg-white px-1 py-1 text-[13px] leading-relaxed text-[#222] outline-none placeholder:text-[#b0b0b8]'
      }
      value={prompt}
      placeholder={promptPlaceholder}
      onChange={(e) => persistPrompt(e.target.value)}
    />
  )

  const darkFooter = isSplitLayout && !desktopMode
  const splitCtrl = darkFooter
    ? 'h-8 rounded-lg bg-white/10 px-2 text-[11px] font-bold text-white/90 outline-none'
    : 'h-8 rounded-lg bg-black/[0.04] px-2 text-[11px] font-bold text-[#555] outline-none'
  const configureModels = () => navigate('/settings/providers', { state: { returnTo: window.location.pathname } })
  const audioTabs = desktopMode && node.type === 'audio' && (
    <div className="flex items-center gap-2" role="tablist" aria-label="音频创作模式">
      {([{ value: 'speech', label: '文字转语音', Icon: FileText }, { value: 'music', label: '音乐生成', Icon: Music2 }] as const).map(({ value, label, Icon }) => (
        <button key={value} type="button" role="tab" aria-selected={audioMode === value}
          onClick={() => chooseDesktopAudioMode(value)}
          className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] ${audioMode === value ? 'bg-[#111] text-white' : 'text-[#777] hover:bg-black/[0.04]'}`}>
          <Icon size={15} />{label}
        </button>
      ))}
    </div>
  )
  const lyricsField = isMusicModel && lyricsMode === 'manual' && (
    <label className="flex flex-col gap-1.5 text-[12px] text-[#777]">歌词
      <textarea aria-label="歌词" value={lyrics} onChange={(event) => changeLyrics(event.target.value)}
        placeholder="输入歌词，可用 [Verse]、[Chorus] 标记段落…"
        className="min-h-[100px] w-full resize-none rounded-xl border border-black/10 bg-[#fafafa] px-3.5 py-3 text-[13px] text-[#222] outline-none" />
    </label>
  )
  const footerBar = (
    <div className={isSplitLayout
      ? `flex flex-wrap items-center gap-1.5 rounded-b-[20px] px-3.5 py-2.5 ${darkFooter ? 'border-t border-white/10 bg-[#1a1a1a]' : 'bg-white'}`
      : 'flex flex-wrap items-center gap-1.5 border-t border-black/6 pt-2'}>
      <ModelPicker dark={darkFooter} compact={!isSplitLayout}
        className={isSplitLayout ? 'min-w-[120px] max-w-[210px] flex-[1_1_140px]' : 'max-w-[200px]'}
        models={typeModels} value={model || preferred || ''}
        desktopProviderNames={desktopMode ? desktopCatalog.providerNames : undefined}
        onConfigureModels={desktopMode ? configureModels : undefined}
        onChange={applyDesktopModel} />
      {desktopMode && (node.type === 'image' || node.type === 'video') && (
        <MediaSpecificationPicker mediaType={node.type} aspect={effectiveAspect} aspectOptions={effectiveAspectOptions}
          resolution={selectedResKey} resolutionOptions={resolutionOptions}
          duration={node.type === 'video' ? duration : undefined} durationCapability={durationCapability}
          onAspectChange={changeAspect} onResolutionChange={changeResolution} onDurationChange={changeDuration} />
      )}
      {!desktopMode && (node.type === 'image' || node.type === 'video') && (
        <>
          {isSplitLayout ? <SplitFooterSelect value={effectiveAspect} options={effectiveAspectOptions.map((value) => ({ value, label: value }))} onChange={changeAspect} />
            : <select className={splitCtrl} aria-label="比例" value={effectiveAspect} onChange={(event) => changeAspect(event.target.value)}>{effectiveAspectOptions.map((value) => <option key={value}>{value}</option>)}</select>}
          {isSplitLayout ? <SplitFooterSelect value={selectedResKey} options={resolutionKeys.map((value) => ({ value, label: value }))} onChange={setResKey} />
            : <select className={splitCtrl} aria-label="分辨率" value={selectedResKey} onChange={(event) => setResKey(event.target.value)}>{resolutionKeys.map((value) => <option key={value}>{value}</option>)}</select>}
        </>
      )}
      {(node.type === 'image' || node.type === 'video') && !isSplitLayout && (
        <select className={`${splitCtrl} max-w-[100px]`} aria-label="风格" value={STYLE_PRESETS.includes(style) ? style : style ? '__custom__' : ''}
          onChange={(event) => setStyle(event.target.value === '__custom__' ? style || '自定义' : event.target.value)}>
          <option value="">风格</option>{STYLE_PRESETS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      )}
      {node.type === 'video' && !isSplitLayout && (
        <select className={splitCtrl} aria-label="运镜" value={camera} onChange={(event) => setCamera(event.target.value)}>
          <option value="">运镜</option>{['推近', '拉远', '左移', '右移', '环绕', '升降'].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      )}
      {desktopMode && node.type === 'video' && supportsAudioOption && (
        <label className="flex items-center gap-1 text-[11px] text-[#777]">
          <input type="checkbox" checked={generateAudio} onChange={(event) => {
            setGenerateAudio(event.target.checked); persistNodeParams({ generate_audio: event.target.checked })
          }} />音频
        </label>
      )}
      {desktopMode && node.type === 'audio' && audioMode === 'speech' && (
        voiceOptions.length ? <PortalChoiceSelect value={voiceId || voiceOptions[0].id} label="音色"
          options={voiceOptions.map(({ id, label }) => ({ value: id, label }))} onChange={changeVoice} />
          : selectedDesktopModel?.providerId !== 'local-sapi-tts' && <button type="button" onClick={configureModels}
              title="使用此模型在提供方设置中配置的音色" className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[#777] hover:bg-black/[0.04]">
              <Settings2 size={13} />音色设置
            </button>
      )}
      {isMusicModel && <PortalChoiceSelect<MusicLyricsMode> value={lyricsMode} label="歌词模式" onChange={changeLyricsMode}
        options={[{ value: 'auto', label: '自动写词' }, { value: 'manual', label: '自定义歌词' }, { value: 'instrumental', label: '纯音乐' }]} />}
      <div className="ml-auto flex items-center gap-1.5">
        {isSplitLayout && (node.type === 'text' || desktopMode && node.type === 'image') && (
          <div className={`flex shrink-0 overflow-hidden rounded-full p-0.5 ${darkFooter ? 'bg-white/10' : 'bg-[#f0f0f2]'}`}>
            {(desktopMode && node.type === 'image' ? [1, 2, 4].filter((value) => value <= maximumOutputs) : [1, 2, 4]).map((value) => (
              <button key={value} type="button" onClick={() => { setCount(value); persistNodeParams({ count: value }) }}
                className={`rounded-full px-2.5 py-1.5 text-[11px] font-bold ${count === value ? darkFooter ? 'bg-white text-[#111]' : 'bg-[#111] text-white' : darkFooter ? 'text-white/70' : 'text-[#777]'}`}>
                {value}x
              </button>
            ))}
          </div>
        )}
        {latest?.status === 'succeeded' && <Check size={14} className="text-emerald-600" />}
        {(err || desktopMode && (desktopCatalogError || model && !selectedModel)) && (
          <span role="alert" title={err} className={`max-w-[170px] text-[10px] font-semibold ${darkFooter ? 'text-red-300' : 'text-red-600'}`}>
            {err || (desktopCatalogError instanceof Error ? desktopCatalogError.message : '所选模型已不可用，请重新选择或配置模型。')}
          </span>
        )}
        <button type="button" disabled={busy || !(model || preferred) || !typeModels.length || desktopMode && (!selectedModel || Boolean(desktopCatalogError))}
          onClick={() => void doSubmit()} title="生成"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl hover:opacity-90 disabled:opacity-40 ${darkFooter ? 'bg-white/20 text-white' : 'bg-[#111] text-white'}`}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <span className="text-[20px] leading-none">→</span>}
        </button>
      </div>
    </div>
  )

  if (isSplitLayout) {
    return (
      <>
        <div className="nodrag nowheel flex flex-col rounded-[20px]" onMouseDown={(e) => e.stopPropagation()}>
          <div className="flex flex-col gap-3 p-4">
            {audioTabs}
            {!(desktopMode && node.type === 'audio') && refSection}
            {isMusicModel && <p className="text-[12px] text-[#777]">描述曲风</p>}
            {promptField}
            {lyricsField}
          </div>
          {footerBar}
        </div>
        {desktopReferencePrompt}
      </>
    )
  }

  return (
    <>
      <div className="nodrag nowheel flex flex-col gap-3" onMouseDown={(e) => e.stopPropagation()}>
        {audioTabs}
        {/* 参考区：与提示词框分开的独立展示框 */}
        {!(desktopMode && node.type === 'audio') && <div className="rounded-xl border border-black/10 bg-white p-2.5">{refSection}</div>}

        {/* 提示词框：与参考区视觉上分离 */}
        <div className="rounded-xl border border-black/10 bg-white p-2.5">
          <p className="mb-1.5 text-[12px] font-bold text-[#333]">提示词</p>
          {promptField}
        </div>

        {lyricsField}
        {footerBar}
      </div>
      {desktopReferencePrompt}
    </>
  )
}

/** 供节点视图同步上游 URL（写入 params 便于生成） */
export function syncUpstreamIntoParams(nodeId: Id, refs: UpstreamRef[]) {
  const node = useCanvasStore.getState().nodes.find((n) => sid(n.id) === sid(nodeId))?.data.node
  if (!node) return
  const urls = refs.map((r) => r.url).filter(Boolean)
  useCanvasStore.getState().updateNodePayload(nodeId, {
    params: {
      ...node.params,
      upstreamRefs: refs.map((r) => ({
        nodeId: r.sourceNodeId,
        kind: r.kind,
        url: r.url,
        text: r.text,
      })),
      referenceUrls: urls,
    },
  })
}

export function getNodeMediaFromStore(node: FlowNode, latest?: GenerationTask | null): string | undefined {
  return (
    resolveMediaUrl(latest?.outputs?.[0]?.url, latest?.outputs?.[0]?.meta as Record<string, unknown>) ||
    (node.data.node.params.url as string) ||
    (node.data.node.params.thumbnailUrl as string) ||
    undefined
  )
}
