import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Box, Check, ChevronRight, Download, FileInput, Layers3, PackageOpen, Puzzle, Search, Sparkles, WandSparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import type { DesktopProject, MarketplacePackage } from '@/desktop/desktop-bridge'
import { t as uiText, useUiLanguage } from '@/lib/i18n'

type ComponentType = MarketplacePackage['components'][number]['type']
type MarketplaceComponent = MarketplacePackage['components'][number]
type Filter = 'all' | 'installed' | ComponentType

const componentLabels: Record<ComponentType, string> = {
  template: '画布模板',
  asset: '素材',
  preset: '节点预设',
  skill: 'Skill',
}

const filters: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'installed', label: '已安装' },
  { value: 'template', label: '画布模板' },
  { value: 'asset', label: '素材' },
  { value: 'preset', label: '节点预设' },
  { value: 'skill', label: 'Skill' },
]

const marketplaceErrors: Record<string, string> = {
  MARKETPLACE_IMPORT_FILE_INVALID: '无法读取此文件，或文件超过允许大小。请选择有效的插件包 JSON。',
  MARKETPLACE_PACKAGE_INVALID: '插件包无效或包含不支持的内容。',
  MARKETPLACE_VERSION_COLLISION: '目录中已有同一版本但内容不同的插件包，请更改包版本后重试。',
  MARKETPLACE_BUILTIN_COLLISION: '此包与内置插件的标识冲突，无法导入。',
  MARKETPLACE_UPDATE_COMPONENT_REMOVED: '新版本移除或改变了已安装组件。请先卸载受影响的组件再更新。',
  MARKETPLACE_SELECTION_INVALID: '组件选择无效，请刷新后重试。',
  MARKETPLACE_PACKAGE_NOT_FOUND: '插件包不存在，请刷新后重试。',
  MARKETPLACE_COMPONENT_NOT_FOUND: '组件不存在，请刷新后重试。',
  MARKETPLACE_PACKAGE_NOT_INSTALLED: '当前项目未安装此插件包。',
  MARKETPLACE_COMPONENT_NOT_INSTALLED: '当前项目未安装此组件。',
  MARKETPLACE_COMPONENT_NOT_AVAILABLE: '此组件已停用或不可用，请刷新后重试。',
  MARKETPLACE_ROLLBACK_UNAVAILABLE: '没有可恢复的上一版本。',
  MARKETPLACE_STORAGE_INVALID: '插件目录或项目组件数据无法读取。',
  MARKETPLACE_STORAGE_TOO_LARGE: '插件数据超过允许大小。',
  MARKETPLACE_CATALOG_FULL: '本地插件目录已满。',
  MARKETPLACE_PROJECT_FULL: '当前项目已安装的插件包达到上限。',
}

function marketplaceError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  const code = Object.keys(marketplaceErrors).find((candidate) => message.includes(candidate))
  return code ? uiText(marketplaceErrors[code]) : message || uiText('操作失败，请重试。')
}

function componentLabel(type: ComponentType) {
  return uiText(componentLabels[type] ?? type)
}

/** Search and filtering use the public package metadata; component content is never rendered here. */
export function filterMarketplacePackages(packages: MarketplacePackage[], filter: Filter, keyword: string) {
  const query = keyword.trim().toLocaleLowerCase()
  return packages.filter((item) => {
    const matchingComponents = item.components.filter((component) => filter === 'all' || (filter === 'installed' ? component.installed : component.type === filter))
    const matchesFilter = filter === 'all' || matchingComponents.length > 0
    const text = [uiText(item.name), uiText(item.description), uiText(item.author), ...matchingComponents.flatMap((component) => [uiText(component.name), uiText(component.description), componentLabel(component.type)])]
      .join(' ').toLocaleLowerCase()
    return matchesFilter && (!query || text.includes(query))
  })
}

function packageTypes(item: MarketplacePackage) {
  return [...new Set(item.components.map((component) => component.type))]
}

function getMarketplace() {
  const marketplace = window.vibepaperDesktop?.marketplace
  if (!marketplace) throw new Error(uiText('桌面插件市场接口不可用。'))
  return marketplace
}

function PackageMark({ type, small = false }: { type?: ComponentType; small?: boolean }) {
  const iconSize = small ? 19 : 25
  const icon = type === 'template' ? <Layers3 size={iconSize} /> : type === 'preset' ? <WandSparkles size={iconSize} /> : type === 'skill' ? <Sparkles size={iconSize} /> : type === 'asset' ? <Box size={iconSize} /> : <Puzzle size={iconSize} />
  return <span className={`inline-flex shrink-0 items-center justify-center rounded-2xl bg-[#edf2fa] text-[#3e5f96] ${small ? 'h-10 w-10' : 'h-14 w-14'}`}>{icon}</span>
}

export function MarketplacePage() {
  const language = useUiLanguage()
  const navigate = useNavigate()
  const [project, setProject] = useState<DesktopProject | null>(null)
  const [packages, setPackages] = useState<MarketplacePackage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [keyword, setKeyword] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [removeTarget, setRemoveTarget] = useState<MarketplaceComponent | null>(null)

  const refresh = useCallback(async () => {
    const bridge = window.vibepaperDesktop
    if (!bridge?.marketplace) throw new Error(uiText('桌面插件市场接口不可用。'))
    const active = await bridge.getActiveProject()
    const items = await bridge.marketplace.list(active?.projectId)
    setProject(active)
    setPackages(items)
  }, [])

  useEffect(() => {
    let live = true
    const load = async () => {
      try { await refresh() }
      catch (error) {
        if (live) {
          setLoadFailed(true)
          setNotice({ tone: 'error', text: marketplaceError(error) })
        }
      } finally { if (live) setLoading(false) }
    }
    void load()
    return () => { live = false }
  }, [refresh])

  const retryLoad = async () => {
    setLoading(true)
    setNotice(null)
    try {
      await refresh()
      setLoadFailed(false)
    } catch (error) {
      setLoadFailed(true)
      setNotice({ tone: 'error', text: marketplaceError(error) })
    } finally { setLoading(false) }
  }

  const visible = useMemo(() => filterMarketplacePackages(packages, filter, keyword), [packages, filter, keyword, language])
  const detail = packages.find((item) => item.id === detailId) ?? null
  const updateBlocked = Boolean(detail?.updateAvailable && detail.components.some((component) => component.updateConflict))
  const installedCount = packages.reduce((count, item) => count + item.components.filter((component) => component.installed).length, 0)

  const run = async (action: () => Promise<boolean | void>, success: string) => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const completed = await action()
      if (completed === false) return
      await refresh()
      setLoadFailed(false)
      setNotice({ tone: 'success', text: success })
    } catch (error) {
      setNotice({ tone: 'error', text: marketplaceError(error) })
    } finally { setBusy(false) }
  }

  const openDetail = (item: MarketplacePackage) => {
    setDetailId(item.id)
    setSelected([])
    setNotice(null)
  }
  const importPackage = () => void run(async () => {
    const result = await getMarketplace().importPackage()
    if (!result) return false
    setDetailId(result.id)
    setSelected([])
  }, uiText('本地包已导入目录。选择需要的组件并安装到当前项目。'))
  const install = () => {
    if (!project || !detail || !selected.length || updateBlocked) return
    void run(async () => {
      await getMarketplace().install(project.projectId, detail.id, selected)
      setSelected([])
    }, uiText('组件已安装并启用。可在画布的「插件组件」或 Agent 技能面板中使用。'))
  }
  const setEnabled = (component: MarketplaceComponent, enabled: boolean) => {
    if (!project || !detail) return
    void run(async () => { await getMarketplace().setEnabled(project.projectId, detail.id, component.id, enabled) },
      enabled ? uiText('组件已启用。可在画布的「插件组件」或 Agent 技能面板中使用。') : uiText('组件已停用。'))
  }
  const remove = (component: MarketplaceComponent) => {
    if (!project || !detail) return
    void run(async () => { await getMarketplace().uninstall(project.projectId, detail.id, component.id) }, uiText('组件已从当前项目卸载。'))
  }
  const rollback = () => {
    if (!project || !detail) return
    void run(async () => { await getMarketplace().rollback(project.projectId, detail.id) }, uiText('已恢复上一版本，请检查当前项目的组件状态。'))
  }
  const updatePackage = () => {
    if (!project || !detail || !detail.updateAvailable || updateBlocked) return
    void run(async () => { await getMarketplace().install(project.projectId, detail.id, []) }, uiText('插件包已更新，原有组件的安装和启停状态已保留。'))
  }
  const exportPackage = () => {
    if (!project || !detail) return
    void run(() => getMarketplace().exportPackage(project.projectId, detail.id), uiText('插件包已导出。'))
  }

  return (
    <div className="mx-auto max-w-[1250px] pb-12 text-[#172238]">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          {detail && <button type="button" onClick={() => { setDetailId(null); setNotice(null) }} className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[#647086] hover:text-[#173f85]"><ArrowLeft size={16} />{uiText('返回插件市场')}</button>}
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-[#71809a]">{uiText('创作工作区')}</p>
          <h1 className="text-[28px] font-bold tracking-tight">{detail ? uiText(detail.name) : uiText('插件市场')}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#69768a]">{detail ? uiText(detail.description) : uiText('发现并安装适合当前项目的创作组件，让常用工作流随手可用。')}</p>
        </div>
        <Button variant="ghost" className="shrink-0" leftIcon={<FileInput size={16} />} disabled={busy} onClick={importPackage}>{uiText('导入本地包')}</Button>
      </div>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e2e9f3] bg-white px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#edf2fa] text-[#416395]"><Layers3 size={19} /></span>
          <div>
            <p className="text-sm font-bold">{project ? uiText('当前项目：{0}', { 0: project.name }) : uiText('尚未打开项目')}</p>
            <p className="mt-0.5 text-xs leading-5 text-[#77849a]">{project ? uiText('组件安装与启停仅作用于当前项目。') : uiText('可先浏览市场；打开项目后即可安装组件。')}</p>
          </div>
        </div>
        {!project && <Button variant="ghost" onClick={() => navigate('/workspace')}>{uiText('选择项目')}</Button>}
        {project && <button type="button" onClick={() => navigate(`/canvas/${encodeURIComponent(project.canvasId)}`)} className="inline-flex items-center gap-1 text-sm font-semibold text-[#315a96] hover:text-[#173f85]">{uiText('返回画布')}<ArrowRight size={15} /></button>}
      </div>

      {notice && <div role={notice.tone === 'error' ? 'alert' : 'status'} className={`mb-6 rounded-xl border px-4 py-3 text-sm leading-6 ${notice.tone === 'error' ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{notice.text}</div>}

      {loading ? <div className="flex justify-center py-20"><Spinner /></div> : loadFailed ? <div className="rounded-2xl border border-[#e2e9f3] bg-white py-16 text-center"><p className="mb-4 text-sm text-[#69768a]">{uiText('暂时无法显示插件目录。')}</p><Button variant="ghost" onClick={() => { void retryLoad() }}>{uiText('重试')}</Button></div> : detail ? (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-[#e2e9f3] bg-white p-5 text-sm text-[#69768a]">
            <PackageMark />
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-[#23324a]">{uiText(detail.author)} <span className="font-normal text-[#97a1b1]">·</span> {uiText('目录版本 {0}', { 0: detail.version })}</p>
              <p className="mt-1">{detail.source === 'builtin' ? uiText('内置目录') : uiText('本地导入')}</p>
              {detail.installedVersion && <p className="mt-1">{uiText('当前项目已安装版本 {0}', { 0: detail.installedVersion })}</p>}
            </div>
            {detail.updateAvailable && <Button disabled={!project || busy || updateBlocked} onClick={updatePackage}>{uiText('更新至 {0}', { 0: detail.version })}</Button>}
            <Button variant="ghost" disabled={!project || busy} leftIcon={<Download size={15} />} onClick={exportPackage}>{uiText('导出包')}</Button>
            {detail.rollbackVersion && <Button variant="ghost" disabled={!project || busy} onClick={rollback}>{uiText('恢复版本 {0}', { 0: detail.rollbackVersion })}</Button>}
          </div>
          {detail.updateAvailable && <p className="mb-5 rounded-xl border border-[#d8e6f7] bg-[#eff6ff] px-4 py-3 text-sm leading-6 text-[#46658e]">{uiText('已安装组件预览当前版本，未安装组件预览目录新版本。更新保留已安装组件和启停状态；若新版本移除已安装组件或改变其类型，更新会被拒绝。')}</p>}
          <section className="rounded-2xl border border-[#e2e9f3] bg-white p-5 sm:p-6">
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div><h2 className="text-lg font-bold">{uiText('选择组件')}</h2><p className="mt-1 text-sm text-[#77849a]">{uiText('按需安装；已安装的组件可单独启用、停用或卸载。')}</p></div>
              <Button disabled={!project || busy || selected.length === 0 || updateBlocked} leftIcon={<Download size={16} />} onClick={install}>{uiText('安装所选组件（{0}）', { 0: selected.length })}</Button>
            </div>
            <div className="divide-y divide-[#edf0f5]">
              {detail.components.map((component) => (
                <div key={component.id} className="py-4 first:pt-1 last:pb-1">
                <div className="flex flex-wrap items-center gap-3 sm:flex-nowrap">
                  {!component.installed && <input type="checkbox" aria-label={uiText('选择组件 {0}', { 0: uiText(component.name) })} checked={selected.includes(component.id)} disabled={!project || busy} onChange={(event) => setSelected((current) => event.target.checked ? [...current, component.id] : current.filter((id) => id !== component.id))} className="h-4 w-4 accent-[#315a96]" />}
                  <PackageMark type={component.type} small />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-[#24334a]">{uiText(component.name)}</span><span className="rounded-md bg-[#f1f4f8] px-2 py-0.5 text-xs text-[#647086]">{componentLabel(component.type)}</span></div>
                    <p className="mt-1 text-sm leading-5 text-[#7b8798]">{uiText(component.description)}</p>
                    <UpdateConflictNotice component={component} />
                  </div>
                  {component.installed ? <div className="ml-auto flex items-center gap-2 text-sm">
                    <span className={component.enabled ? 'text-emerald-700' : 'text-[#8490a3]'}>{component.enabled ? uiText('已启用') : uiText('已停用')}</span>
                    <button type="button" disabled={busy} onClick={() => setEnabled(component, !component.enabled)} className="rounded-lg px-2.5 py-2 font-semibold text-[#315a96] hover:bg-[#edf2fa] disabled:opacity-50">{component.enabled ? uiText('停用') : uiText('启用')}</button>
                    <button type="button" disabled={busy} onClick={() => setRemoveTarget(component)} className="rounded-lg px-2.5 py-2 text-[#7a8699] hover:bg-red-50 hover:text-red-700 disabled:opacity-50">{uiText('卸载')}</button>
                  </div> : <span className="ml-auto text-xs text-[#9ba5b5]">{uiText('未安装')}</span>}
                </div>
                <details className="mt-2 ml-0 rounded-xl bg-[#f8fafc] px-4 py-2 sm:ml-7">
                  <summary className="cursor-pointer py-1 text-sm font-semibold text-[#496990]">{uiText('预览组件内容')}</summary>
                  <ComponentPreview component={component} />
                </details>
                </div>
              ))}
            </div>
          </section>
          <UsageGuide />
        </>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5" aria-label={uiText('组件分类')}>
              {filters.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)} className={`rounded-full px-3.5 py-2 text-sm font-semibold transition ${filter === item.value ? 'bg-[#243e68] text-white' : 'text-[#69768a] hover:bg-[#e9eef7]'}`}>{uiText(item.label)}</button>)}
            </div>
            <label className="flex h-10 w-full items-center gap-2 rounded-xl border border-[#e2e9f3] bg-white px-3 text-[#95a0b1] sm:w-64"><Search size={16} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={uiText('搜索插件和组件')} aria-label={uiText('搜索插件和组件')} className="min-w-0 flex-1 bg-transparent text-sm text-[#24334a] outline-none placeholder:text-[#a4adbb]" /></label>
          </div>
          <div className="mb-4 flex items-center justify-between text-sm text-[#8995a7]"><span>{uiText('共 {0} 个插件包', { 0: visible.length })}</span>{project && <span>{uiText('当前项目已安装 {0} 个组件', { 0: installedCount })}</span>}</div>
          {visible.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visible.map((item) => <PackageCard key={item.id} item={item} onOpen={() => openDetail(item)} />)}</div> : <div className="rounded-2xl border border-dashed border-[#d8e0eb] bg-white py-16 text-center text-[#8490a3]"><PackageOpen size={30} className="mx-auto mb-3" /><p className="font-semibold text-[#59677c]">{uiText('没有找到匹配的插件包')}</p><p className="mt-1 text-sm">{uiText('试试其他分类或搜索词，也可以导入本地包。')}</p></div>}
          <UsageGuide />
        </>
      )}
      <ConfirmDialog open={Boolean(removeTarget)} onClose={() => setRemoveTarget(null)} onConfirm={() => { if (removeTarget) remove(removeTarget) }} title={uiText('卸载组件')} message={uiText('确定从当前项目卸载「{0}」？', { 0: removeTarget ? uiText(removeTarget.name) : '' })} danger />
    </div>
  )
}

export function PackageCard({ item, onOpen }: { item: MarketplacePackage; onOpen: () => void }) {
  const installed = item.components.filter((component) => component.installed).length
  return <button type="button" onClick={onOpen} className="group flex min-h-[216px] w-full flex-col rounded-2xl border border-[#e2e9f3] bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-[#b8c9e2] hover:shadow-[0_10px_28px_rgba(35,65,110,0.08)]">
    <div className="flex w-full items-start gap-3"><PackageMark /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><h3 className="truncate text-base font-bold text-[#23324a]">{uiText(item.name)}</h3><ChevronRight size={17} className="shrink-0 text-[#a8b4c5] group-hover:text-[#315a96]" /></div><p className="mt-1 text-xs text-[#95a0b1]">{uiText(item.author)} · v{item.version}</p></div></div>
    <p className="mt-4 line-clamp-2 flex-1 text-sm leading-6 text-[#718096]">{uiText(item.description)}</p>
    <div className="mt-4 flex flex-wrap items-center gap-1.5">{packageTypes(item).map((type) => <span key={type} className="rounded-md bg-[#f1f4f8] px-2 py-1 text-xs text-[#647086]">{componentLabel(type)}</span>)}</div>
    <div className="mt-4 flex w-full items-center justify-between border-t border-[#f0f3f7] pt-3 text-xs text-[#95a0b1]"><span>{item.source === 'builtin' ? uiText('内置目录') : uiText('本地导入')}</span><span className={installed ? 'inline-flex items-center gap-1 text-emerald-700' : ''}>{installed ? <><Check size={13} />{uiText('已安装 {0}/{1}', { 0: installed, 1: item.components.length })}</> : uiText('查看详情')}</span></div>
  </button>
}

export function UpdateConflictNotice({ component }: { component: MarketplaceComponent }) {
  if (!component.updateConflict) return null
  return <p className="mt-1 text-xs leading-5 text-amber-800">{component.updateConflict === 'removed'
    ? uiText('新版已移除此组件，请先卸载它再更新。')
    : uiText('新版更改了此组件的类型，请先卸载它再更新。')}</p>
}

function UsageGuide() {
  return <div className="mt-6 flex gap-3 rounded-2xl border border-[#dde7f5] bg-[#f1f6fd] px-5 py-4 text-sm leading-6 text-[#5d6e89]"><Sparkles className="mt-0.5 shrink-0 text-[#577bb0]" size={18} /><div><p className="font-bold text-[#36567f]">{uiText('安装后如何使用？')}</p><p className="mt-1">{uiText('安装并启用后，返回画布打开「插件组件」使用模板、素材和预设；Skill 可在 Agent 技能面板中选择。组件只影响当前项目，不会自动创建生成任务。')}</p><p className="mt-1">{uiText('生成前请配置并选择可用模型，再从画布或 Agent 发起；云端模型可能收取供应商费用。')}</p><p className="mt-1 text-xs text-[#8190a5]">{uiText('本地包是经过校验的声明式数据，不执行第三方代码。')}</p></div></div>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function previewNodeType(value: unknown) {
  if (value === 'text') return uiText('文字节点')
  if (value === 'image') return uiText('图片节点')
  if (value === 'video') return uiText('视频节点')
  if (value === 'audio') return uiText('音频节点')
  return typeof value === 'string' ? value : uiText('节点')
}

const previewParameterLabels: Record<string, string> = {
  prompt: '提示词', content: '内容', title: '标题', style: '风格', camera: '运镜', model: '模型', aspect: '比例',
  ratio: '比例', size: '尺寸', resolution: '分辨率', resKey: '分辨率', duration: '时长', count: '数量', generate_audio: '音频',
}

function PreviewParameters({ value }: { value: unknown }) {
  return <>{Object.entries(record(value)).map(([key, field]) => <p key={key} className="mt-1">{uiText(previewParameterLabels[key] ?? key)}：{typeof field === 'string' ? field : JSON.stringify(field)}</p>)}</>
}

/** Treat imported content as text and use image data only for validated, supported image types. */
export function ComponentPreview({ component }: { component: MarketplaceComponent }) {
  const data = record(component.data)
  const contentClass = 'mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-3 text-xs leading-5 text-[#536278]'
  if (component.type === 'template') {
    const nodes = Array.isArray(data.nodes) ? data.nodes.map(record) : []
    const edges = Array.isArray(data.edges) ? data.edges.map(record) : []
    const labels = new Map(nodes.map((node, index) => [String(node.id ?? index), uiText('节点 {0}：{1}', { 0: index + 1, 1: previewNodeType(node.type) })]))
    return <div className="pb-2 text-sm text-[#69768a]">
      <p className="mt-2 font-semibold">{uiText('模板包含 {0} 个节点、{1} 条连线', { 0: nodes.length, 1: edges.length })}</p>
      <div className={contentClass}>{nodes.map((node, index) => <div key={String(node.id ?? index)} className="mb-2 last:mb-0"><strong>{labels.get(String(node.id ?? index))}</strong><PreviewParameters value={node.params} /></div>)}</div>
      {edges.length > 0 && <div className={contentClass}><strong>{uiText('连接关系')}</strong>{edges.map((edge, index) => <p key={index} className="mt-1">{labels.get(String(edge.source)) ?? uiText('节点')} → {labels.get(String(edge.target)) ?? uiText('节点')}</p>)}</div>}
    </div>
  }
  if (component.type === 'asset') {
    const mime = typeof data.mime === 'string' ? data.mime : ''
    const base64 = typeof data.base64 === 'string' ? data.base64 : ''
    const isImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) && /^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    return isImage ? <img src={`data:${mime};base64,${base64}`} alt={uiText(component.name)} className="mt-3 mb-2 max-h-56 max-w-full rounded-lg border border-[#e2e9f3] object-contain" /> : <p className="py-3 text-sm text-[#77849a]">{uiText('此素材暂无可显示的预览。')}</p>
  }
  if (component.type === 'preset') {
    return <div className="pb-2 text-sm text-[#69768a]"><p className="mt-2">{uiText('适用节点：{0}', { 0: previewNodeType(data.nodeType) })}</p><div className={contentClass}><PreviewParameters value={data.params} /></div></div>
  }
  if (component.type === 'skill') {
    return <div className="pb-2 text-sm text-[#69768a]"><p className="mt-2 font-semibold">{uiText('Skill 指令')}</p><p className={contentClass}>{typeof data.instructions === 'string' ? data.instructions : uiText('暂无可预览内容。')}</p></div>
  }
  return <p className="py-3 text-sm text-[#77849a]">{uiText('暂无可预览内容。')}</p>
}
