const { openDesktopAgentStores } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/agent-stores.ts')
const { SessionRunService } = require('../../pi-main/packages/vibepaper-agent-service/src/application/session-run-service.ts')
const { ApprovalService } = require('../../pi-main/packages/vibepaper-agent-service/src/application/approval-service.ts')
const {
  confirmDesktopGenerationAction,
  recoverDesktopAgentRuns,
} = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/generation-confirmation.ts')
const {
  createDesktopAgentSkillContext,
  listDesktopAgentSkills,
} = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/skill-context.ts')
const {
  runDramaTurn,
  sanitizeAgentReply,
  sanitizeAssistantMessage,
} = require('../../pi-main/packages/vibepaper-agent-service/src/application/agent-runtime.ts')
const { DesktopLocalToolGateway } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/local-tool-gateway.ts')
const {
  createRuntimeTools,
  desktopGenerationConfirmationItems,
} = require('../../pi-main/packages/vibepaper-agent-service/src/tools/runtime-tools.ts')
const { AGNES_MODELS } = require('./agnes-model-catalog.cjs')
const { createAgentLocalToolClient } = require('./agent-local-tools.cjs')

const parentPort = process.parentPort
if (!parentPort) throw new Error('Agent Worker 必须由 Electron utility process 启动。')

let stores = null
let requestQueue = Promise.resolve()
const agentLocalCoreClient = createAgentLocalToolClient(parentPort)

async function requireProject(projectId) {
  if (!stores) throw new Error('AGENT_PROJECT_NOT_OPEN')
  if (typeof projectId !== 'string' || stores.projectId !== projectId) {
    throw new Error('AGENT_PROJECT_CHANGED')
  }
  return stores
}

async function listSessions(projectId) {
  const current = await requireProject(projectId)
  const sessions = await current.sessions.listSessions()
  return Promise.all(sessions.map(async ({ id, createdAt, modifiedAt }) => {
    const session = await current.sessions.openSession(id)
    const title = await session.getName()
    return { sessionId: id, title: title || '新对话', createdAt, modifiedAt }
  }))
}

async function listAgentSkills(payload) {
  const current = await requireProject(payload?.projectId)
  const { sessionId, keyword } = payload ?? {}
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 128)) {
    throw new Error('AGENT_SESSION_INPUT_INVALID')
  }
  if (keyword !== undefined && (typeof keyword !== 'string' || keyword.length > 160)) {
    throw new Error('SKILL_QUERY_INVALID')
  }
  let loadedSkillIds = []
  if (sessionId) {
    await current.sessions.openSession(sessionId)
    const availableSkillIds = new Set(listDesktopAgentSkills().map((skill) => skill.id))
    loadedSkillIds = current.control.getLoadedSkillIds(sessionId).filter((skillId) => availableSkillIds.has(skillId))
  }
  return { items: listDesktopAgentSkills(keyword), loadedSkillIds }
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
}

function historyText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
}

function storedHistoryMessage(message) {
  if (!message || !['user', 'assistant', 'toolResult'].includes(message.role)) return null
  const piMessage = message.role === 'assistant' ? sanitizeAssistantMessage(message) : message
  const content = historyText(piMessage)
  const callIds = message.role === 'assistant' && Array.isArray(message.content)
    ? message.content.filter((item) => item?.type === 'toolCall' && typeof item.id === 'string').map((item) => item.id)
    : []
  return {
    role: message.role,
    content,
    meta: {},
    createdAt: new Date(typeof message.timestamp === 'number' ? message.timestamp : 0),
    piMessage,
    ...(callIds.length ? { toolCallIds: callIds } : {}),
    ...(message.role === 'toolResult' && typeof message.toolCallId === 'string'
      ? { toolResultCallId: message.toolCallId }
      : {}),
  }
}

async function getSessionMessages(projectId, sessionId) {
  const current = await requireProject(projectId)
  if (typeof sessionId !== 'string' || sessionId.length > 128) throw new Error('SESSION_ID_INVALID')
  const context = await current.sessions.buildContext(sessionId)
  return context.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: message.role === 'assistant' ? sanitizeAgentReply(messageText(message)) : messageText(message),
      createdAt: typeof message.timestamp === 'number' ? message.timestamp : 0,
    }))
    .filter((message) => message.content.trim().length > 0)
}

async function getSessionSnapshot(projectId, sessionId) {
  const current = await requireProject(projectId)
  const messages = await getSessionMessages(projectId, sessionId)
  const events = toEventEnvelopes(await new SessionRunService(current.control).listSessionEvents(sessionId))
  return { messages, events, lastEventSeq: events.reduce((highest, event) => Math.max(highest, event.eventSeq), 0) }
}

async function listSessionEvents(projectId, sessionId, afterSeq) {
  const current = await requireProject(projectId)
  if (typeof sessionId !== 'string' || sessionId.length > 128
    || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('AGENT_SESSION_INPUT_INVALID')
  const events = await new SessionRunService(current.control).listSessionEvents(sessionId, afterSeq)
  return toEventEnvelopes(events)
}

async function recoverInterruptedRun(current, runService, sessionId) {
  const activeRun = await runService.findActive(sessionId)
  if (!activeRun) return
  throw new Error(activeRun.status === 'waiting_confirmation' ? 'CONFIRMATION_REQUIRED' : 'SESSION_BUSY')
}

async function sendMessage(payload, onRunCreated) {
  const current = await requireProject(payload?.projectId)
  const {
    sessionId,
    content,
    apiKey,
    idempotencyKey,
    canvasContext,
    canvasId,
    canvasVersion,
    canvasNodeCount,
    selectedNodeIds,
    selectedSkillId,
  } = payload ?? {}
  if (typeof sessionId !== 'string' || sessionId.length > 128) throw new Error('SESSION_ID_INVALID')
  if (typeof content !== 'string' || !content.trim() || content.length > 20_000) throw new Error('AGENT_MESSAGE_INVALID')
  if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 4096) throw new Error('CLOUD_CREDENTIAL_MISSING')
  if (typeof canvasContext !== 'string' || canvasContext.length < 1 || canvasContext.length > 8_000) {
    throw new Error('AGENT_CANVAS_CONTEXT_INVALID')
  }
  if (typeof canvasId !== 'string' || canvasId.length < 1 || canvasId.length > 128
    || !Number.isSafeInteger(canvasVersion) || canvasVersion < 0
    || !Number.isSafeInteger(canvasNodeCount) || canvasNodeCount < 0 || canvasNodeCount > 1_000_000) {
    throw new Error('AGENT_CANVAS_CONTEXT_INVALID')
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 255) {
    throw new Error('IDEMPOTENCY_KEY_INVALID')
  }
  if (selectedNodeIds !== undefined && (!Array.isArray(selectedNodeIds) || selectedNodeIds.length > 20
    || selectedNodeIds.some((nodeId) => typeof nodeId !== 'string' || nodeId.length < 1 || nodeId.length > 128))) {
    throw new Error('AGENT_SELECTION_INVALID')
  }
  if (selectedSkillId !== undefined && (typeof selectedSkillId !== 'string' || selectedSkillId.length < 1 || selectedSkillId.length > 160)) {
    throw new Error('SKILL_ID_INVALID')
  }

  const session = await current.sessions.openSession(sessionId)
  const runService = new SessionRunService(current.control)
  const existing = current.control.findByIdempotency(sessionId, idempotencyKey)
  if (existing) {
    onRunCreated?.({ runId: existing.runId })
    if (existing.status === 'completed') {
      const events = await runService.listEvents(existing.runId)
      const final = [...events].reverse().find((event) => event.type === 'assistant_delta')
      const savedText = final?.data?.text ?? final?.data?.content
      if (typeof savedText === 'string') return { assistantText: savedText, events: toEventEnvelopes(events) }
      throw new Error('AGENT_RUN_RESULT_MISSING')
    }
    if (existing.status === 'queued' || existing.status === 'running' || existing.status === 'waiting_confirmation' || existing.status === 'waiting_task') {
      return { runId: existing.runId, waitingConfirmation: existing.status === 'waiting_confirmation' }
    }
    throw new Error('AGENT_RUN_ALREADY_PROCESSED')
  }

  await recoverInterruptedRun(current, runService, sessionId)
  // Capture the branch before appending this turn's user message. runDramaTurn
  // prompts `content` itself; including the just-written user message here
  // would send it twice to the model.
  const priorContext = await current.sessions.buildContext(sessionId)
  const run = await runService.startRun({ sessionId, idempotencyKey })
  await runService.setStatus(run.runId, 'running')
  onRunCreated?.({ runId: run.runId })
  const timestamp = Date.now()
  try {
    await session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: content.trim() }],
      timestamp,
    })
    if (!(await session.getName())) await session.setName(content.trim().slice(0, 72))
  } catch {
    await runService.setStatus(run.runId, 'failed', { errorCode: 'AGENT_SESSION_WRITE_FAILED' })
    await current.sessions.flushOutbox(current.control, sessionId)
    throw new Error('AGENT_SESSION_WRITE_FAILED')
  }

  const gateway = new DesktopLocalToolGateway(agentLocalCoreClient, current.projectId)
  const approvals = new ApprovalService(current.control, current.control.getOrCreateApprovalSecret(), 10 * 60)
  const history = priorContext.messages.map(storedHistoryMessage).filter(Boolean)
  let persistenceQueue = Promise.resolve()
  let persistenceFailure = null
  let timedOut = false
  const persistPiMessage = (message) => {
    const persisted = message.role === 'assistant' ? sanitizeAssistantMessage(message) : message
    persistenceQueue = persistenceQueue.then(() => current.sessions.appendMessage(sessionId, persisted))
    persistenceQueue = persistenceQueue.catch((error) => {
      persistenceFailure = error
      throw error
    })
    return persistenceQueue
  }
  const toolContext = {
    userId: current.projectId,
    sessionId,
    runId: run.runId,
    canvasId,
    canvasVersion,
    referenceNodeIds: selectedNodeIds ?? [],
    gateway,
    approvals,
    desktopMode: true,
    onApprovalRequired: async (action) => {
      const generationItems = await desktopGenerationConfirmationItems(action, gateway)
      await runService.appendEvent(run.runId, 'confirmation_required', {
        actionId: action.actionId,
        approvalToken: action.approvalToken,
        tool: action.toolName,
        summary: action.toolName === 'submit_generation_batch'
          ? `确认提交 ${generationItems.length} 个本地生成任务`
          : '确认提交本地生成任务',
        confirmReason: '生成任务会写入当前本地项目的任务队列。',
        estimatedCost: 0,
        estimatedTotalCost: 0,
        affectedNodeCount: generationItems.length,
        generationItems,
        canvasVersion: action.canvasVersion,
        expiresAt: action.binding.expiresAt,
      })
    },
  }
  let turn
  try {
    const skillContext = createDesktopAgentSkillContext(current.control, sessionId, selectedSkillId)
    const runtimeTools = createRuntimeTools(toolContext)
    turn = await runDramaTurn(
      {
        llmApiKey: apiKey,
        llmBaseUrl: 'https://apihub.agnes-ai.com/v1',
        llmModel: AGNES_MODELS.text,
      },
      undefined,
      sessionId,
      history,
      content.trim(),
      skillContext,
      [],
      {
        profile: 'canvas-general',
        desktopMode: true,
        runtimeTools,
        intentContext: `以下是本轮只读画布摘要：\n${JSON.stringify(canvasContext)}`,
        onAgent(agent) {
          agent.subscribe(async (event) => {
            if (event.type !== 'message_end') return
            if (event.message.role !== 'assistant' && event.message.role !== 'toolResult') return
            await persistPiMessage(event.message)
          })
        },
        onEvent: async (event) => {
          if (event.type === 'assistant_message' && event.content) {
            await runService.appendEvent(run.runId, 'assistant_delta', { text: event.content, replace: true })
          } else if (event.type === 'tool_started') {
            await runService.appendEvent(run.runId, 'tool_started', { tool: event.toolName ?? 'operation', args: {} })
          } else if (event.type === 'tool') {
            await runService.appendEvent(run.runId, 'tool_completed', {
              tool: event.toolName ?? 'operation',
              ok: event.ok !== false,
              ...(event.ok === false && event.errorCode ? { errorCode: event.errorCode } : {}),
              details: event.ok === false ? '本地操作未完成' : '本地操作已完成',
            })
          } else if (event.type === 'tool_retry') {
            const details = event.details && typeof event.details === 'object' ? event.details : {}
            await runService.appendEvent(run.runId, 'tool_retry', {
              tool: event.toolName ?? 'operation',
              attempt: details.attempt,
              maxAttempts: details.maxAttempts,
              errorCode: details.errorCode,
            })
          }
        },
      },
    )
    await persistenceQueue
  } catch (error) {
    const errorCode = persistenceFailure ? 'AGENT_SESSION_WRITE_FAILED'
      : typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/u.test(error.code) ? error.code
        : 'AGENT_MODEL_REQUEST_FAILED'
    current.control.invalidatePendingForRun(run.runId)
    await runService.setStatus(run.runId, 'failed', { errorCode })
    await current.sessions.flushOutbox(current.control, sessionId)
    throw new Error(errorCode)
  }

  const assistantText = sanitizeAgentReply(turn?.assistantText ?? '')
  const errorEvent = turn?.events?.find((event) => event.type === 'error')
  if (timedOut || (!toolContext.confirmationPending && !assistantText.trim()) || errorEvent) {
    const errorCode = timedOut ? 'AGENT_MODEL_TIMEOUT'
      : typeof errorEvent?.errorCode === 'string' ? errorEvent.errorCode : 'AGENT_MODEL_REQUEST_FAILED'
    current.control.invalidatePendingForRun(run.runId)
    await runService.setStatus(run.runId, 'failed', { errorCode })
    await current.sessions.flushOutbox(current.control, sessionId)
    throw new Error(errorCode)
  }
  if (assistantText.trim()) await runService.appendEvent(run.runId, 'assistant_delta', { text: assistantText, replace: true })
  // Flush the full Pi transcript (including assistant tool calls and results)
  // to the JSONL file before making the run terminal.
  await persistenceQueue
  await current.sessions.flushOutbox(current.control, sessionId)
  if (toolContext.confirmationPending) {
    await runService.setStatus(run.runId, 'waiting_confirmation')
    await current.sessions.flushOutbox(current.control, sessionId)
    return { runId: run.runId, assistantText, waitingConfirmation: true }
  }
  await runService.setStatus(run.runId, 'completed', { text: assistantText })
  await current.sessions.flushOutbox(current.control, sessionId)
  return { assistantText, events: toEventEnvelopes(await runService.listEvents(run.runId)) }
}

async function startMessage(payload) {
  let resolveCreated
  let rejectCreated
  let settled = false
  const created = new Promise((resolve, reject) => {
    resolveCreated = resolve
    rejectCreated = reject
  })
  void sendMessage(payload, (run) => {
    if (settled) return
    settled = true
    resolveCreated(run)
  }).catch((error) => {
    if (settled) return
    settled = true
    rejectCreated(error)
  })
  return created
}

async function confirmAgentAction(payload) {
  const current = await requireProject(payload?.projectId)
  return confirmDesktopGenerationAction(payload ?? {}, current, new DesktopLocalToolGateway(agentLocalCoreClient, current.projectId))
}

function toEventEnvelopes(events) {
  return events.map(({ eventId, runId, sessionId, eventSeq, type, runtime, runtimeVersion, data }) => ({
    eventId, runId, sessionId, eventSeq, type, runtime, runtimeVersion, data,
  }))
}

async function dispatch(method, payload) {
  switch (method) {
    case 'agent:open': {
      if (!payload || typeof payload.projectDirectory !== 'string') throw new Error('AGENT_PROJECT_PATH_INVALID')
      if (stores) await stores.close()
      stores = await openDesktopAgentStores(payload.projectDirectory)
      await recoverDesktopAgentRuns(stores)
      return { projectId: stores.projectId }
    }
    case 'agent:list-sessions':
      return listSessions(payload?.projectId)
    case 'agent:list-skills':
      return listAgentSkills(payload)
    case 'agent:get-messages':
      return getSessionMessages(payload?.projectId, payload?.sessionId)
    case 'agent:get-snapshot':
      return getSessionSnapshot(payload?.projectId, payload?.sessionId)
    case 'agent:list-events':
      return listSessionEvents(payload?.projectId, payload?.sessionId, payload?.afterSeq)
    case 'agent:create-session': {
      const current = await requireProject(payload?.projectId)
      const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 120) : ''
      const session = await current.sessions.createSession(title || undefined)
      return { sessionId: session.id, createdAt: session.createdAt }
    }
    case 'agent:send-message':
      return sendMessage(payload)
    case 'agent:start-run':
      return startMessage(payload)
    case 'agent:confirm-action':
      return confirmAgentAction(payload)
    case 'agent:close':
      agentLocalCoreClient.close()
      if (stores) await stores.close()
      stores = null
      return null
    default:
      throw new Error('AGENT_METHOD_UNSUPPORTED')
  }
}

parentPort.on('message', async (event) => {
  const request = event?.data ?? event
  if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== 'string') return
  requestQueue = requestQueue.then(async () => {
    try {
      const result = await dispatch(request.method, request.payload)
      parentPort.postMessage({ id: request.id, ok: true, result })
    } catch (error) {
      parentPort.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error && /^[A-Z0-9_]{1,120}$/u.test(error.message)
          ? error.message
          : 'AGENT_SESSION_OPERATION_FAILED',
      })
    }
  })
})
