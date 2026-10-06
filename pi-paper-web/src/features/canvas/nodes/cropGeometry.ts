export type CropMode = 'single' | 'four' | 'nine'

export type CropRect = {
  x: number
  y: number
  width: number
  height: number
}

export type PixelCropRect = {
  x: number
  y: number
  width: number
  height: number
  column: number
  row: number
}

export type CropHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

export function cropGridSize(mode: CropMode): number {
  return mode === 'four' ? 2 : mode === 'nine' ? 3 : 1
}

export function clampCropRect(rect: CropRect): CropRect {
  const width = clamp(Number.isFinite(rect.width) ? rect.width : 0, 0, 1)
  const height = clamp(Number.isFinite(rect.height) ? rect.height : 0, 0, 1)
  const x = clamp(Number.isFinite(rect.x) ? rect.x : 0, 0, 1 - width)
  const y = clamp(Number.isFinite(rect.y) ? rect.y : 0, 0, 1 - height)
  return { x, y, width, height }
}

export function applyCropPointerDelta(
  initialRect: CropRect,
  handle: CropHandle,
  deltaX: number,
  deltaY: number,
  minimumWidth: number,
  minimumHeight: number,
): CropRect {
  const rect = clampCropRect(initialRect)
  if (handle === 'move') {
    return clampCropRect({
      ...rect,
      x: rect.x + deltaX,
      y: rect.y + deltaY,
    })
  }

  const minWidth = clamp(minimumWidth, 0, 1)
  const minHeight = clamp(minimumHeight, 0, 1)
  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.width
  let bottom = rect.y + rect.height

  if (handle.includes('w')) left = clamp(left + deltaX, 0, right - minWidth)
  if (handle.includes('e')) right = clamp(right + deltaX, left + minWidth, 1)
  if (handle.includes('n')) top = clamp(top + deltaY, 0, bottom - minHeight)
  if (handle.includes('s')) bottom = clamp(bottom + deltaY, top + minHeight, 1)

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Convert a normalized selection into integer source pixels and divide it without gaps. */
export function splitCropIntoPixels(
  imageWidth: number,
  imageHeight: number,
  selection: CropRect,
  mode: CropMode,
): PixelCropRect[] {
  if (!Number.isInteger(imageWidth) || imageWidth < 1 || !Number.isInteger(imageHeight) || imageHeight < 1) {
    throw new Error('图片尺寸无效。')
  }
  const rect = clampCropRect(selection)
  const left = clamp(Math.floor(rect.x * imageWidth), 0, imageWidth - 1)
  const top = clamp(Math.floor(rect.y * imageHeight), 0, imageHeight - 1)
  const right = clamp(Math.ceil((rect.x + rect.width) * imageWidth), left + 1, imageWidth)
  const bottom = clamp(Math.ceil((rect.y + rect.height) * imageHeight), top + 1, imageHeight)
  const columns = cropGridSize(mode)
  const rows = columns
  const cropWidth = right - left
  const cropHeight = bottom - top
  if (cropWidth < columns || cropHeight < rows) {
    throw new Error(`裁剪区域太小，无法切成${columns * rows}张图片。`)
  }

  const crops: PixelCropRect[] = []
  for (let row = 0; row < rows; row++) {
    const y0 = top + Math.floor((cropHeight * row) / rows)
    const y1 = top + Math.floor((cropHeight * (row + 1)) / rows)
    for (let column = 0; column < columns; column++) {
      const x0 = left + Math.floor((cropWidth * column) / columns)
      const x1 = left + Math.floor((cropWidth * (column + 1)) / columns)
      crops.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, column, row })
    }
  }
  return crops
}

export interface CropCanvas {
  width: number
  height: number
  getContext(type: '2d'): Pick<CanvasRenderingContext2D, 'drawImage'> | null
  toBlob(callback: (blob: Blob | null) => void, type?: string): void
}

export interface CropArtifact {
  blob: Blob
  rect: PixelCropRect
}

/** Render each source-pixel crop at native resolution as a PNG artifact. */
export async function renderCropArtifacts(
  source: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
  selection: CropRect,
  mode: CropMode,
  createCanvas: () => CropCanvas = () => document.createElement('canvas'),
): Promise<CropArtifact[]> {
  const rects = splitCropIntoPixels(imageWidth, imageHeight, selection, mode)
  const artifacts: CropArtifact[] = []
  for (const rect of rects) {
    const canvas = createCanvas()
    canvas.width = rect.width
    canvas.height = rect.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建图片裁剪画布。')
    context.drawImage(
      source,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    )
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result)
        else reject(new Error('图片裁剪结果无法编码为 PNG。'))
      }, 'image/png')
    })
    artifacts.push({ blob, rect })
  }
  return artifacts
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
