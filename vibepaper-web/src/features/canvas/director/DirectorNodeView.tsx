import { memo, useMemo, useState } from 'react'
import { Clapperboard, Layers } from 'lucide-react'
import type { NodeProps } from '@xyflow/react'
import { Handle, Position } from '@xyflow/react'
import { sid } from '@/lib/ids'
import { resolveMediaUrl, useAuthedMediaUrl } from '@/lib/media'
import type { ModelInfo } from '@/lib/types'
import { useCanvasStore, type FlowNode } from '../canvasStore'
import { statusBadge } from '../nodes/NodeShell'
import { syncExecFields } from '../nodes/taskActions'
import { NodeFloatingToolbar } from '../nodes/NodeEditorPanel'
import { downloadNodeOutput } from '../nodes/nodeDownloads'
import { DirectorStageEditor } from './DirectorStageEditor'
import {
  DEFAULT_CAMERA,
  DEFAULT_SCENE,
  type DirectorObject,
  type DirectorSceneState,
} from './types'

function parseScene(params: Record<string, unknown> | undefined): DirectorSceneState {
  if (!params) return { ...DEFAULT_SCENE, camera: { ...DEFAULT_CAMERA }, objects: [], captures: [] }
  const rawObjects = (params.sceneObjects ?? params.models) as unknown
  let objects: DirectorObject[] = []
  if (Array.isArray(rawObjects) && rawObjects.length) {
    objects = rawObjects.map((m: Record<string, unknown>, i: number) => {
      // 兼容旧 2D mock 数据结构
      if (m.category && m.kind && m.position) {
        return m as unknown as DirectorObject
      }
      const pos2 = (m.pos as [number, number] | undefined) ?? [0, 0]
      return {
        id: String(m.id ?? `legacy-${i}`),
        category: 'character' as const,
        kind: (m.pose as DirectorObject['kind']) || '站立',
        name: String(m.name ?? `人物 ${String(i + 1).padStart(2, '0')}`),
        position: [Number(pos2[0]) / 10, 0, Number(pos2[1]) / 10] as [number, number, number],
        rotation: 0,
        scale: Number(m.size ?? 1),
        color: String(m.color ?? '#e85d6c'),
      }
    })
  }
  const camera = (params.camera as DirectorSceneState['camera']) ?? { ...DEFAULT_CAMERA }
  const captures = Array.isArray(params.captures)
    ? (params.captures as string[]).filter(Boolean)
    : []
  const latest =
    (params.lastOutputUrl as string) || (params.url as string) || captures[captures.length - 1]
  if (latest && !captures.includes(latest)) captures.push(latest)
  return {
    objects,
    camera: {
      yaw: Number(camera.yaw ?? DEFAULT_CAMERA.yaw),
      pitch: Number(camera.pitch ?? DEFAULT_CAMERA.pitch),
      distance: Number(camera.distance ?? DEFAULT_CAMERA.distance),
    },
    captures,
  }
}

function localCaptureAssetId(url: string | null): string | undefined {
  if (!url) return undefined
  return /^vibe:\/\/app\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(url)?.[1]
}

export const DirectorNodeView = memo(function DirectorNodeView(props: NodeProps<FlowNode>) {
  const nodeId = sid(props.id)
  const selected = useCanvasStore((state) => state.selectedNodeId === nodeId) && !props.dragging
  const node = useCanvasStore((s) => s.nodes.find((n) => sid(n.id) === nodeId)?.data.node)
  const canvasId = useCanvasStore((s) => s.canvas?.canvas.id)
  const [editorOpen, setEditorOpen] = useState(false)

  const scene = useMemo(() => parseScene(node?.params), [node?.params])
  const previewRaw =
    resolveMediaUrl(
      (node?.params.lastOutputUrl as string) ||
        (node?.params.url as string) ||
        scene.captures[scene.captures.length - 1],
      undefined,
    ) || undefined
  const previewSrc = useAuthedMediaUrl(previewRaw)

  if (!node) return null

  const badge = statusBadge(node.status)
  const modelsList = (props.data.models ?? []) as ModelInfo[]
  void modelsList

  const openEditor = () => setEditorOpen(true)

  const persistScene = (state: DirectorSceneState, latestUrl: string | null) => {
    const current = useCanvasStore.getState().nodes.find((n) => sid(n.id) === nodeId)?.data.node
    const assetId = localCaptureAssetId(latestUrl)
    const params = {
      ...(current?.params ?? node.params),
      sceneObjects: state.objects,
      camera: state.camera,
      captures: state.captures,
      ...(assetId ? { assetId } : {}),
      ...(latestUrl
        ? { url: latestUrl, lastOutputUrl: latestUrl, thumbnailUrl: latestUrl }
        : {}),
    }
    useCanvasStore.getState().updateNodePayload(nodeId, {
      params,
      ...(latestUrl ? syncExecFields('succeeded') : { status: current?.status ?? node.status }),
    })
  }

  return (
    <div className={`relative flex items-start gap-3 ${selected ? 'w-[460px]' : 'w-[220px]'}`}>
      {/* 预览卡片 */}
      <div className="relative w-[200px] shrink-0">
        {selected && previewRaw && (
          <NodeFloatingToolbar
            node={node}
            models={modelsList}
            mediaUrl={previewRaw}
            onDownload={() => downloadNodeOutput({ node, mediaUrl: previewRaw })}
          />
        )}
        <div
          className={`overflow-hidden rounded-[16px] bg-white shadow-[0_8px_28px_rgba(15,23,42,0.10)] ring-1 ${
            selected ? 'ring-[#111]/30' : 'ring-black/5'
          }`}
          onDoubleClick={(e) => {
            e.stopPropagation()
            openEditor()
          }}
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
          <div className="px-2.5 py-2.5">
            <div className="flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-[#f7f7f9]">
              {previewSrc ? (
                <img src={previewSrc} alt="" className="h-full w-full object-contain" />
              ) : (
                <div className="flex flex-col items-center gap-1.5 text-[#b0b0b8]">
                  <Layers size={22} strokeWidth={1.5} />
                  <span className="text-[10px] font-semibold">构图参考</span>
                </div>
              )}
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
        {selected && (
          <div className="mt-1.5 flex items-center justify-center gap-1 text-[11px] font-semibold text-[#8e8e93]">
            <Layers size={12} />
            <span>导演台</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${badge.cls}`}>{badge.text}</span>
          </div>
        )}
      </div>

      {/* 编辑控制卡片 */}
      {selected && (
        <div className="mt-6 w-[200px] shrink-0">
          <div className="rounded-[16px] bg-[#f3f0f8] px-4 py-8 shadow-[0_8px_28px_rgba(15,23,42,0.08)] ring-1 ring-black/5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                openEditor()
              }}
              className="nodrag nowheel mx-auto flex h-11 w-full max-w-[150px] items-center justify-center gap-2 rounded-full bg-[#1a1a2e] text-[13px] font-bold text-white hover:bg-black"
            >
              <Clapperboard size={16} />
              编辑
            </button>
          </div>
          <p className="mt-2 text-center text-[10px] font-semibold text-[#aaa]">
            {scene.objects.length > 0
              ? `${scene.objects.length} 个模型 · 双击预览也可编辑`
              : '点击编辑搭建构图场景'}
          </p>
        </div>
      )}

      <DirectorStageEditor
        open={editorOpen}
        initial={scene}
        canvasId={canvasId}
        nodeId={node.id}
        onClose={() => setEditorOpen(false)}
        onSave={persistScene}
      />
    </div>
  )
})
