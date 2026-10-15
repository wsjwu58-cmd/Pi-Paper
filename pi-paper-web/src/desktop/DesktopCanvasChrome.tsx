import { useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import {
  Bot, Check, ChevronDown, Clapperboard, Focus, Grid2x2,
  Hand, Image as ImageIcon, Layers, Library, Mic, MousePointer2, Plus,
  Settings2, Type, Undo2, Upload,
} from 'lucide-react'
import type { DesktopProject } from './desktop-bridge'

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
