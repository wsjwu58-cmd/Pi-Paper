const test = require('node:test')
const assert = require('node:assert/strict')
const { readAgentTaskAuthority } = require('../src/agent-task-authority.cjs')
const scope = { projectId: 'project', taskId: 'task' }

test('running task reads authority without attempting output or generation', async () => {
  const calls = []
  const core = { request: async (method, input) => { calls.push(method); assert.deepEqual(input, scope); return { taskId: 'task', status: 'running' } } }
  assert.equal((await readAgentTaskAuthority(core, scope)).status, 'running')
  assert.deepEqual(calls, ['task:get'])
})

test('success requires every media output to pass Local Core verification', async () => {
  const indices = []
  const core = { request: async (method, input) => {
    if (method === 'task:get') return { taskId: 'task', status: 'succeeded', modality: 'image', outputs: [{}, {}] }
    assert.equal(method, 'task:resolve-output-preview')
    assert.equal(input.projectId, scope.projectId)
    indices.push(input.outputIndex)
    if (input.outputIndex === 1) throw new Error('digest mismatch')
  } }
  const task = await readAgentTaskAuthority(core, scope)
  assert.equal(task.outputVerified, false)
  assert.equal(task.errorCode, 'TASK_OUTPUT_UNAVAILABLE')
  assert.deepEqual(indices, [0, 1])
})

test('text success uses the verified text reader without returning its content', async () => {
  const core = { request: async (method) => method === 'task:get'
    ? { taskId: 'task', status: 'succeeded', modality: 'text' } : 'private generated text' }
  const task = await readAgentTaskAuthority(core, scope)
  assert.equal(task.outputVerified, true)
  assert.equal(JSON.stringify(task).includes('private generated text'), false)
})

test('mismatching task identity is not published', async () => {
  const core = { request: async () => ({ taskId: 'other', status: 'succeeded' }) }
  assert.equal(await readAgentTaskAuthority(core, scope), null)
})
