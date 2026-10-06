import { useEffect, useMemo, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Building2, Copy, LogOut, Shield } from 'lucide-react'
import { api } from '@/lib/api'
import { sid } from '@/lib/ids'
import type { CheckinResult, LedgerView, PageResult } from '@/lib/types'
import { useAuth } from '@/lib/auth'
import { toastError, toastSuccess } from '@/components/ui/Toast'

export function ProfilePage() {
  const user = useAuth((s) => s.user)
  const account = useAuth((s) => s.account)
  const logout = useAuth((s) => s.logout)
  const refreshAccount = useAuth((s) => s.refreshAccount)
  const nav = useNavigate()
  const [checkin, setCheckin] = useState<CheckinResult | null>(null)
  const [ledgers, setLedgers] = useState<LedgerView[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api<PageResult<LedgerView>>('/ledgers?page=1&pageSize=120')
      .then((r) => setLedgers(r.items))
      .catch(() => undefined)
  }, [])

  const doCheckin = async () => {
    setBusy(true)
    try {
      const r = await api<CheckinResult>('/rewards/checkin', { method: 'POST' })
      setCheckin(r)
      toastSuccess(`签到成功 +${r.rewardPoints} 点`)
      await refreshAccount()
    } catch (e) {
      toastError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const yearConsumed = useMemo(
    () => ledgers.filter((l) => l.direction === 'out').reduce((s, l) => s + l.points, 0),
    [ledgers],
  )

  const heatmap = useMemo(() => buildHeatmap(ledgers), [ledgers])

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toastSuccess('已复制')
    } catch {
      toastError('复制失败')
    }
  }

  return (
    <div className="mx-auto max-w-[720px]">
      {/* Header */}
      <section className="mb-10 flex items-start gap-5">
        <div className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#2a2a2e] to-[#111] text-[28px] font-black text-white shadow-[0_8px_24px_rgba(0,0,0,0.15)]">
          {(user?.nickname ?? 'U').slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-[32px] font-black leading-none tracking-tight text-[#111]">
              {user?.nickname ?? '用户'}
            </h1>
            <span className="rounded-md bg-black/[0.06] px-2 py-0.5 text-[12px] font-bold text-[#555]">Hobby</span>
          </div>
          <p className="mt-2 text-[14px] leading-relaxed text-[#888]">
            管理账户身份与点数；订阅、奖励、邀请与公告请在画布右上角账户菜单打开。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void doCheckin()}
              disabled={busy || !!checkin}
              className="h-9 rounded-full bg-[#f0f0f2] px-4 text-[13px] font-semibold text-[#333] hover:bg-[#e8e8ea] disabled:opacity-50"
            >
              {checkin ? `已签到 · 连续 ${checkin.streak} 天` : '每日签到'}
            </button>
            <Link
              to="/enterprise"
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[#f0f0f2] px-4 text-[13px] font-semibold text-[#333] hover:bg-[#e8e8ea]"
            >
              <Building2 size={14} /> 企业中心
            </Link>
          </div>
        </div>
      </section>

      {/* Heatmap */}
      <section className="mb-10 rounded-[20px] bg-[#f0f0f2] px-5 py-5">
        <h2 className="mb-4 text-[15px] font-bold text-[#111]">
          近一年点数消耗 <span className="font-black">{yearConsumed}</span>
        </h2>
        <div className="overflow-x-auto">
          <div
            className="grid w-max gap-[3px]"
            style={{
              gridTemplateRows: 'repeat(7, 10px)',
              gridAutoFlow: 'column',
              gridAutoColumns: '10px',
            }}
          >
            {heatmap.map((cell, i) => (
              <div
                key={i}
                title={`${cell.date}: ${cell.points}`}
                className="rounded-[2px]"
                style={{ background: heatColor(cell.level) }}
              />
            ))}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[#999]">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: heatColor(l) }} />
          ))}
          <span>More</span>
        </div>
      </section>

      {/* Account identity */}
      <section className="mb-10">
        <h2 className="text-[20px] font-black text-[#111]">账户身份</h2>
        <p className="mt-1 text-[13px] text-[#999]">查看会员身份与绑定信息</p>
        <div className="mt-5 space-y-4">
          <FieldRow label="会员身份" value="Hobby" />
          <FieldRow label="手机号" value={user?.phone || '未绑定'} />
          <FieldRow
            label="用户 ID"
            value={sid(user?.id)}
            action={
              <button
                type="button"
                onClick={() => void copy(sid(user?.id))}
                className="inline-flex h-9 items-center gap-1 rounded-lg border border-black/10 bg-white px-2.5 text-[12px] font-semibold text-[#555]"
              >
                <Copy size={13} /> 复制
              </button>
            }
          />
          <FieldRow label="邮箱" value={user?.email ?? '—'} />
          <FieldRow label="邀请码" value={user?.inviteCode ?? '—'} />
        </div>
      </section>

      {/* Points */}
      <section className="mb-10 border-t border-black/[0.06] pt-8">
        <h2 className="text-[20px] font-black text-[#111]">当前点数</h2>
        <p className="mt-1 text-[13px] italic text-[#999]">企业协作场景下点数与冻结由计费服务统一结算</p>
        <div className="mt-4 space-y-2 text-[15px]">
          <p className="font-semibold text-[#111]">个人点数：{account?.availablePoints ?? 0}</p>
          <p className="text-[13px] text-[#888]">余额 {account?.balance ?? 0} · 冻结 {account?.frozenPoints ?? 0}</p>
        </div>
      </section>

      {/* Account ops */}
      <section className="border-t border-black/[0.06] pt-8">
        <h2 className="mb-1 flex items-center gap-2 text-[20px] font-black text-[#111]">
          <Shield size={18} /> 账户操作
        </h2>
        <p className="mb-5 text-[13px] text-[#999]">安全相关操作</p>
        <button
          type="button"
          onClick={async () => {
            await logout()
            nav('/login')
          }}
          className="inline-flex items-center gap-2 text-[14px] font-semibold text-red-500 hover:text-red-600"
        >
          <LogOut size={16} /> 退出登录
        </button>
      </section>
    </div>
  )
}

function FieldRow({
  label,
  value,
  action,
}: {
  label: string
  value: string
  action?: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-semibold text-[#999]">{label}</p>
      <div className="flex items-center gap-2">
        <div className="flex h-11 flex-1 items-center rounded-xl bg-[#f0f0f2] px-4 text-[14px] font-medium text-[#222]">
          <span className="truncate">{value}</span>
        </div>
        {action}
      </div>
    </div>
  )
}

function buildHeatmap(ledgers: LedgerView[]) {
  const days = 53 * 7
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  start.setDate(start.getDate() - (days - 1))

  const byDay = new Map<string, number>()
  for (const l of ledgers) {
    if (l.direction !== 'out') continue
    const d = new Date(l.createdAt)
    d.setHours(0, 0, 0, 0)
    const key = d.toISOString().slice(0, 10)
    byDay.set(key, (byDay.get(key) ?? 0) + l.points)
  }

  const cells: Array<{ date: string; points: number; level: number }> = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    const points = byDay.get(key) ?? 0
    let level = 0
    if (points > 0) level = 1
    if (points >= 10) level = 2
    if (points >= 40) level = 3
    if (points >= 100) level = 4
    cells.push({ date: key, points, level })
  }
  return cells
}

function heatColor(level: number): string {
  return ['#e8e8ea', '#c6f0d0', '#86efac', '#4ade80', '#16a34a'][level] ?? '#e8e8ea'
}
