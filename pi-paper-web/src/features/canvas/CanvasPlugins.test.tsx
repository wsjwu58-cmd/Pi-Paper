import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketplacePackage } from '@/desktop/desktop-bridge'
import { CanvasPlugins } from './CanvasPlugins'

const packages: MarketplacePackage[] = [{
  id: 'bundle', name: 'Product', description: '', version: '1', author: 'Local', source: 'builtin',
  installed: true, enabled: true, installedVersion: '1', updateAvailable: false, rollbackVersion: null,
  components: [
    { id: 'template', type: 'template', name: 'Template', description: '', installed: true, enabled: true, updateConflict: null, data: { nodes: [], edges: [] } },
    { id: 'image-preset', type: 'preset', name: 'Image preset', description: '', installed: true, enabled: true, updateConflict: null, data: { nodeType: 'image', params: { prompt: 'photo' } } },
    { id: 'video-preset', type: 'preset', name: 'Video preset', description: '', installed: true, enabled: true, updateConflict: null, data: { nodeType: 'video', params: { prompt: 'clip' } } },
    { id: 'disabled', type: 'preset', name: 'Disabled preset', description: '', installed: true, enabled: false, updateConflict: null, data: { nodeType: 'image', params: {} } },
    { id: 'asset', type: 'asset', name: 'Asset', description: '', installed: true, enabled: true, updateConflict: null, data: { kind: 'image', mime: 'image/png', base64: 'private-data' } },
    { id: 'skill', type: 'skill', name: 'Private skill name', description: '', installed: true, enabled: true, updateConflict: null, data: { category: 'general', instructions: 'private-instructions' } },
    { id: 'node', type: 'node_definition', name: 'Product node', description: '', installed: true, enabled: true, updateConflict: null, data: { schemaVersion: 1, baseType: 'image', promptTemplate: '{{product}}', fields: [{ id: 'product', label: 'Product', kind: 'text', default: '' }] } },
    { id: 'product-stage', type: 'director_scene', name: '商品棚拍场景', description: '', installed: true, enabled: true, updateConflict: null, data: { objects: [], camera: { yaw: 35, pitch: 25, distance: 8 } } },
    { id: 'client', type: 'connector', name: 'Client template', description: '', installed: true, enabled: true, updateConflict: null, data: { kind: 'mcp-client', clientName: 'Test', permissions: [] } },
    { id: 'role', type: 'agent_role', name: 'Private role', description: '', installed: true, enabled: true, updateConflict: null, data: { profile: 'canvas-general', tools: [], skills: [], contexts: [], instructions: '' } },
    { id: 'workflow', type: 'workflow_recipe', name: 'Workflow', description: '', installed: true, enabled: true, updateConflict: null, data: { steps: [{ kind: 'storyboard_preview', componentId: 'shots' }] } },
  ],
}]

function render(presetNodeType?: string, items = packages, serviceAvailable = true) {
  vi.stubGlobal('window', { vibepaperDesktop: serviceAvailable ? { marketplace: { list: vi.fn() } } : {} })
  const client = new QueryClient()
  client.setQueryData(['desktop-marketplace', 'project'], items)
  return renderToStaticMarkup(<QueryClientProvider client={client}>
    <CanvasPlugins projectId="project" open busy={false} presetNodeType={presetNodeType} onClose={() => {}} onUse={async () => {}} onSaveSelection={async () => true} />
  </QueryClientProvider>)
}

afterEach(() => vi.unstubAllGlobals())

describe('canvas plugin component picker', () => {
  it('shows only enabled supported components without rendering asset or skill contents', () => {
    const html = render()
    expect(html).toContain('Template')
    expect(html).toContain('Image preset')
    expect(html).toContain('Asset')
    expect(html).toContain('Workflow')
    expect(html).toContain('预览流程')
    expect(html).not.toContain('Disabled preset')
    expect(html).toContain('Product node')
    expect(html).toContain('新建节点')
    expect(html).toContain('商品棚拍场景')
    expect(html).toContain('新建导演台')
    expect(html).toContain('Skill：在 Agent 的技能面板中选择。')
    expect(html).toContain('Agent 角色：在 Agent 输入区的「会话角色」中选择。')
    expect(html).toContain('MCP 客户端模板：在插件市场打开对应连接器')
    expect(html).not.toContain('Private skill name')
    expect(html).not.toContain('private-data')
    expect(html).not.toContain('private-instructions')
  })

  it('shows only matching presets when opened from a node editor', () => {
    const html = render('image')
    expect(html).toContain('Image preset')
    expect(html).not.toContain('Video preset')
    expect(html).not.toContain('Template')
    expect(html).not.toContain('Workflow')
    expect(html).not.toContain('商品棚拍场景')
    expect(html).toContain('导演组件：打开导演台节点')
    expect(html).not.toContain('保存模板')
  })

  it('shows a director-only enabled component with the real editor entry instead of a false empty state', () => {
    const item = { ...packages[0], components: packages[0].components.filter((component) => component.id === 'product-stage') }
    const html = render(undefined, [item])
    expect(html).toContain('商品棚拍场景')
    expect(html).toContain('新建导演台')
    expect(html).toContain('双击导演台节点')
    expect(html).toContain('已启用导演组件')
    expect(html).not.toContain('暂无已启用组件')
  })

  it('distinguishes an empty node context from components available elsewhere', () => {
    const html = render('audio')
    expect(html).toContain('当前节点暂无可用组件。')
    expect(html).toContain('其他画布组件：从画布工具栏打开')
    expect(html).toContain('导演组件：打开导演台节点')
    expect(html).not.toContain('暂无已启用组件')
  })

  it('summarizes enabled skills without claiming there are no enabled components', () => {
    const item = { ...packages[0], officialSkillCatalog: true, components: packages[0].components.filter((component) => component.type === 'skill') }
    const html = render(undefined, [item])
    expect(html).toContain('此处暂无可直接使用的组件')
    expect(html).toContain('Skill：在 Agent 的技能面板中选择。')
    expect(html).not.toContain('Private skill name')
    expect(html).not.toContain('暂无已启用组件')
  })

  it('reports an unavailable marketplace service instead of a false empty state or stale cards', () => {
    const html = render(undefined, packages, false)
    expect(html).toContain('本地插件服务尚未就绪。')
    expect(html).not.toContain('暂无已启用组件')
    expect(html).not.toContain('商品棚拍场景')
  })
})
