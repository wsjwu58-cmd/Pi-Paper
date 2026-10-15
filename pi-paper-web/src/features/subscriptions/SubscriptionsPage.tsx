import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CreditCard, Building2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { Id, RechargePackage, SubscriptionPlan } from '@/lib/types'
import { useAuth } from '@/lib/auth'
import { toastError, toastSuccess } from '@/components/ui/Toast'

export function SubscriptionsPage() {
  const account = useAuth((s) => s.account)
  const refreshAccount = useAuth((s) => s.refreshAccount)
  const qc = useQueryClient()
  const { data: packages } = useQuery({ queryKey: ['packages'], queryFn: () => api<RechargePackage[]>('/packages') })
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api<SubscriptionPlan[]>('/subscriptions/plans') })

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
    mutationFn: (planId: Id) => api('/subscriptions', { method: 'POST', body: JSON.stringify({ planId }) }),
    onSuccess: () => toastSuccess('订阅成功'),
    onError: (e) => toastError((e as Error).message),
  })

  return (
    <div className="mx-auto max-w-[1000px]">
      <h1 className="mb-6 text-[24px] font-black text-[#111]">订阅菜单</h1>
      <div className="mb-5 flex items-center gap-3 rounded-2xl border border-black/6 bg-white p-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#111] text-white">
          <CreditCard size={18} />
        </div>
        <div className="flex-1">
          <p className="text-[13px] text-[#999]">总可用点数</p>
          <p className="text-[22px] font-black text-[#111]">{account?.availablePoints ?? 0} <span className="text-[12px] font-semibold text-[#999]">（余额 {account?.balance ?? 0}，冻结 {account?.frozenPoints ?? 0}）</span></p>
        </div>
        <Building2 size={18} className="text-[#bbb]" />
      </div>

      <section className="mb-6">
        <h2 className="mb-3 text-[16px] font-bold text-[#111]">购买点数</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {packages?.map((p) => (
            <button key={p.id} onClick={() => buy.mutate(p.id)} className="rounded-2xl border border-black/8 bg-white p-4 text-left transition hover:-translate-y-0.5 hover:border-[#111] hover:shadow-lg">
              <p className="text-[14px] font-bold text-[#111]">{p.name}</p>
              <p className="mt-1 text-[22px] font-black text-[#111]">{p.points}<span className="text-[11px] font-semibold text-[#999]"> 点</span></p>
              <p className="mt-2 text-[13px] font-bold text-emerald-600">¥{p.priceCny}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-[16px] font-bold text-[#111]">个人订阅方案</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {plans?.map((p) => (
            <div key={p.id} className="rounded-2xl border border-black/8 bg-white p-5">
              <p className="text-[15px] font-bold text-[#111]">{p.name}</p>
              <p className="mt-1 text-[24px] font-black text-[#111]">¥{p.priceCny}<span className="text-[12px] font-semibold text-[#999]">/月</span></p>
              <ul className="my-3 space-y-1 text-[12px] text-[#666]">
                {p.benefits &&
                  Object.entries(p.benefits).map(([k, v]) => (
                    <li key={k}>
                      {k}: {String(v)}
                    </li>
                  ))}
              </ul>
              <button onClick={() => subscribe.mutate(p.id)} className="h-10 w-full rounded-xl bg-[#111] text-[13px] font-bold text-white">
                订阅
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl bg-gradient-to-br from-indigo-600 to-purple-700 p-6 text-white">
        <h2 className="text-[17px] font-black">企业方案优势</h2>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-indigo-100">
          共享企业点数池、团队素材库、成员权限分级管理、用量统计与分配记录 CSV 导出，适合影视/广告制作团队。
          获取顾问联系方式：contact@vibepaper.dev
        </p>
      </section>
    </div>
  )
}
