import type { NodePayload } from '@/lib/types'

/** Desktop persistence also stores the prompt as a top-level node field. */
export function promptEditPatch(params: Record<string, unknown>, value: string, desktopMode: boolean): Partial<NodePayload> {
  return { params: { ...params, prompt: value }, ...(desktopMode ? { prompt: value } : {}) }
}
