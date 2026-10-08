import type { AgentConfirmation } from './agentTypes'

/** Accept the millisecond/second timestamps emitted by the agent service and legacy ISO dates. */
export function parseConfirmationExpiry(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const numeric = Number(normalized)
    if (!Number.isFinite(numeric)) return undefined
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Convert event payload timestamps to the stable format used by chat state. */
export function normalizeConfirmationExpiry(value: unknown): string | undefined {
  const parsed = parseConfirmationExpiry(value)
  return parsed === undefined ? undefined : new Date(parsed).toISOString()
}

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
  const expiresAt = parseConfirmationExpiry(confirmation.expiresAt)
  return expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt > now
}
