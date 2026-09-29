import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@/desktop/desktop-bridge'

let api: typeof import('./api').api
let bridge: {
  getActiveProject: ReturnType<typeof vi.fn>
  listDramaAssets: ReturnType<typeof vi.fn>
  upsertDramaAsset: ReturnType<typeof vi.fn>
  createDramaSeries: ReturnType<typeof vi.fn>
  createDramaCharacter: ReturnType<typeof vi.fn>
  addDramaReferencePack: ReturnType<typeof vi.fn>
  createDramaShot: ReturnType<typeof vi.fn>
  prepareDramaKeyframeNode: ReturnType<typeof vi.fn>
  recordDramaKeyframe: ReturnType<typeof vi.fn>
  prepareDramaVideoNode: ReturnType<typeof vi.fn>
  recordDramaLineage: ReturnType<typeof vi.fn>
  staleDramaLineagesForCharacter: ReturnType<typeof vi.fn>
  loadCanvas: ReturnType<typeof vi.fn>
  createNode: ReturnType<typeof vi.fn>
  listDramaRenderBatches: ReturnType<typeof vi.fn>
  getDramaRenderBatch: ReturnType<typeof vi.fn>
  listRenderReviews: ReturnType<typeof vi.fn>
  createRenderReview: ReturnType<typeof vi.fn>
  getAgentUsage: ReturnType<typeof vi.fn>
}

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
  ;({ api } = await import('./api'))
})

beforeEach(() => {
  bridge = {
    getActiveProject: vi.fn(async () => ({ projectId: 'project-1', canvasId: 'canvas/1', name: 'Test' })),
    listDramaAssets: vi.fn(async () => ({ items: [] })),
    upsertDramaAsset: vi.fn(async (input) => ({ ...input, assetId: 'asset-1', currentCanvasVersion: 1 })),
    createDramaSeries: vi.fn(async (input) => ({ ...input.series, id: input.series.id ?? 'series-1', canvasId: input.canvasId })),
    createDramaCharacter: vi.fn(async (input) => input.character),
    addDramaReferencePack: vi.fn(async (input) => input.pack),
    createDramaShot: vi.fn(async (input) => input.shot),
    prepareDramaKeyframeNode: vi.fn(async (input) => ({
      nodeType: 'image', creativeType: 'keyframe', shotId: input.shotId,
      referencePackIds: ['ref-1'], referenceAssetIds: ['front-1', 'side-1', 'back-1', 'expression-1'],
    })),
    recordDramaKeyframe: vi.fn(async (input) => input.render),
    prepareDramaVideoNode: vi.fn(async (input) => ({
      nodeType: 'video', creativeType: 'clip', shotId: input.shotId,
      keyframeRenderId: 'keyframe-1', referencePackIds: ['ref-1'],
    })),
    recordDramaLineage: vi.fn(async (input) => input.lineage),
    staleDramaLineagesForCharacter: vi.fn(async () => ['lineage-1']),
    loadCanvas: vi.fn(async () => ({ projectId: 'project-1', canvasId: 'canvas/1', version: 8, nodes: [], edges: [], groups: [], stacks: [] })),
    createNode: vi.fn(async () => ({ node: { id: 'created-node-1' }, version: 9, replayed: false })),
    listDramaRenderBatches: vi.fn(async () => ({ items: [] })),
    getDramaRenderBatch: vi.fn(async () => ({ id: 'batch-1' })),
    listRenderReviews: vi.fn(async () => ({ items: [] })),
    createRenderReview: vi.fn(async (input) => ({ ...input, id: 'review-1', verdict: 'pass' })),
    getAgentUsage: vi.fn(async () => ({ sessionId: 'session-1', tokenTotal: 15, modelUsage: { 'agnes/model-a': 15 } })),
  }
  vi.stubGlobal('window', {
    location: { protocol: 'vibe:' },
    vibepaperDesktop: bridge as unknown as DesktopBridge,
  })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('desktop API must not use fetch') }))
})

describe('desktop local API adapters', () => {
  it('routes drama asset reads and filters through the active project bridge', async () => {
    await expect(api('/canvases/canvas%2F1/drama-assets?assetType=scene&episodeId=ep-1'))
      .resolves.toEqual({ items: [] })
    expect(bridge.listDramaAssets).toHaveBeenCalledWith('project-1', 'canvas/1', {
      assetType: 'scene', episodeId: 'ep-1',
    })
  })

  it('routes drama asset writes with the bridge-owned project and idempotency key', async () => {
    await api('/canvases/canvas%2F1/drama-assets', {
      method: 'POST',
      idempotencyKey: 'drama-key-1',
      body: JSON.stringify({ assetType: 'series_bible', canvasVersion: 0, data: { premise: 'Story' } }),
    })
    expect(bridge.upsertDramaAsset).toHaveBeenCalledWith({
      assetType: 'series_bible', canvasVersion: 0, data: { premise: 'Story' },
      projectId: 'project-1', canvasId: 'canvas/1', idempotencyKey: 'drama-key-1',
    })
  })

  it('routes the original drama state endpoints through local storage and canvas CAS', async () => {
    await api('/drama/series', {
      method: 'POST', idempotencyKey: 'series-command',
      body: JSON.stringify({ canvasId: 'canvas/1', id: 'series-1' }),
    })
    expect(bridge.createDramaSeries).toHaveBeenCalledWith({
      projectId: 'project-1', canvasId: 'canvas/1', idempotencyKey: 'series-command',
      series: {
        id: 'series-1', activeCanonRevision: 1,
        format: {
          id: 'vertical-short-drama-v1', aspectRatio: '9:16', targetDurationSeconds: 180,
          minShotCount: 60, maxShotCount: 90, minShotDurationSeconds: 2, maxShotDurationSeconds: 5,
          keyframeFirst: true,
        },
      },
    })

    await api('/drama/series/series-1/characters', {
      method: 'POST', idempotencyKey: 'character-command',
      body: JSON.stringify({ name: 'Hero', identityAnchors: ['A', 'B', 'C'], voiceId: 'voice-1' }),
    })
    expect(bridge.createDramaCharacter).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'character-command',
      character: expect.objectContaining({ seriesId: 'series-1', activeLookRevision: 1 }),
    }))

    await api('/drama/characters/hero-1/reference-packs', {
      method: 'POST', idempotencyKey: 'pack-command',
      body: JSON.stringify({
        lookRevision: 1, status: 'approved', frontAssetId: 'front-1', sideAssetId: 'side-1',
        backAssetId: 'back-1', expressionAssetIds: ['expression-1'],
      }),
    })
    await api('/drama/series/series-1/shots', {
      method: 'POST', idempotencyKey: 'shot-command',
      body: JSON.stringify({ episodeNo: 1, shotNo: 1, durationSeconds: 3,
        characterBindings: [{ characterId: 'hero-1', lookRevision: 1 }] }),
    })

    const keyframeNode = await api<{ canvasNodeId: string }>('/drama/shots/shot-1/keyframe-node', {
      method: 'POST', idempotencyKey: 'keyframe-node-command',
      body: JSON.stringify({ canvasId: 'canvas/1', prompt: 'A vertical keyframe', model: 'image-model' }),
    })
    expect(keyframeNode.canvasNodeId).toBe('created-node-1')
    expect(bridge.prepareDramaKeyframeNode).toHaveBeenCalledWith({
      projectId: 'project-1', canvasId: 'canvas/1', shotId: 'shot-1',
    })
    expect(bridge.createNode).toHaveBeenCalledWith(expect.objectContaining({
      expectedVersion: 8, idempotencyKey: 'keyframe-node-command', type: 'image', creativeType: 'keyframe',
      prompt: 'A vertical keyframe', modelRef: 'image-model',
      params: expect.objectContaining({
        shotId: 'shot-1', referencePackIds: ['ref-1'],
        referenceAssetIds: ['front-1', 'side-1', 'back-1', 'expression-1'], aspectRatio: '9:16', model: 'image-model',
      }),
    }))
    await api('/drama/shots/shot-1/keyframes', {
      method: 'POST', idempotencyKey: 'accept-command',
      body: JSON.stringify({ status: 'accepted', referencePackIds: ['ref-1'] }),
    })
    await api('/drama/shots/shot-1/video-node', {
      method: 'POST', idempotencyKey: 'video-node-command',
      body: JSON.stringify({ canvasId: 'canvas/1', prompt: 'A vertical clip' }),
    })
    expect(bridge.prepareDramaVideoNode).toHaveBeenCalledWith({
      projectId: 'project-1', canvasId: 'canvas/1', shotId: 'shot-1',
    })
    await api('/drama/lineages', {
      method: 'POST', idempotencyKey: 'lineage-command',
      body: JSON.stringify({ shotId: 'shot-1', keyframeRenderId: 'keyframe-1', status: 'submitted' }),
    })
    await api('/drama/characters/hero-1/stale-lineages', {
      method: 'POST', idempotencyKey: 'stale-command',
    })
    expect(bridge.staleDramaLineagesForCharacter).toHaveBeenCalledWith({
      projectId: 'project-1', canvasId: 'canvas/1', idempotencyKey: 'stale-command', characterId: 'hero-1',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('routes session usage to the local Pi ledger without points or network fetch', async () => {
    const result = await api<Record<string, unknown>>('/agent/sessions/session-1/usage')
    expect(bridge.getAgentUsage).toHaveBeenCalledWith('project-1', 'session-1')
    expect(result).toMatchObject({ tokenTotal: 15, modelUsage: { 'agnes/model-a': 15 } })
    expect(result).not.toHaveProperty('pointsUsed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('routes render batch reads and continuity review writes through the local project bridge', async () => {
    await expect(api('/drama/render-batches')).resolves.toEqual({ items: [] })
    expect(bridge.listDramaRenderBatches).toHaveBeenCalledWith('project-1', 'canvas/1')

    await api('/render-reviews', {
      method: 'POST',
      body: JSON.stringify({
        canvasId: 'canvas/1', targetNodeId: 'video-node', shotDurationSeconds: 3,
        expectedDurationSeconds: 3, characterConsistent: true, audioDurationMs: 3000,
        videoDurationMs: 3000, previousCamera: 'wide', currentCamera: 'close',
      }),
    })
    expect(bridge.createRenderReview).toHaveBeenCalledWith({
      canvasId: 'canvas/1', targetNodeId: 'video-node', shotDurationSeconds: 3,
      expectedDurationSeconds: 3, characterConsistent: true, audioDurationMs: 3000,
      videoDurationMs: 3000, previousCamera: 'wide', currentCamera: 'close', projectId: 'project-1',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects every render batch mutation until local accepted keyframes and confirmation exist', async () => {
    const mutationPaths = [
      '/drama/render-batches',
      '/drama/render-batches/batch-1/submit',
      '/drama/render-batches/batch-1/jobs/job-1/status',
      '/drama/render-batches/batch-1/jobs/job-1/rerun',
    ]
    for (const path of mutationPaths) {
      await expect(api(path, { method: 'POST' }))
        .rejects.toMatchObject({ code: 'DESKTOP_RENDER_BATCH_UNAVAILABLE' })
    }
    expect(bridge.listDramaRenderBatches).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
