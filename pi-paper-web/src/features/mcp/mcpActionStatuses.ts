const terminalMcpActionStatuses = new Set([
  'approved', 'authorized', 'rejected', 'expired', 'timed_out', 'timeout', 'cancelled', 'canceled',
  'invalidated', 'submitted', 'submission_unknown', 'submission-unknown', 'succeeded', 'completed',
  'failed', 'denied',
])

export function isTerminalMcpActionStatus(status: string): boolean {
  return terminalMcpActionStatuses.has(status)
}

export function isPendingProviderDisclosure(action: { kind: string; status: string }): boolean {
  return action.kind === 'provider_disclosure' && action.status === 'awaiting_disclosure'
}
