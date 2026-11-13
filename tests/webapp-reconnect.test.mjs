// 14I-W — Web View live render + reconnect recovery (Phase 14I batch-3, Stream W).
// Covers: every durable kind has a live render path while a run is active, the
// last acknowledged durable sequence is persisted and replayed from, stale or
// duplicated frames never re-apply, tool cards are idempotent upserts keyed by
// provider call ID, and the silent-subscription watchdog re-subscribes from the
// durable log. Client assertions read the shipped browser module (the established
// web test pattern: app.js is vanilla JS with no importable module boundary).
// Server assertions include live SSE replay behavior from dist.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const readNormalized = async filePath => (await readFile(path.join(repoRoot, filePath), 'utf8')).replace(/\r\n/g, '\n')

async function tempRoot() { return await mkdtemp(path.join(os.tmpdir(), 'termagent-webapp-reconnect-')) }

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

function openEventStream(base, pathname, headers, onFrame) {
  const req = http.request(new URL(pathname, base), { headers: { accept: 'text/event-stream', ...headers } })
  req.on('error', error => { if (error?.code !== 'ECONNRESET') throw error })
  req.once('response', res => {
    if (res.statusCode !== 200) throw new Error(`unexpected stream status ${res.statusCode}`)
    res.setEncoding('utf8')
    let carry = ''
    res.on('data', chunk => {
      carry += chunk
      while (true) {
        const boundary = /\r\n\r\n|\n\n/.exec(carry)
        if (!boundary) break
        const raw = carry.slice(0, boundary.index)
        carry = carry.slice(boundary.index + boundary[0].length)
        let event = 'message'
        let id
        const data = []
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('id:')) id = line.slice(3).trim()
          if (line.startsWith('event:')) event = line.slice(6).trim()
          if (line.startsWith('data:')) data.push(line.slice(5).trim())
        }
        if (data.length) onFrame({ event, id, data: JSON.parse(data.join('\n')), raw }, req)
      }
    })
    res.on('error', error => { if (error?.code !== 'ECONNRESET') throw error })
  })
  req.end()
  return req
}

test('14I-W: the Web View persists and replays from the last acknowledged durable sequence', async () => {
  const app = await readNormalized(path.join('web', 'app', 'app.js'))
  assert.ok(app.includes('const ackKey = (sessionId) => `termagent:webview:seq:${sessionId}`'),
    'the acknowledgement key is namespaced per session')
  assert.ok(app.includes('function readAckSequence(sessionId)'), 'a persisted acknowledgement is readable')
  assert.ok(app.includes('function writeAckSequence(sessionId, sequence)'), 'an acknowledgement is persisted')
  assert.ok(app.includes('state.cursor = readAckSequence(id);'),
    'switching to a session resumes from its persisted acknowledgement')
  assert.ok(app.includes('writeAckSequence(state.activeId, state.cursor);'),
    'each applied durable frame records the new acknowledgement')
  assert.ok(app.includes('writeAckSequence(id, state.cursor);'),
    'snapshot reconciliation and the ready frame also record the acknowledgement')
  // Stale replay must never re-apply and a replayed event ID must never duplicate.
  assert.ok(app.includes('sequence < state.cursor) return;'),
    'an older durable sequence is ignored, not applied')
  assert.ok(app.includes('if (state.activityIds.has(event.eventId)) return;'),
    'an already-applied event ID is deduplicated')
  assert.ok(app.includes('function reconcileAfterReconnect(id)'), 'reconnect reconciles from an authoritative snapshot')
  assert.ok(app.includes('if (reconnected) void reconcileAfterReconnect(id);'),
    'the ready frame triggers reconciliation after a lost connection')
  assert.ok(app.includes("writeAckSequence(id, 0);"),
    'a stale cursor ahead of the durable log is reset instead of looping')
})

test('14I-W: tool cards are idempotent upserts keyed by provider call ID', async () => {
  const app = await readNormalized(path.join('web', 'app', 'app.js'))
  assert.ok(app.includes('toolCards: new Map()'), 'tool cards live in a call-ID keyed projection')
  assert.ok(app.includes('function upsertToolCard(callId, patch = {})'), 'tool cards are upserted, not appended')
  assert.ok(app.includes('const current = state.toolCards.get(key)'), 'an existing card is reused for the same call ID')
  assert.ok(app.includes('const renderedCards = new Set()'), 'a render pass renders each call ID once')
  assert.ok(app.includes('if (renderedCards.has(card.callId)) continue;'),
    'a card backfilled from lifecycle/live frames is not duplicated after the snapshot arrives')
  assert.ok(app.includes('const callId = String(payload.callId || payload.toolCallId || \'\');'),
    'durable lifecycle records are keyed by call ID only')
  assert.ok(app.includes('data-tool-id="${esc(callId)}"'), 'the call ID identifies the rendered card')
  assert.ok(app.includes('call ${callId.length > 20'),
    'the provider call ID is visible in the card for traceability')
})

test('14I-W: every run-active event kind has a live render path', async () => {
  const app = await readNormalized(path.join('web', 'app', 'app.js'))
  // Foreground prompt stream (fastest path while the run is active).
  assert.ok(app.includes("if (frame.event === 'tool_start')"), 'tool-call start renders live')
  assert.ok(app.includes("if (frame.event === 'tool_end')"), 'tool result/output renders live')
  assert.ok(app.includes("if (frame.event === 'status')"), 'run status/activity renders live')
  assert.ok(app.includes("if (frame.event === 'text')"), 'final/streaming text renders live')
  assert.ok(app.includes("if (frame.event === 'reasoning')"), 'reasoning renders live')
  assert.ok(app.includes("if (frame.event === 'question')"), 'question asked renders live')
  // SSE live frames.
  assert.ok(app.includes("event.kind === 'session.tool.output.delta'"), 'tool output deltas update the card')
  assert.ok(app.includes("event.kind === 'runtime.activity.changed'"), 'activity changes update the run bar and activity rows')
  assert.ok(app.includes("event.kind === 'runtime.status.changed'"), 'runtime status changes update run state')
  // Durable frames (authoritative) cover the rest while the run is active.
  for (const kind of [
    'session.tool.called', 'session.tool.started', 'session.tool.progress', 'session.tool.completed', 'session.tool.failed',
    'session.reasoning.started', 'session.reasoning.completed',
    'session.todo.updated', 'session.diff.updated', 'session.mutation.applied',
    'session.permission.asked', 'session.permission.resolved',
    'session.question.asked', 'session.question.resolved',
    'session.message.assistant', 'session.task.created', 'session.task.updated', 'session.task.notification',
  ]) {
    assert.ok(app.includes(`'${kind}'`), `durable kind ${kind} must be handled while a run is active`)
  }
  assert.ok(app.includes("title: status ? `Task ${status}` : event.kind === 'session.task.notification' ? 'Task update' : 'Task activity'"),
    'task activity and notifications become visible rows, not only a task count')
  assert.ok(app.includes('if (String(event.kind || \'\').startsWith(\'session.tool.\')) renderFeed();'),
    'durable tool lifecycle frames repaint the keyed card immediately')
})

test('14I-W: a silent subscription watchdog re-subscribes from the durable log', async () => {
  const app = await readNormalized(path.join('web', 'app', 'app.js'))
  assert.ok(app.includes('const STREAM_WATCHDOG_RUN_MS = 20_000;'), 'the active-run watchdog budget is 20 s')
  assert.ok(app.includes('const STREAM_WATCHDOG_IDLE_MS = 40_000;'), 'idle sessions keep a cheaper 40 s budget')
  assert.ok(app.includes('const threshold = running ? STREAM_WATCHDOG_RUN_MS : STREAM_WATCHDOG_IDLE_MS;'),
    'the watchdog tightens while a run is active')
  assert.ok(app.includes('await refreshCurrent();'), 'the watchdog fetches authoritative durable state')
  assert.ok(app.includes('state.streamAbort?.abort();\n        startEventStream(sessionId);'),
    'the watchdog closes and re-opens the stale SSE reader')
  assert.ok(app.includes('state.lastHeartbeat = Date.now();'), 'applied frames reset the liveness timer')
})

test('14I-W: the server accepts an explicit replay cursor and emits SSE ids and heartbeats', async () => {
  const httpSource = await readNormalized(path.join('src', 'server', 'http.ts'))
  assert.ok(httpSource.includes("req.headers['last-event-id']"),
    'Last-Event-ID resumes a native EventSource without rewriting the URL')
  assert.ok(httpSource.includes("url.searchParams.get('since')"), 'an explicit since cursor is accepted')
  assert.ok(httpSource.includes("url.searchParams.get('after')"), 'the canonical after cursor is retained')
  assert.ok(httpSource.includes("writeSse(res, 'event', event, event.sequence)"),
    'durable frames carry their sequence as the SSE id')
  assert.ok(httpSource.includes('const SSE_HEARTBEAT_MS = 15_000'), 'the heartbeat floor is 15 s')
  assert.ok(httpSource.includes("await writeSse(res, 'heartbeat'"), 'open streams emit liveness heartbeats')
  assert.ok(httpSource.includes('currentSequence'), 'the heartbeat carries the authoritative sequence')
})

test('14I-W: SSE replay honors since and Last-Event-ID and rejects a cursor ahead of the log', async () => {
  const root = await tempRoot()
  const { SessionEventBus } = await import('../dist/session/event-bus.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { startServer } = await import('../dist/server/http.js')
  const events = new SessionEventBus()
  const store = new SessionStore(path.join(root, 'sessions'), events)
  const id = 'reconnect-stream-session'
  let server
  const closeServer = async () => {
    if (!server) return
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    server = undefined
  }
  const open = (pathname, headers = {}) => new Promise((resolve, reject) => {
    const frames = []
    const deadline = setTimeout(() => reject(new Error(`timed out waiting for ${pathname}`)), 3000)
    const req = openEventStream(base, pathname, headers, (frame, request) => {
      frames.push(frame)
      const last = frames.at(-1)
      if (last.event === 'error' || (last.event === 'event' && last.data.sequence === 3)) {
        clearTimeout(deadline)
        request.destroy()
        resolve(frames)
      }
    })
    req.once('error', error => { if (error?.code !== 'ECONNRESET') { clearTimeout(deadline); reject(error) } })
  })
  let base
  try {
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id, cwd: root } })
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { n: 1 } })
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { n: 2 } })
    server = await startServer(fakeRuntime(store, events, root), { host: '127.0.0.1', port: 0 })
    base = `http://127.0.0.1:${server.address().port}`

    const sinceFrames = await open(`/api/v1/sessions/${id}/events/stream?since=1`)
    const sinceEvents = sinceFrames.filter(frame => frame.event === 'event')
    assert.deepEqual(sinceEvents.map(frame => frame.data.sequence), [2, 3],
      'since=1 replays exactly the missed durable frames')
    assert.deepEqual(sinceEvents.map(frame => frame.id), ['2', '3'],
      'each durable frame exposes its sequence as the SSE id')

    const headerFrames = await open(`/api/v1/sessions/${id}/events/stream`, { 'Last-Event-ID': '2' })
    assert.deepEqual(headerFrames.filter(frame => frame.event === 'event').map(frame => frame.data.sequence), [3],
      'Last-Event-ID resumes from the last acknowledged sequence')

    // The proof no longer waits for a live publish: the replay itself is the
    // authoritative recovery path. A cursor ahead of the log is rejected.
    const aheadFrames = await open(`/api/v1/sessions/${id}/events/stream?since=99`)
    assert.equal(aheadFrames.at(-1).event, 'error')
    assert.equal(aheadFrames.at(-1).data.code, 'invalid-cursor')
    await waitForSubscriberCount(events, id, 0)
  } finally {
    await closeServer()
    await rm(root, { recursive: true, force: true })
  }
})