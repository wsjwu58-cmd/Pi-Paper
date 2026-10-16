// Narrow post-abort cleanup for one isolated Codex acceptance profile.
// It only uses the original Main/Renderer IPC to inspect redacted provider
// status, clear Agnes credentials, and revoke the exact fixture grant.
'use strict'

const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const { app, dialog, protocol } = require('electron')

const root = path.resolve(__dirname, '../..')
const runDirectoryName = 'mcp-codex-agnes-2026-10-16T03-00-40-076Z-38c41950-bb56-4dce-a423-c2f500cebb97'
const runRoot = path.join(root, '.test-temp', runDirectoryName)
const profile = path.join(runRoot, 'VibePaper')
const projectDirectory = path.join(runRoot, 'project')
const reportPath = path.join(runRoot, 'codex-agnes-post-abort-cleanup-2026-10-16T03-00-40-076Z-retry-protocol-preregistered.json')
const originalReportPath = path.join(root, 'docs', 'verification', '2026-10-11-mcp-acceptance',
  'codex-agnes-acceptance-2026-10-16T03-00-40-076Z.json')
const fixtureClientName = 'codex'
const fixtureDisplayName = 'Codex Agnes full-chain acceptance'
const fixtureCredentialEnvName = 'VIBEPAPER_ACCEPTANCE_AGNES_KEY'
const allowedErrorCodes = new Set([
  'INVALID_INPUT', 'MCP_CLIENT_NOT_FOUND', 'MCP_UNAVAILABLE', 'PROVIDER_NOT_FOUND',
  'PROVIDER_REVISION_CONFLICT', 'PROVIDER_REVISION_REQUIRED', 'PROVIDER_STATE_INCOMPLETE',
  'SECURE_STORAGE_UNAVAILABLE', 'TARGET_SCOPE_INVALID', 'TARGET_PROFILE_MISSING',
  'CLEANUP_REPORT_ALREADY_EXISTS', 'ELECTRON_WINDOW_TIMEOUT', 'RENDERER_LOAD_TIMEOUT',
  'RENDERER_LOAD_FAILED', 'RENDERER_BRIDGE_UNAVAILABLE', 'RENDERER_UNAVAILABLE',
  'APP_QUIT_BEFORE_CLEANUP',
])
const allowedErrorNames = new Set(['AbortError', 'DOMException', 'Error', 'RangeError', 'ReferenceError', 'SyntaxError', 'TimeoutError', 'TypeError'])

const dialogCalls = { messageBox: 0, messageBoxSync: 0, openDialog: 0, openDialogSync: 0, saveDialog: 0, saveDialogSync: 0, errorBox: 0 }
let hiddenWindow = null
let windowShown = false
let showRequestsSuppressed = 0
let reportWritten = false
let reportWritePromise = null
let mainLoaded = false
let stage = 'module-preflight'
let failure = null
let readiness = null
let startupError = null

function fixedErrorCode(error) {
  return typeof error?.code === 'string' && allowedErrorCodes.has(error.code)
    ? error.code
    : 'CLEANUP_IPC_FAILED'
}

function safeFailure(error) {
  return {
    stage,
    errorName: allowedErrorNames.has(error?.name) ? error.name : 'Error',
    errorCode: fixedErrorCode(error),
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function withTimeout(promise, milliseconds, code) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), milliseconds)
    }),
  ]).finally(() => clearTimeout(timer))
}

function assertFixedScope() {
  const expectedRunRoot = path.resolve(root, '.test-temp', runDirectoryName)
  if (runRoot !== expectedRunRoot || path.basename(runRoot) !== runDirectoryName) {
    throw Object.assign(new Error('TARGET_SCOPE_INVALID'), { code: 'TARGET_SCOPE_INVALID' })
  }
  for (const directory of [path.join(root, '.test-temp'), runRoot, profile, projectDirectory]) {
    let stat
    try { stat = fsSync.lstatSync(directory) } catch {}
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw Object.assign(new Error('TARGET_PROFILE_MISSING'), { code: 'TARGET_PROFILE_MISSING' })
    }
  }
  if (fsSync.existsSync(reportPath)) {
    throw Object.assign(new Error('CLEANUP_REPORT_ALREADY_EXISTS'), { code: 'CLEANUP_REPORT_ALREADY_EXISTS' })
  }
}

function configureHiddenDesktop() {
  // Match Main's privileged scheme setup before Electron emits `ready`, then
  // suppress Main's duplicate registration exactly as the acceptance harness does.
  protocol.registerSchemesAsPrivileged([{
    scheme: 'vibe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }])
  protocol.registerSchemesAsPrivileged = () => {}
  app.commandLine.appendSwitch('user-data-dir', profile)

  const windowCreated = deferred()
  const rendererLoaded = deferred()
  app.on('browser-window-created', (_event, created) => {
    hiddenWindow = created
    try { created.setSkipTaskbar(true) } catch {}
    try { created.hide() } catch {}
    created.show = () => {
      showRequestsSuppressed += 1
      try { created.hide() } catch {}
      return undefined
    }
    created.showInactive = () => {
      showRequestsSuppressed += 1
      try { created.hide() } catch {}
      return undefined
    }
    created.focus = () => undefined
    created.moveTop = () => undefined
    created.on('show', () => {
      windowShown = true
      try { created.hide() } catch {}
    })
    created.webContents.once('did-finish-load', () => rendererLoaded.resolve(created))
    created.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame) rendererLoaded.reject(Object.assign(new Error('RENDERER_LOAD_FAILED'), { code: 'RENDERER_LOAD_FAILED', errorCode }))
    })
    windowCreated.resolve(created)
  })

  // No native UI is needed for cleanup. If startup unexpectedly requests a
  // dialog, return cancellation/empty selections; never synthesize approval.
  if (typeof dialog.showMessageBox === 'function') {
    dialog.showMessageBox = async () => { dialogCalls.messageBox += 1; return { response: -1, checkboxChecked: false } }
  }
  if (typeof dialog.showMessageBoxSync === 'function') {
    dialog.showMessageBoxSync = () => { dialogCalls.messageBoxSync += 1; return -1 }
  }
  if (typeof dialog.showOpenDialog === 'function') {
    dialog.showOpenDialog = async () => { dialogCalls.openDialog += 1; return { canceled: true, filePaths: [] } }
  }
  if (typeof dialog.showOpenDialogSync === 'function') {
    dialog.showOpenDialogSync = () => { dialogCalls.openDialogSync += 1; return undefined }
  }
  if (typeof dialog.showSaveDialog === 'function') {
    dialog.showSaveDialog = async () => { dialogCalls.saveDialog += 1; return { canceled: true, filePath: undefined } }
  }
  if (typeof dialog.showSaveDialogSync === 'function') {
    dialog.showSaveDialogSync = () => { dialogCalls.saveDialogSync += 1; return undefined }
  }
  if (typeof dialog.showErrorBox === 'function') {
    dialog.showErrorBox = () => { dialogCalls.errorBox += 1 }
  }
  return { windowCreated, rendererLoaded }
}

function providerCredentialState(snapshot) {
  const provider = Array.isArray(snapshot?.providers)
    ? snapshot.providers.find((entry) => entry?.id === 'agnes')
    : null
  if (!provider) return { providerFound: false, configured: null, configuredFieldCount: null, revision: null }
  const fields = Array.isArray(provider.credentialFields) ? provider.credentialFields : []
  return {
    providerFound: true,
    configured: provider.configured === true,
    configuredFieldCount: fields.filter((field) => field?.configured === true).length,
    revision: Number.isSafeInteger(provider.revision) ? provider.revision : null,
  }
}

function isFixtureGrant(client) {
  if (client?.clientName !== fixtureClientName || client?.displayName !== fixtureDisplayName) return false
  const grants = Array.isArray(client.providerGrants) ? client.providerGrants : []
  return grants.some((grant) => grant?.providerId === 'agnes'
    && Array.isArray(grant.credentialFields) && grant.credentialFields.includes('apiKey')
    && Array.isArray(grant.credentialInputModes) && grant.credentialInputModes.includes('authorized_env')
    && Array.isArray(grant.authorizedEnv) && grant.authorizedEnv.some((item) => item?.fieldName === 'apiKey'
      && item?.envVariableName === fixtureCredentialEnvName))
}

async function evaluate(expression) {
  if (!hiddenWindow || hiddenWindow.isDestroyed() || hiddenWindow.webContents.isDestroyed()) {
    throw Object.assign(new Error('RENDERER_UNAVAILABLE'), { code: 'RENDERER_UNAVAILABLE' })
  }
  return hiddenWindow.webContents.executeJavaScript(expression, true)
}

async function cleanup() {
  const state = {
    providerBefore: null,
    providerAfter: null,
    credentialClearAttempted: false,
    credentialClearSucceeded: false,
    credentialAlreadyClear: false,
    credentialErrorCode: null,
    credentialErrorName: null,
    credentialErrorStage: null,
    fixtureClientMatchCount: 0,
    fixtureClientCandidateCount: 0,
    fixtureClientWasAlreadyRevoked: false,
    grantRevokeAttempted: false,
    grantRevokeSucceeded: false,
    grantErrorCode: null,
    grantErrorName: null,
    grantErrorStage: null,
  }

  stage = 'read-provider-config'
  const before = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
  state.providerBefore = providerCredentialState(before)
  const needsCredentialClear = state.providerBefore.configured === true || state.providerBefore.configuredFieldCount > 0
  if (needsCredentialClear && state.providerBefore.providerFound && Number.isSafeInteger(state.providerBefore.revision)) {
    stage = 'clear-provider-config'
    state.credentialClearAttempted = true
    try {
      await evaluate(`window.vibepaperDesktop.clearProviderConfiguration('agnes', ${state.providerBefore.revision})`)
      const afterClear = await evaluate('window.vibepaperDesktop.getProviderConfiguration()')
      state.providerAfter = providerCredentialState(afterClear)
      state.credentialClearSucceeded = state.providerAfter.providerFound
        && state.providerAfter.configured === false && state.providerAfter.configuredFieldCount === 0
    } catch (error) {
      state.credentialErrorCode = fixedErrorCode(error)
      state.credentialErrorName = allowedErrorNames.has(error?.name) ? error.name : 'Error'
      state.credentialErrorStage = 'clear-provider-config'
    }
  } else {
    state.credentialAlreadyClear = state.providerBefore.providerFound
      && state.providerBefore.configured === false && state.providerBefore.configuredFieldCount === 0
    state.providerAfter = state.providerBefore
    state.credentialClearSucceeded = state.credentialAlreadyClear
  }

  stage = 'read-mcp-state'
  const mcpState = await evaluate('window.vibepaperDesktop.getMcpState()')
  const clients = Array.isArray(mcpState?.clients) ? mcpState.clients : []
  const candidates = clients.filter(client => client?.clientName === fixtureClientName
    && client?.displayName === fixtureDisplayName)
  const matches = clients.filter(isFixtureGrant)
  state.fixtureClientCandidateCount = candidates.length
  state.fixtureClientMatchCount = matches.length
  if (matches.length === 1) {
    const client = matches[0]
    state.fixtureClientWasAlreadyRevoked = Boolean(client.revokedAt)
    if (!client.revokedAt || client.connected === true) {
      stage = 'revoke-fixture-grant'
      state.grantRevokeAttempted = true
      try {
        await evaluate(`window.vibepaperDesktop.revokeMcpClientGrant(${JSON.stringify(client.clientId)})`)
      } catch (error) {
        state.grantErrorCode = fixedErrorCode(error)
        state.grantErrorName = allowedErrorNames.has(error?.name) ? error.name : 'Error'
        state.grantErrorStage = 'revoke-fixture-grant'
      }
    }
    try {
      stage = 'verify-fixture-grant-revocation'
      const afterRevoke = await evaluate('window.vibepaperDesktop.getMcpState()')
      const verified = (Array.isArray(afterRevoke?.clients) ? afterRevoke.clients : []).filter(isFixtureGrant)
      state.grantRevokeSucceeded = verified.length === 1 && Boolean(verified[0].revokedAt) && verified[0].connected === false
    } catch (error) {
      state.grantErrorCode ||= fixedErrorCode(error)
      state.grantErrorName ||= allowedErrorNames.has(error?.name) ? error.name : 'Error'
      state.grantErrorStage ||= 'verify-fixture-grant-revocation'
    }
  }

  const credentialsClean = state.credentialClearSucceeded || state.credentialAlreadyClear
  const grantClean = state.fixtureClientCandidateCount === 0
    || state.fixtureClientCandidateCount === 1 && state.fixtureClientMatchCount === 1 && state.grantRevokeSucceeded
  return {
    status: credentialsClean && grantClean ? 'completed' : 'partial',
    credentialsClean,
    grantClean,
    ...state,
  }
}

async function writeReport(result) {
  if (reportWritten) return reportWritePromise
  reportWritePromise = (async () => {
    const report = {
      schemaVersion: 1,
      scope: 'codex-agnes-aborted-run-2026-10-16T03-00-40-076Z',
      stage: result.stage || stage,
      status: result.status,
      failure: result.failure || failure,
      credentialsClean: result.credentialsClean === true,
      grantClean: result.grantClean === true,
      providerBefore: result.providerBefore || null,
      providerAfter: result.providerAfter || null,
      credentialClearAttempted: result.credentialClearAttempted === true,
      credentialClearSucceeded: result.credentialClearSucceeded === true,
      credentialAlreadyClear: result.credentialAlreadyClear === true,
      credentialErrorCode: result.credentialErrorCode || null,
      credentialErrorName: result.credentialErrorName || null,
      credentialErrorStage: result.credentialErrorStage || null,
      fixtureClientMatchCount: Number.isSafeInteger(result.fixtureClientMatchCount) ? result.fixtureClientMatchCount : 0,
      fixtureClientCandidateCount: Number.isSafeInteger(result.fixtureClientCandidateCount) ? result.fixtureClientCandidateCount : 0,
      fixtureClientWasAlreadyRevoked: result.fixtureClientWasAlreadyRevoked === true,
      grantRevokeAttempted: result.grantRevokeAttempted === true,
      grantRevokeSucceeded: result.grantRevokeSucceeded === true,
      grantErrorCode: result.grantErrorCode || null,
      grantErrorName: result.grantErrorName || null,
      grantErrorStage: result.grantErrorStage || null,
      originalAcceptanceReportPreserved: await fs.stat(originalReportPath).then(() => true, () => false),
      safety: {
        isolatedProfileUsed: true,
        windowShown,
        showRequestsSuppressed,
        dialogsAutoApproved: false,
        dialogCalls,
        codexLaunched: false,
        generationSubmitted: false,
        taskStoreAccessed: false,
        decryptedCredentialRead: false,
        secretWritten: false,
        clientOrProjectIdsWritten: false,
      },
      finishedAt: new Date().toISOString(),
    }
    const handle = await fs.open(reportPath, 'wx')
    try { await handle.writeFile(JSON.stringify(report, null, 2), 'utf8') } finally { await handle.close() }
    reportWritten = true
    return report
  })()
  return reportWritePromise
}

async function main() {
  if (startupError) throw startupError
  stage = 'require-main'
  mainLoaded = true
  require('../src/main.cjs')
  stage = 'wait-app-ready'
  await app.whenReady()
  stage = 'wait-main-window'
  await withTimeout(readiness.windowCreated.promise, 90_000, 'ELECTRON_WINDOW_TIMEOUT')
  stage = 'wait-renderer-load'
  await withTimeout(readiness.rendererLoaded.promise, 90_000, 'RENDERER_LOAD_TIMEOUT')
  stage = 'check-preload-bridge'
  const bridgeReady = await evaluate('Boolean(window.vibepaperDesktop && window.vibepaperDesktop.getProviderConfiguration && window.vibepaperDesktop.getMcpState)')
  if (!bridgeReady) throw Object.assign(new Error('RENDERER_BRIDGE_UNAVAILABLE'), { code: 'RENDERER_BRIDGE_UNAVAILABLE' })
  const result = await cleanup()
  stage = 'write-cleanup-report'
  const report = await writeReport(result)
  process.stdout.write(`CLEANUP_STATUS ${report.status}\n`)
  process.stdout.write(`CLEANUP_REPORT ${reportPath}\n`)
  if (report.status === 'completed') app.quit()
  else app.exit(1)
}

app.on('before-quit', (event) => {
  if (reportWritten || !mainLoaded) return
  event.preventDefault()
  stage = 'main-requested-quit-before-cleanup'
  failure = safeFailure(Object.assign(new Error('APP_QUIT_BEFORE_CLEANUP'), { code: 'APP_QUIT_BEFORE_CLEANUP' }))
  void writeReport({
    status: 'failed',
    credentialsClean: false,
    grantClean: false,
    stage,
    failure,
  }).finally(() => app.exit(1))
})

// Run every scope and protocol preflight synchronously during module loading,
// before Electron can reach `ready` and before requiring the original Main.
try {
  stage = 'synchronous-scope-preflight'
  assertFixedScope()
  stage = 'pre-register-vibe-protocol'
  readiness = configureHiddenDesktop()
} catch (error) {
  startupError = error
  failure = safeFailure(error)
}

main().catch(async (error) => {
  failure = safeFailure(error)
  process.exitCode = 1
  const report = await writeReport({
    status: 'failed',
    credentialsClean: false,
    grantClean: false,
    stage,
    failure,
  }).catch(() => null)
  process.stdout.write(`CLEANUP_STATUS ${report?.status || 'failed'}\n`)
  if (report) process.stdout.write(`CLEANUP_REPORT ${reportPath}\n`)
  app.exit(1)
})
