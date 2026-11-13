// 14I-B3 — Stream D: session diagnostics + notification delivery durability.
// Covers: redacted lastSessionLeaseContention() records (lock, owner pid +
// process identity, op kind, acquisition wait/retries/recovery decision, hold
// duration, JSONL size, sequence state, session id) reported separately from
// corrupt-JSONL data issues, plus at-least-once task notification delivery
// guarded by consumed markers that preserve child output references and the
// durable notification sequence.
// Tests import dist/ like every other suite here; build happens at integration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, truncate } from 'node:fs/promises'
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

const DEAD_PID = 2147483647

async function fixture() {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14i-d3-home-'))
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
    lockPath: id => path.join(sessionsRoot, `.${id}.state.lock`),
    writeLock: async (lockPath, owner) => writeFile(lockPath, JSON.stringify(owner) + '\n', 'utf8'),
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

test('14I-B3: contended session lease acquisition records a redacted live-owner decision', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '150'
    const secretPrompt = 'SUPER-SECRET-PROMPT-7f3a9c'
    await f.writeLock(f.lockPath(meta.id), { pid: process.pid, token: 'live-owner-token', started: Date.now() })
    await assert.rejects(
      () => f.store.appendMessage(meta.id, { role: 'user', content: secretPrompt }),
      busyErrorMatch(() => true),
    )
    const contention = f.store.lastSessionLeaseContention()
    assert.ok(contention, 'contended acquisition must populate the contention record')
    assert.equal(contention.lock, 'session')
    assert.equal(contention.sessionId, meta.id)
    assert.equal(contention.id, meta.id)
    assert.equal(contention.operation, 'append')
    assert.equal(contention.opKind, 'append')
    assert.equal(contention.decision, 'live-owner')
    assert.equal(contention.outcome, 'timeout')
    assert.equal(contention.ownerPid, process.pid)
    assert.equal(contention.ownerIdentity, `pid:${process.pid}`)
    assert.ok(contention.attempts >= 1)
    assert.ok(Number.isInteger(contention.retries))
    assert.ok(contention.waitedMs >= 0)
    assert.ok(Number.isFinite(contention.decidedAt))
    assert.ok(contention.at > 0)
    assert.ok(Number.isFinite(contention.jsonlBytes), 'contention records the JSONL byte size')
    assert.ok(contention.sequenceState && Number.isFinite(contention.sequenceState.current))
    assert.equal(contention.heldMs, undefined, 'a timed-out acquisition never held the lock')
    assert.ok(!JSON.stringify(contention).includes('SUPER-SECRET-PROMPT-7f3a9c'), 'contention must not retain prompt content')
  } finally { await f.cleanup() }
})

test('14I-B3: stale owner recovery records the recovered-stale decision with retry context', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '5000'
    await f.writeLock(f.lockPath(meta.id), { pid: DEAD_PID, token: 'dead-owner-token', started: Date.now() })
    await f.store.appendMessage(meta.id, { role: 'user', content: 'after stale recovery' })
    const contention = f.store.lastSessionLeaseContention()
    assert.equal(contention.outcome, 'recovered-stale')
    assert.equal(contention.decision, 'recovered-stale')
    assert.equal(contention.ownerPid, DEAD_PID)
    assert.equal(contention.attempts, 2)
    assert.equal(contention.retries, 1)
    assert.equal(await f.store.currentSequence(meta.id), 2)
  } finally { await f.cleanup() }
})

test('14I-B3: corrupt session JSONL is reported through the separate data-issue class', async () => {
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
      () => f.store.load(id),
      error => error instanceof Error && /Corrupt session log at line 2/.test(error.message),
    )
    const issue = f.store.lastSessionDataIssue()
    assert.ok(issue, 'corrupt JSONL must surface a data issue')
    assert.equal(issue.sessionId, id)
    assert.equal(issue.kind, 'corrupt-jsonl')
    assert.equal(issue.line, 2)
    assert.equal(issue.detail, 'invalid-json-line')
    assert.ok(Number.isFinite(issue.at))
  } finally { await f.cleanup() }
})

test('14I-B3: a partial trailing session record is repaired and recorded as a data issue', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    const id = meta.id
    // create() appends exactly one record (the meta line, durable sequence 1).
    // Append a second event so the partial trailing record under test is a
    // real line 2, not the only record in the log.
    await f.store.append(id, { type: 'todo', ts: Date.now(), data: { items: [], previous: [] } })
    const before = await stat(f.logPath(id))
    await truncate(f.logPath(id), before.size - 8)
    const enriched = await f.store.append(id, { type: 'meta', ts: Date.now(), data: { after: 'crash-partial' } })
    // The truncated todo record was never durably committed, so repair drops
    // it and the repaired append reclaims its sequence: meta=1, appended=2.
    assert.equal(Number(enriched.sequence), 2)
    const issue = f.store.lastSessionDataIssue()
    assert.ok(issue, 'partial trailing record must surface a data issue')
    assert.equal(issue.sessionId, id)
    assert.equal(issue.kind, 'trailing-partial-repair')
    assert.equal(issue.line, 2)
  } finally { await f.cleanup() }
})

test('14I-B3: pendingTaskNotifications observes without appending consumed markers', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    const id = meta.id
    const notification = { taskId: 'task-observe-1', kind: 'agent', status: 'completed', summary: 'child finished', outputPath: '/tmp/termagent-task-out-observe.log', childSessionId: 'child-observe-1', completedAt: Date.now() }
    await f.store.append(id, { type: 'task.notification', ts: Date.now(), data: notification })
    const pending = await f.store.pendingTaskNotifications(id)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].taskId, 'task-observe-1')
    assert.equal(pending[0].status, 'completed')
    assert.equal(pending[0].notificationSequence, 2)
    const consumedBefore = (await f.store.load(id)).events.filter((event) => event.type === 'task.notification.consumed').length
    assert.equal(consumedBefore, 0, 'observe-only pendingTaskNotifications must not append consumed markers')
    const consumed = await f.store.consumeTaskNotifications(id)
    assert.equal(consumed.length, 1)
    assert.equal((await f.store.pendingTaskNotifications(id)).length, 0)
  } finally { await f.cleanup() }
})

test('14I-B3: deliverTaskNotifications delivers before marking and keeps delivery at-least-once', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    const id = meta.id
    const notification = { taskId: 'task-deliver-1', kind: 'agent', status: 'completed', summary: 'child finished ok', outputPath: '/tmp/termagent-task-out-deliver-1.log', childSessionId: 'child-deliver-1', completedAt: Date.now() }
    await f.store.append(id, { type: 'task.notification', ts: Date.now(), data: notification })
    await assert.rejects(
      () => f.store.deliverTaskNotifications(id, async () => { throw new Error('simulated delivery crash') }),
      error => error instanceof Error && /simulated delivery crash/.test(error.message),
    )
    assert.equal((await f.store.pendingTaskNotifications(id)).length, 1, 'failed delivery must leave the notification pending')
    const delivered = []
    const deliveredNow = await f.store.deliverTaskNotifications(id, async (notification) => { delivered.push(notification) })
    assert.equal(deliveredNow.length, 1)
    assert.equal(delivered[0].taskId, 'task-deliver-1')
    assert.equal(delivered[0].outputPath, '/tmp/termagent-task-out-deliver-1.log')
    assert.equal(delivered[0].childSessionId, 'child-deliver-1')
    assert.equal(delivered[0].notificationSequence, 2)
    const consumedEvents = (await f.store.load(id)).events.filter((event) => event.type === 'task.notification.consumed')
    assert.equal(consumedEvents.length, 1)
    assert.equal(consumedEvents[0].data.taskId, 'task-deliver-1')
    assert.equal(consumedEvents[0].data.notificationSequence, 2)
    assert.equal(consumedEvents[0].data.outputPath, '/tmp/termagent-task-out-deliver-1.log')
    assert.equal(consumedEvents[0].data.childSessionId, 'child-deliver-1')
    assert.equal(consumedEvents[0].data.status, 'completed')
    const redelivered = await f.store.deliverTaskNotifications(id, async (notification) => { delivered.push(notification) })
    assert.equal(redelivered.length, 0, 'marker landed, so the next pass must not redeliver')
  } finally { await f.cleanup() }
})

test('14I-B3: duplicate task.notification events for one taskId deliver once', async () => {
  const f = await fixture()
  try {
    const meta = await f.store.create(f.sessionsRoot, 'test-model')
    const id = meta.id
    const base = { kind: 'shell', status: 'completed', summary: 'duplicate worker completion', completedAt: Date.now() }
    await f.store.append(id, { type: 'task.notification', ts: Date.now(), data: { taskId: 'task-dup-1', ...base } })
    await f.store.append(id, { type: 'task.notification', ts: Date.now(), data: { taskId: 'task-dup-1', ...base } })
    const delivered = []
    const deliveredNow = await f.store.deliverTaskNotifications(id, async (notification) => { delivered.push(notification) })
    assert.equal(deliveredNow.length, 1)
    assert.equal(delivered[0].taskId, 'task-dup-1')
    assert.equal(delivered[0].notificationSequence, 2)
    assert.equal((await f.store.pendingTaskNotifications(id)).length, 0, 'a single delivery plus marker suppresses the duplicate notification')
  } finally { await f.cleanup() }
})
