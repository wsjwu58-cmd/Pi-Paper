import { useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import {
  BarChart3, BookOpen, Bot, Check, ChevronDown, Clapperboard, Focus, Grid2x2,
  Hand, History, Image as ImageIcon, Layers, Library, Mic, MousePointer2, Plus, Puzzle, Send,
  Settings2, SlidersHorizontal, Square, SquarePlus, Type, Undo2, Upload, X,
} from 'lucide-react'
import { AgentEmptyState } from '@/features/canvas/AgentEmptyState'
import { AgentTurnTimeline } from '@/features/canvas/AgentExecutionRecord'
import type { DesktopAgentMessage, DesktopAgentSession, DesktopProject } from './desktop-bridge'

interface ChromeProps {
  project: DesktopProject
  saveLabel: string
  saveError: string
  backupMessage: string
  assetsOpen: boolean
  agentOpen: boolean
  mode: 'select' | 'pan'
  onModeChange: (mode: 'select' | 'pan') => void
  onAssetsChange: (open: boolean) => void
  onAgentChange: (open: boolean) => void
  onAddText: () => void
  onAddImage: () => void
  onAddVideo: () => void
  onAddAudio: () => void
  onAddCompose: () => void
  onAddDirector: () => void
  onAutoLayout: () => void
  onImportImage: () => void
  onOpenModels: () => void
  onBackup: () => void
  onRestore: () => void
  onSwitchProject: () => void
}

function IconButton({ title, onClick, children, active = false }: {
  title: string; onClick: () => void; children: React.ReactNode; active?: boolean
}) {
  return <button type="button" title={title} aria-label={title} onClick={onClick}
    className={`flex h-9 w-9 items-center justify-center rounded-full transition ${active ? 'bg-[#111] text-white' : 'text-[#666] hover:bg-black/5 hover:text-[#111]'}`}>
    {children}
  </button>
}

export function DesktopCanvasChrome(props: ChromeProps) {
  const { fitView } = useReactFlow()
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [nodeMenuOpen, setNodeMenuOpen] = useState(false)

  return <>
    <div className="pointer-events-auto absolute left-4 top-4 z-30">
      <div className="relative flex h-11 items-center gap-2 rounded-[18px] bg-[#1a1a1b] px-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
        <button type="button" title="项目操作" aria-label="项目操作" onClick={() => setProjectMenuOpen((open) => !open)} className="rounded-full p-2.5 text-white/70 hover:bg-white/10 hover:text-white"><Undo2 size={16} /></button>
        <div className="min-w-0 pr-2">
          <p className="max-w-48 truncate text-[14px] font-bold text-white">{props.project.name}</p>
          <p className="text-[11px] text-white/50">{props.saveError ? <span className="text-red-300" title={props.saveError}>保存失败</span> : props.saveLabel === '已保存' ? <span className="inline-flex items-center gap-1 text-emerald-400"><Check size={11} /> 已保存到本地</span> : props.saveLabel}</p>
        </div>
        {projectMenuOpen && <div className="absolute left-0 top-12 z-50 w-56 rounded-[18px] border border-black/8 bg-white p-1.5 text-[#333] shadow-xl">
          <p className="px-3 py-1 text-[11px] font-bold text-[#999]">本地项目</p>
          <button onClick={props.onSwitchProject} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-black/5">切换项目</button>
          <button onClick={props.onBackup} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-black/5">备份项目</button>
          <button onClick={props.onRestore} className="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-black/5">恢复备份副本</button>
          {props.backupMessage && <p className="px-3 py-2 text-xs text-[#666]" role="status">{props.backupMessage}</p>}
        </div>}
      </div>
    </div>

    <div className="pointer-events-auto absolute right-4 top-4 z-30 flex h-11 items-center gap-1 rounded-[18px] border border-black/6 bg-white/95 px-1.5 shadow-[0_12px_40px_rgba(15,23,42,0.10)] backdrop-blur">
      <button type="button" onClick={() => setProjectMenuOpen((open) => !open)} className="flex items-center gap-2 rounded-full px-1.5 py-1 hover:bg-black/[0.04]">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#111] text-xs font-bold text-white">{props.project.name.slice(0, 1)}</span>
        <span className="hidden text-left sm:block"><span className="block max-w-24 truncate text-[13px] font-bold leading-tight text-[#111]">{props.project.name}</span><span className="block text-[11px] font-semibold text-[#666]">本地项目</span></span>
        <ChevronDown size={13} className="text-[#999]" />
      </button>
      <span className="mx-1 h-5 w-px bg-black/8" />
      <IconButton title="Paper Agent" active={props.agentOpen} onClick={() => props.onAgentChange(!props.agentOpen)}><Bot size={17} /></IconButton>
      <IconButton title="素材库" active={props.assetsOpen} onClick={() => props.onAssetsChange(!props.assetsOpen)}><Library size={17} /></IconButton>
      <IconButton title="模型与 API Key" onClick={props.onOpenModels}><Settings2 size={17} /></IconButton>
    </div>

    <div className="pointer-events-auto absolute left-4 top-1/2 z-30 -translate-y-1/2">
      <div className="flex flex-col gap-1 rounded-[24px] border border-white/10 bg-[#1a1c24]/95 px-2 py-3 shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-md">
        <ToolButton title="选择模式" active={props.mode === 'select'} onClick={() => props.onModeChange('select')}><MousePointer2 size={17} /></ToolButton>
        <ToolButton title="抓手模式" active={props.mode === 'pan'} onClick={() => props.onModeChange('pan')}><Hand size={17} /></ToolButton>
        <span className="mx-2 my-1 h-px bg-white/10" />
        <div className="relative">
          <ToolButton title="添加节点" active={nodeMenuOpen} onClick={() => setNodeMenuOpen((open) => !open)}><Plus size={18} /></ToolButton>
          {nodeMenuOpen && <div className="absolute left-[58px] top-0 z-50 w-[220px] rounded-[20px] border border-white/10 bg-[#1a1c24] p-3 shadow-[0_24px_72px_rgba(0,0,0,0.35)]">
            <p className="mb-2 px-1 text-[11px] font-bold text-[#8e929c]">添加节点</p>
            <button onClick={() => { props.onAddText(); setNodeMenuOpen(false) }} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-white hover:bg-white/10"><Type size={17} /> 文本</button>
            <button onClick={() => { props.onAddImage(); setNodeMenuOpen(false) }} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-white hover:bg-white/10"><ImageIcon size={17} /> 图片</button>
            <button onClick={() => { props.onAddVideo(); setNodeMenuOpen(false) }} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-white hover:bg-white/10"><Clapperboard size={17} /> 视频</button>
            <button onClick={() => { props.onAddAudio(); setNodeMenuOpen(false) }} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-white hover:bg-white/10"><Mic size={17} /> 音频</button>
            <button onClick={() => { props.onAddCompose(); setNodeMenuOpen(false) }} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-white hover:bg-white/10"><Clapperboard size={17} /> 合成</button>
            <button onClick={() => { props.onAddDirector(); setNodeMenuOpen(false) }} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-white hover:bg-white/10"><Layers size={17} /> 导演台</button>
          </div>}
        </div>
        <ToolButton title="导入图片" onClick={props.onImportImage}><Upload size={17} /></ToolButton>
        <ToolButton title="素材库" onClick={() => props.onAssetsChange(true)}><Library size={17} /></ToolButton>
        <span className="mx-2 my-1 h-px bg-white/10" />
        <ToolButton title="聚焦视图" onClick={() => void fitView()}><Focus size={17} /></ToolButton>
        <ToolButton title="网格整理" onClick={props.onAutoLayout}><Grid2x2 size={17} /></ToolButton>
      </div>
    </div>
  </>
}

function ToolButton({ title, active = false, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" title={title} aria-label={title} onClick={onClick} className={`flex h-10 w-10 items-center justify-center rounded-full transition ${active ? 'bg-white text-[#1a1c24]' : 'text-white/75 hover:bg-white/10 hover:text-white'}`}>{children}</button>
}

export function DesktopAgentPanel({ sessions, activeSessionId, messages, draft, sending, creating, agnesConfigured, error, onDraftChange, onNewSession, onSelectSession, onSend, onConfigure, onClose }: {
  sessions: DesktopAgentSession[]
  activeSessionId: string | null
  messages: DesktopAgentMessage[]
  draft: string
  sending: boolean
  creating: boolean
  agnesConfigured: boolean
  error: string
  onDraftChange: (value: string) => void
  onNewSession: () => Promise<void>
  onSelectSession: (sessionId: string) => Promise<void>
  onSend: () => Promise<void>
  onConfigure: () => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<'chat' | 'history'>('chat')
  const [width, setWidth] = useState(380)
  const resizeStart = useRef<{ x: number; width: number } | null>(null)
  return <aside className="relative z-30 flex h-full flex-none flex-col overflow-visible border-l border-[var(--canvas-border)] bg-[var(--canvas-surface)] text-[var(--canvas-text)] shadow-xl shadow-black/20 backdrop-blur-md" style={{ width }}>
    <div role="separator" aria-orientation="vertical" aria-label="调整 Agent 面板宽度" className="group absolute -left-1.5 top-0 z-40 h-full w-3 cursor-col-resize touch-none select-none" onPointerDown={(event) => { resizeStart.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={(event) => { if (resizeStart.current) setWidth(Math.min(720, Math.max(300, resizeStart.current.width + resizeStart.current.x - event.clientX))) }} onPointerUp={() => { resizeStart.current = null }} onPointerCancel={() => { resizeStart.current = null }} onDoubleClick={() => setWidth(380)}><span aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-full w-[3px] -translate-x-1/2 bg-transparent transition-colors group-hover:bg-[var(--canvas-border-strong)] group-active:bg-[var(--canvas-border-strong)]" /></div>
    <div className="flex items-center justify-between px-4 py-3.5">
      <div className="flex items-center gap-2.5"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#111] text-white"><Bot size={16} /></span><div><p className="max-w-[140px] truncate text-[14px] font-bold text-[#111]">{sessions.find((session) => session.sessionId === activeSessionId)?.title || '新对话'}</p><p className="text-[11px] text-[#999]">Paper Agent</p></div></div>
      <div className="flex items-center gap-0.5">
        <IconButton title="新对话" onClick={() => void onNewSession()}><SquarePlus size={16} /></IconButton>
        <button title="Skills 尚未接入桌面版" disabled className="rounded-full p-2 text-[#bbb]"><BookOpen size={16} /></button>
        <button title="短剧资产尚未接入桌面版" disabled className="rounded-full p-2 text-[#bbb]"><Clapperboard size={16} /></button>
        <IconButton title="历史" active={tab === 'history'} onClick={() => setTab(tab === 'history' ? 'chat' : 'history')}><History size={16} /></IconButton>
        <button title="用量视图尚未接入桌面版" disabled className="rounded-full p-2 text-[#bbb]"><BarChart3 size={16} /></button>
        <IconButton title="偏好设置" onClick={onConfigure}><Settings2 size={16} /></IconButton>
        <IconButton title="关闭" onClick={onClose}><X size={16} /></IconButton>
      </div>
    </div>
    {tab === 'chat' ? <div className="flex min-h-0 flex-1 flex-col bg-[var(--canvas-surface)]">
      <div className="min-h-0 flex-1 overflow-y-auto bg-transparent px-3.5 pb-8 pt-3.5" aria-live="polite">
        {messages.length === 0 && <AgentEmptyState onSuggestion={onDraftChange} />}
        {messages.map((message, index) => <div key={`${message.createdAt}-${index}`} className={`mb-4 flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}><div className={message.role === 'user' ? 'max-w-[94%] whitespace-pre-line rounded-[18px] bg-[#efefef] px-3.5 py-2.5 text-[15px] leading-[1.65] text-[#111]' : 'w-full min-w-0 px-1 py-1 text-[15px] leading-[1.7] text-[#222]'}>{message.role === 'assistant' ? <AgentTurnTimeline steps={[]} content={message.content} /> : message.content}</div></div>)}
        {sending && <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-[#888]"><span className="h-2 w-2 rounded-full bg-emerald-500" />正在工作</p>}
      </div>
      {error && <p role="alert" className="mx-3 mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <form className="shrink-0 px-3 pb-3" onSubmit={(event) => { event.preventDefault(); void onSend() }}>
        <div className="relative rounded-lg border border-[var(--canvas-border)] bg-[var(--canvas-surface)] shadow-[0_8px_24px_rgba(15,23,42,0.08)] focus-within:border-[var(--canvas-border-strong)]">
          <textarea aria-label="发送给 Agent 的消息" value={draft} maxLength={20_000} disabled={sending} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void onSend() } }} rows={3} placeholder="描述创意或需求；@ 节点引用与 / Skill 暂不可用" className="block min-h-[72px] w-full resize-none bg-transparent px-3 pb-12 pt-3 text-[13px] leading-relaxed text-[var(--canvas-text)] outline-none placeholder:text-[var(--canvas-muted-soft)] disabled:opacity-60" />
          <div className="absolute bottom-2 left-2 right-2 flex items-center gap-1.5">
            <button type="button" title="Skills 尚未接入桌面版" disabled className="flex size-8 items-center justify-center rounded-lg text-[var(--canvas-muted-soft)]"><Puzzle size={16} /></button>
            <button type="button" title="生成偏好" onClick={onConfigure} className="flex size-8 items-center justify-center rounded-lg text-[var(--canvas-muted)] hover:bg-[var(--canvas-hover)]"><SlidersHorizontal size={16} /></button>
            <button type="button" onClick={onConfigure} className="ml-auto truncate rounded-lg px-2 py-1 text-[11px] font-semibold text-[#555]">{agnesConfigured ? 'Agnes 2.5 Flash' : '配置模型'}</button>
            {sending
              ? <button type="button" title="桌面 Agent Worker 尚未提供中止接口" aria-label="停止（暂不可用）" disabled className="inline-flex size-7 cursor-not-allowed items-center justify-center rounded-lg bg-[var(--canvas-surface-muted)] text-[var(--canvas-muted-soft)]"><Square size={12} /></button>
              : <button type="submit" title="发送" aria-label="发送" disabled={!agnesConfigured || !draft.trim() || creating} className="inline-flex size-7 items-center justify-center rounded-lg bg-[var(--canvas-active)] text-[var(--canvas-active-text)] disabled:cursor-not-allowed disabled:bg-[var(--canvas-surface-muted)] disabled:text-[var(--canvas-muted-soft)]"><Send size={14} /></button>}
          </div>
        </div>
      </form>
    </div> : <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3"><p className="mb-3 text-[12px] font-bold text-[#888]">历史对话</p>{sessions.length === 0 ? <p className="text-xs text-[#999]">暂无会话</p> : sessions.map((session) => <button key={session.sessionId} type="button" onClick={() => { void onSelectSession(session.sessionId); setTab('chat') }} className={`mb-1 block w-full rounded-xl px-3 py-2.5 text-left hover:bg-black/[0.04] ${session.sessionId === activeSessionId ? 'bg-black/[0.05]' : ''}`}><p className="truncate text-[13px] font-semibold">{session.title || '新对话'}</p><p className="mt-1 text-[11px] text-[#999]">{new Date(session.modifiedAt).toLocaleString()}</p></button>)}</div>}
  </aside>
}
