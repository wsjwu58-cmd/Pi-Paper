import { api, apiUrl } from '@/lib/api'
import { sid } from '@/lib/ids'
import type { Id, NodePayload } from '@/lib/types'
import { useCanvasStore } from '../canvasStore'
import { isDesktopRuntime } from '../canvasPort'

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired'])

export function syncExecFields(status: string): Pick<NodePayload, 'status' | 'execStatus'> {
  return { status, execStatus: status }
}

/** 立刻把节点执行态写回画布服务，避免只改本地 store、Agent 摘要仍读到 running。 */
export async function persistNodeExec(nodeId: Id, patch: Partial<NodePayload>): Promise<void> {
  // Desktop node changes are persisted by CanvasPage through the local canvas bridge.
  if (isDesktopRuntime()) return
  const canvasId = useCanvasStore.getState().canvas?.canvas.id
  if (canvasId == null) return
  try {
    await api(`/canvases/${sid(canvasId)}/nodes/${sid(nodeId)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
  } catch {
    /* 整表防抖保存仍会带上；这里失败不打断生成回写 */
  }
}

export async function submitNodeTask(
  nodeId: Id,
  modelType: string,
  modelParams: Record<string, unknown>,
  estimatedCost = 8,
  desktopOptions?: { providerType?: 'local' | 'cloud' },
) {
  if (isDesktopRuntime()) {
    const bridge = window.vibepaperDesktop
    if (!bridge) throw new Error('桌面本地服务尚未就绪，无法创建生成任务。')
    const canvas = useCanvasStore.getState().canvas
    if (!canvas) throw new Error('画布尚未加载，无法创建本地任务。')
    const activeProject = await bridge.getActiveProject()
    if (!activeProject) throw new Error('没有打开的本地项目，无法创建生成任务。')
    const node = useCanvasStore.getState().nodes.find((item) => sid(item.id) === sid(nodeId))?.data.node
    const modality = node?.type
    if (modality !== 'text' && modality !== 'image' && modality !== 'video' && modality !== 'audio') {
      throw new Error('此节点类型尚未接入桌面本地生成。')
    }
    if (modality === 'audio') {
      if (desktopOptions?.providerType !== 'local' || modelType !== 'local-sapi-tts') {
        throw new Error('桌面音频生成仅支持 Windows SAPI 本地语音模型。')
      }
      if (typeof bridge.getLocalAudioModel !== 'function') {
        throw new Error('桌面本地语音服务尚未接入。')
      }
      const audioModel = await bridge.getLocalAudioModel()
      if (!audioModel?.available || audioModel.modelId !== 'local-sapi-tts') {
        throw new Error('Windows SAPI 本地语音模型在当前平台不可用。')
      }
    }
    const prompt = typeof modelParams.prompt === 'string' ? modelParams.prompt.trim() : ''
    if (!prompt) throw new Error('请先填写生成提示词。')

    const { prompt: _prompt, ...parameters } = modelParams
    const task = await bridge.createGenerationTask({
      projectId: activeProject.projectId,
      canvasId: sid(canvas.canvas.id),
      canvasVersion: canvas.canvas.version,
      nodeId: sid(nodeId),
      prompt,
      idempotencyKey: crypto.randomUUID(),
      providerType: desktopOptions?.providerType ?? 'cloud',
      modality,
      parameters,
    })
    if (!task) throw new Error('本地生成任务没有创建成功。')
    const queued = {
      ...syncExecFields('queued'),
      params: {
        ...(useCanvasStore.getState().nodes.find((item) => sid(item.id) === sid(nodeId))?.data.node.params ?? {}),
        ...modelParams,
        model: modelType,
      },
      currentOutputId: task.taskId,
    }
    useCanvasStore.getState().updateNodePayload(nodeId, queued)
    window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { taskId: task.taskId, nodeId: sid(nodeId) } }))
    return task.taskId
  }

  const { useAuth } = await import('@/lib/auth')
  const canvas = useCanvasStore.getState().canvas
  const user = useAuth.getState().user
  const res = await api<{ taskId: string }>('/tasks', {
    method: 'POST',
    idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
    body: JSON.stringify({
      userId: user?.id,
      nodeId,
      canvasId: canvas?.canvas.id,
      modelType,
      modelParams,
      estimatedCost,
      source: 'user',
    }),
  })
  const queued = {
    ...syncExecFields('queued'),
    params: {
      ...(useCanvasStore.getState().nodes.find((n) => sid(n.id) === sid(nodeId))?.data.node.params ?? {}),
      ...modelParams,
    },
    currentOutputId: res.taskId,
  }
  useCanvasStore.getState().updateNodePayload(nodeId, queued)
  void persistNodeExec(nodeId, queued)
  useAuth.getState().refreshAccount()
  window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { taskId: res.taskId, nodeId: sid(nodeId) } }))
  const es = new EventSource(apiUrl(`/tasks/${res.taskId}/events`))
  es.onmessage = (ev) => {
    try {
      const d = JSON.parse(ev.data)
      const status = d.status as string | undefined
      if (!status) return
      const patch: Record<string, unknown> = { ...syncExecFields(status) }
      if (status === 'succeeded' && d.outputs?.[0]) {
        const out = d.outputs[0] as { url?: string; meta?: Record<string, unknown> }
        const node = useCanvasStore.getState().nodes.find((n) => sid(n.id) === sid(nodeId))?.data.node
        const url = out.url || (typeof out.meta?.remoteUrl === 'string' ? out.meta.remoteUrl : undefined)
        if (node && url) {
          patch.params = { ...node.params, url, lastOutputUrl: url }
        }
      }
      useCanvasStore.getState().updateNodePayload(nodeId, patch as never)
      if (TERMINAL.has(status)) {
        void persistNodeExec(nodeId, patch as Partial<NodePayload>)
        es.close()
        useAuth.getState().refreshAccount()
        window.dispatchEvent(
          new CustomEvent('vp-task-updated', { detail: { taskId: res.taskId, nodeId: sid(nodeId) } }),
        )
      }
    } catch {
      /* ignore */
    }
  }
  es.onerror = () => {
    window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { taskId: res.taskId, nodeId: sid(nodeId) } }))
  }
  return res.taskId
}

/** Submit the original Compose node through the local FFmpeg task bridge. */
export async function submitComposeNodeTask(nodeId: Id, inputNodeIds: string[]): Promise<string> {
  if (!isDesktopRuntime()) throw new Error('本地视频合成接口仅适用于桌面项目。')
  const bridge = window.vibepaperDesktop
  if (!bridge?.composeVideos) throw new Error('桌面本地视频合成服务尚未就绪。')
  const canvas = useCanvasStore.getState().canvas
  if (!canvas) throw new Error('画布尚未加载，无法创建本地合成任务。')
  const activeProject = await bridge.getActiveProject()
  if (!activeProject) throw new Error('没有打开的本地项目，无法创建本地合成任务。')
  const node = useCanvasStore.getState().nodes.find((item) => sid(item.id) === sid(nodeId))?.data.node
  if (!node || node.type !== 'compose') throw new Error('合成节点已不存在。')
  if (inputNodeIds.length < 2 || new Set(inputNodeIds).size !== inputNodeIds.length) {
    throw new Error('合成至少需要 2 个不重复的视频输入。')
  }

  const task = await bridge.composeVideos({
    projectId: activeProject.projectId,
    canvasId: sid(canvas.canvas.id),
    canvasVersion: canvas.canvas.version,
    nodeId: sid(nodeId),
    idempotencyKey: crypto.randomUUID(),
    inputNodeIds,
  })
  if (!task?.taskId) throw new Error('本地合成任务没有创建成功。')

  const current = useCanvasStore.getState().nodes.find((item) => sid(item.id) === sid(nodeId))?.data.node
  useCanvasStore.getState().updateNodePayload(nodeId, {
    ...syncExecFields(task.status),
    params: {
      ...(current?.params ?? node.params),
      operation: 'compose',
      count: 1,
      inputNodeIds,
      model: task.modelId ?? 'compose-1.0',
    },
    currentOutputId: task.taskId,
  })
  window.dispatchEvent(new CustomEvent('vp-task-updated', { detail: { taskId: task.taskId, nodeId: sid(nodeId) } }))
  return task.taskId
}
