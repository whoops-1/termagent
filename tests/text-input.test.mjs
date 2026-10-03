import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutTextInput, visualCursorColumn } from '../dist/cli/tui/text-input.js'

test('text input layout keeps cursor and viewport on visual rows', () => {
  const value = 'abcdefghijklmnopqrstuvwxyz 0123456789'
  const cursor = value.length
  const layout = layoutTextInput(value, cursor, 12, 2)
  assert.equal(layout.totalRows, 4)
  assert.equal(layout.rows.length, 2)
  assert.equal(layout.hiddenAbove, true)
  assert.equal(layout.hiddenBelow, false)
  assert.equal(layout.cursorRow, 1)
  assert.equal(layout.cursorColumn, 1)
})

test('text input layout treats explicit newlines as row boundaries', () => {
  const layout = layoutTextInput('first\nsecond\nthird', 6, 40, 8)
  assert.equal(layout.rows.length, 3)
  assert.equal(layout.cursorRow, 1)
  assert.equal(layout.cursorColumn, 0)
  assert.equal(layout.rows[1].text, 'second')
})

test('visual cursor column uses the same wrapping model as rendering', () => {
  const value = '1234567890abcdefghij'
  assert.equal(visualCursorColumn(value, 9, 10), 9)
  assert.equal(visualCursorColumn(value, 10, 10), 0)
  assert.equal(visualCursorColumn(value, 11, 10), 1)
})
