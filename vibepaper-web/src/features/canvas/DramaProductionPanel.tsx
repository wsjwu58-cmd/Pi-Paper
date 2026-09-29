import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'

type ProductionItem = { id: string | number; label: string; status: string; detail: string }
type RenderJob = {
  id: string
  shotId: string
  keyframeRenderId: string
  canvasNodeId?: string
  durationSeconds: number
  providerType: 'local' | 'cloud'
  providerId: string
  modelId: string
  modelParams: Record<string, unknown>
  status: 'draft' | 'running' | 'completed' | 'failed'
  taskId?: string
  errorCode?: string
  attempt: number
}
type RenderBatch = {
  id: string
  canvasId: string
  seriesId: string
  episodeNo: number
  estimatedCost: number
  status: 'draft' | 'awaiting_approval' | 'running' | 'partial' | 'completed' | 'failed'
  jobs: RenderJob[]
}
type RenderCandidate = {
  seriesId: string
  episodeNo: number
  shotId: string
  shotNo: number
  durationSeconds: number
  keyframeRenderId: string
  canvasNodeId: string
  prompt: string
  providerType: 'local' | 'cloud'
  providerId: string
  modelId: string
  modelParams: Record<string, unknown>
  available: boolean
  unavailableReasonCode?: string | null
  unavailableReason?: string | null
}
type ConfirmationJob = {
  id: string
  shotId: string
  canvasNodeId: string
  keyframeRenderId: string
  durationSeconds: number
  providerType: 'local' | 'cloud'
  providerId: string
  modelId: string
  prompt: string
}
type RenderConfirmation = {
  actionId: string
  token: string
  expiresAt: string
  operation: 'submit' | 'rerun'
  batchId: string
  canvasVersion: number
  jobs: ConfirmationJob[]
}
type PreparedBatch = { batch: RenderBatch; confirmation: RenderConfirmation }
type CandidateGroup = { id: string; seriesId: string; episodeNo: number; candidates: RenderCandidate[] }

function idempotencyKey() {
  return `drama-batch-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function providerLabel(providerId: string) {
  if (providerId === 'agnes') return 'Agnes'
  if (providerId === 'volcengine-ark') return '火山方舟'
  return providerId
}

function statusLabel(status: string) {
  return ({
    draft: '待确认',
    awaiting_approval: '等待确认',
    running: '生成中',
    partial: '部分完成',
    completed: '已完成',
    failed: '失败',
  } as Record<string, string>)[status] ?? status
}

function groupCandidates(candidates: RenderCandidate[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>()
  for (const candidate of candidates) {
    const id = `${candidate.seriesId}\u0000${candidate.episodeNo}`
    let group = groups.get(id)
    if (!group) {
      group = { id, seriesId: candidate.seriesId, episodeNo: candidate.episodeNo, candidates: [] }
      groups.set(id, group)
    }
    group.candidates.push(candidate)
  }
  return [...groups.values()].map((group) => ({
    ...group,
    candidates: [...group.candidates].sort((a, b) => a.shotNo - b.shotNo),
  }))
}

export function hasActiveRenderJobs(batches: Array<{ jobs: Array<{ status: string }> }>) {
  return batches.some((batch) => batch.jobs.some((job) => job.status === 'running'))
}

export function DramaUnavailableRenderCandidates({ candidates }: { candidates: RenderCandidate[] }) {
  if (candidates.length === 0) return null
  return (
    <ul aria-label="暂不可提交的镜头" className="mt-2 space-y-1">
      {candidates.map((candidate) => (
        <li key={`${candidate.shotId}:${candidate.canvasNodeId}`} className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-900">
          第 {candidate.shotNo} 镜 · {providerLabel(candidate.providerId)} · {candidate.modelId} · {candidate.durationSeconds} 秒：
          {' '}{candidate.unavailableReason || '当前提供方暂不支持此镜头参数'}
        </li>
      ))}
    </ul>
  )
}

export function DramaRenderConfirmationCard({
  confirmation,
  candidateForShot,
  busy,
  onSubmit,
  onReject,
}: {
  confirmation: RenderConfirmation
  candidateForShot: Map<string, RenderCandidate>
  busy: boolean
  onSubmit: () => void
  onReject: () => void
}) {
  return (
    <div role="dialog" aria-label="确认视频生成" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2.5">
      <p className="text-[12px] font-bold text-[#222]">
        {confirmation.operation === 'rerun' ? '确认局部重跑' : '确认视频生成'}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-[#555]">
        将为这 {confirmation.jobs.length} 个镜头提交本地生成任务。选择云端模型时，会把下方提示词和已接受关键帧发送给对应提供方；提供方可能按其规则收费。
      </p>
      <ul className="mt-2 space-y-2">
        {confirmation.jobs.map((job) => {
          const candidate = candidateForShot.get(job.shotId)
          return (
            <li key={job.id} className="rounded-md bg-white/80 p-2 text-[11px]">
              <p className="font-semibold text-[#333]">
                {candidate ? `第 ${candidate.shotNo} 镜` : '镜头'} · {providerLabel(job.providerId)} · {job.modelId} · {job.durationSeconds} 秒
              </p>
              <p className="mt-0.5 text-[#666]">输入：已接受关键帧；目标：原镜头视频节点</p>
              <p className="mt-0.5 text-[#666]">新结果会成为该节点当前预览的最新结果，原任务仍保存在本地历史中。</p>
              <details className="mt-1">
                <summary className="cursor-pointer text-[#555]">查看完整提示词</summary>
                <p className="mt-1 whitespace-pre-wrap break-words text-[#666]">{job.prompt}</p>
              </details>
            </li>
          )
        })}
      </ul>
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={onReject} className="rounded-md border border-black/10 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#444] disabled:opacity-60">
          拒绝
        </button>
        <button type="button" disabled={busy} onClick={onSubmit} className="rounded-md bg-[#111] px-2.5 py-1.5 text-[11px] font-bold text-white disabled:opacity-60">
          {busy ? '处理中…' : `确认并生成 ${confirmation.jobs.length} 个任务`}
        </button>
      </div>
    </div>
  )
}

export function DramaProductionPanel({ canvasId, desktop = false }: { canvasId?: string | number; desktop?: boolean }) {
  const [items, setItems] = useState<ProductionItem[]>([])
  const [batches, setBatches] = useState<RenderBatch[]>([])
  const [candidates, setCandidates] = useState<RenderCandidate[]>([])
  const [confirmation, setConfirmation] = useState<PreparedBatch | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyAction, setBusyAction] = useState('')
  const [error, setError] = useState('')
  const createKeys = useRef(new Map<string, string>())

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
      const canvasBatches = (batchesResult.items ?? []).filter((batch) => String(batch.canvasId) === String(canvasId))
      setBatches(canvasBatches)
      if (desktop) {
        const candidatesResult = await api<{ items: RenderCandidate[] }>('/drama/render-batches/candidates')
        setCandidates(candidatesResult.items ?? [])
      } else {
        setCandidates([])
      }
    } catch (cause) {
      setError((cause as Error).message || '读取生产链失败')
    } finally {
      setLoading(false)
    }
  }, [canvasId, desktop])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!desktop || !hasActiveRenderJobs(batches)) return
    const timer = window.setInterval(() => { void refresh() }, 2_000)
    return () => window.clearInterval(timer)
  }, [batches, desktop, refresh])

  const handledJobs = new Set(batches.flatMap((batch) => batch.jobs.map((job) => `${job.canvasNodeId ?? ''}:${job.keyframeRenderId}`)))
  const unhandledCandidates = candidates.filter((candidate) => !handledJobs.has(`${candidate.canvasNodeId}:${candidate.keyframeRenderId}`))
  const availableCandidates = unhandledCandidates.filter((candidate) => candidate.available)
  const unavailableCandidates = unhandledCandidates.filter((candidate) => !candidate.available)
  const groups = groupCandidates(availableCandidates)

  const prepareExistingBatch = async (batchId: string) => {
    setBusyAction(batchId)
    setError('')
    try {
      const prepared = await api<PreparedBatch>(`/drama/render-batches/${encodeURIComponent(batchId)}/prepare`, {
        method: 'POST', body: JSON.stringify({ operation: 'submit' }),
      })
      setConfirmation(prepared)
    } catch (cause) {
      setError((cause as Error).message || '准备生成确认失败')
    } finally {
      setBusyAction('')
    }
  }

  const createBatch = async (group: CandidateGroup) => {
    setBusyAction(group.id)
    setError('')
    const requestKey = createKeys.current.get(group.id) ?? idempotencyKey()
    createKeys.current.set(group.id, requestKey)
    try {
      const prepared = await api<PreparedBatch>('/drama/render-batches', {
        method: 'POST',
        idempotencyKey: requestKey,
        body: JSON.stringify({
          seriesId: group.seriesId,
          episodeNo: group.episodeNo,
          canvasId,
          jobs: group.candidates.map((candidate) => ({
            shotId: candidate.shotId,
            keyframeRenderId: candidate.keyframeRenderId,
            canvasNodeId: candidate.canvasNodeId,
            durationSeconds: candidate.durationSeconds,
            modelType: 'video',
            providerType: candidate.providerType,
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            modelParams: candidate.modelParams,
          })),
        }),
      })
      createKeys.current.delete(group.id)
      setConfirmation(prepared)
      await refresh()
    } catch (cause) {
      setError((cause as Error).message || '创建渲染批次失败')
    } finally {
      setBusyAction('')
    }
  }

  const rerunJob = async (batchId: string, jobId: string) => {
    const key = `${batchId}:${jobId}`
    setBusyAction(key)
    setError('')
    try {
      const prepared = await api<PreparedBatch>(
        `/drama/render-batches/${encodeURIComponent(batchId)}/jobs/${encodeURIComponent(jobId)}/rerun`,
        { method: 'POST', body: JSON.stringify({}) },
      )
      setConfirmation(prepared)
    } catch (cause) {
      setError((cause as Error).message || '准备局部重跑失败')
    } finally {
      setBusyAction('')
    }
  }

  const submitConfirmation = async () => {
    if (!confirmation) return
    const current = confirmation
    setBusyAction('confirmation')
    setError('')
    try {
      await api<RenderBatch>(`/drama/render-batches/${encodeURIComponent(current.batch.id)}/submit`, {
        method: 'POST',
        body: JSON.stringify({
          actionId: current.confirmation.actionId,
          token: current.confirmation.token,
          canvasVersion: current.confirmation.canvasVersion,
        }),
      })
      setConfirmation(null)
      await refresh()
    } catch (cause) {
      setError((cause as Error).message || '提交视频生成失败')
    } finally {
      setBusyAction('')
    }
  }

  const rejectConfirmation = async () => {
    if (!confirmation) return
    const current = confirmation
    setBusyAction('confirmation')
    setError('')
    try {
      await api(`/drama/render-batches/${encodeURIComponent(current.batch.id)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ actionId: current.confirmation.actionId, token: current.confirmation.token }),
      })
      setConfirmation(null)
      await refresh()
    } catch (cause) {
      setError((cause as Error).message || '拒绝生成确认失败')
    } finally {
      setBusyAction('')
    }
  }

  const candidateForShot = new Map(candidates.map((candidate) => [candidate.shotId, candidate]))

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

      {confirmation ? (
        <DramaRenderConfirmationCard
          confirmation={confirmation.confirmation}
          candidateForShot={candidateForShot}
          busy={busyAction === 'confirmation'}
          onSubmit={() => void submitConfirmation()}
          onReject={() => void rejectConfirmation()}
        />
      ) : null}

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
          <p role="status" className="mt-1 text-[11px] text-[#777]">
            批次只从已接受关键帧、成功本地图片任务和对应视频节点中生成；提交前会显示目标、模型与输入供你确认。
          </p>
        ) : null}
        {desktop ? <DramaUnavailableRenderCandidates candidates={unavailableCandidates} /> : null}
        {desktop && groups.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {groups.map((group) => (
              <div key={group.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2 py-2 text-[11px]">
                <span className="min-w-0 truncate text-[#444]">第 {group.episodeNo} 集 · {group.candidates.length} 个可提交镜头</span>
                <button
                  type="button"
                  disabled={Boolean(busyAction)}
                  onClick={() => void createBatch(group)}
                  className="shrink-0 rounded-md bg-[#111] px-2 py-1.5 font-semibold text-white disabled:opacity-60"
                >
                  {busyAction === group.id ? '准备中…' : '检查并确认'}
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {desktop && groups.length === 0 ? <p className="mt-1 text-[11px] text-[#888]">当前没有新的、可由已接入提供方提交的视频镜头。</p> : null}
        {batches.length === 0 ? <p className="mt-1 text-[11px] text-[#888]">尚无渲染批次。</p> : batches.map((batch) => {
          const draftCount = batch.jobs.filter((job) => job.status === 'draft').length
          const failedJobs = batch.jobs.filter((job) => job.status === 'failed')
          const completedCount = batch.jobs.filter((job) => job.status === 'completed').length
          return (
            <div key={batch.id} className="mt-1.5 rounded-lg bg-white px-2 py-1.5 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[#444]">第 {batch.episodeNo} 集 · {batch.jobs.length} 镜头</span>
                <span className="text-[#666]">{desktop ? statusLabel(batch.status) : batch.status}{desktop ? '' : ` · ${batch.estimatedCost} 点`}</span>
              </div>
              <p className="mt-1 text-[10px] text-[#999]">
                {completedCount}/{batch.jobs.length} 已完成
                {desktop
                  ? failedJobs.length ? ` · ${failedJobs.length} 个失败，可逐镜头重跑` : ''
                  : batch.jobs.some((job) => job.errorCode) ? ' · 存在失败任务，可局部重跑' : ''}
              </p>
              {desktop && draftCount > 0 && ['draft', 'awaiting_approval'].includes(batch.status) ? (
                <button
                  type="button"
                  disabled={Boolean(busyAction)}
                  onClick={() => void prepareExistingBatch(batch.id)}
                  className="mt-1 rounded-md border border-black/10 px-2 py-1 text-[10px] font-semibold text-[#444] disabled:opacity-60"
                >
                  {busyAction === batch.id ? '准备中…' : `检查并提交剩余 ${draftCount} 个镜头`}
                </button>
              ) : null}
              {desktop && failedJobs.map((job) => {
                const candidate = candidateForShot.get(job.shotId)
                const jobKey = `${batch.id}:${job.id}`
                return (
                  <div key={job.id} className="mt-1 flex items-center justify-between gap-2 rounded-md border border-red-100 bg-red-50/60 px-2 py-1">
                    <span className="min-w-0 truncate text-[10px] text-red-800">
                      {candidate ? `第 ${candidate.shotNo} 镜` : '镜头'}失败{job.errorCode ? ` · ${job.errorCode}` : ''}
                    </span>
                    <button
                      type="button"
                      disabled={Boolean(busyAction)}
                      onClick={() => void rerunJob(batch.id, job.id)}
                      className="shrink-0 rounded-md border border-red-200 bg-white px-2 py-1 text-[10px] font-semibold text-red-800 disabled:opacity-60"
                    >
                      {busyAction === jobKey ? '准备中…' : '局部重跑'}
                    </button>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </section>
  )
}
