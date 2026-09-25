const path = require('node:path')
const fs = require('node:fs/promises')
const nativeFs = require('node:fs')
const { Readable } = require('node:stream')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const {
  discoverLocalModels,
  normalizeLocalTextModelConfig,
} = require('./local-model-catalog.cjs')
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  session,
  utilityProcess,
} = require('electron')
const { AGNES_MODELS, AGNES_PROVIDER_ID, getAgnesModelCatalog } = require('./agnes-model-catalog.cjs')
const { COMPOSE_MODEL_ID, COMPOSE_PROVIDER_ID } = require('./compose-provider.cjs')
const { MODEL_ID: SAPI_MODEL_ID, PROVIDER_ID: SAPI_PROVIDER_ID } = require('./sapi-tts.cjs')
const { buildAgentCanvasContext } = require('./agent-canvas-context.cjs')
const { buildDesktopAgentModelDirectory } = require('./agent-model-directory.cjs')
const { ALLOWED_AGENT_CORE_METHODS } = require('./agent-local-tools.cjs')
const { createRecentProjectCatalog } = require('./recent-project-catalog.cjs')

app.setName('VibePaper')
protocol.registerSchemesAsPrivileged([{
  scheme: 'vibe',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}])

const hasSingleInstanceLock = app.requestSingleInstanceLock()
let mainWindow = null
let localCore = null
let recentProjectFile = null
let recentProjectsFile = null
let recentProjectCatalog = null
let desktopSettingsFile = null
let agnesCredentialFile = null
let quittingAfterCoreClose = false
let stopping = false
let generationWorker = null
let agentWorker = null
let agentProjectId = null
let activeProjectDirectory = null
let taskPumpPromise = null
let taskPumpRequestedProjectId = null
let pendingTaskCreations = 0
let projectTransitionCount = 0
const taskCreationWaiters = []
const desktopRoot = path.resolve(__dirname, '..')
const webRoot = path.resolve(desktopRoot, '..', 'vibepaper-web')
const rendererRoot = path.join(webRoot, 'dist')
const rendererIndex = path.join(rendererRoot, 'index.html')
const developmentUrl = process.env.VITE_DEV_SERVER_URL

function isTrustedRendererUrl(value) {
  try {
    const candidate = new URL(value)
    if (developmentUrl) return candidate.origin === new URL(developmentUrl).origin
    return candidate.protocol === 'vibe:' && candidate.host === 'app'
      && candidate.pathname === '/' && !candidate.search && !candidate.hash
  } catch {
    return false
  }
}

function assertTrustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame
    || !isTrustedRendererUrl(event.senderFrame.url)) {
    throw new Error('此本地请求未通过桌面宿主校验。')
  }
}

function isCanvasDomainId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 256)
    || (typeof value === 'number' && Number.isSafeInteger(value))
}

function assertGroupStackRequest(input, label, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.projectId !== 'string' || input.projectId.length === 0 || input.projectId.length > 200
    || typeof input.canvasId !== 'string' || input.canvasId.length === 0 || input.canvasId.length > 200) {
    throw new Error(`${label}请求无效。`)
  }
  if (options.idField && !isCanvasDomainId(input[options.idField])) throw new Error(`${label}标识无效。`)
  if (options.nodeIdsRequired || input.nodeIds !== undefined && input.nodeIds !== null) {
    const minimum = options.nodeIdsRequired ? 2 : 0
    if (!Array.isArray(input.nodeIds) || input.nodeIds.length < minimum || input.nodeIds.length > 10_000
      || input.nodeIds.some((nodeId) => !isCanvasDomainId(nodeId))) {
      throw new Error(`${label}节点列表无效。`)
    }
  }
  for (const field of options.stringFields ?? []) {
    if (input[field] !== undefined && input[field] !== null && typeof input[field] !== 'string') {
      throw new Error(`${label}数据无效。`)
    }
  }
  if (options.booleanFields?.some((field) => input[field] !== undefined && input[field] !== null
    && typeof input[field] !== 'boolean')) {
    throw new Error(`${label}数据无效。`)
  }
  let serialized
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new Error(`${label}请求无效。`)
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > 32 * 1024 * 1024) {
    throw new Error(`${label}请求超过本地画布数据上限。`)
  }
}

function startLocalCore() {
  const child = utilityProcess.fork(path.join(__dirname, 'local-core.cjs'), [], {
    serviceName: 'VibePaper Local Core',
    stdio: 'ignore',
  })
  const pending = new Map()
  let nextRequestId = 1
  let exitError = null
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })

  child.once('spawn', markStarted)

  child.on('message', (message) => {
    if (!message || !Number.isSafeInteger(message.id)) return
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(typeof message.error === 'string' ? message.error : '本地项目操作失败。'))
  })

  child.on('exit', (code) => {
    exitError = new Error(`本地核心进程已停止（${code}）。`)
    markStarted()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(exitError)
    }
    pending.clear()
    if (mainWindow && !quittingAfterCoreClose) {
      void dialog.showErrorBox('本地核心已停止', '本地项目服务意外退出。请重新启动 VibePaper 后继续。')
      app.quit()
    }
  })

  return {
    child,
    async request(method, payload = {}, timeoutMs = 60_000) {
      await started
      if (exitError) throw exitError
      const id = nextRequestId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('本地核心响应超时。'))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          child.postMessage({ id, method, payload })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
  }
}

function codedError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function startGenerationWorker() {
  if (generationWorker) return generationWorker
  const child = utilityProcess.fork(path.join(__dirname, 'generation-worker.cjs'), [], {
    serviceName: 'VibePaper Local Generation Worker',
    stdio: 'ignore',
  })
  const pending = new Map()
  let nextRequestId = 1
  let exitError = null
  let markStarted
  let markExited
  let exitedSettled = false
  const started = new Promise((resolve) => { markStarted = resolve })
  const exited = new Promise((resolve) => { markExited = resolve })

  const worker = {
    child,
    async request(method, payload) {
      await started
      if (exitError) throw exitError
      const id = nextRequestId++
      return new Promise((resolve, reject) => {
        const composeInputCount = payload?.modality === 'compose' && Array.isArray(payload?.parameters?.inputNodeIds)
          ? payload.parameters.inputNodeIds.length : 0
        const timeout = payload?.modality === 'compose'
          ? Math.min(24 * 60 * 60 * 1000, composeInputCount * 4 * 60 * 1000 + 8 * 60 * 1000)
          : payload?.modality === 'video' ? 17 * 60 * 1000
          : payload?.providerType === 'cloud' && payload?.modality === 'image' ? 10 * 60 * 1000
            : payload?.providerType === 'cloud' ? 8 * 60 * 1000
            : 4 * 60 * 1000
        const timer = setTimeout(() => {
          pending.delete(id)
          child.kill()
          reject(codedError(payload?.providerType === 'cloud' ? 'CLOUD_REQUEST_TIMEOUT' : 'LOCAL_MODEL_UNAVAILABLE'))
        }, timeout)
        pending.set(id, { resolve, reject, timer })
        try {
          child.postMessage({ id, method, payload })
        } catch {
          clearTimeout(timer)
          pending.delete(id)
          reject(codedError('LOCAL_MODEL_UNAVAILABLE'))
        }
      })
    },
    async stop() {
      child.kill()
      await exited
    },
  }

  const failWorker = (error) => {
    exitError = error
    markStarted()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(exitError)
    }
    pending.clear()
    if (!exitedSettled) {
      exitedSettled = true
      markExited()
    }
    if (generationWorker === worker) generationWorker = null
  }

  child.once('spawn', markStarted)
  child.on('message', (message) => {
    if (!message || !Number.isSafeInteger(message.id)) return
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.ok) request.resolve(message.result)
    else request.reject(codedError(typeof message.errorCode === 'string' ? message.errorCode : 'LOCAL_MODEL_EXECUTION_FAILED'))
  })
  child.on('error', () => {
    failWorker(codedError('LOCAL_MODEL_UNAVAILABLE'))
  })
  child.on('exit', () => {
    failWorker(codedError('LOCAL_MODEL_UNAVAILABLE'))
  })

  generationWorker = worker
  return worker
}

function createAgentWorker() {
  const child = utilityProcess.fork(path.join(desktopRoot, 'dist', 'agent-worker.cjs'), [], {
    serviceName: 'VibePaper Agent Worker',
    stdio: 'ignore',
  })
  const pending = new Map()
  let nextRequestId = 1
  let exitError = null
  let markStarted
  let markExited
  let exitedSettled = false
  const started = new Promise((resolve) => { markStarted = resolve })
  const exited = new Promise((resolve) => { markExited = resolve })
  let workerReference = null
  const executeAgentCoreRequest = async (method, input) => {
    if (!ALLOWED_AGENT_CORE_METHODS.has(method)) throw new Error('AGENT_LOCAL_CORE_METHOD_UNSUPPORTED')
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.projectId !== 'string' || input.projectId.length < 1 || input.projectId.length > 128) {
      throw new Error('AGENT_LOCAL_CORE_INPUT_INVALID')
    }
    const allowedKeys = {
      'agent:core:load-canvas': ['projectId', 'canvasId'],
      'agent:core:create-node': ['projectId', 'canvasId', 'expectedVersion', 'idempotencyKey', 'type', 'creativeType', 'prompt', 'params', 'x', 'y', 'width', 'height', 'modelRef'],
      'agent:core:update-node': ['projectId', 'canvasId', 'expectedVersion', 'idempotencyKey', 'nodeId', 'x', 'y', 'width', 'height', 'params', 'prompt', 'modelRef', 'creativeType', 'status', 'execStatus', 'output', 'currentOutputId', 'groupId', 'stackId', 'stale'],
      'agent:core:connect-edge': ['projectId', 'canvasId', 'expectedVersion', 'idempotencyKey', 'sourceNodeId', 'targetNodeId', 'sourcePort', 'targetPort', 'dependencyType'],
      'agent:core:save-canvas': ['projectId', 'canvasId', 'expectedVersion', 'idempotencyKey', 'nodes', 'edges', 'groups', 'stacks'],
      'agent:core:get-task': ['projectId', 'taskId'],
      'agent:core:list-assets': ['projectId'],
      'agent:core:list-models': ['projectId'],
      'agent:core:create-generation-task': ['projectId', 'canvasId', 'canvasVersion', 'nodeId', 'modality', 'providerType', 'providerId', 'modelId', 'idempotencyKey', 'prompt', 'parameters'],
    }[method]
    if (Object.keys(input).some((key) => !allowedKeys.includes(key))) throw new Error('AGENT_LOCAL_CORE_INPUT_INVALID')
    if (stopping || projectTransitionCount > 0 || agentWorker !== workerReference || agentProjectId !== input.projectId) {
      throw new Error('AGENT_PROJECT_CHANGED')
    }
    const active = await localCore.request('project:get-active', undefined, 15_000)
    if (!active || active.projectId !== input.projectId
      || (input.canvasId !== undefined && input.canvasId !== active.canvasId)
      || stopping || projectTransitionCount > 0 || agentWorker !== workerReference || agentProjectId !== input.projectId) {
      throw new Error('AGENT_PROJECT_CHANGED')
    }
    switch (method) {
      case 'agent:core:load-canvas':
        return localCore.request('canvas:load', { projectId: input.projectId, canvasId: active.canvasId }, 15_000)
      case 'agent:core:create-node':
        return localCore.request('canvas:create-node', input, 30_000)
      case 'agent:core:update-node':
        return localCore.request('canvas:update-node', input, 30_000)
      case 'agent:core:connect-edge':
        return localCore.request('canvas:connect', input, 30_000)
      case 'agent:core:save-canvas':
        return localCore.request('canvas:save', input, 60_000)
      case 'agent:core:get-task':
        return localCore.request('task:get', input, 15_000)
      case 'agent:core:list-assets':
        return localCore.request('asset:list', { projectId: input.projectId }, 15_000)
      case 'agent:core:list-models': {
        const [agnes, localTextModel] = await Promise.all([getAgnesModelSettings(), getLocalTextModelConfig()])
        return buildDesktopAgentModelDirectory(agnes, localTextModel)
      }
      case 'agent:core:create-generation-task': {
        const modalities = ['text', 'image', 'video']
        if (typeof input.canvasId !== 'string' || !input.canvasId
          || !Number.isSafeInteger(input.canvasVersion) || input.canvasVersion < 0
          || typeof input.nodeId !== 'string' || !input.nodeId
          || !modalities.includes(input.modality)
          || !['local', 'cloud'].includes(input.providerType)
          || typeof input.providerId !== 'string' || !input.providerId
          || typeof input.modelId !== 'string' || !input.modelId
          || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 255
          || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 200_000
          || !input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) {
          throw new Error('AGENT_GENERATION_INPUT_INVALID')
        }
        const canvas = await localCore.request('canvas:load', { projectId: input.projectId, canvasId: active.canvasId }, 15_000)
        if (!canvas || canvas.canvasId !== input.canvasId || canvas.version !== input.canvasVersion
          || !Array.isArray(canvas.nodes) || !canvas.nodes.some((node) => node.id === input.nodeId)) {
          throw new Error('AGENT_CANVAS_CHANGED')
        }
        const [agnes, localTextModel] = await Promise.all([getAgnesModelSettings(), getLocalTextModelConfig()])
        const model = buildDesktopAgentModelDirectory(agnes, localTextModel).find((entry) =>
          entry.enabled === true && entry.name === input.modelId && entry.modelType === input.modality
          && entry.providerType === input.providerType && entry.providerId === input.providerId)
        if (!model) throw new Error('AGENT_GENERATION_MODEL_UNAVAILABLE')
        if ((input.providerType === 'local' && input.modality !== 'text')
          || (input.providerType === 'cloud' && !agnes?.apiKeyConfigured)) {
          throw new Error(input.providerType === 'cloud' ? 'CLOUD_CREDENTIAL_MISSING' : 'UNSUPPORTED_MODALITY')
        }
        beginTaskCreation()
        try {
          const task = await localCore.request('task:create', {
            projectId: input.projectId,
            canvasId: input.canvasId,
            canvasVersion: input.canvasVersion,
            nodeId: input.nodeId,
            modality: input.modality,
            providerType: input.providerType,
            providerId: input.providerId,
            modelId: input.modelId,
            idempotencyKey: input.idempotencyKey,
            parameters: { ...input.parameters, prompt: input.prompt },
          }, 30_000)
          void scheduleTaskPump(input.projectId)
          return task
        } finally {
          finishTaskCreation()
        }
      }
    }
  }

  const worker = {
    child,
    async request(method, payload, timeoutMs = 30_000) {
      await started
      if (exitError) throw exitError
      const id = nextRequestId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(codedError('AGENT_WORKER_TIMEOUT'))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          child.postMessage({ id, method, payload })
        } catch {
          clearTimeout(timer)
          pending.delete(id)
          reject(codedError('AGENT_WORKER_UNAVAILABLE'))
        }
      })
    },
    async stop() {
      await worker.request('agent:close', {}, 275_000).catch(() => undefined)
      if (!exitedSettled) child.kill()
      await exited
    },
  }
  workerReference = worker

  const failWorker = (error) => {
    exitError = error
    markStarted()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    if (!exitedSettled) {
      exitedSettled = true
      markExited()
    }
    if (agentWorker === worker) {
      agentWorker = null
      agentProjectId = null
    }
  }

  child.once('spawn', markStarted)
  child.on('message', (message) => {
    if (message?.kind === 'agent-local-core-request') {
      if (typeof message.requestId !== 'string' || !/^agent-core-\d{1,12}$/u.test(message.requestId)) return
      void executeAgentCoreRequest(message.method, message.payload).then((result) => {
        child.postMessage({ kind: 'agent-local-core-response', requestId: message.requestId, ok: true, result })
      }).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : ''
        const errorCode = /^[A-Z0-9_]{1,120}$/u.test(errorMessage) ? errorMessage : 'CANVAS_UNAVAILABLE'
        try {
          child.postMessage({ kind: 'agent-local-core-response', requestId: message.requestId, ok: false, errorCode })
        } catch {
          // The Worker may exit while its read-only Local Core request is settling.
        }
      })
      return
    }
    if (!message || !Number.isSafeInteger(message.id)) return
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(typeof message.error === 'string' ? message.error : 'Agent 本地会话操作失败。'))
  })
  child.on('error', () => failWorker(codedError('AGENT_WORKER_UNAVAILABLE')))
  child.on('exit', () => failWorker(codedError('AGENT_WORKER_UNAVAILABLE')))
  return worker
}

async function startAgentWorker(projectDirectory) {
  await stopAgentWorker()
  const worker = createAgentWorker()
  agentWorker = worker
  try {
    const opened = await worker.request('agent:open', { projectDirectory })
    agentProjectId = opened.projectId
    activeProjectDirectory = projectDirectory
    return opened
  } catch (error) {
    await worker.stop()
    throw error
  }
}

async function stopAgentWorker() {
  const worker = agentWorker
  if (!worker) return
  agentWorker = null
  agentProjectId = null
  await worker.stop()
}

async function drainTaskQueue(projectId) {
  if (stopping || !localCore) return

  while (!stopping) {
    const claimed = await localCore.request('task:claim-next', { projectId })
    if (!claimed) return
    if (stopping) return
    const { task, parameters, outputDirectory } = claimed
    try {
      let model
      let inputPaths
      if (task.modality === 'compose') {
        if (task.providerType !== 'local' || task.providerId !== COMPOSE_PROVIDER_ID
          || task.modelId !== COMPOSE_MODEL_ID) throw codedError('MODEL_UNAVAILABLE')
        inputPaths = await localCore.request('task:resolve-compose-inputs', {
          projectId,
          taskId: task.taskId,
        })
        model = {
          providerId: COMPOSE_PROVIDER_ID,
          providerType: 'local',
          modelId: COMPOSE_MODEL_ID,
        }
      } else if (task.providerType === 'local' && task.modality === 'audio') {
        if (task.providerId !== SAPI_PROVIDER_ID || task.modelId !== SAPI_MODEL_ID) {
          throw codedError('MODEL_UNAVAILABLE')
        }
        model = {
          providerId: SAPI_PROVIDER_ID,
          providerType: 'local',
          modelId: SAPI_MODEL_ID,
        }
      } else if (task.providerType === 'local') {
        model = await getLocalTextModelConfig()
        if (!model) throw codedError('LOCAL_MODEL_CONFIGURATION_MISSING')
        if (task.modality !== 'text') throw codedError('UNSUPPORTED_MODALITY')
        if (task.providerId !== model.providerId || task.modelId !== model.modelId) {
          throw codedError('LOCAL_MODEL_CONFIGURATION_CHANGED')
        }
      } else if (task.providerType === 'cloud') {
        if (task.providerId !== AGNES_PROVIDER_ID || AGNES_MODELS[task.modality] !== task.modelId) {
          throw codedError('CLOUD_MODEL_CONFIGURATION_INVALID')
        }
        const apiKey = await getAgnesApiKey()
        if (!apiKey) throw codedError('CLOUD_CREDENTIAL_MISSING')
        model = {
          providerId: AGNES_PROVIDER_ID,
          providerType: 'cloud',
          endpoint: 'https://apihub.agnes-ai.com/v1',
          modelId: task.modelId,
          apiKey,
        }
      } else {
        throw codedError('PROVIDER_TYPE_UNSUPPORTED')
      }
      const worker = startGenerationWorker()
      const result = await worker.request(`generate:${task.modality}`, {
        taskId: task.taskId,
        modality: task.modality,
        providerType: task.providerType,
        providerId: model.providerId,
        prompt: parameters?.prompt,
        endpoint: model.endpoint,
        modelId: model.modelId,
        apiKey: model.apiKey,
        parameters,
        ...(inputPaths ? { inputPaths } : {}),
        outputDirectory,
      })
      if (stopping) return
      await localCore.request('task:succeeded', {
        projectId,
        taskId: task.taskId,
        outputPath: result?.outputPath,
        outputMeta: result?.outputMeta,
      })
    } catch (error) {
      if (stopping) return
      const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,120}$/u.test(error.code)
        ? error.code
        : 'LOCAL_MODEL_EXECUTION_FAILED'
      try {
        await localCore.request('task:failed', { projectId, taskId: task.taskId, errorCode })
      } catch {
        return
      }
    }
  }
}

function scheduleTaskPump(projectId) {
  if (stopping || typeof projectId !== 'string' || !projectId) return Promise.resolve()
  taskPumpRequestedProjectId = projectId
  if (taskPumpPromise) return taskPumpPromise

  const pump = (async () => {
    while (!stopping && taskPumpRequestedProjectId) {
      const nextProjectId = taskPumpRequestedProjectId
      taskPumpRequestedProjectId = null
      await drainTaskQueue(nextProjectId)
    }
  })()
  taskPumpPromise = pump.catch(() => undefined).finally(() => {
    taskPumpPromise = null
    if (!stopping && taskPumpRequestedProjectId) void scheduleTaskPump(taskPumpRequestedProjectId)
  })
  return taskPumpPromise
}

function beginTaskCreation() {
  pendingTaskCreations += 1
}

function finishTaskCreation() {
  pendingTaskCreations -= 1
  if (pendingTaskCreations === 0) {
    for (const resolve of taskCreationWaiters.splice(0)) resolve()
  }
}

async function waitForTaskCreations() {
  while (pendingTaskCreations > 0) {
    await new Promise((resolve) => taskCreationWaiters.push(resolve))
  }
}

async function runProjectTransition(operation) {
  projectTransitionCount += 1
  const previousDirectory = activeProjectDirectory
  let projectSwitched = false
  try {
    await waitForTaskCreations()
    if (taskPumpPromise) await taskPumpPromise
    await stopAgentWorker()
    const result = await operation()
    if (result?.project && typeof result.directory === 'string') {
      activeProjectDirectory = result.directory
      projectSwitched = true
      await startAgentWorker(result.directory)
    } else if (previousDirectory) {
      await startAgentWorker(previousDirectory)
    }
    return result
  } catch (error) {
    if (!projectSwitched && previousDirectory) await startAgentWorker(previousDirectory).catch(() => undefined)
    throw error
  } finally {
    projectTransitionCount -= 1
  }
}

async function writeRecentProjectDirectory(directory) {
  if (!recentProjectCatalog) throw new Error('桌面设置尚未初始化。')
  return recentProjectCatalog.record(directory)
}

async function readDesktopSettings() {
  let settings
  try {
    settings = JSON.parse(await fs.readFile(desktopSettingsFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1 }
    throw error
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || settings.schemaVersion !== 1) {
    throw new Error('桌面设置文件格式无效。')
  }
  if (Object.keys(settings).some((key) => !['schemaVersion', 'localTextModel'].includes(key))) {
    throw new Error('桌面设置文件包含当前版本不支持的字段。')
  }
  return settings
}

async function writeDesktopSettings(settings) {
  const temporaryPath = path.join(path.dirname(desktopSettingsFile), `.settings.${randomUUID()}.tmp`)
  let handle
  try {
    await fs.mkdir(path.dirname(desktopSettingsFile), { recursive: true })
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, desktopSettingsFile)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function assertCredentialVaultAvailable() {
  if (!await safeStorage.isAsyncEncryptionAvailable()) {
    throw new Error('此设备的系统凭据存储当前不可用，未保存云端 API Key。')
  }
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    throw new Error('Linux 系统未提供安全凭据库。请启用 Secret Service、KWallet 或 Secret Portal 后再配置 API Key。')
  }
}

async function writeAgnesCredentialCiphertext(ciphertext) {
  const temporaryPath = path.join(path.dirname(agnesCredentialFile), `.agnes-credential.${randomUUID()}.tmp`)
  let handle
  try {
    await fs.mkdir(path.dirname(agnesCredentialFile), { recursive: true })
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(ciphertext)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, agnesCredentialFile)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function getAgnesApiKey() {
  await assertCredentialVaultAvailable()
  let ciphertext
  try {
    ciphertext = await fs.readFile(agnesCredentialFile)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error('无法读取系统保护的 Agnes 凭据。')
  }
  try {
    const decrypted = await safeStorage.decryptStringAsync(ciphertext)
    if (decrypted.shouldReEncrypt) {
      const reencrypted = await safeStorage.encryptStringAsync(decrypted.result)
      await writeAgnesCredentialCiphertext(reencrypted)
    }
    return decrypted.result
  } catch {
    throw new Error('无法解密系统保护的 Agnes 凭据；请重新配置 API Key。')
  }
}

async function saveAgnesApiKey(input) {
  if (typeof input !== 'string') throw new Error('Agnes API Key 格式无效。')
  const apiKey = input.trim()
  if (apiKey.length < 16 || apiKey.length > 1024 || /\s|[\u0000-\u001f\u007f]/u.test(apiKey)) {
    throw new Error('Agnes API Key 格式无效。')
  }
  await assertCredentialVaultAvailable()
  const ciphertext = await safeStorage.encryptStringAsync(apiKey)
  await writeAgnesCredentialCiphertext(ciphertext)
  return getAgnesModelCatalog(true)
}

async function clearAgnesApiKey() {
  try {
    await fs.rm(agnesCredentialFile, { force: true })
  } catch {
    throw new Error('无法移除 Agnes 凭据。')
  }
  return getAgnesModelCatalog(false)
}

async function getAgnesModelSettings() {
  return getAgnesModelCatalog(Boolean(await getAgnesApiKey()))
}

async function getLocalTextModelConfig() {
  const settings = await readDesktopSettings()
  if (settings.localTextModel === undefined || settings.localTextModel === null) return null
  return normalizeLocalTextModelConfig(settings.localTextModel)
}

function getLocalAudioModel() {
  const available = process.platform === 'win32'
  return {
    providerId: SAPI_PROVIDER_ID,
    providerType: 'local',
    modelId: SAPI_MODEL_ID,
    modalities: ['audio'],
    inputModes: ['text'],
    toolCalling: false,
    cancellation: false,
    available,
    unavailableReason: available ? null : 'local-sapi-tts 仅支持 Windows。',
  }
}

async function saveLocalTextModelConfig(input) {
  const config = normalizeLocalTextModelConfig(input)
  const settings = await readDesktopSettings()
  await writeDesktopSettings({ ...settings, schemaVersion: 1, localTextModel: config })
  return config
}

async function clearLocalTextModelConfig() {
  const settings = await readDesktopSettings()
  if (settings.localTextModel !== undefined) await writeDesktopSettings({ schemaVersion: 1 })
  return null
}

async function stopGenerationWorker() {
  const worker = generationWorker
  if (!worker) return
  generationWorker = null
  await worker.stop()
}

async function restoreRecentProject() {
  try {
    const recent = JSON.parse(await fs.readFile(recentProjectFile, 'utf8'))
    if (!recent || recent.schemaVersion !== 1 || typeof recent.projectDirectory !== 'string') return null
    const opened = await localCore.request('project:open', { directory: recent.projectDirectory })
    await writeRecentProjectDirectory(opened.directory)
    await startAgentWorker(opened.directory)
    return opened.project
  } catch {
    // Preserve recent-project.json even when the path is stale; a future open can repair it.
    return null
  }
}

function registerContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' || !isTrustedRendererUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }

    const policy = developmentUrl
      ? "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'"
    const responseHeaders = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== 'content-security-policy'),
    )
    responseHeaders['Content-Security-Policy'] = [policy]
    callback({ responseHeaders })
  })
}

function registerRendererProtocol() {
  protocol.handle('vibe', async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app' || request.method !== 'GET') {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    }

    let requestedPath
    try {
      requestedPath = decodeURIComponent(url.pathname)
    } catch {
      return new Response('Bad path', { status: 400, headers: { 'content-type': 'text/plain' } })
    }
    const taskOutputMatch = /^\/tasks\/([a-f0-9-]{36})\/output$/iu.exec(requestedPath)
    if (taskOutputMatch && !url.search && !url.hash) {
      try {
        const activeProject = await localCore.request('project:get-active')
        if (!activeProject) throw new Error('NO_ACTIVE_PROJECT')
        const output = await localCore.request('task:resolve-output-preview', {
          projectId: activeProject.projectId,
          taskId: taskOutputMatch[1],
        })
        const rangeHeader = request.headers.get('range')
        let start = 0
        let end = output.sizeBytes - 1
        let status = 200
        const headers = new Headers({
          'content-type': output.mimeType,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
          'accept-ranges': 'bytes',
        })
        if (rangeHeader) {
          const match = /^bytes=(\d*)-(\d*)$/iu.exec(rangeHeader.trim())
          if (!match || (!match[1] && !match[2])) {
            return new Response(null, { status: 416, headers: { 'content-range': `bytes */${output.sizeBytes}` } })
          }
          if (!match[1]) {
            const suffixLength = Number(match[2])
            if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
              return new Response(null, { status: 416, headers: { 'content-range': `bytes */${output.sizeBytes}` } })
            }
            start = Math.max(0, output.sizeBytes - suffixLength)
          } else {
            start = Number(match[1])
            end = match[2] ? Number(match[2]) : end
          }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
            || start < 0 || end < start || start >= output.sizeBytes) {
            return new Response(null, { status: 416, headers: { 'content-range': `bytes */${output.sizeBytes}` } })
          }
          end = Math.min(end, output.sizeBytes - 1)
          status = 206
          headers.set('content-range', `bytes ${start}-${end}/${output.sizeBytes}`)
        }
        headers.set('content-length', String(end - start + 1))
        const fileStream = nativeFs.createReadStream(output.filePath, { start, end })
        return new Response(Readable.toWeb(fileStream), { status, headers })
      } catch {
        return new Response('Task output not found', { status: 404, headers: { 'content-type': 'text/plain' } })
      }
    }
    const assetMatch = /^\/assets\/([a-f0-9-]{36})$/iu.exec(requestedPath)
    if (assetMatch && !url.search && !url.hash) {
      try {
        const asset = await localCore.request('asset:resolve', { assetId: assetMatch[1] })
        const fileResponse = await net.fetch(pathToFileURL(asset.filePath).toString())
        const headers = new Headers(fileResponse.headers)
        headers.set('content-type', asset.mimeType)
        headers.set('x-content-type-options', 'nosniff')
        headers.set('cache-control', 'private, max-age=3600, immutable')
        return new Response(fileResponse.body, { status: 200, headers })
      } catch {
        return new Response('Asset not found', { status: 404, headers: { 'content-type': 'text/plain' } })
      }
    }
    const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '')
    const targetPath = path.resolve(rendererRoot, relativePath)
    const relativeToRoot = path.relative(rendererRoot, targetPath)
    if (!relativeToRoot || relativeToRoot === '.' || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
      return new Response('Bad path', { status: 400, headers: { 'content-type': 'text/plain' } })
    }

    try {
      return await net.fetch(pathToFileURL(targetPath).toString())
    } catch {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } })
    }
  })
}

function assertAssetProjectId(projectId) {
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200) {
    throw new Error('素材项目标识无效。')
  }
}

function assertAssetId(assetId) {
  if (typeof assetId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(assetId)) {
    throw new Error('素材标识无效。')
  }
}

async function assertActiveAssetProject(projectId) {
  assertAssetProjectId(projectId)
  if (stopping || projectTransitionCount > 0 || !localCore) throw new Error('项目正在切换，请稍后重试。')
  const active = await localCore.request('project:get-active')
  if (!active || active.projectId !== projectId) throw new Error('当前项目已更改，无法操作素材。')
  if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
}

function registerProjectIpc() {
  ipcMain.handle('desktop:project:get-active', (event) => {
    assertTrustedSender(event)
    return localCore.request('project:get-active')
  })
  ipcMain.handle('desktop:project:list-recent', (event) => {
    assertTrustedSender(event)
    return recentProjectCatalog.listRecentProjects()
  })
  ipcMain.handle('desktop:project:open-recent', async (event, projectId) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    const selected = await recentProjectCatalog.resolve(projectId)
    const opened = await runProjectTransition(() => localCore.request('project:open', {
      directory: selected.directory,
      expectedProjectId: selected.project.projectId,
      expectedCanvasId: selected.project.canvasId,
    }))
    if (opened.project.projectId !== selected.project.projectId
      || opened.project.canvasId !== selected.project.canvasId) {
      throw new Error('最近项目身份已变化，请从项目目录重新打开。')
    }
    await writeRecentProjectDirectory(opened.directory)
    void scheduleTaskPump(opened.project.projectId)
    return opened.project
  })
  ipcMain.handle('desktop:project:create', async (event, name) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择新项目的保存位置',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const created = await runProjectTransition(() => localCore.request('project:create', {
      parentDirectory: result.filePaths[0],
      name,
    }))
    await writeRecentProjectDirectory(created.directory)
    return created.project
  })
  ipcMain.handle('desktop:project:open', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开 VibePaper 本地项目',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const opened = await runProjectTransition(() => localCore.request('project:open', { directory: result.filePaths[0] }))
    await writeRecentProjectDirectory(opened.directory)
    void scheduleTaskPump(opened.project.projectId)
    return opened.project
  })
  ipcMain.handle('desktop:project:backup', async (event, projectId) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择项目备份保存位置',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const backup = await runProjectTransition(() => localCore.request('project:backup', {
      parentDirectory: result.filePaths[0],
      projectId,
    }))
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '项目备份完成',
      message: '本地项目备份已创建，包含支持的 Agent 会话与记忆文件。',
      detail: backup.directory,
    })
    return { name: backup.name }
  })
  ipcMain.handle('desktop:project:restore-backup', async (event) => {
    assertTrustedSender(event)
    const sourceResult = await dialog.showOpenDialog(mainWindow, {
      title: '选择要恢复的 VibePaper 项目备份',
      properties: ['openDirectory'],
    })
    if (sourceResult.canceled || sourceResult.filePaths.length === 0) return null
    const destinationResult = await dialog.showOpenDialog(mainWindow, {
      title: '选择恢复副本的保存位置',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (destinationResult.canceled || destinationResult.filePaths.length === 0) return null

    const restored = await runProjectTransition(() => localCore.request('project:restore-backup', {
      sourceDirectory: sourceResult.filePaths[0],
      parentDirectory: destinationResult.filePaths[0],
    }, 30 * 60 * 1000))
    await writeRecentProjectDirectory(restored.directory)
    void scheduleTaskPump(restored.project.projectId)
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '备份恢复完成',
      message: '已创建并打开恢复副本。',
      detail: `${restored.project.name}\n${restored.directory}`,
    })
    return restored.project
  })
  ipcMain.handle('desktop:asset:import-image', async (event, projectId) => {
    assertTrustedSender(event)
    await assertActiveAssetProject(projectId)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入本地图片素材',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    await assertActiveAssetProject(projectId)
    return localCore.request('asset:import', { sourcePath: result.filePaths[0], projectId }, 5 * 60 * 1000)
  })
  ipcMain.handle('desktop:asset:list', async (event, projectId) => {
    assertTrustedSender(event)
    await assertActiveAssetProject(projectId)
    return localCore.request('asset:list', { projectId })
  })
  ipcMain.handle('desktop:asset:save-task-output', async (event, projectId, taskId) => {
    assertTrustedSender(event)
    assertAssetProjectId(projectId)
    if (typeof taskId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(taskId)) {
      throw new Error('任务标识无效。')
    }
    await assertActiveAssetProject(projectId)
    return localCore.request('asset:save-task-output', { projectId, taskId }, 5 * 60 * 1000)
  })
  ipcMain.handle('desktop:asset:rename', async (event, projectId, assetId, name) => {
    assertTrustedSender(event)
    assertAssetId(assetId)
    if (typeof name !== 'string' || name.length === 0 || name.length > 255 || !name.trim()) {
      throw new Error('素材名称需为 1-255 个字符。')
    }
    await assertActiveAssetProject(projectId)
    return localCore.request('asset:rename', { projectId, assetId, name })
  })
  ipcMain.handle('desktop:asset:replace-image', async (event, projectId, assetId) => {
    assertTrustedSender(event)
    assertAssetId(assetId)
    await assertActiveAssetProject(projectId)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '替换本地图片素材',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    await assertActiveAssetProject(projectId)
    return localCore.request('asset:replace', {
      projectId,
      assetId,
      sourcePath: result.filePaths[0],
    }, 5 * 60 * 1000)
  })
  ipcMain.handle('desktop:asset:delete', async (event, projectId, assetId) => {
    assertTrustedSender(event)
    assertAssetId(assetId)
    await assertActiveAssetProject(projectId)
    return localCore.request('asset:delete', { projectId, assetId })
  })
  ipcMain.handle('desktop:canvas:load', (event, projectId, canvasId) => {
    assertTrustedSender(event)
    return localCore.request('canvas:load', { projectId, canvasId })
  })
  ipcMain.handle('desktop:canvas:export', (event, projectId, canvasId) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200
      || typeof canvasId !== 'string' || canvasId.length === 0 || canvasId.length > 200) {
      throw new Error('画布导出请求无效。')
    }
    return localCore.request('canvas:export', { projectId, canvasId })
  })
  ipcMain.handle('desktop:canvas:create-node', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.projectId !== 'string' || input.projectId.length === 0 || input.projectId.length > 200
      || typeof input.canvasId !== 'string' || input.canvasId.length === 0 || input.canvasId.length > 200
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 2_147_483_647
      || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128
      || !['text', 'image', 'video', 'audio', 'compose', 'director'].includes(input.type)
      || typeof input.x !== 'number' || !Number.isFinite(input.x)
      || typeof input.y !== 'number' || !Number.isFinite(input.y)
      || (input.width !== undefined && (typeof input.width !== 'number' || !Number.isFinite(input.width)))
      || (input.height !== undefined && (typeof input.height !== 'number' || !Number.isFinite(input.height)))
      || (input.params !== undefined && (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)))
      || (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > 20_000))
      || (input.modelRef !== undefined && input.modelRef !== null && typeof input.modelRef !== 'string')
      || (input.creativeType !== undefined && input.creativeType !== null && typeof input.creativeType !== 'string')) {
      throw new Error('节点创建请求无效。')
    }
    const params = input.params ?? (typeof input.prompt === 'string' ? { prompt: input.prompt } : {})
    let paramsJson
    try {
      paramsJson = JSON.stringify(params)
    } catch {
      throw new Error('节点参数必须是有效的 JSON 对象。')
    }
    if (typeof paramsJson !== 'string' || Buffer.byteLength(paramsJson, 'utf8') > 32 * 1024 * 1024) {
      throw new Error('节点参数超过本地画布数据上限。')
    }
    return localCore.request('canvas:create-node', {
      projectId: input.projectId,
      canvasId: input.canvasId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      type: input.type,
      x: input.x,
      y: input.y,
      ...(input.width === undefined ? {} : { width: input.width }),
      ...(input.height === undefined ? {} : { height: input.height }),
      params,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.modelRef === undefined ? {} : { modelRef: input.modelRef }),
      ...(input.creativeType === undefined ? {} : { creativeType: input.creativeType }),
    })
  })
  ipcMain.handle('desktop:canvas:update-node', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.projectId !== 'string' || input.projectId.length === 0 || input.projectId.length > 200
      || typeof input.canvasId !== 'string' || input.canvasId.length === 0 || input.canvasId.length > 200
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 2_147_483_647
      || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128
      || typeof input.nodeId !== 'string' || input.nodeId.length === 0 || input.nodeId.length > 256
      || (input.prompt !== undefined && (typeof input.prompt !== 'string' || input.prompt.length > 20_000))
      || (input.params !== undefined && (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)))
      || (input.prompt === undefined && input.params === undefined)) {
      throw new Error('节点更新请求无效。')
    }
    let paramsJson
    if (input.params !== undefined) {
      try {
        paramsJson = JSON.stringify(input.params)
      } catch {
        throw new Error('节点参数必须是有效的 JSON 对象。')
      }
      if (typeof paramsJson !== 'string' || Buffer.byteLength(paramsJson, 'utf8') > 32 * 1024 * 1024) {
        throw new Error('节点参数超过本地画布数据上限。')
      }
    }
    return localCore.request('canvas:update-node', {
      projectId: input.projectId,
      canvasId: input.canvasId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      nodeId: input.nodeId,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.params === undefined ? {} : { params: input.params }),
    })
  })
  ipcMain.handle('desktop:canvas:delete-node', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.projectId !== 'string' || input.projectId.length === 0 || input.projectId.length > 200
      || typeof input.canvasId !== 'string' || input.canvasId.length === 0 || input.canvasId.length > 200
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 2_147_483_647
      || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128
      || typeof input.nodeId !== 'string' || input.nodeId.length === 0 || input.nodeId.length > 256) {
      throw new Error('节点删除请求无效。')
    }
    return localCore.request('canvas:delete-node', {
      projectId: input.projectId,
      canvasId: input.canvasId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
      nodeId: input.nodeId,
    })
  })
  ipcMain.handle('desktop:canvas:save', (event, input) => {
    assertTrustedSender(event)
    return localCore.request('canvas:save', input)
  })
  ipcMain.handle('desktop:canvas:connect', (event, input) => {
    assertTrustedSender(event)
    return localCore.request('canvas:connect', input)
  })
  ipcMain.handle('desktop:canvas:delete-edge', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.projectId !== 'string' || input.projectId.length === 0 || input.projectId.length > 200
      || typeof input.canvasId !== 'string' || input.canvasId.length === 0 || input.canvasId.length > 200
      || typeof input.edgeId !== 'string' || input.edgeId.length === 0 || input.edgeId.length > 256) {
      throw new Error('连线删除请求无效。')
    }
    return localCore.request('canvas:delete-edge', {
      projectId: input.projectId,
      canvasId: input.canvasId,
      edgeId: input.edgeId,
    })
  })
  ipcMain.handle('desktop:canvas:group:add', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    assertGroupStackRequest(input, '编组', { nodeIdsRequired: true, stringFields: ['color'] })
    return localCore.request('canvas:group:add', input)
  })
  ipcMain.handle('desktop:canvas:group:update', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    assertGroupStackRequest(input, '编组', {
      idField: 'groupId',
      stringFields: ['name', 'color', 'layout'],
    })
    return localCore.request('canvas:group:update', input)
  })
  ipcMain.handle('desktop:canvas:group:delete', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    assertGroupStackRequest(input, '编组', { idField: 'groupId' })
    return localCore.request('canvas:group:delete', input)
  })
  ipcMain.handle('desktop:canvas:stack:add', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    assertGroupStackRequest(input, '堆叠', { nodeIdsRequired: true })
    return localCore.request('canvas:stack:add', input)
  })
  ipcMain.handle('desktop:canvas:stack:update', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    assertGroupStackRequest(input, '堆叠', { idField: 'stackId', booleanFields: ['collapsed'] })
    return localCore.request('canvas:stack:update', input)
  })
  ipcMain.handle('desktop:canvas:stack:extract', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    assertGroupStackRequest(input, '堆叠', { idField: 'stackId' })
    if (!isCanvasDomainId(input.nodeId)) throw new Error('节点标识无效。')
    return localCore.request('canvas:stack:extract', input)
  })
  ipcMain.handle('desktop:canvas:stack:delete', (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    assertGroupStackRequest(input, '堆叠', { idField: 'stackId' })
    return localCore.request('canvas:stack:delete', input)
  })
  ipcMain.handle('desktop:task:list', (event, projectId, limit) => {
    assertTrustedSender(event)
    return localCore.request('task:list', { projectId, limit })
  })
  ipcMain.handle('desktop:task:search', async (event, projectId, query) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200
      || !query || typeof query !== 'object' || Array.isArray(query)) {
      throw new Error('任务搜索请求无效。')
    }
    const allowedFields = new Set(['page', 'pageSize', 'keyword', 'model', 'modality', 'status', 'fromTime', 'toTime'])
    if (Object.keys(query).some((key) => !allowedFields.has(key))) throw new Error('任务搜索条件无效。')
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 20
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error('任务搜索分页参数无效。')
    }
    for (const key of ['keyword', 'model']) {
      const value = query[key]
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > 200)) {
        throw new Error('任务搜索条件无效。')
      }
    }
    if (query.modality !== undefined && query.modality !== null && query.modality !== ''
      && !['text', 'image', 'audio', 'video', 'compose'].includes(query.modality)) {
      throw new Error('任务模态筛选无效。')
    }
    if (query.status !== undefined && query.status !== null && query.status !== ''
      && !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(query.status)) {
      throw new Error('任务状态筛选无效。')
    }
    for (const key of ['fromTime', 'toTime']) {
      const value = query[key]
      if (value !== undefined && value !== null
        && (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000)) {
        throw new Error('任务日期筛选无效。')
      }
    }
    if (query.fromTime != null && query.toTime != null && query.fromTime > query.toTime) {
      throw new Error('任务日期范围无效。')
    }

    const result = await localCore.request('task:search', { projectId, query })
    return {
      items: result.items.map((task) => ({
        taskId: task.taskId,
        nodeId: task.nodeId,
        modality: task.modality,
        providerType: task.providerType,
        status: task.status,
        attemptCount: task.attemptCount,
        errorCode: task.errorCode,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        ...(task.outputMeta ? { outputMeta: task.outputMeta } : {}),
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    }
  })
  ipcMain.handle('desktop:task:get', async (event, projectId, taskId) => {
    assertTrustedSender(event)
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200
      || typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 200) {
      throw new Error('任务查询请求无效。')
    }
    const task = await localCore.request('task:get', { projectId, taskId })
    if (!task) return null
    // Expose only the task summary used by the renderer; keep input hashes,
    // output paths, and internal provider/model identifiers in the main process.
    return {
      taskId: task.taskId,
      nodeId: task.nodeId,
      modality: task.modality,
      providerType: task.providerType,
      status: task.status,
      attemptCount: task.attemptCount,
      errorCode: task.errorCode,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      ...(task.outputMeta ? { outputMeta: task.outputMeta } : {}),
    }
  })
  ipcMain.handle('desktop:task:get-input', async (event, projectId, taskId) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 200
      || typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 200) {
      throw new Error('任务输入查询请求无效。')
    }
    const result = await localCore.request('task:get-input', { projectId, taskId })
    if (!result) return null
    const task = result.task
    return {
      task: {
        taskId: task.taskId,
        canvasId: task.canvasId,
        canvasVersion: task.canvasVersion,
        nodeId: task.nodeId,
        modality: task.modality,
        providerType: task.providerType,
        providerId: task.providerId,
        modelId: task.modelId,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      },
      parameters: result.parameters,
    }
  })
  ipcMain.handle('desktop:task:cancel', (event, projectId, taskId) => {
    assertTrustedSender(event)
    return localCore.request('task:cancel', { projectId, taskId })
  })
  ipcMain.handle('desktop:task:create-generation', async (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    beginTaskCreation()
    try {
      const modalities = ['text', 'image', 'audio', 'video']
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || typeof input.projectId !== 'string' || typeof input.canvasId !== 'string'
        || !Number.isSafeInteger(input.canvasVersion) || typeof input.nodeId !== 'string'
        || typeof input.prompt !== 'string' || (input.modality !== 'audio' && input.prompt.trim().length === 0)
        || input.prompt.length > 200_000 || typeof input.idempotencyKey !== 'string'
        || !modalities.includes(input.modality)
        || !['local', 'cloud'].includes(input.providerType)
        || (input.parameters !== undefined && (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)))) {
        throw new Error('生成任务请求无效。')
      }
      let providerId
      let modelId
      if (input.providerType === 'local') {
        if (input.modality === 'audio') {
          providerId = SAPI_PROVIDER_ID
          modelId = SAPI_MODEL_ID
        } else {
          if (input.modality !== 'text') throw codedError('UNSUPPORTED_MODALITY')
          const model = await getLocalTextModelConfig()
          if (!model) throw new Error('请先配置本地文本模型。')
          providerId = model.providerId
          modelId = model.modelId
        }
      } else {
        if (input.modality === 'audio') throw codedError('MODEL_UNAVAILABLE')
        const catalog = await getAgnesModelSettings()
        if (!catalog.apiKeyConfigured) throw codedError('CLOUD_CREDENTIAL_MISSING')
        modelId = AGNES_MODELS[input.modality]
        providerId = AGNES_PROVIDER_ID
      }
      const parameters = { ...(input.parameters ?? {}) }
      if (input.modality !== 'audio' || input.prompt.trim() || !String(parameters.prompt ?? '').trim()) {
        parameters.prompt = input.prompt
      }
      const task = await localCore.request('task:create', {
        projectId: input.projectId,
        canvasId: input.canvasId,
        canvasVersion: input.canvasVersion,
        nodeId: input.nodeId,
        modality: input.modality,
        providerType: input.providerType,
        providerId,
        modelId,
        idempotencyKey: input.idempotencyKey,
        parameters,
      })
      void scheduleTaskPump(input.projectId)
      return task
    } finally {
      finishTaskCreation()
    }
  })
  ipcMain.handle('desktop:task:compose', async (event, input) => {
    assertTrustedSender(event)
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['projectId', 'canvasId', 'canvasVersion', 'nodeId', 'idempotencyKey', 'inputNodeIds'].includes(key))
      || typeof input.projectId !== 'string' || !input.projectId
      || typeof input.canvasId !== 'string' || !input.canvasId
      || !Number.isSafeInteger(input.canvasVersion) || input.canvasVersion < 0
      || typeof input.nodeId !== 'string' || !input.nodeId
      || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 255
      || !Array.isArray(input.inputNodeIds) || input.inputNodeIds.length < 2 || input.inputNodeIds.length > 10_000
      || input.inputNodeIds.some((nodeId) => typeof nodeId !== 'string' || !nodeId.trim() || nodeId.length > 256)) {
      throw codedError('INVALID_INPUT')
    }
    beginTaskCreation()
    try {
      const task = await localCore.request('task:create', {
        projectId: input.projectId,
        canvasId: input.canvasId,
        canvasVersion: input.canvasVersion,
        nodeId: input.nodeId,
        modality: 'compose',
        providerType: 'local',
        providerId: COMPOSE_PROVIDER_ID,
        modelId: COMPOSE_MODEL_ID,
        idempotencyKey: input.idempotencyKey,
        parameters: { operation: 'compose', inputNodeIds: input.inputNodeIds, count: 1 },
      })
      void scheduleTaskPump(input.projectId)
      return task
    } finally {
      finishTaskCreation()
    }
  })
  ipcMain.handle('desktop:task:read-output', (event, projectId, taskId) => {
    assertTrustedSender(event)
    return localCore.request('task:read-output', { projectId, taskId })
  })
  ipcMain.handle('desktop:model:get-agnes', async (event) => {
    assertTrustedSender(event)
    return getAgnesModelSettings()
  })
  ipcMain.handle('desktop:model:save-agnes-key', async (event, apiKey) => {
    assertTrustedSender(event)
    return saveAgnesApiKey(apiKey)
  })
  ipcMain.handle('desktop:model:clear-agnes-key', async (event) => {
    assertTrustedSender(event)
    return clearAgnesApiKey()
  })
  ipcMain.handle('desktop:model:get-local-text', (event) => {
    assertTrustedSender(event)
    return getLocalTextModelConfig()
  })
  ipcMain.handle('desktop:model:get-local-audio', (event) => {
    assertTrustedSender(event)
    return getLocalAudioModel()
  })
  ipcMain.handle('desktop:model:discover-local', (event, endpoint) => {
    assertTrustedSender(event)
    return discoverLocalModels(endpoint)
  })
  ipcMain.handle('desktop:model:save-local-text', (event, config) => {
    assertTrustedSender(event)
    return saveLocalTextModelConfig(config).then(async (model) => {
      if (!projectTransitionCount) {
        const active = await localCore.request('project:get-active')
        if (active) void scheduleTaskPump(active.projectId)
      }
      return model
    })
  })
  ipcMain.handle('desktop:model:clear-local-text', (event) => {
    assertTrustedSender(event)
    return clearLocalTextModelConfig()
  })
}

function registerAgentIpc() {
  async function getAgentWorker(projectId) {
    if (stopping || projectTransitionCount > 0) throw new Error('项目正在切换，请稍后重试。')
    const active = await localCore.request('project:get-active')
    if (!active || active.projectId !== projectId || !agentWorker || agentProjectId !== projectId) {
      throw new Error('当前项目的本地 Agent 会话不可用。')
    }
    if (projectTransitionCount > 0 || agentProjectId !== projectId) {
      throw new Error('项目正在切换，请稍后重试。')
    }
    return agentWorker
  }

  ipcMain.handle('desktop:agent:list-sessions', async (event, projectId) => {
    assertTrustedSender(event)
    const worker = await getAgentWorker(projectId)
    return worker.request('agent:list-sessions', { projectId })
  })
  ipcMain.handle('desktop:agent:list-skills', async (event, projectId, sessionId, keyword) => {
    assertTrustedSender(event)
    if ((typeof sessionId !== 'undefined' && (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 128))
      || (typeof keyword !== 'undefined' && (typeof keyword !== 'string' || keyword.length > 160))) {
      throw codedError('AGENT_SKILL_QUERY_INVALID')
    }
    const worker = await getAgentWorker(projectId)
    return worker.request('agent:list-skills', { projectId, sessionId, keyword })
  })
  ipcMain.handle('desktop:agent:create-session', async (event, projectId, title) => {
    assertTrustedSender(event)
    const worker = await getAgentWorker(projectId)
    return worker.request('agent:create-session', { projectId, title })
  })
  ipcMain.handle('desktop:agent:get-messages', async (event, projectId, sessionId) => {
    assertTrustedSender(event)
    const worker = await getAgentWorker(projectId)
    return worker.request('agent:get-messages', { projectId, sessionId })
  })
  ipcMain.handle('desktop:agent:get-snapshot', async (event, projectId, sessionId) => {
    assertTrustedSender(event)
    const worker = await getAgentWorker(projectId)
    return worker.request('agent:get-snapshot', { projectId, sessionId })
  })
  ipcMain.handle('desktop:agent:list-events', async (event, projectId, sessionId, afterSeq) => {
    assertTrustedSender(event)
    if (typeof sessionId !== 'string' || sessionId.length > 128
      || !Number.isSafeInteger(afterSeq) || afterSeq < 0) throw codedError('AGENT_SESSION_INPUT_INVALID')
    const worker = await getAgentWorker(projectId)
    return worker.request('agent:list-events', { projectId, sessionId, afterSeq })
  })
  ipcMain.handle('desktop:agent:start-run', async (event, input) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.projectId !== 'string' || typeof input.canvasId !== 'string'
      || typeof input.sessionId !== 'string' || input.sessionId.length > 128
      || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 20_000
      || !Number.isSafeInteger(input.canvasVersion) || input.canvasVersion < 0
      || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 255
      || (input.selectedSkillId !== undefined && (typeof input.selectedSkillId !== 'string'
        || input.selectedSkillId.length < 1 || input.selectedSkillId.length > 160))
      || (input.selectedNodeIds !== undefined && (!Array.isArray(input.selectedNodeIds)
        || input.selectedNodeIds.length > 20 || input.selectedNodeIds.some((id) => typeof id !== 'string' || !id)))) {
      throw codedError('AGENT_RUN_INPUT_INVALID')
    }
    const worker = await getAgentWorker(input.projectId)
    const apiKey = await getAgnesApiKey()
    if (!apiKey) throw codedError('CLOUD_CREDENTIAL_MISSING')
    const active = await localCore.request('project:get-active')
    if (!active || active.projectId !== input.projectId || active.canvasId !== input.canvasId) throw codedError('AGENT_PROJECT_CHANGED')
    const canvas = await localCore.request('canvas:load', { projectId: input.projectId, canvasId: input.canvasId })
    if (canvas.version !== input.canvasVersion) throw codedError('AGENT_CANVAS_CHANGED')
    const canvasContext = buildAgentCanvasContext(canvas)
    const latestWorker = await getAgentWorker(input.projectId)
    const latestProject = await localCore.request('project:get-active')
    if (latestWorker !== worker || !latestProject || latestProject.projectId !== input.projectId
      || latestProject.canvasId !== input.canvasId) throw codedError('AGENT_PROJECT_CHANGED')
    const latestCanvas = await localCore.request('canvas:load', { projectId: input.projectId, canvasId: input.canvasId })
    if (latestCanvas.version !== input.canvasVersion) throw codedError('AGENT_CANVAS_CHANGED')
    return worker.request('agent:start-run', {
      ...input,
      content: input.content.trim(),
      canvasContext,
      canvasNodeCount: latestCanvas.nodes.length,
      apiKey,
    }, 30_000)
  })
  ipcMain.handle('desktop:agent:confirm-action', async (event, input) => {
    assertTrustedSender(event)
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.projectId !== 'string' || typeof input.canvasId !== 'string'
      || typeof input.sessionId !== 'string' || input.sessionId.length > 128
      || typeof input.actionId !== 'string' || input.actionId.length > 128
      || typeof input.approvalToken !== 'string' || input.approvalToken.length > 4096
      || typeof input.accept !== 'boolean'
      || !Number.isSafeInteger(input.canvasVersion) || input.canvasVersion < 0) {
      throw codedError('AGENT_CONFIRMATION_INPUT_INVALID')
    }
    const worker = await getAgentWorker(input.projectId)
    const active = await localCore.request('project:get-active')
    if (!active || active.projectId !== input.projectId || active.canvasId !== input.canvasId) throw codedError('AGENT_PROJECT_CHANGED')
    const canvas = await localCore.request('canvas:load', { projectId: input.projectId, canvasId: input.canvasId })
    return worker.request('agent:confirm-action', { ...input, currentCanvasVersion: canvas.version }, 60_000)
  })
  ipcMain.handle('desktop:agent:send-message', async (event, projectId, sessionId, content, selectedSkillId) => {
    assertTrustedSender(event)
    if (typeof content !== 'string' || !content.trim() || content.length > 20_000) {
      throw codedError('AGENT_MESSAGE_INVALID')
    }
    if (selectedSkillId !== undefined && (typeof selectedSkillId !== 'string'
      || selectedSkillId.length < 1 || selectedSkillId.length > 160)) throw codedError('AGENT_SKILL_ID_INVALID')
    const worker = await getAgentWorker(projectId)
    const apiKey = await getAgnesApiKey()
    if (!apiKey) throw codedError('CLOUD_CREDENTIAL_MISSING')
    const active = await localCore.request('project:get-active')
    if (!active || active.projectId !== projectId) throw codedError('AGENT_PROJECT_CHANGED')
    const canvas = await localCore.request('canvas:load', { projectId, canvasId: active.canvasId })
    const canvasContext = buildAgentCanvasContext(canvas)
    const latestWorker = await getAgentWorker(projectId)
    const latestProject = await localCore.request('project:get-active')
    if (latestWorker !== worker || !latestProject || latestProject.projectId !== projectId) {
      throw codedError('AGENT_PROJECT_CHANGED')
    }
    const latestCanvas = await localCore.request('canvas:load', { projectId, canvasId: latestProject.canvasId })
    if (latestCanvas.version !== canvas.version) throw codedError('AGENT_CANVAS_CHANGED')
    return worker.request('agent:send-message', {
      projectId,
      sessionId,
      content,
      selectedSkillId,
      canvasId: latestProject.canvasId,
      canvasVersion: latestCanvas.version,
      canvasNodeCount: latestCanvas.nodes.length,
      canvasContext,
      apiKey,
      idempotencyKey: randomUUID(),
    }, 270_000)
  })
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })

  if (developmentUrl) {
    await mainWindow.loadURL(developmentUrl)
  } else {
    await mainWindow.loadURL('vibe://app/')
  }
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    if (!developmentUrl) await fs.access(rendererIndex)
    recentProjectFile = path.join(app.getPath('userData'), 'recent-project.json')
    recentProjectsFile = path.join(app.getPath('userData'), 'recent-projects.json')
    desktopSettingsFile = path.join(app.getPath('userData'), 'settings.json')
    agnesCredentialFile = path.join(app.getPath('userData'), 'credentials', 'agnes-api-key.bin')
    localCore = startLocalCore()
    recentProjectCatalog = createRecentProjectCatalog({
      catalogFile: recentProjectsFile,
      legacyFile: recentProjectFile,
      inspectProject: (directory, expectedIdentity) => localCore.request('project:inspect', {
        directory,
        ...(expectedIdentity ? {
          expectedProjectId: expectedIdentity.projectId,
          expectedCanvasId: expectedIdentity.canvasId,
        } : {}),
      }),
    })
    const restoredProject = await restoreRecentProject()
    if (restoredProject) void scheduleTaskPump(restoredProject.projectId)
    registerRendererProtocol()
    registerContentSecurityPolicy()
    registerProjectIpc()
    registerAgentIpc()
    await createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  }).catch((error) => {
    const message = error instanceof Error ? error.message : '桌面应用启动失败。'
    void dialog.showErrorBox('VibePaper 启动失败', message)
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (!localCore || quittingAfterCoreClose) return
    event.preventDefault()
    quittingAfterCoreClose = true
      stopping = true
      taskPumpRequestedProjectId = null
      void (async () => {
        await waitForTaskCreations()
        await stopAgentWorker().catch(() => undefined)
        await stopGenerationWorker().catch(() => undefined)
      await taskPumpPromise?.catch(() => undefined)
      await localCore.request('core:close', {}, 5_000).catch(() => undefined)
      localCore.child.kill()
      app.quit()
    })()
  })
} else {
  app.quit()
}
