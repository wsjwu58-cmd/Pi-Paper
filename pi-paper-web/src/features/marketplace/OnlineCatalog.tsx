import { useEffect, useState } from 'react'
import { CloudDownload, FileInput, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { MarketplaceOnlineCatalog, MarketplacePackage } from '@/desktop/desktop-bridge'
import type { UiLanguage } from '@/lib/i18n'

const words = {
  title: ['GitHub 在线目录', 'GitHub catalog'],
  intro: ['仅在点击刷新或下载时访问 GitHub。下载后可离线使用；导入不安装组件或启动生成。', 'GitHub is contacted only when you refresh or download. Imported items work offline; importing does not install components or start generation.'],
  refresh: ['刷新在线目录', 'Refresh catalog'],
  refreshing: ['正在刷新…', 'Refreshing…'],
  download: ['下载并导入', 'Download and import'],
  downloading: ['正在下载…', 'Downloading…'],
  localSkill: ['导入独立 Skill', 'Import standalone Skill'],
  skillInfo: ['支持仅含指令的 Pi SKILL.md；不导入辅助文件、脚本或 npm 包。请在安装前预览指令。', 'Import instruction-only Pi SKILL.md files. Supporting files, scripts, and npm packages are not imported. Review instructions before installing.'],
  empty: ['尚未刷新在线目录。已导入的包仍可离线使用。', 'The online catalog has not been refreshed. Previously imported packages remain available offline.'],
  index: ['目录快照', 'Catalog snapshot'],
  incompatible: ['当前应用版本不兼容', 'Incompatible with this app version'],
  unsupportedComponents: ['此应用尚不支持这些组件类型', 'This app does not yet support these component types'],
  unsupportedFormat: ['此应用尚不支持此条目的格式', 'This app does not yet support this item format'],
  range: ['适用版本', 'App versions'],
  skill: ['独立 Skill', 'Standalone Skill'],
  package: ['创作包', 'Creative package'],
  source: ['GitHub 在线导入', 'Imported from GitHub'],
  imported: ['已导入目录，请预览并选择组件安装。', 'Imported to the catalog. Review and select components to install.'],
  network: ['连接 GitHub 失败。可继续使用已缓存目录和已导入的包。', 'Could not reach GitHub. Cached listings and imported packages remain available.'],
  indexError: ['在线目录无效或已损坏。已导入的包仍可使用。', 'The online catalog is invalid or damaged. Imported packages remain available.'],
  changed: ['目录已更新，请重新选择要下载的条目。', 'The catalog changed. Select the item again.'],
  integrity: ['文件大小、摘要或内容与目录不匹配，未导入。', 'File size, checksum, or content did not match the catalog. Nothing was imported.'],
  unsupported: ['此 Skill 不符合独立指令格式，或依赖未支持的文件、命令或设置。', 'This Skill is not a supported standalone instruction file, or depends on unsupported files, commands, or settings.'],
  versionCollision: ['相同版本已有不同内容，请联系发布者更改版本。', 'This version already has different content. Ask the publisher to change the version.'],
  failure: ['操作失败，请检查文件或稍后重试。', 'The operation failed. Check the file or try again later.'],
} as const

type Word = keyof typeof words
export const catalogText = (language: UiLanguage, key: Word) => words[key][language === 'en' ? 1 : 0]

function errorText(language: UiLanguage, error: unknown) {
  const message = error instanceof Error ? error.message : ''
  const code = message.includes('MARKETPLACE_ONLINE_NETWORK_ERROR') ? 'network'
    : message.includes('MARKETPLACE_ONLINE_INDEX_CHANGED') ? 'changed'
      : message.includes('MARKETPLACE_ONLINE_INCOMPATIBLE') ? 'incompatible'
        : message.includes('MARKETPLACE_ONLINE_INTEGRITY') ? 'integrity'
          : message.includes('MARKETPLACE_ONLINE_INDEX_INVALID') || message.includes('MARKETPLACE_STORAGE_INVALID') ? 'indexError'
            : message.includes('MARKETPLACE_SKILL_') || message.includes('MARKETPLACE_PACKAGE_INVALID') ? 'unsupported'
              : message.includes('MARKETPLACE_VERSION_COLLISION') ? 'versionCollision' : 'failure'
  return catalogText(language, code)
}

export function OnlineCatalog({ language, disabled, onImported }: {
  language: UiLanguage
  disabled: boolean
  onImported: (item: MarketplacePackage) => Promise<void>
}) {
  const [catalog, setCatalog] = useState<MarketplaceOnlineCatalog | null>(null)
  const [operation, setOperation] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  const service = window.vibepaperDesktop?.marketplace
  useEffect(() => {
    let live = true
    if (service?.onlineCached) void service.onlineCached().then((value) => { if (live) setCatalog(value) })
      .catch((error: unknown) => { if (live) setNotice({ tone: 'error', text: errorText(language, error) }) })
    return () => { live = false }
  }, [service, language])

  const run = async (name: string, action: () => Promise<void>) => {
    if (disabled || operation) return
    setOperation(name); setNotice(null)
    try { await action() } catch (error) { setNotice({ tone: 'error', text: errorText(language, error) }) }
    finally { setOperation(null) }
  }
  const onRefresh = () => void run('refresh', async () => {
    if (!service?.onlineRefresh) throw new Error('MARKETPLACE_ONLINE_NETWORK_ERROR')
    setCatalog(await service.onlineRefresh())
  })
  const onDownload = (id: string) => void run(id, async () => {
    if (!service?.onlineDownload || !catalog) throw new Error('MARKETPLACE_ONLINE_INDEX_CHANGED')
    const item = await service.onlineDownload(id, catalog.commit)
    await onImported(item)
    setNotice({ tone: 'success', text: catalogText(language, 'imported') })
  })
  const onLocalSkill = () => void run('skill', async () => {
    if (!service?.importSkill) throw new Error('MARKETPLACE_SKILL_UNSUPPORTED')
    const item = await service.importSkill()
    if (!item) return
    await onImported(item)
    setNotice({ tone: 'success', text: catalogText(language, 'imported') })
  })
  const busy = disabled || Boolean(operation)
  return <section className="mb-6 rounded-2xl border border-[#dce6f3] bg-[#f8fbff] p-5 sm:p-6" aria-label={catalogText(language, 'title')}>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl"><h2 className="flex items-center gap-2 text-lg font-bold text-[#233b61]"><CloudDownload size={20} />{catalogText(language, 'title')}</h2><p className="mt-2 text-sm leading-6 text-[#64758c]">{catalogText(language, 'intro')}</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" disabled={busy} leftIcon={<FileInput size={15} />} onClick={onLocalSkill}>{catalogText(language, 'localSkill')}</Button>
        <Button variant="ghost" disabled={busy} leftIcon={<RefreshCw size={15} />} onClick={onRefresh}>{catalogText(language, operation === 'refresh' ? 'refreshing' : 'refresh')}</Button>
      </div>
    </div>
    <p className="mt-3 text-xs leading-5 text-[#73839a]">{catalogText(language, 'skillInfo')}</p>
    {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} className={`mt-3 rounded-lg px-3 py-2 text-sm ${notice.tone === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>{notice.text}</p>}
    {catalog ? <>
      <p className="mt-4 break-all text-xs text-[#8190a5]">{catalogText(language, 'index')}: {catalog.repository} / {catalog.branch} · {catalog.commit}</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">{catalog.entries.map((entry) => <article key={entry.id} className="rounded-xl border border-[#e2eaf4] bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><h3 className="font-semibold text-[#263c5b]">{entry.name}</h3><p className="mt-1 text-xs text-[#8794a6]">{entry.author} · v{entry.version} · {entry.unsupportedKind ? entry.kind : catalogText(language, entry.kind === 'pi-skill' ? 'skill' : 'package')}</p></div><Button variant="ghost" disabled={busy || !entry.compatible} onClick={() => onDownload(entry.id)}>{catalogText(language, operation === entry.id ? 'downloading' : 'download')}</Button></div>
        <p className="mt-3 text-sm leading-6 text-[#6e7d90]">{entry.description}</p>
        <p className={`mt-3 text-xs ${entry.compatible ? 'text-[#8996a7]' : 'font-semibold text-amber-700'}`}>{entry.unsupportedKind ? catalogText(language, 'unsupportedFormat') : entry.unsupportedComponents.length ? `${catalogText(language, 'unsupportedComponents')}: ${entry.unsupportedComponents.join(', ')}` : entry.compatible ? `${catalogText(language, 'range')}: ${entry.target.minVersion} – ${entry.target.maxVersion}` : catalogText(language, 'incompatible')} · {entry.size.toLocaleString()} B</p>
        <p className="mt-1 break-all text-xs text-[#8996a7]">SHA-256: {entry.sha256}</p>
      </article>)}</div>
    </> : <p className="mt-4 text-sm text-[#8996a7]">{catalogText(language, 'empty')}</p>}
  </section>
}
