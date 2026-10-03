import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
export type FileReadRange = {
  startLine: number
  endLine: number
}

export type FileReadSegment = FileReadRange & {
  /** Normalized, unnumbered UTF-8 text for this contiguous range. */
  content: string
  bytes: number
  /** True when the cached text exactly represents the source lines, without output/line truncation. */
  complete: boolean
  recordedAt: number
}

export type FileReadRequest = FileReadRange & {
  lineCount: number
  truncated: boolean
  contextPresent: boolean
  recordedAt: number
}

export type ReadFileState = {
  canonicalPath: string
  mtimeMs: number
  size: number
  totalLines: number
  lastUse: number
  contentHash?: string
  bom?: boolean
  lineEnding?: 'LF' | 'CRLF'
  segments: FileReadSegment[]
  requests: FileReadRequest[]
}

export type ReadCacheStatus = 'miss' | 'fresh' | 'unchanged' | 'rehydrated' | 'overlap' | 'already-covered'

export type ReadCacheLookup = {
  state: ReadFileState
  status: Exclude<ReadCacheStatus, 'miss'>
  exact?: FileReadRequest
  covered: FileReadRange[]
  uncovered: FileReadRange[]
  content?: string
}

const DEFAULT_MAX_ENTRIES = 100
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
const MAX_REQUEST_HISTORY = 64

function normalizeRange(range: FileReadRange): FileReadRange {
  const startLine = Math.max(1, Math.floor(Number(range.startLine) || 1))
  const endLine = Math.max(startLine, Math.floor(Number(range.endLine) || startLine))
  return { startLine, endLine }
}

export function mergeReadRanges(ranges: FileReadRange[]): FileReadRange[] {
  if (!ranges.length) return []
  const sorted = ranges
    .map(normalizeRange)
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
  const merged: FileReadRange[] = [{ ...sorted[0]! }]
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1]!
    if (range.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, range.endLine)
    else merged.push({ ...range })
  }
  return merged
}

function subtractRanges(request: FileReadRange, covered: FileReadRange[]): FileReadRange[] {
  const target = normalizeRange(request)
  const result: FileReadRange[] = []
  let cursor = target.startLine
  for (const range of mergeReadRanges(covered)) {
    if (range.endLine < cursor) continue
    if (range.startLine > target.endLine) break
    if (range.startLine > cursor) {
      result.push({ startLine: cursor, endLine: Math.min(target.endLine, range.startLine - 1) })
    }
    cursor = Math.max(cursor, range.endLine + 1)
    if (cursor > target.endLine) break
  }
  if (cursor <= target.endLine) result.push({ startLine: cursor, endLine: target.endLine })
  return result
}

function stateBytes(state: ReadFileState) {
  return state.segments.reduce((sum, segment) => sum + segment.bytes + 64, 0)
    + state.requests.reduce((sum, request) => sum + 64, 0)
}

/**
 * TermAgent adaptation of TermAgent's FileStateCache pattern.
 *
 * The cache lives for one Agent.run session. It tracks what the model has
 * actually read, keeps a bounded LRU footprint, and can mark cached requests
 * as needing rehydration after context compaction without serializing raw file
 * contents into the durable session log.
 */

export async function rehydrateReadCoverageEvidence(
  coverage: readonly { canonicalPath: string; mtimeMs: number; size: number; totalLines: number; contentHash?: string; ranges: readonly { startLine: number; endLine: number }[] }[],
  budgetTokens = 600,
  maxFiles = 5,
): Promise<string[]> {
  const budget = Math.max(64, Math.floor(budgetTokens))
  const evidence: string[] = []
  let used = 0
  for (const item of coverage.slice(0, Math.max(0, maxFiles))) {
    let stat: any
    try { stat = await fs.stat(item.canonicalPath) } catch { continue }
    if (!stat.isFile() || stat.mtimeMs !== item.mtimeMs || stat.size !== item.size) continue
    let text: string
    try { text = await fs.readFile(item.canonicalPath, 'utf8') } catch { continue }
    if (item.contentHash && crypto.createHash('sha256').update(text, 'utf8').digest('hex') !== item.contentHash) continue
    const lines = text.replaceAll('\r\n','\n').replaceAll('\r','\n').split('\n')
    const maxLine = lines.at(-1) === '' ? lines.length - 1 : lines.length
    for (const range of item.ranges.slice(0, 8)) {
      const start = Math.max(1, Math.floor(range.startLine))
      const end = Math.min(maxLine, Math.max(start, Math.floor(range.endLine)))
      if (end < start) continue
      const chunk = `${item.canonicalPath}#L${start}-${end}\n${lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n')}`
      const cost = Math.ceil(chunk.length / 4)
      if (used + cost > budget) break
      evidence.push(chunk)
      used += cost
    }
    if (used >= budget) break
  }
  return evidence
}

export class FileReadStateCache {
  readonly maxEntries: number
  readonly maxBytes: number
  private states = new Map<string, ReadFileState>()
  private bytes = 0
  private contextEpoch = 0
  /** Ephemeral prompt-visible coverage. This is intentionally not durable. */
  private contextCoverage = new Map<string, FileReadRange[]>()

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries))
    this.maxBytes = Math.max(64 * 1024, Math.floor(maxBytes))
  }

  canonicalPath(filePath: string) {
    return filePath
  }

  get(filePath: string) {
    const state = this.states.get(this.canonicalPath(filePath))
    if (!state) return undefined
    this.touch(state.canonicalPath, state)
    return state
  }

  invalidate(filePath: string) {
    const key = this.canonicalPath(filePath)
    const state = this.states.get(key)
    if (!state) return false
    this.bytes -= stateBytes(state)
    this.states.delete(key)
    this.contextCoverage.delete(key)
    return true
  }

  clear() {
    this.states.clear()
    this.contextCoverage.clear()
    this.bytes = 0
  }

  /**
   * Context compaction removes old tool results from the prompt. Cached file
   * evidence therefore remains valid on disk but is no longer guaranteed to
   * be visible to the model. The next exact read may rehydrate that evidence
   * from memory instead of doing another filesystem read.
   */
  noteCompaction() {
    this.contextEpoch += 1
    this.contextCoverage.clear()
    for (const state of this.states.values()) {
      for (const request of state.requests) request.contextPresent = false
    }
  }

  contextSnapshot(limit = 8) {
    return [...this.states.values()]
      .sort((a, b) => b.lastUse - a.lastUse)
      .slice(0, Math.max(0, limit))
      .map(state => ({
        canonicalPath: state.canonicalPath,
        mtimeMs: state.mtimeMs,
        size: state.size,
        totalLines: state.totalLines,
        lastUse: state.lastUse,
        contentHash: state.contentHash,
        bom: state.bom,
        lineEnding: state.lineEnding,
        ranges: mergeReadRanges(state.segments.filter(segment => segment.complete)),
      }))
  }

  async rehydrateContextEvidence(budgetTokens = 600, maxFiles = 5) {
    const budget = Math.max(64, Math.floor(budgetTokens))
    const evidence: string[] = []
    let used = 0
    const states = [...this.states.values()].sort((a, b) => b.lastUse - a.lastUse).slice(0, Math.max(0, maxFiles))
    for (const state of states) {
      let currentStat: any
      try { currentStat = await fs.stat(state.canonicalPath) } catch { continue }
      if (!currentStat.isFile() || currentStat.mtimeMs !== state.mtimeMs || currentStat.size !== state.size) continue
      let text: string
      try { text = await fs.readFile(state.canonicalPath, 'utf8') } catch { continue }
      if (state.contentHash && crypto.createHash('sha256').update(text, 'utf8').digest('hex') !== state.contentHash) continue
      const lines = text.replaceAll('\r\n','\n').replaceAll('\r','\n').split('\n')
      const ranges = mergeReadRanges(state.segments).slice(0, 8)
      for (const range of ranges) {
        const start = Math.max(1, range.startLine)
        const end = Math.min(lines.length - (lines.at(-1)==='' ? 1 : 0), range.endLine)
        if (end < start) continue
        const raw = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n')
        const textChunk = `${state.canonicalPath}#L${start}-${end}\n${raw}`
        const cost = Math.ceil(textChunk.length / 4)
        if (used + cost > budget) break
        evidence.push(textChunk)
        used += cost
        this.markRequestContextPresent(state.canonicalPath, { startLine:start, endLine:end }, true)
      }
      if (used >= budget) break
    }
    return evidence
  }

  stats() {
    return {
      entries: this.states.size,
      bytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      contextEpoch: this.contextEpoch,
    }
  }

  lookup(
    filePath: string,
    range: FileReadRange,
    fileMeta: { mtimeMs: number; size: number; totalLines?: number },
  ): ReadCacheLookup | undefined {
    const key = this.canonicalPath(filePath)
    const state = this.states.get(key)
    if (!state || state.mtimeMs !== fileMeta.mtimeMs || state.size !== fileMeta.size) {
      if (state) this.invalidate(key)
      return undefined
    }
    state.totalLines = fileMeta.totalLines ?? state.totalLines
    this.touch(key, state)

    const rawRequested = normalizeRange(range)
    const requested = {
      startLine: rawRequested.startLine,
      endLine: Math.min(rawRequested.endLine, state.totalLines),
    }
    if (requested.endLine < requested.startLine) {
      return { state, status: 'fresh', covered: [], uncovered: [], exact: undefined }
    }
    const exact = [...state.requests].reverse().find(request =>
      request.startLine === requested.startLine && request.endLine === requested.endLine,
    )
    const covered = mergeReadRanges(state.segments.filter(segment => segment.complete))
    const uncovered = subtractRanges(requested, covered)
    const legacyContextCoverage = state.requests
      .filter(request => request.contextPresent && !request.truncated)
      .map(request => ({startLine:request.startLine,endLine:Math.min(request.endLine,state.totalLines)}))
    const contextVisible = mergeReadRanges([...(this.contextCoverage.get(key) ?? []), ...legacyContextCoverage])
    const contextMissing = subtractRanges(requested, contextVisible)
    const contextComplete = contextMissing.length === 0
    const content = uncovered.length === 0 && !contextComplete ? this.reconstruct(state, requested) : undefined

    if (exact && !exact.truncated && uncovered.length === 0) {
      if (contextComplete) return { state, status: 'unchanged', exact, covered, uncovered }
      if (content !== undefined) return { state, status: 'rehydrated', exact, covered, uncovered, content }
    }

    if (uncovered.length === 0) {
      if (contextComplete) return { state, status: 'already-covered', exact, covered, uncovered }
      if (content !== undefined) return { state, status: 'rehydrated', exact, covered, uncovered, content }
    }

    const hasOverlap = covered.some(r => r.startLine <= requested.endLine && r.endLine >= requested.startLine)
    return { state, status: hasOverlap ? 'overlap' : 'fresh', exact, covered, uncovered }
  }

  record(
    filePath: string,
    fileMeta: { mtimeMs: number; size: number; totalLines: number; contentHash?: string; bom?: boolean; lineEnding?: 'LF' | 'CRLF' },
    requestedRange: FileReadRange,
    segments: Array<{ startLine: number; endLine: number; content: string; complete?: boolean }>,
    options: { lineCount: number; truncated: boolean },
  ) {
    const key = this.canonicalPath(filePath)
    let state = this.states.get(key)
    if (state && (state.mtimeMs !== fileMeta.mtimeMs || state.size !== fileMeta.size)) {
      this.invalidate(key)
      state = undefined
    }
    if (!state) {
      state = {
        canonicalPath: key,
        mtimeMs: fileMeta.mtimeMs,
        size: fileMeta.size,
        totalLines: fileMeta.totalLines,
        lastUse: Date.now(),
        segments: [],
        requests: [],
      }
      this.states.set(key, state)
    }

    this.bytes -= stateBytes(state)
    state.mtimeMs = fileMeta.mtimeMs
    state.size = fileMeta.size
    state.totalLines = fileMeta.totalLines
    if (fileMeta.contentHash) state.contentHash = fileMeta.contentHash
    if (fileMeta.bom !== undefined) state.bom = fileMeta.bom
    if (fileMeta.lineEnding) state.lineEnding = fileMeta.lineEnding
    state.lastUse = Date.now()

    for (const raw of segments) {
      const segmentRange = normalizeRange(raw)
      if (!raw.content.length) continue
      const next: FileReadSegment = {
        ...segmentRange,
        content: raw.content,
        bytes: Buffer.byteLength(raw.content, 'utf8'),
        complete: raw.complete !== false,
        recordedAt: Date.now(),
      }
      state.segments = state.segments.filter(existing =>
        existing.startLine !== next.startLine || existing.endLine !== next.endLine,
      )
      state.segments.push(next)
    }

    const requested = normalizeRange(requestedRange)
    state.requests = state.requests.filter(request =>
      request.startLine !== requested.startLine || request.endLine !== requested.endLine,
    )
    state.requests.push({
      ...requested,
      lineCount: options.lineCount,
      truncated: options.truncated,
      contextPresent: true,
      recordedAt: Date.now(),
    })
    state.requests = state.requests.slice(-MAX_REQUEST_HISTORY)
    const visible = this.contextCoverage.get(key) ?? []
    const nextVisible = mergeReadRanges([
      ...visible,
      ...segments.filter(segment => segment.complete !== false).map(segment => normalizeRange(segment)),
    ])
    this.contextCoverage.set(key, nextVisible)
    this.touch(key, state, false)
    this.bytes += stateBytes(state)
    this.evict()
    return state
  }

  hasCompleteRead(filePath: string): boolean {
    const state = this.states.get(this.canonicalPath(filePath))
    if (!state || !state.contentHash) return false
    if (state.totalLines === 0) return true
    const completeCoverage = mergeReadRanges(state.segments.filter(segment => segment.complete))
    const first = completeCoverage[0]
    return Boolean(first && first.startLine === 1 && first.endLine >= state.totalLines)
  }

  hasFreshFullRead(filePath: string, current: { mtimeMs: number; size: number }): boolean {
    const state = this.states.get(this.canonicalPath(filePath))
    if (!this.hasCompleteRead(filePath) || !state) return false
    return state.mtimeMs === current.mtimeMs && state.size === current.size
  }

  mutationState(filePath: string) {
    const state = this.states.get(this.canonicalPath(filePath))
    return state ? { ...state, segments: state.segments.map(segment => ({ ...segment })), requests: state.requests.map(request => ({ ...request })) } : undefined
  }

  seedFullContent(
    filePath: string,
    fileMeta: { mtimeMs: number; size: number; totalLines: number; contentHash: string; bom: boolean; lineEnding: 'LF' | 'CRLF' },
    content: string,
    contextPresent = false,
  ) {
    const key = this.canonicalPath(filePath)
    this.invalidate(key)
    const normalized = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    const totalLines = normalized.length === 0 ? 0 : normalized.split('\n').length - (normalized.endsWith('\n') ? 1 : 0)
    const lines = normalized.split('\n')
    const segment: FileReadSegment = {
      startLine: 1,
      endLine: Math.max(1, totalLines),
      content: lines.join('\n'),
      bytes: Buffer.byteLength(content, 'utf8'),
      complete: true,
      recordedAt: Date.now(),
    }
    const state: ReadFileState = {
      canonicalPath: key,
      mtimeMs: fileMeta.mtimeMs,
      size: fileMeta.size,
      totalLines: totalLines,
      lastUse: Date.now(),
      contentHash: fileMeta.contentHash,
      bom: fileMeta.bom,
      lineEnding: fileMeta.lineEnding,
      segments: [segment],
      requests: [{ startLine: 1, endLine: Math.max(1, totalLines), lineCount: Math.max(1, totalLines), truncated: false, contextPresent, recordedAt: Date.now() }],
    }
    const bytes = stateBytes(state)
    if (bytes > this.maxBytes) return
    this.states.set(key, state)
    this.bytes += bytes
    this.contextCoverage.set(key, contextPresent ? [{startLine:1,endLine:Math.max(1,totalLines)}] : [])
    this.evict()
  }

  markContextCoverage(filePath: string, range: FileReadRange, present = true) {
    const key = this.canonicalPath(filePath)
    if (!this.states.has(key)) return
    const normalized = normalizeRange(range)
    const current = this.contextCoverage.get(key) ?? []
    this.contextCoverage.set(key, present
      ? mergeReadRanges([...current, normalized])
      : subtractRanges(normalized, current)
    )
    this.markRequestContextPresent(key, normalized, present)
  }

  markRequestContextPresent(filePath: string, range: FileReadRange, present = true) {
    const state = this.states.get(this.canonicalPath(filePath))
    if (!state) return
    const normalized = normalizeRange(range)
    for (const request of state.requests) {
      if (request.startLine === normalized.startLine && request.endLine === normalized.endLine) request.contextPresent = present
    }
  }

  private reconstruct(state: ReadFileState, range: FileReadRange) {
    const candidates = state.segments
      .filter(segment => segment.complete && segment.startLine <= range.endLine && segment.endLine >= range.startLine)
      .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
    if (!candidates.length) return undefined

    const lines = new Map<number, string>()
    for (const segment of candidates) {
      const segmentLines = segment.content.split(/\r?\n/)
      for (let i = 0; i < segmentLines.length; i++) {
        const lineNumber = segment.startLine + i
        if (lineNumber >= range.startLine && lineNumber <= range.endLine && !lines.has(lineNumber)) {
          lines.set(lineNumber, segmentLines[i] ?? '')
        }
      }
    }

    for (let line = range.startLine; line <= range.endLine; line++) {
      if (!lines.has(line)) return undefined
    }
    return Array.from({ length: range.endLine - range.startLine + 1 }, (_, i) => lines.get(range.startLine + i) ?? '').join('\n')
  }

  private touch(key: string, state: ReadFileState, updateBytes = true) {
    if (updateBytes) this.bytes -= stateBytes(state)
    state.lastUse = Date.now()
    this.states.delete(key)
    this.states.set(key, state)
    if (updateBytes) this.bytes += stateBytes(state)
  }

  private evict() {
    while (this.states.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.states.keys().next().value as string | undefined
      if (!oldest) break
      const state = this.states.get(oldest)
      if (state) this.bytes -= stateBytes(state)
      this.states.delete(oldest)
      this.contextCoverage.delete(oldest)
    }
  }
}
