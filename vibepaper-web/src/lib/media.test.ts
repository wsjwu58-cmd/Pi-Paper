import { beforeAll, describe, expect, it, vi } from 'vitest'

let resolveRendererMediaUrl: typeof import('./media').resolveRendererMediaUrl

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  ;({ resolveRendererMediaUrl } = await import('./media'))
})

describe('desktop media URLs', () => {
  const assetId = '123e4567-e89b-42d3-a456-426614174000'

  it('keeps local asset thumbnails so the library can render imported images', () => {
    expect(resolveRendererMediaUrl(`vibe://app/assets/${assetId}/thumbnail`))
      .toBe(`vibe://app/assets/${assetId}/thumbnail`)
  })

  it('rejects unrecognized local protocol routes', () => {
    expect(resolveRendererMediaUrl(`vibe://app/assets/${assetId}/thumbnail/other`)).toBeUndefined()
  })
})
