import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve('dist/design-system')
const ansi = await import(path.join(root, 'ansi.js'))
const theme = await import(path.join(root, 'theme.js'))
const md = await import(path.join(root, 'markdown.js'))

const options = { width: 70, theme: theme.getTheme('termagent'), capability: 'truecolor' }

function plain(lines) {
  return ansi.stripAnsi(lines.join('\n'))
}

test('markdown renders headings and lists semantically', () => {
  const lines = md.renderMarkdown('# Title\n\n- first\n- second\n\n1. ordered', options)
  const value = plain(lines)
  assert.match(value, /Title/)
  assert.match(value, /• first/)
  assert.match(value, /• second/)
  assert.match(value, /1\. ordered/)
  assert.doesNotMatch(value, /^# Title/m)
  for (const line of lines) assert.ok(ansi.widthOf(line) <= 70)
})

test('markdown renders code blocks with labels and line numbers', () => {
  const lines = md.renderMarkdown('```js\nconst answer = 42\nconsole.log(answer)\n```', options)
  const value = plain(lines)
  assert.match(value, /js/)
  assert.match(value, /1 const answer = 42/)
  assert.match(value, /2 console\.log\(answer\)/)
  assert.equal(value.includes('```'), false)
  for (const line of lines) assert.equal(ansi.widthOf(line), 70)
})

test('markdown renders bordered tables and switches to semantic cards when narrow', () => {
  const source = '| Name | Value |\n| :--- | ---: |\n| foo | 42 |\n| bar | 100 |'
  const wide = md.renderMarkdown(source, options)
  const widePlain = plain(wide)
  assert.match(widePlain, /┌.*┬.*┐/)
  assert.match(widePlain, /foo/)
  assert.match(widePlain, /100/)
  for (const line of wide) assert.equal(ansi.widthOf(line), 70)

  const narrow = md.renderMarkdown(source, { ...options, width: 36 })
  const narrowPlain = plain(narrow)
  assert.match(narrowPlain, /Name/)
  assert.match(narrowPlain, /Value/)
  assert.match(narrowPlain, /┌.*┬.*┐/)
  assert.doesNotMatch(narrowPlain, /^\| Name/m)
  for (const line of narrow) assert.ok(ansi.widthOf(line) <= 36)

  const cards = md.renderMarkdown(source, { ...options, width: 30 })
  const cardsPlain = plain(cards)
  assert.match(cardsPlain, /Name:/)
  assert.match(cardsPlain, /Value:/)
  for (const line of cards) assert.ok(ansi.widthOf(line) <= 30)
})

test('markdown list and quote prefixes remain width-safe on narrow terminals', () => {
  const t = theme.getTheme('termagent')
  const source = [
    '- This list item is long enough to require wrapping on a narrow terminal.',
    '> This blockquote is also long enough to require wrapping.',
    '12. This ordered list item must keep its numeric prefix inside the width.',
  ].join('\n')
  const rows = md.renderMarkdown(source, { width: 40, theme: t, capability: 'truecolor' })
  for (const row of rows) assert.ok(ansi.widthOf(row) <= 40, `${ansi.widthOf(row)} > 40`)
})
