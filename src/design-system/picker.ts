import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'
import { contentWidth } from './geometry.js'

export const COMMAND_PICKER_GEOMETRY = {
  maxWidth: 60,
  minWidth: 24,
  fixedNameWidth: 24,
  descriptionGap: 2,
  itemPaddingLeft: 3,
  itemPaddingRight: 3,
  stackedBreakpoint: 56,
} as const

export type PickerOption = {
  label: string
  description?: string
  value?: string
  disabled?: boolean
}

export type PickerRowStatus = 'default' | 'active' | 'success' | 'warning' | 'error' | 'disabled'

export type PickerRow = {
  id: string
  label: string
  detail?: string
  badge?: string
  status?: PickerRowStatus
  value?: string
  disabled?: boolean
  key?: string
  swatches?: string[]
}

export type PickerRenderOptions = {
  options?: PickerOption[]
  rows?: PickerRow[]
  selectedIndex: number
  width: number
  maxVisible?: number
  query?: string
  theme: Theme
  capability: ColorCapability
  title?: string
  footer?: string
  commandLayout?: boolean | 'stacked'
  commandNameWidth?: number
  commandDescriptionGap?: number
  commandItemPaddingLeft?: number
  commandItemPaddingRight?: number
  availableRows?: number
}

export function pickerWindow(total: number, selectedIndex: number, maxVisible: number) {
  if (total <= maxVisible) return { start: 0, end: total }
  const selected = Math.max(0, Math.min(selectedIndex, total - 1))
  const half = Math.floor(maxVisible / 2)
  let start = Math.max(0, selected - half)
  start = Math.min(start, total - maxVisible)
  return { start, end: start + maxVisible }
}

export type PickerLayout = {
  window: { start: number; end: number }
  maxVisible: number
  rowHeight: number
  listOffsetRows: number
}

export function pickerLayout(options: {
  total: number
  selectedIndex: number
  maxVisible?: number
  availableRows?: number
  commandStacked?: boolean
  framed?: boolean
  hasQuery?: boolean
  hasFooter?: boolean
}): PickerLayout {
  const maxRequested = Math.max(1, options.maxVisible ?? 8)
  const availableRows = options.availableRows ?? Number.MAX_SAFE_INTEGER
  const framed = Boolean(options.framed)
  const hasQuery = Boolean(options.hasQuery)
  const hasFooter = Boolean(options.hasFooter)
  const rowHeight = options.commandStacked ? 2 : 1
  const baseChromeRows = framed ? 2 + (hasQuery ? 2 : 0) + (hasFooter ? 1 : 0) : 0
  const maxByHeight = Math.max(1, Math.floor((availableRows - baseChromeRows) / rowHeight))
  let maxVisible = Math.max(1, Math.min(maxRequested, options.total || 1, maxByHeight))
  if (options.total > maxVisible) {
    const withMeta = Math.max(1, Math.floor((availableRows - baseChromeRows - 1) / rowHeight))
    maxVisible = Math.max(1, Math.min(maxVisible, withMeta))
  }
  return {
    window: pickerWindow(options.total, options.selectedIndex, maxVisible),
    maxVisible,
    rowHeight,
    listOffsetRows: framed ? 1 + (hasQuery ? 2 : 0) : 0,
  }
}

function renderSwatches(swatches: readonly string[] | undefined, capability: ColorCapability) {
  if (!swatches?.length) return ''
  return swatches.slice(0, 6).map(color => paint('■', { fg: color, capability, attrs: { bold: true } })).join(' ')
}

export function renderPicker(options: PickerRenderOptions) {
  const items: PickerRow[] = options.rows ?? (options.options ?? []).map((item, index) => ({
    id: item.value ?? `option:${index}`,
    label: item.label,
    detail: item.description,
    value: item.value,
    disabled: item.disabled,
  }))
  const { selectedIndex, width, theme, capability } = options
  const commandFixed = options.commandLayout === true && width >= 1
  const commandStacked = options.commandLayout === 'stacked'
  const commandNameWidth = Math.max(4, options.commandNameWidth ?? 24)
  const commandDescriptionGap = Math.max(0, options.commandDescriptionGap ?? 2)
  const itemPaddingLeft = Math.max(0, options.commandItemPaddingLeft ?? 3)
  const itemPaddingRight = Math.max(0, options.commandItemPaddingRight ?? 3)
  const frame = Boolean(options.title)
  const layout = pickerLayout({
    total: items.length,
    selectedIndex,
    maxVisible: options.maxVisible,
    availableRows: options.availableRows,
    commandStacked,
    framed: frame,
    hasQuery: options.query !== undefined,
    hasFooter: Boolean(options.footer),
  })
  const maxVisible = layout.maxVisible

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

  const window = layout.window
  const out: string[] = []
  const listContentWidth = contentWidth(width, frame ? { borderLeft: 1, borderRight: 1, paddingLeft: 0, paddingRight: 0 } : { borderLeft: 0, borderRight: 0, paddingLeft: 0, paddingRight: 0 })

  if (frame) {
    const title = options.title!
    const titlePart = `─ ${clip(title, Math.max(8, width - 8))} `
    out.push(padRight(`╭${titlePart}${'─'.repeat(Math.max(0, width - widthOf(titlePart) - 2))}╮`, width))
    if (options.query !== undefined) {
      const query = options.query ? `Search: ${options.query}` : 'Type to search'
      out.push(padRight(`│ ${paint(clip(query, listContentWidth - 3), { fg: theme.muted, capability })}`, width))
      out.push(padRight(`│ ${paint('─'.repeat(Math.max(1, listContentWidth - 2)), { fg: theme.border, capability })}`, width))
    }
  }

  for (let i = window.start; i < window.end; i++) {
    const item = items[i]!
    const selected = i === selectedIndex
    const marker = selected ? '›' : ' '
    const detail = item.detail ?? ''
    const badge = item.badge ? `[${item.badge}]` : ''
    const semanticColor = item.disabled || item.status === 'disabled' ? theme.muted
      : item.status === 'success' ? theme.success
        : item.status === 'warning' ? theme.warning
          : item.status === 'error' ? theme.error
            : item.status === 'active' ? theme.primary
              : undefined

    let text: string
    if (commandFixed) {
      const rowContentWidth = Math.max(1, listContentWidth - itemPaddingLeft - itemPaddingRight)
      const effectiveNameWidth = Math.min(commandNameWidth, Math.max(4, rowContentWidth - 1))
      const effectiveGap = Math.min(commandDescriptionGap, Math.max(0, rowContentWidth - effectiveNameWidth - 1))
      const nameText = clip(item.label, Math.max(2, effectiveNameWidth - 2))
      const nameCell = `${marker} ${nameText}${' '.repeat(Math.max(0, effectiveNameWidth - 2 - widthOf(nameText)))}`
      const descBudget = Math.max(0, rowContentWidth - effectiveNameWidth - effectiveGap)
      const detailText = badge ? `${badge}${detail ? ` ${detail}` : ''}` : detail
      const swatch = renderSwatches(item.swatches, capability)
      const swatchWidth = widthOf(swatch)
      const separator = swatch && detailText ? '  ' : ''
      const tailBudget = Math.max(0, descBudget - swatchWidth - widthOf(separator))
      const desc = detailText && tailBudget > 0 ? clip(detailText, tailBudget) : ''
      const tail = `${desc}${separator}${swatch}`
      text = `${' '.repeat(itemPaddingLeft)}${nameCell}${' '.repeat(effectiveGap)}${tail}${' '.repeat(Math.max(0, rowContentWidth - effectiveNameWidth - effectiveGap - widthOf(tail)))}${' '.repeat(itemPaddingRight)}`
    } else if (commandStacked) {
      const rowContentWidth = Math.max(1, listContentWidth - itemPaddingLeft - itemPaddingRight)
      const label = clip(item.label, Math.max(1, rowContentWidth - 2))
      const detailText = badge ? `${badge}${detail ? ` ${detail}` : ''}` : detail
      const swatch = renderSwatches(item.swatches, capability)
      const detailBudget = Math.max(1, rowContentWidth - widthOf(swatch) - (swatch ? 2 : 0))
      const desc = detailText ? clip(detailText, detailBudget) : ''
      const first = `${' '.repeat(itemPaddingLeft)}${marker} ${label}${' '.repeat(itemPaddingRight)}`
      const secondText = [desc, swatch].filter(Boolean).join(swatch ? '  ' : '')
      const second = secondText ? `${' '.repeat(itemPaddingLeft + 2)}${secondText}${' '.repeat(itemPaddingRight)}` : ''
      const firstStyled = paint(padRight(first, listContentWidth), {
        fg: selected ? theme.text : semanticColor ?? theme.text,
        bg: selected ? theme.selection : undefined,
        attrs: selected ? { bold: true } : undefined,
        capability,
      })
      out.push(frame ? padRight(`│${firstStyled}│`, width) : firstStyled)
      if (second) {
        const secondStyled = paint(padRight(clip(second, listContentWidth), listContentWidth), {
          fg: selected ? theme.text : semanticColor ?? theme.muted,
          bg: selected ? theme.selection : undefined,
          capability,
        })
        out.push(frame ? padRight(`│${secondStyled}│`, width) : secondStyled)
      }
      continue
    } else {
      const labelWidth = Math.max(8, Math.min(30, Math.floor(width * 0.42)))
      const rawLabel = clip(item.label, labelWidth)
      const swatch = renderSwatches(item.swatches, capability)
      const descBudget = Math.max(0, listContentWidth - 4 - widthOf(rawLabel) - widthOf(swatch) - (swatch ? 2 : 0))
      const desc = detail && descBudget > 2 ? ` ${clip(detail, descBudget)}` : ''
      text = `${marker} ${rawLabel}${desc}${swatch ? `  ${swatch}` : ''}`
    }

    const row = padRight(clip(text, listContentWidth), listContentWidth)
    const styled = paint(row, {
      fg: selected ? theme.text : item.disabled ? theme.muted : theme.text,
      bg: selected ? theme.selection : undefined,
      attrs: selected ? { bold: true } : undefined,
      capability,
    })
    out.push(frame ? padRight(`│${styled}│`, width) : styled)
  }

  if (items.length > maxVisible) {
    const top = window.start > 0 ? '↑ more' : '      '
    const bottom = window.end < items.length ? '↓ more' : '      '
    const range = `${window.start + 1}-${window.end} of ${items.length}`
    const query = options.query ? `filter: ${clip(options.query, Math.max(8, width - 34))}` : ''
    const meta = `  ${top}  ${range}${query ? `   ${query}` : ''}  ${bottom}`
    const innerMetaWidth = frame ? Math.max(0, width - 4) : width
    const row = paint(padRight(clip(meta, innerMetaWidth), innerMetaWidth), { fg: theme.muted, capability, attrs: { dim: true } })
    out.push(frame ? padRight(`│ ${row} │`, width) : row)
  }

  if (frame && options.footer) {
    out.push(padRight(`│ ${paint(clip(options.footer, listContentWidth - 2), { fg: theme.muted, capability, attrs: { dim: true } })}`, width))
  }
  if (frame) out.push(padRight(`╰${'─'.repeat(Math.max(0, width - 2))}╯`, width))
  return out
}

