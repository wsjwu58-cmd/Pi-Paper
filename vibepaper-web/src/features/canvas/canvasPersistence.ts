import { t as uiText } from '@/lib/i18n'
import { sid } from '@/lib/ids'
import type { DesktopMcpCanvasFlushRequest, DesktopMcpCanvasFlushResponse } from '@/desktop/desktop-bridge'

type FlushCanvas = () => Promise<void>

interface CanvasPersistenceRegistration {
  projectId: string | null
  canvasId: string
  flush: FlushCanvas
}

export type McpCanvasBarrierPhase = 'idle' | 'pending' | 'active'

export function settleMcpCanvasFlushRequest(
  requests: Map<string, DesktopMcpCanvasFlushRequest>,
  settled: { requestId: string; projectId: string; canvasId: string },
): boolean {
  const pending = requests.get(settled.requestId)
  if (!pending || pending.projectId !== settled.projectId || pending.canvasId !== settled.canvasId) return false
  return requests.delete(settled.requestId)
}

const MCP_EDIT_EVENTS = new Set([
  'pointerdown', 'pointermove', 'pointerup', 'pointercancel',
  'mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'touchcancel',
  'click', 'auxclick', 'dblclick', 'contextmenu', 'wheel',
  'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'change', 'paste', 'cut', 'drop', 'drag', 'dragstart', 'dragover',
  'compositionstart', 'compositionupdate', 'compositionend',
])

export function shouldBlockMcpCanvasInput(input: {
  phase: McpCanvasBarrierPhase
  eventType: string
  pointerId?: number
  activePointerIds: ReadonlySet<number>
  composing: boolean
}): boolean {
  if (input.phase === 'idle' || !MCP_EDIT_EVENTS.has(input.eventType)) return false
  if (input.phase === 'pending' && input.pointerId !== undefined && input.activePointerIds.has(input.pointerId)
    && ['pointermove', 'pointerup', 'pointercancel'].includes(input.eventType)) return false
  if (input.phase === 'pending' && input.composing
    && ['compositionupdate', 'compositionend', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input'].includes(input.eventType)) return false
  return true
}

export function isFinalMcpCanvasImeInput(input: {
  afterCompositionEnd: boolean
  eventType: string
  isComposing?: boolean
  inputType?: string
}): boolean {
  if (!input.afterCompositionEnd || input.eventType !== 'input' || input.isComposing === true) return false
  // Chromium reports insertFromComposition in some builds and insertText in
  // others. Both are the final committed value; intermediate composition
  // updates keep isComposing=true and must not release the pending flush.
  return /^(insert|delete)/u.test(input.inputType ?? '')
}

export function createMcpCanvasFlushResponse(
  request: DesktopMcpCanvasFlushRequest,
  result: { status: 'flushed'; persistedVersion: number } | { status: 'failed'; errorCode: string },
): DesktopMcpCanvasFlushResponse {
  return result.status === 'flushed'
    ? { requestId: request.requestId, projectId: request.projectId, canvasId: request.canvasId, status: 'flushed', persistedVersion: result.persistedVersion }
    : { requestId: request.requestId, projectId: request.projectId, canvasId: request.canvasId, status: 'failed', errorCode: result.errorCode }
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
    throw new Error(uiText("画布保存服务尚未就绪，无法导出当前节点。"))
  }
  await registration.flush()
  if (activeRegistration !== registration) {
    throw new Error(uiText("画布已切换，无法导出当前节点。"))
  }
}
