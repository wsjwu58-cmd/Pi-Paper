import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { t as uiText, useUiLanguage } from '@/lib/i18n'

export function CanvasPlugins({ projectId, open, busy, presetNodeType, onClose, onUse, onSaveSelection }: {
  projectId?: string
  open: boolean
  busy: boolean
  presetNodeType?: string | null
  onClose: () => void
  onUse: (packageId: string, componentId: string) => Promise<void>
  onSaveSelection: (name: string) => Promise<boolean>
}) {
  useUiLanguage()
  const [name, setName] = useState('')
  const { data: packages = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['desktop-marketplace', projectId],
    enabled: open && Boolean(projectId && window.vibepaperDesktop?.marketplace),
    queryFn: () => window.vibepaperDesktop!.marketplace.list(projectId),
    staleTime: 0,
  })
  if (!open) return null
  const usable = packages.flatMap((pkg) => pkg.components
    .filter((component) => component.installed && component.enabled && ['template', 'asset', 'preset'].includes(component.type)
      && (!presetNodeType || component.type === 'preset' && (component.data as { nodeType?: string })?.nodeType === presetNodeType))
    .map((component) => ({ pkg, component })))
  return (
    <aside className="absolute left-20 top-20 z-30 flex max-h-[calc(100vh-7rem)] w-[320px] flex-col rounded-2xl border border-black/10 bg-white shadow-xl" aria-label={uiText('插件组件')}>
      <div className="flex items-center justify-between border-b border-black/5 px-4 py-3">
        <div><h2 className="text-sm font-bold text-[#222]">{uiText('插件组件')}</h2><p className="mt-1 text-xs text-[#777]">{uiText('使用当前项目已启用的组件')}</p></div>
        <button type="button" onClick={onClose} aria-label={uiText('关闭')} className="rounded-lg p-2 text-[#777] hover:bg-black/5"><X size={16} /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {!projectId && <p className="p-2 text-xs text-[#777]">{uiText('请先打开本地项目。')}</p>}
        {isLoading && <p className="p-2 text-xs text-[#777]">{uiText('正在读取插件组件…')}</p>}
        {isError && <p className="p-2 text-xs text-red-700">{uiText('读取插件组件失败。')} <button type="button" className="underline" onClick={() => void refetch()}>{uiText('重试')}</button></p>}
        {!isLoading && !isError && usable.length === 0 && <p className="p-2 text-xs leading-5 text-[#777]">{uiText('暂无已启用组件。请先在插件市场安装并启用。')}</p>}
        {usable.map(({ pkg, component }) => (
          <div key={`${pkg.id}:${component.id}`} className="rounded-xl border border-black/8 p-3">
            <p className="text-[13px] font-semibold text-[#222]">{uiText(component.name)}</p>
            <p className="mt-1 text-xs leading-5 text-[#777]">{uiText(component.description)}</p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#888]">{uiText(pkg.name)} · {component.type === 'template' ? uiText('模板') : component.type === 'asset' ? uiText('素材') : uiText('预设')}</span>
              <button type="button" disabled={busy} onClick={() => void onUse(pkg.id, component.id)} className="rounded-lg bg-[#222] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{component.type === 'template' ? uiText('插入') : component.type === 'asset' ? uiText('导入画布') : uiText('应用到选中节点')}</button>
            </div>
          </div>
        ))}
      </div>
      {!presetNodeType && <div className="border-t border-black/5 p-3">
        <label htmlFor="plugin-template-name" className="text-xs font-semibold text-[#555]">{uiText('将选中节点保存为本地模板')}</label>
        <p className="mt-1 text-[11px] leading-4 text-[#888]">{uiText('保存可编辑文本、布局及选中节点之间的连线；素材、生成结果和模型参数不会保存。')}</p>
        <div className="mt-2 flex gap-2">
          <input id="plugin-template-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder={uiText('模板名称')} className="min-w-0 flex-1 rounded-lg border border-black/10 px-2 py-1.5 text-xs" />
          <button type="button" disabled={busy || !name.trim()} onClick={() => void onSaveSelection(name.trim()).then((saved) => { if (saved) { setName(''); void refetch() } })} className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{uiText('保存模板')}</button>
        </div>
      </div>}
    </aside>
  )
}
