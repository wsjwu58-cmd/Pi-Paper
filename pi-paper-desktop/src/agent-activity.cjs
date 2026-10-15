'use strict'

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function safeCount(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value.length
    if (Number.isSafeInteger(value) && value >= 0) return value
  }
  return undefined
}

function resultPayload(value) {
  const outer = record(value)
  return Object.hasOwn(outer, 'details') ? outer.details : value
}

function summarizeToolOperation(toolName, argsValue, resultValue) {
  const args = record(argsValue)
  const result = record(resultPayload(resultValue))
  const count = (...keys) => safeCount(...keys.flatMap((key) => [args[key], result[key]]))

  switch (toolName) {
    case 'get_canvas_summary': return '读取画布摘要'
    case 'get_selected_nodes': return `读取选中节点${count('nodeIds') === undefined ? '' : `（${count('nodeIds')} 个）`}`
    case 'get_node_detail': return '读取节点详情'
    case 'list_models': return '读取模型目录'
    case 'search_assets': return '搜索素材'
    case 'check_task_status': return '查询生成任务状态'
    case 'request_render_audit': return '执行渲染审校'
    case 'create_nodes': return `创建节点${count('nodes', 'createdNodes') === undefined ? '' : `（${count('nodes', 'createdNodes')} 个）`}`
    case 'connect_nodes': return `连接节点${count('nodeIds', 'edges') === undefined ? '' : `（${count('nodeIds', 'edges')} 个）`}`
    case 'layout_nodes': return `整理节点布局${count('nodeIds') === undefined ? '' : `（${count('nodeIds')} 个）`}`
    case 'update_node_config': return '更新节点配置'
    case 'submit_generation': return '准备生成任务'
    case 'submit_generation_batch': return `准备批量生成${count('generations', 'tasks') === undefined ? '' : `（${count('generations', 'tasks')} 项）`}`
    case 'load_skill': return '加载 Skill'
    default: return '执行本地操作'
  }
}

function summarizeAgentToolActivity(toolName, phase, args, result, ok, errorCode) {
  const operation = summarizeToolOperation(toolName, args, result)
  const code = typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,47}$/u.test(errorCode)
    ? `（${errorCode}）`
    : ''

  if (phase === 'started') return { summary: `正在${operation}` }
  if (phase === 'retry') return { summary: '正在重试此操作' }
  if (phase === 'completed' && ok === false) {
    return { summary: `操作未完成${code}` }
  }
  return { summary: `已${operation}` }
}

function summarizeAgentToolRetry(detailsValue) {
  const details = record(detailsValue)
  return {
    attempt: Number.isSafeInteger(details.attempt) && details.attempt > 0 ? details.attempt : undefined,
    maxAttempts: Number.isSafeInteger(details.maxAttempts) && details.maxAttempts > 0 ? details.maxAttempts : undefined,
    summary: '工具正在重试',
  }
}

module.exports = { summarizeAgentToolActivity, summarizeAgentToolRetry }
