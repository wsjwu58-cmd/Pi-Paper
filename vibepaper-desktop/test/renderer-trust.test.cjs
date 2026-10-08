const assert = require('node:assert/strict')
const test = require('node:test')
const { isDesktopRendererRoute, isTrustedRendererUrl } = require('../src/renderer-trust.cjs')

test('production navigation retains IPC trust on the original desktop SPA routes', () => {
  for (const route of ['/', '/workspace', '/history', '/canvas/01a0f505-2f16-7f7e-a243-fc56afba5d47']) {
    assert.equal(isDesktopRendererRoute(route), true)
    assert.equal(isTrustedRendererUrl(`vibe://app${route}`), true)
  }
})

test('assets, arbitrary routes, credentials and other origins never gain renderer IPC trust', () => {
  for (const url of ['vibe://app/assets/image.png', 'vibe://app/tasks/id/output',
    'vibe://app/admin', 'vibe://app/canvas/id/more', 'vibe://app/canvas/a%2fb',
    'vibe://app/workspace?external=1', 'vibe://app/history#fragment', 'vibe://user@app/',
    'vibe://other/workspace', 'file:///workspace', 'https://app/workspace', 'not a URL']) {
    assert.equal(isTrustedRendererUrl(url), false, url)
  }
})

test('development renderer retains its configured origin boundary', () => {
  const origin = 'http://127.0.0.1:5173'
  assert.equal(isTrustedRendererUrl(`${origin}/workspace`, origin), true)
  assert.equal(isTrustedRendererUrl(`${origin}/canvas/local-id`, origin), true)
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:5174/workspace', origin), false)
  assert.equal(isTrustedRendererUrl('https://example.com/workspace', origin), false)
})
