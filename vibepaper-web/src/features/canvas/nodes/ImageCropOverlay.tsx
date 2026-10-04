import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { fetchAuthedBlob } from '@/lib/media'
import {
  applyCropPointerDelta,
  cropGridSize,
  renderCropArtifacts,
  splitCropIntoPixels,
  type CropHandle,
  type CropMode,
  type CropRect,
} from './cropGeometry'

const DEFAULT_CROP: CropRect = { x: 0.04, y: 0.04, width: 0.92, height: 0.92 }

const MODE_LABELS: Record<CropMode, string> = {
  single: '单图裁剪',
  four: '四宫格裁剪',
  nine: '九宫格裁剪',
}

const RESIZE_HANDLES: Array<{ id: Exclude<CropHandle, 'move'>; className: string; label: string }> = [
  { id: 'nw', className: '-left-1.5 -top-1.5 cursor-nwse-resize', label: '左上' },
  { id: 'n', className: 'left-1/2 -top-1.5 -translate-x-1/2 cursor-ns-resize', label: '上边' },
  { id: 'ne', className: '-right-1.5 -top-1.5 cursor-nesw-resize', label: '右上' },
  { id: 'e', className: '-right-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize', label: '右边' },
  { id: 'se', className: '-bottom-1.5 -right-1.5 cursor-nwse-resize', label: '右下' },
  { id: 's', className: '-bottom-1.5 left-1/2 -translate-x-1/2 cursor-ns-resize', label: '下边' },
  { id: 'sw', className: '-bottom-1.5 -left-1.5 cursor-nesw-resize', label: '左下' },
  { id: 'w', className: '-left-1.5 top-1/2 -translate-y-1/2 cursor-ew-resize', label: '左边' },
]

export function ImageCropOverlay({
  mediaUrl,
  currentMediaUrl,
  mode,
  onModeChange,
  onClose,
  onConfirm,
}: {
  mediaUrl: string
  currentMediaUrl: string
  mode: CropMode
  onModeChange: (mode: CropMode) => void
  onClose: () => void
  onConfirm: (artifacts: Awaited<ReturnType<typeof renderCropArtifacts>>) => Promise<void>
}) {
  const imageRef = useRef<HTMLImageElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const interaction = useRef<{
    pointerId: number
    handle: CropHandle
    startX: number
    startY: number
    initialRect: CropRect
  } | null>(null)
  const [sourceObjectUrl, setSourceObjectUrl] = useState<string | undefined>(undefined)
  const sourceObjectUrlRef = useRef<string | undefined>(undefined)
  const [loadError, setLoadError] = useState('')
  const [imageSize, setImageSize] = useState<{ width: number; height: number }>()
  const [selection, setSelection] = useState<CropRect>(DEFAULT_CROP)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoadError('')
    setImageSize(undefined)
    setSourceObjectUrl(undefined)
    void fetchAuthedBlob(mediaUrl)
      .then((blob) => {
        if (cancelled) return
        const objectUrl = URL.createObjectURL(blob)
        sourceObjectUrlRef.current = objectUrl
        setSourceObjectUrl(objectUrl)
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(cause instanceof Error ? cause.message : '读取源图片失败。')
      })
    return () => {
      cancelled = true
      if (sourceObjectUrlRef.current) URL.revokeObjectURL(sourceObjectUrlRef.current)
      sourceObjectUrlRef.current = undefined
    }
  }, [mediaUrl])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  const columns = cropGridSize(mode)
  const sourceChanged = currentMediaUrl !== mediaUrl
  const minimumWidth = imageSize ? Math.min(1, columns * Math.max(16 / imageSize.width, 0.04)) : 0.08
  const minimumHeight = imageSize ? Math.min(1, columns * Math.max(16 / imageSize.height, 0.04)) : 0.08
  const validSize = useMemo(() => {
    if (!imageSize) return false
    try {
      splitCropIntoPixels(imageSize.width, imageSize.height, selection, mode)
      return true
    } catch {
      return false
    }
  }, [imageSize, mode, selection])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (busy) return
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-crop-handle]') : null
    const handle = target?.dataset.cropHandle as CropHandle | undefined
    if (!handle) return
    event.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    stage.setPointerCapture(event.pointerId)
    interaction.current = {
      pointerId: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      initialRect: selection,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = interaction.current
    const stage = stageRef.current
    if (!active || !stage || active.pointerId !== event.pointerId) return
    const bounds = stage.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    const deltaX = (event.clientX - active.startX) / bounds.width
    const deltaY = (event.clientY - active.startY) / bounds.height
    setSelection(applyCropPointerDelta(active.initialRect, active.handle, deltaX, deltaY, minimumWidth, minimumHeight))
  }

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (interaction.current?.pointerId !== event.pointerId) return
    interaction.current = null
    if (stageRef.current?.hasPointerCapture(event.pointerId)) stageRef.current.releasePointerCapture(event.pointerId)
  }

  const confirm = async () => {
    if (busy || !validSize || sourceChanged) return
    const image = imageRef.current
    if (!image || image.naturalWidth < 1 || image.naturalHeight < 1) {
      setError('源图片尚未加载完成。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const artifacts = await renderCropArtifacts(
        image,
        image.naturalWidth,
        image.naturalHeight,
        selection,
        mode,
      )
      await onConfirm(artifacts)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建裁剪图片失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="nodrag nopan nowheel relative w-full select-none" onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      {loadError ? (
        <div className="rounded-lg bg-white px-3 py-2 text-[11px] font-semibold text-red-700">{loadError}</div>
      ) : sourceObjectUrl ? (
        <div
          ref={stageRef}
          className="relative inline-block w-full overflow-hidden rounded-[16px] touch-none leading-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={finishPointer}
        >
          <img
            ref={imageRef}
            src={sourceObjectUrl}
            alt="待裁剪图片"
            draggable={false}
            onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
            onError={() => setLoadError('无法解码这张图片。')}
            className="block h-auto w-full object-contain"
          />
          {imageSize && (
            <div
              data-crop-handle="move"
              className="absolute touch-none border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.48)]"
              style={{
                left: `${selection.x * 100}%`,
                top: `${selection.y * 100}%`,
                width: `${selection.width * 100}%`,
                height: `${selection.height * 100}%`,
              }}
              role="presentation"
            >
              {Array.from({ length: columns - 1 }, (_, index) => (
                <span key={`v-${index}`} className="pointer-events-none absolute bottom-0 top-0 border-l border-dashed border-white/80"
                  style={{ left: `${((index + 1) / columns) * 100}%` }} />
              ))}
              {Array.from({ length: columns - 1 }, (_, index) => (
                <span key={`h-${index}`} className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-white/80"
                  style={{ top: `${((index + 1) / columns) * 100}%` }} />
              ))}
              {RESIZE_HANDLES.map((handle) => (
                <span
                  key={handle.id}
                  data-crop-handle={handle.id}
                  aria-label={`调整裁剪框${handle.label}`}
                  className={`absolute z-10 h-3 w-3 rounded-full border-2 border-[#252529] bg-white shadow ${handle.className}`}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-28 items-center justify-center gap-2 rounded-lg bg-[#17171a] text-[11px] font-semibold text-white/70"><Loader2 size={14} className="animate-spin" />正在读取本地图片…</div>
      )}
      {sourceObjectUrl && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center rounded-full bg-white p-1 shadow-sm ring-1 ring-black/10">
            {([
              ['single', '单图'],
              ['four', '四宫格'],
              ['nine', '九宫格'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => onModeChange(value)}
                disabled={busy}
                className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${mode === value ? 'bg-[#222] text-white' : 'text-[#666] hover:bg-black/5'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-[10px] font-semibold text-[#888] sm:inline">
              {sourceChanged ? '源图片已变化' : imageSize ? `${imageSize.width} × ${imageSize.height}` : MODE_LABELS[mode]}
            </span>
            <button
              type="button"
              onClick={() => setSelection(DEFAULT_CROP)}
              disabled={busy || !imageSize}
              className="rounded-full px-2 py-1 text-[10px] font-semibold text-[#777] hover:bg-black/5 disabled:opacity-40"
            >
              重置
            </button>
            <button type="button" onClick={onClose} disabled={busy}
              className="rounded-full px-2 py-1 text-[10px] font-semibold text-[#777] hover:bg-black/5 disabled:opacity-40">取消</button>
            <button
              type="button"
              aria-label={busy ? '正在保存裁剪结果' : '确认裁剪'}
              title={sourceChanged ? '源图片已变化，请取消后重新打开' : !validSize ? `裁剪区域太小，无法切成${columns * columns}张图片` : '确认裁剪'}
              onClick={() => void confirm()}
              disabled={busy || !validSize || sourceChanged}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#29292d] text-white shadow-sm transition-colors hover:bg-black disabled:cursor-not-allowed disabled:bg-[#c5c5c9]"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={16} strokeWidth={2.5} />}
            </button>
          </div>
        </div>
      )}
      {sourceChanged && sourceObjectUrl && <p className="mt-1 text-[10px] font-semibold text-amber-700">源图片已变化，请取消并重新打开裁剪。</p>}
      {error && <div role="alert" className="mt-1 rounded-lg bg-red-50 px-2 py-1.5 text-[10px] font-semibold text-red-700">{error}</div>}
    </div>
  )
}
