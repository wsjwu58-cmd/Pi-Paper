import { Lightbulb, ListTree, Megaphone } from 'lucide-react'

const defaultSuggestions = [
  { icon: ListTree, text: '梳理画布信息，提炼核心创意与明确的下一步' },
  { icon: Megaphone, text: '基于画布素材，写出鲜明有记忆点的品牌文案' },
  { icon: Lightbulb, text: '延展画布内容，提出三个差异化可落地的方向' },
] as const

export function AgentEmptyState({ onSuggestion, description = '让 Paper Agent 理解整张画布的脉络，把零散灵感推进为清晰、可执行的创作方案。', suggestions = defaultSuggestions }: { onSuggestion: (text: string) => void; description?: string; suggestions?: ReadonlyArray<{ icon: typeof ListTree; text: string }> }) {
  return <div className="flex h-full min-h-[220px] items-center justify-center px-4 py-8 text-center">
    <div className="w-full max-w-[560px]">
      <img alt="" className="mx-auto mb-9 h-32 w-auto object-contain" src="/paper-agent.svg" />
      <p className="text-sm font-medium text-[var(--canvas-text-strong)]">Paper Agent</p>
      <p className="mt-1.5 text-xs leading-relaxed text-[var(--canvas-muted)]">{description}</p>
      <div className="-mx-2 mt-4 grid grid-cols-[repeat(auto-fit,minmax(92px,1fr))] gap-2">
        {suggestions.map(({ icon: Icon, text }) => <button key={text} type="button" onClick={() => onSuggestion(text)} className="flex min-h-24 flex-col items-start justify-center gap-2 rounded-xl border border-[var(--canvas-border)] bg-[var(--canvas-surface-muted)] px-2.5 py-3 text-left text-xs leading-snug text-[var(--canvas-text)] transition-colors hover:border-[var(--canvas-border-strong)] hover:bg-[var(--canvas-hover)]"><Icon size={16} strokeWidth={2} className="size-4 flex-none self-center text-[var(--canvas-muted)]" /><span>{text}</span></button>)}
      </div>
    </div>
  </div>
}
