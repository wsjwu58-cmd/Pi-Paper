const { getOfficialSkillDefinitions, listProjectFileSkills } = require('./project-agent-skills.cjs')
const { listMarketplaceSkillIds, marketplaceSkillId } = require('./marketplace-storage.cjs')

/** The marketplace may be called by the Worker itself, so collision checking
 * must never synchronously call back into that Worker's serialized queue. */
async function assertMarketplaceSkillCollisions(directory, nextState) {
  const [projectSkills, reservedMarketIds] = await Promise.all([
    listProjectFileSkills(directory), listMarketplaceSkillIds(directory),
  ])
  const official = getOfficialSkillDefinitions()
  const names = new Set([...official, ...projectSkills].map((skill) => skill.name.trim().toLocaleLowerCase()))
  const existingIds = new Set([...official.map((skill) => skill.key), ...projectSkills.map((skill) => skill.id)])
  if (projectSkills.some((skill) => reservedMarketIds.has(skill.id))) throw new Error('SKILL_NAME_COLLISION')
  for (const entry of nextState.packages) for (const installed of entry.components) {
    const component = entry.manifest.components.find((item) => item.id === installed.id)
    if (component?.type !== 'skill') continue
    const name = component.name.trim().toLocaleLowerCase()
    const id = marketplaceSkillId(entry.manifest.id, component.id)
    if (names.has(name) || existingIds.has(id)) throw new Error('SKILL_NAME_COLLISION')
    names.add(name); existingIds.add(id)
  }
}
module.exports = { assertMarketplaceSkillCollisions }
