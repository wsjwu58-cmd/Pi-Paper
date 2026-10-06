import { useRef, type ReactNode } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { LucideIcon } from 'lucide-react'
import { ArrowUpFromLine } from 'lucide-react'
import type { NodePayload } from '@/lib/types'
import { sid } from '@/lib/ids'
import { statusBadge } from './NodeShell'
import { GenerationProgress } from './GenerationProgress'
import type { GenerationProgressInput } from './generation-progress'
import { resolveGenerationProgressStatus } from './generation-progress'
import './generation-progress.css'
import { SoftCollapse, useAnimatedNodeGeometry, useNodeArrival } from '../canvasMotion'

export function SplitNodeLayout({
  node,
  selected,
  busy,
  accentColor,
  label,
  icon: Icon,
  topContent,
  topUpload,
  bottom,
  extra,
  topMinHeight = 'min-h-[72px]',
  topMinHeightCollapsed = 'min-h-0',
  mediaFrame,
  collapsedWidth = 280,
  generationProgress,
  generationTaskStatus,
  cropEditing = false,
}: {
  node: NodePayload
  selected: boolean
  busy: boolean
  accentColor: string
  label: string
  icon: LucideIcon
  topContent: ReactNode
  topUpload?: {
    accept: string
    onUpload: (file: File) => void | Promise<void>
    onDesktopImport?: () => void | Promise<void>
    unavailableReason?: string
  }
  bottom: ReactNode
  extra?: ReactNode
  topMinHeight?: string
  topMinHeightCollapsed?: string
  /** Media outputs size the node from the media's own aspect ratio. */
  mediaFrame?: 'natural'
  /** Optional compact card width; selected cards retain their editor width. */
  collapsedWidth?: number
  /** A real queued/running task from the node task feed. */
  generationProgress?: GenerationProgressInput | null
  /** Latest real task state, including terminal states, for stale node status suppression. */
  generationTaskStatus?: string | null
  /** Inline crop controls extend the selected image frame and need to remain visible. */
  cropEditing?: boolean
}) {
  const nodeId = sid(node.id)
  const badge = statusBadge(node.status)
  const ringCls = selected ? 'ring-[#111]/35' : 'ring-black/5'
  const expanded = selected
  const shellRef = useRef<HTMLDivElement>(null)
  useAnimatedNodeGeometry(nodeId, shellRef)
  const arrivalClass = useNodeArrival(nodeId)
  const nodeExecutionStatus = String(node.execStatus || node.status || '').toLowerCase()
  const progressStatus = !cropEditing && generationProgress
    ? resolveGenerationProgressStatus(
        generationProgress.status,
        nodeExecutionStatus,
        generationProgress.taskId,
        node.currentOutputId,
      )
    : null
  const showLegacyBusy = !cropEditing && busy && generationTaskStatus === undefined && !progressStatus

  return (
    <div
      ref={shellRef}
      className={`vp-node-shell relative flex flex-col items-center ${arrivalClass}`}
      style={{ width: expanded ? 440 : collapsedWidth }}
    >
      <SoftCollapse open={expanded} className="w-full">
        <div className="mb-1.5 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-[#8e8e93]">
          <Icon size={12} />
          <span>{label}</span>
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}`}>{badge.text}</span>
        </div>
      </SoftCollapse>

      <div className="vp-node-preview relative" style={{ width: cropEditing ? '100%' : expanded ? 240 : collapsedWidth }}>
        <div
          className={`relative w-full ${cropEditing ? 'overflow-visible' : 'overflow-hidden'} rounded-[16px] bg-white shadow-[0_8px_28px_rgba(15,23,42,0.10)] ring-1 ${ringCls}`}
          style={{ outline: node.status === 'running' ? `2px solid ${accentColor}` : undefined }}
        >
          <Handle
            type="target"
            position={Position.Left}
            id="input"
            className="!h-3.5 !w-3.5 !border-2 !border-white !bg-[#c0c0c4]"
            onClick={(e) => {
              e.stopPropagation()
              window.dispatchEvent(
                new CustomEvent('vp-create-downstream-node', {
                  detail: { nodeId, x: e.clientX, y: e.clientY, direction: 'upstream' },
                }),
              )
            }}
          />
          <div className={mediaFrame ? 'p-0' : expanded ? 'px-3 py-2.5' : 'px-3.5 py-3'}>
            {expanded && topUpload && (
              <div className={mediaFrame ? 'absolute right-2 top-2 z-10' : 'mb-1.5 flex justify-end'}>
                <label
                  className={`nodrag nowheel flex h-6 w-6 items-center justify-center rounded-lg bg-[#f0f0f2] ring-1 ring-black/6 ${topUpload.unavailableReason ? 'cursor-not-allowed text-[#b0b0b8]' : 'cursor-pointer text-[#888] hover:bg-[#e8e8ec]'}`}
                  title={topUpload.unavailableReason || '上传素材'}
                  aria-disabled={Boolean(topUpload.unavailableReason)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    if (topUpload.unavailableReason) {
                      e.preventDefault()
                      return
                    }
                    if ((window.vibepaperDesktop || window.location.protocol === 'vibe:') && topUpload.onDesktopImport) {
                      e.preventDefault()
                      void topUpload.onDesktopImport()
                    }
                  }}
                >
                  <ArrowUpFromLine size={12} />
                  <input
                    type="file"
                    accept={topUpload.accept}
                    className="hidden"
                    disabled={Boolean(topUpload.unavailableReason)}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void topUpload.onUpload(f)
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
            )}
            <div
              className={
                mediaFrame
                  ? `relative flex w-full items-start justify-center ${cropEditing ? 'overflow-visible' : 'overflow-hidden'}`
                  : progressStatus
                    ? 'relative flex aspect-video w-full min-h-[120px] max-h-none items-start justify-center overflow-hidden'
                    : `relative flex ${expanded ? topMinHeight : topMinHeightCollapsed} max-h-[120px] items-start justify-center overflow-hidden`
              }
            >
              {topContent}
              {!cropEditing && generationProgress && progressStatus ? (
                <GenerationProgress {...generationProgress} status={progressStatus} />
              ) : showLegacyBusy ? (
                <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-[12px] font-bold text-[#555]">
                  生成中…
                </div>
              ) : null}
            </div>
          </div>
          <Handle
            type="source"
            position={Position.Right}
            id="output"
            className="!h-3.5 !w-3.5 !border-2 !border-white !bg-[#c0c0c4]"
            onClick={(e) => {
              e.stopPropagation()
              window.dispatchEvent(
                new CustomEvent('vp-create-downstream-node', {
                  detail: { nodeId, x: e.clientX, y: e.clientY, direction: 'downstream' },
                }),
              )
            }}
          />
        </div>
      </div>

      <SoftCollapse open={expanded} className="w-full">
          <div className="flex h-5 w-full items-center justify-center">
            <div className="h-full w-px bg-[#c0c0c4]" />
          </div>

          <div className={`w-full rounded-[20px] bg-white shadow-[0_8px_28px_rgba(15,23,42,0.12)] ring-1 ${ringCls}`}>
            {bottom}
          </div>

          {extra}
      </SoftCollapse>
    </div>
  )
}
