import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionStore } from '../dist/session/store.js'

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'termagent-13nh-cwd-'))
  const state = await mkdtemp(path.join(tmpdir(), 'termagent-13nh-state-'))
  const store = new SessionStore(state)
  const session = await store.create(cwd, 'mock')
  return { cwd, state, store, session }
}

async function cleanup(f) {
  await rm(f.cwd, { recursive: true, force: true })
  await rm(f.state, { recursive: true, force: true })
}

const messages = [
  { role: 'user', content: 'initial request' },
  { role: 'assistant', content: 'initial answer' },
]

test('13N-H checkpoint stores immutable messages, snapshot, label and sequence', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.cwd, 'state.txt'), 'checkpoint-state\n')
    const cp = await f.store.checkpoint(f.session.id, messages, { label: 'stable base', agent: 'build', provider: 'mock', model: 'mock-v1' })
    assert.equal(cp.schemaVersion, 1)
    assert.equal(cp.label, 'stable base')
    assert.equal(cp.messageCount, 2)
    assert.match(cp.messageHash, /^[0-9a-f]{64}$/)
    assert.match(cp.snapshotId, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    assert.ok(cp.sourceSequence > 0)

    const listed = await f.store.listCheckpoints(f.session.id)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, cp.id)
    assert.equal(listed[0].messageCount, 2)
    assert.equal(listed[0].label, 'stable base')
    assert.equal('messages' in listed[0], false)

    cp.messages[0].content = 'local mutation must not leak'
    const loaded = await f.store.load(f.session.id)
    const persisted = loaded.events.find((e) => e.type === 'checkpoint')
    assert.equal(persisted.data.messages[0].content, 'initial request')
  } finally {
    await cleanup(f)
  }
})

test('13N-H restore replays checkpoint after later messages and compaction', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.cwd, 'restore.txt'), 'before\n')
    const cp = await f.store.checkpoint(f.session.id, messages, { label: 'restore me' })
    await writeFile(path.join(f.cwd, 'restore.txt'), 'after\n')
    await f.store.appendMessage(f.session.id, { role: 'user', content: 'later request' })
    await f.store.appendMessage(f.session.id, { role: 'assistant', content: 'later answer' })
    await f.store.append(f.session.id, {
      type: 'context.checkpoint',
      ts: Date.now(),
      data: { sessionId: f.session.id, id: 'stale-context', turnId: undefined, epoch: 9, summary: 'later compacted context' },
    })

    const restored = await f.store.restoreCheckpoint(f.session.id, cp.id)
    assert.deepEqual(restored.messages, messages)
    assert.equal(await readFile(path.join(f.cwd, 'restore.txt'), 'utf8'), 'before\n')

    const loaded = await f.store.load(f.session.id)
    assert.deepEqual(loaded.messages, messages)
    assert.equal((await f.store.latestContextCheckpoint(f.session.id)), undefined)
    const restoreEvent = loaded.events.findLast((e) => e.type === 'checkpoint.restore')
    assert.equal(restoreEvent.data.checkpointId, cp.id)
  } finally {
    await cleanup(f)
  }
})

test('13N-H restore clears the active history after an interrupted turn', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.cwd, 'interrupt.txt'), 'stable\n')
    const cp = await f.store.checkpoint(f.session.id, messages, { label: 'interrupt base' })
    await f.store.beginTurn(f.session.id, f.cwd, messages, 'interrupted work')
    await f.store.appendMessage(f.session.id, { role: 'user', content: 'partial request' }, (await f.store.load(f.session.id)).events.findLast((e) => e.type === 'turn')?.data?.id)
    await writeFile(path.join(f.cwd, 'interrupt.txt'), 'partial\n')
    const restored = await f.store.restoreCheckpoint(f.session.id, cp.id).catch((error) => error)
    assert.match(restored.message, /session is busy/i)
    // Complete the synthetic interrupted turn so the explicit restore can proceed.
    const loaded = await f.store.load(f.session.id)
    const started = loaded.events.findLast((e) => e.type === 'turn' && e.data?.status === 'started')?.data
    assert.ok(started)
    await f.store.commitTurn(f.session.id, f.cwd, started, messages)
    const after = await f.store.restoreCheckpoint(f.session.id, cp.id)
    assert.deepEqual(after.messages, messages)
    assert.equal(await readFile(path.join(f.cwd, 'interrupt.txt'), 'utf8'), 'stable\n')
  } finally {
    await cleanup(f)
  }
})

test('13N-H checkpoint snapshot survives turn snapshot cleanup', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.cwd, 'retention.txt'), 'checkpoint\n')
    const cp = await f.store.checkpoint(f.session.id, messages, { label: 'retained' })
    const turn = await f.store.beginTurn(f.session.id, f.cwd, messages, 'consume snapshot cleanup')
    await f.store.commitTurn(f.session.id, f.cwd, turn, messages)
    await writeFile(path.join(f.cwd, 'retention.txt'), 'changed\n')
    const restored = await f.store.restoreCheckpoint(f.session.id, cp.id)
    assert.deepEqual(restored.messages, messages)
    assert.equal(await readFile(path.join(f.cwd, 'retention.txt'), 'utf8'), 'checkpoint\n')
  } finally {
    await cleanup(f)
  }
})

test('13N-H branch-from-checkpoint preserves source session and does not copy render state', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.cwd, 'branch.txt'), 'checkpoint\n')
    const cp = await f.store.checkpoint(f.session.id, messages, { label: 'branch base' })
    await f.store.appendMessage(f.session.id, { role: 'user', content: 'source later' })
    const before = await f.store.load(f.session.id)

    const child = await f.store.forkFromCheckpoint(f.session.id, cp.id)
    const childLoaded = await f.store.load(child.id)
    const sourceAfter = await f.store.load(f.session.id)
    assert.deepEqual(childLoaded.messages, messages)
    assert.deepEqual(sourceAfter.messages, before.messages)
    assert.equal(childLoaded.meta.parentId, f.session.id)
    assert.equal(childLoaded.meta.parentCheckpointId, cp.id)
    assert.equal(childLoaded.meta.parentSnapshotId, cp.snapshotId)
    assert.equal(childLoaded.events.findLast((e) => e.type === 'branch').data.checkpointId, cp.id)
    assert.equal(await readFile(path.join(f.cwd, 'branch.txt'), 'utf8'), 'checkpoint\n')
  } finally {
    await cleanup(f)
  }
})

test('13N-H branch-from-checkpoint can explicitly restore workspace', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.cwd, 'branch-restore.txt'), 'checkpoint\n')
    const cp = await f.store.checkpoint(f.session.id, messages, { label: 'branch restore' })
    await writeFile(path.join(f.cwd, 'branch-restore.txt'), 'later\n')
    const child = await f.store.forkFromCheckpoint(f.session.id, cp.id, { restoreWorkspace: true })
    assert.equal(await readFile(path.join(f.cwd, 'branch-restore.txt'), 'utf8'), 'checkpoint\n')
    const loaded = await f.store.load(child.id)
    assert.deepEqual(loaded.messages, messages)
    assert.equal(loaded.meta.parentCheckpointId, cp.id)
  } finally {
    await cleanup(f)
  }
})

test('13N-H legacy metadata-only checkpoints remain listable but cannot be restored or branched', async () => {
  const f = await fixture()
  try {
    const cp = { id: 'legacy-cp', ts: Date.now(), messageCount: 2, label: 'legacy' }
    await f.store.append(f.session.id, { type: 'checkpoint', ts: cp.ts, data: cp })
    const listed = await f.store.listCheckpoints(f.session.id)
    assert.equal(listed[0].id, 'legacy-cp')
    await assert.rejects(f.store.restoreCheckpoint(f.session.id, 'legacy-cp'), /legacy metadata-only/i)
    await assert.rejects(f.store.forkFromCheckpoint(f.session.id, 'legacy-cp'), /legacy metadata-only/i)
  } finally {
    await cleanup(f)
  }
})
test('13N-H checkpoint references support #index and unique prefixes across a fresh store instance', async () => {
  const f = await fixture()
  try {
    const first = await f.store.checkpoint(f.session.id, messages, { label: 'first' })
    await f.store.appendMessage(f.session.id, { role: 'user', content: 'later' })
    const second = await f.store.checkpoint(f.session.id, [...messages, { role: 'user', content: 'later' }], { label: 'second' })
    const reloadedStore = new SessionStore(f.state)
    const listed = await reloadedStore.listCheckpoints(f.session.id)
    assert.equal(listed.length, 2)
    const restored = await reloadedStore.restoreCheckpoint(f.session.id, '#1')
    assert.equal(restored.checkpoint.id, first.id)
    assert.deepEqual(restored.messages, messages)
    const prefixStore = new SessionStore(f.state)
    const child = await prefixStore.forkFromCheckpoint(f.session.id, second.id.slice(0, 10))
    const childLoaded = await prefixStore.load(child.id)
    assert.deepEqual(childLoaded.messages, [...messages, { role: 'user', content: 'later' }])
  } finally {
    await cleanup(f)
  }
})
