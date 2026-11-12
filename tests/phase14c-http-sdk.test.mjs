import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

function sseResponse(frames) {
  const body = frames.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('14C protocol route table and dependency-free client remain in lockstep', async () => {
  const { API_ROUTES } = await import('../dist/protocol/api.js')
  const { CLIENT_ROUTE_IDS } = await import('../dist/client/client.js')
  assert.equal(new Set(API_ROUTES.map(r => r.id)).size, API_ROUTES.length)
  assert.equal(new Set(API_ROUTES.map(r => `${r.method} ${r.path}`)).size, API_ROUTES.length)
  assert.deepEqual([...CLIENT_ROUTE_IDS].sort(), API_ROUTES.map(r => r.id).sort())

  const clientSource = await readFile(new URL('../src/client/client.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(clientSource, /from ['"]node:/)
  assert.doesNotMatch(clientSource, /EventSource/) // header-authenticated SSE must use fetch/readable streams
})

test('14C client applies bearer auth and merged headers to JSON and SSE requests', async () => {
  const calls = []
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/events/stream')) {
      return sseResponse([{ event: 'ready', data: { type: 'ready', version: 1, sessionId: 's', currentSequence: 0, replayAfter: 0, snapshotRequired: false } }])
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { TermAgentClient } = await import('../dist/client/client.js')
  const client = new TermAgentClient({ baseUrl: 'http://127.0.0.1:9999', token: 'secret', headers: { 'x-client': 'web' }, fetch: fakeFetch, clientId: 'client-1' })

  await client.info()
  const stream = client.streamEvents('s', 0, { reconnect: false })
  const first = await stream.next()
  await stream.return()

  assert.equal(first.value.event, 'ready')
  assert.equal(calls.length, 2)
  for (const call of calls) {
    const headers = new Headers(call.init.headers)
    assert.equal(headers.get('authorization'), 'Bearer secret')
    assert.equal(headers.get('x-client'), 'web')
    assert.ok(headers.get('accept'))
  }
})

test('14C browser default fetch retains its global receiver', async () => {
  const originalFetch = globalThis.fetch
  let receiver
  try {
    globalThis.fetch = function (url, init) {
      receiver = this
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    }
    const { TermAgentClient } = await import('../dist/client/client.js')
    const client = new TermAgentClient({ baseUrl: 'http://example.test' })
    await client.info()
    assert.equal(receiver, globalThis)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('14C client resumes durable SSE after a clean disconnect using the latest cursor', async () => {
  const calls = []
  const responses = [
    sseResponse([
      { event: 'ready', data: { type: 'ready', version: 1, sessionId: 's', currentSequence: 1, replayAfter: 0, snapshotRequired: false } },
      { event: 'event', data: { version: 1, eventId: 'e1', sessionId: 's', sequence: 1, timestamp: 1, category: 'session', kind: 'session.created', durable: true, payload: {} } },
    ]),
    sseResponse([
      { event: 'ready', data: { type: 'ready', version: 1, sessionId: 's', currentSequence: 2, replayAfter: 1, snapshotRequired: false } },
      { event: 'event', data: { version: 1, eventId: 'e2', sessionId: 's', sequence: 2, timestamp: 2, category: 'session', kind: 'session.updated', durable: true, payload: {} } },
    ]),
  ]
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected third reconnect')
    return next
  }
  const { TermAgentClient } = await import('../dist/client/client.js')
  const client = new TermAgentClient({ baseUrl: 'http://example.test', token: 'secret', fetch: fakeFetch })
  const seen = []
  for await (const frame of client.streamEvents('s', 0, { initialRetryDelayMs: 0, maxRetries: 2 })) {
    seen.push(frame)
    if (frame.event === 'event' && frame.data.sequence === 2) break
  }
  assert.deepEqual(seen.map(frame => frame.event), ['ready', 'event', 'ready', 'event'])
  assert.match(calls[0].url, /after=0$/)
  assert.match(calls[1].url, /after=1$/)
})

test('14C server exposes the stable runtime/session API through the dependency-free client', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { mkdir, writeFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const os = await import('node:os')
  const http = await import('node:http')
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase14c-'))
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-phase14c-home-'))
  const old = {
    HOME: process.env.HOME,
    PROVIDER: process.env.TERMAGENT_PROVIDER,
    BASE: process.env.TERMAGENT_BASE_URL,
    KEY: process.env.TERMAGENT_API_KEY,
    MODEL: process.env.TERMAGENT_MODEL,
    APPROVALS: process.env.TERMAGENT_APPROVALS,
    TASK_ROOT: process.env.TERMAGENT_TASK_ROOT,
  }
  let modelServer, server, runtime
  try {
    await mkdir(path.join(root, '.termagent'), { recursive: true })
    await writeFile(path.join(root, '.termagent', 'config.json'), JSON.stringify({ approvals: 'auto' }))
    modelServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\n`)
        res.end()
      })
    })
    await new Promise(resolve => modelServer.listen(0, resolve))
    const modelPort = modelServer.address().port
    process.env.HOME = home
    process.env.TERMAGENT_PROVIDER = 'openai-compatible'
    process.env.TERMAGENT_BASE_URL = `http://127.0.0.1:${modelPort}`
    process.env.TERMAGENT_API_KEY = 'test'
    process.env.TERMAGENT_MODEL = 'mock'
    process.env.TERMAGENT_APPROVALS = 'auto'
    process.env.TERMAGENT_TASK_ROOT = path.join(root, '.termagent', 'tasks')

    const { createRuntime } = await import('../dist/server/runtime.js')
    const { startServer } = await import('../dist/server/http.js')
    const { TermAgentClient } = await import('../dist/client/client.js')
    runtime = await createRuntime(root)
    server = await startServer(runtime, { host: '127.0.0.1', port: 0, token: 'secret' })
    const client = new TermAgentClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'secret', clientId: 'web-14c' })

    const info = await client.info()
    assert.equal(info.name, 'termagent')
    const session = await client.createSession()
    assert.equal(session.cwd, root)
    const history = await client.getHistory(session.id)
    assert.equal(history.meta.id, session.id)
    const messages = await client.getMessages(session.id)
    assert.equal(messages.messages.length, 0)
    const events = await client.getEvents(session.id, 0)
    assert.ok(Array.isArray(events.events))
    const status = await client.getSessionStatus(session.id)
    assert.equal(status.sessionId, session.id)
    await runtime.store.append(session.id, { type: 'provider.usage', ts: 1_800_000_000_000, data: {
      inputTokens: 125, contextTokens: 110, nonCachedInputTokens: 100, outputTokens: 10, totalTokens: 135,
      estimated: false, contextWindow: 200_000, contextSource: 'provider-profile', provider: 'anthropic', model: 'sonnet',
      cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 3, toolUsePromptTokens: 0, estimateInputTokens: 100, driftPercent: 9.1,
    } })
    const context = await client.getContext(session.id)
    assert.equal(context.usage.requests, 1, 'context API aggregates durable provider usage events')
    assert.equal(context.usage.totalTokens, 135, 'inclusive total does not add cache/reasoning breakdowns twice')
    assert.equal(context.usage.cacheReadTokens, 20)
    assert.deepEqual(context.usage.routes.map(route => [route.provider, route.model, route.requests]), [['anthropic', 'sonnet', 1]])
    const snapshot = await client.getSnapshot(session.id)
    assert.equal(snapshot.sessionId, session.id)
    assert.equal(snapshot.state.context.usage.requests, 1, 'initial snapshot and context endpoint share the usage projection')
    await runtime.store.appendPermissionAsked(session.id, { requestId: 'perm-http', tool: 'bash', action: 'run', resources: ['echo hi'] })
    await runtime.store.appendQuestionAsked(session.id, { requestId: 'question-http', questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] })
    const permissions = await client.listPermissions(session.id)
    assert.equal(permissions[0].requestId, 'perm-http')
    const questions = await client.listQuestions(session.id)
    assert.equal(questions[0].requestId, 'question-http')
    const permissionResolution = await client.resolvePermission(session.id, 'perm-http', 'once', { commandId: 'perm-cmd' })
    assert.equal(permissionResolution.receipt.status, 'accepted')
    const questionResolution = await client.answerQuestion(session.id, 'question-http', [['a']], { commandId: 'question-cmd' })
    assert.equal(questionResolution.receipt.status, 'accepted')
    assert.ok(Array.isArray(await client.getTodo(session.id)))
    assert.ok(Array.isArray(await client.getQueue(session.id)))
    assert.ok(Array.isArray((await client.listCheckpoints(session.id)).checkpoints))
    assert.ok(Array.isArray((await client.listTasks()).tasks))
    assert.ok(Array.isArray((await client.listTools()).tools))
    assert.ok(Array.isArray((await client.listModels()).profiles))
    assert.ok(Array.isArray((await client.listAgents()).builtin))
    assert.ok(Array.isArray((await client.listSkills()).skills))

    const queued = await client.enqueue(session.id, 'hello from web', { commandId: 'queue-cmd' })
    assert.equal(queued.receipt.status, 'accepted')
    const duplicateQueue = await client.enqueue(session.id, 'hello from web', { commandId: 'queue-cmd' })
    assert.equal(duplicateQueue.receipt.status, 'duplicate')
    const queue = await client.getQueue(session.id)
    assert.equal(queue.length, 1)
    assert.equal(queue[0].content, 'hello from web')

    const checkpoint = await client.createCheckpoint(session.id, '14C')
    assert.ok(checkpoint && checkpoint.id)
    const checkpoints = await client.listCheckpoints(session.id)
    assert.ok(checkpoints.checkpoints.some(item => item.id === checkpoint.id))

    const shellTask = await runtime.tasks.createShell('printf task-output', root, session.id)
    const listedTasks = await client.listTasks()
    assert.ok(listedTasks.tasks.some(item => item.id === shellTask.id))
    const fetchedTask = await client.getTask(shellTask.id)
    assert.equal(fetchedTask.id, shellTask.id)
    const taskEvents = await client.getTaskEvents(shellTask.id)
    assert.ok(Array.isArray(taskEvents))
    const taskOutput = await client.getTaskOutput(shellTask.id)
    assert.equal(taskOutput, '')
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    if (runtime) await runtime.close()
    if (modelServer) await new Promise(resolve => modelServer.close(resolve))
    for (const [key, value] of Object.entries(old)) {
      const envKey = { HOME: 'HOME', PROVIDER: 'TERMAGENT_PROVIDER', BASE: 'TERMAGENT_BASE_URL', KEY: 'TERMAGENT_API_KEY', MODEL: 'TERMAGENT_MODEL', APPROVALS: 'TERMAGENT_APPROVALS', TASK_ROOT: 'TERMAGENT_TASK_ROOT' }[key]
      if (value === undefined) delete process.env[envKey]
      else process.env[envKey] = value
    }
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})

test('14F6 event stream reports connection loss and recovery to its subscriber', async () => {
  const calls = []
  const responses = [
    sseResponse([{ event: 'ready', data: { type: 'ready', version: 1, sessionId: 's', currentSequence: 0, replayAfter: 0, snapshotRequired: false } }]),
    sseResponse([{ event: 'ready', data: { type: 'ready', version: 1, sessionId: 's', currentSequence: 0, replayAfter: 0, snapshotRequired: false } }]),
  ]
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const response = responses.shift()
    if (!response) throw new Error('unexpected reconnect')
    return response
  }
  const { TermAgentClient } = await import('../dist/client/client.js')
  const client = new TermAgentClient({ baseUrl: 'http://example.test', fetch: fakeFetch })
  const states = []
  const stream = client.streamEvents('s', 0, {
    initialRetryDelayMs: 0,
    maxRetries: 2,
    onConnectionState: (state, detail) => states.push({ state, detail }),
  })
  await stream.next() // First ready frame.
  await stream.next() // Second connection ready frame after the first clean EOF.
  await stream.return()

  assert.equal(calls.length, 2)
  assert.equal(states[0].state, 'connecting')
  assert.ok(states.some(item => item.state === 'connected'))
  assert.ok(states.some(item => item.state === 'reconnecting'))
  assert.equal(states.at(-1).state, 'closed')
})

test('14F6 SSE parser accepts CRLF frames split across transport chunks', async () => {
  const encoded = new TextEncoder()
  const pieces = [
    'event: re',
    'ady\r',
    '\ndata: {"type":"ready","replayAfter":0}\r',
    '\n\r',
    '\n',
  ]
  const body = new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoded.encode(piece))
      controller.close()
    },
  })
  const fakeFetch = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const { TermAgentClient } = await import('../dist/client/client.js')
  const client = new TermAgentClient({ baseUrl: 'http://example.test', fetch: fakeFetch })
  const frames = []
  for await (const frame of client.streamEvents('s', 0, { reconnect: false })) frames.push(frame)
  assert.deepEqual(frames, [{ event: 'ready', data: { type: 'ready', replayAfter: 0 } }])
})
