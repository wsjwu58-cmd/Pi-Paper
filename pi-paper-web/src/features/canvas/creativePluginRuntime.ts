import { t as uiText } from '@/lib/i18n'
import { sid } from '@/lib/ids'
import type { DirectorCamera, DirectorObject } from './director/types'
import { CHARACTER_POSES, PROP_KINDS, PRIMITIVE_KINDS } from './director/catalog'
import { previewCreativeCommand } from './creativeCommandCatalog'
import type { FlowNode } from './canvasStore'
import type { CreativeMediaTool, CreativeMotion, CreativeScene, CreativeSelectionCommand, CreativeStoryboard, PosterLayout, StoryboardField } from './creativePluginTypes'

const invalid = (): never => { throw new Error(uiText('创作组件数据无效。')) }
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const exact = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (!record(v) || Object.keys(v).some((key) => !keys.includes(key))) return invalid()
  return v
}
const number = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return invalid()
  return v
}
const color = (v: unknown): string => {
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/iu.test(v)) return invalid()
  return v
}
const text = (v: unknown, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /(?:https?|file|vibe):\/\/|(?:[a-z]:\\|\/(?:Users|home|private|tmp)\/)/iu.test(v)) return invalid()
  return v
}
export function readCreativeCamera(raw: unknown): DirectorCamera {
  const v = exact(raw, ['yaw', 'pitch', 'distance'])
  return { yaw: number(v.yaw, -180, 180), pitch: number(v.pitch, 5, 80), distance: number(v.distance, 3, 20) }
}
export function readCreativeMotion(raw: unknown): CreativeMotion {
  const v = exact(raw, ['from', 'to', 'duration'])
  return { from: readCreativeCamera(v.from), to: readCreativeCamera(v.to), duration: number(v.duration, 0.5, 30) }
}
export function readCreativeScene(raw: unknown): CreativeScene {
  const v = exact(raw, ['objects', 'camera'])
  if (!Array.isArray(v.objects) || !v.objects.length || v.objects.length > 50) return invalid()
  const objects = v.objects.map((item) => {
    const o = exact(item, ['category', 'kind', 'name', 'position', 'rotation', 'scale', 'color'])
    const kinds = o.category === 'character' ? CHARACTER_POSES : o.category === 'prop' ? PROP_KINDS : o.category === 'primitive' ? PRIMITIVE_KINDS : []
    if (typeof o.kind !== 'string' || !(kinds as string[]).includes(o.kind) || !Array.isArray(o.position) || o.position.length !== 3) return invalid()
    return { category: o.category as DirectorObject['category'], kind: o.kind as DirectorObject['kind'], name: text(o.name, 64),
      position: [number(o.position[0], -6, 6), number(o.position[1], -1, 4), number(o.position[2], -6, 6)] as [number, number, number],
      rotation: number(o.rotation, -180, 180), scale: number(o.scale, 0.3, 3), color: color(o.color) }
  })
  return { objects, camera: readCreativeCamera(v.camera) }
}
export function readPosterLayout(raw: unknown): PosterLayout {
  const v = exact(raw, ['width', 'height', 'background', 'image', 'title'])
  const width = number(v.width, 128, 4096), height = number(v.height, 128, 4096)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width * height > 16_000_000) return invalid()
  const image = exact(v.image, ['x', 'y', 'width', 'height', 'fit'])
  const x = number(image.x, 0, width - 1), y = number(image.y, 0, height - 1)
  const imageWidth = number(image.width, 1, width - x), imageHeight = number(image.height, 1, height - y)
  if (image.fit !== 'contain' && image.fit !== 'cover') return invalid()
  const title = exact(v.title, ['text', 'x', 'y', 'size', 'color'])
  return { width, height, background: color(v.background), image: { x, y, width: imageWidth, height: imageHeight, fit: image.fit },
    title: { text: text(title.text, 200), x: number(title.x, 0, width), y: number(title.y, 0, height), size: number(title.size, 8, 512), color: color(title.color) } }
}
export function readSelectionCommand(raw: unknown): CreativeSelectionCommand {
  const v = exact(raw, ['command', 'orientation', 'gap'])
  if (v.command !== 'arrange' || (v.orientation !== 'horizontal' && v.orientation !== 'vertical')) return invalid()
  return { command: v.command, orientation: v.orientation, gap: number(v.gap, 0, 500) }
}
function equalNodeData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalNodeData(value, right[index]))
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalNodeData(a[key], b[key]))
}
/** Ignore React Flow view updates while rejecting changed selection, positions, or business data. */
export function resolveUnchangedCreativeSelection(previous: FlowNode[], current: FlowNode[], selectedIds: Array<string | number>): FlowNode[] | null {
  const expectedIds = previous.map((node) => sid(node.id))
  const expected = new Set(expectedIds)
  const selected = new Set(selectedIds.map(sid))
  if (expected.size !== previous.length || selected.size !== selectedIds.length || selected.size !== expected.size || [...expected].some((id) => !selected.has(id))) return null
  const currentById = new Map(current.map((node) => [sid(node.id), node]))
  const result: FlowNode[] = []
  for (const old of previous) {
    const node = currentById.get(sid(old.id))
    if (!node || node.position.x !== old.position.x || node.position.y !== old.position.y || !equalNodeData(old.data.node, node.data.node)) return null
    result.push(node)
  }
  return result
}
/** Preserve the selected nodes' spatial order on the axis being arranged. */
export function arrangeCreativeSelection(nodes: FlowNode[], selected: FlowNode[], command: CreativeSelectionCommand): FlowNode[] {
  const preview = previewCreativeCommand({ type: 'selection_command', data: command }, nodes, selected.map((node) => sid(node.id)))
  if (preview.capabilityId !== 'selection.arrange') return nodes
  const positions = new Map(preview.moves.map((move) => [move.id, move.to]))
  return nodes.map((node) => { const position = positions.get(sid(node.id)); return position ? { ...node, position } : node })
}
export function readStoryboard(raw: unknown): CreativeStoryboard {
  const v = exact(raw, ['fields'])
  const allowed = ['title', 'type', 'prompt', 'camera', 'content']
  if (!Array.isArray(v.fields) || !v.fields.length || v.fields.length > allowed.length || new Set(v.fields).size !== v.fields.length || v.fields.some((item) => typeof item !== 'string' || !allowed.includes(item))) return invalid()
  return { fields: [...v.fields] as StoryboardField[] }
}
export function readMediaTool(raw: unknown): CreativeMediaTool {
  const v = exact(raw, ['tool', 'mode'])
  if (v.tool !== 'crop' || (v.mode !== 'single' && v.mode !== 'four' && v.mode !== 'nine')) return invalid()
  return { tool: 'crop', mode: v.mode }
}
/** Interpolate the shortest orbit across the -180/180 seam. */
export function cameraAt(motion: CreativeMotion, progress: number): DirectorCamera {
  const t = Math.max(0, Math.min(1, progress))
  const delta = ((motion.to.yaw - motion.from.yaw + 540) % 360) - 180
  const yaw = ((motion.from.yaw + delta * t + 540) % 360) - 180
  return { yaw: t === 1 ? motion.to.yaw : yaw,
    pitch: motion.from.pitch + (motion.to.pitch - motion.from.pitch) * t,
    distance: motion.from.distance + (motion.to.distance - motion.from.distance) * t }
}
