import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { BookOpen } from 'lucide-react'
import type { SkillView } from '@/lib/types'

export function AgentSkillHistoryCard({
  skillId,
  skills,
}: {
  skillId?: string
  skills: readonly Pick<SkillView, 'id' | 'name'>[]
}) {
  useUiLanguage()
  if (!skillId) return null

  const skill = skills.find((item) => String(item.id) === skillId)
  const label = skill?.name ?? uiText("已使用的 Skill（当前不可用）")

  return (
    <div
      role="note"
      aria-label={uiText("本轮使用的 Skill：{0}", { 0: label })}
      className="mb-2 flex min-w-0 items-center gap-2 rounded-xl border border-black/6 bg-white/80 px-2.5 py-2 text-[12px] text-[#555]"
    >
      <BookOpen size={14} className="shrink-0 text-[#777]" />
      <span className="shrink-0 font-semibold text-[#888]">Skill</span>
      <span className="min-w-0 truncate font-semibold text-[#333]">{label}</span>
    </div>
  )
}
