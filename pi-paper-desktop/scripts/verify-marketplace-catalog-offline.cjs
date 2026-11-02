// Validate every checked-in catalog entry through the real download/import path,
// with an injected filesystem-only transport. No network request is made.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { TextDecoder } = require('node:util')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { BRANCH, MAX_INDEX_BYTES, REPOSITORY, createOnlineCatalog, isCompatible, validateIndex } = require('../src/marketplace-online.cjs')
const { parseFrontmatter } = require('../src/project-agent-skills.cjs')

const ROOT = path.resolve(__dirname, '../..')
// This is a fixture identity for exercising pinned reads; it is not a Git commit.
const FIXTURE_COMMIT = 'a'.repeat(40)
const pkt = (value) => {
  const bytes = Buffer.from(value)
  return Buffer.concat([Buffer.from((bytes.length + 4).toString(16).padStart(4, '0')), bytes])
}
const refs = () => Buffer.concat([
  pkt('# service=git-upload-pack\n'), Buffer.from('0000'),
  pkt(`${FIXTURE_COMMIT} refs/heads/${BRANCH}\n`), Buffer.from('0000'),
])

async function verifyOfflineCatalog(repoRoot = ROOT) {
  const root = await fs.realpath(repoRoot)
  async function readChecked(file, limit) {
    const resolved = path.join(root, file)
    assert.equal(await fs.realpath(resolved), resolved, `symlink or non-canonical path: ${file}`)
    const stat = await fs.lstat(resolved)
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `not a regular file: ${file}`)
    assert.ok(stat.size <= limit, `file exceeds declared limit: ${file}`)
    return fs.readFile(resolved)
  }
  const indexBytes = await readChecked('marketplace/index.json', MAX_INDEX_BYTES)
  const index = validateIndex(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(indexBytes)))
  assert.ok(index.entries.length > 0, 'catalog has no entries')
  const entriesByPath = new Map(index.entries.map((entry) => [entry.path, entry]))
  assert.equal(entriesByPath.size, index.entries.length, 'catalog paths must be unique')
  for (const entry of index.entries) {
    assert.ok(isCompatible(entry, entry.target.minVersion), `unsupported catalog entry: ${entry.id}`)
  }
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-catalog-offline-')))
  try {
    const service = createMarketplaceService(temporary)
    const calls = []
    const request = async (host, url, limit) => {
      calls.push({ host, url })
      if (host === 'github.com' && url === `/${REPOSITORY}.git/info/refs?service=git-upload-pack`) return refs()
      const prefix = `/${REPOSITORY}/${FIXTURE_COMMIT}/`
      assert.equal(host, 'raw.githubusercontent.com')
      assert.ok(url.startsWith(prefix), `unexpected fixture URL: ${url}`)
      const file = url.slice(prefix.length)
      if (file === 'marketplace/index.json') return indexBytes
      assert.ok(entriesByPath.has(file), `path is not listed: ${file}`)
      return readChecked(file, limit)
    }
    const options = { appVersion: index.entries[0].target.minVersion, importPackage: service.importPackage, parseFrontmatter, request }
    const listing = await createOnlineCatalog(temporary, options).refresh()
    const verified = []
    for (const entry of listing.entries) {
      const catalog = createOnlineCatalog(temporary, { ...options, appVersion: entry.target.minVersion })
      const imported = await catalog.download(entry.id, listing.commit)
      assert.equal(imported.source, 'online')
      assert.equal(imported.origin.commit, FIXTURE_COMMIT)
      assert.equal(imported.origin.sha256, entry.sha256)
      verified.push({ id: entry.id, version: entry.version, kind: entry.kind, components: entry.components, size: entry.size, sha256: entry.sha256 })
    }
    const offline = createOnlineCatalog(temporary, { ...options, request: async () => { throw new Error('network disabled') } })
    assert.deepEqual(await offline.cached(), listing)
    const reopened = await createMarketplaceService(temporary).list()
    for (const entry of verified) assert.ok(reopened.some((item) => item.id === entry.id && item.source === 'online'))
    assert.equal(calls.length, 2 + index.entries.length)
    return { verified, cachedOffline: true, importedOffline: true }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

if (require.main === module) {
  verifyOfflineCatalog().then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1 })
}
module.exports = { verifyOfflineCatalog }
