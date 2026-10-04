import { useEffect, useRef, useState } from 'react'
import { ChevronDown, SlidersHorizontal } from 'lucide-react'
import type { ModelInfo } from '@/lib/types'
import { ModelBrandIcon } from './ModelBrandIcon'

/** 带品牌图标的模型下拉，用于偏好 / 节点编辑器。 */
export function ModelPicker({
  models,
  value,
  onChange,
  placeholder = '选择模型',
  dark = false,
  compact = false,
  composer = false,
  className = '',
  desktopProviderNames,
  onConfigureModels,
}: {
  models: ModelInfo[]
  value: string
  onChange: (name: string) => void
  placeholder?: string
  dark?: boolean
  compact?: boolean
  /** Agent 对话框右下角模型选择器样式（与 web 一致） */
  composer?: boolean
  className?: string
  /** Enable the desktop provider grouped menu and its fixed configuration entry. */
  desktopProviderNames?: Record<string, string>
  onConfigureModels?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [activeBrand, setActiveBrand] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const current = models.find((m) => m.name === value)
  const iconSize = composer ? 20 : dark || compact ? 16 : 20
  const visible = models.filter((m) => !/兼容别名|已停用/.test(String(m.description || '')))
  const menuModels = visible.length ? visible : models
  const desktopGroups = onConfigureModels
    ? Array.from(
        menuModels.reduce((groups, model) => {
          const providerId = model.provider || 'other'
          const group = groups.get(providerId) ?? []
          group.push(model)
          groups.set(providerId, group)
          return groups
        }, new Map<string, ModelInfo[]>()),
      )
    : []
  const selectedBrand = desktopGroups.some(([id]) => id === activeBrand)
    ? activeBrand
    : current?.provider || desktopGroups[0]?.[0]
  const brandModels = desktopGroups.find(([id]) => id === selectedBrand)?.[1] ?? []

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  const triggerClass = composer
    ? 'flex h-8 min-w-0 max-w-[180px] items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-[var(--canvas-muted)] transition-colors hover:bg-[var(--canvas-hover)] hover:text-[var(--canvas-text)]'
    : dark
    ? 'flex h-8 w-full min-w-0 max-w-[200px] items-center gap-1.5 rounded-lg bg-white/10 px-2 text-[11px] font-bold text-white/90 hover:bg-white/15'
    : compact
      ? 'flex h-8 max-w-[200px] items-center gap-1.5 rounded-lg bg-black/[0.04] px-2 text-[11px] font-bold text-[#333] hover:bg-black/[0.06]'
      : 'flex h-10 w-full items-center gap-2 rounded-lg border border-black/10 bg-white px-2.5 text-[13px] font-semibold text-[#222] hover:bg-black/[0.02]'

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} className={triggerClass} aria-label="选择 Agent 思考模型">
        {current ? <ModelBrandIcon model={current} size={iconSize} desktop={Boolean(onConfigureModels)} /> : null}
        <span className="min-w-0 flex-1 truncate text-left">
          {current?.displayName || current?.name || value || placeholder}
        </span>
        {composer ? (
          <ChevronDown size={14} strokeWidth={2} className="size-3.5 shrink-0" />
        ) : (
          <span className={`shrink-0 text-[10px] ${dark ? 'text-white/50' : 'text-[#999]'}`}>▾</span>
        )}
      </button>
      {open && (
        <div
          className={`absolute z-[100] min-w-[220px] overflow-hidden rounded-xl border border-[var(--canvas-border)] bg-[var(--canvas-popover)] shadow-xl ${
            dark || compact || composer ? 'bottom-full left-0 mb-1' : 'left-0 top-full mt-1 w-full'
          } ${onConfigureModels ? 'w-[480px] max-w-[calc(100vw-32px)]' : ''}`}
        >
          {onConfigureModels ? (
            <>
              <div className="flex min-h-40 w-[min(480px,calc(100vw-32px))] max-w-full">
                <div className="max-h-72 w-40 shrink-0 overflow-auto border-r border-[var(--canvas-border)] p-2">
                  {desktopGroups.map(([providerId, providerModels]) => (
                    <button key={providerId} type="button" onClick={() => setActiveBrand(providerId)}
                      className={`mb-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-2.5 text-left hover:bg-black/[0.05] ${providerId === selectedBrand ? 'bg-black/[0.06]' : ''}`}>
                      <ModelBrandIcon model={{ name: providerId, provider: providerId, displayName: desktopProviderNames?.[providerId] }} size={17} desktop symbol="settings" />
                      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#555]">
                        {desktopProviderNames?.[providerId] || providerId}
                      </span>
                      <span className="text-[10px] text-[#999]">{providerModels.length}</span>
                    </button>
                  ))}
                </div>
                <div className="max-h-72 min-w-0 flex-1 overflow-auto p-2">
                      {brandModels.map((m) => {
                        const selected = m.name === value
                        return (
                          <button
                            key={m.name}
                            type="button"
                            title={m.displayName ?? m.name}
                            onClick={() => {
                              onChange(m.name)
                              setOpen(false)
                            }}
                            className={`flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-2.5 text-left hover:bg-black/[0.05] ${selected ? 'bg-black/[0.06]' : ''}`}
                          >
                            <ModelBrandIcon model={m} size={18} desktop />
                            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#222]">
                              {m.displayName ?? m.name}
                            </span>
                          </button>
                        )
                      })}
                {!desktopGroups.length && (
                  <p className="px-2 py-4 text-center text-[11px] text-[#888]">尚无已配置且可用的模型</p>
                )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onConfigureModels()
                }}
                className="flex h-10 w-full items-center gap-2 border-t border-[var(--canvas-border)] px-3 text-left text-[11px] font-semibold text-[#555] hover:bg-black/[0.04]"
              >
                <SlidersHorizontal size={14} />
                <span>自定义配置</span>
              </button>
            </>
          ) : (
            <div className="max-h-56 overflow-auto py-1">
              {(menuModels.length ? menuModels : value ? [{ name: value, displayName: value } as ModelInfo] : []).map((m) => {
                const selected = m.name === value
                return (
                  <button
                    key={m.name}
                    type="button"
                    onClick={() => {
                      onChange(m.name)
                      setOpen(false)
                    }}
                    className={`flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-black/[0.04] ${
                      selected ? 'bg-black/[0.04]' : ''
                    }`}
                  >
                    <ModelBrandIcon model={m} size={20} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-bold text-[#222]">
                        {m.displayName ?? m.name}
                      </span>
                      {m.description ? (
                        <span className="block truncate text-[10px] text-[#999]">{m.description}</span>
                      ) : null}
                    </span>
                    {typeof m.basePrice === 'number' ? (
                      <span className="shrink-0 text-[10px] font-semibold text-[#888]">{m.basePrice} 点</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
