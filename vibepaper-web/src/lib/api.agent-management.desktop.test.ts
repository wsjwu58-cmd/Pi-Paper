import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@/desktop/desktop-bridge'

let api: typeof import('./api').api
const project = { projectId: 'project-1', canvasId: 'canvas-1', name: '本地项目' }
const methods = ['listAgentSessions', 'getAgentSession', 'updateAgentSession', 'deleteAgentSession', 'copyAgentSession', 'setAgentSessionSkills', 'attachAgentSessionSkill', 'createAgentPlan', 'getAgentPlan', 'getAgentPlanReadySet', 'rerunAgentPlan'] as const
let bridge: Record<string, ReturnType<typeof vi.fn>>

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  ;({ api } = await import('./api'))
})
beforeEach(() => {
  bridge = { getActiveProject: vi.fn(async () => project) }
  for (const name of methods) bridge[name] = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal('window', { vibepaperDesktop: bridge as unknown as DesktopBridge, location: { protocol: 'vibe:' } })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
})

describe('original Agent management API over the desktop bridge', () => {
  it('routes session lifecycle and skill snapshots without HTTP', async () => {
    await api('/agent/sessions?status=archived')
    expect(bridge.listAgentSessions).toHaveBeenCalledWith('project-1', { status: 'archived' })
    await api('/agent/sessions/session-1', { method: 'PATCH', body: JSON.stringify({ title: '短剧', status: 'archived' }) })
    expect(bridge.updateAgentSession).toHaveBeenCalledWith('project-1', 'session-1', { title: '短剧', status: 'archived' })
    await api('/agent/sessions/session-1/copy', { method: 'POST', body: '{}' })
    expect(bridge.copyAgentSession).toHaveBeenCalledWith('project-1', 'session-1', {})
    await api('/agent/sessions/session-1/skills', { method: 'PUT', body: JSON.stringify({ skillIds: ['skill-1'] }) })
    expect(bridge.setAgentSessionSkills).toHaveBeenCalledWith('project-1', 'session-1', ['skill-1'])
    await api('/agent/sessions/session-1/skills/skill-1:attach', { method: 'POST', body: '{}' })
    expect(bridge.attachAgentSessionSkill).toHaveBeenCalledWith('project-1', 'session-1', 'skill-1')
    await api('/agent/sessions/session-1', { method: 'DELETE' })
    expect(bridge.deleteAgentSession).toHaveBeenCalledWith('project-1', 'session-1')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('routes all four persistent plan endpoints', async () => {
    const input = { plan: { id: 'plan-1', steps: [] }, profile: 'canvas-general' }
    await api('/agent/sessions/session-1/plans', { method: 'POST', body: JSON.stringify(input) })
    expect(bridge.createAgentPlan).toHaveBeenCalledWith('project-1', 'session-1', input)
    await api('/agent/plans/plan-1')
    expect(bridge.getAgentPlan).toHaveBeenCalledWith('project-1', 'plan-1')
    await api('/agent/plans/plan-1/ready-set?profile=audit-readonly')
    expect(bridge.getAgentPlanReadySet).toHaveBeenCalledWith('project-1', 'plan-1', 'audit-readonly')
    await api('/agent/plans/plan-1/rerun', { method: 'POST', body: JSON.stringify({ stepId: 'step-1' }) })
    expect(bridge.rerunAgentPlan).toHaveBeenCalledWith('project-1', 'plan-1', 'step-1')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects invalid identifiers, bodies, methods and missing projects', async () => {
    await expect(api('/agent/plans/%2F')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(api('/agent/plans/p/rerun', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(api('/agent/sessions/s/skills', { method: 'PUT', body: '{"skillIds":[1]}' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(api('/agent/plans/p', { method: 'DELETE' })).rejects.toMatchObject({ code: 'METHOD_NOT_ALLOWED' })
    bridge.getActiveProject.mockResolvedValue(null)
    await expect(api('/agent/sessions')).rejects.toMatchObject({ code: 'PROJECT_REQUIRED' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
