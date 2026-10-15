/** 导演台场景对象与机位状态 */

export type DirectorCategory = 'character' | 'prop' | 'primitive'

export type CharacterPose =
  | '站立'
  | '行走'
  | '奔跑'
  | '坐'
  | '挥手'
  | '跳跃'
  | '点头'
  | '摇头'
  | '沮丧'
  | '潜行'
  | '儿童'

export type PropKind = '台阶' | '椅子' | '墙板' | '灯' | '拱门' | '树' | '桌子' | '栅栏'

export type PrimitiveKind = '方块' | '球体' | '圆柱' | '圆锥' | '金字塔' | '胶囊' | '圆环'

export type DirectorModelKind = CharacterPose | PropKind | PrimitiveKind

export interface DirectorCamera {
  yaw: number
  pitch: number
  distance: number
}

export interface DirectorObject {
  id: string
  category: DirectorCategory
  kind: DirectorModelKind
  name: string
  /** X / Y(高度) / Z */
  position: [number, number, number]
  rotation: number
  scale: number
  color: string
}

export interface DirectorSceneState {
  objects: DirectorObject[]
  camera: DirectorCamera
  captures: string[]
}

export const DEFAULT_CAMERA: DirectorCamera = {
  yaw: 45,
  pitch: 28,
  distance: 9,
}

export const DEFAULT_SCENE: DirectorSceneState = {
  objects: [],
  camera: { ...DEFAULT_CAMERA },
  captures: [],
}

export function createObjectId() {
  return `ds-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}
