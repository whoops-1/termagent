import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function exists(p: string) {
  try { await fs.access(p); return true } catch { return false }
}
export async function ensureDir(p: string) { await fs.mkdir(p, { recursive: true }) }
export function expandHome(p: string) { return p.startsWith('~/') ? path.join(process.env.HOME || process.cwd(), p.slice(2)) : p }
export function within(root: string, target: string) {
  const r = path.resolve(root) + path.sep
  const t = path.resolve(target)
  return t === path.resolve(root) || t.startsWith(r)
}
export async function readText(p: string) { return fs.readFile(p, 'utf8') }
export async function writeText(p: string, content: string) { await ensureDir(path.dirname(p)); await fs.writeFile(p, content, 'utf8') }
