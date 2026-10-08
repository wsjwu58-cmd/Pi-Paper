import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSoftPresence } from '../canvasMotion'

export type MediaDurationCapability =
  | { kind: 'discrete'; values: number[] }
  | { kind: 'range'; minimum: number; maximum: number; step: number }
  | { kind: 'fixed'; value: number }
  | null

export interface MediaSpecificationPickerProps {
  mediaType: 'image' | 'video'
  aspect: string
  aspectOptions: string[]
  resolution: string
  resolutionOptions: Array<{ key: string; value: string }>
  duration?: number
  durationCapability?: MediaDurationCapability
  dark?: boolean
  disabled?: boolean
  onAspectChange: (value: string) => void
  onResolutionChange: (value: string) => void
  onDurationChange?: (value: number) => void
}

function ratioShape(value: string): { width: number; height: number } {
  const [width, height] = value.split(':').map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 17, height: 12 }
  }
  const scale = 19 / Math.max(width, height)
  return { width: Math.max(7, Math.round(width * scale)), height: Math.max(7, Math.round(height * scale)) }
}

function isDurationValid(duration: number, capability: MediaDurationCapability): boolean {
  if (!capability || !Number.isFinite(duration)) return !capability
  if (capability.kind === 'fixed') return duration === capability.value
  if (capability.kind === 'discrete') return capability.values.includes(duration)
  return duration >= capability.minimum && duration <= capability.maximum
}

function durationThumbIndex(duration: number, values: number[]): number {
  const exact = values.indexOf(duration)
  if (exact >= 0) return exact
  let nearest = 0
  for (let index = 1; index < values.length; index += 1) {
    if (Math.abs(values[index] - duration) < Math.abs(values[nearest] - duration)) nearest = index
  }
  return nearest
}

/**
 * Image and video node parameters are selected from the public model directory.
 * The popover is portaled to body so React Flow's canvas transform cannot skew it.
 */
export function MediaSpecificationPicker({
  mediaType,
  aspect,
  aspectOptions,
  resolution,
  resolutionOptions,
  duration,
  durationCapability = null,
  dark = false,
  disabled = false,
  onAspectChange,
  onResolutionChange,
  onDurationChange,
}: MediaSpecificationPickerProps) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const presence = useSoftPresence(open)
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number }>({ left: 12, top: 12 })
  const hasAspectOptions = aspectOptions.length > 0
  const hasResolutionOptions = resolutionOptions.length > 0
  const safeDuration = typeof duration === 'number' && Number.isFinite(duration) ? duration : 0
  const durationIsValid = isDurationValid(safeDuration, durationCapability)
  const summary = [
    hasAspectOptions ? aspect : undefined,
    hasResolutionOptions ? resolutionOptions.find((option) => option.key === resolution)?.key ?? resolution : undefined,
    mediaType === 'video' && durationCapability ? `${safeDuration}秒` : undefined,
  ].filter(Boolean).join(' · ')

  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const width = Math.min(560, window.innerWidth - 24)
    const left = Math.max(12, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12))
    const estimatedHeight = Math.min(popoverRef.current?.getBoundingClientRect().height || (mediaType === 'video' && durationCapability ? 360 : 260), window.innerHeight - 24)
    if (rect.bottom + estimatedHeight < window.innerHeight - 12) {
      setPosition({ left, top: rect.bottom + 10 })
    } else if (rect.top - estimatedHeight > 12) {
      setPosition({ left, bottom: Math.max(12, window.innerHeight - rect.top + 10) })
    } else {
      setPosition({ left, top: Math.max(12, Math.min(rect.bottom + 10, window.innerHeight - estimatedHeight - 12)) })
    }
  }, [open, presence.present, mediaType, durationCapability, aspectOptions.length, resolutionOptions.length])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const closeOnViewportChange = () => setOpen(false)
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', closeOnViewportChange)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', closeOnViewportChange)
    }
  }, [open])

  const renderDurationControl = () => {
    if (mediaType !== 'video' || !durationCapability || duration === undefined) return null
    const label = durationCapability.kind === 'range'
      ? `${durationCapability.minimum}秒 — ${durationCapability.maximum}秒`
      : durationCapability.kind === 'discrete'
        ? `${durationCapability.values[0]}秒 — ${durationCapability.values[durationCapability.values.length - 1]}秒`
        : `${durationCapability.value}秒`
    return (
      <section className="vp-media-duration mt-5" aria-label="视频时长">
        <div className="mb-2 flex items-center justify-between text-[12px] text-[#777]">
          <span>时长</span>
          <span>{label}</span>
        </div>
        {durationCapability.kind === 'fixed' ? (
          <div className="vp-media-duration-fixed flex h-14 items-center justify-center rounded-full bg-[#f1f1f2] text-sm font-semibold text-[#333]">
            {durationCapability.value}秒
          </div>
        ) : (
          <div className="vp-media-duration-track flex h-14 items-center gap-3 rounded-full bg-[#f1f1f2] px-4">
            <span className="shrink-0 text-[12px] text-[#999]">
              {durationCapability.kind === 'range' ? `${durationCapability.minimum}秒` : `${durationCapability.values[0]}秒`}
            </span>
            {durationCapability.kind === 'discrete' ? (
              <input
                aria-label="视频时长档位"
                type="range"
                min={0}
                max={Math.max(0, durationCapability.values.length - 1)}
                step={1}
                value={durationThumbIndex(safeDuration, durationCapability.values)}
                onChange={(event) => onDurationChange?.(durationCapability.values[Number(event.target.value)])}
                disabled={durationCapability.values.length < 2}
                className="vp-media-duration-slider min-w-0 flex-1"
              />
            ) : (
              <input
                aria-label="视频时长"
                type="range"
                min={durationCapability.minimum}
                max={durationCapability.maximum}
                step={durationCapability.step}
                value={Math.min(durationCapability.maximum, Math.max(durationCapability.minimum, safeDuration))}
                onChange={(event) => onDurationChange?.(Number(event.target.value))}
                className="vp-media-duration-slider min-w-0 flex-1"
              />
            )}
            <span className="shrink-0 text-[12px] text-[#999]">
              {durationCapability.kind === 'range' ? `${durationCapability.maximum}秒` : `${durationCapability.values[durationCapability.values.length - 1]}秒`}
            </span>
            <output className="vp-media-duration-value min-w-14 rounded-full bg-white px-3 py-2 text-center text-[13px] font-semibold text-[#222] shadow-sm">
              {safeDuration}秒
            </output>
          </div>
        )}
        {!durationIsValid && (
          <p className="mt-1.5 text-[11px] text-red-600" role="alert">当前时长不符合此模型的能力范围。</p>
        )}
      </section>
    )
  }

  return (
    <div className="vp-media-specification relative shrink-0">
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={`vp-media-specification-trigger flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-semibold transition-colors disabled:cursor-default disabled:opacity-50 ${dark ? 'text-white/90 hover:bg-white/10' : 'text-[#444] hover:bg-black/[0.05]'}`}
        title="画幅、分辨率与时长"
      >
        <span className="truncate">{summary || '规格'}</span>
        <span className="shrink-0 text-[10px] text-current/50">⌄</span>
      </button>
      {presence.present && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={mediaType === 'image' ? '图片生成规格' : '视频生成规格'}
          className={`vp-soft-popover vp-editor-popover vp-media-specification-popover fixed z-[10050] max-h-[calc(100vh-24px)] w-[min(560px,calc(100vw-24px))] overflow-y-auto rounded-[22px] border border-black/[0.06] bg-white p-5 text-[#222] shadow-[0_18px_54px_rgba(15,23,42,0.20)] ${presence.visible ? '' : 'pointer-events-none'}`}
          style={{ left: position.left, ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }) }}
          data-open={presence.visible}
          aria-hidden={!open}
          inert={!open}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {hasAspectOptions && (
            <section aria-label="比例">
              <p className="mb-2.5 text-[13px] text-[#777]">比例</p>
              <div className="vp-media-aspect-grid grid grid-cols-4 gap-1 rounded-[22px] bg-[#f1f1f2] p-1.5">
                {aspectOptions.map((value) => {
                  const shape = ratioShape(value)
                  const selected = aspect === value
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onAspectChange(value)}
                      className={`vp-media-aspect-option flex min-h-[68px] flex-col items-center justify-center gap-1 rounded-[17px] px-2 py-2 text-[12px] transition-colors ${selected ? 'bg-white text-[#111] shadow-sm' : 'text-[#777] hover:bg-white/65'}`}
                    >
                      <span className="vp-media-aspect-shape flex h-5 w-6 items-center justify-center">
                        <span className="block rounded-[3px] border-[2px] border-current" style={{ width: shape.width, height: shape.height }} />
                      </span>
                      <span>{value}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}
          {hasResolutionOptions && (
            <section className={hasAspectOptions ? 'mt-5' : ''} aria-label="分辨率">
              <p className="mb-2.5 text-[13px] text-[#777]">分辨率</p>
              <div className="vp-media-resolution-segments grid min-h-[50px] rounded-full bg-[#f1f1f2] p-1" style={{ gridTemplateColumns: `repeat(${resolutionOptions.length}, minmax(0, 1fr))` }}>
                {resolutionOptions.map(({ key, value }) => {
                  const selected = resolution === key
                  return (
                    <button
                      key={`${key}:${value}`}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onResolutionChange(key)}
                      className={`vp-media-resolution-option rounded-full px-3 py-2 text-[13px] transition-colors ${selected ? 'bg-white text-[#111] shadow-sm' : 'text-[#777] hover:text-[#333]'}`}
                      title={value !== key ? value : undefined}
                    >
                      {key}
                    </button>
                  )
                })}
              </div>
            </section>
          )}
          {renderDurationControl()}
          {!hasAspectOptions && !hasResolutionOptions && !durationCapability && (
            <p className="text-[13px] text-[#777]">此模型目录没有声明可编辑的画面规格。</p>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
