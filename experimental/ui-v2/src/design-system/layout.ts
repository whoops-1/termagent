import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme, TextAttrs } from './types.js'

export type LayoutOptions = {
  width: number
  theme: Theme
  capability: ColorCapability
}

export function rule(options: LayoutOptions, char = '─') {
  return paint(char.repeat(Math.max(1, options.width)), { fg: options.theme.border, capability: options.capability })
}

export function panel(lines: string[], options: LayoutOptions & { title?: string; paddingX?: number; paddingY?: number }) {
  const paddingX = options.paddingX ?? 1
  const paddingY = options.paddingY ?? 1
  const innerWidth = Math.max(1, options.width - paddingX * 2 - 2)
  const out: string[] = []
  const topTitle = options.title ? ` ${clip(options.title, Math.max(1, innerWidth - 2))} ` : ''
  const topFill = Math.max(0, options.width - widthOf(topTitle) - 2)
  const top = `╭${topTitle ? paint(topTitle, { fg: options.theme.primary, attrs: { bold: true }, capability: options.capability }) + '─'.repeat(topFill) : '─'.repeat(Math.max(0, options.width - 2))}╮`
  out.push(paint(top, { fg: options.theme.border, capability: options.capability }))
  for (let i = 0; i < paddingY; i++) out.push(paint(`│${' '.repeat(Math.max(0, options.width - 2))}│`, { fg: options.theme.border, capability: options.capability }))
  for (const raw of lines) {
    const line = clip(raw, innerWidth)
    const content = `${' '.repeat(paddingX)}${padRight(line, innerWidth)}${' '.repeat(paddingX)}`
    out.push(`${paint('│', { fg: options.theme.border, capability: options.capability })}${content}${paint('│', { fg: options.theme.border, capability: options.capability })}`)
  }
  for (let i = 0; i < paddingY; i++) out.push(paint(`│${' '.repeat(Math.max(0, options.width - 2))}│`, { fg: options.theme.border, capability: options.capability }))
  out.push(paint(`╰${'─'.repeat(Math.max(0, options.width - 2))}╯`, { fg: options.theme.border, capability: options.capability }))
  return out
}

export function selectedRow(label: string, width: number, selected: boolean, theme: Theme, capability: ColorCapability, marker = '›') {
  const prefix = selected ? `${marker} ` : '  '
  const textWidth = Math.max(1, width - widthOf(prefix))
  const text = `${prefix}${clip(label, textWidth)}`
  return paint(padRight(text, width), {
    fg: selected ? theme.text : theme.muted,
    bg: selected ? theme.selection : undefined,
    attrs: selected ? { bold: true } : undefined,
    capability,
  })
}

export function keyHint(key: string, label: string, theme: Theme, capability: ColorCapability) {
  return `${paint(key, { fg: theme.text, bg: theme.surface, attrs: { bold: true }, capability })} ${paint(label, { fg: theme.muted, capability })}`
}

export function statusDot(theme: Theme, capability: ColorCapability, color: string, label: string) {
  return `${paint('●', { fg: color, capability })} ${paint(label, { fg: theme.text, capability })}`
}

export function toneAttrs(tone: 'normal' | 'muted' | 'bold' = 'normal'): TextAttrs | undefined {
  if (tone === 'muted') return { dim: true }
  if (tone === 'bold') return { bold: true }
  return undefined
}
