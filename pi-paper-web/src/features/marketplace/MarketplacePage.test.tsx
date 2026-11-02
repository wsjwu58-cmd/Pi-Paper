import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MarketplaceComponent, MarketplacePackage } from '@/desktop/desktop-bridge'
import { ComponentPreview, filterMarketplacePackages, PackageCard, UpdateConflictNotice } from './MarketplacePage'

const example: MarketplacePackage = {
  id: 'test-package', name: '商品棚拍工作流', description: '摄影组件', version: '1.0.0', author: 'Pi-Paper', source: 'builtin',
  installed: true, enabled: true, installedVersion: '1.0.0', updateAvailable: false, rollbackVersion: null,
  components: [
    { id: 'template', type: 'template', name: '画布模板', description: '节点与连线', installed: true, enabled: true, updateConflict: null, data: {
      nodes: [{ id: 'a', type: 'text', x: 0, y: 0, params: { content: '画一只猫' } }, { id: 'b', type: 'image', x: 200, y: 0, params: { prompt: '真实质感' } }],
      edges: [{ source: 'a', target: 'b' }],
    } },
    { id: 'preset', type: 'preset', name: '柔光预设', description: '柔和照明', installed: false, enabled: false, updateConflict: null, data: { nodeType: 'image', params: { prompt: '柔光' } } },
    { id: 'skill', type: 'skill', name: '策划', description: '构思', installed: false, enabled: false, updateConflict: null, data: { category: 'image', instructions: '先了解用户需求' } },
    { id: 'asset', type: 'asset', name: '背景', description: '背景素材', installed: false, enabled: false, updateConflict: null, data: { kind: 'image', mime: 'image/png', base64: 'YWJj' } },
  ],
}

describe('marketplace discovery and previews', () => {
  it('filters by installed state, component type, and component metadata', () => {
    expect(filterMarketplacePackages([example], 'installed', '')).toEqual([example])
    expect(filterMarketplacePackages([example], 'preset', '柔和')).toEqual([example])
    expect(filterMarketplacePackages([example], 'asset', '柔和')).toEqual([])
    expect(filterMarketplacePackages([example], 'template', '无匹配')).toEqual([])
    expect(filterMarketplacePackages([{ ...example, components: example.components.map((item) => ({ ...item, installed: false })) }], 'installed', '')).toEqual([])
  })

  it('shows package provenance and installed component count', () => {
    const html = renderToStaticMarkup(<PackageCard item={example} onOpen={() => undefined} />)
    expect(html).toContain('内置目录')
    expect(html).toContain('已安装 1/4')
    expect(html).toContain('画布模板')
  })

  it('previews actual template topology and prompts, preset parameters and Skill instructions as text', () => {
    const template = renderToStaticMarkup(<ComponentPreview component={example.components[0]} />)
    expect(template).toContain('2 个节点、1 条连线')
    expect(template).toContain('画一只猫')
    expect(template).toContain('真实质感')
    expect(template).toContain('节点 1：文字节点')
    expect(template).toContain('节点 2：图片节点')
    expect(template).toContain('→')
    expect(renderToStaticMarkup(<ComponentPreview component={example.components[1]} />)).toContain('柔光')
    expect(renderToStaticMarkup(<ComponentPreview component={example.components[2]} />)).toContain('先了解用户需求')
  })

  it('renders only supported base64 images and never interprets instructions as HTML', () => {
    expect(renderToStaticMarkup(<ComponentPreview component={example.components[3]} />)).toContain('data:image/png;base64,YWJj')
    const unsafeAsset = { ...example.components[3], data: { mime: 'image/svg+xml', base64: 'YWJj' } } as unknown as MarketplaceComponent
    expect(renderToStaticMarkup(<ComponentPreview component={unsafeAsset} />)).not.toContain('<img')
    const unsafeSkill = { ...example.components[2], data: { instructions: '<script>bad()</script>' } } as unknown as MarketplaceComponent
    const html = renderToStaticMarkup(<ComponentPreview component={unsafeSkill} />)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('identifies precisely which installed components block an update', () => {
    const removed = { ...example.components[0], updateConflict: 'removed' } as MarketplaceComponent
    const changed = { ...example.components[0], updateConflict: 'type_changed' } as MarketplaceComponent
    expect(renderToStaticMarkup(<UpdateConflictNotice component={removed} />)).toContain('新版已移除此组件')
    expect(renderToStaticMarkup(<UpdateConflictNotice component={changed} />)).toContain('新版更改了此组件的类型')
    expect(renderToStaticMarkup(<UpdateConflictNotice component={example.components[0]} />)).toBe('')
  })
})
