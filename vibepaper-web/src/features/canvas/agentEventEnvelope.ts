import type { AgentChatMsg, ExecutionStep } from './agentTypes'

export type AgentEventType =
  | 'assistant_delta'
  | 'reasoning_summary'
  | 'skill_loaded'
  | 'tool_started'
  | 'tool_completed'
  | 'confirmation_required'
  | 'task_status'
  | 'run_completed'
  | 'run_failed'
  | 'run_aborted'

export type AgentEventEnvelope = {
  eventId: string
  runId: string
  sessionId: string
  eventSeq: number
  type: AgentEventType
  runtime: 'pi'
  runtimeVersion: string
  data: Record<string, unknown>
}

export type AgentEventState = {
  messages: AgentChatMsg[]
  seenEventIds: Set<string>
  runStatus: 'running' | 'completed' | 'failed' | 'aborted'
  errorCode?: string
  lastEventType?: AgentEventType
}

export function isAgentEventEnvelope(value: unknown): value is AgentEventEnvelope {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return (
    typeof event.eventId === 'string' &&
    typeof event.runId === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.eventSeq === 'number' &&
    typeof event.type === 'string' &&
    typeof event.runtime === 'string' &&
    typeof event.runtimeVersion === 'string' &&
    !!event.data &&
    typeof event.data === 'object'
  )
}

export function reduceAgentEvent(state: AgentEventState, event: AgentEventEnvelope): AgentEventState {
  if (state.seenEventIds.has(event.eventId)) return state
  const seenEventIds = new Set(state.seenEventIds)
  seenEventIds.add(event.eventId)
  const next: AgentEventState = { ...state, seenEventIds, lastEventType: event.type }
	const assistant = (): AgentChatMsg =>
		[...next.messages].reverse().find((message) => message.role === 'assistant') ?? {
      id: `run-${event.runId}`,
      role: 'assistant',
      type: 'text',
      content: '',
      meta: { executionSteps: [] },
    }
  const updateAssistant = (update: (message: AgentChatMsg) => AgentChatMsg): void => {
    const current = assistant()
    if (next.messages.includes(current)) {
      next.messages = next.messages.map((message) => (message === current ? update(message) : message))
    } else {
      next.messages = [...next.messages, update(current)]
    }
  }

  if (event.type === 'assistant_delta') {
    const delta = typeof event.data.text === 'string' ? event.data.text : ''
    updateAssistant((message) => ({ ...message, content: `${message.content}${delta}` }))
  } else if (event.type === 'reasoning_summary') {
    const summary = typeof event.data.summary === 'string' ? event.data.summary.trim() : ''
    if (summary) {
      updateAssistant((message) => ({
        ...message,
        meta: {
          ...message.meta,
          executionSteps: [
            ...(message.meta?.executionSteps ?? []),
            { id: event.eventId, kind: 'reasoning', label: '思考与计划', summary },
          ],
        },
      }))
    }
  } else if (event.type === 'skill_loaded') {
    const skill = typeof event.data.skill === 'string' ? event.data.skill : 'Skill'
    updateAssistant((message) => ({
      ...message,
      meta: {
        ...message.meta,
        loadedSkills: [...new Set([...(message.meta?.loadedSkills ?? []), skill])],
        executionSteps: [
          ...(message.meta?.executionSteps ?? []),
          { id: event.eventId, kind: 'result', tool: 'load_skill', label: '加载技能', summary: skill, ok: true },
        ],
      },
    }))
  } else if (event.type === 'tool_started' || event.type === 'tool_completed') {
    const tool = typeof event.data.tool === 'string' ? event.data.tool : 'operation'
    const step: ExecutionStep = {
      id: event.eventId,
      kind: event.type === 'tool_started' ? 'plan' : 'result',
      tool,
      label: tool,
      summary: tool,
      ok: event.type === 'tool_completed' ? event.data.ok !== false : undefined,
    }
    updateAssistant((message) => ({
      ...message,
      meta: { ...message.meta, executionSteps: [...(message.meta?.executionSteps ?? []), step] },
    }))
  } else if (event.type === 'confirmation_required') {
    const actionId = typeof event.data.actionId === 'string' ? event.data.actionId : ''
    const approvalToken = typeof event.data.approvalToken === 'string' ? event.data.approvalToken : ''
    if (actionId && approvalToken) {
      updateAssistant((message) => ({
        ...message,
        meta: {
          ...message.meta,
          requiresConfirmation: true,
          confirmation: {
            actionId,
            approvalToken,
            tool: typeof event.data.tool === 'string' ? event.data.tool : undefined,
            summary: typeof event.data.summary === 'string' ? event.data.summary : '待确认操作',
            confirmReason:
              typeof event.data.confirmReason === 'string' ? event.data.confirmReason : undefined,
            estimatedCost: typeof event.data.estimatedCost === 'number' ? event.data.estimatedCost : undefined,
            estimatedTotalCost:
              typeof event.data.estimatedTotalCost === 'number' ? event.data.estimatedTotalCost : undefined,
            canvasVersion: typeof event.data.canvasVersion === 'number' ? event.data.canvasVersion : undefined,
            expiresAt: typeof event.data.expiresAt === 'string' ? event.data.expiresAt : undefined,
            status: 'pending',
          },
        },
      }))
    }
  } else if (event.type === 'task_status') {
    const taskId = typeof event.data.task_id === 'string' ? event.data.task_id : undefined
    const status = typeof event.data.status === 'string' ? event.data.status : undefined
    updateAssistant((message) => ({
      ...message,
      meta: { ...message.meta, taskStatus: { taskId, status, nodeId: typeof event.data.node_id === 'string' ? event.data.node_id : undefined } },
    }))
    if ((status === 'succeeded' || status === 'failed') && !next.messages.some((message) => message.id === `task-${event.eventId}`)) {
      const content = status === 'succeeded'
        ? '生成完成，产物已写回画布节点。'
        : `生成任务未成功完成：${String(event.data.error_code ?? '请稍后重试')}`
      next.messages = [
        ...next.messages,
        {
          id: `task-${event.eventId}`,
          role: 'assistant',
          type: 'text',
          content,
          meta: {
            taskStatus: { taskId, status, nodeId: typeof event.data.node_id === 'string' ? event.data.node_id : undefined },
            executionSteps: [{ id: `speech-${event.eventId}`, kind: 'speech', label: '回复', summary: content }],
          },
        },
      ]
    }
  } else if (event.type === 'run_completed') {
    next.runStatus = 'completed'
    if (typeof event.data.text === 'string') updateAssistant((message) => ({ ...message, content: event.data.text as string }))
  } else if (event.type === 'run_failed' || event.type === 'run_aborted') {
    next.runStatus = event.type === 'run_failed' ? 'failed' : 'aborted'
    next.errorCode = typeof event.data.errorCode === 'string' ? event.data.errorCode : undefined
    updateAssistant((message) => ({
      ...message,
      meta: { ...message.meta, errorCode: next.errorCode, runStatus: next.runStatus },
    }))
  }
  return next
}
