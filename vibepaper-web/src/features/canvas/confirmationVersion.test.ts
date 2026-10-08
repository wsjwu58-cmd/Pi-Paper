import { describe, expect, it } from 'vitest'

import {
  resolveAgentCanvasVersion,
  resolveBoundConfirmationCanvasVersion,
  resolveConfirmationCanvasVersion,
} from './confirmationVersion'

describe('resolveAgentCanvasVersion', () => {
  it('prefers the authoritative canvas version before sending a new Agent turn', () => {
    expect(resolveAgentCanvasVersion({ canvas: { version: 11 } }, 10)).toBe(11)
  })
})

describe('resolveConfirmationCanvasVersion', () => {
  it('prefers the freshly fetched canvas version over stale local state', () => {
    expect(resolveConfirmationCanvasVersion({ canvas: { version: 8 } }, 5)).toBe(8)
  })

  it('rejects a missing version instead of submitting an unbound confirmation', () => {
    expect(() => resolveConfirmationCanvasVersion({}, undefined)).toThrow('画布版本')
  })
})

describe('resolveBoundConfirmationCanvasVersion', () => {
  it('uses the approval-bound version without an extra blocking Canvas request', () => {
    expect(resolveBoundConfirmationCanvasVersion(8)).toBe(8)
  })

  it('rejects malformed approval metadata', () => {
    expect(() => resolveBoundConfirmationCanvasVersion('8')).toThrow('画布版本')
  })
})
