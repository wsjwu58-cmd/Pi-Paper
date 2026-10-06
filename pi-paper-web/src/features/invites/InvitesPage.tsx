import { useEffect, useState } from 'react'
import { Copy, Link2, UserPlus, BookOpen, MessageSquare } from 'lucide-react'
import { api } from '@/lib/api'
import type { InviteView } from '@/lib/types'
import { toastError, toastSuccess } from '@/components/ui/Toast'

export function InvitesPage() {
  const [data, setData] = useState<InviteView | null>(null)
  const [code, setCode] = useState('')

  useEffect(() => {
    void api<InviteView>('/invites/me').then(setData).catch(() => undefined)
  }, [])

  const accept = async () => {
    if (!code.trim()) return
    try {
      await api('/invites/accept', { method: 'POST', body: JSON.stringify({ inviteCode: code.trim() }) })
      toastSuccess('邀请关系绑定成功，奖励已发放')
      setCode('')
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-[700px]">
      <h1 className="mb-6 text-[24px] font-black text-[#111]">邀请中心</h1>
      <section className="mb-5 rounded-2xl border border-black/6 bg-white p-5">
        <h2 className="mb-3 flex items-center gap-2 text-[15px] font-bold text-[#111]"><Link2 size={16} /> 我的邀请</h2>
        <div className="rounded-xl bg-slate-50 p-4">
          <p className="text-[12px] text-[#999]">我的邀请码</p>
          <p className="mt-1 font-mono text-[20px] font-black tracking-widest text-[#111]">{data?.inviteCode ?? '—'}</p>
          <p className="mt-2 text-[12px] text-[#999]">成功邀请 <b className="text-[#111]">{data?.invitedCount ?? 0}</b> 人，每位好友注册可获 100 点奖励</p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => { navigator.clipboard?.writeText(data?.inviteLink ?? ''); toastSuccess('邀请链接已复制') }}
              className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#111] text-[13px] font-bold text-white"
            >
              <Copy size={14} /> 复制邀请链接
            </button>
          </div>
        </div>
      </section>

      <section className="mb-5 rounded-2xl border border-black/6 bg-white p-5">
        <h2 className="mb-3 flex items-center gap-2 text-[15px] font-bold text-[#111]"><UserPlus size={16} /> 接受邀请</h2>
        <div className="flex gap-2">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入邀请码" className="h-11 flex-1 rounded-xl border border-black/12 px-3.5 text-[14px]" />
          <button onClick={() => void accept()} className="h-11 rounded-xl bg-[#111] px-5 text-[13px] font-bold text-white">接受</button>
        </div>
      </section>

      <section className="mb-5 rounded-2xl border border-black/6 bg-white p-5">
        <h2 className="mb-3 text-[15px] font-bold text-[#111]">成功邀请记录</h2>
        {data?.records.length === 0 ? (
          <p className="py-4 text-center text-[13px] text-[#999]">暂无邀请记录</p>
        ) : (
          <div className="divide-y divide-black/4">
            {data?.records.map((r, i) => (
              <div key={i} className="flex items-center justify-between py-2.5 text-[13px]">
                <span className="font-semibold text-[#444]">{r.inviteeNickname}</span>
                <span className="text-[12px] text-[#999]">{new Date(r.createdAt).toLocaleString('zh-CN')}</span>
                <span className="font-bold text-emerald-600">+{r.rewardPoints}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3">
        <button className="flex items-center gap-2 rounded-2xl border border-black/6 bg-white p-4 text-left text-[13px] font-bold text-[#555] hover:bg-black/[0.02]">
          <BookOpen size={16} className="text-[#999]" /> 查看邀请指南
        </button>
        <button className="flex items-center gap-2 rounded-2xl border border-black/6 bg-white p-4 text-left text-[13px] font-bold text-[#555] hover:bg-black/[0.02]">
          <MessageSquare size={16} className="text-[#999]" /> 反馈建议
        </button>
      </section>
    </div>
  )
}
