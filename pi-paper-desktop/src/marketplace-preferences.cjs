const path = require('node:path')
const { readJson, writeJson, statePath, portableParams } = require('./marketplace-storage.cjs')

function createPresetPreferences(userDirectory) {
  const personalFile = path.join(userDirectory, 'marketplace-preset-defaults.json')
  async function projectFile(directory, create) {
    const file = await statePath(directory, create)
    return file && path.join(path.dirname(file), 'preset-overrides.json')
  }
  async function read(file) {
    const data = await readJson(file, { schemaVersion: 1, entries: {} })
    if (data?.schemaVersion !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) throw new Error('MARKETPLACE_STORAGE_INVALID')
    return data.entries
  }
  const keyFor = (manifest, component) => [manifest.id, manifest.version, component.id].join('/')
  return {
    async load(directory) {
      const [personal, project] = await Promise.all([read(personalFile), directory ? read(await projectFile(directory, false)) : {}])
      return (manifest, component) => {
        const key = keyFor(manifest, component)
        const defaults = personal[key] ?? {}
        const overrides = project[key] ?? {}
        portableParams(defaults, component.data.nodeType)
        portableParams(overrides, component.data.nodeType)
        return { original: component.data.params, personal: defaults, project: overrides }
      }
    },
    async save(directory, scope, manifest, component, params) {
      if (component.type !== 'preset' || !['personal', 'project'].includes(scope) || (scope === 'project' && !directory)) throw new Error('MARKETPLACE_SELECTION_INVALID')
      portableParams(params, component.data.nodeType)
      const file = scope === 'personal' ? personalFile : await projectFile(directory, true)
      const entries = await read(file)
      const key = keyFor(manifest, component)
      if (Object.keys(params).length) entries[key] = params
      else delete entries[key]
      await writeJson(file, { schemaVersion: 1, entries })
    },
  }
}
module.exports = { createPresetPreferences }
