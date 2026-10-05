import { describe, expect, it } from 'vitest'
import type { GenerationTask, NodePayload } from '@/lib/types'
import { getElapsedSeconds } from './generation-progress'
import { generationProgressForNode, pickLatestTask } from './generation-task-selection'

function task(
  taskId: string,
  status: string,
  createdAt: string,
  updatedAt = createdAt,
): GenerationTask {
  return {
    taskId,
    userId: 'local',
    nodeId: 'node-1',
    canvasId: 'canvas-1',
    modelType: 'video',
    estimatedCost: 0,
    actualCost: 0,
    status,
    retryable: false,
    source: 'desktop',
    createdAt,
    updatedAt,
  }
}

const node: NodePayload = {
  id: 'node-1',
  type: 'video',
  params: {},
  status: 'succeeded',
  execStatus: 'succeeded',
  currentOutputId: 'task-old',
}

describe('generation task selection for node progress', () => {
  it('chooses a new active task over an older currentOutputId when timestamps share a millisecond', () => {
    const createdAt = '2026-10-05T01:02:03.000Z'
    const oldTask = task('task-old', 'succeeded', createdAt)
    const newTask = task('task-new', 'running', createdAt)
    const latest = pickLatestTask([oldTask, newTask])

    expect(latest?.taskId).toBe('task-new')
    const progress = generationProgressForNode(node, latest, [])
    expect(progress).toMatchObject({
      taskId: 'task-new',
      status: 'running',
      startedAt: createdAt,
    })
    expect(getElapsedSeconds(progress?.startedAt, Date.parse('2026-10-05T01:02:15.000Z'))).toBe(12)
  })

  it('does not let an older active task cover a newer completed output', () => {
    const oldRunning = task('task-old-running', 'running', '2026-10-05T01:00:00.000Z')
    const newSuccess = task('task-new-success', 'succeeded', '2026-10-05T01:01:00.000Z')

    expect(pickLatestTask([oldRunning, newSuccess])?.taskId).toBe('task-new-success')
    expect(generationProgressForNode(node, newSuccess, [])).toBeNull()
  })

  it('uses task updatedAt when two tasks were created in the same timestamp tick', () => {
    const createdAt = '2026-10-05T01:02:03.000Z'
    const oldSuccess = task('task-old', 'succeeded', createdAt, createdAt)
    const newFailure = task('task-new', 'failed', createdAt, '2026-10-05T01:02:05.000Z')

    expect(pickLatestTask([oldSuccess, newFailure])?.taskId).toBe('task-new')
  })
})
