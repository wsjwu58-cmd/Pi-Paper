const path = require('node:path')
const crypto = require('node:crypto')
const builtin = require('./marketplace-example.cjs')
const { id, validatePackage, readJson, writeJson, readState, writeState, marketplaceSkillId } = require('./marketplace-storage.cjs')

const clone = (value) => JSON.parse(JSON.stringify(value))
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
const statusFor = (entry, componentId) => entry?.components.find((item) => item.id === componentId)

function createMarketplaceService(userDataDirectory, options = {}) {
  const catalogPath = path.join(userDataDirectory, 'marketplace-catalog.json')
  validatePackage(builtin)
  let queue = Promise.resolve()
  const serial = (operation) => {
    const result = queue.then(operation, operation)
    queue = result.catch(() => {})
    return result
  }
  async function catalog() {
    const data = await readJson(catalogPath, { schemaVersion: 1, packages: [] })
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.packages) || data.packages.length > 100) throw new Error('MARKETPLACE_STORAGE_INVALID')
    const seen = new Set([builtin.id])
    for (const item of data.packages) {
      validatePackage(item)
      if (seen.has(item.id)) throw new Error('MARKETPLACE_STORAGE_INVALID')
      seen.add(item.id)
    }
    return data
  }
  async function listInternal(projectDirectory) {
    const data = await catalog()
    const state = projectDirectory ? await readState(projectDirectory) : { packages: [] }
    const choices = [{ manifest: builtin, source: 'builtin' }, ...data.packages.map((manifest) => ({ manifest, source: 'local' }))]
    for (const entry of state.packages) {
      if (!choices.some((item) => item.manifest.id === entry.manifest.id)) choices.push({ manifest: entry.manifest, source: entry.source })
    }
    return choices.map(({ manifest, source }) => {
      const entry = state.packages.find((item) => item.manifest.id === manifest.id)
      const components = [...manifest.components]
      for (const old of entry?.manifest.components ?? []) {
        if (statusFor(entry, old.id) && !components.some((item) => item.id === old.id)) components.push(old)
      }
      return {
        id: manifest.id, name: manifest.name, description: manifest.description, version: manifest.version,
        author: manifest.author, source, installed: Boolean(entry?.components.length),
        enabled: Boolean(entry?.components.some((item) => item.enabled)),
        installedVersion: entry?.components.length ? entry.manifest.version : null,
        updateAvailable: Boolean(entry?.components.length && entry.manifest.version !== manifest.version),
        rollbackVersion: entry?.previous?.manifest.version ?? null,
        components: components.map((component) => {
          const installed = statusFor(entry, component.id)
          const actual = installed ? entry.manifest.components.find((item) => item.id === component.id) : component
          const available = manifest.components.find((item) => item.id === component.id)
          const updateConflict = installed && !available ? 'removed'
            : installed && available.type !== actual.type ? 'type_changed' : null
          return { ...clone(actual), installed: Boolean(installed), enabled: Boolean(installed?.enabled), updateConflict }
        }),
      }
    })
  }
  async function resolveCatalog(packageId, state) {
    id(packageId)
    if (packageId === builtin.id) return { manifest: builtin, source: 'builtin' }
    const item = (await catalog()).packages.find((entry) => entry.id === packageId)
    if (item) return { manifest: item, source: 'local' }
    const saved = state?.packages.find((entry) => entry.manifest.id === packageId)
    if (saved) return { manifest: saved.manifest, source: saved.source }
    throw new Error('MARKETPLACE_PACKAGE_NOT_FOUND')
  }
  async function result(projectDirectory, packageId) {
    return (await listInternal(projectDirectory)).find((item) => item.id === packageId)
  }
  async function addPackage(manifest) {
    validatePackage(manifest)
    if (manifest.id === builtin.id) {
      if (same(manifest, builtin)) return
      throw new Error('MARKETPLACE_BUILTIN_COLLISION')
    }
    const data = await catalog()
    const index = data.packages.findIndex((item) => item.id === manifest.id)
    if (index < 0 && data.packages.length >= 100) throw new Error('MARKETPLACE_CATALOG_FULL')
    if (index >= 0 && data.packages[index].version === manifest.version && !same(data.packages[index], manifest)) {
      throw new Error('MARKETPLACE_VERSION_COLLISION')
    }
    if (index < 0) data.packages.push(clone(manifest)); else data.packages[index] = clone(manifest)
    await writeJson(catalogPath, data)
  }
  async function installInternal(projectDirectory, packageId, componentIds) {
    if (!Array.isArray(componentIds) || componentIds.length > 100 || new Set(componentIds).size !== componentIds.length) throw new Error('MARKETPLACE_SELECTION_INVALID')
    componentIds.forEach(id)
    const state = await readState(projectDirectory)
    const { manifest, source } = await resolveCatalog(packageId, state)
    if (componentIds.some((componentId) => !manifest.components.some((item) => item.id === componentId))) throw new Error('MARKETPLACE_COMPONENT_NOT_FOUND')
    let entry = state.packages.find((item) => item.manifest.id === packageId)
    if (!entry && !componentIds.length) throw new Error('MARKETPLACE_SELECTION_INVALID')
    if (!entry) {
      if (state.packages.length >= 100) throw new Error('MARKETPLACE_PROJECT_FULL')
      entry = { manifest: clone(manifest), source, components: [], previous: null }
      state.packages.push(entry)
    } else if (!same(entry.manifest, manifest)) {
      for (const installed of entry.components) {
        const old = entry.manifest.components.find((item) => item.id === installed.id)
        const next = manifest.components.find((item) => item.id === installed.id)
        if (!next || next.type !== old.type) throw new Error('MARKETPLACE_UPDATE_COMPONENT_REMOVED')
      }
      entry.previous = { manifest: entry.manifest, source: entry.source, components: clone(entry.components) }
      entry.manifest = clone(manifest); entry.source = source
    }
    for (const componentId of componentIds) {
      if (!statusFor(entry, componentId)) entry.components.push({ id: componentId, enabled: true })
    }
    await options.checkSkills?.(projectDirectory, state)
    await writeState(projectDirectory, state)
    return result(projectDirectory, packageId)
  }
  async function editEntry(projectDirectory, packageId, callback) {
    id(packageId)
    const before = await result(projectDirectory, packageId)
    const state = await readState(projectDirectory)
    const entry = state.packages.find((item) => item.manifest.id === packageId)
    if (!entry) throw new Error('MARKETPLACE_PACKAGE_NOT_INSTALLED')
    callback(entry, state)
    await options.checkSkills?.(projectDirectory, state)
    await writeState(projectDirectory, state)
    return await result(projectDirectory, packageId) ?? {
      ...before, installed: false, enabled: false, installedVersion: null, updateAvailable: false, rollbackVersion: null,
      components: before.components.map((component) => ({ ...component, installed: false, enabled: false })),
    }
  }
  return {
    list: (projectDirectory) => serial(() => listInternal(projectDirectory)),
    importPackage: (manifest) => serial(async () => { await addPackage(manifest); return result(undefined, manifest.id) }),
    exportPackage: (projectDirectory, packageId) => serial(async () => {
      const state = projectDirectory ? await readState(projectDirectory) : null
      const installed = state?.packages.find((item) => item.manifest.id === packageId && item.components.length)
      return clone(installed?.manifest ?? (await resolveCatalog(packageId, state)).manifest)
    }),
    install: (projectDirectory, packageId, componentIds) => serial(() => installInternal(projectDirectory, packageId, componentIds)),
    setEnabled: (projectDirectory, packageId, componentId, enabled) => serial(() => editEntry(projectDirectory, packageId, (entry) => {
      id(componentId)
      const installed = statusFor(entry, componentId)
      if (!installed) throw new Error('MARKETPLACE_COMPONENT_NOT_INSTALLED')
      if (typeof enabled !== 'boolean') throw new Error('MARKETPLACE_SELECTION_INVALID')
      installed.enabled = enabled
      const previous = statusFor(entry.previous, componentId)
      if (previous) previous.enabled = enabled
    })),
    uninstall: (projectDirectory, packageId, componentId) => serial(() => editEntry(projectDirectory, packageId, (entry, state) => {
      id(componentId)
      if (!statusFor(entry, componentId)) throw new Error('MARKETPLACE_COMPONENT_NOT_INSTALLED')
      const component = entry.manifest.components.find((item) => item.id === componentId)
      if (component?.type === 'skill') {
        state.retiredSkillIds = [...new Set([...(state.retiredSkillIds ?? []), marketplaceSkillId(packageId, componentId)])].slice(-2000)
      }
      entry.components = entry.components.filter((item) => item.id !== componentId)
      if (entry.previous) entry.previous.components = entry.previous.components.filter((item) => item.id !== componentId)
      if (!entry.components.length) state.packages = state.packages.filter((item) => item !== entry)
    })),
    rollback: (projectDirectory, packageId) => serial(() => editEntry(projectDirectory, packageId, (entry) => {
      if (!entry.previous) throw new Error('MARKETPLACE_ROLLBACK_UNAVAILABLE')
      const current = { manifest: entry.manifest, source: entry.source, components: entry.components }
      const previous = entry.previous
      entry.manifest = previous.manifest; entry.source = previous.source; entry.components = previous.components; entry.previous = current
    })),
    getInstalledComponent: (projectDirectory, packageId, componentId, expectedType) => serial(async () => {
      id(packageId); id(componentId)
      const entry = (await readState(projectDirectory)).packages.find((item) => item.manifest.id === packageId)
      const installed = statusFor(entry, componentId)
      const component = entry?.manifest.components.find((item) => item.id === componentId)
      if (!installed?.enabled || component?.type !== expectedType) throw new Error('MARKETPLACE_COMPONENT_NOT_AVAILABLE')
      return clone(component)
    }),
    saveTemplate: (projectDirectory, draft) => serial(async () => {
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)
        || Object.keys(draft).some((key) => !['name', 'description', 'data'].includes(key))) throw new Error('MARKETPLACE_PACKAGE_INVALID')
      const packageId = `personal-${crypto.randomUUID()}`
      const manifest = { schemaVersion: 1, id: packageId, name: draft.name, description: draft.description ?? '', version: '1.0.0', author: '本地用户',
        components: [{ id: 'template', type: 'template', name: draft.name, description: draft.description ?? '', data: draft.data }] }
      await addPackage(manifest)
      return installInternal(projectDirectory, packageId, ['template'])
    }),
  }
}
module.exports = { createMarketplaceService }
