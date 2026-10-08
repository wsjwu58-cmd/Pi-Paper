import { toastError, toastSuccess } from '@/components/ui/Toast'
import type { DesktopNodeOutputSource } from '@/desktop/desktop-bridge'
import { sid } from '@/lib/ids'
import type { NodePayload } from '@/lib/types'
import { flushCanvasPersistence } from '../canvasPersistence'
import { useCanvasStore } from '../canvasStore'

export type DownloadNodeType = 'text' | 'image' | 'video' | 'audio' | 'compose' | 'director'
export type NodeDownloadStatus = 'saved' | 'cancelled' | 'failed'

export interface NodeDownloadRequest {
  node: NodePayload
  mediaUrl?: string
  textContent?: string
}

const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const TASK_OUTPUT_URL = new RegExp(`^vibe://app/tasks/(${UUID})/output(?:\\?index=([0-3]))?$`, 'iu')
const ASSET_URL = new RegExp(`^vibe://app/assets/(${UUID})$`, 'iu')

function isDesktopRuntime(): boolean {
  return Boolean(window.vibepaperDesktop) || window.location.protocol === 'vibe:'
}

function supportedNodeType(value: string): DownloadNodeType {
  if (['text', 'image', 'video', 'audio', 'compose', 'director'].includes(value)) {
    return value as DownloadNodeType
  }
  throw new Error('此节点类型没有可下载的结果。')
}

function safeFileBaseName(value: unknown, fallback: string): string {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .slice(0, 80)
  return cleaned || fallback
}

function suggestedName(node: NodePayload, type: DownloadNodeType): string {
  const label = safeFileBaseName(node.params.title ?? node.params.name, `vibepaper-${type}`)
  return type === 'text' ? `${label}.txt` : label
}

function desktopSource(mediaUrl?: string, textContent?: string): DesktopNodeOutputSource {
  if (textContent !== undefined) return { kind: 'text', content: textContent }
  const url = mediaUrl?.split('#', 1)[0]
  if (!url) throw new Error('节点当前没有可下载的结果。')
  const taskMatch = TASK_OUTPUT_URL.exec(url)
  if (taskMatch) {
    return {
      kind: 'task',
      taskId: taskMatch[1],
      ...(taskMatch[2] ? { outputIndex: Number(taskMatch[2]) } : {}),
    }
  }
  const assetMatch = ASSET_URL.exec(url)
  if (assetMatch) return { kind: 'asset', assetId: assetMatch[1] }
  throw new Error('只有已保存在当前项目中的结果或素材可以下载。')
}

function startBrowserDownload(node: NodePayload, type: DownloadNodeType, mediaUrl?: string, textContent?: string) {
  if (textContent !== undefined) {
    const url = URL.createObjectURL(new Blob([textContent], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = suggestedName(node, type)
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    return
  }
  if (!mediaUrl) throw new Error('节点当前没有可下载的结果。')
  const anchor = document.createElement('a')
  anchor.href = mediaUrl
  anchor.target = '_blank'
  anchor.rel = 'noreferrer'
  anchor.download = suggestedName(node, type)
  anchor.click()
}

export async function downloadNodeOutput(request: NodeDownloadRequest): Promise<NodeDownloadStatus> {
  const { node, mediaUrl, textContent } = request
  try {
    const type = supportedNodeType(node.type)
    if (isDesktopRuntime()) {
      const bridge = window.vibepaperDesktop
      if (!bridge?.exportNodeOutput) throw new Error('桌面本地下载接口尚未就绪。')
      const beforeFlush = useCanvasStore.getState()
      const canvasId = sid(beforeFlush.canvas?.canvas.id)
      const nodeId = sid(node.id)
      const nodeBeforeFlush = beforeFlush.nodes.find((item) => sid(item.id) === nodeId)?.data.node
      if (!canvasId || !nodeBeforeFlush || nodeBeforeFlush.type !== node.type) {
        throw new Error('当前画布或节点已更改，无法下载节点结果。')
      }
      const projectBeforeFlush = await bridge.getActiveProject()
      if (!projectBeforeFlush) throw new Error('没有打开的本地项目，无法下载节点结果。')
      if (sid(projectBeforeFlush.canvasId) !== canvasId) {
        throw new Error('当前项目或画布已更改，无法下载节点结果。')
      }
      await flushCanvasPersistence(projectBeforeFlush.projectId, canvasId)
      const project = await bridge.getActiveProject()
      if (!project || project.projectId !== projectBeforeFlush.projectId) {
        throw new Error('当前项目已更改，无法下载节点结果。')
      }
      const snapshot = useCanvasStore.getState()
      const currentCanvasId = sid(snapshot.canvas?.canvas.id)
      const currentNode = snapshot.nodes.find((item) => sid(item.id) === nodeId)?.data.node
      if (currentCanvasId !== canvasId || canvasId !== sid(project.canvasId) || !currentNode) {
        throw new Error('当前项目或画布已更改，无法下载节点结果。')
      }
      if (currentNode.type !== type) throw new Error('节点类型已更改，无法下载当前结果。')
      const result = await bridge.exportNodeOutput({
        projectId: project.projectId,
        canvasId,
        nodeId: sid(currentNode.id),
        nodeType: type,
        source: desktopSource(mediaUrl, textContent),
        suggestedName: suggestedName(currentNode, type),
      })
      if (result?.status === 'cancelled') return 'cancelled'
      if (result?.status !== 'saved') throw new Error('本地下载未能完成。')
      toastSuccess('已保存到本地')
      return 'saved'
    }

    startBrowserDownload(node, type, mediaUrl, textContent)
    toastSuccess(textContent === undefined ? '已打开下载内容' : '已开始下载')
    return 'saved'
  } catch (cause) {
    toastError(cause instanceof Error ? cause.message : '下载节点结果失败。')
    return 'failed'
  }
}
