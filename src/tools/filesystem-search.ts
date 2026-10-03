import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { within } from '../util/fs.js'

export const DEFAULT_SEARCH_RESULTS = 250
export const DEFAULT_GLOB_RESULTS = 100
export const MAX_SEARCH_RESULTS = 1000
export const MAX_GLOB_RESULTS = 1000
export const DEFAULT_DIRECTORY_PAGE = 2000
type DirectoryEntryLike = {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'target',
  'venv',
  '.venv',
])

export type SearchMatch = {
  path: string
  line: number
  text: string
}

export type SearchResult = {
  matches: SearchMatch[]
  totalMatches: number
  truncated: boolean
  engine: 'ripgrep' | 'node'
}

export type GlobResult = {
  files: string[]
  totalFiles: number
  truncated: boolean
  engine: 'ripgrep' | 'node'
}

export type DirectoryEntry = {
  name: string
  type: 'file' | 'directory'
}

export type DirectoryPage = {
  entries: DirectoryEntry[]
  totalEntries: number
  truncated: boolean
  nextOffset?: number
}

export function normalizeRelativePath(value: string) {
  return value.replaceAll('\\', '/')
}

export function isIgnoredName(name: string) {
  return IGNORED_DIRECTORIES.has(name)
}

function hasGlobSyntax(pattern: string) {
  return /[*?\[\]{}]/.test(pattern)
}

function escapeRegex(value: string) {
  return value.replace(/[.+^$()|\\]/g, '\\$&')
}

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{')
  if (start === -1) return [pattern]
  let depth = 0
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++
    else if (pattern[i] === '}') {
      depth--
      if (depth !== 0) continue
      const inside = pattern.slice(start + 1, i)
      const parts: string[] = []
      let piece = ''
      let innerDepth = 0
      for (const char of inside) {
        if (char === '{') innerDepth++
        if (char === '}') innerDepth--
        if (char === ',' && innerDepth === 0) {
          parts.push(piece)
          piece = ''
        } else piece += char
      }
      parts.push(piece)
      if (parts.length < 2) return [pattern]
      const output: string[] = []
      for (const part of parts) {
        for (const expanded of expandBraces(pattern.slice(0, start) + part + pattern.slice(i + 1))) {
          output.push(expanded)
        }
      }
      return output
    }
  }
  return [pattern]
}

function globToRegexSource(pattern: string): string {
  const normalized = normalizeRelativePath(pattern)
  const expanded = expandBraces(normalized)
  if (expanded.length > 1) {
    return `(?:${expanded.map(item => globToRegexSource(item)).join('|')})`
  }

  let out = ''
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        i++
        if (normalized[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else out += '[^/]*'
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if (char === '[') {
      const close = normalized.indexOf(']', i + 1)
      if (close !== -1) {
        let cls = normalized.slice(i + 1, close)
        if (cls.startsWith('!')) cls = '^' + cls.slice(1)
        out += `[${cls.replaceAll('\\', '\\\\')}]`
        i = close
        continue
      }
    }
    out += escapeRegex(char)
  }
  return out
}

export function globToRegExp(pattern: string) {
  return new RegExp(`^(?:${globToRegexSource(pattern)})$`)
}

function clampLimit(value: unknown, fallback: number, maximum: number) {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, maximum)
}

function clampOffset(value: unknown) {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function fallbackTextDecoder() {
  return new TextDecoder('utf-8', { fatal: true })
}

async function readTextFileLines(filePath: string, pattern: RegExp, result: SearchMatch[], limit: number, signal: AbortSignal) {
  const bytes = await fs.readFile(filePath)
  if (signal.aborted) throw new Error('Search aborted')
  if (bytes.includes(0)) return 0
  let text: string
  try {
    text = fallbackTextDecoder().decode(bytes)
  } catch {
    return 0
  }
  const lines = text.split(/\r?\n/)
  let matches = 0
  for (let index = 0; index < lines.length; index++) {
    if (signal.aborted) throw new Error('Search aborted')
    if (result.length >= limit) return matches
    const line = lines[index] ?? ''
    if (!pattern.test(line)) continue
    matches++
    result.push({ path: filePath, line: index + 1, text: line })
  }
  return matches
}

async function walkFiles(root: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string) {
    if (signal.aborted) throw new Error('Search aborted')
    const entries = (await fs.readdir(dir, { withFileTypes: true })) as DirectoryEntryLike[]
    entries.sort((a: DirectoryEntryLike, b: DirectoryEntryLike) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (signal.aborted) throw new Error('Search aborted')
      if (isIgnoredName(entry.name) || entry.name === '.DS_Store') continue
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(target)
      } else if (entry.isFile()) {
        files.push(target)
      }
    }
  }
  await walk(root)
  return files
}

async function runRipgrep(args: string[], cwd: string, timeout: number, signal: AbortSignal) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`ripgrep timed out after ${timeout}ms`))
    }, timeout)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string | Uint8Array) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: string | Uint8Array) => { stderr += chunk.toString() })
    child.once('error', (error: Error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code: number | null) => {
      clearTimeout(timer)
      if (code === 0 || code === 1) resolve(stdout)
      else reject(new Error(stderr.trim() || `ripgrep exited with code ${code ?? 'unknown'}`))
    })
  })
}

function parseRipgrepJson(output: string, root: string, pattern: RegExp, include: RegExp | null, limit: number): SearchMatch[] {
  const result: SearchMatch[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    let parsed: any
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed.type !== 'match') continue
    const rawPath = parsed.data?.path?.text
    const lineNumber = Number(parsed.data?.line_number)
    if (typeof rawPath !== 'string' || !Number.isInteger(lineNumber)) continue
    const absolute = path.resolve(root, rawPath)
    const relative = path.relative(root, absolute)
    if (include && !include.test(normalizeRelativePath(relative))) continue
    const text = String(parsed.data?.lines?.text ?? '').replace(/\n$/, '').replace(/\r$/, '')
    if (!pattern.test(text)) continue
    result.push({ path: absolute, line: lineNumber, text })
    if (result.length >= limit) break
  }
  return result
}

export async function searchText(input: {
  pattern: string
  root: string
  include?: string
  limit?: number
  offset?: number
  timeout: number
  signal: AbortSignal
}): Promise<SearchResult> {
  if (!input.pattern) throw new Error('pattern is required')
  let regex: RegExp
  try { regex = new RegExp(input.pattern) } catch (error) { throw new Error(`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`) }
  const includeRegex = input.include ? globToRegExp(input.include) : null
  const limit = clampLimit(input.limit, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS)
  const offset = Math.max(0, Math.floor(Number(input.offset) || 0))

  const args = ['--json', '--hidden', '--line-number', '--no-messages']
  for (const dir of IGNORED_DIRECTORIES) args.push('--glob', `!${dir}/**`)
  if (input.include) args.push('--glob', input.include)
  args.push(input.pattern, input.root)

  try {
    const raw = await runRipgrep(args, input.root, input.timeout, input.signal)
    const all = parseRipgrepJson(raw, input.root, regex, includeRegex, MAX_SEARCH_RESULTS + 1)
    all.sort((a, b) => normalizeRelativePath(path.relative(input.root, a.path)).localeCompare(normalizeRelativePath(path.relative(input.root, b.path))) || a.line - b.line || a.text.localeCompare(b.text))
    const paged = all.slice(offset, offset + limit)
    return {
      matches: paged,
      totalMatches: all.length,
      truncated: all.length > offset + limit || raw.length > 0 && all.length >= MAX_SEARCH_RESULTS + 1,
      engine: 'ripgrep',
    }
  } catch (error) {
    if (error instanceof Error && /Invalid regex pattern|aborted/i.test(error.message)) throw error
  }

  const rootStat = await fs.stat(input.root)
  const files = rootStat.isFile() ? [input.root] : await walkFiles(input.root, input.signal)
  const matches: SearchMatch[] = []
  let totalMatches = 0
  for (const file of files) {
    if (includeRegex && !includeRegex.test(normalizeRelativePath(path.relative(input.root, file)))) continue
    totalMatches += await readTextFileLines(file, regex, matches, offset + limit + 1, input.signal)
    if (matches.length > offset + limit) break
  }
  const paged = matches.slice(offset, offset + limit)
  return {
    matches: paged,
    totalMatches,
    truncated: matches.length > offset + limit || totalMatches > offset + limit,
    engine: 'node',
  }
}

export async function globFiles(input: {
  pattern: string
  root: string
  limit?: number
  offset?: number
  timeout: number
  signal: AbortSignal
}): Promise<GlobResult> {
  const pattern = normalizeRelativePath(input.pattern)
  const matcher = globToRegExp(pattern)
  const limit = clampLimit(input.limit, DEFAULT_GLOB_RESULTS, MAX_GLOB_RESULTS)
  const offset = Math.max(0, Math.floor(Number(input.offset) || 0))

  const args = ['--files', '--hidden', '--no-messages']
  for (const dir of IGNORED_DIRECTORIES) args.push('--glob', `!${dir}/**`)
  args.push('--glob', pattern, input.root)

  try {
    const raw = await runRipgrep(args, input.root, input.timeout, input.signal)
    const files = raw.split('\n').filter(Boolean).map(item => path.resolve(input.root, item)).filter(item => matcher.test(normalizeRelativePath(path.relative(input.root, item))))
    const unique = [...new Set(files)].sort((a, b) => normalizeRelativePath(path.relative(input.root, a)).localeCompare(normalizeRelativePath(path.relative(input.root, b))))
    const paged = unique.slice(offset, offset + limit)
    return { files: paged, totalFiles: unique.length, truncated: unique.length > offset + limit, engine: 'ripgrep' }
  } catch (error) {
    if (error instanceof Error && /aborted/i.test(error.message)) throw error
  }

  const rootStat = await fs.stat(input.root)
  if (!rootStat.isDirectory()) throw new Error(`glob path must be a directory: ${input.root}`)
  const files = await walkFiles(input.root, input.signal)
  const matched = files.filter(file => matcher.test(normalizeRelativePath(path.relative(input.root, file))))
  matched.sort((a, b) => normalizeRelativePath(path.relative(input.root, a)).localeCompare(normalizeRelativePath(path.relative(input.root, b))))
  const paged = matched.slice(offset, offset + limit)
  return { files: paged, totalFiles: matched.length, truncated: matched.length > offset + limit, engine: 'node' }
}

export async function listDirectoryPage(root: string, input: { offset?: number; limit?: number } = {}, signal?: AbortSignal): Promise<DirectoryPage> {
  const offset = clampOffset(input.offset)
  const limit = clampLimit(input.limit, DEFAULT_DIRECTORY_PAGE, DEFAULT_DIRECTORY_PAGE)
  const raw = ((await fs.readdir(root, { withFileTypes: true })) as DirectoryEntryLike[]).filter((entry: DirectoryEntryLike) => !isIgnoredName(entry.name) && entry.name !== '.DS_Store')
  const entries: DirectoryEntry[] = []
  for (const entry of raw.sort((a: DirectoryEntryLike, b: DirectoryEntryLike) => a.name.localeCompare(b.name))) {
    if (signal?.aborted) throw new Error('Directory listing aborted')
    if (entry.isDirectory()) entries.push({ name: `${entry.name}/`, type: 'directory' })
    else if (entry.isFile()) entries.push({ name: entry.name, type: 'file' })
    else if (entry.isSymbolicLink()) {
      const link = path.join(root, entry.name)
      try {
        const resolved = await fs.realpath(link)
        if (!within(root, resolved)) continue
        const stat = await fs.stat(resolved)
        if (stat.isDirectory()) entries.push({ name: `${entry.name}/`, type: 'directory' })
        else if (stat.isFile()) entries.push({ name: entry.name, type: 'file' })
      } catch {}
    }
  }
  const selected = entries.slice(offset - 1, offset - 1 + limit)
  const truncated = offset - 1 + selected.length < entries.length
  return { entries: selected, totalEntries: entries.length, truncated, ...(truncated ? { nextOffset: offset + selected.length } : {}) }
}
