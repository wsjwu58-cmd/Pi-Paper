import { t as uiText, useUiLanguage } from '@/lib/i18n'
import { useEffect, useMemo, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDown, ArrowRight, Download, Move, Ungroup } from 'lucide-react'
import { ViewportPortal, useViewport } from '@xyflow/react'
import { sid } from '@/lib/ids'
import type { GroupPayload } from '@/lib/types'
import { getCanvasGroupBounds } from './canvasGroupUtils'
import type { FlowNode } from './canvasStore'

export interface CanvasGroupViewProps {
  groups: GroupPayload[]
  frozenBounds?: Record<string, { x: number; y: number; width: number; height: number }>
  nodes: FlowNode[]
  selectedGroupId: string | null
  onSelectGroup: (groupId: string) => void
  onMoveGroup: (groupId: string, deltaX: number, deltaY: number) => void
  onArrangeGroup: (group: GroupPayload, orientation: 'horizontal' | 'vertical') => void
  onUngroup: (group: GroupPayload) => void
  onDownloadGroup: (group: GroupPayload) => void
}

export function CanvasGroupView({
  groups,
  frozenBounds,
  nodes,
  selectedGroupId,
  onSelectGroup,
  onMoveGroup,
  onArrangeGroup,
  onUngroup,
  onDownloadGroup,
}: CanvasGroupViewProps) {
  useUiLanguage()
  const { zoom } = useViewport()
  const frames = useMemo(
    () => groups.map((group) => ({ group, bounds: frozenBounds?.[sid(group.id)] ?? getCanvasGroupBounds(group, nodes) }))
      .filter((frame): frame is { group: GroupPayload; bounds: NonNullable<typeof frame.bounds> } => Boolean(frame.bounds)),
    [groups, nodes, frozenBounds],
  )

  return (
    <ViewportPortal>
      {frames.map(({ group, bounds }) => (
        <GroupFrame
          key={sid(group.id)}
          group={group}
          bounds={bounds}
          zoom={zoom}
          selected={selectedGroupId === sid(group.id)}
          onSelectGroup={onSelectGroup}
          onMoveGroup={onMoveGroup}
          onArrangeGroup={onArrangeGroup}
          onUngroup={onUngroup}
          onDownloadGroup={onDownloadGroup}
        />
      ))}
    </ViewportPortal>
  )
}

type GroupFrameProps = Pick<CanvasGroupViewProps, 'onSelectGroup' | 'onMoveGroup' | 'onArrangeGroup' | 'onUngroup' | 'onDownloadGroup'> & {
  group: GroupPayload
  bounds: { x: number; y: number; width: number; height: number }
  zoom: number
  selected: boolean
}

function GroupFrame({
  group,
  bounds,
  zoom,
  selected,
  onSelectGroup,
  onMoveGroup,
  onArrangeGroup,
  onUngroup,
  onDownloadGroup,
}: GroupFrameProps) {
  useUiLanguage()
  const dragAbort = useRef<AbortController | null>(null)
  const id = sid(group.id)

  useEffect(() => () => dragAbort.current?.abort(), [])

  const beginMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragAbort.current?.abort()
    const controller = new AbortController()
    dragAbort.current = controller
    let previousX = event.clientX
    let previousY = event.clientY
    onSelectGroup(id)

    window.addEventListener('pointermove', (moveEvent) => {
      const deltaX = (moveEvent.clientX - previousX) / Math.max(zoom, 0.1)
      const deltaY = (moveEvent.clientY - previousY) / Math.max(zoom, 0.1)
      previousX = moveEvent.clientX
      previousY = moveEvent.clientY
      if (deltaX !== 0 || deltaY !== 0) onMoveGroup(id, deltaX, deltaY)
    }, { signal: controller.signal })
    window.addEventListener('pointerup', () => controller.abort(), { once: true, signal: controller.signal })
    window.addEventListener('pointercancel', () => controller.abort(), { once: true, signal: controller.signal })
  }

  const stop = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onSelectGroup(id)
  }

  return (
    <>
      <div
        data-canvas-group-view={id}
        aria-label={uiText("{0}编组范围", { 0: group.name })}
        className="absolute rounded-[18px] border-2 border-dashed transition-colors"
        style={{
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height,
          zIndex: -1,
          pointerEvents: 'none',
          borderColor: '#111111',
          backgroundColor: '#11111108',
          boxShadow: selected ? '0 0 0 2px #11111122' : undefined,
        }}
      />
      <div
        data-canvas-group-toolbar={id}
        className="absolute flex -translate-x-1/2 -translate-y-[calc(100%+8px)] items-center gap-2 rounded-full border border-black/8 bg-white px-2 py-1 shadow-[0_5px_18px_rgba(0,0,0,0.12)]"
        style={{ left: bounds.x + bounds.width / 2, top: bounds.y, zIndex: 1000, pointerEvents: 'auto' }}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="max-w-28 truncate px-1 text-[11px] font-semibold text-[#555]" title={group.name}>
          {group.name}
        </span>
        <div className="h-4 w-px bg-black/10" />
        <button type="button" className="nodrag nopan flex h-7 w-7 items-center justify-center rounded-full text-[#555] hover:bg-black/5" title={uiText("移动整个编组")} aria-label={uiText("移动整个编组")} onPointerDown={beginMove} onClick={(event) => event.stopPropagation()}>
          <Move size={14} />
        </button>
        <button type="button" className="nodrag nopan flex h-7 w-7 items-center justify-center rounded-full text-[#555] hover:bg-black/5" title={uiText("水平排列")} aria-label={uiText("水平排列")} onClick={(event) => { stop(event); onArrangeGroup(group, 'horizontal') }}>
          <ArrowRight size={14} />
        </button>
        <button type="button" className="nodrag nopan flex h-7 w-7 items-center justify-center rounded-full text-[#555] hover:bg-black/5" title={uiText("垂直排列")} aria-label={uiText("垂直排列")} onClick={(event) => { stop(event); onArrangeGroup(group, 'vertical') }}>
          <ArrowDown size={14} />
        </button>
        <button type="button" className="nodrag nopan flex h-7 w-7 items-center justify-center rounded-full text-[#555] hover:bg-black/5" title={uiText("取消编组")} aria-label={uiText("取消编组")} onClick={(event) => { stop(event); onUngroup(group) }}>
          <Ungroup size={14} />
        </button>
        <button type="button" className="nodrag nopan flex h-7 w-7 items-center justify-center rounded-full text-[#555] hover:bg-black/5" title={uiText("下载组内结果")} aria-label={uiText("下载组内结果")} onClick={(event) => { stop(event); onDownloadGroup(group) }}>
        <Download size={14} />
        </button>
      </div>
    </>
  )
}
