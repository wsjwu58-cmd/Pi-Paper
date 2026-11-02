import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { fetchAuthedBlob } from '@/lib/media'
import { t as uiText, useUiLanguage } from '@/lib/i18n'
import type { PosterLayout } from './creativePluginTypes'
import { readPosterLayout } from './creativePluginRuntime'

/** Paint only to a local canvas; the imported pack supplies data, never code. */
export function paintPoster(context: CanvasRenderingContext2D, image: CanvasImageSource, sourceWidth: number, sourceHeight: number, layout: PosterLayout) {
  const { width, height } = layout
  context.clearRect(0, 0, width, height)
  context.fillStyle = layout.background
  context.fillRect(0, 0, width, height)
  const box = layout.image
  const scale = box.fit === 'cover' ? Math.max(box.width / sourceWidth, box.height / sourceHeight) : Math.min(box.width / sourceWidth, box.height / sourceHeight)
  const renderedWidth = sourceWidth * scale, renderedHeight = sourceHeight * scale
  context.save()
  context.beginPath()
  context.rect(box.x, box.y, box.width, box.height)
  context.clip()
  context.drawImage(image, box.x + (box.width - renderedWidth) / 2, box.y + (box.height - renderedHeight) / 2, renderedWidth, renderedHeight)
  context.restore()
  context.fillStyle = layout.title.color
  context.font = `bold ${layout.title.size}px sans-serif`
  context.textBaseline = 'alphabetic'
  // Restrict the line to the remaining poster width rather than hiding text.
  context.fillText(layout.title.text, layout.title.x, layout.title.y, Math.max(1, width - layout.title.x))
}

export function PosterEditor({ initial, sourceUrl, onClose, onExport }: {
  initial: PosterLayout
  sourceUrl: string
  onClose: () => void
  onExport: (layout: PosterLayout, blob: Blob) => Promise<void>
}) {
  useUiLanguage()
  const [layout, setLayout] = useState<PosterLayout>(() => readPosterLayout(initial))
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let active = true
    let url: string | undefined
    if (!sourceUrl.startsWith('vibe://')) { setError(uiText('海报需要当前项目中的本地图片。')); return }
    void fetchAuthedBlob(sourceUrl).then((blob) => {
      if (!active) return
      url = URL.createObjectURL(blob)
      const loaded = new Image()
      loaded.onload = () => { if (active) setImage(loaded) }
      loaded.onerror = () => { if (active) setError(uiText('无法读取所选图片。')) }
      loaded.src = url
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : uiText('无法读取所选图片。')) })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [sourceUrl])
  let valid = true
  try { readPosterLayout(layout) } catch { valid = false }
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || !valid) return
    const context = canvas.getContext('2d')
    if (context) paintPoster(context, image, image.naturalWidth, image.naturalHeight, layout)
  }, [image, layout, valid])
  const numberInput = (label: string, value: number, onChange: (value: number) => void) => <label className="flex items-center justify-between gap-2 text-xs text-[#555]">{uiText(label)}<input aria-label={uiText(label)} type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} className="w-24 rounded-lg border border-black/10 px-2 py-1" /></label>
  const save = async () => {
    if (!canvasRef.current || !valid || !image || busy) return
    setBusy(true); setError('')
    try {
      const blob = await new Promise<Blob>((resolve, reject) => canvasRef.current!.toBlob((value) => value ? resolve(value) : reject(new Error(uiText('海报 PNG 编码失败。'))), 'image/png'))
      await onExport(readPosterLayout(layout), blob)
    } catch (cause) { setError(cause instanceof Error ? cause.message : uiText('海报保存失败。')) }
    finally { setBusy(false) }
  }
  return createPortal(<div role="dialog" aria-modal="true" aria-label={uiText('海报排版')} className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4">
    <div className="flex max-h-[94vh] w-full max-w-5xl flex-col rounded-2xl bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-black/10 px-5 py-3"><h2 className="font-bold">{uiText('海报排版')}</h2><button type="button" disabled={busy} onClick={onClose}>{uiText('关闭')}</button></header>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[1fr_270px]">
        <div className="flex min-h-[300px] items-center justify-center bg-[#e9ebef] p-5"><canvas ref={canvasRef} width={valid ? layout.width : 1} height={valid ? layout.height : 1} className="max-h-[65vh] max-w-full bg-white object-contain shadow" /></div>
        <div className="space-y-2 overflow-auto p-4">
          <p className="text-xs font-bold">{uiText('画布尺寸与背景')}</p>
          {numberInput('宽度', layout.width, (width) => setLayout({ ...layout, width }))}
          {numberInput('高度', layout.height, (height) => setLayout({ ...layout, height }))}
          <label className="flex justify-between text-xs">{uiText('背景颜色')}<input type="color" value={layout.background} onChange={(e) => setLayout({ ...layout, background: e.target.value })} /></label>
          <p className="pt-2 text-xs font-bold">{uiText('图片位置与大小')}</p>
          {(['x', 'y', 'width', 'height'] as const).map((key) => <div key={key}>{numberInput(({ x: '图片 X', y: '图片 Y', width: '图片宽度', height: '图片高度' })[key], layout.image[key], (value) => setLayout({ ...layout, image: { ...layout.image, [key]: value } }))}</div>)}
          <label className="flex justify-between text-xs">{uiText('图片适配')}<select value={layout.image.fit} onChange={(e) => setLayout({ ...layout, image: { ...layout.image, fit: e.target.value as 'contain' | 'cover' } })}><option value="contain">{uiText('完整显示')}</option><option value="cover">{uiText('铺满裁切')}</option></select></label>
          <p className="pt-2 text-xs font-bold">{uiText('标题')}</p>
          <input aria-label={uiText('标题文字')} value={layout.title.text} maxLength={200} onChange={(e) => setLayout({ ...layout, title: { ...layout.title, text: e.target.value } })} className="w-full rounded-lg border border-black/10 px-2 py-1 text-xs" />
          {(['x', 'y', 'size'] as const).map((key) => <div key={key}>{numberInput(({ x: '标题 X', y: '标题 Y', size: '字号' })[key], layout.title[key], (value) => setLayout({ ...layout, title: { ...layout.title, [key]: value } }))}</div>)}
          <label className="flex justify-between text-xs">{uiText('标题颜色')}<input type="color" value={layout.title.color} onChange={(e) => setLayout({ ...layout, title: { ...layout.title, color: e.target.value } })} /></label>
          {!valid && <p role="alert" className="text-xs text-red-700">{uiText('参数超出画布范围，请检查尺寸、位置和标题。')}</p>}
          {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
          <button type="button" disabled={busy || !valid || !image} onClick={() => void save()} className="w-full rounded-lg bg-[#222] px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? uiText('保存中…') : uiText('生成 PNG 并添加到画布')}</button>
          <p className="text-[11px] text-[#888]">{uiText('排版保存在源图片节点；从源图片的「编辑海报」可继续修改。不会调用模型。')}</p>
        </div>
      </div>
    </div>
  </div>, document.body)
}
