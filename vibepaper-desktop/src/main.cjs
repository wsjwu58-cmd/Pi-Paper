const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
} = require('electron')
const { createDesktopProjectStore } = require('./project-store.cjs')

app.setName('VibePaper')
protocol.registerSchemesAsPrivileged([{
  scheme: 'vibe',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}])

const hasSingleInstanceLock = app.requestSingleInstanceLock()
let mainWindow = null
let projectStore = null
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
    return projectStore.getActiveProject()
  })
  ipcMain.handle('desktop:project:create', (event, name) => {
    assertTrustedSender(event)
    return projectStore.createProject(name)
  })
  ipcMain.handle('desktop:project:open', (event) => {
    assertTrustedSender(event)
    return projectStore.openProject()
  })
  ipcMain.handle('desktop:canvas:load', (event, projectId, canvasId) => {
    assertTrustedSender(event)
    return projectStore.loadCanvas(projectId, canvasId)
  })
  ipcMain.handle('desktop:canvas:save', (event, input) => {
    assertTrustedSender(event)
    return projectStore.saveCanvas(input)
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
    projectStore = createDesktopProjectStore({
      app,
      dialog,
      getWindow: () => mainWindow,
    })
    await projectStore.restoreRecentProject()
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
} else {
  app.quit()
}
