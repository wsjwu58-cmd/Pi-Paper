import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Bot,
  X,
  Send,
  Settings2,
  BookOpen,
  History,
  BarChart3,
  Square,
  SquarePlus,
  Plus,
  Puzzle,
  SlidersHorizontal,
  Lightbulb,
  ListTree,
  Megaphone,
  Clapperboard,
  AlertTriangle,
} from 'lucide-react'
import { api, ApiError, authedFetch } from '@/lib/api'
import { parseJsonPreserveIds } from '@/lib/ids'
import { useAuth } from '@/lib/auth'
import type { MemoryView, ModelInfo, SkillView } from '@/lib/types'
import { SkillsPanel } from './SkillsPanel'
import { ModelPicker } from '@/components/ui/ModelPicker'
import { useCanvasStore } from './canvasStore'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import {
  resolveAgentCanvasVersion,
  resolveBoundConfirmationCanvasVersion,
  resolveConfirmationCanvasVersion,
} from './confirmationVersion'
import { isActionableConfirmation } from './confirmationState'
import { toolLabel, type AgentChatMsg, type AgentConfirmation, type AgentSuggestion, type ExecutionStep } from './agentTypes'
import { AgentNextActions, AgentTaskBadge, AgentTurnTimeline } from './AgentExecutionRecord'
import {
  applyAgentEvent,
  isChatVisibleMessage,
  shouldRefreshCanvas,
  shouldRefreshCanvasEvent,
} from './agentEventHandlers'
import {
  isAgentEventEnvelope,
  mergeSessionMessages,
  reduceAgentEvent,
  type AgentEventEnvelope,
  type AgentEventState,
} from './agentEventEnvelope'
import { AgentComposerBar } from './AgentComposerBar'
import { AgentNodeReferenceCards } from './AgentNodeReferenceCards'
import {
  consumeSentNodeRefs,
  newlySelectedComposerRefs,
  nodeReferencesForComposer,
  refFromNode,
  upsertRefs,
  type ComposerRef,
} from './agentNodeReferences'
import { DramaAssetsTab } from './DramaAssetsTab'
import { getEventStreamReconnectDelay, scrollChatToBottom, shouldReloadSessionAfterStream } from './agentEventStream'
import { SkillCommandPicker } from './skillCommandPicker'
import { filterSkillCommandItems } from './skillCommandPickerUtils'

const AGENT_PANEL_DEFAULT_WIDTH = 380
const AGENT_PANEL_MIN_WIDTH = 300
const AGENT_PANEL_MAX_WIDTH = 720
const DEFAULT_TEXT_MODEL = 'agnes-2.5-flash'

function resolvePreferredTextModel(name?: string | null) {
  if (!name || /deepseek|qwen-max|gpt-4o-mini/i.test(name)) return DEFAULT_TEXT_MODEL
  return name
}

const SUGGESTIONS = [
  { icon: ListTree, text: '梳理画布信息，提炼核心创意与明确的下一步' },
  { icon: Megaphone, text: '基于画布素材，写出鲜明有记忆点的品牌文案' },
  { icon: Lightbulb, text: '延展画布内容，提出三个差异化可落地的方向' },
] as const

interface Suggestion extends AgentSuggestion {}

export function AgentLauncher({ onOpen }: { onOpen: () => void }) {
  return (
    <span className="absolute bottom-4 right-4 z-20 inline-flex" title="打开对话">
      <button
        type="button"
        aria-label="打开对话"
        onClick={onOpen}
        className="group/agent-launcher relative z-0 inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-zinc-300/50 bg-white p-1 text-xs text-zinc-950 shadow-[0_4px_12px_rgb(0_0_0_/_0.05)] transition-all duration-300 hover:border-zinc-400 hover:bg-white"
      >
        <img alt="" className="size-8 object-contain" src="/paper-agent.svg" />
      </button>
    </span>
  )
}

export function AgentPanel() {
  const open = useCanvasStore((s) => s.agentOpen)
  const setOpen = useCanvasStore((s) => s.setAgentOpen)
  const setAgentPanelWidth = useCanvasStore((s) => s.setAgentPanelWidth)
  const canvas = useCanvasStore((s) => s.canvas)
  const preferences = useAuth((s) => s.preferences)
  const updatePreferences = useAuth((s) => s.updatePreferences)
  const [width, setWidth] = useState(AGENT_PANEL_DEFAULT_WIDTH)
  const [resizing, setResizing] = useState(false)
  const resizeStartRef = useRef<{ x: number; w: number } | null>(null)
  const [textModels, setTextModels] = useState<ModelInfo[]>([])
  const [agentModel, setAgentModel] = useState(resolvePreferredTextModel(preferences?.defaultTextModel))
  const [sessionId, setSessionId] = useState<string | number | null>(null)
  const [sessionTitle, setSessionTitle] = useState('新对话')
  const [messages, setMessages] = useState<AgentChatMsg[]>([])
  const [input, setInput] = useState('')
  const [selectedSkill, setSelectedSkill] = useState<SkillView | null>(null)
  const [skillOptions, setSkillOptions] = useState<SkillView[]>([])
  const [skillPickerLoading, setSkillPickerLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [tab, setTab] = useState<'chat' | 'pref' | 'skills' | 'usage' | 'history' | 'drama'>('chat')
  const [composerRefs, setComposerRefs] = useState<ComposerRef[]>([])
  const previousSelectedNodeIdsRef = useRef<Set<string>>(new Set())
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const sseAbortRef = useRef<AbortController | null>(null)
  const sendAbortRef = useRef<AbortController | null>(null)
  const turnIdRef = useRef<string | null>(null)
  const seenTaskIdsRef = useRef<Set<string>>(new Set())
  const seenWakeupRef = useRef<Map<string, number>>(new Map())
  /** 本轮回复逐字动画标记 */
  const [typingTurnId, setTypingTurnId] = useState<string | null>(null)
  // State updates are asynchronous, while a double-click can dispatch two
  // confirmation requests in the same render frame. Keep an immediate lock.
  const confirmingActionRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const canvasId = canvas?.canvas.id
  const previousCanvasIdRef = useRef<string | number | undefined>(undefined)
  const lastEventSeqRef = useRef(0)
  const queryClient = useQueryClient()
  // Every asynchronous session operation carries this epoch. A response from
  // an older epoch is stale by definition and must never update the chat UI.
  const sessionEpochRef = useRef(0)
  const activeSessionIdRef = useRef<string | number | null>(null)
  const agentEventStateRef = useRef<AgentEventState>({
    messages: [],
    seenEventIds: new Set(),
    runStatus: 'running',
    messageIdByRun: new Map(),
    persistedAssistantRunIds: new Set(),
  })

  const notifyCanvasChanged = useCallback(() => {
    // Keep the window event for CanvasPage and invalidate the shared query
    // directly so the sync does not depend on listener timing.
    window.dispatchEvent(new Event('vp-agent-executed'))
    if (canvasId != null) {
      void queryClient.invalidateQueries({ queryKey: ['canvas', String(canvasId)] })
    }
  }, [canvasId, queryClient])

  const skillCommandQuery = useMemo(() => {
    const match = /^\/([^\s]*)$/.exec(input)
    return match?.[1] ?? null
  }, [input])
  const skillCommandItems = useMemo(
    () => (skillCommandQuery == null ? [] : filterSkillCommandItems(skillOptions, skillCommandQuery)),
    [skillCommandQuery, skillOptions],
  )

  useEffect(() => {
    if (!open || tab !== 'chat' || skillCommandQuery == null) return
    let cancelled = false
    setSkillPickerLoading(true)
    void api<{ items: SkillView[] }>(
      `/skills${skillCommandQuery ? `?keyword=${encodeURIComponent(skillCommandQuery)}` : ''}`,
    )
      .then((result) => {
        if (!cancelled) setSkillOptions(result.items ?? [])
      })
      .catch(() => {
        if (!cancelled) setSkillOptions([])
      })
      .finally(() => {
        if (!cancelled) setSkillPickerLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, tab, skillCommandQuery])

  const consumeAgentEnvelope = (event: AgentEventEnvelope): void => {
    setMessages((previous) => {
      const next = reduceAgentEvent({ ...agentEventStateRef.current, messages: previous }, event)
      agentEventStateRef.current = next
      return next.messages
    })
    if (event.type === 'confirmation_required') {
      // A background continuation is interactive again once it reaches a
      // confirmation card; keep the card actionable without a new message.
      setBusy(false)
    } else if (event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_aborted') {
      setBusy(false)
    } else if (event.type === 'task_status') {
      const status = String(event.data.status ?? '')
      if (status === 'queued' || status === 'running') setBusy(true)
      if (['succeeded', 'failed', 'cancelled', 'expired', 'settlement_error'].includes(status)) setBusy(false)
    } else {
      // Auto-continuation has no originating send() call to set busy=true.
      setBusy(true)
    }
    if (event.type === 'run_failed') {
      toastError(String(event.data.message ?? event.data.errorCode ?? 'Agent 运行失败'))
    } else if (event.type === 'run_aborted') {
      setTypingTurnId(null)
    }
  }

  const clearSessionRuntime = () => {
    sseAbortRef.current?.abort()
    sendAbortRef.current?.abort()
    sseAbortRef.current = null
    sendAbortRef.current = null
    activeSessionIdRef.current = null
    lastEventSeqRef.current = 0
    turnIdRef.current = null
    seenTaskIdsRef.current.clear()
    seenWakeupRef.current.clear()
    agentEventStateRef.current = {
      messages: [], seenEventIds: new Set(), runStatus: 'running', messageIdByRun: new Map(), persistedAssistantRunIds: new Set(),
    }
    setSessionTitle('新对话')
    setMessages([])
    setSuggestions([])
    setComposerRefs([])
    setSelectedSkill(null)
    setTypingTurnId(null)
  }

  const beginSessionTransition = () => {
    sessionEpochRef.current += 1
    clearSessionRuntime()
    return sessionEpochRef.current
  }

  const activateEmptySession = (id: string | number, title?: string) => {
    activeSessionIdRef.current = id
    setSessionId(id)
    setSessionTitle(title || '新对话')
    setMessages([])
    setSuggestions([])
    setComposerRefs([])
  }

  useEffect(() => {
    const previousCanvasId = previousCanvasIdRef.current
    if (previousCanvasId !== undefined && String(previousCanvasId) !== String(canvasId)) {
      beginSessionTransition()
      setSessionId(null)
    }
    previousCanvasIdRef.current = canvasId
  }, [canvasId])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    setAgentPanelWidth(open ? width : 0)
  }, [open, width, setAgentPanelWidth])

  useEffect(() => {
    if (preferences?.defaultTextModel) {
      setAgentModel(resolvePreferredTextModel(preferences.defaultTextModel))
    }
  }, [preferences?.defaultTextModel])

  useEffect(() => {
    void api<{ items: ModelInfo[] }>('/models')
      .then((r) => setTextModels(r.items.filter((m) => m.modelType === 'text')))
      .catch(() => undefined)
  }, [])

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId)
      } catch {
        /* synthetic pointer events may lack an active pointer */
      }
      resizeStartRef.current = { x: e.clientX, w: width }
      setResizing(true)
    },
    [width],
  )

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current
    if (!start) return
    const dx = start.x - e.clientX
    const next = Math.min(AGENT_PANEL_MAX_WIDTH, Math.max(AGENT_PANEL_MIN_WIDTH, start.w + dx))
    setWidth(next)
  }, [])

  const endResize = useCallback(() => {
    resizeStartRef.current = null
    setResizing(false)
  }, [])

  const onAgentModelChange = (name: string) => {
    setAgentModel(name)
    void updatePreferences({ defaultTextModel: name }).catch(() => undefined)
  }

  const handleBackgroundEvent = (ev: Record<string, unknown>) => {
    if (isAgentEventEnvelope(ev)) {
      if (shouldRefreshCanvasEvent(ev)) {
        notifyCanvasChanged()
      }
      consumeAgentEnvelope(ev)
      return
    }
    if (shouldRefreshCanvas(ev)) {
      notifyCanvasChanged()
    }
    if (ev.type === 'task_status') {
      const data = (ev.data || {}) as Record<string, unknown>
      const tid = String(data.task_id ?? '')
      if (ev.silent) {
        setMessages((m) => applyAgentEvent(m, ev, turnIdRef.current))
        return
      }
      if (tid && seenTaskIdsRef.current.has(tid)) return
      if (tid) seenTaskIdsRef.current.add(tid)
    }
    if (ev.type === 'assistant_message') {
      const content = String(ev.content ?? '')
      if (content) {
        const last = seenWakeupRef.current.get(content)
        const now = Date.now()
        if (last && now - last < 60_000) return
        seenWakeupRef.current.set(content, now)
      }
      setMessages((prev) => {
        if (prev.some((m) => m.role === 'assistant' && m.content === content)) return prev
        return applyAgentEvent(prev, ev, turnIdRef.current)
      })
      if (Array.isArray(ev.nextActions)) {
        /* next actions live on message meta */
      }
      return
    }
    setMessages((m) => applyAgentEvent(m, ev, turnIdRef.current))
  }

  const handleBackgroundEventRef = useRef<(ev: Record<string, unknown>) => void>(() => undefined)
  handleBackgroundEventRef.current = handleBackgroundEvent

  const loadSessionQuiet = async (
    id: string | number,
    title?: string,
    epoch = sessionEpochRef.current,
    preserveEventStream = false,
  ) => {
    const res = await api<{ items: AgentChatMsg[]; events?: AgentEventEnvelope[] }>(`/agent/sessions/${id}/messages`)
    if (epoch !== sessionEpochRef.current) return false
    activeSessionIdRef.current = id
    setSessionId(id)
    setSessionTitle(title || `对话 #${id}`)
    const loadedMessages = res.items
      .map((m) => ({ ...m, type: m.type || 'text', meta: (m.meta as AgentChatMsg['meta']) ?? {} }))
      .filter(isChatVisibleMessage)
    const mergedMessages = preserveEventStream
      ? mergeSessionMessages(loadedMessages, agentEventStateRef.current.messages)
      : loadedMessages
    let nextState: AgentEventState = {
      messages: mergedMessages,
      seenEventIds: preserveEventStream ? agentEventStateRef.current.seenEventIds : new Set(),
      runStatus: preserveEventStream ? agentEventStateRef.current.runStatus : 'running',
      pendingMessageId: preserveEventStream ? agentEventStateRef.current.pendingMessageId : undefined,
      messageIdByRun: preserveEventStream ? agentEventStateRef.current.messageIdByRun : new Map(),
      persistedAssistantRunIds: new Set([
        ...(preserveEventStream ? agentEventStateRef.current.persistedAssistantRunIds : []),
        ...loadedMessages.flatMap((message) => message.role === 'assistant' && message.content.trim() && message.meta?.runId
          ? [message.meta.runId]
          : []),
      ]),
    }
    for (const event of res.events ?? []) {
      if (!isAgentEventEnvelope(event)) continue
      nextState = reduceAgentEvent(nextState, event)
      lastEventSeqRef.current = Math.max(lastEventSeqRef.current, event.eventSeq)
    }
    agentEventStateRef.current = nextState
    if (!preserveEventStream && (res.events?.length ?? 0) === 0) lastEventSeqRef.current = 0
    setMessages(nextState.messages)
    setSuggestions([])
    setComposerRefs([])
    return true
  }

  const ensureSession = async (forceNew = false) => {
    if (!canvas?.canvas.id) {
      throw new Error('画布尚未加载，请稍后再试')
    }
    if (!forceNew && sessionId) return sessionId

    // Stop old transport immediately. Relying on the later React effect
    // cleanup left a window where old-session SSE events reached new chat UI.
    const epoch = forceNew ? beginSessionTransition() : sessionEpochRef.current

    // 打开画布时恢复该画布最近一次对话，而不是总是新建
    if (!forceNew) {
      try {
        const list = await api<{
          items: Array<{ sessionId: string | number; title: string; canvasId?: string | number }>
        }>(`/agent/sessions?canvasId=${encodeURIComponent(String(canvas.canvas.id))}`)
        const latest = list.items?.[0]
        if (latest?.sessionId != null) {
          const loaded = await loadSessionQuiet(latest.sessionId, latest.title, epoch)
          if (!loaded) throw new DOMException('会话已切换', 'AbortError')
          return latest.sessionId
        }
      } catch {
        /* 列表失败则回退创建 */
      }
    }

    const s = await api<{ sessionId: string | number; title?: string; canvasId?: string | number }>('/agent/sessions', {
      method: 'POST',
      body: JSON.stringify({
        canvasId: String(canvas.canvas.id),
        title: '新对话',
      }),
    })
    if (epoch !== sessionEpochRef.current) throw new DOMException('会话已切换', 'AbortError')
    activateEmptySession(s.sessionId, s.title)
    return s.sessionId
  }

  useEffect(() => {
    if (!open) return
    if (!canvas?.canvas.id) return
    if (sessionId) return
    void ensureSession().catch((e) => toastError((e as Error).message))
  }, [open, sessionId, canvas?.canvas.id])

  useEffect(() => {
    if (!open || !sessionId) return
    const boundSessionId = sessionId
    const ac = new AbortController()
    sseAbortRef.current = ac
    let active = true
    void (async () => {
      let retryMs = 250
      while (active && !ac.signal.aborted) {
        if (String(activeSessionIdRef.current) !== String(boundSessionId)) break
        try {
          const cursor = lastEventSeqRef.current
          const query = cursor > 0 ? `?afterSeq=${cursor}` : ''
          const res = await authedFetch(`/agent/sessions/${sessionId}/events${query}`, { signal: ac.signal })
          if (!res.ok || !res.body) throw new Error(`events:${res.status}`)
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''
          while (active && !ac.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const parts = buf.split('\n\n')
            buf = parts.pop() ?? ''
            for (const part of parts) {
              if (String(activeSessionIdRef.current) !== String(boundSessionId)) {
                active = false
                break
              }
              const dataLine = part.split('\n').find((l) => l.startsWith('data: '))
              if (!dataLine) continue
              // Do not let one malformed/proxy-truncated SSE frame tear down
              // the background stream. The next persisted event remains
              // authoritative and can still restore the Agent trace.
              let ev: Record<string, unknown>
              try {
                ev = parseJsonPreserveIds(dataLine.slice(6)) as Record<string, unknown>
              } catch {
                continue
              }
              if (ev.type === 'idle') continue
              if (isAgentEventEnvelope(ev)) {
                lastEventSeqRef.current = Math.max(lastEventSeqRef.current, ev.eventSeq)
              }
              if (
                isAgentEventEnvelope(ev) ||
                ev.type === 'task_status' ||
                ev.type === 'assistant_message' ||
                ev.type === 'canvas_changed'
              ) {
                handleBackgroundEventRef.current(ev)
              }
            }
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, getEventStreamReconnectDelay(retryMs)))
          retryMs = getEventStreamReconnectDelay(retryMs * 2)
        } catch {
          if (!active || ac.signal.aborted) break
          await new Promise<void>((resolve) => window.setTimeout(resolve, retryMs))
          retryMs = Math.min(5000, retryMs * 2)
        }
      }
    })()
    return () => {
      active = false
      ac.abort()
      sseAbortRef.current = null
    }
  }, [open, sessionId])

  useEffect(() => {
    if (chatScrollRef.current) scrollChatToBottom(chatScrollRef.current)
  }, [messages, busy])

  // busy 结束后若逐字已追上仍卡住标记，做兜底清理
  useEffect(() => {
    if (busy || !typingTurnId) return undefined
    const msg = messages.find((m) => m.id === typingTurnId)
    const len = msg?.content?.length ?? 0
    const ms = Math.min(12000, Math.max(800, len * 20 + 400))
    const t = window.setTimeout(() => {
      setTypingTurnId((cur) => (cur === typingTurnId ? null : cur))
    }, ms)
    return () => window.clearTimeout(t)
  }, [busy, typingTurnId, messages])

  const canvasNodes = useCanvasStore((s) => s.nodes)

  useEffect(() => {
    const syncSelection = (nodes: typeof canvasNodes) => {
      const { selectedIds, added } = newlySelectedComposerRefs(nodes, previousSelectedNodeIdsRef.current)
      previousSelectedNodeIdsRef.current = selectedIds
      if (added.length) setComposerRefs((prev) => upsertRefs(prev, added))
    }
    syncSelection(useCanvasStore.getState().nodes)
    const unsub = useCanvasStore.subscribe((state) => syncSelection(state.nodes))
    return unsub
  }, [])

  const loadSession = async (id: string | number, title?: string) => {
    try {
      const epoch = beginSessionTransition()
      const loaded = await loadSessionQuiet(id, title, epoch)
      if (!loaded) return
      setTab('chat')
      toastSuccess('已切换会话')
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const addSuggestionsToCanvas = async (items: Suggestion[]) => {
    if (!canvasId || items.length === 0) return
    try {
      for (const [i, s] of items.entries()) {
        const type = s.type === 'image' || s.type === 'video' || s.type === 'audio' ? s.type : 'text'
        await api(`/canvases/${canvasId}/nodes`, {
          method: 'POST',
          body: JSON.stringify({
            type,
            x: 180 + i * 40,
            y: 140 + i * 30,
            params: {
              prompt: s.prompt || s.content || s.title || '',
              title: s.title,
              ...(s.nodeParams || {}),
            },
          }),
        })
      }
      toastSuccess(`已添加 ${items.length} 个节点到画布`)
      notifyCanvasChanged()
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const stop = () => {
    sendAbortRef.current?.abort()
    sendAbortRef.current = null
    if (sessionId) {
      void api(`/agent/sessions/${sessionId}/cancel`, { method: 'POST' }).catch(() => undefined)
    }
    setBusy(false)
  }

  const pinNodesByIds = (ids: Array<string | number | undefined>) => {
    const storeNodes = useCanvasStore.getState().nodes
    const add: ComposerRef[] = []
    for (const raw of ids) {
      if (raw == null || raw === '') continue
      const id = String(raw)
      const hit = storeNodes.find((n) => String(n.data.node.id) === id || String(n.id) === id)
      add.push(hit ? refFromNode(hit.data.node) : { id, kind: 'node', title: '节点' })
    }
    if (add.length) setComposerRefs((prev) => upsertRefs(prev, add))
  }

    const processStreamEvent = (ev: Record<string, unknown>) => {
    if (isAgentEventEnvelope(ev)) {
      if (shouldRefreshCanvasEvent(ev)) {
        notifyCanvasChanged()
      }
      if (ev.type === 'assistant_delta') setTypingTurnId(turnIdRef.current)
      consumeAgentEnvelope(ev)
      return
    }
    if (shouldRefreshCanvas(ev)) {
      notifyCanvasChanged()
    }
    if (ev.type === 'assistant_message') {
      if (Array.isArray(ev.suggestions)) setSuggestions(ev.suggestions as Suggestion[])
      const tid = turnIdRef.current
      if (tid && ev.content) setTypingTurnId(tid)
      const skills = ev.loadedSkills as Array<string | { name?: string; key?: string }> | undefined
      if (Array.isArray(skills) && skills.length) {
        setComposerRefs((prev) =>
          upsertRefs(
            prev,
            skills.map((s) => {
              const name = typeof s === 'string' ? s : String(s?.name || s?.key || '')
              return { id: `skill:${name}`, kind: 'skill' as const, title: name }
            }).filter((s) => s.title),
          ),
        )
      }
    }
    if (ev.type === 'skill_loaded') {
      const name = String(ev.skill || '')
      if (name && name !== 'paper-agent-default') {
        setComposerRefs((prev) => upsertRefs(prev, [{ id: `skill:${name}`, kind: 'skill', title: name }]))
      }
    }
    if (ev.type === 'canvas_changed' || (ev.type === 'action_result' && ev.tool === 'create_nodes' && ev.ok)) {
      const data = (ev.data || {}) as Record<string, unknown>
      const created = (data.createdNodes || data.nodes || []) as Array<{ id?: string | number }>
      pinNodesByIds(created.map((n) => n.id))
    }
    if (ev.type === 'task_status') {
      const data = (ev.data || {}) as Record<string, unknown>
      if (String(data.status ?? '') === 'succeeded') {
        pinNodesByIds([data.node_id as string | number | undefined, data.nodeId as string | number | undefined])
      }
    }
    if ((ev.type === 'thinking' || ev.type === 'reflection') && turnIdRef.current) {
      setTypingTurnId(turnIdRef.current)
    }
    setMessages((m) => applyAgentEvent(m, ev, turnIdRef.current))
  }

  const patchConfirmation = (actionId: string, status: AgentConfirmation['status']) => {
    setMessages((items) => {
      const next = items.map((item) =>
        item.meta?.confirmation?.actionId === actionId
          ? {
              ...item,
              meta: {
                ...item.meta,
                requiresConfirmation: status === 'pending' || status === 'submitting',
                confirmation: { ...item.meta.confirmation, status },
              },
            }
          : item,
      )
      agentEventStateRef.current = { ...agentEventStateRef.current, messages: next }
      return next
    })
  }

  const confirmAction = async (confirmation: AgentConfirmation, accept: boolean) => {
    if (!sessionId || confirmingActionRef.current) return
    confirmingActionRef.current = confirmation.actionId
    patchConfirmation(confirmation.actionId, 'submitting')
    try {
      const canvasVersion = confirmation.canvasVersion != null
        ? resolveBoundConfirmationCanvasVersion(confirmation.canvasVersion)
        : canvas?.canvas.id != null
          ? resolveConfirmationCanvasVersion(
              await api<{ canvas?: { version?: unknown }; version?: unknown }>(`/canvases/${canvas.canvas.id}`),
              canvas?.canvas.version,
            )
          : resolveConfirmationCanvasVersion({}, canvas?.canvas.version)
      const result = await api<{
        ok: boolean
        cancelled?: boolean
        taskId?: string
        status?: string
        events?: Record<string, unknown>[]
      }>(
        `/agent/sessions/${sessionId}/confirmations/${confirmation.actionId}`,
        {
          method: 'POST',
          body: JSON.stringify({
            approvalToken: confirmation.approvalToken,
            accept,
            canvasVersion,
          }),
        },
      )
      patchConfirmation(confirmation.actionId, accept ? 'accepted' : 'rejected')
      for (const event of result.events ?? []) processStreamEvent(event)
      if (accept) toastSuccess(result.taskId ? '已确认，生成任务已提交' : '已确认，Agent 正在继续执行')
    } catch (error) {
      if (!accept && error instanceof ApiError && error.code === 'CONFIRMATION_REQUIRED') {
        // The approval was already consumed, removed, or expired. It cannot
        // become actionable again, so dismiss the stale local card instead of
        // restoring it to pending and locking the composer.
        patchConfirmation(confirmation.actionId, 'rejected')
        toastSuccess('过期确认已移除')
        return
      }
      if (
        accept &&
        error instanceof ApiError &&
        (error.code === 'VERSION_CONFLICT' || error.code === 'CONFIRMATION_REQUIRED')
      ) {
        try {
          // A confirmation binds the canvas version and can only be consumed
          // once. A stale locally cached card must not keep the composer locked.
          // Best-effort cancellation is enough here: an already consumed or
          // expired approval is safe to remove from the local queue as well.
          try {
            await api(`/agent/sessions/${sessionId}/confirmations/${confirmation.actionId}`, {
              method: 'POST',
              body: JSON.stringify({
                approvalToken: confirmation.approvalToken,
                accept: false,
              }),
            })
          } catch (cancelError) {
            if (!(cancelError instanceof ApiError && cancelError.code === 'CONFIRMATION_REQUIRED')) throw cancelError
          }
          patchConfirmation(confirmation.actionId, 'rejected')
          await loadSessionQuiet(sessionId, undefined, sessionEpochRef.current, true)
          notifyCanvasChanged()
          toastError(
            error.code === 'VERSION_CONFLICT'
              ? '画布已更新，过期确认已取消；请基于当前画布重新发送生成请求'
              : '确认已失效，已刷新为最新待确认项',
          )
          return
        } catch (cancelError) {
          patchConfirmation(confirmation.actionId, 'pending')
          toastError((cancelError as Error).message || '画布版本已变化，请先取消过期确认后重新发送')
          return
        }
      }
      patchConfirmation(confirmation.actionId, 'pending')
      toastError((error as Error).message || '确认操作失败')
    } finally {
      if (confirmingActionRef.current === confirmation.actionId) confirmingActionRef.current = null
    }
  }

  // A reconnect can replay an old `confirmation_required` event after the
  // authoritative message snapshot already records that same action as
  // accepted/rejected. Terminal persisted state must always win over replayed
  // pending cards, otherwise a completed generation is offered again.
  const terminalConfirmationActionIds = new Set(
    messages.flatMap((item) => {
      const confirmation = item.meta?.confirmation
      return confirmation && (confirmation.status === 'accepted' || confirmation.status === 'rejected')
        ? [confirmation.actionId]
        : []
    }),
  )
  const pendingConfirmations = messages
    .map((item) => item.meta?.confirmation)
    .filter((confirmation): confirmation is AgentConfirmation =>
      isActionableConfirmation(confirmation) &&
      !terminalConfirmationActionIds.has(confirmation.actionId),
    )
  // A session can contain a locally stale card while the Agent has already
  // planned its next action. The latest card is the only actionable one.
  const activeConfirmation = pendingConfirmations.at(-1)
  const hasPendingConfirmation = pendingConfirmations.length > 0

  const send = async () => {
    const content = input.trim()
    if (!content || busy) return
    if (hasPendingConfirmation) {
      toastError('请先在确认卡片中确认或取消当前高风险操作')
      return
    }
    setBusy(true)
    let sid: string | number
    try {
      sid = await ensureSession()
    } catch (e) {
      toastError((e as Error).message)
      setBusy(false)
      return
    }
    const sendSessionEpoch = sessionEpochRef.current
    let requestCanvasVersion = canvas?.canvas.version
    if (canvas?.canvas.id != null) {
      try {
        const latestCanvas = await api<{ canvas?: { version?: unknown }; version?: unknown }>(
          `/canvases/${canvas.canvas.id}`,
        )
        requestCanvasVersion = resolveAgentCanvasVersion(latestCanvas, requestCanvasVersion)
      } catch (e) {
        toastError((e as Error).message || '无法读取当前画布版本，请刷新后重试')
        setBusy(false)
        return
      }
    }
    const sentNodeRefs = composerRefs.filter((ref) => ref.kind === 'node')
    const sentNodeIds = [...new Set(sentNodeRefs.map((ref) => ref.id))]
    const nodeReferences = nodeReferencesForComposer(sentNodeRefs, useCanvasStore.getState().nodes)
    const sentSkillId = selectedSkill ? String(selectedSkill.id) : undefined
    const isFirstUserTurn = !agentEventStateRef.current.messages.some((m) => m.role === 'user')
    setInput('')
    setSelectedSkill(null)
    if (sentSkillId) {
      setComposerRefs((prev) => prev.filter((ref) => ref.id !== `skill:${sentSkillId}`))
    }
    setSuggestions([])
    // 对话历史命名：首条用户语句
    if (
      isFirstUserTurn &&
      (!sessionTitle || sessionTitle === '新对话' || sessionTitle === '画布对话' || sessionTitle.startsWith('对话 '))
    ) {
      setSessionTitle(content.slice(0, 48))
    }
    const turnId = `turn-${Date.now()}`
    turnIdRef.current = turnId
    // 本轮一开始就标记为「需要逐字」，避免等事件时已同批贴全文
    setTypingTurnId(turnId)
    setMessages((m) => {
      const next = [
        ...m,
        {
          id: Date.now(),
          role: 'user',
          type: 'text',
          content,
          meta: { selectedNodeIds: sentNodeIds, nodeReferences, selectedSkillId: sentSkillId },
        },
        {
          id: turnId,
          role: 'assistant',
          type: 'text',
          content: '',
          meta: { executionSteps: [] as ExecutionStep[] },
        },
      ]
      agentEventStateRef.current = {
        messages: next,
        seenEventIds: new Set(),
        runStatus: 'running',
        pendingMessageId: turnId,
        messageIdByRun: new Map(),
        persistedAssistantRunIds: new Set(),
      }
      return next
    })
    const ac = new AbortController()
    sendAbortRef.current = ac
    let confirmationRehydrate: Promise<void> | null = null
    const rehydrateAfterConfirmation = () => {
      if (!confirmationRehydrate) {
        confirmationRehydrate = loadSessionQuiet(sid, undefined, sendSessionEpoch, true)
          .then(() => undefined)
          .catch((error) => {
            toastError((error as Error).message || '确认状态刷新失败')
          })
      }
    }
    try {
      if (ac.signal.aborted) return
      const res = await authedFetch(`/agent/sessions/${sid}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': globalThis.crypto.randomUUID(),
        },
        body: JSON.stringify({
          content,
          selectedNodeIds: sentNodeIds,
          canvasId: canvas?.canvas.id != null ? String(canvas.canvas.id) : undefined,
          canvasVersion: requestCanvasVersion,
          modelId: agentModel,
          selectedSkillId: sentSkillId,
        }),
        signal: ac.signal,
      })
      if (!res.ok) throw new Error(`Agent 请求失败 (${res.status})`)
      setComposerRefs((prev) => consumeSentNodeRefs(prev, new Set(sentNodeIds)))
      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (reader) {
        if (ac.signal.aborted) {
          await reader.cancel().catch(() => undefined)
          break
        }
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          if (ac.signal.aborted || sendSessionEpoch !== sessionEpochRef.current || String(activeSessionIdRef.current) !== String(sid)) {
            break
          }
          const dataLine = part.split('\n').find((l) => l.startsWith('data: '))
          if (!dataLine) continue
          // A reconnecting proxy can leave one partial/invalid SSE frame in
          // the stream. Ignore that frame and continue consuming the next
          // authoritative event rather than aborting the whole Agent turn and
          // surfacing a raw JSON parser error to the creator.
          let ev: Record<string, unknown>
          try {
            ev = parseJsonPreserveIds(dataLine.slice(6)) as Record<string, unknown>
          } catch {
            continue
          }
           if (ev.type === 'done') continue
           processStreamEvent(ev)
           if (shouldReloadSessionAfterStream([ev])) rehydrateAfterConfirmation()
          // 让出主线程，避免一整包事件被 React 批成一次渲染
          await new Promise<void>((r) => setTimeout(r, 0))
        }
      }
      if (ac.signal.aborted || sendSessionEpoch !== sessionEpochRef.current || String(activeSessionIdRef.current) !== String(sid)) return
      // The terminal SSE envelope can be coalesced or omitted by a proxy. Rehydrate
      // the authoritative session after every normal stream completion so pending
      // confirmations and terminal messages cannot be lost in local reducer state.
      if (confirmationRehydrate) await confirmationRehydrate
      else await loadSessionQuiet(sid, undefined, sendSessionEpoch, true)
      notifyCanvasChanged()
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      toastError((e as Error).message)
    } finally {
      if (sendAbortRef.current === ac) sendAbortRef.current = null
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <aside
        aria-hidden
        className="pointer-events-none relative z-30 h-full flex-none overflow-hidden"
        style={{ width: 0 }}
      />
    )
  }

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        'relative z-30 h-full flex-none bg-[var(--canvas-surface)] text-[var(--canvas-text)] shadow-xl shadow-black/20 backdrop-blur-md',
        resizing ? 'duration-0' : 'transition-[width] duration-200 ease-out',
        'overflow-visible border-l border-[var(--canvas-border)]',
      )}
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        className={cn(
          'group absolute -left-1.5 top-0 z-40 h-full w-3 cursor-col-resize touch-none select-none',
          resizing && 'is-resizing',
        )}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={() => setWidth(AGENT_PANEL_DEFAULT_WIDTH)}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-full w-[3px] -translate-x-1/2 bg-transparent transition-colors group-hover:bg-[var(--canvas-border-strong)] group-active:bg-[var(--canvas-border-strong)]"
        />
      </div>
      <div className="flex h-full flex-col" style={{ width }}>
      {tab !== 'skills' && tab !== 'drama' && (
      <div className="flex items-center justify-between px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#111] text-white">
            <Bot size={16} />
          </span>
          <div>
            <p className="max-w-[140px] truncate text-[14px] font-bold text-[#111]">{sessionTitle}</p>
            <p className="text-[11px] text-[#999]">Paper Agent</p>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {tab === 'chat' ? (
            <button
              type="button"
              onClick={() => void ensureSession(true)
                .then(() => toastSuccess('已创建新对话'))
                .catch((e) => {
                  if ((e as Error).name !== 'AbortError') toastError((e as Error).message)
                })}
              title="新对话"
              className="rounded-full p-2 text-[#888] transition hover:bg-black/[0.04]"
            >
              <SquarePlus size={16} />
            </button>
          ) : (
            <NavIcon tab="chat" current={tab} set={setTab} icon={Bot} label="对话" />
          )}
          <NavIcon tab="skills" current={tab} set={setTab} icon={BookOpen} label="Skills" />
          <NavIcon tab="drama" current={tab} set={setTab} icon={Clapperboard} label="短剧资产" />
          <NavIcon tab="history" current={tab} set={setTab} icon={History} label="历史" />
          <NavIcon tab="usage" current={tab} set={setTab} icon={BarChart3} label="用量" />
          <NavIcon tab="pref" current={tab} set={setTab} icon={Settings2} label="偏好" />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-1 rounded-full p-2 text-[#888] hover:bg-black/[0.04]"
          >
            <X size={16} />
          </button>
        </div>
      </div>
      )}

      {tab === 'chat' && (
        <div className="flex min-h-0 flex-1 flex-col bg-[var(--canvas-surface)]">
          {activeConfirmation && (
            <div className="shrink-0 border-y border-[var(--canvas-border)] bg-[var(--canvas-surface-muted)] px-3 py-2">
              <AgentConfirmationCard
                confirmation={activeConfirmation}
                queuedCount={pendingConfirmations.length - 1}
                onConfirm={(accept) => void confirmAction(activeConfirmation, accept)}
              />
            </div>
          )}
          <div ref={chatScrollRef} className="relative min-h-0 flex-1 overflow-y-auto bg-transparent px-3.5 pb-8 pt-3.5">
            {composerRefs.some((ref) => ref.kind === 'node') && (
              <p className="mb-3 rounded-full bg-[#f2f2f2] px-3 py-1.5 text-[11px] font-semibold text-[#555]">
                已加入 {composerRefs.filter((ref) => ref.kind === 'node').length} 个参考节点，将随下一条消息发送
              </p>
            )}

            {messages.length === 0 && (
              <div className="flex h-full min-h-[220px] items-center justify-center px-4 py-8 text-center">
                <div className="w-full max-w-[560px]">
                  <img alt="" className="mx-auto mb-9 h-32 w-auto object-contain" src="/paper-agent.svg" />
                  <p className="text-sm font-medium text-[var(--canvas-text-strong)]">Paper Agent</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-[var(--canvas-muted)]">
                    让 Paper Agent 理解整张画布的脉络，把零散灵感推进为清晰、可执行的创作方案。
                  </p>
                  <div className="-mx-2 mt-4 grid grid-cols-[repeat(auto-fit,minmax(92px,1fr))] gap-2">
                    {SUGGESTIONS.map(({ icon: Icon, text }) => (
                      <button
                        key={text}
                        type="button"
                        onClick={() => setInput(text)}
                        className="flex min-h-24 flex-col items-start justify-center gap-2 rounded-xl border border-[var(--canvas-border)] bg-[var(--canvas-surface-muted)] px-2.5 py-3 text-left text-xs leading-snug text-[var(--canvas-text)] transition-colors hover:border-[var(--canvas-border-strong)] hover:bg-[var(--canvas-hover)]"
                      >
                        <Icon size={16} strokeWidth={2} className="size-4 flex-none self-center text-[var(--canvas-muted)]" />
                        <span>{text}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {messages.filter(isChatVisibleMessage).map((m) => (
              <div key={m.id} className={`mb-4 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={cn(
                    'max-w-[94%] px-1 py-1',
                    m.role === 'user'
                      ? 'rounded-[18px] whitespace-pre-line bg-[#efefef] px-3.5 py-2.5 text-[15px] leading-[1.65] text-[#111]'
                      : 'w-full min-w-0 text-[15px] leading-[1.7] text-[#222]',
                  )}
                >
                  {m.role === 'assistant' ? (
                    <>
                      <AgentTurnTimeline
                        steps={m.meta?.executionSteps ?? []}
                        content={m.content}
                        streaming={m.id === typingTurnId && busy}
                        animateSpeech={m.id === typingTurnId}
                        streamComplete={!busy && m.id === typingTurnId}
                        onRevealDone={() => {
                          setTypingTurnId((cur) => (cur === m.id ? null : cur))
                        }}
                      />
                      <AgentTaskBadge status={m.meta?.taskStatus?.status} taskId={m.meta?.taskStatus?.taskId} />
                      {m.meta?.nextActions && m.meta.nextActions.length > 0 && (
                        <AgentNextActions
                          actions={m.meta.nextActions}
                          onPick={(text) => {
                            setInput(text)
                          }}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <AgentNodeReferenceCards references={m.meta?.nodeReferences ?? []} />
                      <div className={m.meta?.nodeReferences?.length ? 'mt-2' : undefined}>{m.content}</div>
                    </>
                  )}
                </div>
              </div>
            ))}

            {suggestions.length > 0 && (
              <div className="mb-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-bold text-[#333]">建议卡片</p>
                  <button
                    type="button"
                    onClick={() => void addSuggestionsToCanvas(suggestions)}
                    className="text-[11px] font-bold text-[#111] underline underline-offset-2"
                  >
                    全部添加到画布
                  </button>
                </div>
                {suggestions.map((s, idx) => (
                  <div key={`${s.title ?? 's'}-${idx}`} className="rounded-[16px] border border-black/8 bg-white p-3">
                    <p className="text-[12px] font-bold text-[#111]">{s.title || `建议 ${idx + 1}`}</p>
                    <p className="mt-1 text-[12px] leading-relaxed text-[#555]">{s.content || s.prompt || ''}</p>
                    <button
                      type="button"
                      onClick={() => void addSuggestionsToCanvas([s])}
                      className="mt-2 text-[11px] font-bold text-[#111] underline underline-offset-2"
                    >
                      添加到画布
                    </button>
                  </div>
                ))}
              </div>
            )}

            {busy && (
              <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[#888]">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                正在工作
              </p>
            )}
            <div ref={bottomRef} />
          </div>

          <div className="shrink-0">
            <form
              className="shrink-0 px-3 pb-3 pt-0"
              onSubmit={(e) => {
                e.preventDefault()
                if (!busy) void send()
              }}
            >
              <div className="relative rounded-lg border border-[var(--canvas-border)] bg-[color-mix(in_srgb,var(--canvas-surface)_88%,var(--canvas-surface-muted))] shadow-[0_8px_24px_rgba(15,23,42,0.08)] transition-colors focus-within:border-[var(--canvas-border-strong)] focus-within:ring-1 focus-within:ring-[var(--canvas-border)]">
                <AgentComposerBar
                  refs={composerRefs}
                  nodes={canvasNodes}
                  onRemove={(ref) => {
                    if (ref.kind === 'skill' && selectedSkill && ref.id === `skill:${String(selectedSkill.id)}`)
                      setSelectedSkill(null)
                    setComposerRefs((prev) => prev.filter((x) => !(x.kind === ref.kind && x.id === ref.id)))
                  }}
                />
                {skillCommandQuery != null && (
                  <SkillCommandPicker
                    items={skillCommandItems}
                    loading={skillPickerLoading}
                    onSelect={(skill) => {
                      setSelectedSkill(skill)
                      setComposerRefs((prev) =>
                        upsertRefs(prev, [{ id: `skill:${String(skill.id)}`, kind: 'skill', title: skill.name }]),
                      )
                      setInput('')
                    }}
                  />
                )}
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      if (!busy) void send()
                    }
                  }}
                  rows={3}
                  placeholder={
                    hasPendingConfirmation
                      ? '可先编辑下一步需求；请先处理上方待确认生成'
                      : '描述创意或需求，@ 引用参考，/ 选择 Skill'
                  }
                  disabled={busy}
                  className="block min-h-[72px] w-full resize-none bg-transparent px-3 pb-12 pt-3 text-[13px] leading-relaxed text-[var(--canvas-text)] outline-none placeholder:text-[var(--canvas-muted-soft)] disabled:opacity-60"
                />
                <div className="absolute bottom-2 left-2 right-2 z-10 flex min-w-0 items-center gap-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-0.5">
                      <button
                        type="button"
                        aria-label="添加 Skill"
                        title="添加 Skill"
                        onClick={() => setTab('skills')}
                        className="relative flex size-8 shrink-0 items-center justify-center rounded-lg text-[var(--canvas-muted)] transition-colors hover:bg-[var(--canvas-hover)] hover:text-[var(--canvas-text)]"
                      >
                        <Puzzle size={16} strokeWidth={2} className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label="生成偏好"
                        title="生成偏好"
                        onClick={() => setTab('pref')}
                        className="relative flex size-8 items-center justify-center rounded-lg text-[var(--canvas-muted)] transition-colors hover:bg-[var(--canvas-hover)] hover:text-[var(--canvas-text)]"
                      >
                        <SlidersHorizontal size={16} strokeWidth={2} className="size-4" />
                      </button>
                    </div>
                  </div>
                  <div className="min-w-0 shrink">
                    <ModelPicker
                      composer
                      models={
                        textModels.length
                          ? textModels
                          : [
                              {
                                name: agentModel,
                                displayName: agentModel,
                                enabled: true,
                                basePrice: 0,
                                modelType: 'text',
                                id: agentModel,
                              } as ModelInfo,
                            ]
                      }
                      value={agentModel}
                      onChange={onAgentModelChange}
                    />
                  </div>
                  {busy ? (
                    <button
                      type="button"
                      onClick={stop}
                      title="停止"
                      aria-label="停止"
                      className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--canvas-active)] text-[var(--canvas-active-text)] transition-colors"
                    >
                      <Square size={12} strokeWidth={2.5} />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!input.trim() || hasPendingConfirmation}
                      aria-label="发送"
                      className={cn(
                        'inline-flex size-7 items-center justify-center rounded-lg transition-colors',
                        input.trim() && !hasPendingConfirmation
                          ? 'bg-[var(--canvas-active)] text-[var(--canvas-active-text)] hover:opacity-90'
                          : 'cursor-not-allowed bg-[var(--canvas-surface-muted)] text-[var(--canvas-muted-soft)]',
                      )}
                    >
                      <Send size={14} strokeWidth={2} className="size-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {tab === 'pref' && <PreferencesTab />}
      {tab === 'skills' && (
        <SkillsPanel
          sessionId={sessionId}
          onClose={() => setOpen(false)}
          onBackToChat={() => setTab('chat')}
          onApplied={(name) => {
            if (!name) return
            setComposerRefs((prev) => upsertRefs(prev, [{ id: `skill:${name}`, kind: 'skill', title: name }]))
          }}
        />
      )}
      {tab === 'drama' && (
        <DramaAssetsTab
          canvasId={canvas?.canvas.id}
          canvasVersion={canvas?.canvas.version}
          onBack={() => setTab('chat')}
        />
      )}
      {tab === 'usage' && <UsageTab sessionId={sessionId} />}
      {tab === 'history' && (
        <HistoryTab
          sessionId={sessionId}
          canvasId={canvas?.canvas.id}
          onOpenSession={loadSession}
          onImported={(id) => void loadSession(id)}
        />
      )}
      </div>
    </aside>
  )
}

function AgentConfirmationCard({
  confirmation,
  queuedCount = 0,
  onConfirm,
}: {
  confirmation: AgentConfirmation
  queuedCount?: number
  onConfirm: (accept: boolean) => void
}) {
  const pending = confirmation.status === 'pending'
  const submitting = confirmation.status === 'submitting'
  const total = confirmation.estimatedTotalCost ?? confirmation.estimatedCost ?? 0
  const summary = confirmation.tool ? `确认${toolLabel(confirmation.tool)}` : confirmation.summary
  const statusText = submitting ? '正在提交确认…' : '待确认生成'

  return (
    <section className="rounded-lg border border-[var(--canvas-border-strong)] bg-[var(--canvas-surface)] px-2.5 py-2 text-[11px] text-[var(--canvas-text)] shadow-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--canvas-text-muted)]" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{statusText}{queuedCount > 0 ? `，还有 ${queuedCount} 项排队` : ''}</p>
          <p className="mt-0.5 truncate text-[var(--canvas-text-muted)]">{summary}</p>
          <p className="mt-0.5 text-[var(--canvas-text-muted)]">预计 {total} 点{confirmation.affectedNodeCount ? ` · ${confirmation.affectedNodeCount} 个节点` : ''}</p>
        </div>
        {pending || submitting ? (
          <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            disabled={submitting}
            onClick={() => onConfirm(false)}
            className="rounded-md border border-[var(--canvas-border)] px-2 py-1 font-medium text-[var(--canvas-text-muted)] transition hover:bg-[var(--canvas-hover)] disabled:cursor-wait disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onConfirm(true)}
            className="rounded-md bg-[var(--canvas-active)] px-2 py-1 font-medium text-[var(--canvas-active-text)] transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          >
            确认执行
          </button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function NavIcon({
  tab,
  current,
  set,
  icon: Icon,
  label,
}: {
  tab: 'chat' | 'pref' | 'skills' | 'usage' | 'history' | 'drama'
  current: string
  set: (t: 'chat' | 'pref' | 'skills' | 'usage' | 'history' | 'drama') => void
  icon: React.ComponentType<{ size?: number }>
  label: string
}) {
  return (
    <button
      type="button"
      onClick={() => set(tab)}
      title={label}
      className={cn(
        'rounded-full p-2 transition',
        current === tab ? 'bg-black/8 text-[#111]' : 'text-[#888] hover:bg-black/[0.04]',
      )}
    >
      <Icon size={16} />
    </button>
  )
}

function PreferencesTab() {
  const preferences = useAuth((s) => s.preferences)
  const updatePreferences = useAuth((s) => s.updatePreferences)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [pref, setPref] = useState({
    text: resolvePreferredTextModel(preferences?.defaultTextModel),
    image: preferences?.defaultImageModel || 'agnes-image-2.5-flash',
    video: preferences?.defaultVideoModel || 'agnes-video-v2.0',
    resolution: preferences?.defaultResolution || '1024x1024',
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void api<{ items: ModelInfo[] }>('/models')
      .then((r) => setModels(r.items))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    setPref({
      text: resolvePreferredTextModel(preferences?.defaultTextModel),
    image: preferences?.defaultImageModel || 'agnes-image-2.5-flash',
      video: preferences?.defaultVideoModel || 'agnes-video-v2.0',
      resolution: preferences?.defaultResolution || '1024x1024',
    })
  }, [preferences])

  const options = (type: string) =>
    models.filter((m) => m.modelType === type && !/兼容别名|已停用/.test(String(m.description || '')))

  return (
    <div className="flex-1 space-y-3 overflow-auto p-4">
      <p className="text-[13px] font-bold text-[#111]">偏好设置</p>
      <p className="text-[11px] leading-relaxed text-[#888]">
        Agent 对话默认走 DeepSeek；下方为节点生成默认模型。
      </p>
      {(
        [
          ['text', '文本模型'],
          ['image', '图片模型'],
          ['video', '视频模型'],
        ] as const
      ).map(([key, label]) => (
        <div key={key}>
          <p className="mb-1 text-[12px] font-bold text-[#555]">{label}</p>
          <ModelPicker
            models={
              options(key).length
                ? options(key)
                : [{ name: pref[key], displayName: pref[key], enabled: true, basePrice: 0, modelType: key, id: pref[key] } as ModelInfo]
            }
            value={pref[key]}
            onChange={(name) => setPref({ ...pref, [key]: name })}
          />
        </div>
      ))}
      <label className="block text-[12px] font-bold text-[#555]">
        默认分辨率
        <select
          className="mt-1 h-10 w-full rounded-lg border border-black/10 bg-white px-2 text-[13px]"
          value={pref.resolution}
          onChange={(e) => setPref({ ...pref, resolution: e.target.value })}
        >
          {['512x512', '1024x1024', '1280x720', '1920x1080'].map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      <button
        disabled={saving}
        onClick={() => {
          setSaving(true)
          void updatePreferences({
            defaultTextModel: pref.text,
            defaultImageModel: pref.image,
            defaultVideoModel: pref.video,
            defaultResolution: pref.resolution,
          })
            .then(() => toastSuccess('偏好已保存'))
            .catch((e) => toastError((e as Error).message))
            .finally(() => setSaving(false))
        }}
        className="h-10 w-full rounded-full bg-[#111] text-[13px] font-bold text-white disabled:opacity-50"
      >
        {saving ? '保存中…' : '保存偏好'}
      </button>
      <div className="rounded-[18px] bg-[#f7f7f7] p-3">
        <p className="mb-2 text-[12px] font-bold text-[#555]">长期记忆</p>
        <Memories />
      </div>
    </div>
  )
}

function Memories() {
  const [items, setItems] = useState<MemoryView[]>([])
  useEffect(() => {
    void api<{ items: MemoryView[] }>('/memories')
      .then((r) => setItems(r.items))
      .catch(() => undefined)
  }, [])
  return (
    <div className="space-y-1.5">
      {items.length === 0 && <p className="text-[12px] text-[#999]">暂无长期记忆</p>}
      {items.map((m) => (
        <div key={m.id} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-[12px]">
          <span className="flex-1 text-[#555]">{m.content}</span>
          <button
            onClick={() =>
              void api(`/memories/${m.id}`, { method: 'DELETE' }).then(() => setItems((prev) => prev.filter((x) => x.id !== m.id)))
            }
            className="text-red-400 hover:text-red-600"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

function UsageTab({ sessionId }: { sessionId: string | number | null }) {
  const [usage, setUsage] = useState<{ tokenTotal: number; pointsUsed: number; modelUsage: Record<string, number> } | null>(null)
  useEffect(() => {
    if (!sessionId) return
    void api(`/agent/sessions/${sessionId}/usage`)
      .then((u) => setUsage(u as typeof usage))
      .catch(() => undefined)
  }, [sessionId])
  return (
    <div className="flex-1 space-y-3 overflow-auto p-4">
      <p className="text-[13px] font-bold text-[#111]">当前对话用量</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-[18px] bg-[#f7f7f7] p-3 text-center">
          <p className="text-[22px] font-black text-[#111]">{usage?.tokenTotal ?? 0}</p>
          <p className="text-[11px] text-[#999]">Token 总量</p>
        </div>
        <div className="rounded-[18px] bg-[#f7f7f7] p-3 text-center">
          <p className="text-[22px] font-black text-[#111]">{usage?.pointsUsed ?? 0}</p>
          <p className="text-[11px] text-[#999]">点数消耗</p>
        </div>
      </div>
      <div>
        <p className="mb-1 text-[12px] font-bold text-[#555]">各模型消耗</p>
        {Object.entries(usage?.modelUsage ?? {}).map(([m, t]) => (
          <div key={m} className="flex items-center justify-between rounded-lg bg-[#f7f7f7] px-2 py-1.5 text-[12px]">
            <span className="font-semibold text-[#555]">{m}</span>
            <span className="text-[#999]">{t} tokens</span>
          </div>
        ))}
      </div>
    </div>
  )
}

type HistorySession = { sessionId: string | number; title: string; updatedAt?: string }

export function AgentHistorySessionItem({
  session,
  active,
  onOpen,
}: {
  session: HistorySession
  active: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full rounded-[16px] border px-2.5 py-2 text-left text-[12px] ${
        active ? 'border-[#111] bg-[#f7f7f7]' : 'border-black/6 hover:bg-[#f7f7f7]'
      }`}
    >
      <p className="font-bold text-[#333]">{session.title}</p>
      <p className="text-[#999]">{active ? '当前会话' : '历史会话'}</p>
    </button>
  )
}

function HistoryTab({
  sessionId,
  canvasId,
  onOpenSession,
  onImported,
}: {
  sessionId: string | number | null
  canvasId?: string | number
  onOpenSession: (id: string | number, title?: string) => void
  onImported: (id: string | number) => void
}) {
  const [sessions, setSessions] = useState<HistorySession[]>([])
  const [fragments, setFragments] = useState<Array<{ id: number; title: string }>>([])
  const reload = () => {
    const q = canvasId != null ? `?canvasId=${encodeURIComponent(String(canvasId))}` : ''
    void api<{ items: typeof sessions }>(`/agent/sessions${q}`)
      .then((r) => setSessions(r.items))
      .catch(() => undefined)
    void api<{ items: typeof fragments }>('/agent/fragments')
      .then((r) => setFragments(r.items))
      .catch(() => undefined)
  }
  useEffect(() => {
    reload()
  }, [canvasId])
  const saveFragment = async () => {
    if (!sessionId) return
    try {
      await api(`/agent/sessions/${sessionId}/fragments`, {
        method: 'POST',
        body: JSON.stringify({ title: '片段 ' + new Date().toLocaleTimeString() }),
      })
      toastSuccess('会话片段已保存，可跨画布复用')
      reload()
    } catch (e) {
      toastError((e as Error).message)
    }
  }
  return (
    <div className="flex-1 space-y-3 overflow-auto p-3">
      <button
        onClick={() => void saveFragment()}
        className="flex h-9 w-full items-center justify-center gap-1 rounded-full bg-[#111] text-[12px] font-bold text-white"
      >
        <Plus size={13} /> 保存当前会话片段
      </button>
      <p className="text-[12px] font-bold text-[#555]">对话历史</p>
      {sessions.map((s) => (
        <AgentHistorySessionItem
          key={s.sessionId}
          session={s}
          active={String(s.sessionId) === String(sessionId)}
          onOpen={() => onOpenSession(s.sessionId, s.title)}
        />
      ))}
      <p className="text-[12px] font-bold text-[#555]">可复用片段</p>
      {fragments.map((f) => (
        <div key={f.id} className="flex items-center gap-2 rounded-[16px] bg-[#f7f7f7] px-2.5 py-2 text-[12px]">
          <span className="flex-1 font-semibold text-[#555]">{f.title}</span>
          <button
            type="button"
            onClick={() => {
              void api<{ sessionId: string | number }>(`/agent/fragments/${f.id}/import`, {
                method: 'POST',
                body: JSON.stringify({ canvasId }),
              })
                .then((r) => {
                  toastSuccess('片段已导入当前画布')
                  onImported(r.sessionId)
                })
                .catch((e) => toastError((e as Error).message))
            }}
            className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-[#111] shadow-sm"
          >
            导入
          </button>
        </div>
      ))}
    </div>
  )
}
