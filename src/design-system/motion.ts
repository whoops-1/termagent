import type { Theme } from './types.js'
import { paint, padRight } from './ansi.js'

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export function animationFrame(now = Date.now(), intervalMs = 80) {
  const safeInterval = Math.max(16, intervalMs)
  return Math.floor(now / safeInterval)
}

export function elapsedSecondsSince(startedAt: number, now = Date.now()) {
  if (!startedAt || !Number.isFinite(startedAt)) return 0
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

export function pulse(now = Date.now(), periodMs = 900) {
  const safePeriod = Math.max(100, periodMs)
  return Math.floor(now / (safePeriod / 2)) % 2 === 0
}

export function renderStartup(options: {
  width: number
  label?: string
  frame?: number
  theme: Theme
  capability: Parameters<typeof paint>[1]['capability']
}) {
  const label = options.label ?? 'Starting TermAgent'
  const frame = options.frame ?? animationFrame()
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!
  const text = `  ${paint(glyph, { fg: options.theme.info, capability: options.capability })} ${paint(label, { fg: options.theme.muted, capability: options.capability })}`
  return padRight(text, options.width)
}

export function renderCompletion(options: {
  width: number
  label: string
  now?: number
  theme: Theme
  capability: Parameters<typeof paint>[1]['capability']
  animate?: boolean
}) {
  const icon = options.animate === false ? '✓' : pulse(options.now, 300) ? '✓' : '·'
  const text = `  ${paint(icon, { fg: options.theme.success, capability: options.capability, attrs: { bold: true } })} ${paint(options.label, { fg: options.theme.muted, capability: options.capability })}`
  return padRight(text, options.width)
}

