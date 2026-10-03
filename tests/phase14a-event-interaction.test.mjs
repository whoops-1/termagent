import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

async function tempRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-phase14a-'))
}

function command(sessionId, clientId, commandId, payload = {}) {
  return {
    version: 1,
    sessionId,
    clientId,
    commandId,
    issuedAt: Date.now(),
    kind: 'session.prompt',
    payload,
  }
}

async function runChild(root, sessionId, count) {
  const source = `
    import { SessionStore } from ${JSON.stringify(path.resolve(process.cwd(), 'dist/session/store.js'))}
    const store = new SessionStore(${JSON.stringify(root)})
    for (let i = 0; i < ${count}; i++) await store.append(${JSON.stringify(sessionId)}, { type: 'meta', ts: Date.now(), data: { child: process.pid, i } })
  `
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)))
  })
}

test('14A SessionStore assigns durable sequences monotonically under concurrent appends', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(root)
    const session = 'sequence-session'
    await store.append(session, { type: 'meta', ts: Date.now(), data: { session } })
    await Promise.all(Array.from({ length: 24 }, (_, i) => store.append(session, { type: 'provider.turn', ts: Date.now(), data: { i } })))
    const loaded = await store.load(session)
    const sequences = loaded.events.map(event => event.sequence)
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, i) => i + 1))
    assert.equal(await store.currentSequence(session), sequences.length)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14A durable sequence remains gap-free across two Node processes sharing one session file', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(root)
    const session = 'cross-process-session'
    await store.append(session, { type: 'meta', ts: Date.now(), data: { session } })
    await Promise.all([runChild(root, session, 8), runChild(root, session, 8)])
    const loaded = await store.load(session)
    const sequences = loaded.events.map(event => event.sequence)
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, i) => i + 1))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14A public durable event envelopes classify legacy events without using array offsets', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const { validateEventEnvelope } = await import('../dist/protocol/validation.js')
    const store = new SessionStore(root)
    const id = 'envelope-session'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    await store.append(id, { type: 'message', ts: Date.now(), data: { role: 'user', content: 'hello' } })
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { status: 'started' } })
    const page = await store.durableEvents(id, 0, 100)
    assert.equal(page.events.length, 3)
    for (const event of page.events) validateEventEnvelope(event)
    assert.deepEqual(page.events.map(event => event.sequence), [1, 2, 3])
    assert.deepEqual(page.events.map(event => event.kind), ['session.created', 'session.message.user', 'session.provider.updated'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14A command ledger makes duplicate delivery deterministic and rejects key reuse with different semantics', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const { CommandLedger } = await import('../dist/interaction/ledger.js')
    const store = new SessionStore(root)
    const id = 'command-session'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    const ledger = new CommandLedger(store)
    let executions = 0
    const first = await ledger.execute(command(id, 'web', 'cmd-1', { text: 'hello' }), async () => {
      executions += 1
      await store.appendMessage(id, { role: 'user', content: 'hello' })
      return { result: 'accepted' }
    })
    const duplicate = await ledger.execute(command(id, 'web', 'cmd-1', { text: 'hello' }), async () => {
      executions += 1
      return { result: 'should-not-run' }
    })
    const conflict = await ledger.execute(command(id, 'web', 'cmd-1', { text: 'different' }), async () => {
      executions += 1
      return { result: 'should-not-run' }
    })
    assert.equal(first.receipt.status, 'accepted')
    assert.equal(duplicate.receipt.status, 'duplicate')
    assert.equal(conflict.receipt.status, 'rejected')
    assert.equal(conflict.receipt.reason, 'idempotency-conflict')
    assert.equal(executions, 1)
    const receipts = (await store.load(id)).events.filter(event => event.type === 'command.receipt')
    assert.equal(receipts.length, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14A stale command is admitted only against its exact expected sequence', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const { CommandLedger } = await import('../dist/interaction/ledger.js')
    const { durableSequence } = await import('../dist/protocol/types.js')
    const store = new SessionStore(root)
    const id = 'stale-session'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    const ledger = new CommandLedger(store)
    const expected = durableSequence(await store.currentSequence(id))
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { status: 'started' } })
    let executed = false
    const stale = await ledger.execute({ ...command(id, 'terminal', 'cmd-stale'), expectedSequence: expected }, async () => {
      executed = true
      return { result: 'unexpected' }
    })
    assert.equal(stale.receipt.status, 'stale')
    assert.equal(stale.receipt.reason, 'expected-sequence-mismatch')
    assert.equal(executed, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14A permission requests are reconstructible and first writer wins', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(root)
    const id = 'permission-session'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    await store.appendPermissionAsked(id, { requestId: 'perm-1', tool: 'write_file', action: 'edit', resources: ['a.ts'] })
    const pending = await store.pendingInteractions(id)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].status, 'pending')
    const first = await store.resolvePermission(id, 'perm-1', { commandId: 'web-command', clientId: 'web', decision: 'once' })
    const second = await store.resolvePermission(id, 'perm-1', { commandId: 'terminal-command', clientId: 'terminal', decision: 'deny' })
    assert.equal(first.applied, true)
    assert.equal(second.applied, false)
    assert.equal(second.reason, 'already-resolved')
    const restored = await store.getInteractionState(id, 'perm-1')
    assert.equal(restored.status, 'resolved')
    assert.equal(restored.resolution.clientId, 'web')
    assert.equal(restored.resolution.decision, 'once')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14A question requests survive restart and resolve deterministically', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(root)
    const id = 'question-session'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    await store.appendQuestionAsked(id, {
      requestId: 'q-1',
      questions: [{ id: 'q1', question: 'Which file?', options: [{ label: 'a.ts' }, { label: 'b.ts' }] }],
    })
    const restarted = new SessionStore(root)
    const pending = await restarted.pendingInteractions(id)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].kind, 'question')
    const resolved = await restarted.resolveQuestion(id, 'q-1', {
      commandId: 'terminal-command',
      clientId: 'terminal',
      disposition: 'replied',
      answers: [['a.ts']],
    })
    assert.equal(resolved.applied, true)
    const later = new SessionStore(root)
    const state = await later.getInteractionState(id, 'q-1')
    assert.equal(state.status, 'replied')
    assert.deepEqual(state.resolution.answers, [['a.ts']])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14A live-only event envelopes cannot advance durable sequence', async () => {
  const { validateEventEnvelope } = await import('../dist/protocol/validation.js')
  assert.throws(() => validateEventEnvelope({
    version: 1,
    eventId: 'live-1',
    sessionId: 's',
    sequence: 3,
    timestamp: Date.now(),
    category: 'message',
    kind: 'session.text.delta',
    durable: false,
    payload: { delta: 'x' },
  }), /Live-only events must not carry a durable sequence/)
  validateEventEnvelope({
    version: 1,
    eventId: 'live-1',
    sessionId: 's',
    sequence: null,
    timestamp: Date.now(),
    category: 'message',
    kind: 'session.text.delta',
    durable: false,
    payload: { delta: 'x' },
  })
})
test('14A live-event factory produces renderer-neutral transient frames with no durable cursor', async () => {
  const { toLiveEventEnvelope } = await import('../dist/protocol/session-events.js')
  const event = toLiveEventEnvelope('live-session', 'live-42', 'runtime.activity.changed', { state: 'thinking' }, 123)
  assert.deepEqual(event, {
    version: 1,
    eventId: 'live-42',
    sessionId: 'live-session',
    sequence: null,
    timestamp: 123,
    category: 'runtime',
    kind: 'runtime.activity.changed',
    durable: false,
    payload: { state: 'thinking' },
  })
})

test('14A SessionStore repairs an incomplete trailing JSONL write before assigning the next sequence', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(root)
    const id = 'partial-tail-session'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    const file = path.join(root, `${id}.jsonl`)
    await fs.appendFile(file, '{"type":"provider.turn","ts":1,"data":{"partial":true,"sequence":2')
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { recovered: true } })
    const loaded = await store.load(id)
    assert.deepEqual(loaded.events.map(event => event.sequence), [1, 2])
    assert.equal(loaded.events.at(-1).data.recovered, true)
    const page = await store.durableEvents(id, 0, 10)
    assert.deepEqual(page.events.map(event => event.sequence), [1, 2])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
test('14A newline-terminated corrupt trailing event is rejected instead of silently discarded', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(root)
    const id = 'corrupt-tail-session'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    const file = path.join(root, `${id}.jsonl`)
    await fs.appendFile(file, '{not-json}\n')
    await assert.rejects(() => store.append(id, { type: 'provider.turn', ts: Date.now(), data: { recovered: false } }), /Corrupt trailing session event/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14A sequence assignment remains monotonic when legacy records lack explicit sequences', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(root)
    const id = 'legacy-sequence-session'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    const file = path.join(root, `${id}.jsonl`)
    const legacy = JSON.stringify({ type: 'provider.turn', ts: Date.now(), data: { legacy: true } }) + '\n'
    await fs.appendFile(file, legacy)
    await store.append(id, { type: 'provider.turn', ts: Date.now(), data: { current: true } })
    const loaded = await store.load(id)
    assert.deepEqual(loaded.events.map(event => event.sequence), [1, 2, 3])
    assert.equal(await store.currentSequence(id), 3)
    const text = await fs.readFile(file, 'utf8')
    const lines = text.trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines.map(line => line.sequence), [1, undefined, 3])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14A CommandLedger prevents duplicate execution across Node processes', async () => {
  const root = await tempRoot()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const store = new SessionStore(root)
    const id = 'cross-process-command-session'
    await store.append(id, { type: 'meta', ts: Date.now(), data: { id } })
    const distStore = path.resolve(process.cwd(), 'dist/session/store.js')
    const distLedger = path.resolve(process.cwd(), 'dist/interaction/ledger.js')
    const source = `
      import { SessionStore } from ${JSON.stringify(distStore)}
      import { CommandLedger } from ${JSON.stringify(distLedger)}
      const store = new SessionStore(${JSON.stringify(root)})
      const ledger = new CommandLedger(store)
      const command = { version: 1, sessionId: ${JSON.stringify(id)}, clientId: 'web', commandId: 'same', issuedAt: Date.now(), kind: 'session.prompt', payload: { text: 'hello' } }
      const result = await ledger.execute(command, async () => {
        await new Promise(resolve => setTimeout(resolve, 25))
        await store.append(${JSON.stringify(id)}, { type: 'provider.turn', ts: Date.now(), data: { sideEffect: process.pid } })
        return { result: process.pid }
      })
      process.stdout.write(JSON.stringify(result.receipt.status))
    `
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `child exited ${code}`)))
    })
    const results = await Promise.all([run(), run()])
    assert.deepEqual(results.map(value => String(value).trim().replaceAll('\"', '')).sort(), ['accepted', 'duplicate'])
    const effects = (await store.load(id)).events.filter(event => event.type === 'provider.turn' && event.data?.sideEffect)
    assert.equal(effects.length, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
