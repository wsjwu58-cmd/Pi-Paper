function isDesktopRendererRoute(pathname) {
  return pathname === '/' || pathname === '/workspace' || pathname === '/history' || pathname === '/settings/providers'
    || /^\/canvas\/[A-Za-z0-9_-]{1,256}$/u.test(pathname)
}

function isTrustedRendererUrl(value, developmentUrl) {
  try {
    const candidate = new URL(value)
    if (candidate.username || candidate.password) return false
    if (developmentUrl) return candidate.origin === new URL(developmentUrl).origin
    return candidate.protocol === 'vibe:' && candidate.host === 'app'
      && isDesktopRendererRoute(candidate.pathname) && !candidate.search && !candidate.hash
  } catch {
    return false
  }
}

module.exports = { isDesktopRendererRoute, isTrustedRendererUrl }
