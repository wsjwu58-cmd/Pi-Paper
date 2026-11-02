// Explicit live acceptance: downloads only catalog-listed resources into an isolated temp directory.
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { createOnlineCatalog } = require('../src/marketplace-online.cjs')
const { parseFrontmatter } = require('../src/project-agent-skills.cjs')

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibepaper-online-acceptance-'))
  try {
    const service = createMarketplaceService(directory)
    const options = { appVersion: require('../package.json').version, importPackage: service.importPackage, parseFrontmatter }
    const catalog = createOnlineCatalog(directory, options)
    assert.equal(await catalog.cached(), null)
    const listing = await catalog.refresh()
    const imported = []
    const skipped = listing.entries.filter((entry) => !entry.compatible).map((entry) => entry.id)
    for (const entry of listing.entries.filter((entry) => entry.compatible)) {
      const item = await catalog.download(entry.id, listing.commit)
      assert.equal(item.source, 'online')
      assert.equal(item.origin.commit, listing.commit)
      imported.push({ id: item.id, version: item.version, kind: entry.kind, sha256: item.origin.sha256, size: entry.size })
    }
    assert.ok(imported.some((entry) => entry.kind === 'package'))
    assert.ok(imported.some((entry) => entry.kind === 'pi-skill'))
    const offline = createOnlineCatalog(directory, { ...options, request: async () => { throw new Error('offline') } })
    assert.deepEqual(await offline.cached(), listing)
    const offlinePackages = await createMarketplaceService(directory).list()
    for (const entry of imported) assert.ok(offlinePackages.some((item) => item.id === entry.id && item.source === 'online'))
    console.log(JSON.stringify({ repository: listing.repository, branch: listing.branch, commit: listing.commit, imported, skipped, offlineCached: true, offlineImported: true }, null, 2))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1 })
