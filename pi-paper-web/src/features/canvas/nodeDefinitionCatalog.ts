import type { DesktopNodeDefinitionInstance, MarketplaceComponent, MarketplacePackage } from '@/desktop/desktop-bridge'
import { isEdgeTypeCompatible } from './canvasEdges.ts'

export const BASIC_NODES = [
  { type: 'text', label: '文本' }, { type: 'image', label: '图片' },
  { type: 'video', label: '视频' }, { type: 'audio', label: '音频' },
  { type: 'compose', label: '合成' }, { type: 'director', label: '导演台' },
] as const
export type BasicNodeType = typeof BASIC_NODES[number]['type']
export function basicNodeCatalog(hidden: readonly string[] = []) {
  const hiddenSet = new Set(hidden)
  return BASIC_NODES.map((item) => ({ ...item, visible: !hiddenSet.has(item.type) }))
}
export interface ProjectNodeItem {
  packageId: string
  version: string
  component: Extract<MarketplaceComponent, { type: 'node_definition' }>
}
export function compatibleNodeType(existing: string | undefined, candidate: BasicNodeType, direction?: 'upstream' | 'downstream') {
  if (!existing || !direction) return true
  return direction === 'upstream' ? isEdgeTypeCompatible(candidate, existing) : isEdgeTypeCompatible(existing, candidate)
}
export function projectNodeCatalog(packages: MarketplacePackage[]): ProjectNodeItem[] {
  return packages.flatMap((pkg) => pkg.components.flatMap((component) => component.type === 'node_definition' && component.installed && component.enabled && pkg.installedVersion
    ? [{ packageId: pkg.id, version: pkg.installedVersion, component }] : []))
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
  return value
}
export async function createNodeDefinitionInstance(item: ProjectNodeItem): Promise<DesktopNodeDefinitionInstance> {
  const snapshot = { name: item.component.name, data: item.component.data }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(snapshot))))
  return {
    ref: { packageId: item.packageId, componentId: item.component.id, version: item.version,
      digest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') },
    snapshot,
    values: Object.fromEntries(snapshot.data.fields.map((field) => [field.id, field.default])),
  }
}
export function renderNodeDefinitionPrompt(instance: DesktopNodeDefinitionInstance) {
  return instance.snapshot.data.promptTemplate.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/gu,
    (_match, id: string) => String(instance.values[id] ?? ''))
}
export function readNodeDefinition(value: unknown): DesktopNodeDefinitionInstance | null {
  if (!value || typeof value !== 'object') return null
  const instance = value as DesktopNodeDefinitionInstance
  return instance.snapshot?.data?.schemaVersion === 1 && Array.isArray(instance.snapshot.data.fields) && instance.values
    ? instance : null
}
