// 14I-S2 — session-state lock hardening (TODO 14I items 8-11).
// Covers: acquireStateLease bounded backoff + jitter, owner classification
// (live / malformed / stale), budget-exhaustion busy errors, compare-before-
// release, and the redacted lastSessionLeaseContention() diagnostics record.
// Tests import dist/ like every other suite here; build happens at integration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_KEYS = [
  'HOME', 'TERMAGENT_SESSION_ROOT', 'TERMAGENT_SESSION_LOCK_TIMEOUT_MS',
]
function saveEnv() { return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) }
function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// Beyond any plausible pid allocation on POSIX (pid_max <= 2^22) and on Windows
// (pids are 4-aligned well below 2^22): kill(pid, 0) yields ESRCH on both.
const DEAD_PID = 2147483647

async function fixture() {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14i-s2-home-'))
  const sessionsRoot = path.join(home, '.termagent', 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_SESSION_ROOT = sessionsRoot
  delete process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS
  const { SessionStore } = await import('../../dist/session/store.js')
  const store = new SessionStore(sessionsRoot)
  return {
    store, sessionsRoot,
    lockPath: id => path.join(sessionsRoot, `.${id}.state.lock`),
    writeLock: async (lockPath, owner) => writeFile(lockPath, JSON.stringify(owner) + '\n', 'utf8'),
    readLock: async lockPath => JSON.parse((await readFile(lockPath, 'utf8')).trim()),
    async cleanup() {
      restoreEnv(previous)
      await rm(home, { recursive: true, force: true })
    },
  }
}

function busyErrorMatch(extra) {
  return error => {
    if (!(error instanceof Error)) return false
    if (!error.message.startsWith('Session state is busy:')) return false
    return extra ? extra(error.message) : true
  }
}

test('14I-S2: uncontended mutation acquires the lease, runs, and releases the lock', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    await f.store.appendMessage(meta.id, { role: 'user', content: 'hello lease' })
    const loaded = await f.store.load(meta.id)
    assert.equal(loaded.messages.length, 1)
    assert.equal(loaded.messages[0].content, 'hello lease')
    assert.equal(await f.store.currentSequence(meta.id), 2)
    // Normal release removed the state lock entirely.
    await assert.rejects(readFile(f.lockPath(meta.id)), { code: 'ENOENT' })
    // Clean acquisitions are not contention and must not populate diagnostics.
    assert.equal(f.store.lastSessionLeaseContention(), undefined)
  } finally { await f.cleanup() }
})

test('14I-S2: a contended lease waits under backoff and acquires after the first owner releases', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '5000'
    const lockPath = f.lockPath(meta.id)
    await f.writeLock(lockPath, { pid: process.pid, token: 'simulated-first-owner-token', started: Date.now() })
    const started = Date.now()
    let timer
    try {
      timer = setTimeout(() => { rm(lockPath, { force: true }).catch(() => {}) }, 120)
      await f.store.appendMessage(meta.id, { role: 'user', content: 'after release' })
    } finally { if (timer) clearTimeout(timer) }
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 100, `second lease should wait for the owner release, took ${elapsed}ms`)
    const contention = f.store.lastSessionLeaseContention()
    assert.ok(contention, 'contended acquisition must populate diagnostics')
    assert.equal(contention.sessionId, meta.id)
    assert.equal(contention.operation, 'append')
    assert.equal(contention.outcome, 'acquired')
    assert.equal(contention.ownerPid, process.pid)
    assert.ok(contention.attempts >= 2, `attempts=${contention.attempts}`)
    assert.ok(contention.waitedMs >= 90, `waitedMs=${contention.waitedMs}`)
    assert.ok(Number.isFinite(contention.decidedAt))
  } finally { await f.cleanup() }
})

test('14I-S2: a stale owner (dead pid) is recovered well before the timeout budget', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '5000'
    await f.writeLock(f.lockPath(meta.id), { pid: DEAD_PID, token: 'dead-owner-token', started: Date.now() })
    const started = Date.now()
    await f.store.appendMessage(meta.id, { role: 'user', content: 'after stale recovery' })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2000, `stale lock should be recovered immediately, took ${elapsed}ms`)
    const contention = f.store.lastSessionLeaseContention()
    assert.equal(contention.outcome, 'recovered-stale')
    assert.equal(contention.ownerPid, DEAD_PID)
    assert.equal(contention.attempts, 2)
    assert.equal(await f.store.currentSequence(meta.id), 2)
  } finally { await f.cleanup() }
})

test('14I-S2: a malformed but fresh lock is waited on, never deleted by a short timeout', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '250'
    const lockPath = f.lockPath(meta.id)
    const corrupted = '{"pid": 99999, token broken'
    await writeFile(lockPath, corrupted, 'utf8')
    await assert.rejects(
      f.store.appendMessage(meta.id, { role: 'user', content: 'blocked by fresh malformed lock' }),
      busyErrorMatch(message => message.includes('malformed') && message.includes('attempt(s)') && message.includes('ms wait')),
    )
    // A fresh malformed lock may still be mid-write by another owner: the
    // timeout must not delete it.
    assert.equal(await readFile(lockPath, 'utf8'), corrupted)
    const contention = f.store.lastSessionLeaseContention()
    assert.equal(contention.outcome, 'timeout')
    assert.equal(contention.ownerPid, undefined)
    assert.ok(contention.waitedMs >= 100, `waitedMs=${contention.waitedMs}`)
    assert.ok(contention.attempts >= 2, `attempts=${contention.attempts}`)
  } finally { await f.cleanup() }
})

test('14I-S2: an aged malformed lock is recovered as soon as it is classified stale', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '5000'
    const lockPath = f.lockPath(meta.id)
    await writeFile(lockPath, '{"pid": broken', 'utf8')
    const aged = new Date(Date.now() - 10000)
    await utimes(lockPath, aged, aged)
    const started = Date.now()
    await f.store.appendMessage(meta.id, { role: 'user', content: 'after malformed recovery' })
    assert.ok(Date.now() - started < 2000, 'aged malformed lock must be recovered immediately')
    const contention = f.store.lastSessionLeaseContention()
    assert.equal(contention.outcome, 'recovered-malformed')
    assert.equal(contention.ownerPid, undefined)
    await assert.rejects(readFile(lockPath), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('14I-S2: budget exhaustion with a live owner yields a precise busy error, diagnostics, and an intact lock', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '250'
    const lockPath = f.lockPath(meta.id)
    await f.writeLock(lockPath, { pid: process.pid, token: 'live-owner-token', started: Date.now() })
    await assert.rejects(
      f.store.appendMessage(meta.id, { role: 'user', content: 'blocked by live owner' }),
      busyErrorMatch(message => message.includes(`live owner pid ${process.pid}`)),
    )
    // A live owner's lock must never be deleted on timeout.
    const after = await f.readLock(lockPath)
    assert.equal(after.token, 'live-owner-token')
    const contention = f.store.lastSessionLeaseContention()
    assert.equal(contention.outcome, 'timeout')
    assert.equal(contention.ownerPid, process.pid)
    assert.ok(contention.waitedMs >= 100, `waitedMs=${contention.waitedMs}`)
  } finally { await f.cleanup() }
})

test('14I-S2: TERMAGENT_SESSION_LOCK_TIMEOUT_MS=0 disables waiting without deleting a live owner lock', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '0'
    const lockPath = f.lockPath(meta.id)
    await f.writeLock(lockPath, { pid: process.pid, token: 'live-owner-zero-budget', started: Date.now() })
    await assert.rejects(
      f.store.appendMessage(meta.id, { role: 'user', content: 'zero budget' }),
      busyErrorMatch(message => message.includes('live owner pid') && message.includes('0 ms wait')),
    )
    assert.ok(await f.readLock(lockPath))
    const contention = f.store.lastSessionLeaseContention()
    assert.equal(contention.outcome, 'timeout')
    assert.equal(contention.attempts, 1)
    assert.equal(contention.waitedMs, 0)
  } finally { await f.cleanup() }
})

test('14I-S2: release is compare-before-delete; a foreign token never removes another owner lock', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    const lockPath = f.lockPath(meta.id)
    await f.writeLock(lockPath, { pid: process.pid, token: 'owner-token', started: Date.now() })
    // releaseStateLease is TS-private; privacy is compile-time only in dist JS,
    // so the regression test exercises it directly.
    await f.store.releaseStateLease({ lockPath, token: 'attacker-token' })
    assert.equal((await f.readLock(lockPath)).token, 'owner-token')
    await f.store.releaseStateLease({ lockPath, token: 'owner-token' })
    await assert.rejects(readFile(lockPath), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})
