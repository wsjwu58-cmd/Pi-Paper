type CanvasVersionEnvelope = {
  canvas?: { version?: unknown }
  version?: unknown
}

export function resolveAgentCanvasVersion(remote: CanvasVersionEnvelope, fallback?: unknown): number {
  const candidate = remote.canvas?.version ?? remote.version ?? fallback
  if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
    throw new Error('无法获取当前画布版本，请刷新后重试')
  }
  return candidate
}

export function resolveBoundConfirmationCanvasVersion(boundVersion: unknown): number {

	if (typeof boundVersion !== 'number' || !Number.isInteger(boundVersion) || boundVersion < 0) {
		throw new Error('确认信息缺少有效的画布版本，请刷新后重试确认')
	}
	return boundVersion
}

export function resolveConfirmationCanvasVersion(remote: CanvasVersionEnvelope, fallback?: unknown): number {
  try {
    return resolveAgentCanvasVersion(remote, fallback)
  } catch {
    throw new Error('无法获取当前画布版本，请刷新后重试确认')
  }
}
