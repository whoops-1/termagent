import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('interactive exit passes the session id to TerminalUI.leave', () => {
  const source = fs.readFileSync(new URL('../src/cli/repl.ts', import.meta.url), 'utf8')
  assert.match(source, /ui\?\.leave\(session\.id\)/)
  assert.doesNotMatch(source, /ui\?\.leave\(\)/)
})
