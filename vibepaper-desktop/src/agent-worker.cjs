const { openDesktopAgentStores } = require('../../pi-main/packages/vibepaper-agent-service/src/desktop/agent-stores.ts')

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
  return sessions.map(({ id, createdAt, modifiedAt }) => ({ sessionId: id, createdAt, modifiedAt }))
}

async function dispatch(method, payload) {
  switch (method) {
    case 'agent:open': {
      if (!payload || typeof payload.projectDirectory !== 'string') throw new Error('AGENT_PROJECT_PATH_INVALID')
      if (stores) await stores.close()
      stores = await openDesktopAgentStores(payload.projectDirectory)
      return { projectId: stores.projectId }
    }
    case 'agent:list-sessions':
      return listSessions(payload?.projectId)
    case 'agent:create-session': {
      const current = await requireProject(payload?.projectId)
      const title = typeof payload.title === 'string' ? payload.title.trim().slice(0, 120) : ''
      const session = await current.sessions.createSession(title || undefined)
      return { sessionId: session.id, createdAt: session.createdAt }
    }
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
        error: error instanceof Error ? error.message : 'Agent 本地会话操作失败。',
      })
    }
  })
})
