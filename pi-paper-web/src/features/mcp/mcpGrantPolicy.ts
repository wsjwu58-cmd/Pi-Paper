import type {
  DesktopMcpClientGrantInput,
  DesktopMcpClientGrantResult,
  DesktopMcpClientName,
  DesktopMcpPermission,
  DesktopMcpProviderGrantInput,
} from '@/desktop/desktop-bridge'

const clientConfigKeys: Record<DesktopMcpClientName, keyof DesktopMcpClientGrantResult['config']> = {
  codex: 'codex',
  'claude-code': 'claudeCode',
  cursor: 'cursor',
  workbuddy: 'workbuddy',
  trae: 'trae',
  other: 'other',
}

export function getMcpClientConfigText(
  config: DesktopMcpClientGrantResult['config'],
  clientName: DesktopMcpClientName,
): string | null {
  const value = config[clientConfigKeys[clientName]]
  return typeof value === 'string' ? value : null
}

export function setMcpGrantPermission(
  current: DesktopMcpPermission[], permission: DesktopMcpPermission, enabled: boolean,
): DesktopMcpPermission[] {
  if (!enabled && permission === 'provider.read' && current.includes('provider.configure')) return current
  if (!enabled && permission === 'task.read' && current.includes('media.read')) return current
  const next = enabled ? [...new Set([...current, permission])] : current.filter((value) => value !== permission)
  if (next.includes('provider.configure') && !next.includes('provider.read')) next.push('provider.read')
  if (next.includes('media.read') && !next.includes('task.read')) next.push('task.read')
  return next
}

export function providerGrantForPermissions(
  grant: DesktopMcpProviderGrantInput, canConfigure: boolean,
): DesktopMcpProviderGrantInput {
  return canConfigure ? grant : { providerId: grant.providerId, credentialFields: [], credentialInputModes: [], authorizedEnv: [] }
}

export type McpGrantReadiness = {
  activeCanvas: boolean
  busy: boolean
  providerScopeNeeded: boolean
  selectedProviderCount: number
  mediaRead: boolean
  selectedMediaCount: number
  invalidProviderInput: boolean
}

export function canCreateMcpGrant(input: McpGrantReadiness): boolean {
  return input.activeCanvas
    && !input.busy
    && (!input.providerScopeNeeded || input.selectedProviderCount > 0)
    && (!input.mediaRead || input.selectedMediaCount > 0)
    && !input.invalidProviderInput
}

export function createMcpClientGrantInput(
  input: Omit<DesktopMcpClientGrantInput, 'accepted'>,
): DesktopMcpClientGrantInput {
  return { ...input, accepted: true }
}
