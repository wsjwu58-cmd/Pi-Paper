import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users, Boxes, Coins, Megaphone, KeyRound, Crown, FileSearch } from 'lucide-react'
import { api } from '@/lib/api'
import type { PageResult } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { Field, Input, Select } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { toastError, toastSuccess } from '@/components/ui/Toast'

type Tab = 'users' | 'publications' | 'models' | 'packages' | 'transactions' | 'announcements' | 'audit' | 'apikeys' | 'tiers'

export function AdminPage() {
  const [tab, setTab] = useState<Tab>('users')
  const qc = useQueryClient()

  const { data: users } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api<{ items: Array<{ id: number; nickname: string; email: string; role: string; status: string }>; total: number }>('/admin/users'),
    enabled: tab === 'users',
  })
  const { data: pubs } = useQuery({
    queryKey: ['admin-pubs'],
    queryFn: () => api<PageResult<{ id: number; title: string; status: string; ownerId: number }>>('/publications/admin/list'),
    enabled: tab === 'publications',
  })
  const { data: models } = useQuery({
    queryKey: ['admin-models'],
    queryFn: () => api<{ items: Array<{ id: number; name: string; modelType: string; enabled: boolean; basePrice: number }> }>('/admin/models'),
    enabled: tab === 'models',
  })
  const { data: txs } = useQuery({
    queryKey: ['admin-tx'],
    queryFn: () => api<Array<{ id: number; orderNo: string; userId: number; points: number; amountCny: number; status: string; createdAt: string }>>('/admin/transactions'),
    enabled: tab === 'transactions',
  })
  const { data: anns } = useQuery({
    queryKey: ['admin-ann'],
    queryFn: () => api<PageResult<{ id: number; title: string; status: string }>>('/admin/announcements'),
    enabled: tab === 'announcements',
  })
  const { data: audit } = useQuery({
    queryKey: ['admin-audit'],
    queryFn: () => api<PageResult<{ id: number; operatorId: number; action: string; targetType: string; targetId?: number; createdAt: string }>>('/admin/audit-logs'),
    enabled: tab === 'audit',
  })
  const { data: tiers } = useQuery({
    queryKey: ['admin-tiers'],
    queryFn: () => api<Array<{ id: number; name: string; level: number; priceCny: number; enabled: boolean }>>('/admin/member-tiers'),
    enabled: tab === 'tiers',
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api(`/admin/users/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
    onSuccess: () => { toastSuccess('已更新'); qc.invalidateQueries({ queryKey: ['admin-users'] }) },
    onError: (e) => toastError((e as Error).message),
  })

  const moderate = useMutation({
    mutationFn: ({ id, action }: { id: number; action: string }) => api(`/publications/admin/${id}/${action}`, { method: 'POST', body: '{}' }),
    onSuccess: () => { toastSuccess('审核完成'); qc.invalidateQueries({ queryKey: ['admin-pubs'] }) },
    onError: (e) => toastError((e as Error).message),
  })

  const toggleModel = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api(`/admin/models/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => { toastSuccess('模型配置已更新'); qc.invalidateQueries({ queryKey: ['admin-models'] }) },
    onError: (e) => toastError((e as Error).message),
  })

  return (
    <div className="w-full">
      <div className="mb-5">
        <h1 className="text-[26px] font-black text-[#111]">运营后台</h1>
        <p className="mt-1 text-[14px] text-[#666]">用户、审核、模型、套餐、交易、公告与审计（对齐 PRD P1）</p>
      </div>
      <div className="mb-5 flex flex-wrap gap-1 rounded-2xl border border-black/6 bg-white p-1.5">
        {(
          [
            ['users', '用户管理', Users],
            ['publications', '内容审核', Boxes],
            ['models', '模型管理', FileSearch],
            ['packages', '充值套餐', Coins],
            ['transactions', '交易管理', Coins],
            ['announcements', '公告管理', Megaphone],
            ['audit', '审计日志', FileSearch],
            ['apikeys', 'API 管理', KeyRound],
            ['tiers', '会员体系', Crown],
          ] as const
        ).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)} className={`flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-bold ${tab === key ? 'bg-[#111] text-white' : 'text-[#666] hover:bg-black/[0.04]'}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === 'users' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <h2 className="mb-3 text-[15px] font-bold">用户列表（共 {users?.total ?? 0}）</h2>
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-[#999]"><tr><th className="py-2">ID</th><th>昵称</th><th>邮箱</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {users?.items.map((u) => (
                <tr key={u.id} className="border-t border-black/4">
                  <td className="py-2 text-[#777]">{u.id}</td>
                  <td className="font-bold">{u.nickname}</td>
                  <td className="text-[#666]">{u.email}</td>
                  <td><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold">{u.role}</span></td>
                  <td className="text-[#777]">{u.status}</td>
                  <td>
                    <select
                      value={u.status}
                      onChange={(e) => setStatus.mutate({ id: u.id, status: e.target.value })}
                      className="h-8 rounded-lg border border-black/10 px-2 text-[12px]"
                    >
                      <option value="active">正常</option>
                      <option value="disabled">禁用</option>
                      <option value="banned">封禁</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'publications' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <h2 className="mb-3 text-[15px] font-bold">公开画布审核</h2>
          <div className="divide-y divide-black/4">
            {pubs?.items.map((p) => (
              <div key={p.id} className="flex items-center gap-3 py-2.5">
                <span className="flex-1 font-semibold text-[#444]">{p.title}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${p.status === 'published' ? 'bg-emerald-100 text-emerald-700' : p.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>{p.status}</span>
                <button onClick={() => moderate.mutate({ id: p.id, action: 'approve' })} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-bold text-white">通过</button>
                <button onClick={() => moderate.mutate({ id: p.id, action: 'reject' })} className="rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-bold text-white">驳回</button>
                <button onClick={() => moderate.mutate({ id: p.id, action: 'take_down' })} className="rounded-lg border border-black/10 px-3 py-1.5 text-[12px] font-bold">下架</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'models' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-bold">AI 模型配置</h2>
            <ModelCreateButton onDone={() => qc.invalidateQueries({ queryKey: ['admin-models'] })} />
          </div>
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-[#999]"><tr><th className="py-2">模型</th><th>类型</th><th>基础价</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              {models?.items.map((m) => (
                <tr key={m.id} className="border-t border-black/4">
                  <td className="py-2 font-bold">{m.name}</td>
                  <td className="text-[#666]">{m.modelType}</td>
                  <td>{m.basePrice} 点</td>
                  <td><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${m.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{m.enabled ? '启用' : '停用'}</span></td>
                  <td><button onClick={() => toggleModel.mutate({ id: m.id, enabled: !m.enabled })} className="rounded-lg border border-black/10 px-3 py-1.5 text-[12px] font-bold">{m.enabled ? '停用' : '启用'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'transactions' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <h2 className="mb-3 text-[15px] font-bold">交易记录</h2>
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-[#999]"><tr><th className="py-2">订单号</th><th>用户</th><th>点数</th><th>金额</th><th>状态</th><th>时间</th></tr></thead>
            <tbody>
              {txs?.map((t) => (
                <tr key={t.id} className="border-t border-black/4">
                  <td className="py-2 text-[#777]">{t.orderNo}</td>
                  <td className="text-[#555]">#{t.userId}</td>
                  <td className="font-bold">{t.points}</td>
                  <td>¥{t.amountCny}</td>
                  <td><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${t.status === 'success' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{t.status}</span></td>
                  <td className="text-[#999]">{new Date(t.createdAt).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'announcements' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-bold">公告管理</h2>
            <AnnouncementCreate onDone={() => qc.invalidateQueries({ queryKey: ['admin-ann'] })} />
          </div>
          <div className="divide-y divide-black/4">
            {anns?.items.map((a) => (
              <div key={a.id} className="flex items-center gap-3 py-2.5">
                <span className="flex-1 font-semibold text-[#444]">{a.title}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-[#666]">{a.status}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'audit' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <h2 className="mb-3 text-[15px] font-bold">审计日志</h2>
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-[#999]"><tr><th className="py-2">操作人</th><th>动作</th><th>对象</th><th>时间</th></tr></thead>
            <tbody>
              {audit?.items.map((a) => (
                <tr key={a.id} className="border-t border-black/4">
                  <td className="py-2 text-[#777]">{a.operatorId ?? '—'}</td>
                  <td className="font-bold">{a.action}</td>
                  <td className="text-[#555]">{a.targetType} #{a.targetId ?? ''}</td>
                  <td className="text-[#999]">{new Date(a.createdAt).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'tiers' && (
        <section className="rounded-2xl border border-black/6 bg-white p-5">
          <h2 className="mb-3 text-[15px] font-bold">会员等级（P2）</h2>
          <div className="grid grid-cols-3 gap-3">
            {tiers?.map((t) => (
              <div key={t.id} className="rounded-xl border border-black/8 p-4">
                <p className="font-bold text-[#111]">{t.name}</p>
                <p className="text-[12px] text-[#999]">Lv.{t.level} · ¥{t.priceCny}/月</p>
                <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${t.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{t.enabled ? '启用' : '停用'}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'apikeys' && <ApiKeysTab />}
      {tab === 'packages' && <PackagesTab />}
    </div>
  )
}

function ModelCreateButton({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [modelType, setModelType] = useState('text')
  const [basePrice, setBasePrice] = useState('10')
  const create = useMutation({
    mutationFn: () =>
      api('/admin/models', {
        method: 'POST',
        body: JSON.stringify({
          name,
          modelType,
          provider:
            modelType === 'text'
              ? 'agnes-text'
              : modelType === 'image'
                ? 'agnes-image'
                : modelType === 'video'
                  ? 'agnes-video'
                  : modelType === 'audio'
                    ? 'doubao-tts'
                    : modelType === 'compose'
                      ? 'mock-compose'
                      : modelType === 'director'
                        ? 'mock-director'
                        : 'openai-text',
          basePrice: Number(basePrice),
        }),
      }),
    onSuccess: () => { toastSuccess('模型已创建'); setOpen(false); onDone() },
    onError: (e) => toastError((e as Error).message),
  })
  return (
    <>
      <Button onClick={() => setOpen(true)}>新增模型</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="新增模型">
        <div className="flex flex-col gap-3">
          <Field label="模型名称"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="类型">
            <Select value={modelType} onChange={(e) => setModelType(e.target.value)}>
              <option value="text">文本</option><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option>
            </Select>
          </Field>
          <Field label="基础价（点数）"><Input type="number" value={basePrice} onChange={(e) => setBasePrice(e.target.value)} /></Field>
          <Button onClick={() => create.mutate()}>保存</Button>
        </div>
      </Modal>
    </>
  )
}

function AnnouncementCreate({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const create = useMutation({
    mutationFn: () => api('/admin/announcements', { method: 'POST', body: JSON.stringify({ title, content, status: 'published' }) }),
    onSuccess: () => { toastSuccess('公告已发布'); setOpen(false); onDone() },
  })
  return (
    <>
      <Button onClick={() => setOpen(true)}>发布公告</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="发布公告">
        <div className="flex flex-col gap-3">
          <Field label="标题"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="内容"><textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-28 rounded-xl border border-black/12 p-3 text-[14px]" /></Field>
          <Button onClick={() => create.mutate()}>发布</Button>
        </div>
      </Modal>
    </>
  )
}

function ApiKeysTab() {
  const { data: keys } = useQuery({ queryKey: ['admin-keys'], queryFn: () => api<Array<{ id: number; name: string; provider: string; enabled: boolean; rateLimit: number }>>('/admin/api-keys') })
  return (
    <section className="rounded-2xl border border-black/6 bg-white p-5">
      <h2 className="mb-3 text-[15px] font-bold">第三方 API Key 管理</h2>
      <div className="divide-y divide-black/4">
        {keys?.map((k) => (
          <div key={k.id} className="flex items-center gap-3 py-2.5">
            <span className="flex-1 font-semibold text-[#444]">{k.name} · {k.provider}</span>
            <span className="text-[12px] text-[#999]">限流 {k.rateLimit}/分</span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${k.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{k.enabled ? '启用' : '停用'}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function PackagesTab() {
  const { data: packages } = useQuery({ queryKey: ['packages'], queryFn: () => api<Array<{ id: number; name: string; points: number; priceCny: number; enabled: boolean }>>('/packages') })
  return (
    <section className="rounded-2xl border border-black/6 bg-white p-5">
      <h2 className="mb-3 text-[15px] font-bold">充值套餐</h2>
      <div className="grid grid-cols-3 gap-3">
        {packages?.map((p) => (
          <div key={p.id} className="rounded-xl border border-black/8 p-4">
            <p className="font-bold text-[#111]">{p.name}</p>
            <p className="text-[12px] text-[#999]">{p.points} 点 · ¥{p.priceCny}</p>
            <span className={`mt-2 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${p.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{p.enabled ? '上架中' : '已下架'}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
