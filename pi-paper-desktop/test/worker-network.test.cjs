const { test } = require('node:test')
const assert = require('node:assert/strict')
const { workerProxyEnvironment, initializeWorkerProxy } = require('../src/worker-network.cjs')

test('Chromium HTTP proxy takes precedence over inherited proxy settings', () => {
  const original = { HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:8', PATH: 'fixture' }
  const env = workerProxyEnvironment(original, 'PROXY 127.0.0.1:7890; DIRECT')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.https_proxy, undefined)
  assert.equal(env.PATH, original.PATH)
  assert.equal(original.https_proxy, 'http://127.0.0.1:8')
})
test('HTTPS proxy is supported and loopback bypasses the proxy', () => {
  const env = workerProxyEnvironment({ no_proxy: 'internal.example' }, 'HTTPS proxy.example:443')
  assert.equal(env.HTTPS_PROXY, 'https://proxy.example:443')
  for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'internal.example']) assert.ok(env.NO_PROXY.split(',').includes(host))
})
test('direct connection preserves explicit environment proxies', () => {
  assert.equal(workerProxyEnvironment({ HTTPS_PROXY: 'http://proxy.example:8080' }, 'DIRECT').HTTPS_PROXY, 'http://proxy.example:8080')
  let calls = 0
  assert.equal(initializeWorkerProxy({}, () => calls++), false)
  assert.equal(calls, 0)
})
test('Worker initializes native Node proxy with loopback exclusions', () => {
  let config
  assert.equal(initializeWorkerProxy({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, value => { config = value }), true)
  assert.equal(config.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.ok(config.NO_PROXY.includes('127.0.0.1'))
  assert.throws(() => initializeWorkerProxy({ HTTPS_PROXY: 'http://proxy.example:8080' }, null), /UNSUPPORTED/)
})
