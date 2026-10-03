import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'

export type ComposerState = 'ready' | 'working' | 'queued' | 'question' | 'permission' | 'compacting' | 'error'

export type ComposerMeta = {
  state?: ComposerState
  provider?: string
  model?: string
  mode?: string
  contextTokens?: number
  contextLimit?: number
  queuedCount?: number
  activeTools?: number
  workspace?: string
  connection?: 'connected' | 'unknown' | 'error'
  hint?: string
  tip?: string
  modelLine?: string
}

function compactTokens(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}m`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(Math.max(0, Math.round(value)))
}

function stateLabel(state: ComposerState, queued: number) {
  switch (state) {
    case 'working': return queued ? `Working · ${queued} queued` : 'Working'
    case 'queued': return `Queued · ${queued}`
    case 'question': return 'Needs your answer'
    case 'permission': return 'Permission needed'
    case 'compacting': return 'Compacting context'
    case 'error': return 'Provider error'
    default: return 'Ready'
  }
}

function compactStateLabel(state: ComposerState, queued: number) {
  switch (state) {
    case 'working': return queued ? `Working·${queued}q` : 'Working'
    case 'queued': return `Queued·${queued}`
    case 'question': return 'Answer needed'
    case 'permission': return 'Permission'
    case 'compacting': return 'Compacting'
    case 'error': return 'Error'
    default: return 'Ready'
  }
}

function stateIcon(state: ComposerState) {
  switch (state) {
    case 'working': return '◐'
    case 'queued': return '⋯'
    case 'question': return '?'
    case 'permission': return '!'
    case 'compacting': return '↻'
    case 'error': return '×'
    default: return '●'
  }
}

function stateColor(state: ComposerState, theme: Theme) {
  switch (state) {
    case 'working': return theme.info
    case 'queued': return theme.primary
    case 'question': return theme.info
    case 'permission': return theme.warning
    case 'compacting': return theme.secondary
    case 'error': return theme.error
    default: return theme.success
  }
}

function cursorText(value: string, column: number) {
  const chars = Array.from(value)
  let used = 0
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    const w = widthOf(ch)
    if (column < used + w) return `${chars.slice(0, i).join('')}\x1b[7m${ch}\x1b[27m${chars.slice(i + 1).join('')}`
    used += w
  }
  return `${value}\x1b[7m \x1b[27m`
}

function frame(width: number, text: string, color: string, capability: ColorCapability) {
  return padRight(paint(`│${clip(text, Math.max(1, width - 2))}`, { fg: color, capability }), width)
}

function border(width: number, left: string, fill: string, right: string, theme: Theme, capability: ColorCapability) {
  return padRight(paint(`${left}${fill}${right}`, { fg: theme.border, capability }), width)
}

function densityFor(width: number): 'wide' | 'medium' | 'small' {
  if (width >= 84) return 'wide'
  if (width >= 52) return 'medium'
  return 'small'
}

function topLine(width: number, meta: ComposerMeta, theme: Theme, capability: ColorCapability, density: 'wide' | 'medium' | 'small') {
  const state = meta.state ?? 'ready'
  const queued = meta.queuedCount ?? 0
  const label = stateLabel(state, queued)
  const endpoint = meta.provider || meta.model ? `${meta.provider ? meta.provider : ''}${meta.model ? `/${meta.model}` : ''}` : 'provider/model'
  const ctx = meta.contextLimit != null ? `ctx ${compactTokens(meta.contextTokens)}/${compactTokens(meta.contextLimit)}` : ''
  const tool = (density === 'wide' && meta.activeTools) ? `${meta.activeTools} tool${meta.activeTools === 1 ? '' : 's'}` : ''
  const connection = meta.connection === 'error' ? 'offline' : ''
  const raw = density === 'small'
    ? ` ${stateIcon(state)} ${compactStateLabel(state, queued)}${ctx ? `  ${ctx}` : ''}`
    : ` ${stateIcon(state)} ${label}  ${endpoint}  ${ctx}${tool ? `  ${tool}` : ''}${connection ? `  ${connection}` : ''}`
  const content = clip(raw.trimStart(), Math.max(1, width - 5))
  const line = `╭─ ${content}${'─'.repeat(Math.max(0, width - 4 - widthOf(content)))}╮`
  return paint(line, { fg: stateColor(state, theme), capability, attrs: { bold: true } })
}

function bottomLine(width: number, meta: ComposerMeta, theme: Theme, capability: ColorCapability, density: 'wide' | 'medium' | 'small', hint?: string) {
  const inner = Math.max(8, width - 4)
  const modelLine = meta.modelLine || `${meta.mode ? meta.mode[0]!.toUpperCase() + meta.mode.slice(1) : 'Build'} · ${meta.model || 'No model'} ${meta.provider || 'provider'}`
  const workspace = meta.workspace ? compactPath(meta.workspace) : ''
  const rawHint = meta.tip || hint || meta.hint || (meta.queuedCount ? '↑↓ history · Ctrl+P commands · ↵ send · queued safely' : '↑↓ history · Ctrl+P commands · ↵ send')
  const textHint = density !== 'small' ? `Tip: ${rawHint}` : rawHint
  const left = density === 'wide' ? clip(modelLine, Math.max(10, Math.floor(inner * 0.48))) : density === 'medium' ? clip(modelLine, Math.max(8, Math.floor(inner * 0.50))) : clip(modelLine, inner)
  const middle = density === 'wide' && workspace ? clip(workspace, Math.max(8, Math.floor(inner * 0.20))) : ''
  const remaining = Math.max(8, inner - widthOf(left) - widthOf(middle) - (left ? 1 : 0) - (middle ? 1 : 0))
  const right = clip(textHint, remaining)
  const bodyParts = density === 'small' ? [left] : [left, middle, right].filter(Boolean)
  let body = bodyParts.length > 1 ? bodyParts.join(' ') : (bodyParts[0] || '')
  if (widthOf(body) > inner) body = clip(body, inner)
  return padRight(`${paint('│', { fg: theme.border, capability })}${paint(` ${body}`, { fg: theme.muted, capability, attrs: density === 'small' ? undefined : { bold: true } })}${paint('│', { fg: theme.border, capability })}`, width)
}

function compactPath(value: string) {
  if (value.length <= 34) return value
  return `…${value.slice(-33)}`
}

export function composerStateFrom(input: {
  turnActive: boolean
  queuedCount: number
  permission: boolean
  question: boolean
  statusTone?: 'dim' | 'warn' | 'error'
  activityPhase?: string
}): ComposerState {
  if (input.permission) return 'permission'
  if (input.question) return 'question'
  if (input.statusTone === 'error') return 'error'
  if (input.activityPhase === 'compacting') return 'compacting'
  if (input.turnActive) return 'working'
  return input.queuedCount ? 'queued' : 'ready'
}
export function renderComposer(options: {
  width: number
  inputLines: string[]
  inputCursor?: { row: number; column: number }
  showCursor?: boolean
  hiddenAbove?: boolean
  hiddenBelow?: boolean
  meta: ComposerMeta
  theme: Theme
  capability: ColorCapability
  hint?: string
}) {
  const width = Math.max(24, options.width)
  const inner = Math.max(10, width - 4)
  const density = densityFor(width)
  const out: string[] = []
  const horizontal = '─'.repeat(Math.max(0, width - 2))
  const inputLines = options.inputLines.length ? options.inputLines : ['']
  const maxInputRows = density === 'wide' ? 2 : 1
  const cursorRow = options.inputCursor?.row ?? 0
  const start = Math.max(0, Math.min(cursorRow, Math.max(0, inputLines.length - maxInputRows)))
  const visibleInput = inputLines.slice(start, start + maxInputRows)

  out.push(topLine(width, options.meta, options.theme, options.capability, density))

  visibleInput.forEach((line, index) => {
    const sourceRow = start + index
    const atTop = options.hiddenAbove && sourceRow === start && start > 0
    const atBottom = options.hiddenBelow && sourceRow === start + visibleInput.length - 1 && sourceRow < inputLines.length - 1
    const marker = atTop ? '↑ ' : '  '
    const suffix = atBottom ? '  ↓' : ''
    const cursor = options.showCursor && options.inputCursor && sourceRow === cursorRow
    const value = cursor ? cursorText(line, options.inputCursor!.column) : line
    const cleanWidth = Math.max(1, inner - widthOf(marker) - widthOf(suffix))
    const clipped = clip(value, cleanWidth)
    const body = `${marker}${clipped}${' '.repeat(Math.max(0, cleanWidth - widthOf(clipped)))}${suffix}`
    out.push(padRight(`${paint('│', { fg: options.theme.border, capability: options.capability })}${paint(body, { fg: options.theme.text, bg: options.theme.panel, capability: options.capability })}${paint('│', { fg: options.theme.border, capability: options.capability })}`, width))
  })

  out.push(bottomLine(width, options.meta, options.theme, options.capability, density, options.hint))
  out.push(border(width, '╰', horizontal, '╯', options.theme, options.capability))
  return out
}
