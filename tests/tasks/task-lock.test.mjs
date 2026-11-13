// 14I-B2 — task-manager lock hardening + parent-orchestration settle wakeup.
// Covers: shared classified lock core (bounded backoff + jitter, live owner /
// malformed / stale classification), budget-exhaustion busy errors that keep
// the historical error prefixes, live-owner locks are never deleted,
// compare-before-release, redacted lastTaskLeaseContention() diagnostics, and
// waitTaskSettled in-process wakeup semantics.
// Tests import dist/ like every other suite here; build happens at integration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_KEYS = [
  'HOME', 'TERMAGENT_TASK_ROOT', 'TERMAGENT_TASK_LOCK_TIMEOUT_MS',
]
function saveEnv() { return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])) }
function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

// Beyond any plausible pid allocation on POSIX and Windows: kill(pid, 0) → ESRCH.
const DEAD_PID = 2147483647

// Windows recursive rm can race concurrent lock-file create/delete cycles
// (ENOTEMPTY/EBUSY between the walk and the rmdir); retry briefly instead of
// failing the test on cleanup timing.
async function rmWithRetry(target, attempts = 5) {
  for (let index = 1; index <= attempts; index++) {
    try { await rm(target, { recursive: true, force: true }); return }
    catch (error) {
      if (index === attempts || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 50 * index))
    }
  }
}

function taskRecord(id, overrides = {}) {
  return {
    id, kind: 'shell', status: 'running', command: 'echo hi', cwd: os.tmpdir(),
    started: Date.now(), updated: Date.now(), ...overrides,
  }
}

async function fixture() {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14i-b2-home-'))
  const taskRoot = path.join(home, '.termagent', 'tasks')
  await mkdir(taskRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_TASK_ROOT = taskRoot
  delete process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS
  const { TaskManager } = await import('../../dist/tasks/manager.js')
  const manager = new TaskManager(taskRoot, false)
  return {
    manager, taskRoot, taskRecord,
    lockPath: id => path.join(taskRoot, `.${id}.task.lock`),
    writeTask: async (id, overrides) => writeFile(path.join(taskRoot, `${id}.json`), JSON.stringify(taskRecord(id, overrides)), 'utf8'),
    writeLock: async (lockPath, owner) => writeFile(lockPath, typeof owner === 'string' ? owner : JSON.stringify(owner) + '\n', 'utf8'),
    async cleanup() {
      restoreEnv(previous)
      await rmWithRetry(home)
    },
  }
}

test('14I-B2: uncontended task update acquires, runs, and releases the task lock', async () => {
  const f = await fixture()
  try {
    await f.writeTask('t1')
    const updated = await f.manager.update('t1', { status: 'exited', exitCode: 0 })
    assert.equal(updated.status, 'exited')
    await assert.rejects(stat(f.lockPath('t1')), error => error.code === 'ENOENT', 'lock is released after the operation')
  } finally { await f.cleanup() }
})

test('14I-B2: concurrent task updates all complete without spurious busy errors', async () => {
  const f = await fixture()
  try {
    await f.writeTask('t2')
    // Each update writes a distinct field: a read-modify-write merge under the
    // lock must preserve every concurrent update in the final record. (A shared
    // scalar would make the final value last-writer-wins and nondeterministic.)
    const updates = Array.from({ length: 20 }, (_, index) => f.manager.update('t2', { [`marker${index}`]: index }))
    const results = await Promise.all(updates)
    assert.equal(results.length, 20)
    const final = await f.manager.get('t2')
    for (let index = 0; index < 20; index++) {
      assert.equal(final[`marker${index}`], index, `every serialized update landed (marker${index})`)
    }
  } finally { await f.cleanup() }
})

test('14I-B2: a live owner keeps its lock; the busy error preserves the historical prefix and reports the owner', async () => {
  const f = await fixture()
  try {
    process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS = '300'
    const { TaskManager: FreshManager } = await import('../../dist/tasks/manager.js')
    const manager = new FreshManager(f.taskRoot, false)
    await f.writeTask('t3')
    await f.writeLock(f.lockPath('t3'), { pid: process.pid, token: 'foreign-token', started: Date.now() })
    await assert.rejects(
      () => manager.update('t3', { status: 'exited' }),
      error => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.startsWith(`Task t3 is busy:`), `unexpected message: ${error.message}`)
        assert.match(error.message, /live owner pid \d+ still holds the lock/)
        return true
      },
    )
    const lockStillThere = JSON.parse((await readFile(f.lockPath('t3'), 'utf8')).trim())
    assert.equal(lockStillThere.token, 'foreign-token', 'a live owner\'s lock is never deleted on timeout')
    const contention = manager.lastTaskLeaseContention()
    assert.equal(contention.outcome, 'timeout')
    assert.equal(contention.ownerPid, process.pid)
    assert.ok(contention.attempts >= 1)
    assert.ok(contention.decidedAt > 0)
  } finally { await f.cleanup() }
})

test('14I-B2: a stale owner (dead pid) is recovered immediately', async () => {
  const f = await fixture()
  try {
    const { TaskManager: FreshManager } = await import('../../dist/tasks/manager.js')
    const manager = new FreshManager(f.taskRoot, false)
    await f.writeTask('t4')
    await f.writeLock(f.lockPath('t4'), { pid: DEAD_PID, token: 'stale-token', started: Date.now() })
    const started = Date.now()
    await manager.update('t4', { status: 'exited' })
    assert.ok(Date.now() - started < 3000, `recovery took too long: ${Date.now() - started}ms`)
    const contention = manager.lastTaskLeaseContention()
    assert.equal(contention.outcome, 'recovered-stale')
    assert.equal(contention.ownerPid, DEAD_PID)
  } finally { await f.cleanup() }
})

test('14I-B2: a fresh malformed lock is waited on, not deleted; an aged one is recovered', async () => {
  const f = await fixture()
  try {
    process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS = '250'
    const { TaskManager: FreshManager } = await import('../../dist/tasks/manager.js')
    const manager = new FreshManager(f.taskRoot, false)
    await f.writeTask('t5')
    await f.writeLock(f.lockPath('t5'), 'not-json-at-all')
    await assert.rejects(
      () => manager.update('t5', { status: 'exited' }),
      error => error instanceof Error && error.message.startsWith('Task t5 is busy:') && /malformed or incomplete lock payload/.test(error.message),
    )
    const stillThere = await readFile(f.lockPath('t5'), 'utf8')
    assert.equal(stillThere, 'not-json-at-all', 'a fresh malformed lock is not deleted while it may be mid-write')

    // Age the malformed contents past the freshness threshold: recovery is now safe.
    const aged = new Date(Date.now() - 10_000)
    await utimes(f.lockPath('t5'), aged, aged)
    await manager.update('t5', { status: 'exited' })
    assert.equal((await f.manager.get('t5')).status, 'exited')
    assert.equal(manager.lastTaskLeaseContention().outcome, 'recovered-malformed')
  } finally { await f.cleanup() }
})

test('14I-B2: compare-before-release keeps a foreign owner\'s live lock', async () => {
  const f = await fixture()
  try {
    process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS = '250'
    const { TaskManager: FreshManager } = await import('../../dist/tasks/manager.js')
    const manager = new FreshManager(f.taskRoot, false)
    await f.writeTask('t6')
    // Our own pid is provably live: the acquirer must wait and time out, and
    // release paths (which run only after a successful acquisition here) must
    // never have removed the foreign lock.
    await f.writeLock(f.lockPath('t6'), { pid: process.pid, token: 'do-not-touch', started: Date.now() })
    await assert.rejects(() => manager.update('t6', { status: 'exited' }), error => error instanceof Error && error.message.startsWith('Task t6 is busy:'))
    const lock = JSON.parse((await readFile(f.lockPath('t6'), 'utf8')).trim())
    assert.equal(lock.token, 'do-not-touch')
  } finally { await f.cleanup() }
})

test('14I-B2: waitTaskSettled wakes on same-process settlement and honors its deadline', async () => {
  const f = await fixture()
  try {
    await f.writeTask('t7', { status: 'running' })
    const settled = f.manager.waitTaskSettled('t7', 5000)
    await f.manager.update('t7', { status: 'exited', exitCode: 0 })
    const result = await settled
    assert.equal(result?.status, 'exited')

    await f.writeTask('t8', { status: 'running' })
    const timedOut = await f.manager.waitTaskSettled('t8', 250)
    assert.equal(timedOut, undefined, 'deadline expiry resolves with undefined')
    const stillRunning = await f.manager.get('t8')
    assert.equal(stillRunning.status, 'running')

    const missing = await f.manager.waitTaskSettled('missing-task', 100)
    assert.equal(missing, undefined, 'a vanished task record resolves with undefined')
  } finally { await f.cleanup() }
})
