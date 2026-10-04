import { useState } from 'react'
import { Image as ImageIcon, Settings2 } from 'lucide-react'
import type { ModelInfo } from '@/lib/types'

export type ModelBrand =
  | 'agnes'
  | 'anthropic'
  | 'deepseek'
  | 'qwen'
  | 'openai'
  | 'google'
  | 'xai'
  | 'minimax'
  | 'elevenlabs'
  | 'fish'
  | 'bytedance'
  | 'alibaba'
  | 'doubao'
  | 'flux'
  | 'stability'
  | 'kling'
  | 'vidu'
  | 'pixverse'
  | 'byteplus'
  | 'moonshot'
  | 'kimi'
  | 'happyhorse'
  | 'wan'
  | 'audio'
  | 'compose'
  | 'director'
  | 'generic'

const ENGINE_LLM_BASE = 'https://tos.nexra-ai.com/engine-llm'

const BRAND_ICON_URL: Partial<Record<ModelBrand, string>> = {
  deepseek: `${ENGINE_LLM_BASE}/deepseek.png`,
  qwen: `${ENGINE_LLM_BASE}/qwen.png`,
  openai: `${ENGINE_LLM_BASE}/openai.png`,
  google: `${ENGINE_LLM_BASE}/google.png`,
  doubao: `${ENGINE_LLM_BASE}/doubao.png`,
  flux: `${ENGINE_LLM_BASE}/flux.png`,
  stability: `${ENGINE_LLM_BASE}/stability.png`,
  kling: `${ENGINE_LLM_BASE}/kling.png`,
  wan: `${ENGINE_LLM_BASE}/wan.png`,
}

/** Locally bundled vendor marks used only by the desktop UI. */
const DESKTOP_BRAND_ICON_URL: Partial<Record<ModelBrand, string>> = {
  agnes: '/provider-icons/agnes.png',
  anthropic: '/provider-icons/anthropic.ico',
  deepseek: '/provider-icons/deepseek.ico',
  openai: '/provider-icons/openai.svg',
  google: '/provider-icons/google.ico',
  xai: '/provider-icons/xai.ico',
  minimax: '/provider-icons/minimax.ico',
  elevenlabs: '/provider-icons/elevenlabs.svg',
  fish: '/provider-icons/fish-audio.ico',
  bytedance: '/provider-icons/bytedance.png',
  alibaba: '/provider-icons/alibaba-cloud.ico',
  kling: '/provider-icons/kling.png',
  vidu: '/provider-icons/vidu.svg',
  pixverse: '/provider-icons/pixverse.svg',
  byteplus: '/provider-icons/byteplus.png',
  moonshot: '/provider-icons/moonshot.ico',
  kimi: '/provider-icons/kimi.ico',
  qwen: '/provider-icons/qwen.png',
  happyhorse: '/provider-icons/happyhorse.png',
}

const DESKTOP_PROVIDER_BRANDS: Record<string, ModelBrand> = {
  agnes: 'agnes',
  anthropic: 'anthropic',
  deepseek: 'deepseek',
  openai: 'openai',
  google: 'google',
  xai: 'xai',
  minimax: 'minimax',
  elevenlabs: 'elevenlabs',
  'fish-audio': 'fish',
  bytedance: 'bytedance',
  doubao: 'bytedance',
  'doubao-voice': 'bytedance',
  'doubao-voice-v1': 'bytedance',
  volcengine: 'bytedance',
  'volcengine-ark': 'bytedance',
  alibaba: 'alibaba',
  'alibaba-video': 'alibaba',
  kling: 'kling',
  vidu: 'vidu',
  pixverse: 'pixverse',
  byteplus: 'byteplus',
  moonshot: 'moonshot',
  kimi: 'kimi',
  qwen: 'qwen',
  happyhorse: 'happyhorse',
}

const DESKTOP_PROVIDER_LABEL_BRANDS: Record<string, ModelBrand> = {
  'agnes ai': 'agnes',
  'google ai studio': 'google',
  'google ai': 'google',
  'fish audio': 'fish',
  'byte dance': 'bytedance',
  '火山方舟': 'bytedance',
  '阿里云百炼': 'alibaba',
  '阿里云百炼视频': 'alibaba',
}

const BRAND_META: Record<ModelBrand, { label: string; bg: string; fg: string }> = {
  agnes: { label: 'A', bg: '#111827', fg: '#fff' },
  anthropic: { label: 'A', bg: '#d97757', fg: '#fff' },
  deepseek: { label: 'DS', bg: '#4d6bfe', fg: '#fff' },
  qwen: { label: 'QW', bg: '#615ced', fg: '#fff' },
  openai: { label: 'AI', bg: '#10a37f', fg: '#fff' },
  google: { label: 'G', bg: '#4285f4', fg: '#fff' },
  xai: { label: 'x', bg: '#111827', fg: '#fff' },
  minimax: { label: 'M', bg: '#111827', fg: '#fff' },
  elevenlabs: { label: '11', bg: '#111827', fg: '#fff' },
  fish: { label: 'F', bg: '#ff6d6a', fg: '#fff' },
  bytedance: { label: 'B', bg: '#35b8c7', fg: '#fff' },
  alibaba: { label: 'A', bg: '#ff6a00', fg: '#fff' },
  doubao: { label: '豆', bg: '#3b82f6', fg: '#fff' },
  flux: { label: 'FX', bg: '#111827', fg: '#fff' },
  stability: { label: 'SD', bg: '#9333ea', fg: '#fff' },
  kling: { label: 'KL', bg: '#0f766e', fg: '#fff' },
  vidu: { label: 'V', bg: '#03061e', fg: '#fff' },
  pixverse: { label: 'P', bg: '#111827', fg: '#fff' },
  byteplus: { label: 'B', bg: '#1967ff', fg: '#fff' },
  moonshot: { label: 'M', bg: '#111827', fg: '#fff' },
  kimi: { label: 'K', bg: '#111827', fg: '#fff' },
  happyhorse: { label: 'H', bg: '#111827', fg: '#fff' },
  wan: { label: 'WN', bg: '#ea580c', fg: '#fff' },
  audio: { label: '♪', bg: '#db2777', fg: '#fff' },
  compose: { label: '合', bg: '#475569', fg: '#fff' },
  director: { label: '导', bg: '#1e293b', fg: '#fff' },
  generic: { label: 'M', bg: '#64748b', fg: '#fff' },
}

function normalizeBrandLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function brandFromDesktopLabel(value: string): ModelBrand | undefined {
  const label = normalizeBrandLabel(value)
  if (DESKTOP_PROVIDER_BRANDS[label]) return DESKTOP_PROVIDER_BRANDS[label]
  if (DESKTOP_PROVIDER_LABEL_BRANDS[label]) return DESKTOP_PROVIDER_LABEL_BRANDS[label]

  // Anchored official model-family labels provide a fallback when callers only
  // have a model display name and no provider ID.
  if (/^claude(?:\s|$)/.test(label)) return 'anthropic'
  if (/^(?:gpt(?:\s|-|$)|o[134](?:\s|-|$))/.test(label)) return 'openai'
  if (/^(?:gemini|veo)(?:\s|$)/.test(label) || /^banana (?:2|pro)(?:\s|$)/.test(label)) return 'google'
  if (/^deepseek(?:\s|-|$)/.test(label)) return 'deepseek'
  if (/^grok(?:\s|-|$)/.test(label)) return 'xai'
  if (/^minimax(?:\s|-|$)/.test(label)) return 'minimax'
  if (/^elevenlabs(?:\s|$)/.test(label) || /^eleven (?:flash|multilingual|voice|music|agents)(?:\s|$)/.test(label)) return 'elevenlabs'
  if (/^fish audio(?:\s|$)/.test(label)) return 'fish'
  if (/^(?:seed(?:\s|ance|ream)|doubao(?:\s|-|$))/.test(label)) return 'bytedance'
  if (/^(?:wan(?:\s|[-0-9])|z-image turbo$)/.test(label)) return 'alibaba'
  if (/^qwen(?:\s|-|$)/.test(label)) return 'qwen'
  if (/^agnes(?:\s|$)/.test(label)) return 'agnes'
  if (/^kling(?:\s|$)/.test(label)) return 'kling'
  if (/^vidu(?:\s|$)/.test(label)) return 'vidu'
  if (/^pixverse(?:\s|$)/.test(label)) return 'pixverse'
  if (/^byteplus(?:\s|$)/.test(label)) return 'byteplus'
  if (/^kimi(?:\s|$)/.test(label)) return 'kimi'
  if (/^happyhorse(?:\s|$)/.test(label)) return 'happyhorse'
  return undefined
}

/** Resolve a bundled desktop mark from stable provider IDs or known model labels. */
export function resolveDesktopModelBrand(
  model: Pick<ModelInfo, 'name' | 'provider' | 'displayName'> | string,
): ModelBrand {
  if (typeof model === 'string') return brandFromDesktopLabel(model) ?? 'generic'

  const provider = normalizeBrandLabel(model.provider || '')
  const providerBrand = DESKTOP_PROVIDER_BRANDS[provider] ?? DESKTOP_PROVIDER_LABEL_BRANDS[provider]
  if (providerBrand) return providerBrand

  return brandFromDesktopLabel(model.displayName || '')
    ?? brandFromDesktopLabel(model.name || '')
    ?? 'generic'
}

/** 按 provider / 模型名推断品牌，用于图标。 */
export function resolveModelBrand(model: Pick<ModelInfo, 'name' | 'provider' | 'displayName'> | string): ModelBrand {
  const name = (typeof model === 'string' ? model : model.name || '').toLowerCase()
  const provider = (typeof model === 'string' ? '' : model.provider || '').toLowerCase()
  const display = (typeof model === 'string' ? '' : model.displayName || '').toLowerCase()
  const hay = `${provider} ${name} ${display}`

  if (/agnes/.test(hay)) return 'agnes'
  if (/deepseek/.test(hay)) return 'deepseek'
  if (/qwen|tongyi|通义/.test(hay)) return 'qwen'
  if (/gemini|google/.test(hay)) return 'google'
  if (/gpt|openai/.test(hay)) return 'openai'
  if (/doubao|seedream|seedance|volc|ark|方舟/.test(hay)) return 'doubao'
  if (/flux/.test(hay)) return 'flux'
  if (/stable|sd3|sd-/.test(hay)) return 'stability'
  if (/kling|可灵/.test(hay)) return 'kling'
  if (/wan-|\bwan\b/.test(hay)) return 'wan'
  if (/music|audio/.test(hay)) return 'audio'
  if (/compose|合成/.test(hay)) return 'compose'
  if (/director|导演/.test(hay)) return 'director'
  return 'generic'
}

/** CDN 模型图标 URL，与 web 参考 UI 一致。 */
export function resolveModelIconUrl(
  model: Pick<ModelInfo, 'name' | 'provider' | 'displayName'> | string,
): string | null {
  const brand = resolveModelBrand(model)
  return BRAND_ICON_URL[brand] ?? null
}

function BeanIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M12 2c-4.5 0-8 3.5-8 9 0 4 2 11 8 11s8-7 8-11c0-5.5-3.5-9-8-9zm0 3c.8 0 1.5.4 2 1.2.5 1.2.3 2.8-.5 4.1-.8 1.3-2.2 2-3.5 1.8-1.3-.2-2.2-1.2-2.2-2.5 0-2.5 2.2-4.6 4.2-4.6z" />
    </svg>
  )
}

export function ModelBrandIcon({
  model,
  size = 18,
  className = '',
  preferImage = true,
  desktop = false,
  symbol = 'image',
}: {
  model: Pick<ModelInfo, 'name' | 'provider' | 'displayName'> | string
  size?: number
  className?: string
  /** 优先使用 CDN 图标（与 web 一致），加载失败时回退字母徽章 */
  preferImage?: boolean
  /** Desktop provider screens use bundled UI symbols and never load remote brand assets. */
  desktop?: boolean
  symbol?: 'image' | 'settings'
}) {
  const brand = resolveModelBrand(model)
  const meta = BRAND_META[brand]
  const font = Math.max(8, Math.round(size * 0.42))
  const iconUrl = preferImage ? resolveModelIconUrl(model) : null
  const [imgFailed, setImgFailed] = useState(false)
  const title = typeof model === 'string' ? model : model.displayName || model.name

  if (desktop) {
    const desktopBrand = resolveDesktopModelBrand(model)
    const desktopIconUrl = preferImage ? DESKTOP_BRAND_ICON_URL[desktopBrand] : null
    if (desktopIconUrl && !imgFailed) {
      return (
        <span
          className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-black/10 bg-white p-0.5 ${className}`}
          style={{ width: size, height: size }}
          title={title}
          aria-hidden
        >
          <img
            alt=""
            src={desktopIconUrl}
            className="size-full object-contain"
            onError={() => setImgFailed(true)}
          />
        </span>
      )
    }

    const SymbolIcon = symbol === 'settings' ? Settings2 : ImageIcon
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-md bg-[#f0eef8] text-[#6d55c9] ${className}`}
        style={{ width: size, height: size }}
        title={title}
        aria-hidden
      >
        <SymbolIcon size={Math.max(12, Math.round(size * 0.58))} strokeWidth={1.8} />
      </span>
    )
  }

  if (iconUrl && !imgFailed) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded ${className}`}
        style={{ width: size, height: size }}
        title={title}
        aria-hidden
      >
        <img
          alt=""
          src={iconUrl}
          className="size-full object-contain"
          onError={() => setImgFailed(true)}
        />
      </span>
    )
  }

  const useBean = brand === 'doubao' || brand === 'wan'

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-black leading-none ${className}`}
      style={{
        width: size,
        height: size,
        background: meta.bg,
        color: meta.fg,
        fontSize: font,
      }}
      title={title}
      aria-hidden
    >
      {useBean ? <BeanIcon size={size} /> : meta.label}
    </span>
  )
}
