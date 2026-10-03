import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'termagent-13m-hardening-'))

function toolCall(id, action) {
  return {
    type: 'tool_call',
    call: {
      id,
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify(action) },
    },
  }
}

function longLine(index) {
  const suffix = String(index).padStart(4, '0')
  return `x${suffix} = "termagent-exploration-line-${suffix}-payload"` // 51-ish bytes before the newline
}

async function makeCrypto(root, lines = 1372) {
  const content = Array.from({ length: lines }, (_, i) => longLine(i + 1)).join('\n') + '\n'
  await fs.writeFile(path.join(root, 'crypto.py'), content, 'utf8')
  await fs.writeFile(path.join(root, 'bot_data.json'), '{"status":"ok"}\n', 'utf8')
}

test('13M hardening: semantic fingerprints ignore durable lifecycle churn', async () => {
  const { ExplorationState } = await import('../../dist/context/exploration.js')
  const { semanticProgressFingerprint } = await import('../../dist/agent/progress.js')
  const exploration = new ExplorationState('/repo')
  exploration.observeTool('read_file', { path: 'crypto.py', startLine: 1, endLine: 100 }, {
    canonicalPath: '/repo/crypto.py',
    mtimeMs: 1,
    size: 1000,
    totalLines: 1372,
    returnedRanges: [{ startLine: 1, endLine: 100 }],
  })
  const state = exploration.snapshot()
  const base = { exploration: state, todos: [], mutations: [], workflow: undefined }
  const one = semanticProgressFingerprint({
    ...base,
    toolLifecycle: [{ callId: 'a', turnId: 't1', name: 'read_file', state: 'completed', outcome: 'success', arguments: { path: 'crypto.py' }, outputReference: 'tool-output://one', startedAt: 1, endedAt: 2 }],
  })
  const two = semanticProgressFingerprint({
    ...base,
    toolLifecycle: [{ callId: 'b', turnId: 't9', name: 'read_file', state: 'completed', outcome: 'success', arguments: { path: 'crypto.py' }, outputReference: 'tool-output://two', startedAt: 900, endedAt: 1000 }],
  })
  assert.equal(one, two)
})

test('13M hardening: incomplete version metadata cannot erase known read coverage', async () => {
  const { ExplorationState } = await import('../../dist/context/exploration.js')
  const exploration = new ExplorationState('/repo')
  exploration.observeTool('read_file', { path: 'crypto.py', startLine: 1, endLine: 100 }, {
    canonicalPath: '/repo/crypto.py',
    mtimeMs: 1,
    size: 1000,
    totalLines: 1372,
    returnedRanges: [{ startLine: 1, endLine: 100 }],
  })
  const repeat = exploration.observeTool('read_file', { path: 'crypto.py', startLine: 1, endLine: 100 }, {
    canonicalPath: '/repo/crypto.py',
    requestedRange: { startLine: 1, endLine: 100 },
  })
  assert.equal(repeat.meaningful, false)
  assert.deepEqual(repeat.newRanges, [])
  assert.deepEqual(exploration.snapshot().files[0].coveredRanges, [{ startLine: 1, endLine: 100 }])
})

test('13M hardening: Build-mode read sequence terminates semantically before historical exhaustion', async () => {
  const root = await temp()
  try {
    const fixture = JSON.parse(await fs.readFile(path.join(process.cwd(), 'tests/fixtures/phase13m-build-mode-read-sequence.json'), 'utf8'))
    await makeCrypto(root)
    const { Agent } = await import('../../dist/agent/agent.js')
    const { SessionStore } = await import('../../dist/session/store.js')
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')
    const { builtinTools } = await import('../../dist/tools/builtin.js')
    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, 'build-regression')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    builtinTools({ timeout: 5000, maxOutput: 100000 }).forEach(tool => registry.add(tool))

    class Provider {
      calls = 0
      async *stream(messages, schemas) {
        this.calls += 1
        if (!schemas.length) {
          yield { type: 'text', delta: 'Build-mode exploration stopped safely.' }
          yield { type: 'done', finishReason: 'stop' }
          return
        }
        const action = fixture.actions[this.calls - 1]
        if (!action) throw new Error(`fixture unexpectedly exhausted at provider call ${this.calls}`)
        yield toolCall(`build-${this.calls}`, action)
        yield { type: 'done', finishReason: 'tool_calls' }
      }
    }

    const provider = new Provider()
    let telemetry
    await new Agent(provider, registry, sessions, 0, 6000, 1).run({
      sessionId: session.id,
      messages: [],
      cwd: root,
      instructions: 'explore the codebase and give full summary',
      prompt: 'explore the codebase and give full summary',
      mode: 'build',
      onExplorationTelemetry: snapshot => { telemetry = snapshot },
    })

    assert.ok(provider.calls < fixture.historicalPotentialToolCalls, `provider reached ${provider.calls} calls from a ${fixture.historicalPotentialToolCalls}-call historical workload`)
    assert.equal(telemetry.terminationReason, 'semantic-no-progress')
    assert.ok(telemetry.noProgressRounds >= 3)
    assert.ok(telemetry.newRanges > 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13M hardening: exploration coverage survives forced compaction and a fresh Agent restore', async () => {
  const root = await temp()
  try {
    await fs.writeFile(path.join(root, 'crypto.py'), Array.from({ length: 800 }, (_, i) => `line-${i + 1} ${'x'.repeat(180)}`).join('\n') + '\n', 'utf8')
    const { Agent } = await import('../../dist/agent/agent.js')
    const { SessionStore } = await import('../../dist/session/store.js')
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')
    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, 'restore-regression')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    let executions = 0
    registry.add({
      name: 'read_file',
      description: 'Read a text file.',
      risk: 'read',
      schema: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path'] },
      execute: async args => {
        executions += 1
        return {
          output: `crypto evidence ${executions} ${'y'.repeat(18000)}`,
          metadata: {
            canonicalPath: path.join(root, 'crypto.py'),
            mtimeMs: 1,
            size: 160000,
            totalLines: 800,
            returnedRanges: [{ startLine: Number(args.startLine ?? 1), endLine: Number(args.endLine ?? 100) }],
            requestedRange: { startLine: Number(args.startLine ?? 1), endLine: Number(args.endLine ?? 100) },
          },
        }
      },
    })

    class FirstProvider {
      calls = 0
      config = { maxTokens: 0 }
      async *stream(messages, schemas) {
        this.calls += 1
        if (this.calls <= 8) {
          const startLine = (this.calls - 1) * 100 + 1
          yield { type: 'text', delta: 'context filler '.repeat(500) }
          yield toolCall(`first-${this.calls}`, { path: 'crypto.py', startLine, endLine: startLine + 99 })
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'initial exploration complete' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }

    const first = new FirstProvider()
    await new Agent(first, registry, sessions, 0, 4000, 1, undefined, [], { threshold: 0.5, reserveTokens: 128, recentTokens: 256 }).run({
      sessionId: session.id,
      messages: [],
      cwd: root,
      instructions: 'inspect crypto.py',
      prompt: 'inspect crypto.py',
      mode: 'explore',
    })

    const savedEvents = await sessions.load(session.id)
    assert.ok(savedEvents.events.some(event => event.type === 'compaction'), 'expected forced context compaction')
    const checkpoint = await sessions.latestContextCheckpoint(session.id)
    assert.deepEqual(checkpoint?.machineState?.exploration?.files?.[0]?.coveredRanges, [{ startLine: 1, endLine: 800 }])

    class RestoreProvider {
      calls = 0
      config = { maxTokens: 0 }
      async *stream(messages, schemas) {
        this.calls += 1
        if (this.calls === 1) {
          yield toolCall('restore-1', { path: 'crypto.py', startLine: 1, endLine: 100, probe: 1 })
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'restored coverage remained authoritative' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }

    const restored = new RestoreProvider()
    let telemetry
    await new Agent(restored, registry, sessions, 0, 4000, 1, undefined, [], { threshold: 0.5, reserveTokens: 128, recentTokens: 256 }).run({
      sessionId: session.id,
      messages: [],
      cwd: root,
      instructions: 'recheck crypto.py',
      prompt: 'recheck crypto.py',
      mode: 'explore',
      onExplorationTelemetry: snapshot => { telemetry = snapshot },
    })
    assert.equal(restored.calls, 2)
    assert.equal(telemetry.toolCalls, 1)
    assert.equal(telemetry.usefulCalls, 0)
    assert.equal(telemetry.newRanges, 0)
    assert.equal(telemetry.noProgressRounds, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
