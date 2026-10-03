import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { assertSnapshot, runPreview } from '../../tools/experimental-ui-pty.mjs'
import { widthOf } from '../../experimental/ui-v2/dist/preview/design-system/ansi.js'

function assertLinesFit(snapshot, width) {
  for (const line of snapshot.split('\n')) {
    assert.ok(widthOf(line) <= width, `line width ${widthOf(line)} exceeded ${width}: ${line}`)
  }
}

for (const [width, theme] of [[60, 'termagent'], [80, 'forge'], [80, 'tideglass'], [60, 'paperlite']]) {
  test(`PTY preview ${theme} at ${width} columns remains deterministic and width-safe`, () => {
    const snapshot = runPreview({ width, theme })
    assert.ok(/TermAgent|AI AGENT FOR YOUR TERMINAL/.test(snapshot))
    assertLinesFit(snapshot, width)
    const { snapshot: file } = assertSnapshot(width, theme)
    const expected = fs.readFileSync(file, 'utf8').replace(/\n+$/, '')
    assert.equal(snapshot, expected)
  })
}

test('PTY harness exercises the actual pseudo-terminal command', () => {
  const snapshot = runPreview({ width: 60, theme: 'termagent' })
  assert.match(snapshot, /Open terminal for any LLM/)
  assert.match(snapshot, /Writing response/)
})

for (const [scene, width] of [
  ['dialog', 60], ['question', 60], ['picker', 60], ['markdown', 60], ['transcript', 60], ['exit', 60],
  ['dialog', 80], ['question', 80], ['picker', 80], ['markdown', 80], ['transcript', 80], ['exit', 80],
  ['reasoning', 60], ['tool', 60], ['diff', 60], ['provider', 60], ['plugins', 60],
  ['reasoning', 80], ['tool', 80], ['diff', 80], ['provider', 80], ['plugins', 80],
  ['markdown', 40], ['transcript', 40], ['picker', 40],
]) {
  test(`PTY preview ${scene} at ${width} columns remains deterministic and width-safe`, () => {
    const snapshot = runPreview({ width, theme: 'termagent', scene })
    assertLinesFit(snapshot, width)
    const { snapshot: file } = assertSnapshot(width, 'termagent', scene)
    const expected = fs.readFileSync(file, 'utf8').replace(/\n+$/, '')
    assert.equal(snapshot, expected)
  })
}
