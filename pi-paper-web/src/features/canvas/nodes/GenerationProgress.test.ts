import { describe, expect, it } from 'vitest'
import {
  formatElapsedSeconds,
  getElapsedSeconds,
  resolveGenerationProgressStatus,
} from './generation-progress'

describe('generation progress task state', () => {
  it('shows only real queued and running task states', () => {
    expect(resolveGenerationProgressStatus('queued', 'queued', 'task-1', 'task-1')).toBe('queued')
    expect(resolveGenerationProgressStatus('running', 'running', 'task-1', 'task-1')).toBe('running')
    expect(resolveGenerationProgressStatus('succeeded', 'running', 'task-1', 'task-1')).toBeNull()
    expect(resolveGenerationProgressStatus('cancelled', 'cancelled', 'task-1', 'task-1')).toBeNull()
    expect(resolveGenerationProgressStatus('running', 'cancelled', 'task-1', 'task-1')).toBe('running')
    expect(resolveGenerationProgressStatus('running', 'failed', 'task-1', 'task-2')).toBeNull()
    expect(resolveGenerationProgressStatus('running', 'cancelled', 'task-1', 'task-2')).toBeNull()
  })

  it('computes elapsed time from the task timestamp without going below zero', () => {
    expect(getElapsedSeconds('2026-10-04T00:00:00.000Z', Date.parse('2026-10-04T00:00:08.900Z'))).toBe(8)
    expect(getElapsedSeconds('2026-10-04T00:00:10.000Z', Date.parse('2026-10-04T00:00:08.000Z'))).toBe(0)
    expect(getElapsedSeconds(undefined, 100)).toBeNull()
    expect(getElapsedSeconds('invalid-date', 100)).toBeNull()
  })

  it('formats elapsed seconds as minute or hour durations', () => {
    expect(formatElapsedSeconds(0)).toBe('00:00')
    expect(formatElapsedSeconds(74)).toBe('01:14')
    expect(formatElapsedSeconds(3661)).toBe('01:01:01')
  })
})
