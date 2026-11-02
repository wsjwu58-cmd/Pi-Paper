const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const MAX_BYTES = 16 * 1024 * 1024
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/u
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u
const TYPES = new Set(['template', 'asset', 'preset', 'skill'])
const { EDGE_COMPATIBLE_TARGET_TYPES } = require('./canvas-edge-types.cjs')
const NODE_TYPES = new Set(Object.keys(EDGE_COMPATIBLE_TARGET_TYPES))
const CATEGORIES = new Set(['general', 'image', 'video', 'text', 'canvas'])
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const invalid = () => { throw new Error('MARKETPLACE_PACKAGE_INVALID') }
function text(v, max, required = true) {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) invalid()
  return v
}
function id(v) {
  if (typeof v !== 'string' || !ID.test(v) || ['constructor', 'prototype', '__proto__'].includes(v)) invalid()
  return v
}
function keys(value, allowed) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid()
}
function portableParams(params, nodeType) {
  const textKeys = ['content', 'prompt', 'title', 'style', 'camera']
  const specificationKeys = ['model', 'aspect', 'ratio', 'size', 'resolution', 'resKey', 'duration', 'count', 'generate_audio']
  keys(params, [...textKeys, ...specificationKeys])
  for (const [key, value] of Object.entries(params)) {
    if (textKeys.includes(key)) {
      text(value, 20_000, false)
      if (/(?:https?|file|vibe):\/\/|(?:[a-z]:\\|\/(?:Users|home|private|tmp)\/)/iu.test(value)) invalid()
      continue
    }
    if (!['image', 'video'].includes(nodeType)) invalid()
    if (['model', 'aspect', 'ratio', 'size', 'resolution', 'resKey'].includes(key)) {
      if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:/+-]{0,255}$/iu.test(value) || value.includes('://')) invalid()
    } else if (key === 'duration') {
      if (nodeType !== 'video' || typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 600) invalid()
    } else if (key === 'count') {
      if (nodeType !== 'image' || !Number.isSafeInteger(value) || value < 1 || value > 4) invalid()
    } else if (key === 'generate_audio' && (nodeType !== 'video' || typeof value !== 'boolean')) invalid()
  }
}
function validateComponent(component) {
  keys(component, ['id', 'type', 'name', 'description', 'data'])
  id(component.id); text(component.name, 64); text(component.description, 1024, false)
  if (!TYPES.has(component.type)) invalid()
  const data = component.data
  if (component.type === 'template') {
    keys(data, ['nodes', 'edges'])
    if (!Array.isArray(data.nodes) || data.nodes.length < 1 || data.nodes.length > 20
      || !Array.isArray(data.edges) || data.edges.length > 100) invalid()
    const ids = new Set()
    for (const node of data.nodes) {
      keys(node, ['id', 'type', 'x', 'y', 'params'])
      id(node.id)
      if (ids.has(node.id) || !NODE_TYPES.has(node.type) || !Number.isFinite(node.x) || !Number.isFinite(node.y)
        || Math.abs(node.x) > 100_000 || Math.abs(node.y) > 100_000 || !record(node.params)) invalid()
      portableParams(node.params, node.type); ids.add(node.id)
    }
    const pairs = new Set()
    const adjacency = new Map(data.nodes.map((node) => [node.id, []]))
    for (const edge of data.edges) {
      keys(edge, ['source', 'target', 'sourcePort', 'targetPort'])
      if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) invalid()
      const source = data.nodes.find((node) => node.id === edge.source)
      const target = data.nodes.find((node) => node.id === edge.target)
      if (!EDGE_COMPATIBLE_TARGET_TYPES[source.type].has(target.type)) invalid()
      const pair = `${edge.source}\0${edge.target}`
      if (pairs.has(pair)) invalid()
      pairs.add(pair); adjacency.get(edge.source).push(edge.target)
      if (edge.sourcePort !== undefined) text(edge.sourcePort, 80)
      if (edge.targetPort !== undefined) text(edge.targetPort, 80)
    }
    const visited = new Set(), visiting = new Set()
    function visit(node) {
      if (visiting.has(node)) invalid()
      if (visited.has(node)) return
      visiting.add(node)
      for (const next of adjacency.get(node)) visit(next)
      visiting.delete(node); visited.add(node)
    }
    for (const node of ids) visit(node)
  } else if (component.type === 'asset') {
    keys(data, ['kind', 'mime', 'base64'])
    if (data.kind !== 'image' || data.mime !== 'image/png' || typeof data.base64 !== 'string'
      || data.base64.length < 32 || data.base64.length > 6 * 1024 * 1024
      || data.base64.length % 4 || /[^A-Za-z0-9+/=]/u.test(data.base64)) invalid()
    const bytes = Buffer.from(data.base64, 'base64')
    if (bytes.toString('base64') !== data.base64 || bytes.length < 33
      || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid()
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    if (!width || !height || width > 4096 || height > 4096 || width * height > 16_000_000) invalid()
  } else if (component.type === 'preset') {
    keys(data, ['nodeType', 'params'])
    if (!['text', 'image', 'video', 'audio'].includes(data.nodeType) || !record(data.params)) invalid()
    portableParams(data.params, data.nodeType)
  } else {
    keys(data, ['category', 'instructions'])
    if (!CATEGORIES.has(data.category)) invalid()
    text(data.instructions, 200_000)
  }
  return component
}
function validatePackage(manifest) {
  keys(manifest, ['schemaVersion', 'id', 'name', 'description', 'version', 'author', 'components'])
  if (manifest.schemaVersion !== 1) invalid()
  id(manifest.id); text(manifest.name, 64); text(manifest.description, 1024, false); text(manifest.author, 100)
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) invalid()
  if (!Array.isArray(manifest.components) || manifest.components.length < 1 || manifest.components.length > 100) invalid()
  const ids = new Set()
  for (const component of manifest.components) {
    validateComponent(component)
    if (ids.has(component.id)) invalid()
    ids.add(component.id)
  }
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_BYTES / 2) invalid()
  return manifest
}
async function safeDir(directory, create = false) {
  let info = await fs.lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
  if (!info && create) { await fs.mkdir(directory, { mode: 0o700 }); info = await fs.lstat(directory) }
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error('MARKETPLACE_STORAGE_INVALID')
  return true
}
async function statePath(projectDirectory, create = false) {
  const root = await fs.realpath(path.resolve(projectDirectory))
  let directory = root
  for (const name of ['.vibepaper', 'agent', 'skills', '.marketplace']) {
    directory = path.join(directory, name)
    if (!await safeDir(directory, create && name !== '.vibepaper')) return null
  }
  return path.join(directory, 'state.json')
}
async function readJson(file, fallback) {
  if (!file) return fallback
  const info = await fs.lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return fallback
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('MARKETPLACE_STORAGE_INVALID')
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { throw new Error('MARKETPLACE_STORAGE_INVALID') }
}
async function writeJson(file, value) {
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) throw new Error('MARKETPLACE_STORAGE_TOO_LARGE')
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(encoded, 'utf8'); await handle.sync(); await handle.close(); handle = null
    await fs.rename(temporary, file)
  } finally { await handle?.close().catch(() => {}); await fs.rm(temporary, { force: true }).catch(() => {}) }
}
function validateSnapshot(snapshot, allowPrevious = true) {
  keys(snapshot, allowPrevious ? ['manifest', 'source', 'components', 'previous'] : ['manifest', 'source', 'components'])
  validatePackage(snapshot.manifest)
  if (!['builtin', 'local'].includes(snapshot.source) || !Array.isArray(snapshot.components)) invalid()
  const seen = new Set()
  for (const item of snapshot.components) {
    keys(item, ['id', 'enabled']); id(item.id)
    if (typeof item.enabled !== 'boolean' || seen.has(item.id) || !snapshot.manifest.components.some((c) => c.id === item.id)) invalid()
    seen.add(item.id)
  }
  if (snapshot.previous !== null && snapshot.previous !== undefined) {
    if (!allowPrevious) invalid()
    validateSnapshot(snapshot.previous, false)
    if (snapshot.previous.manifest.id !== snapshot.manifest.id) invalid()
  }
  return snapshot
}
async function readState(projectDirectory) {
  const state = await readJson(await statePath(projectDirectory), { schemaVersion: 1, packages: [] })
  if (!record(state) || state.schemaVersion !== 1 || !Array.isArray(state.packages) || state.packages.length > 100) throw new Error('MARKETPLACE_STORAGE_INVALID')
  if (state.retiredSkillIds !== undefined && (!Array.isArray(state.retiredSkillIds) || state.retiredSkillIds.length > 2000
    || state.retiredSkillIds.some((value) => typeof value !== 'string' || !/^market-[a-f0-9]{24}$/u.test(value)))) throw new Error('MARKETPLACE_STORAGE_INVALID')
  const seen = new Set()
  for (const item of state.packages) {
    validateSnapshot(item)
    if (seen.has(item.manifest.id)) throw new Error('MARKETPLACE_STORAGE_INVALID')
    seen.add(item.manifest.id)
  }
  return state
}
async function writeState(projectDirectory, state) {
  await writeJson(await statePath(projectDirectory, true), state)
}
function marketplaceSkillId(packageId, componentId) {
  return `market-${crypto.createHash('sha256').update(`${packageId}\0${componentId}`).digest('hex').slice(0, 24)}`
}
async function listMarketplaceSkills(projectDirectory) {
  const state = await readState(projectDirectory)
  return state.packages.flatMap((entry) => entry.components.flatMap((installed) => {
    const component = entry.manifest.components.find((item) => item.id === installed.id)
    if (component?.type !== 'skill') return []
    const skillId = marketplaceSkillId(entry.manifest.id, component.id)
    return [{ id: skillId, key: skillId, name: component.name, description: component.description,
      instructions: component.data.instructions, source: 'project', category: component.data.category,
      version: 1, enabled: installed.enabled }]
  }))
}
async function listMarketplaceSkillIds(projectDirectory) {
  const state = await readState(projectDirectory)
  const ids = new Set(state.retiredSkillIds ?? [])
  for (const entry of state.packages) for (const snapshot of [entry, entry.previous]) {
    for (const component of snapshot?.manifest.components ?? []) {
      if (component.type === 'skill') ids.add(marketplaceSkillId(snapshot.manifest.id, component.id))
    }
  }
  return ids
}
module.exports = { MAX_BYTES, id, validatePackage, validateComponent, validateSnapshot, readJson, writeJson, readState, writeState, listMarketplaceSkills, listMarketplaceSkillIds, marketplaceSkillId }
