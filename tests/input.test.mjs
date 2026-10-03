import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { defaultCompletions } from '../dist/cli/input.js'

test('interactive completion resolves commands, agents, and project files', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termagent-input-'))
  await writeFile(path.join(cwd, 'app.ts'), 'export const app = 1')
  const complete = defaultCompletions(['help', 'model', 'agent'], ['reviewer'], cwd)
  assert.deepEqual(await complete('/he', 3), ['/help', '/model', '/agent'])
  assert.deepEqual(await complete('/agent re', 10), ['/agent reviewer'])
  assert.deepEqual(await complete('@ap', 3), ['app.ts'])
})
test('slash menu opens, filters, navigates, accepts with arrows, and scroll keys target chat', async()=>{
  const { PromptEditor } = await import('../dist/cli/input.js')
  const seen=[]
  const scrolls=[]
  const editor=new PromptEditor({
    completions:()=>[
      '/help','/model','/provider','/agent','/agents','/commands','/plan','/build','/explore','/sessions'
    ],
    onCompletion:(state)=>seen.push(state),
    onScroll:(delta)=>scrolls.push(delta),
    onChange:()=>{},
    getColumns:()=>80,
  })

  const drive = async (seq) => {
    const result = await editor.handleSequence(seq)
    await new Promise(resolve => setTimeout(resolve, 0))
    return result
  }

  await drive('/')
  const slash = seen.at(-1)
  assert.equal(slash.kind, 'command')
  assert.equal(slash.items.length, 10)
  assert.equal(slash.index, 0)
  assert.equal(slash.items[0], '/help')

  await drive('h')
  const filtered = seen.at(-1)
  assert.equal(filtered.kind, 'command')
  assert.deepEqual(filtered.items, ['/help'])
  assert.equal(filtered.query, 'h')

  // Re-open and exercise keyboard selection rather than the editor history.
  await drive('\x1b')
  await drive('\x08')
  await drive('\x1b[B')
  assert.equal(seen.at(-1).index, 1)
  // Eight visible rows are a viewport, not the selection limit. Move through
  // the ninth and tenth entries without wrapping back to the first.
  for (let i = 0; i < 8; i++) await drive('\x1b[B')
  assert.equal(seen.at(-1).index, 9)
  assert.equal(seen.at(-1).items[9], '/sessions')
  // The picker window is only eight rows tall; selection itself is not capped at eight.
  // Walk back to the second item and accept it to prove navigation remains global.
  for (let i = 0; i < 8; i++) await drive('\x1b[A')
  assert.equal(seen.at(-1).index, 1)
  const enterResult = await drive('\r')
  assert.equal(enterResult, null)
  assert.equal(editor.snapshot().value, '/model')
  assert.equal(editor.snapshot().cursor, '/model'.length)
  assert.equal(seen.at(-1), null)

  await drive('\x1b[5~')
  await drive('\x1b[6~')
  await drive('\x1b[1;5A')
  await drive('\x1b[1;5B')
  await drive('\x1b[1;5H')
  await drive('\x1b[1;5F')
  assert.deepEqual(scrolls, [5, -5, 3, -3, 1000000, -1000000])
})
test('command completion ranks an exact command above longer prefix matches', async () => {
  const { PromptEditor } = await import('../dist/cli/input.js')
  const seen = []
  const editor = new PromptEditor({
    completions: () => ['/checkpoints', '/checkpoint', '/restore'],
    onCompletion: state => seen.push(state),
    onChange: () => {},
  })

  await editor.handleSequence('/')
  for (const ch of 'checkpoint') await editor.handleSequence(ch)

  const state = seen.at(-1)
  assert.equal(state.items[0], '/checkpoint')
  assert.equal(state.index, 0)
  const result = await editor.handleSequence('\r')
  assert.deepEqual(result, { type: 'submit', value: '/checkpoint' })
  assert.equal(editor.snapshot().value, '')
})

test('exact slash command submits on the first Enter instead of requiring a second Enter', async () => {
  const { PromptEditor } = await import('../dist/cli/input.js')
  const editor = new PromptEditor({
    completions: () => ['/provider', '/providers'],
    onChange: () => {},
  })
  await editor.handleSequence('/')
  for (const ch of 'provider') await editor.handleSequence(ch)
  const result = await editor.handleSequence('\r')
  assert.deepEqual(result, { type: 'submit', value: '/provider' })
  assert.equal(editor.snapshot().value, '')
})

test('Ctrl+P command palette filters and submits without modifying the draft', async () => {
  const { PromptEditor } = await import('../dist/cli/input.js')
  const seen = []
  const palette = Array.from({ length: 12 }, (_, i) => `cmd-${i + 1}`)
  let editor
  editor = new PromptEditor({
    onChange: () => {},
    onCompletion: state => seen.push(state),
    onShortcut: async name => { if (name === 'commands') editor.openCommandPalette(palette) },
  })
  await editor.handleSequence('\x10')
  assert.equal(seen.at(-1).kind, 'palette')
  assert.equal(seen.at(-1).items.length, 12)
  assert.equal(editor.snapshot().value, '')

  for (let i = 0; i < 9; i++) await editor.handleSequence('\x1b[B')
  assert.equal(seen.at(-1).index, 9)
  const submit = await editor.handleSequence('\r')
  assert.deepEqual(submit, { type: 'submit', value: '/cmd-10' })
  assert.equal(editor.snapshot().value, '')

  editor.openCommandPalette(['/help', '/model', '/permissions', '/checkpoint'])
  await editor.handleSequence('che')
  assert.deepEqual(seen.at(-1).items, ['/checkpoint'])
  assert.equal(seen.at(-1).query, 'che')
  await editor.handleSequence('\x7f')
  assert.deepEqual(seen.at(-1).items, ['/checkpoint'])
  assert.equal(seen.at(-1).query, 'ch')
})
