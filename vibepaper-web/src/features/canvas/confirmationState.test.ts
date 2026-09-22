import { describe, expect, it } from 'vitest'
import { isActionableConfirmation } from './confirmationState'

describe('isActionableConfirmation', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z')

  it('keeps only an unexpired pending confirmation actionable', () => {
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '生成', status: 'pending', expiresAt: '2026-09-22T12:01:00.000Z' }, now)).toBe(true)
  })

  it('hides expired, terminal, and legacy confirmations restored from history', () => {
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '生成', status: 'pending', expiresAt: '2026-09-22T11:59:00.000Z' }, now)).toBe(false)
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '生成', status: 'accepted', expiresAt: '2026-09-22T12:01:00.000Z' }, now)).toBe(false)
    expect(isActionableConfirmation({ actionId: 'a', approvalToken: 't', summary: '旧生成', status: 'pending' }, now)).toBe(false)
  })
})
