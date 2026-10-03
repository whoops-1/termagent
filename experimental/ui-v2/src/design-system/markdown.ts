import { clip, paint, padRight, stripAnsi, widthOf } from './ansi.js'
import type { ColorCapability, Theme, TextAttrs } from './types.js'
import { highlightLine } from './syntax.js'

export type MarkdownOptions = {
  width: number
  theme: Theme
  capability: ColorCapability
  maxCodeLines?: number
}

type Segment = {
  text: string
  fg?: string
  attrs?: TextAttrs
}

type TableBlock = {
  header: string[]
  align: Array<'left' | 'center' | 'right'>
  rows: string[][]
}

const fenceRe = /^\s*(```+|~~~+)\s*([^\s`~]+)?\s*$/
const orderedRe = /^(\s*)(\d+)[.)]\s+(.*)$/
const unorderedRe = /^(\s*)[-*+]\s+(.*)$/
const headingRe = /^(#{1,6})\s+(.*)$/

function splitTableRow(line: string) {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  let body = trimmed
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (const ch of body) {
    if (escaped) { current += ch; escaped = false; continue }
    if (ch === '\\') { escaped = true; current += ch; continue }
    if (ch === '|') { cells.push(current.trim()); current = ''; continue }
    current += ch
  }
  cells.push(current.trim())
  return cells.length >= 2 ? cells : null
}

function parseAlignCell(cell: string): 'left' | 'center' | 'right' {
  const text = cell.trim()
  const left = text.startsWith(':')
  const right = text.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  return 'left'
}

function isSeparatorRow(cells: string[]) {
  return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))
}

function parseTable(lines: string[], index: number): { table: TableBlock; next: number } | null {
  const header = splitTableRow(lines[index] ?? '')
  const separator = splitTableRow(lines[index + 1] ?? '')
  if (!header || !separator || !isSeparatorRow(separator) || header.length !== separator.length) return null
  const rows: string[][] = []
  let next = index + 2
  while (next < lines.length) {
    const row = splitTableRow(lines[next] ?? '')
    if (!row || row.length !== header.length) break
    rows.push(row)
    next++
  }
  return {
    table: { header, align: separator.map(parseAlignCell), rows },
    next,
  }
}

function inlineSegments(input: string, theme: Theme): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  const push = (text: string, fg?: string, attrs?: TextAttrs) => {
    if (!text) return
    segments.push({ text, fg, attrs })
  }

  // Scan left-to-right so formatting does not cascade through already parsed text.
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^\)]+\))/g
  for (const match of input.matchAll(re)) {
    const start = match.index ?? 0
    if (start > cursor) push(input.slice(cursor, start))
    const token = match[0]
    if (token.startsWith('**') || token.startsWith('__')) push(token.slice(2, -2), theme.text, { bold: true })
    else if (token.startsWith('`')) push(token.slice(1, -1), theme.markdownCode)
    else if (token.startsWith('*') || token.startsWith('_')) push(token.slice(1, -1), theme.markdownQuote, { italic: true })
    else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) push(link[1]!, theme.markdownLink, { underline: true })
      else push(token)
    }
    cursor = start + token.length
  }
  if (cursor < input.length) push(input.slice(cursor))
  return segments
}

function renderSegments(segments: Segment[], capability: ColorCapability) {
  return segments.map(segment => paint(segment.text, {
    fg: segment.fg,
    attrs: segment.attrs,
    capability,
  })).join('')
}

function wrapSegments(segments: Segment[], width: number, capability: ColorCapability): string[] {
  const safe = Math.max(10, width)
  const rows: string[] = []
  let current: Segment[] = []
  let used = 0

  const flush = () => {
    rows.push(renderSegments(current, capability).replace(/\s+$/, ''))
    current = []
    used = 0
  }

  for (const original of segments) {
    let pending = original.text
    while (pending.length) {
      const leading = current.length === 0 ? pending.match(/^\s+/)?.[0]?.length ?? 0 : 0
      if (leading === pending.length) { current.push({ ...original, text: pending }); used += widthOf(pending); break }
      if (leading && used === 0) { pending = pending.slice(leading); continue }

      const words = pending.split(/(\s+)/)
      let consumed = 0
      for (const part of words) {
        const partWidth = widthOf(stripAnsi(part))
        if (current.length && used + partWidth > safe) break
        if (!current.length && partWidth > safe) {
          let chunk = ''
          let chunkWidth = 0
          for (const ch of Array.from(part)) {
            const w = widthOf(ch)
            if (chunk && chunkWidth + w > safe) break
            chunk += ch
            chunkWidth += w
          }
          if (!chunk) break
          current.push({ ...original, text: chunk })
          used += chunkWidth
          consumed += chunk.length
          break
        }
        current.push({ ...original, text: part })
        used += partWidth
        consumed += part.length
      }

      if (consumed === 0) {
        if (current.length) flush()
        else {
          const ch = Array.from(pending)[0]
          if (!ch) break
          current.push({ ...original, text: ch })
          used += widthOf(ch)
          pending = pending.slice(ch.length)
        }
      } else {
        pending = pending.slice(consumed)
        if (pending && used >= safe) flush()
      }
    }
  }
  if (current.length) flush()
  return rows.length ? rows : ['']
}

function renderPlainParagraph(text: string, options: MarkdownOptions) {
  const segments = inlineSegments(text, options.theme)
  return wrapSegments(segments, options.width, options.capability)
}

function renderHeading(text: string, depth: number, options: MarkdownOptions) {
  const content = renderSegments(inlineSegments(text, options.theme), options.capability)
  const styled = paint(content, {
    fg: depth === 1 ? options.theme.primary : options.theme.markdownHeading,
    capability: options.capability,
    attrs: { bold: true },
  })
  const rows = [clip(styled, options.width)]
  if (depth === 1 && options.width >= 12) rows.push(paint('─'.repeat(Math.min(options.width, Math.max(8, widthOf(styled)))), { fg: options.theme.border, capability: options.capability }))
  return rows
}

function renderCodeBlock(codeLines: string[], language: string, options: MarkdownOptions) {
  const inner = Math.max(10, options.width - 4)
  const visibleLines = codeLines.slice(0, options.maxCodeLines ?? 160)
  const title = language || 'text'
  const topLead = `╭─ ${title} `
  const top = `${topLead}${'─'.repeat(Math.max(0, options.width - widthOf(topLead) - 1))}╮`
  const body = visibleLines.map((line, index) => {
    const highlighted = highlightLine(line, title, options.theme, options.capability)
    const gutter = paint(String(index + 1).padStart(3), { fg: options.theme.muted, capability: options.capability })
    const content = `│ ${gutter} ${clip(highlighted, Math.max(1, inner - 6))}`
    return padRight(content + paint('│', { fg: options.theme.border, capability: options.capability }), options.width)
  })
  if (visibleLines.length < codeLines.length) body.push(padRight(`│ ${paint('… truncated', { fg: options.theme.muted, capability: options.capability })}`, options.width))
  const bottom = `╰${'─'.repeat(Math.max(0, options.width - 2))}╯`
  return [
    paint(clip(top, options.width), { fg: options.theme.border, capability: options.capability }),
    ...body,
    paint(clip(bottom, options.width), { fg: options.theme.border, capability: options.capability }),
  ]
}

function padAligned(value: string, target: number, align: 'left' | 'center' | 'right') {
  const plainWidth = widthOf(stripAnsi(value))
  const padding = Math.max(0, target - plainWidth)
  if (align === 'right') return `${' '.repeat(padding)}${value}`
  if (align === 'center') {
    const left = Math.floor(padding / 2)
    return `${' '.repeat(left)}${value}${' '.repeat(padding - left)}`
  }
  return `${value}${' '.repeat(padding)}`
}

function renderTable(table: TableBlock, options: MarkdownOptions) {
  const parsedHeader = table.header.map(cell => inlineSegments(cell, options.theme))
  const parsedRows = table.rows.map(row => row.map(cell => inlineSegments(cell, options.theme)))
  const headerPlain = table.header.map(cell => stripAnsi(renderSegments(inlineSegments(cell, options.theme), options.capability)))
  const rowsPlain = table.rows.map(row => row.map(cell => stripAnsi(renderSegments(inlineSegments(cell, options.theme), options.capability))))
  const columns = table.header.length
  const minWidths = Array.from({ length: columns }, (_, i) => Math.max(3, widthOf(headerPlain[i] ?? ''), ...rowsPlain.map(row => widthOf(row[i] ?? ''))))
  const borderOverhead = columns * 3 + 1
  const available = Math.max(columns * 3, options.width - borderOverhead - 2)
  const total = minWidths.reduce((a, b) => a + b, 0)

  if (total > available || options.width < 44) {
    const out: string[] = []
    table.rows.forEach((row, rowIndex) => {
      if (rowIndex) out.push(paint('  ·  ', { fg: options.theme.border, capability: options.capability }))
      for (let i = 0; i < columns; i++) {
        const label = table.header[i] ?? `Column ${i + 1}`
        const value = stripAnsi(row[i] ?? '')
        const line = `${paint(`${label}:`, { fg: options.theme.markdownHeading, capability: options.capability, attrs: { bold: true } })} ${clip(value, Math.max(8, options.width - widthOf(label) - 4))}`
        out.push(line)
      }
    })
    return out.length ? out : ['']
  }

  const extra = available - total
  const widths = minWidths.map((value, i) => value + Math.floor(extra / columns) + (i < extra % columns ? 1 : 0))
  const border = (left: string, middle: string, right: string) => paint(`${left}${widths.map(width => '─'.repeat(width + 2)).join(middle)}${right}`, { fg: options.theme.border, capability: options.capability })
  const row = (cells: string[], alignments: Array<'left' | 'center' | 'right'>, header = false) => {
    const content = cells.map((cell, i) => padAligned(cell, widths[i]!, header ? 'center' : alignments[i] ?? 'left')).join(' │ ')
    return paint('│', { fg: options.theme.border, capability: options.capability }) + ` ${content} ` + paint('│', { fg: options.theme.border, capability: options.capability })
  }

  const out: string[] = [border('┌', '┬', '┐'), row(parsedHeader.map((cell, i) => renderSegments(cell, options.capability)), table.align, true), border('├', '┼', '┤')]
  parsedRows.forEach((cells, index) => {
    out.push(row(cells.map(cell => renderSegments(cell, options.capability)), table.align))
    if (index < parsedRows.length - 1) out.push(border('├', '┼', '┤'))
  })
  out.push(border('└', '┴', '┘'))
  return out.map(line => padRight(clip(line, options.width), options.width))
}

export function renderMarkdown(text: string, options: MarkdownOptions): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0

  const blank = () => { if (out.length && out[out.length - 1] !== '') out.push('') }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) { blank(); i++; continue }

    const fence = line.match(fenceRe)
    if (fence) {
      const marker = fence[1]!
      const language = fence[2] ?? 'text'
      const code: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i] ?? '')) {
        code.push(lines[i] ?? '')
        i++
      }
      if (i < lines.length) i++
      if (out.length) blank()
      out.push(...renderCodeBlock(code, language, options))
      continue
    }

    const table = parseTable(lines, i)
    if (table) {
      if (out.length) blank()
      out.push(...renderTable(table.table, options))
      i = table.next
      continue
    }

    const heading = line.match(headingRe)
    if (heading) {
      if (out.length) blank()
      out.push(...renderHeading(heading[2]!, heading[1]!.length, options))
      i++
      continue
    }

    if (/^\s{0,3}((---+)|(\*\s*\*\s*\*)|(___+))\s*$/.test(line)) {
      blank()
      out.push(paint('─'.repeat(Math.min(options.width, 48)), { fg: options.theme.border, capability: options.capability }))
      i++
      continue
    }

    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      const quoteWidth = Math.max(8, options.width - 2)
      const rows = renderPlainParagraph(quote[1]!, { ...options, width: quoteWidth }).map(value => `${paint('▎', { fg: options.theme.markdownQuote, capability: options.capability })} ${value}`)
      out.push(...rows)
      i++
      continue
    }

    const ordered = line.match(orderedRe)
    if (ordered) {
      const indent = ordered[1] ?? ''
      const prefixWidth = widthOf(indent) + widthOf(`${ordered[2]}. `)
      const rows = renderPlainParagraph(ordered[3]!, { ...options, width: Math.max(8, options.width - prefixWidth) })
      rows.forEach((value, index) => out.push(`${indent}${paint(index === 0 ? `${ordered[2]}.` : ' ', { fg: options.theme.markdownHeading, capability: options.capability })} ${value}`))
      i++
      continue
    }

    const unordered = line.match(unorderedRe)
    if (unordered) {
      const indent = unordered[1] ?? ''
      const prefixWidth = widthOf(indent) + 2
      const rows = renderPlainParagraph(unordered[2]!, { ...options, width: Math.max(8, options.width - prefixWidth) })
      rows.forEach((value, index) => out.push(`${indent}${paint(index === 0 ? '•' : ' ', { fg: options.theme.markdownHeading, capability: options.capability })} ${value}`))
      i++
      continue
    }

    out.push(...renderPlainParagraph(line, options))
    i++
  }

  while (out.at(-1) === '') out.pop()
  return out.length ? out : ['']
}
