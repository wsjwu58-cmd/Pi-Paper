// Process-boundary client only. Tool schemas and business behavior live in the
// original TypeScript Agent service under pi-main/packages/vibepaper-agent-service.
const AGENT_CORE_METHODS = Object.freeze([
  'agent:core:load-canvas',
  'agent:core:create-node',
  'agent:core:update-node',
  'agent:core:connect-edge',
  'agent:core:save-canvas',
  'agent:core:get-task',
  'agent:core:list-assets',
  'agent:core:list-models',
  // Reached only through the original TypeScript Agent gateway after its
  // persisted approval token has been validated in the Agent Worker.
  'agent:core:create-generation-task',
])
const ALLOWED_AGENT_CORE_METHODS = new Set(AGENT_CORE_METHODS)

function createAgentLocalToolClient(parentPort, timeoutMs = 30_000) {
  const pending = new Map()
  let nextRequestId = 1
  let closed = false

  const onMessage = (event) => {
    const message = event?.data ?? event
    if (message?.kind !== 'agent-local-core-response' || typeof message.requestId !== 'string') return
    const request = pending.get(message.requestId)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.requestId)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(typeof message.errorCode === 'string' ? message.errorCode : 'AGENT_LOCAL_CORE_FAILED'))
  }
  parentPort.on('message', onMessage)

  return {
    request(method, payload, requestTimeoutMs = timeoutMs) {
      if (closed) return Promise.reject(new Error('AGENT_LOCAL_CORE_CLIENT_CLOSED'))
      if (!ALLOWED_AGENT_CORE_METHODS.has(method)) return Promise.reject(new Error('AGENT_LOCAL_CORE_METHOD_UNSUPPORTED'))
      const requestId = `agent-core-${nextRequestId++}`
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('AGENT_LOCAL_CORE_TIMEOUT'))
        }, requestTimeoutMs)
        pending.set(requestId, { resolve, reject, timer })
        try {
          parentPort.postMessage({ kind: 'agent-local-core-request', requestId, method, payload })
        } catch {
          clearTimeout(timer)
          pending.delete(requestId)
          reject(new Error('AGENT_LOCAL_CORE_UNAVAILABLE'))
        }
      })
    },
    close() {
      if (closed) return
      closed = true
      parentPort.removeListener?.('message', onMessage)
      for (const [requestId, request] of pending) {
        clearTimeout(request.timer)
        request.reject(new Error('AGENT_LOCAL_CORE_CLIENT_CLOSED'))
        pending.delete(requestId)
      }
    },
  }
}

module.exports = {
  AGENT_CORE_METHODS,
  ALLOWED_AGENT_CORE_METHODS,
  createAgentLocalToolClient,
}
