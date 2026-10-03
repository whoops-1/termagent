import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

async function load(name) { return await import(`../dist/${name}.js`) }

test('prompt editor supports bounded edit undo/redo and history palette', async () => {
  const { PromptEditor } = await load('cli/input')
  const completions = []
  const editor = new PromptEditor({ onCompletion: x => x && completions.push(x), onChange: () => {} })
  await editor.handleSequence('a')
  await editor.handleSequence('b')
  assert.equal(editor.value(), 'ab')
  await editor.handleSequence('\x1a')
  assert.equal(editor.value(), 'a')
  await editor.handleSequence('\x19')
  assert.equal(editor.value(), 'ab')
  editor.openHistoryPalette(['first prompt', 'second prompt'])
  assert.equal(completions.at(-1).kind, 'history')
  await editor.handleSequence('\x1b[B')
  const selected = await editor.handleSequence('\r')
  assert.equal(selected.type, 'submit')
  assert.equal(selected.value, 'second prompt')
})

test('prompt editor Vim mode separates insert and normal modes', async () => {
  const { PromptEditor } = await load('cli/input')
  const editor = new PromptEditor({ onChange: () => {} })
  editor.setVimMode(true)
  await editor.handleSequence('a')
  await editor.handleSequence('b')
  await editor.handleSequence('c')
  await editor.handleSequence('\x1b')
  assert.equal(editor.isVimNormal(), true)
  await editor.handleSequence('h')
  await editor.handleSequence('x')
  assert.equal(editor.value(), 'ac')
  await editor.handleSequence('i')
  await editor.handleSequence('b')
  assert.equal(editor.value(), 'abc')
})

test('prompt draft stash and queue survive process-local reload', async () => {
  const { PromptQueueStore } = await load('cli/prompt-queue')
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase4-home-'))
  const oldHome = process.env.HOME
  process.env.HOME = home
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase4-cwd-'))
  try {
    const first = new PromptQueueStore(cwd)
    await first.stash('draft text')
    await first.enqueue('first queued')
    await first.enqueue('second queued')
    const second = new PromptQueueStore(cwd)
    const state = await second.list()
    assert.equal(state.stash, 'draft text')
    assert.deepEqual(state.queue, ['first queued', 'second queued'])
    assert.equal(await second.popStash(), 'draft text')
    assert.equal(await second.dequeue(), 'first queued')
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome
    await rm(home, {recursive:true,force:true})
    await rm(cwd, {recursive:true,force:true})
  }
})

test('diff renderer returns per-file statistics and bounded text', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase4-diff-'))
  const { spawnSync } = await import('node:child_process')
  try {
    spawnSync('git', ['init', '-q'], {cwd:root})
    spawnSync('git', ['config', 'user.email', 'test@example.invalid'], {cwd:root})
    spawnSync('git', ['config', 'user.name', 'Test'], {cwd:root})
    await writeFile(path.join(root, 'a.txt'), 'one\n')
    spawnSync('git', ['add', '.'], {cwd:root})
    spawnSync('git', ['commit', '-qm', 'init'], {cwd:root})
    await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n')
    const { renderGitDiff } = await load('diff/render')
    const result = await renderGitDiff(root, {color:false, maxBytes:1024})
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0].path, 'a.txt')
    assert.equal(result.additions, 1)
    assert.equal(result.deletions, 0)
    assert.match(result.text, /\+two/)
    assert.ok(Buffer.byteLength(result.text, 'utf8') <= 1024)
  } finally {
    await rm(root, {recursive:true,force:true})
  }
})

test('write and edit tools return bounded structured diff metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-tool-diff-'))
  try {
    const { builtinTools } = await load('tools/builtin')
    const write = builtinTools({ timeout: 5000, maxOutput: 12000 }).find(t => t.name === 'write_file')
    const edit = builtinTools({ timeout: 5000, maxOutput: 12000 }).find(t => t.name === 'edit_file')
    assert.ok(write)
    assert.ok(edit)
    await write.execute({ path: 'src/example.ts', content: 'export const value = 1\n' }, { sessionID:'s', agent:'build', cwd:root, abort:new AbortController().signal })
    const result = await edit.execute({ path:'src/example.ts', oldText:'value = 1', newText:'value = 2' }, { sessionID:'s', agent:'build', cwd:root, abort:new AbortController().signal })
    assert.match(result.metadata.diff, /-export const value = 1/)
    assert.match(result.metadata.diff, /\+export const value = 2/)
    assert.equal(result.metadata.fileDiff.path, 'src/example.ts')
    assert.equal(result.metadata.fileDiff.additions, 1)
    assert.equal(result.metadata.fileDiff.deletions, 1)
  } finally {
    await rm(root, { recursive:true, force:true })
  }
})
