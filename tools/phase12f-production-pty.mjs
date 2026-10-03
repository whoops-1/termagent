import { TerminalUI } from '../dist/cli/ui.js'
import { stripAnsi, widthOf } from '../dist/design-system/ansi.js'

function diffResult() {
  const path = 'src/example.ts'
  const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,3 @@\n const before = 1\n-const value = 1\n+const value = 2\n+const extra = 2\n`
  return { text: patch, files: [{ path, patch, status: 'modified', additions: 2, deletions: 1 }], additions: 2, deletions: 1 }
}

async function scene(name) {
  const input = process.stdin
  const output = process.stdout
  const ui = new TerminalUI({ title: 'phase12f-pty', model: 'mock', provider: 'provider', mode: 'build', cwd: '/workspace/project', output, input })
  ui.enter()
  if (name === 'startup') {
    ui['startupUntil'] = Date.now() + 900
  } else if (name === 'transcript') {
    ui.addUser('PTY transcript identity marker')
    ui.appendAssistant('Responsive transcript content stays primary. '.repeat(3))
    ui['startupUntil'] = Date.now() - 1
  } else if (name === 'picker') {
    ui.addUser('PTY picker marker')
    ui.setCompletion({ kind: 'palette', query: '', index: 12, items: Array.from({ length: 18 }, (_, i) => `/command-${i}`) })
    ui['startupUntil'] = Date.now() - 1
  } else if (name === 'inline-diff') {
    ui.addUser('PTY diff marker')
    ui.startTool('edit_file', { path: 'src/example.ts' })
    ui.endTool('edit_file', 'updated', { files: [{ relativePath: 'src/example.ts', diff: diffResult().text, additions: 2, deletions: 1 }] })
    ui['startupUntil'] = Date.now() - 1
  } else if (name === 'diff-inspector') {
    ui.addUser('PTY inspector marker')
    ui.openWorkingTreeDiff(diffResult(), 'Working tree changes')
    ui['onInspectorData']('\r')
    ui['startupUntil'] = Date.now() - 1
  } else if (name === 'permission') {
    ui.startAssistant()
    const pending = ui.requestPermission({
      tool: { name: 'bash', description: 'shell', risk: 'shell', schema: { type: 'object' } },
      args: { command: 'echo PTY_PERMISSION_MARKER' },
    })
    ui['startupUntil'] = Date.now() - 1
    await new Promise(resolve => setTimeout(resolve, 35))
    await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 1))])
  } else if (name === 'question') {
    ui.addUser('PTY question marker')
    ui.startAssistant()
    const pending = ui.requestQuestion([{
      header: 'Choice',
      question: 'PTY_QUESTION_MARKER',
      options: [{ label: 'bounded' }, { label: 'stacked' }, { label: 'wide' }, { label: 'fallback' }],
      multi: false,
      custom: false,
    }])
    ui['startupUntil'] = Date.now() - 1
    await new Promise(resolve => setTimeout(resolve, 35))
    void pending
  } else {
    throw new Error(`Unknown scene: ${name}`)
  }
  ui.render()
  const frame = ui['previousFrame']
  const width = process.stdout.columns || 80
  if (frame.length !== (process.stdout.rows || 24)) throw new Error(`frame row count mismatch: ${frame.length}`)
  for (const row of frame) if (widthOf(row) !== width) throw new Error(`frame width mismatch: ${widthOf(row)} != ${width}`)
  process.stdout.write('__TERMAGENT_12F_PTY_OK__\n')
  await new Promise(resolve => setTimeout(resolve, 40))
  ui.leave()
  process.exit(0)
}

await scene(process.argv[2] || 'startup')
