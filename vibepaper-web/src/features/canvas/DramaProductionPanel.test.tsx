import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'

let DramaProductionPanel: typeof import('./DramaProductionPanel').DramaProductionPanel
let DramaRenderConfirmationCard: typeof import('./DramaProductionPanel').DramaRenderConfirmationCard
let DramaUnavailableRenderCandidates: typeof import('./DramaProductionPanel').DramaUnavailableRenderCandidates
let hasActiveRenderJobs: typeof import('./DramaProductionPanel').hasActiveRenderJobs

beforeAll(async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  ;({ DramaProductionPanel, DramaRenderConfirmationCard, DramaUnavailableRenderCandidates, hasActiveRenderJobs } = await import('./DramaProductionPanel'))
})

describe('DramaProductionPanel', () => {
  it('explains that desktop batch candidates require a verified accepted keyframe and video node', () => {
    const html = renderToStaticMarkup(<DramaProductionPanel canvasId="canvas-1" desktop />)

    expect(html).toContain('已接受关键帧、成功本地图片任务和对应视频节点')
    expect(html).toContain('提交前会显示目标、模型与输入供你确认')
    expect(html).toContain('当前没有新的、可由已接入提供方提交的视频镜头')
    expect(html).not.toContain('平台点数')
  })

  it('shows the target, provider, prompt, keyframe input, and a separate confirmation action', () => {
    const html = renderToStaticMarkup(
      <DramaRenderConfirmationCard
        confirmation={{
          actionId: 'action-1', token: 'secret-confirmation-token', expiresAt: '2026-09-29T12:00:00.000Z',
          operation: 'submit', batchId: 'batch-1', canvasVersion: 8,
          jobs: [{
            id: 'job-1', shotId: 'shot-1', canvasNodeId: 'clip-node-1', keyframeRenderId: 'keyframe-task-1',
            durationSeconds: 4, providerType: 'cloud', providerId: 'agnes', modelId: 'agnes-video-2.5-flash',
            prompt: 'A vertical close-up in warm evening light',
          }],
        }}
        candidateForShot={new Map()}
        busy={false}
        onSubmit={() => undefined}
        onReject={() => undefined}
      />,
    )

    expect(html).toContain('确认视频生成')
    expect(html).toContain('Agnes · agnes-video-2.5-flash · 4 秒')
    expect(html).toContain('输入：已接受关键帧；目标：原镜头视频节点')
    expect(html).toContain('新结果会成为该节点当前预览的最新结果，原任务仍保存在本地历史中。')
    expect(html).toContain('A vertical close-up in warm evening light')
    expect(html).toContain('确认并生成 1 个任务')
    expect(html).toContain('提供方可能按其规则收费')
    expect(html).not.toContain('平台点数')
    expect(html).not.toContain('余额')
    expect(html).not.toContain('冻结')
    expect(html).not.toContain('secret-confirmation-token')
  })

  it('keeps refreshing when some jobs are running in a partial batch', () => {
    expect(hasActiveRenderJobs([{ jobs: [{ status: 'completed' }, { status: 'running' }, { status: 'failed' }] }])).toBe(true)
    expect(hasActiveRenderJobs([{ jobs: [{ status: 'completed' }, { status: 'failed' }] }])).toBe(false)
  })

  it('shows unsupported provider and duration candidates with a reason and no submit action', () => {
    const html = renderToStaticMarkup(<DramaUnavailableRenderCandidates candidates={[{
      seriesId: 'series-1', episodeNo: 1, shotId: 'shot-2', shotNo: 2, durationSeconds: 3,
      keyframeRenderId: 'keyframe-2', canvasNodeId: 'clip-2', prompt: 'prompt', providerType: 'cloud',
      providerId: 'agnes', modelId: 'agnes-video-2.5-flash', modelParams: { prompt: 'prompt' },
      available: false, unavailableReasonCode: 'PROVIDER_CAPABILITY_UNAVAILABLE',
      unavailableReason: 'Agnes 视频时长必须在 4 到 12 秒之间。',
    }]} />)

    expect(html).toContain('暂不可提交的镜头')
    expect(html).toContain('第 2 镜 · Agnes · agnes-video-2.5-flash · 3 秒')
    expect(html).toContain('Agnes 视频时长必须在 4 到 12 秒之间。')
    expect(html).not.toContain('<button')
  })
})
