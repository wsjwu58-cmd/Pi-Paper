import { t as uiText, useUiLanguage, uiLocale } from '@/lib/i18n'
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
import type { DesktopCanvasExportDocument, DesktopCanvasImportResult, DesktopProject } from '@/desktop/desktop-bridge'
import { isDesktopRuntime } from '@/features/canvas/canvasPort'
import { resolveRendererMediaUrl } from '@/lib/media'

export interface WorkspaceDesktopProject {
  projectId: string
  canvasId: string
  name: string
  thumbnailUrl?: string | null
}

export interface WorkspaceDesktopAdapter {
  projects: WorkspaceDesktopProject[]
  activeProjectId?: string | null
  isLoading: boolean
  error: string
  onSelectProject: (project: WorkspaceDesktopProject) => Promise<void>
  onOpenExistingProject: () => Promise<void>
  onCreateProject: (name: string) => Promise<void>
  onExportProject?: (project: WorkspaceDesktopProject) => Promise<void>
  onImportCanvasDocument?: (document: DesktopCanvasExportDocument) => Promise<DesktopCanvasImportResult | null>
  onRenameProject?: (project: WorkspaceDesktopProject, name: string) => Promise<void>
  onDeleteProject?: (project: WorkspaceDesktopProject) => Promise<boolean>
}

export function WorkspacePage({ desktopAdapter }: { desktopAdapter?: WorkspaceDesktopAdapter } = {}) {
  useUiLanguage()
  if (desktopAdapter) return <DesktopWorkspacePage adapter={desktopAdapter} />
  if (isDesktopRuntime()) return <WorkspacePageDesktop />
  return <WorkspacePageWeb />
}

function WorkspacePageDesktop() {
  useUiLanguage()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<DesktopProject[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const loadProjects = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      const bridge = window.vibepaperDesktop
      if (!bridge) throw new Error(uiText("桌面项目接口不可用。"))
      const [recent, active] = await Promise.all([bridge.listRecentProjects(), bridge.getActiveProject()])
      setProjects(recent)
      setActiveProjectId(active?.projectId ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uiText("无法读取本地项目列表。"))
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
      if (!bridge) throw new Error(uiText("桌面项目接口不可用。"))
      enterProject(await bridge.openRecentProject(candidate.projectId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uiText("无法打开本地项目。"))
      await loadProjects()
    }
  }
  const openExistingProject = async () => {
    setError('')
    try {
      enterProject(await window.vibepaperDesktop?.openProject() ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uiText("无法打开本地项目。"))
    }
  }
  const createProject = async (name: string) => {
    setError('')
    try {
      enterProject(await window.vibepaperDesktop?.createProject(name) ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uiText("无法创建本地项目。"))
    }
  }
  const exportProject = async (project: WorkspaceDesktopProject) => {
    setError('')
    try {
      const bridge = window.vibepaperDesktop
      if (!bridge) throw new Error(uiText("桌面画布导出接口不可用。"))
      const document = await bridge.exportCanvas(project.projectId, project.canvasId)
      const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = `${project.name || 'canvas'}.json`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : uiText("无法导出本地画布。"))
    }
  }

  const importCanvasDocument = async (document: DesktopCanvasExportDocument) => {
    const bridge = window.vibepaperDesktop
    if (!bridge) throw new Error(uiText("桌面画布导入接口不可用。"))
    const result = await bridge.importCanvasDocument(document)
    if (result) {
      if (result.warnings.length > 0) toastError(result.warnings.join('；'))
      enterProject(result.project)
    }
    return result
  }

  const renameProject = async (project: WorkspaceDesktopProject, name: string) => {
    const bridge = window.vibepaperDesktop
    if (!bridge) throw new Error(uiText("桌面项目接口不可用。"))
    await bridge.renameProject(project.projectId, name)
    await loadProjects()
  }

  const deleteProject = async (project: WorkspaceDesktopProject) => {
    const bridge = window.vibepaperDesktop
    if (!bridge) throw new Error(uiText("桌面项目接口不可用。"))
    const deleted = await bridge.deleteProject(project.projectId)
    if (!deleted) return false
    await loadProjects()
    return true
  }

  return <DesktopWorkspacePage adapter={{
    projects,
    activeProjectId,
    isLoading,
    error,
    onSelectProject: selectProject,
    onOpenExistingProject: openExistingProject,
    onCreateProject: createProject,
    onExportProject: exportProject,
    onImportCanvasDocument: importCanvasDocument,
    onRenameProject: renameProject,
    onDeleteProject: deleteProject,
  }} />
}

function WorkspacePageWeb() {
  useUiLanguage()
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
      toastSuccess(uiText("画布已创建"))
      nav(`/canvas/${sid(c.id)}`)
    },
    onError: (e) => toastError((e as Error).message),
  })

  const del = useMutation({
    mutationFn: (id: Id) => api(`/canvases/${sid(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['canvases'] })
      toastSuccess(uiText("画布已删除"))
    },
    onError: (e) => toastError((e as Error).message),
  })

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: Id; name: string }) =>
      api<CanvasView>(`/canvases/${sid(id)}`, { method: 'PUT', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['canvases'] })
      toastSuccess(uiText("已重命名"))
    },
  })

  const importJson = useMutation({
    mutationFn: (json: string) => api('/canvases/import', { method: 'POST', body: json }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['canvases'] })
      toastSuccess(uiText("导入成功"))
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
      toastError(e instanceof ApiError ? e.message : uiText("导出失败"))
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
            {uiText("画布管理")}</h1>
          <p className="mt-2 text-[14px] text-[#888]">{uiText("管理您的画布，切换后可继续编辑")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#aaa]" />
            <Input
              className="h-11 w-48 rounded-xl border-black/8 bg-white pl-9"
              placeholder={uiText("搜索画布")}
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
            {uiText("新建画布")}</Button>
          <Button variant="secondary" leftIcon={<Upload size={16} />} onClick={() => fileRef.current?.click()}>
            {uiText("导入画布")}</Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-24">
          <Spinner className="h-8 w-8" />
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-black/12 bg-white/60 py-24 text-center">
          <FolderOpen size={40} className="mx-auto mb-3 text-[#ccc]" />
          <p className="text-[16px] font-bold text-[#444]">{uiText("还没有画布")}</p>
          <p className="mt-1 text-[13px] text-[#999]">{uiText("点击「新建画布」开始创作")}</p>
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
                    {uiText("当前")}</span>
                )}

                <div className="absolute right-2.5 top-2.5 flex gap-1 opacity-0 transition group-hover:opacity-100">
                  <IconBtn
                    title={uiText("重命名")}
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenameTarget(c)
                      setNewName(c.name)
                    }}
                  >
                    <Pencil size={13} />
                  </IconBtn>
                  <IconBtn
                    title={uiText("下载 JSON")}
                    onClick={(e) => {
                      e.stopPropagation()
                      void onExport(c)
                    }}
                  >
                    <Download size={13} />
                  </IconBtn>
                  <IconBtn
                    title={uiText("删除")}
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
                    {c.updatedAt ? new Date(c.updatedAt).toLocaleString(uiLocale()) : ''} · v{c.version}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={uiText("新建画布")}>
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
          <Field label={uiText("画布名称")}>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={uiText("例如：赛博朋克短片")}
              autoFocus
            />
          </Field>
          <Button type="submit">{uiText("创建并进入")}</Button>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && del.mutate(deleteTarget.id)}
        title={uiText("删除画布")}
        message={uiText("确定删除「{0}」吗？此操作不可恢复。", { 0: deleteTarget?.name ?? '' })}
        danger
      />

      <Modal open={!!renameTarget} onClose={() => setRenameTarget(null)} title={uiText("重命名画布")}>
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
          <Field label={uiText("新名称")}>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          </Field>
          <Button type="submit">{uiText("保存")}</Button>
        </form>
      </Modal>
    </div>
  )
}

function DesktopWorkspacePage({ adapter }: { adapter: WorkspaceDesktopAdapter }) {
  useUiLanguage()
  const [keyword, setKeyword] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState(uiText("我的项目"))
  const [renameTarget, setRenameTarget] = useState<WorkspaceDesktopProject | null>(null)
  const [renameName, setRenameName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceDesktopProject | null>(null)
  const [busy, setBusy] = useState(false)
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null)
  const [operationError, setOperationError] = useState('')
  const [operationNotice, setOperationNotice] = useState('')
  const importFileRef = useRef<HTMLInputElement>(null)
  const filteredProjects = useMemo(() => {
    const normalized = keyword.trim().toLocaleLowerCase()
    return adapter.projects.filter((project) => !normalized || project.name.toLocaleLowerCase().includes(normalized))
  }, [adapter.projects, keyword])

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    setOperationError('')
    try {
      await adapter.onCreateProject(name)
      setCreateOpen(false)
      setNewName(uiText("我的项目"))
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : uiText("无法创建本地项目。"))
    } finally {
      setBusy(false)
    }
  }

  const openExisting = async () => {
    if (busy) return
    setBusy(true)
    setOperationError('')
    try {
      await adapter.onOpenExistingProject()
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : uiText("无法打开本地项目。"))
    } finally {
      setBusy(false)
    }
  }

  const selectProject = async (project: WorkspaceDesktopProject) => {
    if (busy) return
    setBusy(true)
    setOpeningProjectId(project.projectId)
    setOperationError('')
    setOperationNotice('')
    try {
      await adapter.onSelectProject(project)
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : uiText("无法打开本地项目。"))
    } finally {
      setBusy(false)
      setOpeningProjectId(null)
    }
  }

  const importCanvasFile = async (file?: File) => {
    if (!file || !adapter.onImportCanvasDocument || busy) return
    setBusy(true)
    setOperationError('')
    setOperationNotice('')
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error(uiText("画布 JSON 文件不能超过 32 MB。"))
      const parsed = JSON.parse(await file.text()) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(uiText("JSON 文件内容无效。"))
      const result = await adapter.onImportCanvasDocument(parsed as DesktopCanvasExportDocument)
      if (result) {
        setOperationNotice(result.warnings.length ? uiText("画布已导入。{0}", { 0: result.warnings.join('；') }) : uiText("画布已导入。"))
      }
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : uiText("无法导入画布 JSON。"))
    } finally {
      setBusy(false)
      if (importFileRef.current) importFileRef.current.value = ''
    }
  }

  const rename = async (event: React.FormEvent) => {
    event.preventDefault()
    const target = renameTarget
    const name = renameName.trim()
    if (!target || !name || !adapter.onRenameProject || busy) return
    setBusy(true)
    setOperationError('')
    setOperationNotice('')
    try {
      await adapter.onRenameProject(target, name)
      setRenameTarget(null)
      setOperationNotice(uiText("项目已重命名。"))
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : uiText("无法重命名本地项目。"))
    } finally {
      setBusy(false)
    }
  }

  const deleteProject = async (target: WorkspaceDesktopProject) => {
    if (!adapter.onDeleteProject || busy) return
    setBusy(true)
    setOperationError('')
    setOperationNotice('')
    try {
      const deleted = await adapter.onDeleteProject(target)
      if (deleted) setOperationNotice(uiText("项目已移至系统回收站。"))
    } catch (cause) {
      setOperationError(cause instanceof Error ? cause.message : uiText("无法删除本地项目。"))
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
            {uiText("画布管理")}</h1>
          <p className="mt-2 text-[14px] text-[#888]">{uiText("选择本地项目继续创作，或创建一个新项目")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#aaa]" />
            <Input
              className="h-11 w-48 rounded-xl border-black/8 bg-white pl-9"
              placeholder={uiText("搜索项目")}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <Button variant="primary" leftIcon={<FilePlus2 size={16} />} onClick={() => setCreateOpen(true)}>
            {uiText("新建本地项目")}</Button>
          <Button variant="secondary" leftIcon={<FolderOpen size={16} />} onClick={() => void openExisting()} disabled={busy}>
            {uiText("打开已有项目")}</Button>
          {adapter.onImportCanvasDocument && (
            <>
              <input
                ref={importFileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => { void importCanvasFile(event.target.files?.[0]) }}
              />
              <Button variant="secondary" leftIcon={<Upload size={16} />} onClick={() => importFileRef.current?.click()} disabled={busy}>
                {uiText("导入画布 JSON")}</Button>
            </>
          )}
        </div>
      </div>

      {adapter.error && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">{adapter.error}</p>}
      {operationError && <p role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">{operationError}</p>}
      {operationNotice && <p role="status" className="mb-4 rounded-xl bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{operationNotice}</p>}
      {adapter.isLoading ? (
        <div className="flex justify-center py-24"><Spinner className="h-8 w-8" /></div>
      ) : filteredProjects.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-black/12 bg-white/60 py-24 text-center">
          <FolderOpen size={40} className="mx-auto mb-3 text-[#ccc]" />
          <p className="text-[16px] font-bold text-[#444]">{adapter.projects.length ? uiText("没有匹配的本地项目") : uiText("还没有打开过本地项目")}</p>
          <p className="mt-1 text-[13px] text-[#999]">{uiText("可以打开已有项目，或新建本地项目开始创作")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {filteredProjects.map((project) => (
            <div
              key={project.projectId}
              role="button"
              tabIndex={busy ? -1 : 0}
              onClick={() => { void selectProject(project) }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void selectProject(project) } }}
              aria-disabled={busy}
              className="group relative aspect-[4/3] cursor-pointer overflow-hidden rounded-[18px] text-left shadow-[0_2px_12px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(15,23,42,0.12)] aria-disabled:cursor-wait aria-disabled:opacity-60"
            >
              <div className="absolute inset-0 bg-gradient-to-b from-[#ececee] via-[#e4e4e8] to-[#c8c8ce]" />
              {resolveRendererMediaUrl(project.thumbnailUrl ?? undefined) ? (
                <img src={resolveRendererMediaUrl(project.thumbnailUrl ?? undefined)} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center"><OrigamiIcon /></div>
              )}
              <div className="absolute left-3 top-3 rounded-md bg-[#111] px-2 py-0.5 text-[11px] font-bold text-white">{uiText("本地项目")}</div>
              {(adapter.onExportProject || adapter.onRenameProject || adapter.onDeleteProject) && <span className="absolute right-2.5 top-2.5 flex gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                {adapter.onRenameProject && <IconBtn title={uiText("重命名项目")} onClick={(event) => { event.stopPropagation(); setRenameTarget(project); setRenameName(project.name); setOperationError(''); setOperationNotice('') }}>
                  <Pencil size={13} />
                </IconBtn>}
                {adapter.onExportProject && <IconBtn title={uiText("下载 JSON")} onClick={(event) => { event.stopPropagation(); void adapter.onExportProject?.(project).catch((cause) => setOperationError(cause instanceof Error ? cause.message : uiText("无法导出本地画布。"))) }}>
                  <Download size={13} />
                </IconBtn>}
                {adapter.onDeleteProject && <IconBtn title={project.projectId === adapter.activeProjectId ? uiText("当前项目不能删除") : uiText("删除项目")} danger disabled={project.projectId === adapter.activeProjectId || busy} onClick={(event) => { event.stopPropagation(); if (project.projectId !== adapter.activeProjectId) setDeleteTarget(project) }}>
                  <Trash2 size={13} />
                </IconBtn>}
              </span>}
              <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/55 to-transparent" />
              <div className="absolute bottom-0 left-0 right-0 px-4 pb-3.5">
                <p className="truncate text-[15px] font-bold text-white drop-shadow">{project.name}</p>
                <p className="mt-0.5 text-[11px] text-white/75">
                  {openingProjectId === project.projectId ? uiText("正在打开本地项目…") : uiText("包含 1 个本地画布 · 点击进入")}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={createOpen} onClose={() => { if (!busy) setCreateOpen(false) }} title={uiText("新建本地项目")}>
        <form className="flex flex-col gap-4" onSubmit={(event) => { void create(event) }}>
          <Field label={uiText("项目名称")}>
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={uiText("例如：赛博朋克短片")} autoFocus />
          </Field>
          <p className="text-[12px] leading-5 text-[#777]">{uiText("创建后会选择本机文件夹并在其中保存一个画布。")}</p>
          <Button type="submit" disabled={busy || !newName.trim()}>{busy ? uiText("正在创建…") : uiText("创建并进入")}</Button>
        </form>
      </Modal>
      <Modal open={!!renameTarget} onClose={() => { if (!busy) setRenameTarget(null) }} title={uiText("重命名项目")}>
        <form className="flex flex-col gap-4" onSubmit={(event) => { void rename(event) }}>
          <Field label={uiText("项目名称")}>
            <Input value={renameName} onChange={(event) => setRenameName(event.target.value)} autoFocus />
          </Field>
          <Button type="submit" disabled={busy || !renameName.trim()}>{busy ? uiText("正在保存…") : uiText("保存")}</Button>
        </form>
      </Modal>
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => { if (!busy) setDeleteTarget(null) }}
        onConfirm={() => { if (deleteTarget) void deleteProject(deleteTarget); setDeleteTarget(null) }}
        title={uiText("删除本地项目")}
        message={deleteTarget?.projectId === adapter.activeProjectId
          ? uiText("当前打开的项目不能删除。")
          : uiText("确定删除「{0}」吗？整个本地项目文件夹会移到系统回收站/废纸篓，可从那里恢复，不会立即物理删除。", { 0: deleteTarget?.name ?? '' })}
        danger
      />
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  title,
  danger,
  disabled,
}: {
  children: React.ReactNode
  onClick: (e: React.MouseEvent) => void
  title: string
  danger?: boolean
  disabled?: boolean
}) {
  useUiLanguage()
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-full bg-white/95 shadow-sm disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? 'text-red-500 hover:text-red-600' : 'text-[#555] hover:text-[#111]'
      }`}
    >
      {children}
    </button>
  )
}

function OrigamiIcon() {
  useUiLanguage()
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
