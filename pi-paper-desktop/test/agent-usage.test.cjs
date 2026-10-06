const assert = require('node:assert/strict')
const test = require('node:test')
const { buildAgentUsage } = require('../src/agent-usage.cjs')

test('summary receipts count every chunk exactly once and attribute the real model', () => {
  const receipt = { id: 'receipt-1', type: 'custom', customType: 'vibepaper_summary_usage',
    data: { provider: 'agnes', model: 'agnes-2.5-flash', usage: { input: 70, output: 10, cacheRead: 3, cacheWrite: 0 } } }
  const usage = buildAgentUsage([receipt, receipt, { ...receipt, id: 'receipt-2' }], 'summary')
  assert.equal(usage.summaryCallCount, 2)
  assert.equal(usage.modelCallCount, 2)
  assert.equal(usage.summaryTokens, 166)
  assert.deepEqual(usage.modelUsage, { 'agnes/agnes-2.5-flash': 166 })
})

test('agent usage aggregates persisted Pi token fields and ignores duplicate entry IDs', () => {
  const entries = [
    {
      id: 'assistant-1',
      type: 'message',
      message: {
        role: 'assistant', provider: 'agnes', responseModel: 'agnes-2.5-flash',
        usage: { input: 100, output: 20, cacheRead: 7, cacheWrite: 3 },
        content: [{ type: 'text', text: 'ok' }, { type: 'toolCall' }, { type: 'toolCall' }],
      },
    },
    {
      id: 'assistant-1',
      type: 'message',
      message: { role: 'assistant', provider: 'wrong', model: 'duplicate', usage: { input: 999 } },
    },
    {
      id: 'assistant-2',
      type: 'message',
      message: {
        role: 'assistant', provider: 'local', model: 'qwen-local',
        usage: { input: 11, output: 5, cacheRead: 0, cacheWrite: 0 },
        content: [{ type: 'text', text: 'done' }],
      },
    },
    {
      id: 'tool-result-1',
      type: 'message',
      message: { role: 'toolResult', usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } },
    },
    {
      id: 'summary-1',
      type: 'compaction',
      usage: { input: 13, output: 4, cacheRead: 1, cacheWrite: 0 },
    },
  ]

  const usage = buildAgentUsage(entries, 'session-1')
  assert.deepEqual(usage, {
    sessionId: 'session-1',
    tokenTotal: 169,
    inputTokens: 126,
    outputTokens: 32,
    cacheReadTokens: 8,
    cacheWriteTokens: 3,
    summaryTokens: 18,
    toolResultTokens: 5,
    modelCallCount: 3,
    summaryCallCount: 1,
    toolCallCount: 2,
    modelUsage: { 'agnes/agnes-2.5-flash': 130, 'local/qwen-local': 16 },
    modelCalls: { 'agnes/agnes-2.5-flash': 1, 'local/qwen-local': 1 },
  })
  assert.equal(Object.hasOwn(usage, 'pointsUsed'), false)
  assert.equal(Object.hasOwn(usage, 'cost'), false)
})

test('agent usage returns actual zero usage when no persisted entries contain model tokens', () => {
  const usage = buildAgentUsage([{ id: 'user-1', type: 'message', message: { role: 'user', content: [] } }], 'empty')
  assert.equal(usage.tokenTotal, 0)
  assert.equal(usage.modelCallCount, 0)
  assert.deepEqual(usage.modelUsage, {})
})

test('agent usage excludes model identity and tokens from imported transcript entries', () => {
  const usage = buildAgentUsage([
    {
      id: 'fragment-assistant-1',
      type: 'message',
      message: {
        role: 'assistant', provider: 'agnes', model: 'historical-model',
        usage: { input: 80, output: 20, cacheRead: 4, cacheWrite: 2 },
        content: [{ type: 'text', text: 'copied text' }, { type: 'toolCall' }],
      },
    },
    {
      id: 'fragment-import-marker-1',
      type: 'custom',
      customType: 'vibepaper_fragment_import',
      data: { messageId: 'fragment-assistant-1' },
    },
  ], 'imported-session')

  assert.equal(usage.tokenTotal, 0)
  assert.equal(usage.modelCallCount, 0)
  assert.equal(usage.toolCallCount, 0)
  assert.deepEqual(usage.modelUsage, {})
  assert.deepEqual(usage.modelCalls, {})
})
