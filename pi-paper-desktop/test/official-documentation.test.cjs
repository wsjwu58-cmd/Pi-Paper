const assert = require('node:assert/strict')
const test = require('node:test')
const { isOfficialDocumentationUrl } = require('../src/official-documentation.cjs')
const docs = require('../../pi-paper-web/public/provider-documentation.json')

test('official documentation links allow only the shipped exact HTTPS URLs', () => {
  for (const url of Object.values(docs)) assert.equal(isOfficialDocumentationUrl(url, docs), true, url)
  for (const url of [
    'https://example.com/', 'https://platform.minimax.io/docs/unknown',
    'https://platform.minimax.io/docs?apiKey=secret', 'https://platform.minimax.io/docs#secret',
    'https://user:secret@platform.minimax.io/docs', 'https://platform.minimax.io:8443/docs',
    'http://platform.minimax.io/docs', 'file:///C:/private', 'javascript:alert(1)', '', null,
  ]) assert.equal(isOfficialDocumentationUrl(url, docs), false, String(url))
})
