import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopNodeOutputExportInput, DesktopNodeOutputExportResult } from '@/desktop/desktop-bridge'
import type { NodePayload } from '@/lib/types'
import { useCanvasStore } from '../canvasStore'
import { registerCanvasPersistence } from '../canvasPersistence'

vi.mock('@/components/ui/Toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

import { toastError, toastSuccess } from '@/components/ui/Toast'
import { downloadNodeOutput } from './nodeDownloads'

const taskId = '12345678-1234-4234-8234-123456789abc'
const assetId = '12345678-1234-4234-8234-123456789abd'

function node(type: NodePayload['type']): NodePayload {
  return { id: 'node-id', type, params: { title: 'my / result' }, status: 'succeeded' }
}

function setupDesktop(
  exportResult: DesktopNodeOutputExportResult,
  nodeType: NodePayload['type'] = 'image',
  exportError?: Error,
) {
  const order: string[] = []
  const exportNodeOutput = vi.fn(async (_input: DesktopNodeOutputExportInput) => {
    order.push('export')
    if (exportError) throw exportError
    return exportResult
  })
  const unregister = registerCanvasPersistence('project-id', 'canvas-id', async () => {
    order.push('flush')
  })
  useCanvasStore.setState({
    canvas: { canvas: { id: 'canvas-id' } } as never,
    nodes: [{ id: 'node-id', data: { node: node(nodeType) } } as never],
  })
  vi.stubGlobal('window', {
    location: { protocol: 'vibe:' },
    vibepaperDesktop: {
      exportNodeOutput,
      getActiveProject: vi.fn(async () => ({ projectId: 'project-id', canvasId: 'canvas-id' })),
    },
  })
  return { exportNodeOutput, order, unregister }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('downloadNodeOutput', () => {
  it('flushes the canvas and exports the visible task media result', async () => {
    const { exportNodeOutput, order, unregister } = setupDesktop({ status: 'saved' }, 'video')
    try {
      const result = await downloadNodeOutput({
        node: node('video'),
        mediaUrl: `vibe://app/tasks/${taskId}/output?index=2#t=0.001`,
      })

      expect(result).toBe('saved')
      expect(order).toEqual(['flush', 'export'])
      expect(exportNodeOutput).toHaveBeenCalledWith({
        projectId: 'project-id',
        canvasId: 'canvas-id',
        nodeId: 'node-id',
        nodeType: 'video',
        source: { kind: 'task', taskId, outputIndex: 2 },
        suggestedName: 'my _ result',
      })
      expect(toastSuccess).toHaveBeenCalledWith('已保存到本地')
      expect(toastError).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('passes the current text-node content to the restricted local export bridge', async () => {
    const { exportNodeOutput, unregister } = setupDesktop({ status: 'saved' }, 'text')
    try {
      await downloadNodeOutput({ node: node('text'), textContent: '当前可见文本' })
      expect(exportNodeOutput).toHaveBeenCalledWith(expect.objectContaining({
        nodeType: 'text',
        source: { kind: 'text', content: '当前可见文本' },
        suggestedName: 'my _ result.txt',
      }))
    } finally {
      unregister()
    }
  })

  it('keeps save-dialog cancellation silent', async () => {
    const { unregister } = setupDesktop({ status: 'cancelled' }, 'director')
    try {
      await expect(downloadNodeOutput({
        node: node('director'),
        mediaUrl: `vibe://app/assets/${assetId}`,
      })).resolves.toBe('cancelled')
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(toastError).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('shows local export failures and does not claim the output was saved', async () => {
    const { unregister } = setupDesktop({ status: 'saved' }, 'image', new Error('目标文件无法写入。'))
    try {
      await expect(downloadNodeOutput({
        node: node('image'),
        mediaUrl: `vibe://app/assets/${assetId}`,
      })).resolves.toBe('failed')
      expect(toastError).toHaveBeenCalledWith('目标文件无法写入。')
      expect(toastSuccess).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })
})
