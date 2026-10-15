import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentNodeReferenceCards } from './AgentNodeReferenceCards'

describe('AgentNodeReferenceCards', () => {
  it('renders image and text references above a user message', () => {
    const html = renderToStaticMarkup(
      <AgentNodeReferenceCards
        references={[
          {
            nodeId: '12',
            nodeType: 'image',
            title: '橘猫角色卡',
            status: 'ready',
            previewUrl: '/outputs/file/cat.png',
          },
          {
            nodeId: '11',
            nodeType: 'text',
            title: '分镜表：第 1 集',
            status: 'ready',
            textContent: '第一镜：雨夜',
          },
        ]}
      />,
    )

    expect(html).toContain('橘猫角色卡')
    expect(html).toContain('ready')
    expect(html).toContain('/outputs/file/cat.png')
    expect(html).toContain('分镜表：第 1 集')
    expect(html).toContain('TXT')
  })
})
