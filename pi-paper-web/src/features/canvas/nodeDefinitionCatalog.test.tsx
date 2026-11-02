import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { MarketplacePackage } from '@/desktop/desktop-bridge'
import { basicNodeCatalog, createNodeDefinitionInstance, compatibleNodeType, projectNodeCatalog, renderNodeDefinitionPrompt } from './nodeDefinitionCatalog'
import { NodeDefinitionFields } from './nodes/NodeDefinitionFields'
import { ComponentPreview, filterMarketplacePackages } from '@/features/marketplace/MarketplacePage'

const item: MarketplacePackage = {
  id: 'studio', name: '商品包', description: '', version: '1.0.0', author: '本地用户', source: 'project',
  installed: true, enabled: true, installedVersion: '1.0.0', updateAvailable: false, rollbackVersion: null,
  components: [{ id: 'node', type: 'node_definition', name: '商品棚拍图', description: '', installed: true, enabled: true, updateConflict: null,
    data: { schemaVersion: 1, baseType: 'image', promptTemplate: '{{product}}，{{light}}', fields: [
      { id: 'product', label: '商品', kind: 'text', default: '玻璃杯' },
      { id: 'light', label: '光线', kind: 'enum', default: '柔光', options: ['柔光', '侧光'] },
    ] } }],
}

describe('custom node catalog', () => {
  it('discovers only enabled project instances and filters inherited connection types', () => {
    expect(basicNodeCatalog()).toHaveLength(6)
    expect(basicNodeCatalog(['image']).find((node) => node.type === 'image')?.visible).toBe(false)
    expect(basicNodeCatalog(['image']).filter((node) => node.visible)).toHaveLength(5)
    expect(projectNodeCatalog([item])).toHaveLength(1)
    expect(projectNodeCatalog([{ ...item, components: item.components.map((component) => ({ ...component, enabled: false })) }])).toEqual([])
    expect(compatibleNodeType('text', 'image', 'downstream')).toBe(true)
    expect(compatibleNodeType('audio', 'image', 'downstream')).toBe(false)
    expect(compatibleNodeType('video', 'image', 'upstream')).toBe(true)
    expect(compatibleNodeType('text', 'image', 'upstream')).toBe(false)
    expect(filterMarketplacePackages([item], 'project', '')).toEqual([item])
    expect(filterMarketplacePackages([item], 'node_definition', '棚拍')).toEqual([item])
  })
  it('creates a deterministic immutable definition reference and renders fields without HTML', async () => {
    const [entry] = projectNodeCatalog([item])
    const first = await createNodeDefinitionInstance(entry)
    const second = await createNodeDefinitionInstance(entry)
    expect(first).toEqual(second)
    expect(first.ref.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(renderNodeDefinitionPrompt(first)).toBe('玻璃杯，柔光')
    const html = renderToStaticMarkup(<NodeDefinitionFields instance={first} onChange={() => {}} />)
    expect(html).toContain('商品棚拍图')
    expect(html).toContain('生成提示词预览')
    expect(html).toContain('玻璃杯，柔光')
    const preview = renderToStaticMarkup(<ComponentPreview component={entry.component} />)
    expect(preview).toContain('基础类型')
    expect(preview).toContain('商品')
    expect(preview).toContain('{{product}}')
    expect(preview).toContain('检查模型能力')
    expect(preview).toContain('不会联系供应商或选择模型')
  })
})
