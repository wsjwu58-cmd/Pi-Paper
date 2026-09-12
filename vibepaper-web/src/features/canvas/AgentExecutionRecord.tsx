import { useEffect, useState } from 'react'
import { Brain, Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import type { ExecutionStep } from './agentTypes'
import { toolLabel } from './agentTypes'
import { cn } from '@/lib/cn'
import { useTypewriter } from './useTypewriter'
import { StreamingAgentReply } from './AgentMarkdown'

const EDIT_TOOLS = new Set([
  'create_nodes',
  'connect_nodes',
  'layout_nodes',
  'update_node_config',
  'delete_nodes',
])

/**
 * 保留时间线顺序：推理 / 工具 / 对白交错。
 * 连续编辑类工具合并为一条「编辑画布」。
 */
export function buildTimeline(steps: ExecutionStep[]): ExecutionStep[] {
  const shown: ExecutionStep[] = []

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    if (s.kind === 'reasoning' || s.kind === 'speech') {
      if (s.summary?.trim()) shown.push(s)
      continue
    }
    if (s.kind === 'plan' || s.kind === 'result') {
      if (s.tool && EDIT_TOOLS.has(s.tool)) {
        const block = [s]
        let j = i + 1
        while (
          j < steps.length &&
          (steps[j].kind === 'plan' || steps[j].kind === 'result') &&
          steps[j].tool &&
          EDIT_TOOLS.has(steps[j].tool as string)
        ) {
          block.push(steps[j])
          j += 1
        }
        const done = block.some((b) => b.kind === 'result' && b.ok)
        const fail = block.some((b) => b.kind === 'result' && b.ok === false)
        const detail =
          block.map((b) => b.reasoning || b.detail || b.summary).find((t) => t && t !== '编辑画布') ||
          undefined
        shown.push({
          id: block[block.length - 1].id,
          kind: done || fail ? 'result' : 'plan',
          tool: 'create_nodes',
          label: '编辑画布',
          summary: '编辑画布',
          ok: fail ? false : done ? true : undefined,
          detail,
          reasoning: detail,
        })
        i = j - 1
        continue
      }

      if (s.kind === 'plan') {
        const laterResult = steps.slice(i + 1).find((x) => x.kind === 'result' && x.tool === s.tool)
        if (laterResult) continue
        shown.push({
          ...s,
          label: toolLabel(s.tool),
          summary: toolLabel(s.tool),
        })
        continue
      }

      shown.push({
        ...s,
        label: toolLabel(s.tool),
        summary: toolLabel(s.tool),
      })
    }
  }
  return shown
}

function ReasoningBlock({
  text,
  streaming,
}: {
  text: string
  streaming?: boolean
}) {
  const { text: shown, catchingUp } = useTypewriter(text, !!streaming, 18)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (streaming) setOpen(true)
  }, [streaming])
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="mb-1 flex w-full items-center gap-1.5 rounded-[8px] px-1 py-1 text-left text-[13px] font-medium text-[#888] hover:bg-black/[0.03]"
      >
        <Brain size={14} className="text-[#999]" strokeWidth={1.75} />
        <span className="flex-1">思考与计划</span>
        {open ? <ChevronDown size={15} className="text-[#aaa]" /> : <ChevronRight size={15} className="text-[#aaa]" />}
      </button>
      {open && <div className="max-h-[140px] overflow-y-auto rounded-[8px] bg-[#f7f7f8] px-3 py-2.5">
        <p className="whitespace-pre-wrap text-[13px] leading-[1.65] text-[#777]">
          {shown}
          {(streaming || catchingUp) && (
            <span
              aria-hidden
              className="ml-0.5 inline-block h-[12px] w-[6px] translate-y-[1px] animate-pulse rounded-[1px] bg-[#bbb]"
            />
          )}
        </p>
      </div>}
    </div>
  )
}

function ToolRow({ step }: { step: ExecutionStep }) {
  const [open, setOpen] = useState(false)
  const isDone = step.kind === 'result' && step.ok !== false
  const isFail = step.kind === 'result' && step.ok === false
  const isPending = step.kind === 'plan'
  const detail = (step.detail || step.reasoning || '').trim()
  const canExpand = Boolean(detail) && detail !== step.label

  return (
    <div className="border-t border-black/[0.06]">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => canExpand && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2.5 py-2.5 text-left',
          canExpand ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <span
          className={cn(
            'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full',
            isFail
              ? 'bg-red-500 text-white'
              : isDone
                ? 'bg-emerald-500 text-white'
                : isPending
                  ? 'bg-amber-400/90 text-white'
                  : 'bg-emerald-500 text-white',
          )}
        >
          {isFail ? (
            <X size={11} strokeWidth={3} />
          ) : isPending ? (
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          ) : (
            <Check size={11} strokeWidth={3} />
          )}
        </span>
        <span className="min-w-0 flex-1 text-[14px] font-medium text-[#333]">{step.label}</span>
        {canExpand ? (
          open ? (
            <ChevronDown size={16} className="shrink-0 text-[#bbb]" />
          ) : (
            <ChevronRight size={16} className="shrink-0 text-[#bbb]" />
          )
        ) : (
          <ChevronRight size={16} className="shrink-0 text-transparent" />
        )}
      </button>
      {open && detail ? (
        <p className="pb-2.5 pl-[30px] text-[13px] leading-relaxed text-[#888]">{detail}</p>
      ) : null}
    </div>
  )
}

export function AgentTurnTimeline({
  steps,
  content,
  streaming = false,
  animateSpeech = false,
  streamComplete = false,
  onRevealDone,
}: {
  steps: ExecutionStep[]
  /** 兜底正文：若时间线尚无 speech 则追加 */
  content?: string
  streaming?: boolean
  animateSpeech?: boolean
  streamComplete?: boolean
  onRevealDone?: () => void
}) {
  const base = buildTimeline(steps)
  const hasSpeech = base.some((s) => s.kind === 'speech')
  const timeline =
    !hasSpeech && content?.trim()
      ? [
          ...base,
          {
            id: 'speech-fallback',
            kind: 'speech' as const,
            label: '回复',
            summary: content.trim(),
          },
        ]
      : base

  const toolCount = timeline.filter((s) => s.kind === 'plan' || s.kind === 'result').length
  const hasProcess = timeline.some((s) => s.kind !== 'speech')
  const [processOpen, setProcessOpen] = useState(true)

  useEffect(() => {
    if (streaming) setProcessOpen(true)
  }, [streaming])

  if (timeline.length === 0) return null

  const title =
    streaming && timeline.some((s) => s.kind === 'reasoning')
      ? '执行记录 · 推理中…'
      : toolCount > 0
        ? `执行记录 · 执行了 ${toolCount} 项操作`
        : '执行记录'

  const speechItems = timeline.filter((s) => s.kind === 'speech')
  const lastSpeechId = speechItems[speechItems.length - 1]?.id

  return (
    <div className="w-full min-w-0">
      {hasProcess && (
        <button
          type="button"
          onClick={() => setProcessOpen((v) => !v)}
          className="mb-1 flex w-full items-center gap-2 rounded-[10px] bg-[#f5f5f6] px-3 py-2 text-left text-[13px] font-medium text-[#666]"
        >
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              streaming ? 'animate-pulse bg-amber-400' : 'bg-[#c8c8c8]',
            )}
          />
          <span className="flex-1">{title}</span>
          {processOpen ? (
            <ChevronDown size={15} className="text-[#aaa]" />
          ) : (
            <ChevronRight size={15} className="text-[#aaa]" />
          )}
        </button>
      )}

      <div className="space-y-1">
        {timeline.map((s) => {
          if (s.kind === 'reasoning') {
            if (!processOpen && !streaming) return null
            return (
              <ReasoningBlock
                key={s.id}
                text={s.summary}
                streaming={streaming && s.id === timeline.filter((x) => x.kind === 'reasoning').at(-1)?.id}
              />
            )
          }
          if (s.kind === 'plan' || s.kind === 'result') {
            if (!processOpen && !streaming) return null
            return <ToolRow key={s.id} step={s} />
          }
          // speech：折叠过程时仍展示对白
          const isLast = s.id === lastSpeechId
          return (
            <div key={s.id} className="py-1.5">
              <StreamingAgentReply
                text={s.summary}
                animate={animateSpeech && isLast}
                streamComplete={streamComplete && isLast}
                onRevealDone={isLast ? onRevealDone : undefined}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** @deprecated 兼容旧引用名 */
export function AgentExecutionRecord({
  steps,
  streaming = false,
}: {
  steps: ExecutionStep[]
  defaultOpen?: boolean
  streaming?: boolean
}) {
  return <AgentTurnTimeline steps={steps} streaming={streaming} />
}

export function AgentNextActions({
  actions,
  onPick,
}: {
  actions: string[]
  onPick: (text: string) => void
}) {
  if (actions.length === 0) return null
  const shown = actions.slice(0, 4)
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-[13px] font-semibold text-[#666]">下一步</p>
      <div className="flex flex-col gap-1.5">
        {shown.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => onPick(a)}
            className="rounded-[10px] border border-black/8 bg-white px-3 py-2 text-left text-[14px] text-[#333] transition hover:border-black/16 hover:bg-[#fafafa]"
          >
            {a}
          </button>
        ))}
      </div>
    </div>
  )
}

export function AgentTaskBadge({
  status,
  taskId,
}: {
  status?: string
  taskId?: string
}) {
  if (!status || status === 'succeeded' || status === 'failed') return null
  const label =
    status === 'running' ? '生成中…' : status === 'queued' ? '排队中…' : `任务 ${status}`
  return (
    <p className="mt-2 flex items-center gap-1.5 text-[13px] font-medium text-[#888]">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
      {label}
      {taskId ? <span className="text-[#bbb]">#{String(taskId).slice(-6)}</span> : null}
    </p>
  )
}
