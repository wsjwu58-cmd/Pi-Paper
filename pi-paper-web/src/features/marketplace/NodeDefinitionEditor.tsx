import { useMemo, useState } from 'react'
import type { MarketplaceNodeDefinition, MarketplaceNodeField, MarketplacePackage } from '@/desktop/desktop-bridge'
import { t as uiText } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'

type DraftField = { id: string; label: string; kind: 'text' | 'number' | 'enum'; defaultValue: string; min: string; max: string; options: string }
const initialField: DraftField = { id: 'product', label: '商品卖点', kind: 'text', defaultValue: '', min: '0', max: '100', options: '' }

export function NodeDefinitionEditor({ projectId, onSaved, onClose }: {
  projectId: string
  onSaved: (item: MarketplacePackage) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('商品棚拍图')
  const [description, setDescription] = useState('')
  const [baseType, setBaseType] = useState<MarketplaceNodeDefinition['baseType']>('image')
  const [template, setTemplate] = useState('商品棚拍，{{product}}，柔和棚拍光线')
  const [fields, setFields] = useState<DraftField[]>([initialField])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const updateField = (index: number, patch: Partial<DraftField>) => setFields((current) => current.map((field, i) => i === index ? { ...field, ...patch } : field))
  const data = useMemo<MarketplaceNodeDefinition>(() => ({
    schemaVersion: 1, baseType, promptTemplate: template,
    fields: fields.map((field): MarketplaceNodeField => field.kind === 'number'
      ? { id: field.id, label: field.label, kind: 'number', default: Number(field.defaultValue), min: Number(field.min), max: Number(field.max) }
      : field.kind === 'enum'
        ? { id: field.id, label: field.label, kind: 'enum', default: field.defaultValue, options: field.options.split('\n').map((item) => item.trim()).filter(Boolean) }
        : { id: field.id, label: field.label, kind: 'text', default: field.defaultValue }),
  }), [baseType, fields, template])
  const preview = template.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/gu, (_match, id: string) => fields.find((field) => field.id === id)?.defaultValue ?? `{{${id}}}`)
  const save = async () => {
    setBusy(true); setError('')
    try {
      const marketplace = window.vibepaperDesktop?.marketplace
      if (!marketplace) throw new Error(uiText('桌面插件市场接口不可用。'))
      const item = await marketplace.saveNodeDefinition(projectId, { name, description, data })
      await onSaved(item)
    } catch (caught) {
      setError(caught instanceof Error && caught.message.includes('MARKETPLACE_PACKAGE_INVALID')
        ? uiText('节点定义无效。请检查字段标识、默认值、选项和模板中的占位符。')
        : caught instanceof Error ? caught.message : uiText('保存失败，请重试。'))
    } finally { setBusy(false) }
  }
  const input = 'w-full rounded-lg border border-[#d8e0eb] bg-white px-3 py-2 text-sm text-[#24334a]'
  return <section className="mb-6 rounded-2xl border border-[#d8e2f0] bg-white p-5" aria-label={uiText('创建节点定义')}>
    <h2 className="font-bold text-[#24334a]">{uiText('创建节点定义')}</h2>
    <p className="mt-1 text-sm text-[#69768a]">{uiText('选择基础节点，字段使用 {{字段标识}} 插入提示词。保存后可选择安装，不会开始生成。')}</p>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-semibold text-[#647086]">{uiText('节点名称')}<input className={`${input} mt-1`} value={name} maxLength={64} onChange={(event) => setName(event.target.value)} /></label>
      <label className="text-xs font-semibold text-[#647086]">{uiText('基础节点')}<select className={`${input} mt-1`} value={baseType} onChange={(event) => setBaseType(event.target.value as MarketplaceNodeDefinition['baseType'])}>
        <option value="image">{uiText('图片')}</option><option value="text">{uiText('文本')}</option><option value="video">{uiText('视频')}</option><option value="audio">{uiText('音频')}</option>
      </select></label>
      <label className="text-xs font-semibold text-[#647086] sm:col-span-2">{uiText('说明')}<input className={`${input} mt-1`} value={description} maxLength={1024} onChange={(event) => setDescription(event.target.value)} /></label>
      <label className="text-xs font-semibold text-[#647086] sm:col-span-2">{uiText('提示词模板')}<textarea className={`${input} mt-1 min-h-20`} value={template} maxLength={4000} onChange={(event) => setTemplate(event.target.value)} /></label>
    </div>
    <div className="mt-4 space-y-3">{fields.map((field, index) => <div key={index} className="grid gap-2 rounded-xl bg-[#f7f9fc] p-3 sm:grid-cols-3">
      <label className="text-xs text-[#647086]">{uiText('字段标识')}<input aria-label={uiText('字段标识')} className={`${input} mt-1`} value={field.id} onChange={(event) => updateField(index, { id: event.target.value })} /></label>
      <label className="text-xs text-[#647086]">{uiText('显示名称')}<input aria-label={uiText('显示名称')} className={`${input} mt-1`} value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} /></label>
      <label className="text-xs text-[#647086]">{uiText('控件')}<select aria-label={uiText('控件')} className={`${input} mt-1`} value={field.kind} onChange={(event) => updateField(index, { kind: event.target.value as DraftField['kind'] })}><option value="text">{uiText('文本')}</option><option value="number">{uiText('数字')}</option><option value="enum">{uiText('枚举')}</option></select></label>
      <label className="text-xs text-[#647086]">{uiText('默认值')}<input aria-label={uiText('默认值')} className={`${input} mt-1`} type={field.kind === 'number' ? 'number' : 'text'} value={field.defaultValue} onChange={(event) => updateField(index, { defaultValue: event.target.value })} /></label>
      {field.kind === 'number' && <><label className="text-xs text-[#647086]">{uiText('最小值')}<input className={`${input} mt-1`} type="number" value={field.min} onChange={(event) => updateField(index, { min: event.target.value })} /></label><label className="text-xs text-[#647086]">{uiText('最大值')}<input className={`${input} mt-1`} type="number" value={field.max} onChange={(event) => updateField(index, { max: event.target.value })} /></label></>}
      {field.kind === 'enum' && <label className="text-xs text-[#647086] sm:col-span-2">{uiText('选项，每行一项')}<textarea className={`${input} mt-1`} value={field.options} onChange={(event) => updateField(index, { options: event.target.value })} /></label>}
      <button type="button" className="text-left text-xs font-semibold text-[#9a4c4c]" disabled={fields.length <= 1} onClick={() => setFields((current) => current.filter((_, i) => i !== index))}>{uiText('删除字段')}</button>
    </div>)}</div>
    <button type="button" disabled={fields.length >= 20} className="mt-3 text-sm font-semibold text-[#315a96] disabled:opacity-50" onClick={() => setFields((current) => [...current, { ...initialField, id: '', label: '' }])}>{uiText('添加字段')}</button>
    <div className="mt-4 rounded-xl bg-[#f4f7fb] p-3 text-sm text-[#536278]"><strong>{uiText('默认提示词预览')}</strong><p className="mt-1 whitespace-pre-wrap break-words">{preview}</p></div>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <div className="mt-4 flex gap-2"><Button disabled={busy} onClick={() => void save()}>{uiText('保存到本项目')}</Button><Button variant="ghost" disabled={busy} onClick={onClose}>{uiText('取消')}</Button></div>
  </section>
}
