import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { FilePlus2, Upload, Download, Pencil, Trash2, FolderOpen, Search, LayoutGrid } from 'lucide-react'
import { api, ApiError, assetUrl } from '@/lib/api'
import { sid } from '@/lib/ids'
import type { CanvasView, Id, PageResult } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Input'
import { ConfirmDialog, Modal } from '@/components/ui/Modal'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { Spinner } from '@/components/ui/Spinner'
import type { DesktopProject } from '@/desktop/desktop-bridge'

export interface WorkspaceDesktopProject {
  projectId: string
  canvasId: string
  name: string
}

export interface WorkspaceDesktopAdapter {
  projects: WorkspaceDesktopProject[]
  isLoading: boolean
  error: string
  onSelectProject: (project: WorkspaceDesktopProject) => Promise<void>
  onOpenExistingProject: () => Promise<void>
  onCreateProject: (name: string) => Promise<void>
  onExportProject?: (project: WorkspaceDesktopProject) => Promise<void>
}

export function WorkspacePage({ desktopAdapter }: { desktopAdapter?: WorkspaceDesktopAdapter } = {}) {
  if (desktopAdapter) return <DesktopWorkspacePage adapter={desktopAdapter} />
  if (window.vibepaperDesktop) return <WorkspacePageDesktop />
  return <WorkspacePageWeb />
}

function WorkspacePageDesktop() {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<DesktopProject[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const loadProjects = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      const bridge = window.vibepaperDesktop
      if (!bridge) throw new Error('桌面项目接口不可用。')
      setProjects(await bridge.listRecentProjects())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本地项目列表。')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void loadProjects() }, [loadProjects])

  const enterProject = (project: DesktopProject | null) => {
    if (project) navigate(`/canvas/${encodeURIComponent(project.canvasId)}`)
  }
  const selectProject = async (candidate: WorkspaceDesktopProject) => {
    setError('')
    try {
      const bridge = window.vibepaperDesktop
      if (!bridge) throw new Error('桌面项目接口不可用。')
      enterProject(await bridge.openRecentProject(candidate.projectId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开本地项目。')
      await loadProjects()
    }
  }
  const openExistingProject = async () => {
    setError('')
    try {
      enterProject(await window.vibepaperDesktop?.openProject() ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开本地项目。')
    }
  }
  const createProject = async (name: string) => {
    setError('')
    try {
      enterProject(await window.vibepaperDesktop?.createProject(name) ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建本地项目。')
    }
  }
  const exportProject = async (project: WorkspaceDesktopProject) => {
    setError('')
    try {
      const bridge = window.vibepaperDesktop
      if (!bridge) throw new Error('桌面画布导出接口不可用。')
      const document = await bridge.exportCanvas(project.projectId, project.canvasId)
      const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = `${project.name || 'canvas'}.json`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法导出本地画布。')
    }
  }

  return <DesktopWorkspacePage adapter={{
    projects,
    isLoading,
    error,
    onSelectProject: selectProject,
    onOpenExistingProject: openExistingProject,
    onCreateProject: createProject,
    onExportProject: exportProject,
  }} />
}

function WorkspacePageWeb() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [keyword, setKeyword] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CanvasView | null>(null)
  const [renameTarget, setRenameTarget] = useState<CanvasView | null>(null)
  const [newName, setNewName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['canvases', keyword],
    queryFn: () =>
      api<PageResult<CanvasView>>(
        `/canvases?page=1&pageSize=50${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ''}`,
      ),
  })

  const create = useMutation({
    mutationFn: (name: string) => api<CanvasView>('/canvases', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['canvases'] })
      toastSuccess('画布已创建')
      nav(`/canvas/${sid(c.id)}`)
    },
    onError: (e) => toastError((e as Error).message),
  })

  const del = useMutation({
    mutationFn: (id: Id) => api(`/canvases/${sid(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['canvases'] })
      toastSuccess('画布已删除')
    },
    onError: (e) => toastError((e as Error).message),
  })

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: Id; name: string }) =>
      api<CanvasView>(`/canvases/${sid(id)}`, { method: 'PUT', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['canvases'] })
      toastSuccess('已重命名')
    },
  })

  const importJson = useMutation({
    mutationFn: (json: string) => api('/canvases/import', { method: 'POST', body: json }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['canvases'] })
      toastSuccess('导入成功')
    },
    onError: (e) => toastError((e as Error).message),
  })

  const onImportFile = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => importJson.mutate(String(reader.result))
    reader.readAsText(file)
  }

  const onExport = async (c: CanvasView) => {
    try {
      const doc = await api<Record<string, unknown>>(`/canvases/${sid(c.id)}/export`, { method: 'POST' })
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${c.name || 'canvas'}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      toastError(e instanceof ApiError ? e.message : '导出失败')
    }
  }

  const sorted = useMemo(() => {
    const items = [...(data?.items ?? [])]
    items.sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0
      return tb - ta
    })
    return items
  }, [data])

  const currentId = sorted[0] ? sid(sorted[0].id) : null

  return (
    <div className="w-full">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-[28px] font-black tracking-tight text-[#111]">
            <LayoutGrid size={26} strokeWidth={2.4} />
            画布管理
          </h1>
          <p className="mt-2 text-[14px] text-[#888]">管理您的画布，切换后可继续编辑</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#aaa]" />
            <Input
              className="h-11 w-48 rounded-xl border-black/8 bg-white pl-9"
              placeholder="搜索画布"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onImportFile(e.target.files[0])}
          />
          <Button variant="primary" leftIcon={<FilePlus2 size={16} />} onClick={() => setCreateOpen(true)}>
            新建画布
          </Button>
          <Button variant="secondary" leftIcon={<Upload size={16} />} onClick={() => fileRef.current?.click()}>
            导入画布
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-24">
          <Spinner className="h-8 w-8" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-black/12 bg-white/60 py-24 text-center">
          <FolderOpen size={40} className="mx-auto mb-3 text-[#ccc]" />
          <p className="text-[16px] font-bold text-[#444]">还没有画布</p>
          <p className="mt-1 text-[13px] text-[#999]">点击「新建画布」开始创作</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {sorted.map((c) => {
            const isCurrent = sid(c.id) === currentId
            return (
              <div
                key={sid(c.id)}
                className="group relative aspect-[4/3] cursor-pointer overflow-hidden rounded-[18px] shadow-[0_2px_12px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(15,23,42,0.12)]"
                onClick={() => nav(`/canvas/${sid(c.id)}`)}
              >
                <div className="absolute inset-0 bg-gradient-to-b from-[#ececee] via-[#e4e4e8] to-[#c8c8ce]" />
                {assetUrl(c.thumbnailUrl) ? (
                  <img src={assetUrl(c.thumbnailUrl)} alt="" className="absolute inset-0 h-full w-full object-cover" />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <OrigamiIcon />
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/55 to-transparent" />

                {isCurrent && (
                  <span className="absolute left-3 top-3 rounded-md bg-[#111] px-2 py-0.5 text-[11px] font-bold text-white">
                    当前
                  </span>
                )}

                <div className="absolute right-2.5 top-2.5 flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <IconBtn
                    title="重命名"
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenameTarget(c)
                      setNewName(c.name)
                    }}
                  >
                    <Pencil size={13} />
                  </IconBtn>
                  <IconBtn
                    title="下载 JSON"
                    onClick={(e) => {
                      e.stopPropagation()
                      void onExport(c)
                    }}
                  >
                    <Download size={13} />
                  </IconBtn>
                  <IconBtn
                    title="删除"
                    danger
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteTarget(c)
                    }}
                  >
                    <Trash2 size={13} />
                  </IconBtn>
                </div>

                <div className="absolute bottom-0 left-0 right-0 px-4 pb-3.5">
                  <p className="truncate text-[15px] font-bold text-white drop-shadow">{c.name}</p>
                  <p className="mt-0.5 text-[11px] text-white/70">
                    {c.updatedAt ? new Date(c.updatedAt).toLocaleString('zh-CN') : ''} · v{c.version}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="新建画布">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (newName.trim()) {
              create.mutate(newName.trim())
              setCreateOpen(false)
              setNewName('')
            }
          }}
        >
          <Field label="画布名称">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="例如：赛博朋克短片"
              autoFocus
            />
          </Field>
          <Button type="submit">创建并进入</Button>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && del.mutate(deleteTarget.id)}
        title="删除画布"
        message={`确定删除「${deleteTarget?.name ?? ''}」吗？此操作不可恢复。`}
        danger
      />

      <Modal open={!!renameTarget} onClose={() => setRenameTarget(null)} title="重命名画布">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (renameTarget && newName.trim()) {
              rename.mutate({ id: renameTarget.id, name: newName.trim() })
              setRenameTarget(null)
            }
          }}
        >
          <Field label="新名称">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          </Field>
          <Button type="submit">保存</Button>
        </form>
      </Modal>
    </div>
  )
}

function DesktopWorkspacePage({ adapter }: { adapter: WorkspaceDesktopAdapter }) {
  const [keyword, setKeyword] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('我的项目')
  const [busy, setBusy] = useState(false)
  const filteredProjects = useMemo(() => {
    const normalized = keyword.trim().toLocaleLowerCase()
    return adapter.projects.filter((project) => !normalized || project.name.toLocaleLowerCase().includes(normalized))
  }, [adapter.projects, keyword])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await adapter.onCreateProject(name)
      setCreateOpen(false)
      setNewName('我的项目')
    } finally {
      setBusy(false)
    }
  }

  const openExisting = async () => {
    if (busy) return
    setBusy(true)
    try {
      await adapter.onOpenExistingProject()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-[28px] font-black tracking-tight text-[#111]">
            <LayoutGrid size={26} strokeWidth={2.4} />
            画布管理
          </h1>
          <p className="mt-2 text-[14px] text-[#888]">选择本地项目继续创作，或创建一个新项目</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#aaa]" />
            <Input
              className="h-11 w-48 rounded-xl border-black/8 bg-white pl-9"
              placeholder="搜索项目"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <Button variant="primary" leftIcon={<FilePlus2 size={16} />} onClick={() => setCreateOpen(true)}>
            新建本地项目
          </Button>
          <Button variant="secondary" leftIcon={<FolderOpen size={16} />} onClick={() => void openExisting()} disabled={busy}>
            打开已有项目
          </Button>
        </div>
      </div>

      {adapter.error && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">{adapter.error}</p>}
      {adapter.isLoading ? (
        <div className="flex justify-center py-24"><Spinner className="h-8 w-8" /></div>
      ) : filteredProjects.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-black/12 bg-white/60 py-24 text-center">
          <FolderOpen size={40} className="mx-auto mb-3 text-[#ccc]" />
          <p className="text-[16px] font-bold text-[#444]">{adapter.projects.length ? '没有匹配的本地项目' : '还没有打开过本地项目'}</p>
          <p className="mt-1 text-[13px] text-[#999]">可以打开已有项目，或新建本地项目开始创作</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {filteredProjects.map((project) => (
            <div
              key={project.projectId}
              role="button"
              tabIndex={busy ? -1 : 0}
              onClick={() => { if (!busy) void adapter.onSelectProject(project) }}
              onKeyDown={(event) => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void adapter.onSelectProject(project) } }}
              aria-disabled={busy}
              className="group relative aspect-[4/3] cursor-pointer overflow-hidden rounded-[18px] text-left shadow-[0_2px_12px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(15,23,42,0.12)] aria-disabled:cursor-wait aria-disabled:opacity-60"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-[#ececee] via-[#e4e4e8] to-[#c8c8ce]" />
              <div className="absolute inset-0 flex items-center justify-center"><OrigamiIcon /></div>
              <div className="absolute left-3 top-3 rounded-md bg-[#111] px-2 py-0.5 text-[11px] font-bold text-white">本地项目</div>
              {adapter.onExportProject && <span className="absolute right-2.5 top-2.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                <IconBtn title="下载 JSON" onClick={(event) => { event.stopPropagation(); void adapter.onExportProject?.(project) }}>
                  <Download size={13} />
                </IconBtn>
              </span>}
              <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/55 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 px-4 pb-3.5">
                <p className="truncate text-[15px] font-bold text-white drop-shadow">{project.name}</p>
                <p className="mt-0.5 text-[11px] text-white/75">包含 1 个本地画布 · 点击进入</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => { if (!busy) setCreateOpen(false) }} title="新建本地项目">
        <form className="flex flex-col gap-4" onSubmit={(event) => { void create(event) }}>
          <Field label="项目名称">
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：赛博朋克短片" autoFocus />
          </Field>
          <p className="text-[12px] leading-5 text-[#777]">创建后会选择本机文件夹并在其中保存一个画布。</p>
          <Button type="submit" disabled={busy || !newName.trim()}>{busy ? '正在创建…' : '创建并进入'}</Button>
        </form>
      </Modal>
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode
  onClick: (e: React.MouseEvent) => void
  title: string
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-full bg-white/95 shadow-sm ${
        danger ? 'text-red-500 hover:text-red-600' : 'text-[#555] hover:text-[#111]'
      }`}
    >
      {children}
    </button>
  )
}

function OrigamiIcon() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" aria-hidden className="opacity-70">
      <path
        d="M36 12L18 28l8 4 10-8 10 8 8-4L36 12z"
        fill="#5a5a62"
        opacity="0.35"
      />
      <path d="M18 28l8 22 10-14V24l-10 8-8-4z" fill="#3d3d44" />
      <path d="M54 28l-8 22-10-14V24l10 8 8-4z" fill="#2f2f36" />
      <path d="M26 50l10-14 10 14-10 8-10-8z" fill="#4a4a52" />
    </svg>
  )
}
