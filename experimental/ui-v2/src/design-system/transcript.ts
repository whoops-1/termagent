import { clip, paint, padRight, widthOf } from './ansi.js'
import { renderMarkdown } from './markdown.js'
import type { ColorCapability, Theme } from './types.js'

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

function roleLabel(label: string, color: string, width: number, theme: Theme, capability: ColorCapability) {
  const prefix = paint('◆', { fg: color, capability })
  const name = paint(` ${label}`, { fg: theme.text, capability, attrs: { bold: true } })
  return fit(`${prefix}${name}`, width)
}

export function renderUserTurn(options: {
  text: string
  width: number
  theme: Theme
  capability: ColorCapability
}) {
  const { text, width, theme, capability } = options
  const inner = Math.max(8, width - 2)
  const rows = [roleLabel('You', theme.user, inner, theme, capability)]
  const bodyWidth = Math.max(8, width - 5)
  const body = renderMarkdown(text, { width: bodyWidth, theme, capability })
  for (const line of body) rows.push(`  ${line}`)
  rows.push('')
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
  const inner = Math.max(8, width - 2)
  const rows = [roleLabel('TermAgent', theme.assistant, inner, theme, capability)]
  if (reasoning) {
    const chars = reasoning.length.toLocaleString()
    const label = reasoningVisible ? 'Reasoning' : 'Reasoning available'
    const reasoningSummary = `${paint('∴', { fg: theme.reasoning, capability })} ${paint(label, { fg: theme.reasoning, capability, attrs: { bold: true } })} ${paint(`· ${chars} chars`, { fg: theme.muted, capability })} ${paint('· Ctrl+E inspect', { fg: theme.muted, capability })}`
    rows.push(`  ${fit(reasoningSummary, Math.max(1, width - 2))}`)
    if (reasoningVisible) {
      const reasoningLines = renderMarkdown(reasoning, { width: Math.max(8, width - 5), theme, capability })
      rows.push(...reasoningLines.map(line => `  ${paint('│', { fg: theme.reasoning, capability })} ${line}`))
    }
  }
  if (text) {
    const body = renderMarkdown(text, { width: Math.max(8, width - 5), theme, capability })
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
  const color = tool.waiting ? theme.warning : tool.running ? theme.tool : theme.success
  const marker = tool.waiting ? '◆' : tool.running ? '→' : '✓'
  const state = tool.waiting ? 'awaiting approval' : tool.running ? 'running' : 'completed'
  const elapsed = tool.durationMs == null ? '' : ` · ${(tool.durationMs / 1000).toFixed(1)}s`
  const diff = tool.hasDiff ? ` · +${tool.additions ?? 0} -${tool.deletions ?? 0}` : ''
  const prefix = `  ${paint(marker, { fg: color, capability })} ${paint(tool.name, { fg: theme.text, capability, attrs: { bold: true } })}`
  const suffix = `${paint(` · ${state}${elapsed}${diff}`, { fg: theme.muted, capability })}`
  const prefixWidth = widthOf(`${marker} ${tool.name}`) + 2
  const summaryWidth = Math.max(8, width - prefixWidth - widthOf(` · ${state}${elapsed}${diff}`) - 1)
  const line = `${prefix} ${paint(fit(tool.summary, summaryWidth), { fg: theme.muted, capability })}${suffix}`
  return [padRight(line, width), '']
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
  const bodyWidth = Math.max(8, width - 5)
  const lines = system.text.split(/\r?\n/)
  const out = lines.flatMap(line => {
    const chunks = renderMarkdown(line, { width: bodyWidth, theme, capability })
    return chunks.map(chunk => `  ${paint(icon, { fg: color, capability })} ${chunk}`)
  })
  out.push('')
  return out.map(line => padRight(line, width))
}
