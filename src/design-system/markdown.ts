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

export type TableCellModel = {
  source: string
  segments: Segment[]
}

export type TableModel = {
  header: TableCellModel[]
  align: Array<'left' | 'center' | 'right'>
  rows: TableCellModel[][]
}

export type TableLayoutMode = 'grid' | 'compact' | 'cards'

function splitTableRow(line: string) {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  let body = trimmed
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (ch === '\\' && body[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
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

function parseTable(lines: string[], index: number, theme: Theme): { table: TableModel; next: number } | null {
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
  const toCell = (source: string): TableCellModel => ({ source, segments: inlineSegments(source, theme) })
  return {
    table: { header: header.map(toCell), align: separator.map(parseAlignCell), rows: rows.map(row => row.map(toCell)) },
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

function renderedCellText(cell: TableCellModel, capability: ColorCapability) {
  return renderSegments(cell.segments, capability)
}

function plainCellWidth(cell: TableCellModel) {
  return widthOf(stripAnsi(cell.source))
}

function longestWordWidth(cell: TableCellModel) {
  return Math.max(...cell.source.split(/\s+/).filter(Boolean).map(widthOf), 1)
}

function distributeWidths(preferred: number[], minimum: number[], available: number) {
  const widths = minimum.map(value => value)
  let remaining = Math.max(0, available - widths.reduce((sum, value) => sum + value, 0))
  while (remaining > 0) {
    let chosen = -1
    let bestNeed = -1
    for (let i = 0; i < widths.length; i++) {
      const need = Math.max(0, preferred[i]! - widths[i]!)
      if (need > bestNeed) { bestNeed = need; chosen = i }
    }
    if (chosen < 0 || bestNeed <= 0) break
    const step = Math.min(bestNeed, Math.max(1, Math.floor(remaining / Math.max(1, widths.length))))
    widths[chosen]! += step
    remaining -= step
  }
  let i = 0
  while (remaining > 0 && widths.length) {
    widths[i % widths.length]! += 1
    remaining--
    i++
  }
  return widths
}

function wrapTableCell(cell: TableCellModel, width: number, capability: ColorCapability) {
  const lines = wrapSegments(cell.segments, Math.max(2, width), capability)
  return lines.length ? lines : ['']
}

function borderLine(widths: number[], left: string, middle: string, right: string, theme: Theme, capability: ColorCapability) {
  const line = `${left}${widths.map(w => '─'.repeat(w + 2)).join(middle)}${right}`
  return paint(line, { fg: theme.border, capability })
}

function tableGrid(table: TableModel, options: MarkdownOptions, widths: number[]) {
  const renderRow = (cells: TableCellModel[], header = false) => {
    const wrapped = cells.map((cell, index) => wrapTableCell(cell, widths[index]!, options.capability))
    const height = Math.max(...wrapped.map(lines => lines.length), 1)
    const out: string[] = []
    for (let lineIndex = 0; lineIndex < height; lineIndex++) {
      const parts = cells.map((cell, index) => {
        const content = wrapped[index]![lineIndex] ?? ''
        const target = widths[index]!
        const align = table.align[index] ?? 'left'
        return padAligned(content, target, align)
      })
      const raw = `│ ${parts.join(' │ ')} │`
      out.push(raw)
    }
    return out.map(row => paint(row, {
      fg: header ? options.theme.text : undefined,
      capability: options.capability,
      attrs: header ? { bold: true } : undefined,
    }))
  }

  const out: string[] = [borderLine(widths, '┌', '┬', '┐', options.theme, options.capability)]
  out.push(...renderRow(table.header, true))
  out.push(borderLine(widths, '├', '┼', '┤', options.theme, options.capability))
  for (let i = 0; i < table.rows.length; i++) {
    out.push(...renderRow(table.rows[i]!, false))
    if (i < table.rows.length - 1) out.push(borderLine(widths, '├', '┼', '┤', options.theme, options.capability))
  }
  out.push(borderLine(widths, '└', '┴', '┘', options.theme, options.capability))
  return out.map(line => padRight(clip(line, options.width), options.width))
}

function tableCompact(table: TableModel, options: MarkdownOptions, widths: number[]) {
  const columns = table.header.length
  const vertical = paint('│', { fg: options.theme.border, capability: options.capability })
  const rowLines = (cells: TableCellModel[], header = false) => {
    const wrapped = cells.map((cell, index) => wrapTableCell(cell, widths[index]!, options.capability))
    const height = Math.max(...wrapped.map(lines => lines.length), 1)
    const out: string[] = []
    for (let i = 0; i < height; i++) {
      const parts = cells.map((cell, index) => {
        const value = wrapped[index]![i] ?? ''
        return padAligned(value, widths[index]!, table.align[index] ?? 'left')
      })
      out.push(`${vertical} ${parts.join(paint(' │ ', { fg: options.theme.subtle, capability: options.capability }))} ${vertical}`)
    }
    return out.map(line => paint(line, { fg: header ? options.theme.text : undefined, capability: options.capability, attrs: header ? { bold: true } : undefined }))
  }
  const out: string[] = [borderLine(widths, '┌', '┬', '┐', options.theme, options.capability)]
  out.push(...rowLines(table.header, true))
  out.push(borderLine(widths, '├', '┼', '┤', options.theme, options.capability))
  for (let i = 0; i < table.rows.length; i++) {
    out.push(...rowLines(table.rows[i]!, false))
    if (i < table.rows.length - 1) out.push(borderLine(widths, '├', '┼', '┤', options.theme, options.capability))
  }
  out.push(borderLine(widths, '└', '┴', '┘', options.theme, options.capability))
  return out.map(line => padRight(clip(line, options.width), options.width))
}

function tableCards(table: TableModel, options: MarkdownOptions) {
  const inner = Math.max(12, options.width - 4)
  const out: string[] = []
  const rowCount = Math.max(table.rows.length, 1)
  const rows = table.rows.length ? table.rows : [table.header.map(() => ({ source: '', segments: [] }))]
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row = rows[rowIndex]!
    const title = ` ${rowIndex + 1}/${rowCount || 1} `
    out.push(padRight(paint(`╭─${title}${'─'.repeat(Math.max(0, inner - widthOf(title) - 3))}╮`, { fg: options.theme.border, capability: options.capability }), options.width))
    for (let column = 0; column < table.header.length; column++) {
      const label = clip(table.header[column]!.source || `Column ${column + 1}`, Math.max(6, inner - 4))
      const valueLines = wrapTableCell(row[column]!, Math.max(6, inner - Math.min(20, widthOf(label)) - 3), options.capability)
      const labelPrefix = paint(`${clip(label, Math.max(6, Math.min(18, inner - 8)))}:`, { fg: options.theme.markdownHeading, capability: options.capability, attrs: { bold: true } })
      for (let lineIndex = 0; lineIndex < Math.max(1, valueLines.length); lineIndex++) {
        const prefix = lineIndex === 0 ? `${labelPrefix} ` : `${' '.repeat(Math.min(20, widthOf(label)) + 2)}`
        out.push(padRight(clip(`│ ${prefix}${valueLines[lineIndex] ?? ''}`, options.width - 1) + paint('│', { fg: options.theme.border, capability: options.capability }), options.width))
      }
    }
    out.push(padRight(paint(`╰${'─'.repeat(Math.max(0, options.width - 2))}╯`, { fg: options.theme.border, capability: options.capability }), options.width))
    if (rowIndex < rowCount - 1) out.push('')
  }
  return out
}

export function tableLayout(table: TableModel, width: number): { mode: TableLayoutMode; widths: number[] } {
  const columns = table.header.length
  if ((columns >= 5 && width < 92) || (columns >= 3 && width < 48)) return { mode: 'cards', widths: [] }
  const separatorWidth = columns * 3 + 1
  const available = Math.max(0, width - separatorWidth)
  const minimum = table.header.map((cell, i) => Math.max(4, Math.min(8, longestWordWidth(cell), plainCellWidth(cell)), ...table.rows.map(row => Math.min(8, longestWordWidth(row[i]!)))) )
  const preferred = table.header.map((cell, i) => Math.max(8, Math.min(28, plainCellWidth(cell), ...table.rows.map(row => Math.min(28, plainCellWidth(row[i]!))))))
  const minimumTotal = minimum.reduce((sum, value) => sum + value, 0)
  if (columns === 2 && width >= 34 && minimumTotal <= available) {
    return { mode: available >= 62 ? 'grid' : 'compact', widths: distributeWidths(preferred, minimum, available) }
  }
  if (minimumTotal > available || width < 34) return { mode: 'cards', widths: [] }
  const mode: TableLayoutMode = width >= columns * 14 + separatorWidth + 4 ? 'grid' : 'compact'
  return { mode, widths: distributeWidths(preferred, minimum, available) }
}

function renderTable(table: TableModel, options: MarkdownOptions) {
  const layout = tableLayout(table, options.width)
  if (layout.mode === 'cards') return tableCards(table, options)
  if (layout.mode === 'compact') return tableCompact(table, options, layout.widths)
  return tableGrid(table, options, layout.widths)
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

    const table = parseTable(lines, i, options.theme)
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
