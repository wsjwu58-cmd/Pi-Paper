import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Copy, RotateCcw, RefreshCw } from 'lucide-react'
import { api, assetUrl } from '@/lib/api'
import type { GenerationTask, PageResult } from '@/lib/types'
import { Input, Select } from '@/components/ui/Input'
import { toastSuccess } from '@/components/ui/Toast'
import { Spinner } from '@/components/ui/Spinner'
import { Modal } from '@/components/ui/Modal'
import type {
  DesktopProject,
  DesktopTask,
  DesktopTaskInputSnapshot,
  DesktopTaskSearchQuery,
  DesktopTaskSearchResult,
} from '@/desktop/desktop-bridge'

const statusMeta: Record<string, { text: string; cls: string }> = {
  queued: { text: '排队中', cls: 'bg-amber-100 text-amber-700' },
  running: { text: '执行中', cls: 'bg-blue-100 text-blue-700' },
  succeeded: { text: '成功', cls: 'bg-emerald-100 text-emerald-700' },
  failed: { text: '失败', cls: 'bg-red-100 text-red-700' },
  cancelled: { text: '已取消', cls: 'bg-slate-200 text-slate-600' },
  expired: { text: '已过期', cls: 'bg-slate-200 text-slate-600' },
}

export interface HistoryDesktopAdapter {
  projectId?: string | null
  projectName: string | null
  tasks: DesktopTask[]
  isLoading: boolean
  error: string
  reload: () => Promise<void>
  searchTasks?: (query: DesktopTaskSearchQuery) => Promise<DesktopTaskSearchResult>
  getTaskInput?: (taskId: string) => Promise<DesktopTaskInputSnapshot | null>
  readTaskOutput?: (taskId: string) => Promise<string>
}

export function HistoryPage({ desktopAdapter }: { desktopAdapter?: HistoryDesktopAdapter } = {}) {
  if (desktopAdapter) return <DesktopHistoryPage adapter={desktopAdapter} />
  if (window.vibepaperDesktop) return <HistoryPageDesktop />
  return <HistoryPageWeb />
}

function HistoryPageDesktop() {
  const [project, setProject] = useState<DesktopProject | null>(null)
  const [tasks, setTasks] = useState<DesktopTask[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      const bridge = window.vibepaperDesktop
      if (!bridge) throw new Error('桌面任务接口不可用。')
      const active = await bridge.getActiveProject()
      setProject(active)
      setTasks([])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取本地任务记录。')
      setTasks([])
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const searchTasks = useCallback(async (query: DesktopTaskSearchQuery): Promise<DesktopTaskSearchResult> => {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 20
    if (!project) return { items: [], total: 0, page, pageSize }
    const bridge = window.vibepaperDesktop
    if (!bridge) throw new Error('桌面任务接口不可用。')
    return bridge.searchTasks(project.projectId, query)
  }, [project])

  const getTaskInput = useCallback(async (taskId: string): Promise<DesktopTaskInputSnapshot | null> => {
    if (!project) return null
    const bridge = window.vibepaperDesktop
    if (!bridge) throw new Error('桌面任务接口不可用。')
    return bridge.getTaskInput(project.projectId, taskId)
  }, [project])
  const readTaskOutput = useCallback(async (taskId: string): Promise<string> => {
    if (!project) throw new Error('没有已打开的本地项目。')
    const bridge = window.vibepaperDesktop
    if (!bridge) throw new Error('桌面任务接口不可用。')
    return bridge.readTaskOutput(project.projectId, taskId)
  }, [project])

  return <DesktopHistoryPage adapter={{
    projectId: project?.projectId ?? null,
    projectName: project?.name ?? null,
    tasks,
    isLoading,
    error,
    reload,
    searchTasks,
    getTaskInput,
    readTaskOutput,
  }} />
}

function HistoryPageWeb() {
  const [keyword, setKeyword] = useState('')
  const [model, setModel] = useState('')
  const [taskType, setTaskType] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  const params = new URLSearchParams({ page: String(page), pageSize: '20' })
  if (keyword) params.set('keyword', keyword)
  if (model) params.set('model', model)
  if (taskType) params.set('task_type', taskType)
  if (status) params.set('status', status)
  if (from) params.set('date_from', new Date(from).toISOString())
  if (to) params.set('date_to', new Date(`${to}T23:59:59`).toISOString())

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['history', params.toString()],
    queryFn: () => api<PageResult<GenerationTask>>(`/tasks?${params.toString()}`),
  })

  const reset = () => {
    setKeyword('')
    setModel('')
    setTaskType('')
    setStatus('')
    setFrom('')
    setTo('')
    setPage(1)
  }

  return (
    <div className="w-full">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-[24px] font-black text-[#111]">历史记录</h1>
          <p className="mt-1 text-[13px] text-[#666]">查看所有画布的生成任务执行情况</p>
        </div>
        <div className="flex gap-2">
          <button onClick={reset} className="flex h-10 items-center gap-1.5 rounded-xl border border-black/10 px-3.5 text-[13px] font-semibold hover:bg-black/[0.03]">
            <RotateCcw size={14} /> 重置
          </button>
          <button onClick={() => void refetch()} className="flex h-10 items-center gap-1.5 rounded-xl border border-black/10 px-3.5 text-[13px] font-semibold hover:bg-black/[0.03]">
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 rounded-2xl border border-black/6 bg-white p-3 md:grid-cols-6">
        <div className="relative col-span-2">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#999]" />
          <Input className="h-9 pl-8" placeholder="搜索提示词" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1) }} />
        </div>
        <Input className="h-9" placeholder="模型" value={model} onChange={(e) => { setModel(e.target.value); setPage(1) }} />
        <Select className="h-9" value={taskType} onChange={(e) => { setTaskType(e.target.value); setPage(1) }}>
          <option value="">全部模态</option>
          <option value="text">文本</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="audio">音频</option>
        </Select>
        <Select className="h-9" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
          <option value="">全部状态</option>
          {Object.entries(statusMeta).map(([k, v]) => (
            <option key={k} value={k}>{v.text}</option>
          ))}
        </Select>
        <div className="flex gap-1">
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="h-9 flex-1 rounded-lg border border-black/12 px-2 text-[12px]" />
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="h-9 flex-1 rounded-lg border border-black/12 px-2 text-[12px]" />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><Spinner className="h-7 w-7" /></div>
      ) : data?.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/15 py-16 text-center text-[14px] text-[#999]">暂无任务记录</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-black/6 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-black/6 bg-slate-50 text-[12px] text-[#777]">
              <tr>
                <th className="px-3 py-2.5">时间</th>
                <th className="px-3 py-2.5">结果</th>
                <th className="px-3 py-2.5">模态</th>
                <th className="px-3 py-2.5">模型</th>
                <th className="px-3 py-2.5">点数</th>
                <th className="px-3 py-2.5">提示词</th>
                <th className="px-3 py-2.5">状态</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((t) => {
                const out = t.outputs?.[0]
                return (
                  <tr key={t.taskId} className="border-b border-black/4 hover:bg-slate-50/60">
                    <td className="whitespace-nowrap px-3 py-2.5 text-[#777]">
                      {t.createdAt ? new Date(t.createdAt).toLocaleString('zh-CN') : ''}
                    </td>
                    <td className="px-3 py-2.5">
                      {out?.url ? (
                        t.modelType === 'image' ? (
                          <img src={assetUrl(out.url)} alt="" className="h-10 w-14 rounded-lg object-cover" />
                        ) : (
                          <a href={assetUrl(out.url)} target="_blank" rel="noreferrer" className="text-[12px] font-semibold text-blue-600 hover:underline">
                            查看结果
                          </a>
                        )
                      ) : (
                        <span className="text-[#ccc]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-[#555]">{t.modelType}</td>
                    <td className="px-3 py-2.5 text-[#555]">{t.modelType}</td>
                    <td className="px-3 py-2.5 font-bold text-[#111]">{t.actualCost || t.estimatedCost}</td>
                    <td className="max-w-56 px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        <span className="truncate text-[#666]">{t.prompt ?? ''}</span>
                        {t.prompt && (
                          <button onClick={() => { navigator.clipboard?.writeText(t.prompt ?? ''); toastSuccess('提示词已复制') }} className="shrink-0 rounded p-1 text-[#999] hover:text-[#111]">
                            <Copy size={12} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${statusMeta[t.status]?.cls ?? 'bg-slate-100 text-slate-500'}`}>
                        {statusMeta[t.status]?.text ?? t.status}
                      </span>
                      {t.status === 'failed' && t.errorMessage && <p className="mt-0.5 max-w-32 truncate text-[10px] text-red-400">{t.errorMessage}</p>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-3 py-2.5 text-[12px] text-[#777]">
            <span>共 {data?.total ?? 0} 条</span>
            <div className="flex gap-1">
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded-lg border border-black/10 px-3 py-1 disabled:opacity-40">上一页</button>
              <button disabled={(data?.items.length ?? 0) < 20} onClick={() => setPage((p) => p + 1)} className="rounded-lg border border-black/10 px-3 py-1 disabled:opacity-40">下一页</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const desktopStatusMeta: Record<string, { text: string; cls: string }> = {
  queued: { text: '排队中', cls: 'bg-amber-100 text-amber-700' },
  running: { text: '执行中', cls: 'bg-blue-100 text-blue-700' },
  succeeded: { text: '成功', cls: 'bg-emerald-100 text-emerald-700' },
  failed: { text: '失败', cls: 'bg-red-100 text-red-700' },
  cancelled: { text: '已取消', cls: 'bg-slate-200 text-slate-600' },
  interrupted: { text: '中断', cls: 'bg-orange-100 text-orange-700' },
}

function DesktopHistoryPage({ adapter }: { adapter: HistoryDesktopAdapter }) {
  const [keyword, setKeyword] = useState('')
  const [model, setModel] = useState('')
  const [taskType, setTaskType] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [inputs, setInputs] = useState<Record<string, DesktopTaskInputSnapshot | null>>({})
  const [outputPreview, setOutputPreview] = useState<{ taskId: string; text: string } | null>(null)
  const [outputLoading, setOutputLoading] = useState(false)
  const [outputError, setOutputError] = useState('')
  const [searchResult, setSearchResult] = useState<{ key: string; result: DesktopTaskSearchResult } | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)

  const searchQuery = useMemo<DesktopTaskSearchQuery>(() => ({
    page,
    pageSize: 20,
    keyword: keyword.trim(),
    model: model.trim(),
    modality: taskType as DesktopTaskSearchQuery['modality'],
    status: status as DesktopTaskSearchQuery['status'],
    fromTime: from ? new Date(`${from}T00:00:00`).getTime() : undefined,
    toTime: to ? new Date(`${to}T23:59:59.999`).getTime() : undefined,
  }), [from, keyword, model, page, status, taskType, to])
  const searchKey = JSON.stringify({ projectId: adapter.projectId ?? adapter.projectName, query: searchQuery })

  useEffect(() => {
    if (!adapter.searchTasks) return
    let cancelled = false
    setSearchLoading(true)
    setSearchError('')
    void adapter.searchTasks(searchQuery).then((result) => {
      if (!cancelled) setSearchResult({ key: searchKey, result })
    }).catch((cause) => {
      if (!cancelled) setSearchError(cause instanceof Error ? cause.message : '无法搜索本地任务记录。')
    }).finally(() => {
      if (!cancelled) setSearchLoading(false)
    })
    return () => { cancelled = true }
  }, [adapter.searchTasks, refreshVersion, searchKey, searchQuery])

  const filtered = useMemo(() => {
    if (adapter.searchTasks) return []
    const keywordValue = keyword.trim().toLocaleLowerCase()
    const modelValue = model.trim().toLocaleLowerCase()
    const fromTime = from ? new Date(`${from}T00:00:00`).getTime() : null
    const toTime = to ? new Date(`${to}T23:59:59`).getTime() : null
    return adapter.tasks.filter((task) => {
      const taskDetails = inputs[task.taskId]?.task
      const taskModel = `${taskDetails?.providerId ?? ''} ${taskDetails?.modelId ?? ''} ${task.providerType}`.toLocaleLowerCase()
      const parameters = inputs[task.taskId]?.parameters
      const prompt = typeof parameters?.prompt === 'string'
        ? parameters.prompt
        : typeof (parameters?.modelParams as Record<string, unknown> | undefined)?.prompt === 'string'
          ? String((parameters?.modelParams as Record<string, unknown>).prompt)
          : ''
      const created = Date.parse(task.createdAt)
      if (keywordValue && Object.hasOwn(inputs, task.taskId) && !prompt.toLocaleLowerCase().includes(keywordValue)) return false
      if (modelValue && Object.hasOwn(inputs, task.taskId) && !taskModel.includes(modelValue)) return false
      if (taskType && task.modality !== taskType) return false
      if (status && task.status !== status) return false
      if (fromTime !== null && (!Number.isFinite(created) || created < fromTime)) return false
      if (toTime !== null && (!Number.isFinite(created) || created > toTime)) return false
      return true
    })
  }, [adapter.searchTasks, adapter.tasks, from, inputs, keyword, model, status, taskType, to])

  const currentSearchResult = searchResult?.key === searchKey ? searchResult.result : null
  const visible = adapter.searchTasks
    ? (currentSearchResult?.items ?? [])
    : filtered.slice((page - 1) * 20, page * 20)
  const total = adapter.searchTasks ? (currentSearchResult?.total ?? 0) : filtered.length
  const pageCount = Math.max(1, Math.ceil(total / 20))

  useEffect(() => {
    if (!adapter.getTaskInput || visible.length === 0) return
    let cancelled = false
    void Promise.all(visible.map(async (task) => {
      if (Object.hasOwn(inputs, task.taskId)) return null
      try {
        return [task.taskId, await adapter.getTaskInput!(task.taskId)] as const
      } catch {
        return [task.taskId, null] as const
      }
    })).then((results) => {
      if (cancelled) return
      const entries = results.filter((value): value is readonly [string, DesktopTaskInputSnapshot | null] => value !== null)
      if (entries.length) setInputs((current) => ({ ...current, ...Object.fromEntries(entries) }))
    })
    return () => { cancelled = true }
  }, [adapter.getTaskInput, inputs, visible])

  useEffect(() => {
    setInputs({})
    setSearchResult(null)
  }, [adapter.projectId])

  const reset = () => {
    setKeyword('')
    setModel('')
    setTaskType('')
    setStatus('')
    setFrom('')
    setTo('')
    setPage(1)
  }

  const reload = async () => {
    await adapter.reload()
    setRefreshVersion((value) => value + 1)
  }

  const showTextOutput = async (taskId: string) => {
    if (!adapter.readTaskOutput) return
    setOutputLoading(true)
    setOutputError('')
    setOutputPreview({ taskId, text: '' })
    try {
      const text = await adapter.readTaskOutput(taskId)
      setOutputPreview({ taskId, text })
    } catch (cause) {
      setOutputError(cause instanceof Error ? cause.message : '无法读取本地文本结果。')
    } finally {
      setOutputLoading(false)
    }
  }

  return (
    <div className="w-full">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-[24px] font-black text-[#111]">历史记录</h1>
          <p className="mt-1 text-[13px] text-[#666]">查看本地项目「{adapter.projectName ?? '未打开'}」中的生成任务</p>
        </div>
        <div className="flex gap-2">
          <button onClick={reset} className="flex h-10 items-center gap-1.5 rounded-xl border border-black/10 px-3.5 text-[13px] font-semibold hover:bg-black/[0.03]">
            <RotateCcw size={14} /> 重置
          </button>
          <button onClick={() => void reload()} className="flex h-10 items-center gap-1.5 rounded-xl border border-black/10 px-3.5 text-[13px] font-semibold hover:bg-black/[0.03]">
            <RefreshCw size={14} /> 刷新
          </button>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 rounded-2xl border border-black/6 bg-white p-3 md:grid-cols-6">
        <div className="relative col-span-2">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#999]" />
          <Input className="h-9 pl-8" placeholder="搜索提示词" value={keyword} onChange={(e) => { setKeyword(e.target.value); setPage(1) }} />
        </div>
        <Input className="h-9" placeholder="模型" value={model} onChange={(e) => { setModel(e.target.value); setPage(1) }} />
        <Select className="h-9" value={taskType} onChange={(e) => { setTaskType(e.target.value); setPage(1) }}>
          <option value="">全部模态</option>
          <option value="text">文本</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="audio">音频</option>
        </Select>
        <Select className="h-9" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}>
          <option value="">全部状态</option>
          {Object.entries(desktopStatusMeta).map(([key, value]) => <option key={key} value={key}>{value.text}</option>)}
        </Select>
        <div className="flex gap-1">
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="h-9 min-w-0 flex-1 rounded-lg border border-black/12 px-2 text-[12px]" />
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="h-9 min-w-0 flex-1 rounded-lg border border-black/12 px-2 text-[12px]" />
        </div>
      </div>

      {(adapter.error || searchError) && <p role="alert" className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-700">{adapter.error || searchError}</p>}
      {adapter.isLoading || (adapter.searchTasks && (searchLoading || (!currentSearchResult && !searchError))) ? (
        <div className="flex justify-center py-20"><Spinner className="h-7 w-7" /></div>
      ) : !adapter.projectName ? (
        <div className="rounded-2xl border border-dashed border-black/15 py-16 text-center text-[14px] text-[#999]">打开本地项目后可查看其中的生成历史</div>
      ) : total === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/15 py-16 text-center text-[14px] text-[#999]">暂无任务记录</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-black/6 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-left text-[13px]">
              <thead className="border-b border-black/6 bg-slate-50 text-[12px] text-[#777]">
                <tr>
                  <th className="px-3 py-2.5">时间</th>
                  <th className="px-3 py-2.5">结果</th>
                  <th className="px-3 py-2.5">模态</th>
                  <th className="px-3 py-2.5">模型</th>
                  <th className="px-3 py-2.5">提示词</th>
                  <th className="px-3 py-2.5">状态</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((task) => {
                  const outputUrl = `vibe://app/tasks/${encodeURIComponent(task.taskId)}/output`
                  const input = inputs[task.taskId]?.parameters
                  const taskDetails = inputs[task.taskId]?.task
                  const prompt = typeof input?.prompt === 'string'
                    ? input.prompt
                    : typeof (input?.modelParams as Record<string, unknown> | undefined)?.prompt === 'string'
                      ? String((input?.modelParams as Record<string, unknown>).prompt)
                      : ''
                  const result = task.status === 'succeeded'
                    ? task.modality === 'image'
                      ? <a href={outputUrl} target="_blank" rel="noreferrer"><img src={outputUrl} alt="生成结果" className="h-10 w-14 rounded-lg object-cover" /></a>
                      : task.modality === 'video'
                        ? <video src={outputUrl} controls preload="metadata" className="h-12 w-20 rounded-lg bg-black/5" />
                        : task.modality === 'audio'
                          ? <audio src={outputUrl} controls preload="metadata" className="w-36" />
                          : adapter.readTaskOutput
                            ? <button type="button" onClick={() => void showTextOutput(task.taskId)} className="text-[12px] font-semibold text-blue-600 hover:underline">查看结果</button>
                            : <span className="text-[12px] text-[#888]">本地已保存</span>
                    : <span className="text-[#ccc]">—</span>
                  const statusView = desktopStatusMeta[task.status] ?? { text: task.status, cls: 'bg-slate-100 text-slate-500' }
                  return (
                    <tr key={task.taskId} className="border-b border-black/4 hover:bg-slate-50/60">
                      <td className="whitespace-nowrap px-3 py-2.5 text-[#777]">{task.createdAt ? new Date(task.createdAt).toLocaleString('zh-CN') : ''}</td>
                      <td className="px-3 py-2.5">{result}</td>
                      <td className="px-3 py-2.5 font-semibold text-[#555]">{task.modality}</td>
                      <td className="px-3 py-2.5 text-[#555]">{taskDetails?.providerId || task.providerType}{taskDetails?.modelId ? ` · ${taskDetails.modelId}` : ''}</td>
                      <td className="max-w-56 px-3 py-2.5"><span className="truncate text-[#666]">{prompt || (adapter.getTaskInput ? (Object.hasOwn(inputs, task.taskId) ? '—' : '读取中…') : '任务输入详情未提供')}</span></td>
                      <td className="px-3 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${statusView.cls}`}>{statusView.text}</span>
                        {task.status === 'failed' && task.errorCode && <p className="mt-0.5 max-w-32 truncate text-[10px] text-red-400">{task.errorCode}</p>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-3 py-2.5 text-[12px] text-[#777]">
            <span>共 {total} 条本地任务</span>
            <div className="flex gap-1">
              <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="rounded-lg border border-black/10 px-3 py-1 disabled:opacity-40">上一页</button>
              <button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-black/10 px-3 py-1 disabled:opacity-40">下一页</button>
            </div>
          </div>
        </div>
      )}

      <Modal open={outputPreview !== null} onClose={() => { if (!outputLoading) { setOutputPreview(null); setOutputError('') } }} title="本地文本结果">
        {outputLoading ? <div className="flex justify-center py-8"><Spinner className="h-6 w-6" /></div> : outputError
          ? <p role="alert" className="text-sm text-red-700">{outputError}</p>
          : <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-50 p-3 text-[13px] leading-6 text-[#333]">{outputPreview?.text}</pre>}
      </Modal>
    </div>
  )
}
