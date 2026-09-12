import { LoaderCircle, Puzzle } from 'lucide-react'
import type { SkillView } from '@/lib/types'

export function SkillCommandPicker({
  items,
  loading,
  onSelect,
}: {
  items: readonly SkillView[]
  loading?: boolean
  onSelect: (skill: SkillView) => void
}) {
  return (
    <div
      role="listbox"
      aria-label="选择 Skill"
      className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-30 max-h-72 overflow-y-auto rounded-2xl border border-black/10 bg-white p-1.5 shadow-[0_16px_40px_rgba(15,23,42,0.16)]"
    >
      {loading && (
        <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-[#888]">
          <LoaderCircle size={14} className="animate-spin" /> 加载 Skill…
        </div>
      )}
      {!loading && items.length === 0 && <p className="px-3 py-3 text-[12px] text-[#888]">没有匹配的 Skill</p>}
      {!loading &&
        items.map((skill) => (
          <button
            key={String(skill.id)}
            type="button"
            role="option"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(skill)}
            className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-[#f3f4f6]"
          >
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#f1f3f5] text-[#667085]">
              <Puzzle size={15} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-bold text-[#111]">{skill.name}</span>
              <span className="mt-0.5 block truncate text-[11px] text-[#9299a3]">
                {skill.description || skill.instructions.slice(0, 80)}
              </span>
            </span>
          </button>
        ))}
    </div>
  )
}
