import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, CircleAlert, ExternalLink, Eye, EyeOff, Loader2, LockKeyhole, Save, Trash2, Wifi } from 'lucide-react'
import { ModelBrandIcon } from '@/components/ui/ModelBrandIcon'
import { desktopProviderLabel } from '@/desktop/providerModels'
import {
  hasUnsavedProviderConfigurationDraft,
  providerConfigurationRefreshQueryKeys,
  shouldAdoptProviderDraftAfterRefresh,
  type ProviderConfigurationDraft,
  type ProviderConfigurationDraftBaseline,
} from './providerConfigurationEvents'
import { getVideoDurationOptions } from '@/features/canvas/nodes/videoNodeParameters'
import './ProviderConfigurationPage.css'
import type {
  DesktopMcpProviderInputRequest,
  DesktopProvider,
  DesktopProviderConfiguration,
  DesktopProviderConfigurationInput,
  DesktopProviderTestResult,
} from '@/desktop/desktop-bridge'

const bridge = window.vibepaperDesktop
const CONFIG_QUERY_KEY = ['desktop-provider-configuration'] as const
const MODALITIES = [
  ['text', '文本'],
  ['image', '图片'],
  ['video', '视频'],
  ['audio', '音频'],
] as const


type ProviderNotice = {
  tone: 'success' | 'error' | 'info'
  source: 'test' | 'save' | 'clear'
  text: string
}

function readReturnTo(state: unknown): string {
  if (!state || typeof state !== 'object') return '/workspace'
  const returnTo = (state as { returnTo?: unknown }).returnTo
  return typeof returnTo === 'string' && returnTo.startsWith('/') ? returnTo : '/workspace'
}

export function ProviderConfigurationPage() {
  useUiLanguage()
  const { data: OFFICIAL_DOCUMENTATION = {} } = useQuery<Record<string, string>>({
    queryKey: ['official-provider-documentation'],
    queryFn: async () => {
      const response = await fetch('/provider-documentation.json')
      if (!response.ok) throw new Error(uiText("官方文档链接加载失败。"))
      return response.json()
    },
    staleTime: Infinity,
  })
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const returnTo = readReturnTo(location.state)
  const [mcpProviderInput, setMcpProviderInput] = useState<DesktopMcpProviderInputRequest | null>(null)
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: async () => {
      if (!bridge?.getProviderConfiguration) throw new Error(uiText("桌面模型配置接口尚未接入。"))
      return bridge.getProviderConfiguration()
    },
  })
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const selectedProvider = data?.providers.find((provider) => provider.id === selectedProviderId) ?? data?.providers[0]
  const [baseUrl, setBaseUrl] = useState('')
  const [timeoutSeconds, setTimeoutSeconds] = useState(120)
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([])
  const [defaultModelIds, setDefaultModelIds] = useState<Record<string, string>>({})
  const [modelDefaults, setModelDefaults] = useState<Record<string, Record<string, unknown>>>({})
  const [busyAction, setBusyAction] = useState<'save' | 'test' | 'clear' | null>(null)
  const [notice, setNotice] = useState<ProviderNotice | null>(null)
  const providerDraftBaselineRef = useRef<ProviderConfigurationDraftBaseline | null>(null)
  const providerDraftRevisionRef = useRef<number | null>(null)
  const configurationRef = useRef(data)
  configurationRef.current = data
  const currentDraft: ProviderConfigurationDraft = {
    providerId: selectedProvider?.id ?? selectedProviderId,
    baseUrl,
    timeoutSeconds,
    credentials,
    enabledModelIds,
    defaultModelIds,
    modelDefaults,
  }
  const currentDraftRef = useRef(currentDraft)
  currentDraftRef.current = currentDraft

  const applyProviderDraft = useCallback((provider: DesktopProvider) => {
    const draft: ProviderConfigurationDraft = {
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      timeoutSeconds: provider.timeoutSeconds || 120,
      credentials: {},
      enabledModelIds: provider.enabledModelIds ?? [],
      defaultModelIds: provider.defaultModelIds ?? {},
      modelDefaults: provider.modelDefaults ?? {},
    }
    providerDraftBaselineRef.current = {
      providerId: draft.providerId,
      baseUrl: draft.baseUrl,
      timeoutSeconds: draft.timeoutSeconds,
      enabledModelIds: draft.enabledModelIds,
      defaultModelIds: draft.defaultModelIds,
      modelDefaults: draft.modelDefaults,
    }
    providerDraftRevisionRef.current = Number.isSafeInteger(provider.revision) && (provider.revision ?? -1) >= 0
      ? provider.revision!
      : null
    setBaseUrl(draft.baseUrl)
    setTimeoutSeconds(draft.timeoutSeconds)
    setEnabledModelIds(draft.enabledModelIds)
    setDefaultModelIds(draft.defaultModelIds)
    setModelDefaults(draft.modelDefaults)
    setCredentials({})
    setNotice(null)
  }, [])

  const acceptMcpProviderInput = useCallback((request: DesktopMcpProviderInputRequest) => {
    if (!request || typeof request.providerId !== 'string' || typeof request.operationId !== 'string') return
    setMcpProviderInput(request)
    setSelectedProviderId(request.providerId)
  }, [])

  useEffect(() => {
    const routeState = location.state && typeof location.state === 'object'
      ? location.state as { mcpProviderInput?: DesktopMcpProviderInputRequest }
      : undefined
    if (routeState?.mcpProviderInput) acceptMcpProviderInput(routeState.mcpProviderInput)
    const unsubscribe = bridge?.subscribeMcpProviderInput(acceptMcpProviderInput)
    return unsubscribe
  }, [acceptMcpProviderInput, location.state])

  useEffect(() => {
    if (!selectedProviderId && data?.providers[0]) setSelectedProviderId(data.providers[0].id)
  }, [data?.providers, selectedProviderId])

  useEffect(() => {
    if (!selectedProvider) return
    if (providerDraftBaselineRef.current?.providerId === selectedProvider.id) return
    applyProviderDraft(selectedProvider)
  }, [selectedProvider?.id, applyProviderDraft])

  const providerModels = useMemo(
    () => data?.models.filter((model) => model.providerId === selectedProvider?.id) ?? [],
    [data?.models, selectedProvider?.id],
  )

  const usableDefaults = useMemo(() => {
    const byModality = new Map<string, typeof providerModels>()
    for (const [modality] of MODALITIES) {
      byModality.set(modality, providerModels.filter((model) =>
        model.modelType === modality && model.implemented && enabledModelIds.includes(model.id),
      ))
    }
    return byModality
  }, [enabledModelIds, providerModels])

  const buildInput = (forConnectionTest = false): DesktopProviderConfigurationInput => {
    if (!selectedProvider) throw new Error(uiText("请选择一个提供方。"))
    if (selectedProvider.configurable === false) throw new Error(selectedProvider.unavailableReason || uiText("此提供方尚未完成接入，暂不可配置。"))
    const credentialsToSave = Object.fromEntries(
      Object.entries(credentials).filter(([, value]) => value.trim().length > 0).map(([key, value]) => [key, value.trim()]),
    )
    for (const field of selectedProvider.credentialFields) {
      if (field.required && !(forConnectionTest && field.name === 'voiceId')
        && !selectedProvider.configured && !credentialsToSave[field.name]) {
        throw new Error(uiText("请填写{0}。", { 0: uiText(field.label) }))
      }
    }
    const configuredModelIds = new Set(providerModels.filter((model) => model.implemented).map((model) => model.id))
    const enabled = enabledModelIds.filter((id) => configuredModelIds.has(id))
    return {
      providerId: selectedProvider.id,
      expectedRevision: (() => {
        const revision = providerDraftRevisionRef.current
        if (!Number.isSafeInteger(revision) || (revision ?? -1) < 0) {
          throw new Error(uiText("配置版本尚未就绪，请刷新后重试。"))
        }
        return revision!
      })(),
      ...(!forConnectionTest && mcpProviderInput?.providerId === selectedProvider.id
        ? { operationId: mcpProviderInput.operationId, mcpProposalId: mcpProviderInput.proposalId }
        : {}),
      baseUrl: baseUrl.trim(),
      ...(Object.keys(credentialsToSave).length ? { credentials: credentialsToSave } : {}),
      enabledModelIds: enabled,
      defaultModelIds: Object.fromEntries(Object.entries(defaultModelIds).filter(([, id]) => enabled.includes(id))),
      modelDefaults,
      timeoutSeconds: Math.max(10, Math.min(600, Math.round(timeoutSeconds || 120))),
    }
  }

  const refreshCatalog = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: CONFIG_QUERY_KEY, refetchType: 'none' })
    const refreshed = await refetch()
    if (refreshed.data) configurationRef.current = refreshed.data
    window.dispatchEvent(new Event('vp-desktop-model-catalog-changed'))
    return refreshed.data
  }, [queryClient, refetch])

  useEffect(() => {
    const unsubscribe = bridge?.subscribeMcpEvents((event) => {
      if (event.type !== 'provider.configuration.changed') return
      const knownRevision = configurationRef.current?.providers.find((provider) => provider.id === event.providerId)?.revision
      if (!providerConfigurationRefreshQueryKeys(event, knownRevision).length) return
      const wasDirty = hasUnsavedProviderConfigurationDraft(currentDraftRef.current, providerDraftBaselineRef.current)
      const selectedIdAtStart = currentDraftRef.current.providerId
      void refreshCatalog().then((refreshed) => {
        if (!shouldAdoptProviderDraftAfterRefresh(event, knownRevision, wasDirty)
          || hasUnsavedProviderConfigurationDraft(currentDraftRef.current, providerDraftBaselineRef.current)
          || currentDraftRef.current.providerId !== selectedIdAtStart || selectedIdAtStart !== event.providerId) return
        const updatedProvider = refreshed?.providers.find((provider) => provider.id === event.providerId)
        if (updatedProvider) applyProviderDraft(updatedProvider)
      }).catch(() => undefined)
    })
    return unsubscribe
  }, [applyProviderDraft, refreshCatalog])

  useEffect(() => {
    if (!selectedProvider || !mcpProviderInput || mcpProviderInput.providerId !== selectedProvider.id) return
    let disposed = false
    void (async () => {
      const active = await bridge?.getActiveProject()
      if (disposed) return
      if (active?.projectId !== mcpProviderInput.projectId || active.canvasId !== mcpProviderInput.canvasId) {
        setNotice({ tone: 'error', source: 'save', text: uiText("此配置请求属于另一个项目或画布。请切回原授权画布后重新准备。") })
        setMcpProviderInput(null)
        return
      }
      if (selectedProvider.revision !== mcpProviderInput.expectedRevision) {
        setNotice({ tone: 'error', source: 'save', text: uiText("这份外部配置准备期间，提供方版本已变化。请刷新后让外部 Agent 重新准备。") })
        setMcpProviderInput(null)
        return
      }
      const config = mcpProviderInput.publicConfig
      if (config.baseUrl !== undefined) setBaseUrl(config.baseUrl)
      if (config.enabledModelIds !== undefined) setEnabledModelIds(config.enabledModelIds)
      if (config.defaultModelIds !== undefined) setDefaultModelIds(config.defaultModelIds)
      if (config.modelDefaults !== undefined) setModelDefaults(config.modelDefaults)
      if (config.timeoutSeconds !== undefined) setTimeoutSeconds(config.timeoutSeconds)
      setCredentials({})
      const credentialLabels = mcpProviderInput.credentialFields
        .map((name) => selectedProvider.credentialFields.find((field) => field.name === name)?.label ?? name)
      setNotice({
        tone: 'info',
        source: 'save',
        text: uiText("外部 Agent 已准备公开配置。请在此页面输入密钥并保存；密钥不会返回给外部客户端。需配置字段：{0}", { 0: credentialLabels.join('、') || uiText('按需选择') }),
      })
    })().catch(() => {
      if (!disposed) {
        setNotice({ tone: 'error', source: 'save', text: uiText("无法验证外部配置请求的画布范围，请刷新状态后重试。") })
        setMcpProviderInput(null)
      }
    })
    return () => { disposed = true }
  }, [mcpProviderInput?.proposalId, selectedProvider?.id])

  const save = async () => {
    if (!bridge?.saveProviderConfiguration || busyAction || selectedProvider?.configurable === false) return
    setBusyAction('save')
    setNotice(null)
    try {
      const input = buildInput()
      const isMcpInput = Boolean(mcpProviderInput?.providerId === input.providerId && input.operationId && input.mcpProposalId)
      const saved = await bridge.saveProviderConfiguration(input)
      const savedProvider = saved.providers.find((provider) => provider.id === input.providerId)
      if (savedProvider) applyProviderDraft(savedProvider)
      if (mcpProviderInput?.providerId === input.providerId) setMcpProviderInput(null)
      await refreshCatalog()
      setNotice({
        tone: 'success',
        source: 'save',
        text: isMcpInput
          ? uiText("配置已保存。外部客户端可查询原请求结果；密钥不会回传。")
          : uiText("配置已保存。凭据不会在此页面回显。"),
      })
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : uiText("保存配置失败。")
      if (/版本|revision|conflict/iu.test(text)) await refreshCatalog()
      setNotice({ tone: 'error', source: 'save', text })
    } finally {
      setBusyAction(null)
    }
  }

  const test = async () => {
    if (!bridge?.testProviderConfiguration || busyAction || selectedProvider?.configurable === false) return
    setBusyAction('test')
    setNotice(null)
    try {
      const result: DesktopProviderTestResult = await bridge.testProviderConfiguration(buildInput(true))
      setNotice({ tone: result.success && result.status === 'connected' ? 'success' : 'error', source: 'test', text: result.message })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : uiText("连接检测失败。")
      if (/版本|revision|conflict/iu.test(message)) await refreshCatalog()
      setNotice({ tone: 'error', source: 'test', text: message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '') })
    } finally {
      setBusyAction(null)
    }
  }

  const clear = async () => {
    if (!bridge?.clearProviderConfiguration || !selectedProvider || busyAction || selectedProvider.configurable === false) return
    setBusyAction('clear')
    setNotice(null)
    try {
      const expectedRevision = providerDraftRevisionRef.current
      if (!Number.isSafeInteger(expectedRevision) || (expectedRevision ?? -1) < 0) {
        throw new Error(uiText("配置版本尚未就绪，请刷新后重试。"))
      }
      const cleared = await bridge.clearProviderConfiguration(selectedProvider.id, expectedRevision!)
      const clearedProvider = cleared.providers.find((provider) => provider.id === selectedProvider.id)
      if (clearedProvider) applyProviderDraft(clearedProvider)
      if (mcpProviderInput?.providerId === selectedProvider.id) setMcpProviderInput(null)
      await refreshCatalog()
      setNotice({ tone: 'success', source: 'clear', text: uiText("此设备上保存的连接凭据和模型启用状态已清除。") })
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : uiText("清除配置失败。")
      if (/版本|revision|conflict/iu.test(text)) await refreshCatalog()
      setNotice({ tone: 'error', source: 'clear', text })
    } finally {
      setBusyAction(null)
    }
  }

  const toggleModel = (modelId: string) => {
    const model = providerModels.find((candidate) => candidate.id === modelId)
    if (!model?.implemented) return
    setEnabledModelIds((current) => current.includes(modelId)
      ? current.filter((id) => id !== modelId)
      : [...current, modelId])
    if (enabledModelIds.includes(modelId) && defaultModelIds[model.modelType] === modelId) {
      setDefaultModelIds((current) => {
        const next = { ...current }
        delete next[model.modelType]
        return next
      })
    }
  }

  const toggleModality = (modelType: string) => {
    const implementedIds = providerModels
      .filter((model) => model.modelType === modelType && model.implemented)
      .map((model) => model.id)
    if (!implementedIds.length) return
    const everyEnabled = implementedIds.every((id) => enabledModelIds.includes(id))
    setEnabledModelIds((current) => everyEnabled
      ? current.filter((id) => !implementedIds.includes(id))
      : [...new Set([...current, ...implementedIds])])
    if (everyEnabled) {
      setDefaultModelIds((current) => {
        const next = { ...current }
        delete next[modelType]
        return next
      })
    }
  }

  const loading = isLoading || Boolean(busyAction)
  const documentationUrl = selectedProvider ? OFFICIAL_DOCUMENTATION[selectedProvider.id] : undefined

  return (
    <div className="provider-config-page mx-auto w-full max-w-[1480px]">
      <nav className="provider-config-breadcrumb" aria-label={uiText("页面位置")}>
        <span>{uiText("设置")}</span>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page">{uiText("自定义配置")}</span>
      </nav>
      <div className="provider-config-heading">
        <div>
          <h1>{uiText("自定义配置")}</h1>
          <p>{uiText("配置各厂商 API 凭据、启用模型与默认参数。")}</p>
        </div>
        {documentationUrl ? (
          <a className="provider-config-doc-link" href={documentationUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={17} />
            {uiText("查看官方文档")}</a>
        ) : (
          <button className="provider-config-doc-link" type="button" disabled title={uiText("该提供方暂未登记官方文档链接")}>
            <ExternalLink size={17} />
            {uiText("官方文档暂缺")}</button>
        )}
      </div>

      <div className="provider-config-shell">
        <aside className="provider-config-sidebar">
          <div className="provider-config-sidebar-heading">{uiText("模型提供方")}</div>
          <div className="provider-config-provider-list">
            {data?.providers.map((provider) => (
              <ProviderNavItem
                key={provider.id}
                provider={provider}
                models={data.models}
                selected={provider.id === selectedProvider?.id}
                onClick={() => setSelectedProviderId(provider.id)}
              />
            ))}
          </div>
          {!isLoading && !data?.providers.length && (
            <p className="provider-config-empty">{uiText("暂时没有可配置的模型提供方。")}</p>
          )}
          <div className="provider-config-local-note">
            <LockKeyhole size={15} />
            <span>{uiText("凭据加密保存在此设备，API Key 不会回显。")}</span>
          </div>
        </aside>

        <main className="provider-config-main">
          {isLoading ? (
            <div className="provider-config-loading"><Loader2 size={18} className="animate-spin" />{uiText("正在读取配置…")}</div>
          ) : error ? (
            <div className="provider-config-error" role="alert">{error instanceof Error ? error.message : uiText("读取模型配置失败。")}</div>
          ) : selectedProvider && data ? (
            <>
            {mcpProviderInput?.providerId === selectedProvider.id && (
              <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-900" role="status" data-testid="mcp-provider-input-prompt">
                <strong>{uiText("来自外部 Agent 的配置请求")}</strong>
                <p>{uiText("公开配置已预填。请检查模型和请求范围，在下方输入 API Key 后保存。Key 只写入此设备，不会回显给客户端。")}</p>
              </div>
            )}
            <ProviderEditor
              provider={selectedProvider}
              models={providerModels}
              enabledModelIds={enabledModelIds}
              defaultModelIds={defaultModelIds}
              modelDefaults={modelDefaults}
              baseUrl={baseUrl}
              timeoutSeconds={timeoutSeconds}
              credentials={credentials}
              usableDefaults={usableDefaults}
              busy={loading || selectedProvider.configurable === false}
              busyAction={busyAction}
              notice={notice}
              onToggleModality={toggleModality}
              onBaseUrlChange={(value) => { setBaseUrl(value); setNotice(null) }}
              onTimeoutChange={setTimeoutSeconds}
              onCredentialChange={(name, value) => {
                setCredentials((current) => ({ ...current, [name]: value }))
                setNotice(null)
              }}
              onToggleModel={toggleModel}
              onDefaultChange={(modality, modelId) => setDefaultModelIds((current) => ({ ...current, [modality]: modelId }))}
              onModelDefaultChange={(modelId, key, value) => setModelDefaults((current) => ({ ...current, [modelId]: { ...current[modelId], [key]: value } }))}
              onTest={() => void test()}
              onSave={() => void save()}
              onClear={() => void clear()}
              onCancel={() => navigate(returnTo)}
            />
            </>
          ) : (
            <div className="provider-config-loading">{uiText("选择左侧提供方开始配置。")}</div>
          )}
        </main>
      </div>
    </div>
  )
}

function ProviderNavItem({ provider, models, selected, onClick }: {
  provider: DesktopProvider
  models: DesktopProviderConfiguration['models']
  selected: boolean
  onClick: () => void
}) {
  useUiLanguage()
  const providerName = desktopProviderLabel(provider.id, provider.name)
  const enabledCount = models.filter((model) =>
    model.providerId === provider.id && model.implemented && model.enabled,
  ).length
  const serviceHint = provider.id === 'volcengine'
    ? uiText("文本 / 图片服务")
    : provider.id === 'volcengine-ark'
      ? uiText("Seedance 视频服务")
      : ''
  const statusCount = provider.configurable === false
    ? uiText("待接入")
    : provider.configured
      ? (enabledCount ? enabledCount + uiText("个已启用") : uiText("已配置"))
      : uiText("未配置")
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      className={'provider-config-provider-button' + (selected ? ' is-selected' : '')}
      title={provider.configured && enabledCount ? enabledCount + uiText("个已启用模型") : providerName}
    >
      <ModelBrandIcon model={{ name: provider.id, provider: provider.id, displayName: providerName }} size={28} desktop symbol="settings" />
      <span className="provider-config-provider-label">
        <span className="provider-config-provider-name">{uiText(providerName)}</span>
        {serviceHint && <span className="provider-config-provider-service">{serviceHint}</span>}
      </span>
      <span className={'provider-config-provider-count' + (provider.configured ? ' is-configured' : '')}>
        {provider.configured && <span className="provider-config-status-dot" />}
        {statusCount}
      </span>
    </button>
  )
}
function ProviderEditor({
  provider,
  models,
  enabledModelIds,
  defaultModelIds,
  modelDefaults,
  baseUrl,
  timeoutSeconds,
  credentials,
  usableDefaults,
  busy,
  busyAction,
  notice,
  onToggleModality,
  onBaseUrlChange,
  onTimeoutChange,
  onCredentialChange,
  onToggleModel,
  onDefaultChange,
  onModelDefaultChange,
  onTest,
  onSave,
  onClear,
  onCancel,
}: {
  provider: DesktopProvider
  models: DesktopProviderConfiguration['models']
  enabledModelIds: string[]
  defaultModelIds: Record<string, string>
  modelDefaults: Record<string, Record<string, unknown>>
  baseUrl: string
  timeoutSeconds: number
  credentials: Record<string, string>
  usableDefaults: Map<string, DesktopProviderConfiguration['models']>
  busy: boolean
  busyAction: 'save' | 'test' | 'clear' | null
  notice: ProviderNotice | null
  onToggleModality: (modelType: string) => void
  onBaseUrlChange: (value: string) => void
  onTimeoutChange: (value: number) => void
  onCredentialChange: (name: string, value: string) => void
  onToggleModel: (modelId: string) => void
  onDefaultChange: (modality: string, modelId: string) => void
  onModelDefaultChange: (modelId: string, key: string, value: unknown) => void
  onTest: () => void
  onSave: () => void
  onClear: () => void
  onCancel: () => void
}) {
  useUiLanguage()
  const providerName = desktopProviderLabel(provider.id, provider.name)
  const [visibleCredentials, setVisibleCredentials] = useState<Record<string, boolean>>({})
  useEffect(() => setVisibleCredentials({}), [provider.id])
  const probeUnavailable = provider.connectionTest?.kind === 'format-only'
  const hasModelDefaults = [...usableDefaults.values()].some((items) => items.length)
  const capabilityRows = MODALITIES.filter(([modality]) =>
    provider.modalities?.includes(modality) || models.some((model) => model.modelType === modality),
  )
  const resultTitle = notice
    ? notice.source === 'test'
      ? notice.tone === 'success' ? uiText("连接检测成功") : uiText("连接检测未通过")
      : notice.source === 'save'
        ? notice.tone === 'success' ? uiText("配置已保存") : uiText("保存失败")
        : notice.tone === 'success' ? uiText("配置已清除") : uiText("清除失败")
    : probeUnavailable ? uiText("暂不支持连接检测") : provider.configured ? uiText("凭据已保存，尚未检测") : uiText("尚未检测")
  const resultTone = notice?.tone === 'error'
    ? 'error'
    : notice?.tone === 'success'
      ? 'success'
      : 'neutral'
  const resultText = notice?.text ?? (
    probeUnavailable
      ? uiText("此提供方尚未接入安全鉴权检测接口，无法在此验证 Key。仍可保存配置；模型权限需在实际生成时验证。")
      : provider.configured
      ? uiText("点击检测连接，使用已保存或新填写的凭据发送真实鉴权请求；不会提交生成任务。")
      : uiText("填写官方凭据后检测连接。检测发送真实鉴权请求，不会提交生成任务。")
  )
  const detailScrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (detailScrollRef.current) detailScrollRef.current.scrollTop = 0
  }, [provider.id])

  return (
    <div className="provider-config-editor">
      <div className="provider-config-scroll-content" ref={detailScrollRef}>
      <div className="provider-config-brand-header">
        <ModelBrandIcon model={{ name: provider.id, provider: provider.id, displayName: providerName }} size={46} desktop symbol="settings" />
        <div className="provider-config-brand-copy">
          <div className="provider-config-brand-title-row">
            <h2>{uiText(providerName)}</h2>
            {provider.configured && <span className="provider-config-saved-badge">{uiText("凭据已保存")}</span>}
          </div>
          <p>{uiText("配置 ")}{uiText(providerName)} {uiText("的官方 API 凭据，启用已接入模型并设置默认参数。")}</p>
        </div>
      </div>

      {provider.configurable === false && (
        <div className="provider-config-unavailable" role="status">
          {uiText(provider.unavailableReason || "此提供方尚未完成 API 适配，当前不能保存凭据或启用模型。")}
        </div>
      )}

      {provider.providerType !== 'local' && (
        <p className="provider-config-data-note">
          {uiText("使用云端模型时，所需提示词与已选参考素材会发送给 ")}{uiText(providerName)}{uiText("，供应商可能收费；生成结果保存在本地项目。")}</p>
      )}

      <section className="provider-config-fields" aria-label={uiText("连接凭据与请求设置")}>
        {provider.credentialFields.length > 0 && (
          <div className="provider-config-credential-grid">
            {provider.credentialFields.map((field) => (
              <div className="provider-config-field" key={field.name}>
                <label htmlFor={'credential-' + field.name}>
                  {uiText(field.label)}
                  {field.required && <span className="provider-config-required"> *</span>}
                </label>
                <div className={field.secret ? 'provider-config-secret-input' : undefined}>
                <input
                  id={'credential-' + field.name}
                  value={credentials[field.name] ?? ''}
                  onChange={(event) => onCredentialChange(field.name, event.target.value)}
                  disabled={busy}
                  type={field.secret && !visibleCredentials[field.name] ? 'password' : 'text'}
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={2048}
                  placeholder={provider.configured ? uiText("已保存，留空保留现有值") : uiText("输入") + " " + uiText(field.label)}
                />
                {field.secret && (
                  <button
                    type="button"
                    className="provider-config-secret-toggle"
                    onClick={() => setVisibleCredentials((current) => ({ ...current, [field.name]: !current[field.name] }))}
                    aria-label={(visibleCredentials[field.name] ? uiText("隐藏") : uiText("显示")) + " " + uiText(field.label)}
                    aria-controls={'credential-' + field.name}
                    aria-pressed={Boolean(visibleCredentials[field.name])}
                    title={visibleCredentials[field.name] ? uiText("隐藏密钥") : uiText("显示密钥")}
                  >
                    {visibleCredentials[field.name] ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                )}
                </div>
                {provider.configured && <p>{uiText("已有值不会回显；留空会保留。")}</p>}
              </div>
            ))}
          </div>
        )}

        <div className="provider-config-connection-grid">
          <div className="provider-config-field">
            <label htmlFor="provider-base-url">API Base URL</label>
            <input
              id="provider-base-url"
              value={baseUrl}
              onChange={(event) => onBaseUrlChange(event.target.value)}
              disabled={busy}
              spellCheck={false}
              placeholder={provider.baseUrl || uiText("官方 API 地址")}
            />
            <p>{uiText("使用该厂商提供的官方 API 地址。")}</p>
          </div>
          <div className="provider-config-field">
            <label htmlFor="provider-timeout">{uiText("请求超时")}</label>
            <div className="provider-config-timeout">
              <input
                id="provider-timeout"
                type="number"
                min={10}
                max={600}
                value={timeoutSeconds}
                onChange={(event) => onTimeoutChange(Number(event.target.value))}
                disabled={busy}
              />
              <span>{uiText("秒")}</span>
            </div>
            <p>{uiText("单次请求等待时间，范围 10–600 秒。")}</p>
          </div>
        </div>
      </section>

      <section className="provider-config-capability-section">
        <div className="provider-config-section-heading">
          <div>
            <h3>{uiText("启用能力")}</h3>
            <p>{uiText("切换会真实启用或停用下方已适配模型；未实现的型号不能启用。")}</p>
          </div>
        </div>
        {capabilityRows.length ? (
          <div className="provider-config-capability-grid">
            {capabilityRows.map(([modality, label]) => {
              const modalityModels = models.filter((model) => model.modelType === modality)
              const implementedModels = modalityModels.filter((model) => model.implemented)
              const enabledCount = implementedModels.filter((model) => enabledModelIds.includes(model.id)).length
              const allEnabled = implementedModels.length > 0 && enabledCount === implementedModels.length
              const partial = enabledCount > 0 && !allEnabled
              return (
                <button
                  type="button"
                  key={modality}
                  className="provider-config-capability"
                  onClick={() => onToggleModality(modality)}
                  disabled={busy || !implementedModels.length}
                  aria-pressed={allEnabled}
                  title={implementedModels.length ? uiText("切换此类所有已适配模型") : uiText("此类目前没有已适配模型")}
                >
                  <span className="provider-config-capability-copy">
                    <span>{uiText(label + '生成')}</span>
                    <small>
                      {implementedModels.length
                        ? enabledCount + ' / ' + implementedModels.length + ' ' + uiText("已启用")
                        : modalityModels.length ? uiText("模型待适配") : uiText("暂无适配型号")}
                    </small>
                  </span>
                  <span className={'provider-config-switch' + (allEnabled ? ' is-on' : '') + (partial ? ' is-partial' : '')} aria-hidden="true">
                    <span />
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <p className="provider-config-no-models">{uiText("该提供方尚未声明可用能力。")}</p>
        )}
      </section>

      <section className="provider-config-model-section">
        <div className="provider-config-section-heading">
          <div>
            <h3>{uiText("模型列表")}</h3>
            <p>{uiText("可启用的模型由官方目录与本地适配状态决定。")}</p>
          </div>
          <span className="provider-config-model-total">
            {enabledModelIds.filter((id) => models.some((model) => model.id === id && model.implemented)).length}
            {' / '}
            {models.filter((model) => model.implemented).length} {uiText("个已启用")}</span>
        </div>
        {models.length ? (
          <div className="provider-config-model-grid">
            {models.map((model) => {
              const checked = enabledModelIds.includes(model.id)
              const unavailable = !model.implemented
              return (
                <label
                  key={model.id}
                  className={'provider-config-model-card' + (checked ? ' is-enabled' : '') + (unavailable ? ' is-unavailable' : '')}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleModel(model.id)}
                    disabled={busy || unavailable}
                  />
                  <ModelBrandIcon model={{ name: model.apiModelId, provider: model.brandId || model.providerId, displayName: model.displayName || model.name }} size={32} desktop />
                  <span className="provider-config-model-copy">
                    <span className="provider-config-model-title">
                      <strong>{model.displayName || model.name}</strong>
                      <span className={'provider-config-model-type' + (unavailable ? ' is-unavailable' : '')}>
                        {unavailable ? uiText("待适配") : model.modelType}
                      </span>
                    </span>
                    <span className="provider-config-api-id">API ID：{model.apiModelId}</span>
                    {(unavailable || provider.configured && !model.enabled && model.unavailableReason) && (
                      <span className="provider-config-model-reason">
                        {uiText(model.unavailableReason || "此模型或生成操作尚未完成适配，暂不能启用。")}
                      </span>
                    )}
                    {typeof model.constraints?.accountAccessNotice === 'string' && (
                      <span className="provider-config-model-reason">{model.constraints.accountAccessNotice}</span>
                    )}
                    {model.operation && (
                      <span className="provider-config-model-capability">
                        {uiText("操作：")}{model.operation} {uiText("· 输入：")}{model.inputModes.length ? model.inputModes.join('、') : uiText("无")}
                      </span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        ) : (
          <p className="provider-config-no-models">{uiText("此提供方暂未登记模型目录。")}</p>
        )}
      </section>

      {hasModelDefaults && (
        <section className="provider-config-defaults-section">
          <div className="provider-config-section-heading">
            <div>
              <h3>{uiText("默认模型与参数")}</h3>
              <p>{uiText("默认值用于新建节点；已有节点会保留自己的参数。")}</p>
            </div>
          </div>
          <div className="provider-config-default-grid">
            {MODALITIES.map(([modality, label]) => {
              const options = usableDefaults.get(modality) ?? []
              if (!options.length) return null
              return (
                <div key={modality} className="provider-config-default-item">
                  <label htmlFor={'provider-default-' + modality}>{uiText(label)}{uiText("默认模型")}</label>
                  <select
                    id={'provider-default-' + modality}
                    value={defaultModelIds[modality] ?? ''}
                    onChange={(event) => onDefaultChange(modality, event.target.value)}
                    disabled={busy}
                  >
                    <option value="">{uiText("不设置")}</option>
                    {options.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.name}</option>)}
                  </select>
                  {options
                    .filter((model) => model.id === defaultModelIds[modality])
                    .map((model) => (
                      <ModelDefaultParameters
                        key={model.id}
                        model={model}
                        values={modelDefaults[model.id] ?? {}}
                        busy={busy}
                        onChange={(key, value) => onModelDefaultChange(model.id, key, value)}
                      />
                    ))}
                </div>
              )
            })}
          </div>
        </section>
      )}

      <div className={'provider-config-result is-' + resultTone} role="status" aria-live="polite">
        <span className="provider-config-result-icon">
          {resultTone === 'error' ? <CircleAlert size={22} /> : resultTone === 'success' ? <Check size={22} /> : <Wifi size={22} />}
        </span>
        <span className="provider-config-result-copy">
          <strong>{resultTitle}</strong>
          <span>{resultText}</span>
        </span>
        {notice?.source === 'test' && (
          <span className="provider-config-result-tag">{notice.tone === 'success' ? uiText("鉴权请求成功") : uiText("检测未通过")}</span>
        )}
      </div>
      </div>

      <footer className="provider-config-footer">
        <div>
          {provider.configured && (
            <button type="button" onClick={onClear} disabled={busy} className="provider-config-clear-button">
              {busyAction === 'clear' ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              {uiText("清除配置")}</button>
          )}
        </div>
        <div className="provider-config-footer-actions">
          <button type="button" onClick={onCancel} disabled={busy} className="provider-config-secondary-button">{uiText("取消")}</button>
          <button type="button" onClick={onTest} disabled={busy || provider.configurable === false || probeUnavailable} className="provider-config-secondary-button">
            {busyAction === 'test' ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />}
            {probeUnavailable ? uiText("暂不支持检测") : busyAction === 'test' ? uiText("正在检测…") : uiText("检测连接")}
          </button>
          <button type="button" onClick={onSave} disabled={busy || provider.configurable === false} className="provider-config-primary-button">
            {busyAction === 'save' ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {uiText("保存配置")}</button>
        </div>
      </footer>
    </div>
  )
}
function ModelDefaultParameters({ model, values, busy, onChange }: {
  model: DesktopProviderConfiguration['models'][number]
  values: Record<string, unknown>
  busy: boolean
  onChange: (key: string, value: unknown) => void
}) {
  useUiLanguage()
  const constraints = model.constraints ?? {}
  const defaults = { ...model.defaults, ...values }
  const durations = getVideoDurationOptions(constraints, String(defaults.resolution ?? ''))
  if (model.modelType !== 'image' && model.modelType !== 'video') return null
  const optionsForAspect = (field: 'sizesByAspectRatio' | 'resolutionsByAspectRatio', ratio: unknown) => {
    const mapping = constraints[field]
    return mapping && typeof mapping === 'object' && !Array.isArray(mapping)
      ? (mapping as Record<string, unknown>)[String(ratio)] : undefined
  }
  const lists = [
    ['ratio', uiText("画幅"), constraints.acceptedAspectRatios],
    ['size', uiText("图片分辨率"), optionsForAspect('sizesByAspectRatio', defaults.ratio) ?? constraints.acceptedSizes],
    ['resolution', uiText("视频分辨率"), optionsForAspect('resolutionsByAspectRatio', defaults.ratio) ?? constraints.acceptedResolutions],
  ] as const
  return (
    <div className="provider-config-parameter-box">
      {lists.map(([key, label, raw]) => {
        const options = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
        if (!options.length) return null
        return (
          <label key={key} className="provider-config-parameter-row">
            <span>{uiText(label)}</span>
            <select disabled={busy} value={String(defaults[key] ?? options[0])} onChange={(event) => {
              onChange(key, event.target.value)
              if (key === 'ratio') {
                for (const [parameter, field] of [['size', 'sizesByAspectRatio'], ['resolution', 'resolutionsByAspectRatio']] as const) {
                  const allowed = optionsForAspect(field, event.target.value)
                  if (Array.isArray(allowed) && allowed.length && !allowed.includes(defaults[parameter])) onChange(parameter, allowed[0])
                }
              }
              if (key === 'resolution') {
                const allowed = getVideoDurationOptions(constraints, event.target.value)
                if (allowed.length && !allowed.includes(Number(defaults.duration))) onChange('duration', allowed[0])
              }
            }}>
              {options.map((option) => <option key={option}>{option}</option>)}
            </select>
          </label>
        )
      })}
      {model.modelType === 'video' && typeof constraints.minimumDuration === 'number' && typeof constraints.maximumDuration === 'number' && (
        <label className="provider-config-parameter-row">
          <span>{uiText("时长（秒）")}</span>
          {durations.length ? (
            <select disabled={busy} value={Number(defaults.duration ?? durations[0])} onChange={(event) => onChange('duration', Number(event.target.value))}>
              {durations.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          ) : (
            <input
              type="number"
              disabled={busy}
              min={constraints.minimumDuration}
              max={constraints.maximumDuration}
              value={Number(defaults.duration ?? Math.max(constraints.minimumDuration, 4))}
              onChange={(event) => onChange('duration', Number(event.target.value))}
            />
          )}
        </label>
      )}
      {constraints.supportsGenerateAudio === true && (
        <label className="provider-config-parameter-checkbox">
          <input type="checkbox" disabled={busy} checked={defaults.generate_audio === true} onChange={(event) => onChange('generate_audio', event.target.checked)} />
          {uiText("生成音频")}</label>
      )}
    </div>
  )
}
