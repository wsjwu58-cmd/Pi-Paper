const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs/promises')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const test = require('node:test')
const { createMarketplaceService } = require('../src/marketplace.cjs')
const { createOnlineCatalog, importStandaloneSkill, parseBranchRef, requestBytes, validateIndex } = require('../src/marketplace-online.cjs')
const { listMarketplaceSkills } = require('../src/marketplace-storage.cjs')
const { parseFrontmatter } = require('../src/project-agent-skills.cjs')
const { registerMarketplaceIpc } = require('../src/marketplace-ipc.cjs')

const ROOT = path.resolve(__dirname, '../..')
const SHA = '8c61a80f695ed32e691cd01ee609c2a72cb1cf97'
const OTHER = '1'.repeat(40)
const copy = (value) => JSON.parse(JSON.stringify(value))
const pkt = (value) => { const content = Buffer.from(value); return Buffer.concat([Buffer.from((content.length + 4).toString(16).padStart(4, '0')), content]) }
const refs = (commit = SHA) => Buffer.concat([pkt('# service=git-upload-pack\n'), Buffer.from('0000'), pkt(`${commit} refs/heads/feat/desktop-local-migration\n`), Buffer.from('0000')])
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-online-test-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'project')
  const user = path.join(root, 'user')
  await fs.mkdir(path.join(project, '.vibepaper'), { recursive: true })
  await fs.mkdir(user)
  const index = JSON.parse(await fs.readFile(path.join(ROOT, 'marketplace/index.json'), 'utf8'))
  const files = new Map(await Promise.all(index.entries.map(async (entry) => [entry.path, await fs.readFile(path.join(ROOT, entry.path))])))
  const service = createMarketplaceService(user)
  const calls = []
  const network = async (host, url, limit) => {
    calls.push({ host, url, limit })
    if (host === 'github.com') return refs()
    const prefix = `/wsjwu58-cmd/Pi-Paper/${SHA}/`
    assert.equal(host, 'raw.githubusercontent.com')
    assert.ok(url.startsWith(prefix))
    const name = url.slice(prefix.length)
    const bytes = name === 'marketplace/index.json' ? Buffer.from(JSON.stringify(index)) : files.get(name)
    assert.ok(bytes, `unknown path ${name}`)
    assert.ok(bytes.length <= limit)
    return bytes
  }
  const options = { appVersion: '0.1.0', importPackage: service.importPackage, parseFrontmatter, request: network }
  return { root, project, user, index, files, service, calls, network, options, catalog: createOnlineCatalog(user, options) }
}

test('online refresh pins one commit, imports each verified kind, and persists usable offline state', async (t) => {
  const { catalog, service, project, user, calls, options } = await fixture(t)
  assert.equal(await catalog.cached(), null)
  assert.equal(calls.length, 0)
  const listing = await catalog.refresh()
  assert.equal(listing.commit, SHA)
  assert.equal(calls.length, 2)
  for (const entry of listing.entries) {
    const item = await catalog.download(entry.id, SHA)
    assert.equal(item.source, 'online')
    assert.equal(item.origin.commit, SHA)
    assert.equal(item.origin.sha256, entry.sha256)
    assert.equal(item.installed, false)
  }
  const downloaded = await service.list(project)
  const skill = downloaded.find((item) => item.id === 'pi-storyboard-brief')
  assert.equal(skill.components[0].type, 'skill')
  assert.equal((await listMarketplaceSkills(project)).length, 0)
  await service.install(project, skill.id, ['skill'])
  assert.equal((await listMarketplaceSkills(project))[0].name, 'storyboard-brief')
  const networkCalls = calls.length
  const offline = createOnlineCatalog(user, { ...options, request: async () => { throw Error('offline') } })
  assert.deepEqual(await offline.cached(), listing)
  await assert.rejects(offline.refresh(), /offline/)
  assert.deepEqual(await offline.cached(), listing)
  assert.equal(calls.length, networkCalls)
  const reopened = await createMarketplaceService(user).list(project)
  assert.ok(reopened.some((item) => item.id === 'scene-composition' && item.source === 'online'))
  assert.ok(reopened.some((item) => item.id === skill.id && item.installed && item.source === 'online'))
})

test('catalog rejects incompatible entries, stale views, tampered downloads and unsafe paths without import', async (t) => {
  const { catalog, service, files, index, calls, user, options } = await fixture(t)
  const listing = await catalog.refresh()
  await assert.rejects(catalog.download(listing.entries[0].id, OTHER), /MARKETPLACE_ONLINE_INDEX_CHANGED/)
  const incompatible = createOnlineCatalog(user, { ...options, appVersion: '0.2.0' })
  assert.equal((await incompatible.cached()).entries[0].compatible, false)
  const before = calls.length
  await assert.rejects(incompatible.download(listing.entries[0].id, SHA), /MARKETPLACE_ONLINE_INCOMPATIBLE/)
  assert.equal(calls.length, before)
  const first = index.entries[0]
  const correct = files.get(first.path)
  const altered = Buffer.from(correct)
  altered[altered.length - 2] ^= 1
  files.set(first.path, altered)
  await assert.rejects(catalog.download(first.id, SHA), /MARKETPLACE_ONLINE_INTEGRITY/)
  assert.equal((await service.list()).some((item) => item.id === first.id), false)
  files.set(first.path, correct.subarray(1))
  await assert.rejects(catalog.download(first.id, SHA), /MARKETPLACE_ONLINE_INTEGRITY/)
  for (const unsafe of ['marketplace/packages/../steal.json', 'https://example.com/evil.json', 'marketplace/packages/%2e%2e/evil.json']) {
    const data = copy(index); data.entries[0].path = unsafe
    assert.throws(() => validateIndex(data), /MARKETPLACE_ONLINE_INDEX_INVALID/)
  }
  const duplicate = copy(index); duplicate.entries.push(copy(index.entries[0]))
  assert.throws(() => validateIndex(duplicate), /MARKETPLACE_ONLINE_INDEX_INVALID/)
})

test('supported component types share the local validator; future types disable only their own listing', async (t) => {
  const { catalog, index, calls } = await fixture(t)
  const supported = copy(index.entries[0])
  supported.id = 'supported-many-types'
  supported.components = ['template', 'asset', 'preset', 'skill', 'connector', 'director_scene', 'director_camera', 'director_motion', 'poster_layout', 'selection_command', 'storyboard', 'media_tool']
  const future = copy(index.entries[0])
  future.id = 'future-entry'
  future.components = ['preset', 'future_component']
  const futureKind = copy(index.entries[0])
  futureKind.id = 'future-format'
  futureKind.kind = 'future-format'
  const otherProduct = copy(index.entries[0])
  otherProduct.id = 'other-product'
  otherProduct.target.product = 'Another-App'
  index.entries.push(supported, future, futureKind, otherProduct)
  const listing = await catalog.refresh()
  assert.equal(listing.entries.find((entry) => entry.id === supported.id).compatible, true)
  const unknown = listing.entries.find((entry) => entry.id === future.id)
  assert.equal(unknown.compatible, false)
  assert.deepEqual(unknown.unsupportedComponents, ['future_component'])
  assert.equal(listing.entries.find((entry) => entry.id === futureKind.id).unsupportedKind, true)
  assert.equal(listing.entries.find((entry) => entry.id === otherProduct.id).compatible, false)
  assert.equal(listing.entries.find((entry) => entry.id === 'scene-composition').compatible, true)
  const before = calls.length
  await assert.rejects(catalog.download(future.id, SHA), /MARKETPLACE_ONLINE_INCOMPATIBLE/)
  assert.equal(calls.length, before)
})

test('Git packet parsing selects only the exact fixed branch and rejects malformed or duplicate refs', () => {
  assert.equal(parseBranchRef(refs()), SHA)
  assert.throws(() => parseBranchRef(Buffer.from('0005x')), /MARKETPLACE_ONLINE_INDEX_INVALID/)
  assert.throws(() => parseBranchRef(Buffer.concat([refs(), pkt(`${OTHER} refs/heads/feat/desktop-local-migration\n`)])), /MARKETPLACE_ONLINE_INDEX_INVALID/)
  assert.throws(() => parseBranchRef(Buffer.concat([pkt('# service=git-upload-pack\n'), pkt(`${SHA} refs/heads/other\n`)])), /MARKETPLACE_ONLINE_INDEX_INVALID/)
})

test('standalone Pi Skill preserves instructions but rejects resource dependencies and unsupported semantics', () => {
  const make = (body, extra = '') => Buffer.from(`---\nname: simple-skill\ndescription: Explain composition.\n${extra}---\n\n${body}\n`)
  const first = importStandaloneSkill(make('Discuss foreground and lighting.'), parseFrontmatter)
  assert.equal(first.components[0].data.instructions, 'Discuss foreground and lighting.')
  assert.equal(first.id, importStandaloneSkill(make('Discuss foreground and lighting.'), parseFrontmatter).id)
  for (const body of ['Read [details](references/more.md).', 'Run scripts/build.sh', 'Read /Users/alice/private.txt', 'Run npm install']) {
    assert.throws(() => importStandaloneSkill(make(body), parseFrontmatter), /MARKETPLACE_SKILL_DEPENDENCIES_UNSUPPORTED/)
  }
  assert.throws(() => importStandaloneSkill(make('Instructions', 'allowed-tools: Bash\n'), parseFrontmatter), /MARKETPLACE_SKILL_UNSUPPORTED/)
  assert.throws(() => importStandaloneSkill(Buffer.from('not frontmatter'), parseFrontmatter), /MARKETPLACE_SKILL_INVALID/)
})

test('standalone file IPC verifies the trusted sender and imports through the normal catalog', async (t) => {
  const { root, user } = await fixture(t)
  const file = path.join(root, 'SKILL.md')
  await fs.writeFile(file, '---\nname: local-composition\ndescription: Organize a scene.\n---\n\nChoose the focal point.\n')
  const handlers = new Map()
  registerMarketplaceIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
    assertTrustedSender: (event) => { if (!event.trusted) throw Error('UNTRUSTED') },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) }, window: () => null,
    userDataDirectory: user, tempDirectory: () => root, withProject: () => {}, importImage: () => {},
  })
  const handler = handlers.get('desktop:marketplace:import-skill')
  await assert.rejects(handler({ trusted: false }), /UNTRUSTED/)
  const result = await handler({ trusted: true })
  assert.equal(result.source, 'local')
  assert.equal(result.installed, false)
  assert.equal(result.components[0].data.instructions, 'Choose the focal point.')
})

test('streaming HTTP rejects redirects, advertised oversize, and bytes beyond the limit', async () => {
  const original = https.get
  try {
    const simulate = (status, headers, chunks) => {
      https.get = (_options, callback) => {
        const request = new EventEmitter()
        request.destroy = () => {}
        process.nextTick(() => {
          const response = new PassThrough()
          response.statusCode = status; response.headers = headers
          callback(response)
          for (const chunk of chunks) response.write(chunk)
          response.end()
        })
        return request
      }
      return requestBytes('github.com', '/test', 4)
    }
    assert.deepEqual(await simulate(200, { 'content-length': '4' }, [Buffer.from('test')]), Buffer.from('test'))
    await assert.rejects(simulate(302, {}, []), /MARKETPLACE_ONLINE_NETWORK_ERROR/)
    await assert.rejects(simulate(200, { 'content-length': '5' }, []), /MARKETPLACE_ONLINE_NETWORK_ERROR/)
    await assert.rejects(simulate(200, {}, [Buffer.from('123'), Buffer.from('45')]), /MARKETPLACE_ONLINE_NETWORK_ERROR/)
  } finally { https.get = original }
})

test('offline release verification checks every listed file and rejects corrupted or invalid content', async (t) => {
  const crypto = require('node:crypto')
  const { verifyOfflineCatalog } = require('../scripts/verify-marketplace-catalog-offline.cjs')
  const result = await verifyOfflineCatalog(ROOT)
  assert.ok(result.verified.some((entry) => entry.id === 'interview-two-camera'))
  assert.equal(result.cachedOffline, true)
  assert.equal(result.importedOffline, true)

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'marketplace-offline-negative-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.cp(path.join(ROOT, 'marketplace'), path.join(root, 'marketplace'), { recursive: true })
  const indexPath = path.join(root, 'marketplace/index.json')
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'))
  index.entries = index.entries.filter((item) => item.id !== 'pi-storyboard-brief')
  await fs.writeFile(indexPath, JSON.stringify(index))
  const reduced = await verifyOfflineCatalog(root)
  assert.deepEqual(reduced.verified.map((item) => item.id), index.entries.map((item) => item.id))
  const entry = index.entries.find((item) => item.id === 'interview-two-camera')
  const packagePath = path.join(root, entry.path)
  const original = await fs.readFile(packagePath)
  const damaged = Buffer.from(original)
  damaged[damaged.length - 1] ^= 1
  await fs.writeFile(packagePath, damaged)
  await assert.rejects(verifyOfflineCatalog(root), /MARKETPLACE_ONLINE_INTEGRITY/)

  // A matching checksum must not bypass the strict creative data validator.
  const malformed = JSON.parse(original.toString('utf8'))
  malformed.components[0].data.objects[0].script = 'run()'
  const bytes = Buffer.from(JSON.stringify(malformed))
  entry.size = bytes.length
  entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  await fs.writeFile(packagePath, bytes)
  await fs.writeFile(indexPath, JSON.stringify(index))
  await assert.rejects(verifyOfflineCatalog(root), /MARKETPLACE_PACKAGE_INVALID/)
})

test('online interview components install selectively and remain in a reopened project without a generation task', async (t) => {
  const { root, catalog, service } = await fixture(t)
  const { createLocalProjectStore } = require('../src/project-store.cjs')
  const store = createLocalProjectStore()
  try {
    const { project, directory } = await store.createProject(root, 'Interview')
    const listing = await catalog.refresh()
    const item = await catalog.download('interview-two-camera', listing.commit)
    assert.equal(item.installed, false)
    assert.deepEqual(item.components.map((part) => part.type), ['director_scene', 'director_camera', 'director_camera', 'director_motion'])
    await service.install(directory, item.id, ['interview-stage', 'left-view'])
    const partial = (await service.list(directory)).find((entry) => entry.id === item.id)
    assert.equal(partial.components.find((part) => part.id === 'interview-stage').installed, true)
    assert.equal(partial.components.find((part) => part.id === 'right-view').installed, false)
    await service.install(directory, item.id, ['right-view', 'orbit-between-views'])
    const scene = await service.getInstalledComponent(directory, item.id, 'interview-stage', 'director_scene')
    const left = await service.getInstalledComponent(directory, item.id, 'left-view', 'director_camera')
    const right = await service.getInstalledComponent(directory, item.id, 'right-view', 'director_camera')
    const motion = await service.getInstalledComponent(directory, item.id, 'orbit-between-views', 'director_motion')
    assert.deepEqual(motion.data.from, left.data)
    assert.deepEqual(motion.data.to, right.data)
    assert.notDeepEqual(left.data, right.data)
    const sceneObjects = scene.data.objects.map((object, index) => ({ ...object, id: `ds-fixture-${index}` }))
    const nodes = [{ id: 'stage', type: 'director', position: { x: 0, y: 0 }, data: { params: { sceneObjects, camera: left.data, motion: motion.data } } }]
    await store.saveCanvas({ projectId: project.projectId, canvasId: project.canvasId, expectedVersion: 0, nodes, edges: [], groups: [], stacks: [] })
    await service.setEnabled(directory, item.id, 'left-view', false)
    await service.uninstall(directory, item.id, 'interview-stage')
    await store.close()
    await store.openProject(directory)
    const loaded = store.loadCanvas(project.projectId, project.canvasId).nodes.find((node) => node.id === 'stage')
    assert.deepEqual(loaded.data.params.sceneObjects, sceneObjects)
    assert.deepEqual(loaded.data.params.camera, left.data)
    assert.deepEqual(loaded.data.params.motion, motion.data)
    assert.equal((await store.listTasks(project.projectId)).length, 0)
  } finally { await store.close() }
})
