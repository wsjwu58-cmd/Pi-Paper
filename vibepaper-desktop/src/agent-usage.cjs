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
  const importedTranscriptMessageIds = new Set(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry?.type === 'custom' && entry.customType === 'vibepaper_fragment_import')
      .map((entry) => entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
        && typeof entry.data.messageId === 'string' ? entry.data.messageId : null)
      .filter(Boolean),
  )
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
        if (!importedTranscriptMessageIds.has(entry.id)) {
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
        }
      } else if (message.role === 'toolResult' && message.usage) {
        // Pi persists usage attached to tool results separately from assistant messages.
        // Preserve it in the total without attributing it to a model that was not recorded.
        addUsage(totals, message.usage)
        addUsage(toolResultTotals, message.usage)
      }
      continue
    }

    const summaryReceipt = entry.type === 'custom' && entry.customType === 'vibepaper_summary_usage'
      ? entry.data : null
    const summaryUsage = summaryReceipt?.usage ??
      ((entry.type === 'compaction' || entry.type === 'branch_summary') ? entry.usage : null)
    if (summaryUsage) {
      const tokens = addUsage(totals, summaryUsage)
      addUsage(summaryTotals, summaryUsage)
      summaryCallCount += 1
      modelCallCount += 1
      if (summaryReceipt && typeof summaryReceipt.provider === 'string' && typeof summaryReceipt.model === 'string') {
        const key = `${summaryReceipt.provider}/${summaryReceipt.model}`
        modelCalls[key] = (modelCalls[key] ?? 0) + 1
        modelUsage[key] = (modelUsage[key] ?? 0) + tokens
      }
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
