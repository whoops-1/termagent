// Stream T — Phase 14I item 871: stress evidence. Each test uses its own
// temp root and is bounded. Tests import dist/ directly.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_KEYS = ['HOME', 'TERMAGENT_SESSION_ROOT', 'TERMAGENT_SESSION_LOCK_TIMEOUT_MS', 'TERMAGENT_TASK_ROOT', 'TERMAGENT_TASK_LOCK_TIMEOUT_MS']

function saveEnv() { return Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]])) }
function restoreEnv(prev) {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

async function rmWithRetry(target, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try { await rm(target, { recursive: true, force: true }); return }
    catch (e) {
      if (i === attempts || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(e.code)) throw e
      await new Promise(r => setTimeout(r, 50 * i))
    }
  }
}

const DEAD_PID = 2147483647

// ---------- Test 1: concurrent task completion ----------
test('14I-stress: concurrent task completion delivers exactly N notifications once', { timeout: 120000 }, async () => {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'ta-14i-s1-home-'))
  const sessionsRoot = path.join(home, '.termagent', 'sessions')
  const taskRoot = path.join(home, '.termagent', 'tasks')
  await mkdir(sessionsRoot, { recursive: true })
  await mkdir(taskRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_SESSION_ROOT = sessionsRoot
  process.env.TERMAGENT_TASK_ROOT = taskRoot
  delete process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS
  delete process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const store = new SessionStore(sessionsRoot)
    const manager = new TaskManager(taskRoot, false)
    const parent = await store.create(sessionsRoot, 'test-model')
    const N = 6
    const tasks = await Promise.all(Array.from({ length: N }, () =>
      manager.createShell('echo hi', os.tmpdir(), parent.id, [], { background: true })
    ))
    await Promise.all(tasks.map(t => manager.finish(t.id, { status: 'exited', exitCode: 0, result: 'done' })))
    const loaded = await store.load(parent.id)
    const notifs = loaded.events.filter(e => e.type === 'task.notification')
    assert.equal(notifs.length, N, 'exactly N task.notification events')
    // deliver once
    const delivered = []
    const deliveredNow = await store.deliverTaskNotifications(parent.id, async (n) => { delivered.push(n) })
    assert.equal(deliveredNow.length, N, 'all N delivered in first pass')
    assert.equal(delivered.length, N)
    assert.equal((await store.pendingTaskNotifications(parent.id)).length, 0)
    // second pass delivers nothing
    const redelivered = await store.deliverTaskNotifications(parent.id, async () => {})
    assert.equal(redelivered.length, 0, 'marker landed; no redelivery')
    // sequences strictly monotonic among notification events
    const seqs = notifs.map(e => e.sequence).sort((a, b) => a - b)
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'monotonic sequences')
  } finally {
    restoreEnv(previous)
    await rmWithRetry(home)
  }
})

// ---------- Test 2: several workers appending to one parent session ----------
test('14I-stress: concurrent appends from multiple workers preserve monotonic sequences', { timeout: 120000 }, async () => {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'ta-14i-s2-home-'))
  const sessionsRoot = path.join(home, '.termagent', 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_SESSION_ROOT = sessionsRoot
  delete process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const id = 'shared-session'
    const seeder = new SessionStore(sessionsRoot)
    await seeder.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    const workers = Array.from({ length: 4 }, () => new SessionStore(sessionsRoot))
    const N = 40
    const ops = Array.from({ length: N }, (_, i) =>
      workers[i % workers.length].append(id, { type: 'meta', ts: Date.now(), data: { i } })
    )
    await Promise.all(ops)
    const loaded = await seeder.load(id)
    assert.equal(loaded.events.length, N + 1, 'all events present')
    const seqs = loaded.events.map(e => e.sequence)
    const unique = new Set(seqs)
    assert.equal(unique.size, seqs.length, 'no duplicate sequences')
    const sorted = [...seqs].sort((a, b) => a - b)
    assert.deepEqual(seqs.slice().sort((a, b) => a - b), sorted)
    // continuity: 1..N+1
    for (let i = 0; i < sorted.length; i++) assert.equal(sorted[i], i + 1, 'contiguous sequences')
  } finally {
    restoreEnv(previous)
    await rmWithRetry(home)
  }
})

// ---------- Test 3: long JSONL history ----------
test('14I-stress: append after long JSONL history stays under 5s and keeps sequence continuity', { timeout: 300000 }, async () => {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'ta-14i-s3-home-'))
  const sessionsRoot = path.join(home, '.termagent', 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_SESSION_ROOT = sessionsRoot
  delete process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(sessionsRoot)
    const id = 'long-history'
    const TARGET = 5000
    for (let i = 0; i < TARGET; i++) {
      await store.append(id, { type: 'meta', ts: Date.now(), data: { i } })
    }
    const before = await store.currentSequence(id)
    assert.equal(before, TARGET, 'seeded sequence count')
    const start = Date.now()
    const appended = await store.append(id, { type: 'meta', ts: Date.now(), data: { final: true } })
    const elapsed = Date.now() - start
    assert.ok(elapsed < 5000, `append took ${elapsed}ms, ceiling 5000ms`)
    assert.equal(Number(appended.sequence), TARGET + 1, 'sequence continuity after long history')
    const loaded = await store.load(id)
    assert.equal(loaded.events.length, TARGET + 1)
  } finally {
    restoreEnv(previous)
    await rmWithRetry(home)
  }
})

// ---------- Test 4: simultaneous subscribers + slow SSE consumer ----------
test('14I-stress: slow SSE consumer receives all frames and server stays responsive', { timeout: 120000 }, async () => {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'ta-14i-s4-home-'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'ta-14i-s4-root-'))
  const sessionsRoot = path.join(home, '.termagent', 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_SESSION_ROOT = sessionsRoot
  delete process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS
  try {
    const { SessionEventBus } = await import('../dist/session/event-bus.js')
    const { SessionStore } = await import('../dist/session/store.js')
    const { startServer } = await import('../dist/server/http.js')
    const events = new SessionEventBus()
    const store = new SessionStore(sessionsRoot, events)
    const id = 'slow-consumer'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id, cwd: root } })
    const runtime = { cwd: root, cfg: { maxOutputBytes: 100000, providers: {}, routing: {}, smartRouting: {} }, store, events, tasks: { history: async () => [], list: async () => [] }, mcp: { clients: [] }, customCommands: [], customAgents: [], skills: [], registry: { list: () => [] }, getProvider: () => ({ id: 'test', model: 'test-model' }), isRunning: () => false, contextSnapshot: async () => ({ sessionId: 'context', tokens: 0, limit: 12000, remaining: 12000, utilization: 0 }) }
    const server = await startServer(runtime, { host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.address().port}`
    let fastReq, slowReq
    try {
      const fastFrames = []
    const slowFrames = []
    // fast subscriber
    const fastReqP = openEventStreamFast(base, `/api/v1/sessions/${id}/events/stream?after=0`, fastFrames)
    // slow subscriber with delayed reads
    const slowReqP = openSlowStream(base, `/api/v1/sessions/${id}/events/stream?after=0`, slowFrames, 8)
    fastReq = await fastReqP
    slowReq = await slowReqP
    // wait for both subscribers
    const subDeadline = Date.now() + 5000
    while (events.subscriberCount(id) !== 2 && Date.now() < subDeadline) await new Promise(r => setTimeout(r, 10))
    assert.equal(events.subscriberCount(id), 2, 'both subscribers attached')

    const N = 20
    const workerStore = new SessionStore(sessionsRoot)
    for (let i = 0; i < N; i++) {
      await workerStore.append(id, { type: 'meta', ts: Date.now(), data: { i } })
    }

    const target = 1 + N
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (fastFrames.filter(f => f.event === 'event').length >= target &&
          slowFrames.filter(f => f.event === 'event').length >= target) break
      await new Promise(r => setTimeout(r, 50))
    }
    assert.ok(fastFrames.filter(f => f.event === 'event').length >= target, 'fast client received all durable events')
    assert.ok(slowFrames.filter(f => f.event === 'event').length >= target, 'slow client received all durable events')

    // server responsive: /health returns 200 during stream
    const health = await httpGet(base, '/health')
    assert.equal(health.status, 200)
    } finally {
      // Teardown must run even when assertions throw: open SSE responses keep
      // the event loop alive and would hang the whole test process otherwise.
      try { fastReq?.destroy() } catch {}
      try { slowReq?.destroy() } catch {}
      try { server.closeAllConnections?.() } catch {}
      try { await new Promise(r => server.close(r)) } catch {}
    }
  } finally {
    restoreEnv(previous)
    await rmWithRetry(home)
    await rmWithRetry(root)
  }
})

// ---------- Test 5: lock owner crash + stale recovery ----------
test('14I-stress: dead owner lock recovers; live owner lock survives timeout', { timeout: 120000 }, async () => {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'ta-14i-s5-home-'))
  const sessionsRoot = path.join(home, '.termagent', 'sessions')
  const taskRoot = path.join(home, '.termagent', 'tasks')
  await mkdir(sessionsRoot, { recursive: true })
  await mkdir(taskRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_SESSION_ROOT = sessionsRoot
  process.env.TERMAGENT_TASK_ROOT = taskRoot
  delete process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS
  delete process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS
  try {
    // session store: stale recovery
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(sessionsRoot)
    const meta = await store.create(sessionsRoot, 'test-model')
    const lockPath = path.join(sessionsRoot, `.${meta.id}.state.lock`)
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(lockPath, JSON.stringify({ pid: DEAD_PID, token: 'dead', started: Date.now() }) + '\n')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '5000'
    await store.appendMessage(meta.id, { role: 'user', content: 'after stale' })
    const contention = store.lastSessionLeaseContention()
    assert.equal(contention.outcome, 'recovered-stale')
    assert.equal(contention.decision, 'recovered-stale')

    // session store: live owner survives
    const meta2 = await store.create(sessionsRoot, 'test-model')
    const lockPath2 = path.join(sessionsRoot, `.${meta2.id}.state.lock`)
    await wf(lockPath2, JSON.stringify({ pid: process.pid, token: 'live-token', started: Date.now() }) + '\n')
    process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS = '150'
    await assert.rejects(
      () => store.appendMessage(meta2.id, { role: 'user', content: 'should fail' }),
      (e) => e instanceof Error && e.message.startsWith('Session state is busy:')
    )
    const lockStill = JSON.parse((await readFile(lockPath2, 'utf8')).trim())
    assert.equal(lockStill.token, 'live-token', 'live owner lock survives')

    // task manager: stale recovery
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const manager = new TaskManager(taskRoot, false)
    const { writeFile: wf2 } = await import('node:fs/promises')
    const tId = 'task-stale'
    await wf2(path.join(taskRoot, `${tId}.json`), JSON.stringify({ id: tId, kind: 'shell', status: 'running', command: 'echo', cwd: os.tmpdir(), started: Date.now(), updated: Date.now() }))
    await wf2(path.join(taskRoot, `.${tId}.task.lock`), JSON.stringify({ pid: DEAD_PID, token: 'dead', started: Date.now() }) + '\n')
    const { TaskManager: FM } = await import('../dist/tasks/manager.js')
    const fm = new FM(taskRoot, false)
    const started = Date.now()
    await fm.update(tId, { status: 'exited', exitCode: 0 })
    assert.ok(Date.now() - started < 3000, 'stale task recovery is fast')
    assert.equal(fm.lastTaskLeaseContention().outcome, 'recovered-stale')

    // task manager: live owner survives
    const tId2 = 'task-live'
    await wf2(path.join(taskRoot, `${tId2}.json`), JSON.stringify({ id: tId2, kind: 'shell', status: 'running', command: 'echo', cwd: os.tmpdir(), started: Date.now(), updated: Date.now() }))
    await wf2(path.join(taskRoot, `.${tId2}.task.lock`), JSON.stringify({ pid: process.pid, token: 'do-not-touch', started: Date.now() }) + '\n')
    process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS = '200'
    const fm2 = new (await import('../dist/tasks/manager.js')).TaskManager(taskRoot, false)
    await assert.rejects(
      () => fm2.update(tId2, { status: 'exited' }),
      (e) => e instanceof Error && e.message.startsWith(`Task ${tId2} is busy:`)
    )
    const lock2 = JSON.parse((await readFile(path.join(taskRoot, `.${tId2}.task.lock`), 'utf8')).trim())
    assert.equal(lock2.token, 'do-not-touch', 'live task owner lock survives')
  } finally {
    restoreEnv(previous)
    await rmWithRetry(home)
  }
})

// ---------- Test 6: daemon restart ----------
test('14I-stress: daemon restart preserves sessions, recovers tasks, pending notifications deliver once', { timeout: 120000 }, async () => {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'ta-14i-s6-home-'))
  const sessionsRoot = path.join(home, '.termagent', 'sessions')
  const taskRoot = path.join(home, '.termagent', 'tasks')
  await mkdir(sessionsRoot, { recursive: true })
  await mkdir(taskRoot, { recursive: true })
  process.env.HOME = home
  process.env.TERMAGENT_SESSION_ROOT = sessionsRoot
  process.env.TERMAGENT_TASK_ROOT = taskRoot
  delete process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS
  delete process.env.TERMAGENT_TASK_LOCK_TIMEOUT_MS
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const { TaskManager } = await import('../dist/tasks/manager.js')
    const store1 = new SessionStore(sessionsRoot)
    const manager1 = new TaskManager(taskRoot, false)
    const parent = await store1.create(sessionsRoot, 'test-model')
    // running task record with dead pid (simulates crashed daemon worker)
    const created = await manager1.createShell('echo hi', os.tmpdir(), parent.id, [], { background: true })
    const realId = created.id
    await manager1.update(realId, { status: 'running', pid: DEAD_PID, parentNotified: true })
    // pre-seed a pending notification
    await store1.append(parent.id, { type: 'task.notification', ts: Date.now(), data: { taskId: realId, kind: 'shell', status: 'completed', summary: 'done', completedAt: Date.now() } })
    const eventsBefore = (await store1.load(parent.id)).events.length
    // destroy instances (drop references)
    // create fresh instances
    const store2 = new SessionStore(sessionsRoot)
    const manager2 = new TaskManager(taskRoot, false)
    await manager2.recover()
    // session events intact
    const eventsAfter = (await store2.load(parent.id)).events.length
    assert.equal(eventsAfter, eventsBefore, 'session events survive restart')
    // task recovered (dead pid -> failed)
    const task = await manager2.get(realId)
    assert.equal(task.status, 'failed', 'running task with dead pid recovered to failed')
    // pending notification deliverable exactly once
    const delivered = []
    const first = await store2.deliverTaskNotifications(parent.id, async (n) => { delivered.push(n) })
    assert.equal(first.length, 1)
    assert.equal(delivered.length, 1)
    const second = await store2.deliverTaskNotifications(parent.id, async () => {})
    assert.equal(second.length, 0, 'second pass delivers nothing')
  } finally {
    restoreEnv(previous)
    await rmWithRetry(home)
  }
})

// ---------- helpers for test 4 ----------
function openEventStreamFast(base, pathname, frames) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), { headers: { accept: 'text/event-stream' } })
    req.on('error', (e) => { if (e?.code !== 'ECONNRESET') { /* swallow */ } })
    req.once('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error(`status ${res.statusCode}`)); return }
      res.setEncoding('utf8')
      let carry = ''
      res.on('data', (chunk) => {
        carry += chunk
        while (true) {
          const idx = carry.indexOf('\n\n')
          if (idx < 0) break
          const frame = carry.slice(0, idx)
          carry = carry.slice(idx + 2)
          let event = 'message'
          const data = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            if (line.startsWith('data:')) data.push(line.slice(5).trim())
          }
          if (data.length) {
            try { frames.push({ event, data: JSON.parse(data.join('\n')) }) } catch {}
          }
        }
      })
      res.on('error', (e) => { if (e?.code !== 'ECONNRESET') { /* swallow */ } })
    })
    req.end()
    resolve(req)
  })
}

function openSlowStream(base, pathname, frames, delayMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), { headers: { accept: 'text/event-stream' } })
    req.on('error', (e) => { if (e?.code !== 'ECONNRESET') { /* swallow */ } })
    req.once('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error(`status ${res.statusCode}`)); return }
      res.setEncoding('utf8')
      let carry = ''
      res.on('data', (chunk) => {
        res.pause()
        setTimeout(() => {
          carry += chunk
          while (true) {
            const idx = carry.indexOf('\n\n')
            if (idx < 0) break
            const frame = carry.slice(0, idx)
            carry = carry.slice(idx + 2)
            let event = 'message'
            const data = []
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim()
              if (line.startsWith('data:')) data.push(line.slice(5).trim())
            }
            if (data.length) {
              try { frames.push({ event, data: JSON.parse(data.join('\n')) }) } catch {}
            }
          }
          res.resume()
        }, delayMs)
      })
      res.on('error', (e) => { if (e?.code !== 'ECONNRESET') { /* swallow */ } })
    })
    req.end()
    resolve(req)
  })
}

function httpGet(base, pathname) {
  return new Promise((resolve, reject) => {
    http.get(new URL(pathname, base), (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => body += c)
      res.on('end', () => resolve({ status: res.statusCode, body }))
    }).on('error', reject)
  })
}
