/**
 * Skills 面板：按产品截图 1:1 复刻列表 / 详情 / 新建。
 * 数据一律来自 /api/v1/skills（数据库），不读本地 md。
 */
import { toastError, toastSuccess } from '@/components/ui/Toast'
import type { MouseEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  LayoutGrid,
  Plus,
  Puzzle,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Type,
  User,
  X,
  Image as ImageIcon,
} from 'lucide-react'
import { api } from '@/lib/api'
import type { SkillView } from '@/lib/types'

const FAV_KEY = 'vp_skill_favorites'

type CategoryKey = 'all' | 'favorite' | 'image' | 'video' | 'text' | 'mine'

const CATEGORIES: { key: CategoryKey; label: string; icon: typeof LayoutGrid }[] = [
  { key: 'all', label: '全部', icon: LayoutGrid },
  { key: 'favorite', label: '收藏', icon: Star },
  { key: 'image', label: '图片', icon: ImageIcon },
  { key: 'video', label: '视频', icon: Camera },
  { key: 'text', label: '文本', icon: Type },
  { key: 'mine', label: '我的', icon: User },
]

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

function saveFavorites(ids: Set<string>) {
  localStorage.setItem(FAV_KEY, JSON.stringify([...ids]))
}

function renderMarkdownLite(md: string) {
  const lines = (md || '').split('\n')
  const nodes: ReactNode[] = []
  let listBuf: string[] = []
  const flushList = () => {
    if (!listBuf.length) return
    nodes.push(
      <ul key={`ul-${nodes.length}`} className="my-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-[#333]">
        {listBuf.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>,
    )
    listBuf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('# ')) {
      flushList()
      nodes.push(
        <h1 key={i} className="mb-2 mt-1 text-[18px] font-bold text-[#111]">
          {line.slice(2)}
        </h1>,
      )
    } else if (line.startsWith('## ')) {
      flushList()
      nodes.push(
        <h2 key={i} className="mb-1.5 mt-4 text-[14px] font-bold text-[#111]">
          {line.slice(3)}
        </h2>,
      )
    } else if (line.startsWith('### ')) {
      flushList()
      nodes.push(
        <h3 key={i} className="mb-1 mt-3 text-[13px] font-bold text-[#444]">
          {line.slice(4)}
        </h3>,
      )
    } else if (/^\s*[-*]\s+/.test(line)) {
      listBuf.push(line.replace(/^\s*[-*]\s+/, ''))
    } else if (line.trim() === '') {
      flushList()
    } else if (line.startsWith('|')) {
      flushList()
      // skip table pipes in lite view as plain text
      nodes.push(
        <p key={i} className="my-1 font-mono text-[11px] text-[#666]">
          {line}
        </p>,
      )
    } else {
      flushList()
      nodes.push(
        <p key={i} className="my-1.5 text-[13px] leading-relaxed text-[#333]">
          {line}
        </p>,
      )
    }
  }
  flushList()
  return nodes
}

export function SkillsPanel({
  sessionId,
  onClose,
  onBackToChat,
  onApplied,
  desktopSkills,
  loadedSkillIds = [],
}: {
  sessionId: string | number | null
  onClose: () => void
  onBackToChat: () => void
  onApplied?: (name: string) => void
  desktopSkills?: readonly SkillView[]
  loadedSkillIds?: readonly string[]
}) {
  const [skills, setSkills] = useState<SkillView[]>([])
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState<CategoryKey>('all')
  const [favorites, setFavorites] = useState<Set<string>>(() => loadFavorites())
  const [view, setView] = useState<'list' | 'detail' | 'create'>('list')
  const [active, setActive] = useState<SkillView | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [draft, setDraft] = useState({ name: '', description: '', instructions: '', category: 'general' })
  const [enabledLocal, setEnabledLocal] = useState(true)
  const [loading, setLoading] = useState(false)
  const desktopMode = desktopSkills !== undefined

  const reload = useCallback(() => {
    if (desktopMode) {
      setLoading(false)
      return
    }
    setLoading(true)
    void api<{ items: SkillView[] }>(`/skills${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`)
      .then((r) => setSkills(r.items ?? []))
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [desktopMode, keyword])

  useEffect(() => {
    if (desktopMode) return
    reload()
  }, [desktopMode, reload])

  const filtered = useMemo(() => {
    let list = (desktopSkills ?? skills).filter((s) => s.name !== 'paper-agent-default')
    const normalizedKeyword = keyword.trim().toLocaleLowerCase()
    if (normalizedKeyword) {
      list = list.filter((skill) =>
        [skill.id, skill.name, skill.description, skill.instructions]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase().includes(normalizedKeyword)),
      )
    }
    if (category === 'favorite') {
      list = list.filter((s) => favorites.has(String(s.id)))
    } else if (category === 'mine') {
      list = list.filter((s) => !desktopMode && s.source !== 'builtin')
    } else if (category === 'image' || category === 'video' || category === 'text') {
      list = list.filter((s) => (s.category || 'general') === category)
    }
    return list
  }, [desktopMode, desktopSkills, skills, keyword, category, favorites])

  const toggleFav = (id: string | number, e?: MouseEvent) => {
    e?.stopPropagation()
    const next = new Set(favorites)
    const key = String(id)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setFavorites(next)
    saveFavorites(next)
  }

  const openDetail = async (s: SkillView) => {
    if (desktopMode) {
      setActive(s)
      setEnabledLocal(true)
      setView('detail')
      return
    }
    try {
      const full = await api<SkillView>(`/skills/${s.id}`)
      setActive(full)
      setEnabledLocal(full.enabled !== false)
      setView('detail')
    } catch {
      setActive(s)
      setEnabledLocal(s.enabled !== false)
      setView('detail')
    }
  }

  const applySkill = async () => {
    if (!active) return
    if (desktopMode) {
      onApplied?.(active.name)
      toastSuccess(`已选择 Skill：${active.name}`)
      onBackToChat()
      return
    }
    if (!sessionId) {
      toastError('请先打开一个对话')
      return
    }
    try {
      await api(`/agent/sessions/${sessionId}/skills/${active.id}:attach`, { method: 'POST' })
      toastSuccess(`已应用 Skill：${active.name}`)
      onApplied?.(active.name)
      onBackToChat()
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const saveCreate = async () => {
    if (!draft.name.trim() || !draft.instructions.trim()) {
      toastError('名称与指令必填')
      return
    }
    try {
      await api('/skills', {
        method: 'POST',
        body: JSON.stringify(draft),
      })
      toastSuccess('Skill 已创建')
      setDraft({ name: '', description: '', instructions: '', category: 'general' })
      setView('list')
      reload()
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const toggleEnabled = async (on: boolean) => {
    if (desktopMode) return
    setEnabledLocal(on)
    if (!active || active.source === 'builtin') return
    try {
      const updated = await api<SkillView>(`/skills/${active.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: on }),
      })
      setActive(updated)
      reload()
    } catch (e) {
      setEnabledLocal(!on)
      toastError((e as Error).message)
    }
  }

  // —— 详情页 ——
  if (view === 'detail' && active) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col bg-white">
        <div className="flex items-center gap-2 border-b border-black/[0.06] px-3 py-3">
          <button
            type="button"
            onClick={() => setView('list')}
            className="rounded-full p-1.5 text-[#555] hover:bg-black/[0.04]"
            aria-label="返回"
          >
            <ArrowLeft size={18} />
          </button>
          <p className="min-w-0 flex-1 truncate text-[15px] font-bold text-[#111]">{active.name}</p>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-[#888] hover:bg-black/[0.04]">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <section>
            <p className="mb-2 text-[13px] font-bold text-[#888]">描述</p>
            <div className="rounded-2xl bg-[#f3f4f6] px-3.5 py-3 text-[13px] leading-relaxed text-[#333]">
              {active.description || '暂无描述'}
            </div>
          </section>
          <section>
            <p className="mb-2 text-[13px] font-bold text-[#888]">指令</p>
            <div className="rounded-2xl border border-black/[0.08] bg-white px-3.5 py-3">
              {renderMarkdownLite(active.instructions || '')}
            </div>
          </section>
        </div>

        <div className="flex items-center justify-between border-t border-black/[0.06] px-4 py-3">
          <button
            type="button"
            role="switch"
            aria-checked={enabledLocal}
            disabled={desktopMode || active.source === 'builtin'}
            onClick={() => void toggleEnabled(!enabledLocal)}
            title={desktopMode ? '桌面版内置 Skill 始终可用' : active.source === 'builtin' ? '内置 Skill 始终可用' : '启用/停用'}
            className={`relative h-7 w-12 rounded-full transition ${
              enabledLocal ? 'bg-[#1f2937]' : 'bg-[#d1d5db]'
            } ${desktopMode || active.source === 'builtin' ? 'opacity-50' : ''}`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${
                enabledLocal ? 'left-[22px]' : 'left-0.5'
              }`}
            />
          </button>
          <button
            type="button"
            onClick={() => void applySkill()}
            className="h-10 min-w-[120px] rounded-xl bg-[#111827] px-6 text-[14px] font-bold text-white"
          >
            应用
          </button>
        </div>
      </div>
    )
  }

  // —— 新建 ——
  if (view === 'create') {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col bg-white">
        <div className="flex items-center gap-2 border-b border-black/[0.06] px-3 py-3">
          <button type="button" onClick={() => setView('list')} className="rounded-full p-1.5 text-[#555] hover:bg-black/[0.04]">
            <ArrowLeft size={18} />
          </button>
          <p className="flex-1 text-[15px] font-bold text-[#111]">新建 Skill</p>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-[#888] hover:bg-black/[0.04]">
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="名称"
            className="h-10 w-full rounded-xl border border-black/10 bg-[#f9fafb] px-3 text-[13px]"
          />
          <textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="描述"
            className="h-20 w-full rounded-xl border border-black/10 bg-[#f3f4f6] px-3 py-2 text-[13px]"
          />
          <textarea
            value={draft.instructions}
            onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            placeholder="指令（支持 Markdown）"
            className="h-48 w-full rounded-xl border border-black/10 px-3 py-2 font-mono text-[12px]"
          />
          <select
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            className="h-10 w-full rounded-xl border border-black/10 bg-white px-3 text-[13px]"
          >
            <option value="general">通用</option>
            <option value="image">图片</option>
            <option value="video">视频</option>
            <option value="text">文本</option>
            <option value="canvas">画布</option>
          </select>
        </div>
        <div className="flex gap-2 border-t border-black/[0.06] px-4 py-3">
          <button type="button" onClick={() => setView('list')} className="h-10 flex-1 rounded-xl border border-black/10 text-[13px] font-bold">
            取消
          </button>
          <button type="button" onClick={() => void saveCreate()} className="h-10 flex-1 rounded-xl bg-[#111827] text-[13px] font-bold text-white">
            保存
          </button>
        </div>
      </div>
    )
  }

  // —— 列表（截图 1:1）——
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-white">
      <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
        <h2 className="text-[18px] font-bold tracking-tight text-[#111]">Skills</h2>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setView('create')}
            disabled={desktopMode}
            title={desktopMode ? '桌面版项目自定义 Skill 尚未接入' : '新建 Skill'}
            className="flex h-8 items-center gap-1 rounded-full bg-[#111] px-3 text-[12px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus size={14} strokeWidth={2.5} /> 新建
          </button>
          <button
            type="button"
            onClick={() => {
              const target = filtered.find((s) => String(s.id) === hoverId) ?? filtered[0]
              if (target) void openDetail(target)
              else toastError('暂无 Skill，请先新建或等待默认 Skill 同步')
            }}
            className="flex h-8 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold text-[#333] hover:bg-black/[0.04]"
            title="查看详情"
          >
            <SlidersHorizontal size={14} /> 管理
          </button>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-[#888] hover:bg-black/[0.04]">
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="px-4">
        <div className="flex h-10 items-center gap-2 rounded-full bg-[#f3f4f6] px-3.5">
          <Search size={15} className="text-[#9ca3af]" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索名称或描述"
            className="h-full w-full bg-transparent text-[13px] text-[#111] outline-none placeholder:text-[#9ca3af]"
          />
        </div>
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {CATEGORIES.map(({ key, label, icon: Icon }) => {
            const activeCat = category === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setCategory(key)}
                className={`flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold transition ${
                  activeCat ? 'bg-[#111827] text-white' : 'bg-transparent text-[#4b5563] hover:bg-black/[0.04]'
                }`}
              >
                <Icon size={13} strokeWidth={activeCat ? 2.25 : 2} />
                {label}
              </button>
            )
          })}
        </div>
        {desktopMode && (
          <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[10px] leading-relaxed text-amber-800">
            当前仅支持内置 SYSTEM_SKILLS；项目自定义 Skill 的创建、导入和管理尚未接入桌面版。
          </p>
        )}
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading && <p className="px-3 py-6 text-center text-[12px] text-[#999]">加载中…</p>}
        {!loading && filtered.length === 0 && (
          <p className="px-3 py-8 text-center text-[12px] text-[#999]">暂无 Skill</p>
        )}
        {filtered.map((s) => {
          const id = String(s.id)
          const hovered = hoverId === id
          const fav = favorites.has(id)
          return (
            <button
              key={id}
              type="button"
              onMouseEnter={() => setHoverId(id)}
              onMouseLeave={() => setHoverId(null)}
              onClick={() => void openDetail(s)}
              className={`flex w-full items-center gap-3 rounded-2xl px-2.5 py-2.5 text-left transition ${
                hovered ? 'bg-[#f3f4f6]' : 'bg-transparent'
              }`}
            >
              <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#f3f4f6] text-[#6b7280]">
                {(s.category || '') === 'image' ? (
                  <ImageIcon size={18} />
                ) : (s.category || '') === 'video' ? (
                  <Camera size={18} />
                ) : (
                  <Sparkles size={18} />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="block truncate text-[14px] font-bold text-[#111]">{s.name}</span>
                  {desktopMode && loadedSkillIds.includes(id) && (
                    <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">本会话已加载</span>
                  )}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-[#9ca3af]">
                  {s.description || s.instructions?.slice(0, 80) || ''}
                </span>
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => toggleFav(s.id, e)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') toggleFav(s.id)
                }}
                className="rounded-full p-1.5 text-[#9ca3af] hover:bg-white/80"
              >
                <Star size={16} className={fav ? 'fill-[#f59e0b] text-[#f59e0b]' : ''} />
              </span>
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-around border-t border-black/[0.06] px-6 py-2.5">
        <button type="button" className="rounded-full p-2 text-[#2563eb]" title="Skills" aria-current="page">
          <Puzzle size={18} />
        </button>
        <button type="button" onClick={onBackToChat} className="rounded-full p-2 text-[#9ca3af] hover:text-[#555]" title="偏好">
          <SlidersHorizontal size={18} />
        </button>
        <button type="button" onClick={onBackToChat} className="rounded-full p-2 text-[#9ca3af] hover:text-[#555]" title="对话">
          <CheckCircle2 size={18} />
        </button>
      </div>
    </div>
  )
}
