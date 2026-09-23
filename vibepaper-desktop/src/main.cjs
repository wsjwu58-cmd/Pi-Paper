const path = require('node:path')
const fs = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  utilityProcess,
} = require('electron')

app.setName('VibePaper')
protocol.registerSchemesAsPrivileged([{
  scheme: 'vibe',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}])

const hasSingleInstanceLock = app.requestSingleInstanceLock()
let mainWindow = null
let localCore = null
let recentProjectFile = null
let quittingAfterCoreClose = false
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
    const created = await localCore.request('project:create', {
      parentDirectory: result.filePaths[0],
      name,
    })
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
    const opened = await localCore.request('project:open', { directory: result.filePaths[0] })
    await writeRecentProjectDirectory(opened.directory)
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
      message: '本地项目备份已创建。',
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

    const restored = await localCore.request('project:restore-backup', {
      sourceDirectory: sourceResult.filePaths[0],
      parentDirectory: destinationResult.filePaths[0],
    }, 30 * 60 * 1000)
    await writeRecentProjectDirectory(restored.directory)
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
    localCore = startLocalCore()
    await restoreRecentProject()
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
    void localCore.request('core:close', {}, 5_000).catch(() => undefined).finally(() => {
      localCore.child.kill()
      app.quit()
    })
  })
} else {
  app.quit()
}
