import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentMarkdown } from './AgentMarkdown'

describe('AgentMarkdown', () => {
  it('renders common Markdown blocks and inline formatting safely', () => {
    const fence = String.fromCharCode(96).repeat(3)
    const tick = String.fromCharCode(96)
    const markdown = [
      '# Document title',
      '###### Small heading',
      'Text with **bold**, *italic*, ~~removed~~, and ' + tick + 'code' + tick + '.',
      '- first item',
      '- second item',
      '1. ordered item',
      '| left | centered | right |',
      '| :--- | :---: | ---: |',
      '| A | B | C |',
      '> quoted **text**',
      fence + 'html',
      '<img src=x onerror=alert(1)>',
      fence,
      '<script>alert(1)</script>',
    ].join('\n')

    const html = renderToStaticMarkup(<AgentMarkdown text={markdown} />)

    expect(html).toContain('<h1')
    expect(html).toContain('<h1 class="text-[15px] font-bold text-[#111]">')
    expect(html).toContain('<h6')
    expect(html).toContain('<strong')
    expect(html).toContain('<em')
    expect(html).toContain('<del')
    expect(html).toContain('>code</code>')
    expect(html).toContain('<ul')
    expect(html).toContain('<ol')
    expect(html).toContain('<table')
    expect(html).toContain('text-align:center')
    expect(html).toContain('<blockquote')
    expect(html).toContain('<pre')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')

    const readerHtml = renderToStaticMarkup(<AgentMarkdown text="# Document title" variant="document" />)
    expect(readerHtml).toContain('<h1 class="text-[22px] font-bold leading-snug text-[#111]">')
  })

  it('keeps the full body in the rendered tree without a line clamp', () => {
    const text = Array.from({ length: 80 }, (_, index) => 'paragraph-' + index).join('\n\n')
    const html = renderToStaticMarkup(<AgentMarkdown text={text} />)

    expect(html).toContain('paragraph-79')
    expect(html.match(/<p\b/g)).toHaveLength(80)
    expect(html).not.toContain('line-clamp')
  })
})
