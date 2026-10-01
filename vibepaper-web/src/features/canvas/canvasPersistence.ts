import { sid } from '@/lib/ids'

type FlushCanvas = () => Promise<void>

interface CanvasPersistenceRegistration {
  projectId: string | null
  canvasId: string
  flush: FlushCanvas
}

let activeRegistration: CanvasPersistenceRegistration | null = null

export function registerCanvasPersistence(
  projectId: string | null | undefined,
  canvasId: string,
  flush: FlushCanvas,
): () => void {
  const registration = { projectId: projectId ?? null, canvasId: sid(canvasId), flush }
  activeRegistration = registration
  return () => {
    if (activeRegistration === registration) activeRegistration = null
  }
}

export async function flushCanvasPersistence(projectId: string, canvasId: string): Promise<void> {
  const registration = activeRegistration
  if (!registration || registration.projectId !== projectId || registration.canvasId !== sid(canvasId)) {
    throw new Error('画布保存服务尚未就绪，无法导出当前节点。')
  }
  await registration.flush()
  if (activeRegistration !== registration) {
    throw new Error('画布已切换，无法导出当前节点。')
  }
}
