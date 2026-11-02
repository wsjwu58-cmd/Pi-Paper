// Read-only projection of the existing host catalog and configured bindings.
// The result deliberately excludes credentials, endpoints, defaults and prompts.
const MODALITIES = new Set(['text', 'image', 'video', 'audio'])
const INPUTS = new Set(['text', 'image', 'video', 'audio'])
const REASONS = Object.freeze({
  PROVIDER_UNCONFIGURED: '尚未配置该提供方。',
  MODEL_UNIMPLEMENTED: '该模型的官方适配尚未实现。',
  MODEL_DISABLED: '该模型未启用或所需配置不完整。',
  UNSUPPORTED_INPUT: '模型不支持所选参考输入。',
  ASPECT_NOT_DECLARED: '适配器未声明此模型支持的画幅比例。',
  UNSUPPORTED_ASPECT: '模型不支持所选画幅比例。',
  RESOLUTION_NOT_DECLARED: '适配器未声明此模型支持的分辨率。',
  UNSUPPORTED_RESOLUTION: '模型不支持所选分辨率。',
})
const validString = (value, max = 80) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value)
const strings = (value) => Array.isArray(value) ? value.filter((item) => validString(item, 120)).slice(0, 128) : []
function discoverModelBindings(catalog, input) {
  if (!catalog || !Array.isArray(catalog.models) || !Array.isArray(catalog.providers)
    || !input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['modality', 'referenceInputs', 'resolution', 'aspect'].includes(key))
    || !MODALITIES.has(input.modality)
    || (input.referenceInputs !== undefined && (!Array.isArray(input.referenceInputs) || input.referenceInputs.length > 4
      || new Set(input.referenceInputs).size !== input.referenceInputs.length || input.referenceInputs.some((value) => !INPUTS.has(value))))
    || (input.resolution !== undefined && !validString(input.resolution))
    || (input.aspect !== undefined && !validString(input.aspect))) throw new Error('INVALID_INPUT')
  const query = { modality: input.modality, referenceInputs: [...(input.referenceInputs ?? [])],
    ...(input.resolution ? { resolution: input.resolution } : {}), ...(input.aspect ? { aspect: input.aspect } : {}) }
  const providers = new Map(catalog.providers.filter((provider) => provider && validString(provider.id, 160)).map((provider) => [provider.id, provider]))
  const seen = new Set()
  const bindings = []
  for (const model of catalog.models) {
    if (!model || model.modelType !== query.modality || !validString(model.providerId, 160)) continue
    const id = validString(model.id, 256) ? model.id : model.name
    if (!validString(id, 256)) continue
    const key = `${model.providerId}\0${id}`
    if (seen.has(key)) continue
    seen.add(key)
    const provider = providers.get(model.providerId)
    const providerType = model.providerType === 'local' ? 'local' : 'cloud'
    const inputModes = strings(model.inputModes).filter((mode) => INPUTS.has(mode))
    const constraints = model.constraints && typeof model.constraints === 'object' && !Array.isArray(model.constraints) ? model.constraints : {}
    const ratios = strings(constraints.acceptedAspectRatios)
    const tableName = query.modality === 'image' ? 'sizesByAspectRatio' : 'resolutionsByAspectRatio'
    const table = constraints[tableName] && typeof constraints[tableName] === 'object' && !Array.isArray(constraints[tableName]) ? constraints[tableName] : null
    const declared = strings(query.modality === 'image' ? constraints.acceptedSizes : constraints.acceptedResolutions)
    const supportedResolutions = query.aspect && table ? strings(table[query.aspect]) : declared
    let reason = null
    if (model.implemented === false) reason = 'MODEL_UNIMPLEMENTED'
    else if (providerType !== 'local' && provider?.configured !== true) reason = 'PROVIDER_UNCONFIGURED'
    else if (model.enabled !== true) reason = 'MODEL_DISABLED'
    else if (query.referenceInputs.some((mode) => !inputModes.includes(mode))) reason = 'UNSUPPORTED_INPUT'
    else if (query.aspect && !ratios.length && !table) reason = 'ASPECT_NOT_DECLARED'
    else if (query.aspect && (ratios.length && !ratios.includes(query.aspect) || table && !Object.hasOwn(table, query.aspect))) reason = 'UNSUPPORTED_ASPECT'
    else if (query.resolution && !supportedResolutions.length) reason = 'RESOLUTION_NOT_DECLARED'
    else if (query.resolution && !supportedResolutions.some((value) => value.toLocaleLowerCase() === query.resolution.toLocaleLowerCase())) reason = 'UNSUPPORTED_RESOLUTION'
    bindings.push({ id, displayName: validString(model.displayName, 256) ? model.displayName : id,
      providerId: model.providerId, providerName: validString(provider?.name, 256) ? provider.name : model.providerId,
      providerType, modality: query.modality, inputModes, supportedResolutions,
      available: reason === null, reason, reasonMessage: reason ? REASONS[reason] : null })
  }
  bindings.sort((a, b) => Number(b.available) - Number(a.available) || a.providerName.localeCompare(b.providerName) || a.displayName.localeCompare(b.displayName))
  return { query, bindings }
}
module.exports = { discoverModelBindings }
