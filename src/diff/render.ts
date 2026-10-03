import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type DiffFile = { path: string; additions: number; deletions: number; binary?: boolean }
export type DiffResult = { text: string; files: DiffFile[]; additions: number; deletions: number }

export type TextDiffResult = { text: string; additions: number; deletions: number; binary?: boolean }

function runGit(cwd: string, args: string[]) {
  return new Promise<string>((resolve) => {
    const p = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    p.stdout.on('data', (b: any) => { text += b.toString() })
    p.on('close', () => resolve(text))
    p.on('error', () => resolve(''))
  })
}
async function runGitRaw(args: string[]) {
  return await new Promise<string>((resolve) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (b: any) => { text += b.toString() })
    child.on('close', () => resolve(text))
    child.on('error', () => resolve(''))
  })
}

/**
 * Create a bounded unified patch for an in-memory file change.
 * This deliberately reuses Git's diff engine, which is already required by
 * TermAgent's snapshot/working-tree features, instead of introducing another
 * diff implementation or a native dependency.
 */
export async function renderTextDiff(filePath: string, oldText: string, newText: string, opts: { maxBytes?: number } = {}): Promise<TextDiffResult> {
  if (oldText === newText) return { text: '', additions: 0, deletions: 0 }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-text-diff-'))
  const oldFile = path.join(dir, 'old')
  const newFile = path.join(dir, 'new')
  try {
    await fs.writeFile(oldFile, oldText, 'utf8')
    await fs.writeFile(newFile, newText, 'utf8')
    const raw = await runGitRaw(['diff', '--no-index', '--no-color', '--no-ext-diff', '--unified=3', oldFile, newFile])
    if (!raw) return { text: '', additions: 0, deletions: 0 }

    const label = String(filePath).replaceAll('\\', '/')
    const lines = raw.replace(/\r\n/g, '\n').split('\n')
    const output: string[] = []
    let additions = 0
    let deletions = 0
    for (const line of lines) {
      if (line.startsWith('diff --git ') || line.startsWith('index ')) continue
      if (line.startsWith('--- ')) { output.push(`--- a/${label}`); continue }
      if (line.startsWith('+++ ')) { output.push(`+++ b/${label}`); continue }
      if (line.startsWith('+') && !line.startsWith('+++')) additions++
      if (line.startsWith('-') && !line.startsWith('---')) deletions++
      output.push(line)
    }
    let text = output.join('\n').trimEnd()
    const maxBytes = Math.max(1024, Number(opts.maxBytes || 12000))
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      const suffix = '\n… diff truncated'
      text = truncateUtf8(text, Math.max(1, maxBytes - Buffer.byteLength(suffix, 'utf8'))) + suffix
    }
    return { text, additions, deletions }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const chars = Array.from(text)
  let low = 0, high = chars.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(chars.slice(0, mid).join(''), 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  return chars.slice(0, low).join('')
}

export async function gitDiff(cwd: string, staged = false): Promise<string> {
  const result = await renderGitDiff(cwd, { staged })
  return result.text || 'No changes.'
}

export async function renderGitDiff(cwd: string, opts: { staged?: boolean; color?: boolean; maxBytes?: number } = {}): Promise<DiffResult> {
  const args = ['diff', '--no-ext-diff', '--unified=3', '--no-color']
  if (opts.staged) args.push('--cached')
  const raw = await runGit(cwd, args)
  if (!raw) return { text: 'No changes.', files: [], additions: 0, deletions: 0 }
  const files: DiffFile[] = []
  let current: DiffFile | undefined
  const output: string[] = []
  let additions = 0
  let deletions = 0
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      const file = match?.[2] || match?.[1] || 'unknown'
      current = { path: file, additions: 0, deletions: 0 }
      files.push(current)
    }
    if (line.startsWith('Binary files ')) {
      if (current) current.binary = true
      output.push(line)
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) { additions++; if (current) current.additions++ }
    if (line.startsWith('-') && !line.startsWith('---')) { deletions++; if (current) current.deletions++ }
    output.push(line)
  }
  let text = output.join('\n').trimEnd()
  if (opts.maxBytes && Buffer.byteLength(text, 'utf8') > opts.maxBytes) {
    const suffix='\n… diff truncated'
    if(opts.maxBytes<=Buffer.byteLength(suffix,'utf8')) text=truncateUtf8(suffix,opts.maxBytes)
    else text=truncateUtf8(text,opts.maxBytes-Buffer.byteLength(suffix,'utf8'))+suffix
  }
  let rendered = opts.color === false ? text : colorizeDiff(text)
  if (opts.maxBytes && Buffer.byteLength(rendered, 'utf8') > opts.maxBytes) rendered = truncateUtf8(text, opts.maxBytes)
  return { text: rendered, files, additions, deletions }
}

function colorizeDiff(text: string) {
  const reset = '\x1b[0m'
  const green = '\x1b[32m'
  const red = '\x1b[31m'
  const cyan = '\x1b[36m'
  return text.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return `${cyan}${line}${reset}`
    if (line.startsWith('+')) return `${green}${line}${reset}`
    if (line.startsWith('-')) return `${red}${line}${reset}`
    if (line.startsWith('@@')) return `${cyan}${line}${reset}`
    return line
  }).join('\n')
}
