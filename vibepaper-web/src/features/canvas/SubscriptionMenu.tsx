import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Copy, Moon, Sun } from 'lucide-react'
import { api } from '@/lib/api'
import type { Id, RechargePackage, SubscriptionPlan, UserPreference } from '@/lib/types'
import { useAuth } from '@/lib/auth'
import { useCanvasStore } from './canvasStore'
import { Modal } from '@/components/ui/Modal'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'

export function SubscriptionMenu() {
  const panel = useCanvasStore((s) => s.accountPanel)
  const setPanel = useCanvasStore((s) => s.setAccountPanel)
  const open = panel === 'subscription'
  const user = useAuth((s) => s.user)
  const account = useAuth((s) => s.account)
  const preferences = useAuth((s) => s.preferences)
  const updatePreferences = useAuth((s) => s.updatePreferences)
  const refreshAccount = useAuth((s) => s.refreshAccount)
  const qc = useQueryClient()
  const [cycle, setCycle] = useState<'month' | 'year'>('month')
  const [selectedPlan, setSelectedPlan] = useState<Id | null>(null)

  const { data: packages } = useQuery({
    queryKey: ['packages'],
    queryFn: () => api<RechargePackage[]>('/packages'),
    enabled: open,
  })
  const { data: plans } = useQuery({
    queryKey: ['plans'],
    queryFn: () => api<SubscriptionPlan[]>('/subscriptions/plans'),
    enabled: open,
  })

  const buy = useMutation({
    mutationFn: async (pkgId: Id) => {
      return await api<{ id: Id; amountCny: number; points: number; status: string }>('/recharge/orders', {
        method: 'POST',
        idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
        body: JSON.stringify({ packageId: pkgId }),
      })
    },
    onSuccess: async (order) => {
      toastSuccess(`订单 #${order.id} 已创建，支付完成后点数将到账`)
      await refreshAccount()
      qc.invalidateQueries({ queryKey: ['packages'] })
    },
    onError: (e) => toastError((e as Error).message),
  })

  const subscribe = useMutation({
    mutationFn: (planId: Id) =>
      api('/subscriptions', { method: 'POST', body: JSON.stringify({ planId }) }),
    onSuccess: () => toastSuccess('订阅成功'),
    onError: (e) => toastError((e as Error).message),
  })

  const sortedPlans = useMemo(() => plans ?? [], [plans])
  const activePlanId: Id | null = selectedPlan ?? sortedPlans[1]?.id ?? sortedPlans[0]?.id ?? null

  return (
    <Modal open={open} onClose={() => setPanel(null)} size="xl" hideHeader>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#111] text-[16px] font-black text-white">
            {(user?.nickname ?? 'U').slice(0, 1)}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[16px] font-bold text-[#111]">{user?.nickname}</p>
              <span className="rounded-full bg-[#ededed] px-2.5 py-0.5 text-[11px] font-bold text-[#555]">
                Hobby
              </span>
              <span className="inline-flex rounded-full bg-[#ededed] p-0.5 text-[11px] font-bold">
                <button
                  type="button"
                  className={cn(
                    'rounded-full px-2 py-0.5',
                    (preferences?.language ?? 'zh') === 'zh' ? 'bg-white shadow-sm' : 'text-[#777]',
                  )}
                  onClick={() => void updatePreferences({ language: 'zh' })}
                >
                  中文
                </button>
                <button
                  type="button"
                  className={cn(
                    'rounded-full px-2 py-0.5',
                    preferences?.language === 'en' ? 'bg-white shadow-sm' : 'text-[#777]',
                  )}
                  onClick={() => void updatePreferences({ language: 'en' })}
                >
                  EN
                </button>
              </span>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#ededed]"
                onClick={() =>
                  void updatePreferences({
                    theme: (preferences?.theme ?? 'light') === 'light' ? 'dark' : 'light',
                  } as Partial<UserPreference>)
                }
                title="切换主题"
              >
                {(preferences?.theme ?? 'light') === 'light' ? (
                  <Sun size={14} />
                ) : (
                  <Moon size={14} />
                )}
              </button>
            </div>
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 text-[12px] text-[#888] hover:text-[#111]"
              onClick={() => {
                void navigator.clipboard?.writeText(String(user?.id ?? ''))
                toastSuccess('用户 ID 已复制')
              }}
            >
              ID {user?.id} <Copy size={12} />
            </button>
          </div>
        </div>

        <div className="text-center">
          <p className="font-serif text-[28px] font-bold tracking-tight text-[#111]">VibePaper</p>
          <div className="mt-2 inline-flex rounded-full bg-[#f0f0f0] p-1">
            {(
              [
                ['month', '按月购买'],
                ['year', '按年购买'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setCycle(k)}
                className={cn(
                  'h-9 rounded-full px-4 text-[13px] font-bold transition',
                  cycle === k ? 'bg-white text-[#111] shadow-sm' : 'text-[#777]',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-[140px] text-right text-[13px]">
          <p className="text-[#888]">
            个人点数{' '}
            <b className="text-[16px] text-[#111]">{account?.balance ?? 0}</b>
          </p>
          <p className="mt-1 text-[#888]">
            可用{' '}
            <b className="text-[16px] text-[#111]">{account?.availablePoints ?? 0}</b>
          </p>
        </div>
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {sortedPlans.map((p, idx) => {
          const active = p.id === activePlanId
          const price = cycle === 'year' ? Math.round(p.priceCny * 10) : p.priceCny
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedPlan(p.id)}
              className={cn(
                'relative rounded-2xl border bg-[#fafafa] p-4 text-left transition',
                active
                  ? 'border-[#111] shadow-[inset_0_0_0_2px_#111]'
                  : 'border-black/6 hover:border-black/20',
              )}
            >
              {idx === 1 ? (
                <span className="absolute right-3 top-3 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                  Popular
                </span>
              ) : null}
              <p className="text-[16px] font-black text-[#111]">{p.name}</p>
              <p className="mt-2 text-[22px] font-black text-[#111]">
                {cycle === 'month' ? `每月 ${price} 元` : `每年 ${price} 元`}
              </p>
              {cycle === 'year' ? (
                <span className="mt-1 inline-block rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                  约 20% OFF
                </span>
              ) : null}
              <p className="mt-4 text-[12px] font-bold text-[#555]">点数权益</p>
              <ul className="mt-2 space-y-1.5 text-[12px] text-[#666]">
                <li>· 每月赠送点数按方案发放</li>
                <li>· 支持个人创作全模态生成</li>
                <li>· 可叠加购买充值包</li>
              </ul>
            </button>
          )
        })}
        {sortedPlans.length === 0 ? (
          <p className="col-span-full py-8 text-center text-[13px] text-[#999]">
            暂无订阅方案，可先购买点数包
          </p>
        ) : null}
      </div>

      <div className="mb-5">
        <p className="mb-2 text-[13px] font-bold text-[#555]">快捷充值</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {packages?.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={buy.isPending}
              onClick={() => buy.mutate(p.id)}
              className="rounded-xl border border-black/8 bg-white px-3 py-3 text-left hover:border-[#111] disabled:opacity-50"
            >
              <p className="text-[13px] font-bold text-[#111]">{p.name}</p>
              <p className="text-[12px] text-[#666]">
                {p.points} 点 · ¥{p.priceCny}
              </p>
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        disabled={!activePlanId || subscribe.isPending}
        onClick={() => activePlanId && subscribe.mutate(activePlanId)}
        className="h-12 w-full rounded-full bg-[#111] text-[15px] font-bold text-white disabled:opacity-50"
      >
        立即订阅
      </button>
    </Modal>
  )
}
