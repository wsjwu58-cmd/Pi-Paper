import type { SkillView } from '@/lib/types'

export function filterSkillCommandItems(skills: readonly SkillView[], query: string): SkillView[] {
  const normalized = query.trim().toLocaleLowerCase()
  const seenNames = new Set<string>()
  return skills
    .filter((skill) => skill.name !== 'paper-agent-default')
    .filter((skill) => {
      if (!normalized) return true
      return [skill.name, skill.description, skill.instructions]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(normalized))
    })
    .filter((skill) => {
      const name = skill.name.trim().toLocaleLowerCase()
      if (seenNames.has(name)) return false
      seenNames.add(name)
      return true
    })
    .slice(0, 12)
}
