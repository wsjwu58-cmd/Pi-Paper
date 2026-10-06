import type { CharacterPose, DirectorCategory, DirectorModelKind, PrimitiveKind, PropKind } from './types'

export interface CatalogItem {
  kind: DirectorModelKind
  category: DirectorCategory
  label: string
  /** lucide icon name key used in UI */
  icon: string
  defaultColor: string
  defaultScale: number
}

export const CHARACTER_POSES: CharacterPose[] = [
  '站立',
  '行走',
  '奔跑',
  '坐',
  '挥手',
  '跳跃',
  '点头',
  '摇头',
  '沮丧',
  '潜行',
  '儿童',
]

export const PROP_KINDS: PropKind[] = ['台阶', '椅子', '墙板', '灯', '拱门', '树', '桌子', '栅栏']

export const PRIMITIVE_KINDS: PrimitiveKind[] = ['方块', '球体', '圆柱', '圆锥', '金字塔', '胶囊', '圆环']

export const CHARACTER_CATALOG: CatalogItem[] = CHARACTER_POSES.map((pose) => ({
  kind: pose,
  category: 'character' as const,
  label: pose === '站立' ? '人物' : pose,
  icon: 'person',
  defaultColor: '#e85d6c',
  defaultScale: pose === '儿童' ? 0.72 : 1,
}))

/** 左侧「人物模型」入口：点击后展开姿态列表 */
export const CHARACTER_ENTRY: CatalogItem = {
  kind: '站立',
  category: 'character',
  label: '人物',
  icon: 'person',
  defaultColor: '#e85d6c',
  defaultScale: 1,
}

export const PROP_CATALOG: CatalogItem[] = [
  { kind: '台阶', category: 'prop', label: '台阶', icon: 'steps', defaultColor: '#9a9aa3', defaultScale: 1 },
  { kind: '墙板', category: 'prop', label: '墙板', icon: 'wall', defaultColor: '#c8c8ce', defaultScale: 1 },
  { kind: '拱门', category: 'prop', label: '拱门', icon: 'arch', defaultColor: '#b0b0b8', defaultScale: 1 },
  { kind: '桌子', category: 'prop', label: '桌子', icon: 'table', defaultColor: '#8b6914', defaultScale: 1 },
  { kind: '椅子', category: 'prop', label: '椅子', icon: 'chair', defaultColor: '#1a1a1a', defaultScale: 1 },
  { kind: '灯', category: 'prop', label: '灯', icon: 'lamp', defaultColor: '#f5d76e', defaultScale: 1 },
  { kind: '树', category: 'prop', label: '树', icon: 'tree', defaultColor: '#3d8b4f', defaultScale: 1 },
  { kind: '栅栏', category: 'prop', label: '栅栏', icon: 'fence', defaultColor: '#6b5344', defaultScale: 1 },
]

export const PRIMITIVE_CATALOG: CatalogItem[] = [
  { kind: '方块', category: 'primitive', label: '方块', icon: 'cube', defaultColor: '#7c8cff', defaultScale: 1 },
  { kind: '球体', category: 'primitive', label: '球体', icon: 'sphere', defaultColor: '#ff7c8c', defaultScale: 1 },
  { kind: '圆柱', category: 'primitive', label: '圆柱', icon: 'cylinder', defaultColor: '#7cffb0', defaultScale: 1 },
  { kind: '圆锥', category: 'primitive', label: '圆锥', icon: 'cone', defaultColor: '#ffc07c', defaultScale: 1 },
  { kind: '圆环', category: 'primitive', label: '圆环', icon: 'torus', defaultColor: '#c07cff', defaultScale: 1 },
  { kind: '胶囊', category: 'primitive', label: '胶囊', icon: 'capsule', defaultColor: '#7ce8ff', defaultScale: 1 },
  { kind: '金字塔', category: 'primitive', label: '金字塔', icon: 'pyramid', defaultColor: '#ffe07c', defaultScale: 1 },
]

export function nextObjectName(kind: DirectorModelKind, existingNames: string[]) {
  const base = kind === '站立' ? '人物' : kind
  let n = 1
  const taken = new Set(existingNames)
  while (taken.has(`${base} ${String(n).padStart(2, '0')}`)) n += 1
  return `${base} ${String(n).padStart(2, '0')}`
}
