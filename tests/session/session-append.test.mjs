// 14I-B4 — durable-sequence append optimization + turn-lease recovery guards.
// Covers: the stat-validated fast path (correct monotonic sequences without
// full-history rescans), external-append fallback to the authoritative scan,
// crash repair of a partial trailing line, mid-file corruption surfacing a
// precise error, and cross-store (cross-process) interleaving correctness.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, appendFile, stat, truncate } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_KEYS = ['HOME', 'TERMAGENT_SESSION_ROOT', 'TERMAGENT_SESSION_LOCK_TIMEOUT_MS']
function saveEnv() { return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) }
function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function fixture() {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14i-b4-home-'))
  const sessionsRoot = path.join(home, '.termagent', 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_SESSION_ROOT = sessionsRoot
  delete process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS
  const { SessionStore } = await import('../../dist/session/store.js')
  const store = new SessionStore(sessionsRoot)
  return {
    store, sessionsRoot,
    logPath: id => path.join(sessionsRoot, `${id}.jsonl`),
    async cleanup() {
      restoreEnv(previous)
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('14I-B4: rapid appends produce strictly increasing durable sequences via the fast path', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    const id = meta.id
    for (let index = 0; index < 30; index++) {
      await f.store.append(id, { type: 'meta', ts: Date.now(), data: { index } })
    }
    // create's own meta line consumes durable sequence 1, so 30 appends land 2..31.
    const current = await f.store.currentSequence(id)
    assert.equal(Number(current), 31)
    const page = await f.store.durableEvents(id, 0, 100)
    let previous = 0
    for (const event of page.events) {
      assert.ok(Number(event.sequence) > previous, `sequence must strictly increase: ${previous} -> ${event.sequence}`)
      previous = Number(event.sequence)
    }
    assert.equal(previous, 31)
  } finally { await f.cleanup() }
})

test('14I-B4: an external append invalidates the cache and the next sequence is still correct', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    const id = meta.id
    for (let index = 0; index < 5; index++) {
      await f.store.append(id, { type: 'meta', ts: Date.now(), data: { index } })
    }
    // Simulate a detached worker appending to the same session log without
    // sharing the in-memory cache: the next append must fall back to the
    // authoritative full scan and continue the sequence monotonically.
    await appendFile(f.logPath(id), JSON.stringify({ type: 'meta', ts: Date.now(), data: { external: true } }) + '\n', 'utf8')
    // create's meta is sequence 1, five appends are 2..6, so the external line is positional 7.
    const externalCurrent = await f.store.currentSequence(id)
    assert.equal(Number(externalCurrent), 7, 'external line without a sequence falls back to positional numbering')
    const enriched = await f.store.append(id, { type: 'meta', ts: Date.now(), data: { after: 'external' } })
    assert.equal(Number(enriched.sequence), 8)
  } finally { await f.cleanup() }
})

test('14I-B4: a crash mid-append is repaired and the sequence continues monotonically', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    const id = meta.id
    for (let index = 0; index < 10; index++) {
      await f.store.append(id, { type: 'meta', ts: Date.now(), data: { index } })
    }
    const before = await stat(f.logPath(id))
    // Simulate the partial trailing write of a crashed append: the process
    // died after writing part of the next line. The cache is gone with the
    // process, so the next append must run the repair + full scan path.
    await truncate(f.logPath(id), before.size - 8)
    const enriched = await f.store.append(id, { type: 'meta', ts: Date.now(), data: { after: 'crash' } })
    assert.equal(Number(enriched.sequence), 11)
    const text = await readFile(f.logPath(id), 'utf8')
    const lines = text.split('\n').filter(line => line.trim())
    for (const line of lines) JSON.parse(line)
    assert.equal(lines.length, 11, 'the partial trailing line was truncated before the new event landed')
  } finally { await f.cleanup() }
})

test('14I-B4: mid-file corruption still fails with the precise historical error', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    const id = meta.id
    for (let index = 0; index < 3; index++) {
      await f.store.append(id, { type: 'meta', ts: Date.now(), data: { index } })
    }
    const original = await readFile(f.logPath(id), 'utf8')
    const lines = original.split('\n')
    lines[1] = '{"type":"meta","corrupt'
    await writeFile(f.logPath(id), lines.join('\n'), 'utf8')
    await assert.rejects(
      () => f.store.append(id, { type: 'meta', ts: Date.now(), data: { after: 'corruption' } }),
      error => error instanceof Error && /Corrupt session log at line 2/.test(error.message),
    )
  } finally { await f.cleanup() }
})

test('14I-B4: two stores sharing one root interleave appends with globally monotonic sequences', async () => {
  const f = await fixture()
  try {
    const { SessionStore: SecondStoreHost } = await import('../../dist/session/store.js')
    const storeA = f.store
    const storeB = new SecondStoreHost(f.sessionsRoot)
    const meta = await storeA.create(f.sessionsRoot, 'test-model')
    const id = meta.id
    const expected = []
    for (let index = 0; index < 6; index++) {
      const store = index % 2 === 0 ? storeA : storeB
      const enriched = await store.append(id, { type: 'meta', ts: Date.now(), data: { index, store: index % 2 === 0 ? 'A' : 'B' } })
      expected.push(Number(enriched.sequence))
    }
    // create's meta consumes sequence 1, so the interleaved appends land 2..7.
    assert.deepEqual(expected, [2, 3, 4, 5, 6, 7], 'each store either trusts its cache or rescans; the file decides')
  } finally { await f.cleanup() }
})
