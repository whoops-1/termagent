import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function tempRoot() { return await mkdtemp(path.join(os.tmpdir(), 'termagent-phase14b-')) }

async function waitForSubscriberCount(events, sessionId, expected) {
  const deadline = Date.now() + 2000
  while (events.subscriberCount(sessionId) !== expected) {
    if (Date.now() >= deadline) throw new Error(`subscriber count did not reach ${expected}; got ${events.subscriberCount(sessionId)}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function fakeRuntime(store, events, cwd) {
  return {
    cwd,
    cfg: { maxOutputBytes: 100000, providers: {}, routing: {}, smartRouting: {} },
    store,
    events,
    tasks: { history: async () => [], list: async () => [] },
    mcp: { clients: [] },
    customCommands: [],
    customAgents: [],
    skills: [],
    registry: { list: () => [] },
    getProvider: () => ({ id: 'test', model: 'test-model' }),
    isRunning: () => false,
    contextSnapshot: async () => ({ sessionId: 'context', tokens: 0, limit: 12000, remaining: 12000, utilization: 0 }),
  }
}


function httpJson(base, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), { headers: { accept: 'application/json', connection: 'close' } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.once('error', reject)
      res.once('end', () => {
        try { resolve({ status: res.statusCode, data: body ? JSON.parse(body) : undefined }) }
        catch (error) { reject(error) }
      })
    })
    req.once('error', reject)
    req.end()
  })
}

async function openEventStream(base, pathname, onFrame) {
  const req = http.request(new URL(pathname, base), { headers: { accept: 'text/event-stream' } })
  req.on('error', error => { if (error?.code !== 'ECONNRESET') throw error })
  req.once('response', res => {
    if (res.statusCode !== 200) throw new Error(`unexpected stream status ${res.statusCode}`)
    res.setEncoding('utf8')
    let carry = ''
    res.on('data', chunk => {
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
        if (data.length) onFrame({ event, data: JSON.parse(data.join('\n')) }, req)
      }
    })
    res.on('error', error => { if (error?.code !== 'ECONNRESET') throw error })
  })
  req.end()
  return req
}


test('14F SSE writer waits for drain and stops waiting when the response closes', async () => {
  const { writeSse } = await import('../dist/server/http.js')
  class SlowResponse extends EventEmitter {
    writableEnded = false
    destroyed = false
    frames = []
    write(frame) { this.frames.push(frame); return false }
  }

  const response = new SlowResponse()
  let settled = false
  const pending = writeSse(response, 'event', { sequence: 7 }).then(value => { settled = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'writer must not advance while the socket is backpressured')
  assert.match(response.frames[0], /event: event\ndata: \{\"sequence\":7\}\n\n/)
  response.emit('drain')
  assert.equal(await pending, true)

  const closed = new SlowResponse()
  const waiting = writeSse(closed, 'event', { sequence: 8 })
  closed.destroyed = true
  closed.emit('close')
  assert.equal(await waiting, false)
})

test('14B durable event stream replays then tails without a polling gap', async () => {
  const root = await tempRoot()
  const { SessionEventBus } = await import('../dist/session/event-bus.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { startServer } = await import('../dist/server/http.js')
  const events = new SessionEventBus()
  const store = new SessionStore(path.join(root, 'sessions'), events)
  const id = 'stream-session'
  let server
  const closeServer = async () => {
    if (!server) return
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    server = undefined
  }
  try {
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id, cwd: root } })
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { n: 1 } })

    const runtime = fakeRuntime(store, events, root)
    server = await startServer(runtime, { host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.address().port}`
    const frames = []

    let streamResolve
    let streamReject
    const originalDurableEvents = store.durableEvents.bind(store)
    let delayedReplay = true
    store.durableEvents = async (...args) => {
      const result = await originalDurableEvents(...args)
      if (delayedReplay) {
        delayedReplay = false
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      return result
    }

    const streamReady = new Promise((resolve, reject) => { streamResolve = resolve; streamReject = reject })
    await openEventStream(base, `/api/v1/sessions/${id}/events/stream?after=1`, (frame, req) => {
      frames.push(frame)
      if (frame.event === 'event' && frame.data.sequence === 3) {
        req.destroy()
        streamResolve()
      }
      if (frame.event === 'error') streamReject(new Error(frame.data.message))
    })

    await waitForSubscriberCount(events, id, 1)
    assert.equal(events.subscriberCount(id), 1)

    // Commit while the first historical read is deliberately paused. Because
    // the subscriber exists before replay, the dirty edge cannot be lost.
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { n: 2 } })
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { n: 3 } })

    await streamReady
    const ready = frames.find(frame => frame.event === 'ready')
    assert.equal(ready.data.currentSequence, 2)
    assert.equal(ready.data.replayAfter, 1)
    assert.equal(frames.some(frame => frame.event === 'connection' && frame.data.payload.state === 'connected'), true)
    assert.deepEqual(frames.filter(frame => frame.event === 'event').map(frame => frame.data.sequence), [2, 3])

    const snapshotRes = await httpJson(base, `/api/v1/sessions/${id}/snapshot`)
    assert.equal(snapshotRes.status, 200)
    const snapshot = snapshotRes.data
    assert.equal(snapshot.sequence, 4)
    assert.equal(snapshot.state.meta.id, id)
    assert.deepEqual((await store.durableEvents(id, 1, 10)).events.map(event => event.sequence), [2, 3, 4])

    assert.equal(events.subscriberCount(id), 0)
  } finally {
    await closeServer()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(events.subscriberCount(), 0)
    await rm(root, { recursive: true, force: true })
  }
})

test('14B disconnect and reconnect resume from the last durable sequence without changing session truth', async () => {
  const root = await tempRoot()
  const { SessionEventBus } = await import('../dist/session/event-bus.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { startServer } = await import('../dist/server/http.js')
  const events = new SessionEventBus()
  const store = new SessionStore(path.join(root, 'sessions'), events)
  const id = 'reconnect-session'
  let server
  const closeServer = async () => {
    if (!server) return
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    server = undefined
  }
  try {
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id, cwd: root } })
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { n: 1 } })
    server = await startServer(fakeRuntime(store, events, root), { host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.address().port}`

    const firstFrames = []
    let firstReq
    const firstReady = new Promise((resolve, reject) => {
      openEventStream(base, `/api/v1/sessions/${id}/events/stream?after=0`, (frame, req) => {
        firstReq = req
        firstFrames.push(frame)
        if (frame.event === 'event' && frame.data.sequence === 2) {
          req.destroy()
          resolve()
        }
        if (frame.event === 'error') reject(new Error(frame.data.message))
      }).catch(reject)
    })
    await firstReady
    assert.ok(firstReq.destroyed || firstReq.writableEnded)
    await waitForSubscriberCount(events, id, 0)

    const before = await store.currentSequence(id)
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { n: 2 } })
    assert.equal(await store.currentSequence(id), before + 1)

    const secondFrames = []
    let secondReq
    const secondReady = new Promise((resolve, reject) => {
      openEventStream(base, `/api/v1/sessions/${id}/events/stream?after=2`, (frame, req) => {
        secondReq = req
        secondFrames.push(frame)
        if (frame.event === 'event' && frame.data.sequence === 3) {
          req.destroy()
          resolve()
        }
        if (frame.event === 'error') reject(new Error(frame.data.message))
      }).catch(reject)
    })
    await secondReady
    assert.equal(secondFrames.filter(frame => frame.event === 'event').map(frame => frame.data.sequence).join(','), '3')
    await waitForSubscriberCount(events, id, 0)
    assert.ok(secondReq.destroyed || secondReq.writableEnded)
    assert.equal(await store.currentSequence(id), 3)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    assert.equal(events.subscriberCount(), 0)
    await rm(root, { recursive: true, force: true })
  }
})


test('14F SSE tail observes durable writes from an independent SessionStore without a shared EventBus', async () => {
  const root = await tempRoot()
  const { SessionEventBus } = await import('../dist/session/event-bus.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { startServer } = await import('../dist/server/http.js')
  const events = new SessionEventBus()
  const rootPath = path.join(root, 'sessions')
  const daemonStore = new SessionStore(rootPath, events)
  const workerStore = new SessionStore(rootPath)
  const id = 'cross-process-tail'
  let server
  try {
    await daemonStore.append(id, { type: 'meta', ts: Date.now(), data: { id, cwd: root } })
    server = await startServer(fakeRuntime(daemonStore, events, root), { host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.address().port}`
    const received = new Promise((resolve, reject) => {
      openEventStream(base, `/api/v1/sessions/${id}/events/stream?after=1`, (frame, req) => {
        if (frame.event === 'event' && frame.data.sequence === 2) {
          req.destroy()
          resolve(frame.data)
        }
        if (frame.event === 'error') reject(new Error(frame.data.message))
      }).catch(reject)
    })
    await waitForSubscriberCount(events, id, 1)

    // The worker has its own SessionStore and deliberately has no shared event
    // bus reference. The SSE durable cursor must still discover the append.
    await workerStore.append(id, { type: 'provider.turn', ts: Date.now(), data: { source: 'worker-process' } })
    const event = await Promise.race([
      received,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cross-process durable event was not tailed')), 3500)),
    ])
    assert.equal(event.kind, 'session.provider.updated')
    assert.equal(event.payload.source, 'worker-process')
  } finally {
    if (server) {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    }
    await waitForSubscriberCount(events, id, 0)
    assert.equal(events.subscriberCount(), 0)
    await rm(root, { recursive: true, force: true })
  }
})

test('14F SSE explicitly signals transient live-buffer overflow for client reconciliation', async () => {
  const root = await tempRoot()
  const { SessionEventBus } = await import('../dist/session/event-bus.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { toLiveEventEnvelope } = await import('../dist/protocol/session-events.js')
  const { startServer } = await import('../dist/server/http.js')
  const events = new SessionEventBus()
  const store = new SessionStore(path.join(root, 'sessions'), events)
  const id = 'live-overflow-session'
  let server
  try {
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id, cwd: root } })
    server = await startServer(fakeRuntime(store, events, root), { host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${server.address().port}`
    const gapReceived = new Promise((resolve, reject) => {
      openEventStream(base, `/api/v1/sessions/${id}/events/stream?after=1`, (frame, req) => {
        if (frame.event === 'gap') {
          req.destroy()
          resolve(frame.data)
        }
        if (frame.event === 'error') reject(new Error(frame.data.message))
      }).catch(reject)
    })
    await waitForSubscriberCount(events, id, 1)
    for (let i = 0; i < 140; i += 1) {
      const kind = i % 2 ? 'session.text.delta' : 'session.reasoning.delta'
      events.publishLive(toLiveEventEnvelope(id, `overflow-${i}`, kind, { streamId: `run-${i}`, delta: String(i) }))
    }
    const gap = await Promise.race([
      gapReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSE overflow gap was not delivered')), 2000)),
    ])
    assert.equal(gap.reason, 'live-buffer-overflow')
    assert.equal(gap.snapshotRequired, true)
    assert.equal(gap.currentSequence, 1)
  } finally {
    if (server) {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
    }
    await waitForSubscriberCount(events, id, 0)
    assert.equal(events.subscriberCount(), 0)
    await rm(root, { recursive: true, force: true })
  }
})

test('14B stream cursor ahead of durable state fails explicitly', async () => {
  const root = await tempRoot()
  const { SessionStore } = await import('../dist/session/store.js')
  const { SessionEventBus } = await import('../dist/session/event-bus.js')
  const { startServer } = await import('../dist/server/http.js')
  const events = new SessionEventBus()
  const store = new SessionStore(path.join(root, 'sessions'), events)
  const id = 'cursor-session'
  let server
  const closeServer = async () => {
    if (!server) return
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    server = undefined
  }
  try {
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id, cwd: root } })
    server = await startServer(fakeRuntime(store, events, root), { host: '127.0.0.1', port: 0 })
    const port = server.address().port
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/${id}/events/stream?after=99`)
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.match(text, /invalid-cursor/)
    assert.equal(events.subscriberCount(id), 0)
  } finally {
    await closeServer()
    await rm(root, { recursive: true, force: true })
  }
})
