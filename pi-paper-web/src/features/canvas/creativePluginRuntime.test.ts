import { vi } from 'vitest'
vi.mock('@/lib/media', () => ({ fetchAuthedBlob: vi.fn() }))
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { arrangeCreativeSelection, cameraAt, readCreativeMotion, readCreativeScene, readMediaTool, readPosterLayout, readSelectionCommand, readStoryboard, resolveUnchangedCreativeSelection } from './creativePluginRuntime'
import { paintPoster } from './PosterEditor'
import { storyboardCsv, storyboardRows } from './StoryboardEditor'
import { splitCropIntoPixels } from './nodes/cropGeometry'
import type { FlowNode } from './canvasStore'

const require = createRequire(import.meta.url)
const example = require('../../../../pi-paper-desktop/src/marketplace-creative-example.cjs') as { components: Array<{ id: string; type: string; data: unknown }> }
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
  it('arranges the selection in the requested direction using actual node sizes and the component gap', () => {
    const make = (id: string, x: number, y: number, width: number, height: number): FlowNode => ({
      id, type: 'image', position: { x, y }, measured: { width, height }, data: {
        node: { id, type: 'image', x, y, params: {}, status: 'idle' }, selected: false, onConfig: () => {}, models: [],
      },
    })
    const a = make('a', 10, 20, 100, 40), b = make('b', 400, 5, 150, 70), c = make('c', 200, 10, 120, 60)
    const outside = make('outside', 900, 900, 100, 100)
    const nodes = [a, b, c, outside]
    const horizontal = arrangeCreativeSelection(nodes, [a, b, c], readSelectionCommand({ command: 'arrange', orientation: 'horizontal', gap: 37 }))
    expect(horizontal.map((node) => node.position)).toEqual([{ x: 10, y: 5 }, { x: 304, y: 5 }, { x: 147, y: 5 }, { x: 900, y: 900 }])
    expect(horizontal[3]).toBe(outside)
    const verticalData = example.components.find((item) => item.id === 'vertical-storyboard')!.data
    const vertical = arrangeCreativeSelection(nodes, [a, b, c], readSelectionCommand(verticalData))
    expect(vertical.map((node) => node.position)).toEqual([{ x: 10, y: 191 }, { x: 10, y: 5 }, { x: 10, y: 103 }, { x: 900, y: 900 }])
    expect(vertical[3]).toBe(outside)
  })
  it('uses the bundled media tool mode to split the selected crop', () => {
    const tool = readMediaTool(data('media_tool'))
    expect(tool.mode).toBe('four')
    expect(splitCropIntoPixels(100, 80, { x: 0, y: 0, width: 1, height: 1 }, tool.mode)).toEqual([
      { x: 0, y: 0, width: 50, height: 40, column: 0, row: 0 },
      { x: 50, y: 0, width: 50, height: 40, column: 1, row: 0 },
      { x: 0, y: 40, width: 50, height: 40, column: 0, row: 1 },
      { x: 50, y: 40, width: 50, height: 40, column: 1, row: 1 },
    ])
  })
  it('accepts view remeasurement during confirmation but rejects changes to selected nodes', () => {
    const make = (id: string, x: number, height: number): FlowNode => ({
      id, type: 'image', position: { x, y: 20 }, measured: { width: 100, height }, data: {
        node: { id, type: 'image', x, y: 20, params: { title: id, settings: { prompt: 'unchanged' } }, status: 'idle' },
        selected: true, onConfig: () => {}, models: [],
      },
    })
    const before = [make('a', 10, 40), make('b', 200, 50)]
    const remeasured = before.map((node) => ({ ...node, measured: { width: 130, height: 90 },
      data: { ...node.data, selected: false, node: { ...node.data.node, params: { ...node.data.node.params, settings: { prompt: 'unchanged' } } } } }))
    const selection = resolveUnchangedCreativeSelection(before, remeasured, ['b', 'a'])
    expect(selection).toEqual(remeasured)
    expect(selection?.[0]).toBe(remeasured[0])
    expect(arrangeCreativeSelection(remeasured, selection!, readSelectionCommand({ command: 'arrange', orientation: 'vertical', gap: 17 })).map((node) => node.position))
      .toEqual([{ x: 10, y: 20 }, { x: 10, y: 127 }])
    expect(resolveUnchangedCreativeSelection(before, remeasured, ['a'])).toBeNull()
    expect(resolveUnchangedCreativeSelection(before, remeasured, ['a', 'a'])).toBeNull()
    expect(resolveUnchangedCreativeSelection(before, remeasured, ['a', 'b', 'other'])).toBeNull()
    expect(resolveUnchangedCreativeSelection(before, remeasured.slice(0, 1), ['a', 'b'])).toBeNull()
    expect(resolveUnchangedCreativeSelection(before, [{ ...remeasured[0], position: { x: 11, y: 20 } }, remeasured[1]], ['a', 'b'])).toBeNull()
    expect(resolveUnchangedCreativeSelection(before, [{ ...remeasured[0], data: { ...remeasured[0].data,
      node: { ...remeasured[0].data.node, params: { title: 'a', settings: { prompt: 'edited' } } } } }, remeasured[1]], ['a', 'b'])).toBeNull()
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
