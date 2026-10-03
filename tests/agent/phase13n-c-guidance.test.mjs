import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function harness() {
  const { Agent } = await import('../../dist/agent/agent.js')
  const { SessionStore } = await import('../../dist/session/store.js')
  const { ToolRegistry } = await import('../../dist/tools/registry.js')
  const { PermissionGate } = await import('../../dist/tools/permissions.js')
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-13n-c-'))
  const store = new SessionStore(path.join(root, 'sessions'))
  const session = await store.create(root, 'mock')
  const registry = new ToolRegistry(new PermissionGate('auto'))
  return { Agent, store, session, registry, root }
}

test('13N-C guidance module adapts to evidence and no-progress state', async () => {
  const { renderExplorationGuidance } = await import('../../dist/agent/exploration-guidance.js')
  const guidance = renderExplorationGuidance({
    prompt: 'find all references to the session processor',
    availableTools: ['repo_map', 'grep', 'read_file'],
    state: {
      discoveredFiles: 12,
      coveredRanges: 4,
      searchObservations: 3,
      symbols: 5,
      verificationFacts: 1,
      progressRevision: 7,
      noProgressRounds: 2,
      lastProgress: 'grep discovered 2 new file(s)',
    },
  })
  assert.match(guidance, /grep → read_file/)
  assert.match(guidance, /12 discovered file\(s\)/)
  assert.match(guidance, /No-progress streak: 2 round\(s\)/)
  assert.match(guidance, /Latest evidence note: grep discovered 2 new file\(s\)/)
  assert.match(guidance, /Batch independent read\/search calls/)
  assert.match(guidance, /not a mandatory repo_map → glob → grep → read ceremony/)
})

test('13N-C production Agent injects guidance into the next provider request with live evidence', async () => {
  const { Agent, store, session, registry, root } = await harness()
  const seen = []
  registry.add({
    name: 'glob',
    description: 'discover files',
    risk: 'read',
    schema: { type: 'object' },
    execute: async () => ({ output: 'a.ts\nb.ts', metadata: { glob: { discoveredFiles: ['a.ts', 'b.ts'] } } }),
  })
  let calls = 0
  class Provider {
    async *stream(messages, schemas) {
      calls += 1
      seen.push(messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'))
      if (calls === 1) {
        yield { type: 'tool_call', call: { id: 'g1', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: 'src/*.ts' }) } } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      }
    }
  }

  const agent = new Agent(new Provider(), registry, store, 3)
  await agent.run({
    sessionId: session.id,
    messages: [],
    cwd: root,
    instructions: 'Explore the codebase and find relevant files.',
    prompt: 'find files matching src/*.ts',
    mode: 'explore',
  })

  assert.equal(calls, 2)
  assert.match(seen[0], /EXPLORATION GUIDANCE:/)
  assert.match(seen[0], /file-pattern oriented/)
  assert.match(seen[1], /Current evidence state:/)
  assert.match(seen[1], /2 discovered file\(s\)/)
  await rm(root, { recursive: true, force: true })
})

test('13N-C production guidance does not become progress by itself', async () => {
  const { renderExplorationGuidance } = await import('../../dist/agent/exploration-guidance.js')
  const first = renderExplorationGuidance({ prompt: 'explore the repository', availableTools: ['repo_map', 'glob', 'grep', 'read_file'], state: { progressRevision: 0, noProgressRounds: 0 } })
  const second = renderExplorationGuidance({ prompt: 'explore the repository', availableTools: ['repo_map', 'glob', 'grep', 'read_file'], state: { progressRevision: 0, noProgressRounds: 0 } })
  assert.equal(first, second)
})
