import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'
import type { QueuedPrompt } from '../session/prompt-queue.js'

export type QueueAction = 'edit' | 'cancel' | 'up' | 'down'

export type QueuePanelEntry = { item: QueuedPrompt; row: number; controls: boolean }

export function queuePanelEntries(items: QueuedPrompt[], width: number): QueuePanelEntry[] {
  const maxItems = width < 48 ? 2 : width < 76 ? 3 : 5
  const running = items.filter(item => item.status === 'executing')
  const queued = items.filter(item => item.status === 'queued')
  const ordered = [...running, ...queued]
  return ordered.slice(0, maxItems).map((item, index) => ({
    item,
    row: index + 1,
    controls: item.status === 'queued',
  }))
}

export function renderQueuePanel(options: {
  width: number
  items: QueuedPrompt[]
  theme: Theme
  capability: ColorCapability
}) {
  const width = Math.max(24, options.width)
  if (!options.items.length) return []
  const queuedCount = options.items.filter(item => item.status === 'queued').length
  const runningCount = options.items.filter(item => item.status === 'executing').length
  const entries = queuePanelEntries(options.items, width)
  const visibleQueued = entries.filter(entry => entry.item.status === 'queued').length
  const moreQueued = Math.max(0, queuedCount - visibleQueued)
  const inner = Math.max(12, width - 4)
  const summary = `Queue · ${queuedCount} queued${runningCount ? ` · ${runningCount} running` : ''}`
  const heading = clip(summary, Math.max(8, width - 6))
  const out: string[] = []
  out.push(padRight(paint(`┌─ ${heading}${'─'.repeat(Math.max(0, width - widthOf(heading) - 5))}┐`, { fg: options.theme.primary, capability: options.capability, attrs: { bold: true } }), width))

  entries.forEach(entry => {
    const item = entry.item
    const running = item.status === 'executing'
    const marker = running ? '▶ ' : `${Math.max(1, options.items.filter(q => q.status === 'queued').indexOf(item) + 1)}. `
    const controls = entry.controls
      ? width >= 64 ? '  edit · ×' : width >= 48 ? '  e · ×' : ''
      : width >= 56 ? '  running' : ''
    const budget = Math.max(8, inner - widthOf(marker) - widthOf(controls) - 1)
    const text = clip(item.content.replace(/\s+/g, ' ').trim(), budget)
    const used = widthOf(marker) + widthOf(text) + widthOf(controls)
    const pad = Math.max(0, inner - used - 1)
    const line = `│ ${marker}${text}${' '.repeat(pad)}${controls} │`
    out.push(padRight(paint(line, { fg: running ? options.theme.info : options.theme.text, capability: options.capability, attrs: running ? { bold: true } : undefined }), width))
  })

  if (moreQueued) {
    const line = `│   +${moreQueued} more queued · /queue to manage`
    out.push(padRight(paint(clip(line, width - 1) + '│', { fg: options.theme.muted, capability: options.capability }), width))
  }
  out.push(padRight(paint(`└${'─'.repeat(Math.max(0, width - 2))}┘`, { fg: options.theme.border, capability: options.capability }), width))
  return out
}
