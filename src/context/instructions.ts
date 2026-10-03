import path from 'node:path'
import { promises as fs } from 'node:fs'
import { exists } from '../util/fs.js'

const names = ['TERMAGENT.md', 'AGENTS.md', 'CLAUDE.md']

export async function loadInstructions(cwd: string): Promise<string> {
  const roots: string[] = []
  let cur = path.resolve(cwd)
  while (true) {
    roots.push(cur)
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  roots.reverse()
  const parts: string[] = []
  for (const root of roots) for (const name of names) {
    const file = path.join(root, name)
    if (await exists(file)) {
      const text = await fs.readFile(file, 'utf8')
      parts.push(`## ${path.relative(cwd, file) || name}\n${text.trim()}`)
    }
  }
  return parts.join('\n\n')
}
