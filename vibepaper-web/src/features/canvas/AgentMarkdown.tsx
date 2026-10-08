import { Fragment, useEffect, type ReactNode } from 'react'
import { useTypewriter } from './useTypewriter'
import { cn } from '@/lib/cn'

/** Markdown subset used by agent replies and text nodes. Raw HTML stays text. */
export function AgentMarkdown({ text, className, compact = false, variant = 'message' }: { text: string; className?: string; compact?: boolean; variant?: 'message' | 'document' }) {
  if (!text) return null
  const blocks = parseBlocks(text)
  return (
    <div className={cn('space-y-2.5 text-[15px] leading-[1.7] text-[#222]', className)}>
      {blocks.map((b, i) => <Fragment key={i}>{renderBlock(b, compact, variant)}</Fragment>)}
    </div>
  )
}

export function StreamingAgentReply({
  text,
  animate,
  streamComplete,
  className,
  onRevealDone,
}: {
  text: string
  animate?: boolean
  streamComplete?: boolean
  className?: string
  onRevealDone?: () => void
}) {
  const { text: shown, catchingUp, done } = useTypewriter(text, !!animate, 14)

  useEffect(() => {
    if (animate && streamComplete && done && !catchingUp) onRevealDone?.()
  }, [animate, streamComplete, done, catchingUp, onRevealDone])

  if (!text && !shown) return null
  return (
    <div className={cn('relative', className)}>
      <AgentMarkdown text={shown || (animate ? '' : text)} />
      {(animate || catchingUp) && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[14px] w-[7px] translate-y-[2px] animate-pulse rounded-[1px] bg-[#bbb]"
        />
      )}
    </div>
  )
}

type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'emoji-list'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][]; alignments: Array<'left' | 'center' | 'right' | null> }
  | { type: 'code'; language: string; text: string }
  | { type: 'quote'; text: string }
  | { type: 'p'; text: string }

const FENCE_START = /^ {0,3}(\x60{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.+?)\s*#*\s*|\s*)$/

function isTableSep(line: string): boolean {
  if (!line.includes('|')) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function readFence(line: string) {
  const match = FENCE_START.exec(line)
  if (!match) return null
  const info = match[2].trim()
  return { marker: match[1], info, language: info.split(/\s+/)[0] ?? '' }
}

function tableAlignment(cell: string): 'left' | 'center' | 'right' | null {
  const value = cell.trim()
  if (!/^:?-{3,}:?$/.test(value)) return null
  if (value.startsWith(':') && value.endsWith(':')) return 'center'
  if (value.endsWith(':')) return 'right'
  return value.startsWith(':') ? 'left' : null
}

function isQuoteLine(line: string): boolean {
  return /^ {0,3}>/.test(line)
}

function isPipeRow(line: string): boolean {
  if (!line.includes('|') || isTableSep(line)) return false
  return splitRow(line).length >= 2
}

function startsTable(lines: string[], i: number): boolean {
  if (!isPipeRow(lines[i]) || i + 1 >= lines.length) return false
  return isTableSep(lines[i + 1]) && splitRow(lines[i]).length === splitRow(lines[i + 1]).length
}

/** 📄 / 🎬 / 🖼️ 等开头的进度行 */
function isEmojiBullet(line: string): boolean {
  return /^\s*\p{Extended_Pictographic}/u.test(line)
}

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }

    const fence = readFence(line)
    if (fence) {
      const codeLines: string[] = []
      i += 1
      while (i < lines.length) {
        const closing = readFence(lines[i])
        if (closing && !closing.info && closing.marker[0] === fence.marker[0] && closing.marker.length >= fence.marker.length) {
          i += 1
          break
        }
        codeLines.push(lines[i])
        i += 1
      }
      blocks.push({ type: 'code', language: fence.language, text: codeLines.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
        text: (heading[2] ?? '').trim(),
      })
      i += 1
      continue
    }
    // **已就位** 单独成行当小标题
    const boldOnly = /^\*\*([^*]+)\*\*\s*$/.exec(line.trim())
    if (boldOnly && (boldOnly[1].includes('已就位') || boldOnly[1].includes('生成中') || boldOnly[1].length <= 24)) {
      blocks.push({ type: 'heading', level: 2, text: boldOnly[1] })
      i += 1
      continue
    }

    if (isQuoteLine(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && isQuoteLine(lines[i])) {
        quoteLines.push(lines[i].replace(/^ {0,3}> ?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n') })
      continue
    }

    if (startsTable(lines, i)) {
      const headers = splitRow(line)
      const alignments = splitRow(lines[i + 1]).map(tableAlignment)
      i += 1
      if (isTableSep(lines[i])) i += 1
      const rows: string[][] = []
      while (i < lines.length && isPipeRow(lines[i])) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      blocks.push({ type: 'table', headers, rows, alignments })
      continue
    }
    if (isEmojiBullet(line)) {
      const items: string[] = []
      while (i < lines.length && isEmojiBullet(lines[i])) {
        items.push(lines[i].trim())
        i += 1
      }
      blocks.push({ type: 'emoji-list', items })
      continue
    }
    const ul = /^\s*[-+*]\s+/.test(line)
    const ol = /^\s*\d+[.)]\s+/.test(line)
    if (ul || ol) {
      const items: string[] = []
      const re = ol ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-+*]\s+(.*)$/
      while (i < lines.length) {
        const m = re.exec(lines[i])
        if (!m) break
        items.push(m[1])
        i += 1
      }
      blocks.push({ type: 'list', ordered: ol, items })
      continue
    }
    const para: string[] = [line]
    i += 1
    while (
      i < lines.length &&
      lines[i].trim() &&
      !readFence(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !isQuoteLine(lines[i]) &&
      !/^\s*[-+*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !isEmojiBullet(lines[i]) &&
      !startsTable(lines, i)
    ) {
      para.push(lines[i])
      i += 1
    }
    blocks.push({ type: 'p', text: para.join('\n') })
  }
  return blocks
}

function splitRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let codeTicks = 0
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '\\' && line[i + 1] === '|') {
      cell += '|'
      i += 1
    } else if (char === '\x60') {
      let end = i + 1
      while (line[end] === '\x60') end += 1
      const count = end - i
      if (codeTicks === 0) codeTicks = count
      else if (codeTicks === count) codeTicks = 0
      cell += line.slice(i, end)
      i = end - 1
    } else if (char === '|' && codeTicks === 0) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }
  cells.push(cell.trim())
  if (line.trimStart().startsWith('|')) cells.shift()
  if (line.trimEnd().endsWith('|')) cells.pop()
  return cells
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1
  return slashes % 2 === 1
}

function findClosingDelimiter(text: string, delimiter: string, start: number): number {
  let index = text.indexOf(delimiter, start)
  while (index !== -1) {
    if (!isEscaped(text, index)) {
      const before = text[index - 1]
      const after = text[index + delimiter.length]
      if (!/\s/.test(before ?? '') && !/\s/.test(after ?? '')) return index
    }
    index = text.indexOf(delimiter, index + delimiter.length)
  }
  return -1
}

function isWordCharacter(char: string | undefined): boolean {
  return !!char && /[\p{L}\p{N}]/u.test(char)
}

function renderInline(line: string): ReactNode[] {
  const result: ReactNode[] = []
  const tick = String.fromCharCode(96)
  const escapable = tick + '*_{}[]()#+.!|>~-\\'
  let plain = ''
  let i = 0
  const flush = () => {
    if (!plain) return
    result.push(plain)
    plain = ''
  }

  while (i < line.length) {
    if (line[i] === '\\' && i + 1 < line.length && escapable.includes(line[i + 1])) {
      plain += line[i + 1]
      i += 2
      continue
    }

    if (line[i] === tick) {
      const close = line.indexOf(tick, i + 1)
      if (close > i + 1) {
        flush()
        result.push(<code key={result.length} className="mx-0.5 rounded-[5px] bg-[#f0f0f0] px-1.5 py-0.5 font-mono text-[13px] text-[#555]">{line.slice(i + 1, close)}</code>)
        i = close + 1
        continue
      }
    }

    let matched: { delimiter: string; close: number } | null = null
    for (const delimiter of ['~~', '**', '__', '*', '_']) {
      if (!line.startsWith(delimiter, i)) continue
      if ((delimiter === '*' || delimiter === '_') && line.startsWith(delimiter + delimiter, i)) continue
      if (/\s/.test(line[i + delimiter.length] ?? '')) continue
      if (delimiter === '_' && isWordCharacter(line[i - 1])) continue
      const close = findClosingDelimiter(line, delimiter, i + delimiter.length)
      if (close < 0 || (delimiter === '_' && isWordCharacter(line[close + delimiter.length]))) continue
      matched = { delimiter, close }
      break
    }

    if (matched) {
      flush()
      const content = renderInline(line.slice(i + matched.delimiter.length, matched.close))
      if (matched.delimiter === '~~') result.push(<del key={result.length} className="text-[#666]">{content}</del>)
      else if (matched.delimiter === '**' || matched.delimiter === '__') result.push(<strong key={result.length} className="font-semibold text-[#111]">{content}</strong>)
      else result.push(<em key={result.length}>{content}</em>)
      i = matched.close + matched.delimiter.length
      continue
    }

    plain += line[i]
    i += 1
  }

  flush()
  return result
}

function renderBlock(block: Block, compact: boolean, variant: 'message' | 'document'): ReactNode {
  if (block.type === 'heading') {
    const Tag = (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const)[block.level - 1]
    const headingClass = compact
      ? 'text-[12px]'
      : variant === 'message'
        ? 'text-[15px] font-bold text-[#111]'
      : block.level === 1
        ? 'text-[22px] font-bold leading-snug text-[#111]'
        : block.level === 2
          ? 'text-[19px] font-bold leading-snug text-[#111]'
          : block.level === 3
            ? 'text-[17px] font-bold leading-snug text-[#111]'
            : 'text-[15px] font-bold leading-snug text-[#111]'
    return <Tag className={headingClass}>{renderInline(block.text)}</Tag>
  }
  if (block.type === 'emoji-list') {
    return (
      <ul className={cn('space-y-1.5', compact && 'text-[12px]')}>
        {block.items.map((item, i) => (
          <li key={i} className={cn('leading-[1.7] text-[#222]', compact ? 'text-[12px]' : 'text-[15px]')}>
            {renderInline(item)}
          </li>
        ))}
      </ul>
    )
  }
  if (block.type === 'list') {
    const List = block.ordered ? 'ol' : 'ul'
    return (
      <List className={cn('ml-4 space-y-1.5', block.ordered ? 'list-decimal' : 'list-disc')}>
        {block.items.map((item, i) => (
          <li key={i} className={cn('leading-[1.7]', compact ? 'text-[12px]' : 'text-[15px]')}>
            {renderInline(item)}
          </li>
        ))}
      </List>
    )
  }
  if (block.type === 'table') {
    return (
      <div className="max-w-full overflow-x-auto rounded-[10px] border border-black/8">
        <table className={cn('w-full border-collapse text-left', compact ? 'text-[11px]' : 'text-[13px]')}>
          <thead>
            <tr className="bg-[#f4f4f5]">
              {block.headers.map((h, i) => (
                <th key={i} style={block.alignments[i] ? { textAlign: block.alignments[i]! } : undefined} className="border-b border-black/8 px-2.5 py-1.5 font-semibold text-[#444]">
                  {renderInline(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri} className="align-top">
                {block.headers.map((_, ci) => (
                  <td key={ci} style={block.alignments[ci] ? { textAlign: block.alignments[ci]! } : undefined} className="border-b border-black/5 px-2.5 py-1.5 text-[#555]">
                    {renderInline(row[ci] || '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  if (block.type === 'code') {
    return (
      <div className="max-w-full overflow-hidden rounded-[10px] border border-black/10 bg-[#f7f7f8]">
        {block.language && <div className="border-b border-black/5 px-3 py-1.5 font-mono text-[11px] text-[#777]">{block.language}</div>}
        <pre className={cn('max-w-full overflow-x-auto p-3 font-mono leading-[1.6] text-[#333]', compact ? 'text-[11px]' : 'text-[13px]')}><code>{block.text}</code></pre>
      </div>
    )
  }
  if (block.type === 'quote') {
    return (
      <blockquote className="border-l-[3px] border-[#d4d4d8] pl-4 text-[#555]">
        {parseBlocks(block.text).map((nested, i) => <Fragment key={i}>{renderBlock(nested, compact, variant)}</Fragment>)}
      </blockquote>
    )
  }
  return (
    <p className={cn('whitespace-pre-wrap', compact ? 'text-[12px] leading-[1.5]' : 'text-[15px] leading-[1.7]')}>
      {renderInline(block.text)}
    </p>
  )
}
