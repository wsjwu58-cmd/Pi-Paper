import { useEffect, useState } from 'react'
import { Gift, CalendarCheck, ListChecks } from 'lucide-react'
import { api } from '@/lib/api'
import type { CheckinResult, DailyTaskView } from '@/lib/types'
import { useAuth } from '@/lib/auth'
import { toastError, toastSuccess } from '@/components/ui/Toast'

export function RewardsPage() {
  const refreshAccount = useAuth((s) => s.refreshAccount)
  const [checkin, setCheckin] = useState<CheckinResult | null>(null)
  const [tasks, setTasks] = useState<DailyTaskView[]>([])
  const [busy, setBusy] = useState(false)

  const load = () => {
    void api<{ items: DailyTaskView[] }>('/rewards/daily-tasks').then((r) => setTasks(r.items)).catch(() => undefined)
  }
  useEffect(load, [])

  const doCheckin = async () => {
    setBusy(true)
    try {
      const r = await api<CheckinResult>('/rewards/checkin', { method: 'POST' })
      setCheckin(r)
      toastSuccess(`签到成功 +${r.rewardPoints} 点，连续 ${r.streak} 天`)
      await refreshAccount()
      load()
    } catch (e) {
      toastError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const claim = async (key: string) => {
    try {
      await api(`/rewards/daily-tasks/${key}/claim`, { method: 'POST' })
      toastSuccess('奖励已领取')
      await refreshAccount()
      load()
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-[700px]">
      <h1 className="mb-6 text-[24px] font-black text-[#111]">奖励中心</h1>
      <section className="mb-5 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 p-6 text-white">
        <div className="flex items-center justify-between">
          <div>
            <p className="flex items-center gap-2 text-[15px] font-bold">
              <CalendarCheck size={18} /> 每日签到
            </p>
            <p className="mt-1 text-[12px] text-amber-50">
              {checkin ? `已签到，连续 ${checkin.streak} 天，获得 ${checkin.rewardPoints} 点` : '连续签到奖励递增，上限 30 点'}
            </p>
          </div>
          <button
            onClick={() => void doCheckin()}
            disabled={busy || !!checkin}
            className="flex h-11 items-center gap-1.5 rounded-xl bg-white px-5 text-[14px] font-black text-orange-600 shadow disabled:opacity-60"
          >
            <Gift size={15} /> {checkin ? '今日已签到' : '签到'}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-black/6 bg-white p-5">
        <h2 className="mb-3 flex items-center gap-2 text-[15px] font-bold text-[#111]">
          <ListChecks size={16} /> 每日任务
        </h2>
        <div className="space-y-2">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-xl border border-black/6 p-3">
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg text-[11px] font-black ${t.completed ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-[#888]'}`}>
                {t.completed ? '✓' : `${t.progress}/${t.target}`}
              </div>
              <div className="flex-1">
                <p className="text-[13px] font-bold text-[#111]">{t.title}</p>
                <p className="text-[11px] text-[#999]">{t.description} · 奖励 {t.rewardPoints} 点</p>
              </div>
              <button
                onClick={() => void claim(t.taskKey)}
                disabled={!t.completed || t.claimed}
                className="h-9 rounded-xl bg-[#111] px-3.5 text-[12px] font-bold text-white disabled:bg-black/10 disabled:text-[#999]"
              >
                {t.claimed ? '已领取' : '领取'}
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
