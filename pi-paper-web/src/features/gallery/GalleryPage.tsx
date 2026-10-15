import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Copy, Maximize2, Trash2, Sparkles } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import type { CanvasDetail, PageResult, PublicationView } from '@/lib/types'
import { Input } from '@/components/ui/Input'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { Spinner } from '@/components/ui/Spinner'

export function GalleryPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [keyword, setKeyword] = useState('')
  const [preview, setPreview] = useState<PublicationView | null>(null)
  const [process, setProcess] = useState<CanvasDetail | null>(null)
  const [delTarget, setDelTarget] = useState<PublicationView | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['gallery', keyword],
    queryFn: () => api<PageResult<PublicationView>>(`/gallery/publications?page=1&pageSize=24${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`),
  })

  const clone = useMutation({
    mutationFn: (id: string | number) =>
      api<{ canvasId: string | number }>(`/gallery/publications/${id}/clone`, { method: 'POST' }),
    onSuccess: (r) => {
      toastSuccess('克隆成功')
      nav(`/canvas/${String(r.canvasId)}`)
    },
    onError: (e) => toastError((e as Error).message),
  })

  const del = useMutation({
    mutationFn: (id: string | number) => api(`/publications/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gallery'] })
      toastSuccess('已删除')
    },
    onError: (e) => toastError((e as Error).message),
  })

  const openProcess = async (p: PublicationView) => {
    try {
      const d = await api<{ snapshot: CanvasDetail }>(`/gallery/publications/${p.id}`)
      setProcess(d.snapshot)
      setPreview(null)
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : '加载失败')
    }
  }

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-black text-[#111]">创意广场</h1>
          <p className="mt-1 text-[13px] text-[#666]">发现灵感，一键克隆到个人工作区</p>
        </div>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#999]" />
          <Input className="w-64 pl-9" placeholder="搜索作品" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Spinner className="h-8 w-8" /></div>
      ) : data?.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/15 py-20 text-center">
          <Sparkles size={32} className="mx-auto mb-2 text-[#ccc]" />
          <p className="text-[14px] text-[#999]">暂无公开作品</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {data?.items.map((p) => (
            <div key={p.id} className="group overflow-hidden rounded-2xl border border-black/8 bg-white transition hover:shadow-[0_16px_40px_rgba(15,23,42,0.10)]">
              <div
                className="relative flex h-44 cursor-pointer items-center justify-center bg-gradient-to-br from-slate-100 to-indigo-50"
                onClick={() => setPreview(p)}
              >
                {p.thumbnailUrl ? (
                  <img src={p.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid grid-cols-3 gap-1 p-4 opacity-60">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="h-10 rounded-lg bg-black/10" style={{ marginTop: i % 3 * 10 }} />
                    ))}
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/0 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
                  <button onClick={(e) => { e.stopPropagation(); setPreview(p) }} className="rounded-xl bg-white/95 p-2.5 text-[#111] shadow"><Maximize2 size={16} /></button>
                  <button onClick={(e) => { e.stopPropagation(); void openProcess(p) }} className="rounded-xl bg-white/95 p-2.5 text-[#111] shadow"><Copy size={16} /></button>
                </div>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-bold text-[#111]">{p.title}</p>
                  {p.description ? <p className="mt-0.5 truncate text-[12px] text-[#777]">{p.description}</p> : null}
                  <p className="text-[12px] text-[#999]">by {p.authorName ?? '创作者'}</p>
                </div>
                <div className="flex gap-1.5">
                  <button disabled={!p.shareWorkflow} onClick={() => clone.mutate(p.id)} className="rounded-lg bg-[#111] px-3 py-1.5 text-[12px] font-bold text-white disabled:cursor-not-allowed disabled:bg-[#aaa]">
                    克隆
                  </button>
                  <button onClick={() => setDelTarget(p)} className="rounded-lg p-1.5 text-[#bbb] hover:text-red-500" title="删除自己的作品">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.title} wide>
        <div className="mb-4 flex h-80 items-center justify-center overflow-hidden rounded-2xl bg-slate-100">
          {preview?.previewAssetUrl || preview?.thumbnailUrl ? (
            <PublicationMedia publication={preview} />
          ) : (
            <span className="text-[13px] text-[#999]">暂无成品预览图</span>
          )}
        </div>
        {preview?.description ? <p className="mb-4 text-[14px] leading-6 text-[#666]">{preview.description}</p> : null}
        <div className="flex justify-end gap-2">
          <button disabled={!preview?.shareWorkflow} onClick={() => preview && void openProcess(preview)} className="h-10 rounded-xl border border-black/10 px-4 text-[13px] font-semibold disabled:cursor-not-allowed disabled:text-[#aaa]">查看制作过程</button>
          <button disabled={!preview?.shareWorkflow} onClick={() => preview && clone.mutate(preview.id)} className="h-10 rounded-xl bg-[#111] px-4 text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:bg-[#aaa]">一键克隆</button>
        </div>
      </Modal>

      <Modal open={!!process} onClose={() => setProcess(null)} title={`制作过程 · ${process?.canvas.name ?? ''}`} wide>
        {process && (
          <div className="space-y-3">
            <p className="text-[12px] text-[#999]">{process.nodes.length} 个节点 · {process.edges.length} 条连线</p>
            <div className="relative min-h-[320px] overflow-auto rounded-2xl border border-black/8 bg-[#f7f7f8] p-4">
              <svg className="pointer-events-none absolute inset-0 h-full w-full">
                {process.edges.map((e) => {
                  const source = process.nodes.find((n) => String(n.id) === String(e.sourceNodeId))
                  const target = process.nodes.find((n) => String(n.id) === String(e.targetNodeId))
                  if (!source || !target) return null
                  const x1 = (source.x ?? 0) * 0.35 + 80
                  const y1 = (source.y ?? 0) * 0.35 + 40
                  const x2 = (target.x ?? 0) * 0.35 + 80
                  const y2 = (target.y ?? 0) * 0.35 + 40
                  return (
                    <line
                      key={String(e.id)}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={e.valid ? '#93c5fd' : '#c0c0c0'}
                      strokeWidth="2"
                    />
                  )
                })}
              </svg>
              {process.nodes.map((n) => (
                <div
                  key={n.id}
                  className="absolute w-40 rounded-xl border border-black/10 bg-white px-3 py-2 text-[12px] shadow-sm"
                  style={{ left: (n.x ?? 0) * 0.35 + 20, top: (n.y ?? 0) * 0.35 + 20 }}
                >
                  <p className="font-bold text-[#444]">{n.type} 节点</p>
                  <p className="truncate text-[#999]">{String(n.params.prompt ?? n.params.name ?? '')}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!delTarget}
        onClose={() => setDelTarget(null)}
        onConfirm={() => delTarget && del.mutate(delTarget.id)}
        title="删除作品"
        message="仅能删除自己上传的作品，确定删除吗？"
        danger
      />
    </div>
  )
}

function PublicationMedia({ publication }: { publication: PublicationView }) {
  const url = publication.previewAssetUrl || publication.thumbnailUrl
  const isVideo = publication.previewAssetType === 'video'
  const isAudio = publication.previewAssetType === 'audio'
  if (!url) return null
  if (isVideo) return <video src={url} className="h-full w-full object-contain" controls />
  if (isAudio) return <audio src={url} className="w-4/5" controls />
  return <img src={url} alt={publication.title} className="h-full w-full object-contain" />
}
