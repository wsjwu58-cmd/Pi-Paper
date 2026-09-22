import type { AgentChatMsg, AgentConfirmation, ExecutionStep } from './agentTypes'
import { stepFromPlan, stepFromResult, stepFromSpeech, stepFromThinking, toolLabel } from './agentTypes'
import { normalizeConfirmationExpiry } from './confirmationState'

function stripEmbeddedReactJson(text: string): string {
  const s = text.trim()
  if (!s) return ''
  const re = /\{[\s\n\r]*"(?:thinking|decision|_actions|actions|ask_question)"/
  const m = re.exec(s)
  if (!m || m.index == null) {
    if (s.includes('"_actions"') && s.includes('"decision"')) {
      const idx = s.indexOf('{')
      return idx > 0 ? s.slice(0, idx).trim() : ''
    }
    return s
  }
  if (m.index > 0) return s.slice(0, m.index).trim()
  return ''
}

function appendExecutionStep(steps: ExecutionStep[], step: ExecutionStep): ExecutionStep[] {
  const key = `${step.kind ?? ''}|${step.tool ?? ''}|${step.summary ?? ''}`
  if (steps.some((s) => `${s.kind ?? ''}|${s.tool ?? ''}|${s.summary ?? ''}` === key)) {
    return steps
  }
  return [...steps, step]
}

/** 同一拍推理：落在时间线末尾的 reasoning 上累加；若中间已插入工具/对白则新开一段。 */
function upsertReasoning(steps: ExecutionStep[], content: string): ExecutionStep[] {
  const next = [...steps]
  const last = next[next.length - 1]
  if (last?.kind === 'reasoning') {
    const prev = stripEmbeddedReactJson(last.summary || '')
    const nextSummary =
      content.startsWith(prev) || prev.startsWith(content)
        ? content.length >= prev.length
          ? content
          : prev
        : prev
          ? `${prev}\n\n${content}`
          : content
    next[next.length - 1] = {
      ...last,
      summary: stripEmbeddedReactJson(nextSummary),
    }
    return next
  }
  return [...next, stepFromThinking(content, Date.now())]
}

function upsertSpeech(steps: ExecutionStep[], content: string): ExecutionStep[] {
  const trimmed = content.trim()
  if (!trimmed) return steps
  const next = [...steps]
  const last = next[next.length - 1]
  if (last?.kind === 'speech') {
    // 流式覆盖同段；若是全新更长段落且不以旧文开头，则新开一段（中途对白）
    if (trimmed === last.summary) return next
    if (trimmed.startsWith(last.summary) || last.summary.startsWith(trimmed)) {
      next[next.length - 1] = { ...last, summary: trimmed }
      return next
    }
  }
  // 避免与已有完全相同的 speech 重复
  if (next.some((s) => s.kind === 'speech' && s.summary === trimmed)) return next
  return [...next, stepFromSpeech(trimmed, Date.now())]
}

export function isChatVisibleMessage(m: AgentChatMsg): boolean {
  if (m.role === 'user') return true
  if (m.type && m.type !== 'text') return false
  if (m.content?.trim()) return true
  if ((m.meta?.executionSteps?.length ?? 0) > 0) return true
  if (m.meta?.confirmation) return true
  return false
}

export function patchLastAssistant(
  messages: AgentChatMsg[],
  patch: (m: AgentChatMsg) => AgentChatMsg,
): AgentChatMsg[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      const next = [...messages]
      next[i] = patch(messages[i])
      return next
    }
  }
  return messages
}

export function applyAgentEvent(
  messages: AgentChatMsg[],
  ev: Record<string, unknown>,
  turnId: string | null,
): AgentChatMsg[] {
  if (ev.type === 'confirm_required') {
    const actionId = String(ev.actionId ?? '')
    const approvalToken = String(ev.approvalToken ?? ev.token ?? '')
    if (!actionId || !approvalToken) return messages
    const confirmation: AgentConfirmation = {
      actionId,
      approvalToken,
      tool: typeof ev.tool === 'string' ? ev.tool : undefined,
      summary: String(ev.summary ?? ev.tool ?? '待确认操作'),
      confirmReason: typeof ev.confirmReason === 'string' ? ev.confirmReason : undefined,
      estimatedCost: Number(ev.estimatedCost ?? 0) || 0,
      chainEstimatedCost: Number(ev.chainEstimatedCost ?? 0) || 0,
      estimatedTotalCost: Number(ev.estimatedTotalCost ?? ev.estimatedCost ?? 0) || 0,
      approvedCostCap: Number(ev.approvedCostCap ?? 0) || 0,
      affectedNodeCount: Number(ev.affectedNodeCount ?? 0) || 0,
      canvasVersion: Number(ev.canvasVersion ?? 0) || undefined,
      planVersion: Number(ev.planVersion ?? 0) || undefined,
      expiresAt: normalizeConfirmationExpiry(ev.expiresAt),
      status: 'pending',
    }
    return patchLastAssistant(messages, (m) => ({
      ...m,
      meta: { ...m.meta, requiresConfirmation: true, confirmation },
    }))
  }

  if (ev.type === 'thinking' || ev.type === 'reflection') {
    const content = stripEmbeddedReactJson(String(ev.content ?? ev.note ?? '').trim())
    if (!content) return messages
    return patchLastAssistant(messages, (m) => ({
      ...m,
      meta: {
        ...m.meta,
        executionSteps: upsertReasoning(m.meta?.executionSteps ?? [], content),
      },
    }))
  }

  if (ev.type === 'skill_loaded') {
    const name = String(
      ev.skill || (Array.isArray(ev.keys) ? (ev.keys as string[]).join('、') : '') || 'Skill',
    )
    if (!name || name === 'paper-agent-default') return messages
    return patchLastAssistant(messages, (m) => {
      const skills = [...(m.meta?.loadedSkills ?? [])]
      if (!skills.includes(name)) skills.push(name)
      return {
        ...m,
        meta: {
          ...m.meta,
          loadedSkills: skills,
          executionSteps: appendExecutionStep(m.meta?.executionSteps ?? [], {
            id: `skill-${name}`,
            kind: 'result',
            tool: 'load_skill',
            label: '加载技能',
            summary: name,
            ok: true,
            reasoning: `加载 ${name}`,
          }),
        },
      }
    })
  }

  if (ev.type === 'plan_step') {
    const step = stepFromPlan(
      ev.tool as string | undefined,
      String(ev.summary ?? ev.tool ?? ''),
      Date.now(),
      typeof ev.reasoning === 'string' ? ev.reasoning : undefined,
    )
    return patchLastAssistant(messages, (m) => ({
      ...m,
      meta: {
        ...m.meta,
        executionSteps: appendExecutionStep(m.meta?.executionSteps ?? [], step),
      },
    }))
  }

  if (ev.type === 'speech' && ev.content) {
    const content = String(ev.content)
    return patchLastAssistant(messages, (m) => ({
      ...m,
      meta: {
        ...m.meta,
        executionSteps: upsertSpeech(m.meta?.executionSteps ?? [], content),
      },
    }))
  }

  if (ev.type === 'inline_confirm' && ev.content) {
    const line = String(ev.content)
    return patchLastAssistant(messages, (m) => ({
      ...m,
      content: m.content?.trim() ? `${m.content.trim()}\n${line}` : line,
      meta: {
        ...m.meta,
        executionSteps: upsertSpeech(m.meta?.executionSteps ?? [], line),
      },
    }))
  }

  if (ev.type === 'action_result') {
    const tool = ev.tool as string | undefined
    const ok = !!ev.ok
    const data = (ev.data || {}) as Record<string, unknown>
    const submitAck =
      tool === 'submit_generation' &&
      ok &&
      !data.skipped &&
      Boolean(data.ack || data.task_id || data.taskId)
    const detail = ok
      ? tool === 'submit_generation'
        ? data.skipped
          ? String(data.note ?? '已跳过（节点已有成品）')
          : submitAck
            ? '已受理，排队生成中'
            : String(data.note ?? data.error ?? '未实际提交')
        : undefined
      : String(data.error ?? '')
    const label = toolLabel(tool)
    const step = stepFromResult(
      tool,
      ok && (tool !== 'submit_generation' || submitAck || !!data.skipped),
      ok
        ? submitAck || tool !== 'submit_generation'
          ? data.skipped && tool === 'submit_generation'
            ? `${label}（已跳过）`
            : label
          : `${label}（未提交）`
        : `${label}失败`,
      detail,
    )
    return patchLastAssistant(messages, (m) => ({
      ...m,
      meta: {
        ...m.meta,
        executionSteps: appendExecutionStep(m.meta?.executionSteps ?? [], step),
      },
    }))
  }

  if (ev.type === 'assistant_message' && ev.content) {
    const content = String(ev.content)
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant' && last.content === content && !ev.executionSteps) return messages
    const spam = /任务已提交|后台生成中|依赖就绪的下游/
    if (
      last?.role === 'assistant' &&
      spam.test(content) &&
      spam.test(String(last.content || ''))
    ) {
      return messages
    }
    const streaming = ev.streaming === true
    const silentContent = ev.silentContent === true
    const steps = (ev.executionSteps as ExecutionStep[] | undefined) ?? []
    const patchMeta = (m: AgentChatMsg): AgentChatMsg['meta'] => {
      let executionSteps = (() => {
        const incoming = !streaming && steps.length ? steps : steps.length ? steps : m.meta?.executionSteps
        if (!incoming?.length) return m.meta?.executionSteps ?? []
        const prevSkills = (m.meta?.executionSteps ?? []).filter((s) => s.tool === 'load_skill')
        const prevSpeech = (m.meta?.executionSteps ?? []).filter((s) => s.kind === 'speech')
        let merged = [...incoming]
        if (prevSkills.length && !merged.some((s) => s.tool === 'load_skill')) {
          merged = [...prevSkills, ...merged]
        }
        // 收尾 executionSteps 若缺 speech，保留时间线里已有的对白段
        if (prevSpeech.length && !merged.some((s) => s.kind === 'speech')) {
          const tools = merged.filter((s) => s.kind !== 'speech')
          merged = [...prevSpeech, ...tools]
        }
        return merged
      })()
      if (!silentContent && content.trim()) {
        executionSteps = upsertSpeech(executionSteps, content)
      }
      return {
        ...m.meta,
        replyType: (ev.replyType as string | undefined) ?? m.meta?.replyType,
        pipelineStage: (ev.pipelineStage as string | undefined) ?? m.meta?.pipelineStage,
        suggestions: streaming
          ? m.meta?.suggestions
          : ((ev.suggestions as AgentChatMsg['meta'] extends { suggestions?: infer S } ? S : never) ??
            m.meta?.suggestions),
        nextActions: streaming
          ? m.meta?.nextActions
          : ((ev.nextActions as string[]) ?? m.meta?.nextActions),
        loadedSkills: streaming
          ? m.meta?.loadedSkills
          : (Array.isArray(ev.loadedSkills)
              ? (ev.loadedSkills as unknown[])
                  .map((x) =>
                    typeof x === 'string'
                      ? x
                      : String((x as { name?: string; key?: string })?.name || (x as { key?: string })?.key || ''),
                  )
                  .filter(Boolean)
              : m.meta?.loadedSkills),
        executionSteps,
      }
    }
    const existing = messages.find((m) => m.id === turnId)
    if (existing) {
      return messages.map((m) =>
        m.id === turnId
          ? {
              ...m,
              content: silentContent && m.content?.trim() ? m.content : content,
              meta: patchMeta(m),
            }
          : m,
      )
    }
    return [
      ...messages,
      {
        id: turnId ?? Date.now(),
        role: 'assistant',
        type: 'text',
        content,
        meta: patchMeta({
          id: turnId ?? Date.now(),
          role: 'assistant',
          type: 'text',
          content,
          meta: {},
        }),
      },
    ]
  }

  if (ev.type === 'task_status') {
    const data = (ev.data || {}) as Record<string, unknown>
    const st = String(data.status ?? '')
    const taskStatus = {
      taskId: data.task_id as string | undefined,
      status: st || undefined,
      nodeId: data.node_id as string | undefined,
    }
    if (ev.silent) {
      return patchLastAssistant(messages, (m) => ({
        ...m,
        meta: { ...m.meta, taskStatus },
      }))
    }
    if (!['succeeded', 'failed'].includes(st)) {
      return patchLastAssistant(messages, (m) => ({
        ...m,
        meta: { ...m.meta, taskStatus },
      }))
    }
    if (st === 'succeeded' || st === 'failed') {
      const content =
        st === 'succeeded'
          ? '✅ 生成完成，产物已写回画布节点。'
          : `❌ 生成失败：${String(data.error || data.error_code || '原因未知')}`
      return [
        ...messages,
        {
          id: `task-${data.task_id ?? Date.now()}`,
          role: 'assistant',
          type: 'text',
          content,
          meta: {
            taskStatus: {
              taskId: data.task_id as string | undefined,
              status: st,
              nodeId: data.node_id as string | undefined,
            },
            executionSteps: [stepFromSpeech(content, Date.now())],
          },
        },
      ]
    }
  }

  return messages
}

export function shouldRefreshCanvas(ev: Record<string, unknown>): boolean {
  if (ev.type === 'canvas_changed') return true
  if (ev.type === 'action_result' && ev.ok) {
    const tool = String(ev.tool ?? '')
    return tool === 'create_nodes' || tool === 'connect_nodes'
  }
  if (ev.type === 'task_status') {
    const data = (ev.data || {}) as Record<string, unknown>
    return ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired', 'settlement_error'].includes(
      String(data.status ?? ''),
    )
  }
  return false
}

const CANVAS_MUTATION_TOOLS = new Set([
  'create_nodes',
  'connect_nodes',
  'layout_nodes',
  'update_node_config',
  'delete_nodes',
])

export function shouldRefreshCanvasEvent(ev: Record<string, unknown>): boolean {
  if (shouldRefreshCanvas(ev)) return true
  if (ev.type !== 'tool_completed') return false
  const data = (ev.data || {}) as Record<string, unknown>
  return data.ok !== false && CANVAS_MUTATION_TOOLS.has(String(data.tool || ''))
}
