import { describe, expect, it, vi } from 'vitest'
import {
  applyCropPointerDelta,
  renderCropArtifacts,
  splitCropIntoPixels,
  type CropCanvas,
  type CropRect,
} from './cropGeometry'

describe('crop geometry', () => {
  it('moves and resizes the frame while keeping it inside the image', () => {
    const initial: CropRect = { x: 0.2, y: 0.25, width: 0.5, height: 0.4 }
    expect(applyCropPointerDelta(initial, 'move', 0.7, -0.5, 0.1, 0.1)).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 0.4,
    })
    const resized = applyCropPointerDelta(initial, 'nw', 0.49, 0.39, 0.2, 0.2)
    expect(resized.x).toBeCloseTo(0.5)
    expect(resized.y).toBeCloseTo(0.45)
    expect(resized.width).toBeCloseTo(0.2)
    expect(resized.height).toBeCloseTo(0.2)
  })

  it('splits an odd-sized crop into four pixel-exact, gap-free tiles', () => {
    const crops = splitCropIntoPixels(101, 77, { x: 0.1, y: 0.1, width: 0.81, height: 0.81 }, 'four')
    expect(crops).toEqual([
      { x: 10, y: 7, width: 41, height: 32, column: 0, row: 0 },
      { x: 51, y: 7, width: 41, height: 32, column: 1, row: 0 },
      { x: 10, y: 39, width: 41, height: 32, column: 0, row: 1 },
      { x: 51, y: 39, width: 41, height: 32, column: 1, row: 1 },
    ])
    expect(crops.reduce((sum, crop) => sum + crop.width * crop.height, 0)).toBe(82 * 64)
  })

  it('renders native-resolution PNG blobs with the exact source rectangles', async () => {
    const source = {} as CanvasImageSource
    const calls: number[][] = []
    const canvases: Array<{ width: number; height: number }> = []
    const createCanvas = vi.fn(() => {
      const canvas = { width: 0, height: 0 }
      canvases.push(canvas)
      const fake: CropCanvas = {
        get width() { return canvas.width },
        set width(value: number) { canvas.width = value },
        get height() { return canvas.height },
        set height(value: number) { canvas.height = value },
        getContext: () => ({ drawImage: ((_image: CanvasImageSource, ...args: number[]) => { calls.push(args) }) as CanvasRenderingContext2D['drawImage'] }),
        toBlob: (callback, type) => callback(new Blob(['png'], { type })),
      }
      return fake
    })

    const selection: CropRect = { x: 0, y: 0, width: 1, height: 1 }
    const artifacts = await renderCropArtifacts(source, 10, 8, selection, 'nine', createCanvas)

    expect(artifacts).toHaveLength(9)
    expect(artifacts.every(({ blob }) => blob.type === 'image/png' && blob.size > 0)).toBe(true)
    expect(canvases.map(({ width, height }) => [width, height])).toEqual([
      [3, 2], [3, 2], [4, 2],
      [3, 3], [3, 3], [4, 3],
      [3, 3], [3, 3], [4, 3],
    ])
    expect(calls).toEqual([
      [0, 0, 3, 2, 0, 0, 3, 2], [3, 0, 3, 2, 0, 0, 3, 2], [6, 0, 4, 2, 0, 0, 4, 2],
      [0, 2, 3, 3, 0, 0, 3, 3], [3, 2, 3, 3, 0, 0, 3, 3], [6, 2, 4, 3, 0, 0, 4, 3],
      [0, 5, 3, 3, 0, 0, 3, 3], [3, 5, 3, 3, 0, 0, 3, 3], [6, 5, 4, 3, 0, 0, 4, 3],
    ])
  })
})
