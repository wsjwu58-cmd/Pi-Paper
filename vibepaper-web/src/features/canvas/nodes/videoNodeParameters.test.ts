import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@/lib/types'
import { buildMediaReferenceParameters, getNodeResolutionMap, getVideoFrameReferences, resolveNodeResolution } from './videoNodeParameters'

const agnesVideo = { name: 'agnes-video-v2.0', provider: 'agnes', modelType: 'video' } as ModelInfo

describe('video node request parameters', () => {
  it('uses the first two image or video references as ordered keyframes', () => {
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
