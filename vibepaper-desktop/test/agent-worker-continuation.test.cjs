const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')

const workerSource = fs.readFileSync(path.resolve(__dirname, '../src/agent-worker.cjs'), 'utf8')

function createStores(projectId) {
  const runs = new Map()
  return {
    projectId,
    projectDirectory: projectId,
    control: {
      findById(runId) {
        return runs.get(runId) ?? { runId, sessionId: 'session-1', status: 'queued' }
      },
      findByIdempotency() { return undefined },
      markTaskContinuationCompleted() {},
      markTaskContinuationInterrupted() {},
      invalidatePendingForRun() {},
      getOrCreateApprovalSecret() { return 'test-only-secret' },
      getLoadedSkillIds() { return [] },
      _runs: runs,
    },
    sessions: {
      async close() {},
      async flushOutbox() {},
      async listSessions() { return [] },
      async openSession() { return {} },
      async listTranscriptMessages() { return [] },
      async resolveSessionTitle() { return '新对话' },
    },
    async close() {},
  }
}

function createWorkerHarness(options = {}) {
  const parentPort = new EventEmitter()
  parentPort.postMessage = () => {}
  const runtime = options.runtime ?? {
    starts: [],
    reconcileCalls: [],
    canvasRequests: [],
    runEvents: new Map(),
    claims: [],
    sessionMessages: [],
    memoryCandidateCalls: 0,
    dailyMemoryCalls: 0,
    scopedMemoryWrites: 0,
    turnCalls: [],
    generationTaskCalls: 0,
    confirmationActions: [],
    continuationStatus: 'claimed',
    coreRequests: [],
    loadCanvas: async () => ({ canvasId: 'canvas-1', version: 0, nodes: [] }),
  }
  class SessionRunService {
    constructor(control) { this.control = control }
    async listSessionEvents() { return [] }
    async listEvents(runId) { return runtime.runEvents.get(runId) ?? [] }
    async appendEvent(runId, type, data) {
      const events = runtime.runEvents.get(runId) ?? []
      const event = { runId, type, data }
      events.push(event)
      runtime.runEvents.set(runId, events)
      return event
    }
  }
  class NoopStore {
    constructor() {}
    async initialize() {}
    createTools() { return [] }
  }
  class TestProjectMemory extends NoopStore {
    createTools(query) {
      runtime.memoryToolQueries = [...(runtime.memoryToolQueries ?? []), query]
      return []
    }
  }
  class TestScopedMemory extends NoopStore {
    async list(scope) {
      runtime.scopedMemoryReads = [...(runtime.scopedMemoryReads ?? []), scope]
      return { items: [] }
    }
    async proposeCandidate() { runtime.scopedMemoryWrites += 1 }
    async create() { runtime.scopedMemoryWrites += 1 }
  }
  const stubs = {
    'agent-stores.ts': {
      openDesktopAgentStores: async (projectDirectory) => createStores(projectDirectory),
    },
    'project-memory.ts': { DesktopProjectMemory: TestProjectMemory },
    'session-fragments.ts': { DesktopSessionFragments: NoopStore },
    'scoped-memory.ts': {
      DesktopScopedMemoryStore: TestScopedMemory,
      desktopCandidateScope() { return 'canvas' },
    },
    'session-store.ts': { desktopCompactionSummary: () => '' },
    'context-assembler.ts': {
      assembleDesktopMemoryContext: () => 'test memory context',
      projectDesktopSessionContext: () => ({ initialGoal: null }),
      planDesktopContextBudget: () => ({ requestFitsWithoutHistory: true, compactionRequired: false }),
    },
    'session-run-service.ts': { SessionRunService: options.SessionRunService ?? SessionRunService },
    'approval-service.ts': { ApprovalService: options.ApprovalService ?? NoopStore },
    'generation-confirmation.ts': { confirmDesktopGenerationAction() {}, recoverDesktopAgentRuns: async () => {} },
    'task-status-sync.ts': {
      async reconcileDesktopAgentTasks(stores, _reader, options) {
        runtime.reconcileCalls.push({ projectId: stores.projectId, options })
        return {
          checked: 0,
          updated: 0,
          finalizedRuns: 0,
          unreadable: 0,
          expiredConfirmations: 0,
          continuationClaims: runtime.claims,
        }
      },
    },
    'skill-context.ts': {
      createDesktopAgentSkillContext: () => ({ indexLines: [], skills: [], loadedSkillIds: [], loadedSkills: [], onLoad: async () => {} }),
      listDesktopAgentSkills: () => [],
    },
    'node-reference-context.ts': { selectNodeReferences: () => [] },
    'agent-runtime.ts': {
      agnesModel: () => ({ contextWindow: 128_000, maxTokens: 4_096 }),
      prepareDesktopAgentTurnContext: (history, content, _skillContext, _nodeReferences, hooks) => ({
        initialMessages: history.map((message) => message.piMessage).filter(Boolean),
        currentUserInput: content,
        systemPrompt: 'test-only system prompt',
        toolSchemas: [],
        runtimeTools: hooks.runtimeTools,
      }),
      sanitizeAgentReply: (text) => text,
      sanitizeAssistantMessage: (message) => message,
      ...(options.agentRuntime ?? {}),
    },
    'memory-candidate-extractor.ts': {
      extractMemoryCandidates() { runtime.memoryCandidateCalls += 1; return [] },
    },
    'daily-memory-service.ts': {
      extractDailyMemory() { runtime.dailyMemoryCalls += 1; return undefined },
    },
    'profile-selector.ts': { selectProfile: () => ({ name: 'test-profile' }) },
    'local-tool-gateway.ts': options.localToolGateway ?? {},
    'runtime-tools.ts': options.runtimeTools ?? {},
    'agnes-model-catalog.cjs': { AGNES_MODELS: {} },
    'agent-local-tools.cjs': {
      getAgentCanvasDomain: () => 'general',
      createAgentLocalToolClient: () => ({
        async request(method, payload) {
          runtime.canvasRequests.push({ method, payload })
          runtime.coreRequests.push({ method, payload })
          if (method === 'agent:core:load-canvas') return runtime.loadCanvas()
          if (method === 'agent:core:list-models') return runtime.models ?? []
          if (method === 'agent:core:create-generation-task') {
            runtime.generationTaskCalls += 1
            return { taskId: 'must-not-be-created', status: 'queued' }
          }
          return {}
        },
        close() {},
      }),
    },
    'agent-canvas-context.cjs': { buildAgentCanvasContext: () => 'canvas context' },
    'agent-usage.cjs': {},
    'agent-activity.cjs': {},
    'project-agent-skills.cjs': { listProjectAgentSkills: async () => [] },
  }
  const fakeRequire = (request) => {
    const basename = path.basename(request)
    const stub = stubs[basename]
    if (!stub) throw new Error(`Unexpected Worker import: ${request}`)
    return stub
  }
  const module = { exports: {} }
  let instrumentedWorkerSource = workerSource
  if (options.captureStartErrors) {
    instrumentedWorkerSource = instrumentedWorkerSource.replace(
      '  } catch (error) {\n    const cancelled = runControl.controller.signal.aborted',
      '  } catch (error) {\n    parentPort.testTurnErrors.push(error?.stack ?? error?.message ?? String(error))\n    const cancelled = runControl.controller.signal.aborted',
    )
    instrumentedWorkerSource = instrumentedWorkerSource.replace(
      '  }, continuationMode).catch((error) => {\n    if (settled) return',
      '  }, continuationMode).catch((error) => {\n    parentPort.testStartErrors.push(error?.stack ?? error?.message ?? String(error))\n    if (settled) return',
    )
  }
  if (options.captureStartErrors && instrumentedWorkerSource === workerSource) {
    throw new Error('Worker source did not match the test-only startMessage error observer')
  }
  parentPort.testStartErrors = []
  parentPort.testTurnErrors = []
  const context = vm.createContext({
    process: { parentPort },
    module,
    exports: module.exports,
    require: fakeRequire,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { warn() {}, error() {} },
  })
  const wrapper = vm.runInContext(`(function (exports, require, module, process) {\n${instrumentedWorkerSource}\nmodule.exports.__testHooks = {
    dispatch,
    setStores(value) { stores = value },
    setAgentContext(value) {
      projectMemory = value.projectMemory
      scopedMemory = value.scopedMemory
      sessionFragments = value.sessionFragments
    },
    setStartMessage(value) { startMessage = value },
    getContinuationApiKey() { return continuationApiKey },
  }\n})`, context)
  wrapper(module.exports, fakeRequire, module, context.process)
  return { hooks: module.exports.__testHooks, runtime, parentPort }
}

function makeClaim(projectId, runId) {
  const idempotencyKey = 'task-continuation:origin-run-1'
  const request = {
    originRunId: 'origin-run-1',
    projectId,
    sessionId: 'session-1',
    idempotencyKey,
    prompt: '请根据已完成任务继续后续步骤。',
    taskResults: [{ taskId: 'task-1', status: 'succeeded' }],
  }
  return {
    status: 'claimed',
    request,
    run: { runId, sessionId: request.sessionId, idempotencyKey, status: 'queued' },
    shouldStart: true,
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail('condition did not become true')
}

test('continuation scheduler requires a key and deduplicates concurrent notifications by Run', async () => {
  const { hooks, runtime } = createWorkerHarness()
  hooks.setStores(createStores('project-1'))
  runtime.claims = [makeClaim('project-1', 'continuation-run-1')]
  const startGate = deferred()
  hooks.setStartMessage((payload, mode) => {
    runtime.starts.push({ payload, mode })
    return startGate.promise
  })

  const noKey = await hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: '' })
  assert.equal(runtime.starts.length, 0)
  assert.equal(noKey.scheduled, 0)
  assert.equal(runtime.reconcileCalls[0].options.apiKey, undefined)

  const first = hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: 'test-key-one' })
  await waitFor(() => runtime.starts.length === 1)
  const second = await hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: 'test-key-one' })
  assert.equal(runtime.starts.length, 1)
  assert.equal(second.scheduled, 0)
  assert.equal('continuationClaims' in second, false)
  assert.equal(JSON.stringify(second).includes('test-key-one'), false)
  assert.equal(runtime.starts[0].payload.content, runtime.claims[0].request.prompt)
  assert.equal(runtime.starts[0].payload.idempotencyKey, runtime.claims[0].request.idempotencyKey)
  assert.equal(runtime.starts[0].mode.kind, 'task-continuation')

  runtime.starts[0].mode.onSettled()
  startGate.resolve({ runId: 'continuation-run-1' })
  const firstResult = await first
  assert.equal(firstResult.scheduled, 1)
})

test('in-flight continuation dispatch is discarded after key rotation or project switch', async () => {
  const { hooks, runtime } = createWorkerHarness()
  hooks.setStores(createStores('project-1'))
  runtime.claims = [makeClaim('project-1', 'continuation-run-key-rotation')]
  const oldCanvas = deferred()
  runtime.loadCanvas = () => oldCanvas.promise
  hooks.setStartMessage((payload, mode) => {
    runtime.starts.push({ payload, mode })
    return Promise.resolve({ runId: mode.run.runId })
  })

  const oldKeyDispatch = hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: 'test-key-old' })
  await waitFor(() => runtime.canvasRequests.length === 1)
  await hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: 'test-key-new' })
  oldCanvas.resolve({ canvasId: 'canvas-1', version: 0, nodes: [] })
  await oldKeyDispatch
  assert.equal(runtime.starts.length, 0)
  assert.equal(hooks.getContinuationApiKey(), 'test-key-new')

  runtime.claims = [makeClaim('project-1', 'continuation-run-project-switch')]
  const oldProjectCanvas = deferred()
  runtime.loadCanvas = () => oldProjectCanvas.promise
  const oldProjectDispatch = hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: 'test-key-new' })
  await waitFor(() => runtime.canvasRequests.length === 2)
  await hooks.dispatch('agent:open', { projectDirectory: 'project-2' })
  oldProjectCanvas.resolve({ canvasId: 'canvas-1', version: 0, nodes: [] })
  await oldProjectDispatch
  assert.equal(runtime.starts.length, 0)
  assert.equal(hooks.getContinuationApiKey(), null)

  runtime.claims = [makeClaim('project-2', 'continuation-run-no-key-after-switch')]
  const noKeyAfterSwitch = await hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-2', apiKey: '' })
  assert.equal(noKeyAfterSwitch.scheduled, 0)
  assert.equal(runtime.starts.length, 0)
})

test('queued startup failures remain visible and append their retry event once', async () => {
  const { hooks, runtime } = createWorkerHarness()
  hooks.setStores(createStores('project-1'))
  runtime.claims = [makeClaim('project-1', 'continuation-run-start-failure')]
  runtime.loadCanvas = async () => { throw new Error('temporary canvas read failure') }
  hooks.setStartMessage(async () => { assert.fail('failed setup must not start a model turn') })

  const first = await hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: 'test-key' })
  const second = await hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: 'test-key' })
  const events = runtime.runEvents.get('continuation-run-start-failure') ?? []
  assert.equal(first.failed, 1)
  assert.equal(second.failed, 1)
  assert.equal(events.filter((event) => event.data?.errorCode === 'AGENT_CONTINUATION_START_FAILED').length, 1)
  assert.equal(events[0].data.text.includes('test-key'), false)
})

async function loadOriginalTurnModules() {
  const src = path.resolve(__dirname, '../../pi-main/packages/vibepaper-agent-service/src')
  const load = (relativePath) => import(pathToFileURL(path.join(src, relativePath)).href)
  const [runService, approval, runtimeTools, localToolGateway] = await Promise.all([
    load('application/session-run-service.ts'),
    load('application/approval-service.ts'),
    load('tools/runtime-tools.ts'),
    load('desktop/local-tool-gateway.ts'),
  ])
  return {
    SessionRunService: runService.SessionRunService,
    ApprovalService: approval.ApprovalService,
    runtimeTools,
    DesktopLocalToolGateway: localToolGateway.DesktopLocalToolGateway,
  }
}

function createObservableTurnStores(projectId, run, runtime) {
  const runs = new Map([[run.runId, { ...run }]])
  const events = new Map()
  const approvals = new Map()
  const control = {
    findById(runId) { return runs.get(runId) },
    findByIdempotency(sessionId, idempotencyKey) {
      return [...runs.values()].find((candidate) => candidate.sessionId === sessionId
        && candidate.idempotencyKey === idempotencyKey)
    },
    findActive(sessionId) {
      return [...runs.values()].find((candidate) => candidate.sessionId === sessionId
        && ['queued', 'running', 'waiting_confirmation', 'waiting_task'].includes(candidate.status))
    },
    save(value) {
      if (value?.action) approvals.set(value.action.actionId, value)
      else runs.set(value.runId, { ...value })
    },
    updateStatus(runId, status) {
      const current = runs.get(runId)
      if (current) runs.set(runId, { ...current, status, updatedAt: new Date() })
    },
    appendEvent(event) {
      const current = events.get(event.runId) ?? []
      events.set(event.runId, [...current, event])
    },
    listEvents(runId) { return [...(events.get(runId) ?? [])] },
    listSessionEvents(sessionId, afterSeq = 0) {
      return [...events.values()].flat()
        .filter((event) => event.sessionId === sessionId && event.eventSeq > afterSeq)
        .sort((left, right) => left.eventSeq - right.eventSeq)
    },
    find(actionId) { return approvals.get(actionId) },
    markTaskContinuationCompleted(runId, ownerProjectId) {
      assert.equal(ownerProjectId, projectId)
      assert.equal(runId, run.runId)
      runtime.continuationStatus = 'completed'
    },
    markTaskContinuationInterrupted(runId, ownerProjectId) {
      assert.equal(ownerProjectId, projectId)
      assert.equal(runId, run.runId)
      runtime.continuationStatus = 'interrupted'
    },
    invalidatePendingForRun() {},
    getOrCreateApprovalSecret() { return 'test-only-approval-secret' },
    getLoadedSkillIds() { return [] },
    prepareOperation() {
      runtime.operationPreparations = (runtime.operationPreparations ?? 0) + 1
      return undefined
    },
    transitionOperation() {},
    _runs: runs,
    _events: events,
    _approvals: approvals,
  }
  const sessions = {
    async openSession() { return {} },
    async listSessions() { return [{ id: run.sessionId }] },
    async buildContext() { return { messages: runtime.sessionMessages.map((entry) => entry.message), entries: [] } },
    async listTranscriptMessages() {
      return runtime.sessionMessages.map((entry) => ({ messageId: entry.id, message: entry.message }))
    },
    async appendMessage(_sessionId, message) {
      const id = `message-${runtime.sessionMessages.length + 1}`
      runtime.sessionMessages.push({ id, message })
      return id
    },
    async resolveSessionTitle() { return '续跑测试会话' },
    async flushOutbox() {},
    async appendCompaction() {},
    async appendSummaryUsage() {},
  }
  return { projectId, projectDirectory: projectId, control, sessions, async close() {} }
}

function createFakeAgentTurn(runtime, scenario) {
  return async (...args) => {
    const [config, _store, sessionId, history, content, skillContext, nodeReferences, hooks] = args
    const call = { config, sessionId, history, content, skillContext, nodeReferences, hooks }
    runtime.turnCalls.push(call)
    const listeners = []
    hooks.onAgent({
      subscribe(listener) { listeners.push(listener) },
      abort() { runtime.agentAborted = true },
    })
    await hooks.onEvent({ type: 'assistant_message', content: '正在检查已完成任务的结果。' })

    if (scenario === 'confirmation') {
      const generationTool = hooks.runtimeTools.find((tool) => tool.name === 'submit_generation')
      assert.ok(generationTool, 'the original generation tool is available to the continuation turn')
      runtime.generationToolResult = await generationTool.execute('tool-call-1', {
        nodeId: 'node-1',
        modelType: 'test-image-model',
        modelParams: { prompt: 'Create the next requested illustration.' },
        overwrite: false,
      })
      const toolCallMessage = {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tool-call-1', name: 'submit_generation', arguments: {} }],
        timestamp: Date.now(),
      }
      const toolResultMessage = {
        role: 'toolResult',
        toolCallId: 'tool-call-1',
        content: [{ type: 'text', text: 'The desktop confirmation is waiting for the user.' }],
        timestamp: Date.now(),
      }
      for (const listener of listeners) {
        await listener({ type: 'message_end', message: toolCallMessage })
        await listener({ type: 'message_end', message: toolResultMessage })
      }
      return { events: [], assistantText: '', totalTokens: 0 }
    }

    await hooks.onEvent({ type: 'assistant_message', content: '已根据任务结果继续整理后续步骤。' })
    const assistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '已根据任务结果继续整理后续步骤。' }],
      timestamp: Date.now(),
    }
    for (const listener of listeners) await listener({ type: 'message_end', message: assistantMessage })
    return { events: [], assistantText: '已根据任务结果继续整理后续步骤。', totalTokens: 1 }
  }
}

function createOriginalTurnRuntimeModules(runtime, scenario) {
  const models = {
    createRuntimeTools: runtime.originalModules.runtimeTools.createRuntimeTools,
    desktopGenerationConfirmationItems: runtime.originalModules.runtimeTools.desktopGenerationConfirmationItems,
  }
  return {
    SessionRunService: runtime.originalModules.SessionRunService,
    ApprovalService: runtime.originalModules.ApprovalService,
    runtimeTools: models,
    localToolGateway: { DesktopLocalToolGateway: runtime.originalModules.DesktopLocalToolGateway },
    agentRuntime: { runDramaTurn: createFakeAgentTurn(runtime, scenario) },
  }
}

async function runFakeOriginalContinuation(scenario) {
  const originalModules = await loadOriginalTurnModules()
  const runtime = {
    starts: [],
    reconcileCalls: [],
    canvasRequests: [],
    coreRequests: [],
    runEvents: new Map(),
    claims: [],
    sessionMessages: [],
    memoryCandidateCalls: 0,
    dailyMemoryCalls: 0,
    scopedMemoryWrites: 0,
    turnCalls: [],
    generationTaskCalls: 0,
    continuationStatus: 'claimed',
    originalModules,
    models: [{
      name: 'test-image-model',
      displayName: 'Test image model',
      enabled: true,
      modelType: 'image',
      modalities: ['image'],
      providerType: 'local',
      providerId: 'test-local',
    }],
    loadCanvas: async () => ({
      projectId: 'project-1',
      canvasId: 'canvas-1',
      version: 0,
      nodes: [{ id: 'node-1', type: 'image', position: { x: 0, y: 0 }, data: { label: 'Poster', params: {} } }],
      edges: [],
    }),
  }
  runtime.sessionMessages.push({
    id: 'legacy-continuation-progress',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '上一阶段生成已完成，正在读取画布并继续执行后续步骤。' }],
      timestamp: 1,
    },
  })
  runtime.sessionMessages.push({
    id: 'valid-assistant-same-progress-text',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '上一阶段生成已完成，正在读取画布并继续执行后续步骤。' }],
      api: 'openai-completions',
      provider: 'agnes',
      model: 'test-model',
      usage: { input: 1, output: 1, totalTokens: 2 },
      timestamp: 2,
    },
  })
  const harness = createWorkerHarness({ ...createOriginalTurnRuntimeModules(runtime, scenario), runtime, captureStartErrors: true })
  const claim = makeClaim('project-1', `continuation-run-${scenario}`)
  const stores = createObservableTurnStores('project-1', claim.run, runtime)
  runtime.claims = [claim]
  harness.hooks.setStores(stores)
  harness.hooks.setAgentContext({
    projectMemory: { createTools: () => [] },
    scopedMemory: {
      async list() { return { items: [] } },
      async proposeCandidate() { runtime.scopedMemoryWrites += 1 },
      async create() { runtime.scopedMemoryWrites += 1 },
    },
    sessionFragments: {},
  })
  return { ...harness, stores, runtime, claim }
}

test('claimed continuation uses the original Worker turn flow without persisting a synthetic user message', async () => {
  const { hooks, stores, runtime, claim, parentPort } = await runFakeOriginalContinuation('complete')
  const response = await hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: 'test-cloud-key' })
  assert.equal(response.failed, 0, JSON.stringify({ response, errors: parentPort.testStartErrors }))
  await waitFor(() => ['completed', 'failed', 'aborted'].includes(stores.control.findById(claim.run.runId)?.status))
  assert.equal(stores.control.findById(claim.run.runId).status, 'completed', JSON.stringify({
    events: stores.control.listEvents(claim.run.runId), messages: runtime.sessionMessages,
    memoryCandidateCalls: runtime.memoryCandidateCalls, scopedMemoryWrites: runtime.scopedMemoryWrites,
    errors: [...parentPort.testTurnErrors, ...parentPort.testStartErrors],
  }))

  assert.equal(response.scheduled, 1)
  assert.equal(runtime.turnCalls.length, 1)
  const turn = runtime.turnCalls[0]
  assert.equal(turn.content, claim.request.prompt)
  assert.equal(turn.hooks.desktopTurnContext.currentUserInput, claim.request.prompt)
  assert.equal(turn.hooks.desktopTurnContext.initialMessages.some((message) => message.role === 'user'), false)
  assert.equal(turn.history.filter((message) => message.content === '上一阶段生成已完成，正在读取画布并继续执行后续步骤。').length, 1)
  assert.equal(turn.history.some((message) => message.role === 'user' && message.content.includes(claim.request.prompt)), false)
  assert.equal(runtime.sessionMessages.some(({ message }) => message.role === 'user'), false)
  assert.equal(runtime.sessionMessages.some(({ message }) => message.content?.some?.((block) => block.text === claim.request.prompt)), false)
  const persistedProgressMessages = runtime.sessionMessages.filter(({ message }) =>
    message.content?.some?.((block) => block.text === '上一阶段生成已完成，正在读取画布并继续执行后续步骤。'))
  assert.equal(persistedProgressMessages.length, 2)
  const visibleMessages = await hooks.dispatch('agent:get-messages', { projectId: 'project-1', sessionId: claim.request.sessionId })
  assert.equal(visibleMessages.filter((message) => message.content === '上一阶段生成已完成，正在读取画布并继续执行后续步骤。').length, 1)
  assert.equal(runtime.memoryCandidateCalls, 0)
  assert.equal(runtime.dailyMemoryCalls, 0)
  assert.equal(runtime.scopedMemoryWrites, 0)
  assert.equal(runtime.continuationStatus, 'completed')

  const events = stores.control.listEvents(claim.run.runId)
  assert.ok(events.some((event) => event.type === 'assistant_delta'
    && event.data.text === '上一阶段生成已完成，正在读取画布并继续执行后续步骤。'))
  assert.ok(events.some((event) => event.type === 'assistant_delta'
    && event.data.text === '已根据任务结果继续整理后续步骤。'))
  const persisted = JSON.stringify({ messages: runtime.sessionMessages, events })
  assert.equal(persisted.includes('test-cloud-key'), false)
})

test('a continuation generation request creates the original confirmation and waits without submitting a task', async () => {
  const { hooks, stores, runtime, claim, parentPort } = await runFakeOriginalContinuation('confirmation')
  const response = await hooks.dispatch('agent:reconcile-tasks', { projectId: 'project-1', apiKey: 'test-cloud-key' })
  assert.equal(response.failed, 0, JSON.stringify({ response, errors: parentPort.testStartErrors }))
  await waitFor(() => ['waiting_confirmation', 'failed', 'aborted'].includes(stores.control.findById(claim.run.runId)?.status))
  assert.equal(stores.control.findById(claim.run.runId).status, 'waiting_confirmation', JSON.stringify({
    events: stores.control.listEvents(claim.run.runId), messages: runtime.sessionMessages,
    memoryCandidateCalls: runtime.memoryCandidateCalls, scopedMemoryWrites: runtime.scopedMemoryWrites,
    errors: [...parentPort.testTurnErrors, ...parentPort.testStartErrors],
  }))

  assert.equal(response.scheduled, 1)
  assert.equal(runtime.turnCalls.length, 1)
  const turn = runtime.turnCalls[0]
  assert.equal(turn.content, claim.request.prompt)
  assert.equal(turn.hooks.runtimeTools.some((tool) => tool.name === 'submit_generation'), true)
  const approval = [...stores.control._approvals.values()][0]
  assert.ok(approval)
  assert.equal(approval.action.params.continueAfterTask, true)
  assert.equal(runtime.generationToolResult.terminate, true)
  assert.equal(stores.control.findById(claim.run.runId).status, 'waiting_confirmation')
  assert.equal(runtime.continuationStatus, 'claimed')
  assert.equal(runtime.generationTaskCalls, 0)
  assert.equal(runtime.coreRequests.some((request) => request.method === 'agent:core:create-generation-task'), false)
  assert.equal(runtime.operationPreparations ?? 0, 0)
  assert.ok(stores.control.listEvents(claim.run.runId).some((event) => event.type === 'confirmation_required'))
})
