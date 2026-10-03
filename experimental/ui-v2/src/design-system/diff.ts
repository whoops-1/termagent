import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'

export type DiffLine = {
  kind: 'context' | 'add' | 'remove' | 'hunk'
  text: string
}

function lineColor(kind: DiffLine['kind'], theme: Theme) {
  if (kind === 'add') return theme.diffAdded
  if (kind === 'remove') return theme.diffRemoved
  if (kind === 'hunk') return theme.info
  return theme.muted
}

export function renderDiffBlock(options: {
  width: number
  title: string
  lines: DiffLine[]
  theme: Theme
  capability: ColorCapability
}) {
  const { width, title, lines, theme, capability } = options
  const inner = Math.max(10, width - 2)
  const titleText = `╭─ ${clip(title, Math.max(4, width - 8))} `
  const top = padRight(`${paint(titleText, { fg: theme.borderActive, capability, attrs: { bold: true } })}${paint('─'.repeat(Math.max(0, width - widthOf(titleText) - 1)), { fg: theme.border, capability })}╮`, width)
  const visible = lines.slice(0, Math.max(1, width < 48 ? 40 : 120))
  const body = visible.map((line, index) => {
    const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : line.kind === 'hunk' ? '@' : ' '
    const gutter = String(index + 1).padStart(3)
    const content = clip(line.text, Math.max(1, inner - 8))
    const color = lineColor(line.kind, theme)
    const prefix = paint(`│ ${gutter} `, { fg: theme.muted, capability })
    return padRight(`${prefix}${paint(marker, { fg: color, capability, attrs: { bold: true } })} ${paint(content, { fg: color, capability })}${paint('│', { fg: theme.border, capability })}`, width)
  })
  const bottom = padRight(paint(`╰${'─'.repeat(Math.max(0, width - 2))}╯`, { fg: theme.border, capability }), width)
  return [top, ...body, bottom]
}
