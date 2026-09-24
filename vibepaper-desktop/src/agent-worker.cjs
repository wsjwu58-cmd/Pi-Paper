const { openDesktopAgentStores } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/agent-stores.ts')
const { SessionRunService } = require('../../pi-main/packages/vibepaper-agent-service/src/application/session-run-service.ts')
const { AGNES_MODELS } = require('./agnes-model-catalog.cjs')
const agentRuntimePromise = Promise.all([
  import('@earendil-works/pi-agent-core'),
  import('@earendil-works/pi-ai/api/openai-completions.lazy'),
]).then(([agentCore, openAi]) => ({ Agent: agentCore.Agent, streamSimple: openAi.openAICompletionsApi().streamSimple }))

const parentPort = process.parentPort
if (!parentPort) throw new Error('Agent Worker 必须由 Electron utility process 启动。')

let stores = null
let requestQueue = Promise.resolve()

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

function messageText(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
}

async function getSessionMessages(projectId, sessionId) {
  const current = await requireProject(projectId)
  if (typeof sessionId !== 'string' || sessionId.length > 128) throw new Error('SESSION_ID_INVALID')
  const context = await current.sessions.buildContext(sessionId)
  return context.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: messageText(message),
      createdAt: typeof message.timestamp === 'number' ? message.timestamp : 0,
    }))
    .filter((message) => message.content.trim().length > 0)
}

async function recoverInterruptedRun(current, runService, sessionId) {
  const activeRun = await runService.findActive(sessionId)
  if (!activeRun) return
  await runService.setStatus(activeRun.runId, 'aborted', { reason: 'worker_interrupted' })
  await current.sessions.flushOutbox(current.control, sessionId)
}

async function recoverInterruptedRuns(current) {
  const runService = new SessionRunService(current.control)
  const sessions = await current.sessions.listSessions()
  for (const session of sessions) {
    const activeRun = await runService.findActive(session.id)
    if (activeRun) await runService.setStatus(activeRun.runId, 'aborted', { reason: 'worker_restarted' })
  }
  await current.sessions.flushOutbox(current.control)
}

async function sendMessage(payload) {
  const current = await requireProject(payload?.projectId)
  const { sessionId, content, apiKey, idempotencyKey } = payload ?? {}
  if (typeof sessionId !== 'string' || sessionId.length > 128) throw new Error('SESSION_ID_INVALID')
  if (typeof content !== 'string' || !content.trim() || content.length > 20_000) throw new Error('AGENT_MESSAGE_INVALID')
  if (typeof apiKey !== 'string' || apiKey.length < 1 || apiKey.length > 4096) throw new Error('CLOUD_CREDENTIAL_MISSING')
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 255) {
    throw new Error('IDEMPOTENCY_KEY_INVALID')
  }

  const session = await current.sessions.openSession(sessionId)
  const runService = new SessionRunService(current.control)
  const existing = current.control.findByIdempotency(sessionId, idempotencyKey)
  if (existing) {
    if (existing.status === 'completed') {
      const events = await runService.listEvents(existing.runId)
      const final = [...events].reverse().find((event) => event.type === 'assistant_delta')
      const savedText = final?.data?.content
      if (typeof savedText === 'string') return { assistantText: savedText }
      throw new Error('AGENT_RUN_RESULT_MISSING')
    }
    if (existing.status === 'queued' || existing.status === 'running' || existing.status === 'waiting_confirmation' || existing.status === 'waiting_task') {
      await runService.setStatus(existing.runId, 'aborted', { reason: 'worker_interrupted' })
      await current.sessions.flushOutbox(current.control, sessionId)
    }
    throw new Error('AGENT_RUN_ALREADY_PROCESSED')
  }

  await recoverInterruptedRun(current, runService, sessionId)
  const run = await runService.startRun({ sessionId, idempotencyKey })
  await runService.setStatus(run.runId, 'running')
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

  const context = await current.sessions.buildContext(sessionId)
  const { Agent, streamSimple } = await agentRuntimePromise
  const model = {
    id: AGNES_MODELS.text,
    name: AGNES_MODELS.text,
    api: 'openai-completions',
    provider: 'agnes',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  }
  const initialMessageCount = context.messages.length
  const persistedMessages = new WeakSet()
  const agent = new Agent({
    initialState: {
      model,
      messages: context.messages,
      systemPrompt: '你是 VibePaper 的创作助手。用中文清晰回答用户，当前没有读取或修改画布、素材和任务的工具；不要声称已经完成本地写入。',
      tools: [],
    },
    streamFn: streamSimple,
    getApiKey: (provider) => provider === 'agnes' ? apiKey : undefined,
    sessionId,
    toolExecution: 'sequential',
  })
  agent.subscribe(async (event) => {
    if (event.type !== 'message_end' || event.message.role !== 'assistant' || persistedMessages.has(event.message)) return
    await current.sessions.appendMessage(sessionId, event.message)
    persistedMessages.add(event.message)
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    agent.abort()
  }, 240_000)
  try {
    await agent.continue()
  } catch {
    await runService.setStatus(run.runId, 'failed', { errorCode: 'AGENT_MODEL_REQUEST_FAILED' })
    await current.sessions.flushOutbox(current.control, sessionId)
    throw new Error('AGENT_MODEL_REQUEST_FAILED')
  } finally {
    clearTimeout(timeout)
  }

  const generated = agent.state.messages.slice(initialMessageCount)
  for (const message of generated) {
    if (message.role !== 'assistant' || persistedMessages.has(message)) continue
    await current.sessions.appendMessage(sessionId, message)
    persistedMessages.add(message)
  }
  const finalAssistant = [...generated].reverse().find((message) => message.role === 'assistant')
  const assistantText = messageText(finalAssistant)
  if (timedOut || !assistantText.trim() || finalAssistant?.stopReason === 'error') {
    await runService.setStatus(run.runId, 'failed', { errorCode: timedOut ? 'AGENT_MODEL_TIMEOUT' : 'AGENT_MODEL_REQUEST_FAILED' })
    await current.sessions.flushOutbox(current.control, sessionId)
    throw new Error(timedOut ? 'AGENT_MODEL_TIMEOUT' : 'AGENT_MODEL_REQUEST_FAILED')
  }
  await runService.appendEvent(run.runId, 'assistant_delta', { content: assistantText })
  await runService.setStatus(run.runId, 'completed')
  await current.sessions.flushOutbox(current.control, sessionId)
  return { assistantText }
}

async function dispatch(method, payload) {
  switch (method) {
    case 'agent:open': {
      if (!payload || typeof payload.projectDirectory !== 'string') throw new Error('AGENT_PROJECT_PATH_INVALID')
      if (stores) await stores.close()
      stores = await openDesktopAgentStores(payload.projectDirectory)
      await recoverInterruptedRuns(stores)
      return { projectId: stores.projectId }
    }
    case 'agent:list-sessions':
      return listSessions(payload?.projectId)
    case 'agent:get-messages':
      return getSessionMessages(payload?.projectId, payload?.sessionId)
    case 'agent:create-session': {
      const current = await requireProject(payload?.projectId)
      const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 120) : ''
      const session = await current.sessions.createSession(title || undefined)
      return { sessionId: session.id, createdAt: session.createdAt }
    }
    case 'agent:send-message':
      return sendMessage(payload)
    case 'agent:close':
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
