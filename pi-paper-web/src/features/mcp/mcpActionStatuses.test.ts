import { describe, expect, it } from 'vitest'
import { isPendingProviderDisclosure, isTerminalMcpActionStatus } from './mcpActionStatuses'

describe('MCP disclosure action status', () => {
  it('shows only an awaiting disclosure action', () => {
    expect(isPendingProviderDisclosure({ kind: 'provider_disclosure', status: 'awaiting_disclosure' })).toBe(true)
    expect(isPendingProviderDisclosure({ kind: 'provider_disclosure', status: 'authorized' })).toBe(false)
    expect(isPendingProviderDisclosure({ kind: 'provider_disclosure', status: 'rejected' })).toBe(false)
    expect(isPendingProviderDisclosure({ kind: 'provider_disclosure', status: 'expired' })).toBe(false)
    expect(isPendingProviderDisclosure({ kind: 'generation', status: 'awaiting_disclosure' })).toBe(false)
  })

  it('treats known decisions as terminal while preserving the explicit pending state', () => {
    expect(isTerminalMcpActionStatus('authorized')).toBe(true)
    expect(isTerminalMcpActionStatus('rejected')).toBe(true)
    expect(isTerminalMcpActionStatus('expired')).toBe(true)
    expect(isTerminalMcpActionStatus('awaiting_disclosure')).toBe(false)
  })
})
