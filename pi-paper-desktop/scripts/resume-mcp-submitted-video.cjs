// Recovery QA only: reopen one already submitted Agnes video through original
// Main/TaskStore/Worker. Never create a task or permit a worker without the
// persisted upstream ID. Key travels over no-echo stdin, never argv or Renderer.
const path = require('node:path')
const fs = require('node:fs/promises')
const { randomUUID, createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const assert = require('node:assert/strict')
const { protectRunDirectory, safeEnvironment } = require('./prepare-mcp-native-confirmation.cjs')
const root = path.resolve(__dirname, '../..')
const sourceRun = 'mcp-codex-agnes-2026-10-20T09-08-01-160Z-8120f1de-0821-4917-8e14-5b6f2b647b5a'
const projectDirectory = path.join(root, '.test-temp', sourceRun, 'project', 'Codex Agnes media acceptance')

function snapshot() {
  const db = new DatabaseSync(path.join(projectDirectory, '.vibepaper/project.sqlite'), { readOnly: true })
  try {
    const tasks = db.prepare('SELECT task_id, canvas_id, node_id, modality, provider_id, model_id, status, error_code, output_path, output_sha256, output_size_bytes FROM tasks').all()
    assert.equal(tasks.length, 1)
    const task = tasks[0]
    assert.equal(task.modality, 'video')
    assert.equal(task.provider_id, 'agnes')
    const events = db.prepare('SELECT type, data_json FROM task_events WHERE task_id = ? ORDER BY event_seq').all(task.task_id)
    const checkpoints = events.map(row => JSON.parse(row.data_json).providerCheckpoint).filter(Boolean)
    const checkpoint = checkpoints.at(-1)
    assert.equal(checkpoint?.phase, 'submitted')
    assert.equal(typeof checkpoint.remoteTaskId, 'string')
    assert(checkpoint.remoteTaskId.length > 0)
    const failureText = events.filter(row => row.type === 'failed').map(row => row.data_json).join('\n')
    const errorDiagnostics = { httpStatusCodes: [...new Set((failureText.match(/\b(?:400|401|402|403|404|408|409|429|500|502|503|504)\b/gu) || []).map(Number))],
      notFound: /not found|不存在|找不到/iu.test(failureText), queueFull: /队列.*满|queue.*full/iu.test(failureText) }
    return { task, checkpoint, checkpointCount: checkpoints.length, errorDiagnostics }
  } finally { db.close() }
}

async function readSecret() {
  return new Promise((resolve, reject) => {
    let value = ''
    const raw = Boolean(process.stdin.isTTY && process.stdin.setRawMode)
    const finish = (error) => {
      process.stdin.off('data', onData)
      process.stdin.pause()
      if (raw) process.stdin.setRawMode(false)
      if (error) reject(error)
      else resolve(value.trim())
    }
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('operator_cancelled'))
        if (character === '\n' || character === '\r') return finish()
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else value += character
        if (value.length > 4096) return finish(new Error('credential_input_invalid'))
      }
    }
    if (raw) process.stdin.setRawMode(true)
    process.stdin.on('data', onData)
    process.stdin.resume()
  })
}

async function controller() {
  const before = snapshot()
  assert(['running', 'queued'].includes(before.task.status), 'original_task_not_resumable')
  const runRoot = path.join(root, '.test-temp', `mcp-video-recovery-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`)
  await fs.mkdir(runRoot)
  protectRunDirectory(runRoot)
  process.stdout.write('RECOVERY_KEY_STDIN_READY (no echo; query existing video only)\n')
  let secret = await readSecret()
  assert(secret.length > 10, 'credential_input_invalid')
  const executable = require('electron')
  const child = spawn(executable, [__filename, '--worker', runRoot], {
    cwd: path.join(root, 'pi-paper-desktop'), env: safeEnvironment(runRoot),
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  child.on('message', message => {
    if (message?.type === 'recovery-key-ready' && secret) {
      child.send({ type: 'recovery-key', secret })
      secret = ''
    }
  })
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const reportPath = path.join(runRoot, 'result.json')
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
  const evidencePath = path.join(root, 'docs/verification/2026-10-11-mcp-acceptance', `${path.basename(runRoot)}.json`)
  await fs.writeFile(evidencePath, JSON.stringify(report, null, 2))
  console.log(`Evidence: ${evidencePath}`)
  console.log(JSON.stringify(report))
  if (!report.success) process.exitCode = 1
}

async function worker() {
  const { app, BrowserWindow, dialog, protocol, safeStorage, utilityProcess } = require('electron')
  const runRoot = path.resolve(process.argv.at(-1))
  assert(path.dirname(runRoot) === path.join(root, '.test-temp') && path.basename(runRoot).startsWith('mcp-video-recovery-'))
  const profile = path.join(runRoot, 'VibePaper')
  app.setPath('userData', profile)
  const originalGetPath = app.getPath.bind(app)
  app.getPath = name => name === 'appData' ? runRoot : originalGetPath(name)
  protocol.registerSchemesAsPrivileged([{ scheme: 'vibe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
  protocol.registerSchemesAsPrivileged = () => {}
  let window, settings, configured = false, cleanupVerified = false
  let phase = 'preflight', guardedWorkerCalls = 0, blockedWorkerCalls = 0
  const before = snapshot()
  const report = { schemaVersion: 1, testType: 'recover-existing-approved-video-without-resubmission',
    sourceRun, startedAt: new Date().toISOString(), success: false, nativeCodexPopupAccepted: false,
    newGenerationRequested: false, credentialPassedToRenderer: false, rawTranscriptSaved: false }
  const fork = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (modulePath, ...args) => {
    const child = fork(modulePath, ...args)
    if (path.basename(modulePath) === 'generation-worker.cjs') {
      const postMessage = child.postMessage.bind(child)
      child.postMessage = message => {
        if (String(message?.method || '').startsWith('generate:')) {
          if (message.payload?.taskId !== before.task.task_id || message.payload?.remoteTaskId !== before.checkpoint.remoteTaskId
            || message.payload?.modality !== 'video') {
            blockedWorkerCalls++
            throw new Error('recovery_new_submission_blocked')
          }
          guardedWorkerCalls++
          if (guardedWorkerCalls > 1) throw new Error('recovery_duplicate_worker_blocked')
        }
        return postMessage(message)
      }
    }
    return child
  }
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  for (const method of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox']) {
    dialog[method] = () => { throw new Error('unexpected_native_dialog') }
  }
  app.on('browser-window-created', (_event, created) => { window = created })
  const evaluate = source => window.webContents.executeJavaScript(source)
  const waitFor = async (check, milliseconds = 90000) => {
    const deadline = Date.now() + milliseconds
    while (Date.now() < deadline) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('recovery_wait_timeout')
  }
  try {
    await fs.mkdir(profile)
    let secret = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('credential_input_timeout')), 30000)
      process.once('message', message => {
        clearTimeout(timeout)
        if (message?.type !== 'recovery-key' || typeof message.secret !== 'string') return reject(new Error('credential_input_invalid'))
        resolve(message.secret)
      })
      process.send({ type: 'recovery-key-ready' })
    })
    await app.whenReady()
    settings = require('../src/provider-settings.cjs').createProviderSettings({ directory: profile, safeStorage,
      catalog: () => require('../dist/pi-official-media.cjs').getOfficialProviderCatalog() })
    const catalog = await settings.snapshot()
    const provider = catalog.providers.find(entry => entry.id === 'agnes')
    await settings.save({ providerId: 'agnes', expectedRevision: provider.revision,
      enabledModelIds: [before.task.model_id], defaultModelIds: { video: before.task.model_id }, credentials: { apiKey: secret } })
    configured = true
    secret = ''
    await fs.writeFile(path.join(profile, 'recent-project.json'), JSON.stringify({ schemaVersion: 1, projectDirectory }))
    phase = 'original-main-task-recovery'
    require('../src/main.cjs')
    await waitFor(() => window && !window.webContents.isLoading() && evaluate("location.pathname === '/workspace' && Boolean(document.querySelector('[role=button]'))").catch(() => false))
    await evaluate("document.querySelector('[role=button]').click()")
    await waitFor(() => evaluate(`location.pathname === ${JSON.stringify(`/canvas/${before.task.canvas_id}`)}`).catch(() => false))
    await waitFor(() => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(snapshot().task.status), 17 * 60 * 1000)
    const after = snapshot()
    assert.equal(after.task.task_id, before.task.task_id)
    assert.equal(after.checkpoint.remoteTaskId, before.checkpoint.remoteTaskId)
    assert.equal(after.checkpointCount, before.checkpointCount)
    Object.assign(report, { taskStatus: after.task.status, taskErrorCode: after.task.error_code,
      errorDiagnostics: after.errorDiagnostics,
      taskCount: 1, originalTaskIdentityPreserved: true, originalRemoteIdentityPreserved: true,
      newProviderCheckpoints: after.checkpointCount - before.checkpointCount })
    if (after.task.status === 'succeeded') {
      phase = 'verify-original-node-output'
      const relative = after.task.output_path
      const outputPath = path.resolve(projectDirectory, '.vibepaper', relative)
      assert(!path.relative(path.join(projectDirectory, '.vibepaper'), outputPath).startsWith('..'))
      const bytes = await fs.readFile(outputPath)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      assert.equal(sha256, after.task.output_sha256)
      assert.equal(bytes.length, after.task.output_size_bytes)
      const selector = `.react-flow__node[data-id="${before.task.node_id}"] video`
      await waitFor(() => evaluate(`(() => { const v=document.querySelector(${JSON.stringify(selector)}); return Boolean(v && v.readyState>=2 && v.videoWidth>0 && v.currentSrc.includes('/tasks/')); })()`).catch(() => false))
      report.originalVideoNode = await evaluate(`(() => { const v=document.querySelector(${JSON.stringify(selector)});return {decoded:v.readyState>=2,width:v.videoWidth,height:v.videoHeight,duration:v.duration}; })()`)
      report.output = { sizeBytes: bytes.length, sha256 }
      bytes.fill(0)
      assert.equal(guardedWorkerCalls, 1)
      report.success = true
    }
  } catch (error) {
    report.errorCode = /^[A-Z0-9_]{1,100}$/u.test(error?.code || '') ? error.code
      : /^[a-z0-9_]{1,100}$/u.test(error?.message || '') ? error.message : 'recovery_qa_failed'
    report.failureLine = String(error?.stack || '').split(/\r?\n/u).map(line => line.match(/resume-mcp-submitted-video\.cjs:(\d+):\d+/u)?.[1]).find(Boolean) || null
  } finally {
    if (configured) {
      try {
        const current = await settings.snapshot()
        await settings.clear('agnes', { expectedRevision: current.providers.find(entry => entry.id === 'agnes').revision })
        cleanupVerified = !(await settings.snapshot()).providers.find(entry => entry.id === 'agnes').configured
      } catch { cleanupVerified = false }
    }
    Object.assign(report, { phase, guardedWorkerCalls, blockedWorkerCalls, credentialsCleared: cleanupVerified,
      completedAt: new Date().toISOString(), combinedRealCodexFullChainAccepted: false })
    await fs.writeFile(path.join(runRoot, 'result.json'), JSON.stringify(report, null, 2))
    app.quit()
  }
}

if (process.argv.includes('--worker')) worker().catch(() => { require('electron').app.exit(1) })
else controller().catch(() => { console.error('RECOVERY_QA_FAILED'); process.exitCode = 1 })
