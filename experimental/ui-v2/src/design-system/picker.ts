import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'

export type PickerOption = {
  label: string
  description?: string
  value?: string
  disabled?: boolean
}

export type PickerRenderOptions = {
  options: PickerOption[]
  selectedIndex: number
  width: number
  maxVisible?: number
  query?: string
  theme: Theme
  capability: ColorCapability
  title?: string
  footer?: string
}

export function pickerWindow(total: number, selectedIndex: number, maxVisible: number) {
  if (total <= maxVisible) return { start: 0, end: total }
  const selected = Math.max(0, Math.min(selectedIndex, total - 1))
  const half = Math.floor(maxVisible / 2)
  let start = Math.max(0, selected - half)
  start = Math.min(start, total - maxVisible)
  return { start, end: start + maxVisible }
}

export function renderPicker(options: PickerRenderOptions) {
  const { options: items, selectedIndex, width, theme, capability } = options
  const maxVisible = Math.max(1, Math.min(options.maxVisible ?? 8, items.length || 1))
  if (!items.length) {
    const empty = paint('No results found', { fg: theme.muted, capability })
    return options.title
      ? [
          paint(`╭─ ${clip(options.title, Math.max(8, width - 8))} ${'─'.repeat(Math.max(0, width - widthOf(options.title) - 5))}╮`, { fg: theme.border, capability }),
          padRight(`${paint('│', { fg: theme.border, capability })} ${empty}`, width - 1),
          padRight(paint(`╰${'─'.repeat(Math.max(0, width - 2))}╯`, { fg: theme.border, capability }), width),
        ]
      : [padRight(empty, width)]
  }

  const window = pickerWindow(items.length, selectedIndex, maxVisible)
  const out: string[] = []
  const labelWidth = Math.max(8, Math.min(30, Math.floor(width * 0.42)))
  const frame = Boolean(options.title)
  const contentWidth = frame ? Math.max(4, width - 2) : width

  if (frame) {
    const title = options.title!
    const titlePart = `─ ${clip(title, Math.max(8, width - 8))} `
    out.push(padRight(`╭${titlePart}${'─'.repeat(Math.max(0, width - widthOf(titlePart) - 2))}╮`, width))
    if (options.query !== undefined) {
      const query = options.query ? `Search: ${options.query}` : 'Type to search'
      out.push(padRight(`│ ${paint(clip(query, contentWidth - 3), { fg: theme.muted, capability })}`, width))
      out.push(padRight(`│ ${paint('─'.repeat(Math.max(1, contentWidth - 2)), { fg: theme.border, capability })}`, width))
    }
  }

  for (let i = window.start; i < window.end; i++) {
    const item = items[i]!
    const selected = i === selectedIndex
    const marker = selected ? '›' : ' '
    const state = item.disabled ? paint('disabled', { fg: theme.muted, capability }) : ''
    const rawLabel = clip(item.label, labelWidth)
    const footerWidth = options.query ? widthOf(`filter: ${options.query}`) + 2 : 0
    const descBudget = Math.max(0, contentWidth - 4 - widthOf(rawLabel) - widthOf(state) - footerWidth)
    const desc = item.description && descBudget > 2 ? ` ${clip(item.description, descBudget)}` : ''
    const text = `${marker} ${rawLabel}${desc}${state ? ` ${state}` : ''}`
    const row = padRight(clip(text, contentWidth - (frame ? 2 : 0)), contentWidth - (frame ? 2 : 0))
    const styled = paint(row, {
      fg: selected ? theme.text : item.disabled ? theme.muted : theme.text,
      bg: selected ? theme.selection : undefined,
      attrs: selected ? { bold: true } : undefined,
      capability,
    })
    out.push(frame ? padRight(`│ ${styled} │`, width) : styled)
  }

  if (items.length > maxVisible) {
    const top = window.start > 0 ? '↑ more' : '      '
    const bottom = window.end < items.length ? '↓ more' : '      '
    const range = `${window.start + 1}-${window.end} of ${items.length}`
    const query = options.query ? `filter: ${clip(options.query, Math.max(8, width - 34))}` : ''
    const meta = `  ${top}  ${range}${query ? `   ${query}` : ''}  ${bottom}`
    const row = paint(padRight(clip(meta, frame ? width - 2 : width), frame ? width - 2 : width), { fg: theme.muted, capability, attrs: { dim: true } })
    out.push(frame ? padRight(`│ ${row} │`, width) : row)
  }

  if (frame && options.footer) {
    out.push(padRight(`│ ${paint(clip(options.footer, contentWidth - 2), { fg: theme.muted, capability, attrs: { dim: true } })}`, width))
  }
  if (frame) out.push(padRight(`╰${'─'.repeat(Math.max(0, width - 2))}╯`, width))
  return out
}
