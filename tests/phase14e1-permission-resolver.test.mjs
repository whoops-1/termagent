import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function savedEnv() {
  return {
    HOME: process.env.HOME,
    PROVIDER: process.env.TERMAGENT_PROVIDER,
    BASE: process.env.TERMAGENT_BASE_URL,
    KEY: process.env.TERMAGENT_API_KEY,
    MODEL: process.env.TERMAGENT_MODEL,
    APPROVALS: process.env.TERMAGENT_APPROVALS,
    TASK_ROOT: process.env.TERMAGENT_TASK_ROOT,
  }
}

function restoreEnv(old) {
  const mapping = {
    HOME: 'HOME',
    PROVIDER: 'TERMAGENT_PROVIDER',
    BASE: 'TERMAGENT_BASE_URL',
    KEY: 'TERMAGENT_API_KEY',
    MODEL: 'TERMAGENT_MODEL',
    APPROVALS: 'TERMAGENT_APPROVALS',
    TASK_ROOT: 'TERMAGENT_TASK_ROOT',
  }
  for (const [key, name] of Object.entries(mapping)) {
    if (old[key] === undefined) delete process.env[name]
    else process.env[name] = old[key]
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14e1-'))
  const home = await mkdtemp(path.join(os.tmpdir(), 'termagent-14e1-home-'))
  const old = savedEnv()
  let runtime
  let server
  let runtimeClosed = false
  try {
    await mkdir(path.join(root, '.termagent'), { recursive: true })
    await writeFile(path.join(root, '.termagent', 'config.json'), JSON.stringify({ approvals: 'ask', maxToolRounds: 4 }))
    process.env.HOME = home
    process.env.TERMAGENT_PROVIDER = 'openai-compatible'
    process.env.TERMAGENT_BASE_URL = 'http://127.0.0.1:1/v1'
    process.env.TERMAGENT_API_KEY = 'test'
    process.env.TERMAGENT_MODEL = 'phase14e1-test'
    process.env.TERMAGENT_APPROVALS = 'ask'
    process.env.TERMAGENT_TASK_ROOT = path.join(home, '.termagent', 'tasks')

    const { createRuntime } = await import('../dist/server/runtime.js')
    const { startServer } = await import('../dist/server/http.js')
    const { TermAgentClient } = await import('../dist/client/client.js')
    runtime = await createRuntime(root)
    server = await startServer(runtime, { host: '127.0.0.1', port: 0, token: 'phase14e1-secret' })
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    const client = new TermAgentClient({ baseUrl, token: 'phase14e1-secret', clientId: 'browser' })
    const session = await runtime.store.create(root, 'phase14e1-test')

    const cleanup = async () => {
      if (server) await new Promise(resolve => server.close(resolve))
      if (runtime && !runtimeClosed) { await runtime.close(); runtimeClosed = true }
      restoreEnv(old)
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
    const closeRuntime = async () => { if (runtime && !runtimeClosed) { await runtime.close(); runtimeClosed = true } }
    return { root, home, runtime, server, client, baseUrl, session, cleanup, closeRuntime, TermAgentClient }
  } catch (error) {
    if (server) await new Promise(resolve => server.close(resolve))
    if (runtime) await runtime.close()
    restoreEnv(old)
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

function addProbe(runtime, name = 'phase14e1_write_probe') {
  let executions = 0
  runtime.registry.add({
    name,
    description: 'Phase 14E.1 permission resolver test probe',
    risk: 'write',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    permission: { action: 'edit', resources: args => [args.path] },
    execute: async args => {
      executions += 1
      return { output: `executed:${args.path}` }
    },
  })
  return () => executions
}

function toolContext(root, sessionId, options = {}) {
  return {
    sessionID: sessionId,
    agent: 'build',
    cwd: root,
    abort: options.signal || new AbortController().signal,
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
  }
}

async function waitForPending(store, sessionId, count = 1, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pending = await store.pendingInteractions(sessionId)
    if (pending.length >= count) return pending
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${count} pending permission request(s)`)
}

test('14E.1 browser Allow resolves the original tool wait and survives browser reconnect', async () => {
  const f = await fixture()
  try {
    const executions = addProbe(f.runtime)
    f.runtime.registry.gate.askLegacy = async () => { throw new Error('stdin fallback must not be used by the server runtime') }
    const running = f.runtime.registry.execute('phase14e1_write_probe', { path: 'src/reconnected.ts' }, toolContext(f.root, f.session.id, { toolCallId: 'tool-call-reconnect' }))
    const [pending] = await waitForPending(f.runtime.store, f.session.id)

    const { TermAgentClient } = await import('../dist/client/client.js')
    const reconnectedClient = new TermAgentClient({ baseUrl: f.baseUrl, token: 'phase14e1-secret', clientId: 'browser-reconnected' })
    const restored = await reconnectedClient.listPermissions(f.session.id)
    assert.equal(restored.length, 1)
    assert.equal(restored[0].requestId, pending.requestId)
    assert.equal(restored[0].toolCallId, 'tool-call-reconnect')
    assert.equal(restored[0].status, 'pending')

    const reply = await reconnectedClient.resolvePermission(f.session.id, pending.requestId, 'once', { commandId: 'browser-reconnect-allow' })
    assert.equal(reply.receipt.status, 'accepted')
    assert.equal(reply.result.applied, true)
    assert.deepEqual(await running, { output: 'executed:src/reconnected.ts' })
    assert.equal(executions(), 1)

    const finalState = await f.runtime.store.getInteractionState(f.session.id, pending.requestId)
    assert.equal(finalState.status, 'resolved')
    assert.equal(finalState.resolution.decision, 'once')
    assert.equal(finalState.resolution.clientId, 'browser-reconnected')
    const duplicate = await reconnectedClient.resolvePermission(f.session.id, pending.requestId, 'once', { commandId: 'browser-reconnect-allow' })
    assert.equal(duplicate.receipt.status, 'duplicate')
  } finally {
    await f.cleanup()
  }
})

test('14E.1 browser Deny rejects the original tool wait without executing the tool', async () => {
  const f = await fixture()
  try {
    const executions = addProbe(f.runtime)
    const running = f.runtime.registry.execute('phase14e1_write_probe', { path: 'src/denied.ts' }, toolContext(f.root, f.session.id, { toolCallId: 'tool-call-deny' }))
    const denied = assert.rejects(running, /Permission denied/)
    const [pending] = await waitForPending(f.runtime.store, f.session.id)
    const reply = await f.client.resolvePermission(f.session.id, pending.requestId, 'deny', { commandId: 'browser-deny' })
    assert.equal(reply.result.applied, true)
    await denied
    assert.equal(executions(), 0)
    const state = await f.runtime.store.getInteractionState(f.session.id, pending.requestId)
    assert.equal(state.status, 'resolved')
    assert.equal(state.resolution.decision, 'deny')
  } finally {
    await f.cleanup()
  }
})

test('14E.1 terminal and browser race through one first-writer-wins decision', async () => {
  const f = await fixture()
  try {
    const executions = addProbe(f.runtime)
    const running = f.runtime.registry.execute('phase14e1_write_probe', { path: 'src/race.ts' }, toolContext(f.root, f.session.id, { toolCallId: 'tool-call-race' })).then(
      value => ({ status: 'resolved', value }),
      error => ({ status: 'rejected', error }),
    )
    const [pending] = await waitForPending(f.runtime.store, f.session.id)
    const [browser, terminal] = await Promise.all([
      f.client.resolvePermission(f.session.id, pending.requestId, 'once', { commandId: 'browser-race-once' }),
      f.runtime.store.resolvePermission(f.session.id, pending.requestId, { commandId: 'terminal-race-deny', clientId: 'terminal', decision: 'deny' }),
    ])
    assert.equal(Number(browser.result.applied) + Number(terminal.applied), 1)

    const state = await f.runtime.store.getInteractionState(f.session.id, pending.requestId)
    assert.equal(state.status, 'resolved')
    if (state.resolution.decision === 'once') {
      assert.equal(state.resolution.clientId, 'browser')
      const outcome = await running
      assert.equal(outcome.status, 'resolved')
      assert.deepEqual(outcome.value, { output: 'executed:src/race.ts' })
      assert.equal(executions(), 1)
    } else {
      assert.equal(state.resolution.decision, 'deny')
      assert.equal(state.resolution.clientId, 'terminal')
      const outcome = await running
      assert.equal(outcome.status, 'rejected')
      assert.match(outcome.error.message, /Permission denied/)
      assert.equal(executions(), 0)
    }

    const stale = await f.runtime.store.resolvePermission(f.session.id, pending.requestId, { commandId: 'stale-resolution', clientId: 'late-client', decision: 'always' })
    assert.equal(stale.applied, false)
    assert.equal(stale.reason, 'already-resolved')
    const wrongSession = await f.runtime.store.create(f.root, 'wrong-session')
    await assert.rejects(
      f.runtime.store.resolvePermission(wrongSession.id, pending.requestId, { commandId: 'wrong-session-resolution', clientId: 'browser', decision: 'once' }),
      /Permission request not found/,
    )
  } finally {
    await f.cleanup()
  }
})

test('14E.1 Always is durably recorded and reused by the existing gate grant cache', async () => {
  const f = await fixture()
  try {
    const executions = addProbe(f.runtime)
    const first = f.runtime.registry.execute('phase14e1_write_probe', { path: 'src/always.ts' }, toolContext(f.root, f.session.id, { toolCallId: 'tool-call-always-1' }))
    const [pending] = await waitForPending(f.runtime.store, f.session.id)
    await f.client.resolvePermission(f.session.id, pending.requestId, 'always', { commandId: 'browser-always' })
    assert.deepEqual(await first, { output: 'executed:src/always.ts' })

    const second = await f.runtime.registry.execute('phase14e1_write_probe', { path: 'src/always.ts' }, toolContext(f.root, f.session.id, { toolCallId: 'tool-call-always-2' }))
    assert.deepEqual(second, { output: 'executed:src/always.ts' })
    assert.equal(executions(), 2)
    assert.equal((await f.runtime.store.pendingInteractions(f.session.id)).length, 0)
  } finally {
    await f.cleanup()
  }
})

test('14E.1 concurrent permission requests keep independent resolver identities', async () => {
  const f = await fixture()
  try {
    const executions = addProbe(f.runtime)
    // No provider toolCallId: request IDs must still be unique for concurrent calls.
    const first = f.runtime.registry.execute('phase14e1_write_probe', { path: 'src/concurrent.ts' }, toolContext(f.root, f.session.id))
    const second = f.runtime.registry.execute('phase14e1_write_probe', { path: 'src/concurrent.ts' }, toolContext(f.root, f.session.id))
    const pending = await waitForPending(f.runtime.store, f.session.id, 2)
    assert.notEqual(pending[0].requestId, pending[1].requestId)

    await Promise.all(pending.map((request, index) => f.client.resolvePermission(f.session.id, request.requestId, 'once', { commandId: `concurrent-${index}` })))
    const results = await Promise.all([first, second])
    assert.equal(results.length, 2)
    assert.equal(executions(), 2)
  } finally {
    await f.cleanup()
  }
})

test('14E.1 abort cancels the pending permission and prevents tool execution', async () => {
  const f = await fixture()
  try {
    const executions = addProbe(f.runtime)
    const controller = new AbortController()
    const running = f.runtime.registry.execute('phase14e1_write_probe', { path: 'src/aborted.ts' }, toolContext(f.root, f.session.id, { toolCallId: 'tool-call-abort', signal: controller.signal }))
    const [pending] = await waitForPending(f.runtime.store, f.session.id)
    controller.abort()
    await assert.rejects(running, /cancelled/i)
    assert.equal(executions(), 0)
    const state = await f.runtime.store.getInteractionState(f.session.id, pending.requestId)
    assert.equal(state.status, 'cancelled')
    assert.equal(state.cancelReason, 'interrupted')
    const stale = await f.client.resolvePermission(f.session.id, pending.requestId, 'once', { commandId: 'late-after-abort' })
    assert.equal(stale.result.applied, false)
    assert.equal(stale.result.request.status, 'cancelled')
  } finally {
    await f.cleanup()
  }
})

test('14E.1 graceful runtime shutdown cancels an in-flight permission and restart sees it settled', async () => {
  const f = await fixture()
  try {
    let executions = 0
    f.runtime.registry.add({
      name: 'phase14e1_shutdown_probe',
      description: 'Shutdown probe',
      risk: 'write',
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      permission: { action: 'edit', resources: args => [args.path] },
      execute: async () => { executions += 1; return { output: 'unexpected' } },
    })
    const provider = f.runtime.getProvider()
    provider.stream = async function* (_messages, _tools, signal) {
      if (signal.aborted) throw new Error('provider request interrupted')
      yield { type: 'tool_call', call: { id: 'shutdown-tool-call', type: 'function', function: { name: 'phase14e1_shutdown_probe', arguments: JSON.stringify({ path: 'shutdown.ts' }) } } }
      yield { type: 'done', finishReason: 'tool_calls' }
    }

    const running = f.runtime.runPrompt(f.session.id, [], 'run the shutdown test tool') .then(
      value => ({ status: 'resolved', value }),
      error => ({ status: 'rejected', error }),
    )
    const [pending] = await waitForPending(f.runtime.store, f.session.id)
    await f.closeRuntime()
    const outcome = await running
    assert.equal(outcome.status, 'rejected')
    assert.equal(f.runtime.isRunning(f.session.id), false)
    assert.equal(executions, 0)

    const cancelled = await f.runtime.store.getInteractionState(f.session.id, pending.requestId)
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.cancelReason, 'interrupted')

    const { createRuntime } = await import('../dist/server/runtime.js')
    const restarted = await createRuntime(f.root)
    try {
      const restored = await restarted.store.getInteractionState(f.session.id, pending.requestId)
      assert.equal(restored.status, 'cancelled')
      assert.equal((await restarted.store.pendingInteractions(f.session.id)).length, 0)
    } finally {
      await restarted.close()
    }
  } finally {
    await f.cleanup()
  }
})

test('14E.1 timeout is enforced and persisted as a permission cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14e1-timeout-'))
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const { SessionEventBus } = await import('../dist/session/event-bus.js')
    const { PermissionGate } = await import('../dist/tools/permissions.js')
    const { ToolRegistry } = await import('../dist/tools/registry.js')
    const events = new SessionEventBus()
    const store = new SessionStore(path.join(root, 'sessions'), events)
    const session = await store.create(root, 'timeout-test')
    const gate = new PermissionGate('ask', process.stdin, process.stdout, [], store)
    gate.setRequester(async request => await store.waitForInteractionResolution(request.sessionId, request.requestId, request.signal, 20))
    const registry = new ToolRegistry(gate)
    let executions = 0
    registry.add({
      name: 'phase14e1_timeout_probe',
      description: 'Timeout probe',
      risk: 'write',
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      permission: { action: 'edit', resources: args => [args.path] },
      execute: async () => { executions += 1; return { output: 'unexpected' } },
    })
    await assert.rejects(
      registry.execute('phase14e1_timeout_probe', { path: 'timeout.ts' }, toolContext(root, session.id, { toolCallId: 'timeout-tool-call' })),
      /Interaction request timed out/,
    )
    const [state] = (await store.interactionStates(session.id))
    assert.equal(state.status, 'cancelled')
    assert.equal(state.cancelReason, 'timeout')
    assert.equal(executions, 0)
    assert.equal(events.subscriberCount(session.id), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('14E.1 a durable reply wins an abort delivered in the same wakeup turn', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'termagent-14e1-reply-abort-race-'))
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const { SessionEventBus } = await import('../dist/session/event-bus.js')
    const events = new SessionEventBus()
    const store = new SessionStore(path.join(root, 'sessions'), events)
    const session = await store.create(root, 'race-test')
    await store.appendPermissionAsked(session.id, { requestId: 'permission-race', tool: 'write_file', action: 'edit', resources: ['race.ts'] })
    const controller = new AbortController()
    const waiting = store.waitForInteractionResolution(session.id, 'permission-race', controller.signal, 1000)
    await store.resolvePermission(session.id, 'permission-race', { commandId: 'reply-first', clientId: 'browser', decision: 'once' })
    controller.abort()
    const state = await waiting
    assert.equal(state.status, 'resolved')
    assert.equal(state.resolution.decision, 'once')
    assert.equal(events.subscriberCount(session.id), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
