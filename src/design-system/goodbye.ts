import { clip, paint, padRight } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'

export function renderGoodbye(options: {
  width: number
  sessionId: string
  theme: Theme
  capability: ColorCapability
}) {
  const { width, sessionId, theme, capability } = options
  const command = `termagent --resume ${sessionId}`
  const rows = [
    paint('✓ Session ended', { fg: theme.success, capability, attrs: { bold: true } }),
    paint('  Thanks for using TermAgent.', { fg: theme.text, capability }),
    paint('  Resume your session with:', { fg: theme.muted, capability }),
    paint(`  ${clip(command, Math.max(1, width - 2))}`, { fg: theme.primary, capability, attrs: { bold: true } }),
  ]
  return rows.map(row => padRight(row, width))
}
