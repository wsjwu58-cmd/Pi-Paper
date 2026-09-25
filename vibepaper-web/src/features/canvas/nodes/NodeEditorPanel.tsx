import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeftRight,
  ArrowUpFromLine,
  Check,
  Crop,
  Download,
  Expand,
  Film,
  Library,
  Loader2,
  Maximize2,
  Ratio,
  Scan,
  Type,
  X,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { uploadAsset } from '@/lib/api'
import { resolveMediaUrl, useAuthedMediaUrl } from '@/lib/media'
import { sid } from '@/lib/ids'
import type { GenerationTask, Id, ModelInfo, NodePayload } from '@/lib/types'
import type { DesktopLocalAudioModel } from '@/desktop/desktop-bridge'
import { ModelPicker } from '@/components/ui/ModelPicker'
import { useCanvasStore, type FlowNode } from '../canvasStore'
import { isDesktopRuntime } from '../canvasPort'
import { toastError, toastSuccess } from '@/components/ui/Toast'

const STYLE_PRESETS = ['赛博朋克', '水彩', '写实', '动漫', '电影感', '产品渲染', '三视图']
const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4']
const RES_MAP: Record<string, string> = {
  '1K': '1024x1024',
  '2K': '2048x2048',
  '4K': '3840x2160',
}

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

/** 读取连入当前节点的上游素材（有效连线优先） */
export function useUpstreamRefs(nodeId: string): UpstreamRef[] {
  const nid = sid(nodeId)
  // 用签名订阅，避免数组引用导致无更新 / 过度渲染
  const signature = useCanvasStore((s) => {
    const parts: string[] = []
    for (const e of s.edges) {
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
  onFullscreen,
}: {
  node: NodePayload
  models: ModelInfo[]
  mediaUrl?: string
  onSaveToLibrary?: () => void
  onFullscreen?: () => void
}) {
  const desktopMode = isDesktopRuntime()
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<'crop' | 'upscale' | 'three' | null>(null)
  const imageModel =
    models.find((m) => m.modelType === 'image' && /agnes-image/i.test(m.name))?.name ??
    models.find((m) => m.modelType === 'image' && /agnes|seedream/i.test(m.name))?.name ??
    models.find((m) => m.modelType === 'image')?.name
  const videoModel =
    models.find((m) => m.modelType === 'video' && /agnes-video/i.test(m.name))?.name ??
    models.find((m) => m.modelType === 'video' && /agnes|seedance/i.test(m.name))?.name ??
    models.find((m) => m.modelType === 'video')?.name

  const runOp = async (op: string, extra: Record<string, unknown> = {}) => {
    if (busy) return
    if (desktopMode) {
      toastError('桌面本地尚未接入裁剪、扩图、超分和视频剪辑工具。')
      return
    }
    setBusy(true)
    try {
      const { submitNodeTask } = await import('./taskActions')
      const model = node.type === 'video' ? videoModel : imageModel
      if (!model) throw new Error('无可用模型')
      await submitNodeTask(node.id, model, { operation: op, count: 1, sourceUrl: mediaUrl, ...extra }, 8)
      toastSuccess(`${op}已提交`)
      setMenu(null)
    } catch (e) {
      toastError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (node.type !== 'image' && node.type !== 'video') return null

  return (
    <div
      className="nodrag absolute left-1/2 top-0 z-30 flex -translate-x-1/2 -translate-y-[calc(100%+8px)] items-center gap-0.5 rounded-2xl border border-black/8 bg-white px-1.5 py-1 shadow-[0_8px_28px_rgba(15,23,42,0.14)]"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {node.type === 'image' && (
        <>
          <ToolIcon title={desktopMode ? '桌面本地未接入：裁剪' : '裁剪'} disabled={desktopMode} active={menu === 'crop'} onClick={() => setMenu(menu === 'crop' ? null : 'crop')}>
            <Crop size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地未接入：扩图' : '扩图'} disabled={desktopMode || busy} onClick={() => void runOp('扩图')}>
            <Expand size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地未接入：超分' : '超分'} disabled={desktopMode} active={menu === 'upscale'} onClick={() => setMenu(menu === 'upscale' ? null : 'upscale')}>
            <Scan size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地未接入：三视图' : '三视图'} disabled={desktopMode} active={menu === 'three'} onClick={() => setMenu(menu === 'three' ? null : 'three')}>
            <Ratio size={15} />
          </ToolIcon>
        </>
      )}
      {node.type === 'video' && (
        <>
          <ToolIcon title={desktopMode ? '桌面本地未接入：剪辑' : '剪辑'} disabled={desktopMode} onClick={() => void runOp('剪辑', { start: 0, end: 5 })}>
            <Crop size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地未接入：提帧' : '提帧'} disabled={desktopMode} onClick={() => void runOp('提帧', { frameAt: 1 })}>
            <Film size={15} />
          </ToolIcon>
          <ToolIcon title={desktopMode ? '桌面本地未接入：超分' : '超分'} disabled={desktopMode} onClick={() => void runOp('超分', { resolution: '1920x1080' })}>
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
      {mediaUrl && (
        <a href={mediaUrl} target="_blank" rel="noreferrer" className="flex h-8 w-8 items-center justify-center rounded-xl text-[#444] hover:bg-black/[0.05]" title="下载">
          <Download size={15} />
        </a>
      )}
      {onSaveToLibrary && !desktopMode && (
        <ToolIcon title="存入素材库" onClick={onSaveToLibrary}>
          <Library size={15} />
        </ToolIcon>
      )}
      {desktopMode && (
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
            ['四宫格', '四宫格裁剪'],
            ['九宫格', '九宫格裁剪'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="w-full rounded-lg px-2 py-1.5 text-left text-[12px] font-semibold text-[#444] hover:bg-black/[0.04]"
              onClick={() => void runOp('裁剪', { cropMode: id })}
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
  const nodeId = sid(node.id)
  const desktopMode = Boolean(window.vibepaperDesktop)
  const { data: desktopCatalog = { models: [] as ModelInfo[], localAudio: null as DesktopLocalAudioModel | null }, isFetched: desktopModelsFetched } = useQuery({
    queryKey: ['desktop-node-models'],
    enabled: desktopMode,
    staleTime: 5_000,
    queryFn: async (): Promise<{ models: ModelInfo[]; localAudio: DesktopLocalAudioModel | null }> => {
      const bridge = window.vibepaperDesktop
      if (!bridge) return { models: [], localAudio: null }
      const [agnesResult, localResult, localAudioResult] = await Promise.allSettled([
        bridge.getAgnesModels(),
        bridge.getLocalTextModel(),
        typeof bridge.getLocalAudioModel === 'function' ? bridge.getLocalAudioModel() : Promise.resolve(null),
      ])
      const available: ModelInfo[] = []
      if (agnesResult.status === 'fulfilled') {
        const catalog = agnesResult.value
        if (catalog.apiKeyConfigured) {
          for (const modality of ['text', 'image', 'video'] as const) {
            const name = catalog.models[modality]
            available.push({
              id: name,
              name,
              modelType: modality,
              displayName: `Agnes · ${modality === 'text' ? '文本' : modality === 'image' ? '图片' : '视频'}（云端）`,
              description: '云端模型。点击生成会发送提示词和文本参考；供应商可能收费。',
              provider: 'agnes',
              enabled: true,
              basePrice: null as unknown as number,
            })
          }
        }
      }
      if (localResult.status === 'fulfilled' && localResult.value) {
        const local = localResult.value
        available.push({
          id: local.modelId,
          name: local.modelId,
          modelType: 'text',
          displayName: `本地 · ${local.modelId}`,
          description: '本地模型，请求留在本机。',
          provider: 'local',
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
          displayName: '本地 · Windows SAPI 离线语音',
          description: 'Windows SAPI 离线语音合成；输入和结果保存在本机。',
          provider: 'local',
          enabled: true,
          basePrice: null as unknown as number,
        })
      }
      return { models: available, localAudio }
    },
  })
  const desktopModels = desktopCatalog.models
  const upstream = useUpstreamRefs(nodeId)
  const excludedIds = useMemo(
    () => new Set(((node.params.excludedRefIds as string[]) ?? []).map(String)),
    [node.params.excludedRefIds],
  )
  const [localRefs, setLocalRefs] = useState<LocalRef[]>([])
  const [desktopReferencePromptOpen, setDesktopReferencePromptOpen] = useState(false)
  const [frameOrder, setFrameOrder] = useState<'asc' | 'swap'>('asc')
  const [prompt, setPrompt] = useState(stripLegacyReferenceFidelity((node.params.prompt as string) ?? ''))
  const [model, setModel] = useState((node.params.model as string) ?? '')
  const [aspect, setAspect] = useState((node.params.aspect as string) || '1:1')
  const [resKey, setResKey] = useState((node.params.resKey as string) || '2K')
  const [style, setStyle] = useState((node.params.style as string) ?? '')
  const [camera, setCamera] = useState((node.params.camera as string) ?? '')
  const [count, setCount] = useState(Number(node.params.count) || 1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const editorModels = desktopMode ? desktopModels : models
  const typeModels = useMemo(
    () =>
      editorModels.filter(
        (m) => m.modelType === node.type && !/兼容别名|已停用/.test(String(m.description || '')),
      ),
    [editorModels, node.type],
  )
  const preferred =
    (desktopMode && node.type === 'text' ? typeModels.find((m) => m.provider === 'local')?.name : undefined) ??
    (desktopMode && node.type === 'audio' ? typeModels.find((m) => m.name === 'local-sapi-tts')?.name : undefined) ??
    typeModels.find((m) => /agnes-image|agnes-video/i.test(m.name))?.name ??
    typeModels.find((m) => /agnes|seedream|seedance/i.test(m.name))?.name ??
    typeModels[0]?.name

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
  }, [node.id, node.params.prompt, node.params.model, preferred, typeModels])

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
    const images = localRefs.filter((r) => r.kind === 'image' || r.kind === 'video')
    if (frameOrder === 'swap' && images.length >= 2) {
      const [a, b, ...rest] = images
      return [b, a, ...rest, ...localRefs.filter((r) => r.kind === 'text' || r.kind === 'audio')]
    }
    return localRefs
  }, [frameOrder, localRefs, node.type])

  const firstFrame = refsForUi.find((r) => r.kind === 'image' || r.kind === 'video')
  const lastFrame = refsForUi.filter((r) => r.kind === 'image' || r.kind === 'video')[1]

  const persistPrompt = (value: string) => {
    setPrompt(value)
    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
    useCanvasStore.getState().updateNodePayload(nodeId, {
      params: { ...(current?.params ?? node.params), prompt: value },
    })
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

  const onUploadRef = async (file: File) => {
    try {
      if (isDesktopRuntime()) {
        throw new Error('桌面本地尚未接入节点参考媒体上传；请使用文本参考或移除媒体连线。')
      }
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
    setBusy(true)
    setErr('')
    try {
      const { submitNodeTask } = await import('./taskActions')
      const refUrls = refsForUi.map((r) => r.url).filter(Boolean)
      const refTexts = refsForUi
        .map((r) => r.text)
        .filter((t): t is string => Boolean(t && String(t).trim()))
      const trimmedPrompt = stripLegacyReferenceFidelity(prompt)
      const effectivePrompt =
        trimmedPrompt && refTexts.length
          ? `${refTexts.join('\n')}\n\n${trimmedPrompt}`
          : trimmedPrompt || refTexts.join('\n')
      if (!effectivePrompt.trim()) {
        setErr('请填写提示词或添加参考')
        setBusy(false)
        return
      }
      const resolution = RES_MAP[resKey] || '1024x1024'
      const outputCount = isSplitLayout && node.type === 'text' ? count : 1
      if (desktopMode && refsForUi.some((ref) => Boolean(ref.url))) {
        throw new Error('桌面本地生成尚未接入图片、视频或音频参考输入。请移除媒体参考后重试。')
      }
      const selectedModel = typeModels.find((item) => item.name === (model || preferred))
      const audioParams = desktopMode && node.type === 'audio'
        ? {
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
          resolution,
          aspect,
          style,
          camera,
          count: outputCount,
          referenceUrls: refUrls,
          referenceImages: refUrls.filter(Boolean),
          referenceTexts: refTexts,
          firstFrameUrl: firstFrame?.url,
          lastFrameUrl: lastFrame?.url,
          imageUrl: firstFrame?.kind === 'image' ? firstFrame.url : undefined,
          upstreamNodeIds: refsForUi.map((r) => r.sourceNodeId).filter(Boolean),
          ...audioParams,
        },
        10,
        { providerType: selectedModel?.provider === 'local' ? 'local' : 'cloud' },
      )
      const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
      useCanvasStore.getState().updateNodePayload(node.id, {
        params: {
          ...(current?.params ?? node.params),
          prompt: trimmedPrompt || effectivePrompt,
          model: model || preferred,
          resolution,
          aspect,
          resKey,
          style,
          camera,
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
          ? '描述你要生成的音频内容…'
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

  const desktopReferencePrompt = desktopReferencePromptOpen && (
    <DesktopTextReferencePrompt
      onCancel={() => setDesktopReferencePromptOpen(false)}
      onSubmit={(text) => {
        addTextReference(text)
        setDesktopReferencePromptOpen(false)
      }}
    />
  )

  const refSection = (
    <>
      <p className="mb-1.5 text-[12px] font-bold text-[#333]">{refTitle}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-14 w-14 cursor-pointer flex-col items-center justify-center rounded-xl bg-[#f0f0f2] text-[#888] ring-1 ring-black/6 hover:bg-[#e8e8ec]">
          <ArrowUpFromLine size={16} />
          <input
            type="file"
            accept={node.type === 'video' ? 'image/*,video/*' : 'image/*,video/*,audio/*,text/*'}
            className="hidden"
            disabled={desktopMode}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onUploadRef(f)
            }}
          />
        </label>
        {desktopMode && (
          <span className="max-w-[180px] text-[10px] leading-relaxed text-[#999]">
            桌面本地未接入节点参考媒体上传；可添加文本参考。
          </span>
        )}
        {node.type !== 'video' && (
          <button
            type="button"
            title="添加文本参考"
            onClick={() => {
              if (desktopMode) {
                setDesktopReferencePromptOpen(true)
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
              .filter((r) => r.kind === 'text' || r.kind === 'audio')
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

  const splitCtrl = isSplitLayout
    ? 'h-8 rounded-lg bg-white/10 px-2 text-[11px] font-bold text-white/90 outline-none'
    : 'h-8 rounded-lg bg-black/[0.04] px-2 text-[11px] font-bold text-[#333]'

  const footerBar = (
    <div
      className={
        isSplitLayout
          ? 'flex items-center gap-2 border-t border-white/10 bg-[#1a1a1a] px-3.5 py-2.5'
          : 'flex flex-wrap items-center gap-1.5 border-t border-black/6 pt-2'
      }
    >
      <ModelPicker
        dark={isSplitLayout}
        compact={!isSplitLayout}
        className="max-w-[200px]"
        models={typeModels}
        value={model || preferred || ''}
        onChange={(v) => {
          setModel(v)
          const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
          useCanvasStore.getState().updateNodePayload(node.id, {
            params: { ...(current?.params ?? node.params), model: v },
          })
        }}
      />
      {desktopMode && (
        <span className={`max-w-[210px] text-[9px] leading-tight ${isSplitLayout ? 'text-white/50' : 'text-[#999]'}`}>
          {node.type === 'audio'
            ? !desktopModelsFetched
              ? '正在检查本地语音模型…'
              : typeModels.some((item) => item.name === 'local-sapi-tts')
              ? 'Windows SAPI 离线语音；输入和结果保存在本机。'
              : desktopCatalog.localAudio?.unavailableReason || 'Windows SAPI 本地语音模型在当前平台不可用。'
            : !desktopModels.length && desktopModelsFetched
              ? '未配置可用模型。请在桌面模型设置中配置本地文本模型或 Agnes API Key。'
              : model || preferred
                ? typeModels.find((item) => item.name === (model || preferred))?.provider === 'local'
                  ? '本地模型，请求留在本机。'
                  : 'Agnes 云端模型；提示词和文本参考会发送至供应商，可能产生费用。'
                : '当前节点类型暂无桌面模型。'}
        </span>
      )}
      {isSplitLayout && node.type === 'text' && (
        <div className="flex shrink-0 overflow-hidden rounded-lg bg-white/10 p-0.5">
          {([1, 2, 4] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setCount(n)}
              className={`rounded-md px-2.5 py-1 text-[10px] font-bold ${
                count === n ? 'bg-white text-[#111]' : 'text-white/70 hover:bg-white/10'
              }`}
            >
              {n}x
            </button>
          ))}
        </div>
      )}
      {isSplitLayout && (node.type === 'image' || node.type === 'video') && (
        <>
          <SplitFooterSelect
            value={aspect}
            options={ASPECTS.map((a) => ({ value: a, label: a }))}
            onChange={setAspect}
            className="max-w-[72px]"
          />
          <SplitFooterSelect
            value={resKey}
            options={Object.keys(RES_MAP).map((k) => ({ value: k, label: k }))}
            onChange={setResKey}
            className="max-w-[56px]"
          />
        </>
      )}
      {(node.type === 'image' || node.type === 'video') && !isSplitLayout && (
        <>
          <select className={splitCtrl} value={aspect} onChange={(e) => setAspect(e.target.value)}>
            {ASPECTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select className={splitCtrl} value={resKey} onChange={(e) => setResKey(e.target.value)}>
            {Object.keys(RES_MAP).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select
            className={`${splitCtrl} max-w-[100px]`}
            value={STYLE_PRESETS.includes(style) ? style : style ? '__custom__' : ''}
            onChange={(e) => {
              const v = e.target.value === '__custom__' ? style || '自定义' : e.target.value
              setStyle(v)
            }}
          >
            <option value="">风格</option>
            {STYLE_PRESETS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </>
      )}
      {node.type === 'video' && !isSplitLayout && (
        <select className={splitCtrl} value={camera} onChange={(e) => setCamera(e.target.value)}>
          <option value="">运镜</option>
          {['推近', '拉远', '左移', '右移', '环绕', '升降'].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {latest?.status === 'succeeded' && (
          <Check size={14} className={isSplitLayout ? 'text-emerald-400' : 'text-emerald-600'} />
        )}
        {err && (
          <span
            className={`max-w-[120px] truncate text-[10px] font-semibold ${isSplitLayout ? 'text-red-300' : 'text-red-600'}`}
          >
            {err}
          </span>
        )}
        <button
          type="button"
          disabled={busy || !(model || preferred) || (desktopMode && node.type === 'audio' && !typeModels.some((item) => item.name === 'local-sapi-tts'))}
          onClick={() => void doSubmit()}
          className={`flex h-9 w-9 items-center justify-center rounded-full hover:opacity-90 disabled:opacity-40 ${
            isSplitLayout ? 'bg-white/20 text-white' : 'bg-[#111] text-white'
          }`}
          title="生成"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <span className="text-[14px] leading-none">→</span>}
        </button>
      </div>
    </div>
  )

  if (isSplitLayout) {
    return (
      <>
        <div className="nodrag nowheel flex flex-col rounded-[20px]" onMouseDown={(e) => e.stopPropagation()}>
          <div className="flex flex-col gap-3 p-4">
            {refSection}
            {promptField}
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
        {/* 参考区：与提示词框分开的独立展示框 */}
        <div className="rounded-xl border border-black/10 bg-white p-2.5">{refSection}</div>

        {/* 提示词框：与参考区视觉上分离 */}
        <div className="rounded-xl border border-black/10 bg-white p-2.5">
          <p className="mb-1.5 text-[12px] font-bold text-[#333]">提示词</p>
          {promptField}
        </div>

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
