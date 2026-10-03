import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve('experimental/ui-v2/dist/preview/design-system')
const ansi = await import(path.join(root, 'ansi.js'))
const theme = await import(path.join(root, 'theme.js'))
const picker = await import(path.join(root, 'picker.js'))

test('picker keeps the selected item inside a moving viewport', () => {
  const t = theme.getTheme()
  const items = Array.from({ length: 24 }, (_, i) => ({ label: `/command-${i + 1}`, description: `Description ${i + 1}` }))
  const rows = picker.renderPicker({ options: items, selectedIndex: 20, width: 56, maxVisible: 8, theme: t, capability: 'truecolor' })
  const plain = ansi.stripAnsi(rows.join('\n'))
  assert.match(plain, /command-21/)
  assert.match(plain, /17-24 of 24/)
  assert.match(plain, /↑ more/)
  assert.equal(plain.includes('command-1\n'), false)
  for (const row of rows) assert.ok(ansi.widthOf(row) <= 56)
})

test('picker changes visible count for narrow terminals without changing selection semantics', () => {
  const t = theme.getTheme()
  const items = Array.from({ length: 10 }, (_, i) => ({ label: `item-${i + 1}` }))
  const rows = picker.renderPicker({ options: items, selectedIndex: 8, width: 48, maxVisible: 6, theme: t, capability: 'ansi256' })
  const plain = ansi.stripAnsi(rows.join('\n'))
  assert.match(plain, /item-9/)
  assert.match(plain, /5-10 of 10/)
  for (const row of rows) assert.ok(ansi.widthOf(row) <= 48)
})
