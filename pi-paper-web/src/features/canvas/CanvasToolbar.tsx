import { t as uiText, useUiLanguage } from '@/lib/i18n'
import {
  MousePointer2,
  Hand,
  Plus,
  Upload,
  Focus,
  Grid2x2,
  LayoutGrid,
  Library,
  Boxes,
  Layers,
  Download,
  Ungroup,
  Palette,
  Type,
  Image,
  Video,
  Mic,
  Clapperboard,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { api, uploadAsset } from '@/lib/api'
import { sid } from '@/lib/ids'
import { createCanvasGroup, nodeMediaUrl, removeCanvasGroupFromStore, useCanvasStore } from './canvasStore'
import { arrangeCanvasGroupNodes } from './canvasGroupUtils'
import { downloadNodeOutput } from './nodes/nodeDownloads'
import { textNodeContent } from './nodes/textContent'
import { toastError, toastSuccess } from '@/components/ui/Toast'
import { cn } from '@/lib/cn'
import { isDesktopRuntime } from './canvasPort'
import { useSoftPresence } from './canvasMotion'

const NODE_MENU = [
  { type: 'text', label: '文本', sub: 'Text', icon: Type },
  { type: 'image', label: '图片', sub: 'Image', icon: Image },
  { type: 'video', label: '视频', sub: 'Video', icon: Video },
  { type: 'audio', label: '音频', sub: 'Audio', icon: Mic },
  { type: 'compose', label: '合成', sub: 'Synthesis', icon: Clapperboard },
  { type: 'director', label: '导演台', sub: 'Director', icon: Clapperboard },
]

const GROUP_COLORS = ['#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#111111']

export function CanvasToolbar({
  mode,
  setMode,
  onFitView,
  onAutoLayout,
  onAddNode,
  desktopMode = false,
  projectId,
}: {
  mode: 'select' | 'pan'
  setMode: (m: 'select' | 'pan') => void
  onFitView: () => void
  onAutoLayout: () => void
  onAddNode: (type: string) => void
  desktopMode?: boolean
  projectId?: string
}) {
  useUiLanguage()
  const isDesktop = desktopMode || isDesktopRuntime()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuPresence = useSoftPresence(menuOpen)
  const fileRef = useRef<HTMLInputElement>(null)
  const setAssetOpen = useCanvasStore((s) => s.setAssetOpen)
  const canvas = useCanvasStore((s) => s.canvas)
  const nodes = useCanvasStore((s) => s.nodes)
  const groups = useCanvasStore((s) => s.groups)
  const stacks = useCanvasStore((s) => s.stacks)
  const setGroups = useCanvasStore((s) => s.setGroups)
  const setStacks = useCanvasStore((s) => s.setStacks)
  const setNodes = useCanvasStore((s) => s.setNodes)
  const setDirty = useCanvasStore((s) => s.setDirty)
  const selected = nodes.filter((n) => n.selected)

  const activeGroup = groups.find((g) => selected.length > 0 && selected.every((n) => g.nodeIds.map(sid).includes(sid(n.id))))
  const activeStack = stacks.find((s) => selected.length > 0 && selected.every((n) => s.nodeIds.map(sid).includes(sid(n.id))))

  const onUpload = async (file: File) => {
    try {
      if (isDesktop) throw new Error(uiText("桌面版请使用“导入图片”从本机导入素材。"))
      await uploadAsset(file, undefined, canvas?.canvas.id)
      toastSuccess(uiText("上传成功"))
      window.dispatchEvent(new Event('vp-assets-updated'))
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const importLocalImage = async () => {
    const bridge = window.vibepaperDesktop
    if (!bridge || !projectId) {
      toastError(uiText("本地项目未就绪，无法导入图片。"))
      return
    }
    try {
      const imported = await bridge.importImage(projectId)
      if (!imported) return
      toastSuccess(uiText("图片已导入本地素材库"))
      window.dispatchEvent(new Event('vp-assets-updated'))
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const groupSelected = async () => {
    if (!canvas || selected.length < 2) return
    try {
      const group = await createCanvasGroup(selected.map((node) => sid(node.id)), { color: '#8b5cf6' })
      if (!group) return
      toastSuccess(uiText("已编组"))
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const updateGroup = async (patch: { color?: string; layout?: string; name?: string }) => {
    if (!canvas || !activeGroup) return
    try {
      const isLocalSingleGroup = activeGroup.nodeIds.length < 2
      const g = isLocalSingleGroup
        ? { ...activeGroup, ...patch }
        : isDesktop
          ? await (async () => {
              const bridge = window.vibepaperDesktop
              if (!bridge || !projectId) throw new Error(uiText("本地项目未就绪，无法更新编组。"))
              return bridge.updateGroup({ projectId, canvasId: sid(canvas.canvas.id), groupId: sid(activeGroup.id), ...patch })
            })()
          : await api<{ id: string | number; name: string; color: string; layout: string; nodeIds: Array<string | number> }>(
              `/canvases/${sid(canvas.canvas.id)}/groups/${sid(activeGroup.id)}`,
              { method: 'PUT', body: JSON.stringify(patch) },
            )
      if (sid(useCanvasStore.getState().canvas?.canvas.id) !== sid(canvas.canvas.id)) return
      if (isDesktop && !isLocalSingleGroup) {
        const currentProject = await window.vibepaperDesktop?.getActiveProject()
        if (!currentProject || currentProject.projectId !== projectId || sid(currentProject.canvasId) !== sid(canvas.canvas.id)) return
        if (sid(useCanvasStore.getState().canvas?.canvas.id) !== sid(canvas.canvas.id)) return
      }
      const currentState = useCanvasStore.getState()
      setGroups(
        currentState.groups.map((item) =>
          sid(item.id) === sid(activeGroup.id)
            ? { ...item, name: g.name, color: g.color, layout: g.layout, nodeIds: g.nodeIds.map(sid) }
            : item,
        ),
      )
      if (patch.layout === 'grid' || patch.layout === 'horizontal') {
        const currentNodes = useCanvasStore.getState().nodes
        const next = patch.layout === 'horizontal'
          ? arrangeCanvasGroupNodes(currentNodes, activeGroup.nodeIds, 'horizontal')
          : (() => {
              const members = currentNodes.filter((n) => activeGroup.nodeIds.map(sid).includes(sid(n.id)))
              const originX = Math.min(...members.map((m) => m.position.x))
              const originY = Math.min(...members.map((m) => m.position.y))
              return currentNodes.map((n) => {
                const idx = activeGroup.nodeIds.map(sid).indexOf(sid(n.id))
                return idx < 0 ? n : {
                  ...n,
                  position: { x: originX + (idx % 3) * 330, y: originY + Math.floor(idx / 3) * 280 },
                }
              })
            })()
        setNodes(next)
        setDirty(true)
      }
      if (isLocalSingleGroup) {
        setDirty(true)
        window.dispatchEvent(new Event('vp-canvas-group-snapshot'))
      }
      toastSuccess(uiText("编组已更新"))
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const ungroup = async () => {
    if (!canvas || !activeGroup) return
    try {
      if (activeGroup.nodeIds.length < 2) {
        removeCanvasGroupFromStore(activeGroup, true)
      } else if (isDesktop) {
        const bridge = window.vibepaperDesktop
        if (!bridge || !projectId) throw new Error(uiText("本地项目未就绪，无法取消编组。"))
        const canvasId = sid(canvas.canvas.id)
        await bridge.deleteGroup({ projectId, canvasId, groupId: sid(activeGroup.id) })
        if (sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) return
        const currentProject = await bridge.getActiveProject()
        if (!currentProject || currentProject.projectId !== projectId || sid(currentProject.canvasId) !== canvasId) return
        if (sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) return
        removeCanvasGroupFromStore(activeGroup)
      } else {
        const canvasId = sid(canvas.canvas.id)
        await api(`/canvases/${canvasId}/groups/${sid(activeGroup.id)}`, { method: 'DELETE' })
        if (sid(useCanvasStore.getState().canvas?.canvas.id) !== canvasId) return
        removeCanvasGroupFromStore(activeGroup)
      }
      if (sid(useCanvasStore.getState().canvas?.canvas.id) !== sid(canvas.canvas.id)) return
      toastSuccess(uiText("已取消编组"))
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const stackSelected = async () => {
    if (!canvas || selected.length < 2) return
    try {
      const s = isDesktop
        ? await (async () => {
            const bridge = window.vibepaperDesktop
            if (!bridge || !projectId) throw new Error(uiText("本地项目未就绪，无法堆叠。"))
            return bridge.addStack({ projectId, canvasId: sid(canvas.canvas.id), nodeIds: selected.map((n) => sid(n.id)) })
          })()
        : await api<{ id: string | number; nodeIds: Array<string | number> }>(
            `/canvases/${sid(canvas.canvas.id)}/stacks`,
            {
              method: 'POST',
              body: JSON.stringify({ nodeIds: selected.map((n) => sid(n.id)) }),
            },
          )
      setStacks([...stacks, { id: sid(s.id), collapsed: true, nodeIds: s.nodeIds.map(sid) }])
      const ids = s.nodeIds.map(sid)
      const base = nodes.find((n) => sid(n.id) === ids[0])
      if (base) {
        setNodes(
          nodes.map((n) => {
            const idx = ids.indexOf(sid(n.id))
            if (idx <= 0) return n
            return { ...n, position: { x: base.position.x + idx * 12, y: base.position.y + idx * 12 } }
          }),
        )
        setDirty(true)
      }
      toastSuccess(uiText("已堆叠"))
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const expandStack = async () => {
    if (!canvas || !activeStack) return
    try {
      if (isDesktop) {
        const bridge = window.vibepaperDesktop
        if (!bridge || !projectId) throw new Error(uiText("本地项目未就绪，无法展开堆叠。"))
        await bridge.updateStack({ projectId, canvasId: sid(canvas.canvas.id), stackId: sid(activeStack.id), collapsed: false })
      } else {
        await api(`/canvases/${sid(canvas.canvas.id)}/stacks/${sid(activeStack.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ collapsed: false }),
        })
      }
      const ids = activeStack.nodeIds.map(sid)
      const base = nodes.find((n) => sid(n.id) === ids[0])
      if (base) {
        setNodes(
          nodes.map((n) => {
            const idx = ids.indexOf(sid(n.id))
            if (idx < 0) return n
            return { ...n, position: { x: base.position.x + (idx % 3) * 330, y: base.position.y + Math.floor(idx / 3) * 280 } }
          }),
        )
        setDirty(true)
      }
      setStacks(stacks.map((s) => (sid(s.id) === sid(activeStack.id) ? { ...s, collapsed: false } : s)))
      toastSuccess(uiText("堆叠已展开"))
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const unstack = async () => {
    if (!canvas || !activeStack) return
    try {
      if (isDesktop) {
        const bridge = window.vibepaperDesktop
        if (!bridge || !projectId) throw new Error(uiText("本地项目未就绪，无法取消堆叠。"))
        await bridge.deleteStack({ projectId, canvasId: sid(canvas.canvas.id), stackId: sid(activeStack.id) })
      } else {
        await api(`/canvases/${sid(canvas.canvas.id)}/stacks/${sid(activeStack.id)}`, { method: 'DELETE' })
      }
      setStacks(stacks.filter((s) => sid(s.id) !== sid(activeStack.id)))
      toastSuccess(uiText("已取消堆叠"))
    } catch (e) {
      toastError((e as Error).message)
    }
  }

  const downloadSelected = async () => {
    if (selected.length === 0) return
    let saved = 0
    for (const flowNode of selected) {
      const node = flowNode.data.node
      const textContent = node.type === 'text' ? textNodeContent(node.output?.text, node.params) : undefined
      const mediaUrl = node.type === 'text' ? undefined : nodeMediaUrl(node)
      if (textContent || mediaUrl) {
        if (await downloadNodeOutput({ node, ...(textContent ? { textContent } : {}), ...(mediaUrl ? { mediaUrl } : {}) }) === 'saved') saved += 1
      }
    }
    if (saved === 0) {
      toastError(uiText("选中节点暂无可下载的输出内容"))
    }
  }

  return (
    <div className="flex flex-col gap-1 rounded-[24px] border border-white/10 bg-[#1a1c24]/95 px-2 py-3 shadow-[0_16px_48px_rgba(0,0,0,0.28)] backdrop-blur-md">
      <ToolButton active={mode === 'select'} onClick={() => setMode('select')} title={uiText("选择模式")}>
        <MousePointer2 size={17} />
      </ToolButton>
      <ToolButton active={mode === 'pan'} onClick={() => setMode('pan')} title={uiText("抓手模式")}>
        <Hand size={17} />
      </ToolButton>

      <div className="mx-2 my-1 h-px bg-white/10" />

      <div className="relative">
        <ToolButton active={menuOpen} onClick={() => setMenuOpen((v) => !v)} title={uiText("添加节点")}>
          <Plus size={18} />
        </ToolButton>
        {menuPresence.present && (
          <div data-open={menuPresence.visible} aria-hidden={!menuOpen} inert={!menuOpen}
            className="vp-soft-popover absolute left-[58px] top-0 z-50 w-[220px] rounded-[20px] border border-white/10 bg-[#1a1c24]/98 p-3 shadow-[0_24px_72px_rgba(0,0,0,0.35)] backdrop-blur-md">
            <p className="mb-2 px-1 text-[11px] font-bold tracking-wide text-[#8e929c]">{uiText("添加节点")}</p>
            {NODE_MENU.map((t) => {
              const Icon = t.icon
              return (
                <button
                  key={t.type}
                  onClick={() => {
                    onAddNode(t.type)
                    setMenuOpen(false)
                  }}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition hover:bg-white/8"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#2d303a] text-white/90">
                    <Icon size={17} strokeWidth={1.6} />
                  </span>
                  <div>
                    <p className="text-[14px] font-semibold text-white">{uiText(t.label)}</p>
                    <p className="text-[11px] text-[#8e929c]">{t.sub}</p>
                  </div>
                </button>
              )
            })}
            <div className="mx-1 my-2 h-px bg-white/10" />
            <button
              onClick={() => (isDesktop ? void importLocalImage() : fileRef.current?.click())}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition hover:bg-white/8"
              title={isDesktop ? uiText("桌面本地仅支持导入图片") : uiText("上传素材")}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#2d303a] text-white/90">
                <Upload size={17} strokeWidth={1.6} />
              </span>
              <div>
                <p className="text-[14px] font-semibold text-white">{isDesktop ? uiText("导入图片") : uiText("上传")}</p>
                <p className="text-[11px] text-[#8e929c]">{isDesktop ? uiText("本地素材") : 'Upload'}</p>
              </div>
            </button>
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*,audio/*"
        className="hidden"
        disabled={isDesktop}
        onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
      />

      <ToolButton onClick={() => setAssetOpen(true)} title={uiText("素材库")}>
        <Library size={17} />
      </ToolButton>

      <div className="mx-2 my-1 h-px bg-white/10" />

      <ToolButton onClick={onFitView} title={uiText("聚焦视图")}>
        <Focus size={17} />
      </ToolButton>
      <ToolButton onClick={onAutoLayout} title={uiText("网格整理")}>
        <Grid2x2 size={17} />
      </ToolButton>

      {selected.length >= 2 && (
        <>
          <div className="mx-2 my-1 h-px bg-white/10" />
          <ToolButton onClick={groupSelected} title={uiText("编组")}>
            <Boxes size={17} />
          </ToolButton>
          <ToolButton onClick={stackSelected} title={uiText("堆叠")}>
            <Layers size={17} />
          </ToolButton>
          <ToolButton onClick={downloadSelected} title={uiText("下载选中内容")}>
            <Download size={17} />
          </ToolButton>
        </>
      )}

      {activeGroup && (
        <>
          <div className="mx-2 my-1 h-px bg-white/10" />
          <ToolButton onClick={() => void updateGroup({ layout: 'grid' })} title={uiText("网格排列")}>
            <LayoutGrid size={17} />
          </ToolButton>
          <ToolButton onClick={() => void updateGroup({ layout: 'horizontal' })} title={uiText("水平排列")}>
            <Boxes size={17} />
          </ToolButton>
          <ToolButton
            onClick={() => {
              const next = GROUP_COLORS[(GROUP_COLORS.indexOf(activeGroup.color) + 1) % GROUP_COLORS.length]
              void updateGroup({ color: next })
            }}
            title={uiText("编组颜色")}
          >
            <Palette size={17} />
          </ToolButton>
          <ToolButton onClick={() => void ungroup()} title={uiText("取消编组")}>
            <Ungroup size={17} />
          </ToolButton>
        </>
      )}

      {activeStack && (
        <>
          <div className="mx-2 my-1 h-px bg-white/10" />
          <ToolButton onClick={() => void expandStack()} title={uiText("展开堆叠")}>
            <Layers size={17} />
          </ToolButton>
          <ToolButton onClick={() => void unstack()} title={uiText("取消堆叠")}>
            <Ungroup size={17} />
          </ToolButton>
        </>
      )}
    </div>
  )
}

function ToolButton({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  useUiLanguage()
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-full transition',
        active
          ? 'bg-white text-[#1a1c24]'
          : 'text-white/75 hover:bg-white/10 hover:text-white',
      )}
    >
      {children}
    </button>
  )
}
