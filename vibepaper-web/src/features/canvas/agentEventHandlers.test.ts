import { describe, expect, it } from 'vitest'
import { reduceAgentEvent, type AgentEventEnvelope, type AgentEventState } from './agentEventEnvelope'
import { shouldRefreshCanvasEvent } from './agentEventHandlers'

const base: AgentEventState = { messages: [], seenEventIds: new Set(), runStatus: 'running' }

function event(type: AgentEventEnvelope['type'], data: Record<string, unknown>, eventId: string = type): AgentEventEnvelope {
  return {
    eventId,
    runId: 'run-1',
    sessionId: 'session-1',
    eventSeq: 1,
    type,
    runtime: 'pi',
    runtimeVersion: '0.1.0',
    data,
  }
}

describe('agent event envelope reducer', () => {
  it('appends only strict assistant deltas and ignores duplicate event ids', () => {
    let state = reduceAgentEvent(base, event('assistant_delta', { text: 'Hel' }))
    state = reduceAgentEvent(state, event('assistant_delta', { text: 'lo' }, 'delta-2'))
    const duplicate = reduceAgentEvent(state, event('assistant_delta', { text: 'ignored' }, 'delta-2'))
    expect(state.messages.at(-1)?.content).toBe('Hello')
    expect(duplicate).toBe(state)
  })

  it('records tool timeline and terminal failures visibly', () => {
    let state = reduceAgentEvent(base, event('tool_started', { tool: 'get_canvas_summary' }, 'tool-1'))
    state = reduceAgentEvent(state, event('tool_completed', { tool: 'get_canvas_summary', ok: true }, 'tool-2'))
    state = reduceAgentEvent(state, event('run_failed', { errorCode: 'MODEL_TIMEOUT' }, 'failed-1'))
    expect(state.messages.at(-1)?.meta?.executionSteps?.map((step) => step.tool)).toEqual([
      'get_canvas_summary',
      'get_canvas_summary',
    ])
    expect(state.runStatus).toBe('failed')
    expect(state.errorCode).toBe('MODEL_TIMEOUT')
  })

  it('refreshes the canvas after an envelope completes a canvas write', () => {
    expect(
      shouldRefreshCanvasEvent(
        event('tool_completed', { tool: 'create_nodes', ok: true }, 'write-1'),
      ),
    ).toBe(true)
  })

  it('shows safe thinking summaries and refreshes queued task state immediately', () => {
    let state = reduceAgentEvent(base, event('reasoning_summary', { summary: '正在核对画布与可用资源。' }, 'think-1'))
    state = reduceAgentEvent(state, event('task_status', { task_id: 'task-1', status: 'queued', node_id: 'node-1' }, 'task-1'))
    expect(state.messages[0]?.meta?.executionSteps?.[0]?.kind).toBe('reasoning')
    expect(state.messages[0]?.meta?.taskStatus?.status).toBe('queued')
    expect(shouldRefreshCanvasEvent(event('task_status', { task_id: 'task-1', status: 'queued' }, 'queued-refresh'))).toBe(true)
  })

  it('adds a completion reply from a terminal task event without reloading messages', () => {
    const state = reduceAgentEvent(base, event('task_status', { task_id: 'task-2', status: 'succeeded' }, 'task-done'))
    expect(state.messages.at(-1)?.content).toContain('生成完成')
  })
})
