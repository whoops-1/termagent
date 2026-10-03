import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve('experimental/ui-v2/dist/preview/design-system')
const ansi = await import(path.join(root, 'ansi.js'))
const theme = await import(path.join(root, 'theme.js'))
const banner = await import(path.join(root, 'banner.js'))

for (const width of [80, 64, 52, 46, 40, 32]) {
  test(`banner stays width-safe at ${width} columns`, () => {
    const rows = banner.renderBanner({ width, version: '1.18.0', theme: theme.getTheme('termagent'), capability: 'truecolor' })
    assert.ok(rows.length >= 1)
    for (const row of rows) assert.ok(ansi.widthOf(row) <= width, `${ansi.widthOf(row)} > ${width}`)
    const plain = ansi.stripAnsi(rows.join('\n'))
  assert.doesNotMatch(plain, /☺|🙂|😊|😀/)
  assert.match(plain, width >= 48 ? /████|╚═╝/ : /TermAgent/)
  })
}

test('wide banner uses the TermAgent wordmark and themed startup treatment', () => {
  const rows = banner.renderBanner({ width: 80, version: '1.18.0', theme: theme.getTheme('termagent'), capability: 'truecolor' })
  assert.equal(rows.length, 14)
  const plain = ansi.stripAnsi(rows.join('\n'))
  assert.match(plain, /████████╗/)
  assert.match(plain, /╚══██╔══╝/)
  assert.match(plain, /██╔████╔██║/)
  assert.match(plain, /✦ Open terminal for any LLM ✦/)
  assert.match(plain, /termagent v1.18.0/)
  const raw = rows.join('')
  assert.match(raw, /\x1b\[38;2;180;240;170m/)
  assert.doesNotMatch(plain, /☺|🙂|😊|😀/)
})
