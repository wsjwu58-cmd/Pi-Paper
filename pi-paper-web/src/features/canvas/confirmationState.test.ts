import { describe, expect, it } from 'vitest'
import { isActionableConfirmation, normalizeConfirmationExpiry } from './confirmationState'

describe('isActionableConfirmation', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z')

  it('keeps only an unexpired pending confirmation actionable', () => {
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '生成', status: 'pending', expiresAt: '2026-09-22T12:01:00.000Z' }, now)).toBe(true)
  })

  it('accepts the millisecond and second timestamps emitted by the agent service', () => {
    const expiresAt = Date.parse('2026-09-22T12:01:00.000Z')
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '生成', status: 'pending', expiresAt }, now)).toBe(true)
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '生成', status: 'pending', expiresAt: expiresAt / 1000 }, now)).toBe(true)
    expect(normalizeConfirmationExpiry(expiresAt)).toBe('2026-09-22T12:01:00.000Z')
    expect(normalizeConfirmationExpiry(String(expiresAt))).toBe('2026-09-22T12:01:00.000Z')
  })

  it('hides expired, terminal, and legacy confirmations restored from history', () => {
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '生成', status: 'pending', expiresAt: '2026-09-22T11:59:00.000Z' }, now)).toBe(false)
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '生成', status: 'accepted', expiresAt: '2026-09-22T12:01:00.000Z' }, now)).toBe(false)
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '旧生成', status: 'pending' }, now)).toBe(false)
  })
})
