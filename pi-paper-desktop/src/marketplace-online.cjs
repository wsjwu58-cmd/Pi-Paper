const https = require('node:https')
const crypto = require('node:crypto')
const path = require('node:path')
const { TextDecoder } = require('node:util')
const { MAX_BYTES, id, validatePackage, isSupportedComponentType, readJson, writeJson } = require('./marketplace-storage.cjs')

// These are application-owned constants, never supplied by the renderer or index.
const REPOSITORY = 'wsjwu58-cmd/Pi-Paper'
const BRANCH = 'feat/desktop-local-migration'
const INDEX_PATH = 'marketplace/index.json'
const MAX_INDEX_BYTES = 256 * 1024
const MAX_SKILL_BYTES = 200_000
const SHA = /^[a-f0-9]{40}$/u
const HASH = /^[a-f0-9]{64}$/u
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u
const decoder = new TextDecoder('utf-8', { fatal: true })
const invalid = () => { throw new Error('MARKETPLACE_ONLINE_INDEX_INVALID') }
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
function keys(value, allowed) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid()
}
function string(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid()
}
function version(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) invalid()
  return value.split('.').map(Number)
}
function compareVersions(a, b) {
  const left = version(a), right = version(b)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}
function isCompatible(entry, appVersion) {
  return entry.target.product === 'Pi-Paper' && ['package', 'pi-skill'].includes(entry.kind)
    && compareVersions(appVersion, entry.target.minVersion) >= 0 && compareVersions(appVersion, entry.target.maxVersion) <= 0
    && entry.components.every(isSupportedComponentType)
}
function validatePath(value, kind) {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9_./-]+$/u.test(value)
    || !value.startsWith('marketplace/') || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) invalid()
  if (kind === 'package' && (!value.startsWith('marketplace/packages/') || !value.endsWith('.json'))) invalid()
  if (kind === 'pi-skill' && (!value.startsWith('marketplace/skills/') || !value.endsWith('/SKILL.md'))) invalid()
}
function validateIndex(index) {
  keys(index, ['schemaVersion', 'entries'])
  if (index.schemaVersion !== 1 || !Array.isArray(index.entries) || index.entries.length > 100) invalid()
  const seen = new Set()
  for (const entry of index.entries) {
    keys(entry, ['id', 'version', 'name', 'description', 'author', 'kind', 'components', 'path', 'size', 'sha256', 'target'])
    try { id(entry.id) } catch { invalid() }
    version(entry.version); string(entry.name, 64); string(entry.description, 1024); string(entry.author, 100)
    if (seen.has(entry.id)) invalid()
    seen.add(entry.id)
    if (typeof entry.kind !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.kind)) invalid()
    if (!Array.isArray(entry.components) || !entry.components.length || entry.components.length > 100
      || new Set(entry.components).size !== entry.components.length || entry.components.some((type) => typeof type !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(type))
      || (entry.kind === 'pi-skill' && (entry.components.length !== 1 || entry.components[0] !== 'skill'))) invalid()
    validatePath(entry.path, entry.kind)
    if (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > (entry.kind === 'pi-skill' ? MAX_SKILL_BYTES : MAX_BYTES / 2)
      || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) invalid()
    keys(entry.target, ['product', 'minVersion', 'maxVersion'])
    string(entry.target.product, 64)
    if (compareVersions(entry.target.minVersion, entry.target.maxVersion) > 0) invalid()
  }
  return index
}
function decode(bytes, code) {
  try { return decoder.decode(bytes) } catch { throw new Error(code) }
}
function parseJson(bytes, code) {
  try { return JSON.parse(decode(bytes, code)) } catch { throw new Error(code) }
}

// No redirects, arbitrary hostnames, unbounded buffering or user-provided URLs.
function get(hostname, requestPath, limit) {
  return new Promise((resolve, reject) => {
    let finished = false
    let deadline
    const fail = () => {
      if (!finished) { finished = true; clearTimeout(deadline); reject(new Error('MARKETPLACE_ONLINE_NETWORK_ERROR')) }
    }
    const request = https.get({ hostname, path: requestPath, protocol: 'https:', method: 'GET',
      headers: { 'User-Agent': 'Pi-Paper-Marketplace', Accept: '*/*' }, timeout: 15000 }, (response) => {
      if (response.statusCode !== 200 || (response.headers['content-length'] !== undefined
        && (!/^\d+$/u.test(response.headers['content-length']) || Number(response.headers['content-length']) > limit))) {
        response.destroy(); fail(); return
      }
      let size = 0
      const chunks = []
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) { response.destroy(); request.destroy(); fail(); return }
        chunks.push(chunk)
      })
      response.on('error', fail)
      response.on('aborted', fail)
      response.on('end', () => { if (!finished) { finished = true; clearTimeout(deadline); resolve(Buffer.concat(chunks)) } })
    })
    deadline = setTimeout(() => { request.destroy(); fail() }, 15000)
    request.on('timeout', () => { request.destroy(); fail() })
    request.on('error', fail)
  })
}
function rawPath(commit, file) {
  return `/${REPOSITORY}/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`
}

// Parse Git's pkt-line ref advertisement rather than relying on the REST API's
// shared anonymous rate limit. The branch name and repository remain fixed.
function parseBranchRef(bytes) {
  let offset = 0
  let commit = null
  let service = false
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) invalid()
    const header = bytes.toString('ascii', offset, offset + 4)
    if (!/^[0-9a-f]{4}$/iu.test(header)) invalid()
    const size = Number.parseInt(header, 16)
    offset += 4
    if (size === 0) continue
    if (size < 4 || offset + size - 4 > bytes.length) invalid()
    const line = decode(bytes.subarray(offset, offset + size - 4), 'MARKETPLACE_ONLINE_INDEX_INVALID')
    offset += size - 4
    if (line === '# service=git-upload-pack\n') { service = true; continue }
    const record = /^([a-f0-9]{40}) ([^\u0000\n]+)(?:\u0000[^\n]*)?\n$/u.exec(line)
    if (record?.[2] === `refs/heads/${BRANCH}`) {
      if (commit !== null) invalid()
      commit = record[1]
    }
  }
  if (!service || !commit) invalid()
  return commit
}

// Only SKILL.md frontmatter and body are imported. No supporting files, code,
// package manager hooks or permission declarations become part of the package.
function importStandaloneSkill(bytes, parseFrontmatter, identity) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_SKILL_BYTES) throw new Error('MARKETPLACE_SKILL_INVALID')
  const content = decode(bytes, 'MARKETPLACE_SKILL_INVALID')
  if (!/^\ufeff?---\r?\n/u.test(content)) throw new Error('MARKETPLACE_SKILL_INVALID')
  let parsed
  try { parsed = parseFrontmatter(content) } catch { throw new Error('MARKETPLACE_SKILL_INVALID') }
  const front = parsed?.frontmatter
  const body = parsed?.body
  if (!isRecord(front) || typeof front.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(front.name)
    || front.name.length > 64 || typeof front.description !== 'string' || !front.description.trim()
    || front.description.length > 1024 || typeof body !== 'string' || !body.trim() || body.length > 200_000
    || Object.keys(front).some((key) => !['name', 'description', 'license', 'metadata'].includes(key))
    || (front.license !== undefined && typeof front.license !== 'string')) throw new Error('MARKETPLACE_SKILL_UNSUPPORTED')
  // Reject common external-resource references instead of silently importing an incomplete skill.
  // This cannot prove arbitrary prose has no dependencies; the preview remains authoritative.
  if (/\]\(\s*(?!https?:\/\/|mailto:|#)[^)]*\)/iu.test(body)
    || /(?:^|[\s`"'(])(?:\.\.?\/|(?:scripts|references|assets)\/)[^\s`"')]+/imu.test(body)
    || /(?:file:\/\/|[a-z]:\\|~\/|\/(?:Users|home|private|tmp|etc|opt|var)\/)/iu.test(body)
    || /\b(?:npm|npx|pnpm|yarn)\s+(?:install|exec|run|add|dlx)\b/iu.test(body)) throw new Error('MARKETPLACE_SKILL_DEPENDENCIES_UNSUPPORTED')
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex')
  const manifest = {
    schemaVersion: 1, id: identity?.id ?? `pi-skill-${checksum.slice(0, 24)}`, version: identity?.version ?? '1.0.0',
    name: front.name, description: front.description.trim(), author: identity?.author ?? 'Pi Skill',
    components: [{ id: 'skill', type: 'skill', name: front.name, description: front.description.trim(), data: { category: 'general', instructions: body.trim() } }],
  }
  validatePackage(manifest)
  return manifest
}

function createOnlineCatalog(userDataDirectory, { appVersion, importPackage, parseFrontmatter, request = get } = {}) {
  version(appVersion)
  const cachePath = path.join(userDataDirectory, 'marketplace-online-index.json')
  let refreshQueue = Promise.resolve()
  async function readCache() {
    const cache = await readJson(cachePath, null)
    if (cache === null) return null
    if (!isRecord(cache) || Object.keys(cache).some((key) => !['schemaVersion', 'commit', 'index'].includes(key))
      || cache.schemaVersion !== 1 || typeof cache.commit !== 'string' || !SHA.test(cache.commit)) invalid()
    validateIndex(cache.index)
    return cache
  }
  const view = (cache) => cache && ({ commit: cache.commit, repository: REPOSITORY, branch: BRANCH,
    entries: cache.index.entries.map((entry) => ({ ...entry, compatible: isCompatible(entry, appVersion), unsupportedKind: !['package', 'pi-skill'].includes(entry.kind), unsupportedComponents: entry.components.filter((type) => !isSupportedComponentType(type)) })) })
  async function refresh() {
    const commit = parseBranchRef(await request('github.com', `/${REPOSITORY}.git/info/refs?service=git-upload-pack`, 1024 * 1024))
    const index = validateIndex(parseJson(await request('raw.githubusercontent.com', rawPath(commit, INDEX_PATH), MAX_INDEX_BYTES), 'MARKETPLACE_ONLINE_INDEX_INVALID'))
    const cache = { schemaVersion: 1, commit, index }
    await writeJson(cachePath, cache)
    return view(cache)
  }
  async function download(packageId, expectedCommit) {
    const cache = await readCache()
    if (!cache || cache.commit !== expectedCommit) throw new Error('MARKETPLACE_ONLINE_INDEX_CHANGED')
    const entry = cache.index.entries.find((item) => item.id === packageId)
    if (!entry) throw new Error('MARKETPLACE_PACKAGE_NOT_FOUND')
    if (!isCompatible(entry, appVersion)) throw new Error('MARKETPLACE_ONLINE_INCOMPATIBLE')
    const bytes = await request('raw.githubusercontent.com', rawPath(cache.commit, entry.path), entry.size)
    if (bytes.length !== entry.size || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('MARKETPLACE_ONLINE_INTEGRITY')
    const manifest = entry.kind === 'package'
      ? validatePackage(parseJson(bytes, 'MARKETPLACE_PACKAGE_INVALID'))
      : importStandaloneSkill(bytes, parseFrontmatter, entry)
    if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.name !== entry.name
      || manifest.description !== entry.description || manifest.author !== entry.author
      || JSON.stringify([...new Set(manifest.components.map((component) => component.type))].sort()) !== JSON.stringify([...entry.components].sort())) {
      throw new Error('MARKETPLACE_ONLINE_INTEGRITY')
    }
    return importPackage(manifest, { source: 'online', commit: cache.commit, sha256: entry.sha256, path: entry.path })
  }
  return {
    cached: async () => view(await readCache()),
    refresh: () => { const result = refreshQueue.then(refresh, refresh); refreshQueue = result.catch(() => {}); return result },
    download,
  }
}
module.exports = { REPOSITORY, BRANCH, INDEX_PATH, MAX_INDEX_BYTES, MAX_SKILL_BYTES, createOnlineCatalog, importStandaloneSkill, validateIndex, isCompatible, parseBranchRef, requestBytes: get }
