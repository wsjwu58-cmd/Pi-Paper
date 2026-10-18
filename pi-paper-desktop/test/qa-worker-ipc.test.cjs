'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const { createQaWorkerControl } = require('../scripts/qa-worker-ipc.cjs')

const requestId = 'f53c6bb8-3df0-44eb-a6be-c339cc6e0135'

function createFakeProcess() {
  const fakeProcess = new EventEmitter()
  fakeProcess.connected = true
  return fakeProcess
}

test('accepts only an exact boolean operator media gate message', async () => {
  const fakeProcess = createFakeProcess()
  const control = createQaWorkerControl(fakeProcess)
  const decision = control.waitForOperatorMediaGate({ timeoutMs: 100 })
  fakeProcess.emit('message', { type: 'qa-operator-media-gate', approved: 'true' })
  fakeProcess.emit('message', { type: 'qa-operator-media-gate', approved: true, scope: 'extra' })
  fakeProcess.emit('message', { type: 'qa-operator-media-gate', approved: true })
  assert.equal(await decision, true)
  control.close()
})

test('accepts a client form decision only for its exact request ID', async () => {
  const fakeProcess = createFakeProcess()
  const control = createQaWorkerControl(fakeProcess)
  const decision = control.waitForClientConfirmation(requestId, { timeoutMs: 100 })
  fakeProcess.emit('message', { type: 'qa-client-confirmation', requestId, accept: true, extra: 1 })
  fakeProcess.emit('message', { type: 'qa-client-confirmation', requestId: '00000000-0000-4000-8000-000000000000', accept: true })
  fakeProcess.emit('message', { type: 'qa-client-confirmation', requestId, accept: false })
  assert.deepEqual(await decision, { answered: true, accepted: false })
  control.close()
})

test('timeout, IPC disconnect, and abort all fail closed', async () => {
  const noChannelProcess = new EventEmitter()
  const noChannelControl = createQaWorkerControl(noChannelProcess)
  assert.equal(await noChannelControl.waitForOperatorMediaGate(), false)
  noChannelControl.close()
  const timeoutProcess = createFakeProcess()
  const timeoutControl = createQaWorkerControl(timeoutProcess)
  assert.equal(await timeoutControl.waitForOperatorMediaGate({ timeoutMs: 10 }), false)
  assert.deepEqual(await timeoutControl.waitForClientConfirmation(requestId, { timeoutMs: 10 }),
    { answered: false, accepted: false })
  timeoutControl.close()

  const disconnectedProcess = createFakeProcess()
  const disconnectedControl = createQaWorkerControl(disconnectedProcess)
  const pendingGate = disconnectedControl.waitForOperatorMediaGate({ timeoutMs: 1_000 })
  const pendingConfirmation = disconnectedControl.waitForClientConfirmation(requestId, { timeoutMs: 1_000 })
  disconnectedProcess.connected = false
  disconnectedProcess.emit('disconnect')
  assert.equal(await pendingGate, false)
  assert.deepEqual(await pendingConfirmation, { answered: false, accepted: false })
  disconnectedControl.close()

  const abortedProcess = createFakeProcess()
  const abortedControl = createQaWorkerControl(abortedProcess)
  const abortController = new AbortController()
  const pendingAfterAbort = abortedControl.waitForClientConfirmation(requestId, { signal: abortController.signal, timeoutMs: 1_000 })
  abortController.abort()
  assert.deepEqual(await pendingAfterAbort, { answered: false, accepted: false })
  abortedControl.close()
})

test('ignores malformed or unrelated IPC messages until the safe timeout', async () => {
  const fakeProcess = createFakeProcess()
  const control = createQaWorkerControl(fakeProcess)
  const decision = control.waitForClientConfirmation(requestId, { timeoutMs: 10 })
  fakeProcess.emit('message', null)
  fakeProcess.emit('message', { type: 'qa-operator-media-gate', approved: true })
  fakeProcess.emit('message', { type: 'qa-client-confirmation', requestId: 'not-a-uuid', accept: true })
  assert.deepEqual(await decision, { answered: false, accepted: false })
  control.close()
})
