const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

const workerBundle = process.argv[2]
  ? path.resolve(process.argv[2], 'dist', 'agent-worker.cjs')
  : path.resolve(__dirname, '..', 'dist', 'agent-worker.cjs')

function workerSource(bundlePath) {
  return `
    const { parentPort } = require('node:worker_threads')
    process.parentPort = {
      on: (...args) => parentPort.on(...args),
      postMessage: (...args) => parentPort.postMessage(...args),
    }
    require(${JSON.stringify(bundlePath)})
  `
}

function request(worker, id, method, payload) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onWorkerError)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Agent Worker did not respond to ${method}.`))
    }, 10_000)
    const onMessage = (message) => {
      if (message?.id !== id) return
      cleanup()
      if (message.ok) resolve(message.result)
      else reject(new Error(message.error || `Agent Worker failed ${method}.`))
    }
    const onWorkerError = (error) => {
      cleanup()
      reject(error)
    }
    worker.on('message', onMessage)
    worker.on('error', onWorkerError)
    worker.postMessage({ id, method, payload })
  })
}

async function main() {
  await fs.access(workerBundle)
  const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-agent-worker-smoke-'))
  const dataDirectory = path.join(projectDirectory, '.vibepaper')
  const projectId = '1a7b3c2d-4e5f-4678-9abc-def012345678'
  let worker
  let opened = false
  try {
    await fs.mkdir(dataDirectory)
    await fs.writeFile(path.join(dataDirectory, 'project.json'), JSON.stringify({
      schemaVersion: 1,
      projectId,
      canvasId: '9f8e7d6c-5b4a-4321-9876-543210fedcba',
      name: 'Agent Worker Smoke',
      createdAt: new Date().toISOString(),
    }))

    worker = new Worker(workerSource(workerBundle), { eval: true })
    await request(worker, 1, 'agent:open', { projectDirectory })
    opened = true
    const created = await request(worker, 2, 'agent:create-skill', {
      projectId,
      draft: {
        name: 'Smoke Project Skill',
        description: 'Validate the bundled Pi Skill loader at runtime.',
        instructions: 'Use this skill to confirm the worker bundle can load project skills.',
        category: 'general',
      },
    })
    assert.equal(created.source, 'project')

    const listed = await request(worker, 3, 'agent:list-skills', { projectId })
    assert.ok(listed.items.some((skill) => skill.id === created.id && skill.name === created.name))

    const initialFragments = await request(worker, 4, 'agent:list-fragments', { projectId })
    assert.deepEqual(initialFragments, { items: [] })
    const sourceSession = await request(worker, 5, 'agent:create-session', { projectId, title: 'Fragment source' })
    const savedFragment = await request(worker, 6, 'agent:save-session-fragment', {
      projectId,
      sessionId: sourceSession.sessionId,
      title: 'Worker fragment smoke',
    })
    const fragmentsBeforeRestart = await request(worker, 7, 'agent:list-fragments', { projectId })
    assert.ok(fragmentsBeforeRestart.items.some((fragment) => fragment.id === savedFragment.fragmentId))
    const imported = await request(worker, 8, 'agent:import-fragment', {
      projectId,
      fragmentId: savedFragment.fragmentId,
      canvasId: '9f8e7d6c-5b4a-4321-9876-543210fedcba',
    })
    assert.notEqual(imported.sessionId, sourceSession.sessionId)

    await request(worker, 9, 'agent:close', {})
    opened = false
    await worker.terminate()
    worker = new Worker(workerSource(workerBundle), { eval: true })
    await request(worker, 10, 'agent:open', { projectDirectory })
    opened = true
    const fragmentsAfterRestart = await request(worker, 11, 'agent:list-fragments', { projectId })
    assert.ok(fragmentsAfterRestart.items.some((fragment) => fragment.id === savedFragment.fragmentId))
    const importedAfterRestart = await request(worker, 12, 'agent:import-fragment', {
      projectId,
      fragmentId: savedFragment.fragmentId,
      canvasId: '9f8e7d6c-5b4a-4321-9876-543210fedcba',
    })
    assert.notEqual(importedAfterRestart.sessionId, sourceSession.sessionId)
    assert.notEqual(importedAfterRestart.sessionId, imported.sessionId)
    const sessionsAfterRestart = await request(worker, 13, 'agent:list-sessions', { projectId })
    assert.ok(sessionsAfterRestart.some((session) => session.sessionId === importedAfterRestart.sessionId))
    console.log('Agent Worker bundle loaded a project Skill and saved/imported a project fragment across restart.')
  } finally {
    if (worker) {
      if (opened) await request(worker, 4, 'agent:close', {}).catch(() => undefined)
      await worker.terminate()
    }
    await fs.rm(projectDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
})
