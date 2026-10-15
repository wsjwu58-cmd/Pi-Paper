'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { summarizeAgentToolActivity, summarizeAgentToolRetry } = require('../src/agent-activity.cjs')

test('Agent tool timeline stores bounded summaries instead of prompt, media, or internal IDs', () => {
  const args = {
    nodes: [{ type: 'text', params: { prompt: 'private screenplay text' } }],
    nodeId: 'node_private_123',
    canvasId: 'canvas_private_456',
  }
  const result = {
    details: {
      createdNodes: [{ id: 'node_private_789', content: 'private generated content' }],
      assetUrl: 'vibe://app/assets/private',
    },
    content: [{ text: 'private tool response' }],
  }

  const started = summarizeAgentToolActivity('create_nodes', 'started', args)
  const completed = summarizeAgentToolActivity('create_nodes', 'completed', undefined, result, true)
  const persisted = JSON.stringify({ started, completed })

  assert.deepEqual(started, { summary: '正在创建节点（1 个）' })
  assert.deepEqual(completed, { summary: '已创建节点（1 个）' })
  assert.doesNotMatch(persisted, /private screenplay|private generated|node_private|canvas_private|vibe:\/\//u)
})

test('Agent tool activity handles status-only calls and safe error codes', () => {
  assert.deepEqual(
    summarizeAgentToolActivity('submit_generation_batch', 'completed', undefined, { generations: [{ nodeId: 'secret' }] }, false, 'VERSION_CONFLICT'),
    { summary: '操作未完成（VERSION_CONFLICT）' },
  )
  assert.deepEqual(
    summarizeAgentToolActivity('get_canvas_summary', 'completed', undefined, {}, true),
    { summary: '已读取画布摘要' },
  )
})

test('Agent retry timeline retains attempt counts without the original event payload', () => {
  assert.deepEqual(summarizeAgentToolRetry({ retrying: true, attempt: 2, maxAttempts: 3, prompt: 'secret' }), {
    attempt: 2,
    maxAttempts: 3,
    summary: '工具正在重试',
  })
})
