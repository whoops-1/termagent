import { clip, paint, padRight, widthOf } from './ansi.js'
import { renderMarkdown } from './markdown.js'
import type { ColorCapability, Theme } from './types.js'
import { statusDescriptor, toolStatus } from './status.js'
import { contentWidth } from './geometry.js'

export type TranscriptTool = {
  name: string
  summary: string
  running?: boolean
  waiting?: boolean
  durationMs?: number
  additions?: number
  deletions?: number
  hasDiff?: boolean
}

export type TranscriptSystem = {
  text: string
  tone?: 'dim' | 'warn' | 'error'
}

function fit(text: string, width: number) {
  return clip(text, Math.max(1, width))
}

function renderPanelLine(line: string, width: number, borderColor: string, panelColor: string, theme: Theme, capability: ColorCapability) {
  const innerWidth = Math.max(1, contentWidth(width, { borderLeft: 1, borderRight: 0, paddingLeft: 2, paddingRight: 0 }))
  const content = `  ${fit(line, innerWidth)}`
  const trailing = ' '.repeat(Math.max(0, width - 1 - widthOf(content)))
  return `${paint('│', { fg: borderColor, capability })}${paint(content, { fg: theme.text, bg: panelColor, capability })}${paint(trailing, { bg: panelColor, capability })}`
}

export function renderUserTurn(options: {
  text: string
  width: number
  theme: Theme
  capability: ColorCapability
}) {
  const { text, width, theme, capability } = options
  const bodyWidth = Math.max(8, contentWidth(width, { borderLeft: 1, borderRight: 0, paddingLeft: 2, paddingRight: 2 }))
  const body = renderMarkdown(text, { width: bodyWidth, theme, capability })
  const headerRaw = 'You'
  const header = `${paint('│', { fg: theme.user, capability })}${paint(`  ${headerRaw}`, { fg: theme.user, capability, attrs: { bold: true } })}${' '.repeat(Math.max(0, width - 4 - widthOf(headerRaw)))} `
  const rows = [header.padEnd(width, ' '), ...body.map(line => renderPanelLine(line, width, theme.user, theme.surface, theme, capability))]
  return rows.map(row => padRight(row, width))
}

export function renderAssistantTurn(options: {
  text: string
  reasoning?: string
  width: number
  theme: Theme
  capability: ColorCapability
  reasoningVisible?: boolean
}) {
  const { text, reasoning, width, theme, capability, reasoningVisible = false } = options
  const rows: string[] = []
  if (reasoning) {
    const chars = reasoning.length.toLocaleString()
    const label = reasoningVisible ? 'Reasoning' : 'Reasoning available'
    const reasoningSummary = `${paint('∴', { fg: theme.reasoning, capability })} ${paint(label, { fg: theme.reasoning, capability, attrs: { bold: true } })} ${paint(`· ${chars} chars`, { fg: theme.muted, capability })} ${paint('· Ctrl+E inspect', { fg: theme.muted, capability })}`
    rows.push(`  ${fit(reasoningSummary, Math.max(1, width - 2))}`)
    if (reasoningVisible) {
      const reasoningLines = renderMarkdown(reasoning, { width: Math.max(8, contentWidth(width, { borderLeft: 0, borderRight: 0, paddingLeft: 2, paddingRight: 2 })), theme, capability })
      rows.push(...reasoningLines.map(line => `  ${paint('│', { fg: theme.reasoning, capability })} ${line}`))
    }
  }
  if (text) {
    const body = renderMarkdown(text, { width: Math.max(8, contentWidth(width, { borderLeft: 0, borderRight: 0, paddingLeft: 2, paddingRight: 2 })), theme, capability })
    rows.push(...body.map(line => `  ${line}`))
  } else if (!reasoning) {
    rows.push(`  ${paint('… waiting for response', { fg: theme.muted, capability, attrs: { dim: true } })}`)
  }
  rows.push('')
  return rows.map(row => padRight(row, width))
}

export function renderToolActivity(options: {
  tool: TranscriptTool
  width: number
  theme: Theme
  capability: ColorCapability
}) {
  const { tool, width, theme, capability } = options
  const uiStatus = toolStatus({ running: tool.running, waiting: tool.waiting })
  const descriptor = statusDescriptor(uiStatus)
  const state = descriptor.label
  const color = tool.waiting ? theme.warning : tool.running ? theme.tool : theme.success
  const marker = uiStatus === 'done' ? '✓' : uiStatus === 'waiting' ? '!' : '→'
  const elapsed = tool.durationMs == null ? '' : ` · ${(tool.durationMs / 1000).toFixed(1)}s`
  const diff = tool.hasDiff ? ` · +${tool.additions ?? 0} -${tool.deletions ?? 0}` : ''
  const prefixRaw = clip(`  ${marker} ${tool.name}`, Math.max(1, width - 1))
  const prefix = paint(prefixRaw, { fg: theme.text, capability, attrs: { bold: true } })
  const suffixRaw = ` · ${state}${elapsed}${diff}`
  const suffixBudget = Math.max(0, width - widthOf(prefixRaw) - 2)
  const suffixRawClipped = suffixBudget > 0 ? clip(suffixRaw, suffixBudget) : ''
  const suffix = suffixRawClipped ? paint(suffixRawClipped, { fg: theme.muted, capability }) : ''
  const summaryWidth = Math.max(0, width - widthOf(prefixRaw) - 1 - widthOf(suffixRawClipped))
  const summary = summaryWidth > 0 ? paint(fit(tool.summary, summaryWidth), { fg: theme.muted, capability }) : ''
  const line = `${prefix}${summary ? ` ${summary}` : ''}${suffix}`
  return [padRight(clip(line, width), width), '']
}

export function renderSystemRow(options: {
  system: TranscriptSystem
  width: number
  theme: Theme
  capability: ColorCapability
}) {
  const { system, width, theme, capability } = options
  const color = system.tone === 'error' ? theme.error : system.tone === 'warn' ? theme.warning : theme.muted
  const icon = system.tone === 'error' ? '!' : system.tone === 'warn' ? '⚠' : '•'
  const bodyWidth = Math.max(8, contentWidth(width, { borderLeft: 1, borderRight: 0, paddingLeft: 2, paddingRight: 2 }))
  const lines = system.text.split(/\r?\n/)
  const out = lines.flatMap(line => {
    const chunks = renderMarkdown(line, { width: bodyWidth, theme, capability })
    return chunks.map(chunk => `  ${paint(icon, { fg: color, capability })} ${chunk}`)
  })
  out.push('')
  return out.map(line => padRight(line, width))
}
