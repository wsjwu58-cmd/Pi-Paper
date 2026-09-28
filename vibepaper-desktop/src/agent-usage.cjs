function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function addUsage(target, usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return 0
  target.input += count(usage.input)
  target.output += count(usage.output)
  target.cacheRead += count(usage.cacheRead)
  target.cacheWrite += count(usage.cacheWrite)
  return count(usage.input) + count(usage.output) + count(usage.cacheRead) + count(usage.cacheWrite)
}

function buildAgentUsage(entries, sessionId) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const summaryTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const toolResultTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const modelUsage = Object.create(null)
  const modelCalls = Object.create(null)
  const seenEntryIds = new Set()
  let modelCallCount = 0
  let summaryCallCount = 0
  let toolCallCount = 0

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (typeof entry.id === 'string') {
      if (seenEntryIds.has(entry.id)) continue
      seenEntryIds.add(entry.id)
    }

    if (entry.type === 'message' && entry.message && typeof entry.message === 'object') {
      const message = entry.message
      if (message.role === 'assistant') {
        const provider = typeof message.provider === 'string' ? message.provider.trim() : ''
        const model = typeof message.responseModel === 'string' && message.responseModel.trim()
          ? message.responseModel.trim()
          : typeof message.model === 'string' ? message.model.trim() : ''
        const modelKey = provider && model ? `${provider}/${model}` : model || provider
        if (modelKey) {
          modelCallCount += 1
          modelCalls[modelKey] = (modelCalls[modelKey] ?? 0) + 1
          const tokens = addUsage(totals, message.usage)
          modelUsage[modelKey] = (modelUsage[modelKey] ?? 0) + tokens
        }
        if (Array.isArray(message.content)) {
          toolCallCount += message.content.filter((part) => part?.type === 'toolCall').length
        }
      } else if (message.role === 'toolResult' && message.usage) {
        // Pi persists usage attached to tool results separately from assistant messages.
        // Preserve it in the total without attributing it to a model that was not recorded.
        addUsage(totals, message.usage)
        addUsage(toolResultTotals, message.usage)
      }
      continue
    }

    if ((entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) {
      addUsage(totals, entry.usage)
      addUsage(summaryTotals, entry.usage)
      summaryCallCount += 1
      modelCallCount += 1
    }
  }

  const tokenTotal = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
  const summaryTokens = summaryTotals.input + summaryTotals.output + summaryTotals.cacheRead + summaryTotals.cacheWrite
  const toolResultTokens = toolResultTotals.input + toolResultTotals.output + toolResultTotals.cacheRead + toolResultTotals.cacheWrite
  return {
    sessionId,
    tokenTotal,
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    summaryTokens,
    toolResultTokens,
    modelCallCount,
    summaryCallCount,
    toolCallCount,
    modelUsage: Object.fromEntries(Object.entries(modelUsage).sort(([left], [right]) => left.localeCompare(right))),
    modelCalls: Object.fromEntries(Object.entries(modelCalls).sort(([left], [right]) => left.localeCompare(right))),
  }
}

module.exports = { buildAgentUsage }
