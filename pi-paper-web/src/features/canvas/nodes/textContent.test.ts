import { describe, expect, it } from 'vitest'

import { textNodeContent } from './textContent'

describe('textNodeContent', () => {
  it('renders content created directly by the Agent when no generated output exists', () => {
    expect(textNodeContent(undefined, { content: '猫和老鼠' })).toBe('猫和老鼠')
  })

  it('prefers generated output over saved and draft content', () => {
    expect(textNodeContent('生成结果', { lastOutputText: '旧结果', content: '原文' })).toBe('生成结果')
  })
})
