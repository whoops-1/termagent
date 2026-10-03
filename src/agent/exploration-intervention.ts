import type { ExplorationStateSnapshot } from '../context/exploration.js'
import type { ToolLoopAction, SemanticIntervention } from './loop-guard.js'

const EXPLORATION_TOOLS = new Set(['read_file', 'grep', 'glob', 'repo_map'])

function short(value: unknown, limit = 120): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(1, limit - 1))}…`
}

function actionDescription(action: ToolLoopAction): string {
  const args = action.input && typeof action.input === 'object' && !Array.isArray(action.input)
    ? action.input as Record<string, unknown>
    : {}
  if (action.toolName === 'read_file') {
    const file = short(args.path ?? args.filePath ?? args.file, 100) || '(path not recorded)'
    const start = Number.isSafeInteger(Number(args.startLine)) ? Number(args.startLine) : undefined
    const end = Number.isSafeInteger(Number(args.endLine)) ? Number(args.endLine) : undefined
    return `${file}${start !== undefined ? `:${start}${end !== undefined ? `-${end}` : ''}` : ''}`
  }
  if (action.toolName === 'grep') {
    const pattern = short(args.pattern ?? args.query, 90) || '(pattern not recorded)'
    const path = short(args.path ?? args.cwd, 70)
    return path ? `${pattern} @ ${path}` : pattern
  }
  if (action.toolName === 'glob') {
    const pattern = short(args.pattern, 100) || '(pattern not recorded)'
    const path = short(args.path ?? args.cwd, 70)
    return path ? `${pattern} @ ${path}` : pattern
  }
  if (action.toolName === 'repo_map') {
    const focusFiles = Array.isArray(args.focusFiles) ? args.focusFiles.map(value => short(value, 50)).filter(Boolean).slice(0, 3) : []
    const focusSymbols = Array.isArray(args.focusSymbols) ? args.focusSymbols.map(value => short(value, 50)).filter(Boolean).slice(0, 3) : []
    const focus = [...focusFiles.map(value => `file:${value}`), ...focusSymbols.map(value => `symbol:${value}`)]
    return focus.length ? focus.join(', ') : 'repository structure'
  }
  return action.toolName
}

function currentCoverage(snapshot: ExplorationStateSnapshot, action: ToolLoopAction): string | undefined {
  if (action.toolName !== 'read_file') return undefined
  const args = action.input && typeof action.input === 'object' && !Array.isArray(action.input)
    ? action.input as Record<string, unknown>
    : {}
  const rawPath = args.path ?? args.filePath ?? args.file
  if (typeof rawPath !== 'string' || !rawPath.trim()) return undefined
  const file = snapshot.files.find(item => item.canonicalPath === rawPath || item.canonicalPath.endsWith(`/${rawPath.replace(/^\.\//, '')}`))
  if (!file) return undefined
  const ranges = file.coveredRanges.slice(0, 8).map(range => `${range.startLine}-${range.endLine}`).join(', ')
  return ranges || undefined
}

export function explorationInterventionMessage(
  intervention: SemanticIntervention,
  actions: readonly ToolLoopAction[],
  snapshot: ExplorationStateSnapshot,
  count: number,
): string {
  const tracked = actions.filter(action => EXPLORATION_TOOLS.has(action.toolName))
  const subjects = tracked.slice(0, 4).map(action => actionDescription(action))
  const subjectText = subjects.length ? subjects.join('; ') : 'the previous exploration action'

  if (intervention === 'nudge') {
    return [
      'EXPLORATION STRATEGY NUDGE:',
      `Round ${count} produced no new semantic evidence (${subjectText}).`,
      'Change strategy instead of repeating the same evidence-producing action.',
      'Use repo_map for structure when useful, glob for file-pattern discovery, grep for content or symbols, and read_file only for known paths or uncovered ranges.',
      'Parallelize independent read/search calls when safe. If a file/range is already covered, continue from uncovered lines or synthesize from the evidence already collected.',
    ].join('\n')
  }

  if (intervention === 'constrain') {
    const coverage = tracked
      .map(action => currentCoverage(snapshot, action))
      .filter((value): value is string => Boolean(value))
      .slice(0, 3)
    const coverageText = coverage.length ? ` Current read coverage includes: ${coverage.join('; ')}.` : ''
    return [
      'EXPLORATION STRATEGY CONSTRAINT:',
      `The last ${count} exploration rounds produced no new semantic evidence. The redundant action is now constrained: ${subjectText}.${coverageText}`,
      'Choose a different tool, query/path, or uncovered range. Do not vary only cosmetic arguments, output limits, probes, or generated identifiers.',
    ].join('\n')
  }

  const fileCount = snapshot.discoveredFiles.length
  const readCount = snapshot.reads.length
  const searchCount = snapshot.searches.length
  const symbolCount = snapshot.symbols.length
  return [
    'EXPLORATION SUBTASK STOPPED:',
    `The exploration produced no new semantic evidence for ${count} consecutive rounds.`,
    `Collected evidence: ${fileCount} discovered file(s), ${readCount} bounded read observation(s), ${searchCount} search observation(s), ${symbolCount} symbol(s).`,
    snapshot.lastProgress ? `Last recorded meaningful progress: ${snapshot.lastProgress}.` : 'No additional meaningful progress was recorded.',
    'Do not make additional exploration tool calls. Summarize what was established and identify any evidence that remains missing.',
  ].join('\n')
}

export function explorationInterventionToolActions(
  actions: readonly ToolLoopAction[],
): ToolLoopAction[] {
  return actions.filter(action => EXPLORATION_TOOLS.has(action.toolName))
}
