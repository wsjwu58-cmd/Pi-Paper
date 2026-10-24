import { describe, expect, it } from 'vitest'
import { canCreateMcpGrant, createMcpClientGrantInput, getMcpClientConfigText, providerGrantForPermissions, setMcpGrantPermission } from './mcpGrantPolicy'

describe('MCP scoped client grants', () => {
  it('keeps provider discovery available while configuration is selected', () => {
    const permissions = setMcpGrantPermission(['canvas.read'], 'provider.configure', true)
    expect(permissions).toEqual(['canvas.read', 'provider.configure', 'provider.read'])
    expect(setMcpGrantPermission(permissions, 'provider.read', false)).toEqual(permissions)
    const readOnly = setMcpGrantPermission(permissions, 'provider.configure', false)
    expect(readOnly).toEqual(['canvas.read', 'provider.read'])
    expect(setMcpGrantPermission(readOnly, 'provider.read', false)).toEqual(['canvas.read'])
  })

  it('drops hidden credential mappings from a read-only provider grant', () => {
    const draft = { providerId: 'agnes', credentialFields: ['apiKey'],
      credentialInputModes: ['authorized_env' as const],
      authorizedEnv: [{ fieldName: 'apiKey', envVariableName: '' }] }
    expect(providerGrantForPermissions(draft, false)).toEqual({
      providerId: 'agnes', credentialFields: [], credentialInputModes: [], authorizedEnv: [],
    })
    expect(providerGrantForPermissions(draft, true)).toEqual(draft)
    expect(draft.authorizedEnv).toEqual([{ fieldName: 'apiKey', envVariableName: '' }])
  })

  it('keeps task output discovery available while media reading is selected', () => {
    const permissions = setMcpGrantPermission(['canvas.read'], 'media.read', true)
    expect(permissions).toEqual(['canvas.read', 'media.read', 'task.read'])
    expect(setMcpGrantPermission(permissions, 'task.read', false)).toEqual(permissions)
    const tasksOnly = setMcpGrantPermission(permissions, 'media.read', false)
    expect(tasksOnly).toEqual(['canvas.read', 'task.read'])
    expect(setMcpGrantPermission(tasksOnly, 'task.read', false)).toEqual(['canvas.read'])
  })
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

  it('selects only the configuration format for the selected client', () => {
    const config = {
      codex: '[mcp_servers.vibepaper]',
      claudeCode: '{"mcpServers":{"vibepaper":{"legacy":true}}}',
      cursor: '{"mcpServers":{"vibepaper":{"cursor":true}}}',
      workbuddy: '{"mcpServers":{"vibepaper":{"workbuddy":true}}}',
      trae: null,
      traeCommandCompatible: false,
      other: '{"mcpServers":{"vibepaper":{"other":true}}}',
    }
    expect(getMcpClientConfigText(config, 'codex')).toBe(config.codex)
    expect(getMcpClientConfigText(config, 'claude-code')).toBe(config.claudeCode)
    expect(getMcpClientConfigText(config, 'cursor')).toBe(config.cursor)
    expect(getMcpClientConfigText(config, 'workbuddy')).toBe(config.workbuddy)
    expect(getMcpClientConfigText(config, 'trae')).toBeNull()
    expect(getMcpClientConfigText(config, 'other')).toBe(config.other)
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
