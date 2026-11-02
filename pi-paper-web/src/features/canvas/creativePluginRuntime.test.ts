import { vi } from 'vitest'
vi.mock('@/lib/media', () => ({ fetchAuthedBlob: vi.fn() }))
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { cameraAt, readCreativeMotion, readCreativeScene, readMediaTool, readPosterLayout, readSelectionCommand, readStoryboard } from './creativePluginRuntime'
import { paintPoster } from './PosterEditor'
import { storyboardCsv, storyboardRows } from './StoryboardEditor'
import type { FlowNode } from './canvasStore'

const require = createRequire(import.meta.url)
const example = require('../../../../pi-paper-desktop/src/marketplace-creative-example.cjs') as { components: Array<{ type: string; data: unknown }> }
const validators: Record<string, (data: unknown) => unknown> = {
  director_scene: readCreativeScene, director_camera: (value) => value, director_motion: readCreativeMotion,
  poster_layout: readPosterLayout, selection_command: readSelectionCommand, storyboard: readStoryboard, media_tool: readMediaTool,
}
const data = (type: string) => example.components.find((item) => item.type === type)!.data

describe('declarative creative components', () => {
  it('reads every bundled creative component and rejects unsafe or incompatible input', () => {
    for (const component of example.components) expect(() => validators[component.type](component.data)).not.toThrow()
    expect(() => readCreativeScene({ ...data('director_scene') as object, script: 'run()' })).toThrow()
    expect(() => readCreativeScene({ objects: [{ category: 'prop', kind: '站立' }], camera: { yaw: 0, pitch: 20, distance: 8 } })).toThrow()
    expect(() => readPosterLayout({ ...data('poster_layout') as object, title: { text: 'file:///secret', x: 0, y: 20, size: 20, color: '#000000' } })).toThrow()
    expect(() => readSelectionCommand({ command: 'shell', orientation: 'horizontal', gap: 5 })).toThrow()
    expect(() => readMediaTool({ tool: 'crop', mode: 'script' })).toThrow()
    expect(() => readStoryboard({ fields: ['title', 'title'] })).toThrow()
  })
  it('plays the short orbit across the 180-degree seam and finishes on the exact target', () => {
    const motion = readCreativeMotion({ from: { yaw: 170, pitch: 20, distance: 10 }, to: { yaw: -170, pitch: 40, distance: 6 }, duration: 4 })
    expect(cameraAt(motion, 0.5)).toEqual({ yaw: -180, pitch: 30, distance: 8 })
    expect(cameraAt(motion, 1)).toEqual(motion.to)
  })
  it('paints the local source in the editable frame and clips cover mode before rendering text', () => {
    const layout = readPosterLayout(data('poster_layout'))
    const calls: string[] = []
    const context = { clearRect: vi.fn(() => calls.push('clear')), fillRect: vi.fn(() => calls.push('background')),
      save: vi.fn(() => calls.push('save')), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(() => calls.push('clip')),
      drawImage: vi.fn(() => calls.push('image')), restore: vi.fn(() => calls.push('restore')), fillText: vi.fn(() => calls.push('title')) } as unknown as CanvasRenderingContext2D
    paintPoster(context, {} as CanvasImageSource, 920, 960, layout)
    expect(calls).toEqual(['clear', 'background', 'save', 'clip', 'image', 'restore', 'title'])
    expect(context.drawImage).toHaveBeenCalledWith(expect.anything(), 80, 80, 920, 960)
    expect(context.fillText).toHaveBeenCalledWith('商品名称', 100, 1190, 980)
  })
  it('exports ordered rows with escaped values and blocks spreadsheet formula injection', () => {
    const make = (id: string, x: number, content: string): FlowNode => ({ id, type: 'text', position: { x, y: 0 }, data: {
      node: { id, type: 'text', x, y: 0, params: { title: id, content }, status: 'idle' }, selected: false, onConfig: () => {}, models: [],
    } })
    const rows = storyboardRows([make('second', 20, 'ordinary'), make('first', 10, '=1+1,"x"')])
    expect(rows.map((row) => row.values.title)).toEqual(['first', 'second'])
    expect(storyboardCsv(rows.reverse(), ['title', 'content'])).toBe('\ufeff"序号","标题","内容"\r\n"1","second","ordinary"\r\n"2","first","\'=1+1,""x"""\r\n')
  })

})

describe('poster save merge', () => {
  it('keeps concurrent edits and never connects a render to a replaced source image', async () => {
    const { mergePosterResult } = await import('./posterGraph')
    const make = (id: string, url: string): FlowNode => ({ id, type: 'image', position: { x: 0, y: 0 }, data: {
      node: { id, type: 'image', x: 0, y: 0, params: { url }, status: 'idle' }, selected: false, onConfig: () => {}, models: [],
    } })
    const source = make('source', 'old'), output = make('poster', 'poster')
    const layout = readPosterLayout(data('poster_layout'))
    const edge = { id: 'edge', source: 'source', target: 'poster' }
    const mediaUrl = (node: FlowNode['data']['node']) => String(node.params.url)
    const changed = make('source', 'new')
    const merged = mergePosterResult({ nodes: [changed], edges: [], source, sourceUrl: 'old', output, edge, layout, mediaUrl })
    expect(merged.sourceRetained).toBe(false)
    expect(merged.nodes[0].data.node.params.url).toBe('new')
    expect(merged.nodes[0].data.node.params.posterLayout).toBeUndefined()
    expect(merged.nodes).toHaveLength(2)
    expect(merged.edges).toEqual([])
    const unchanged = mergePosterResult({ nodes: [source], edges: [], source, sourceUrl: 'old', output, edge, layout, mediaUrl })
    expect(unchanged.sourceRetained).toBe(true)
    expect(unchanged.nodes[0].data.node.params.posterLayout).toEqual(layout)
    expect(unchanged.edges).toEqual([edge])
  })
})
