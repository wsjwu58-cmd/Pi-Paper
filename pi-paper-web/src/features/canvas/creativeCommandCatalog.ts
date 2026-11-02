/** Host-owned, data-only commands. Packages only configure the declared inputs. */
export const CREATIVE_COMMAND_DESCRIPTORS = {
  storyboard: { capabilityId: 'storyboard.preview', version: 1, componentType: 'storyboard', label: '分镜导出', button: '导出选区', minimumSelection: 1, effect: 'read', entries: ['canvas-selection', 'agent'], inputFields: ['fields'] },
  selection_command: { capabilityId: 'selection.arrange', version: 1, componentType: 'selection_command', label: '选区命令', button: '应用到选中节点', minimumSelection: 2, effect: 'canvas_write', entries: ['canvas-selection', 'agent'], inputFields: ['orientation', 'gap'] },
} as const
export type CreativeCommandType = keyof typeof CREATIVE_COMMAND_DESCRIPTORS
export function getCreativeCommandDescriptor(type: string) {
  return Object.hasOwn(CREATIVE_COMMAND_DESCRIPTORS, type) ? CREATIVE_COMMAND_DESCRIPTORS[type as CreativeCommandType] : undefined
}

type Field = 'title' | 'type' | 'prompt' | 'camera' | 'content'
type Position = { x: number; y: number }
export type CreativeCommandNode = { id: string; type?: string; position: Position; width?: number; height?: number;
  measured?: { width?: number; height?: number }; data: Record<string, unknown> }
type CreativeCommandComponent = { type: string; data: unknown }
type CatalogPackage = { id: string; installedDigest?: string | null; version?: string; installedVersion?: string | null; components: Array<{ id: string; name: string; type: string; installed: boolean; enabled: boolean }> }
type Formatter = (text: string, values?: Record<string, unknown>) => string
const formatDefault: Formatter = (text, values = {}) => text.replace(/\{(\d+)\}/gu, (match, key: string) => Object.hasOwn(values, key) ? String(values[key] ?? '') : match)
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown) => typeof value === 'string' ? value : ''
const fieldsAllowed: Field[] = ['title', 'type', 'prompt', 'camera', 'content']

function nodePayload(node: CreativeCommandNode) {
  const nested = record(node.data.node)
  return { type: string(nested.type) || string(node.type), params: record(nested.params ?? node.data.params), output: record(nested.output ?? node.data.output) }
}
function cameraText(value: unknown, format: Formatter): string | null {
  const camera = record(value)
  if (![camera.yaw, camera.pitch, camera.distance].every((item) => typeof item === 'number' && Number.isFinite(item))) return null
  return format('方向 {0}°，俯仰 {1}°，距离 {2}', { 0: camera.yaw, 1: camera.pitch, 2: camera.distance })
}
function storyboardCamera(params: Record<string, unknown>, format: Formatter): string {
  const camera = params.camera, view = cameraText(camera, format), parts: string[] = []
  if (typeof camera === 'string') { if (camera) parts.push(camera) }
  else if (camera != null) parts.push(view ? format('机位：{0}', { 0: view }) : format('机位数据格式无效'))
  if (params.motion != null) {
    const motion = record(params.motion), from = cameraText(motion.from, format), to = cameraText(motion.to, format)
    parts.push(from && to && typeof motion.duration === 'number' && Number.isFinite(motion.duration)
      ? format('运镜：{0} → {1}，{2} 秒', { 0: from, 1: to, 2: motion.duration }) : format('运镜数据格式无效'))
  }
  return parts.length === 2 ? format('{0}；{1}', { 0: parts[0], 1: parts[1] }) : parts[0] ?? ''
}
export function buildStoryboardRows(nodes: CreativeCommandNode[], format: Formatter = formatDefault) {
  return [...nodes].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x).map((node, index) => {
    const payload = nodePayload(node), params = payload.params
    const content = [payload.output.text, params.lastOutputText, params.content, params.text].find((value) => value != null && String(value).trim())
    return { id: String(node.id), values: { title: string(params.title) || string(params.name) || format('镜头 {0}', { 0: index + 1 }),
      type: payload.type, prompt: string(params.prompt), camera: payload.type === 'director' ? storyboardCamera(params, format) : string(params.camera),
      content: content == null ? '' : String(content) } }
  })
}
function selection(nodes: CreativeCommandNode[], selectedIds: string[], minimum: number) {
  if (!Array.isArray(selectedIds) || selectedIds.some((id) => typeof id !== 'string' || !id) || new Set(selectedIds).size !== selectedIds.length) throw new Error('SELECTION_CHANGED')
  if (!selectedIds.length) throw new Error('SELECTION_EMPTY')
  if (selectedIds.length < minimum) throw new Error('SELECTION_TOO_SMALL')
  const byId = new Map(nodes.map((node) => [String(node.id), node]))
  const selected = selectedIds.map((id) => byId.get(id))
  if (selected.some((node) => !node || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y))) throw new Error('SELECTION_CHANGED')
  return selected as CreativeCommandNode[]
}
export function describeCreativeCommands(packages: CatalogPackage[], nodes: CreativeCommandNode[], selectedIds: string[]) {
  return packages.flatMap((pkg) => pkg.components.flatMap((component) => {
    const descriptor = getCreativeCommandDescriptor(component.type)
    if (!descriptor) return []
    let reason: string | null = !component.installed ? 'NOT_INSTALLED' : !component.enabled ? 'DISABLED' : null
    if (!reason) { try { selection(nodes, selectedIds, descriptor.minimumSelection) } catch (error) { reason = error instanceof Error ? error.message : 'SELECTION_CHANGED' } }
    return [{ ...descriptor, packageId: pkg.id, componentId: component.id, name: component.name,
      packageDigest: pkg.installedDigest ?? null, version: pkg.installedVersion ?? pkg.version ?? null, installed: component.installed, enabled: component.enabled, available: reason === null, reason }]
  }))
}
export function previewCreativeCommand(component: CreativeCommandComponent, nodes: CreativeCommandNode[], selectedIds: string[], format: Formatter = formatDefault) {
  const descriptor = getCreativeCommandDescriptor(component.type)
  if (!descriptor) throw new Error('COMPONENT_INVALID')
  const selected = selection(nodes, selectedIds, descriptor.minimumSelection)
  const data = record(component.data)
  if (component.type === 'storyboard') {
    if (!Array.isArray(data.fields) || !data.fields.length || data.fields.length > fieldsAllowed.length
      || new Set(data.fields).size !== data.fields.length || data.fields.some((field) => !fieldsAllowed.includes(field as Field))) throw new Error('COMPONENT_INVALID')
    const fields = data.fields as Field[], rows = buildStoryboardRows(selected, format)
    const missing = rows.flatMap((row) => { const missingFields = fields.filter((field) => !row.values[field].trim()); return missingFields.length ? [{ id: row.id, fields: missingFields }] : [] })
    return { capabilityId: 'storyboard.preview' as const, fields, rows, missing }
  }
  if (data.command !== 'arrange' || !['horizontal', 'vertical'].includes(String(data.orientation))
    || typeof data.gap !== 'number' || !Number.isFinite(data.gap) || data.gap < 0 || data.gap > 500) throw new Error('COMPONENT_INVALID')
  const orientation = data.orientation as 'horizontal' | 'vertical', gap = data.gap
  const ordered = [...selected].sort((a, b) => orientation === 'horizontal'
    ? a.position.x - b.position.x || a.position.y - b.position.y : a.position.y - b.position.y || a.position.x - b.position.x)
  const originX = Math.min(...ordered.map((node) => node.position.x)), originY = Math.min(...ordered.map((node) => node.position.y))
  let cursor = 0
  const moves = ordered.map((node) => {
    const from = { ...node.position }, to = orientation === 'horizontal' ? { x: originX + cursor, y: originY } : { x: originX, y: originY + cursor }
    cursor += (orientation === 'horizontal' ? node.measured?.width ?? node.width ?? 300 : node.measured?.height ?? node.height ?? 240) + gap
    return { id: String(node.id), from, to }
  })
  return { capabilityId: 'selection.arrange' as const, orientation, gap, moves }
}
