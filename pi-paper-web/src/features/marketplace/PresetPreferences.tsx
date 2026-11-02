import { useState } from 'react'
import type { MarketplaceComponent } from '@/desktop/desktop-bridge'
import { t } from '@/lib/i18n'

type Preset = Extract<MarketplaceComponent, { type: 'preset' }>
type Scope = 'personal' | 'project'
const fieldNames: Record<string, string> = {
  prompt: '提示词', style: '风格', camera: '运镜', title: '标题', content: '正文', model: '模型',
  aspect: '宽高比', ratio: '比例', size: '尺寸', resolution: '分辨率', resKey: '分辨率档位',
  duration: '时长', count: '数量', generate_audio: '生成音频',
}

export function PresetPreferences({ component, projectId, packageId, version, onSaved }: {
  component: Preset; projectId?: string; packageId: string; version: string; onSaved: () => Promise<void>
}) {
  const [scope, setScope] = useState<Scope>('personal')
  const preferences = component.preferences
  if (!preferences) return null
  return <details className="mt-2 rounded-xl border border-[#dce5f0] bg-white px-4 py-2 sm:ml-7">
    <summary className="cursor-pointer py-1 text-sm font-semibold">{t('配置预设')}</summary>
    <p className="my-2 text-xs leading-5 text-[#667489]">{t('个人默认值可跨项目使用，项目设置优先。修改只影响下次应用此版本。')}</p>
    <label className="text-sm">{t('设置范围')} <select className="rounded border px-2 py-1" value={scope} onChange={e => setScope(e.target.value as Scope)}>
      <option value="personal">{t('个人默认值')}</option>
      {component.installed && projectId && <option value="project">{t('当前项目')}</option>}
    </select></label>
    <PreferenceFields key={JSON.stringify([scope, version, preferences, projectId])} scope={scope} component={component} preferences={preferences}
      save={async params => { await window.vibepaperDesktop!.marketplace.savePresetPreferences(projectId, scope, packageId, component.id, version, params); await onSaved() }} />
  </details>
}
function PreferenceFields({ scope, component, preferences, save }: {
  scope: Scope; component: Preset; preferences: NonNullable<Preset['preferences']>; save: (params: Record<string, unknown>) => Promise<void>
}) {
  const inherited = scope === 'personal' ? preferences.original : { ...preferences.original, ...preferences.personal }
  const [overrides, setOverrides] = useState({ ...preferences[scope] })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const fields = new Set(['prompt', ...Object.keys(inherited), ...Object.keys(overrides)])
  if (['image', 'video'].includes(component.data.nodeType)) { fields.add('model'); fields.add('ratio'); fields.add('resolution') }
  if (component.data.nodeType === 'video') fields.add('duration')
  if (component.data.nodeType === 'image') fields.add('count')
  return <form className="my-3 space-y-2" onSubmit={async event => {
    event.preventDefault()
    setBusy(true); setMessage('')
    try { await save(overrides); setMessage(t('已保存')) }
    catch { setMessage(t('无法保存，请检查参数并重试。')) }
    finally { setBusy(false) }
  }}>
    {[...fields].map(key => {
      const numeric = key === 'count' || key === 'duration'
      return <label key={key} className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 text-xs">
        <span>{t(fieldNames[key] ?? key)}</span>
        {key === 'generate_audio' ? <select className="rounded-md border px-2 py-1.5"
          value={String(overrides[key] ?? '')} onChange={e => {
            const next = { ...overrides }
            if (e.target.value) next[key] = e.target.value === 'true'
            else delete next[key]
            setOverrides(next)
          }}>
          <option value="">{t('继承')}</option><option value="true">{t('启用')}</option><option value="false">{t('停用')}</option>
        </select> : <input type={numeric ? 'number' : 'text'} step={key === 'duration' ? 'any' : undefined}
          className="rounded-md border px-2 py-1.5" placeholder={String(inherited[key] ?? t('使用节点设置'))}
          value={String(overrides[key] ?? '')} onChange={event => {
            const raw = event.target.value
            setOverrides(previous => {
              const next = { ...previous }
              if (!raw) delete next[key]
              else next[key] = numeric ? Number(raw) : raw
              return next
            })
          }} />}
      </label>
    })}
    <div className="flex items-center gap-3 pt-1 text-xs">
      <button disabled={busy} className="rounded bg-[#243e68] px-3 py-2 text-white">{t('保存设置')}</button>
      <button type="button" disabled={busy} onClick={() => setOverrides({})}>{t('清除覆盖值')}</button>
      <span role="status">{message}</span>
    </div>
  </form>
}
