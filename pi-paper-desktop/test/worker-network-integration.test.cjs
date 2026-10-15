const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const test = require('node:test')
const { initializeWorkerProxy, workerProxyEnvironment } = require('../src/worker-network.cjs')

test('submission, polling, download and native requests use the proxy while local models bypass it', { timeout: 10000 }, async t => {
  const calls = []
  const respond = (request, response) => {
    calls.push({ method: request.method, url: request.url })
    request.resume()
    if (request.url.endsWith('/output')) response.end(Buffer.from([1, 2, 3, 4]))
    else { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}') }
  }
  const proxy = http.createServer(respond)
  const upstream = http.createServer(respond)
  const tunnels = new Set()
  proxy.on('connect', (request, socket, head) => {
    if (request.url !== 'provider.invalid:80') { socket.destroy(); return }
    const target = net.connect(upstream.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) target.write(head)
      socket.pipe(target).pipe(socket)
    })
    tunnels.add(socket)
    tunnels.add(target)
    socket.on('error', () => target.destroy())
    target.on('error', () => socket.destroy())
  })
  const local = http.createServer((_request, response) => response.end('local-model'))
  await Promise.all([new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)), new Promise(resolve => local.listen(0, '127.0.0.1', resolve)), new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))])
  let restore
  t.after(async () => {
    restore?.()
    for (const socket of tunnels) socket.destroy()
    proxy.closeAllConnections()
    local.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => local.close(resolve)), new Promise(resolve => upstream.close(resolve))])
  })
  const env = workerProxyEnvironment({}, `PROXY 127.0.0.1:${proxy.address().port}`)
  initializeWorkerProxy(env, value => { restore = http.setGlobalProxyFromEnv(value) })
  assert.deepEqual(await (await fetch('http://provider.invalid/submit', { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) })).json(), { ok: true })
  assert.deepEqual(await (await fetch('http://provider.invalid/poll', { signal: AbortSignal.timeout(3000) })).json(), { ok: true })
  assert.deepEqual(Buffer.from(await (await fetch('http://provider.invalid/output', { signal: AbortSignal.timeout(3000) })).arrayBuffer()), Buffer.from([1, 2, 3, 4]))
  await new Promise((resolve, reject) => {
    const request = http.get('http://provider.invalid/native', { timeout: 3000 }, response => { response.resume(); response.on('end', resolve) })
    request.on('timeout', () => request.destroy(new Error('Native request timed out')))
    request.on('error', reject)
  })
  assert.deepEqual(calls.map(c => c.method), ['POST', 'GET', 'GET', 'GET'])
  assert.equal(await (await fetch(`http://127.0.0.1:${local.address().port}/v1/models`, { signal: AbortSignal.timeout(3000) })).text(), 'local-model')
  assert.equal(calls.length, 4)
})
