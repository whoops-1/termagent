import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'termagent-p6-'))

async function makeCrypto(root, lines = 1372) {
  const content = Array.from({ length: lines }, (_, i) => `def generated_line_${i + 1}(): return ${JSON.stringify(`value-${i + 1}`)}`).join('\n') + '\n'
  await fs.writeFile(path.join(root, 'crypto.py'), content, 'utf8')
}

function providerToolCall(id, action) {
  return {
    type: 'tool_call',
    call: {
      id,
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify(action) },
    },
  }
}

test('13M-P6 telemetry records exploration efficiency counters', async () => {
  const { ExplorationTelemetry } = await import('../../dist/agent/exploration-telemetry.js')
  const telemetry = new ExplorationTelemetry()

  telemetry.recordCall({
    toolName: 'read_file',
    input: { path: '/repo/a.ts', startLine: 1, endLine: 10, probe: 1 },
    scope: { cwd: '/repo' },
    observation: {
      meaningful: true,
      reason: 'new read coverage',
      newFiles: ['/repo/a.ts'],
      newRanges: [{ startLine: 1, endLine: 10 }],
      newSymbols: [],
      newSearch: false,
      overlap: false,
    },
  })
  telemetry.recordCall({
    toolName: 'read_file',
    input: { path: '/repo/a.ts', startLine: 5, endLine: 15, probe: 2 },
    scope: { cwd: '/repo' },
    observation: {
      meaningful: true,
      reason: 'new read coverage',
      newFiles: [],
      newRanges: [{ startLine: 11, endLine: 15 }],
      newSymbols: [],
      newSearch: false,
      overlap: true,
    },
  })
  telemetry.recordCall({
    toolName: 'read_file',
    input: { path: '/repo/a.ts', startLine: 5, endLine: 15, probe: 3 },
    scope: { cwd: '/repo' },
    observation: {
      meaningful: false,
      reason: 'read produced no new coverage',
      newFiles: [],
      newRanges: [],
      newSymbols: [],
      newSearch: false,
      overlap: true,
    },
  })
  telemetry.recordCall({
    toolName: 'grep',
    input: { pattern: 'router', path: 'src' },
    scope: { cwd: '/repo' },
    observation: {
      meaningful: true,
      reason: 'new search evidence',
      newFiles: ['/repo/router.ts'],
      newRanges: [],
      newSymbols: [],
      newSearch: true,
      overlap: false,
    },
  })
  telemetry.recordCall({
    toolName: 'grep',
    input: { pattern: 'router', path: 'src' },
    scope: { cwd: '/repo' },
    observation: {
      meaningful: false,
      reason: 'search produced no new exploration evidence',
      newFiles: [],
      newRanges: [],
      newSymbols: [],
      newSearch: false,
      overlap: false,
    },
  })
  telemetry.recordRound({ meaningfulProgress: true })
  telemetry.recordRound({ meaningfulProgress: false })
  telemetry.setTerminationReason('semantic-no-progress')

  assert.deepEqual(telemetry.snapshot(), {
    toolCalls: 5,
    usefulCalls: 3,
    repeatedCalls: 2,
    overlappingCalls: 2,
    newFiles: 2,
    newRanges: 2,
    reconstructedEvidence: 0,
    searchNovelty: 1,
    novelSearchResults: 0,
    newSymbols: 0,
    settledVerificationFacts: 0,
    rounds: 2,
    noProgressRounds: 1,
    terminationReason: 'semantic-no-progress',
  })
})

test('13M-P6 reproduces the 33-call-shaped crypto.py reread workload and terminates on semantic no-progress', async () => {
  const root = await temp()
  try {
    const fixture = JSON.parse(await fs.readFile(path.join(process.cwd(), 'tests/fixtures/phase13m-p6-crypto-33-call.json'), 'utf8'))
    assert.equal(fixture.totalPotentialToolCalls, 33)

    await makeCrypto(root)
    const { Agent } = await import('../../dist/agent/agent.js')
    const { SessionStore } = await import('../../dist/session/store.js')
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')
    const { builtinTools } = await import('../../dist/tools/builtin.js')

    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, 'p6-crypto')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    builtinTools({ timeout: 5000, maxOutput: 100000 }).forEach(tool => registry.add(tool))

    class Provider {
      calls = 0
      async *stream(messages, schemas) {
        this.calls += 1
        if (!schemas.length) {
          yield { type: 'text', delta: 'exploration stopped after semantic no-progress detection' }
          yield { type: 'done', finishReason: 'stop' }
          return
        }
        const action = fixture.actions[this.calls - 1]
        if (!action) throw new Error(`fixture unexpectedly exhausted at provider call ${this.calls}`)
        yield providerToolCall(`crypto-${this.calls}`, action)
        yield { type: 'done', finishReason: 'tool_calls' }
      }
    }

    const provider = new Provider()
    let latestTelemetry
    let output = ''
    await new Agent(provider, registry, sessions, 0, 12000, 1).run({
      sessionId: session.id,
      messages: [],
      cwd: root,
      instructions: 'Explore crypto.py and understand its contents.',
      prompt: 'Explore crypto.py and understand its contents.',
      mode: 'explore',
      onText: value => { output += value },
      onExplorationTelemetry: snapshot => { latestTelemetry = snapshot },
    })

    assert.equal(provider.calls, 9)
    assert.equal(output, 'exploration stopped after semantic no-progress detection')
    assert.deepEqual(latestTelemetry, {
      toolCalls: 8,
      usefulCalls: 5,
      repeatedCalls: 3,
      overlappingCalls: 2,
      newFiles: 1,
      newRanges: 5,
      reconstructedEvidence: 0,
      searchNovelty: 0,
      novelSearchResults: 0,
      newSymbols: 0,
      settledVerificationFacts: 0,
      rounds: 8,
      noProgressRounds: 3,
      terminationReason: 'semantic-no-progress',
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13M-P6 legitimate long exploration is measured by semantic progress instead of a fixed call count', async () => {
  const root = await temp()
  try {
    await makeCrypto(root, 400)
    const { Agent } = await import('../../dist/agent/agent.js')
    const { SessionStore } = await import('../../dist/session/store.js')
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')
    const { builtinTools } = await import('../../dist/tools/builtin.js')

    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, 'p6-long')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    builtinTools({ timeout: 5000, maxOutput: 100000 }).forEach(tool => registry.add(tool))

    class Provider {
      calls = 0
      async *stream(messages, schemas) {
        this.calls += 1
        if (this.calls <= 40) {
          const startLine = (this.calls - 1) * 10 + 1
          yield providerToolCall(`long-${this.calls}`, { path: 'crypto.py', startLine, endLine: startLine + 9 })
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'legitimate long exploration complete' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }

    const provider = new Provider()
    let latestTelemetry
    let output = ''
    await new Agent(provider, registry, sessions, 0, 12000, 1).run({
      sessionId: session.id,
      messages: [],
      cwd: root,
      instructions: 'Inspect all ranges of crypto.py.',
      prompt: 'Inspect all ranges of crypto.py.',
      mode: 'explore',
      onText: value => { output += value },
      onExplorationTelemetry: snapshot => { latestTelemetry = snapshot },
    })

    assert.equal(provider.calls, 41)
    assert.equal(output, 'legitimate long exploration complete')
    assert.equal(latestTelemetry.toolCalls, 40)
    assert.equal(latestTelemetry.usefulCalls, 40)
    assert.equal(latestTelemetry.repeatedCalls, 0)
    assert.equal(latestTelemetry.newRanges, 40)
    assert.equal(latestTelemetry.noProgressRounds, 0)
    assert.equal(latestTelemetry.terminationReason, 'completed')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
