import { sid } from '@/lib/ids'
import type { NodePayload } from '@/lib/types'
import { createCanvasGroup, useCanvasStore, nodeMediaUrl, type FlowNode } from '../canvasStore'
import { desktopCanvasDetail, desktopNodePayload } from '../canvasPort'
import { flushCanvasPersistence } from '../canvasPersistence'
import { buildFlow } from '../canvasStore'
import { resolveMediaUrl } from '@/lib/media'
import { cropGridSize, type CropArtifact, type CropMode } from './cropGeometry'

export interface CropSourceSnapshot {
  nodeId: string
  mediaUrl: string
  sourceNodeMediaUrl?: string
  outputId?: string | number
  assetId?: string | number
  sourceName?: string
}

export async function saveCropArtifactsAsNodes(
  source: CropSourceSnapshot,
  mode: CropMode,
  artifacts: CropArtifact[],
): Promise<number> {
  const bridge = window.vibepaperDesktop
  if (!bridge?.saveCanvasImage) throw new Error('桌面本地图片保存服务尚未就绪。')
  if (artifacts.length !== cropGridSize(mode) ** 2) throw new Error('裁剪结果数量与所选模式不匹配。')

  const active = await bridge.getActiveProject()
  const initial = useCanvasStore.getState()
  const canvasId = initial.canvas?.canvas.id == null ? '' : sid(initial.canvas.canvas.id)
  if (!active || !canvasId || active.canvasId !== canvasId) throw new Error('当前画布已切换，请重新打开裁剪。')
  const projectId = active.projectId
  await flushCanvasPersistence(projectId, canvasId)
  await assertCropSourceCurrent(source, projectId, canvasId)

  const savedAssets: Array<{ assetId: string; url: string; name: string; artifact: CropArtifact }> = []
  const basename = safeBaseName(source.sourceName)
  const count = artifacts.length
  const modeName = mode === 'single' ? '裁剪' : mode === 'four' ? '四宫格' : '九宫格'
  try {
    for (let index = 0; index < count; index++) {
      await assertCropSourceCurrent(source, projectId, canvasId)
      const name = count === 1 ? `${basename}-裁剪.png` : `${basename}-${modeName}-${String(index + 1).padStart(2, '0')}.png`
      const saved = await bridge.saveCanvasImage({
        projectId,
        canvasId,
        nodeId: source.nodeId,
        pngBytes: new Uint8Array(await artifacts[index].blob.arrayBuffer()),
        name,
      })
      if (!saved?.assetId || !saved.url) throw new Error(`第 ${index + 1} 张裁剪图片未保存到本地素材。`)
      savedAssets.push({ assetId: saved.assetId, url: saved.url, name, artifact: artifacts[index] })
    }
  } catch (error) {
    await discardUnpublishedAssets(bridge, projectId, savedAssets.map((asset) => asset.assetId))
    throw error
  }

  window.dispatchEvent(new Event('vp-assets-updated'))
  const previewWidth = count === 1 ? 280 : 120
  const columns = cropGridSize(mode)
  const currentSource = findCurrentSource(source.nodeId)
  if (!currentSource) throw new Error('源图片节点已不存在，裁剪产物已保存在本地素材库。')
  const baseX = currentSource.position.x
  const measuredHeight = Number((currentSource as FlowNode & { measured?: { height?: number } }).measured?.height ?? currentSource.height)
  const baseY = currentSource.position.y + Math.max(Number.isFinite(measuredHeight) ? measuredHeight : 240, 240) + 36
  const rowHeights = Array.from({ length: columns }, (_, row) => {
    const rowAssets = savedAssets.filter((asset) => asset.artifact.rect.row === row)
    return Math.max(120, ...rowAssets.map(({ artifact }) => previewWidth * artifact.rect.height / artifact.rect.width + 30))
  })
  const rowOffsets: number[] = []
  for (let row = 0; row < columns; row++) {
    rowOffsets[row] = row === 0 ? 0 : rowOffsets[row - 1] + rowHeights[row - 1] + 26
  }

  const createdNodeIds: string[] = []
  let creationError: unknown
  for (const asset of savedAssets) {
    try {
      await assertCropSourceCurrent(source, projectId, canvasId)
      const live = useCanvasStore.getState()
      const canvas = live.canvas
      if (!canvas || sid(canvas.canvas.id) !== canvasId) throw new Error('画布已切换，已停止创建后续裁剪节点。')
      const row = asset.artifact.rect.row
      const column = asset.artifact.rect.column
      const x = baseX + column * (previewWidth + 24)
      const y = baseY + rowOffsets[row]
      const aspectHeight = Math.ceil(previewWidth * asset.artifact.rect.height / asset.artifact.rect.width + 60)
      const params = {
        assetId: asset.assetId,
        name: asset.name,
        url: asset.url,
        lastOutputUrl: asset.url,
        thumbnailUrl: asset.url,
        cropPreviewWidth: previewWidth,
        cropIndex: createdNodeIds.length + 1,
        cropMode: mode,
      }
      const created = await bridge.createNode({
        projectId,
        canvasId,
        expectedVersion: canvas.canvas.version,
        idempotencyKey: crypto.randomUUID(),
        type: 'image',
        x,
        y,
        width: previewWidth,
        height: aspectHeight,
        params,
      })
      const id = sid(created.node.id)
      if (!id || created.node.type !== 'image') throw new Error('本地画布没有返回有效的图片节点。')
      createdNodeIds.push(id)
      const latest = useCanvasStore.getState()
      if (!latest.canvas || sid(latest.canvas.canvas.id) !== canvasId) {
        throw new Error('画布已切换，裁剪节点已保存在原画布；请返回原画布查看。')
      }
      latest.setCanvas({
        ...latest.canvas,
        canvas: { ...latest.canvas.canvas, version: created.version },
      })
      const sourceFlow = latest.nodes.find((item) => sid(item.id) === source.nodeId)
      const fallback = sourceFlow ?? currentSource
      const payload = desktopNodePayload(created.node)
      const flowNode = {
        ...created.node,
        id,
        type: 'image',
        position: { x, y },
        width: previewWidth,
        height: aspectHeight,
        data: {
          node: {
            ...payload,
            id,
            type: 'image',
            x,
            y,
            width: previewWidth,
            height: aspectHeight,
            params,
            status: 'idle',
            execStatus: 'idle',
          } as NodePayload,
          selected: false,
          onConfig: fallback.data.onConfig,
          models: fallback.data.models ?? [],
        },
      } as FlowNode
      latest.setNodes([...latest.nodes, flowNode])
      // The create IPC call can finish after a source change. Keep its already
      // persisted node visible, then stop before publishing any further crop.
      await assertCropSourceCurrent(source, projectId, canvasId)
    } catch (error) {
      creationError = error
      break
    }
  }

  if (creationError) {
    const recoveredIds = await refreshPersistedCropNodes(
      bridge,
      projectId,
      canvasId,
      savedAssets.map((asset) => asset.assetId),
      source.nodeId,
    ).catch(() => [])
    for (const id of recoveredIds) {
      if (!createdNodeIds.includes(id)) createdNodeIds.push(id)
    }
  }

  let canGroup = true
  try {
    await assertCropSourceCurrent(source, projectId, canvasId)
  } catch (error) {
    canGroup = false
    creationError ??= error
  }

  if (createdNodeIds.length > 0 && canGroup) {
    const groupName = mode === 'single' ? '裁剪图片' : `${modeName}裁剪`
    try {
      const group = await createCanvasGroup(createdNodeIds, {
        allowSingle: true,
        name: groupName,
        color: '#8b5cf6',
        layout: 'free',
      })
      if (!group) throw new Error('自动编组没有完成。')
    } catch (error) {
      creationError = creationError
        ? new Error(`${messageOf(creationError)}；自动编组失败：${messageOf(error)}`)
        : new Error(`裁剪图片节点已创建，但自动编组失败：${messageOf(error)}`)
    }
  }

  if (creationError) {
    throw new Error(`已创建 ${createdNodeIds.length}/${count} 个图片节点。${messageOf(creationError)}`)
  }
  const completed = useCanvasStore.getState()
  completed.setNodes(completed.nodes.map((node) => ({
    ...node,
    selected: false,
    data: { ...node.data, selected: false },
  })))
  completed.selectNode(null)
  return createdNodeIds.length
}

function findCurrentSource(nodeId: string): FlowNode | null {
  return useCanvasStore.getState().nodes.find((node) => sid(node.id) === sid(nodeId)) ?? null
}

async function assertCropSourceCurrent(source: CropSourceSnapshot, projectId: string, canvasId: string): Promise<void> {
  const state = useCanvasStore.getState()
  const activeCanvas = state.canvas?.canvas
  if (!activeCanvas || sid(activeCanvas.id) !== canvasId) throw new Error('画布已切换，已停止发布裁剪结果。')
  const node = state.nodes.find((item) => sid(item.id) === source.nodeId)?.data.node
  if (!node || node.type !== 'image') throw new Error('源图片节点已不存在，已停止发布裁剪结果。')
  if (source.outputId != null && sid(node.currentOutputId) !== sid(source.outputId)) {
    throw new Error('源图片结果已变化，已停止发布裁剪结果。')
  }
  if (source.assetId != null && sid(node.params.assetId) !== sid(source.assetId)) {
    throw new Error('源图片素材已变化，已停止发布裁剪结果。')
  }
  if (source.sourceNodeMediaUrl != null && nodeMediaUrl(node) !== source.sourceNodeMediaUrl) {
    throw new Error('源图片已变化，已停止发布裁剪结果。')
  }
  if (source.outputId == null) {
    const currentUrl = resolveMediaUrl(nodeMediaUrl(node))
    if (currentUrl !== resolveMediaUrl(source.mediaUrl)) throw new Error('源图片已变化，已停止发布裁剪结果。')
  }
  const active = await window.vibepaperDesktop?.getActiveProject()
  if (!active || active.projectId !== projectId || active.canvasId !== canvasId) {
    throw new Error('项目或画布已切换，已停止发布裁剪结果。')
  }
}

async function discardUnpublishedAssets(
  bridge: NonNullable<Window['vibepaperDesktop']>,
  projectId: string,
  assetIds: string[],
): Promise<void> {
  await Promise.all(assetIds.map((assetId) => bridge.deleteAsset(projectId, assetId).catch(() => undefined)))
}

async function refreshPersistedCropNodes(
  bridge: NonNullable<Window['vibepaperDesktop']>,
  projectId: string,
  canvasId: string,
  assetIds: string[],
  sourceNodeId: string,
): Promise<string[]> {
  const active = await bridge.getActiveProject()
  const before = useCanvasStore.getState()
  if (
    !active || active.projectId !== projectId || active.canvasId !== canvasId ||
    sid(before.canvas?.canvas.id) !== canvasId
  ) return []

  const detail = desktopCanvasDetail(await bridge.loadCanvas(projectId, canvasId), active)
  const assetIdSet = new Set(assetIds.map(sid))
  const flow = buildFlow(detail, (nodeId) => {
    const current = useCanvasStore.getState().nodes.find((node) => sid(node.id) === sid(sourceNodeId))
    current?.data.onConfig(nodeId)
  })
  const recovered = flow.nodes.filter((node) => assetIdSet.has(sid(node.data.node.params.assetId)))
  const current = useCanvasStore.getState()
  if (sid(current.canvas?.canvas.id) !== canvasId) return []
  const knownIds = new Set(current.nodes.map((node) => sid(node.id)))
  const source = current.nodes.find((node) => sid(node.id) === sid(sourceNodeId))
  current.setCanvas({
    ...current.canvas!,
    canvas: { ...current.canvas!.canvas, version: detail.canvas.version },
  })
  current.setNodes([
    ...current.nodes,
    ...recovered.filter((node) => !knownIds.has(sid(node.id))).map((node) => ({
      ...node,
      data: { ...node.data, models: source?.data.models ?? [] },
    })),
  ])
  return recovered.map((node) => sid(node.id))
}

function safeBaseName(value?: string): string {
  const withoutExtension = String(value || '图片').replace(/\.[^.]+$/u, '')
  return withoutExtension.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').trim().slice(0, 100) || '图片'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
