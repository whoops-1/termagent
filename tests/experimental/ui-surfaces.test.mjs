import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve('experimental/ui-v2/dist/design-system')
const surface = await import(path.join(root, 'surfaces.js'))
const diff = await import(path.join(root, 'diff.js'))
const theme = await import(path.join(root, 'theme.js'))
const ansi = await import(path.join(root, 'ansi.js'))

for (const width of [60, 80]) {
  test(`dialog frame is centered and width-safe at ${width} columns`, () => {
    const rows = surface.renderDialogFrame({
      width,
      height: 16,
      title: 'Permission required',
      subtitle: 'The agent is waiting for approval.',
      content: [
        ansi.paint('Run shell command?', { fg: theme.getTheme().warning, capability: 'truecolor' }),
        '',
        ansi.paint('› Allow once', { fg: theme.getTheme().text, bg: theme.getTheme().selection, capability: 'truecolor', attrs: { bold: true } }),
      ],
      footer: '↑↓ select · Enter confirm · Esc close',
      theme: theme.getTheme(),
      capability: 'truecolor',
      tone: 'warning',
      maxWidth: Math.min(76, width - 2),
      preserveAnsi: true,
    })
    assert.equal(rows.length, 16)
    for (const row of rows) assert.ok(ansi.widthOf(row) <= width)
    assert.match(ansi.stripAnsi(rows[0]), /Permission required/)
    assert.match(rows.join('\n'), /\x1b\[48;/)
  })
}

test('diff renderer communicates additions and removals without overflow', () => {
  const t = theme.getTheme()
  const rows = diff.renderDiffBlock({
    width: 60,
    title: 'src/cli/ui.ts',
    theme: t,
    capability: 'truecolor',
    lines: [
      { kind: 'hunk', text: '@@ prompt footer @@' },
      { kind: 'remove', text: 'const color = BLUE' },
      { kind: 'add', text: 'const color = theme.text' },
      { kind: 'context', text: 'scheduleRender()' },
    ],
  })
  const plain = ansi.stripAnsi(rows.join('\n'))
  assert.match(plain, /src\/cli\/ui\.ts/)
  assert.match(plain, /- const color = BLUE/)
  assert.match(plain, /\+ const color = theme\.text/)
  for (const row of rows) assert.ok(ansi.widthOf(row) <= 60)
})
