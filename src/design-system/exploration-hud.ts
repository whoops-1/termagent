import path from 'node:path'
import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'
import type { ExplorationStateSnapshot, ExplorationRange } from '../context/exploration.js'
import type { ExplorationTelemetrySnapshot } from '../agent/exploration-telemetry.js'

export type ExplorationHUDMode = 'reading' | 'searching' | 'verifying' | 'thinking' | 'complete'

export type ExplorationHUDModel = {
  visible: boolean
  mode: ExplorationHUDMode
  subject: string
  percent?: number
  coveredLabel?: string
  remainingLabel?: string
  discoveryLabel?: string
  verificationLabel?: string
  counts: { files: number; ranges: number; searches: number; symbols: number }
}

function relativeSubject(cwd: string, value: string) {
  const relative = path.relative(cwd, value)
  return relative && !relative.startsWith('..') ? relative : value
}

function coveredLineCount(ranges: readonly ExplorationRange[]) {
  return ranges.reduce((sum, range) => sum + Math.max(0, range.endLine - range.startLine + 1), 0)
}
function inspectedLabel(ranges: readonly ExplorationRange[], totalLines: number) {
  if (!ranges.length || totalLines <= 0) return undefined
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine)
  const merged: ExplorationRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine)
    else merged.push({ ...range })
  }
  if (merged.length === 1) return `${rangeLabel(merged[0]!)} inspected`
  return `${coveredLineCount(merged).toLocaleString()} lines inspected`
}

function missingRanges(totalLines: number, covered: readonly ExplorationRange[]) {
  if (totalLines <= 0) return []
  const sorted = [...covered].sort((a, b) => a.startLine - b.startLine)
  const missing: ExplorationRange[] = []
  let cursor = 1
  for (const range of sorted) {
    if (range.endLine < cursor) continue
    if (range.startLine > cursor) missing.push({ startLine: cursor, endLine: Math.min(totalLines, range.startLine - 1) })
    cursor = Math.max(cursor, range.endLine + 1)
    if (cursor > totalLines) break
  }
  if (cursor <= totalLines) missing.push({ startLine: cursor, endLine: totalLines })
  return missing
}

function rangeLabel(range: ExplorationRange) {
  return range.startLine === range.endLine ? String(range.startLine) : `${range.startLine}-${range.endLine}`
}

function lastDiscovery(snapshot: ExplorationStateSnapshot) {
  const search = snapshot.searches.at(-1)
  if (search) {
    if (search.query) return search.path ? `${search.query} · ${relativeSubject(snapshot.cwd, search.path)}` : search.query
    if (search.path) return relativeSubject(snapshot.cwd, search.path)
    return `${search.kind} · ${search.discoveredFiles.length} file(s)`
  }
  const symbol = snapshot.symbols.at(-1)
  if (symbol) return symbol.path ? `${symbol.name} · ${relativeSubject(snapshot.cwd, symbol.path)}` : symbol.name
  return snapshot.lastProgress
}

function verificationLabel(snapshot: ExplorationStateSnapshot) {
  const facts = snapshot.settledVerificationFacts ?? []
  if (!facts.length) return undefined
  const last = facts.at(-1) ?? ''
  if (last.startsWith('lsp:clean:')) return 'LSP clean'
  if (last.startsWith('lsp:failed:')) return 'LSP diagnostics found'
  if (last.startsWith('lsp:timed_out:')) return 'LSP timed out'
  if (last.startsWith('lsp:cancelled:')) return 'LSP cancelled'
  if (last.startsWith('verify:')) return `verification settled · ${facts.length}`
  return `verification evidence · ${facts.length}`
}

export function buildExplorationHUDModel(snapshot: ExplorationStateSnapshot | undefined, telemetry: ExplorationTelemetrySnapshot | undefined, activeTool?: string, active = false): ExplorationHUDModel {
  if (!snapshot || !telemetry) return { visible: false, mode: 'thinking', subject: '', counts: { files: 0, ranges: 0, searches: 0, symbols: 0 } }

  const latestRead = snapshot.reads.at(-1)
  const latestFile = latestRead ? snapshot.files.find(file => file.canonicalPath === latestRead.canonicalPath) : undefined
  const covered = latestFile ? coveredLineCount(latestFile.coveredRanges) : 0
  const totalLines = latestFile?.totalLines ?? 0
  const percent = totalLines > 0 ? Math.min(100, Math.round((covered / totalLines) * 100)) : undefined
  const missing = totalLines > 0 ? missingRanges(totalLines, latestFile!.coveredRanges) : []
  const latestSearch = snapshot.searches.at(-1)
  const mode: ExplorationHUDMode = activeTool === 'read_file'
    ? 'reading'
    : activeTool === 'grep' || activeTool === 'glob' || activeTool === 'repo_map'
      ? 'searching'
      : telemetry.settledVerificationFacts > 0 && activeTool === 'verify_project'
        ? 'verifying'
        : totalLines > 0 && latestFile?.fullCoverage
          ? 'complete'
          : 'thinking'

  const remainingLabel = missing.length
    ? `${rangeLabel(missing[0]!)}${missing.length > 1 ? ` +${missing.length - 1}` : ''} remaining`
    : totalLines > 0 && latestFile?.fullCoverage ? 'file fully inspected' : undefined

  return {
    visible: active || telemetry.toolCalls > 0,
    mode,
    subject: latestFile ? relativeSubject(snapshot.cwd, latestFile.canonicalPath) : latestSearch?.path ? relativeSubject(snapshot.cwd, latestSearch.path) : 'repository',
    percent,
    coveredLabel: latestFile && totalLines > 0 ? inspectedLabel(latestFile.coveredRanges, totalLines) : latestFile?.fullCoverage ? 'full file inspected' : undefined,
    remainingLabel,
    discoveryLabel: lastDiscovery(snapshot),
    verificationLabel: verificationLabel(snapshot),
    counts: { files: snapshot.discoveredFiles.length, ranges: snapshot.files.reduce((total, file) => total + file.coveredRanges.length, 0), searches: snapshot.searches.length, symbols: snapshot.symbols.length },
  }
}

function bar(percent: number, width: number, theme: Theme, capability: ColorCapability) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  const empty = Math.max(0, width - filled)
  return `${paint('█'.repeat(filled), { fg: theme.primary, capability })}${paint('░'.repeat(empty), { fg: theme.subtle, capability })}`
}

export function renderExplorationHUD(options: {
  width: number
  theme: Theme
  capability: ColorCapability
  model: ExplorationHUDModel
  compact?: boolean
}) {
  const width = Math.max(24, options.width)
  const theme = options.theme
  const capability = options.capability
  const model = options.model
  if (!model.visible) return []
  const compact = options.compact ?? width < 58
  const title = model.mode === 'reading' ? 'READING' : model.mode === 'searching' ? 'EXPLORING' : model.mode === 'verifying' ? 'VERIFYING' : model.mode === 'complete' ? 'EXPLORATION COMPLETE' : 'EXPLORING'

  if (compact) {
    const percent = model.percent !== undefined ? ` ${model.percent}%` : ''
    const detail = model.remainingLabel ?? model.discoveryLabel ?? `${model.counts.files} file(s) · ${model.counts.searches} searches`
    const raw = `  ${title} · ${clip(model.subject, Math.max(8, width - title.length - percent.length - 8))}${percent} · ${clip(detail, Math.max(8, width - 18))}`
    return [padRight(paint(raw, { fg: theme.muted, bg: theme.panel, capability }), width)]
  }

  const inner = Math.max(18, width - 6)
  const rows: string[] = []
  rows.push(padRight(`${paint('┌', { fg: theme.border, capability })}${paint(` ${title} `, { fg: theme.primary, capability, attrs: { bold: true } })}${paint('─'.repeat(Math.max(0, width - widthOf(title) - 9)), { fg: theme.border, capability })}${paint('┐', { fg: theme.border, capability })}`, width))
  rows.push(padRight(`${paint('│', { fg: theme.border, capability })} ${paint(clip(model.subject, inner), { fg: theme.text, capability, attrs: { bold: true } })}`, width))
  if (model.percent !== undefined) rows.push(padRight(`${paint('│', { fg: theme.border, capability })} ${bar(model.percent, Math.max(10, inner - 8), theme, capability)} ${paint(`${model.percent}%`, { fg: theme.text, capability, attrs: { bold: true } })}`, width))
  if (model.coveredLabel) rows.push(padRight(`${paint('│', { fg: theme.border, capability })} ${paint('✓', { fg: theme.success, capability })} ${clip(model.coveredLabel, inner - 3)}`, width))
  if (model.remainingLabel) rows.push(padRight(`${paint('│', { fg: theme.border, capability })} ${paint('•', { fg: theme.warning, capability })} ${clip(model.remainingLabel, inner - 3)}`, width))
  if (model.discoveryLabel) rows.push(padRight(`${paint('│', { fg: theme.border, capability })}`, width))
  if (model.discoveryLabel) rows.push(padRight(`${paint('│', { fg: theme.border, capability })} ${paint('Last discovery', { fg: theme.muted, capability, attrs: { bold: true } })}`, width))
  if (model.discoveryLabel) rows.push(padRight(`${paint('│', { fg: theme.border, capability })} ${clip(model.discoveryLabel, inner)}`, width))
  if (model.verificationLabel) rows.push(padRight(`${paint('│', { fg: theme.border, capability })} ${paint('✓', { fg: theme.success, capability })} ${clip(model.verificationLabel, inner - 3)}`, width))
  rows.push(padRight(`${paint('│', { fg: theme.border, capability })} ${paint(`${model.counts.files} files · ${model.counts.ranges} ranges · ${model.counts.searches} discoveries · ${model.counts.symbols} symbols`, { fg: theme.muted, capability })}`, width))
  rows.push(padRight(`${paint('└', { fg: theme.border, capability })}${paint('─'.repeat(Math.max(0, width - 2)), { fg: theme.border, capability })}${paint('┘', { fg: theme.border, capability })}`, width))
  return rows
}
