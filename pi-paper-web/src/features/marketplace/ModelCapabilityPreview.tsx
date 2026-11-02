import { useState } from 'react'
import type { DesktopModelCapabilityResult } from '@/desktop/desktop-bridge'
import { t as uiText } from '@/lib/i18n'

/** Explicit local inspection; this never chooses a binding or contacts a provider. */
export function ModelCapabilityPreview({ projectId, modality, initialResolution }: {
  projectId?: string
  modality: 'text' | 'image' | 'video' | 'audio'
  initialResolution?: string
}) {
  const [references, setReferences] = useState<Array<'text' | 'image' | 'video' | 'audio'>>([])
  const [resolution, setResolution] = useState(initialResolution ?? '')
  const [aspect, setAspect] = useState('')
  const [result, setResult] = useState<DesktopModelCapabilityResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inspect = async () => {
    if (!projectId || !window.vibepaperDesktop?.marketplace) return
    setBusy(true); setError(''); setResult(null)
    try {
      setResult(await window.vibepaperDesktop.marketplace.discoverModels(projectId, { modality,
        ...(references.length ? { referenceInputs: references } : {}),
        ...(resolution.trim() ? { resolution: resolution.trim() } : {}), ...(aspect.trim() ? { aspect: aspect.trim() } : {}) }))
    } catch (caught) { setError(caught instanceof Error ? caught.message : uiText('读取模型能力失败。')) }
    finally { setBusy(false) }
  }
  return <div className="mt-3 rounded-xl border border-[#e3e9f2] bg-white p-3 text-xs text-[#637187]">
    <strong>{uiText('适用模型')}</strong><p className="mt-1">{uiText('仅检查本机配置和已声明能力，不会联系供应商或选择模型。')}</p>
    <div className="mt-2 grid gap-2 sm:grid-cols-3">
      <fieldset><legend>{uiText('参考输入')}</legend><div className="mt-1 flex flex-wrap gap-2">{([{ type: 'text', label: '文本' }, { type: 'image', label: '图片' }, { type: 'video', label: '视频' }, { type: 'audio', label: '音频' }] as const).map((item) => <label key={item.type} className="inline-flex items-center gap-1"><input type="checkbox" checked={references.includes(item.type)} onChange={(event) => { setReferences((current) => event.target.checked ? [...current, item.type] : current.filter((value) => value !== item.type)); setResult(null) }} />{uiText(item.label)}</label>)}</div></fieldset>
      <label>{uiText('分辨率')}<input aria-label={uiText('分辨率')} className="mt-1 w-full rounded-lg border border-black/10 p-1.5" maxLength={80} value={resolution} onChange={(event) => { setResolution(event.target.value); setResult(null) }} /></label>
      <label>{uiText('画幅比例')}<input aria-label={uiText('画幅比例')} className="mt-1 w-full rounded-lg border border-black/10 p-1.5" maxLength={80} value={aspect} placeholder="1:1" onChange={(event) => { setAspect(event.target.value); setResult(null) }} /></label>
    </div>
    <button type="button" disabled={!projectId || busy} onClick={() => void inspect()} className="mt-2 rounded-lg border border-[#d8e1ed] px-3 py-1.5 font-semibold text-[#315a96] disabled:opacity-50">{uiText('检查模型能力')}</button>
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
    {result && <div className="mt-2 max-h-52 overflow-auto"><p>{uiText('满足条件的已配置模型：{0}', { 0: result.bindings.filter((item) => item.available).length })}</p>
      {result.bindings.length === 0 ? <p className="mt-1">{uiText('当前目录没有此类型的模型。')}</p> : result.bindings.map((binding) => <p key={`${binding.providerId}/${binding.id}`} className="mt-1 break-words">{binding.providerName} · {binding.displayName} — {binding.available ? uiText('配置与能力匹配') : uiText(binding.reasonMessage ?? '不可用')}</p>)}
    </div>}
  </div>
}
