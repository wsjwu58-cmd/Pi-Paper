const { openDesktopAgentStores } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/agent-stores.ts')
const { DesktopProjectMemory } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/project-memory.ts')
const { DesktopSessionFragments } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/session-fragments.ts')
const { parseDesktopPlanCreateRequest, parseDesktopPlanExecuteRequest, parseDesktopPlanRerunRequest, parseDesktopPlanId, parseDesktopAgentProfile, desktopPlanResponse } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/persistent-plan-repository.ts')
const { DesktopPlanExecutionService } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/plan-execution-service.ts')
const { confirmDesktopDeleteAction } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/deletion-confirmation.ts')
const { DesktopScopedMemoryStore, desktopCandidateScope } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/scoped-memory.ts')
const { desktopCompactionSummary } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/session-store.ts')
const {
  assembleDesktopMemoryContext,
  generateDesktopContextSummary,
  planDesktopContextBudget,
  projectDesktopSessionContext,
} = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/context-assembler.ts')
const { SessionRunService } = require('../../pi-main/packages/vibepaper-agent-service/src/application/session-run-service.ts')
const { ApprovalService } = require('../../pi-main/packages/vibepaper-agent-service/src/application/approval-service.ts')
const {
  confirmDesktopGenerationAction,
  recoverDesktopAgentRuns,
} = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/generation-confirmation.ts')
const {
  reconcileDesktopAgentTasks,
} = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/task-status-sync.ts')
const {
  createDesktopAgentSkillContext,
  listDesktopAgentSkills,
  setDesktopSessionSkills,
  attachDesktopSessionSkill,
  listDesktopAgentSessionSkills,
} = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/skill-context.ts')
const {
  createProjectAgentSkill,
  deleteProjectAgentSkill,
  importProjectAgentSkill,
  listProjectAgentSkills,
  updateProjectAgentSkill,
} = require('./project-agent-skills.cjs')
const { selectNodeReferences } = require('../../pi-main/packages/vibepaper-agent-service/src/application/node-reference-context.ts')
const {
  agnesModel,
  prepareDesktopAgentTurnContext,
  runDramaTurn,
  sanitizeAgentReply,
  sanitizeAssistantMessage,
} = require('../../pi-main/packages/vibepaper-agent-service/src/application/agent-runtime.ts')
const { extractMemoryCandidates } = require('../../pi-main/packages/vibepaper-agent-service/src/application/memory-candidate-extractor.ts')
const { extractDailyMemory } = require('../../pi-main/packages/vibepaper-agent-service/src/application/daily-memory-service.ts')
const { selectProfile } = require('../../pi-main/packages/vibepaper-agent-service/src/application/profile-selector.ts')
const { DesktopLocalToolGateway } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/local-tool-gateway.ts')
const {
  createRuntimeTools,
  desktopGenerationConfirmationItems,
} = require('../../pi-main/packages/vibepaper-agent-service/src/tools/runtime-tools.ts')
const { AGNES_MODELS } = require('./agnes-model-catalog.cjs')
const { getAgentCanvasDomain, createAgentLocalToolClient } = require('./agent-local-tools.cjs')
const { buildAgentCanvasContext } = require('./agent-canvas-context.cjs')
const { buildAgentUsage } = require('./agent-usage.cjs')
const { summarizeAgentToolActivity, summarizeAgentToolRetry } = require('./agent-activity.cjs')

const parentPort = process.parentPort
if (!parentPort) throw new Error('Agent Worker 必须由 Electron utility process 启动。')

let stores = null
let projectMemory = null
let scopedMemory = null
let sessionFragments = null
let planExecution = null
let requestQueue = Promise.resolve()
const activeRuns = new Map()
const scheduledTaskContinuations = new Set()
let continuationApiKey = null
const agentLocalCoreClient = createAgentLocalToolClient(parentPort)

async function requireProject(projectId) {
  if (!stores) throw new Error('AGENT_PROJECT_NOT_OPEN')
  if (typeof projectId !== 'string' || stores.projectId !== projectId) {
    throw new Error('AGENT_PROJECT_CHANGED')
  }
  return stores
}

async function manageSession(method, payload) {
  const current = await requireProject(payload?.projectId)
  const sessionId = payload?.sessionId
  await current.sessions.openSession(sessionId)
  if (method === 'agent:get-session') return current.sessions.getSession(sessionId)
  if (method === 'agent:update-session' || method === 'agent:delete-session') {
    if (method === 'agent:delete-session' || payload.input?.status === 'archived') {
      const running = [...activeRuns.values()].filter((run) => run.sessionId === sessionId)
      for (const run of running) {
        run.cancelled = true
        run.controller.abort()
        run.agent?.abort()
      }
      await Promise.all(running.map((run) => run.completion))
      await planExecution?.onSessionStop(sessionId)
    }
    return method === 'agent:delete-session'
      ? current.sessions.deleteSession(sessionId)
      : current.sessions.updateSession(sessionId, payload.input)
  }
  if (method === 'agent:copy-session') {
    if (payload.input?.canvasId !== undefined && payload.input.canvasId !== payload.canvasId) throw new Error('AGENT_CANVAS_CHANGED')
    return current.sessions.copySession(sessionId, payload.input)
  }
  const skills = listDesktopAgentSkills(undefined, await listProjectAgentSkills(current.projectDirectory))
  return method === 'agent:set-session-skills'
    ? setDesktopSessionSkills(current.sessions, sessionId, payload.input, skills)
    : attachDesktopSessionSkill(current.sessions, sessionId, payload.input, skills)
}

async function managePlan(method, payload) {
  const current = await requireProject(payload?.projectId)
  const ownerId = current.projectId
  if (method === 'agent:plan:create') {
    const input = parseDesktopPlanCreateRequest(payload.input, payload.id)
    return desktopPlanResponse(await current.plans.create({
      ...input, ownerId, sessionId: payload.id, canvasId: payload.canvasId,
    }))
  }
  const planId = parseDesktopPlanId(payload.id)
  if (method === 'agent:plan:execute') return planExecution.execute({
    ...parseDesktopPlanExecuteRequest(payload.input), planId, canvasId: payload.canvasId,
  })
  if (method === 'agent:plan:execution') return planExecution.getExecution({ planId })
  if (method === 'agent:plan:cancel') return planExecution.cancel({ planId })
  if (method === 'agent:plan:get') return desktopPlanResponse(await current.plans.get(planId, ownerId))
  if (method === 'agent:plan:ready-set') return desktopPlanResponse(await current.plans.readySet(planId, ownerId, parseDesktopAgentProfile(payload.input)))
  return desktopPlanResponse(await current.plans.rerun({ planId, ownerId, ...parseDesktopPlanRerunRequest({ stepId: payload.input }) }))
}

async function listSessions(projectId, filter) {
  const current = await requireProject(projectId)
  return current.sessions.listAgentSessions(filter)
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
  const projectSkills = await listProjectAgentSkills(current.projectDirectory)
  const items = listDesktopAgentSkills(keyword, projectSkills)
  if (sessionId) {
    await current.sessions.openSession(sessionId)
    return listDesktopAgentSessionSkills(current.control, sessionId, keyword, projectSkills)
  }
  return { items, loadedSkillIds: [] }
}

function reservedSkillNames() {
  return listDesktopAgentSkills().map((skill) => skill.name)
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

function isSyntheticTaskContinuationProgressMessage(message) {
  if (message?.role !== 'assistant') return false
  const content = historyText(message).trim()
  const isProgress = content === '上一阶段生成已完成，正在读取画布并继续执行后续步骤。'
    || content === '上一阶段生成已结束，正在读取画布并整理失败影响与后续步骤。'
  const hasModelUsage = typeof message.model === 'string' && message.model.length > 0
    && typeof message.usage?.totalTokens === 'number'
  return isProgress && !hasModelUsage
}

function storedHistoryMessage(message) {
  if (isSyntheticTaskContinuationProgressMessage(message)) return null
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

function sessionTimelineRuns(current, sessionId, events) {
  return [...new Set(events.map((event) => event.runId))].flatMap((runId) => {
    if (typeof runId !== 'string' || runId.length < 1 || runId.length > 128) return []
    const run = current.control.findById(runId)
    const createdAt = run?.createdAt instanceof Date ? run.createdAt.getTime() : Number.NaN
    if (!run || run.sessionId !== sessionId || !Number.isSafeInteger(createdAt) || createdAt < 0) return []
    return [{ runId, sessionId: run.sessionId, createdAt }]
  })
}

async function getSessionMessages(projectId, sessionId, sessionEvents) {
  const current = await requireProject(projectId)
  if (typeof sessionId !== 'string' || sessionId.length > 128) throw new Error('SESSION_ID_INVALID')
  const events = sessionEvents ?? await new SessionRunService(current.control).listSessionEvents(sessionId)
  const timelineRuns = sessionTimelineRuns(current, sessionId, events)
  return (await current.sessions.listTranscriptMessages(sessionId, timelineRuns))
    .filter(({ message }) => (message.role === 'user' || message.role === 'assistant')
      && !isSyntheticTaskContinuationProgressMessage(message))
    .map(({ messageId, message, metadata }) => ({
      id: messageId,
      role: message.role,
      content: message.role === 'assistant' ? sanitizeAgentReply(messageText(message)) : messageText(message),
      createdAt: typeof message.timestamp === 'number' ? message.timestamp : 0,
      ...(metadata ? { meta: metadata } : {}),
    }))
    .filter((message) => message.content.trim().length > 0)
}

async function getSessionUsage(projectId, sessionId) {
  const current = await requireProject(projectId)
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 128) {
    throw new Error('SESSION_ID_INVALID')
  }
  const session = await current.sessions.openSession(sessionId)
  const entries = await session.findEntries({ order: 'oldestFirst' })
  return buildAgentUsage(entries, sessionId)
}

async function getSessionSnapshot(projectId, sessionId) {
  const current = await requireProject(projectId)
  await reconcileSessionTasks(current, sessionId)
  const sessionEvents = await new SessionRunService(current.control).listSessionEvents(sessionId)
  const messages = await getSessionMessages(projectId, sessionId, sessionEvents)
  const events = toEventEnvelopes(sessionEvents)
  return { messages, events, lastEventSeq: events.reduce((highest, event) => Math.max(highest, event.eventSeq), 0) }
}

async function listSessionEvents(projectId, sessionId, afterSeq) {
  const current = await requireProject(projectId)
  if (typeof sessionId !== 'string' || sessionId.length > 128
    || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error('AGENT_SESSION_INPUT_INVALID')
  await current.sessions.openSession(sessionId)
  await reconcileSessionTasks(current, sessionId)
  const events = await new SessionRunService(current.control).listSessionEvents(sessionId, afterSeq)
  return toEventEnvelopes(events)
}

async function reconcileSessionTasks(current, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) throw new Error('SESSION_ID_INVALID')
  await current.sessions.openSession(sessionId)
  const reconciled = await reconcileDesktopAgentTasks(current, (taskId) => agentLocalCoreClient.request(
    'agent:core:get-task', { projectId: current.projectId, taskId },
  ), { sessionId, ...(continuationApiKey ? { apiKey: continuationApiKey } : {}) })
  await planExecution?.reconcileAll()
  const continuations = continuationApiKey
    ? await scheduleTaskContinuationClaims(current, reconciled.continuationClaims, continuationApiKey)
    : { scheduled: 0, failed: 0 }
  const { continuationClaims, ...counts } = reconciled
  return { ...counts, ...continuations }
}

async function reconcileProjectTasks(payload) {
  const current = await requireProject(payload?.projectId)
  const apiKey = payload?.apiKey
  if (typeof apiKey !== 'string' || apiKey.length > 4096) {
    continuationApiKey = null
    stopTaskContinuationRuns()
    throw new Error('AGENT_RECONCILIATION_INPUT_INVALID')
  }
  const nextApiKey = apiKey || null
  if (continuationApiKey && continuationApiKey !== nextApiKey) stopTaskContinuationRuns()
  continuationApiKey = nextApiKey
  const reconciled = await reconcileDesktopAgentTasks(current, (taskId) => agentLocalCoreClient.request(
    'agent:core:get-task', { projectId: current.projectId, taskId },
  ), { ...(continuationApiKey ? { apiKey: continuationApiKey } : {}) })
  await planExecution?.reconcileAll()
  const continuations = continuationApiKey
    ? await scheduleTaskContinuationClaims(current, reconciled.continuationClaims, continuationApiKey)
    : { scheduled: 0, failed: 0 }
  const { continuationClaims, ...counts } = reconciled
  return { ...counts, ...continuations }
}

function stopTaskContinuationRuns() {
  for (const runControl of activeRuns.values()) {
    if (!runControl.taskContinuation) continue
    runControl.cancelled = true
    runControl.controller.abort()
    runControl.agent?.abort()
  }
}

async function scheduleTaskContinuationClaims(current, claims, apiKey) {
  if (!apiKey || continuationApiKey !== apiKey || !Array.isArray(claims)) return { scheduled: 0, failed: 0 }
  let scheduled = 0
  let failed = 0
  for (const claim of claims) {
    if (claim?.status !== 'claimed' || claim.shouldStart !== true || !claim.request || !claim.run) continue
    const runId = claim.run.runId
    if (typeof runId !== 'string' || scheduledTaskContinuations.has(runId)) continue
    scheduledTaskContinuations.add(runId)
    try {
      const payload = await taskContinuationPayload(current, claim.request, apiKey)
      if (continuationApiKey !== apiKey) {
        scheduledTaskContinuations.delete(runId)
        continue
      }
      const allSucceeded = claim.request.taskResults.length > 0
        && claim.request.taskResults.every((task) => task.status === 'succeeded')
      const mode = {
        kind: 'task-continuation',
        request: claim.request,
        run: claim.run,
        allSucceeded,
        onSettled: () => scheduledTaskContinuations.delete(runId),
      }
      await startMessage(payload, mode)
      scheduled += 1
    } catch {
      scheduledTaskContinuations.delete(runId)
      failed += 1
      await recordTaskContinuationScheduleFailure(current, claim).catch(() => undefined)
    }
  }
  return { scheduled, failed }
}

async function recordTaskContinuationScheduleFailure(current, claim) {
  const runId = claim?.run?.runId
  const run = typeof runId === 'string' ? current.control.findById(runId) : undefined
  if (!run || run.status !== 'queued') return
  const runService = new SessionRunService(current.control)
  const events = await runService.listEvents(run.runId)
  if (events.some((event) => event.type === 'assistant_delta'
    && event.data?.errorCode === 'AGENT_CONTINUATION_START_FAILED')) return
  await runService.appendEvent(run.runId, 'assistant_delta', {
    text: '自动续跑暂时无法启动，将在下次任务状态检查时重试。',
    errorCode: 'AGENT_CONTINUATION_START_FAILED',
    replace: true,
  })
  await current.sessions.flushOutbox(current.control, run.sessionId)
}

function markTaskContinuationInterrupted(current, runId) {
  try {
    current.control.markTaskContinuationInterrupted(runId, current.projectId)
  } catch {
    // A failed/aborted run is already excluded from queued continuation recovery.
  }
}

function markTaskContinuationCompleted(current, runId) {
  try {
    current.control.markTaskContinuationCompleted(runId, current.projectId)
  } catch {
    // The terminal run remains authoritative if this secondary status write fails.
  }
}

async function taskContinuationPayload(current, request, apiKey) {
  if (request.projectId !== current.projectId || typeof request.sessionId !== 'string'
    || typeof request.idempotencyKey !== 'string' || typeof request.prompt !== 'string') {
    throw new Error('AGENT_CONTINUATION_INVALID')
  }
  const canvas = await agentLocalCoreClient.request('agent:core:load-canvas', { projectId: current.projectId })
  if (!canvas || typeof canvas !== 'object' || Array.isArray(canvas)
    || typeof canvas.canvasId !== 'string' || !canvas.canvasId
    || !Number.isSafeInteger(canvas.version) || canvas.version < 0
    || !Array.isArray(canvas.nodes) || canvas.nodes.length > 1_000_000) {
    throw new Error('AGENT_CANVAS_CONTEXT_INVALID')
  }
  return {
    projectId: current.projectId,
    sessionId: request.sessionId,
    content: request.prompt,
    apiKey,
    idempotencyKey: request.idempotencyKey,
    canvasContext: buildAgentCanvasContext(canvas),
    canvasId: canvas.canvasId,
    canvasVersion: canvas.version,
    canvasNodeCount: canvas.nodes.length,
    selectedNodeIds: [],
    canvasDomain: getAgentCanvasDomain(canvas),
  }
}

async function recoverInterruptedRun(current, runService, sessionId) {
  await reconcileSessionTasks(current, sessionId)
  const activeRun = await runService.findActive(sessionId)
  if (!activeRun) return
  throw new Error(activeRun.status === 'waiting_confirmation' ? 'CONFIRMATION_REQUIRED' : 'SESSION_BUSY')
}

async function prepareBudgetedDesktopHistory(input) {
  let context = await input.current.sessions.buildContext(input.sessionId)
  let history = context.messages.map(storedHistoryMessage).filter(Boolean)
  if (history.some((message) => Array.isArray(message.piMessage?.content)
    && message.piMessage.content.some((block) => block?.type === 'image'))) {
    throw new Error('AGENT_INPUT_MODALITY_UNSUPPORTED')
  }
  let summary = desktopCompactionSummary(context)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (input.taskContinuation && continuationApiKey !== input.apiKey) throw new Error('CLOUD_CREDENTIAL_MISSING')
    const hooks = {
      profile: input.profile,
      desktopMode: true,
      desktopCompactionSummary: summary,
      intentContext: input.intentContext,
      sessionContext: input.sessionContext,
      memoryContext: input.memoryContext,
      runtimeTools: input.runtimeTools,
      desktopMemoryTools: input.desktopMemoryTools,
    }
    const turnContext = prepareDesktopAgentTurnContext(
      history,
      input.content,
      input.skillContext,
      input.nodeReferences,
      hooks,
    )
    const plan = planDesktopContextBudget({
      history: turnContext.initialMessages,
      currentUserInput: turnContext.currentUserInput,
      systemPrompt: turnContext.systemPrompt,
      toolSchemas: turnContext.toolSchemas,
      contextWindowTokens: agnesModel({
        llmModel: AGNES_MODELS.text,
        llmBaseUrl: 'https://apihub.agnes-ai.com/v1',
      }).contextWindow,
      outputReserveTokens: agnesModel({
        llmModel: AGNES_MODELS.text,
        llmBaseUrl: 'https://apihub.agnes-ai.com/v1',
      }).maxTokens,
    })
    if (!plan.requestFitsWithoutHistory) throw new Error('AGENT_CONTEXT_WINDOW_EXCEEDED')
    if (!plan.compactionRequired) return { context, history, summary, turnContext, plan }

    if (input.taskContinuation && continuationApiKey !== input.apiKey) throw new Error('CLOUD_CREDENTIAL_MISSING')
    const nextSummary = await generateDesktopContextSummary({
      messages: plan.summarizedHistory,
      previousSummary: summary,
      authoritativeState: input.sessionContext,
      model: agnesModel({
        llmModel: AGNES_MODELS.text,
        llmBaseUrl: 'https://apihub.agnes-ai.com/v1',
      }),
      apiKey: input.apiKey,
      sessionId: input.sessionId,
      signal: input.signal,
      onSummaryResponse: (response) => input.current.sessions.appendSummaryUsage(input.sessionId, response),
    })
    await input.current.sessions.appendCompaction(input.sessionId, {
      summary: nextSummary,
      retainLastMessages: plan.retainLastMessages,
      tokensBefore: plan.requestTokens,
    })
    context = await input.current.sessions.buildContext(input.sessionId)
    history = context.messages.map(storedHistoryMessage).filter(Boolean)
    summary = desktopCompactionSummary(context)
  }
  throw new Error('AGENT_CONTEXT_COMPACTION_LIMIT')
}

function selectedCanvasState(value, canvasId, canvasVersion, canvasNodeCount) {
  if (!value || typeof value !== 'object' || !value.canvas || !Array.isArray(value.nodes)) {
    throw new Error('AGENT_CANVAS_CONTEXT_INVALID')
  }
  if (value.canvas.id !== canvasId || value.canvas.version !== canvasVersion || value.nodes.length !== canvasNodeCount) {
    throw new Error('AGENT_CANVAS_CHANGED')
  }
  const nodeIds = value.nodes.map((node) => node?.id).filter((id) => typeof id === 'string' && id.length > 0)
  if (nodeIds.length !== value.nodes.length) throw new Error('AGENT_CANVAS_CONTEXT_INVALID')
  return { canvasId, version: value.canvas.version, nodeIds }
}

async function deriveDesktopSessionContext(current, sessionId, canvasId, canvasState) {
  const runService = new SessionRunService(current.control)
  const [events, transcript] = await Promise.all([
    runService.listSessionEvents(sessionId),
    current.sessions.listTranscriptMessages(sessionId),
  ])
  const firstUser = transcript.find(({ message }) => message.role === 'user')?.message
  return projectDesktopSessionContext({
    sessionId,
    canvasId,
    initialGoal: firstUser ? messageText(firstUser).slice(0, 512) : undefined,
    events,
    canvas: canvasState,
  })
}

async function buildDesktopMemoryContext(sessionId, canvasId, query) {
  const [project, global, session, canvas, daily] = await Promise.all([
    scopedMemory.list('project'),
    scopedMemory.list('global'),
    scopedMemory.list('session', sessionId),
    scopedMemory.list('canvas'),
    scopedMemory.list('daily'),
  ])
  return assembleDesktopMemoryContext({
    records: [
    ...project.items,
    ...global.items,
    ...session.items,
    ...canvas.items,
    ...daily.items,
    ],
    query,
    canvasId,
  })
}

function desktopMemoryPayload(payload) {
  const scope = payload?.scope
  if (!['session', 'canvas', 'project', 'global', 'daily'].includes(scope)) throw new Error('MEMORY_SCOPE_INVALID')
  if (scope === 'session') {
    if (typeof payload?.sessionId !== 'string' || !payload.sessionId.trim()) throw new Error('SESSION_ID_INVALID')
  }
  return scope
}

async function agentMemoryDispatch(method, payload) {
  const current = await requireProject(payload?.projectId)
  if (method === 'agent:memory-candidates:list') return scopedMemory.listCandidates()
  if (method === 'agent:memory-candidates:accept' || method === 'agent:memory-candidates:reject') {
    if (typeof payload?.candidateId !== 'string' || payload.candidateId.length < 1 || payload.candidateId.length > 128) {
      throw new Error('MEMORY_CANDIDATE_INVALID')
    }
    const decision = method.endsWith(':accept') ? 'accept' : 'reject'
    const result = await scopedMemory.reviewCandidate(payload.candidateId, decision)
    return { status: decision === 'accept' ? 'accepted' : 'rejected', ...(result.item ? { item: result.item } : {}) }
  }
  if (method === 'agent:memory:export') {
    return scopedMemory.export()
  }

  const scope = payload?.scope
  if (method === 'agent:memory:list') {
    if (scope === undefined) return { items: (await scopedMemory.export()).items }
    const validatedScope = desktopMemoryPayload(payload)
    if (validatedScope === 'session') await current.sessions.openSession(payload.sessionId)
    return await scopedMemory.list(validatedScope, payload.sessionId)
  }
  if (method === 'agent:memory:create') {
    const validatedScope = desktopMemoryPayload(payload)
    requireMemoryContent(payload?.content)
    if (validatedScope === 'session') await current.sessions.openSession(payload.sessionId)
    return await scopedMemory.create(validatedScope, payload.content, payload.sessionId)
  }
  if (method === 'agent:memory:update') {
    const validatedScope = desktopMemoryPayload(payload)
    requireMemoryContent(payload?.content)
    if (typeof payload?.memoryId !== 'string' || payload.memoryId.length < 1 || payload.memoryId.length > 128) {
      throw new Error('MEMORY_ID_INVALID')
    }
    if (validatedScope === 'session') await current.sessions.openSession(payload.sessionId)
    return await scopedMemory.update(validatedScope, payload.memoryId, payload.content, payload.sessionId)
  }
  if (method === 'agent:memory:delete') {
    const validatedScope = desktopMemoryPayload(payload)
    if (typeof payload?.memoryId !== 'string' || payload.memoryId.length < 1 || payload.memoryId.length > 128) {
      throw new Error('MEMORY_ID_INVALID')
    }
    if (validatedScope === 'session') await current.sessions.openSession(payload.sessionId)
    return await scopedMemory.delete(validatedScope, payload.memoryId, payload.sessionId)
  }
  throw new Error('AGENT_METHOD_UNSUPPORTED')
}

function requireMemoryContent(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) throw new Error('MEMORY_CONTENT_INVALID')
}

async function sendMessage(payload, onRunCreated, continuationMode) {
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
    canvasDomain,
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
  if (canvasDomain !== undefined && canvasDomain !== 'general' && canvasDomain !== 'short-drama') {
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

  await current.sessions.openSession(sessionId)
  if (!(await current.sessions.isSessionActive(sessionId))) throw new Error('SESSION_ARCHIVED')
  const runService = new SessionRunService(current.control)
  const existing = current.control.findByIdempotency(sessionId, idempotencyKey)
  if (continuationMode) {
    if (continuationMode.kind !== 'task-continuation' || continuationApiKey !== apiKey
      || !existing || existing.runId !== continuationMode.run?.runId || existing.status !== 'queued'
      || continuationMode.run.sessionId !== sessionId || continuationMode.run.idempotencyKey !== idempotencyKey) {
      throw new Error(continuationApiKey === apiKey ? 'AGENT_CONTINUATION_RUN_INVALID' : 'CLOUD_CREDENTIAL_MISSING')
    }
  } else if (existing) {
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

  if (!continuationMode) await recoverInterruptedRun(current, runService, sessionId)
  const selectedNodes = [...new Set(selectedNodeIds ?? [])]
  const gateway = new DesktopLocalToolGateway(agentLocalCoreClient, current.projectId)
  const canvasSummary = await gateway.getCanvasSummary(current.projectId, canvasId)
  const canvasState = selectedCanvasState(canvasSummary, canvasId, canvasVersion, canvasNodeCount)
  const nodeReferences = selectedNodes.length
    ? selectNodeReferences(await gateway.getSelectedNodes(current.projectId, canvasId, selectedNodes), selectedNodes)
    : []
  const sessionContext = await deriveDesktopSessionContext(current, sessionId, canvasId, canvasState)
  const run = continuationMode?.run ?? await runService.startRun({ sessionId, idempotencyKey })
  gateway.attachRun({ control: current.control, sessionId, runId: run.runId })
  let resolveCompletion
  const completion = new Promise((resolve) => { resolveCompletion = resolve })
  const runControl = {
    sessionId,
    controller: new AbortController(), agent: null, cancelled: false, completion, resolveCompletion,
    taskContinuation: Boolean(continuationMode),
  }
  activeRuns.set(run.runId, runControl)
  await runService.setStatus(run.runId, 'running')
  onRunCreated?.({ runId: run.runId })

  const approvals = new ApprovalService(current.control, current.control.getOrCreateApprovalSecret(), 10 * 60)
  let persistenceQueue = Promise.resolve()
  let persistenceFailure = null
  const persistPiMessage = (message) => {
    const persisted = message.role === 'assistant' ? sanitizeAssistantMessage(message) : message
    persistenceQueue = persistenceQueue.then(() => current.sessions.appendMessage(sessionId, persisted, {
      selectedNodeIds: [], nodeReferences: [], runId: run.runId,
    }))
    persistenceQueue = persistenceQueue.catch((error) => {
      persistenceFailure = error
      throw error
    })
    return persistenceQueue
  }
  let turn
  let toolContext
  try {
    if (continuationMode) {
      const progressMessage = continuationMode.allSucceeded
        ? '上一阶段生成已完成，正在读取画布并继续执行后续步骤。'
        : '上一阶段生成已结束，正在读取画布并整理失败影响与后续步骤。'
      await runService.appendEvent(run.runId, 'assistant_delta', { text: progressMessage, replace: true })
    }
    const projectSkills = await listProjectAgentSkills(current.projectDirectory)
    const skillContext = createDesktopAgentSkillContext(current.control, sessionId, selectedSkillId, projectSkills)
    const memoryContext = await buildDesktopMemoryContext(sessionId, canvasId, content.trim())
    const profile = selectProfile({ canvasDomain })
    const intentContext = `本轮画布摘要（只作线索；版本与节点身份以本地读取工具返回为准）：\n${JSON.stringify(canvasContext)}\n\n当前权威画布版本：${canvasState.version}；节点数：${canvasState.nodeIds.length}。`
    toolContext = {
      userId: current.projectId,
      sessionId,
      runId: run.runId,
      canvasId,
      canvasVersion,
      referenceNodeIds: selectedNodes,
      gateway,
      approvals,
      desktopMode: true,
      continueAfterTask: continuationMode ? true : undefined,
      onAuditRequested: async (input) => gateway.requestRenderAudit(current.projectId, canvasId, toolContext.canvasVersion, input),
      onApprovalRequired: async (action) => {
        if (action.toolName === 'delete_nodes') {
          await runService.appendEvent(run.runId, 'confirmation_required', {
            kind: 'canvas_delete', actionId: action.actionId, approvalToken: action.approvalToken,
            tool: action.toolName, summary: '确认删除节点及关联连线',
            canvasId: action.canvasId, canvasVersion: action.canvasVersion,
            expiresAt: action.binding.expiresAt, ...action.params.preview,
          })
          return
        }
        const generationItems = await desktopGenerationConfirmationItems(action, gateway)
        await runService.appendEvent(run.runId, 'confirmation_required', {
          kind: 'generation',
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
    const runtimeToolsForTurn = createRuntimeTools(toolContext)
    const desktopMemoryTools = projectMemory.createTools(content.trim())
    const prepared = await prepareBudgetedDesktopHistory({
      current,
      sessionId,
      content: content.trim(),
      apiKey,
      signal: runControl.controller.signal,
      profile,
      skillContext,
      nodeReferences,
      runtimeTools: runtimeToolsForTurn,
      desktopMemoryTools,
      sessionContext,
      intentContext,
      memoryContext,
      taskContinuation: Boolean(continuationMode),
    })
    if (runControl.controller.signal.aborted) throw new Error('RUN_ABORTED')

    // The persisted user entry is appended after compaction and remains separate
    // from the prior-turn model history. Pi receives it once through prompt().
    if (!continuationMode) {
      await current.sessions.appendMessage(sessionId, {
        role: 'user',
        content: [{ type: 'text', text: content.trim() }],
        timestamp: Date.now(),
      },
        {
          selectedNodeIds: nodeReferences.map((reference) => reference.nodeId),
          nodeReferences,
          ...(selectedSkillId ? { selectedSkillId } : {}),
          runId: run.runId,
        })
      await current.sessions.resolveSessionTitle(sessionId)
    }

    if (!continuationMode) {
      for (const candidate of extractMemoryCandidates(content.trim())) {
        // Match the original HTTP path: automatic hints must not gate a turn.
        try {
          await scopedMemory.proposeCandidate({
            sessionId,
            content: candidate.content,
            scope: desktopCandidateScope(content, candidate.scope),
            memoryType: candidate.memoryType,
            confidence: candidate.confidence,
          })
        } catch { /* Explicit memory tools still report their own errors. */ }
      }
      const dailyContent = extractDailyMemory(content.trim())
      if (dailyContent) {
        try { await scopedMemory.create('daily', dailyContent, sessionId) } catch { /* Best-effort hint. */ }
      }
    }

    if (continuationMode && continuationApiKey !== apiKey) throw new Error('CLOUD_CREDENTIAL_MISSING')
    turn = await runDramaTurn(
      {
        llmApiKey: apiKey,
        llmBaseUrl: 'https://apihub.agnes-ai.com/v1',
        llmModel: AGNES_MODELS.text,
      },
      undefined,
      sessionId,
      prepared.history,
      content.trim(),
      skillContext,
      nodeReferences,
      {
        profile,
        desktopMode: true,
        runtimeTools: runtimeToolsForTurn,
        desktopMemoryTools,
        desktopCompactionSummary: prepared.summary,
        sessionContext,
        desktopTurnContext: prepared.turnContext,
        intentContext,
        memoryContext,
        shouldStopAfterTurn: () => runControl.cancelled || runControl.controller.signal.aborted || Boolean(toolContext.confirmationPending),
        onAgent(agent) {
          runControl.agent = agent
          if (runControl.cancelled) agent.abort()
          agent.subscribe(async (event) => {
            if (event.type !== 'message_end') return
            if (event.message.role !== 'assistant' && event.message.role !== 'toolResult') return
            await persistPiMessage(event.message)
          })
        },
        onEvent: async (event) => {
          if (event.type === 'assistant_message' && event.content) {
            await runService.appendEvent(run.runId, 'assistant_delta', { text: event.content, replace: true })
          } else if (event.type === 'thinking' && event.content) {
            await runService.appendEvent(run.runId, 'thinking', { text: event.content })
          } else if (event.type === 'tool_started') {
            await runService.appendEvent(run.runId, 'tool_started', {
              tool: event.toolName ?? 'operation',
              args: summarizeAgentToolActivity(event.toolName, 'started', event.details),
            })
          } else if (event.type === 'tool') {
            await runService.appendEvent(run.runId, 'tool_completed', {
              tool: event.toolName ?? 'operation',
              ok: event.ok !== false,
              ...(event.ok === false && event.errorCode ? { errorCode: event.errorCode } : {}),
              details: summarizeAgentToolActivity(
                event.toolName,
                'completed',
                undefined,
                event.details,
                event.ok !== false,
                event.errorCode,
              ),
            })
          } else if (event.type === 'tool_retry') {
            await runService.appendEvent(run.runId, 'tool_retry', {
              tool: event.toolName ?? 'operation',
              ...summarizeAgentToolRetry(event.details),
            })
          }
        },
      },
    )
    await persistenceQueue
  } catch (error) {
    const cancelled = runControl.controller.signal.aborted || error?.message === 'RUN_ABORTED'
    const errorCode = persistenceFailure ? 'AGENT_SESSION_WRITE_FAILED'
      : cancelled ? 'RUN_ABORTED'
        : typeof error?.code === 'string' && /^[A-Z0-9_]{2,80}$/u.test(error.code) ? error.code
          : typeof error?.message === 'string' && /^[A-Z0-9_]{2,80}$/u.test(error.message) ? error.message
            : 'AGENT_MODEL_REQUEST_FAILED'
    current.control.invalidatePendingForRun(run.runId)
    await runService.setStatus(run.runId, cancelled ? 'aborted' : 'failed',
      cancelled ? { reason: 'user_cancelled' } : { errorCode })
    if (continuationMode) markTaskContinuationInterrupted(current, run.runId)
    await current.sessions.flushOutbox(current.control, sessionId)
    finishActiveRun(run.runId)
    throw new Error(errorCode)
  }

  const assistantText = sanitizeAgentReply(turn?.assistantText ?? '')
  const errorEvent = turn?.events?.find((event) => event.type === 'error')
  if (runControl.controller.signal.aborted) {
    current.control.invalidatePendingForRun(run.runId)
    await runService.setStatus(run.runId, 'aborted', { reason: 'user_cancelled' })
    if (continuationMode) markTaskContinuationInterrupted(current, run.runId)
    await current.sessions.flushOutbox(current.control, sessionId)
    finishActiveRun(run.runId)
    throw new Error('RUN_ABORTED')
  }
  if ((!toolContext.confirmationPending && !assistantText.trim()) || errorEvent) {
    const errorCode = typeof errorEvent?.errorCode === 'string' ? errorEvent.errorCode : 'AGENT_MODEL_REQUEST_FAILED'
    current.control.invalidatePendingForRun(run.runId)
    await runService.setStatus(run.runId, 'failed', { errorCode })
    if (continuationMode) markTaskContinuationInterrupted(current, run.runId)
    await current.sessions.flushOutbox(current.control, sessionId)
    finishActiveRun(run.runId)
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
    finishActiveRun(run.runId)
    return { runId: run.runId, assistantText, waitingConfirmation: true }
  }
  await runService.setStatus(run.runId, 'completed', { text: assistantText })
  if (continuationMode) markTaskContinuationCompleted(current, run.runId)
  await current.sessions.flushOutbox(current.control, sessionId)
  finishActiveRun(run.runId)
  return { assistantText, events: toEventEnvelopes(await runService.listEvents(run.runId)) }
}

function finishActiveRun(runId) {
  const active = activeRuns.get(runId)
  if (!active) return
  activeRuns.delete(runId)
  active.resolveCompletion?.()
}

async function startMessage(payload, continuationMode) {
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
  }, continuationMode).catch((error) => {
    if (settled) return
    settled = true
    rejectCreated(error)
  }).finally(() => continuationMode?.onSettled?.())
  return created
}

async function confirmAgentAction(payload) {
  const current = await requireProject(payload?.projectId)
  if (planExecution?.handlesAction(payload?.actionId)) return planExecution.confirm(payload)
  const gateway = new DesktopLocalToolGateway(agentLocalCoreClient, current.projectId)
  const record = current.control.find(payload?.actionId)
  const runId = record?.action?.runId
  if (typeof runId === 'string') {
    const run = current.control.findById(runId)
    if (run && run.sessionId === payload?.sessionId) {
      gateway.attachRun({ control: current.control, sessionId: run.sessionId, runId: run.runId })
    }
  }
  await current.sessions.openSession(payload?.sessionId)
  return record?.action?.toolName === 'delete_nodes'
    ? confirmDesktopDeleteAction(payload ?? {}, current, gateway)
    : confirmDesktopGenerationAction(payload ?? {}, current, gateway)
}

async function cancelAgentRun(payload) {
  const current = await requireProject(payload?.projectId)
  if (typeof payload?.runId !== 'string' || payload.runId.length < 1 || payload.runId.length > 128) {
    throw new Error('AGENT_RUN_INPUT_INVALID')
  }
  if (typeof payload?.sessionId !== 'string' || payload.sessionId.length < 1 || payload.sessionId.length > 128) {
    throw new Error('AGENT_RUN_INPUT_INVALID')
  }
  const run = current.control.findById(payload.runId)
  if (!run || run.sessionId !== payload.sessionId
    || !['queued', 'running', 'waiting_confirmation', 'waiting_task'].includes(run.status)) {
    return { cancelled: false }
  }
  const planCancellation = await planExecution?.cancelRun(run.runId)
  if (planCancellation?.cancelled) return planCancellation
  const active = activeRuns.get(run.runId)
  if (active) {
    active.cancelled = true
    active.controller.abort()
    active.agent?.abort()
    return { cancelled: true }
  }
  if (run.status === 'waiting_confirmation') {
    current.control.invalidatePendingForRun(run.runId)
    await new SessionRunService(current.control).setStatus(run.runId, 'aborted', { reason: 'user_cancelled' })
    markTaskContinuationInterrupted(current, run.runId)
    await current.sessions.flushOutbox(current.control, run.sessionId)
    return { cancelled: true }
  }
  return { cancelled: false }
}

async function abortAndWaitForRuns() {
  await planExecution?.stop()
  const active = [...activeRuns.values()]
  for (const runControl of active) {
    runControl.cancelled = true
    runControl.controller.abort()
    runControl.agent?.abort()
  }
  if (active.length) {
    const completed = Promise.all(active.map((runControl) => runControl.completion))
    let timeoutHandle
    const timeout = new Promise((resolve) => { timeoutHandle = setTimeout(resolve, 10_000) })
    await Promise.race([completed, timeout])
    clearTimeout(timeoutHandle)
  }
  if (activeRuns.size) throw new Error('AGENT_RUN_SHUTDOWN_TIMEOUT')
}

function toEventEnvelopes(events) {
  return [...events]
    .sort((left, right) => left.eventSeq - right.eventSeq)
    .map(({ eventId, runId, sessionId, eventSeq, type, runtime, runtimeVersion, data, createdAt }) => ({
      eventId, runId, sessionId, eventSeq, type, runtime, runtimeVersion, data,
      ...(createdAt instanceof Date && Number.isSafeInteger(createdAt.getTime())
        ? { createdAt: createdAt.getTime() }
        : {}),
    }))
}

async function dispatch(method, payload) {
  switch (method) {
    case 'agent:open': {
      if (!payload || typeof payload.projectDirectory !== 'string') throw new Error('AGENT_PROJECT_PATH_INVALID')
      continuationApiKey = null
      scheduledTaskContinuations.clear()
      await abortAndWaitForRuns()
      if (stores) await stores.close()
      stores = null
      planExecution = null
      projectMemory = null
      scopedMemory = null
      sessionFragments = null
      const openedStores = await openDesktopAgentStores(payload.projectDirectory)
      try {
        const openedMemory = new DesktopProjectMemory(openedStores.projectDirectory, openedStores.projectId, {
          ...(typeof payload.userDataDirectory === 'string' ? { userDataDirectory: payload.userDataDirectory } : {}),
        })
        await openedMemory.initialize()
        const openedScopedMemory = new DesktopScopedMemoryStore(
          openedStores.projectDirectory,
          openedStores.projectId,
          openedStores.sessions,
          openedMemory,
          openedStores.control,
        )
        await openedScopedMemory.initialize()
        const openedFragments = new DesktopSessionFragments(
          openedStores.projectDirectory,
          openedStores.projectId,
          openedStores.sessions,
        )
        await openedFragments.initialize()
        await recoverDesktopAgentRuns(openedStores)
        const openedPlanExecution = new DesktopPlanExecutionService(openedStores, {
          gatewayFactory: ({ sessionId, runId }) => {
            const gateway = new DesktopLocalToolGateway(agentLocalCoreClient, openedStores.projectId)
            gateway.attachRun({ control: openedStores.control, sessionId, runId })
            return gateway
          },
          readTask: (taskId) => agentLocalCoreClient.request('agent:core:get-task', {
            projectId: openedStores.projectId, taskId,
          }),
          skillContextFactory: async (sessionId) => createDesktopAgentSkillContext(
            openedStores.control, sessionId, undefined, await listProjectAgentSkills(openedStores.projectDirectory),
          ),
          onAuditRequested: (input, context) => context.gateway.requestRenderAudit(
            openedStores.projectId, context.canvasId, context.canvasVersion, input,
          ),
        })
        await openedPlanExecution.recoverAll()
        stores = openedStores
        planExecution = openedPlanExecution
        projectMemory = openedMemory
        scopedMemory = openedScopedMemory
        sessionFragments = openedFragments
        return { projectId: openedStores.projectId }
      } catch (error) {
        await openedStores.close()
        throw error
      }
    }
    case 'agent:list-sessions':
      return listSessions(payload?.projectId, payload?.filter)
    case 'agent:get-session':
    case 'agent:update-session':
    case 'agent:delete-session':
    case 'agent:copy-session':
    case 'agent:set-session-skills':
    case 'agent:attach-session-skill':
      return manageSession(method, payload)
    case 'agent:plan:create':
    case 'agent:plan:get':
    case 'agent:plan:ready-set':
    case 'agent:plan:rerun':
    case 'agent:plan:execute':
    case 'agent:plan:execution':
    case 'agent:plan:cancel':
      return managePlan(method, payload)
    case 'agent:list-skills':
      return listAgentSkills(payload)
    case 'agent:create-skill': {
      const current = await requireProject(payload?.projectId)
      return createProjectAgentSkill(current.projectDirectory, payload?.draft, reservedSkillNames())
    }
    case 'agent:update-skill': {
      const current = await requireProject(payload?.projectId)
      return updateProjectAgentSkill(current.projectDirectory, payload?.skillId, payload?.patch, reservedSkillNames())
    }
    case 'agent:delete-skill': {
      const current = await requireProject(payload?.projectId)
      return deleteProjectAgentSkill(current.projectDirectory, payload?.skillId)
    }
    case 'agent:import-skill': {
      const current = await requireProject(payload?.projectId)
      return importProjectAgentSkill(current.projectDirectory, payload?.fileName, payload?.contents, reservedSkillNames())
    }
    case 'agent:get-messages':
      return getSessionMessages(payload?.projectId, payload?.sessionId)
    case 'agent:get-usage':
      return getSessionUsage(payload?.projectId, payload?.sessionId)
    case 'agent:get-snapshot':
      return getSessionSnapshot(payload?.projectId, payload?.sessionId)
    case 'agent:list-events':
      return listSessionEvents(payload?.projectId, payload?.sessionId, payload?.afterSeq)
    case 'agent:list-fragments': {
      await requireProject(payload?.projectId)
      return sessionFragments.list()
    }
    case 'agent:save-session-fragment': {
      const current = await requireProject(payload?.projectId)
      if (typeof payload?.sessionId !== 'string' || payload.sessionId.length < 1 || payload.sessionId.length > 128
        || (payload.title !== undefined && (typeof payload.title !== 'string' || payload.title.length > 120))) {
        throw new Error('AGENT_SESSION_FRAGMENT_INPUT_INVALID')
      }
      await current.sessions.openSession(payload.sessionId)
      return sessionFragments.save(payload.sessionId, payload.title)
    }
    case 'agent:import-fragment': {
      await requireProject(payload?.projectId)
      if (typeof payload?.fragmentId !== 'string' || payload.fragmentId.length < 1 || payload.fragmentId.length > 128
        || (payload.canvasId !== undefined && (typeof payload.canvasId !== 'string' || payload.canvasId.length < 1 || payload.canvasId.length > 128))) {
        throw new Error('AGENT_SESSION_FRAGMENT_INPUT_INVALID')
      }
      return sessionFragments.import(payload.fragmentId, payload.canvasId)
    }
    case 'agent:create-session': {
      const current = await requireProject(payload?.projectId)
      const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 120) : ''
      const session = await current.sessions.createSession(title || undefined, payload.canvasId)
      return { sessionId: session.id, createdAt: session.createdAt }
    }
    case 'agent:send-message':
      return sendMessage(payload)
    case 'agent:start-run':
      return startMessage(payload)
    case 'agent:reconcile-tasks':
      return reconcileProjectTasks(payload)
    case 'agent:confirm-action':
      return confirmAgentAction(payload)
    case 'agent:cancel-run':
      return cancelAgentRun(payload)
    case 'agent:memory:list':
    case 'agent:memory:create':
    case 'agent:memory:update':
    case 'agent:memory:delete':
    case 'agent:memory:export':
    case 'agent:memory-candidates:list':
    case 'agent:memory-candidates:accept':
    case 'agent:memory-candidates:reject':
      return agentMemoryDispatch(method, payload)
    case 'agent:close':
      continuationApiKey = null
      scheduledTaskContinuations.clear()
      await abortAndWaitForRuns()
      agentLocalCoreClient.close()
      if (stores) await stores.close()
      stores = null
      planExecution = null
      projectMemory = null
      scopedMemory = null
      sessionFragments = null
      return null
    default:
      throw new Error('AGENT_METHOD_UNSUPPORTED')
  }
}

parentPort.on('message', async (event) => {
  const request = event?.data ?? event
  if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== 'string') return
  const executeRequest = async () => {
    try {
      const result = await dispatch(request.method, request.payload)
      parentPort.postMessage({ id: request.id, ok: true, result })
    } catch (error) {
      parentPort.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error && /^[A-Z0-9_]{1,120}$/u.test(error.code ?? error.message)
          ? error.code ?? error.message
          : 'AGENT_SESSION_OPERATION_FAILED',
      })
    }
  }
  if (request.method === 'agent:cancel-run' || request.method === 'agent:plan:cancel') {
    void executeRequest()
    return
  }
  requestQueue = requestQueue.then(executeRequest)
})
