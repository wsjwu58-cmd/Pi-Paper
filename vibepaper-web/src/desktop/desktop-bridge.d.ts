import type { Edge, Node } from '@xyflow/react'

export interface DesktopProject {
  projectId: string
  canvasId: string
  name: string
}

export interface DesktopCanvas {
  projectId: string
  canvasId: string
  version: number
  nodes: Node[]
  edges: Edge[]
}

export interface DesktopAsset {
  assetId: string
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  sizeBytes: number
  createdAt: string
  referenceCount: number
}

export interface DesktopBridge {
  getActiveProject(): Promise<DesktopProject | null>
  createProject(name: string): Promise<DesktopProject | null>
  openProject(): Promise<DesktopProject | null>
  backupProject(projectId: string): Promise<{ name: string } | null>
  restoreBackup(): Promise<DesktopProject | null>
  importImage(projectId: string): Promise<DesktopAsset | null>
  listAssets(projectId: string): Promise<DesktopAsset[]>
  loadCanvas(projectId: string, canvasId: string): Promise<DesktopCanvas>
  saveCanvas(input: {
    projectId: string
    canvasId: string
    expectedVersion: number
    nodes: Node[]
    edges: Edge[]
  }): Promise<{ version: number }>
}

declare global {
  interface Window {
    vibepaperDesktop?: DesktopBridge
  }
}

export {}
