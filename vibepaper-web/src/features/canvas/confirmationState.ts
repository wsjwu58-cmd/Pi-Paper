import type { AgentConfirmation } from './agentTypes'

/**
 * A confirmation can be restored from durable chat history long after its
 * server-side approval token has expired. Such a record is useful history,
 * but it must never keep the composer locked or render as an actionable card.
 */
export function isActionableConfirmation(
  confirmation: AgentConfirmation | undefined,
  now = Date.now(),
): confirmation is AgentConfirmation {
  if (confirmation?.status !== 'pending' && confirmation?.status !== 'submitting') return false
  if (!confirmation.expiresAt) return false
  const expiresAt = Date.parse(confirmation.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > now
}
