import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Clipboard, PlugZap, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { desktopProviderLabel } from '@/desktop/providerModels'
import { canCreateMcpGrant, createMcpClientGrantInput, getMcpClientConfigText, providerGrantForPermissions, setMcpGrantPermission } from './mcpGrantPolicy'
import type {
  DesktopMcpClientGrantInput,
  DesktopMcpClientGrantResult,
  DesktopMcpClientName,
  DesktopMcpCredentialInputMode,
  DesktopMcpEvent,
  DesktopMcpPermission,
  DesktopMcpProviderDescriptor,
  DesktopMcpProviderGrantInput,
  DesktopMcpState,
} from '@/desktop/desktop-bridge'

const bridge = window.vibepaperDesktop
const DISCLOSURE_VERSION = 'desktop-mcp-provider-disclosure-v1'
const clientOptions: Array<{ id: DesktopMcpClientName; label: string; documentationUrl: string }> = [
  { id: 'codex', label: 'Codex', documentationUrl: 'https://developers.openai.com/codex/mcp/' },
  { id: 'claude-code', label: 'Claude Code', documentationUrl: 'https://code.claude.com/docs/en/mcp' },
  { id: 'cursor', label: 'Cursor', documentationUrl: 'https://cursor.com/docs/mcp' },
  { id: 'workbuddy', label: 'WorkBuddy', documentationUrl: 'https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide' },
  { id: 'trae', label: 'TRAE', documentationUrl: 'https://docs.trae.cn/ide_add-mcp-servers' },
  { id: 'other', label: '其他 MCP 客户端', documentationUrl: 'https://modelcontextprotocol.io/specification/2025-11-25/basic/transports' },
]
const permissionOptions: Array<{ id: DesktopMcpPermission; label: string; note: string }> = [
  { id: 'canvas.read', label: '读取画布', note: '读取授权画布摘要、节点和素材元数据。' },
  { id: 'canvas.write', label: '编辑画布', note: '创建或修改授权画布中的节点、连线和布局。' },
  { id: 'generation.propose', label: '准备生成', note: '提交前由客户端通过 MCP 表单确认；桌面不重复确认。' },
  { id: 'task.read', label: '读取任务', note: '查看授权画布任务状态和文本结果。' },
  { id: 'media.read', label: '读取媒体', note: '只读取下方指定类别的结果预览或媒体内容；同时需要读取任务状态与结果。' },
  { id: 'provider.read', label: '读取模型配置', note: '查看公开模型能力和连接状态，不包含密钥。' },
  { id: 'provider.configure', label: '配置模型', note: '仅限下方指定的提供方和凭据字段；同时需要读取公开模型配置。' },
]
const mediaOptions = ['image', 'video', 'audio', 'text'] as const
const mediaLabels: Record<typeof mediaOptions[number], string> = {
  image: '图片', video: '视频', audio: '音频', text: '文本',
}
const modalityLabels: Record<string, string> = mediaLabels
const permissionLabels: Record<DesktopMcpPermission, string> = {
  'canvas.read': '读取画布',
  'canvas.write': '编辑画布',
  'generation.propose': '准备生成',
  'task.read': '读取任务',
  'media.read': '读取媒体',
  'provider.read': '读取模型配置',
  'provider.configure': '配置模型',
}
const inputModeOptions: Array<{ id: DesktopMcpCredentialInputMode; label: string }> = [
  { id: 'authorized_env', label: '授权的环境变量' },
  { id: 'desktop_input', label: '在 VibePaper 配置页输入' },
  { id: 'inline', label: '允许经外部 Agent 一次性提交' },
]

type ProviderDraft = {
  selected: boolean
  credentialFields: string[]
  credentialInputModes: DesktopMcpCredentialInputMode[]
  authorizedEnv: Record<string, string>
}

function configText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value ?? '') }
}

function providerDraft(provider: DesktopMcpProviderDescriptor): ProviderDraft {
  return {
    selected: false,
    credentialFields: [],
    credentialInputModes: ['authorized_env', 'desktop_input'],
    authorizedEnv: Object.fromEntries(provider.credentialFields.map((field) => [field.name, ''])),
  }
}

export function DesktopMcpSettingsPage() {
  useUiLanguage()
  const [state, setState] = useState<DesktopMcpState | null>(null)
  const [permissions, setPermissions] = useState<DesktopMcpPermission[]>(['canvas.read', 'canvas.write'])
  const [providerDrafts, setProviderDrafts] = useState<Record<string, ProviderDraft>>({})
  const [clientName, setClientName] = useState<DesktopMcpClientName>('codex')
  const [displayName, setDisplayName] = useState('')
  const [mediaTypes, setMediaTypes] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ tone: 'error' | 'success' | 'info'; text: string } | null>(null)
  const [lastCreated, setLastCreated] = useState<{ clientId: string; clientName: DesktopMcpClientName; config: DesktopMcpClientGrantResult['config'] } | null>(null)

  const refresh = useCallback(async () => {
    if (!bridge) throw new Error(uiText('桌面 MCP 接口尚未接入。'))
    const nextState = await bridge.getMcpState()
    setState(nextState)
    setProviderDrafts((current) => {
      const next = { ...current }
      for (const provider of nextState.providers ?? []) next[provider.providerId] ??= providerDraft(provider)
      return next
    })
  }, [])

  useEffect(() => {
    let active = true
    const load = async () => {
      try { await refresh() }
      catch (error) {
        if (active) setMessage({ tone: 'error', text: error instanceof Error ? error.message : uiText('读取 MCP 设置失败。') })
      }
    }
    void load()
    const unsubscribe = bridge?.subscribeMcpEvents((event: DesktopMcpEvent) => {
      if (event.type === 'state.changed' || event.type === 'canvas.changed' || event.type === 'task.changed') void refresh()
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [refresh])

  const activeCanvas = state?.activeCanvas
  const providerById = useMemo(() => new Map((state?.providers ?? []).map((provider) => [provider.providerId, provider])), [state?.providers])
  const providerScopeNeeded = permissions.includes('provider.configure') || permissions.includes('provider.read')
  const selectedProviderDrafts = (state?.providers ?? []).filter((provider) => (providerDrafts[provider.providerId] ?? providerDraft(provider)).selected)
  const invalidProviderInput = selectedProviderDrafts.some((provider) => {
    if (!permissions.includes('provider.configure')) return false
    const draft = providerDrafts[provider.providerId] ?? providerDraft(provider)
    if (!draft.credentialFields.length) return true
    return draft.credentialInputModes.includes('authorized_env') && draft.credentialFields.some((fieldName) => (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test((draft.authorizedEnv[fieldName] ?? '').trim())
    ))
  })
  const canGrant = canCreateMcpGrant({
    activeCanvas: Boolean(activeCanvas),
    busy: Boolean(busy),
    providerScopeNeeded,
    selectedProviderCount: selectedProviderDrafts.length,
    mediaRead: permissions.includes('media.read'),
    selectedMediaCount: mediaTypes.length,
    invalidProviderInput,
  })

  const setPermission = (permission: DesktopMcpPermission, enabled: boolean) => {
    setPermissions((current) => setMcpGrantPermission(current, permission, enabled))
    if (permission === 'media.read' && !enabled) setMediaTypes([])
  }

  const updateProviderDraft = (providerId: string, update: (current: ProviderDraft) => ProviderDraft) => {
    const provider = providerById.get(providerId)
    setProviderDrafts((current) => ({
      ...current,
      [providerId]: update(current[providerId] ?? (provider ? providerDraft(provider) : {
        selected: false, credentialFields: [], credentialInputModes: [], authorizedEnv: {},
      })),
    }))
  }

  const buildProviderGrants = (): DesktopMcpProviderGrantInput[] => {
    const needsProviderScope = permissions.includes('provider.configure') || permissions.includes('provider.read')
    if (!needsProviderScope) return []
    return (state?.providers ?? []).flatMap((provider) => {
      const draft = providerDrafts[provider.providerId] ?? providerDraft(provider)
      if (!draft.selected) return []
      const authorizedEnv = draft.credentialInputModes.includes('authorized_env')
        ? draft.credentialFields.map((fieldName) => ({ fieldName, envVariableName: (draft.authorizedEnv[fieldName] ?? '').trim() }))
        : []
      const grant = providerGrantForPermissions({
        providerId: provider.providerId,
        credentialFields: draft.credentialFields,
        credentialInputModes: draft.credentialInputModes,
        authorizedEnv,
      }, permissions.includes('provider.configure'))
      if (grant.authorizedEnv.some(({ envVariableName }) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envVariableName))) {
        throw new Error(uiText('请为授权的凭据字段填写有效的环境变量名。'))
      }
      return [grant]
    })
  }

  const createGrant = async () => {
    if (!bridge || !activeCanvas || !canGrant) return
    setBusy('create')
    setMessage(null)
    try {
      const input: DesktopMcpClientGrantInput = createMcpClientGrantInput({
        clientName,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        permissions,
        providerGrants: buildProviderGrants(),
        mediaTypes: permissions.includes('media.read') ? mediaTypes : [],
        disclosureVersion: state?.connectionDisclosureVersion ?? DISCLOSURE_VERSION,
      })
      const result = await bridge.createMcpClientGrant(input)
      setLastCreated({ clientId: result.clientId, clientName, config: result.config })
      setMessage({ tone: 'success', text: uiText('已记录所选访问范围并生成连接配置。客户端将按此范围自动连接；生成时由客户端表单确认。') })
      setDisplayName('')
      await refresh()
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : uiText('创建客户端授权失败。') })
    } finally { setBusy(null) }
  }

  const toggleMcp = async () => {
    if (!bridge || busy) return
    setBusy('toggle')
    setMessage(null)
    try {
      setState(await bridge.setMcpEnabled(!state?.enabled))
      setMessage({ tone: 'success', text: state?.enabled ? uiText('外部 Agent 连接已关闭。') : uiText('外部 Agent 连接已启用。') })
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : uiText('无法更新 MCP 状态。') })
    } finally { setBusy(null) }
  }

  const revoke = async (clientId: string) => {
    if (!bridge || busy) return
    setBusy(clientId)
    setMessage(null)
    try {
      await bridge.revokeMcpClientGrant(clientId)
      setMessage({ tone: 'success', text: uiText('该客户端授权已撤销。') })
      await refresh()
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : uiText('撤销授权失败。') })
    } finally { setBusy(null) }
  }

  const copyConfig = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setMessage({ tone: 'success', text: uiText('{0} 配置已复制。', { 0: label }) })
    } catch {
      setMessage({ tone: 'error', text: uiText('无法访问剪贴板，请手动复制配置。') })
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6" data-testid="mcp-settings-page">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#66748d]">{uiText('桌面连接')}</p>
          <h1 className="mt-1 text-2xl font-bold text-[#172238]">{uiText('外部 Agent / MCP')}</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#526079]">{uiText('授权 Codex、Claude Code、Cursor、WorkBuddy、TRAE 等本机 Agent 操作当前本地画布。生成只在所选客户端中确认一次，桌面不会重复确认；不支持确认表单的客户端无法生成。')}</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={Boolean(busy)} className="inline-flex items-center gap-2 rounded-lg border border-[#d7deea] bg-white px-3 py-2 text-sm font-medium text-[#43516a] disabled:opacity-50">
          <RefreshCw size={15} />{uiText('刷新状态')}
        </button>
      </header>

      {message && <p role={message.tone === 'error' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${message.tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : message.tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-blue-200 bg-blue-50 text-blue-800'}`}>{message.text}</p>}

      <section className="rounded-2xl border border-[#e0e6ef] bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-[#eef3fb] text-[#315d9d]"><PlugZap size={21} /></span>
            <div>
              <h2 className="font-semibold text-[#1d2b43]">{uiText('MCP 服务')}</h2>
              <p className="mt-1 text-sm text-[#69768c]">{state?.enabled ? uiText('已启用；客户端按下方保存的项目、画布、媒体和提供方范围自动连接。') : uiText('默认关闭。启用并创建范围授权后，本机 MCP 客户端可自动连接。')}</p>
            </div>
          </div>
          <button type="button" data-testid="mcp-enabled-toggle" aria-pressed={Boolean(state?.enabled)} onClick={() => void toggleMcp()} disabled={!state || Boolean(busy)} className={`rounded-lg px-4 py-2 text-sm font-semibold ${state?.enabled ? 'bg-[#dfece7] text-[#236448]' : 'bg-[#213d68] text-white'} disabled:opacity-50`}>
            {busy === 'toggle' ? uiText('正在更新…') : state?.enabled ? uiText('关闭 MCP') : uiText('启用 MCP')}
          </button>
        </div>
        <div className="mt-4 rounded-xl bg-[#f6f8fb] px-4 py-3 text-sm text-[#526079]">
          {activeCanvas
            ? <><span className="font-semibold">{uiText('授权画布：')}</span>{activeCanvas.name || activeCanvas.canvasId} <span className="text-[#8b95a6]">· {uiText('版本')} {activeCanvas.version}</span></>
            : uiText('尚未选择本地项目。先打开原画布创作页，再为当前项目创建授权。')}
          <span className="ml-2 inline-flex items-center gap-1 text-xs">{state?.canvasReady ? <><Check size={13} className="text-emerald-600" />{uiText('保存同步已就绪')}</> : uiText('画布页未打开；MCP 写入会保持不可用。')}</span>
        </div>
      </section>

      <section className="rounded-2xl border border-[#e0e6ef] bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-[#1d2b43]">{uiText('授权新客户端')}</h2>
        <p className="mt-1 text-sm text-[#69768c]">{uiText('每个客户端单独设置权限范围。配置片段只含本机启动参数，不包含连接秘密或模型 API Key；连接会自动验证受限本地凭据。')}</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-[#35435a]">{uiText('客户端')}
            <select value={clientName} onChange={(event) => { setClientName(event.target.value as DesktopMcpClientName); setLastCreated(null) }} className="mt-1.5 w-full rounded-lg border border-[#d5ddea] bg-white px-3 py-2.5 text-sm">
              {clientOptions.map((client) => <option key={client.id} value={client.id}>{client.id === 'other' ? uiText(client.label) : client.label}</option>)}
            </select>
          </label>
          <label className="block text-sm font-medium text-[#35435a]">{uiText('显示名称（可选）')}
            <input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} className="mt-1.5 w-full rounded-lg border border-[#d5ddea] px-3 py-2.5 text-sm" placeholder={uiText('例如：个人 Codex')} />
          </label>
        </div>
        {clientName === 'trae' && <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{uiText('TRAE 要求 command 不含空格。若 VibePaper 运行路径包含空格，设置页会隐藏无法运行的 TRAE 配置。')}</p>}

        <div className="mt-5 grid gap-2 md:grid-cols-2">
          {permissionOptions.map((option) => (
            <label key={option.id} className="flex cursor-pointer gap-3 rounded-xl border border-[#e7ebf2] p-3">
              <input type="checkbox" checked={permissions.includes(option.id)} disabled={(option.id === 'provider.read' && permissions.includes('provider.configure')) || (option.id === 'task.read' && permissions.includes('media.read'))} onChange={(event) => setPermission(option.id, event.target.checked)} className="mt-1 accent-[#315d9d]" />
              <span><span className="block text-sm font-semibold text-[#26364f]">{uiText(option.label)}</span><span className="mt-0.5 block text-xs leading-5 text-[#69768c]">{uiText(option.note)}</span></span>
            </label>
          ))}
        </div>

        {permissions.includes('provider.read') || permissions.includes('provider.configure') ? (
          <div className="mt-5 space-y-3">
            <h3 className="text-sm font-semibold text-[#26364f]">{uiText('提供方范围与凭据输入方式')}</h3>
            {(state?.providers ?? []).map((provider) => {
              const draft = providerDrafts[provider.providerId] ?? providerDraft(provider)
              return (
                <div key={provider.providerId} className="rounded-xl border border-[#e7ebf2] p-4" data-testid={`mcp-provider-${provider.providerId}`}>
                  <label className="flex items-center gap-2 text-sm font-semibold text-[#26364f]">
                    <input type="checkbox" checked={draft.selected} onChange={(event) => updateProviderDraft(provider.providerId, (current) => ({ ...current, selected: event.target.checked }))} className="accent-[#315d9d]" />
                    {uiText(desktopProviderLabel(provider.providerId, provider.name))} <span className="text-xs font-normal text-[#758198]">{provider.modalities.map((modality) => uiText(modalityLabels[modality] ?? modality)).join(' / ')}</span>
                  </label>
                  {draft.selected && permissions.includes('provider.configure') && (
                    <div className="mt-3 space-y-3 border-t border-[#edf0f5] pt-3">
                      <div>
                        <p className="text-xs font-semibold text-[#526079]">{uiText('可写凭据字段')}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {provider.credentialFields.map((field) => (
                            <label key={field.name} className="inline-flex items-center gap-1.5 rounded-lg bg-[#f6f8fb] px-2.5 py-1.5 text-xs text-[#43516a]">
                              <input type="checkbox" checked={draft.credentialFields.includes(field.name)} onChange={(event) => updateProviderDraft(provider.providerId, (current) => ({ ...current, credentialFields: event.target.checked ? [...new Set([...current.credentialFields, field.name])] : current.credentialFields.filter((name) => name !== field.name) }))} className="accent-[#315d9d]" />
                              {uiText(field.label)}
                            </label>
                          ))}
                        </div>
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-[#526079]">{uiText('允许的凭据输入方式')}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {inputModeOptions.map((option) => (
                            <label key={option.id} className="inline-flex items-center gap-1.5 rounded-lg bg-[#f6f8fb] px-2.5 py-1.5 text-xs text-[#43516a]">
                              <input type="checkbox" checked={draft.credentialInputModes.includes(option.id)} onChange={(event) => updateProviderDraft(provider.providerId, (current) => ({ ...current, credentialInputModes: event.target.checked ? [...new Set([...current.credentialInputModes, option.id])] : current.credentialInputModes.filter((mode) => mode !== option.id) }))} className="accent-[#315d9d]" />
                              {uiText(option.label)}
                            </label>
                          ))}
                        </div>
                      </div>
                      {draft.credentialInputModes.includes('authorized_env') && draft.credentialFields.length > 0 && (
                        <div className="grid gap-2 md:grid-cols-2">
                          {provider.credentialFields.filter((field) => draft.credentialFields.includes(field.name)).map((field) => (
                            <label key={field.name} className="text-xs text-[#526079]">{uiText(field.label)} · {uiText('环境变量名')}
                              <input value={draft.authorizedEnv[field.name] ?? ''} onChange={(event) => updateProviderDraft(provider.providerId, (current) => ({ ...current, authorizedEnv: { ...current.authorizedEnv, [field.name]: event.target.value } }))} spellCheck={false} autoComplete="off" className="mt-1 w-full rounded-lg border border-[#d5ddea] px-2.5 py-2 font-mono text-xs" placeholder="VIBEPAPER_PROVIDER_API_KEY" />
                            </label>
                          ))}
                        </div>
                      )}
                      {draft.credentialInputModes.includes('inline') && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">{uiText('外部聊天或工具日志可能保存你提交的 Key；VibePaper 无法替外部客户端删除或保证脱敏。')}</p>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : null}

        {permissions.includes('media.read') && (
          <div className="mt-5 rounded-xl border border-[#e7ebf2] p-4">
            <h3 className="text-sm font-semibold text-[#26364f]">{uiText('允许读取的媒体类别')}</h3>
            <p className="mt-1 text-xs text-[#69768c]">{uiText('画布和素材元数据不等于媒体内容授权。只向外部 Agent 开放所选类别。')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {mediaOptions.map((mediaType) => (
                <label key={mediaType} className="inline-flex items-center gap-2 rounded-lg bg-[#f6f8fb] px-3 py-2 text-sm text-[#43516a]">
                  <input type="checkbox" checked={mediaTypes.includes(mediaType)} onChange={(event) => setMediaTypes((current) => event.target.checked ? [...new Set([...current, mediaType])] : current.filter((value) => value !== mediaType))} className="accent-[#315d9d]" />
                  {uiText(mediaLabels[mediaType])}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/70 p-4 text-sm leading-6 text-[#38516f]">
          <div className="flex items-start gap-2"><ShieldCheck size={18} className="mt-0.5 shrink-0" /><div>
            <p className="font-semibold">{uiText('范围、数据发送与费用')}</p>
            <p className="mt-1">{uiText('创建授权会记录当前项目与画布、所选权限、媒体类别、提供方及可写凭据字段。外部 Agent 读取的提示词、文本和所选媒体可能由客户端发给它自己的模型供应商。使用云端生成模型时，本次请求所需的提示词、参数和参考内容会发送给所选提供方，供应商可能收费；具体范围和费用依厂商及实际请求而定。')}</p>
            <p className="mt-1">{uiText('生成确认只在支持 MCP 表单的客户端中显示一次；拒绝、超时或不支持该能力时不会创建生成任务。模型凭据不能通过确认表单收集。')}</p>
          </div></div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-[#78849a]">{uiText('启用服务并创建授权即记录上述所选范围；后续连接、配置和安全检测在范围内自动执行。')}</p>
          <button type="button" onClick={() => void createGrant()} disabled={!canGrant} data-testid="mcp-create-grant" className="rounded-lg bg-[#213d68] px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
            {busy === 'create' ? uiText('正在创建…') : uiText('创建授权并显示配置')}
          </button>
        </div>
      </section>

      {lastCreated && (
        <section className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm" data-testid="mcp-client-config">
          <h2 className="font-semibold text-[#1d2b43]">{uiText('客户端连接配置')}</h2>
          <p className="mt-1 text-sm text-[#69768c]">{uiText('此授权对应 {0}。复制下方配置到该客户端；配置不含连接秘密或模型凭据。', { 0: clientOptions.find((client) => client.id === lastCreated.clientName)?.label ?? lastCreated.clientName })}</p>
          <a className="mt-2 inline-block text-sm text-[#315d9d] underline" href={clientOptions.find((client) => client.id === lastCreated.clientName)?.documentationUrl} target="_blank" rel="noreferrer">{uiText('查看客户端官方 MCP 配置说明')}</a>
          <p className="mt-2 text-xs leading-5 text-[#69768c]">{uiText('本次 MCP 生成确认尚未在该客户端通过本项目的真实客户端验收。若客户端不支持 MCP 表单确认，生成会返回明确错误且不会提交任务。')}</p>
          {lastCreated.clientName === 'trae' && !lastCreated.config.traeCommandCompatible ? (
            <p role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{uiText('当前 VibePaper 可执行文件路径含空格，违反 TRAE 对 command 的限制，因此未生成 TRAE 配置。请从不含空格的路径启动 VibePaper（例如 E:\\pp\\Pi-Paper\\Pi-Paper.exe），然后重新创建授权。')}</p>
          ) : (() => {
            const value = getMcpClientConfigText(lastCreated.config, lastCreated.clientName)
            if (!value) return null
            const label = clientOptions.find((client) => client.id === lastCreated.clientName)?.label ?? lastCreated.clientName
            const key = lastCreated.clientName
            return <div className="mt-4">
              <div className="mb-1 flex items-center justify-between"><label htmlFor={`mcp-config-${key}`} className="text-sm font-semibold text-[#35435a]">{label}</label><button type="button" onClick={() => void copyConfig(label, value)} className="inline-flex items-center gap-1.5 rounded-md border border-[#d7deea] px-2.5 py-1 text-xs text-[#43516a]"><Clipboard size={13} />{uiText('复制')}</button></div>
              <textarea id={`mcp-config-${key}`} readOnly value={configText(value)} rows={8} className="w-full resize-y rounded-lg border border-[#d5ddea] bg-[#f7f8fa] p-3 font-mono text-xs text-[#35435a]" />
            </div>
          })()}
        </section>
      )}

      <section className="rounded-2xl border border-[#e0e6ef] bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold text-[#1d2b43]">{uiText('已授权客户端')}</h2><span className="text-xs text-[#7b879b]">{state?.clients.length ?? 0}</span></div>
        <div className="mt-3 space-y-2">
          {(state?.clients ?? []).length === 0 ? <p className="rounded-xl bg-[#f6f8fb] px-4 py-4 text-sm text-[#69768c]">{uiText('当前没有客户端授权。')}</p> : state?.clients.map((client) => (
            <div key={client.clientId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e7ebf2] p-4" data-testid={`mcp-client-${client.clientId}`}>
              <div className="min-w-0">
                <p className="font-semibold text-[#26364f]">{client.displayName || (clientOptions.find((option) => option.id === client.clientName)?.id === 'other' ? uiText('其他 MCP 客户端') : clientOptions.find((option) => option.id === client.clientName)?.label) || client.clientName}</p>
                <p className="mt-1 text-xs text-[#69768c]">{uiText('画布')} · {client.canvasId} · {client.permissions.map((permission) => uiText(permissionLabels[permission] ?? permission)).join('、')}</p>
                {client.providerGrants.length > 0 && <p className="mt-1 text-xs text-[#69768c]">{client.providerGrants.map((grant) => {
                  const provider = providerById.get(grant.providerId)
                  return provider ? uiText(desktopProviderLabel(provider.providerId, provider.name)) : grant.providerId
                }).join('、')}</p>}
                {client.revokedAt && <p className="mt-1 text-xs font-medium text-red-700">{uiText('已撤销')}</p>}
              </div>
              {!client.revokedAt && <button type="button" onClick={() => void revoke(client.clientId)} disabled={Boolean(busy)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"><Trash2 size={15} />{uiText('撤销授权')}</button>}
            </div>
          ))}
        </div>
      </section>

    </div>
  )
}
