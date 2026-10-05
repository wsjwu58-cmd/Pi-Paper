import type { GenerationTask, NodePayload } from '@/lib/types'
import { isGenerationInFlight, type GenerationModality, type GenerationProgressInput, type GenerationReferencePreview } from './generation-progress'

function timestamp(value?: string): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function compareNewestFirst(
  a: { task: GenerationTask; index: number },
  b: { task: GenerationTask; index: number },
): number {
  const aCreated = timestamp(a.task.createdAt)
  const bCreated = timestamp(b.task.createdAt)
  if (aCreated !== null && bCreated !== null && aCreated !== bCreated) return bCreated - aCreated

  const aUpdated = timestamp(a.task.updatedAt)
  const bUpdated = timestamp(b.task.updatedAt)
  if (aUpdated !== null && bUpdated !== null && aUpdated !== bUpdated) return bUpdated - aUpdated

  const aActive = isGenerationInFlight(a.task.status)
  const bActive = isGenerationInFlight(b.task.status)
  if (aActive !== bActive) return Number(bActive) - Number(aActive)

  // Task feeds are already newest-first. Keep their order when timestamps do
  // not distinguish two terminal tasks, rather than letting a stale node pin
  // override the feed's current record.
  return a.index - b.index
}

export function pickLatestTask(items: GenerationTask[]): GenerationTask | null {
  if (items.length === 0) return null
  return items
    .map((task, index) => ({ task, index }))
    .sort(compareNewestFirst)[0]?.task ?? null
}

export function generationProgressForNode(
  node: NodePayload,
  latest: GenerationTask | null,
  references: GenerationReferencePreview[],
): GenerationProgressInput | null {
  // A fresh in-flight task is authoritative even while the node still carries
  // the previous task's currentOutputId.
  const taskId = latest && isGenerationInFlight(latest.status) ? latest.taskId : node.currentOutputId
  if (taskId == null) return null
  const currentTask = latest && String(latest.taskId) === String(taskId) ? latest : null
  if (currentTask) {
    if (!isGenerationInFlight(currentTask.status)) return null
    return {
      taskId: currentTask.taskId,
      status: currentTask.status as GenerationProgressInput['status'],
      modality: node.type as GenerationModality,
      startedAt: currentTask.createdAt,
      references,
    }
  }

  const nodeStatus = String(node.execStatus || node.status || '').toLowerCase()
  if (!isGenerationInFlight(nodeStatus)) return null
  return {
    taskId,
    status: nodeStatus,
    modality: node.type as GenerationModality,
    references,
  }
}
