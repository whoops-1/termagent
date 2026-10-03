import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'

export type FooterContext = 'prompt' | 'picker' | 'modal' | 'inspector' | 'activity'

export function renderFooter(options: {
  width: number
  cwd: string
  context: FooterContext
  theme: Theme
  capability: ColorCapability
  vim?: boolean
  turnActive?: boolean
}) {
  const leftLabel = options.turnActive ? 'esc interrupt' : 'esc'
  const vim = options.vim ? ' · vim' : ''
  const left = paint(`${leftLabel}${vim}`, { fg: options.theme.muted, capability: options.capability })
  const hints = options.context === 'inspector'
    ? '↑↓ scroll   PgUp/PgDn page   Esc close'
    : options.context === 'picker'
      ? '↑↓ select   Enter choose   Esc close'
      : options.context === 'modal'
        ? '↑↓ select   Enter confirm   Esc cancel'
        : options.context === 'activity'
          ? 'Ctrl+E reasoning   Ctrl+O details   Tab agents'
          : 'Ctrl+P commands   Ctrl+E reasoning   Ctrl+O details'
  const right = paint(hints, { fg: options.theme.muted, capability: options.capability })
  const gap = Math.max(1, options.width - widthOf(left) - widthOf(right))
  const cwd = paint(clip(options.cwd, Math.max(10, options.width)), { fg: options.theme.muted, capability: options.capability })
  return [padRight(`${left}${' '.repeat(gap)}${right}`, options.width), padRight(cwd, options.width)]
}
