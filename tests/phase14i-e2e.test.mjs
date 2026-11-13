// Stream T — Phase 14I item 870: end-to-end live visibility + mid-run
// disconnect/reconnect convergence for a long-running agent with two attached
// SSE subscribers (terminal-equivalent + browser-equivalent). Tests import
// dist/ directly; no build is performed here.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ENV_KEYS = [
  'HOME', 'TERMAGENT_SESSION_ROOT', 'TERMAGENT_SESSION_LOCK_TIMEOUT_MS',
  'TERMAGENT_PROVIDER', 'TERMAGENT_BASE_URL', 'TERMAGENT_API_KEY',
  'TERMAGENT_MODEL', 'TERMAGENT_APPROVALS', 'TERMAGENT_TASK_ROOT',
]

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

function openEventStream(base, pathname, onFrame) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, base), { headers: { accept: 'text/event-stream' } })
    req.on('error', (e) => { if (e?.code !== 'ECONNRESET') { /* swallow */ } })
    req.once('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error(`unexpected stream status ${res.statusCode}`)); return }
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
            try { onFrame({ event, data: JSON.parse(data.join('\n')) }, req) }
            catch { /* ignore parse errors */ }
          }
        }
      })
      res.on('error', (e) => { if (e?.code !== 'ECONNRESET') { /* swallow */ } })
    })
    req.end()
    resolve(req)
  })
}

async function waitForSubscriberCount(events, sessionId, expected) {
  const deadline = Date.now() + 5000
  while (events.subscriberCount(sessionId) !== expected) {
    if (Date.now() >= deadline) throw new Error(`subscriber count did not reach ${expected}; got ${events.subscriberCount(sessionId)}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

function durableSeqs(frames) { return frames.filter(f => f.event === 'event').map(f => f.data.sequence) }
function maxSeq(frames) { const s = durableSeqs(frames); return s.length ? Math.max(...s) : 0 }

function isToolTransition(frame) {
  if (frame.event === 'live') {
    const d = frame.data || {}
    if (d.kind === 'runtime.activity.changed' && (d.payload?.phase === 'started' || d.payload?.state === 'tool')) return true
    if (d.kind === 'session.tool.output.delta') return true
  }
  if (frame.event === 'event') {
    const d = frame.data || {}
    const kind = d.kind || ''
    if (kind === 'session.message.assistant' || kind === 'session.message.tool') {
      const msg = d.payload?.message || d.data?.message
      if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) return true
      if (kind === 'session.message.tool') return true
    }
    if (kind === 'session.provider.updated') return true
  }
  return false
}

async function fixture() {
  const previous = saveEnv()
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14i-e2e-home-'))
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14i-e2e-root-'))
  const sessionsRoot = path.join(home, '.termagent', 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  await mkdir(path.join(root, '.termagent'), { recursive: true })
  await writeFile(path.join(root, '.termagent', 'config.json'), JSON.stringify({ approvals: 'auto', maxToolRounds: 3 }))
  await writeFile(path.join(root, 'hello.txt'), 'hello world line 1\nline 2\n')
  process.env.HOME = home
  process.env.TERMAGENT_SESSION_ROOT = sessionsRoot
  process.env.TERMAGENT_PROVIDER = 'openai-compatible'
  process.env.TERMAGENT_BASE_URL = 'http://127.0.0.1:1/v1'
  process.env.TERMAGENT_API_KEY = 'test'
  process.env.TERMAGENT_MODEL = 'phase14i-e2e-stub'
  process.env.TERMAGENT_APPROVALS = 'auto'
  process.env.TERMAGENT_TASK_ROOT = path.join(home, '.termagent', 'tasks')
  delete process.env.TERMAGENT_SESSION_LOCK_TIMEOUT_MS
  const { createRuntime } = await import('../dist/server/runtime.js')
  const { startServer } = await import('../dist/server/http.js')
  const runtime = await createRuntime(root)
  const server = await startServer(runtime, { host: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${server.address().port}`
  // stub provider
  const provider = runtime.getProvider()
  provider.id = 'stub'
  let round = 0
  provider.stream = async function* () {
    if (round === 0) {
      round++
      yield { type: 'reasoning', delta: 'thinking about read' }
      yield { type: 'tool_call', call: { id: 'call-e2e-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) } } }
      await new Promise(r => setTimeout(r, 150))
      yield { type: 'done', finishReason: 'tool_calls' }
    } else {
      round++
      yield { type: 'text', delta: 'final answer after read' }
      await new Promise(r => setTimeout(r, 50))
      yield { type: 'done', finishReason: 'stop' }
    }
  }
  const session = await runtime.store.create(root, 'phase14i-e2e-stub')
  return {
    root, home, runtime, server, base, session, sessionsRoot,
    async close() {
      try { server.closeAllConnections?.() } catch {}
      try { await new Promise(r => server.close(r)) } catch {}
      try { await runtime.close() } catch {}
      restoreEnv(previous)
      await rmWithRetry(root)
      await rmWithRetry(home)
    },
  }
}

test('14I-T: long-running agent live visibility + mid-run disconnect/reconnect convergence', { timeout: 120000 }, async () => {
  const f = await fixture()
  try {
    const sessionId = f.session.id
    const events = f.runtime.events
    // subscriber A (never disconnected)
    const aFrames = []
    const aReqP = openEventStream(f.base, `/api/v1/sessions/${sessionId}/events/stream?after=0`, (frame) => aFrames.push(frame))
    const aReq = await aReqP
    // subscriber B (will disconnect mid-run)
    const bFrames = []
    const bReqP = openEventStream(f.base, `/api/v1/sessions/${sessionId}/events/stream?after=0`, (frame) => bFrames.push(frame))
    const bReq = await bReqP
    await waitForSubscriberCount(events, sessionId, 2)

    const runStatus = { done: false, finishedAt: 0, error: null }
    const toolTransition = { seenAt: 0 }
    // watcher for tool transition across both streams
    const watcher = (async () => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline && !runStatus.done) {
        const all = aFrames.concat(bFrames)
        if (!toolTransition.seenAt && all.some(isToolTransition)) {
          toolTransition.seenAt = Date.now()
        }
        if (toolTransition.seenAt) break
        await new Promise(r => setTimeout(r, 20))
      }
    })()

    const runPromise = f.runtime.runPrompt(sessionId, [], 'read the file and summarize', {
      onTool: () => {},
      onToolResult: () => {},
    }).then((res) => { runStatus.done = true; runStatus.finishedAt = Date.now(); return res })
      .catch((e) => { runStatus.done = true; runStatus.finishedAt = Date.now(); runStatus.error = e; throw e })

    // mid-run disconnect of subscriber B after it observes a tool transition
    const disconnectPromise = (async () => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline && !runStatus.done) {
        if (bFrames.some(isToolTransition)) break
        await new Promise(r => setTimeout(r, 20))
      }
      const lastAckB = maxSeq(bFrames)
      try { bReq.destroy() } catch {}
      await waitForSubscriberCount(events, sessionId, 1).catch(() => {})
      return lastAckB
    })()

    await Promise.all([runPromise, disconnectPromise, watcher])
    if (runStatus.error) throw runStatus.error

    // tool transition must have become visible before the run stopped
    assert.ok(toolTransition.seenAt > 0, 'a tool-call lifecycle transition must be visible while the run is active')
    assert.ok(toolTransition.seenAt <= runStatus.finishedAt, 'tool transition must appear before the agent stops')

    // last ack for B before disconnect
    const lastAckB = maxSeq(bFrames)

    // reconnect B from last acknowledged sequence
    const b2Frames = []
    let b2Req = null
    openEventStream(f.base, `/api/v1/sessions/${sessionId}/events/stream?after=${lastAckB}`, (frame, req) => {
      b2Frames.push(frame)
      if (!b2Req) b2Req = req
    }).catch(() => {})
    // allow replay + tail to arrive
    const replayDeadline = Date.now() + 3000
    while (Date.now() < replayDeadline) {
      await new Promise(r => setTimeout(r, 50))
      // stop early once B2 has reached the global max durable sequence
      const globalMax = maxSeq(aFrames)
      if (maxSeq(b2Frames) >= globalMax && globalMax > 0) {
        // give a little extra time for trailing frames
        await new Promise(r => setTimeout(r, 100))
        break
      }
    }
    if (b2Req) { try { b2Req.destroy() } catch {} }
    await waitForSubscriberCount(events, sessionId, 0).catch(() => {})

    // convergence: B combined durable sequences exactly equal A durable sequences
    const aSeqs = durableSeqs(aFrames)
    const bCombinedSeqs = durableSeqs(bFrames.concat(b2Frames))
    // dedupe by sequence
    const bUnique = [...new Set(bCombinedSeqs)]
    assert.deepEqual(bUnique.sort((x, y) => x - y), [...new Set(aSeqs)].sort((x, y) => x - y),
      'reconnected subscriber must converge to exactly the same durable sequences')

    // no duplicates
    assert.equal(bCombinedSeqs.length, bUnique.length, 'no duplicate durable sequences after reconnect')

    // A (never disconnected) shows same final durable state
    assert.ok(aSeqs.length > 0, 'subscriber A must have durable events')
    assert.equal(maxSeq(aFrames), maxSeq(bFrames.concat(b2Frames)), 'final durable cursor must match')

    // tool cards: count distinct call ids in assistant durable messages; must match
    function toolCallIds(frames) {
      const ids = new Set()
      for (const fr of frames.filter(f => f.event === 'event')) {
        const d = fr.data || {}
        const msg = d.payload?.message || d.data?.message
        if (msg && Array.isArray(msg.tool_calls)) for (const c of msg.tool_calls) if (c.id) ids.add(c.id)
      }
      return ids
    }
    const aIds = toolCallIds(aFrames)
    const bIds = toolCallIds(bFrames.concat(b2Frames))
    assert.deepEqual([...aIds].sort(), [...bIds].sort(), 'no missing/duplicate tool cards after reconnect')
    assert.ok(aIds.size >= 1, 'at least one tool call must be recorded')

    // cleanup reqs
    try { aReq.destroy() } catch {}
  } finally {
    await f.close()
  }
})
