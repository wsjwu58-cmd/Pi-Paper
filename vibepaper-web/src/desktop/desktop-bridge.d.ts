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

export type DesktopDramaAssetType =
  | 'series_bible'
  | 'episode'
  | 'scene'
  | 'character_profile'
  | 'character_look'
  | 'shot_spec'
  | 'continuity_constraint'
  | 'audio_cue'
  | 'subtitle_cue'

export interface DesktopDramaAsset {
  id: string
  assetId: string
  canvasId: string
  assetType: DesktopDramaAssetType
  assetVersion: number
  canvasVersion: number
  currentCanvasVersion: number
  data: Record<string, unknown>
  replayed: boolean
  createdAt: string
  updatedAt: string
}

export interface DesktopDramaSeries {
  id: string
  canvasId: string
  activeCanonRevision: number
  format: {
    id: string
    aspectRatio: '9:16'
    targetDurationSeconds: number
    minShotCount: number
    maxShotCount: number
    minShotDurationSeconds: number
    maxShotDurationSeconds: number
    keyframeFirst: true
  }
}

export interface DesktopDramaCharacter {
  id: string
  seriesId: string
  name: string
  identityAnchors: string[]
  activeLookRevision: number
  voiceId: string
}

export interface DesktopDramaReferencePack {
  id: string
  characterId: string
  lookRevision: number
  status: 'draft' | 'approved' | 'retired'
  frontAssetId: string
  sideAssetId: string
  backAssetId: string
  expressionAssetIds: string[]
}

export interface DesktopDramaShotCharacterBinding {
  characterId: string
  lookRevision: number
}

export interface DesktopDramaShot {
  id: string
  seriesId: string
  episodeNo: number
  shotNo: number
  durationSeconds: number
  characterBindings: DesktopDramaShotCharacterBinding[]
  promptRevision: number
}

export interface DesktopDramaKeyframeNodeDraft {
  nodeType: 'image'
  creativeType: 'keyframe'
  shotId: string
  referenceAssetIds: string[]
  referencePackIds: string[]
}

export interface DesktopDramaVideoNodeDraft {
  nodeType: 'video'
  creativeType: 'clip'
  shotId: string
  keyframeRenderId: string
  referencePackIds: string[]
}

export interface DesktopDramaSeriesInput extends DesktopCanvasScope {
  idempotencyKey: string
  series: {
    id?: string
    activeCanonRevision?: number
    format?: DesktopDramaSeries['format']
  }
}

export interface DesktopDramaCharacterInput extends DesktopCanvasScope {
  idempotencyKey: string
  character: Omit<DesktopDramaCharacter, 'id'> & { id?: string }
}

export interface DesktopDramaReferencePackInput extends DesktopCanvasScope {
  idempotencyKey: string
  pack: Omit<DesktopDramaReferencePack, 'id'> & { id?: string }
}

export interface DesktopDramaShotInput extends DesktopCanvasScope {
  idempotencyKey: string
  shot: Omit<DesktopDramaShot, 'id'> & { id?: string }
}

export interface DesktopDramaKeyframeInput extends DesktopCanvasScope {
  idempotencyKey: string
  render: {
    id?: string
    shotId: string
    status: 'draft' | 'accepted' | 'rejected' | 'stale'
    referencePackIds: string[]
  }
}

export interface DesktopDramaLineageInput extends DesktopCanvasScope {
  idempotencyKey: string
  lineage: {
    id?: string
    shotId: string
    keyframeRenderId: string
    status: 'draft' | 'ready_for_video' | 'submitted' | 'stale'
  }
}

export interface DesktopDramaRenderJob {
  id: string
  shotId: string
  keyframeRenderId: string
  canvasNodeId?: string
  durationSeconds: number
  modelType: 'video'
  providerType: 'local' | 'cloud'
  providerId: string
  modelId: string
  modelParams: Record<string, unknown>
  estimatedCost: number
  inputHash: string
  status: 'draft' | 'running' | 'completed' | 'failed'
  taskId?: string
  errorCode?: string
  attempt: number
}

export interface DesktopDramaRenderCandidate {
  seriesId: string
  episodeNo: number
  shotId: string
  shotNo: number
  durationSeconds: number
  keyframeRenderId: string
  canvasNodeId: string
  prompt: string
  providerType: 'local' | 'cloud'
  providerId: string
  modelId: string
  modelParams: Record<string, unknown>
  available: boolean
  unavailableReasonCode?: string | null
  unavailableReason?: string | null
}

export interface DesktopDramaRenderConfirmationJob {
  id: string
  shotId: string
  canvasNodeId: string
  keyframeRenderId: string
  durationSeconds: number
  providerType: 'local' | 'cloud'
  providerId: string
  modelId: string
  prompt: string
}

export interface DesktopDramaRenderConfirmation {
  actionId: string
  token: string
  expiresAt: string
  operation: 'submit' | 'rerun'
  batchId: string
  canvasVersion: number
  contentHash: string
  jobs: DesktopDramaRenderConfirmationJob[]
}

export interface DesktopDramaRenderBatchCreateInput extends DesktopCanvasScope {
  idempotencyKey: string
  seriesId: string
  episodeNo: number
  canvasVersion: number
  jobs: Array<Pick<DesktopDramaRenderCandidate,
    'shotId' | 'keyframeRenderId' | 'canvasNodeId' | 'durationSeconds' | 'providerType' | 'providerId' | 'modelId' | 'modelParams'
  > & { modelType: 'video' }>
}

export interface DesktopDramaRenderBatchConfirmationInput extends DesktopCanvasScope {
  batchId: string
  operation?: 'submit' | 'rerun'
  jobId?: string
}

export interface DesktopDramaRenderBatchActionInput extends DesktopCanvasScope {
  batchId: string
  actionId: string
  token: string
  canvasVersion: number
}

export interface DesktopDramaRenderBatch {
  id: string
  canvasId: string
  seriesId: string
  episodeNo: number
  estimatedCost: number
  status: 'draft' | 'awaiting_approval' | 'running' | 'partial' | 'completed' | 'failed'
  sessionId?: string
  canvasVersion?: number
  approvalActionId?: string
  jobs: DesktopDramaRenderJob[]
  createdAt: string
  updatedAt: string
}

export interface DesktopRenderReview {
  id: string
  canvas_id: string
  user_id: string
  target_node_id: string
  target_kind: string
  scores: Record<string, unknown>
  failures: Array<{ ruleId: string; severity: 'error' | 'warning'; evidence: string }>
  recommended_action: string
  evidence: Record<string, unknown>
  retry_count: number
  status: 'pass' | 'fail'
  source_task_id?: string
  created_at: string
}

export interface DesktopUpsertDramaAssetInput extends DesktopCanvasScope {
  canvasVersion: number
  idempotencyKey: string
  assetType: DesktopDramaAssetType
  assetId?: string | number
  data: Record<string, unknown>
}

export interface DesktopAgentUsage {
  sessionId: string
  tokenTotal: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  summaryTokens: number
  toolResultTokens: number
  modelCallCount: number
  summaryCallCount: number
  toolCallCount: number
  modelUsage: Record<string, number>
  modelCalls: Record<string, number>
}

export type DesktopMemoryScope = 'session' | 'canvas' | 'project' | 'global' | 'daily'

export interface DesktopAgentMemory {
  id: string
  content: string
  memoryType: string
  scope: DesktopMemoryScope
  sessionId?: string
  canvasId?: string
  confidence: number
  source: string
  version: number
  createdAt: string
  expiresAt?: string
}

export interface DesktopAgentMemoryCandidate {
  id: string
  content: string
  memoryType: string
  scope: DesktopMemoryScope
  sessionId?: string
  canvasId?: string
  confidence: number
  createdAt: string
}

export interface DesktopAgentSessionFragment {
  id: string
  title: string
  canvasId: string | null
  createdAt: string
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

export interface DesktopCanvasImportResult {
  project: DesktopProject
  warnings: string[]
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
  assetType: 'image' | 'video' | 'audio' | 'text'
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
    | 'video/mp4' | 'video/quicktime' | 'video/webm'
    | 'audio/wav' | 'audio/mpeg' | 'audio/ogg' | 'audio/mp4'
    | 'text/plain' | 'text/markdown'
  sizeBytes: number
  createdAt: string
  updatedAt?: string
  referenceCount: number
}

export interface DesktopAssetImportResult {
  assets: DesktopAsset[]
  errors: Array<{ name: string; message: string }>
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
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  outputPath?: string | null
  outputSizeBytes?: number | null
  outputMeta?: DesktopAudioOutputMeta
  outputs?: DesktopTaskOutput[]
}

export interface DesktopTaskOutput {
  index: number
  url?: string
  outputMeta: Record<string, unknown> | null
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
  source: 'builtin' | 'system_dynamic' | 'project'
  category: string
  version: number
  enabled: boolean
}

export interface DesktopAgentMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  id?: string | number
  type?: string
  meta?: NonNullable<AgentChatMsg['meta']> & { runId?: string }
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
  providerId?: 'agnes' | 'volcengine-ark'
  modelId?: string
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

export interface DesktopArkModelCatalog {
  providerId: 'volcengine-ark'
  providerType: 'cloud'
  apiBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
  models: { video: 'doubao-seedance-2-5-260628' }
  apiKeyConfigured: boolean
  modalities: ['video']
  inputModes: { video: ['text', 'image', 'video', 'audio'] }
  toolCalling: false
  streaming: false
  cancellation: false
}

export interface DesktopBridge {
  getActiveProject(): Promise<DesktopProject | null>
  listRecentProjects(): Promise<DesktopProject[]>
  openRecentProject(projectId: string): Promise<DesktopProject>
  renameProject(projectId: string, name: string): Promise<DesktopProject>
  deleteProject(projectId: string): Promise<boolean>
  createProject(name: string): Promise<DesktopProject | null>
  openProject(): Promise<DesktopProject | null>
  backupProject(projectId: string): Promise<{ name: string } | null>
  restoreBackup(): Promise<DesktopProject | null>
  importLocalAsset(projectId: string): Promise<DesktopAsset | null>
  importLocalAssets(projectId: string): Promise<DesktopAssetImportResult | null>
  importImage(projectId: string): Promise<DesktopAsset | null>
  saveTaskOutputToLibrary(projectId: string, taskId: string): Promise<DesktopAsset>
  saveDirectorCapture(input: {
    projectId: string
    canvasId: string
    nodeId: string
    pngBytes: Uint8Array
  }): Promise<{ assetId: string; url: string }>
  listAssets(projectId: string): Promise<DesktopAsset[]>
  renameAsset(projectId: string, assetId: string, name: string): Promise<DesktopAsset>
  replaceImage(projectId: string, assetId: string): Promise<DesktopAsset | null>
  replaceAudio(projectId: string, assetId: string): Promise<DesktopAsset | null>
  replaceAsset(projectId: string, assetId: string): Promise<DesktopAsset | null>
  deleteAsset(projectId: string, assetId: string): Promise<DesktopAssetDeleteImpact>
  loadCanvas(projectId: string, canvasId: string): Promise<DesktopCanvas>
  listDramaAssets(projectId: string, canvasId: string, filters?: {
    assetType?: DesktopDramaAssetType
    episodeId?: string
    sceneId?: string
    shotId?: string
  }): Promise<{ items: DesktopDramaAsset[] }>
  upsertDramaAsset(input: DesktopUpsertDramaAssetInput): Promise<DesktopDramaAsset>
  createDramaSeries(input: DesktopDramaSeriesInput): Promise<DesktopDramaSeries>
  createDramaCharacter(input: DesktopDramaCharacterInput): Promise<DesktopDramaCharacter>
  addDramaReferencePack(input: DesktopDramaReferencePackInput): Promise<DesktopDramaReferencePack>
  createDramaShot(input: DesktopDramaShotInput): Promise<DesktopDramaShot>
  prepareDramaKeyframeNode(input: DesktopCanvasScope & { shotId: string }): Promise<DesktopDramaKeyframeNodeDraft>
  recordDramaKeyframe(input: DesktopDramaKeyframeInput): Promise<DesktopDramaKeyframeInput['render']>
  prepareDramaVideoNode(input: DesktopCanvasScope & { shotId: string }): Promise<DesktopDramaVideoNodeDraft>
  recordDramaLineage(input: DesktopDramaLineageInput): Promise<DesktopDramaLineageInput['lineage']>
  staleDramaLineagesForCharacter(input: DesktopCanvasScope & { idempotencyKey: string; characterId: string }): Promise<string[]>
  listDramaRenderBatches(projectId: string, canvasId: string): Promise<{ items: DesktopDramaRenderBatch[] }>
  getDramaRenderBatch(projectId: string, canvasId: string, batchId: string): Promise<DesktopDramaRenderBatch>
  listDramaRenderCandidates(projectId: string, canvasId: string): Promise<{ items: DesktopDramaRenderCandidate[] }>
  createDramaRenderBatch(input: DesktopDramaRenderBatchCreateInput): Promise<DesktopDramaRenderBatch>
  prepareDramaRenderBatchConfirmation(input: DesktopDramaRenderBatchConfirmationInput): Promise<{
    batch: DesktopDramaRenderBatch
    confirmation: DesktopDramaRenderConfirmation
  }>
  submitDramaRenderBatch(input: DesktopDramaRenderBatchActionInput): Promise<DesktopDramaRenderBatch>
  rejectDramaRenderBatchConfirmation(input: Omit<DesktopDramaRenderBatchActionInput, 'canvasVersion'>): Promise<{ rejected: true }>
  rerunDramaRenderBatchJob(input: DesktopCanvasScope & { batchId: string; jobId: string }): Promise<{
    batch: DesktopDramaRenderBatch
    confirmation: DesktopDramaRenderConfirmation
  }>
  listRenderReviews(projectId: string, canvasId: string, targetNodeId?: string): Promise<{ items: DesktopRenderReview[] }>
  createRenderReview(input: DesktopCanvasScope & {
    targetNodeId: string
    targetKind?: string
    shotDurationSeconds: number
    expectedDurationSeconds: number
    characterConsistent: boolean
    audioDurationMs: number
    videoDurationMs: number
    previousCamera: string
    currentCamera: string
    retryCount?: number
  }): Promise<Record<string, unknown>>
  exportCanvas(projectId: string, canvasId: string): Promise<DesktopCanvasExportDocument>
  importCanvasDocument(document: DesktopCanvasExportDocument): Promise<DesktopCanvasImportResult | null>
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
    idempotencyKey?: string
    nodes: Node[]
    edges: Edge[]
    groups?: DesktopCanvasGroup[] | null
    stacks?: DesktopCanvasStack[] | null
  }): Promise<{ version: number; staleNodeIds: string[] }>
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
  retryTask(projectId: string, taskId: string): Promise<DesktopTask>
  createGenerationTask(input: DesktopCreateGenerationTaskInput): Promise<DesktopTask | null>
  composeVideos(input: DesktopComposeTaskInput): Promise<DesktopTask>
  readTaskOutput(projectId: string, taskId: string): Promise<string>
  getAgnesModels(): Promise<DesktopAgnesModelCatalog>
  saveAgnesApiKey(apiKey: string): Promise<DesktopAgnesModelCatalog>
  clearAgnesApiKey(): Promise<DesktopAgnesModelCatalog>
  getArkModels(): Promise<DesktopArkModelCatalog>
  saveArkApiKey(apiKey: string): Promise<DesktopArkModelCatalog>
  clearArkApiKey(): Promise<DesktopArkModelCatalog>
  getLocalTextModel(): Promise<DesktopLocalTextModel | null>
  getLocalAudioModel(): Promise<DesktopLocalAudioModel>
  discoverLocalModels(endpoint: string): Promise<string[]>
  saveLocalTextModel(config: Pick<DesktopLocalTextModel, 'endpoint' | 'modelId'>): Promise<DesktopLocalTextModel>
  clearLocalTextModel(): Promise<null>
  listAgentSessions(projectId: string): Promise<DesktopAgentSession[]>
  listAgentFragments(projectId: string): Promise<{ items: DesktopAgentSessionFragment[] }>
  saveAgentSessionFragment(projectId: string, sessionId: string, title?: string): Promise<{ fragmentId: string }>
  importAgentFragment(projectId: string, fragmentId: string, canvasId?: string): Promise<{ sessionId: string }>
  listAgentMemories(projectId: string, scope?: DesktopMemoryScope, sessionId?: string): Promise<{ items: DesktopAgentMemory[] }>
  createAgentMemory(projectId: string, content: string, scope?: DesktopMemoryScope, sessionId?: string): Promise<DesktopAgentMemory>
  updateAgentMemory(projectId: string, memoryId: string, content: string, scope?: DesktopMemoryScope, sessionId?: string): Promise<DesktopAgentMemory>
  deleteAgentMemory(projectId: string, memoryId: string, scope?: DesktopMemoryScope, sessionId?: string): Promise<{ status: 'ok' }>
  exportAgentMemories(projectId: string): Promise<{ schemaVersion: 1; exportedAt: string; items: DesktopAgentMemory[] }>
  listAgentMemoryCandidates(projectId: string): Promise<{ items: DesktopAgentMemoryCandidate[] }>
  reviewAgentMemoryCandidate(projectId: string, candidateId: string, action: 'accept' | 'reject'): Promise<{
    status: 'accepted' | 'rejected'
    item?: DesktopAgentMemory
  }>
  listAgentSkills(projectId: string, sessionId?: string, keyword?: string): Promise<{
    items: DesktopAgentSkill[]
    loadedSkillIds: string[]
  }>
  createAgentSkill(projectId: string, draft: Pick<DesktopAgentSkill, 'name' | 'description' | 'instructions' | 'category'>): Promise<DesktopAgentSkill>
  updateAgentSkill(projectId: string, skillId: string, patch: Partial<Pick<DesktopAgentSkill, 'name' | 'description' | 'instructions' | 'category' | 'enabled'>>): Promise<DesktopAgentSkill>
  deleteAgentSkill(projectId: string, skillId: string): Promise<{ status: 'ok' }>
  importAgentSkill(projectId: string): Promise<DesktopAgentSkill | null>
  createAgentSession(projectId: string, title?: string): Promise<Pick<DesktopAgentSession, 'sessionId' | 'createdAt'>>
  getAgentMessages(projectId: string, sessionId: string): Promise<DesktopAgentMessage[]>
  getAgentUsage(projectId: string, sessionId: string): Promise<DesktopAgentUsage>
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
  cancelAgentRun?(projectId: string, sessionId: string, runId: string): Promise<{ cancelled: boolean }>
}

declare global {
  interface Window {
    vibepaperDesktop?: DesktopBridge
  }
}

export {}
