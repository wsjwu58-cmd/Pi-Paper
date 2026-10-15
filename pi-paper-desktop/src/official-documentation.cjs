function isOfficialDocumentationUrl(value, documentation) {
  try {
    if (typeof value !== 'string') return false
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false
    return Object.values(documentation).some((entry) => new URL(entry).href === url.href)
  } catch {
    return false
  }
}

module.exports = { isOfficialDocumentationUrl }
