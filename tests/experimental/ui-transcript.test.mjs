import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve('experimental/ui-v2/dist/preview/design-system')
const ansi = await import(path.join(root, 'ansi.js'))
const theme = await import(path.join(root, 'theme.js'))
const transcript = await import(path.join(root, 'transcript.js'))

function assertWidth(rows, width) {
  for (const row of rows) assert.ok(ansi.widthOf(row) <= width, `row exceeded ${width}: ${ansi.stripAnsi(row)}`)
}

test('transcript gives user and assistant turns distinct semantic hierarchy', () => {
  const t = theme.getTheme()
  const rows = transcript.renderUserTurn({ text: 'Explain **Markdown**.', width: 60, theme: t, capability: 'truecolor' })
    .concat(transcript.renderAssistantTurn({ text: '# Answer\n\nUse `marked`.', reasoning: 'Checking the requested UI behavior.', width: 60, theme: t, capability: 'truecolor' }))
  const plain = ansi.stripAnsi(rows.join('\n'))
  assert.match(plain, /◆ You/)
  assert.match(plain, /◆ TermAgent/)
  assert.match(plain, /Answer/)
  assert.match(plain, /marked/)
  assertWidth(rows, 60)
})

test('tool activity stays compact and communicates lifecycle state', () => {
  const t = theme.getTheme()
  const running = transcript.renderToolActivity({ tool: { name: 'bash', summary: 'npm test', running: true }, width: 50, theme: t, capability: 'truecolor' })
  const done = transcript.renderToolActivity({ tool: { name: 'write_file', summary: 'src/app.ts', durationMs: 1234, additions: 7, deletions: 2, hasDiff: true }, width: 50, theme: t, capability: 'truecolor' })
  assert.match(ansi.stripAnsi(running[0]), /→ bash .* running/)
  assert.match(ansi.stripAnsi(done[0]), /✓ write_file .* completed .* 1\.2s .* \+7 -2/)
  assertWidth(running.concat(done), 50)
})

test('system rows distinguish warning and error tones without layout drift', () => {
  const t = theme.getTheme()
  const warning = transcript.renderSystemRow({ system: { text: 'Something needs attention.', tone: 'warn' }, width: 42, theme: t, capability: 'ansi256' })
  const error = transcript.renderSystemRow({ system: { text: 'Command failed.', tone: 'error' }, width: 42, theme: t, capability: 'ansi256' })
  assert.match(ansi.stripAnsi(warning[0]), /⚠ Something needs attention\./)
  assert.match(ansi.stripAnsi(error[0]), /! Command failed\./)
  assertWidth(warning.concat(error), 42)
})
