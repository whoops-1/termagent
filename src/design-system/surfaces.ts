import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'
import { contentWidth, centeredFrame } from './geometry.js'

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
  const frame = centeredFrame(width, options.maxWidth ?? 76, 28, options.maxWidth ?? 76)
  const modalWidth = frame.frameWidth
  const left = frame.left
  const right = frame.right
  const innerWidth = contentWidth(modalWidth, { borderLeft: 1, borderRight: 1, paddingLeft: 1, paddingRight: 1 })
  const borderColor = toneColor(options.tone ?? 'normal', theme)
  const prefix = ' '.repeat(left)
  const suffix = ' '.repeat(right)
  const preserveAnsi = options.preserveAnsi ?? true
  const inner = (text: string, fg?: string, attrs?: Parameters<typeof paint>[1]['attrs']) => {
    const value = padRight(clip(text, innerWidth), innerWidth)
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

export type DockFrameOptions = {
  width: number
  title: string
  content: string[]
  footer?: string
  theme: Theme
  capability: ColorCapability
  tone?: SurfaceTone
  maxWidth?: number
}

export function renderDockFrame(options: DockFrameOptions) {
  const width = Math.max(24, options.width)
  const frame = centeredFrame(width, options.maxWidth ?? width - 2, 20, options.maxWidth ?? width - 2)
  const frameWidth = frame.frameWidth
  const left = frame.left
  const right = frame.right
  const innerWidth = contentWidth(frameWidth, { borderLeft: 1, borderRight: 1, paddingLeft: 1, paddingRight: 1 })
  const color = toneColor(options.tone ?? 'normal', options.theme)
  const prefix = ' '.repeat(left)
  const suffix = ' '.repeat(right)

  const borderLine = (leftChar: string, rightChar: string) =>
    `${prefix}${leftChar}${'─'.repeat(Math.max(0, frameWidth - 2))}${rightChar}${suffix}`

  const bodyLine = (value: string, fg = options.theme.text, attrs?: Parameters<typeof paint>[1]['attrs']) => {
    const clipped = clip(value, innerWidth)
    const pad = ' '.repeat(Math.max(0, innerWidth - widthOf(clipped)))
    return `${prefix}│ ${paint(clipped, { fg, attrs, capability: options.capability })}${pad} │${suffix}`
  }

  const rows: string[] = []
  const title = clip(` ${options.title} `, Math.max(1, frameWidth - 6))
  const titleWidth = widthOf(title)
  const lineWidth = Math.max(0, frameWidth - titleWidth - 4)
  rows.push(`${prefix}╭─${paint(title, { fg: color, attrs: { bold: true }, capability: options.capability })}${'─'.repeat(lineWidth)}─╮${suffix}`)
  for (const value of options.content) {
    const clipped = clip(value, innerWidth)
    const pad = ' '.repeat(Math.max(0, innerWidth - widthOf(clipped)))
    rows.push(`${prefix}│ ${clipped}${pad} │${suffix}`)
  }
  if (options.footer) rows.push(bodyLine(options.footer, options.theme.muted, { dim: true }))
  rows.push(borderLine('╰', '╯'))
  return rows.map((row) => padRight(row, width))
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
