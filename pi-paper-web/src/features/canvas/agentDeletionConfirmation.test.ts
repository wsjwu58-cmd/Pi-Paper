import { describe, expect, it } from 'vitest'
import { reduceAgentEvent, restoreDesktopAgentEventState, type AgentEventEnvelope, type AgentEventState } from './agentEventEnvelope'

const confirmation: AgentEventEnvelope = {
  eventId: 'delete-confirm', runId: 'delete-run', sessionId: 'session-1', eventSeq: 1,
  type: 'confirmation_required', runtime: 'pi', runtimeVersion: 'desktop',
  data: { kind: 'canvas_delete', actionId: 'delete-action', approvalToken: 'token', tool: 'delete_nodes',
    nodeCount: 2, nodeLabels: ['角色参考', '关键帧'], connectedEdgeCount: 3, downstreamNodeCount: 1,
    affectedGroupCount: 1, affectedStackCount: 0, canvasVersion: 8 },
}
function empty(): AgentEventState {
  return { messages: [], seenEventIds: new Set(), runStatus: 'running', messageIdByRun: new Map(), persistedAssistantRunIds: new Set() }
}
describe('desktop deletion preview on the original Agent confirmation timeline', () => {
  it('preserves deletion type, labels and impact counts', () => {
    const state = reduceAgentEvent(empty(), confirmation)
    expect(state.messages[0].meta?.confirmation).toMatchObject({
      kind: 'canvas_delete', affectedNodeCount: 2, nodeLabels: ['角色参考', '关键帧'],
      connectedEdgeCount: 3, downstreamNodeCount: 1, affectedGroupCount: 1, affectedStackCount: 0,
    })
    expect(state.messages[0].meta?.requiresConfirmation).toBe(true)
    expect(reduceAgentEvent(state, confirmation).messages).toHaveLength(1)
  })
  it('restores one confirmation and clears it after accepted completion', () => {
    const completed: AgentEventEnvelope = { ...confirmation, eventId: 'delete-completed', eventSeq: 2,
      type: 'run_completed', data: { actionId: 'delete-action', actionStatus: 'accepted', text: '已删除两个节点。' } }
    const state = restoreDesktopAgentEventState([], [confirmation, completed])
    expect(state.messages.some((message) => message.meta?.requiresConfirmation)).toBe(false)
    expect(state.runStatus).toBe('completed')
  })
})
