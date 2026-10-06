import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Download, Users, Wallet, Library, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { Spinner } from '@/components/ui/Spinner'

interface EnterpriseInfo {
  id: number
  name: string
  ownerId: number
  enterpriseCode: string
  totalPoints: number
  allocatablePoints: number
  sharedPoolEnabled: boolean
  myRole?: string
}

interface Member {
  userId: number
  role: string
  nickname?: string
  email?: string
  account?: { balance: number; availablePoints: number; frozenPoints: number }
}

export function EnterprisePage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'overview' | 'members' | 'assets' | 'records' | 'usage' | 'settings'>('overview')
  const [allocTarget, setAllocTarget] = useState<Member | null>(null)
  const [amount, setAmount] = useState('')
  const [dissolveOpen, setDissolveOpen] = useState(false)

  const { data: entData, isLoading } = useQuery({
    queryKey: ['enterprise-me'],
    queryFn: () => api<{ enterprise: EnterpriseInfo | null }>('/enterprises/me'),
  })
  const ent = entData?.enterprise ?? null

  const { data: members, refetch: refetchMembers } = useQuery({
    queryKey: ['ent-members', ent?.id],
    queryFn: () => api<Member[]>(`/enterprises/${ent!.id}/members`),
    enabled: !!ent && tab === 'members',
  })
  const { data: records } = useQuery({
    queryKey: ['ent-records', ent?.id],
    queryFn: () => api<Array<{ id: number; memberId: number; allocType: string; points: number; balanceAfter: number; createdAt: string }>>(`/enterprises/${ent!.id}/allocation-records`),
    enabled: !!ent && tab === 'records',
  })
  const { data: entAssets } = useQuery({
    queryKey: ['ent-assets', ent?.id],
    queryFn: () => api<Array<{ id: number; name: string; assetType: string; url?: string }>>(`/enterprises/${ent!.id}/assets`),
    enabled: !!ent && tab === 'assets',
  })
  const { data: usage } = useQuery({
    queryKey: ['ent-usage', ent?.id],
    queryFn: () => api<Array<{ date: string; points: number; memberId?: number }>>(`/enterprises/${ent!.id}/usage?scope=enterprise`),
    enabled: !!ent && tab === 'usage',
  })

  const allocate = useMutation({
    mutationFn: (type: 'allocate' | 'recycle') =>
      api(`/enterprises/${ent!.id}/members/${allocTarget!.userId}/${type}`, {
        method: 'POST',
        body: JSON.stringify({ amount: Number(amount) }),
      }),
    onSuccess: async () => {
      toastSuccess('操作成功')
      setAllocTarget(null)
      setAmount('')
      await refetchMembers()
      qc.invalidateQueries({ queryKey: ['enterprise-me'] })
    },
    onError: (e) => toastError(e instanceof ApiError ? e.message : '操作失败'),
  })

  const removeMember = useMutation({
    mutationFn: (userId: number) => api(`/enterprises/${ent!.id}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toastSuccess('已移出成员')
      void refetchMembers()
    },
    onError: (e) => toastError((e as Error).message),
  })

  const rename = useMutation({
    mutationFn: (name: string) => api(`/enterprises/${ent!.id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      toastSuccess('企业名称已更新')
      qc.invalidateQueries({ queryKey: ['enterprise-me'] })
    },
  })

  const createInvite = async () => {
    if (!ent) return
    try {
      const inv = await api<{ token: string }>(`/enterprises/${ent.id}/invitations`, { method: 'POST' })
      navigator.clipboard?.writeText(`${location.origin}/enterprise?invite=${inv.token}`)
      toastSuccess('邀请链接已复制，7 天内有效')
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const dissolve = useMutation({
    mutationFn: () => api(`/enterprises/${ent!.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toastSuccess('企业已解散')
      qc.invalidateQueries({ queryKey: ['enterprise-me'] })
    },
  })

  if (isLoading) {
    return <div className="flex justify-center py-24"><Spinner className="h-8 w-8" /></div>
  }

  if (!ent) {
    return <NoEnterprise onCreated={() => qc.invalidateQueries({ queryKey: ['enterprise-me'] })} />
  }

  return (
    <div className="mx-auto max-w-[1000px]">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-black text-[#111]">{ent.name}</h1>
          <p className="mt-1 text-[13px] text-[#666]">企业码 {ent.enterpriseCode} · 我的角色 {ent.myRole}</p>
        </div>
        <Button variant="secondary" leftIcon={<Copy size={15} />} onClick={() => void createInvite()}>
          复制邀请链接
        </Button>
      </div>

      <div className="mb-5 grid grid-cols-3 gap-3">
        <StatCard label="企业总点数" value={ent.totalPoints} icon={<Wallet size={16} />} />
        <StatCard label="可分配点数" value={ent.allocatablePoints} icon={<Users size={16} />} />
        <StatCard label="共享池" value={ent.sharedPoolEnabled ? '已开启' : '关闭'} icon={<Library size={16} />} />
      </div>

      <div className="mb-5 flex flex-wrap gap-1 rounded-2xl border border-black/6 bg-white p-1.5">
        {(
          [
            ['overview', '概览'],
            ['members', '成员管理'],
            ['assets', '企业素材库'],
            ['records', '分配记录'],
            ['usage', '用量统计'],
            ['settings', '账户设置'],
          ] as const
        ).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={`h-9 rounded-xl px-4 text-[13px] font-bold ${tab === key ? 'bg-[#111] text-white' : 'text-[#666] hover:bg-black/[0.04]'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'members' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <h2 className="mb-3 text-[15px] font-bold text-[#111]">团队成员</h2>
          <div className="divide-y divide-black/4">
            {members?.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 py-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-[13px] font-black text-[#888]">
                  {(m.nickname ?? 'U').slice(0, 1).toUpperCase()}
                </div>
                <div className="flex-1">
                  <p className="text-[13px] font-bold text-[#111]">{m.nickname ?? `用户${m.userId}`}</p>
                  <p className="text-[11px] text-[#999]">可用 {m.account?.availablePoints ?? 0} · 冻结 {m.account?.frozenPoints ?? 0}</p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-[#666]">{m.role}</span>
                {m.role !== 'owner' && (
                  <div className="flex gap-1.5">
                    <button onClick={() => { setAllocTarget(m); setAmount('') }} className="rounded-lg bg-[#111] px-2.5 py-1.5 text-[11px] font-bold text-white">分配</button>
                    <button onClick={() => { setAllocTarget(m); setAmount('') }} className="rounded-lg border border-black/10 px-2.5 py-1.5 text-[11px] font-bold text-[#555]">回收</button>
                    <button onClick={() => removeMember.mutate(m.userId)} className="rounded-lg p-1.5 text-[#bbb] hover:text-red-500"><Trash2 size={13} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'assets' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <h2 className="mb-3 text-[15px] font-bold text-[#111]">企业素材库</h2>
          <div className="grid grid-cols-4 gap-2">
            {entAssets?.map((a) => (
              <div key={a.id} className="overflow-hidden rounded-xl border border-black/6">
                <div className="flex h-20 items-center justify-center bg-slate-100 text-[10px] font-bold uppercase text-[#999]">{a.assetType}</div>
                <p className="truncate px-2 py-1.5 text-[11px] font-semibold text-[#555]">{a.name}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'records' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-bold text-[#111]">分配记录</h2>
            <a href={`http://localhost:8080/api/v1/enterprises/${ent.id}/allocation-records/export`} className="flex items-center gap-1.5 rounded-lg border border-black/10 px-3 py-1.5 text-[12px] font-bold text-[#555]" download>
              <Download size={13} /> 导出 CSV
            </a>
          </div>
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-[#999]">
              <tr><th className="py-2">时间</th><th>类型</th><th>对象</th><th>点数</th><th>操作后余额</th></tr>
            </thead>
            <tbody>
              {records?.map((r) => (
                <tr key={r.id} className="border-t border-black/4">
                  <td className="py-2 text-[#777]">{new Date(r.createdAt).toLocaleString('zh-CN')}</td>
                  <td><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${r.allocType === 'allocate' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{r.allocType === 'allocate' ? '分配' : '回收'}</span></td>
                  <td className="text-[#555]">#{r.memberId}</td>
                  <td className="font-bold">{r.points}</td>
                  <td className="text-[#999]">{r.balanceAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'usage' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <h2 className="mb-3 text-[15px] font-bold text-[#111]">用量统计（企业）</h2>
          <div className="flex h-40 items-end gap-1.5 rounded-xl bg-slate-50 p-3">
            {usage?.slice(0, 30).map((u, i) => (
              <div key={i} className="flex-1 rounded-t bg-indigo-400/70" style={{ height: `${Math.min(100, Math.max(5, u.points / 5))}%` }} title={`${u.date}: ${u.points} 点`} />
            ))}
            {(!usage || usage.length === 0) && <p className="w-full text-center text-[12px] text-[#999]">暂无消耗数据</p>}
          </div>
        </section>
      )}

      {tab === 'settings' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <h2 className="mb-4 text-[15px] font-bold text-[#111]">账户设置</h2>
          <form
            className="mb-5 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const name = (e.target as HTMLFormElement).nameInput.value
              if (name) rename.mutate(name)
            }}
          >
            <input name="nameInput" placeholder="新企业名称" className="h-11 flex-1 rounded-xl border border-black/12 px-3.5" />
            <Button type="submit">修改企业名称</Button>
          </form>
          <div className="rounded-xl border border-red-100 bg-red-50/60 p-4">
            <p className="text-[13px] font-bold text-red-700">危险操作</p>
            <p className="mt-1 text-[12px] text-red-500">解散企业后将移除全部成员与素材关联，仅所有者可操作。</p>
            <button onClick={() => setDissolveOpen(true)} className="mt-3 h-10 rounded-xl bg-red-600 px-4 text-[13px] font-bold text-white">解散企业</button>
          </div>
        </section>
      )}

      <Modal open={!!allocTarget} onClose={() => setAllocTarget(null)} title={allocTarget ? `操作成员 ${allocTarget.nickname ?? allocTarget.userId}` : ''}>
        <div className="flex flex-col gap-4">
          <label className="text-[13px] font-semibold text-[#555]">
            点数
            <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 h-11 w-full rounded-xl border border-black/12 px-3.5" />
          </label>
          <div className="flex gap-2">
            <button onClick={() => allocate.mutate('recycle')} className="h-10 flex-1 rounded-xl border border-black/10 font-bold">回收</button>
            <button onClick={() => allocate.mutate('allocate')} className="h-10 flex-1 rounded-xl bg-[#111] font-bold text-white">分配</button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog open={dissolveOpen} onClose={() => setDissolveOpen(false)} onConfirm={() => dissolve.mutate()} title="解散企业" message="此操作不可恢复，确定解散企业？" danger />
    </div>
  )
}

function NoEnterprise({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => api('/enterprises', { method: 'POST', body: JSON.stringify({ name: name || '我的企业' }) }),
    onSuccess: onCreated,
    onError: (e) => toastError((e as Error).message),
  })
  return (
    <div className="mx-auto max-w-md pt-20 text-center">
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-[#111] text-white"><Users size={26} /></div>
      <h1 className="text-[22px] font-black text-[#111]">创建你的企业</h1>
      <p className="mt-2 text-[13px] text-[#666]">共享点数池、团队素材库与成员权限管理</p>
      <div className="mt-6 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="企业名称" className="h-11 flex-1 rounded-xl border border-black/12 px-3.5" />
        <Button onClick={() => create.mutate()}>创建</Button>
      </div>
    </div>
  )
}

function StatCard({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-black/6 bg-white p-4">
      <p className="flex items-center gap-1.5 text-[12px] text-[#999]">{icon}{label}</p>
      <p className="mt-1 text-[22px] font-black text-[#111]">{value}</p>
    </div>
  )
}
