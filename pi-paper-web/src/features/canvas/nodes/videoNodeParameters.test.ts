import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@/lib/types'
import { buildMediaReferenceParameters, getNodeResolutionMap, getVideoDurationCapability, getVideoDurationOptions, getVideoFrameReferences, normalizeRemoteMediaReferenceUrl, resolveNodeResolution } from './videoNodeParameters'

const agnesVideo = { name: 'agnes-video-v2.0', provider: 'agnes', modelType: 'video' } as ModelInfo

describe('video node request parameters', () => {
  it('uses only declared duration ranges and ratio-specific dimensions', () => {
    expect(getVideoDurationCapability({ acceptedDurations: [5, 10] }, '1080p')).toEqual({ kind: 'discrete', values: [5, 10] })
    expect(getVideoDurationCapability({ minimumDuration: 4, maximumDuration: 15 }, '720p')).toEqual({ kind: 'range', minimum: 4, maximum: 15, step: 1 })
    expect(getVideoDurationCapability(undefined, '720p', 6)).toEqual({ kind: 'fixed', value: 6 })
    expect(getVideoDurationCapability(undefined, '720p')).toBeNull()
    const model = { constraints: { acceptedSizes: ['1280x1280', '1536x1024'], sizesByAspectRatio: { '3:2': ['1536x1024'] } } } as unknown as ModelInfo
    expect(resolveNodeResolution('image', model, '1280X1280', true, '3:2')).toEqual({ resKey: '1536X1024', resolution: '1536x1024', size: '1536x1024' })
  })
  it('limits discrete video duration choices by the selected official resolution', () => {
    const constraints = { acceptedDurations: [4, 6, 8], durationByResolution: { '1080p': [8], '4k': [8] } }
    expect(getVideoDurationOptions(constraints, '720P')).toEqual([4, 6, 8])
    expect(getVideoDurationOptions(constraints, '1080P')).toEqual([8])
    expect(getVideoDurationOptions(constraints, '4K')).toEqual([8])
    expect(getVideoDurationOptions(undefined, '720p')).toEqual([])
  })
  it('preserves Web keyframe behavior for the first two image or video references', () => {
    const refs = [
      { id: 'text', kind: 'text' as const, sourceNodeId: 'text-node', text: '夜晚下雨' },
      { id: 'first', kind: 'image' as const, sourceNodeId: 'first-node', url: 'data:image/png;base64,first' },
      { id: 'last', kind: 'image' as const, sourceNodeId: 'last-node', url: 'data:image/png;base64,last' },
    ]

    expect(getVideoFrameReferences(refs)).toMatchObject({
      firstFrame: { id: 'first' },
      lastFrame: { id: 'last' },
    })
    expect(buildMediaReferenceParameters(refs, 'video')).toMatchObject({
      firstFrameUrl: 'data:image/png;base64,first',
      lastFrameUrl: 'data:image/png;base64,last',
      imageUrl: 'data:image/png;base64,first',
      referenceImages: ['data:image/png;base64,first', 'data:image/png;base64,last'],
      referenceTexts: ['夜晚下雨'],
      upstreamNodeIds: ['text-node', 'first-node', 'last-node'],
    })
  })

  it('sends desktop video and audio references under distinct Ark content fields', () => {
    const refs = [
      { id: 'image', kind: 'image' as const, sourceNodeId: 'image-node', url: 'https://cdn.example/image.png' },
      { id: 'video', kind: 'video' as const, sourceNodeId: 'video-node', url: 'https://cdn.example/ref.mp4' },
      { id: 'audio', kind: 'audio' as const, sourceNodeId: 'audio-node', url: 'https://cdn.example/ref.wav' },
    ]

    expect(getVideoFrameReferences(refs)).toMatchObject({
      firstFrame: { id: 'image' },
      lastFrame: { id: 'video' },
    })
    expect(getVideoFrameReferences(refs, true)).toMatchObject({
      firstFrame: { id: 'image' },
      lastFrame: undefined,
    })
    expect(buildMediaReferenceParameters(refs, 'video', true)).toMatchObject({
      referenceUrls: ['https://cdn.example/image.png'],
      referenceImages: ['https://cdn.example/image.png'],
      referenceVideos: ['https://cdn.example/ref.mp4'],
      referenceAudios: ['https://cdn.example/ref.wav'],
      firstFrameUrl: 'https://cdn.example/image.png',
      lastFrameUrl: undefined,
    })
    expect(buildMediaReferenceParameters(refs, 'video')).toMatchObject({
      referenceUrls: ['https://cdn.example/image.png', 'https://cdn.example/ref.mp4', 'https://cdn.example/ref.wav'],
      referenceImages: ['https://cdn.example/image.png', 'https://cdn.example/ref.mp4', 'https://cdn.example/ref.wav'],
    })
  })

  it('accepts HTTPS media references and rejects insecure or credentialed URLs', () => {
    expect(normalizeRemoteMediaReferenceUrl(' https://cdn.example/ref.mp4?signature=a '))
      .toBe('https://cdn.example/ref.mp4?signature=a')
    for (const value of ['http://cdn.example/ref.mp4', 'https://user:pass@cdn.example/ref.mp4', 'not-a-url']) {
      expect(() => normalizeRemoteMediaReferenceUrl(value)).toThrow()
    }
    expect(() => normalizeRemoteMediaReferenceUrl(`https://cdn.example/${'x'.repeat(4100)}`)).toThrow(/4096/u)
  })

  it('limits Agnes video resolution to the 720P size used by its request adapter', () => {
    expect(Object.keys(getNodeResolutionMap('video', agnesVideo))).toEqual(['720P'])
    expect(resolveNodeResolution('video', agnesVideo, '2K')).toEqual({
      resKey: '720P',
      resolution: '1280x720',
      size: '720P',
    })
    expect(resolveNodeResolution('video', { provider: 'volcengine-ark' } as ModelInfo, '2K', true)).toEqual({})
  })

  it('uses desktop model constraints instead of fixing all video providers to 720P', () => {
    const seedance = { ...agnesVideo, provider: 'volcengine-ark', constraints: { acceptedResolutions: ['480p', '720p', '1080p'] } } as ModelInfo
    expect(resolveNodeResolution('video', seedance, '480P', true)).toEqual({ resKey: '480P', resolution: '480p', size: '480p' })
    const minimax = { ...agnesVideo, provider: 'minimax', constraints: { acceptedResolutions: ['768P', '2K'] } } as ModelInfo
    expect(Object.keys(getNodeResolutionMap('video', minimax, true))).toEqual(['768P', '2K'])
    const image = { ...agnesVideo, provider: 'openai', constraints: { acceptedSizes: ['1K'] } } as ModelInfo
    expect(resolveNodeResolution('image', image, '2K', true)).toEqual({ resKey: '1K', resolution: '1K', size: '1K' })
  })

  it('keeps image resolution choices independent from Agnes video capabilities', () => {
    expect(getNodeResolutionMap('image', agnesVideo)).toEqual({
      '1K': '1024x1024',
      '2K': '2048x2048',
      '4K': '3840x2160',
    })
  })
})
