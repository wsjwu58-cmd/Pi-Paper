import type { DirectorCamera, DirectorCategory, DirectorModelKind } from './director/types'

export interface CreativeSceneObject {
  category: DirectorCategory
  kind: DirectorModelKind
  name: string
  position: [number, number, number]
  rotation: number
  scale: number
  color: string
}
export interface CreativeScene { objects: CreativeSceneObject[]; camera: DirectorCamera }
export interface CreativeMotion { from: DirectorCamera; to: DirectorCamera; duration: number }
export interface PosterLayout {
  width: number; height: number; background: string
  image: { x: number; y: number; width: number; height: number; fit: 'cover' | 'contain' }
  title: { text: string; x: number; y: number; size: number; color: string }
}
export interface CreativeSelectionCommand { command: 'arrange'; orientation: 'horizontal' | 'vertical'; gap: number }
export type StoryboardField = 'title' | 'type' | 'prompt' | 'camera' | 'content'
export interface CreativeStoryboard { fields: StoryboardField[] }
export interface CreativeMediaTool { tool: 'crop'; mode: 'single' | 'four' | 'nine' }
