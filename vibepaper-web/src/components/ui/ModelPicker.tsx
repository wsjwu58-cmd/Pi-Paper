import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
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
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = models.find((m) => m.name === value)
  const iconSize = composer ? 20 : dark || compact ? 16 : 20
  const visible = models.filter((m) => !/兼容别名|已停用/.test(String(m.description || '')))
  const menuModels = visible.length ? visible : models

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
        {current ? <ModelBrandIcon model={current} size={iconSize} /> : null}
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
          className={`absolute z-[100] max-h-56 min-w-[220px] overflow-auto rounded-xl border border-[var(--canvas-border)] bg-[var(--canvas-popover)] py-1 shadow-xl ${
            dark || compact || composer ? 'bottom-full left-0 mb-1' : 'left-0 top-full mt-1 w-full'
          }`}
        >
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
  )
}
