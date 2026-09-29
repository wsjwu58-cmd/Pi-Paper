import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'

type ProductionItem = { id: string | number; label: string; status: string; detail: string }
type RenderBatch = {
  id: string | number
  canvasId: string | number
  episodeNo: number
  estimatedCost: number
  status: string
  jobs: Array<{ id: string | number; shotId: string; status: string; taskId?: string; errorCode?: string }>
}

export function DramaProductionPanel({ canvasId, desktop = false }: { canvasId?: string | number; desktop?: boolean }) {
  const [items, setItems] = useState<ProductionItem[]>([])
  const [batches, setBatches] = useState<RenderBatch[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (canvasId == null) return
    setLoading(true)
    setError('')
    try {
      const assetsResult = await api<{ items: Array<{ assetId: string | number; assetType: string; assetVersion: number; data: Record<string, unknown> }> }>(`/canvases/${canvasId}/drama-assets`)
      setItems((assetsResult.items ?? []).map((item) => ({
        id: item.assetId,
        label: `${item.assetType} v${item.assetVersion}`,
        status: typeof item.data.status === 'string' ? item.data.status : 'draft',
        detail: typeof item.data.staleImpact === 'string' ? item.data.staleImpact : '等待上游事实或任务终态',
      })))
      const batchesResult = await api<{ items: RenderBatch[] }>('/drama/render-batches')
      setBatches((batchesResult.items ?? []).filter((batch) => String(batch.canvasId) === String(canvasId)))
    } catch (cause) {
      setError((cause as Error).message || '读取生产链失败')
    } finally {
      setLoading(false)
    }
  }, [canvasId, desktop])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <section className="mt-5 rounded-xl border border-black/8 bg-[#fafafa] p-3" aria-label="短剧生产链">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[12px] font-bold text-[#333]">生产链</p>
          <p className="text-[10px] text-[#888]">关键帧 → 视频 → 音频/字幕 → 合成；stale 只提示局部重跑</p>
        </div>
        <button type="button" onClick={() => void refresh()} title="刷新生产链" className="rounded-lg p-1.5 text-[#666] hover:bg-black/5">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[11px] text-red-700">{error}</p> : null}
      <div className="mt-2 space-y-1.5">
        {items.length === 0 ? <p className="text-[11px] text-[#888]">尚无可追踪制品。</p> : items.map((item) => (
          <div key={String(item.id)} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-1.5 text-[11px]">
            <span className="truncate text-[#444]">{item.label}</span>
            <span className={item.status === 'stale' ? 'text-amber-700' : 'text-[#888]'}>{item.status} · {item.detail}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-black/6 pt-2">
        <p className="text-[10px] font-semibold text-[#666]">视频渲染批次</p>
        {desktop ? (
          <p role="status" className="mt-1 text-[11px] text-amber-800">
            桌面本地没有可验证的已接受关键帧记录，批次确认、任务提交、状态同步和重跑尚未接入；此处只显示已有批次。
          </p>
        ) : null}
        {batches.length === 0 ? <p className="mt-1 text-[11px] text-[#888]">尚无渲染批次。</p> : batches.map((batch) => (
          <div key={String(batch.id)} className="mt-1.5 rounded-lg bg-white px-2 py-1.5 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[#444]">第 {batch.episodeNo} 集 · {batch.jobs.length} 镜头</span>
              <span className="text-[#666]">{batch.status}{desktop ? '' : ` · ${batch.estimatedCost} 点`}</span>
            </div>
            <p className="mt-1 text-[10px] text-[#999]">
              {batch.jobs.filter((job) => job.status === 'completed').length}/{batch.jobs.length} 已完成
              {batch.jobs.some((job) => job.errorCode) ? ' · 存在失败任务，可局部重跑' : ''}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
