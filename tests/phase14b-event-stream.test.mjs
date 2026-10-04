import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
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
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
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
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
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
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
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
