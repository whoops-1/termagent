import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve('experimental/ui-v2/dist/preview/design-system')
const ansi = await import(path.join(root, 'ansi.js'))
const theme = await import(path.join(root, 'theme.js'))
const tips = await import(path.join(root, 'tips.js'))
const goodbye = await import(path.join(root, 'goodbye.js'))

test('tips are local, deterministic, and width-safe', () => {
  const t = theme.getTheme()
  const row = tips.renderTip({ width: 64, theme: t, capability: 'truecolor', index: 2 })
  assert.match(ansi.stripAnsi(row), /^Tip: Ctrl\+O opens/)
  assert.equal(ansi.widthOf(row), 64)
})

test('goodbye exposes the exact resume command and session id', () => {
  const t = theme.getTheme()
  const rows = goodbye.renderGoodbye({ width: 60, sessionId: 'sess_123', theme: t, capability: 'ansi256' })
  const plain = ansi.stripAnsi(rows.join('\n'))
  assert.match(plain, /Session ended/)
  assert.match(plain, /termagent --resume sess_123/)
  for (const row of rows) assert.ok(ansi.widthOf(row) <= 60)
})
