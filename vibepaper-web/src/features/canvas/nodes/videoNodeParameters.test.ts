import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@/lib/types'
import { buildMediaReferenceParameters, getNodeResolutionMap, getVideoFrameReferences, normalizeRemoteMediaReferenceUrl, resolveNodeResolution } from './videoNodeParameters'

const agnesVideo = { name: 'agnes-video-v2.0', provider: 'agnes', modelType: 'video' } as ModelInfo

describe('video node request parameters', () => {
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
    expect(resolveNodeResolution('video', undefined, '2K', true)).toEqual({
      resKey: '720P',
      resolution: '1280x720',
      size: '720P',
    })
  })

  it('keeps image resolution choices independent from Agnes video capabilities', () => {
    expect(getNodeResolutionMap('image', agnesVideo)).toEqual({
      '1K': '1024x1024',
      '2K': '2048x2048',
      '4K': '3840x2160',
    })
  })
})
