const assert = require('node:assert/strict')
const test = require('node:test')
const { createProviderNetworkProbe } = require('../src/provider-network.cjs')

const catalog = () => ({ providers: [{ id: 'openai', baseUrl: 'https://api.openai.com/v1' }] })

test('provider probes use the injected system transport and preserve authentication and cancellation', async () => {
  const signal = new AbortController().signal
  const calls = []
  const run = createProviderNetworkProbe({
    catalog,
    probe: (id, options) => options.fetch('https://api.openai.com/v1/models', {
      method: 'GET', headers: { Authorization: `Bearer ${options.apiKey}` }, signal,
    }),
    fetch: async (url, init) => { calls.push({ url, init }); return { status: 401 } },
  })
  assert.equal((await run('openai', { apiKey: 'fixture-key' })).status, 401)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer fixture-key')
  assert.equal(calls[0].init.signal, signal)
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.credentials, 'omit')
  assert.equal(calls[0].init.bypassCustomProtocolHandlers, true)
})

test('injecting a transport does not bypass official HTTPS origin restrictions', async () => {
  let calls = 0
  for (const url of ['http://api.openai.com/v1/models', 'https://example.com/v1/models',
    'https://api.openai.com:8443/v1/models', 'https://user:secret@api.openai.com/v1/models',
    'file:///private', 'https://api.openai.com/v1/models#secret']) {
    const run = createProviderNetworkProbe({
      catalog, probe: (id, options) => options.fetch(url), fetch: async () => { calls++; return {} },
    })
    await assert.rejects(run('openai', {}), { code: 'PROVIDER_ENDPOINT_INVALID' })
  }
  assert.equal(calls, 0)
})
