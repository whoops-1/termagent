import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DEFAULT_MAX_LINES = 2_000
export const DEFAULT_MAX_BYTES = 50 * 1024
export const DEFAULT_RETENTION_DAYS = 7
export const TOOL_OUTPUT_REFERENCE_PREFIX = 'tool-output://'

export type ToolOutputAttachment = Record<string, unknown>

export interface ToolOutputInput {
  sessionId: string
  toolCallId: string
  text: string
  metadata?: unknown
  attachments?: ToolOutputAttachment[]
}

export interface ToolOutputLimits {
  maxLines: number
  maxBytes: number
  retentionDays: number
}

export interface ToolOutputBoundResult {
  text: string
  truncated: boolean
  persisted: boolean
  reference?: string
  outputPath?: string
  metadataPath?: string
  totalBytes: number
  totalLines: number
  contentHash: string
  previewBytes: number
  previewLines: number
  previewStrategy: 'complete' | 'head-tail'
}

interface ToolOutputMeta {
  version: 1
  sessionId: string
  toolCallId: string
  contentHash: string
  totalBytes: number
  totalLines: number
  metadata?: unknown
  attachments?: ToolOutputAttachment[]
  createdAt: number
  updatedAt: number
}

function clampPositive(value: unknown, fallback: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.floor(n))
}

function countLines(text: string): number {
  if (!text) return 0
  let count = 1
  for (const ch of text) if (ch === '\n') count++
  return count
}

function takePrefixUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !text) return ''
  let bytes = 0
  let out = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    out += char
    bytes += size
  }
  return out
}

function takeSuffixUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || !text) return ''
  let bytes = 0
  const chars = Array.from(text)
  const out: string[] = []
  for (let i = chars.length - 1; i >= 0; i--) {
    const char = chars[i]!
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    out.unshift(char)
    bytes += size
  }
  return out.join('')
}

function fitHeadLines(lines: string[], maxLines: number, maxBytes: number): string[] {
  const out: string[] = []
  let bytes = 0
  for (const line of lines.slice(0, maxLines)) {
    const next = bytes + Buffer.byteLength(line, 'utf8') + (out.length ? 1 : 0)
    if (next > maxBytes) break
    out.push(line)
    bytes = next
  }
  return out
}

function fitTailLines(lines: string[], maxLines: number, maxBytes: number): string[] {
  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i]!
    const next = bytes + Buffer.byteLength(line, 'utf8') + (out.length ? 1 : 0)
    if (next > maxBytes) break
    out.unshift(line)
    bytes = next
  }
  return out
}

function boundedPreview(text: string, maxLines: number, maxBytes: number, markerOverride?: string): string {
  if (countLines(text) <= maxLines && Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  if (maxBytes <= 32) return takePrefixUtf8(text, maxBytes)

  const lines = text.split('\n')
  const marker = markerOverride || '…[truncated; full tool output saved to a managed file]…'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const lineBudget = Math.max(1, maxLines - 1)
  const bodyBytes = Math.max(2, maxBytes - markerBytes - 2)
  const headLineCount = Math.max(1, Math.ceil(lineBudget * 0.58))
  const tailLineCount = Math.max(0, lineBudget - headLineCount)
  const head = fitHeadLines(lines, headLineCount, Math.max(1, Math.ceil(bodyBytes * 0.58)))
  const tail = tailLineCount ? fitTailLines(lines, tailLineCount, Math.max(1, bodyBytes - Math.ceil(bodyBytes * 0.58))) : []
  let candidate = `${head.join('\n')}\n${marker}${tail.length ? `\n${tail.join('\n')}` : ''}`

  if (Buffer.byteLength(candidate, 'utf8') <= maxBytes && countLines(candidate) <= maxLines) return candidate

  const headBytes = Math.max(1, Math.floor(bodyBytes / 2))
  const tailBytes = Math.max(1, bodyBytes - headBytes)
  const first = takePrefixUtf8(lines[0] || '', headBytes)
  const last = takeSuffixUtf8(lines.at(-1) || '', tailBytes)
  candidate = last && lines.length > 1
    ? `${first}\n${marker}\n${last}`
    : `${first}\n${marker}`

  if (Buffer.byteLength(candidate, 'utf8') <= maxBytes && countLines(candidate) <= maxLines) return candidate
  return takePrefixUtf8(candidate, maxBytes)
}

export function summarizeToolOutputPreview(text: string, maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES): string {
  return boundedPreview(text, Math.max(1, maxLines), Math.max(32, maxBytes))
}

export function toolOutputReference(hash: string): string {
  return `${TOOL_OUTPUT_REFERENCE_PREFIX}${hash}`
}

export function parseToolOutputReference(value: string): string | null {
  if (!value.startsWith(TOOL_OUTPUT_REFERENCE_PREFIX)) return null
  const hash = value.slice(TOOL_OUTPUT_REFERENCE_PREFIX.length)
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null
}

export function toolOutputStoreRoot(): string {
  return process.env.TERMAGENT_TOOL_OUTPUT_ROOT || path.join(process.env.HOME || process.cwd(), '.termagent', 'tool-output')
}

function fileNames(key: string, root: string) {
  return {
    text: path.join(root, `tool_${key}.log`),
    meta: path.join(root, `tool_${key}.json`),
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, file)
}

function callKey(sessionId: string, toolCallId: string): string {
  return crypto.createHash('sha256').update(`${sessionId}\0${toolCallId}`).digest('hex')
}

export class ToolOutputStore {
  readonly root: string
  private readonly limitsValue: ToolOutputLimits
  private cleanupAt = 0

  constructor(options: { root?: string; maxLines?: number; maxBytes?: number; retentionDays?: number } = {}) {
    this.root = options.root || toolOutputStoreRoot()
    this.limitsValue = {
      maxLines: clampPositive(options.maxLines, DEFAULT_MAX_LINES, 100_000),
      maxBytes: Math.max(256, clampPositive(options.maxBytes, DEFAULT_MAX_BYTES, 8 * 1024 * 1024)),
      retentionDays: clampPositive(options.retentionDays, DEFAULT_RETENTION_DAYS, 365),
    }
  }

  limits(): ToolOutputLimits {
    return { ...this.limitsValue }
  }

  referenceFor(sessionId: string, toolCallId: string): string {
    return toolOutputReference(callKey(sessionId, toolCallId))
  }

  resolveReference(reference: string): string | null {
    const key = parseToolOutputReference(reference)
    if (!key) return null
    return fileNames(key, this.root).text
  }

  metadataPath(reference: string): string | null {
    const key = parseToolOutputReference(reference)
    if (!key) return null
    return fileNames(key, this.root).meta
  }

  async bind(input: ToolOutputInput, overrides: Partial<ToolOutputLimits> = {}): Promise<ToolOutputBoundResult> {
    const maxLines = clampPositive(overrides.maxLines, this.limitsValue.maxLines, 100_000)
    const maxBytes = Math.max(256, clampPositive(overrides.maxBytes, this.limitsValue.maxBytes, 8 * 1024 * 1024))
    const totalBytes = Buffer.byteLength(input.text, 'utf8')
    const totalLines = countLines(input.text)
    const contentHash = crypto.createHash('sha256').update(input.text, 'utf8').digest('hex')
    const needsPersist = totalBytes > maxBytes || totalLines > maxLines

    if (!needsPersist) {
      return {
        text: input.text,
        truncated: false,
        persisted: false,
        totalBytes,
        totalLines,
        contentHash,
        previewBytes: totalBytes,
        previewLines: totalLines,
        previewStrategy: 'complete',
      }
    }

    const key = callKey(input.sessionId, input.toolCallId)
    const files = fileNames(key, this.root)
    const reference = toolOutputReference(key)
    const now = Date.now()
    const metadata: ToolOutputMeta = {
      version: 1,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      contentHash,
      totalBytes,
      totalLines,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      createdAt: now,
      updatedAt: now,
    }

    let reuseExisting = false
    try {
      const existing = JSON.parse(await fs.readFile(files.meta, 'utf8')) as Partial<ToolOutputMeta>
      reuseExisting = existing.contentHash === contentHash && existing.totalBytes === totalBytes && existing.totalLines === totalLines
    } catch {}

    if (!reuseExisting) {
      await fs.mkdir(this.root, { recursive: true })
      await atomicWrite(files.text, input.text)
      await atomicWrite(files.meta, JSON.stringify(metadata, null, 2))
    } else if (input.metadata !== undefined || input.attachments?.length) {
      try {
        const existing = JSON.parse(await fs.readFile(files.meta, 'utf8')) as ToolOutputMeta
        if (JSON.stringify(existing.metadata) !== JSON.stringify(input.metadata) || JSON.stringify(existing.attachments) !== JSON.stringify(input.attachments)) {
          existing.metadata = input.metadata
          existing.attachments = input.attachments
          existing.updatedAt = now
          await atomicWrite(files.meta, JSON.stringify(existing, null, 2))
        }
      } catch {}
    }

    await this.cleanupIfDue()
    const referenceMarker = `…[middle truncated; full tool output: ${reference}]…`
    const preview = boundedPreview(input.text, maxLines, maxBytes, referenceMarker)
    return {
      text: preview,
      truncated: true,
      persisted: true,
      reference,
      outputPath: files.text,
      metadataPath: files.meta,
      totalBytes,
      totalLines,
      contentHash,
      previewBytes: Buffer.byteLength(preview, 'utf8'),
      previewLines: countLines(preview),
      previewStrategy: 'head-tail',
    }
  }

  async read(reference: string, options: { startLine?: number; endLine?: number } = {}): Promise<{ text: string; path: string; metadata: ToolOutputMeta | null; totalLines: number; startLine: number; endLine: number; truncated: boolean }> {
    const file = this.resolveReference(reference)
    if (!file) throw new Error(`Invalid tool output reference: ${reference}`)
    const metaFile = this.metadataPath(reference)!
    const startLine = Math.max(1, Math.floor(Number(options.startLine) || 1))
    const maxEnd = Math.max(startLine, Math.floor(Number(options.endLine) || startLine + maxLinesForRead() - 1))
    const endLine = Math.min(maxEnd, startLine + maxLinesForRead() - 1)
    const content = await fs.readFile(file, 'utf8')
    const lines = content.split('\n')
    const selected = lines.slice(startLine - 1, endLine)
    const actualEnd = selected.length ? startLine + selected.length - 1 : startLine - 1
    let metadata: ToolOutputMeta | null = null
    try { metadata = JSON.parse(await fs.readFile(metaFile, 'utf8')) as ToolOutputMeta } catch {}
    return {
      text: selected.join('\n'),
      path: file,
      metadata,
      totalLines: metadata?.totalLines ?? countLines(content),
      startLine,
      endLine: actualEnd,
      truncated: actualEnd < (metadata?.totalLines ?? lines.length),
    }
  }

  async cleanup(): Promise<number> {
    const cutoff = Date.now() - this.limitsValue.retentionDays * 24 * 60 * 60 * 1000
    let removed = 0
    let entries: string[] = []
    try { entries = await fs.readdir(this.root) } catch { return 0 }
    for (const entry of entries) {
      if (!/^tool_[a-f0-9]{64}\.(?:log|json)$/.test(entry)) continue
      const file = path.join(this.root, entry)
      try {
        const stat = await fs.stat(file)
        if (stat.mtimeMs < cutoff) {
          await fs.rm(file, { force: true })
          removed++
        }
      } catch {}
    }
    this.cleanupAt = Date.now()
    return removed
  }

  async cleanupIfDue(): Promise<void> {
    if (Date.now() - this.cleanupAt < 60 * 60 * 1000) return
    await this.cleanup().catch(() => {})
  }
}

function maxLinesForRead(): number {
  const raw = Number(process.env.TERMAGENT_TOOL_OUTPUT_READ_LINES)
  return Number.isFinite(raw) && raw > 0 ? Math.min(20_000, Math.floor(raw)) : 2_000
}
