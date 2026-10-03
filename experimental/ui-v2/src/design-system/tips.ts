import { clip, paint, padRight } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'

const TIPS = [
  'Ctrl+P opens the command palette.',
  'Ctrl+E shows reasoning details when available.',
  'Ctrl+O opens the latest tool details.',
  'Shift+Enter adds a new line without submitting.',
  'Use /resume <session_id> to continue an older session.',
]

export function getTip(index = 0) {
  return TIPS[Math.abs(index) % TIPS.length]!
}

export function renderTip(options: {
  width: number
  theme: Theme
  capability: ColorCapability
  index?: number
}) {
  const text = `Tip: ${getTip(options.index)}`
  return padRight(clip(paint(text, { fg: options.theme.muted, capability: options.capability }), options.width), options.width)
}
