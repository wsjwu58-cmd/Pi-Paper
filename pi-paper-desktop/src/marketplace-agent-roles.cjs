// Declarative roles only narrow host capabilities. They never provide code,
// command paths or additional authority.
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/u
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,159}$/u
const TOOL = /^[a-z][a-z0-9_]{0,79}$/u
const PROFILES = new Set(['canvas-general', 'vertical-short-drama', 'asset-assistant', 'audit-readonly'])
const CONTEXTS = new Set(['canvas', 'selection', 'memory', 'history'])
const invalid = () => { throw new Error('MARKETPLACE_PACKAGE_INVALID') }
const record = (value) => value && typeof value === 'object' && !Array.isArray(value)

function validateAgentRole(data) {
  if (!record(data) || Object.keys(data).some((key) => !['profile', 'tools', 'skills', 'contexts', 'instructions'].includes(key))) invalid()
  if (!PROFILES.has(data.profile) || typeof data.instructions !== 'string' || data.instructions.length > 4000
    || /(?:https?|file|vibe):\/\/|(?:[a-z]:\\|\/(?:Users|home|private|tmp)\/)|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token)\s*[:=]/iu.test(data.instructions)) invalid()
  for (const [items, limit, check] of [
    [data.tools, 40, (item) => typeof item === 'string' && TOOL.test(item)],
    [data.skills, 20, (item) => typeof item === 'string' && (SKILL_ID.test(item) || /^package:[a-z0-9][a-z0-9-]{0,79}$/u.test(item))],
    [data.contexts, 4, (item) => CONTEXTS.has(item)],
  ]) {
    if (!Array.isArray(items) || items.length > limit || new Set(items).size !== items.length || items.some((item) => !check(item))) invalid()
  }
  return data
}

function validateRoleBinding(binding) {
  if (!record(binding) || Object.keys(binding).some((key) => !['packageId', 'componentId', 'digest'].includes(key))
    || typeof binding.packageId !== 'string' || !ID.test(binding.packageId)
    || typeof binding.componentId !== 'string' || !ID.test(binding.componentId)
    || typeof binding.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.digest)) {
    throw new Error('AGENT_ROLE_BINDING_INVALID')
  }
  return binding
}

async function listAgentRoles(projectDirectory) {
  const { readState, digestValue } = require('./marketplace-storage.cjs')
  const state = await readState(projectDirectory)
  return state.packages.flatMap((entry) => entry.components.flatMap((installed) => {
    const component = entry.manifest.components.find((item) => item.id === installed.id)
    if (!installed.enabled || component?.type !== 'agent_role') return []
    validateAgentRole(component.data)
    return [{ binding: { packageId: entry.manifest.id, componentId: component.id, digest: digestValue(entry.manifest) },
      name: component.name, description: component.description, version: entry.manifest.version }]
  }))
}

async function resolveAgentRole(projectDirectory, binding) {
  validateRoleBinding(binding)
  const { readState, digestValue, marketplaceSkillId } = require('./marketplace-storage.cjs')
  const state = await readState(projectDirectory)
  const entry = state.packages.find((item) => item.manifest.id === binding.packageId)
  const component = entry?.manifest.components.find((item) => item.id === binding.componentId)
  if (!entry || digestValue(entry.manifest) !== binding.digest || component?.type !== 'agent_role'
    || !entry.components.some((item) => item.id === binding.componentId && item.enabled)) throw new Error('AGENT_ROLE_UNAVAILABLE')
  const data = validateAgentRole(component.data)
  const skills = data.skills.map((reference) => {
    if (!reference.startsWith('package:')) return reference
    const componentId = reference.slice('package:'.length)
    if (!entry.manifest.components.some((item) => item.id === componentId && item.type === 'skill')
      || !entry.components.some((item) => item.id === componentId && item.enabled)) throw new Error('AGENT_ROLE_SKILL_UNAVAILABLE')
    return marketplaceSkillId(entry.manifest.id, componentId)
  })
  return { binding, name: component.name, description: component.description, version: entry.manifest.version,
    profile: data.profile, tools: [...data.tools], skills, contexts: [...data.contexts], instructions: data.instructions }
}

module.exports = { validateAgentRole, validateRoleBinding, listAgentRoles, resolveAgentRole }
