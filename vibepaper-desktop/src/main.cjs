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

app.setName('VibePaper')
protocol.registerSchemesAsPrivileged([{
  scheme: 'vibe',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}])

const hasSingleInstanceLock = app.requestSingleInstanceLock()
let mainWindow = null
let localCore = null
let recentProjectFile = null
let desktopSettingsFile = null
let agnesCredentialFile = null
let quittingAfterCoreClose = false
let stopping = false
let generationWorker = null
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
        const timeout = payload?.modality === 'video' ? 17 * 60 * 1000
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

async function drainTaskQueue(projectId) {
  if (stopping || !localCore) return

  while (!stopping) {
    const claimed = await localCore.request('task:claim-next', { projectId })
    if (!claimed) return
    if (stopping) return
    const { task, parameters, outputDirectory } = claimed
    try {
      let model
      if (task.providerType === 'local') {
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
        outputDirectory,
      })
      if (stopping) return
      await localCore.request('task:succeeded', {
        projectId,
        taskId: task.taskId,
        outputPath: result?.outputPath,
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
  try {
    await waitForTaskCreations()
    if (taskPumpPromise) await taskPumpPromise
    return await operation()
  } finally {
    projectTransitionCount -= 1
  }
}

async function writeRecentProjectDirectory(directory) {
  if (!recentProjectFile) throw new Error('桌面设置尚未初始化。')
  const temporaryPath = path.join(path.dirname(recentProjectFile), `.recent-project.${randomUUID()}.tmp`)
  await fs.mkdir(path.dirname(recentProjectFile), { recursive: true })
  let handle
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, projectDirectory: directory })}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporaryPath, recentProjectFile)
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
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
    return opened.project
  } catch (error) {
    if (!error || error.code !== 'ENOENT') await fs.rm(recentProjectFile, { force: true }).catch(() => undefined)
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
      ? "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'"
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

function registerProjectIpc() {
  ipcMain.handle('desktop:project:get-active', (event) => {
    assertTrustedSender(event)
    return localCore.request('project:get-active')
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
    const backup = await localCore.request('project:backup', {
      parentDirectory: result.filePaths[0],
      projectId,
    })
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
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入本地图片素材',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return localCore.request('asset:import', { sourcePath: result.filePaths[0], projectId })
  })
  ipcMain.handle('desktop:asset:list', (event, projectId) => {
    assertTrustedSender(event)
    return localCore.request('asset:list', { projectId })
  })
  ipcMain.handle('desktop:canvas:load', (event, projectId, canvasId) => {
    assertTrustedSender(event)
    return localCore.request('canvas:load', { projectId, canvasId })
  })
  ipcMain.handle('desktop:canvas:save', (event, input) => {
    assertTrustedSender(event)
    return localCore.request('canvas:save', input)
  })
  ipcMain.handle('desktop:task:list', (event, projectId, limit) => {
    assertTrustedSender(event)
    return localCore.request('task:list', { projectId, limit })
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
      const modalities = ['text', 'image', 'video']
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || typeof input.projectId !== 'string' || typeof input.canvasId !== 'string'
        || !Number.isSafeInteger(input.canvasVersion) || typeof input.nodeId !== 'string'
        || typeof input.prompt !== 'string' || input.prompt.trim().length === 0
        || input.prompt.length > 200_000 || typeof input.idempotencyKey !== 'string'
        || !modalities.includes(input.modality)
        || !['local', 'cloud'].includes(input.providerType)
        || (input.parameters !== undefined && (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)))) {
        throw new Error('生成任务请求无效。')
      }
      let providerId
      let modelId
      if (input.providerType === 'local') {
        if (input.modality !== 'text') throw codedError('UNSUPPORTED_MODALITY')
        const model = await getLocalTextModelConfig()
        if (!model) throw new Error('请先配置本地文本模型。')
        providerId = model.providerId
        modelId = model.modelId
      } else {
        const catalog = await getAgnesModelSettings()
        if (!catalog.apiKeyConfigured) throw codedError('CLOUD_CREDENTIAL_MISSING')
        modelId = AGNES_MODELS[input.modality]
        providerId = AGNES_PROVIDER_ID
        const modalityName = ({ text: '文本', image: '图像', video: '视频' })[input.modality]
        const consent = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: `将${modalityName}提示词发送到 Agnes`,
          buttons: ['取消', '发送到 Agnes'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: `本次${modalityName}任务会把当前文本节点的内容发送至 Agnes AI（Sapiens Technology）。`,
          detail: '请求将离开本机并由供应商处理；供应商可能按其规则收费。此请求只发送提示词和生成参数，不会上传整个项目或本地素材。',
        })
        if (consent.response !== 1) return null
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
        parameters: { ...(input.parameters ?? {}), prompt: input.prompt },
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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
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
    desktopSettingsFile = path.join(app.getPath('userData'), 'settings.json')
    agnesCredentialFile = path.join(app.getPath('userData'), 'credentials', 'agnes-api-key.bin')
    localCore = startLocalCore()
    const restoredProject = await restoreRecentProject()
    if (restoredProject) void scheduleTaskPump(restoredProject.projectId)
    registerRendererProtocol()
    registerContentSecurityPolicy()
    registerProjectIpc()
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
