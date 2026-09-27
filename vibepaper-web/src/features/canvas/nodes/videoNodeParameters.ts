import type { ModelInfo } from '@/lib/types'

const IMAGE_RESOLUTIONS: Readonly<Record<string, string>> = {
  '1K': '1024x1024',
  '2K': '2048x2048',
  '4K': '3840x2160',
}

const AGNES_VIDEO_RESOLUTIONS: Readonly<Record<string, string>> = {
  '720P': '1280x720',
}

export interface VideoReferenceInput {
  kind: 'image' | 'video' | 'audio' | 'text'
  sourceNodeId: string
  url?: string
  text?: string
}

export function getVideoFrameReferences<T extends VideoReferenceInput>(refs: readonly T[]) {
  const frames = refs.filter((ref) => ref.kind === 'image' || ref.kind === 'video')
  return { firstFrame: frames[0], lastFrame: frames[1] }
}

export function buildMediaReferenceParameters(refs: readonly VideoReferenceInput[], modality: string) {
  const frames = modality === 'video' ? getVideoFrameReferences(refs) : { firstFrame: undefined, lastFrame: undefined }
  const urls = refs.map((ref) => ref.url).filter((url): url is string => Boolean(url))
  const texts = refs
    .map((ref) => ref.text)
    .filter((text): text is string => Boolean(text && text.trim()))

  return {
    referenceUrls: urls,
    referenceImages: urls,
    referenceTexts: texts,
    firstFrameUrl: frames.firstFrame?.url,
    lastFrameUrl: frames.lastFrame?.url,
    imageUrl: frames.firstFrame?.kind === 'image' ? frames.firstFrame.url : undefined,
    upstreamNodeIds: refs.map((ref) => ref.sourceNodeId).filter(Boolean),
  }
}

export function getNodeResolutionMap(nodeType: string, model?: ModelInfo, desktopMode = false): Readonly<Record<string, string>> {
  const isAgnesVideo = nodeType === 'video' && (desktopMode ||
    model?.provider?.toLowerCase() === 'agnes' || /agnes-video/i.test(model?.name ?? '')
  )
  return isAgnesVideo ? AGNES_VIDEO_RESOLUTIONS : IMAGE_RESOLUTIONS
}

export function resolveNodeResolution(nodeType: string, model: ModelInfo | undefined, selectedKey: string, desktopMode = false) {
  const resolutionMap = getNodeResolutionMap(nodeType, model, desktopMode)
  const resKey = resolutionMap[selectedKey] ? selectedKey : Object.keys(resolutionMap)[0] ?? selectedKey
  return {
    resKey,
    resolution: resolutionMap[resKey] ?? '1024x1024',
    ...(nodeType === 'video' ? { size: resKey } : {}),
  }
}
