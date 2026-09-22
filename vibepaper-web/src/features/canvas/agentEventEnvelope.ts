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
}

export type AgentEventState = {
  messages: AgentChatMsg[]
  seenEventIds: Set<string>
  runStatus: 'running' | 'completed' | 'failed' | 'aborted'
  errorCode?: string
  lastEventType?: AgentEventType
  pendingMessageId?: string | number
  messageIdByRun: Map<string, string | number>
  /** Runs whose complete assistant reply already came from durable history. */
  persistedAssistantRunIds: Set<string>
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
  if (/do_request_failed|failed to reach upstream|agnesai_error|upstream|^500\s*:/i.test(message)) {
    return '模型服务暂时不可用，请稍后重试。'
  }
  if (/timeout|timed out|超时/i.test(message)) return '模型响应超时，请稍后重试。'
  return message || '模型调用失败，请稍后重试。'
}

export function reduceAgentEvent(state: AgentEventState, event: AgentEventEnvelope): AgentEventState {
  if (state.seenEventIds.has(event.eventId)) return state
  const next: AgentEventState = {
    ...state,
    seenEventIds: new Set([...state.seenEventIds, event.eventId]),
    messageIdByRun: new Map(state.messageIdByRun),
    persistedAssistantRunIds: new Set(state.persistedAssistantRunIds),
    lastEventType: event.type,
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
    next.messages = next.messages.includes(current)
      ? next.messages.map((message) => (message === current ? update(message) : message))
      : [...next.messages, update(current)]
  }
  const withRun = (message: AgentChatMsg): AgentChatMsg['meta'] => ({ ...message.meta, runId: event.runId })

  if (event.type === 'assistant_delta') {
    const delta = typeof event.data.text === 'string' ? event.data.text : ''
    const replace = event.data.replace === true
    // Historical deltas restore the execution record after refresh. The
    // durable assistant message already contains their complete visible text.
    if (!next.persistedAssistantRunIds.has(event.runId)) {
      updateAssistant((message) => ({
        ...message,
        meta: withRun(message),
        content: dedupeRepeatedSegments(removeRepeatedOpening(replace ? delta : `${message.content}${delta}`)),
      }))
    }
  } else if (event.type === 'thinking') {
    const text = typeof event.data.text === 'string' ? event.data.text.trim() : ''
    if (text) updateAssistant((message) => ({ ...message, meta: { ...withRun(message), executionSteps: appendReasoning(message.meta?.executionSteps ?? [], text) } }))
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
        tool: typeof event.data.tool === 'string' ? event.data.tool : undefined,
        summary: typeof event.data.summary === 'string' ? event.data.summary : '待确认操作',
        confirmReason: typeof event.data.confirmReason === 'string' ? event.data.confirmReason : undefined,
        estimatedCost: numberValue(event.data.estimatedCost),
        estimatedTotalCost: numberValue(event.data.estimatedTotalCost),
        canvasVersion: numberValue(event.data.canvasVersion),
        expiresAt: normalizeConfirmationExpiry(event.data.expiresAt),
        status: 'pending',
      } },
    }))
  } else if (event.type === 'task_status') {
    updateAssistant((message) => ({ ...message, meta: { ...withRun(message), taskStatus: {
      taskId: typeof event.data.task_id === 'string' ? event.data.task_id : undefined,
      status: typeof event.data.status === 'string' ? event.data.status : undefined,
      nodeId: typeof event.data.node_id === 'string' ? event.data.node_id : undefined,
    } } }))
  } else if (event.type === 'run_completed') {
    next.runStatus = 'completed'
    if (typeof event.data.text === 'string' && !next.persistedAssistantRunIds.has(event.runId)) updateAssistant((message) => ({
      ...message,
      meta: withRun(message),
      // A terminal summary must not replace the accumulated Agent reply.
      content: appendUniqueText(message.content, event.data.text),
    }))
  } else if (event.type === 'run_failed' || event.type === 'run_aborted') {
    next.runStatus = event.type === 'run_failed' ? 'failed' : 'aborted'
    next.errorCode = typeof event.data.errorCode === 'string' ? event.data.errorCode : undefined
    updateAssistant((message) => ({ ...message, meta: { ...withRun(message), errorCode: next.errorCode, runStatus: next.runStatus } }))
  }
  return next
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

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function printablePayload(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(redactPayload(value), null, 2) ?? ''
  return text.length > 6000 ? `${text.slice(0, 6000)}\n…（已截断）` : text
}

function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    /(?:token|secret|authorization|api[_-]?key|password|node_?id|task_?id|session_?id|canvas_?id)/i.test(key) ? '[已隐藏]' : redactPayload(item),
  ]))
}
