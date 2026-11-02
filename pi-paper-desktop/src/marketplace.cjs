const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const { createPresetPreferences } = require('./marketplace-preferences.cjs')
const bundled = [require('./marketplace-example.cjs'), require('./marketplace-creative-example.cjs'), require('./marketplace-connector-example.cjs'), require('./marketplace-drama-roles.cjs')]
const builtinById = new Map(bundled.map(manifest => [manifest.id, manifest]))
const { digestValue, id, isOnlineOrigin, validatePackage, readJson, writeJson, readState, writeState, marketplaceSkillId } = require('./marketplace-storage.cjs')
// This module is bundled separately for the standalone app and carries the
// exact same generated registry used by the Agent worker.
const { getOfficialSkillDefinitions, listProjectFileSkills } = require('./project-agent-skills.cjs')
// These virtual IDs cannot collide with valid portable manifest IDs.
const OFFICIAL_SKILL_CATALOG = '@vibepaper/official-skills'
const PROJECT_SKILL_CATALOG = '@vibepaper/project-skills'

const clone = (value) => JSON.parse(JSON.stringify(value))
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
const statusFor = (entry, componentId) => entry?.components.find((item) => item.id === componentId)

function createMarketplaceService(userDataDirectory, options = {}) {
  const preferences = createPresetPreferences(userDataDirectory)
  const catalogPath = path.join(userDataDirectory, 'marketplace-catalog.json')
  bundled.forEach(validatePackage)
  let queue = Promise.resolve()
  const serial = (operation) => {
    const result = queue.then(operation, operation)
    queue = result.catch(() => {})
    return result
  }
  async function catalog() {
    const data = await readJson(catalogPath, { schemaVersion: 1, packages: [] })
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.packages) || data.packages.length > 100) throw new Error('MARKETPLACE_STORAGE_INVALID')
    const seen = new Set()
    for (const item of data.packages) {
      validatePackage(item)
      if (seen.has(item.id)) throw new Error('MARKETPLACE_STORAGE_INVALID')
      seen.add(item.id)
    }
    if (data.provenance !== undefined) {
      if (!data.provenance || typeof data.provenance !== 'object' || Array.isArray(data.provenance)) throw new Error('MARKETPLACE_STORAGE_INVALID')
      for (const [packageId, origin] of Object.entries(data.provenance)) {
        if (!data.packages.some((item) => item.id === packageId) || !isOnlineOrigin(origin)) throw new Error('MARKETPLACE_STORAGE_INVALID')
      }
    }
    return data
  }
  async function listInternal(projectDirectory) {
    const presetLayers = await preferences.load(projectDirectory)
    const data = await catalog()
    const state = projectDirectory ? await readState(projectDirectory) : { packages: [] }
    const choices = availablePackages(data, state)
    const official = getOfficialSkillDefinitions()
    const disabled = new Set(state.disabledOfficialSkillIds ?? [])
    const components = official.map((skill) => ({
      id: skill.key, type: 'skill', name: skill.name, description: skill.description,
      data: { category: skill.category, instructions: skill.instructions },
      installed: true, enabled: skill.kind === 'builtin-core' || !disabled.has(skill.key),
      systemRequired: skill.kind === 'builtin-core', updateConflict: null,
    })).sort((a, b) => Number(b.systemRequired) - Number(a.systemRequired)
      || a.data.category.localeCompare(b.data.category) || a.name.localeCompare(b.name))
    const virtual = [{
      id: OFFICIAL_SKILL_CATALOG, name: '官方 Skill', description: '随应用提供的核心与创作 Skill；动态 Skill 可按项目启停。',
      version: '1.0.0', author: 'Pi-Paper', source: 'builtin', officialSkillCatalog: true,
      installed: true, enabled: components.some((item) => item.enabled), installedVersion: projectDirectory ? '1.0.0' : null,
      updateAvailable: false, rollbackVersion: null, origin: null, components,
    }]
    // A new project may not have opened the Agent yet. Browsing the market
    // must not initialize its Skill directory as a side effect.
    const agentDirectory = projectDirectory && path.join(projectDirectory, '.vibepaper', 'agent')
    if (agentDirectory && await fs.lstat(agentDirectory).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })) {
      const projectSkills = await listProjectFileSkills(projectDirectory)
      if (projectSkills.length) virtual.push({
        id: PROJECT_SKILL_CATALOG, name: '本项目 Skill 文件', description: '在当前项目 Skill 面板创建和编辑的本地文件。',
        version: '1.0.0', author: '本项目', source: 'local', projectSkillCatalog: true,
        installed: true, enabled: projectSkills.some((skill) => skill.enabled), installedVersion: '1.0.0',
        updateAvailable: false, rollbackVersion: null, origin: null,
        components: projectSkills.map((skill) => ({ id: skill.id, type: 'skill', name: skill.name,
          description: skill.description, data: { category: skill.category, instructions: skill.instructions },
          installed: true, enabled: skill.enabled, updateConflict: null })),
      })
    }
    const packages = choices.map(({ manifest, source, origin }) => {
      const entry = state.packages.find((item) => item.manifest.id === manifest.id)
      const components = [...manifest.components]
      for (const old of entry?.manifest.components ?? []) {
        if (statusFor(entry, old.id) && !components.some((item) => item.id === old.id)) components.push(old)
      }
      return {
        id: manifest.id, name: manifest.name, description: manifest.description, version: manifest.version,
        author: manifest.author, source, origin: origin ? clone(origin) : null, digest: digestValue(manifest),
        installedDigest: entry?.components.length ? digestValue(entry.manifest) : null, installed: Boolean(entry?.components.length),
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
          const view = { ...clone(actual), installed: Boolean(installed), enabled: Boolean(installed?.enabled), updateConflict }
          if (actual.type === 'preset') {
            const layers = presetLayers(installed ? entry.manifest : manifest, actual)
            view.preferences = layers
            view.data.params = { ...layers.original, ...layers.personal, ...layers.project }
          }
          return view
        }),
      }
    })
    return [...virtual, ...packages]
  }
  function availablePackages(catalog, state) {
    // Imported IDs may predate a bundled pack with the same ID. Keep imported
    // content identifiable and usable when upgrading or restoring an old project.
    const choices = new Map(bundled.map(manifest => [manifest.id, { manifest, source: 'builtin' }]))
    for (const entry of state?.packages ?? []) {
      if (!choices.has(entry.manifest.id) || entry.source !== 'builtin') {
        choices.set(entry.manifest.id, { manifest: entry.manifest, source: entry.source === 'online' ? 'online' : 'local', origin: entry.origin })
      }
    }
    for (const manifest of catalog.packages) {
      const origin = catalog.provenance?.[manifest.id]
      choices.set(manifest.id, { manifest, source: origin ? 'online' : 'local', origin })
    }
    for (const version of state?.projectPackages ?? []) {
      const packageId = version.manifest.id
      // A project owns its authored IDs. Importing an exported copy into the
      // user catalog must not mask the project or make that project unreadable.
      if (builtinById.has(packageId)) throw new Error('MARKETPLACE_PACKAGE_COLLISION')
      choices.set(packageId, { manifest: version.manifest, source: 'project' })
    }
    return [...choices.values()]
  }
  async function resolveCatalog(packageId, state) {
    id(packageId)
    const item = availablePackages(await catalog(), state).find(({ manifest }) => manifest.id === packageId)
    if (!item) throw new Error('MARKETPLACE_PACKAGE_NOT_FOUND')
    return item
  }
  async function result(projectDirectory, packageId) {
    return (await listInternal(projectDirectory)).find((item) => item.id === packageId)
  }
  async function addPackage(manifest, origin) {
    validatePackage(manifest)
    const builtin = builtinById.get(manifest.id)
    if (builtin) {
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
    data.provenance ??= {}
    if (origin) data.provenance[manifest.id] = clone(origin); else delete data.provenance[manifest.id]
    await writeJson(catalogPath, data)
  }
  function operationReplay(state, operation) {
    if (!operation) return null
    if (state.schemaVersion !== 2) throw new Error('MARKETPLACE_STORAGE_INVALID')
    const existing = state.creatorOperations.find((item) => item.key === operation.key)
    if (existing && existing.inputHash !== operation.inputHash) throw new Error('IDEMPOTENCY_CONFLICT')
    if (!existing && state.creatorOperations.length >= 5000) throw new Error('MARKETPLACE_PROJECT_FULL')
    return existing
  }
  function recordPackageOperation(state, operation, entry) {
    if (!operation) return
    const receipt = { id: entry.manifest.id, installedVersion: entry.manifest.version,
      components: entry.components.map(({ id: componentId, enabled }) => ({ id: componentId, installed: true, enabled })) }
    state.creatorOperations.push({ key: operation.key, inputHash: operation.inputHash,
      result: { kind: operation.kind, status: 'completed', receipt } })
  }
  async function installInternal(projectDirectory, packageId, componentIds, config = {}) {
    if (!Array.isArray(componentIds) || componentIds.length > 100 || new Set(componentIds).size !== componentIds.length) throw new Error('MARKETPLACE_SELECTION_INVALID')
    componentIds.forEach(id)
    const state = await readState(projectDirectory)
    const replay = operationReplay(state, config.operation)
    if (replay) return clone(replay.result.receipt)
    const { manifest, source, origin } = await resolveCatalog(packageId, state)
    if (config.digest && (source !== 'project' || digestValue(manifest) !== config.digest)) throw new Error('MARKETPLACE_VERSION_CONFLICT')
    if (componentIds.some((componentId) => !manifest.components.some((item) => item.id === componentId))) throw new Error('MARKETPLACE_COMPONENT_NOT_FOUND')
    let entry = state.packages.find((item) => item.manifest.id === packageId)
    if (!entry && !componentIds.length) throw new Error('MARKETPLACE_SELECTION_INVALID')
    if (!entry) {
      if (state.packages.length >= 100) throw new Error('MARKETPLACE_PROJECT_FULL')
      entry = { manifest: clone(manifest), source, origin, components: [], previous: null }
      state.packages.push(entry)
    } else if (!same(entry.manifest, manifest)) {
      for (const installed of entry.components) {
        const old = entry.manifest.components.find((item) => item.id === installed.id)
        const next = manifest.components.find((item) => item.id === installed.id)
        if (!next || next.type !== old.type) throw new Error('MARKETPLACE_UPDATE_COMPONENT_REMOVED')
      }
      entry.previous = { manifest: entry.manifest, source: entry.source, origin: entry.origin, components: clone(entry.components) }
      entry.manifest = clone(manifest); entry.source = source; entry.origin = origin
    }
    for (const componentId of componentIds) {
      if (!statusFor(entry, componentId)) entry.components.push({ id: componentId, enabled: config.enabledDefault ?? true })
    }
    await options.checkSkills?.(projectDirectory, state)
    recordPackageOperation(state, config.operation, entry)
    await writeState(projectDirectory, state, config.authorize)
    return result(projectDirectory, packageId)
  }
  async function editEntry(projectDirectory, packageId, callback, authorize, operation) {
    id(packageId)
    const before = await result(projectDirectory, packageId)
    const state = await readState(projectDirectory)
    const replay = operationReplay(state, operation)
    if (replay) return clone(replay.result.receipt)
    const entry = state.packages.find((item) => item.manifest.id === packageId)
    if (!entry) throw new Error('MARKETPLACE_PACKAGE_NOT_INSTALLED')
    callback(entry, state)
    await options.checkSkills?.(projectDirectory, state)
    recordPackageOperation(state, operation, entry)
    await writeState(projectDirectory, state, authorize)
    return await result(projectDirectory, packageId) ?? {
      ...before, installed: false, enabled: false, installedVersion: null, updateAvailable: false, rollbackVersion: null,
      components: before.components.map((component) => ({ ...component, installed: false, enabled: false })),
    }
  }
  function validateCreatorDraft(draft, allowNodeDefinition = false) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)
      || Object.keys(draft).some((key) => !['name', 'description', 'components'].includes(key))
      || !Array.isArray(draft.components) || draft.components.length < 1 || draft.components.length > 20
      || draft.components.some((component) => !['template', 'preset', ...(allowNodeDefinition ? ['node_definition', 'agent_role', 'workflow_recipe', 'selection_command', 'storyboard'] : [])].includes(component?.type))) throw new Error('MARKETPLACE_PACKAGE_INVALID')
    const manifest = { schemaVersion: 1, id: 'project-00000000-0000-0000-0000-000000000000', name: draft.name, description: draft.description ?? '', version: '1.0.0', author: '本地用户', components: draft.components }
    validatePackage(manifest)
    const encoded = JSON.stringify(draft)
    if (/(?:\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token)\s*[:=])/iu.test(encoded)) throw new Error('MARKETPLACE_SECRET_REJECTED')
    return { draftDigest: digestValue(draft), components: draft.components.map((component) => ({ id: component.id, type: component.type, name: component.name, ...(component.type === 'template' ? { nodeCount: component.data.nodes.length, edgeCount: component.data.edges.length } : {}) })) }
  }
  async function saveProjectDraft(projectDirectory, draft, input = {}, allowNodeDefinition = false) {
    const preview = validateCreatorDraft(draft, allowNodeDefinition)
    if (input.draftDigest !== preview.draftDigest) throw new Error('MARKETPLACE_DRAFT_CHANGED')
    if (typeof input.operationKey !== 'string' || !input.operationKey || input.operationKey.length > 128) throw new Error('IDEMPOTENCY_KEY_INVALID')
    const state = await readState(projectDirectory)
    if (state.schemaVersion === 1) { state.schemaVersion = 2; state.projectPackages = []; state.creatorOperations = [] }
    const inputHash = digestValue({ draft, base: input.base ?? null })
    const previousOperation = state.creatorOperations.find((operation) => operation.key === input.operationKey)
    if (previousOperation) {
      if (previousOperation.inputHash !== inputHash) throw new Error('IDEMPOTENCY_CONFLICT')
      return { ...previousOperation.result, package: await result(projectDirectory, previousOperation.result.packageId), replayed: true }
    }
    if (state.projectPackages.length >= 1000 || state.creatorOperations.length >= 5000) throw new Error('MARKETPLACE_PROJECT_FULL')
    let packageId, version = '1.0.0', parentDigest = null
    if (input.base !== undefined) {
      if (!input.base || typeof input.base !== 'object' || Array.isArray(input.base)
        || Object.keys(input.base).some((key) => !['packageId', 'digest'].includes(key))) throw new Error('MARKETPLACE_VERSION_CONFLICT')
      packageId = input.base.packageId
      const latest = [...state.projectPackages].reverse().find((item) => item.manifest.id === packageId)
      if (!latest || latest.digest !== input.base.digest) throw new Error('MARKETPLACE_VERSION_CONFLICT')
      const parts = latest.manifest.version.split('.').map(Number)
      if (parts[2] >= 99999) throw new Error('MARKETPLACE_VERSION_CONFLICT')
      parts[2] += 1; version = parts.join('.'); parentDigest = latest.digest
    } else {
      packageId = `project-${crypto.randomUUID()}`
      if (availablePackages(await catalog(), state).some((item) => item.manifest.id === packageId)) throw new Error('MARKETPLACE_PACKAGE_COLLISION')
    }
    const manifest = { schemaVersion: 1, id: packageId, name: draft.name, description: draft.description ?? '', version, author: '本地用户', components: clone(draft.components) }
    validatePackage(manifest)
    const digest = digestValue(manifest)
    const saved = { kind: 'save', status: 'completed', packageId, version, digest, parentDigest }
    state.projectPackages.push({ manifest, digest, parentDigest })
    state.creatorOperations.push({ key: input.operationKey, inputHash, result: saved })
    await writeState(projectDirectory, state, input.authorize)
    return { ...saved, package: await result(projectDirectory, packageId), replayed: false }
  }
  return {
    validateCreatorDraft,
    saveProjectDraft: (projectDirectory, draft, input) => serial(() => saveProjectDraft(projectDirectory, draft, input, true)),
    saveNodeDefinition: (projectDirectory, draft) => serial(async () => {
      const normalized = { name: draft?.name, description: draft?.description ?? '', components: [{ id: 'node', type: 'node_definition', name: draft?.name, description: draft?.description ?? '', data: draft?.data }] }
      const { draftDigest } = validateCreatorDraft(normalized, true)
      return (await saveProjectDraft(projectDirectory, normalized, { draftDigest, operationKey: crypto.randomUUID() }, true)).package
    }),
    prepareCreatorOperation: (projectDirectory, key, inputHash, metadata, authorize) => serial(async () => {
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key) || !/^[a-f0-9]{64}$/u.test(inputHash)) throw new Error('IDEMPOTENCY_KEY_INVALID')
      const state = await readState(projectDirectory)
      if (state.schemaVersion === 1) { state.schemaVersion = 2; state.projectPackages = []; state.creatorOperations = [] }
      const existing = state.creatorOperations.find((item) => item.key === key)
      if (existing) {
        if (existing.inputHash !== inputHash) throw new Error('IDEMPOTENCY_CONFLICT')
        return { created: false, result: clone(existing.result) }
      }
      if (state.creatorOperations.length >= 5000) throw new Error('MARKETPLACE_PROJECT_FULL')
      const result = { kind: 'apply', status: 'prepared', ...clone(metadata) }
      state.creatorOperations.push({ key, inputHash, result })
      await writeState(projectDirectory, state, authorize)
      return { created: true, result: clone(result) }
    }),
    completeCreatorOperation: (projectDirectory, key, inputHash, receipt) => serial(async () => {
      const state = await readState(projectDirectory)
      const operation = state.creatorOperations?.find((item) => item.key === key)
      if (!operation || operation.inputHash !== inputHash || !['apply', 'preset_apply', 'preset_undo'].includes(operation.result.kind)) throw new Error('IDEMPOTENCY_CONFLICT')
      if (operation.result.status === 'completed') return clone(operation.result)
      if (operation.result.status === 'failed') throw new Error('OPERATION_FAILED')
      operation.result = { ...operation.result, status: 'completed', receipt: clone(receipt) }
      await writeState(projectDirectory, state)
      return clone(operation.result)
    }),
    failCreatorOperation: (projectDirectory, key, inputHash, errorCode) => serial(async () => {
      const state = await readState(projectDirectory)
      const operation = state.creatorOperations?.find((item) => item.key === key)
      if (!operation || operation.inputHash !== inputHash || operation.result.status !== 'prepared') throw new Error('IDEMPOTENCY_CONFLICT')
      operation.result = { ...operation.result, status: 'failed', errorCode: /^[A-Z0-9_]{1,120}$/u.test(errorCode ?? '') ? errorCode : 'OPERATION_REJECTED' }
      await writeState(projectDirectory, state)
      return clone(operation.result)
    }),
    getCreatorOperations: (projectDirectory, key) => serial(async () => {
      if (key !== undefined && (typeof key !== 'string' || !key || key.length > 128)) throw new Error('INVALID_INPUT')
      const state = await readState(projectDirectory)
      const operations = state.creatorOperations ?? []
      return clone((key === undefined ? operations.slice(-20) : operations.filter((item) => item.key === key))
        .map(({ key: operationKey, inputHash, result }) => ({ operationKey, inputHash, ...result })))
    }),
    installCreator: (projectDirectory, packageId, digest, componentIds, authorize, operation) => serial(() => installInternal(projectDirectory, packageId, componentIds, { digest, enabledDefault: false, authorize, operation })),
    getBasicNodeVisibility: (projectDirectory) => serial(async () => ({ hidden: [...((await readState(projectDirectory)).hiddenBasicNodeTypes ?? [])] })),
    setBasicNodeVisibility: (projectDirectory, type, visible) => serial(async () => {
      if (!['text', 'image', 'video', 'audio', 'compose', 'director'].includes(type) || typeof visible !== 'boolean') throw new Error('INVALID_INPUT')
      const state = await readState(projectDirectory)
      const hidden = new Set(state.hiddenBasicNodeTypes ?? [])
      if (visible) hidden.delete(type); else hidden.add(type)
      state.hiddenBasicNodeTypes = [...hidden]
      await writeState(projectDirectory, state)
      return { hidden: [...hidden] }
    }),
    list: (projectDirectory) => serial(() => listInternal(projectDirectory)),
    savePresetPreferences: (directory, scope, packageId, componentId, version, params) => serial(async () => {
      id(packageId); id(componentId)
      const state = directory ? await readState(directory) : null
      const entry = state?.packages.find((item) => item.manifest.id === packageId && statusFor(item, componentId))
      if (scope === 'project' && !entry) throw new Error('MARKETPLACE_COMPONENT_NOT_INSTALLED')
      const { manifest } = entry ?? await resolveCatalog(packageId, state)
      const component = manifest.components.find((item) => item.id === componentId)
      if (manifest.version !== version || component?.type !== 'preset') throw new Error('MARKETPLACE_SELECTION_INVALID')
      await preferences.save(directory, scope, manifest, component, params)
    }),
    importPackage: (manifest, origin) => serial(async () => { await addPackage(manifest, origin); return result(undefined, manifest.id) }),
    exportPackage: (projectDirectory, packageId) => serial(async () => {
      const state = projectDirectory ? await readState(projectDirectory) : null
      const installed = state?.packages.find((item) => item.manifest.id === packageId && item.components.length)
      return clone(installed?.manifest ?? (await resolveCatalog(packageId, state)).manifest)
    }),
    install: (projectDirectory, packageId, componentIds) => serial(() => installInternal(projectDirectory, packageId, componentIds)),
    setEnabled: (projectDirectory, packageId, componentId, enabled) => serial(async () => {
      if (packageId === OFFICIAL_SKILL_CATALOG) {
        const skill = getOfficialSkillDefinitions().find((item) => item.key === componentId)
        if (!skill) throw new Error('MARKETPLACE_COMPONENT_NOT_FOUND')
        if (typeof enabled !== 'boolean') throw new Error('MARKETPLACE_SELECTION_INVALID')
        if (skill.kind === 'builtin-core') throw new Error('MARKETPLACE_SYSTEM_REQUIRED')
        const state = await readState(projectDirectory)
        const disabled = new Set(state.disabledOfficialSkillIds ?? [])
        if (enabled) disabled.delete(componentId); else disabled.add(componentId)
        state.disabledOfficialSkillIds = [...disabled]
        await writeState(projectDirectory, state)
        return result(projectDirectory, packageId)
      }
      if (packageId === PROJECT_SKILL_CATALOG) throw new Error('MARKETPLACE_PROJECT_SKILL_MANAGED_IN_PANEL')
      return editEntry(projectDirectory, packageId, (entry) => {
      id(componentId)
      const installed = statusFor(entry, componentId)
      if (!installed) throw new Error('MARKETPLACE_COMPONENT_NOT_INSTALLED')
      if (typeof enabled !== 'boolean') throw new Error('MARKETPLACE_SELECTION_INVALID')
      installed.enabled = enabled
      const previous = statusFor(entry.previous, componentId)
      if (previous) previous.enabled = enabled
      })
    }),
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
      const current = { manifest: entry.manifest, source: entry.source, origin: entry.origin, components: entry.components }
      const previous = entry.previous
      entry.manifest = previous.manifest; entry.source = previous.source; entry.origin = previous.origin; entry.components = previous.components; entry.previous = current
    })),
    setEnabledCreator: (projectDirectory, packageId, digest, componentId, enabled, authorize, operation) => serial(() => editEntry(projectDirectory, packageId, (entry) => {
      id(componentId)
      if (entry.source !== 'project' || digestValue(entry.manifest) !== digest) throw new Error('MARKETPLACE_VERSION_CONFLICT')
      const installed = statusFor(entry, componentId)
      if (!installed || typeof enabled !== 'boolean') throw new Error('MARKETPLACE_COMPONENT_NOT_INSTALLED')
      installed.enabled = enabled
      const previous = statusFor(entry.previous, componentId)
      if (previous) previous.enabled = enabled
    }, authorize, operation)),
    withInstalledSnapshot: (projectDirectory, packageId, componentId, callback) => serial(async () => {
      id(packageId); id(componentId)
      if (typeof callback !== 'function') throw new Error('INVALID_INPUT')
      const entry = (await readState(projectDirectory)).packages.find((item) => item.manifest.id === packageId)
      const installed = statusFor(entry, componentId)
      const component = entry?.manifest.components.find((item) => item.id === componentId)
      if (!installed?.enabled || !component) throw new Error('MARKETPLACE_COMPONENT_NOT_AVAILABLE')
      return callback({ version: entry.manifest.version, digest: digestValue(entry.manifest), component: clone(component) })
    }),
    getInstalledSnapshot: (projectDirectory, packageId, componentId) => serial(async () => {
      id(packageId); id(componentId)
      const entry = (await readState(projectDirectory)).packages.find((item) => item.manifest.id === packageId)
      const installed = statusFor(entry, componentId)
      const component = entry?.manifest.components.find((item) => item.id === componentId)
      if (!installed?.enabled || !component) throw new Error('MARKETPLACE_COMPONENT_NOT_AVAILABLE')
      return { version: entry.manifest.version, digest: digestValue(entry.manifest), component: clone(component) }
    }),
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
