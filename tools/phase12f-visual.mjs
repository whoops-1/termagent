import fs from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { TerminalUI } from '../dist/cli/ui.js'
import { stripAnsi } from '../dist/design-system/ansi.js'

export const FIXED_NOW = 1_700_000_000_000
export const SNAPSHOT_ROOT = path.resolve(new URL('../tests/qa/phase12f-snapshots/', import.meta.url).pathname)

function wait(ms = 15) { return new Promise(resolve => setTimeout(resolve, ms)) }

function harness(width, height) {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = () => input
  input.resume = () => input
  input.pause = () => input
  input.setEncoding = () => input
  const output = new EventEmitter()
  output.columns = width
  output.rows = height
  output.write = () => true
  return { input, output }
}

function diffResult(fileCount = 1) {
  const chunks = []
  const files = []
  for (let i = 0; i < fileCount; i++) {
    const name = 'src/example-000.ts'
    const patch = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,3 +1,4 @@\n const before = ${i}\n-const value = ${i}\n+const value = ${i + 1}\n+const extra = ${i}\n`
    chunks.push(patch)
    files.push({ path: name, patch, status: 'modified', additions: 2, deletions: 1 })
  }
  return { text: chunks.join('\n'), files, additions: fileCount * 2, deletions: fileCount }
}

export async function renderPhase12FSnapshot(scene, width, height) {
  const originalNow = Date.now
  const originalTerm = process.env.TERM
  const originalColorTerm = process.env.COLORTERM
  const originalNoColor = process.env.NO_COLOR
  Date.now = () => FIXED_NOW
  process.env.TERM = 'dumb'
  process.env.COLORTERM = ''
  process.env.NO_COLOR = '1'
  const { input, output } = harness(width, height)
  const ui = new TerminalUI({ title: 'phase12f', model: 'mock', provider: 'provider', mode: 'build', cwd: '/workspace/project', output, input })
  let pending = []
  try {
    ui.enter()
    if (scene === 'startup' || scene === 'narrow-fallback') {
      ui['startupUntil'] = FIXED_NOW + 900
    } else if (scene === 'transcript') {
      ui.addUser('USER: Preserve this transcript identity without repeated speaker badges.')
      ui.appendAssistant('ASSISTANT: A responsive transcript must keep content primary. '.repeat(3))
    } else if (scene === 'picker') {
      ui.addUser('Open the command picker.')
      ui.setCompletion({ kind: 'palette', query: '', index: 12, items: Array.from({ length: 15 }, (_, i) => `/command-${i}`) })
    } else if (scene === 'inline-diff') {
      ui.addUser('Show the edit diff inline.')
      ui.startTool('edit_file', { path: 'src/example.ts' })
      ui.endTool('edit_file', 'updated', {
        files: [{ relativePath: 'src/example.ts', diff: diffResult().text, additions: 2, deletions: 1 }],
      })
    } else if (scene === 'diff-inspector') {
      ui.addUser('Inspect the working tree.')
      ui.openWorkingTreeDiff({
        ...diffResult(6),
        text: diffResult(6).text,
      }, 'Working tree changes')
      input.emit('data', '\r')
    } else if (scene === 'permission') {
      ui.startAssistant()
      pending.push(ui.requestPermission({
        tool: { name: 'bash', description: 'shell', risk: 'shell', schema: { type: 'object' } },
        args: { command: 'echo phase12f permission' },
      }))
      await wait()
    } else if (scene === 'question') {
      ui.addUser('Answer the responsive question.')
      ui.startAssistant()
      pending.push(ui.requestQuestion([{
        header: 'Choice',
        question: 'Which responsive layout should be preserved?',
        options: [{ label: 'bounded' }, { label: 'stacked' }, { label: 'wide' }, { label: 'adaptive' }, { label: 'fallback' }],
        multi: false,
        custom: false,
      }]))
      await wait()
    }
    if (scene !== 'startup' && scene !== 'narrow-fallback') ui['startupUntil'] = FIXED_NOW - 1
    ui.render()
    return ui['previousFrame'].map(row => stripAnsi(row)).join('\n')
  } finally {
    if (scene === 'permission') input.emit('data', 'n')
    if (scene === 'question') input.emit('data', '\r')
    if (pending.length) await Promise.allSettled(pending)
    ui.leave()
    Date.now = originalNow
    if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm
    if (originalColorTerm === undefined) delete process.env.COLORTERM; else process.env.COLORTERM = originalColorTerm
    if (originalNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = originalNoColor
  }
}

export const SNAPSHOTS = [
  ['startup', 60, 24],
  ['narrow-fallback', 56, 20],
  ['transcript', 80, 24],
  ['transcript', 160, 40],
  ['picker', 40, 20],
  ['picker', 80, 24],
  ['inline-diff', 80, 24],
  ['diff-inspector', 40, 20],
  ['diff-inspector', 160, 40],
  ['permission', 48, 20],
  ['permission', 100, 30],
  ['question', 40, 20],
  ['question', 100, 30],
]

export function snapshotName(scene, width, height) {
  return `${scene}-${width}x${height}.txt`
}

export async function writeSnapshots() {
  await fs.mkdir(SNAPSHOT_ROOT, { recursive: true })
  for (const [scene, width, height] of SNAPSHOTS) {
    const content = await renderPhase12FSnapshot(scene, width, height)
    await fs.writeFile(path.join(SNAPSHOT_ROOT, snapshotName(scene, width, height)), `${content}\n`, 'utf8')
  }
}

if (process.argv.includes('--update')) await writeSnapshots()
