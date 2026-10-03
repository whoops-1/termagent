import crypto from 'node:crypto'
import { canonicalJson } from '../util/canonical.js'
import type { ToolCallLifecycleRecord } from './tool-call-lifecycle.js'
import type { ExplorationStateSnapshot } from '../context/exploration.js'

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    if (['callId', 'turnId', 'taskId', 'taskID', 'childSessionId', 'sessionId', 'outputReference', 'outputPath', 'startedAt', 'endedAt', 'durationMs', 'timestamp', 'createdAt', 'updatedAt', 'repeatedCallCount', 'noProgressRounds'].includes(key)) continue
    result[key] = stable(record[key])
  }
  return result
}

// Tool lifecycle is durable execution bookkeeping, not semantic exploration state.
// Every completed read appends another lifecycle record even when the underlying
// repository evidence is unchanged, so including lifecycle records here would
// manufacture semantic progress and defeat the no-progress guard.
function explorationProjection(exploration: ExplorationStateSnapshot) {
  return {
    discoveredFiles: exploration.discoveredFiles,
    files: exploration.files.map(file => ({
      canonicalPath: file.canonicalPath,
      mtimeMs: file.mtimeMs,
      size: file.size,
      totalLines: file.totalLines,
      contentHash: file.contentHash,
      coveredRanges: file.coveredRanges,
      fullCoverage: file.fullCoverage,
    })),
    searches: exploration.searches.map(search => ({
      kind: search.kind,
      query: search.query,
      path: search.path,
      include: search.include,
      discoveredFiles: [...search.discoveredFiles].sort(),
      symbols: [...search.symbols].sort(),
      resultKeys: [...search.resultKeys].sort(),
    })),
    symbols: exploration.symbols,
    settledVerificationFacts: exploration.settledVerificationFacts ?? [],
    progressRevision: exploration.progressRevision,
  }
}

export function buildSemanticProgressSnapshot(input: {
  exploration: ExplorationStateSnapshot
  todos?: readonly { task: string; status: string; priority?: string }[]
  mutations?: readonly unknown[]
  toolLifecycle?: readonly ToolCallLifecycleRecord[]
  workflow?: unknown
}) {
  return stable({
    exploration: explorationProjection(input.exploration),
    todos: [...(input.todos ?? [])].map(item => ({ task: item.task, status: item.status, priority: item.priority })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    mutations: (input.mutations ?? []).map(stable).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    workflow: stable(input.workflow),
  })
}

export function semanticProgressFingerprint(input: {
  exploration: ExplorationStateSnapshot
  todos?: readonly { task: string; status: string; priority?: string }[]
  mutations?: readonly unknown[]
  toolLifecycle?: readonly ToolCallLifecycleRecord[]
  workflow?: unknown
}): string {
  return crypto.createHash('sha256').update(canonicalJson(buildSemanticProgressSnapshot(input))).digest('hex')
}
