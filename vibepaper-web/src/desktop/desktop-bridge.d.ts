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

export type DesktopTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export interface DesktopTask {
  taskId: string
  modality: 'text' | 'image' | 'audio' | 'video'
  providerType: 'local' | 'cloud'
  status: DesktopTaskStatus
  attemptCount: number
  errorCode: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface DesktopAgentSession {
  sessionId: string
  createdAt: number
  modifiedAt: number
}

export interface DesktopCreateGenerationTaskInput {
  projectId: string
  canvasId: string
  canvasVersion: number
  nodeId: string
  prompt: string
  idempotencyKey: string
  providerType: 'local' | 'cloud'
  modality: 'text' | 'image' | 'video'
  parameters?: Record<string, unknown>
}

export interface DesktopLocalTextModel {
  providerId: 'local-openai-compatible'
  providerType: 'local'
  endpoint: string
  modelId: string
  modalities: ['text']
  inputModes: ['text']
  toolCalling: false
  streaming: false
  cancellation: false
}

export interface DesktopAgnesModelCatalog {
  providerId: 'agnes'
  providerType: 'cloud'
  apiBaseUrl: 'https://apihub.agnes-ai.com/v1'
  models: { text: 'agnes-2.5-flash'; image: 'agnes-image-2.5-flash'; video: 'agnes-video-2.5-flash' }
  apiKeyConfigured: boolean
  modalities: ['text', 'image', 'video']
  inputModes: { text: ['text']; image: ['text']; video: ['text'] }
  toolCalling: false
  streaming: false
  cancellation: false
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
  listTasks(projectId: string, limit?: number): Promise<DesktopTask[]>
  cancelTask(projectId: string, taskId: string): Promise<DesktopTask>
  createGenerationTask(input: DesktopCreateGenerationTaskInput): Promise<DesktopTask | null>
  readTaskOutput(projectId: string, taskId: string): Promise<string>
  getAgnesModels(): Promise<DesktopAgnesModelCatalog>
  saveAgnesApiKey(apiKey: string): Promise<DesktopAgnesModelCatalog>
  clearAgnesApiKey(): Promise<DesktopAgnesModelCatalog>
  getLocalTextModel(): Promise<DesktopLocalTextModel | null>
  discoverLocalModels(endpoint: string): Promise<string[]>
  saveLocalTextModel(config: Pick<DesktopLocalTextModel, 'endpoint' | 'modelId'>): Promise<DesktopLocalTextModel>
  clearLocalTextModel(): Promise<null>
  listAgentSessions(projectId: string): Promise<DesktopAgentSession[]>
  createAgentSession(projectId: string, title?: string): Promise<Pick<DesktopAgentSession, 'sessionId' | 'createdAt'>>
}

declare global {
  interface Window {
    vibepaperDesktop?: DesktopBridge
  }
}

export {}
