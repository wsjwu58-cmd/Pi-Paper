const MAX_CONTEXT_CHARS = 8_000
const MAX_NODE_COUNT = 80
const MAX_EDGE_COUNT = 160
const MAX_LABEL_CHARS = 500

function cleanText(value, maxLength = MAX_LABEL_CHARS) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength)
}

function nodeLabel(node) {
  const data = node?.data && typeof node.data === 'object' ? node.data : {}
  const type = cleanText(node?.type, 32) || '未知类型'
  const typeLabel = ({ text: '文本', image: '图片', video: '视频' })[type] || type
  const rawLabel = type === 'text' ? data.label : data.name
  const label = cleanText(rawLabel)
  const omitted = typeof rawLabel === 'string' && rawLabel.length > MAX_LABEL_CHARS
  if (type === 'text') return `文本正文：${label || '（空）'}${omitted ? '…（正文已截断）' : ''}`
  return `${typeLabel}名称：${label || '（未命名）'}`
}

function buildAgentCanvasContext(canvas) {
  const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : []
  const edges = Array.isArray(canvas?.edges) ? canvas.edges : []
  const aliases = new Map(nodes.map((node, index) => [node?.id, `节点 ${index + 1}`]))
  const includedNodeIds = new Set()
  const header = `当前画布只读摘要：共 ${nodes.length} 个节点、${edges.length} 条连线。`
  const lines = [header]
  let used = header.length
  let includedNodes = 0

  for (const [index, node] of nodes.entries()) {
    if (includedNodes >= MAX_NODE_COUNT) break
    const alias = `节点 ${index + 1}`
    const type = cleanText(node?.type, 32) || '未知类型'
    const typeLabel = ({ text: '文本', image: '图片', video: '视频' })[type] || type
    const line = `- ${alias}（${typeLabel}）：${nodeLabel(node)}`
    if (used + line.length + 160 > MAX_CONTEXT_CHARS) break
    lines.push(line)
    used += line.length + 1
    includedNodes += 1
    includedNodeIds.add(node.id)
  }

  const remainingEdges = edges.filter((edge) => includedNodeIds.has(edge?.source) && includedNodeIds.has(edge?.target))
  let includedEdges = 0
  if (remainingEdges.length && used + 1_000 < MAX_CONTEXT_CHARS) {
    lines.push('连线关系：')
    used += 6
    for (const edge of remainingEdges) {
      if (includedEdges >= MAX_EDGE_COUNT) break
      const line = `- ${aliases.get(edge.source)} → ${aliases.get(edge.target)}`
      if (used + line.length + 120 > MAX_CONTEXT_CHARS) break
      lines.push(line)
      used += line.length + 1
      includedEdges += 1
    }
  }

  const omittedNodes = nodes.length - includedNodes
  const omittedEdges = edges.length - includedEdges
  if (omittedNodes > 0 || omittedEdges > 0) {
    lines.push(`摘要已限长，未发送 ${omittedNodes} 个节点及 ${omittedEdges} 条连线。`)
  }
  return lines.join('\n')
}

module.exports = { buildAgentCanvasContext }
