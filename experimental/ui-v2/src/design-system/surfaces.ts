import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'

export type SurfaceTone = 'normal' | 'info' | 'success' | 'warning' | 'error'

function toneColor(tone: SurfaceTone, theme: Theme) {
  if (tone === 'success') return theme.success
  if (tone === 'warning') return theme.warning
  if (tone === 'error') return theme.error
  if (tone === 'info') return theme.info
  return theme.borderActive
}

function line(width: number, fill = ' ', left = '│', right = '│') {
  return `${left}${fill.repeat(Math.max(0, width - 2))}${right}`
}

export function renderDialogFrame(options: {
  width: number
  height: number
  title: string
  subtitle?: string
  content: string[]
  footer?: string
  theme: Theme
  capability: ColorCapability
  tone?: SurfaceTone
  maxWidth?: number
  preserveAnsi?: boolean
}) {
  const { width, height, title, subtitle, theme, capability } = options
  const modalWidth = Math.max(28, Math.min(options.maxWidth ?? 76, width - 4))
  const left = Math.max(0, Math.floor((width - modalWidth) / 2))
  const right = Math.max(0, width - modalWidth - left)
  const contentWidth = Math.max(8, modalWidth - 4)
  const borderColor = toneColor(options.tone ?? 'normal', theme)
  const prefix = ' '.repeat(left)
  const suffix = ' '.repeat(right)
  const preserveAnsi = options.preserveAnsi ?? true
  const inner = (text: string, fg?: string, attrs?: Parameters<typeof paint>[1]['attrs']) => {
    const value = padRight(clip(text, contentWidth), contentWidth)
    const rendered = preserveAnsi && !fg && !attrs
      ? value
      : paint(value, { fg: fg ?? theme.text, attrs, capability })
    return `${prefix}│${rendered}│${suffix}`
  }
  const top = `${prefix}╭${paint(` ${clip(title, Math.max(1, modalWidth - 6))} `, { fg: borderColor, attrs: { bold: true }, capability })}${'─'.repeat(Math.max(0, modalWidth - widthOf(` ${clip(title, Math.max(1, modalWidth - 6))} `) - 2))}╮${suffix}`
  const bottom = `${prefix}╰${'─'.repeat(Math.max(0, modalWidth - 2))}╯${suffix}`

  const rows: string[] = [top]
  if (subtitle) rows.push(inner(subtitle, theme.muted, { dim: true }))
  if (subtitle) rows.push(inner(''))

  const available = Math.max(1, height - rows.length - 2 - (options.footer ? 1 : 0))
  const content = options.content.slice(0, available)
  for (const item of content) rows.push(inner(item))
  while (rows.length < height - 1 - (options.footer ? 1 : 0)) rows.push(inner(''))
  if (options.footer) rows.push(inner(options.footer, theme.muted, { dim: true }))
  rows.push(bottom)

  return rows.slice(0, height).map(row => padRight(row, width))
}

export function renderSectionHeader(title: string, width: number, theme: Theme, capability: ColorCapability, tone: SurfaceTone = 'normal') {
  const color = toneColor(tone, theme)
  const label = ` ${title} `
  return padRight(
    `${paint(label, { fg: color, attrs: { bold: true }, capability })}${paint('─'.repeat(Math.max(0, width - widthOf(label))), { fg: theme.border, capability })}`,
    width,
  )
}

export function renderStatusCallout(options: {
  width: number
  title: string
  detail?: string
  tone: SurfaceTone
  theme: Theme
  capability: ColorCapability
}) {
  const icon = options.tone === 'success' ? '✓' : options.tone === 'warning' ? '!' : options.tone === 'error' ? '×' : options.tone === 'info' ? 'i' : '·'
  const color = toneColor(options.tone, options.theme)
  const title = paint(`${icon} ${options.title}`, { fg: color, attrs: { bold: true }, capability: options.capability })
  const detail = options.detail ? ` ${paint(options.detail, { fg: options.theme.muted, capability: options.capability })}` : ''
  return padRight(clip(`  ${title}${detail}`, options.width), options.width)
}
