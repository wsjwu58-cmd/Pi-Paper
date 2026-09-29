import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'

let DramaProductionPanel: typeof import('./DramaProductionPanel').DramaProductionPanel

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  ;({ DramaProductionPanel } = await import('./DramaProductionPanel'))
})

describe('DramaProductionPanel', () => {
  it('explains why desktop render batches cannot be created or run', () => {
    const html = renderToStaticMarkup(<DramaProductionPanel canvasId="canvas-1" desktop />)

    expect(html).toContain('没有可验证的已接受关键帧记录')
    expect(html).toContain('批次确认、任务提交、状态同步和重跑尚未接入')
    expect(html).toContain('尚无渲染批次')
  })
})
