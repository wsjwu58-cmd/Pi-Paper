import { Image as ImageIcon, Video } from 'lucide-react'
import type { AgentNodeReference } from './agentTypes'

export function AgentNodeReferenceCards({ references }: { references: readonly AgentNodeReference[] }) {
  if (references.length === 0) return null

  return (
    <div className="flex max-w-full flex-col gap-1.5" aria-label="本轮参考节点">
      {references.map((reference) => (
        <div
          key={reference.nodeId}
          className="flex min-w-0 max-w-full items-center gap-2 rounded-[14px] border border-black/10 bg-black/[0.025] p-2"
        >
          {reference.previewUrl ? (
            <img
              src={reference.previewUrl}
              alt={reference.title}
              className="h-10 w-10 shrink-0 rounded-[10px] object-cover"
            />
          ) : reference.nodeType === 'text' ? (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white text-[12px] font-medium text-[#777]">
              TXT
            </span>
          ) : reference.nodeType === 'video' ? (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white text-[#777]">
              <Video size={16} />
            </span>
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white text-[#777]">
              <ImageIcon size={16} />
            </span>
          )}
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-[14px] font-medium leading-5 text-[#222]" title={reference.title}>
              {reference.title}
            </span>
            <span className="block truncate text-[12px] leading-4 text-[#aaa]">{reference.status || 'ready'}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
