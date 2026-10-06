import type { ModelInfo } from '@/lib/types'
import type { MediaDurationCapability } from './MediaSpecificationPicker'

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

export function getVideoDurationOptions(constraints: Record<string, unknown> | undefined, resolution: string): number[] {
  const byResolution = constraints?.durationByResolution
  const matching = byResolution && typeof byResolution === 'object' && !Array.isArray(byResolution)
    ? Object.entries(byResolution).find(([key]) => key.toLowerCase() === resolution.toLowerCase())?.[1] : undefined
  const values = matching ?? constraints?.acceptedDurations
  return Array.isArray(values) ? values.filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0) : []
}

export function getVideoDurationCapability(
  constraints: Record<string, unknown> | undefined,
  resolution: string,
  defaultDuration?: unknown,
): MediaDurationCapability {
  const options = getVideoDurationOptions(constraints, resolution)
  if (options.length) return { kind: 'discrete', values: options }

  const minimum = constraints?.minimumDuration
  const maximum = constraints?.maximumDuration
  if (typeof minimum === 'number' && Number.isFinite(minimum)
    && typeof maximum === 'number' && Number.isFinite(maximum)
    && minimum > 0 && maximum >= minimum) {
    const configuredStep = constraints?.durationStep
    const step = typeof configuredStep === 'number' && Number.isFinite(configuredStep) && configuredStep > 0
      ? configuredStep
      : Number.isInteger(minimum) && Number.isInteger(maximum) ? 1 : 0.1
    return { kind: 'range', minimum, maximum, step }
  }

  if (typeof defaultDuration === 'number' && Number.isFinite(defaultDuration) && defaultDuration > 0) {
    return { kind: 'fixed', value: defaultDuration }
  }
  return null
}

export function normalizeRemoteMediaReferenceUrl(value: string) {
  const source = typeof value === 'string' ? value.trim() : ''
  if (!source || source.length > 4096) throw new Error('参考地址不能为空，且不能超过 4096 个字符。')
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error('参考地址无效，请输入 HTTPS 地址。')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('请使用不含账号密码的 HTTPS 媒体地址。')
  }
  return url.toString()
}

export function getVideoFrameReferences<T extends VideoReferenceInput>(refs: readonly T[], desktopMode = false) {
  const frames = refs.filter((ref) => ref.kind === 'image' || !desktopMode && ref.kind === 'video')
  return { firstFrame: frames[0], lastFrame: frames[1] }
}

export function buildMediaReferenceParameters(refs: readonly VideoReferenceInput[], modality: string, desktopMode = false) {
  const frames = modality === 'video' ? getVideoFrameReferences(refs, desktopMode) : { firstFrame: undefined, lastFrame: undefined }
  const allUrls = refs.map((ref) => ref.url).filter((url): url is string => Boolean(url))
  const imageUrls = refs.filter((ref) => ref.kind === 'image').map((ref) => ref.url).filter((url): url is string => Boolean(url))
  const videoUrls = refs.filter((ref) => ref.kind === 'video').map((ref) => ref.url).filter((url): url is string => Boolean(url))
  const audioUrls = refs.filter((ref) => ref.kind === 'audio').map((ref) => ref.url).filter((url): url is string => Boolean(url))
  const texts = refs
    .map((ref) => ref.text)
    .filter((text): text is string => Boolean(text && text.trim()))

  return {
    referenceUrls: desktopMode ? imageUrls : allUrls,
    referenceImages: desktopMode ? imageUrls : allUrls,
    ...(desktopMode ? { referenceVideos: videoUrls, referenceAudios: audioUrls } : {}),
    referenceTexts: texts,
    firstFrameUrl: frames.firstFrame?.url,
    lastFrameUrl: frames.lastFrame?.url,
    imageUrl: frames.firstFrame?.kind === 'image' ? frames.firstFrame.url : undefined,
    upstreamNodeIds: refs.map((ref) => ref.sourceNodeId).filter(Boolean),
  }
}

export function getNodeResolutionMap(nodeType: string, model?: ModelInfo, desktopMode = false, aspect?: string): Readonly<Record<string, string>> {
  if (desktopMode) {
    const desktopModel = model as ModelInfo & { constraints?: Record<string, unknown> } | undefined
    const constraints = desktopModel?.constraints
    const byAspect = nodeType === 'video' ? constraints?.resolutionsByAspectRatio : constraints?.sizesByAspectRatio
    const matching = aspect && byAspect && typeof byAspect === 'object' && !Array.isArray(byAspect)
      ? (byAspect as Record<string, unknown>)[aspect] : undefined
    const allowed = matching ?? (nodeType === 'video' ? constraints?.acceptedResolutions : constraints?.acceptedSizes)
    if (Array.isArray(allowed) && allowed.length && allowed.every((value) => typeof value === 'string')) {
      return Object.fromEntries(allowed.map((value: string) => [value.toUpperCase(), value]))
    }
    const defaults = model?.defaultParams ?? {}
    const declaredDefault = nodeType === 'video' ? defaults.resolution : defaults.size ?? defaults.resolution
    if (typeof declaredDefault === 'string' && declaredDefault.trim()) {
      return { [declaredDefault.toUpperCase()]: declaredDefault }
    }
    return {}
  }
  const isAgnesVideo = nodeType === 'video' && (
    model?.provider?.toLowerCase() === 'agnes' || /agnes-video/i.test(model?.name ?? '')
  )
  const isArkVideo = nodeType === 'video' && model?.provider?.toLowerCase() === 'volcengine-ark'
  return isAgnesVideo || isArkVideo ? AGNES_VIDEO_RESOLUTIONS : IMAGE_RESOLUTIONS
}

export function resolveNodeResolution(nodeType: string, model: ModelInfo | undefined, selectedKey: string, desktopMode = false, aspect?: string) {
  const resolutionMap = getNodeResolutionMap(nodeType, model, desktopMode, aspect)
  if (desktopMode && Object.keys(resolutionMap).length === 0) return {}
  const resKey = resolutionMap[selectedKey] ? selectedKey : Object.keys(resolutionMap)[0] ?? selectedKey
  return {
    resKey,
    ...(resolutionMap[resKey] !== undefined ? { resolution: resolutionMap[resKey] } : {}),
    ...(nodeType === 'video' || desktopMode && nodeType === 'image' ? { size: desktopMode ? resolutionMap[resKey] ?? resKey : resKey } : {}),
  }
}
