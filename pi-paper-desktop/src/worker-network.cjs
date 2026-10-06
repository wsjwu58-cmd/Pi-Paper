const http = require('node:http')

// Workers use Node fetch, which does not inherit Chromium's system proxy.
function workerProxyEnvironment(environment, chromiumProxy) {
  const env = { ...environment }
  const first = typeof chromiumProxy === 'string' ? chromiumProxy.split(';')[0].trim() : ''
  const match = /^(PROXY|HTTPS)\s+([^\s/@]+:\d+)$/u.exec(first)
  if (match) {
    const proxy = `${match[1] === 'HTTPS' ? 'https' : 'http'}://${match[2]}`
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
    delete env.http_proxy
    delete env.https_proxy
  }
  // Local model services must remain on loopback even when a proxy is enabled.
  env.NO_PROXY = [...new Set([
    ...(env.no_proxy || env.NO_PROXY || '').split(',').map(item => item.trim()).filter(Boolean),
    'localhost', '127.0.0.1', '::1', '[::1]',
  ])].join(',')
  delete env.no_proxy
  return env
}

function initializeWorkerProxy(environment = process.env, configure = http.setGlobalProxyFromEnv) {
  if (!(environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy)) return false
  if (typeof configure !== 'function') throw new Error('WORKER_PROXY_RUNTIME_UNSUPPORTED')
  const env = workerProxyEnvironment(environment)
  configure({
    HTTP_PROXY: env.http_proxy || env.HTTP_PROXY,
    HTTPS_PROXY: env.https_proxy || env.HTTPS_PROXY,
    NO_PROXY: env.NO_PROXY,
  })
  return true
}

module.exports = { workerProxyEnvironment, initializeWorkerProxy }
