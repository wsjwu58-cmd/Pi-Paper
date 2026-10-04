export type GenerationProgressStatus = 'queued' | 'running'
export type GenerationModality = 'text' | 'image' | 'video' | 'audio' | 'compose'

export interface GenerationReferencePreview {
  /** Already resolved for display by the caller. */
  src: string
  type?: 'image' | 'video'
  poster?: string
  alt?: string
}

export interface GenerationProgressInput {
  taskId: string | number
  status: GenerationProgressStatus
  modality: GenerationModality
  /** The real task createdAt timestamp; no synthetic progress is inferred. */
  startedAt?: string
  /** Only usable upstream reference media should be passed here. */
  references?: readonly GenerationReferencePreview[]
}

const ACTIVE_STATUSES = new Set(['queued', 'running'])
const TERMINAL_STATUSES = new Set([
  'succeeded',
  'success',
  'ready',
  'failed',
  'cancelled',
  'expired',
  'interrupted',
  'settlement_error',
])

export function isGenerationInFlight(status: unknown): status is GenerationProgressStatus {
  return typeof status === 'string' && ACTIVE_STATUSES.has(status.toLowerCase())
}

export function isGenerationTerminal(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status.toLowerCase())
}

/** Match node execution state to the current output task before letting it suppress a task feed update. */
export function resolveGenerationProgressStatus(
  taskStatus: unknown,
  nodeStatus: unknown,
  taskId?: string | number,
  currentOutputId?: string | number,
): GenerationProgressStatus | null {
  if (!isGenerationInFlight(taskStatus)) return null
  const isCurrentTask = taskId != null && currentOutputId != null && String(taskId) === String(currentOutputId)
  if (isGenerationTerminal(nodeStatus) && !isCurrentTask) return null
  return taskStatus.toLowerCase() as GenerationProgressStatus
}

export function getElapsedSeconds(startedAt: string | undefined, now = Date.now()): number | null {
  if (!startedAt) return null
  const start = Date.parse(startedAt)
  if (!Number.isFinite(start)) return null
  return Math.max(0, Math.floor((now - start) / 1000))
}

export function formatElapsedSeconds(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remainder = safeSeconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}
