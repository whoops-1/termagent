import { clip, paint, padRight, widthOf } from './ansi.js'
import { SPINNER_FRAMES } from './motion.js'
import type { ColorCapability, Theme } from './types.js'
import { activityStatus, statusDescriptor, type UIStatus } from './status.js'

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
  const status: UIStatus = activityStatus(options.phase)
  const descriptor = statusDescriptor(status)
  const prefixGlyph = status === 'working'
    ? frame
    : status === 'waiting'
      ? '!'
      : status === 'done'
        ? '✓'
        : status === 'failed'
          ? '×'
          : status === 'cancelled'
            ? '~'
            : '·'
  const prefix = paint(prefixGlyph, { fg: color, capability: options.capability, attrs: status === 'working' ? undefined : { bold: true } })
  const rawLabel = options.label || options.phase
  const label = shimmerText(rawLabel, frameNumber, options.theme.text, color, options.capability)
  const elapsed = options.elapsedSeconds >= SHOW_ELAPSED_AFTER
    ? ` ${paint('·', { fg: options.theme.border, capability: options.capability })} ${paint(`${Math.max(0, options.elapsedSeconds)}s`, { fg: options.theme.muted, capability: options.capability })}`
    : ''
  const content = `  ${prefix} ${label}${elapsed}`
  return padRight(clip(content, options.width), options.width)
}

export function activityWidth(options: { label: string; elapsedSeconds?: number; phase?: ActivityPhase }) {
  const status = activityStatus(options.phase ?? 'writing')
  const stateWidth = 0
  const elapsedWidth = options.elapsedSeconds !== undefined && options.elapsedSeconds >= SHOW_ELAPSED_AFTER
    ? 4 + String(Math.max(0, options.elapsedSeconds)).length
    : 0
  return 2 + 1 + 1 + widthOf(options.label) + stateWidth + elapsedWidth
}
