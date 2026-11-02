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
    { id: 'skill', type: 'skill', name: 'Skill', description: '', installed: true, enabled: true, updateConflict: null, data: { category: 'general', instructions: 'private-instructions' } },
    { id: 'workflow', type: 'workflow_recipe', name: 'Workflow', description: '', installed: true, enabled: true, updateConflict: null, data: { steps: [{ kind: 'storyboard_preview', componentId: 'shots' }] } },
  ],
}]

function render(presetNodeType?: string) {
  vi.stubGlobal('window', { vibepaperDesktop: { marketplace: { list: vi.fn() } } })
  const client = new QueryClient()
  client.setQueryData(['desktop-marketplace', 'project'], packages)
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
    expect(html).not.toContain('Skill')
    expect(html).not.toContain('private-data')
    expect(html).not.toContain('private-instructions')
  })

  it('shows only matching presets when opened from a node editor', () => {
    const html = render('image')
    expect(html).toContain('Image preset')
    expect(html).not.toContain('Video preset')
    expect(html).not.toContain('Template')
    expect(html).not.toContain('Workflow')
    expect(html).not.toContain('保存模板')
  })
})
