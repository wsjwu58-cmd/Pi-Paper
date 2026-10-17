import type { DesktopMcpClientGrantInput } from '@/desktop/desktop-bridge'

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
