import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@/desktop/desktop-bridge'

let api: typeof import('./api').api
let bridge: {
  getActiveProject: ReturnType<typeof vi.fn>
  listDramaAssets: ReturnType<typeof vi.fn>
  upsertDramaAsset: ReturnType<typeof vi.fn>
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
