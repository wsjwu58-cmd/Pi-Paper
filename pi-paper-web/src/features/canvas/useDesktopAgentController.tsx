import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { AgentPanelDesktopAdapter } from './AgentPanel'
import { isChatVisibleMessage } from './agentEventHandlers'
import {
  friendlyAgentErrorMessage,
  isAgentRunActive,
  reduceAgentEvent,
  restoreDesktopAgentEventState,
  setConfirmationStatus,
  upsertDesktopUserMessage,
  type AgentEventState,
} from './agentEventEnvelope'
import { isActionableConfirmation } from './confirmationState'
import type { AgentChatMsg, AgentConfirmation } from './agentTypes'
import type { DesktopAgnesModelCatalog, DesktopAgentMessage, DesktopAgentModelCatalog, DesktopAgentSession, DesktopAgentSkill, DesktopProviderModel } from '@/desktop/desktop-bridge'
import type { ModelInfo, SkillView } from '@/lib/types'
import { useCanvasStore } from './canvasStore'
import { nodeReferencesForComposer, refFromNode, type ComposerRef } from './agentNodeReferences'

const bridge = window.vibepaperDesktop

function toChatMessages(messages: DesktopAgentMessage[]): AgentChatMsg[] {
  return messages.map((message, index) => ({
    id: message.id ?? `${message.createdAt}-${index}`,
    role: message.role,
    type: message.type ?? 'text',
    content: message.content,
    meta: message.meta ?? {},
  })).filter(isChatVisibleMessage)
}

function toSkillView(skill: DesktopAgentSkill): SkillView {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    source: skill.source,
    category: skill.category,
    version: skill.version,
    enabled: skill.enabled,
  }
}

function toAgentPickerModel(model: DesktopProviderModel): ModelInfo {
  return {
    id: model.id,
    name: model.id,
    modelType: model.modelType,
    displayName: model.displayName,
    provider: model.providerId,
    enabled: true,
    basePrice: 0,
  }
}

function createEventState(messages: AgentChatMsg[]): AgentEventState {
  return {
    messages,
    seenEventIds: new Set(),
    runStatus: 'running',
    runStatusById: new Map(),
    messageIdByRun: new Map(),
    assistantTextByRun: new Map(),
    persistedAssistantRunIds: new Set(messages.flatMap((message) =>
      message.role === 'assistant' && message.content.trim() && message.meta?.runId ? [message.meta.runId] : [],
    )),
  }
}

function normalizeError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ''
  if (message.includes('CLOUD_CREDENTIAL_MISSING')) return uiText("当前 Agent 模型凭据不可用，请在模型设置中配置对应提供方。")
  if (message.includes('MODEL_UNAVAILABLE')) return uiText("当前 Agent 模型未配置或不支持工具调用，请选择一个已启用的文本模型。")
  if (message.includes('AGENT_SESSION_MODEL_MISMATCH')) return uiText("会话模型已变更，请重新选择会话后再发送。")
  if (message.includes('SESSION_BUSY')) return uiText("当前会话正在运行，完成或停止后再切换模型。")
  if (message.includes('AGENT_CANVAS_CHANGED')) return uiText("画布已更新，请重新发送后再确认。")
  if (message.includes('AGENT_PROJECT_CHANGED')) return uiText("当前本地项目已切换，请重新打开画布。")
  if (message.includes('AGENT_RUN_ALREADY_PROCESSED')) return uiText("这条消息已处理，请检查会话记录后再继续。")
  if (message.includes('AGENT_MESSAGE_INVALID')) return uiText("消息不能为空，且不能超过 20,000 个字符。")
  return friendlyAgentErrorMessage(message || uiText("本地 Agent 操作失败。"))
}

export function useDesktopAgentController({
  projectId,
  canvasId,
  flushCanvas,
  onCanvasChanged,
}: {
  projectId?: string
  canvasId: string
  flushCanvas: () => Promise<void>
  onCanvasChanged: () => void
}): AgentPanelDesktopAdapter & {
  onSendWithReferences: (input: { selectedNodeIds: string[]; selectedSkillId?: string }) => Promise<boolean>
  settingsOpen: boolean
  closeSettings: () => void
  settingsDialog: React.ReactNode
} {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<DesktopAgentSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentChatMsg[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [agnesCatalog, setAgnesCatalog] = useState<DesktopAgnesModelCatalog | null>(null)
  const [agentModelCatalog, setAgentModelCatalog] = useState<DesktopAgentModelCatalog | null>(null)
  const [selectedModelId, setSelectedModelId] = useState('')
  const [skills, setSkills] = useState<SkillView[]>([])
  const [loadedSkillIds, setLoadedSkillIds] = useState<string[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const queryClient = useQueryClient()
  const activeSessionRef = useRef<string | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const activeRunSessionIdRef = useRef<string | null>(null)
  const eventStatesRef = useRef(new Map<string, AgentEventState>())
  const eventSequencesRef = useRef(new Map<string, number>())
  const requestEpochRef = useRef(0)
  const sendingRef = useRef(false)
  const confirmingActionRef = useRef<string | null>(null)
  const skillRequestEpochRef = useRef(0)

  const agentModelOptions = (agentModelCatalog?.models ?? []).map(toAgentPickerModel)
  const providerNames = agentModelCatalog?.providerNames ?? {}
  const selectedAgentModel = agentModelCatalog?.models.find((model) => model.id === selectedModelId)
  const selectedModelAvailable = selectedAgentModel !== undefined

  const loadSkills = useCallback(async (sessionId?: string | null) => {
    if (!bridge || !projectId) {
      setSkills([])
      setLoadedSkillIds([])
      return
    }
    const epoch = ++skillRequestEpochRef.current
    setSkillsLoading(true)
    try {
      const result = await bridge.listAgentSkills(projectId, sessionId ?? undefined)
      if (epoch !== skillRequestEpochRef.current) return
      setSkills(result.items.map(toSkillView))
      setLoadedSkillIds(result.loadedSkillIds)
    } catch (cause) {
      if (epoch === skillRequestEpochRef.current) {
        setSkills([])
        setLoadedSkillIds([])
        setError(normalizeError(cause))
      }
    } finally {
      if (epoch === skillRequestEpochRef.current) setSkillsLoading(false)
    }
  }, [projectId])

  const loadSession = useCallback(async (sessionId: string, epoch: number) => {
    if (!bridge || !projectId) return
    if (bridge.getAgentSessionSnapshot) {
      const snapshot = await bridge.getAgentSessionSnapshot(projectId, sessionId)
      const persistedMessages = toChatMessages(snapshot.messages)
      const cachedState = eventStatesRef.current.get(sessionId)
      const state = restoreDesktopAgentEventState(persistedMessages, snapshot.events, cachedState)
      if (epoch !== requestEpochRef.current) return
      eventStatesRef.current.set(sessionId, state)
      eventSequencesRef.current.set(sessionId, snapshot.lastEventSeq)
      setMessages(state.messages)
      sendingRef.current = isAgentRunActive(state)
      if (sendingRef.current) {
        activeRunIdRef.current = state.lastEventRunId ?? null
        activeRunSessionIdRef.current = sessionId
      } else if (activeRunSessionIdRef.current === sessionId) {
        activeRunIdRef.current = null
        activeRunSessionIdRef.current = null
      }
      setSending(sendingRef.current)
    } else {
      const loaded = toChatMessages(await bridge.getAgentMessages(projectId, sessionId))
      if (epoch !== requestEpochRef.current) return
      const state = createEventState(loaded)
      eventStatesRef.current.set(sessionId, state)
      eventSequencesRef.current.set(sessionId, 0)
      setMessages(loaded)
      sendingRef.current = isAgentRunActive(state)
      setSending(sendingRef.current)
    }
  }, [projectId])

  const refreshSessions = useCallback(async (preferredSessionId?: string) => {
    if (!bridge || !projectId) return
    const epoch = ++requestEpochRef.current
    setError('')
    try {
      const listed = await bridge.listAgentSessions(projectId)
      if (epoch !== requestEpochRef.current) return
      setSessions(listed)
      const preferred = preferredSessionId ? listed.find((item) => item.sessionId === preferredSessionId) : undefined
      const nextId = preferred?.sessionId ?? listed.find((item) => item.status !== 'archived')?.sessionId ?? listed[0]?.sessionId ?? null
      const nextSession = nextId ? listed.find((item) => item.sessionId === nextId) : undefined
      setSelectedModelId(nextSession?.agentModelId ?? agentModelCatalog?.defaultModelId ?? '')
      activeSessionRef.current = nextId
      setActiveSessionId(nextId)
      if (!nextId) {
        setMessages([])
        activeRunIdRef.current = null
        activeRunSessionIdRef.current = null
        sendingRef.current = false
        setSending(false)
        await loadSkills(null)
        return
      }
      if (activeRunSessionIdRef.current && activeRunSessionIdRef.current !== nextId) {
        activeRunIdRef.current = null
        activeRunSessionIdRef.current = null
      }
      await loadSession(nextId, epoch)
      await loadSkills(nextId)
    } catch (cause) {
      if (epoch === requestEpochRef.current) setError(normalizeError(cause))
    }
  }, [agentModelCatalog?.defaultModelId, loadSession, loadSkills, projectId])

  useEffect(() => {
    activeSessionRef.current = null
    activeRunIdRef.current = null
    activeRunSessionIdRef.current = null
    setSessions([])
    setActiveSessionId(null)
    setMessages([])
    setError('')
    sendingRef.current = false
    setSending(false)
    if (!bridge || !projectId) return
    let current = true
    void Promise.allSettled([
      bridge.getAgnesModels(),
      bridge.getAgentModelCatalog(),
      bridge.listAgentSessions(projectId),
    ]).then(async ([agnes, agentCatalog, listed]) => {
      if (!current) return
      if (agnes.status === 'fulfilled') setAgnesCatalog(agnes.value)
      else setError(normalizeError(agnes.reason))
      if (agentCatalog.status === 'fulfilled') setAgentModelCatalog(agentCatalog.value)
      else setError(normalizeError(agentCatalog.reason))
      if (listed.status !== 'fulfilled') {
        setError(normalizeError(listed.reason))
        return
      }
      setSessions(listed.value)
      const initial = listed.value[0]?.sessionId ?? null
      const initialSession = listed.value[0]
      setSelectedModelId(initialSession?.agentModelId
        ?? (agentCatalog.status === 'fulfilled' ? agentCatalog.value.defaultModelId ?? '' : ''))
      activeSessionRef.current = initial
      setActiveSessionId(initial)
      if (initial) {
        const epoch = ++requestEpochRef.current
        try {
          await loadSession(initial, epoch)
        } catch (cause) {
          if (current && epoch === requestEpochRef.current) setError(normalizeError(cause))
        }
      }
      await loadSkills(initial)
    })
    return () => {
      current = false
      requestEpochRef.current += 1
    }
  }, [canvasId, loadSession, loadSkills, projectId])

  useEffect(() => {
    if (!bridge?.subscribeAgentEvents || !projectId || !activeSessionId) return
    let active = true
    const afterSeq = eventSequencesRef.current.get(activeSessionId) ?? 0
    const unsubscribe = bridge.subscribeAgentEvents(projectId, activeSessionId, afterSeq, (event) => {
      if (!active || event.sessionId !== activeSessionId) return
      const previous = eventStatesRef.current.get(activeSessionId) ?? createEventState([])
      const next = reduceAgentEvent(previous, event, { recordAssistantSpeech: true })
      eventStatesRef.current.set(activeSessionId, next)
      eventSequencesRef.current.set(activeSessionId, Math.max(eventSequencesRef.current.get(activeSessionId) ?? afterSeq, event.eventSeq))
      setMessages(next.messages)
      if (event.type === 'confirmation_required' || event.type === 'run_completed'
        || event.type === 'run_failed' || event.type === 'run_aborted') {
        if (!activeRunIdRef.current || event.runId === activeRunIdRef.current) {
          activeRunIdRef.current = null
          activeRunSessionIdRef.current = null
          sendingRef.current = false
          setSending(false)
        }
        if (event.type === 'run_failed') {
          setError(friendlyAgentErrorMessage(event.data.message ?? event.data.errorCode))
        }
        void bridge.listAgentSessions(projectId).then((listed) => {
          if (active) setSessions(listed)
        }).catch(() => undefined)
      } else if (event.type === 'task_status') {
        // Task updates can arrive after run_completed. Do not let a late task
        // event resurrect the Agent's busy state or stop button.
        if (isAgentRunActive(next, event.runId) && (!activeRunIdRef.current || event.runId === activeRunIdRef.current)) {
          activeRunIdRef.current = event.runId
          activeRunSessionIdRef.current = activeSessionId
          sendingRef.current = true
          setSending(true)
        }
      } else {
        if (!activeRunIdRef.current || event.runId === activeRunIdRef.current) {
          activeRunIdRef.current = event.runId
          activeRunSessionIdRef.current = activeSessionId
          sendingRef.current = true
          setSending(true)
        }
      }
      if (event.type === 'tool_completed' || event.type === 'task_status') {
        if (projectId) {
          // Refresh the original node task feed for queued, running, and
          // terminal updates. One invalidation per event keeps replay bursts
          // from starting redundant task loads.
          void queryClient.invalidateQueries({ queryKey: ['canvas-tasks', projectId] })
        }
        onCanvasChanged()
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [activeSessionId, onCanvasChanged, projectId, queryClient])

  const onNewSession = useCallback(async () => {
    if (!bridge || !projectId || creating) return
    setCreating(true)
    setError('')
    try {
      const created = await bridge.createAgentSession(projectId, uiText("新对话"))
      if (selectedModelId && selectedModelAvailable) {
        await bridge.setAgentSessionModel(projectId, created.sessionId, selectedModelId)
      }
      await refreshSessions(created.sessionId)
    } catch (cause) {
      setError(normalizeError(cause))
    } finally {
      setCreating(false)
    }
  }, [creating, projectId, refreshSessions, selectedModelAvailable, selectedModelId])

  const onSelectSession = useCallback(async (sessionId: string) => {
    if (!bridge || !projectId) return
    const epoch = ++requestEpochRef.current
    activeSessionRef.current = sessionId
    activeRunIdRef.current = null
    activeRunSessionIdRef.current = null
    setActiveSessionId(sessionId)
    setError('')
    try {
      if (!sessions.some((session) => session.sessionId === sessionId)) {
        const listed = await bridge.listAgentSessions(projectId)
        if (epoch !== requestEpochRef.current) return
        setSessions(listed)
        if (!listed.some((session) => session.sessionId === sessionId)) throw new Error('SESSION_NOT_FOUND')
      }
      const session = sessions.find((candidate) => candidate.sessionId === sessionId)
      const refreshedSession = session ?? await bridge.getAgentSession(projectId, sessionId)
      setSelectedModelId(refreshedSession.agentModelId ?? agentModelCatalog?.defaultModelId ?? '')
      await loadSession(sessionId, epoch)
      await loadSkills(sessionId)
    } catch (cause) {
      if (epoch === requestEpochRef.current) setError(normalizeError(cause))
    }
  }, [agentModelCatalog?.defaultModelId, loadSession, loadSkills, projectId, sessions])

  const updateSession = useCallback(async (sessionId: string, patch: { title?: string; status?: 'active' | 'archived' }) => {
    if (!bridge || !projectId) return
    setError('')
    try {
      const updated = await bridge.updateAgentSession(projectId, sessionId, patch)
      const isCurrent = activeSessionRef.current === sessionId
      const preferredId = isCurrent
        ? (patch.status === 'archived' ? undefined : updated.sessionId)
        : activeSessionRef.current ?? undefined
      await refreshSessions(preferredId)
    } catch (cause) {
      setError(normalizeError(cause))
    }
  }, [projectId, refreshSessions])

  const copySession = useCallback(async (sessionId: string) => {
    if (!bridge || !projectId) return
    setError('')
    try {
      const copied = await bridge.copyAgentSession(projectId, sessionId, { canvasId })
      await refreshSessions(copied.sessionId)
    } catch (cause) {
      setError(normalizeError(cause))
    }
  }, [canvasId, projectId, refreshSessions])

  const deleteSession = useCallback(async (sessionId: string) => {
    if (!bridge || !projectId) return
    setError('')
    try {
      await bridge.deleteAgentSession(projectId, sessionId)
      await refreshSessions(activeSessionRef.current === sessionId ? undefined : activeSessionRef.current ?? undefined)
    } catch (cause) {
      setError(normalizeError(cause))
    }
  }, [projectId, refreshSessions])

  const onSelectAgentModel = useCallback(async (modelId: string) => {
    if (!bridge || !projectId) return
    if (!agentModelCatalog?.models.some((model) => model.id === modelId)) {
      setError(uiText("此模型尚未配置、启用或不支持 Agent 工具调用。"))
      return
    }
    if (sendingRef.current) {
      setError(uiText("当前会话正在运行，完成或停止后再切换模型。"))
      return
    }
    const sessionId = activeSessionRef.current
    if (!sessionId) {
      setSelectedModelId(modelId)
      setError('')
      return
    }
    const activeSession = sessions.find((session) => session.sessionId === sessionId)
    if (activeSession?.status === 'archived') {
      setError(uiText("请先恢复此会话，再更换模型。"))
      return
    }
    setError('')
    try {
      const result = await bridge.setAgentSessionModel(projectId, sessionId, modelId)
      if (result.bindingId !== modelId) throw new Error('AGENT_SESSION_MODEL_MISMATCH')
      setSelectedModelId(modelId)
      setSessions((current) => current.map((session) => session.sessionId === sessionId
        ? { ...session, agentModelId: modelId }
        : session))
    } catch (cause) {
      setError(normalizeError(cause))
    }
  }, [agentModelCatalog, projectId, sessions])

  const sendWithReferences = useCallback(async (input: { selectedNodeIds: string[]; selectedSkillId?: string }): Promise<boolean> => {
    const content = draft.trim()
    if (!bridge || !projectId || !content || sendingRef.current) return false
    if (sessions.find((session) => session.sessionId === activeSessionRef.current)?.status === 'archived') {
      setError(uiText("此会话已归档，请先恢复后继续发送。"))
      return false
    }
    if (!selectedModelId || !selectedModelAvailable) {
      setError(uiText("当前会话选择的 Agent 模型不可用，请配置其提供方或切换到可用模型。"))
      return false
    }
    const hasPendingConfirmation = messages.some((message) => {
      const confirmation = message.meta?.confirmation
      return isActionableConfirmation(confirmation)
    })
    if (hasPendingConfirmation) {
      setError(uiText("请先处理上方待确认的操作，再继续发送消息。"))
      return false
    }
    setError('')
    sendingRef.current = true
    setSending(true)
    let sessionId = activeSessionRef.current
    let eventDrivenRun = false
    try {
      if (!agnesCatalog?.apiKeyConfigured) throw new Error('CLOUD_CREDENTIAL_MISSING')
      await flushCanvas()
      const snapshot = useCanvasStore.getState()
      const currentCanvas = snapshot.canvas
      if (!currentCanvas || String(currentCanvas.canvas.id) !== canvasId) throw new Error('AGENT_PROJECT_CHANGED')
      if (!sessionId) {
        const created = await bridge.createAgentSession(projectId, uiText("新对话"))
        const binding = await bridge.setAgentSessionModel(projectId, created.sessionId, selectedModelId)
        if (binding.bindingId !== selectedModelId) throw new Error('AGENT_SESSION_MODEL_MISMATCH')
        sessionId = created.sessionId
        activeSessionRef.current = sessionId
        setActiveSessionId(sessionId)
        setSessions((current) => [{
          sessionId: created.sessionId,
          title: content.slice(0, 48) || uiText("新对话"),
          agentModelId: selectedModelId,
          createdAt: created.createdAt,
          modifiedAt: created.createdAt,
        }, ...current])
      }
      if (bridge.startAgentRun) {
        const selectedNodeIds = [...new Set((input?.selectedNodeIds ?? []).slice(0, 20))]
        const selectedRefs: ComposerRef[] = selectedNodeIds.map((nodeId) => {
          const node = snapshot.nodes.find((candidate) => String(candidate.id) === nodeId || String(candidate.data.node.id) === nodeId)
          return node ? refFromNode(node.data.node) : { id: nodeId, kind: 'node', title: uiText("节点") }
        })
        const nodeReferences = nodeReferencesForComposer(selectedRefs, snapshot.nodes)
        const started = await bridge.startAgentRun({
          projectId,
          canvasId,
          canvasVersion: currentCanvas.canvas.version,
          sessionId,
          modelId: selectedModelId,
          content,
          selectedNodeIds,
          selectedSkillId: input?.selectedSkillId,
          idempotencyKey: crypto.randomUUID(),
        })
        activeRunIdRef.current = started.runId
        activeRunSessionIdRef.current = sessionId
        await loadSkills(sessionId)
        eventDrivenRun = true
        setDraft('')
        const previous = eventStatesRef.current.get(sessionId) ?? createEventState([])
        const optimisticMessage: AgentChatMsg = {
          id: `local-user-${crypto.randomUUID()}`,
          role: 'user',
          type: 'text',
          content,
          meta: {
            runId: started.runId,
            selectedNodeIds,
            nodeReferences,
            ...(input?.selectedSkillId ? { selectedSkillId: input.selectedSkillId } : {}),
          },
        }
        const optimisticState = { ...previous, messages: upsertDesktopUserMessage(previous.messages, optimisticMessage) }
        eventStatesRef.current.set(sessionId, optimisticState)
        setMessages(optimisticState.messages)
        await loadSession(sessionId, requestEpochRef.current)
      } else {
        await bridge.sendAgentMessage(projectId, sessionId, content, input?.selectedSkillId, selectedModelId)
        setDraft('')
        await loadSkills(sessionId)
        await refreshSessions(sessionId)
      }
      return true
    } catch (cause) {
      setError(normalizeError(cause))
      if (!eventDrivenRun) {
        sendingRef.current = false
        setSending(false)
      }
      return false
    }
  }, [canvasId, draft, flushCanvas, loadSession, loadSkills, messages, projectId, refreshSessions,
    selectedModelAvailable, selectedModelId, sessions])

  const onSend = useCallback(async () => {
    await sendWithReferences({ selectedNodeIds: [] })
  }, [sendWithReferences])

  const onConfirm = useCallback(async (confirmation: AgentConfirmation, accept: boolean) => {
    const sessionId = activeSessionRef.current
    if (!bridge || !projectId || !sessionId || confirmingActionRef.current) return
    if (!bridge.confirmAgentAction) {
      setError(uiText("本地 Agent 生成确认接口尚未接入。"))
      return
    }
    confirmingActionRef.current = confirmation.actionId
    setError('')
    try {
      const currentCanvas = useCanvasStore.getState().canvas
      const canvasVersion = confirmation.canvasVersion ?? currentCanvas?.canvas.version
      if (!Number.isSafeInteger(canvasVersion)) throw new Error('AGENT_CANVAS_CHANGED')
      const result = await bridge.confirmAgentAction({
        projectId,
        canvasId,
        sessionId,
        actionId: confirmation.actionId,
        approvalToken: confirmation.approvalToken,
        accept,
        canvasVersion: canvasVersion as number,
      })
      const previous = eventStatesRef.current.get(sessionId) ?? createEventState([])
      const nextMessages = setConfirmationStatus(previous.messages, confirmation.actionId, result.status)
      eventStatesRef.current.set(sessionId, { ...previous, messages: nextMessages })
      if (sessionId === activeSessionRef.current) setMessages(nextMessages)
      await refreshSessions(sessionId)
      if (accept) onCanvasChanged()
    } catch (cause) {
      setError(normalizeError(cause))
    } finally {
      confirmingActionRef.current = null
    }
  }, [canvasId, onCanvasChanged, projectId, refreshSessions])

  const onStop = useCallback(async () => {
    const sessionId = activeRunSessionIdRef.current
    const runId = activeRunIdRef.current
    if (!bridge || !projectId || !sessionId || !runId) return
    if (!bridge.cancelAgentRun) {
      setError(uiText("本地 Agent 取消接口尚未接入。"))
      return
    }
    setError('')
    try {
      const result = await bridge.cancelAgentRun(projectId, sessionId, runId)
      if (!result.cancelled && sessionId === activeSessionRef.current) {
        const epoch = ++requestEpochRef.current
        await loadSession(sessionId, epoch)
      }
    } catch (cause) {
      setError(normalizeError(cause))
    }
  }, [loadSession, projectId])

  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const openProviderSettings = useCallback(() => {
    setSettingsOpen(false)
    navigate('/settings/providers', { state: { returnTo: window.location.pathname } })
  }, [navigate])
  const refreshAgentModelCatalog = useCallback(async () => {
    if (!bridge) return
    const catalog = await bridge.getAgentModelCatalog()
    setAgentModelCatalog(catalog)
    if (!activeSessionRef.current) setSelectedModelId(catalog.defaultModelId ?? '')
  }, [])
  const refreshSkills = useCallback(async () => loadSkills(activeSessionId), [activeSessionId, loadSkills])
  const settingsDialog = settingsOpen && projectId
    ? <DesktopAgentModelSettings
        configured={agnesCatalog?.apiKeyConfigured === true}
        onSaved={(catalog) => {
          setAgnesCatalog(catalog)
          setSettingsOpen(false)
          setError('')
          void refreshAgentModelCatalog().catch((cause) => setError(normalizeError(cause)))
        }}
        onCleared={(catalog) => {
          setAgnesCatalog(catalog)
          setError('')
          void refreshAgentModelCatalog().catch((cause) => setError(normalizeError(cause)))
        }}
        onOpenProviderSettings={openProviderSettings}
        onClose={closeSettings}
      />
    : null

  return {
    projectId,
    sessions,
    activeSessionId,
    messages,
    draft,
    sending,
    activeRunId: activeRunSessionIdRef.current === activeSessionId ? activeRunIdRef.current : null,
    creating,
    configured: selectedModelAvailable,
    modelLabel: selectedAgentModel?.displayName
      ?? (selectedModelId ? uiText("{0}（当前不可用）", { 0: selectedModelId }) : uiText("选择 Agent 模型")),
    modelOptions: agentModelOptions,
    selectedModelId,
    providerNames,
    onSelectModel: onSelectAgentModel,
    error,
    skills,
    loadedSkillIds,
    skillsLoading,
    refreshSkills,
    onDraftChange: setDraft,
    onNewSession,
    onSelectSession,
    onRenameSession: (sessionId: string, title: string) => updateSession(sessionId, { title }),
    onArchiveSession: (sessionId: string) => updateSession(sessionId, { status: 'archived' }),
    onRestoreSession: (sessionId: string) => updateSession(sessionId, { status: 'active' }),
    onCopySession: copySession,
    onDeleteSession: deleteSession,
    onSend,
    onSendWithReferences: sendWithReferences,
    onStop,
    onConfirm,
    onConfigure: () => setSettingsOpen(true),
    onClose: () => useCanvasStore.getState().setAgentOpen(false),
    settingsOpen,
    closeSettings,
    settingsDialog,
  }
}

function DesktopAgentModelSettings({ configured, onSaved, onCleared, onOpenProviderSettings, onClose }: {
  configured: boolean
  onSaved: (catalog: DesktopAgnesModelCatalog) => void
  onCleared: (catalog: DesktopAgnesModelCatalog) => void
  onOpenProviderSettings: () => void
  onClose: () => void
}) {
  useUiLanguage()
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const save = async () => {
    if (!bridge || busy || !apiKey.trim()) return
    setBusy(true)
    setError('')
    try {
      onSaved(await bridge.saveAgnesApiKey(apiKey.trim()))
      setApiKey('')
      setMessage(uiText("Agnes API Key 已安全保存。"))
    } catch (cause) {
      setError(normalizeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!bridge || busy) return
    setBusy(true)
    setError('')
    try {
      onCleared(await bridge.clearAgnesApiKey())
      setApiKey('')
      setMessage(uiText("Agnes API Key 已从此设备移除。"))
    } catch (cause) {
      setError(normalizeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-5" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="agent-model-settings-title">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="agent-model-settings-title" className="text-lg font-bold">{uiText("模型与 API Key")}</h2>
          <p className="mt-1 text-xs leading-5 text-[#777]">{uiText("Agent 按会话保存文本模型选择；工具调用只会发送给已配置并启用的兼容模型。")}</p>
        </div>
        <button onClick={onClose} className="rounded-lg border border-black/12 px-3 py-2 text-xs font-bold">{uiText("关闭")}</button>
      </div>
      <section className="mt-5 rounded-xl border border-black/8 bg-[#fbfaff] p-4">
        <h3 className="text-sm font-bold">{uiText("Agnes 云端模型")}</h3>
        <p className="mt-1 text-xs leading-5 text-[#666]">{uiText("文本模型：agnes-2.5-flash")}</p>
        <p className="mt-2 text-xs leading-5 text-amber-800">{uiText("向 Agent 发送消息时，会发送当前消息、会话历史和画布只读摘要，由 Agnes 处理，可能产生供应商费用。不会上传图片、视频、素材字节或项目路径，也不会每次发送都弹确认。")}</p>
        <label htmlFor="desktop-agent-agnes-api-key" className="mt-4 block text-xs font-semibold">Agnes API Key</label>
        <input id="desktop-agent-agnes-api-key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} maxLength={1024} placeholder={configured ? uiText("已配置；输入新 Key 可替换") : uiText("粘贴 API Key")} className="mt-2 h-10 w-full rounded-lg border border-black/12 bg-white px-3 text-sm outline-none focus:border-[#8a72e8]" />
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-[#777]">{configured ? uiText("此设备已配置 Key") : uiText("尚未配置 Key")}</span>
          <div className="flex gap-2">
            {configured && <button onClick={() => void clear()} disabled={busy} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-700 disabled:opacity-50">{uiText("移除 Key")}</button>}
            <button onClick={() => void save()} disabled={busy || !apiKey.trim()} className="rounded-lg bg-[#6d55c9] px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busy ? uiText("请稍候…") : uiText("安全保存 Key")}</button>
          </div>
        </div>
        {(message || error) && <p role={error ? 'alert' : 'status'} className={`mt-3 text-xs ${error ? 'text-red-700' : 'text-[#666]'}`}>{error || message}</p>}
      </section>
      <button type="button" onClick={onOpenProviderSettings} className="mt-4 w-full rounded-xl border border-black/10 px-4 py-3 text-left text-xs font-semibold text-[#555] hover:bg-black/[0.03]">
        {uiText("配置其他官方模型提供方")}<span className="mt-1 block font-normal text-[#888]">{uiText("设置厂商 API 凭据、启用模型并选择画布默认模型。")}</span>
      </button>
    </section>
  </div>
}
