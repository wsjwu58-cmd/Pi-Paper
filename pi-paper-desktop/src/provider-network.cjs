function createProviderNetworkProbe({ catalog, probe, fetch }) {
  return async (providerId, options) => {
    const provider = catalog().providers.find((item) => item.id === providerId)
    if (!provider?.baseUrl) throw Object.assign(new Error('未知官方模型提供方。'), { code: 'PROVIDER_ENDPOINT_INVALID' })
    const allowedHosts = new Set([new URL(provider.baseUrl).hostname, ...(provider.allowedHosts || [])])
    function checkedUrl(value, base = false) {
      let url
      try { url = new URL(value) } catch { /* Reject without echoing input. */ }
      if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
        || base && url.search || !allowedHosts.has(url.hostname)) {
        throw Object.assign(new Error('请使用该厂商官方 HTTPS API 地址。'), { code: 'PROVIDER_ENDPOINT_INVALID' })
      }
      return url.href
    }
    checkedUrl(options.baseUrl || provider.baseUrl, true)
    return probe(providerId, {
      ...options,
      fetch: (input, init) => fetch(checkedUrl(input), {
        ...init,
        redirect: 'error',
        credentials: 'omit',
        bypassCustomProtocolHandlers: true,
      }),
    })
  }
}

module.exports = { createProviderNetworkProbe }
