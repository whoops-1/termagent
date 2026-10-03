import { paint, padRight, widthOf } from './ansi.js'
import { SPINNER_FRAMES } from './motion.js'
import type { ColorCapability, Theme } from './types.js'

export type ActivityPhase = 'thinking' | 'writing' | 'tool' | 'permission' | 'question' | 'retrying' | 'compacting' | 'done' | 'error'

const SHOW_ELAPSED_AFTER = 3

function phaseColor(phase: ActivityPhase, theme: Theme) {
  if (phase === 'error') return theme.error
  if (phase === 'done') return theme.success
  if (phase === 'permission') return theme.warning
  if (phase === 'tool') return theme.tool
  if (phase === 'question') return theme.secondary
  if (phase === 'retrying') return theme.warning
  if (phase === 'compacting') return theme.info
  return theme.primary
}

function shimmerText(label: string, frame: number, base: string, accent: string, capability: ColorCapability) {
  const chars = Array.from(label)
  if (!chars.length) return paint('', { fg: base, capability })
  const focus = (Math.floor(frame / 2) % (chars.length + 4)) - 2
  return chars.map((char, index) => paint(char, {
    fg: Math.abs(index - focus) <= 1 ? accent : base,
    capability,
    attrs: { bold: true },
  })).join('')
}

export function renderActivity(options: {
  width: number
  phase: ActivityPhase
  label: string
  elapsedSeconds: number
  frame?: number
  theme: Theme
  capability: ColorCapability
}) {
  const frameNumber = Math.max(0, options.frame ?? 0)
  const frame = SPINNER_FRAMES[frameNumber % SPINNER_FRAMES.length]!
  const color = phaseColor(options.phase, options.theme)
  const prefix = paint(frame, { fg: color, capability: options.capability })
  const label = shimmerText(options.label || options.phase, frameNumber, options.theme.text, color, options.capability)
  const elapsed = options.elapsedSeconds >= SHOW_ELAPSED_AFTER
    ? ` ${paint('·', { fg: options.theme.border, capability: options.capability })} ${paint(`${Math.max(0, options.elapsedSeconds)}s`, { fg: options.theme.muted, capability: options.capability })}`
    : ''
  const content = `  ${prefix} ${label}${elapsed}`
  return padRight(content, options.width)
}

export function activityWidth(options: { label: string; elapsedSeconds?: number }) {
  return 4 + 1 + widthOf(options.label) + (options.elapsedSeconds && options.elapsedSeconds >= SHOW_ELAPSED_AFTER ? 4 + String(options.elapsedSeconds).length : 0)
}
