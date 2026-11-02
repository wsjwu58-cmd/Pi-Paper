const { createHash } = require('node:crypto')

// Node definitions are inert data. The host owns the editor, ports and task
// execution; the only transformation supported here is bounded substitution.
const BASE_TYPES = new Set(['text', 'image', 'video', 'audio'])
const ID = /^[a-z][a-z0-9_]{0,39}$/u
const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/u
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u
const FORBIDDEN_ID = /^(?:constructor|prototype|__proto__|api_?key|password|secret|access_?token|refresh_?token)$/iu
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const invalid = () => { throw new Error('MARKETPLACE_PACKAGE_INVALID') }
const invalidInstance = () => { throw new Error('NODE_DEFINITION_INVALID') }
function keys(value, allowed, fail = invalid) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail()
}
function portableText(value, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())
    || /(?:https?|file|vibe):\/\/|(?:[a-z]:\\|\/(?:Users|home|private|tmp)\/)/iu.test(value)) invalid()
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
function definitionDigest(snapshot) {
  return createHash('sha256').update(JSON.stringify(canonical(snapshot))).digest('hex')
}
function validateNodeDefinition(data) {
  keys(data, ['schemaVersion', 'baseType', 'promptTemplate', 'fields'])
  if (data.schemaVersion !== 1 || !BASE_TYPES.has(data.baseType) || !Array.isArray(data.fields)
    || data.fields.length < 1 || data.fields.length > 20) invalid()
  portableText(data.promptTemplate, 4000)
  const fields = new Map()
  for (const field of data.fields) {
    keys(field, ['id', 'label', 'kind', 'default', 'min', 'max', 'options'])
    if (typeof field.id !== 'string' || !ID.test(field.id) || FORBIDDEN_ID.test(field.id) || fields.has(field.id)) invalid()
    portableText(field.label, 64)
    if (field.kind === 'text') {
      if (field.min !== undefined || field.max !== undefined || field.options !== undefined) invalid()
      portableText(field.default, 1000, false)
    } else if (field.kind === 'number') {
      if (field.options !== undefined || typeof field.min !== 'number' || typeof field.max !== 'number'
        || !Number.isFinite(field.min) || !Number.isFinite(field.max) || field.min < -100000 || field.max > 100000
        || field.min > field.max || typeof field.default !== 'number' || !Number.isFinite(field.default)
        || field.default < field.min || field.default > field.max) invalid()
    } else if (field.kind === 'enum') {
      if (field.min !== undefined || field.max !== undefined || !Array.isArray(field.options)
        || field.options.length < 1 || field.options.length > 30 || new Set(field.options).size !== field.options.length) invalid()
      for (const option of field.options) portableText(option, 120)
      if (!field.options.includes(field.default)) invalid()
    } else invalid()
    fields.set(field.id, field)
  }
  const placeholders = [...data.promptTemplate.matchAll(/\{\{([a-z][a-z0-9_]{0,39})\}\}/gu)].map((match) => match[1])
  if (placeholders.some((id) => !fields.has(id)) || [...fields.keys()].some((id) => !placeholders.includes(id))
    || /[{}]/u.test(data.promptTemplate.replace(/\{\{[a-z][a-z0-9_]{0,39}\}\}/gu, ''))) invalid()
  return data
}
function validateNodeInstance(instance, baseType) {
  try {
    keys(instance, ['ref', 'snapshot', 'values'], invalidInstance)
    keys(instance.ref, ['packageId', 'componentId', 'version', 'digest'], invalidInstance)
    const { packageId, componentId, version, digest } = instance.ref
    if (!PACKAGE_ID.test(packageId ?? '') || !PACKAGE_ID.test(componentId ?? '') || !VERSION.test(version ?? '')
      || !/^[a-f0-9]{64}$/u.test(digest ?? '')) invalidInstance()
    keys(instance.snapshot, ['name', 'data'], invalidInstance)
    portableText(instance.snapshot.name, 64)
    validateNodeDefinition(instance.snapshot.data)
    if (instance.snapshot.data.baseType !== baseType || definitionDigest(instance.snapshot) !== digest) invalidInstance()
    const fields = instance.snapshot.data.fields
    keys(instance.values, fields.map((field) => field.id), invalidInstance)
    for (const field of fields) {
      if (!Object.hasOwn(instance.values, field.id)) invalidInstance()
      const value = instance.values[field.id]
      if (field.kind === 'text' && (typeof value !== 'string' || value.length > 1000)) invalidInstance()
      if (field.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max)) invalidInstance()
      if (field.kind === 'enum' && !field.options.includes(value)) invalidInstance()
    }
    return instance
  } catch { invalidInstance() }
}
function renderDefinitionPrompt(instance, baseType) {
  validateNodeInstance(instance, baseType)
  const prompt = instance.snapshot.data.promptTemplate.replace(/\{\{([a-z][a-z0-9_]{0,39})\}\}/gu,
    (_match, id) => String(instance.values[id]))
  if (prompt.length > 20000) invalidInstance()
  return prompt
}
function sameDefinition(left, right) {
  return JSON.stringify(canonical(left ? { ref: left.ref, snapshot: left.snapshot } : null))
    === JSON.stringify(canonical(right ? { ref: right.ref, snapshot: right.snapshot } : null))
}
module.exports = { validateNodeDefinition, validateNodeInstance, definitionDigest, renderDefinitionPrompt, sameDefinition }
