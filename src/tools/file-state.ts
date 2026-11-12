import { promises as fs, createReadStream } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { within } from '../util/fs.js'
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

export type PersistedReadCoverage = {
  canonicalPath: string
  mtimeMs: number
  size: number
  totalLines: number
  contentHash?: string
  ranges: readonly FileReadRange[]
}

export type ReadCoverageRestoreResult = {
  restoredFiles: number
  restoredRanges: number
  restoredBytes: number
  skipped: number
}

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
const MAX_RESTORE_FILES = 64
const MAX_RESTORE_BYTES = 8 * 1024 * 1024
const MAX_RESTORE_FILE_SCAN_BYTES = 32 * 1024 * 1024
const MAX_RESTORE_TOTAL_SCAN_BYTES = 64 * 1024 * 1024
const MAX_RESTORE_LINE_CHARS = 256 * 1024
const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024

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
 * The cache is ephemeral to one Agent.run call, but its safe read-coverage
 * metadata can be checkpointed and revalidated on the next turn. It tracks
 * what the model actually read, keeps a bounded LRU footprint, and marks
 * restored requests as needing prompt rehydration without serializing raw file
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
    if (!stat.isFile() || stat.mtimeMs !== item.mtimeMs || stat.size !== item.size || stat.size > MAX_EVIDENCE_FILE_BYTES) continue
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

/**
 * Reconstruct only previously inspected, complete ranges while hashing the
 * whole file as a stream. This keeps restart recovery memory-bounded even for
 * large source files and refuses stale/tampered file contents.
 */
async function readValidatedRanges(
  filePath: string,
  ranges: readonly FileReadRange[],
  maxBytes: number,
): Promise<{ segments: Array<{ startLine: number; endLine: number; content: string }>; totalLines: number; contentHash: string; bom: boolean; lineEnding: 'LF' | 'CRLF'; bytes: number } | undefined> {
  const wanted = mergeReadRanges([...ranges])
  if (!wanted.length || maxBytes <= 0) return undefined
  const collected = wanted.map(range => ({ ...range, lines: [] as string[], bytes: 0, overflow: false }))
  const digest = crypto.createHash('sha256')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let carry = ''
  let discardCurrentLine = false
  let lineNumber = 0
  let crlfCount = 0
  let lfCount = 0
  let firstChunk = true
  let bom = false
  let storedBytes = 0

  const overflowLine = (nextLine: number) => {
    const target = collected.find(item => nextLine >= item.startLine && nextLine <= item.endLine)
    if (!target || target.overflow) return
    target.overflow = true
    storedBytes -= target.bytes
    target.bytes = 0
    target.lines = []
  }

  const consume = (raw: string) => {
    const crlf = raw.endsWith('\r')
    const text = crlf ? raw.slice(0, -1) : raw
    if (crlf) crlfCount++
    else lfCount++
    lineNumber++
    const target = collected.find(item => lineNumber >= item.startLine && lineNumber <= item.endLine)
    if (!target || target.overflow) return
    if (text.length > MAX_RESTORE_LINE_CHARS) {
      overflowLine(lineNumber)
      return
    }
    const bytes = Buffer.byteLength(text, 'utf8') + (target.lines.length ? 1 : 0)
    if (storedBytes + bytes > maxBytes) {
      overflowLine(lineNumber)
      return
    }
    target.lines.push(text)
    target.bytes += bytes
    storedBytes += bytes
  }

  try {
    for await (const chunk of createReadStream(filePath)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      digest.update(buffer)
      let decoded = decoder.decode(buffer, { stream: true })
      if (firstChunk) {
        firstChunk = false
        bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
        if (decoded.startsWith('\uFEFF')) decoded = decoded.slice(1)
      }

      let offset = 0
      let newline = decoded.indexOf('\n', offset)
      while (newline >= 0) {
        const fragment = decoded.slice(offset, newline)
        if (!discardCurrentLine) {
          carry += fragment
          if (carry.length > MAX_RESTORE_LINE_CHARS) {
            discardCurrentLine = true
            carry = ''
          }
        }
        if (discardCurrentLine) {
          if (fragment.endsWith('\r')) crlfCount++
          else lfCount++
          lineNumber++
          overflowLine(lineNumber)
        } else consume(carry)
        carry = ''
        discardCurrentLine = false
        offset = newline + 1
        newline = decoded.indexOf('\n', offset)
      }

      const tail = decoded.slice(offset)
      if (tail && !discardCurrentLine) {
        carry += tail
        if (carry.length > MAX_RESTORE_LINE_CHARS) {
          discardCurrentLine = true
          carry = ''
          overflowLine(lineNumber + 1)
        }
      }
    }
    const tail = decoder.decode()
    if (tail && !discardCurrentLine) {
      carry += tail
      if (carry.length > MAX_RESTORE_LINE_CHARS) {
        discardCurrentLine = true
        carry = ''
        overflowLine(lineNumber + 1)
      }
    }
    if (discardCurrentLine) lineNumber++
    else if (carry.length > 0) consume(carry)
  } catch {
    return undefined
  }

  const hash = digest.digest('hex')
  const segments = collected
    .filter(item => !item.overflow && item.lines.length === item.endLine - item.startLine + 1)
    .map(item => ({ startLine: item.startLine, endLine: item.endLine, content: item.lines.join('\n') }))
  return {
    segments,
    totalLines: lineNumber,
    contentHash: hash,
    bom,
    lineEnding: crlfCount > lfCount ? 'CRLF' : 'LF',
    bytes: storedBytes,
  }
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
   * Restore durable read coverage into this turn's ephemeral cache.
   *
   * The checkpoint stores identities and line ranges, never raw source text.
   * Every file is re-resolved, checked against the caller's active workspace
   * scope, stat-checked, and hashed before any cached segment is admitted.
   * Restored ranges are marked context-absent so the next read_file call
   * rehydrates the evidence into the model instead of incorrectly returning
   * "already visible" after a process restart.
   */
  async restoreCoverage(
    coverage: readonly PersistedReadCoverage[],
    options: { cwd: string; scopePaths?: readonly string[]; maxFiles?: number; maxBytes?: number },
  ): Promise<ReadCoverageRestoreResult> {
    const result: ReadCoverageRestoreResult = { restoredFiles: 0, restoredRanges: 0, restoredBytes: 0, skipped: 0 }
    const fileLimit = Math.min(MAX_RESTORE_FILES, Math.max(0, Math.floor(options.maxFiles ?? MAX_RESTORE_FILES)))
    const byteLimit = Math.min(this.maxBytes, MAX_RESTORE_BYTES, Math.max(0, Math.floor(options.maxBytes ?? MAX_RESTORE_BYTES)))
    if (!fileLimit || !byteLimit) return { ...result, skipped: coverage.length }

    const cwd = await fs.realpath(options.cwd).catch(() => path.resolve(options.cwd))
    const roots = (options.scopePaths?.length ? options.scopePaths : ['.'])
      .map(scope => path.resolve(cwd, scope))
    const realRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => root)))
    let remainingBytes = byteLimit
    let remainingScanBytes = MAX_RESTORE_TOTAL_SCAN_BYTES

    for (const item of coverage) {
      if (result.restoredFiles >= fileLimit || remainingScanBytes <= 0) { result.skipped++; continue }
      if (!item || typeof item.canonicalPath !== 'string' || !path.isAbsolute(item.canonicalPath)
        || !Number.isFinite(item.mtimeMs) || !Number.isFinite(item.size)
        || !Number.isSafeInteger(item.totalLines) || item.totalLines < 0
        || !Array.isArray(item.ranges) || !item.ranges.length
        || typeof item.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(item.contentHash)) {
        result.skipped++
        continue
      }
      const lexicalPath = path.resolve(item.canonicalPath)
      let realPath: string
      try { realPath = await fs.realpath(lexicalPath) } catch { result.skipped++; continue }
      if (!realRoots.some(root => within(root, realPath))) { result.skipped++; continue }

      let before: Awaited<ReturnType<typeof fs.stat>>
      try { before = await fs.stat(realPath) } catch { result.skipped++; continue }
      if (!before.isFile() || before.mtimeMs !== item.mtimeMs || before.size !== item.size
        || before.size > MAX_RESTORE_FILE_SCAN_BYTES || before.size > remainingScanBytes) { result.skipped++; continue }

      const ranges = mergeReadRanges(item.ranges.filter(range =>
        Number.isSafeInteger(range.startLine) && Number.isSafeInteger(range.endLine)
        && range.startLine >= 1 && range.endLine >= range.startLine
        && range.endLine <= item.totalLines,
      ))
      if (!ranges.length) { result.skipped++; continue }

      const restored = await readValidatedRanges(realPath, ranges, remainingBytes)
      remainingScanBytes = Math.max(0, remainingScanBytes - before.size)
      if (!restored || !restored.segments.length || restored.contentHash.toLowerCase() !== item.contentHash.toLowerCase()
        || restored.totalLines !== item.totalLines) {
        result.skipped++
        continue
      }
      // Guard against a write racing the stream read. Hashing already checks
      // content identity; this second stat prevents admitting a moving target.
      const after = await fs.stat(realPath).catch(() => undefined)
      if (!after?.isFile() || after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
        result.skipped++
        continue
      }

      let fileRestored = 0
      for (const segment of restored.segments) {
        this.record(
          lexicalPath,
          { mtimeMs: before.mtimeMs, size: before.size, totalLines: restored.totalLines, contentHash: restored.contentHash, bom: restored.bom, lineEnding: restored.lineEnding },
          segment,
          [{ ...segment, complete: true }],
          { lineCount: segment.endLine - segment.startLine + 1, truncated: false },
        )
        this.markContextCoverage(lexicalPath, segment, false)
        fileRestored++
        result.restoredRanges++
        result.restoredBytes += Buffer.byteLength(segment.content, 'utf8')
      }
      if (fileRestored) result.restoredFiles++
      remainingBytes = Math.max(0, remainingBytes - restored.bytes)
      if (remainingBytes <= 0) {
        result.skipped += coverage.length - result.restoredFiles - result.skipped
        break
      }
    }
    return result
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
      if (!currentStat.isFile() || currentStat.mtimeMs !== state.mtimeMs || currentStat.size !== state.size || currentStat.size > MAX_EVIDENCE_FILE_BYTES) continue
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
