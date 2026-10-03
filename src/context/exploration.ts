import path from 'node:path'
import crypto from 'node:crypto'
import { canonicalJson } from '../util/canonical.js'

export const EXPLORATION_STATE_VERSION = 1 as const

export type ExplorationRange = { startLine: number; endLine: number }

export interface ExplorationFileState {
  canonicalPath: string
  mtimeMs?: number
  size?: number
  totalLines?: number
  contentHash?: string
  coveredRanges: ExplorationRange[]
  fullCoverage: boolean
}

export interface ExplorationReadObservation {
  canonicalPath: string
  requestedRange: ExplorationRange
  previouslyCovered: ExplorationRange[]
  newlyCovered: ExplorationRange[]
  resultingCoverage: ExplorationRange[]
  fullCoverage: boolean
  overlap: boolean
  overlapNoNewInfo: boolean
  versionKey: string
}

export interface ExplorationSearchObservation {
  kind: 'grep' | 'glob' | 'repo_map'
  signature: string
  query?: string
  path?: string
  include?: string
  discoveredFiles: string[]
  symbols: string[]
  resultKeys: string[]
}

export interface ExplorationSymbolObservation {
  name: string
  path?: string
  line?: number
  kind?: string
}

export interface ExplorationStateSnapshot {
  version: typeof EXPLORATION_STATE_VERSION
  cwd: string
  scopePaths: string[]
  discoveredFiles: string[]
  files: ExplorationFileState[]
  reads: ExplorationReadObservation[]
  searches: ExplorationSearchObservation[]
  symbols: ExplorationSymbolObservation[]
  settledVerificationFacts?: string[]
  progressRevision: number
  lastProgress?: string
}

export interface ExplorationEvidenceDelta {
  newFiles: string[]
  newRanges: ExplorationRange[]
  reconstructedRanges: ExplorationRange[]
  novelSearchResults: number
  newSymbols: ExplorationSymbolObservation[]
  settledVerificationFacts: string[]
}

export interface ExplorationObservation {
  meaningful: boolean
  reason: string
  newFiles: string[]
  newRanges: ExplorationRange[]
  newSearch: boolean
  overlap: boolean
  read?: ExplorationReadObservation
  evidence: ExplorationEvidenceDelta
}

const MAX_FILES = 256
const MAX_SYMBOLS = 512
const MAX_READS = 96
const MAX_SEARCHES = 96
const MAX_RESULT_KEYS_PER_SEARCH = 512
const MAX_VERIFICATION_FACTS = 128

function range(startLine: unknown, endLine: unknown): ExplorationRange | undefined {
  const start = Number(startLine)
  const end = Number(endLine ?? start)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return undefined
  return { startLine: start, endLine: end }
}

function mergeRanges(ranges: readonly ExplorationRange[]): ExplorationRange[] {
  if (!ranges.length) return []
  const sorted = ranges
    .map(item => ({ startLine: item.startLine, endLine: item.endLine }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
  const merged: ExplorationRange[] = [{ ...sorted[0]! }]
  for (const item of sorted.slice(1)) {
    const last = merged[merged.length - 1]!
    if (item.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, item.endLine)
    else merged.push({ ...item })
  }
  return merged
}

function subtract(target: ExplorationRange, covered: readonly ExplorationRange[]): ExplorationRange[] {
  const result: ExplorationRange[] = []
  let cursor = target.startLine
  for (const item of mergeRanges(covered)) {
    if (item.endLine < cursor) continue
    if (item.startLine > target.endLine) break
    if (item.startLine > cursor) result.push({ startLine: cursor, endLine: Math.min(target.endLine, item.startLine - 1) })
    cursor = Math.max(cursor, item.endLine + 1)
    if (cursor > target.endLine) break
  }
  if (cursor <= target.endLine) result.push({ startLine: cursor, endLine: target.endLine })
  return result
}

function canonicalPath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return path.resolve(cwd, value)
}

function versionEvidence(input: { mtimeMs?: unknown; size?: unknown; contentHash?: unknown; totalLines?: unknown }): Record<string, string | number> | undefined {
  const evidence: Record<string, string | number> = {}
  if (Number.isFinite(Number(input.mtimeMs))) evidence.mtimeMs = Number(input.mtimeMs)
  if (Number.isFinite(Number(input.size))) evidence.size = Number(input.size)
  if (Number.isSafeInteger(Number(input.totalLines))) evidence.totalLines = Number(input.totalLines)
  if (typeof input.contentHash === 'string' && input.contentHash.length > 0) evidence.contentHash = input.contentHash
  return Object.keys(evidence).length ? evidence : undefined
}

function versionKey(input: { mtimeMs?: unknown; size?: unknown; contentHash?: unknown; totalLines?: unknown }): string {
  return canonicalJson(versionEvidence(input) ?? {})
}

function versionChanged(evidence: Record<string, string | number> | undefined, file: ExplorationFileState): boolean {
  if (!evidence) return false
  for (const [key, value] of Object.entries(evidence)) {
    const previous = (file as unknown as Record<string, unknown>)[key]
    if (previous !== undefined && previous !== value) return true
  }
  return false
}

function uniqueStrings(values: readonly unknown[], limit: number): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map(value => value.trim()))].slice(0, limit)
}

function evidenceKey(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 32)
}

function emptyEvidence(): ExplorationEvidenceDelta {
  return {
    newFiles: [],
    newRanges: [],
    reconstructedRanges: [],
    novelSearchResults: 0,
    newSymbols: [],
    settledVerificationFacts: [],
  }
}

function searchPayload(toolName: string, args: Record<string, unknown>, metadata: Record<string, unknown>, cwd: string) {
  const source = (metadata.search ?? metadata.glob ?? metadata.repositoryMap) as Record<string, unknown> | undefined
  const discoveredFiles = uniqueStrings(
    toolName === 'glob'
      ? ((source?.discoveredFiles ?? metadata.discoveredFiles ?? []) as unknown[])
      : toolName === 'repo_map'
        ? ((source?.files ?? metadata.discoveredFiles ?? []) as unknown[])
        : ((source?.discoveredFiles ?? metadata.discoveredFiles ?? []) as unknown[]),
    MAX_FILES,
  )
  const symbols = toolName === 'repo_map'
    ? uniqueStrings((source?.symbols ?? metadata.symbols ?? []) as unknown[], MAX_SYMBOLS)
    : uniqueStrings((metadata.symbols ?? []) as unknown[], MAX_SYMBOLS)
  const matches = toolName === 'grep' && Array.isArray(source?.matches)
    ? source.matches.filter(item => item && typeof item === 'object').slice(0, MAX_RESULT_KEYS_PER_SEARCH) as Array<Record<string, unknown>>
    : []
  const resultKeys = [
    ...discoveredFiles.map(file => evidenceKey({ kind: toolName, file: path.resolve(cwd, file) })),
    ...symbols.map(symbol => evidenceKey({ kind: toolName, symbol })),
    ...matches.map(match => evidenceKey({
      kind: toolName,
      path: typeof match.path === 'string' ? path.resolve(cwd, match.path) : undefined,
      line: Number.isSafeInteger(Number(match.line)) ? Number(match.line) : undefined,
      text: typeof match.text === 'string' ? match.text : undefined,
    })),
  ]
  return { source, discoveredFiles, symbols, resultKeys: [...new Set(resultKeys)].slice(0, MAX_RESULT_KEYS_PER_SEARCH) }
}

function settledVerificationFacts(toolName: string, metadata: Record<string, unknown>): string[] {
  const lspRaw = metadata.lspDiagnostics
  if (lspRaw && typeof lspRaw === 'object' && !Array.isArray(lspRaw)) {
    const record = lspRaw as Record<string, unknown>
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : ''
    const terminal = ['clean', 'failed', 'timed_out', 'cancelled'].includes(status)
    if (!terminal) return []
    const serverId = typeof record.serverId === 'string' ? record.serverId : ''
    const filePath = typeof record.filePath === 'string' ? record.filePath : ''
    if (!serverId || !filePath) return []
    const diagnostics = Array.isArray(record.diagnostics)
      ? record.diagnostics.filter(item => item && typeof item === 'object').slice(0, 40)
      : []
    const signature = evidenceKey({
      kind: 'lsp-diagnostics',
      serverId,
      filePath,
      status,
      diagnosticCount: Number(record.diagnosticCount) || 0,
      errorCount: Number(record.errorCount) || 0,
      warningCount: Number(record.warningCount) || 0,
      diagnostics,
    })
    return [`lsp:${status}:${signature}`]
  }

  const raw = metadata.verificationFacts ?? metadata.verification
  if (Array.isArray(raw)) return uniqueStrings(raw, MAX_VERIFICATION_FACTS).filter(value => value.length <= 512)
  if (!raw || typeof raw !== 'object') return []
  const record = raw as Record<string, unknown>
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : ''
  const settled = record.settled === true || ['passed', 'pass', 'clean', 'failed', 'error', 'timed_out', 'cancelled', 'canceled', 'no_command'].includes(status)
  if (!settled) return []
  const facts = Array.isArray(record.facts) ? record.facts : [record.fact]
  const explicit = uniqueStrings(facts, MAX_VERIFICATION_FACTS).filter(value => value.length <= 512)
  if (explicit.length) return explicit
  if (toolName !== 'verify_project' || !status) return []

  // Verification commands may contain credentials or other sensitive literals.
  // Progress semantics need a stable identity, not the command text itself.
  const command = typeof record.command === 'string' ? record.command : ''
  const signature = evidenceKey({
    kind: 'verification',
    command,
    status,
    exitCode: Number.isSafeInteger(Number(record.exitCode)) ? Number(record.exitCode) : undefined,
    signal: typeof record.signal === 'string' ? record.signal : undefined,
  })
  return [`verify:${status}:${signature}`]
}

export class ExplorationState {
  private readonly files = new Map<string, ExplorationFileState>()
  private readonly reads: ExplorationReadObservation[] = []
  private readonly searches: ExplorationSearchObservation[] = []
  private readonly symbols = new Map<string, ExplorationSymbolObservation>()
  private readonly discovered = new Set<string>()
  private readonly verificationFacts = new Set<string>()
  private progressRevision = 0
  private lastProgress: string | undefined

  constructor(private readonly cwd: string, private readonly scopePaths: readonly string[] = []) {}

  snapshot(): ExplorationStateSnapshot {
    return {
      version: EXPLORATION_STATE_VERSION,
      cwd: this.cwd,
      scopePaths: [...this.scopePaths].map(value => path.resolve(this.cwd, value)).sort(),
      discoveredFiles: [...this.discovered].sort().slice(0, MAX_FILES),
      files: [...this.files.values()].map(item => ({
        ...item,
        coveredRanges: mergeRanges(item.coveredRanges),
      })).sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath)).slice(0, MAX_FILES),
      reads: this.reads.slice(-MAX_READS).map(item => ({
        ...item,
        previouslyCovered: mergeRanges(item.previouslyCovered),
        newlyCovered: mergeRanges(item.newlyCovered),
        resultingCoverage: mergeRanges(item.resultingCoverage),
      })),
      searches: this.searches.slice(-MAX_SEARCHES).map(item => ({
        ...item,
        discoveredFiles: [...item.discoveredFiles],
        symbols: [...item.symbols],
        resultKeys: [...item.resultKeys],
      })),
      symbols: [...this.symbols.values()].sort((a, b) => `${a.path ?? ''}\0${a.line ?? 0}\0${a.name}`.localeCompare(`${b.path ?? ''}\0${b.line ?? 0}\0${b.name}`)).slice(0, MAX_SYMBOLS),
      settledVerificationFacts: [...this.verificationFacts].slice(0, MAX_VERIFICATION_FACTS),
      progressRevision: this.progressRevision,
      ...(this.lastProgress ? { lastProgress: this.lastProgress } : {}),
    }
  }

  restore(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== 'object') return
    const value = snapshot as Partial<ExplorationStateSnapshot>
    if (value.version !== EXPLORATION_STATE_VERSION || typeof value.cwd !== 'string') return
    if (path.resolve(value.cwd) !== path.resolve(this.cwd)) return

    this.files.clear()
    this.reads.length = 0
    this.searches.length = 0
    this.symbols.clear()
    this.discovered.clear()
    this.verificationFacts.clear()

    for (const raw of Array.isArray(value.files) ? value.files.slice(0, MAX_FILES) : []) {
      if (!raw || typeof raw !== 'object' || typeof raw.canonicalPath !== 'string') continue
      const item = raw as ExplorationFileState
      const normalized = {
        canonicalPath: path.resolve(this.cwd, item.canonicalPath),
        mtimeMs: Number.isFinite(Number(item.mtimeMs)) ? Number(item.mtimeMs) : undefined,
        size: Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
        totalLines: Number.isSafeInteger(Number(item.totalLines)) ? Number(item.totalLines) : undefined,
        contentHash: typeof item.contentHash === 'string' ? item.contentHash : undefined,
        coveredRanges: mergeRanges(Array.isArray(item.coveredRanges) ? item.coveredRanges.map(value => range(value?.startLine, value?.endLine)).filter((value): value is ExplorationRange => Boolean(value)) : []),
        fullCoverage: Boolean(item.fullCoverage),
      }
      this.files.set(normalized.canonicalPath, normalized)
      this.discovered.add(normalized.canonicalPath)
    }
    for (const file of Array.isArray(value.discoveredFiles) ? value.discoveredFiles.slice(0, MAX_FILES) : []) {
      const resolved = canonicalPath(this.cwd, file)
      if (resolved) this.discovered.add(resolved)
    }
    for (const raw of Array.isArray(value.reads) ? value.reads.slice(-MAX_READS) : []) {
      if (!raw || typeof raw !== 'object' || typeof raw.canonicalPath !== 'string') continue
      const item = raw as ExplorationReadObservation
      const requestedRange = range(item.requestedRange?.startLine, item.requestedRange?.endLine)
      if (!requestedRange) continue
      this.reads.push({
        canonicalPath: path.resolve(this.cwd, item.canonicalPath),
        requestedRange,
        previouslyCovered: mergeRanges(item.previouslyCovered ?? []),
        newlyCovered: mergeRanges(item.newlyCovered ?? []),
        resultingCoverage: mergeRanges(item.resultingCoverage ?? []),
        fullCoverage: Boolean(item.fullCoverage),
        overlap: Boolean(item.overlap),
        overlapNoNewInfo: Boolean(item.overlapNoNewInfo),
        versionKey: typeof item.versionKey === 'string' ? item.versionKey : '',
      })
    }
    for (const raw of Array.isArray(value.searches) ? value.searches.slice(-MAX_SEARCHES) : []) {
      if (!raw || typeof raw !== 'object' || !['grep', 'glob', 'repo_map'].includes(raw.kind) || typeof raw.signature !== 'string') continue
      const item = raw as ExplorationSearchObservation
      this.searches.push({
        kind: item.kind,
        signature: item.signature,
        ...(typeof item.query === 'string' ? { query: item.query } : {}),
        ...(typeof item.path === 'string' ? { path: item.path } : {}),
        ...(typeof item.include === 'string' ? { include: item.include } : {}),
        discoveredFiles: uniqueStrings(item.discoveredFiles ?? [], MAX_FILES),
        symbols: uniqueStrings(item.symbols ?? [], MAX_SYMBOLS),
        resultKeys: uniqueStrings(item.resultKeys ?? [], MAX_RESULT_KEYS_PER_SEARCH),
      })
    }
    for (const raw of Array.isArray(value.symbols) ? value.symbols.slice(0, MAX_SYMBOLS) : []) {
      if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') continue
      const item = raw as ExplorationSymbolObservation
      const key = `${item.path ?? ''}\0${item.line ?? ''}\0${item.kind ?? ''}\0${item.name}`
      this.symbols.set(key, {
        name: item.name,
        ...(typeof item.path === 'string' ? { path: path.resolve(this.cwd, item.path) } : {}),
        ...(Number.isSafeInteger(Number(item.line)) ? { line: Number(item.line) } : {}),
        ...(typeof item.kind === 'string' ? { kind: item.kind } : {}),
      })
    }
    for (const fact of Array.isArray(value.settledVerificationFacts) ? value.settledVerificationFacts.slice(0, MAX_VERIFICATION_FACTS) : []) {
      if (typeof fact === 'string' && fact.trim() && fact.length <= 512) this.verificationFacts.add(fact.trim())
    }
    this.progressRevision = Number.isSafeInteger(Number(value.progressRevision)) && Number(value.progressRevision) >= 0 ? Number(value.progressRevision) : 0
    this.lastProgress = typeof value.lastProgress === 'string' ? value.lastProgress : undefined
  }

  observeTool(toolName: string, args: unknown, metadata: unknown): ExplorationObservation {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}
    const info = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {}
    const facts = settledVerificationFacts(toolName, info)
    let observation: ExplorationObservation
    if (toolName === 'read_file') observation = this.observeRead(input, info)
    else if (toolName === 'grep' || toolName === 'glob' || toolName === 'repo_map') observation = this.observeSearch(toolName, input, info)
    else if (facts.length) {
      const newFacts = facts.filter(fact => !this.verificationFacts.has(fact))
      for (const fact of newFacts) this.verificationFacts.add(fact)
      if (newFacts.length) {
        this.progressRevision += 1
        this.lastProgress = `verification settled ${newFacts.length} new fact(s)`
      }
      observation = {
        meaningful: newFacts.length > 0,
        reason: newFacts.length ? 'tool settled new verification evidence' : 'tool repeated known verification evidence',
        newFiles: [],
        newRanges: [],
        newSearch: false,
        overlap: false,
        evidence: { ...emptyEvidence(), settledVerificationFacts: newFacts },
      }
    } else {
      observation = { meaningful: false, reason: 'tool is not exploration-tracked', newFiles: [], newRanges: [], newSearch: false, overlap: false, evidence: emptyEvidence() }
    }
    if (!facts.length || toolName !== 'read_file' && toolName !== 'grep' && toolName !== 'glob' && toolName !== 'repo_map') return observation
    const newFacts = facts.filter(fact => !this.verificationFacts.has(fact))
    if (!newFacts.length) return observation
    for (const fact of newFacts) this.verificationFacts.add(fact)
    this.progressRevision += 1
    this.lastProgress = `${observation.reason}; verification settled ${newFacts.length} new fact(s)`
    return {
      ...observation,
      meaningful: true,
      reason: `${observation.reason}; settled verification evidence is new`,
      evidence: { ...observation.evidence, settledVerificationFacts: newFacts },
    }
  }

  private observeRead(args: Record<string, unknown>, metadata: Record<string, unknown>): ExplorationObservation {
    const rawPath = metadata.canonicalPath ?? args.path ?? args.filePath ?? args.file
    const canonical = canonicalPath(this.cwd, rawPath)
    const requestedRange = range(
      (metadata.requestedRange as Record<string, unknown> | undefined)?.startLine ?? metadata.lineStart ?? args.startLine ?? 1,
      (metadata.requestedRange as Record<string, unknown> | undefined)?.endLine ?? metadata.lineEnd ?? args.endLine ?? (Number(metadata.totalLines) || Number(args.startLine) || 1),
    )
    if (!canonical || !requestedRange) return { meaningful: false, reason: 'read_file result did not contain a canonical path and range', newFiles: [], newRanges: [], newSearch: false, overlap: false, evidence: emptyEvidence() }

    const sourceRanges = Array.isArray(metadata.returnedRanges) ? metadata.returnedRanges.map((item: unknown) => {
      if (!item || typeof item !== 'object') return undefined
      const value = item as Record<string, unknown>
      return range(value.startLine, value.endLine)
    }).filter((value): value is ExplorationRange => Boolean(value)) : ['already-covered', 'unchanged', 'rehydrated'].includes(String(metadata.cache)) ? [] : [requestedRange]
    const totalLines = Number.isSafeInteger(Number(metadata.totalLines)) ? Number(metadata.totalLines) : undefined
    const versionEvidenceValue = versionEvidence({ mtimeMs: metadata.mtimeMs, size: metadata.size, totalLines, contentHash: metadata.contentHash })
    const version = canonicalJson(versionEvidenceValue ?? {})
    let file = this.files.get(canonical)
    if (file && versionChanged(versionEvidenceValue, file)) {
      file = undefined
      this.files.delete(canonical)
      this.reads.splice(0, this.reads.length, ...this.reads.filter(item => item.canonicalPath !== canonical))
    }
    if (!file) {
      file = {
        canonicalPath: canonical,
        ...(Number.isFinite(Number(metadata.mtimeMs)) ? { mtimeMs: Number(metadata.mtimeMs) } : {}),
        ...(Number.isFinite(Number(metadata.size)) ? { size: Number(metadata.size) } : {}),
        ...(totalLines !== undefined ? { totalLines } : {}),
        ...(typeof metadata.contentHash === 'string' ? { contentHash: metadata.contentHash } : {}),
        coveredRanges: [],
        fullCoverage: false,
      }
      this.files.set(canonical, file)
    } else {
      if (Number.isFinite(Number(metadata.mtimeMs))) file.mtimeMs = Number(metadata.mtimeMs)
      if (Number.isFinite(Number(metadata.size))) file.size = Number(metadata.size)
      if (totalLines !== undefined) file.totalLines = totalLines
      if (typeof metadata.contentHash === 'string') file.contentHash = metadata.contentHash
    }

    const previouslyCovered = mergeRanges(file.coveredRanges)
    const effectiveReturned = mergeRanges(sourceRanges)
    const newlyCovered = effectiveReturned.flatMap(item => subtract(item, previouslyCovered))
    const resultingCoverage = mergeRanges([...previouslyCovered, ...effectiveReturned])
    file.coveredRanges = resultingCoverage
    file.fullCoverage = Boolean(file.totalLines !== undefined && file.totalLines > 0 && resultingCoverage.some(item => item.startLine === 1 && item.endLine >= file!.totalLines!))
    if (file.totalLines === 0) file.fullCoverage = true
    const wasDiscovered = this.discovered.has(canonical)
    this.discovered.add(canonical)

    const observation: ExplorationReadObservation = {
      canonicalPath: canonical,
      requestedRange,
      previouslyCovered,
      newlyCovered: mergeRanges(newlyCovered),
      resultingCoverage,
      fullCoverage: file.fullCoverage,
      overlap: previouslyCovered.some(item => item.startLine <= requestedRange.endLine && item.endLine >= requestedRange.startLine),
      overlapNoNewInfo: newlyCovered.length === 0,
      versionKey: version,
    }
    this.reads.push(observation)
    if (this.reads.length > MAX_READS) this.reads.splice(0, this.reads.length - MAX_READS)

    const reconstructedRanges = metadata.cache === 'rehydrated'
      ? [{ startLine: requestedRange.startLine, endLine: Math.min(requestedRange.endLine, file.totalLines ?? requestedRange.endLine) }]
      : []
    const newFiles = wasDiscovered ? [] : [canonical]
    const semanticProgress = observation.newlyCovered.length > 0 || observation.fullCoverage && !previouslyCovered.some(item => item.startLine === 1 && item.endLine >= (file!.totalLines ?? 1))
    // Rehydration restores already-known evidence to the model's active context,
    // but it does not create new repository knowledge. Keep it visible in the
    // evidence delta/telemetry without resetting semantic no-progress detection.
    const meaningful = semanticProgress
    if (semanticProgress) {
      this.progressRevision += 1
      this.lastProgress = `read ${canonical} ${observation.newlyCovered.map(item => `${item.startLine}-${item.endLine}`).join(', ') || 'complete file'}`
    }
    return {
      meaningful,
      reason: observation.overlapNoNewInfo
        ? reconstructedRanges.length
          ? 'read rehydrated previously known evidence without new repository information'
          : 'read returned no uncovered lines'
        : 'read added uncovered evidence',
      newFiles,
      newRanges: observation.newlyCovered,
      newSearch: false,
      overlap: observation.overlap,
      read: observation,
      evidence: { ...emptyEvidence(), newFiles, newRanges: observation.newlyCovered, reconstructedRanges },
    }
  }

  private observeSearch(toolName: string, args: Record<string, unknown>, metadata: Record<string, unknown>): ExplorationObservation {
    const kind = toolName as 'grep' | 'glob' | 'repo_map'
    const info = searchPayload(toolName, args, metadata, this.cwd)
    const source = info.source ?? {}
    const query = typeof source.pattern === 'string' ? source.pattern : typeof args.pattern === 'string' ? args.pattern : undefined
    const searchPath = typeof source.path === 'string' ? source.path : typeof args.path === 'string' ? canonicalPath(this.cwd, args.path) : undefined
    const include = typeof source.include === 'string' ? source.include : typeof args.include === 'string' ? args.include : undefined
    const signature = canonicalJson({
      kind,
      query,
      path: searchPath,
      include,
      focusFiles: kind === 'repo_map' && Array.isArray(args.focusFiles) ? args.focusFiles.map(String).sort() : undefined,
      focusSymbols: kind === 'repo_map' && Array.isArray(args.focusSymbols) ? args.focusSymbols.map(String).sort() : undefined,
      offset: Number.isSafeInteger(Number(args.offset)) ? Number(args.offset) : undefined,
    })
    const equivalent = this.searches.find(item => item.signature === signature)
    const before = new Set(this.discovered)
    for (const file of info.discoveredFiles) this.discovered.add(canonicalPath(this.cwd, file) ?? file)
    const newFiles = [...this.discovered].filter(file => !before.has(file))
    const newSymbols: ExplorationSymbolObservation[] = []
    for (const symbol of info.symbols) {
      const key = `\0${symbol}`
      if (this.symbols.has(key)) continue
      const next = { name: symbol }
      this.symbols.set(key, next)
      newSymbols.push(next)
    }
    const knownResultKeys = new Set(this.searches.flatMap(item => item.resultKeys))
    const novelSearchResults = info.resultKeys.filter(key => !knownResultKeys.has(key))
    if (!equivalent) {
      this.searches.push({
        kind,
        signature,
        ...(query ? { query } : {}),
        ...(searchPath ? { path: searchPath } : {}),
        ...(include ? { include } : {}),
        discoveredFiles: info.discoveredFiles,
        symbols: info.symbols,
        resultKeys: info.resultKeys,
      })
      if (this.searches.length > MAX_SEARCHES) this.searches.splice(0, this.searches.length - MAX_SEARCHES)
    } else {
      equivalent.discoveredFiles = uniqueStrings([...equivalent.discoveredFiles, ...info.discoveredFiles], MAX_FILES)
      equivalent.symbols = uniqueStrings([...equivalent.symbols, ...info.symbols], MAX_SYMBOLS)
      equivalent.resultKeys = uniqueStrings([...equivalent.resultKeys, ...info.resultKeys], MAX_RESULT_KEYS_PER_SEARCH)
    }
    const meaningful = newFiles.length > 0 || newSymbols.length > 0 || novelSearchResults.length > 0
    if (meaningful) {
      this.progressRevision += 1
      this.lastProgress = `${kind} discovered ${newFiles.length} new file(s)${newSymbols.length ? ` and ${newSymbols.length} symbol(s)` : ''}${novelSearchResults.length ? ` with ${novelSearchResults.length} novel result(s)` : ''}`
    }
    return {
      meaningful,
      reason: meaningful ? `${kind} discovered new evidence` : `${kind} returned no new semantic evidence`,
      newFiles,
      newRanges: [],
      newSearch: !equivalent,
      overlap: false,
      evidence: { ...emptyEvidence(), newFiles, novelSearchResults: novelSearchResults.length, newSymbols },
    }
  }
}
