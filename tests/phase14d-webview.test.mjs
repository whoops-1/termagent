import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionEventBus } from '../dist/session/event-bus.js'
import { SessionStore } from '../dist/session/store.js'
import { startServer } from '../dist/server/http.js'
import { TermAgentClient } from '../dist/client/client.js'
import { toLiveEventEnvelope } from '../dist/protocol/session-events.js'

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'termagent-phase14d-'))
}

function fakeRuntime(store, events, cwd) {
  return {
    cwd,
    cfg: { maxOutputBytes: 100000, providers: {}, routing: {}, smartRouting: {} },
    store,
    events,
    tasks: { history: async () => [], list: async () => [], get: async () => undefined },
    mcp: { clients: [] },
    customCommands: [], customAgents: [], skills: [],
    registry: { list: () => [] },
    getProvider: () => ({ id: 'test', model: 'test-model' }),
    isRunning: () => false,
    contextSnapshot: async (sessionId) => ({ sessionId, tokens: 0, limit: 12000, remaining: 12000, utilization: 0 }),
    async runPrompt(sessionId, _messages, prompt, options = {}) {
      const streamId = `test-run-${Date.now()}`
      events.publishLive(toLiveEventEnvelope(sessionId, `${streamId}-start`, 'runtime.status.changed', { streamId, state: 'working', phase: 'started', startedAt: Date.now() }))
      options.onStatus?.('Preparing workspace context')
      options.onStatus?.('Thinking')
      options.onReasoning?.('Checking the requested context.')
      options.onTool?.('read_file', { path: 'src/example.ts' }, 'test-call')
      options.onToolResult?.('read_file', 'Read src/example.ts', { toolLifecycle: { callId: 'test-call', state: 'completed' } })
      await store.appendMessage(sessionId, { role: 'user', content: prompt })
      events.publishLive(toLiveEventEnvelope(sessionId, `${streamId}-delta`, 'session.text.delta', { streamId, delta: 'Verified in the Web View stream.' }))
      options.onText?.('Verified in the Web View stream.')
      await store.appendMessage(sessionId, { role: 'assistant', content: 'Verified in the Web View stream.' })
      events.publishLive(toLiveEventEnvelope(sessionId, `${streamId}-end`, 'runtime.status.changed', { streamId, state: 'idle', phase: 'completed', endedAt: Date.now() }))
      return 'Verified in the Web View stream.'
    },
  }
}

async function startFixture({ token = 'web-secret' } = {}) {
  const root = await tempRoot()
  const events = new SessionEventBus()
  const store = new SessionStore(path.join(root, 'sessions'), events)
  const sessionId = 'web-session'
  await store.append(sessionId, {
    type: 'meta', ts: Date.now(),
    data: { id: sessionId, cwd: root, model: 'test-model', created: Date.now(), updated: Date.now() },
  })
  const server = await startServer(fakeRuntime(store, events, root), { host: '127.0.0.1', port: 0, token })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return {
    root, events, store, server, baseUrl, token, sessionId,
    async close() {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(resolve))
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function waitForSubscriberCount(events, id, expected) {
  const deadline = Date.now() + 2000
  while (events.subscriberCount(id) !== expected) {
    if (Date.now() >= deadline) throw new Error(`Expected ${expected} subscribers, got ${events.subscriberCount(id)}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function nextWithTimeout(iterator, timeoutMs = 2000) {
  let timer
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for SSE frame')), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

test('14D serves the v4-based Web View shell and client modules without exposing API data', async () => {
  const fixture = await startFixture()
  try {
    const checks = [
      ['/', 'text/html', 'TermAgent · Web View'],
      ['/styles.css', 'text/css', '--bg'],
      ['/app.js', 'javascript', 'TermAgentClient'],
      ['/web-assets/client/client.js', 'javascript', 'streamEvents'],
      ['/web-assets/protocol/api.js', 'javascript', 'checkpointRestore'],
    ]
    for (const [pathname, type, marker] of checks) {
      const response = await fetch(new URL(pathname, fixture.baseUrl))
      const body = await response.text()
      assert.equal(response.status, 200, `${pathname} should be served`)
      assert.match(response.headers.get('content-type') || '', new RegExp(type, 'i'))
      assert.ok(body.includes(marker), `${pathname} should contain ${marker}`)
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.equal(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), true)
    }
    const response = await fetch(new URL('/', fixture.baseUrl))
    const html = await response.text()
    assert.match(html, /name="viewport"[^>]+viewport-fit=cover/)
    assert.match(html, /type="module" src="\.\/app\.js"/)
    assert.doesNotMatch(html, /web-secret/)
  } finally { await fixture.close() }
})

test('14D keeps API authentication enforced while public Web View assets load', async () => {
  const fixture = await startFixture({ token: 'protected-token' })
  try {
    const page = await fetch(new URL('/', fixture.baseUrl))
    assert.equal(page.status, 200)
    const unauth = await fetch(new URL('/health', fixture.baseUrl))
    assert.equal(unauth.status, 401)
    const unauthorizedApi = await fetch(new URL('/api/v1/sessions', fixture.baseUrl))
    assert.equal(unauthorizedApi.status, 401)
    const auth = { Authorization: 'Bearer protected-token' }
    const health = await fetch(new URL('/health', fixture.baseUrl), { headers: auth })
    assert.equal(health.status, 200)
    assert.equal((await health.json()).ok, true)
    const sessions = await fetch(new URL('/api/v1/sessions', fixture.baseUrl), { headers: auth })
    assert.equal(sessions.status, 200)
    assert.equal((await sessions.json()).sessions[0].id, fixture.sessionId)
  } finally { await fixture.close() }
})

test('14D browser SDK receives live events over the canonical authenticated SSE stream', async () => {
  const fixture = await startFixture()
  const abort = new AbortController()
  const client = new TermAgentClient({ baseUrl: fixture.baseUrl, token: fixture.token, clientId: 'webview-test' })
  const iterator = client.streamEvents(fixture.sessionId, await fixture.store.currentSequence(fixture.sessionId), {
    signal: abort.signal, reconnect: false,
  })[Symbol.asyncIterator]()
  try {
    const ready = await nextWithTimeout(iterator)
    assert.equal(ready.value.event, 'ready')
    await waitForSubscriberCount(fixture.events, fixture.sessionId, 1)
    fixture.events.publishLive(toLiveEventEnvelope(fixture.sessionId, 'web-live-test-1', 'session.text.delta', {
      streamId: 'run-test', delta: 'Web View is live',
    }))
    let received
    for (let i = 0; i < 4; i++) {
      const frame = await nextWithTimeout(iterator)
      if (frame.value?.event === 'live') { received = frame.value; break }
    }
    assert.ok(received, 'the client should receive a live frame')
    assert.equal(received.data.kind, 'session.text.delta')
    assert.equal(received.data.payload.delta, 'Web View is live')
    assert.equal(received.data.durable, false)
  } finally {
    abort.abort()
    await iterator.return().catch(() => {})
    await fixture.close()
  }
})


test('14F6 foreground prompt stream delivers status, reasoning, tool activity and final output', async () => {
  const fixture = await startFixture()
  const client = new TermAgentClient({ baseUrl: fixture.baseUrl, token: fixture.token, clientId: 'webview-live-prompt-test' })
  try {
    const frames = []
    for await (const frame of client.streamPrompt(fixture.sessionId, 'Show live prompt activity.', { mode: 'build' })) frames.push(frame)
    assert.equal(frames[0].event, 'status')
    assert.equal(frames[0].data.message, 'Preparing workspace context')
    assert.ok(frames.some(frame => frame.event === 'reasoning'))
    assert.ok(frames.some(frame => frame.event === 'tool_start' && frame.data.name === 'read_file'))
    assert.ok(frames.some(frame => frame.event === 'tool_end' && frame.data.name === 'read_file'))
    assert.ok(frames.some(frame => frame.event === 'text' && frame.data.delta === 'Verified in the Web View stream.'))
    assert.equal(frames.at(-1).event, 'done')
  } finally { await fixture.close() }
})

test('14D reconciles a browser prompt through durable history after live text arrives', async () => {
  const fixture = await startFixture()
  const abort = new AbortController()
  const client = new TermAgentClient({ baseUrl: fixture.baseUrl, token: fixture.token, clientId: 'webview-prompt-test' })
  const iterator = client.streamEvents(fixture.sessionId, await fixture.store.currentSequence(fixture.sessionId), {
    signal: abort.signal, reconnect: false,
  })[Symbol.asyncIterator]()
  try {
    const ready = await nextWithTimeout(iterator)
    assert.equal(ready.value.event, 'ready')
    await waitForSubscriberCount(fixture.events, fixture.sessionId, 1)
    const promptResult = client.prompt(fixture.sessionId, 'Please verify the live/durable handoff.', { mode: 'build' })
    let liveText
    for (let i = 0; i < 8; i++) {
      const frame = await nextWithTimeout(iterator)
      if (frame.value?.event === 'live' && frame.value.data?.kind === 'session.text.delta') {
        liveText = frame.value.data.payload.delta
        break
      }
    }
    assert.equal(liveText, 'Verified in the Web View stream.')
    const result = await promptResult
    assert.equal(result.text, 'Verified in the Web View stream.')
    const snapshot = await client.getSnapshot(fixture.sessionId)
    assert.equal(snapshot.state.messages.at(-2).role, 'user')
    assert.equal(snapshot.state.messages.at(-2).content, 'Please verify the live/durable handoff.')
    assert.equal(snapshot.state.messages.at(-1).content, 'Verified in the Web View stream.')
  } finally {
    abort.abort()
    await iterator.return().catch(() => {})
    await fixture.close()
  }
})

test('14D bounds and coalesces transient text while durable events remain the recovery cursor', async () => {
  const events = new SessionEventBus()
  const subscription = events.subscribe('coalesce-session')
  const waiting = subscription.waitForChange()
  events.publishLive(toLiveEventEnvelope('coalesce-session', 'delta-1', 'session.text.delta', { streamId: 'run-a', delta: 'Hello ' }))
  events.publishLive(toLiveEventEnvelope('coalesce-session', 'delta-2', 'session.text.delta', { streamId: 'run-a', delta: 'world' }))
  assert.equal(await waiting, true)
  const live = subscription.drainLive()
  assert.equal(live.length, 1)
  assert.equal(live[0].payload.delta, 'Hello world')
  assert.equal(live[0].sequence, null)
  subscription.close()
  assert.equal(events.subscriberCount(), 0)
})

test('14F event bus reports timed wakeups and explicit transient-buffer overflow', async () => {
  const events = new SessionEventBus()
  const subscription = events.subscribe('overflow-session')
  assert.equal(await subscription.waitForChange(10), false)

  for (let i = 0; i < 140; i += 1) {
    const kind = i % 2 ? 'session.text.delta' : 'session.reasoning.delta'
    events.publishLive(toLiveEventEnvelope('overflow-session', `live-${i}`, kind, {
      streamId: `run-${i}`, delta: `chunk-${i}`,
    }))
  }

  const drained = subscription.drainLiveWithGap()
  assert.equal(drained.events.length, 128)
  assert.equal(drained.overflowed, true)
  assert.equal(subscription.drainLiveWithGap().overflowed, false)

  const next = subscription.waitForChange(100)
  events.publishLive(toLiveEventEnvelope('overflow-session', 'after-gap', 'session.text.delta', { streamId: 'next', delta: 'ok' }))
  assert.equal(await next, true)
  subscription.close()
  assert.equal(events.subscriberCount(), 0)
})

test('14D reuses the supplied v4 visual foundation rather than creating a second theme', async () => {
  const prototypeCss = await readFile(new URL('../web/prototype/styles.css', import.meta.url), 'utf8')
  const productionCss = await readFile(new URL('../web/app/styles.css', import.meta.url), 'utf8')
  assert.ok(productionCss.startsWith(prototypeCss), 'production styles must retain the exact v4 stylesheet as their foundation')
  const prototypeHtml = await readFile(new URL('../web/prototype/index.html', import.meta.url), 'utf8')
  assert.match(prototypeHtml, /data-view="session"/)
  assert.match(prototypeHtml, /id="composer"/)
})
