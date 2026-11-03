import { useEffect, useState } from 'react'
import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { desktopProviderLabel, toAvailableDesktopModels } from '@/desktop/providerModels'
import type { DesktopProviderConfiguration } from '@/desktop/desktop-bridge'

type GenerationModality = 'text' | 'image' | 'video'

export function desktopGenerationDefaults(
  configuration: DesktopProviderConfiguration,
  modality: GenerationModality,
): Array<{ providerId: string; providerName: string; name: string; resolution?: string }> {
  const available = toAvailableDesktopModels(configuration, modality)
  return configuration.providers.flatMap((provider) => {
    const model = available.find((item) => item.id === provider.defaultModelIds?.[modality] && item.providerId === provider.id)
    if (!model) return []
    const resolution = model.defaultParams?.resolution ?? model.defaultParams?.size
    return [{
      providerId: provider.id,
      providerName: desktopProviderLabel(provider.id, provider.name),
      name: model.displayName || model.name,
      ...(typeof resolution === 'string' && resolution ? { resolution } : {}),
    }]
  })
}

/** The desktop edition uses provider/model-scoped defaults rather than the web user-preferences API. */
export function DesktopGenerationPreferences({ onConfigure }: { onConfigure: () => void }) {
  useUiLanguage()
  const [configuration, setConfiguration] = useState<DesktopProviderConfiguration | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const bridge = window.vibepaperDesktop
    if (!bridge?.getProviderConfiguration) {
      setError(uiText('桌面模型配置接口尚未接入。'))
      setLoading(false)
      return
    }
    void bridge.getProviderConfiguration().then((providers) => {
      if (!active) return
      setConfiguration(providers)
      setLoading(false)
    }).catch((cause) => {
      if (!active) return
      setError(cause instanceof Error ? cause.message : uiText('读取模型配置失败。'))
      setLoading(false)
    })
    return () => { active = false }
  }, [])

  return (
    <div className="flex-1 space-y-3 overflow-auto p-4">
      <p className="text-[13px] font-bold text-[#111]">{uiText('偏好设置')}</p>
      <p className="text-[11px] leading-relaxed text-[#888]">{uiText('Agent 模型按会话选择。节点默认值按提供方保存；有多个可用默认值时按提供方顺序选择，未设置时从可用模型中选择。已有节点保留自己的参数。')}</p>
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {([
        ['text', '文本模型'],
        ['image', '图片模型'],
        ['video', '视频模型'],
      ] as const).map(([modality, label]) => {
        const values = configuration ? desktopGenerationDefaults(configuration, modality) : []
        return <div key={modality}>
          <p className="mb-1 text-[12px] font-bold text-[#555]">{uiText(label)}</p>
          <div className="min-h-10 w-full rounded-lg border border-black/10 bg-white px-2.5 py-2 text-[13px] text-[#222]">
            {loading ? uiText('正在读取配置…') : error ? uiText('读取模型配置失败。') : values.length ? values.map((value) => <div key={value.providerId} className="py-1">
              <span className="font-semibold">{value.providerName} · {value.name}</span>
              {value.resolution && <span className="ml-1 text-[11px] text-[#888]">({uiText('默认分辨率')}：{value.resolution})</span>}
            </div>) : uiText('尚未设置可用的提供方默认模型')}
          </div>
        </div>
      })}
      <button type="button" onClick={onConfigure} className="h-10 w-full rounded-full bg-[#111] text-[13px] font-bold text-white">
        {uiText('配置默认模型与参数')}
      </button>
    </div>
  )
}
