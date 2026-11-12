import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import { exists } from '../util/fs.js'

const names = ['TERMAGENT.md', 'AGENTS.md', 'CLAUDE.md', 'AGENTS.md.local'] as const
const DEFAULT_TOTAL_BYTES = 64 * 1024
const HARD_TOTAL_BYTES = 512 * 1024
const DEFAULT_FILE_BYTES = 16 * 1024
const HARD_FILE_BYTES = 128 * 1024

export interface InstructionFile {
  path: string
  relativePath: string
  content: string
  sha256: string
  mtimeMs: number
  size: number
  scope: 'global' | 'ancestor' | 'nested'
}

export interface InstructionLoadResult {
  files: InstructionFile[]
  text: string
  totalBytes: number
  truncated: boolean
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function boundedBytes(value: number | undefined, fallback: number, hard: number): number {
  if (value === 0) return 0
  if (!Number.isFinite(value) || !value || value <= 0) return fallback
  return Math.min(hard, Math.max(1024, Math.floor(value)))
}

async function readInstruction(file: string, cwd: string, scope: InstructionFile['scope'], maxBytes: number): Promise<InstructionFile | undefined> {
  try {
    const real = await fs.realpath(file)
    // A nested instruction symlink must not escape the workspace. Ancestor
    // and global files are intentionally outside cwd; nested files are not.
    if (scope === 'nested' && !inside(cwd, real)) return undefined
    const stat = await fs.stat(real)
    if (!stat.isFile()) return undefined
    // Instruction payloads are bounded independently from file size. Avoid
    // reading a giant AGENTS.md into memory just to slice its prefix.
    const handle = await fs.open(real, 'r')
    let raw: Uint8Array
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      raw = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    const content = Buffer.from(raw.subarray(0, maxBytes)).toString('utf8').replace(/^\uFEFF/, '').trim()
    if (!content) return undefined
    return {
      path: real,
      relativePath: path.relative(cwd, real) || path.basename(real),
      content,
      // Include file metadata so edits beyond the loaded prefix still
      // invalidate the cached instruction reference.
      sha256: crypto.createHash('sha256').update(raw).update('\0').update(String(stat.size)).update('\0').update(String(stat.mtimeMs)).digest('hex'),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      scope,
    }
  } catch {
    return undefined
  }
}

export function formatInstructionFiles(files: readonly InstructionFile[]): string {
  return files.map(file => `## ${file.relativePath}\n${file.content}`).join('\n\n')
}

async function collectAtRoots(
  roots: Array<{ root: string; scope: InstructionFile['scope']; names: readonly string[] }>,
  cwd: string,
  options: { maxBytes?: number; maxFileBytes?: number } = {},
): Promise<InstructionLoadResult> {
  const totalLimit = boundedBytes(options.maxBytes, DEFAULT_TOTAL_BYTES, HARD_TOTAL_BYTES)
  const fileLimit = boundedBytes(options.maxFileBytes, DEFAULT_FILE_BYTES, HARD_FILE_BYTES)
  const files: InstructionFile[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  let truncated = false

  for (const entry of roots) {
    for (const name of entry.names) {
      if (totalBytes >= totalLimit) { truncated = true; break }
      const filePath = path.join(entry.root, name)
      if (seen.has(path.resolve(filePath)) || !(await exists(filePath))) continue
      const file = await readInstruction(filePath, cwd, entry.scope, Math.min(fileLimit, totalLimit - totalBytes))
      if (!file) continue
      seen.add(file.path)
      const encodedBytes = Buffer.byteLength(file.content, 'utf8')
      if (file.size > fileLimit || totalBytes + encodedBytes >= totalLimit) truncated = true
      if (encodedBytes > totalLimit - totalBytes) break
      files.push(file)
      totalBytes += encodedBytes
    }
    if (totalBytes >= totalLimit) break
  }

  return { files, text: formatInstructionFiles(files), totalBytes, truncated }
}

function ancestorRoots(cwd: string): string[] {
  const roots: string[] = []
  let current = path.resolve(cwd)
  while (true) {
    roots.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots.reverse()
}

function globalRoots(): string[] {
  const home = os.homedir()
  return [path.join(home, '.config', 'termagent'), path.join(home, '.termagent')]
}

/** Load global instructions and the deterministic root-to-workspace chain. */
export async function loadInstructionFiles(cwd: string, options: { maxBytes?: number; maxFileBytes?: number } = {}): Promise<InstructionLoadResult> {
  const resolvedCwd = path.resolve(cwd)
  const roots = [
    ...globalRoots().map(root => ({ root, scope: 'global' as const, names })),
    ...ancestorRoots(resolvedCwd).map(root => ({ root, scope: 'ancestor' as const, names })),
  ]
  return collectAtRoots(roots, resolvedCwd, options)
}

/** Compatibility wrapper retained for all existing CLI/server callers. */
export async function loadInstructions(cwd: string): Promise<string> {
  return (await loadInstructionFiles(cwd)).text
}

/**
 * Discover instruction files newly relevant to target paths below the
 * workspace. Only ancestor directories between cwd and each target are
 * inspected; sibling instructions never leak into another subtree.
 */
export async function loadScopedInstructionFiles(
  cwd: string,
  targetPaths: readonly string[],
  options: { maxBytes?: number; maxFileBytes?: number; directoryPaths?: readonly string[] } = {},
): Promise<InstructionLoadResult> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd))
  const directories = new Set<string>()
  for (const value of targetPaths) {
    if (typeof value !== 'string' || !value.trim()) continue
    const absolute = path.resolve(root, value)
    const isDirectory = options.directoryPaths?.some(item => path.resolve(root, item) === absolute)
    const targetDirectory = isDirectory ? absolute : path.dirname(absolute)
    if (!inside(root, targetDirectory)) continue
    let current = targetDirectory
    while (inside(root, current)) {
      directories.add(current)
      if (current === root) break
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  const ordered = [...directories].sort((a, b) => {
    const depth = (value: string) => path.relative(root, value).split(path.sep).filter(Boolean).length
    return depth(a) - depth(b) || a.localeCompare(b)
  })
  return collectAtRoots(ordered.map(directory => ({ root: directory, scope: 'nested' as const, names })), root, options)
}

/** Rehydrate previously discovered nested instruction paths after restart. */
export async function loadInstructionPaths(
  cwd: string,
  paths: readonly string[],
  options: { maxBytes?: number; maxFileBytes?: number } = {},
): Promise<InstructionLoadResult> {
  const root = await fs.realpath(cwd).catch(() => path.resolve(cwd))
  const allowedRoots = [root, ...globalRoots().map(value => path.resolve(value))]
  const roots: Array<{ root: string; scope: InstructionFile['scope']; names: readonly string[] }> = []
  const seen = new Set<string>()
  for (const value of paths) {
    if (typeof value !== 'string' || !value.trim()) continue
    const absolute = path.resolve(value)
    if (!allowedRoots.some(allowed => inside(allowed, absolute)) || seen.has(absolute)) continue
    seen.add(absolute)
    roots.push({ root: path.dirname(absolute), scope: inside(root, absolute) ? 'nested' : 'global', names: [path.basename(absolute)] })
  }
  return collectAtRoots(roots, root, options)
}
