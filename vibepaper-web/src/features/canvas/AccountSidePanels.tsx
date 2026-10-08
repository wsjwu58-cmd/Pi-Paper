import { useEffect, useState } from 'react'
import {
  CalendarCheck,
  Check,
  Copy,
  Gift,
  Link2,
  ListChecks,
  Megaphone,
  UserPlus,
} from 'lucide-react'
import { api } from '@/lib/api'
import type { AnnouncementView, CheckinResult, DailyTaskView, InviteView } from '@/lib/types'
import { useAuth } from '@/lib/auth'
import { useCanvasStore } from './canvasStore'
import { Modal } from '@/components/ui/Modal'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'

export function AccountSidePanels() {
  const panel = useCanvasStore((s) => s.accountPanel)
  const setPanel = useCanvasStore((s) => s.setAccountPanel)

  return (
    <>
      <RewardsPanel open={panel === 'rewards'} onClose={() => setPanel(null)} />
      <InvitesPanel open={panel === 'invites'} onClose={() => setPanel(null)} />
      <AnnouncementsPanel
        open={panel === 'announcements'}
        onClose={() => setPanel(null)}
      />
    </>
  )
}

function RewardsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const refreshAccount = useAuth((s) => s.refreshAccount)
  const [checkin, setCheckin] = useState<CheckinResult | null>(null)
  const [tasks, setTasks] = useState<DailyTaskView[]>([])
  const [busy, setBusy] = useState(false)

  const load = () => {
    void api<{ items: DailyTaskView[] }>('/rewards/daily-tasks')
      .then((r) => setTasks(r.items))
      .catch(() => undefined)
  }

  useEffect(() => {
    if (open) load()
  }, [open])

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
    <Modal open={open} onClose={onClose} title="签到与每日任务" wide>
      <div className="space-y-5">
        <section className="rounded-[24px] bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
          <h3 className="mb-4 flex items-center gap-2 text-[15px] font-bold text-[#111]">
            <ListChecks size={17} /> 每日任务
          </h3>
          <div className="space-y-1">
            {tasks.length === 0 ? (
              <p className="py-6 text-center text-[13px] text-[#999]">暂无任务</p>
            ) : (
              tasks.map((t) => (
                <div
                  key={t.taskKey}
                  className="flex items-center gap-3 border-b border-black/[0.04] py-3 last:border-0"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f5f5f5] text-[#666]">
                    <Gift size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-bold text-[#111]">{t.title}</p>
                    <p className="text-[12px] text-[#888]">
                      完成任务可领取 {t.rewardPoints} 点 · {t.progress}/{t.target}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!t.completed || t.claimed}
                    onClick={() => void claim(t.taskKey)}
                    className={cn(
                      'h-8 rounded-full px-3 text-[12px] font-bold transition',
                      t.claimed
                        ? 'bg-[#f5f5f5] text-[#999]'
                        : t.completed
                          ? 'bg-[#111] text-white'
                          : 'bg-[#f5f5f5] text-[#999]',
                    )}
                  >
                    {t.claimed ? '已领' : t.completed ? '领取' : '未完成'}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-[24px] bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
          <div className="mb-4 flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f5f5f5]">
              <CalendarCheck size={17} className="text-[#666]" />
            </span>
            <div>
              <p className="text-[15px] font-bold text-[#111]">每日签到</p>
              <p className="text-[12px] text-[#888]">
                {checkin
                  ? `已签到，连续 ${checkin.streak} 天，获得 ${checkin.rewardPoints} 点`
                  : '连续签到奖励递增'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void doCheckin()}
            disabled={busy || !!checkin}
            className="h-12 w-full rounded-[16px] bg-[#111] text-[14px] font-bold text-white disabled:bg-[#e5e5e5] disabled:text-[#999]"
          >
            {checkin ? '已签到' : '立即签到'}
          </button>
        </section>
      </div>
    </Modal>
  )
}

function InvitesPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<InviteView | null>(null)
  const [code, setCode] = useState('')

  useEffect(() => {
    if (!open) return
    void api<InviteView>('/invites/me').then(setData).catch(() => undefined)
  }, [open])

  const accept = async () => {
    if (!code.trim()) return
    try {
      await api('/invites/accept', {
        method: 'POST',
        body: JSON.stringify({ inviteCode: code.trim() }),
      })
      toastSuccess('邀请关系绑定成功')
      setCode('')
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="邀请中心" wide>
      <section className="mb-4 rounded-[24px] border border-black/6 p-5">
        <h3 className="mb-3 flex items-center gap-2 text-[14px] font-bold">
          <Link2 size={16} /> 我的邀请
        </h3>
        <p className="text-[12px] text-[#999]">我的邀请码</p>
        <p className="mt-1 font-mono text-[22px] font-black tracking-widest">
          {data?.inviteCode ?? '—'}
        </p>
        <p className="mt-2 text-[12px] text-[#999]">
          成功邀请 <b className="text-[#111]">{data?.invitedCount ?? 0}</b> 人
        </p>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(data?.inviteLink ?? '')
            toastSuccess('邀请链接已复制')
          }}
          className="mt-3 inline-flex h-10 items-center gap-1.5 rounded-[16px] bg-[#111] px-4 text-[13px] font-bold text-white"
        >
          <Copy size={14} /> 复制邀请链接
        </button>
      </section>
      <section className="rounded-[24px] border border-black/6 p-5">
        <h3 className="mb-3 flex items-center gap-2 text-[14px] font-bold">
          <UserPlus size={16} /> 接受邀请
        </h3>
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="输入邀请码"
            className="h-11 flex-1 rounded-[16px] border border-black/12 px-3.5 text-[14px]"
          />
          <button
            type="button"
            onClick={() => void accept()}
            className="h-11 rounded-[16px] bg-[#111] px-5 text-[13px] font-bold text-white"
          >
            接受
          </button>
        </div>
      </section>
    </Modal>
  )
}

function AnnouncementsPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [items, setItems] = useState<AnnouncementView[]>([])
  const [current, setCurrent] = useState<AnnouncementView | null>(null)

  useEffect(() => {
    if (!open) return
    void api<AnnouncementView[]>('/announcements').then(setItems).catch(() => undefined)
  }, [open])

  const openItem = (a: AnnouncementView) => {
    setCurrent(a)
    if (!a.read) {
      void api(`/announcements/${a.id}/read`, { method: 'POST' }).catch(() => undefined)
      setItems((prev) => prev.map((x) => (x.id === a.id ? { ...x, read: true } : x)))
    }
  }

  return (
    <>
      <Modal open={open && !current} onClose={onClose} title="公告" wide>
        <div className="space-y-2">
          {items.length === 0 ? (
            <p className="py-10 text-center text-[14px] text-[#999]">暂无公告</p>
          ) : (
            items.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => openItem(a)}
                className="flex w-full items-center gap-3 rounded-[20px] border border-black/6 p-4 text-left hover:bg-black/[0.02]"
              >
                <span
                  className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                    a.read ? 'bg-[#f5f5f5] text-[#999]' : 'bg-red-50 text-red-500'
                  }`}
                >
                  <Megaphone size={16} />
                </span>
                <span className="flex-1">
                  <span className="block text-[14px] font-bold text-[#111]">
                    {a.title}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-[#999]">
                    {a.publishedAt
                      ? new Date(a.publishedAt).toLocaleString('zh-CN')
                      : ''}
                  </span>
                </span>
                {a.read ? <Check size={14} className="text-emerald-500" /> : null}
              </button>
            ))
          )}
        </div>
      </Modal>
      <Modal
        open={!!current}
        onClose={() => setCurrent(null)}
        title={current?.title}
        wide
      >
        <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-[#444]">
          {current?.content}
        </div>
      </Modal>
    </>
  )
}
