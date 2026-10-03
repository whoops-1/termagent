import { background, clip, paint, padRight, RESET, widthOf } from './ansi.js'
import { contentWidth, remainingWidth } from './geometry.js'
import { highlightLine } from './syntax.js'
import type { ColorCapability, Theme } from './types.js'

export type DiffView = 'unified' | 'split'
export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'binary'

export type DiffFile = {
  path: string
  patch: string
  additions: number
  deletions: number
  status?: DiffStatus
  binary?: boolean
  truncated?: boolean
  large?: boolean
}

export type DiffDocument = {
  files: DiffFile[]
  additions: number
  deletions: number
  truncated?: boolean
}

export type DiffLine = {
  kind: 'context' | 'add' | 'remove' | 'hunk' | 'meta'
  text: string
  oldLine?: number
  newLine?: number
}

function statusFromChunk(chunk: string, binary = false): DiffStatus {
  if (binary || /^Binary files /m.test(chunk)) return 'binary'
  if (/^new file mode /m.test(chunk)) return 'added'
  if (/^deleted file mode /m.test(chunk)) return 'deleted'
  if (/^similarity index /m.test(chunk) || /^rename from /m.test(chunk) || /^rename to /m.test(chunk)) return 'renamed'
  return 'modified'
}

function cleanPath(value: string) {
  return value.replace(/^([ab])\//, '').replace(/^"|"$/g, '')
}

function languageFromPath(path: string) {
  const value = path.toLowerCase().split(/[\\/]/).at(-1) ?? path.toLowerCase()
  const dot = value.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return value.slice(dot + 1) || 'plaintext'
}

function paintCodeLine(
  text: string,
  language: string,
  theme: Theme,
  capability: ColorCapability,
  bg?: string,
) {
  const highlighted = highlightLine(text, language, theme, capability)
  if (!bg || capability === 'plain') return highlighted
  const bgSequence = background(bg, capability)
  if (!bgSequence) return highlighted
  return `${bgSequence}${highlighted.replaceAll(RESET, `${RESET}${bgSequence}`)}${RESET}`
}

function inferPath(patch: string, fallback = 'file') {
  const git = patch.match(/^diff --git a\/(.+) b\/(.+)$/m)
  if (git) return cleanPath(git[2] || git[1] || fallback)
  const plus = patch.match(/^\+\+\+ b\/(.+)$/m)
  if (plus) return cleanPath(plus[1]!)
  const minus = patch.match(/^--- a\/(.+)$/m)
  if (minus) return cleanPath(minus[1]!)
  return fallback
}

function countPatchLines(patch: string) {
  let additions = 0
  let deletions = 0
  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}

function splitGitChunks(text: string) {
  const normalized = text.replace(/\r\n/g, '\n').trimEnd()
  if (!normalized) return []
  const chunks = normalized.split(/^diff --git /m).filter(Boolean).map((chunk) => `diff --git ${chunk}`)
  return chunks.length ? chunks : [normalized]
}

export function parseDiffDocument(text: string, fallbackPath = 'file'): DiffDocument {
  const files = splitGitChunks(text).map((patch) => {
    const binary = /^Binary files /m.test(patch)
    const counts = countPatchLines(patch)
    return {
      path: inferPath(patch, fallbackPath),
      patch,
      additions: counts.additions,
      deletions: counts.deletions,
      status: statusFromChunk(patch, binary),
      binary,
    } satisfies DiffFile
  })
  return {
    files,
    additions: files.reduce((n, file) => n + file.additions, 0),
    deletions: files.reduce((n, file) => n + file.deletions, 0),
  }
}

export function normalizeDiffMetadata(metadata: unknown): DiffFile[] {
  if (!metadata || typeof metadata !== 'object') return []
  const source = metadata as Record<string, unknown>
  const rawFiles = Array.isArray(source.files) ? source.files : []
  if (rawFiles.length) {
    const files = rawFiles.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const file = value as Record<string, unknown>
      const patch = typeof file.diff === 'string' ? file.diff : typeof file.patch === 'string' ? file.patch : ''
      const type = typeof file.type === 'string' ? file.type : undefined
      const status = typeof file.status === 'string' ? file.status : type === 'add' ? 'added' : type === 'delete' ? 'deleted' : type === 'move' ? 'renamed' : type === 'untracked' ? 'untracked' : undefined
      if (!patch.trim() && status !== 'untracked' && status !== 'binary') return []
      const pathValue = String(file.relativePath ?? file.filePath ?? file.path ?? inferPath(patch, 'file'))
      const counts = countPatchLines(patch)
      const additions = typeof file.additions === 'number' ? file.additions : counts.additions
      const deletions = typeof file.deletions === 'number' ? file.deletions : counts.deletions
      const binary = Boolean(file.binary) || status === 'binary' || /^Binary files /m.test(patch)
      const large = Boolean(file.large) || Boolean(file.isLargeFile)
      return [{
        path: pathValue,
        patch,
        additions,
        deletions,
        status: binary ? 'binary' : (status as DiffStatus | undefined) ?? 'modified',
        binary,
        large,
      } satisfies DiffFile]
    })
    if (files.length) return files
  }

  if (typeof source.diff === 'string' && source.diff.trim()) {
    const pathValue = typeof source.fileDiff === 'object' && source.fileDiff
      ? String((source.fileDiff as Record<string, unknown>).path ?? (source.fileDiff as Record<string, unknown>).file ?? inferPath(source.diff, 'file'))
      : 'file'
    const parsed = parseDiffDocument(source.diff, pathValue)
    if (parsed.files.length) return parsed.files
    const counts = countPatchLines(source.diff)
    return [{ path: pathValue, patch: source.diff, additions: counts.additions, deletions: counts.deletions, status: 'modified', large: Boolean(source.large) || Boolean(source.isLargeFile) }]
  }

  return []
}

export function parseDiffLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = Number(match[1])
        newLine = Number(match[2])
      }
      lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ') || line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ')) {
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (line === '\\ No newline at end of file') {
      lines.push({ kind: 'meta', text: line })
      continue
    }
    if (line.startsWith('+')) {
      lines.push({ kind: 'add', text: line.slice(1), newLine })
      newLine++
      continue
    }
    if (line.startsWith('-')) {
      lines.push({ kind: 'remove', text: line.slice(1), oldLine })
      oldLine++
      continue
    }
    if (line.startsWith(' ')) {
      lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine })
      oldLine++
      newLine++
      continue
    }
    if (line !== '') lines.push({ kind: 'meta', text: line })
  }
  return lines
}

function numberCell(value: number | undefined, width: number) {
  return String(value ?? '').padStart(width)
}

function lineTone(kind: DiffLine['kind'], theme: Theme): { fg: string; bg?: string } {
  if (kind === 'add') return { fg: theme.success, bg: theme.diffAdded }
  if (kind === 'remove') return { fg: theme.error, bg: theme.diffRemoved }
  if (kind === 'hunk') return { fg: theme.info, bg: theme.diffContext }
  if (kind === 'meta') return { fg: theme.muted, bg: theme.diffContext }
  return { fg: theme.text, bg: undefined }
}

function renderUnifiedLine(
  line: DiffLine,
  width: number,
  numberWidth: number,
  theme: Theme,
  capability: ColorCapability,
  language: string,
) {
  const gutterWidth = numberWidth * 2 + 4
  const textWidth = Math.max(1, remainingWidth(width, gutterWidth))
  const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : line.kind === 'context' ? ' ' : line.kind === 'hunk' ? '@' : '·'
  const tone = lineTone(line.kind, theme)
  const numbers = line.kind === 'hunk' || line.kind === 'meta'
    ? ' '.repeat(gutterWidth - 1)
    : `${numberCell(line.oldLine, numberWidth)} ${numberCell(line.newLine, numberWidth)} `
  const prefix = `${numbers}${marker} `
  const content = clip(line.text, Math.max(1, textWidth - 1))
  const prefixColor = line.kind === 'add' ? theme.success : line.kind === 'remove' ? theme.error : theme.muted
  const renderedContent = ['add', 'remove', 'context'].includes(line.kind)
    ? paintCodeLine(content, language, theme, capability, tone.bg)
    : paint(content, { fg: tone.fg, bg: tone.bg, capability })
  return padRight(`${paint(prefix, { fg: prefixColor, capability })}${renderedContent}`, width)
}

function pairSplitLines(lines: DiffLine[]) {
  const pairs: Array<{ left?: DiffLine; right?: DiffLine; hunk?: DiffLine; meta?: DiffLine }> = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.kind === 'hunk') { pairs.push({ hunk: line }); i++; continue }
    if (line.kind === 'meta') { pairs.push({ meta: line }); i++; continue }
    if (line.kind === 'context') { pairs.push({ left: line, right: line }); i++; continue }
    if (line.kind === 'remove') {
      const removals: DiffLine[] = []
      while (i < lines.length && lines[i]?.kind === 'remove') removals.push(lines[i++]!)
      const additions: DiffLine[] = []
      while (i < lines.length && lines[i]?.kind === 'add') additions.push(lines[i++]!)
      const count = Math.max(removals.length, additions.length)
      for (let n = 0; n < count; n++) pairs.push({ left: removals[n], right: additions[n] })
      continue
    }
    if (line.kind === 'add') {
      const additions: DiffLine[] = []
      while (i < lines.length && lines[i]?.kind === 'add') additions.push(lines[i++]!)
      for (const addition of additions) pairs.push({ right: addition })
      continue
    }
    i++
  }
  return pairs
}

function renderSplitSide(
  line: DiffLine | undefined,
  sideWidth: number,
  numberWidth: number,
  theme: Theme,
  capability: ColorCapability,
  language: string,
) {
  if (!line) return ' '.repeat(sideWidth)
  const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
  const tone = lineTone(line.kind, theme)
  const textWidth = Math.max(1, contentWidth(sideWidth, { borderLeft: 0, borderRight: 0, paddingLeft: numberWidth + 3, paddingRight: 0 }))
  const prefix = `${numberCell(line.kind === 'remove' ? line.oldLine : line.newLine, numberWidth)} ${marker} `
  const prefixColor = line.kind === 'add' ? theme.success : line.kind === 'remove' ? theme.error : theme.muted
  const content = clip(line.text, textWidth)
  const renderedContent = ['add', 'remove', 'context'].includes(line.kind)
    ? paintCodeLine(content, language, theme, capability, tone.bg)
    : paint(content, { fg: tone.fg, bg: tone.bg, capability })
  return padRight(paint(prefix, { fg: prefixColor, capability }) + renderedContent, sideWidth)
}

function renderSplitLine(
  pair: ReturnType<typeof pairSplitLines>[number],
  width: number,
  numberWidth: number,
  theme: Theme,
  capability: ColorCapability,
  language: string,
) {
  if (pair.hunk || pair.meta) {
    const tone = pair.hunk ? lineTone('hunk', theme) : lineTone('meta', theme)
    return padRight(paint(clip(`${pair.hunk?.text ?? pair.meta?.text ?? ''}`, width), { fg: tone.fg, bg: tone.bg, capability }), width)
  }
  const separator = ' │ '
  const sideWidth = Math.max(6, Math.floor((width - widthOf(separator)) / 2))
  const rightWidth = Math.max(1, remainingWidth(width, widthOf(separator), sideWidth))
  return `${renderSplitSide(pair.left, sideWidth, numberWidth, theme, capability, language)}${paint(separator, { fg: theme.border, capability })}${renderSplitSide(pair.right, rightWidth, numberWidth, theme, capability, language)}`
}

export function renderDiffFile(options: {
  width: number
  file: DiffFile
  theme: Theme
  capability: ColorCapability
  view?: DiffView
  maxRows?: number
  showHeader?: boolean
}) {
  const width = Math.max(24, options.width)
  const view = options.view ?? (width >= 120 ? 'split' : 'unified')
  const lines: string[] = []
  if (options.showHeader !== false) {
    const status = options.file.status && options.file.status !== 'modified' ? ` · ${options.file.status}` : ''
    const stats = options.file.binary ? 'binary' : `+${options.file.additions} -${options.file.deletions}`
    lines.push(padRight(paint(`  ${options.file.path}`, { fg: options.theme.text, capability: options.capability, attrs: { bold: true } }) + paint(`  ${stats}${status}`, { fg: options.theme.muted, capability: options.capability }), width))
  }
  if (options.file.binary) {
    lines.push(padRight(paint('  Binary file · diff content is not displayable.', { fg: options.theme.muted, capability: options.capability, attrs: { dim: true } }), width))
    return lines
  }
  if (options.file.large) {
    lines.push(padRight(paint('  Large file · diff content is omitted for performance.', { fg: options.theme.muted, capability: options.capability, attrs: { dim: true } }), width))
    return lines
  }
  if (options.file.status === 'untracked' && !options.file.patch.trim()) {
    lines.push(padRight(paint('  Untracked file · no patch content is available.', { fg: options.theme.muted, capability: options.capability, attrs: { dim: true } }), width))
    return lines
  }
  const parsed = parseDiffLines(options.file.patch)
  const language = languageFromPath(options.file.path)
  const maxLine = parsed.reduce((max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0), 0)
  const numberWidth = Math.max(3, String(Math.max(1, maxLine)).length)
  const rendered = view === 'split'
    ? pairSplitLines(parsed).map((pair) => renderSplitLine(pair, width, numberWidth, options.theme, options.capability, language))
    : parsed.map((line) => renderUnifiedLine(line, width, numberWidth, options.theme, options.capability, language))
  const maxRows = Math.max(1, options.maxRows ?? 160)
  const headerRows = lines.length
  const availableBodyRows = Math.max(0, maxRows - headerRows)
  const truncated = rendered.length > availableBodyRows || options.file.truncated
  const bodyRows = truncated ? Math.max(0, availableBodyRows - 1) : availableBodyRows
  lines.push(...rendered.slice(0, bodyRows))
  if (truncated && lines.length < maxRows) {
    const remaining = Math.max(0, rendered.length - bodyRows)
    lines.push(padRight(paint(`  … diff truncated (${remaining} more rows)`, { fg: options.theme.muted, capability: options.capability, attrs: { dim: true } }), width))
  }
  return lines.map((line) => padRight(line, width))
}

export function renderDiffFiles(options: {
  width: number
  files: DiffFile[]
  theme: Theme
  capability: ColorCapability
  view?: DiffView
  maxRows?: number
  gapRows?: number
}) {
  const rows: string[] = []
  const maxRows = Math.max(1, options.maxRows ?? 180)
  const gapRows = Math.max(0, options.gapRows ?? 1)
  for (let i = 0; i < options.files.length; i++) {
    if (rows.length >= maxRows) break
    const fileRows = renderDiffFile({
      width: options.width,
      file: options.files[i]!,
      theme: options.theme,
      capability: options.capability,
      view: options.view,
      maxRows: Math.max(1, maxRows - rows.length),
    })
    rows.push(...fileRows)
    if (i < options.files.length - 1 && rows.length < maxRows) rows.push(...Array.from({ length: Math.min(gapRows, maxRows - rows.length) }, () => ' '.repeat(Math.max(0, options.width))))
  }
  if (rows.length >= maxRows && options.files.length) {
    rows.splice(maxRows - 1, 1, padRight(paint('  … more file changes', { fg: options.theme.muted, capability: options.capability, attrs: { dim: true } }), options.width))
  }
  return rows.slice(0, maxRows).map((row) => padRight(row, options.width))
}

/** Backward-compatible primitive used by the old experimental surface tests. */
export function renderDiffBlock(options: {
  width: number
  title: string
  lines: Array<{ kind: 'context' | 'add' | 'remove' | 'hunk'; text: string }>
  theme: Theme
  capability: ColorCapability
}) {
  const patch = [
    `--- a/${options.title}`,
    `+++ b/${options.title}`,
    ...options.lines.map((line) => line.kind === 'hunk' ? line.text : `${line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}${line.text}`),
  ].join('\n')
  return renderDiffFile({
    width: options.width,
    file: { path: options.title, patch, additions: options.lines.filter((line) => line.kind === 'add').length, deletions: options.lines.filter((line) => line.kind === 'remove').length },
    theme: options.theme,
    capability: options.capability,
  })
}
