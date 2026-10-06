import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, CircleAlert, ExternalLink, Eye, EyeOff, Loader2, LockKeyhole, Save, Trash2, Wifi } from 'lucide-react'
import { ModelBrandIcon } from '@/components/ui/ModelBrandIcon'
import { desktopProviderLabel } from '@/desktop/providerModels'
import { getVideoDurationOptions } from '@/features/canvas/nodes/videoNodeParameters'
import './ProviderConfigurationPage.css'
import type {
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
  const { data: OFFICIAL_DOCUMENTATION = {} } = useQuery<Record<string, string>>({
    queryKey: ['official-provider-documentation'],
    queryFn: async () => {
      const response = await fetch('/provider-documentation.json')
      if (!response.ok) throw new Error('官方文档链接加载失败。')
      return response.json()
    },
    staleTime: Infinity,
  })
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const returnTo = readReturnTo(location.state)
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: async () => {
      if (!bridge?.getProviderConfiguration) throw new Error('桌面模型配置接口尚未接入。')
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

  useEffect(() => {
    if (!selectedProviderId && data?.providers[0]) setSelectedProviderId(data.providers[0].id)
  }, [data?.providers, selectedProviderId])

  useEffect(() => {
    if (!selectedProvider) return
    setBaseUrl(selectedProvider.baseUrl)
    setTimeoutSeconds(selectedProvider.timeoutSeconds || 120)
    setEnabledModelIds(selectedProvider.enabledModelIds ?? [])
    setDefaultModelIds(selectedProvider.defaultModelIds ?? {})
    setModelDefaults(selectedProvider.modelDefaults ?? {})
    setCredentials({})
    setNotice(null)
  }, [selectedProvider?.id, data?.providers])

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
    if (!selectedProvider) throw new Error('请选择一个提供方。')
    if (selectedProvider.configurable === false) throw new Error(selectedProvider.unavailableReason || '此提供方尚未完成接入，暂不可配置。')
    const credentialsToSave = Object.fromEntries(
      Object.entries(credentials).filter(([, value]) => value.trim().length > 0).map(([key, value]) => [key, value.trim()]),
    )
    for (const field of selectedProvider.credentialFields) {
      if (field.required && !(forConnectionTest && field.name === 'voiceId')
        && !selectedProvider.configured && !credentialsToSave[field.name]) {
        throw new Error(`请填写${field.label}。`)
      }
    }
    const configuredModelIds = new Set(providerModels.filter((model) => model.implemented).map((model) => model.id))
    const enabled = enabledModelIds.filter((id) => configuredModelIds.has(id))
    return {
      providerId: selectedProvider.id,
      baseUrl: baseUrl.trim(),
      ...(Object.keys(credentialsToSave).length ? { credentials: credentialsToSave } : {}),
      enabledModelIds: enabled,
      defaultModelIds: Object.fromEntries(Object.entries(defaultModelIds).filter(([, id]) => enabled.includes(id))),
      modelDefaults,
      timeoutSeconds: Math.max(10, Math.min(600, Math.round(timeoutSeconds || 120))),
    }
  }

  const refreshCatalog = async () => {
    await queryClient.invalidateQueries({ queryKey: CONFIG_QUERY_KEY })
    await refetch()
    window.dispatchEvent(new Event('vp-desktop-model-catalog-changed'))
  }

  const save = async () => {
    if (!bridge?.saveProviderConfiguration || busyAction || selectedProvider?.configurable === false) return
    setBusyAction('save')
    setNotice(null)
    try {
      const input = buildInput()
      await bridge.saveProviderConfiguration(input)
      setCredentials({})
      await refreshCatalog()
      setNotice({ tone: 'success', source: 'save', text: '配置已保存。凭据不会在此页面回显。' })
    } catch (cause) {
      setNotice({ tone: 'error', source: 'save', text: cause instanceof Error ? cause.message : '保存配置失败。' })
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
      const message = cause instanceof Error ? cause.message : '连接检测失败。'
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
      await bridge.clearProviderConfiguration(selectedProvider.id)
      setCredentials({})
      await refreshCatalog()
      setNotice({ tone: 'success', source: 'clear', text: '此设备上保存的连接凭据和模型启用状态已清除。' })
    } catch (cause) {
      setNotice({ tone: 'error', source: 'clear', text: cause instanceof Error ? cause.message : '清除配置失败。' })
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
      <nav className="provider-config-breadcrumb" aria-label="页面位置">
        <span>设置</span>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page">自定义配置</span>
      </nav>
      <div className="provider-config-heading">
        <div>
          <h1>自定义配置</h1>
          <p>配置各厂商 API 凭据、启用模型与默认参数。</p>
        </div>
        {documentationUrl ? (
          <a className="provider-config-doc-link" href={documentationUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={17} />
            查看官方文档
          </a>
        ) : (
          <button className="provider-config-doc-link" type="button" disabled title="该提供方暂未登记官方文档链接">
            <ExternalLink size={17} />
            官方文档暂缺
          </button>
        )}
      </div>

      <div className="provider-config-shell">
        <aside className="provider-config-sidebar">
          <div className="provider-config-sidebar-heading">模型提供方</div>
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
            <p className="provider-config-empty">暂时没有可配置的模型提供方。</p>
          )}
          <div className="provider-config-local-note">
            <LockKeyhole size={15} />
            <span>凭据加密保存在此设备，API Key 不会回显。</span>
          </div>
        </aside>

        <main className="provider-config-main">
          {isLoading ? (
            <div className="provider-config-loading"><Loader2 size={18} className="animate-spin" />正在读取配置…</div>
          ) : error ? (
            <div className="provider-config-error" role="alert">{error instanceof Error ? error.message : '读取模型配置失败。'}</div>
          ) : selectedProvider && data ? (
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
          ) : (
            <div className="provider-config-loading">选择左侧提供方开始配置。</div>
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
  const providerName = desktopProviderLabel(provider.id, provider.name)
  const enabledCount = models.filter((model) =>
    model.providerId === provider.id && model.implemented && model.enabled,
  ).length
  const serviceHint = provider.id === 'volcengine'
    ? '文本 / 图片服务'
    : provider.id === 'volcengine-ark'
      ? 'Seedance 视频服务'
      : ''
  const statusCount = provider.configurable === false
    ? '待接入'
    : provider.configured
      ? (enabledCount ? enabledCount + ' 个已启用' : '已配置')
      : '未配置'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      className={'provider-config-provider-button' + (selected ? ' is-selected' : '')}
      title={provider.configured && enabledCount ? enabledCount + ' 个已启用模型' : providerName}
    >
      <ModelBrandIcon model={{ name: provider.id, provider: provider.id, displayName: providerName }} size={28} desktop symbol="settings" />
      <span className="provider-config-provider-label">
        <span className="provider-config-provider-name">{providerName}</span>
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
      ? notice.tone === 'success' ? '连接检测成功' : '连接检测未通过'
      : notice.source === 'save'
        ? notice.tone === 'success' ? '配置已保存' : '保存失败'
        : notice.tone === 'success' ? '配置已清除' : '清除失败'
    : probeUnavailable ? '暂不支持连接检测' : provider.configured ? '凭据已保存，尚未检测' : '尚未检测'
  const resultTone = notice?.tone === 'error'
    ? 'error'
    : notice?.tone === 'success'
      ? 'success'
      : 'neutral'
  const resultText = notice?.text ?? (
    probeUnavailable
      ? '此提供方尚未接入安全鉴权检测接口，无法在此验证 Key。仍可保存配置；模型权限需在实际生成时验证。'
      : provider.configured
      ? '点击检测连接，使用已保存或新填写的凭据发送真实鉴权请求；不会提交生成任务。'
      : '填写官方凭据后检测连接。检测发送真实鉴权请求，不会提交生成任务。'
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
            <h2>{providerName}</h2>
            {provider.configured && <span className="provider-config-saved-badge">凭据已保存</span>}
          </div>
          <p>配置 {providerName} 的官方 API 凭据，启用已接入模型并设置默认参数。</p>
        </div>
      </div>

      {provider.configurable === false && (
        <div className="provider-config-unavailable" role="status">
          {provider.unavailableReason || '此提供方尚未完成 API 适配，当前不能保存凭据或启用模型。'}
        </div>
      )}

      {provider.providerType !== 'local' && (
        <p className="provider-config-data-note">
          使用云端模型时，所需提示词与已选参考素材会发送给 {providerName}，供应商可能收费；生成结果保存在本地项目。
        </p>
      )}

      <section className="provider-config-fields" aria-label="连接凭据与请求设置">
        {provider.credentialFields.length > 0 && (
          <div className="provider-config-credential-grid">
            {provider.credentialFields.map((field) => (
              <div className="provider-config-field" key={field.name}>
                <label htmlFor={'credential-' + field.name}>
                  {field.label}
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
                  placeholder={provider.configured ? '已保存，留空保留现有值' : '输入' + field.label}
                />
                {field.secret && (
                  <button
                    type="button"
                    className="provider-config-secret-toggle"
                    onClick={() => setVisibleCredentials((current) => ({ ...current, [field.name]: !current[field.name] }))}
                    aria-label={(visibleCredentials[field.name] ? '隐藏' : '显示') + field.label}
                    aria-controls={'credential-' + field.name}
                    aria-pressed={Boolean(visibleCredentials[field.name])}
                    title={visibleCredentials[field.name] ? '隐藏密钥' : '显示密钥'}
                  >
                    {visibleCredentials[field.name] ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                )}
                </div>
                {provider.configured && <p>已有值不会回显；留空会保留。</p>}
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
              placeholder={provider.baseUrl || '官方 API 地址'}
            />
            <p>使用该厂商提供的官方 API 地址。</p>
          </div>
          <div className="provider-config-field">
            <label htmlFor="provider-timeout">请求超时</label>
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
              <span>秒</span>
            </div>
            <p>单次请求等待时间，范围 10–600 秒。</p>
          </div>
        </div>
      </section>

      <section className="provider-config-capability-section">
        <div className="provider-config-section-heading">
          <div>
            <h3>启用能力</h3>
            <p>切换会真实启用或停用下方已适配模型；未实现的型号不能启用。</p>
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
                  title={implementedModels.length ? '切换此类所有已适配模型' : '此类目前没有已适配模型'}
                >
                  <span className="provider-config-capability-copy">
                    <span>{label}生成</span>
                    <small>
                      {implementedModels.length
                        ? enabledCount + ' / ' + implementedModels.length + ' 已启用'
                        : modalityModels.length ? '模型待适配' : '暂无适配型号'}
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
          <p className="provider-config-no-models">该提供方尚未声明可用能力。</p>
        )}
      </section>

      <section className="provider-config-model-section">
        <div className="provider-config-section-heading">
          <div>
            <h3>模型列表</h3>
            <p>可启用的模型由官方目录与本地适配状态决定。</p>
          </div>
          <span className="provider-config-model-total">
            {enabledModelIds.filter((id) => models.some((model) => model.id === id && model.implemented)).length}
            {' / '}
            {models.filter((model) => model.implemented).length} 个已启用
          </span>
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
                        {unavailable ? '待适配' : model.modelType}
                      </span>
                    </span>
                    <span className="provider-config-api-id">API ID：{model.apiModelId}</span>
                    {(unavailable || provider.configured && !model.enabled && model.unavailableReason) && (
                      <span className="provider-config-model-reason">
                        {model.unavailableReason || '此模型或生成操作尚未完成适配，暂不能启用。'}
                      </span>
                    )}
                    {typeof model.constraints?.accountAccessNotice === 'string' && (
                      <span className="provider-config-model-reason">{model.constraints.accountAccessNotice}</span>
                    )}
                    {model.operation && (
                      <span className="provider-config-model-capability">
                        操作：{model.operation} · 输入：{model.inputModes.length ? model.inputModes.join('、') : '无'}
                      </span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
        ) : (
          <p className="provider-config-no-models">此提供方暂未登记模型目录。</p>
        )}
      </section>

      {hasModelDefaults && (
        <section className="provider-config-defaults-section">
          <div className="provider-config-section-heading">
            <div>
              <h3>默认模型与参数</h3>
              <p>默认值用于新建节点；已有节点会保留自己的参数。</p>
            </div>
          </div>
          <div className="provider-config-default-grid">
            {MODALITIES.map(([modality, label]) => {
              const options = usableDefaults.get(modality) ?? []
              if (!options.length) return null
              return (
                <div key={modality} className="provider-config-default-item">
                  <label htmlFor={'provider-default-' + modality}>{label}默认模型</label>
                  <select
                    id={'provider-default-' + modality}
                    value={defaultModelIds[modality] ?? ''}
                    onChange={(event) => onDefaultChange(modality, event.target.value)}
                    disabled={busy}
                  >
                    <option value="">不设置</option>
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
          <span className="provider-config-result-tag">{notice.tone === 'success' ? '鉴权请求成功' : '检测未通过'}</span>
        )}
      </div>
      </div>

      <footer className="provider-config-footer">
        <div>
          {provider.configured && (
            <button type="button" onClick={onClear} disabled={busy} className="provider-config-clear-button">
              {busyAction === 'clear' ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              清除配置
            </button>
          )}
        </div>
        <div className="provider-config-footer-actions">
          <button type="button" onClick={onCancel} disabled={busy} className="provider-config-secondary-button">取消</button>
          <button type="button" onClick={onTest} disabled={busy || provider.configurable === false || probeUnavailable} className="provider-config-secondary-button">
            {busyAction === 'test' ? <Loader2 size={16} className="animate-spin" /> : <Wifi size={16} />}
            {probeUnavailable ? '暂不支持检测' : busyAction === 'test' ? '正在检测…' : '检测连接'}
          </button>
          <button type="button" onClick={onSave} disabled={busy || provider.configurable === false} className="provider-config-primary-button">
            {busyAction === 'save' ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            保存配置
          </button>
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
    ['ratio', '画幅', constraints.acceptedAspectRatios],
    ['size', '图片分辨率', optionsForAspect('sizesByAspectRatio', defaults.ratio) ?? constraints.acceptedSizes],
    ['resolution', '视频分辨率', optionsForAspect('resolutionsByAspectRatio', defaults.ratio) ?? constraints.acceptedResolutions],
  ] as const
  return (
    <div className="provider-config-parameter-box">
      {lists.map(([key, label, raw]) => {
        const options = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
        if (!options.length) return null
        return (
          <label key={key} className="provider-config-parameter-row">
            <span>{label}</span>
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
          <span>时长（秒）</span>
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
          生成音频
        </label>
      )}
    </div>
  )
}
