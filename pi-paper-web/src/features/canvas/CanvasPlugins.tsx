import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import type { MarketplaceComponent } from '@/desktop/desktop-bridge'
import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { describeCreativeCommands, getCreativeCommandDescriptor, type CreativeCommandNode } from './creativeCommandCatalog'

const isDirectorComponent = (component: MarketplaceComponent) =>
  component.type === 'director_scene' || component.type === 'director_camera' || component.type === 'director_motion'

function usableOnCanvas(component: MarketplaceComponent) {
  return ['template', 'asset', 'preset', 'node_definition', 'poster_layout', 'media_tool', 'workflow_recipe'].includes(component.type)
    || isDirectorComponent(component) || Boolean(getCreativeCommandDescriptor(component.type))
    || component.type === 'connector' && component.data.kind === 'local-mcp'
}

function usableOnNode(component: MarketplaceComponent, nodeType: string) {
  return component.type === 'preset' && component.data.nodeType === nodeType
    || nodeType === 'image' && ['poster_layout', 'media_tool'].includes(component.type)
    || nodeType === 'text' && component.type === 'connector' && component.data.kind === 'local-mcp'
}

export function CanvasPlugins({ projectId, open, busy, presetNodeType, nodes = [], selectedIds = [], onClose, onUse, onSaveSelection }: {
  projectId?: string
  open: boolean
  busy: boolean
  presetNodeType?: string | null
  nodes?: CreativeCommandNode[]
  selectedIds?: string[]
  onClose: () => void
  onUse: (packageId: string, componentId: string) => Promise<void>
  onSaveSelection: (name: string) => Promise<boolean>
}) {
  useUiLanguage()
  const [name, setName] = useState('')
  const serviceAvailable = Boolean(window.vibepaperDesktop?.marketplace)
  const { data: packages = [], isLoading, isError, refetch } = useQuery({
    queryKey: ['desktop-marketplace', projectId],
    enabled: open && Boolean(projectId && serviceAvailable),
    queryFn: () => window.vibepaperDesktop!.marketplace.list(projectId),
    staleTime: 0,
  })
  if (!open) return null
  const commandCatalog = describeCreativeCommands(packages, nodes, selectedIds)
  const reason = (value: string | null) => value === 'SELECTION_EMPTY' ? uiText('请先选择要操作的节点。') : value === 'SELECTION_TOO_SMALL' ? uiText('请至少选择两个节点。') : uiText('选区已变更，请重新操作。')
  const enabled = (serviceAvailable && projectId ? packages : []).flatMap((pkg) => pkg.components
    .filter((component) => component.installed && component.enabled)
    .map((component) => ({ pkg, component })))
  const usable = enabled.filter(({ component }) => presetNodeType ? usableOnNode(component, presetNodeType) : usableOnCanvas(component))
  // Skills can include the full default catalog. Group their entry points
  // instead of filling the canvas panel with individual skill cards.
  const guides = [
    presetNodeType && enabled.some(({ component }) => usableOnCanvas(component) && !usableOnNode(component, presetNodeType))
      ? uiText('其他画布组件：从画布工具栏打开「插件组件」使用。') : null,
    presetNodeType && enabled.some(({ component }) => isDirectorComponent(component))
      ? uiText('导演组件：打开导演台节点，在编辑器左侧的「已启用导演组件」中选择。') : null,
    enabled.some(({ component }) => component.type === 'skill')
      ? uiText('Skill：在 Agent 的技能面板中选择。') : null,
    enabled.some(({ component }) => component.type === 'agent_role')
      ? uiText('Agent 角色：在 Agent 输入区的「会话角色」中选择。') : null,
    enabled.some(({ component }) => component.type === 'connector' && component.data.kind === 'mcp-client')
      ? uiText('MCP 客户端模板：在插件市场打开对应连接器，选择「检查 MCP 授权范围」。') : null,
  ].filter((guide): guide is string => Boolean(guide))
  return (
    <aside className="absolute left-20 top-20 z-30 flex max-h-[calc(100vh-7rem)] w-[320px] flex-col rounded-2xl border border-black/10 bg-white shadow-xl" aria-label={uiText('插件组件')}>
      <div className="flex items-center justify-between border-b border-black/5 px-4 py-3">
        <div><h2 className="text-sm font-bold text-[#222]">{uiText('插件组件')}</h2><p className="mt-1 text-xs text-[#777]">{uiText('使用当前项目已启用的组件')}</p></div>
        <button type="button" onClick={onClose} aria-label={uiText('关闭')} className="rounded-lg p-2 text-[#777] hover:bg-black/5"><X size={16} /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {!projectId && <p className="p-2 text-xs text-[#777]">{uiText('请先打开本地项目。')}</p>}
        {projectId && !serviceAvailable && <p className="p-2 text-xs text-red-700">{uiText('本地插件服务尚未就绪。')}</p>}
        {isLoading && <p className="p-2 text-xs text-[#777]">{uiText('正在读取插件组件…')}</p>}
        {isError && <p className="p-2 text-xs text-red-700">{uiText('读取插件组件失败。')} <button type="button" className="underline" onClick={() => void refetch()}>{uiText('重试')}</button></p>}
        {projectId && serviceAvailable && !isLoading && !isError && usable.length === 0 && <p className="p-2 text-xs leading-5 text-[#777]">{presetNodeType
          ? uiText('当前节点暂无可用组件。')
          : guides.length ? uiText('此处暂无可直接使用的组件；其他已启用组件的使用入口如下。') : uiText('暂无已启用组件。请先在插件市场安装并启用。')}</p>}
        {usable.map(({ pkg, component }) => {
          const descriptor = getCreativeCommandDescriptor(component.type)
          const availability = descriptor && commandCatalog.find((item) => item.packageId === pkg.id && item.componentId === component.id)
          const director = isDirectorComponent(component)
          const missingVersion = component.type === 'node_definition' && !pkg.installedVersion
          return <div key={`${pkg.id}:${component.id}`} className="rounded-xl border border-black/8 p-3">
            <p className="text-[13px] font-semibold text-[#222]">{uiText(component.name)}</p>
            <p className="mt-1 text-xs leading-5 text-[#777]">{uiText(component.description)}</p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#888]">{uiText(pkg.name)} · {component.type === 'template' ? uiText('模板') : component.type === 'asset' ? uiText('素材') : component.type === 'node_definition' ? uiText('节点') : component.type === 'director_scene' ? uiText('导演场景') : component.type === 'director_camera' ? uiText('导演机位') : component.type === 'director_motion' ? uiText('运镜路径') : component.type === 'poster_layout' ? uiText('海报排版') : component.type === 'workflow_recipe' ? uiText('创作流程') : descriptor ? uiText(descriptor.label) : component.type === 'media_tool' ? uiText('媒体工具') : component.type === 'connector' ? uiText('本地文本工具') : uiText('预设')}</span>
              <button type="button" disabled={busy || missingVersion || Boolean(availability && !availability.available)} onClick={() => void onUse(pkg.id, component.id)} className="rounded-lg bg-[#222] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{component.type === 'template' ? uiText('插入') : component.type === 'asset' ? uiText('导入画布') : component.type === 'node_definition' ? uiText('新建节点') : director ? uiText('新建导演台') : component.type === 'workflow_recipe' ? uiText('预览流程') : descriptor ? uiText(descriptor.button) : component.type === 'poster_layout' ? uiText('编辑海报') : component.type === 'media_tool' || component.type === 'connector' ? uiText('打开工具') : uiText('应用到选中节点')}</button>
            </div>
            {director && <p className="mt-2 text-xs leading-5 text-[#777]">{uiText('创建后双击导演台节点，在左侧「已启用导演组件」中选择此组件；也可使用已有导演台。')}</p>}
            {missingVersion && <p className="mt-2 text-xs text-[#888]">{uiText('安装版本不可用，请在插件市场重新安装。')}</p>}
            {availability && !availability.available && <p className="mt-2 text-xs text-[#888]">{reason(availability.reason)}</p>}
          </div>
        })}
        {guides.length > 0 && <div className="rounded-xl bg-[#f6f7f9] p-3 text-xs leading-5 text-[#777]">
          <p className="font-semibold text-[#555]">{uiText('其他使用入口')}</p>
          {guides.map((guide) => <p key={guide} className="mt-1">{guide}</p>)}
        </div>}
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
