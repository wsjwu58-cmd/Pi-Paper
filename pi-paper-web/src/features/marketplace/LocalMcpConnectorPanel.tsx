import { useCallback, useEffect, useRef, useState } from 'react'
import { t as uiText } from '@/lib/i18n'

type Source = { id: string; text: string }
type Props = {
  projectId: string; packageId: string; componentId: string
  source?: Source
  onApplyText?: (output: string, source: Source) => Promise<void>
}
type Binding = { executable: string; toolName: string | null }
type Discovery = { token: string; tools: Array<{ name: string; description: string }> }

const errors: Record<string, string> = {
  LOCAL_MCP_EXECUTABLE_INVALID: '程序不可用；请选择本机可执行文件。Windows 当前只支持独立的 .exe 程序。',
  LOCAL_MCP_EXECUTABLE_CHANGED: '程序内容已变化，请重新选择并检查工具。',
  LOCAL_MCP_COMPONENT_CHANGED: '连接器已变更，请清除配置后重新选择程序。',
  LOCAL_MCP_EXECUTABLE_REQUIRED: '请先选择本地程序。',
  LOCAL_MCP_TOOL_REQUIRED: '请先读取并选择工具。',
  LOCAL_MCP_SELECTION_EXPIRED: '工具列表已过期，请重新读取。',
  LOCAL_MCP_TOOL_CHANGED: '工具定义已变化，请重新读取并选择工具。',
  LOCAL_MCP_TEXT_INVALID: '请输入不超过 20000 个字符的文本。',
  LOCAL_MCP_RESULT_UNSUPPORTED: '工具未返回受支持的文本；它可能已经执行，请检查程序状态。',
  LOCAL_MCP_RESULT_TOO_LARGE: '工具返回的文本过长；它可能已经执行，请检查程序状态。',
  LOCAL_MCP_TOOL_FAILED: '工具报告调用失败；它可能已经执行，请检查程序状态。',
  LOCAL_MCP_CONNECTION_FAILED: '无法连接本机 MCP 服务或调用超时；工具可能已经执行，请检查程序状态后再重试。',
  LOCAL_MCP_PROCESS_TERMINATION_FAILED: '无法确认本机程序已退出，请在系统中检查该程序。',
  LOCAL_MCP_TOOLS_INVALID: '服务返回的工具列表无效或过长。',
  LOCAL_MCP_CONFIG_FULL: '本机连接器配置已满，请先清除不再使用的配置。',
  MARKETPLACE_COMPONENT_NOT_AVAILABLE: '连接器未安装或已停用。',
  AGENT_PROJECT_CHANGED: '当前项目已切换。',
  CONNECTOR_SELECTION_CHANGED: '所选文字节点或内容已变化，请重新运行工具。',
  CONNECTOR_CONTEXT_CHANGED: '项目或画布已变化，请重新操作。',
  CONNECTOR_APPLY_SAVE_UNCONFIRMED: '保存结果未确认，请先检查画布。',
}
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const code = Object.keys(errors).find((item) => message.includes(item))
  return uiText(code ? errors[code] : '本机连接器操作失败，请检查程序和当前项目。')
}

/** A local executable is a trusted OS process, not a sandboxed plugin. */
export function LocalMcpConnectorPanel({ projectId, packageId, componentId, source, onApplyText }: Props) {
  const connector = window.vibepaperDesktop?.localMcpConnector
  const [binding, setBinding] = useState<Binding | null>(null)
  const [discovery, setDiscovery] = useState<Discovery | null>(null)
  const [text, setText] = useState(source?.text ?? '')
  const [result, setResult] = useState('')
  const [resultSource, setResultSource] = useState<Source | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const invocation = useRef(0)
  useEffect(() => {
    invocation.current++
    setText(source?.text ?? '')
    setResult('')
    setResultSource(null)
  }, [source?.id, source?.text])
  const refresh = useCallback(async () => {
    if (!connector) throw new Error('CONNECTOR_UNAVAILABLE')
    setBinding(await connector.get(projectId, packageId, componentId))
  }, [connector, projectId, packageId, componentId])
  useEffect(() => {
    let live = true
    if (!connector) { setMessage(uiText('本机连接器服务不可用。')); return }
    void connector.get(projectId, packageId, componentId).then((value) => {
      if (live) setBinding(value)
    }).catch((error: unknown) => { if (live) setMessage(errorMessage(error)) })
    return () => { live = false }
  }, [connector, projectId, packageId, componentId])

  const action = async (operation: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setMessage('')
    try { await operation() } catch (error) { setMessage(errorMessage(error)) } finally { busyRef.current = false; setBusy(false) }
  }
  const choose = () => void action(async () => {
    if (!connector) throw new Error('CONNECTOR_UNAVAILABLE')
    const selected = await connector.choose(projectId, packageId, componentId)
    if (selected) { setBinding(selected); setDiscovery(null); setResult('') }
  })
  const clear = () => void action(async () => {
    if (!connector) throw new Error('CONNECTOR_UNAVAILABLE')
    await connector.clear(projectId, packageId, componentId)
    setBinding(null); setDiscovery(null); setResult('')
  })
  const discover = () => void action(async () => {
    if (!connector) throw new Error('CONNECTOR_UNAVAILABLE')
    const next = await connector.discover(projectId, packageId, componentId)
    setDiscovery(next)
    if (!next.tools.length) setMessage(uiText('没有找到只接收一个 text 字段的兼容工具。'))
  })
  const select = (name: string) => void action(async () => {
    if (!connector || !discovery) throw new Error('CONNECTOR_UNAVAILABLE')
    const next = await connector.select(projectId, packageId, componentId, discovery.token, name)
    setBinding(next); setDiscovery(null); setResult('')
  })
  const run = () => void action(async () => {
    if (!connector) throw new Error('CONNECTOR_UNAVAILABLE')
    const current = ++invocation.current
    const snapshot = source ? { ...source } : null
    setResult(''); setResultSource(null)
    const output = await connector.run(projectId, packageId, componentId, text)
    if (current !== invocation.current) return
    setResult(output); setResultSource(snapshot)
    await refresh()
  })
  return (
    <div className="mt-3 space-y-3 rounded-xl border border-[#dce5f0] bg-[#f8fafc] p-4 text-sm text-[#35435a]" data-testid="local-mcp-connector">
      <p className="font-semibold">{uiText('连接本地 MCP 文本工具')}</p>
      <p className="leading-6">{uiText('只选择你信任的程序。读取工具和调用时会启动该程序；它以当前系统用户权限运行，可以自行读写文件或联网，VibePaper 无法限制其行为。插件包不会提供程序、参数或密钥。')}</p>
      <p className="text-xs leading-5 text-[#69768c]">{uiText('当前仅支持无需命令行参数的独立 stdio MCP 程序，不注入应用密钥或自定义环境变量。工具只接收 text，程序会收到下方输入；结果仅显示在此处，不自动修改画布。')}</p>
      {message && <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">{message}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={choose} className="rounded-lg border border-[#cbd7e6] bg-white px-3 py-2 disabled:opacity-50">{uiText('选择本地程序')}</button>
        <button type="button" disabled={busy} onClick={clear} className="rounded-lg border border-[#cbd7e6] bg-white px-3 py-2 disabled:opacity-50">{uiText('清除本机配置')}</button>
        {binding && <button type="button" disabled={busy} onClick={discover} className="rounded-lg border border-[#cbd7e6] bg-white px-3 py-2 disabled:opacity-50">{uiText('启动程序并读取工具')}</button>}
      </div>
      {binding && <p className="break-all text-xs">{uiText('已选程序：')}{binding.executable}<br />{uiText('已选工具：')}{binding.toolName || uiText('尚未选择')}</p>}
      {discovery && discovery.tools.length > 0 && <div className="space-y-2">
        <p className="font-medium">{uiText('选择本次要授权使用的工具：')}</p>
        {discovery.tools.map((tool) => <div key={tool.name} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-white p-3">
          <div className="min-w-0"><p className="break-all font-medium">{tool.name}</p><p className="whitespace-pre-wrap break-words text-xs text-[#69768c]">{tool.description}</p></div>
          <button type="button" disabled={busy} onClick={() => select(tool.name)} className="rounded-lg border border-[#cbd7e6] px-3 py-1.5 disabled:opacity-50">{uiText('选择此工具')}</button>
        </div>)}
      </div>}
      {binding?.toolName && <div className="space-y-2">
        <label className="block font-medium">{uiText('要发送给本地程序的文本（可粘贴选区）')}
          <textarea value={text} onChange={(event) => setText(event.target.value)} disabled={busy} maxLength={20000} rows={4} className="mt-1 w-full rounded-lg border border-[#cbd7e6] bg-white p-2 font-normal" />
        </label>
        {text.length > 20000 && <p className="text-xs text-amber-900">{uiText('输入超过 20000 个字符，请缩短后再运行。')}</p>}
        <button type="button" disabled={busy || !text.trim() || text.length > 20000} onClick={run} className="rounded-lg bg-[#213d68] px-3 py-2 font-semibold text-white disabled:opacity-50">{busy ? uiText('正在运行…') : uiText('运行所选工具')}</button>
        {result && <label className="block font-medium">{uiText('工具结果（可选择并复制）')}
          <textarea readOnly value={result} rows={5} className="mt-1 w-full rounded-lg border border-[#cbd7e6] bg-white p-2 font-normal" />
        </label>}
        {result && resultSource && onApplyText && <button type="button" disabled={busy} onClick={() => void action(() => onApplyText(result, resultSource))} className="rounded-lg border border-[#cbd7e6] bg-white px-3 py-2 font-semibold disabled:opacity-50">{uiText('保存为新文字节点')}</button>}
      </div>}
    </div>
  )
}
