import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'

type AuditReport = { id: string | number; status?: string; failures?: unknown; evidence?: unknown; recommended_action?: string }

export function DramaAuditPanel({ canvasId }: { canvasId?: string | number; desktop?: boolean }) {
  const [reports, setReports] = useState<AuditReport[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (canvasId == null) return
    setLoading(true)
    setError('')
    try {
      const result = await api<{ items: AuditReport[] }>(`/render-reviews?canvasId=${encodeURIComponent(String(canvasId))}`)
      setReports(result.items ?? [])
    } catch (cause) {
      setError((cause as Error).message || '读取审校报告失败')
    } finally {
      setLoading(false)
    }
  }, [canvasId])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <section className="mt-3 rounded-xl border border-black/8 bg-[#fafafa] p-3" aria-label="短剧审校报告">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[12px] font-bold text-[#333]">审校证据</p>
          <p className="text-[10px] text-[#888]">规则结论优先，模型建议不可覆盖失败项</p>
        </div>
        <button type="button" onClick={() => void refresh()} title="刷新审校" className="rounded-lg p-1.5 text-[#666] hover:bg-black/5">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-[11px] text-red-700">{error}</p> : null}
      <div className="mt-2 space-y-2">
        {reports.length === 0 ? <p className="text-[11px] text-[#888]">尚无审校报告。</p> : reports.map((report) => (
          <article key={String(report.id)} className="rounded-lg bg-white p-2 text-[11px] text-[#555]">
            <p className="font-semibold text-[#333]">报告 #{report.id} · {report.status ?? 'pending'}</p>
            <p className="mt-1 break-words">失败项：{JSON.stringify(report.failures ?? [])}</p>
            <p className="mt-1 break-words">证据：{JSON.stringify(report.evidence ?? {})}</p>
            {report.recommended_action ? <p className="mt-1 text-amber-700">建议：{report.recommended_action}</p> : null}
          </article>
        ))}
      </div>
    </section>
  )
}
