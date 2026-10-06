import { Puzzle, Type, Video, X } from 'lucide-react'
import { resolveMediaUrl } from '@/lib/media'
import { cn } from '@/lib/cn'
import type { FlowNode } from './canvasStore'
import type { NodePayload } from '@/lib/types'
import type { ComposerRef } from './agentNodeReferences'

function previewOf(node: NodePayload | undefined): { url?: string; text?: string } {
  if (!node) return {}
  const p = node.params || {}
  const url = resolveMediaUrl(
    String(p.lastOutputUrl || p.url || p.thumbnailUrl || p.imageUrl || ''),
    (node.output as Record<string, unknown> | undefined) ?? null,
  )
  const text = String(p.lastOutputText || p.content || p.text || '').replace(/\s+/g, ' ').trim()
  return { url: url || undefined, text: text.slice(0, 36) || undefined }
}

export function AgentComposerBar({
  refs,
  nodes,
  onRemove,
}: {
  refs: ComposerRef[]
  nodes: FlowNode[]
  onRemove: (ref: ComposerRef) => void
}) {
  if (refs.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-[var(--canvas-border)] px-2.5 py-2">
      {refs.map((ref) => {
        const node = ref.kind === 'node'
          ? nodes.find((n) => String(n.data.node.id) === ref.id || String(n.id) === ref.id)?.data.node
          : undefined
        const preview = previewOf(node)
        const title = node ? String((node.params || {}).title || ref.title) : ref.title
        return (
          <span
            key={`${ref.kind}-${ref.id}`}
            className={cn(
              'inline-flex max-w-[160px] items-center gap-1 rounded-lg border border-black/8 bg-white py-0.5 pl-1 pr-1 text-[11px] text-[#444]',
            )}
          >
            {ref.kind === 'skill' ? (
              <Puzzle size={12} className="ml-0.5 shrink-0 text-[#888]" />
            ) : preview.url ? (
              <img src={preview.url} alt="" className="h-5 w-5 shrink-0 rounded object-cover" />
            ) : ref.nodeType === 'video' || node?.type === 'video' ? (
              <Video size={12} className="ml-0.5 shrink-0 text-[#888]" />
            ) : (
              <Type size={12} className="ml-0.5 shrink-0 text-[#888]" />
            )}
            <span className="min-w-0 truncate" title={preview.text || title}>
              {preview.text && (ref.nodeType === 'text' || node?.type === 'text') ? preview.text : title}
            </span>
            <button
              type="button"
              aria-label="移除参考"
              onClick={() => onRemove(ref)}
              className="rounded p-0.5 text-[#aaa] hover:bg-black/5 hover:text-[#555]"
            >
              <X size={11} />
            </button>
          </span>
        )
      })}
    </div>
  )
}
