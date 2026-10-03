import crypto from 'node:crypto'

export const LSP_DIAGNOSTIC_STATE_VERSION = 1 as const

export type LspDiagnosticStatus =
  | 'unknown'
  | 'running'
  | 'provisional'
  | 'clean'
  | 'failed'
  | 'timed_out'
  | 'cancelled'

export type LspDiagnosticSeverity = number | string | undefined

export interface LspDiagnostic {
  message: string
  severity?: LspDiagnosticSeverity
  range?: unknown
  source?: string
  code?: string | number
}

export interface LspDiagnosticPublication {
  diagnostics: readonly LspDiagnostic[]
  timestamp?: number
}

export interface LspDiagnosticSnapshot {
  version: typeof LSP_DIAGNOSTIC_STATE_VERSION
  key: string
  serverId: string
  filePath: string
  status: LspDiagnosticStatus
  diagnostics: LspDiagnostic[]
  errorCount: number
  warningCount: number
  publicationCount: number
  startedAt?: number
  lastPublicationAt?: number
  settledAt?: number
  reason?: string
}

export interface LspDiagnosticTrackerOptions {
  quiescenceMs?: number
  minSettleMs?: number
  budgetMs?: number
  now?: () => number
}

interface MutableEntry {
  snapshot: LspDiagnosticSnapshot
}

const DEFAULT_QUIESCENCE_MS = 700
const DEFAULT_MIN_SETTLE_MS = 1500
const DEFAULT_BUDGET_MS = 5000
const MAX_DIAGNOSTICS_PER_FILE = 40
const MAX_FILES = 64

function clampDuration(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(300_000, Math.max(1, Math.floor(number))) : fallback
}

function diagnosticKey(diagnostic: LspDiagnostic): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      message: diagnostic.message,
      severity: diagnostic.severity,
      range: diagnostic.range,
      source: diagnostic.source,
      code: diagnostic.code,
    }))
    .digest('hex')
}

function dedupeDiagnostics(diagnostics: readonly LspDiagnostic[]): LspDiagnostic[] {
  const seen = new Set<string>()
  const result: LspDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      message: String(diagnostic.message ?? ''),
      ...(diagnostic.severity === undefined ? {} : { severity: diagnostic.severity }),
      ...(diagnostic.range === undefined ? {} : { range: diagnostic.range }),
      ...(diagnostic.source === undefined ? {} : { source: String(diagnostic.source) }),
      ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
    })
    if (result.length >= MAX_DIAGNOSTICS_PER_FILE) break
  }
  return result
}

function severityNumber(value: LspDiagnosticSeverity): number {
  if (typeof value === 'number') return value
  switch (String(value ?? '').toLowerCase()) {
    case 'error': return 1
    case 'warning': return 2
    case 'info': return 3
    case 'hint': return 4
    default: return 4
  }
}

function counts(diagnostics: readonly LspDiagnostic[]) {
  let errorCount = 0
  let warningCount = 0
  for (const diagnostic of diagnostics) {
    const severity = severityNumber(diagnostic.severity)
    if (severity === 1) errorCount += 1
    else if (severity === 2) warningCount += 1
  }
  return { errorCount, warningCount }
}

export class LspDiagnosticTracker {
  private readonly entries = new Map<string, MutableEntry>()
  private readonly quiescenceMs: number
  private readonly minSettleMs: number
  private readonly budgetMs: number
  private readonly now: () => number

  constructor(options: LspDiagnosticTrackerOptions = {}) {
    this.quiescenceMs = clampDuration(options.quiescenceMs, DEFAULT_QUIESCENCE_MS)
    this.minSettleMs = clampDuration(options.minSettleMs, DEFAULT_MIN_SETTLE_MS)
    this.budgetMs = clampDuration(options.budgetMs, DEFAULT_BUDGET_MS)
    this.now = options.now ?? Date.now
  }

  begin(input: { key: string; serverId: string; filePath: string; startedAt?: number }): LspDiagnosticSnapshot {
    const startedAt = input.startedAt ?? this.now()
    const snapshot: LspDiagnosticSnapshot = {
      version: LSP_DIAGNOSTIC_STATE_VERSION,
      key: input.key,
      serverId: input.serverId,
      filePath: input.filePath,
      status: 'running',
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      publicationCount: 0,
      startedAt,
    }
    this.entries.delete(input.key)
    if (this.entries.size >= MAX_FILES) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest === 'string') this.entries.delete(oldest)
    }
    this.entries.set(input.key, { snapshot })
    return this.clone(snapshot)
  }

  publish(key: string, publication: LspDiagnosticPublication): LspDiagnosticSnapshot {
    const entry = this.entries.get(key)
    if (!entry) {
      return this.unknown(key)
    }
    if (isTerminal(entry.snapshot.status)) return this.clone(entry.snapshot)

    const timestamp = publication.timestamp ?? this.now()
    const diagnostics = dedupeDiagnostics(publication.diagnostics)
    const diagnosticCounts = counts(diagnostics)
    entry.snapshot = {
      ...entry.snapshot,
      status: 'provisional',
      diagnostics,
      errorCount: diagnosticCounts.errorCount,
      warningCount: diagnosticCounts.warningCount,
      publicationCount: entry.snapshot.publicationCount + 1,
      lastPublicationAt: timestamp,
      ...(entry.snapshot.settledAt === undefined ? {} : { settledAt: undefined }),
      ...(entry.snapshot.reason === undefined ? {} : { reason: undefined }),
    }
    return this.clone(entry.snapshot)
  }

  fail(key: string, reason: string, at = this.now()): LspDiagnosticSnapshot {
    return this.finish(key, 'failed', reason, at)
  }

  cancel(key: string, reason = 'diagnostics cancelled', at = this.now()): LspDiagnosticSnapshot {
    return this.finish(key, 'cancelled', reason, at)
  }

  status(key: string, at = this.now()): LspDiagnosticSnapshot {
    const entry = this.entries.get(key)
    if (!entry) return this.unknown(key)
    if (isTerminal(entry.snapshot.status)) return this.clone(entry.snapshot)

    const snapshot = entry.snapshot
    if (snapshot.startedAt !== undefined && at - snapshot.startedAt >= this.budgetMs) {
      return this.finish(key, 'timed_out', `diagnostic budget ${this.budgetMs}ms expired`, at)
    }

    if (snapshot.publicationCount === 0) {
      entry.snapshot = { ...snapshot, status: 'running' }
      return this.clone(entry.snapshot)
    }

    const lastPublicationAt = snapshot.lastPublicationAt ?? at
    if (at - lastPublicationAt < this.quiescenceMs) {
      entry.snapshot = { ...snapshot, status: 'provisional' }
      return this.clone(entry.snapshot)
    }

    const startedAt = snapshot.startedAt ?? at
    if (snapshot.errorCount === 0 && at - startedAt < this.minSettleMs) {
      entry.snapshot = { ...snapshot, status: 'provisional' }
      return this.clone(entry.snapshot)
    }

    const finalStatus: LspDiagnosticStatus = snapshot.errorCount > 0 ? 'failed' : 'clean'
    return this.finish(key, finalStatus, undefined, at)
  }

  get(key: string): LspDiagnosticSnapshot {
    const entry = this.entries.get(key)
    if (!entry) return this.unknown(key)
    return this.clone(entry.snapshot)
  }

  list(): LspDiagnosticSnapshot[] {
    return [...this.entries.values()].map(entry => this.status(entry.snapshot.key)).sort((a, b) => a.key.localeCompare(b.key))
  }

  async waitForSettled(key: string, options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<LspDiagnosticSnapshot> {
    const pollMs = Math.min(250, Math.max(5, Math.floor(Number(options.pollMs) || 50)))
    while (true) {
      if (options.signal?.aborted) return this.cancel(key, 'diagnostics cancelled by abort signal')
      const snapshot = this.status(key)
      if (isTerminal(snapshot.status)) return snapshot
      await new Promise<void>(resolve => setTimeout(resolve, pollMs))
    }
  }

  verificationRecord(key: string) {
    const snapshot = this.status(key)
    return {
      tool: 'lsp_diagnostics',
      status: snapshot.status,
      ok: snapshot.status === 'clean',
      source: 'lsp' as const,
      serverId: snapshot.serverId,
      filePath: snapshot.filePath,
      diagnosticCount: snapshot.diagnostics.length,
      errorCount: snapshot.errorCount,
      warningCount: snapshot.warningCount,
      ...(snapshot.reason ? { reason: snapshot.reason } : {}),
    }
  }

  private finish(key: string, status: LspDiagnosticStatus, reason: string | undefined, at: number): LspDiagnosticSnapshot {
    const entry = this.entries.get(key)
    if (!entry) return this.unknown(key)
    const snapshot = entry.snapshot
    entry.snapshot = {
      ...snapshot,
      status,
      settledAt: at,
      ...(reason ? { reason } : {}),
    }
    return this.clone(entry.snapshot)
  }

  private unknown(key: string): LspDiagnosticSnapshot {
    return {
      version: LSP_DIAGNOSTIC_STATE_VERSION,
      key,
      serverId: '',
      filePath: '',
      status: 'unknown',
      diagnostics: [],
      errorCount: 0,
      warningCount: 0,
      publicationCount: 0,
    }
  }

  private clone(snapshot: LspDiagnosticSnapshot): LspDiagnosticSnapshot {
    return {
      ...snapshot,
      diagnostics: snapshot.diagnostics.map(item => ({ ...item })),
    }
  }
}

export function isTerminal(status: LspDiagnosticStatus): status is Exclude<LspDiagnosticStatus, 'unknown' | 'running' | 'provisional'> {
  return status === 'clean' || status === 'failed' || status === 'timed_out' || status === 'cancelled'
}

export function lspDiagnosticSemanticFingerprint(snapshot: LspDiagnosticSnapshot): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      serverId: snapshot.serverId,
      filePath: snapshot.filePath,
      status: snapshot.status,
      diagnostics: snapshot.diagnostics.map(diagnostic => ({
        message: diagnostic.message,
        severity: diagnostic.severity,
        range: diagnostic.range,
        source: diagnostic.source,
        code: diagnostic.code,
      })),
      errorCount: snapshot.errorCount,
      warningCount: snapshot.warningCount,
    }))
    .digest('hex')
}
