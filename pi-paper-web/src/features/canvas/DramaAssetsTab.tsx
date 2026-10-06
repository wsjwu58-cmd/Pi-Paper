import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { DramaAuditPanel } from './DramaAuditPanel'
import { DramaProductionPanel } from './DramaProductionPanel'

type DramaAssetType =
  | 'series_bible'
  | 'episode'
  | 'scene'
  | 'character_profile'
  | 'character_look'
  | 'shot_spec'
  | 'continuity_constraint'
  | 'audio_cue'
  | 'subtitle_cue'

interface DramaAsset {
  assetId: string | number
  assetType: DramaAssetType
  assetVersion: number
  canvasVersion: number
  currentCanvasVersion: number
  data: Record<string, unknown>
  updatedAt?: string
}

const ASSET_OPTIONS: Array<{ value: DramaAssetType; label: string }> = [
  { value: 'series_bible', label: '故事圣经' },
  { value: 'episode', label: '剧集' },
  { value: 'scene', label: '场景' },
  { value: 'character_profile', label: '角色档案' },
  { value: 'character_look', label: '角色 Look' },
  { value: 'shot_spec', label: '镜头规格' },
  { value: 'continuity_constraint', label: '连续性约束' },
  { value: 'audio_cue', label: '音频提示' },
  { value: 'subtitle_cue', label: '字幕' },
]

const TEMPLATES: Record<DramaAssetType, Record<string, unknown>> = {
  series_bible: { premise: '', worldRules: [], canonVersion: 1, defaultRatio: '9:16' },
  episode: { episodeNo: 1, goal: '', hook: '', title: '' },
  scene: { sceneOrder: 1, goal: '', setting: '', conflict: '', dialogue: [] },
  character_profile: { name: '', identityAnchor: '', staticTraits: [], dynamicState: {} },
  character_look: { characterId: '', version: 1, costume: '', hair: '', referenceAssetIds: [] },
  shot_spec: { shotNo: 1, purpose: '', duration: 2, camera: '', screenDirection: '', ratio: '9:16' },
  continuity_constraint: { subject: '', rule: '', scope: 'scene', severity: 'must' },
  audio_cue: { text: '', kind: 'dialogue', startMs: 0, durationMs: 0 },
  subtitle_cue: { text: '', startMs: 0, endMs: 1000, language: 'zh-CN' },
}

function stringify(data: Record<string, unknown>) {
  return JSON.stringify(data, null, 2)
}

function idempotencyKey() {
  return `drama-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

export function DramaAssetsTab({
  canvasId,
  canvasVersion,
  desktop = false,
  onBack,
}: {
  canvasId?: string | number
  canvasVersion?: number
  desktop?: boolean
  onBack: () => void
}) {
  const [items, setItems] = useState<DramaAsset[]>([])
  const [assetType, setAssetType] = useState<DramaAssetType>('series_bible')
  const [editing, setEditing] = useState<DramaAsset | null>(null)
  const [rawData, setRawData] = useState(() => stringify(TEMPLATES.series_bible))
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [writeCanvasVersion, setWriteCanvasVersion] = useState(canvasVersion)

  useEffect(() => {
    setWriteCanvasVersion(canvasVersion)
  }, [canvasId, canvasVersion])

  const assetLabel = useMemo(
    () => Object.fromEntries(ASSET_OPTIONS.map((option) => [option.value, option.label])) as Record<DramaAssetType, string>,
    [],
  )

  const refresh = async () => {
    if (canvasId == null) return
    setLoading(true)
    try {
      const result = await api<{ items: DramaAsset[] }>(`/canvases/${canvasId}/drama-assets`)
      setItems(result.items ?? [])
    } catch (error) {
      toastError((error as Error).message || '读取短剧资产失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  // canvasVersion changes after a successful asset write/refetch; load the new snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId, canvasVersion])

  const resetEditor = (nextType: DramaAssetType = assetType) => {
    setEditing(null)
    setAssetType(nextType)
    setRawData(stringify(TEMPLATES[nextType]))
  }

  const save = async () => {
    if (canvasId == null || writeCanvasVersion == null) {
      toastError('画布尚未加载完成，无法保存短剧资产')
      return
    }
    let data: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(rawData)
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('资产内容必须是 JSON 对象')
      data = parsed as Record<string, unknown>
    } catch (error) {
      toastError((error as Error).message || '资产 JSON 格式无效')
      return
    }
    setSaving(true)
    try {
      const saved = await api<DramaAsset>(`/canvases/${canvasId}/drama-assets`, {
        method: 'POST',
        idempotencyKey: idempotencyKey(),
        body: JSON.stringify({
          assetType,
          assetId: editing?.assetId,
          canvasVersion: writeCanvasVersion,
          data,
        }),
      })
      if (Number.isSafeInteger(saved.currentCanvasVersion)) setWriteCanvasVersion(saved.currentCanvasVersion)
      toastSuccess(editing ? '短剧资产已更新' : '短剧资产已创建')
      resetEditor(assetType)
      window.dispatchEvent(new Event('vp-agent-executed'))
      await refresh()
    } catch (error) {
      toastError((error as Error).message || '保存短剧资产失败')
    } finally {
      setSaving(false)
    }
  }

  if (canvasId == null) {
    return <div className="flex-1 p-4 text-[12px] text-[#888]">请在已加载的画布中使用短剧项目资产。</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--canvas-surface)]">
      <div className="flex items-center justify-between border-b border-black/8 px-4 py-3">
        <div>
          <p className="text-[13px] font-bold text-[#111]">短剧项目资产</p>
          <p className="mt-0.5 text-[11px] text-[#888]">{desktop ? '结构化数据按画布版本保存在当前本地项目' : '结构化数据由画布服务版本化保存'}</p>
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={() => void refresh()} title="刷新" className="rounded-lg p-2 text-[#666] hover:bg-black/5">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button type="button" onClick={onBack} className="rounded-lg px-2 py-1 text-[12px] font-semibold text-[#444] hover:bg-black/5">
            返回对话
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <label className="block text-[12px] font-semibold text-[#555]">
          资产类型
          <select
            value={assetType}
            onChange={(event) => resetEditor(event.target.value as DramaAssetType)}
            disabled={Boolean(editing)}
            className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-[12px] disabled:opacity-60"
          >
            {ASSET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <div className="mt-3 flex items-center justify-between">
          <p className="text-[12px] font-semibold text-[#555]">{editing ? `编辑 ${assetLabel[assetType]} v${editing.assetVersion}` : `新建${assetLabel[assetType]}`}</p>
          {editing ? <button type="button" onClick={() => resetEditor(assetType)} className="text-[11px] font-semibold text-[#666] underline">取消编辑</button> : null}
        </div>
        <textarea
          value={rawData}
          onChange={(event) => setRawData(event.target.value)}
          spellCheck={false}
          className="mt-1.5 h-48 w-full resize-y rounded-lg border border-black/10 bg-[#fbfbfb] p-2 font-mono text-[11px] leading-relaxed text-[#333] outline-none focus:border-black/30"
          aria-label="短剧资产 JSON"
        />
        <p className="mt-1 text-[10px] leading-relaxed text-[#888]">保存时会校验必填字段、画布版本和幂等键；版本冲突后请刷新画布再试。</p>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="mt-2 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-[#111] text-[12px] font-bold text-white disabled:opacity-60"
        >
          <Plus size={14} />{saving ? '保存中…' : editing ? '保存更新' : '创建资产'}
        </button>

        <div className="mt-5">
          <p className="mb-2 text-[12px] font-bold text-[#333]">当前资产（{items.length}）</p>
          {loading && items.length === 0 ? <p className="text-[12px] text-[#888]">正在加载…</p> : null}
          {!loading && items.length === 0 ? <p className="text-[12px] text-[#888]">尚未创建结构化短剧资产。</p> : null}
          <div className="space-y-2">
            {items.map((item) => (
              <article key={String(item.assetId)} className="rounded-xl border border-black/8 bg-white p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[12px] font-bold text-[#222]">{assetLabel[item.assetType]} <span className="font-normal text-[#888]">v{item.assetVersion}</span></p>
                    <p className="mt-1 line-clamp-2 break-words text-[11px] leading-relaxed text-[#666]">{JSON.stringify(item.data)}</p>
                  </div>
                  <button
                    type="button"
                    title="编辑资产"
                    onClick={() => {
                      setEditing(item)
                      setAssetType(item.assetType)
                      setRawData(stringify(item.data))
                    }}
                    className="shrink-0 rounded-lg p-1.5 text-[#666] hover:bg-black/5"
                  >
                    <Pencil size={13} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
        <DramaProductionPanel canvasId={canvasId} desktop={desktop} />
        <DramaAuditPanel canvasId={canvasId} desktop={desktop} />
      </div>
    </div>
  )
}
