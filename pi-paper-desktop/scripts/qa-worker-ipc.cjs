'use strict'

const INVALID = Symbol('invalid QA IPC message')
const QA_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function validGateMessage(message) {
  return hasExactKeys(message, ['type', 'approved'])
    && message.type === 'qa-operator-media-gate'
    && typeof message.approved === 'boolean'
}

function validConfirmationMessage(message) {
  return hasExactKeys(message, ['type', 'requestId', 'accept'])
    && message.type === 'qa-client-confirmation'
    && typeof message.requestId === 'string'
    && QA_REQUEST_ID.test(message.requestId)
    && typeof message.accept === 'boolean'
}

function validTimeout(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function createQaWorkerControl(processLike = process) {
  if (!processLike || typeof processLike.on !== 'function' || typeof processLike.removeListener !== 'function') {
    throw new TypeError('A process-like IPC event target is required')
  }

  const waiters = new Set()
  let disconnected = processLike.connected !== true
  let closed = false

  function settle(waiter, value) {
    if (waiter.settled) return
    waiter.settled = true
    waiters.delete(waiter)
    clearTimeout(waiter.timer)
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    waiter.resolve(value)
  }

  function disconnect() {
    if (disconnected) return
    disconnected = true
    for (const waiter of [...waiters]) settle(waiter, waiter.fallback)
  }

  function onMessage(message) {
    if (validGateMessage(message)) {
      for (const waiter of waiters) {
        if (waiter.type !== 'qa-operator-media-gate') continue
        const result = waiter.decode(message)
        if (result !== INVALID) { settle(waiter, result); return }
      }
      return
    }
    if (!validConfirmationMessage(message)) return
    for (const waiter of waiters) {
      if (waiter.type !== 'qa-client-confirmation') continue
      const result = waiter.decode(message)
      if (result !== INVALID) { settle(waiter, result); return }
    }
  }

  processLike.on('message', onMessage)
  processLike.on('disconnect', disconnect)

  function waitFor(type, decode, fallback, options = {}) {
    if (closed || disconnected || options.signal?.aborted) return Promise.resolve(fallback)

    const timeoutMs = validTimeout(options.timeoutMs, 120_000)
    return new Promise((resolve) => {
      const waiter = {
        type,
        decode,
        fallback,
        signal: options.signal,
        settled: false,
        resolve,
        timer: null,
        onAbort: null,
      }
      waiter.onAbort = () => settle(waiter, fallback)
      waiter.timer = setTimeout(() => settle(waiter, fallback), timeoutMs)
      waiters.add(waiter)
      if (waiter.signal) {
        waiter.signal.addEventListener('abort', waiter.onAbort, { once: true })
        if (waiter.signal.aborted) waiter.onAbort()
      }
    })
  }

  function waitForOperatorMediaGate(options = {}) {
    return waitFor('qa-operator-media-gate',
      (message) => validGateMessage(message) ? message.approved : INVALID, false, options)
  }

  function waitForClientConfirmation(requestId, options = {}) {
    const fallback = { answered: false, accepted: false }
    if (typeof requestId !== 'string' || !QA_REQUEST_ID.test(requestId)) return Promise.resolve(fallback)
    return waitFor('qa-client-confirmation', (message) => {
      if (!validConfirmationMessage(message) || message.requestId !== requestId) return INVALID
      return { answered: true, accepted: message.accept }
    }, fallback, options)
  }

  function close() {
    if (closed) return
    closed = true
    disconnect()
    processLike.removeListener('message', onMessage)
    processLike.removeListener('disconnect', disconnect)
  }

  return { waitForOperatorMediaGate, waitForClientConfirmation, close }
}

module.exports = { createQaWorkerControl, validGateMessage, validConfirmationMessage }
