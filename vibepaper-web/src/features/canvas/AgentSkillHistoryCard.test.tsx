import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentSkillHistoryCard } from './AgentSkillHistoryCard'

describe('AgentSkillHistoryCard', () => {
  it('renders the selected Skill name in historical user messages', () => {
    const html = renderToStaticMarkup(
      <AgentSkillHistoryCard
        skillId="project-skill-1"
        skills={[{ id: 'project-skill-1', name: '短剧分镜协作' }]}
      />,
    )

    expect(html).toContain('本轮使用的 Skill：短剧分镜协作')
    expect(html).toContain('短剧分镜协作')
    expect(html).not.toContain('project-skill-1')
  })

  it('does not reveal an internal id if a historical Skill is no longer available', () => {
    const html = renderToStaticMarkup(
      <AgentSkillHistoryCard skillId="deleted-skill-id" skills={[]} />,
    )

    expect(html).toContain('已使用的 Skill（当前不可用）')
    expect(html).not.toContain('deleted-skill-id')
  })

  it('renders nothing when the message did not select a Skill', () => {
    expect(renderToStaticMarkup(<AgentSkillHistoryCard skills={[]} />)).toBe('')
  })
})
