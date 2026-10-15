import { useEffect, useState } from 'react'
import { Megaphone, Check } from 'lucide-react'
import { api } from '@/lib/api'
import type { AnnouncementView } from '@/lib/types'
import { Modal } from '@/components/ui/Modal'

export function AnnouncementsPage() {
  const [items, setItems] = useState<AnnouncementView[]>([])
  const [current, setCurrent] = useState<AnnouncementView | null>(null)

  useEffect(() => {
    void api<AnnouncementView[]>('/announcements').then(setItems).catch(() => undefined)
  }, [])

  const open = (a: AnnouncementView) => {
    setCurrent(a)
    if (!a.read) {
      void api(`/announcements/${a.id}/read`, { method: 'POST' }).catch(() => undefined)
      setItems((prev) => prev.map((x) => (x.id === a.id ? { ...x, read: true } : x)))
    }
  }

  return (
    <div className="mx-auto max-w-[700px]">
      <h1 className="mb-6 text-[24px] font-black text-[#111]">公告</h1>
      <div className="space-y-2">
        {items.length === 0 && <p className="py-10 text-center text-[14px] text-[#999]">暂无公告</p>}
        {items.map((a) => (
          <button key={a.id} onClick={() => open(a)} className="flex w-full items-center gap-3 rounded-2xl border border-black/6 bg-white p-4 text-left transition hover:shadow-md">
            <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${a.read ? 'bg-slate-100 text-[#999]' : 'bg-red-50 text-red-500'}`}>
              <Megaphone size={16} />
            </span>
            <span className="flex-1">
              <span className="block text-[14px] font-bold text-[#111]">{a.title}</span>
              <span className="mt-0.5 block text-[12px] text-[#999]">{a.publishedAt ? new Date(a.publishedAt).toLocaleString('zh-CN') : ''}</span>
            </span>
            {a.read && <Check size={14} className="text-emerald-500" />}
          </button>
        ))}
      </div>
      <Modal open={!!current} onClose={() => setCurrent(null)} title={current?.title} wide>
        <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-[#444]">{current?.content}</div>
      </Modal>
    </div>
  )
}
