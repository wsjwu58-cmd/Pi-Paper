import { describe, expect, it } from 'vitest'

import { parseJsonPreserveIds } from './ids'

describe('parseJsonPreserveIds', () => {
  it('preserves an unsafe integer JSON literal as a string', () => {
    const parsed = parseJsonPreserveIds<{ id: string; count: number }>(
      '{"id":226248678346723328,"count":3}',
    )

    expect(parsed).toEqual({ id: '226248678346723328', count: 3 })
  })

  it('does not rewrite long digits inside quoted Agent event content', () => {
    const payload = JSON.stringify({
      eventId: 'evt-1',
      data: {
        raw: 'Skill output keeps 226248678346723328 exactly as written, even beside JSON-like {"id": 226248678346723328}.',
      },
    })

    const parsed = parseJsonPreserveIds<{ data: { raw: string } }>(payload)

    expect(parsed.data.raw).toContain('"id": 226248678346723328')
  })

  it('leaves decimal and exponent number literals as numbers', () => {
    const parsed = parseJsonPreserveIds<{ decimal: number; exponent: number }>(
      '{"decimal":1234567890123456.5,"exponent":1234567890123456e2}',
    )

    expect(typeof parsed.decimal).toBe('number')
    expect(typeof parsed.exponent).toBe('number')
  })

  it('keeps long fractional canvas coordinates intact', () => {
    const parsed = parseJsonPreserveIds<{ node: { id: string; x: number; y: number } }>(
      '{"node":{"id":227301055640244224,"x":570.398866556266,"y":-0.2751493544461425}}',
    )

    expect(parsed).toEqual({
      node: { id: '227301055640244224', x: 570.398866556266, y: -0.2751493544461425 },
    })
  })
})
