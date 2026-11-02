import type { DesktopNodeDefinitionInstance } from '@/desktop/desktop-bridge'
import { t as uiText } from '@/lib/i18n'
import { renderNodeDefinitionPrompt } from '../nodeDefinitionCatalog'

export function NodeDefinitionFields({ instance, referenceTexts = [], suffix = '', onChange }: {
  instance: DesktopNodeDefinitionInstance
  referenceTexts?: string[]
  suffix?: string
  onChange: (values: Record<string, string | number>) => void
}) {
  const change = (id: string, value: string | number) => onChange({ ...instance.values, [id]: value })
  return <div className="rounded-xl border border-black/10 bg-[#f9fafc] p-3">
    <p className="text-xs font-bold text-[#333]">{uiText(instance.snapshot.name)}</p>
    <div className="mt-2 grid gap-2">{instance.snapshot.data.fields.map((field) => <label key={field.id} className="text-xs text-[#666]">{uiText(field.label)}
      {field.kind === 'enum' ? <select className="mt-1 w-full rounded-lg border border-black/10 bg-white px-2 py-1.5 text-sm" value={String(instance.values[field.id])} onChange={(event) => change(field.id, event.target.value)}>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
        : <input className="mt-1 w-full rounded-lg border border-black/10 bg-white px-2 py-1.5 text-sm" type={field.kind === 'number' ? 'number' : 'text'} min={field.kind === 'number' ? field.min : undefined} max={field.kind === 'number' ? field.max : undefined} maxLength={field.kind === 'text' ? 1000 : undefined} value={instance.values[field.id]} onChange={(event) => {
          if (field.kind === 'text') change(field.id, event.target.value)
          else { const value = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(value) && value >= field.min && value <= field.max) change(field.id, value) }
        }} />}
    </label>)}</div>
    <p className="mt-3 text-[11px] font-semibold text-[#888]">{uiText('生成提示词预览')}</p><p className="mt-1 whitespace-pre-wrap break-words text-xs text-[#555]">{[...referenceTexts, renderNodeDefinitionPrompt(instance).trim(), suffix].filter(Boolean).join('\n\n')}</p>
  </div>
}
