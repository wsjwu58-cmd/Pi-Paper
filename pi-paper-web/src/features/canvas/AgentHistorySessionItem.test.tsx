import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

describe('AgentHistorySessionItem', () => {
  it('does not expose the internal session id in the visible history item', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    })
    const module = await import('./AgentPanel')
    const SessionItem = (
      module as typeof module & {
        AgentHistorySessionItem?: (props: {
          session: { sessionId: string; title: string }
          active: boolean
          onOpen: () => void
        }) => React.ReactNode
      }
    ).AgentHistorySessionItem

    expect(SessionItem).toBeTypeOf('function')
    if (!SessionItem) return

    const html = renderToStaticMarkup(
      <SessionItem
        session={{ sessionId: 'internal-session-352442382010023936', title: '雨夜咖啡馆创作' }}
        active
        onOpen={() => undefined}
      />,
    )

    expect(html).toContain('雨夜咖啡馆创作')
    expect(html).toContain('当前会话')
    expect(html).not.toContain('internal-session-352442382010023936')
  })
})
