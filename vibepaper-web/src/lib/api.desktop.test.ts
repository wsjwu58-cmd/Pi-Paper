import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@/desktop/desktop-bridge'

let api: typeof import('./api').api
let bridge: {
  getActiveProject: ReturnType<typeof vi.fn>
  listDramaAssets: ReturnType<typeof vi.fn>
  upsertDramaAsset: ReturnType<typeof vi.fn>
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

  it('keeps unsupported desktop API paths visibly unavailable', async () => {
    await expect(api('/drama/render-batches')).rejects.toMatchObject({ code: 'DESKTOP_API_UNAVAILABLE' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
