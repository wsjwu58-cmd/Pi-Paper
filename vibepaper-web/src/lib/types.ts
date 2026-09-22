// VibePaper 前端类型（与后端 OpenAPI 契约对齐）
// Snowflake ID 一律按 string 处理（JSON 可能仍短暂出现 number）

export type Id = string | number;

export interface UserView {
  id: Id;
  email: string;
  phone?: string;
  nickname: string;
  avatarUrl?: string;
  status: string;
  role: string;
  enterpriseId?: Id;
  inviteCode: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  user: UserView;
}

export interface PointAccount {
  balance: number;
  frozenPoints: number;
  availablePoints: number;
}

export interface UserPreference {
  theme: string;
  language: string;
  defaultTextModel?: string;
  defaultImageModel?: string;
  defaultVideoModel?: string;
  defaultResolution?: string;
}

export interface CanvasView {
  id: Id;
  ownerId: Id;
  name: string;
  description?: string;
  schemaVersion: string;
  version: number;
  thumbnailUrl?: string;
  visibility: string;
  shareToken: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NodePayload {
  id: Id;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  params: Record<string, unknown>;
  status: string;
  currentOutputId?: Id;
  groupId?: Id;
  stackId?: Id;
  creativeType?: string;
  stale?: boolean;
  modelRef?: string;
  prompt?: string;
  output?: Record<string, unknown>;
  execStatus?: string;
}

export interface EdgePayload {
  id: Id;
  sourceNodeId: Id;
  sourcePort: string;
  targetNodeId: Id;
  targetPort: string;
  valid: boolean;
}

export interface GroupPayload {
  id: Id;
  name: string;
  color: string;
  layout: string;
  nodeIds: Id[];
}

export interface StackPayload {
  id: Id;
  collapsed: boolean;
  nodeIds: Id[];
}

export interface CanvasDetail {
  canvas: CanvasView;
  nodes: NodePayload[];
  edges: EdgePayload[];
  groups: GroupPayload[];
  stacks: StackPayload[];
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ModelInfo {
  id: Id;
  name: string;
  modelType: string;
  displayName?: string;
  description?: string;
  provider?: string;
  enabled: boolean;
  basePrice: number;
  defaultParams?: Record<string, unknown>;
}

export interface TaskOutput {
  id: Id;
  outputType: string;
  url?: string;
  contentType?: string;
  meta?: Record<string, unknown>;
}

export interface GenerationTask {
  taskId: Id;
  userId: Id;
  nodeId?: Id;
  canvasId?: Id;
  modelType: string;
  modelParams?: Record<string, unknown>;
  estimatedCost: number;
  actualCost: number;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
  source: string;
  prompt?: string;
  outputs?: TaskOutput[];
  createdAt?: string;
  updatedAt?: string;
}

export interface AssetView {
  id: Id;
  ownerId: Id;
  name: string;
  assetType: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  thumbnailUrl?: string;
  status: string;
  enterpriseId?: Id;
  certificationStatus: string;
  certificationReason?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AnnouncementView {
  id: Id;
  title: string;
  content: string;
  publishedAt?: string;
  read: boolean;
}

export interface CheckinResult {
  date: string;
  streak: number;
  rewardPoints: number;
}

export interface DailyTaskView {
  id: Id;
  taskKey: string;
  title: string;
  description: string;
  target: number;
  progress: number;
  rewardPoints: number;
  claimed: boolean;
  completed: boolean;
}

export interface InviteView {
  inviteCode: string;
  inviteLink: string;
  invitedCount: number;
  records: Array<{ inviteeId: Id; inviteeNickname: string; rewardPoints: number; createdAt: string }>;
}

export interface RechargePackage {
  id: Id;
  name: string;
  points: number;
  priceCny: number;
  enabled: boolean;
}

export interface SubscriptionPlan {
  id: Id;
  name: string;
  priceCny: number;
  benefits?: Record<string, unknown>;
  enabled: boolean;
}

export interface PublicationView {
  id: Id;
  canvasId: Id;
  ownerId: Id;
  title: string;
  description?: string;
  status: string;
  thumbnailUrl?: string;
  previewAssetUrl?: string;
  previewAssetType?: string;
  authorName?: string;
  authorAvatar?: string;
  shareWorkflow: boolean;
  publishedAt?: string;
  createdAt?: string;
}

export interface SkillView {
  id: Id;
  name: string;
  description?: string;
  instructions: string;
  source: string;
  category?: string;
  version: number;
  enabled?: boolean;
  ownerId?: Id;
  createdAt?: string;
  updatedAt?: string;
}


export interface MemoryView {
  id: Id;
  content: string;
  memoryType: string;
  createdAt: string;
}

export interface SessionView {
  sessionId: Id;
  title: string;
  canvasId?: Id;
  status: string;
}

export interface LedgerView {
  id: Id;
  userId: Id;
  ledgerType: string;
  direction: string;
  points: number;
  balanceAfter?: number;
  taskId?: Id;
  reference?: string;
  createdAt: string;
}
