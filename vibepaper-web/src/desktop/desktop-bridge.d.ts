import type { Edge, Node } from '@xyflow/react'
import type { NodePayload } from '@/lib/types'
import type { AgentChatMsg } from '@/features/canvas/agentTypes'
import type { AgentEventEnvelope } from '@/features/canvas/agentEventEnvelope'

export interface DesktopProject {
  projectId: string
  canvasId: string
  name: string
  updatedAt?: string | null
}

export interface DesktopCanvas {
  projectId: string
  canvasId: string
  version: number
  nodes: Node[]
  edges: Edge[]
  groups: DesktopCanvasGroup[]
  stacks: DesktopCanvasStack[]
}

export interface DesktopCanvasExportDocument {
  schema_version: string
  schemaVersion: string
  canvas: {
    id: string
    name: string
    description: string | null
    schemaVersion: string
    version: number
    createdAt: string
    updatedAt: string | null
  }
  nodes: NodePayload[]
  edges: Array<Omit<DesktopEdgePayload, 'dependencyType'> & { dependencyType: string }>
  groups: DesktopCanvasGroup[]
  stacks: DesktopCanvasStack[]
}

export interface DesktopCanvasGroup {
  id: string
  name: string
  color: string
  layout: string
  nodeIds: string[]
}

export interface DesktopCanvasStack {
  id: string
  collapsed: boolean
  nodeIds: string[]
}

export interface DesktopCanvasScope {
  projectId: string
  canvasId: string
}

export interface DesktopAddGroupInput extends DesktopCanvasScope {
  nodeIds: Array<string | number>
  color?: string | null
}

export interface DesktopUpdateGroupInput extends DesktopCanvasScope {
  groupId: string | number
  name?: string | null
  color?: string | null
  layout?: string | null
  nodeIds?: Array<string | number> | null
}

export interface DesktopDeleteGroupInput extends DesktopCanvasScope {
  groupId: string | number
}

export interface DesktopAddStackInput extends DesktopCanvasScope {
  nodeIds: Array<string | number>
}

export interface DesktopUpdateStackInput extends DesktopCanvasScope {
  stackId: string | number
  collapsed?: boolean | null
}

export interface DesktopExtractFromStackInput extends DesktopCanvasScope {
  stackId: string | number
  nodeId: string | number
}

export interface DesktopDeleteStackInput extends DesktopCanvasScope {
  stackId: string | number
}

export interface DesktopEdgePayload {
  id: string
  sourceNodeId: string
  sourcePort: string
  targetNodeId: string
  targetPort: string
  valid: boolean
  dependencyType: 'reference' | 'input' | 'control'
}

export interface DesktopConnectEdgeResult {
  edge: DesktopEdgePayload
  version: number
  replayed: boolean
}

export interface DesktopCreateNodeInput {
  projectId: string
  canvasId: string
  expectedVersion: number
  idempotencyKey: string
  type: 'text' | 'image' | 'video' | 'audio' | 'compose' | 'director'
  x: number
  y: number
  width?: number
  height?: number
  params?: Record<string, unknown>
  prompt?: string
  modelRef?: string | null
  creativeType?: string | null
}

export interface DesktopCreateNodeResult {
  node: Node
  version: number
  replayed: boolean
}

export interface DesktopUpdateNodeInput {
  projectId: string
  canvasId: string
  expectedVersion: number
  idempotencyKey: string
  nodeId: string
  prompt?: string
  params?: Record<string, unknown>
}

export interface DesktopUpdateNodeResult {
  node: Node
  staleNodes: Array<{
    id: string
    stale: boolean
    execStatus?: string
    nested?: { stale: boolean; execStatus?: string }
  }>
  version: number
  replayed: boolean
}

export interface DesktopDeleteNodeResult {
  deletedNodeId: string
  connectedEdges: string[]
  downstreamNodes: Array<{ id: string; type: string; name: string }>
  canvas: DesktopCanvas
  version: number
}

export interface DesktopAsset {
  assetId: string
  assetType?: 'image' | 'audio'
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'audio/wav'
  sizeBytes: number
  createdAt: string
  updatedAt?: string
  referenceCount: number
}

export interface DesktopAssetDeleteImpact {
  deletedAssetId: string
  references: Array<{ canvasId: string; nodeId: string; type: 'canvas' }>
}

export type DesktopTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type DesktopTaskModality = 'text' | 'image' | 'audio' | 'video' | 'compose'

export interface DesktopTaskSearchQuery {
  page?: number
  pageSize?: number
  keyword?: string
  model?: string
  modality?: '' | DesktopTaskModality
  status?: '' | DesktopTaskStatus
  fromTime?: number
  toTime?: number
}

export interface DesktopTaskSearchResult {
  items: DesktopTask[]
  total: number
  page: number
  pageSize: number
}

export interface DesktopTask {
  taskId: string
  nodeId: string | null
  modality: DesktopTaskModality
  providerType: 'local' | 'cloud'
  providerId?: string
  modelId?: string
  status: DesktopTaskStatus
  attemptCount: number
  errorCode: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  outputPath?: string | null
  outputSizeBytes?: number | null
  outputMeta?: DesktopAudioOutputMeta
}

export interface DesktopAudioOutputMeta {
  index: 0
  outputType: 'audio'
  voiceId: string
  language: string
  rate: number
  toneApplied: boolean
  textHash: string
  durationMs: number
  sampleRate: number
  provider: 'local-sapi-tts'
}

export interface DesktopTaskInputSnapshot {
  task: Pick<DesktopTask, 'taskId' | 'nodeId' | 'modality' | 'providerType' | 'status' | 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt'> & {
    canvasId?: string
    canvasVersion?: number
    providerId?: string
    modelId?: string
  }
  parameters: Record<string, unknown>
}

export interface DesktopAgentSession {
  sessionId: string
  title: string
  createdAt: number
  modifiedAt: number
}

export interface DesktopAgentSkill {
  id: string
  key: string
  name: string
  description: string
  instructions: string
  source: 'builtin' | 'system_dynamic'
  category: string
  version: 1
  enabled: true
}

export interface DesktopAgentMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  id?: string | number
  type?: string
  meta?: AgentChatMsg['meta']
}

export interface DesktopAgentSessionSnapshot {
  messages: DesktopAgentMessage[]
  events: AgentEventEnvelope[]
  lastEventSeq: number
}

export interface DesktopStartAgentRunInput {
  projectId: string
  canvasId: string
  canvasVersion: number
  sessionId: string
  content: string
  selectedNodeIds?: string[]
  selectedSkillId?: string
  modelId?: string
  idempotencyKey: string
}

export interface DesktopConfirmAgentActionInput {
  projectId: string
  canvasId: string
  sessionId: string
  actionId: string
  approvalToken: string
  accept: boolean
  canvasVersion: number
}

export interface DesktopConfirmAgentActionResult {
  actionId: string
  status: 'accepted' | 'rejected'
  lastEventSeq: number
}

export interface DesktopCreateGenerationTaskInput {
  projectId: string
  canvasId: string
  canvasVersion: number
  nodeId: string
  prompt: string
  idempotencyKey: string
  providerType: 'local' | 'cloud'
  modality: 'text' | 'image' | 'audio' | 'video'
  parameters?: Record<string, unknown>
}

export interface DesktopComposeTaskInput {
  projectId: string
  canvasId: string
  canvasVersion: number
  nodeId: string
  idempotencyKey: string
  /** Ordered IDs of connected, locally generated video nodes. */
  inputNodeIds: string[]
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

export interface DesktopLocalAudioModel {
  providerId: 'local-sapi-tts'
  providerType: 'local'
  modelId: 'local-sapi-tts'
  modalities: ['audio']
  inputModes: ['text']
  toolCalling: false
  cancellation: false
  available: boolean
  unavailableReason: string | null
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
  listRecentProjects(): Promise<DesktopProject[]>
  openRecentProject(projectId: string): Promise<DesktopProject>
  createProject(name: string): Promise<DesktopProject | null>
  openProject(): Promise<DesktopProject | null>
  backupProject(projectId: string): Promise<{ name: string } | null>
  restoreBackup(): Promise<DesktopProject | null>
  importLocalAsset(projectId: string): Promise<DesktopAsset | null>
  importImage(projectId: string): Promise<DesktopAsset | null>
  saveTaskOutputToLibrary(projectId: string, taskId: string): Promise<DesktopAsset>
  listAssets(projectId: string): Promise<DesktopAsset[]>
  renameAsset(projectId: string, assetId: string, name: string): Promise<DesktopAsset>
  replaceImage(projectId: string, assetId: string): Promise<DesktopAsset | null>
  replaceAudio(projectId: string, assetId: string): Promise<DesktopAsset | null>
  deleteAsset(projectId: string, assetId: string): Promise<DesktopAssetDeleteImpact>
  loadCanvas(projectId: string, canvasId: string): Promise<DesktopCanvas>
  exportCanvas(projectId: string, canvasId: string): Promise<DesktopCanvasExportDocument>
  createNode(input: DesktopCreateNodeInput): Promise<DesktopCreateNodeResult>
  updateNode(input: DesktopUpdateNodeInput): Promise<DesktopUpdateNodeResult>
  deleteNode(input: {
    projectId: string
    canvasId: string
    expectedVersion: number
    idempotencyKey: string
    nodeId: string
  }): Promise<DesktopDeleteNodeResult>
  saveCanvas(input: {
    projectId: string
    canvasId: string
    expectedVersion: number
    nodes: Node[]
    edges: Edge[]
    groups?: DesktopCanvasGroup[] | null
    stacks?: DesktopCanvasStack[] | null
  }): Promise<{ version: number }>
  connectEdge(input: {
    projectId: string
    canvasId: string
    expectedVersion: number
    idempotencyKey?: string
    sourceNodeId: string
    targetNodeId: string
    sourcePort?: string
    targetPort?: string
    dependencyType?: 'reference' | 'input' | 'control'
  }): Promise<DesktopConnectEdgeResult>
  deleteEdge(input: { projectId: string; canvasId: string; edgeId: string }): Promise<{ status: 'ok' }>
  addGroup(input: DesktopAddGroupInput): Promise<DesktopCanvasGroup>
  updateGroup(input: DesktopUpdateGroupInput): Promise<DesktopCanvasGroup>
  deleteGroup(input: DesktopDeleteGroupInput): Promise<{ status: 'ok' }>
  addStack(input: DesktopAddStackInput): Promise<DesktopCanvasStack>
  updateStack(input: DesktopUpdateStackInput): Promise<DesktopCanvasStack>
  extractFromStack(input: DesktopExtractFromStackInput): Promise<NodePayload>
  deleteStack(input: DesktopDeleteStackInput): Promise<{ status: 'ok' }>
  listTasks(projectId: string, limit?: number): Promise<DesktopTask[]>
  searchTasks(projectId: string, query: DesktopTaskSearchQuery): Promise<DesktopTaskSearchResult>
  getTask(projectId: string, taskId: string): Promise<DesktopTask | null>
  getTaskInput(projectId: string, taskId: string): Promise<DesktopTaskInputSnapshot | null>
  cancelTask(projectId: string, taskId: string): Promise<DesktopTask>
  createGenerationTask(input: DesktopCreateGenerationTaskInput): Promise<DesktopTask | null>
  composeVideos(input: DesktopComposeTaskInput): Promise<DesktopTask>
  readTaskOutput(projectId: string, taskId: string): Promise<string>
  getAgnesModels(): Promise<DesktopAgnesModelCatalog>
  saveAgnesApiKey(apiKey: string): Promise<DesktopAgnesModelCatalog>
  clearAgnesApiKey(): Promise<DesktopAgnesModelCatalog>
  getLocalTextModel(): Promise<DesktopLocalTextModel | null>
  getLocalAudioModel(): Promise<DesktopLocalAudioModel>
  discoverLocalModels(endpoint: string): Promise<string[]>
  saveLocalTextModel(config: Pick<DesktopLocalTextModel, 'endpoint' | 'modelId'>): Promise<DesktopLocalTextModel>
  clearLocalTextModel(): Promise<null>
  listAgentSessions(projectId: string): Promise<DesktopAgentSession[]>
  listAgentSkills(projectId: string, sessionId?: string, keyword?: string): Promise<{
    items: DesktopAgentSkill[]
    loadedSkillIds: string[]
  }>
  createAgentSession(projectId: string, title?: string): Promise<Pick<DesktopAgentSession, 'sessionId' | 'createdAt'>>
  getAgentMessages(projectId: string, sessionId: string): Promise<DesktopAgentMessage[]>
  sendAgentMessage(projectId: string, sessionId: string, content: string, selectedSkillId?: string): Promise<{ assistantText: string }>
  getAgentSessionSnapshot?(projectId: string, sessionId: string): Promise<DesktopAgentSessionSnapshot>
  startAgentRun?(input: DesktopStartAgentRunInput): Promise<{ runId: string }>
  subscribeAgentEvents?(
    projectId: string,
    sessionId: string,
    afterSeq: number,
    listener: (event: AgentEventEnvelope) => void,
  ): () => void
  confirmAgentAction?(input: DesktopConfirmAgentActionInput): Promise<DesktopConfirmAgentActionResult>
  cancelAgentRun?(projectId: string, sessionId: string, runId: string): Promise<void>
}

declare global {
  interface Window {
    vibepaperDesktop?: DesktopBridge
  }
}

export {}
