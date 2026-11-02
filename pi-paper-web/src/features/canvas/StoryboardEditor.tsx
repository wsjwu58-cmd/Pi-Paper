import { useState } from 'react'
import { createPortal } from 'react-dom'
import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { textNodeContent } from './nodes/textContent'
import type { FlowNode } from './canvasStore'
import type { StoryboardField } from './creativePluginTypes'

const fields: StoryboardField[] = ['title', 'type', 'prompt', 'camera', 'content']
const labels: Record<StoryboardField, string> = { title: '标题', type: '类型', prompt: '提示词', camera: '运镜', content: '内容' }
export interface StoryboardRow { id: string; values: Record<StoryboardField, string> }
export function storyboardRows(nodes: FlowNode[]): StoryboardRow[] {
  return [...nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x).map((node, index) => {
    const params = node.data.node.params ?? {}
    const asText = (value: unknown) => typeof value === 'string' ? value : ''
    return { id: String(node.id), values: { title: asText(params.title) || asText(params.name) || uiText('镜头 {0}', { 0: index + 1 }), type: node.data.node.type,
      prompt: asText(params.prompt), camera: asText(params.camera), content: textNodeContent(node.data.node.output?.text, params) } }
  })
}
/** Quote CSV values and neutralize spreadsheet formula prefixes, including leading whitespace. */
function cell(value: string): string {
  const safe = /^[\t\r\n ]*[=+\-@]/u.test(value) ? `'${value}` : value
  return `"${safe.replaceAll('"', '""')}"`
}
export function storyboardCsv(rows: StoryboardRow[], selected: StoryboardField[]): string {
  return '\ufeff' + [ [uiText('序号'), ...selected.map((field) => uiText(labels[field]))], ...rows.map((row, index) => [String(index + 1), ...selected.map((field) => row.values[field])]) ].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
export function StoryboardEditor({ nodes, initialFields, onClose }: { nodes: FlowNode[]; initialFields: StoryboardField[]; onClose: () => void }) {
  useUiLanguage()
  const [rows, setRows] = useState(() => storyboardRows(nodes))
  const [selected, setSelected] = useState<StoryboardField[]>(initialFields)
  const move = (index: number, delta: number) => setRows((current) => {
    const next = [...current], target = index + delta
    if (target < 0 || target >= next.length) return current
    ;[next[index], next[target]] = [next[target], next[index]]
    return next
  })
  const download = () => {
    if (!selected.length) return
    const url = URL.createObjectURL(new Blob([storyboardCsv(rows, selected)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = '分镜表.csv'; a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return createPortal(<div role="dialog" aria-modal="true" aria-label={uiText('导出分镜表')} className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4"><div className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-2xl bg-white p-5 shadow-2xl">
    <div className="flex justify-between"><h2 className="font-bold">{uiText('导出分镜表')}</h2><button type="button" onClick={onClose}>{uiText('关闭')}</button></div>
    <p className="my-3 text-xs text-[#777]">{uiText('调整选中节点的顺序，并选择要导出的字段。')}</p>
    <div className="flex flex-wrap gap-3">{fields.map((field) => <label key={field} className="text-xs"><input type="checkbox" checked={selected.includes(field)} onChange={(e) => setSelected((old) => e.target.checked ? [...old, field] : old.filter((item) => item !== field))} /> {uiText(labels[field])}</label>)}</div>
    <ol className="my-4 space-y-1">{rows.map((row, index) => <li key={row.id} className="flex items-center gap-2 rounded-lg bg-[#f5f6f8] p-2 text-xs"><span className="flex-1">{index + 1}. {row.values.title} · {row.values.type}</span><button type="button" disabled={index === 0} onClick={() => move(index, -1)}>{uiText('上移')}</button><button type="button" disabled={index === rows.length - 1} onClick={() => move(index, 1)}>{uiText('下移')}</button></li>)}</ol>
    <button type="button" disabled={!selected.length || !rows.length} onClick={download} className="rounded-lg bg-[#222] px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{uiText('下载 CSV')}</button>
  </div></div>, document.body)
}
