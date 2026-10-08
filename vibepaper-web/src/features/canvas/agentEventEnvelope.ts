import type { AgentChatMsg, AgentConfirmation, ExecutionStep } from './agentTypes'
import { stepFromThinking, toolLabel } from './agentTypes'
import { normalizeConfirmationExpiry } from './confirmationState'

export type AgentEventType =
  | 'assistant_delta'
  | 'thinking'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_retry'
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
  /** Durable event time, exposed as epoch milliseconds by the desktop Worker. */
  createdAt?: number
}

export type AgentEventState = {
  messages: AgentChatMsg[]
  seenEventIds: Set<string>
  runStatus: 'running' | 'completed' | 'failed' | 'aborted'
  /** Most recent event owner, used to restore the correct live status on reload. */
  lastEventRunId?: string
  /** A session can contain several runs; keep their terminal state separate. */
  runStatusById?: Map<string, 'running' | 'waiting_confirmation' | 'completed' | 'failed' | 'aborted'>
  errorCode?: string
  lastEventType?: AgentEventType
  pendingMessageId?: string | number
  messageIdByRun: Map<string, string | number>
  /** Runs whose complete assistant reply already came from durable history. */
  persistedAssistantRunIds: Set<string>
  /** Text reconstructed from assistant deltas, used to restore desktop speech segments. */
  assistantTextByRun?: Map<string, string>
}

export function isAgentEventEnvelope(value: unknown): value is AgentEventEnvelope {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return typeof event.eventId === 'string' && typeof event.runId === 'string' &&
    typeof event.sessionId === 'string' && typeof event.eventSeq === 'number' &&
    typeof event.type === 'string' && typeof event.runtime === 'string' &&
    typeof event.runtimeVersion === 'string' && !!event.data && typeof event.data === 'object'
}

/** Keep provider diagnostics and raw gateway responses out of the chat UI. */
export function friendlyAgentErrorMessage(value: unknown): string {
  const message = typeof value === 'string' ? value.trim() : ''
  const knownErrors: Record<string, string> = {
    AGENT_MODEL_TIMEOUT: '模型响应超时，请稍后重试。',
    AGENT_MODEL_OUTPUT_LIMIT: '模型回复达到输出上限，自动续跑仍未完成。已完成的画布操作已保留，请发送“继续”从当前进度接着执行。',
    AGENT_MODEL_CONNECTION_FAILED: '模型连接中断，本轮已停止。已完成的画布操作已保留，请检查网络后发送“继续”。',
    AGENT_CONTEXT_SUMMARY_FAILED: '会话压缩失败，本轮已停止。已完成的画布操作已保留，请稍后重试。',
    AGENT_CONTEXT_WINDOW_EXCEEDED: '当前请求超出模型上下文容量，请减少本轮引用或拆分创作要求。',
    MODEL_TIMEOUT: '模型响应超时，请稍后重试。',
    MODEL_UNAVAILABLE: '模型服务暂时不可用，请检查服务配置后重试。',
    AGENT_MODEL_REQUEST_FAILED: '模型请求未完成，本轮已停止。已完成的画布操作已保留，可发送“继续”接着执行。',
    CLOUD_CREDENTIAL_MISSING: '请先配置 Agnes API Key。',
    AGENT_SESSION_WRITE_FAILED: 'Agent 会话未能保存到本地项目，请检查磁盘空间后重试。',
    AGENT_RUN_RESULT_MISSING: 'Agent 未能恢复本轮回复，请重新发送。',
    AGENT_RUN_ALREADY_PROCESSED: '这条消息已处理，请检查会话记录后再继续。',
    SESSION_BUSY: '此会话有任务正在运行，请等待当前任务完成。',
    CONFIRMATION_REQUIRED: '请先处理当前待确认的操作。',
  }
  const knownError = Object.prototype.hasOwnProperty.call(knownErrors, message) ? knownErrors[message] : undefined
  if (knownError) return knownError
  if (/do_request_failed|failed to reach upstream|agnesai_error|upstream|^500\s*:/i.test(message)) {
    return '模型服务暂时不可用，请稍后重试。'
  }
  if (/timeout|timed out|超时/i.test(message)) return '模型响应超时，请稍后重试。'
  if (/^[A-Z][A-Z0-9_]{1,79}$/u.test(message)) return 'Agent 执行失败，请稍后重试。'
  return message || '模型调用失败，请稍后重试。'
}

export function reduceAgentEvent(
  state: AgentEventState,
  event: AgentEventEnvelope,
  options: { recordAssistantSpeech?: boolean } = {},
): AgentEventState {
  if (state.seenEventIds.has(event.eventId)) return state
  const next: AgentEventState = {
    ...state,
    seenEventIds: new Set([...state.seenEventIds, event.eventId]),
    messageIdByRun: new Map(state.messageIdByRun),
    persistedAssistantRunIds: new Set(state.persistedAssistantRunIds),
    assistantTextByRun: new Map(state.assistantTextByRun),
    lastEventRunId: event.runId,
    runStatusById: new Map(state.runStatusById),
    lastEventType: event.type,
  }
  if (event.type === 'confirmation_required') {
    next.runStatusById?.set(event.runId, 'waiting_confirmation')
  } else if (event.type === 'run_completed') {
    next.runStatusById?.set(event.runId, 'completed')
  } else if (event.type === 'run_failed') {
    next.runStatusById?.set(event.runId, 'failed')
  } else if (event.type === 'run_aborted') {
    next.runStatusById?.set(event.runId, 'aborted')
  } else if (event.type === 'task_status') {
    // A generation task can finish while the Agent still has to report its
    // result or continue the conversation. Keep an already-terminal run
    // terminal when its task status arrives later.
    const runStatus = state.runStatusById?.get(event.runId)
    if (!runStatus || runStatus === 'running' || runStatus === 'waiting_confirmation') {
      next.runStatusById?.set(event.runId, 'running')
    }
  } else {
    next.runStatusById?.set(event.runId, 'running')
  }
  const assistant = (): AgentChatMsg => {
    const knownId = next.messageIdByRun.get(event.runId)
    const existing = next.messages.find((message) => message.id === knownId) ??
      (knownId == null
        ? next.messages.find((message) =>
          message.id === next.pendingMessageId ||
          (message.role === 'assistant' && message.meta?.runId === event.runId),
        )
        : undefined)
    if (existing?.role === 'assistant') {
      next.messageIdByRun.set(event.runId, existing.id)
      next.pendingMessageId = undefined
      return existing
    }
    const created: AgentChatMsg = {
      id: `run-${event.runId}`,
      role: 'assistant',
      type: 'text',
      content: '',
      meta: { executionSteps: [], runId: event.runId },
    }
    next.messageIdByRun.set(event.runId, created.id)
    return created
  }
  const updateAssistant = (update: (message: AgentChatMsg) => AgentChatMsg): void => {
    const current = assistant()
    if (next.messages.includes(current)) {
      next.messages = next.messages.map((message) => (message === current ? update(message) : message))
      return
    }
    const anchorIndex = next.messages.findIndex((message) =>
      message.role === 'user' && message.meta?.runId === event.runId,
    )
    const updated = update(current)
    next.messages = anchorIndex < 0
      ? [...next.messages, updated]
      : [...next.messages.slice(0, anchorIndex + 1), updated, ...next.messages.slice(anchorIndex + 1)]
  }
  const withRun = (message: AgentChatMsg): AgentChatMsg['meta'] => ({ ...message.meta, runId: event.runId })

  if (event.type === 'assistant_delta') {
    const delta = typeof event.data.text === 'string' ? event.data.text : ''
    const replace = event.data.replace === true
    const previousRunText = next.assistantTextByRun?.get(event.runId) ?? ''
    const streamedText = dedupeRepeatedSegments(removeRepeatedOpening(replace ? delta : `${previousRunText}${delta}`))
    if (options.recordAssistantSpeech) next.assistantTextByRun?.set(event.runId, streamedText)
    if (options.recordAssistantSpeech && streamedText.trim()) {
      updateAssistant((message) => ({
        ...message,
        meta: {
          ...message.meta,
          runId: event.runId,
          executionSteps: upsertRunSpeech(message.meta?.executionSteps ?? [], streamedText, event),
        },
      }))
    }
    // Historical deltas restore the execution record after refresh. The
    // durable assistant message already contains their complete visible text.
    if (!next.persistedAssistantRunIds.has(event.runId)) {
      updateAssistant((message) => ({
        ...message,
        meta: withRun(message),
        content: options.recordAssistantSpeech
          ? streamedText
          : dedupeRepeatedSegments(removeRepeatedOpening(replace ? delta : `${message.content}${delta}`)),
      }))
    }
  } else if (event.type === 'thinking') {
    const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
    if (text) updateAssistant((message) => ({
      ...message,
      meta: {
        ...withRun(message),
        executionSteps: options.recordAssistantSpeech
          ? upsertRunReasoning(message.meta?.executionSteps ?? [], text, event)
          : appendReasoning(message.meta?.executionSteps ?? [], text),
      },
    }))
  } else if (event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_retry') {
    const tool = typeof event.data.tool === 'string' ? event.data.tool : 'operation'
    const retry = event.type === 'tool_retry'
    const detail = printablePayload(retry ? event.data : event.type === 'tool_started' ? event.data.args : event.data.details)
    const step: ExecutionStep = {
      id: event.eventId,
      kind: event.type === 'tool_completed' ? 'result' : 'plan',
      tool,
      label: toolLabel(tool),
      summary: retry ? `重试中（第 ${numberValue(event.data.attempt) ?? 2}/${numberValue(event.data.maxAttempts) ?? 3} 次）` : toolLabel(tool),
      ok: event.type === 'tool_completed' ? event.data.ok !== false : undefined,
      detail,
      rawDetail: detail,
      attempt: numberValue(event.data.attempt),
      maxAttempts: numberValue(event.data.maxAttempts),
    }
    updateAssistant((message) => ({ ...message, meta: { ...withRun(message), executionSteps: [...(message.meta?.executionSteps ?? []), step] } }))
  } else if (event.type === 'confirmation_required') {
    const actionId = typeof event.data.actionId === 'string' ? event.data.actionId : ''
    const approvalToken = typeof event.data.approvalToken === 'string' ? event.data.approvalToken : ''
    if (actionId && approvalToken) updateAssistant((message) => ({
      ...message,
      meta: { ...withRun(message), requiresConfirmation: true, confirmation: {
        actionId, approvalToken,
        kind: event.data.kind === 'canvas_delete' ? 'canvas_delete' : 'generation',
        nodeLabels: Array.isArray(event.data.nodeLabels) ? event.data.nodeLabels.filter((label): label is string => typeof label === 'string').slice(0, 20).map((label) => label.slice(0, 120)) : undefined,
        connectedEdgeCount: numberValue(event.data.connectedEdgeCount),
        downstreamNodeCount: numberValue(event.data.downstreamNodeCount),
        affectedGroupCount: numberValue(event.data.affectedGroupCount),
        affectedStackCount: numberValue(event.data.affectedStackCount),
        tool: typeof event.data.tool === 'string' ? event.data.tool : undefined,
        summary: typeof event.data.summary === 'string' ? event.data.summary : '待确认操作',
        confirmReason: typeof event.data.confirmReason === 'string' ? event.data.confirmReason : undefined,
        estimatedCost: numberValue(event.data.estimatedCost),
        estimatedTotalCost: numberValue(event.data.estimatedTotalCost),
        affectedNodeCount: numberValue(event.data.affectedNodeCount) ?? numberValue(event.data.nodeCount),
        generationItems: generationItemsFrom(event.data.generationItems),
        canvasVersion: numberValue(event.data.canvasVersion),
        expiresAt: normalizeConfirmationExpiry(event.data.expiresAt),
        status: 'pending',
      } },
    }))
  } else if (event.type === 'task_status') {
    const actionId = typeof event.data.actionId === 'string' ? event.data.actionId : undefined
    const actionStatus = event.data.actionStatus === 'accepted' || event.data.actionStatus === 'rejected'
      ? event.data.actionStatus
      : undefined
    updateAssistant((message) => ({
      ...message,
      meta: {
        ...withRun(message),
        taskStatus: {
          taskId: typeof event.data.task_id === 'string' ? event.data.task_id : typeof event.data.taskId === 'string' ? event.data.taskId : undefined,
          status: typeof event.data.status === 'string' ? event.data.status : undefined,
          nodeId: typeof event.data.node_id === 'string' ? event.data.node_id : typeof event.data.nodeId === 'string' ? event.data.nodeId : undefined,
          errorCode: typeof event.data.error_code === 'string' ? event.data.error_code : typeof event.data.errorCode === 'string' ? event.data.errorCode : undefined,
          errorMessage: typeof event.data.error_message === 'string' ? event.data.error_message : typeof event.data.errorMessage === 'string' ? event.data.errorMessage : undefined,
        },
        ...(actionId && actionStatus && message.meta?.confirmation?.actionId === actionId
          ? { requiresConfirmation: false, confirmation: { ...message.meta.confirmation, status: actionStatus } }
          : {}),
      },
    }))
  } else if (event.type === 'run_completed') {
    next.runStatus = 'completed'
    if (options.recordAssistantSpeech && typeof event.data.text === 'string' && event.data.text.trim()) {
      const previousText = next.assistantTextByRun?.get(event.runId) ?? ''
      const completedText = appendUniqueText(previousText, event.data.text)
      next.assistantTextByRun?.set(event.runId, completedText)
      updateAssistant((message) => ({
        ...message,
        meta: {
          ...withRun(message),
          executionSteps: upsertRunSpeech(message.meta?.executionSteps ?? [], completedText, event),
        },
      }))
    }
    if (typeof event.data.text === 'string' && !next.persistedAssistantRunIds.has(event.runId)) updateAssistant((message) => ({
      ...message,
      meta: withRun(message),
      // A terminal summary must not replace the accumulated Agent reply.
      content: appendUniqueText(message.content, event.data.text),
    }))
    const actionId = typeof event.data.actionId === 'string' ? event.data.actionId : undefined
    const actionStatus = event.data.actionStatus === 'accepted' || event.data.actionStatus === 'rejected'
      ? event.data.actionStatus
      : undefined
    const taskStatus = isRecord(event.data.taskStatus) ? event.data.taskStatus : undefined
    if (actionId || taskStatus) updateAssistant((message) => {
      const confirmation = message.meta?.confirmation
      return {
        ...message,
        meta: {
          ...withRun(message),
          ...(actionId && actionStatus && confirmation?.actionId === actionId
            ? { requiresConfirmation: false, confirmation: { ...confirmation, status: actionStatus } }
            : {}),
          ...(taskStatus ? { taskStatus: {
            taskId: typeof taskStatus.taskId === 'string' ? taskStatus.taskId : undefined,
            status: typeof taskStatus.status === 'string' ? taskStatus.status : undefined,
            nodeId: typeof taskStatus.nodeId === 'string' ? taskStatus.nodeId : undefined,
          } } : {}),
        },
      }
    })
  } else if (event.type === 'run_failed' || event.type === 'run_aborted') {
    next.runStatus = event.type === 'run_failed' ? 'failed' : 'aborted'
    next.errorCode = typeof event.data.errorCode === 'string' ? event.data.errorCode : undefined
    updateAssistant((message) => ({
      ...message,
      meta: {
        ...withRun(message),
        errorCode: next.errorCode,
        runStatus: next.runStatus,
        ...(message.meta?.confirmation?.status === 'pending'
          ? { requiresConfirmation: false, confirmation: { ...message.meta.confirmation, status: 'rejected' as const } }
          : {}),
      },
    }))
  }
  return next
}

/** Build the desktop history from durable turns and their ordered Run trace. */
export function restoreDesktopAgentEventState(
  messages: AgentChatMsg[],
  events: AgentEventEnvelope[],
  cached?: AgentEventState,
): AgentEventState {
  const eventRunIds = new Set(events.map((event) => event.runId))
  const durableMessages = coalesceDesktopAssistantMessages(messages, eventRunIds).reduce<AgentChatMsg[]>(
    (result, message) => message.role === 'user' ? upsertDesktopUserMessage(result, message) : [...result, message],
    [],
  )
  const activeRunIds = new Set(
    [...(cached?.runStatusById ?? [])]
      .filter(([, status]) => status === 'running')
      .map(([runId]) => runId),
  )
  const mergedMessages = cached
    ? mergeDesktopSessionMessages(durableMessages, cached.messages, activeRunIds)
    : durableMessages
  const persistedAssistantRunIds = new Set(cached?.persistedAssistantRunIds ?? [])
  for (const message of durableMessages) {
    if (message.role === 'assistant' && message.content.trim() && message.meta?.runId) {
      persistedAssistantRunIds.add(message.meta.runId)
    }
  }
  const messageIdByRun = new Map<string, string | number>()
  for (const message of mergedMessages) {
    if (message.role === 'assistant' && message.meta?.runId) {
      messageIdByRun.set(message.meta.runId, message.id)
    }
  }
  let state: AgentEventState = {
    ...(cached ?? {
      messages: [],
      seenEventIds: new Set<string>(),
      runStatus: 'running' as const,
      runStatusById: new Map<string, 'running' | 'waiting_confirmation' | 'completed' | 'failed' | 'aborted'>(),
      messageIdByRun: new Map<string, string | number>(),
      persistedAssistantRunIds: new Set<string>(),
    }),
    messages: mergedMessages,
    messageIdByRun,
    persistedAssistantRunIds,
    assistantTextByRun: new Map(cached?.assistantTextByRun),
  }
  for (const event of [...events].sort((left, right) => left.eventSeq - right.eventSeq)) {
    state = reduceAgentEvent(state, event, { recordAssistantSpeech: true })
  }
  return state
}

function coalesceDesktopAssistantMessages(messages: AgentChatMsg[], replayableRunIds: Set<string>): AgentChatMsg[] {
  const lastAssistantIndexByRun = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.meta?.runId && replayableRunIds.has(message.meta.runId)) {
      lastAssistantIndexByRun.set(message.meta.runId, index)
    }
  })
  return messages.filter((message, index) =>
    message.role !== 'assistant' || !message.meta?.runId || !replayableRunIds.has(message.meta.runId)
      || lastAssistantIndexByRun.get(message.meta.runId) === index,
  )
}

/** A started Run may already have reached the history cache before optimistic insertion. */
export function upsertDesktopUserMessage(messages: AgentChatMsg[], incoming: AgentChatMsg): AgentChatMsg[] {
  const index = messages.findIndex((message) => message.id === incoming.id || sameRunMessage(message, incoming))
  if (index < 0) return [...messages, incoming]
  return messages.map((message, position) => position === index
    ? { ...incoming, ...message, meta: { ...incoming.meta, ...message.meta } }
    : message)
}

function mergeDesktopSessionMessages(
  persisted: AgentChatMsg[],
  runtime: AgentChatMsg[],
  activeRunIds: Set<string>,
): AgentChatMsg[] {
  const merged = [...persisted]
  for (const live of runtime) {
    const matchIndex = merged.findIndex((stored) => stored.id === live.id || sameRunMessage(stored, live))
    if (matchIndex >= 0) {
      const stored = merged[matchIndex]!
      const runId = live.meta?.runId
      merged[matchIndex] = {
        ...stored,
        content: runId && activeRunIds.has(runId)
          ? live.content.trim() ? live.content : stored.content
          : stored.content.trim() ? stored.content : live.content,
        meta: {
          ...stored.meta,
          ...live.meta,
          confirmation: mergeConfirmation(stored.meta?.confirmation, live.meta?.confirmation),
          executionSteps: live.meta?.executionSteps?.length
            ? live.meta.executionSteps
            : stored.meta?.executionSteps,
        },
      }
      continue
    }
    if (live.role === 'assistant' && !live.content?.trim() && !(live.meta?.executionSteps?.length) && !live.meta?.confirmation) continue
    const anchorIndex = live.role === 'assistant' && live.meta?.runId
      ? merged.findIndex((message) => message.role === 'user' && message.meta?.runId === live.meta?.runId)
      : -1
    if (anchorIndex < 0) merged.push(live)
    else merged.splice(anchorIndex + 1, 0, live)
  }
  return placeAssistantRunsAfterUserAnchors(merged)
}

function placeAssistantRunsAfterUserAnchors(messages: AgentChatMsg[]): AgentChatMsg[] {
  const ordered = [...messages]
  for (let index = 0; index < ordered.length; index += 1) {
    const message = ordered[index]
    if (message?.role !== 'assistant' || !message.meta?.runId) continue
    const userIndex = ordered.findIndex((candidate) =>
      candidate.role === 'user' && candidate.meta?.runId === message.meta?.runId,
    )
    if (userIndex < 0 || index === userIndex + 1) continue
    ordered.splice(index, 1)
    const updatedUserIndex = ordered.findIndex((candidate) =>
      candidate.role === 'user' && candidate.meta?.runId === message.meta?.runId,
    )
    ordered.splice(updatedUserIndex + 1, 0, message)
  }
  return ordered
}

function sameRunMessage(stored: AgentChatMsg, live: AgentChatMsg): boolean {
  return stored.role === live.role &&
    (stored.role === 'user' || stored.role === 'assistant') &&
    Boolean(stored.meta?.runId) && stored.meta?.runId === live.meta?.runId
}

/** Keep a successfully handled approval terminal across a durable history refresh. */
export function setConfirmationStatus(
  messages: AgentChatMsg[],
  actionId: string,
  status: AgentConfirmation['status'],
): AgentChatMsg[] {
  return messages.map((message) => message.meta?.confirmation?.actionId === actionId
    ? {
        ...message,
        meta: {
          ...message.meta,
          requiresConfirmation: status === 'pending' || status === 'submitting',
          confirmation: { ...message.meta.confirmation, status },
        },
      }
    : message)
}

/**
 * Resolve live activity without mistaking streamed assistant text for a
 * completed run. `runId` may identify a just-started run before its first
 * durable event has arrived.
 */
export function isAgentRunActive(state: AgentEventState, runId?: string): boolean {
  const targetRunId = runId ?? state.lastEventRunId
  if (targetRunId) {
    const status = state.runStatusById?.get(targetRunId)
    if (status) return status === 'running'
    return runId !== undefined
  }
  if (state.runStatus !== 'running') return false
  return state.messages.some((message) =>
    message.role === 'assistant' && (!message.content.trim() || message.meta?.executionSteps?.some((step) => step.kind === 'plan')),
  )
}

/** Merge durable chat history with the in-memory SSE execution trace. */
export function mergeSessionMessages(persisted: AgentChatMsg[], runtime: AgentChatMsg[]): AgentChatMsg[] {
  const merged = [...persisted]
  for (const live of runtime) {
    const matchIndex = merged.findIndex((stored) =>
      stored.id === live.id || sameAssistantRun(stored, live) || (
        stored.role === live.role &&
        Boolean(stored.content?.trim()) &&
        stored.content === live.content
      ),
    )
    if (matchIndex >= 0) {
      const stored = merged[matchIndex]!
      merged[matchIndex] = {
        ...stored,
        // The durable message is the completed reply. A live message may be a
        // partially streamed prefix from the same run, so never append it or
        // render it as a second assistant reply during rehydration.
        content: preferredMessageContent(stored.content, live.content),
        meta: {
          ...stored.meta,
          ...live.meta,
          confirmation: mergeConfirmation(stored.meta?.confirmation, live.meta?.confirmation),
          executionSteps: live.meta?.executionSteps?.length
            ? live.meta.executionSteps
            : stored.meta?.executionSteps,
        },
      }
      continue
    }
    if (live.role === 'assistant' && !live.content?.trim() && !(live.meta?.executionSteps?.length) && !live.meta?.confirmation) continue
    merged.push(live)
  }
  return merged
}

function sameAssistantRun(stored: AgentChatMsg, live: AgentChatMsg): boolean {
  return stored.role === 'assistant' &&
    live.role === 'assistant' &&
    Boolean(stored.meta?.runId) &&
    stored.meta?.runId === live.meta?.runId
}

function preferredMessageContent(persisted: string, runtime: string): string {
  const durable = persisted?.trim() ?? ''
  const streamed = runtime?.trim() ?? ''
  if (!durable) return runtime
  if (!streamed || durable.length >= streamed.length) return persisted
  return runtime
}

function mergeConfirmation(
  persisted?: AgentConfirmation,
  runtime?: AgentConfirmation,
): AgentConfirmation | undefined {
  const terminal = (value?: AgentConfirmation) => value?.status === 'accepted' || value?.status === 'rejected'
  if (terminal(persisted)) return persisted
  if (terminal(runtime)) return runtime
  return runtime ?? persisted
}

function appendUniqueText(previous: string, summary: unknown): string {
  const next = typeof summary === 'string' ? summary.trim() : ''
  const current = previous?.trim() ?? ''
  if (!next || current.includes(next)) return previous
  return current ? `${current}\n\n${next}` : next
}

/** A defensive client-side guard for legacy or replayed streams without replace metadata. */
function removeRepeatedOpening(content: string): string {
  let normalized = content.trim()
  while (normalized.length >= 48) {
    const anchor = normalized.slice(0, Math.min(24, normalized.length))
    const repeatAt = normalized.indexOf(anchor, anchor.length)
    if (repeatAt < 24) break
    normalized = normalized.slice(repeatAt).trim()
  }
  return normalized
}

/** Mirrors the server guard so a live stream cannot flood the chat before persistence. */
function dedupeRepeatedSegments(content: string): string {
  const seen = new Set<string>()
  return content
    .split(/(?<=[。！？\n])|(?=\p{Extended_Pictographic})/u)
    .filter((segment) => {
      const key = segment.replace(/[\s\p{P}\p{Extended_Pictographic}]/gu, '')
      if (key.length < 10 || !seen.has(key)) {
        if (key.length >= 10) seen.add(key)
        return true
      }
      return false
    })
    .join('')
    .trim()
}

function appendReasoning(steps: ExecutionStep[], text: string): ExecutionStep[] {
  const next = [...steps]
  const last = next.at(-1)
  if (last?.kind === 'reasoning') {
    next[next.length - 1] = { ...last, summary: text.startsWith(last.summary) ? text : `${last.summary}\n\n${text}` }
    return next
  }
  return [...next, stepFromThinking(text, Date.now())]
}

/** Desktop snapshots contain cumulative model deltas; update within the current tool-delimited turn segment. */
function upsertRunReasoning(steps: ExecutionStep[], text: string, event: AgentEventEnvelope): ExecutionStep[] {
  const summary = text.trim()
  if (!summary) return steps
  const boundary = lastToolStepIndex(steps)
  const existingIndex = lastStepIndexAfter(steps, boundary, 'reasoning')
  if (existingIndex < 0) return [...steps, {
    ...stepFromThinking(summary, event.eventSeq),
    id: `reason-${event.eventSeq}-${event.eventId}`,
  }]
  const previous = steps[existingIndex]!.summary.trim()
  const merged = summary.startsWith(previous) || previous.startsWith(summary)
    ? (summary.length >= previous.length ? summary : previous)
    : appendUniqueText(previous, summary)
  if (merged === previous) return steps
  const next = [...steps]
  next[existingIndex] = { ...next[existingIndex]!, summary: merged }
  return next
}

/** Keep cumulative speech deltas in one step until a tool operation starts. */
function upsertRunSpeech(steps: ExecutionStep[], text: string, event: AgentEventEnvelope): ExecutionStep[] {
  const summary = text.trim()
  if (!summary) return steps
  const boundary = lastToolStepIndex(steps)
  const existingIndex = lastStepIndexAfter(steps, boundary, 'speech')
  if (existingIndex >= 0) {
    const previous = steps[existingIndex]!.summary.trim()
    if (summary === previous) return steps
    // A Pi assistant message replaces the current speech segment even when the
    // new text is shorter or starts differently. Tool steps freeze that segment.
    const next = [...steps]
    next[existingIndex] = { ...next[existingIndex]!, summary }
    return next
  }
  return [...steps, {
    id: `speech-${event.eventSeq}-${event.eventId}`,
    kind: 'speech',
    label: '回复',
    summary,
  }]
}

function lastToolStepIndex(steps: ExecutionStep[]): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === 'plan' || steps[index]?.kind === 'result') return index
  }
  return -1
}

function lastStepIndexAfter(steps: ExecutionStep[], boundary: number, kind: ExecutionStep['kind']): number {
  for (let index = steps.length - 1; index > boundary; index -= 1) {
    if (steps[index]?.kind === kind) return index
  }
  return -1
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function generationItemsFrom(value: unknown): NonNullable<AgentConfirmation['generationItems']> | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.target !== 'string' || typeof entry.model !== 'string'
      || typeof entry.input !== 'string' || typeof entry.overwrite !== 'boolean') return []
    return [{ target: entry.target, model: entry.model, input: entry.input, overwrite: entry.overwrite }]
  })
  return items.length ? items : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function printablePayload(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const safe = redactPayload(value)
  if (safe === undefined) return undefined
  const text = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2) ?? ''
  if (!text || text === '{}' || text === '[]') return undefined
  return text.length > 6000 ? `${text.slice(0, 6000)}\n…（已截断）` : text
}

function redactPayload(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'summary' && isSafeActivitySummary(value)) return value
    return undefined
  }
  if (Array.isArray(value)) {
    const safe = value.slice(0, 30).map((item) => redactPayload(item)).filter((item) => item !== undefined)
    return safe.length ? safe : undefined
  }
  if (!value || typeof value !== 'object') return value

  // Event details are for a compact activity timeline. Keep only operational
  // metadata; raw prompts, media URLs, payload text, and internal identifiers
  // stay in Pi's existing private session record.
  const allowed = new Set([
    'summary', 'status', 'ok', 'count', 'attempt', 'maxAttempts', 'errorCode',
    'providedInputCount', 'affectedNodeCount', 'createdCount', 'updatedCount',
    'deletedCount', 'connectedCount', 'inputTokens', 'outputTokens', 'totalTokens',
  ])
  const result = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([entryKey]) => allowed.has(entryKey))
    .flatMap(([entryKey, item]) => {
      const safe = redactPayload(item, entryKey)
      return safe === undefined ? [] : [[entryKey, safe]]
    }))
  return Object.keys(result).length ? result : undefined
}

function isSafeActivitySummary(value: string): boolean {
  const operation = '(?:读取画布摘要|读取选中节点(?:（\\d+ 个）)?|读取节点详情|读取模型目录|搜索素材|查询生成任务状态|执行渲染审校|创建节点(?:（\\d+ 个）)?|连接节点(?:（\\d+ 个）)?|整理节点布局(?:（\\d+ 个）)?|更新节点配置|准备生成任务|准备批量生成(?:（\\d+ 项）)?|加载 Skill|执行本地操作)'
  return new RegExp(`^(?:(?:正在|已)${operation}|操作未完成(?:（[A-Z][A-Z0-9_]{1,47}）)?|工具正在重试)$`, 'u').test(value)
}
