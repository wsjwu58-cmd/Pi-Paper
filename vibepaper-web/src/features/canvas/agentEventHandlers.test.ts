import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentTaskBadge, AgentTurnTimeline } from './AgentExecutionRecord'
import { friendlyAgentErrorMessage, isAgentRunActive, mergeSessionMessages, reduceAgentEvent, restoreDesktopAgentEventState, setConfirmationStatus, type AgentEventEnvelope, type AgentEventState } from './agentEventEnvelope'
import { isChatVisibleMessage, shouldRefreshCanvasEvent } from './agentEventHandlers'
import type { AgentChatMsg } from './agentTypes'

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

function eventAtRunSeq(
  runId: string,
  type: AgentEventEnvelope['type'],
  data: Record<string, unknown>,
  eventSeq: number,
  eventId: string,
): AgentEventEnvelope {
  return { ...eventForRun(runId, type, data, eventId), eventSeq }
}

describe('agent event envelope reducer', () => {
  it('appends only strict assistant deltas and ignores duplicate event ids', () => {
    let state = reduceAgentEvent(base, event('assistant_delta', { text: 'Hel' }))
    state = reduceAgentEvent(state, event('assistant_delta', { text: 'lo' }, 'delta-2'))
    const duplicate = reduceAgentEvent(state, event('assistant_delta', { text: 'ignored' }, 'delta-2'))
    expect(state.messages.at(-1)?.content).toBe('Hello')
    expect(duplicate).toBe(state)
  })

  it('keeps the live status active after reply text arrives until the run reaches a terminal event', () => {
    let state = reduceAgentEvent(base, event('assistant_delta', { text: '我先检查画布。' }, 'delta-1'))
    expect(isAgentRunActive(state)).toBe(true)
    state = reduceAgentEvent(state, event('tool_started', { tool: 'get_canvas_summary' }, 'tool-1'))
    expect(isAgentRunActive(state)).toBe(true)
    state = reduceAgentEvent(state, event('run_completed', {}, 'done-1'))
    expect(isAgentRunActive(state)).toBe(false)
  })

  it('tracks activity separately for a continuation run', () => {
    let state = reduceAgentEvent(base, eventForRun('run-1', 'run_completed', {}, 'run-1-done'))
    state = reduceAgentEvent(state, eventForRun('run-2', 'assistant_delta', { text: '继续处理中。' }, 'run-2-delta'))

    expect(isAgentRunActive(state, 'run-1')).toBe(false)
    expect(isAgentRunActive(state, 'run-2')).toBe(true)
  })

  it('keeps the Agent active after a task finishes until the run itself is terminal', () => {
    let state = reduceAgentEvent(base, event('task_status', { status: 'succeeded' }, 'task-finished'))
    expect(isAgentRunActive(state)).toBe(true)
    state = reduceAgentEvent(state, event('run_completed', {}, 'run-finished'))
    expect(isAgentRunActive(state)).toBe(false)
  })

  it('does not let a late task update revive a completed Agent run', () => {
    let state = reduceAgentEvent(base, event('run_completed', {}, 'run-finished'))
    state = reduceAgentEvent(state, event('task_status', { task_id: 'task-1', status: 'succeeded' }, 'task-finished-late'))

    expect(state.runStatusById?.get('run-1')).toBe('completed')
    expect(isAgentRunActive(state)).toBe(false)
  })

  it('adds only non-empty provider thinking events to the execution trace', () => {
    let state = reduceAgentEvent(base, event('thinking', { text: '' }, 'thought-empty'))
    expect(state.messages).toHaveLength(0)
    state = reduceAgentEvent(state, event('thinking', { text: '先检查画布。' }, 'thought-1'))

    expect(state.messages[0]?.meta?.executionSteps).toMatchObject([
      { kind: 'reasoning', label: '推理过程', summary: '先检查画布。' },
    ])
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

  it('shows only bounded activity summaries and hides empty or raw tool details', () => {
    let state = reduceAgentEvent(base, event('tool_started', {
      tool: 'create_nodes',
      args: { summary: '正在创建节点（2 个）', prompt: 'private screenplay', nodeId: 'node-secret' },
    }, 'tool-start-summary'))
    expect(JSON.parse(state.messages[0]?.meta?.executionSteps?.[0]?.detail ?? '{}')).toEqual({ summary: '正在创建节点（2 个）' })

    state = reduceAgentEvent(state, event('tool_completed', {
      tool: 'create_nodes',
      ok: true,
      details: { prompt: 'private screenplay', content: 'private response', assetUrl: 'vibe://private' },
    }, 'tool-complete-raw'))
    expect(state.messages[0]?.meta?.executionSteps?.[1]?.detail).toBeUndefined()

    state = reduceAgentEvent(state, event('tool_started', { tool: 'get_canvas_summary', args: {} }, 'tool-start-empty'))
    expect(state.messages[0]?.meta?.executionSteps?.[2]?.detail).toBeUndefined()
  })

  it('hides raw upstream diagnostics from model failure feedback', () => {
    expect(friendlyAgentErrorMessage('500: Failed to reach upstream (request id: secret)')).toBe('模型服务暂时不可用，请稍后重试。')
    expect(friendlyAgentErrorMessage('模型调用失败')).toBe('模型调用失败')
  })

  it('turns desktop run failure codes into readable messages', () => {
    expect(friendlyAgentErrorMessage('AGENT_MODEL_OUTPUT_LIMIT')).toContain('达到输出上限')
    expect(friendlyAgentErrorMessage('AGENT_MODEL_CONNECTION_FAILED')).toContain('模型连接中断')
    expect(friendlyAgentErrorMessage('AGENT_CONTEXT_SUMMARY_FAILED')).toContain('会话压缩失败')
    expect(friendlyAgentErrorMessage('AGENT_MODEL_REQUEST_FAILED')).toBe('模型请求未完成，本轮已停止。已完成的画布操作已保留，可发送“继续”接着执行。')
    expect(friendlyAgentErrorMessage('AGENT_SESSION_WRITE_FAILED')).toBe('Agent 会话未能保存到本地项目，请检查磁盘空间后重试。')
    expect(friendlyAgentErrorMessage('MODEL_UNAVAILABLE')).toBe('模型服务暂时不可用，请检查服务配置后重试。')
    expect(friendlyAgentErrorMessage('SESSION_BUSY')).toBe('此会话有任务正在运行，请等待当前任务完成。')
    expect(friendlyAgentErrorMessage('SOME_INTERNAL_CODE')).toBe('Agent 执行失败，请稍后重试。')
  })

  it('restores an output-limit failure after a partial reply without reviving the run', () => {
    const trace = [event('thinking', { text: '整理下一步。' }, 'reasoning'), event('run_failed', { errorCode: 'AGENT_MODEL_OUTPUT_LIMIT' }, 'length-failed')]
    const state = restoreDesktopAgentEventState([], trace)
    expect(isAgentRunActive(state)).toBe(false)
    expect(state.messages.at(-1)?.meta).toMatchObject({ runStatus: 'failed', errorCode: 'AGENT_MODEL_OUTPUT_LIMIT' })
    expect(state.messages.at(-1)?.meta?.executionSteps?.[0]?.summary).toBe('整理下一步。')
  })

  it('keeps an empty failed reply visible so its failure reason survives reload', () => {
    const state = restoreDesktopAgentEventState([], [event('run_failed', { errorCode: 'AGENT_MODEL_OUTPUT_LIMIT' }, 'empty-failed')])
    expect(state.messages.filter(isChatVisibleMessage)).toHaveLength(1)
    expect(isChatVisibleMessage({ id: 'empty', role: 'assistant', type: 'text', content: '' })).toBe(false)
  })

  it('replaces a restarted streamed reply instead of appending a duplicate paragraph', () => {
    let state = reduceAgentEvent(base, event('assistant_delta', { text: '你好！我是小P，陪你一起创作。\n\n今天想做什么？' }, 'delta-1'))
    state = reduceAgentEvent(
      state,
      event('assistant_delta', { text: '你好！我是小P，陪你一起创作。\n\n今天想做什么？可以从一张图开始。', replace: true }, 'delta-2'),
    )

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.content).toBe('你好！我是小P，陪你一起创作。\n\n今天想做什么？可以从一张图开始。')
  })

  it('removes repeated openings even when a legacy stream lacks replacement metadata', () => {
    const opening = '《猫鼠大战》分镜概览：第一幕追逐，第二幕设局，第三幕和解。'
    let state = reduceAgentEvent(base, event('assistant_delta', { text: `${opening}\n\n下一步可以做关键帧。` }, 'delta-1'))
    state = reduceAgentEvent(state, event('assistant_delta', { text: `\n\n${opening}\n\n下一步可以做关键帧和分镜。` }, 'delta-2'))

    expect(state.messages[0]?.content).toBe(`${opening}\n\n下一步可以做关键帧和分镜。`)
  })

  it('removes repeated progress phrases that do not repeat the reply opening', () => {
    const created = '10个关键帧节点已创建！'
    const submit = '现在一次性提交生成所有画面 '
    const content = `好的！${created}${submit}🎨${created}${submit}🎨${created}`
    const state = reduceAgentEvent(base, event('assistant_delta', { text: content }, 'delta-1'))

    expect(state.messages[0]?.content).toBe(`好的！${created}${submit.trimEnd()}`)
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

  it('merges a partial streamed reply into its durable reply by run id', () => {
    const persisted = [{
      id: '100', role: 'assistant' as const, type: 'text' as const,
      content: '你好！我是 Agnes，由 Sapiens AI 开发。\n\n我可以继续帮助你创作。',
      meta: { runId: 'run-1' },
    }]
    const runtime = [{
      id: 'run-run-1', role: 'assistant' as const, type: 'text' as const,
      content: '你好！我是 Agnes，由 Sapiens AI 开发。',
      meta: { runId: 'run-1', executionSteps: [{ id: 'tool-1', kind: 'plan' as const, tool: 'get_canvas_summary', label: '读取画布概览', summary: '读取画布概览' }] },
    }]

    const merged = mergeSessionMessages(persisted, runtime)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.content).toBe(persisted[0]?.content)
    expect(merged[0]?.meta?.executionSteps).toEqual(runtime[0]?.meta.executionSteps)
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

  it('keeps a locally confirmed action terminal across a session refresh', () => {
    const pending = [{
      id: 'turn-1', role: 'assistant' as const, type: 'text' as const, content: '请确认生成。',
      meta: { requiresConfirmation: true, confirmation: { actionId: 'action-1', status: 'pending' as const, approvalToken: 'token', summary: '生成' } },
    }]
    const confirmed = setConfirmationStatus(pending, 'action-1', 'accepted')
    const persisted = [{
      id: 'turn-1', role: 'assistant' as const, type: 'text' as const, content: '请确认生成。',
      meta: { confirmation: { actionId: 'action-1', status: 'pending' as const, approvalToken: 'token', summary: '生成' } },
    }]
    const refreshed = mergeSessionMessages(persisted, confirmed)

    expect(confirmed[0]?.meta).toMatchObject({ requiresConfirmation: false, confirmation: { status: 'accepted' } })
    expect(refreshed[0]?.meta?.confirmation?.status).toBe('accepted')
  })

  it('replays accepted confirmation state from task_status and shows task failure details', () => {
    const snapshot: AgentEventState = {
      ...base,
      messages: [{
        id: 'turn-1', role: 'assistant', type: 'text', content: '正在提交生成任务。',
        meta: {
          runId: 'run-1',
          requiresConfirmation: true,
          confirmation: { actionId: 'action-1', approvalToken: 'token', summary: '生成', status: 'pending' },
        },
      }],
    }
    const accepted = reduceAgentEvent(snapshot, event('task_status', {
      actionId: 'action-1', actionStatus: 'accepted', task_id: 'task-1', node_id: 'node-1', status: 'queued',
    }, 'task-queued'))

    expect(accepted.messages[0]?.meta).toMatchObject({
      requiresConfirmation: false,
      confirmation: { actionId: 'action-1', status: 'accepted' },
      taskStatus: { taskId: 'task-1', nodeId: 'node-1', status: 'queued' },
    })

    const failed = reduceAgentEvent(base, event('task_status', {
      task_id: 'task-1', node_id: 'node-1', status: 'failed',
      error_code: 'TASK_OUTPUT_UNAVAILABLE', error_message: '本地任务结果无法读取或校验。',
    }, 'task-failed'))
    expect(failed.messages[0]?.meta?.taskStatus).toMatchObject({
      status: 'failed', errorCode: 'TASK_OUTPUT_UNAVAILABLE', errorMessage: '本地任务结果无法读取或校验。',
    })
    const failureMarkup = renderToStaticMarkup(createElement(AgentTaskBadge, {
      status: failed.messages[0]?.meta?.taskStatus?.status,
      errorCode: failed.messages[0]?.meta?.taskStatus?.errorCode,
      errorMessage: failed.messages[0]?.meta?.taskStatus?.errorMessage,
    }))
    expect(failureMarkup).toContain('生成失败：本地任务结果无法读取或校验。')
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

  it('restores desktop messages by Run, keeping Pi speech in timeline order and one final reply per Run', () => {
    const messages: AgentChatMsg[] = [
      { id: 'user-1', role: 'user', type: 'text', content: '第一轮', meta: { runId: 'run-1' } },
      { id: 'speech-1a', role: 'assistant', type: 'text', content: '先查画布，再告诉你。', meta: { runId: 'run-1' } },
      { id: 'final-1', role: 'assistant', type: 'text', content: '第一轮最终回复。', meta: { runId: 'run-1' } },
      { id: 'user-2', role: 'user', type: 'text', content: '第二轮', meta: { runId: 'run-2' } },
      { id: 'speech-2a', role: 'assistant', type: 'text', content: '正在整理素材。', meta: { runId: 'run-2' } },
      { id: 'speech-2b', role: 'assistant', type: 'text', content: '现在开始执行。', meta: { runId: 'run-2' } },
      { id: 'final-2', role: 'assistant', type: 'text', content: '第二轮最终回复。', meta: { runId: 'run-2' } },
      // A transcript without replayable Run events must retain its native rows.
      { id: 'legacy-a', role: 'assistant', type: 'text', content: '没有事件的旧消息 A。', meta: { runId: 'run-legacy' } },
      { id: 'legacy-b', role: 'assistant', type: 'text', content: '没有事件的旧消息 B。', meta: { runId: 'run-legacy' } },
    ]
    const events = [
      eventAtRunSeq('run-1', 'thinking', { text: '核对画布状态。' }, 1, 'r1-thought-a'),
      eventAtRunSeq('run-1', 'thinking', { text: '核对画布状态。' }, 2, 'r1-thought-b'),
      eventAtRunSeq('run-1', 'assistant_delta', { text: '先查画布，再告诉你。', replace: true }, 3, 'r1-speech-a'),
      eventAtRunSeq('run-1', 'tool_started', { tool: 'get_canvas_summary' }, 4, 'r1-tool-start'),
      eventAtRunSeq('run-1', 'tool_completed', { tool: 'get_canvas_summary', ok: true }, 5, 'r1-tool-done'),
      eventAtRunSeq('run-1', 'thinking', { text: '核对画布状态。' }, 6, 'r1-thought-c'),
      eventAtRunSeq('run-1', 'assistant_delta', { text: '第一轮最终回复。', replace: true }, 7, 'r1-final'),
      eventAtRunSeq('run-1', 'run_completed', { text: '第一轮最终回复。' }, 8, 'r1-complete'),
      eventAtRunSeq('run-2', 'thinking', { text: '先查找可用素材。' }, 9, 'r2-thought-a'),
      eventAtRunSeq('run-2', 'assistant_delta', { text: '正在整理素材。', replace: true }, 10, 'r2-speech-a'),
      eventAtRunSeq('run-2', 'tool_started', { tool: 'search_assets' }, 11, 'r2-tool-start'),
      eventAtRunSeq('run-2', 'tool_completed', { tool: 'search_assets', ok: true }, 12, 'r2-tool-done'),
      eventAtRunSeq('run-2', 'thinking', { text: '选择最合适的素材。' }, 13, 'r2-thought-b'),
      eventAtRunSeq('run-2', 'assistant_delta', { text: '现在开始执行。', replace: true }, 14, 'r2-speech-b'),
      eventAtRunSeq('run-2', 'assistant_delta', { text: '现在开始执行。', replace: true }, 15, 'r2-speech-b-repeat'),
      eventAtRunSeq('run-2', 'tool_started', { tool: 'create_nodes' }, 16, 'r2-tool2-start'),
      eventAtRunSeq('run-2', 'tool_completed', { tool: 'create_nodes', ok: true }, 17, 'r2-tool2-done'),
      eventAtRunSeq('run-2', 'thinking', { text: '总结本轮结果。' }, 18, 'r2-thought-c'),
      eventAtRunSeq('run-2', 'assistant_delta', { text: '第二轮最终回复。', replace: true }, 19, 'r2-final'),
      eventAtRunSeq('run-2', 'run_completed', { text: '第二轮最终回复。' }, 20, 'r2-complete'),
    ].reverse()

    const state = restoreDesktopAgentEventState(messages, events)
    const reopened = restoreDesktopAgentEventState(messages, events)

    expect(state.messages.map((message) => message.id)).toEqual([
      'user-1', 'final-1', 'user-2', 'final-2', 'legacy-a', 'legacy-b',
    ])
    const first = state.messages[1]!
    const second = state.messages[3]!
    expect(first.content).toBe('第一轮最终回复。')
    expect(second.content).toBe('第二轮最终回复。')
    expect(first.meta?.executionSteps?.map((step) => step.kind)).toEqual([
      'reasoning', 'speech', 'plan', 'result', 'reasoning', 'speech',
    ])
    expect(first.meta?.executionSteps?.filter((step) => step.kind === 'reasoning')).toHaveLength(2)
    expect(second.meta?.executionSteps?.map((step) => step.kind)).toEqual([
      'reasoning', 'speech', 'plan', 'result', 'reasoning', 'speech', 'plan', 'result', 'reasoning', 'speech',
    ])
    expect(second.meta?.executionSteps?.filter((step) => step.kind === 'speech').map((step) => step.summary)).toEqual([
      '正在整理素材。', '现在开始执行。', '第二轮最终回复。',
    ])
    expect(state.runStatusById?.get('run-1')).toBe('completed')
    expect(state.runStatusById?.get('run-2')).toBe('completed')
    const stepIds = state.messages.flatMap((message) => message.meta?.executionSteps?.map((step) => step.id) ?? [])
    const reopenedStepIds = reopened.messages.flatMap((message) => message.meta?.executionSteps?.map((step) => step.id) ?? [])
    expect(new Set(stepIds).size).toBe(stepIds.length)
    expect(reopenedStepIds).toEqual(stepIds)
    const markup = renderToStaticMarkup(createElement(AgentTurnTimeline, {
      steps: second.meta?.executionSteps ?? [],
      content: second.content,
    }))
    expect(markup.split('第二轮最终回复。')).toHaveLength(2)
  })

  it('restores equal text from different desktop Runs independently and does not replace a short durable final with cached interim text', () => {
    const repeated = '同一段内容'
    const persisted: AgentChatMsg[] = [
      { id: 'user-1', role: 'user', type: 'text', content: '第一轮', meta: { runId: 'run-1' } },
      { id: 'reply-1', role: 'assistant', type: 'text', content: repeated, meta: { runId: 'run-1' } },
      { id: 'user-2', role: 'user', type: 'text', content: '第二轮', meta: { runId: 'run-2' } },
      { id: 'reply-2', role: 'assistant', type: 'text', content: repeated, meta: { runId: 'run-2' } },
    ]
    const cached: AgentEventState = {
      ...base,
      messages: [
        { id: 'run-run-1', role: 'assistant', type: 'text', content: '这是一段更长但尚未完成的中间发言。', meta: { runId: 'run-1' } },
      ],
      runStatusById: new Map([['run-1', 'completed']]),
      seenEventIds: new Set(['run-1-done']),
    }
    const events = [
      eventAtRunSeq('run-1', 'run_completed', { text: repeated }, 1, 'run-1-done'),
      eventAtRunSeq('run-2', 'run_completed', { text: repeated }, 2, 'run-2-done'),
    ]

    const state = restoreDesktopAgentEventState(persisted, events, cached)

    expect(state.messages.map((message) => message.id)).toEqual(['user-1', 'reply-1', 'user-2', 'reply-2'])
    expect(state.messages[1]?.content).toBe(repeated)
    expect(state.messages[3]?.content).toBe(repeated)
  })

  it('replaces a desktop speech segment when a shorter or differently opened reply arrives before a tool boundary', () => {
    const state = restoreDesktopAgentEventState([
      { id: 'user-1', role: 'user', type: 'text', content: '继续', meta: { runId: 'run-1' } },
    ], [
      eventAtRunSeq('run-1', 'assistant_delta', {
        text: '这是一段较长的中间发言，之后会被模型最终回复替换。', replace: true,
      }, 1, 'interim'),
      eventAtRunSeq('run-1', 'assistant_delta', { text: '短答。', replace: true }, 2, 'short-final'),
      eventAtRunSeq('run-1', 'run_completed', { text: '短答。' }, 3, 'completed'),
    ])

    const assistant = state.messages[1]
    expect(assistant?.content).toBe('短答。')
    expect(assistant?.meta?.executionSteps?.filter((step) => step.kind === 'speech')).toHaveLength(1)
    expect(assistant?.meta?.executionSteps?.find((step) => step.kind === 'speech')?.summary).toBe('短答。')
  })

  it('keeps the same user text as separate turns when Run IDs differ', () => {
    const samePrompt = '帮我检查画布。'
    const state = restoreDesktopAgentEventState([
      { id: 'user-1', role: 'user', type: 'text', content: samePrompt, meta: { runId: 'run-1' } },
      { id: 'reply-1', role: 'assistant', type: 'text', content: '检查完成。', meta: { runId: 'run-1' } },
      { id: 'user-2', role: 'user', type: 'text', content: samePrompt, meta: { runId: 'run-2' } },
      { id: 'reply-2', role: 'assistant', type: 'text', content: '检查完成。', meta: { runId: 'run-2' } },
    ], [
      eventAtRunSeq('run-1', 'run_completed', {}, 1, 'run-1-complete'),
      eventAtRunSeq('run-2', 'run_completed', {}, 2, 'run-2-complete'),
    ])

    expect(state.messages.map((message) => message.id)).toEqual(['user-1', 'reply-1', 'user-2', 'reply-2'])
    expect(state.messages.filter((message) => message.role === 'user' && message.content === samePrompt)).toHaveLength(2)
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
