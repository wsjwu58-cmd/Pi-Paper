import { describe, expect, it } from 'vitest'
import { canCreateMcpGrant, createMcpClientGrantInput } from './mcpGrantPolicy'

describe('MCP scoped client grants', () => {
  it('records the displayed scope without requiring a separate disclosure checkbox', () => {
    expect(canCreateMcpGrant({
      activeCanvas: true,
      busy: false,
      providerScopeNeeded: true,
      selectedProviderCount: 1,
      mediaRead: true,
      selectedMediaCount: 1,
      invalidProviderInput: false,
    })).toBe(true)

    expect(createMcpClientGrantInput({
      clientName: 'codex',
      permissions: ['canvas.read', 'generation.propose'],
      providerGrants: [],
      mediaTypes: [],
      disclosureVersion: 'desktop-mcp-provider-disclosure-v1',
    })).toMatchObject({ accepted: true, permissions: ['canvas.read', 'generation.propose'] })
  })

  it('still requires an active canvas and valid selected scopes', () => {
    const base = {
      activeCanvas: true,
      busy: false,
      providerScopeNeeded: false,
      selectedProviderCount: 0,
      mediaRead: false,
      selectedMediaCount: 0,
      invalidProviderInput: false,
    }
    expect(canCreateMcpGrant({ ...base, activeCanvas: false })).toBe(false)
    expect(canCreateMcpGrant({ ...base, providerScopeNeeded: true })).toBe(false)
    expect(canCreateMcpGrant({ ...base, mediaRead: true })).toBe(false)
    expect(canCreateMcpGrant({ ...base, invalidProviderInput: true })).toBe(false)
  })
})
