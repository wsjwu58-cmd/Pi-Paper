import { describe, expect, it, vi } from 'vitest'
import { getEventStreamReconnectDelay, scrollChatToBottom, shouldReloadSessionAfterStream } from './agentEventStream'

describe('getEventStreamReconnectDelay', () => {
  it('keeps an immediately completed empty stream from reconnecting in a tight loop', () => {
    expect(getEventStreamReconnectDelay(250)).toBe(250)
    expect(getEventStreamReconnectDelay(100)).toBe(250)
    expect(getEventStreamReconnectDelay(8000)).toBe(5000)
  })
})

describe('shouldReloadSessionAfterStream', () => {
  it('requires authoritative session data after a streamed confirmation', () => {
    expect(shouldReloadSessionAfterStream([{ type: 'tool_completed' }, { type: 'confirmation_required' }])).toBe(true)
  })

  it('also recognizes the legacy confirmation envelope', () => {
    expect(shouldReloadSessionAfterStream([{ type: 'confirm_required' }])).toBe(true)
  })
})

describe('scrollChatToBottom', () => {
  it('uses an immediate scroll after rehydrating a confirmation card', () => {
    const scrollTo = vi.fn()

    scrollChatToBottom({ scrollHeight: 687, scrollTo } as unknown as HTMLElement)

    expect(scrollTo).toHaveBeenCalledWith({ top: 687, behavior: 'auto' })
  })
})
