import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import type { Edge } from '@xyflow/react'
import type { DesktopProviderConfiguration } from '@/desktop/desktop-bridge'
import type { FlowNode } from './canvasStore'
import { buildPluginTemplateGraph, changedPluginPresetPatch, commitPluginTemplateGraph, overwrittenPluginPresetFields, pluginPresetPatch, readPluginTemplate, templateFromSelection, type PluginGraphSnapshot } from './pluginComponents'

const require = createRequire(import.meta.url)
const example = require('../../../../pi-paper-desktop/src/marketplace-example.cjs') as { components: Array<{ id: string; data: unknown }> }
const templateData = example.components.find((item) => item.id === 'product-workflow')!.data

function node(id: string, type = 'image', params: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 10, y: 20 }, data: { node: { id, type, params, status: 'idle' }, selected: false, onConfig: () => {}, models: [] } }
}
function snapshot(): PluginGraphSnapshot {
  return { canvas: { canvas: { id: 'canvas', ownerId: 'local', name: 'test', schemaVersion: '1', version: 3, visibility: 'private', shareToken: '' }, nodes: [], edges: [], groups: [], stacks: [] }, nodes: [node('existing')], edges: [], groups: [], stacks: [] }
}
function graph() {
  let i = 0
  return buildPluginTemplateGraph(readPluginTemplate(templateData), { x: 100, y: 200 }, () => {}, () => `new-${++i}`)
}

describe('canvas plugin components', () => {
  it('builds the bundled product template with exactly its six pairwise edges and distinct IDs for each insertion', () => {
    const template = readPluginTemplate(templateData)
    expect(template.nodes).toHaveLength(7)
    expect(template.edges).toHaveLength(6)
    let index = 0
    const first = buildPluginTemplateGraph(template, { x: 100, y: 200 }, () => {}, () => `id-${++index}`)
    const second = buildPluginTemplateGraph(template, { x: 1000, y: 200 }, () => {}, () => `id-${++index}`)
    expect(new Set([...first.nodes, ...second.nodes].map((item) => item.id)).size).toBe(14)
    const targets = template.nodes.filter((item) => item.id.startsWith('result-'))
    for (const target of targets) {
      const expectedSources = template.edges.filter((item) => item.target === target.id).map((item) => item.source)
      expect(expectedSources).toEqual(['product', target.id.replace('result-', 'brief-')])
      const actualTarget = first.nodes[template.nodes.findIndex((item) => item.id === target.id)].id
      expect(first.edges.filter((edge) => edge.target === actualTarget)).toHaveLength(2)
    }
    expect(first.edges.every((edge) => first.nodes.some((item) => item.id === edge.source) && first.nodes.some((item) => item.id === edge.target))).toBe(true)
    expect(first.nodes[1].data.node.params.content).toBeTruthy()
  })

  it('rejects duplicate or dangling links, unsupported fields, and oversized templates before writes', () => {
    const valid = readPluginTemplate(templateData)
    expect(() => readPluginTemplate({ ...valid, edges: [...valid.edges, valid.edges[0]] })).toThrow(/重复连线/)
    expect(() => readPluginTemplate({ ...valid, edges: [...valid.edges, { ...valid.edges[0], targetPort: 'other' }] })).toThrow(/重复连线/)
    expect(() => readPluginTemplate({ ...valid, edges: [{ source: 'product', target: 'outside' }] })).toThrow(/无效的连线/)
    expect(() => readPluginTemplate({ nodes: [valid.nodes[0], valid.nodes[2]], edges: [{ source: 'product', target: 'result-clean' }, { source: 'result-clean', target: 'product' }] })).toThrow(/循环/)
    expect(() => readPluginTemplate({ nodes: [{ ...valid.nodes[0], params: { apiKey: 'secret' } }], edges: [] })).toThrow(/不支持的参数/)
    expect(() => readPluginTemplate({ nodes: Array.from({ length: 21 }, (_, i) => ({ ...valid.nodes[0], id: `n-${i}` })), edges: [] })).toThrow(/数量无效/)
  })

  it('saves the entire graph once and never publishes partial additions on failure', async () => {
    const original = snapshot()
    const additions = graph()
    const apply = vi.fn()
    const save = vi.fn(async (_nodes: FlowNode[], _edges: Edge[]): Promise<{ version: number; staleNodeIds: string[] }> => { throw new Error('version conflict') })
    await expect(commitPluginTemplateGraph({ canvasId: 'canvas', snapshot: original, additions, save, getCurrent: () => original, apply })).rejects.toThrow('version conflict')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toHaveLength(8)
    expect(save.mock.calls[0][1]).toHaveLength(6)
    expect(apply).not.toHaveBeenCalled()
  })

  it('merges insertions with edits made during save and leaves those edits dirty', async () => {
    const original = snapshot()
    const additions = graph()
    const apply = vi.fn()
    let current = original
    let resolve!: (result: { version: number; staleNodeIds: string[] }) => void
    const save = vi.fn(() => new Promise<{ version: number; staleNodeIds: string[] }>((done) => { resolve = done }))
    const pending = commitPluginTemplateGraph({ canvasId: 'canvas', snapshot: original, additions, save, getCurrent: () => current, apply })
    current = { ...original, nodes: [node('existing', 'image', { prompt: 'edited while saving' }), node('concurrent')] }
    resolve({ version: 4, staleNodeIds: [] })
    await pending
    expect(apply).toHaveBeenCalledOnce()
    const merged = apply.mock.calls[0][0]
    expect(merged.nodes).toHaveLength(9)
    expect(merged.nodes[0].data.node.params.prompt).toBe('edited while saving')
    expect(merged.edges).toHaveLength(6)
    expect(merged.dirty).toBe(true)
    expect(merged.version).toBe(4)
  })

  it('does not merge into a different canvas after navigation', async () => {
    const original = snapshot()
    const other = snapshot()
    other.canvas!.canvas.id = 'other'
    const apply = vi.fn()
    const result = await commitPluginTemplateGraph({ canvasId: 'canvas', snapshot: original, additions: graph(), save: async () => ({ version: 4, staleNodeIds: [] }), getCurrent: () => other, apply })
    expect(result).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('exports selected nodes and their internal edges without asset, result, model, or secret fields', () => {
    const a = node('a', 'image', { prompt: 'product', assetId: 'asset-123', url: 'vibe://secret', model: 'model-1', token: 'secret' })
    const b = node('b', 'text', { content: 'description', style: 'soft' })
    const c = node('c')
    const edges: Edge[] = [{ id: 'ab', source: 'b', target: 'a' }, { id: 'bc', source: 'b', target: 'c' }]
    const result = templateFromSelection([a, b, c], edges, ['a', 'b'])
    expect(result.nodes.map((item) => item.params)).toEqual([{ prompt: 'product' }, { content: 'description', style: 'soft' }])
    expect(result.edges).toEqual([{ source: 'node-2', target: 'node-1' }])
    expect(JSON.stringify(result)).not.toMatch(/asset-123|secret|model-1/)
    expect(() => templateFromSelection([node('url', 'text', { content: 'https://example.com' })], [], ['url'])).toThrow(/网址或本地路径/)
  })

  it('uses the current available model capability to accept or reject specification presets', () => {
    const configuration = {
      providers: [{ id: 'provider', configured: true, enabledModelIds: ['model'], defaultModelIds: { image: 'model' } }],
      models: [{ id: 'model', name: 'model', providerId: 'provider', modelType: 'image', enabled: true, implemented: true, inputModes: ['text'], defaults: { ratio: '1:1', size: '1K' }, constraints: { acceptedAspectRatios: ['1:1'], acceptedSizes: ['1K', '2K'], maximumOutputs: 2 } }],
    } as unknown as DesktopProviderConfiguration
    expect(pluginPresetPatch({ nodeType: 'image', params: { prompt: 'photo', ratio: '1:1', size: '2K', count: 2 } }, 'image', { model: 'model' }, configuration)).toMatchObject({ prompt: 'photo', ratio: '1:1', resolution: '2K', count: 2 })
    expect(() => pluginPresetPatch({ nodeType: 'image', params: { size: '4K' } }, 'image', { model: 'model' }, configuration)).toThrow(/分辨率/)
    expect(() => pluginPresetPatch({ nodeType: 'image', params: { count: 3 } }, 'image', { model: 'model' }, configuration)).toThrow(/数量/)
    expect(() => pluginPresetPatch({ nodeType: 'image', params: { model: 'other' } }, 'image', { model: 'model' }, configuration)).toThrow(/选择预设要求的模型/)
    expect(() => pluginPresetPatch({ nodeType: 'video', params: { prompt: 'x' } }, 'image', {}, configuration)).toThrow(/不匹配/)
    configuration.providers[0].enabledModelIds = []
    expect(() => pluginPresetPatch({ nodeType: 'image', params: { ratio: '1:1' } }, 'image', { model: 'model' }, configuration)).toThrow(/可用模型/)
  })

  it('asks for overwrite confirmation only for changed, populated fields and ignores unrelated data', () => {
    const before = { prompt: 'old prompt', style: '', count: 0, generate_audio: false, assetId: 'private-asset', url: 'private-url' }
    const patch = changedPluginPresetPatch(before, { prompt: 'new prompt', style: 'photo', count: 0, generate_audio: true })
    expect(patch).toEqual({ prompt: 'new prompt', style: 'photo', generate_audio: true })
    expect(overwrittenPluginPresetFields(before, patch)).toEqual(['prompt', 'generate_audio'])
    expect(overwrittenPluginPresetFields({}, changedPluginPresetPatch({}, { prompt: 'new' }))).toEqual([])
    expect(JSON.stringify(patch)).not.toMatch(/private-asset|private-url/)
  })

  it('rejects an existing duration that becomes incompatible with a preset video resolution', () => {
    const configuration = {
      providers: [{ id: 'provider', configured: true, enabledModelIds: ['video'], defaultModelIds: { video: 'video' } }],
      models: [{ id: 'video', name: 'video', providerId: 'provider', modelType: 'video', enabled: true, implemented: true, inputModes: ['text'], defaults: { resolution: '720p', duration: 5 }, constraints: { acceptedResolutions: ['720p', '1080p'], durationByResolution: { '1080p': [8] }, acceptedDurations: [5, 8] } }],
    } as unknown as DesktopProviderConfiguration
    const current = { model: 'video', resolution: '720p', duration: 5 }
    expect(() => pluginPresetPatch({ nodeType: 'video', params: { resolution: '1080p' } }, 'video', current, configuration)).toThrow(/时长/)
    expect(pluginPresetPatch({ nodeType: 'video', params: { resolution: '1080p', duration: 8 } }, 'video', current, configuration)).toMatchObject({ resolution: '1080p', duration: 8 })
  })
})

describe('plugin canvas local-core integration', () => {
  it('persists two independent template graphs, replays the same save once, and creates no tasks', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const { createLocalProjectStore } = require('../../../../pi-paper-desktop/src/project-store.cjs')
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-plugin-canvas-'))
    const store = createLocalProjectStore()
    try {
      const opened = await store.createProject(directory, 'Plugin graph')
      const project = opened.project
      vi.stubGlobal('localStorage', { getItem: () => null })
      vi.stubGlobal('window', { vibepaperDesktop: { saveCanvas: (input: unknown) => store.saveCanvas(input) }, location: { protocol: 'vibe:' } })
      const { saveCanvasPort } = await import('./canvasPort')
      const template = readPluginTemplate(templateData)
      const first = buildPluginTemplateGraph(template, { x: 100, y: 200 }, () => {})
      const second = buildPluginTemplateGraph(template, { x: 1300, y: 200 }, () => {})
      const firstInput = { projectId: project.projectId as string, canvasId: project.canvasId as string, expectedVersion: 0,
        idempotencyKey: 'plugin-save-once', nodes: first.nodes, edges: first.edges, groups: [], stacks: [] }
      const saved = await saveCanvasPort(firstInput)
      const replay = await saveCanvasPort(firstInput)
      expect(replay.version).toBe(saved.version)
      await saveCanvasPort({ ...firstInput, expectedVersion: saved.version, idempotencyKey: 'plugin-save-twice',
        nodes: [...first.nodes, ...second.nodes], edges: [...first.edges, ...second.edges] })
      const loaded = store.loadCanvas(project.projectId, project.canvasId)
      expect(loaded.nodes).toHaveLength(14)
      expect(loaded.edges).toHaveLength(12)
      const firstIds = new Set(first.nodes.map((item) => item.id))
      expect(loaded.edges.filter((edge: Edge) => firstIds.has(edge.source) !== firstIds.has(edge.target))).toHaveLength(0)
      expect(await store.listTasks(project.projectId)).toHaveLength(0)
      await expect(saveCanvasPort(firstInput)).resolves.toMatchObject({ version: saved.version })
      await expect(saveCanvasPort({ ...firstInput, idempotencyKey: 'stale-version' })).rejects.toThrow()
      expect(store.loadCanvas(project.projectId, project.canvasId).nodes).toHaveLength(14)
    } finally {
      vi.unstubAllGlobals()
      await store.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
