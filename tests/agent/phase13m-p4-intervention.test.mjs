import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'termagent-p4-'))

function action(pathName = '/repo/crypto.py') {
  return { toolName: 'read_file', input: { path: pathName, startLine: 1, endLine: 100, probe: Math.random() }, scope: { cwd: '/repo' } }
}

test('13M-P4 semantic intervention escalates nudge -> constrain -> stop', async () => {
  const { ToolLoopGuard } = await import('../../dist/agent/loop-guard.js')
  const guard = new ToolLoopGuard({
    semanticNudgeThreshold: 1,
    semanticConstrainThreshold: 2,
    semanticRepeatThreshold: 3,
  })
  const first = action()
  assert.equal(guard.observeNoProgressRound('same', false, [first]).intervention, 'nudge')
  const second = guard.observeNoProgressRound('same', false, [action()])
  assert.equal(second.intervention, 'constrain')
  assert.equal(second.blocked, false)

  const constrained = guard.check('read_file', { path: '/repo/crypto.py', startLine: 1, endLine: 100, probe: 99 }, { cwd: '/repo' })
  assert.equal(constrained.blocked, true)
  assert.equal(constrained.stop, false)
  assert.equal(constrained.intervention, 'constrain')
  assert.match(constrained.reason, /change tool|query\/path|read range/i)

  const stop = guard.observeNoProgressRound('same', false, [action()])
  assert.equal(stop.intervention, 'stop')
  assert.equal(stop.blocked, true)
  assert.equal(stop.stop, true)
})

test('13M-P4 meaningful progress clears semantic constraints', async () => {
  const { ToolLoopGuard } = await import('../../dist/agent/loop-guard.js')
  const guard = new ToolLoopGuard({ semanticRepeatThreshold: 3 })
  assert.equal(guard.observeNoProgressRound('same', false, [action()]).intervention, 'nudge')
  assert.equal(guard.observeNoProgressRound('same', false, [action()]).intervention, 'constrain')
  guard.observeNoProgressRound('changed', true, [action()])
  const check = guard.check('read_file', { path: '/repo/crypto.py', startLine: 1, endLine: 100, probe: 99 }, { cwd: '/repo' })
  assert.equal(check.blocked, false)
})

test('13M-P4 constrained exploration action still permits a genuinely different range or search', async () => {
  const { ToolLoopGuard } = await import('../../dist/agent/loop-guard.js')
  const guard = new ToolLoopGuard({ semanticRepeatThreshold: 3 })
  const first = action()
  guard.observeNoProgressRound('same', false, [first])
  guard.observeNoProgressRound('same', false, [action()])

  const differentRange = guard.check(
    'read_file',
    { path: '/repo/crypto.py', startLine: 101, endLine: 200, probe: 42 },
    { cwd: '/repo' },
  )
  assert.equal(differentRange.blocked, false)

  const differentSearch = guard.check(
    'grep',
    { pattern: 'differentNeedle', path: '/repo' },
    { cwd: '/repo' },
  )
  assert.equal(differentSearch.blocked, false)
})

test('13M-P4 semantic stop threshold is bounded for specialized agents', async () => {
  const { ToolLoopGuard } = await import('../../dist/agent/loop-guard.js')
  const guard = new ToolLoopGuard({ semanticRepeatThreshold: 1000 })
  let result
  for (let i = 0; i < 12; i++) result = guard.observeNoProgressRound('same', false, [action()])
  assert.equal(result?.count, 12)
  assert.equal(result?.intervention, 'stop')
  assert.equal(result?.stop, true)
})

test('13M-P4 Explore intervention notice is specific and bounded', async () => {
  const { explorationInterventionMessage } = await import('../../dist/agent/exploration-intervention.js')
  const snapshot = {
    version: 1,
    root: '/repo',
    discoveredFiles: ['/repo/crypto.py'],
    files: [{ canonicalPath: '/repo/crypto.py', mtimeMs: 1, size: 1000, totalLines: 1372, coveredRanges: [{ startLine: 1, endLine: 100 }], fullCoverage: false, readCount: 2, lastReadAt: 1 }],
    reads: [],
    searches: [],
    symbols: [],
    meaningfulProgressRevision: 1,
    lastProgress: 'read /repo/crypto.py covered 1-100',
    createdAt: 1,
  }
  const read = { toolName: 'read_file', input: { path: '/repo/crypto.py', startLine: 1, endLine: 100, probe: 7 }, scope: { cwd: '/repo' } }
  const nudge = explorationInterventionMessage('nudge', [read], snapshot, 1)
  assert.match(nudge, /repo_map|glob|grep|read_file/i)
  assert.match(nudge, /uncovered ranges/i)

  const constrain = explorationInterventionMessage('constrain', [read], snapshot, 2)
  assert.match(constrain, /redundant action is now constrained/i)
  assert.match(constrain, /Choose a different tool, query\/path, or uncovered range/i)

  const stop = explorationInterventionMessage('stop', [read], snapshot, 3)
  assert.match(stop, /EXPLORATION SUBTASK STOPPED/i)
  assert.match(stop, /1 discovered file/i)
  assert.ok(stop.length < 1600)
})

test('13M-P4 agent delivers nudge, constrains redundant read, then stops with evidence', async () => {
  const root = await temp()
  try {
    const { SessionStore } = await import('../../dist/session/store.js')
    const { Agent } = await import('../../dist/agent/agent.js')
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')

    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, 'p4-agent')
    let executeCount = 0
    const registry = new ToolRegistry(new PermissionGate('auto'))
    registry.add({
      name: 'read_file',
      description: 'read',
      risk: 'read',
      schema: { type: 'object' },
      execute: async () => {
        executeCount += 1
        return {
          output: 'same evidence',
          metadata: {
            canonicalPath: path.join(root, 'crypto.py'),
            mtimeMs: 1,
            size: 1000,
            totalLines: 1372,
            readCoverage: {
              requestedRange: { startLine: 1, endLine: 100 },
              previouslyCovered: executeCount === 1 ? [] : [{ startLine: 1, endLine: 100 }],
              newlyCovered: executeCount === 1 ? [{ startLine: 1, endLine: 100 }] : [],
              returnedRanges: [{ startLine: 1, endLine: 100 }],
              resultingCoverage: [{ startLine: 1, endLine: 100 }],
            },
          },
        }
      },
    })

    class Provider {
      calls = 0
      notices = []
      async *stream(messages) {
        this.calls += 1
        this.notices.push(messages.filter(message => message.role === 'system').map(message => message.content).join('\n'))
        if (this.calls <= 4) {
          yield {
            type: 'tool_call',
            call: {
              id: `call-${this.calls}`,
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'crypto.py', startLine: 1, endLine: 100, probe: this.calls }) },
            },
          }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'stopped with evidence' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }

    const provider = new Provider()
    let status = ''
    const agent = new Agent(provider, registry, sessions, 0, 12000, 1, value => { status = value })
    let output = ''
    await agent.run({
      sessionId: session.id,
      messages: [],
      cwd: root,
      instructions: 'inspect crypto',
      prompt: 'inspect crypto',
      onText: value => { output += value },
    })

    assert.equal(executeCount, 3)
    assert.equal(provider.calls, 5)
    assert.match(provider.notices[2], /EXPLORATION STRATEGY NUDGE/i)
    assert.match(provider.notices[3], /EXPLORATION STRATEGY CONSTRAINT/i)
    assert.match(provider.notices[3], /uncovered range/i)
    assert.match(provider.notices[4], /EXPLORATION SUBTASK STOPPED/i)
    assert.match(provider.notices[4], /1 discovered file/i)
    assert.match(status, /loop guard: the agent repeated the same no-progress execution state 3 times/i)
    assert.equal(output, 'stopped with evidence')

    const persisted = await sessions.load(session.id)
    assert.equal(
      persisted.messages.some(message => typeof message.content === 'string' && /EXPLORATION STRATEGY|EXPLORATION SUBTASK STOPPED/i.test(message.content)),
      false,
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
