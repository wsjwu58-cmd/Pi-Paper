import { describe, expect, it } from 'vitest'
import { mergeSessionMessages, reduceAgentEvent, type AgentEventEnvelope, type AgentEventState } from './agentEventEnvelope'
import { shouldRefreshCanvasEvent } from './agentEventHandlers'

const base: AgentEventState = {
  messages: [], seenEventIds: new Set(), runStatus: 'running', messageIdByRun: new Map(), persistedAssistantRunIds: new Set(),
}

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

function eventForRun(runId: string, type: AgentEventEnvelope['type'], data: Record<string, unknown>, eventId: string): AgentEventEnvelope {
  return { ...event(type, data, eventId), runId }
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

  it('keeps a completed turn intact when a continuation run starts', () => {
    const waiting: AgentEventState = {
      ...base,
      messages: [{ id: 'pending-turn', role: 'assistant', type: 'text', content: '任务已提交，等待生成完成。' }],
      pendingMessageId: 'pending-turn',
      messageIdByRun: new Map(),
    }
    let state = reduceAgentEvent(waiting, eventForRun('run-1', 'tool_started', { tool: 'generate_image' }, 'run-1-tool'))
    state = reduceAgentEvent(state, eventForRun('run-2', 'assistant_delta', { text: '全部任务已完成，继续编排。' }, 'run-2-delta'))

    expect(state.messages).toHaveLength(2)
    expect(state.messages[0]?.content).toBe('任务已提交，等待生成完成。')
    expect(state.messages[1]).toMatchObject({
      id: 'run-run-2',
      content: '全部任务已完成，继续编排。',
      meta: { runId: 'run-2' },
    })
  })

  it('appends a terminal summary without discarding the streamed reply or trace', () => {
    let state = reduceAgentEvent(base, event('thinking', { text: '先核对画布和费用。' }, 'thought-1'))
    state = reduceAgentEvent(state, event('assistant_delta', { text: '我已准备好生成。' }, 'delta-1'))
    state = reduceAgentEvent(state, event('run_completed', { text: '生成完成，产物已写回画布节点。' }, 'done-1'))

    expect(state.messages[0]).toMatchObject({
      content: '我已准备好生成。\n\n生成完成，产物已写回画布节点。',
      meta: { executionSteps: [{ kind: 'reasoning', summary: '先核对画布和费用。' }] },
    })
  })

  it('keeps live execution records when persisted history is reloaded', () => {
    const runtime = [{
      id: 'turn-1', role: 'assistant' as const, type: 'text' as const, content: '我已准备好生成。',
      meta: { executionSteps: [{ id: 'thought', kind: 'reasoning' as const, label: '推理过程', summary: '先核对画布。' }] },
    }]
    const persisted = [{ id: '100', role: 'assistant' as const, type: 'text' as const, content: '我已准备好生成。', meta: {} }]

    expect(mergeSessionMessages(persisted, runtime)[0]?.meta?.executionSteps).toEqual(runtime[0]?.meta.executionSteps)
  })

  it('keeps a terminal persisted confirmation when a reconnect replays its pending event', () => {
    const persisted = [{
      id: 'turn-1', role: 'assistant' as const, type: 'text' as const, content: '请确认生成。',
      meta: { confirmation: { actionId: 'action-1', status: 'accepted' as const, approvalToken: 'token', summary: '已确认' } },
    }]
    const runtime = [{
      id: 'turn-1', role: 'assistant' as const, type: 'text' as const, content: '请确认生成。',
      meta: { confirmation: { actionId: 'action-1', status: 'pending' as const, approvalToken: 'token', summary: '旧事件' } },
    }]

    expect(mergeSessionMessages(persisted, runtime)[0]?.meta?.confirmation?.status).toBe('accepted')
  })

  it('replays persisted run events into the assistant message that owns the run', () => {
    const hydrated: AgentEventState = {
      ...base,
      messages: [{ id: '100', role: 'assistant', type: 'text', content: '生成已准备就绪。', meta: { runId: 'run-1' } }],
      messageIdByRun: new Map(),
    }
    const state = reduceAgentEvent(hydrated, event('tool_started', { tool: 'get_canvas_summary' }, 'replay-tool'))

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.meta?.executionSteps?.[0]).toMatchObject({ tool: 'get_canvas_summary' })
  })

  it('does not append historical text deltas to an already persisted reply', () => {
    const hydrated: AgentEventState = {
      ...base,
      messages: [{ id: '100', role: 'assistant', type: 'text', content: '完整回复。', meta: { runId: 'run-1' } }],
      messageIdByRun: new Map(),
      persistedAssistantRunIds: new Set(['run-1']),
    }
    const state = reduceAgentEvent(hydrated, event('assistant_delta', { text: '完整回复。' }, 'replay-delta'))

    expect(state.messages[0]?.content).toBe('完整回复。')
  })

  it('refreshes the canvas after an envelope completes a canvas write', () => {
    expect(
      shouldRefreshCanvasEvent(
        event('tool_completed', { tool: 'create_nodes', ok: true }, 'write-1'),
      ),
    ).toBe(true)
  })

  it('refreshes and exposes the task badge as soon as a generation is queued', () => {
    const queued = event('task_status', { task_id: 'task-1', node_id: 'node-1', status: 'queued' }, 'task-queued')
    expect(shouldRefreshCanvasEvent(queued)).toBe(true)
    const state = reduceAgentEvent(base, queued)
    expect(state.messages.at(-1)?.meta?.taskStatus).toEqual({
      taskId: 'task-1',
      status: 'queued',
      nodeId: 'node-1',
    })
  })
})
