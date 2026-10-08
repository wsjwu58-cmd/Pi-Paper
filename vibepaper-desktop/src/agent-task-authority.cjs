// Verify results through Local Core's scoped, digest-checked readers. Never
// trust a stored output path alone when reporting generation success to Agent.
async function readAgentTaskAuthority(localCore, input) {
  const task = await localCore.request('task:get', input, 15_000)
  if (!task || task.taskId !== input.taskId) return null
  if (task.status !== 'succeeded') return task
  try {
    if (task.modality === 'text') {
      await localCore.request('task:read-output', input, 15_000)
    } else {
      const count = Array.isArray(task.outputs) && task.outputs.length ? task.outputs.length : 1
      for (let outputIndex = 0; outputIndex < count; outputIndex += 1) {
        await localCore.request('task:resolve-output-preview', { ...input, outputIndex }, 15_000)
      }
    }
    return { ...task, outputVerified: true }
  } catch {
    return { ...task, outputVerified: false, errorCode: 'TASK_OUTPUT_UNAVAILABLE',
      errorMessage: '生成任务已结束，但本地结果无法读取或校验失败。' }
  }
}

module.exports = { readAgentTaskAuthority }
