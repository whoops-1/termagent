import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function makeRoot(prefix='termagent-13n-d-') {
  return await mkdtemp(path.join(tmpdir(), prefix))
}

function context(root, sessionID='verification-test') {
  const controller = new AbortController()
  return { sessionID, agent: 'build', cwd: root, abort: controller.signal, scopePaths: undefined }
}

async function buildAgentHarness(prefix='termagent-13n-d-agent-') {
  const { Agent } = await import('../../dist/agent/agent.js')
  const { SessionStore } = await import('../../dist/session/store.js')
  const { ToolRegistry } = await import('../../dist/tools/registry.js')
  const { PermissionGate } = await import('../../dist/tools/permissions.js')
  const { TaskManager } = await import('../../dist/tasks/manager.js')
  const root = await makeRoot(prefix)
  const sessions = new SessionStore(path.join(root, 'sessions'))
  const session = await sessions.create(root, 'mock')
  const tasks = new TaskManager(path.join(root, 'tasks'), false, path.join(root, 'sessions'))
  const registry = new ToolRegistry(new PermissionGate('auto'))
  return { Agent, SessionStore, ToolRegistry, TaskManager, root, sessions, session, tasks, registry }
}

test('13N-D verify_project reports bounded settled statuses', async () => {
  const { verifyTool } = await import('../../dist/tools/verify.js')
  const root = await makeRoot()
  const tasksRoot = path.join(root, 'tasks')
  const { TaskManager } = await import('../../dist/tasks/manager.js')
  const manager = new TaskManager(tasksRoot, false, path.join(root, 'sessions'))
  const run = (command, timeoutMs=3000) => verifyTool(timeoutMs, 256, manager).execute({ command, timeoutMs }, context(root))

  try {
    const passed = await run('node -e "process.stdout.write(\\\"ok\\\")"')
    assert.equal(passed.metadata.verification.status, 'passed')
    assert.equal(passed.metadata.verification.ok, true)
    assert.equal(passed.metadata.verification.settled, true)
    assert.equal(typeof passed.metadata.verification.commandFingerprint, 'string')
    assert.equal(typeof passed.metadata.task.taskId, 'string')
    assert.equal(typeof passed.metadata.task.outputPath, 'string')

    const large = await verifyTool(3000, 256, manager).execute({ command: `node -e "process.stdout.write('x'.repeat(5000))"`, timeoutMs: 3000 }, context(root, 'large-output'))
    assert.equal(large.metadata.verification.status, 'passed')
    assert.equal(large.metadata.task.outputTruncated, true)
    assert.equal(large.metadata.task.outputBytes >= 5000, true)
    assert.equal(typeof large.metadata.task.outputPath, 'string')

    const failed = await run('node -e "process.exit(7)"')
    assert.equal(failed.metadata.verification.status, 'failed')
    assert.equal(failed.metadata.verification.ok, false)
    assert.equal(failed.metadata.exitCode, 7)

    const timedOut = await run('node -e "setTimeout(()=>process.exit(0),1000)"', 30)
    assert.equal(timedOut.metadata.verification.status, 'timeout')
    assert.equal(timedOut.metadata.verification.ok, false)
    assert.equal(timedOut.metadata.verification.termination, 'timeout')

    const noCommandRoot = await makeRoot('termagent-13n-d-nocmd-')
    const noCommand = await verifyTool().execute({}, context(noCommandRoot, 'no-command'))
    assert.equal(noCommand.metadata.verification.status, 'no_command')
    assert.equal(noCommand.metadata.verification.settled, true)
    await rm(noCommandRoot, { recursive: true, force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('13N-D verify_project reports cancellation as a settled status', async () => {
  const { verifyTool } = await import('../../dist/tools/verify.js')
  const { TaskManager } = await import('../../dist/tasks/manager.js')
  const root = await makeRoot()
  const manager = new TaskManager(path.join(root, 'tasks'), false, path.join(root, 'sessions'))
  const controller = new AbortController()
  controller.abort()
  try {
    const result = await verifyTool(3000, 256, manager).execute(
      { command: 'node -e "setTimeout(()=>{},1000)"', timeoutMs: 3000 },
      { ...context(root, 'cancelled'), abort: controller.signal },
    )
    assert.equal(result.metadata.verification.status, 'cancelled')
    assert.equal(result.metadata.verification.ok, false)
    assert.equal(result.metadata.verification.settled, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('13N-D automatic verification runs once after successful mutations and becomes cached', async () => {
  const h = await buildAgentHarness()
  let verifyRuns = 0
  let providerRounds = 0
  const requests = []
  h.registry.add({
    name: 'verify_project',
    description: 'test verification',
    risk: 'shell',
    schema: { type: 'object', properties: { force: { type: 'boolean' } } },
    execute: async () => {
      return { output: 'explicit verification passed', metadata: { status: 'passed', ok: true, verification: { status: 'passed', ok: true, settled: true, commandFingerprint: 'explicit' } } }
    },
  })
  h.registry.add({
    name: 'write_file',
    description: 'test write',
    risk: 'write',
    schema: { type: 'object' },
    execute: async () => ({
      output: 'wrote test.txt',
      metadata: { mutation: { path: path.join(h.root, 'test.txt'), operation: 'create', afterHash: 'after-1', beforeHash: null } },
    }),
  })
  const provider = {
    async *stream(messages, tools) {
      providerRounds += 1
      requests.push(messages.map(m => `${m.role}:${m.content ?? ''}`).join('\n'))
      if (providerRounds === 1) {
        yield { type: 'tool_call', call: { id: 'write-1', type: 'function', function: { name: 'write_file', arguments: '{}' } } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else if (providerRounds === 2) {
        yield { type: 'tool_call', call: { id: 'verify-1', type: 'function', function: { name: 'verify_project', arguments: '{}' } } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else if (providerRounds === 3) {
        yield { type: 'tool_call', call: { id: 'verify-2', type: 'function', function: { name: 'verify_project', arguments: JSON.stringify({ force: true }) } } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      }
    },
  }
  const originalExecute = h.registry.execute.bind(h.registry)
  h.registry.execute = async (name, args, ctx) => {
    if (name === 'verify_project') {
      verifyRuns += 1
      return await originalExecute(name, args, ctx)
    }
    return await originalExecute(name, args, ctx)
  }

  const agent = new h.Agent(
    provider,
    h.registry,
    h.sessions,
    4,
    12000,
    2,
    undefined,
    [],
    {},
    undefined,
    {},
    { enabled: true, command: 'node -e "process.exit(0)"', timeoutMs: 3000, maxOutputBytes: 256, tools: ['write_file'] },
    h.tasks,
  )

  try {
    await agent.run({
      sessionId: h.session.id,
      messages: [],
      cwd: h.root,
      instructions: 'Implement and verify the change.',
      prompt: 'write the test file and verify it',
      mode: 'build',
    })
    assert.equal(verifyRuns, 1, 'only the explicit force=true verification should reach ToolRegistry.execute')
    const loaded = await h.sessions.load(h.session.id)
    const verificationEvents = loaded.events.filter(event => event.type === 'verification')
    assert.equal(verificationEvents.length, 1)
    assert.equal(verificationEvents[0].data.status, 'passed')
    assert.equal(verificationEvents[0].data.source, 'automatic')
    assert.equal(typeof verificationEvents[0].data.taskId, 'string')
    assert.equal(verificationEvents[0].kind, 'session.verification.completed')
    assert.equal(verificationEvents[0].category, 'verification')
    const checkpoint = loaded.events.filter(event => event.type === 'context.checkpoint').at(-1)
    assert.equal(checkpoint?.data?.machineState?.exploration?.settledVerificationFacts?.some(value => String(value).startsWith('verify:passed:')), true)
    assert.equal(checkpoint?.data?.machineState?.evidenceLedger?.verifications?.some(item => item.status === 'passed'), true)
    assert.equal(checkpoint?.data?.machineState?.evidenceLedger?.verifications?.some(item => typeof item.outputPath === 'string'), true)
    const tasks = await h.tasks.list()
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].status, 'exited')
    assert.equal(requests.some(request => request.includes('AUTOMATIC VERIFICATION: PASSED')), true)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('13N-D apply_patch mutations participate in the default post-edit verification path', async () => {
  const h = await buildAgentHarness()
  let rounds = 0
  h.registry.add({
    name: 'apply_patch',
    description: 'test patch',
    risk: 'write',
    schema: { type: 'object' },
    execute: async () => ({ output: 'patched', metadata: { mutation: { files: [{ path: path.join(h.root, 'x.txt'), operation: 'update', beforeHash: 'a', afterHash: 'b' }] } } }),
  })
  const provider = {
    async *stream() {
      rounds += 1
      if (rounds === 1) {
        yield { type: 'tool_call', call: { id: 'p1', type: 'function', function: { name: 'apply_patch', arguments: '{}' } } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      }
    },
  }
  const agent = new h.Agent(provider, h.registry, h.sessions, 2, 12000, 2, undefined, [], {}, undefined, {}, {
    enabled: true,
    command: 'node -e "process.exit(0)"',
    timeoutMs: 3000,
    maxOutputBytes: 1024,
  }, h.tasks)
  try {
    await agent.run({ sessionId: h.session.id, messages: [], cwd: h.root, instructions: 'apply a patch and verify it', prompt: 'patch it', mode: 'build' })
    const loaded = await h.sessions.load(h.session.id)
    assert.equal(loaded.events.filter(event => event.type === 'verification').length, 1)
    assert.equal((await h.tasks.list()).length, 1)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('13N-D automatic verification honors the mutation tool allowlist', async () => {
  const h = await buildAgentHarness()
  let providerRounds = 0
  h.registry.add({
    name: 'custom_write',
    description: 'test write',
    risk: 'write',
    schema: { type: 'object' },
    execute: async () => ({ output: 'changed', metadata: { mutation: { path: path.join(h.root, 'x.txt'), operation: 'update', afterHash: 'x' } } }),
  })
  const provider = {
    async *stream() {
      providerRounds += 1
      if (providerRounds === 1) {
        yield { type: 'tool_call', call: { id: 'w1', type: 'function', function: { name: 'custom_write', arguments: '{}' } } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else {
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      }
    },
  }
  const agent = new h.Agent(provider, h.registry, h.sessions, 2, 12000, 2, undefined, [], {}, undefined, {}, {
    enabled: true,
    command: 'node -e "process.exit(0)"',
    timeoutMs: 3000,
    maxOutputBytes: 256,
    tools: ['write_file'],
  }, h.tasks)
  try {
    await agent.run({ sessionId: h.session.id, messages: [], cwd: h.root, instructions: 'change a file', prompt: 'change it', mode: 'build' })
    const loaded = await h.sessions.load(h.session.id)
    assert.equal(loaded.events.filter(event => event.type === 'verification').length, 0)
    assert.equal((await h.tasks.list()).length, 0)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('13N-D automatic verification failure becomes workflow evidence and drives iteration', async () => {
  const h = await buildAgentHarness()
  let rounds = 0
  h.registry.add({
    name: 'write_file',
    description: 'test write',
    risk: 'write',
    schema: { type: 'object' },
    execute: async () => ({ output: 'wrote test.txt', metadata: { mutation: { path: path.join(h.root, 'test.txt'), operation: 'update', afterHash: 'bad' } } }),
  })
  const provider = {
    async *stream(messages) {
      rounds += 1
      if (rounds === 1) {
        yield { type: 'tool_call', call: { id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{}' } } }
        yield { type: 'done', finishReason: 'tool_calls' }
      } else if (rounds === 2) {
        yield { type: 'text', delta: 'verification failed, stopping' }
        yield { type: 'done', finishReason: 'stop' }
      }
    },
  }
  const agent = new h.Agent(provider, h.registry, h.sessions, 2, 12000, 2, undefined, [], {}, undefined, {}, {
    enabled: true,
    command: 'node -e "process.exit(5)"',
    timeoutMs: 3000,
    maxOutputBytes: 256,
    tools: ['write_file'],
  }, h.tasks)
  try {
    const result = await agent.run({ sessionId: h.session.id, messages: [], cwd: h.root, instructions: 'make and verify a change', prompt: 'change it', mode: 'build' })
    const loaded = await h.sessions.load(h.session.id)
    const event = loaded.events.find(item => item.type === 'verification')
    assert.equal(event?.data.status, 'failed')
    assert.equal(result.includes('verification'), true)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('13N-D EvidenceLedger is bounded and fingerprint ignores task/call/output identity churn', async () => {
  const { buildEvidenceLedger } = await import('../../dist/context/evidence-ledger.js')
  const base = {
    version: 2,
    cwd: '/tmp/project',
    scopePaths: [],
    discoveredFiles: ['/tmp/project/a.ts'],
    files: [{ canonicalPath: '/tmp/project/a.ts', mtimeMs: 1, size: 10, totalLines: 2, coveredRanges: [{ startLine: 1, endLine: 2 }], fullCoverage: true }],
    reads: [],
    searches: [{ kind: 'grep', signature: 'grep:foo', query: 'foo', path: '/tmp/project', discoveredFiles: ['/tmp/project/a.ts'], symbols: [], resultKeys: ['r1'] }],
    symbols: [{ name: 'foo', path: '/tmp/project/a.ts', line: 1 }],
    settledVerificationFacts: ['verify:passed:abc'],
    progressRevision: 3,
  }
  const ledgerA = buildEvidenceLedger({
    exploration: base,
    lifecycle: [],
    mutations: [{ callId: 'call-a', turnId: 'turn-a', path: '/tmp/project/a.ts', operation: 'update', beforeHash: 'b', afterHash: 'c' }],
    tasks: [{ id: 'task-a', kind: 'shell', status: 'exited', termination: 'completed', exitCode: 0, output: 'huge', outputPath: '/tmp/tasks/a.log', outputBytes: 1000000, outputTruncated: true }],
    automaticVerifications: [{ tool: 'verify_project', status: 'passed', ok: true, commandFingerprint: 'cmd', taskId: 'task-a', outputPath: '/tmp/tasks/a.log', outputBytes: 1000000, outputTruncated: true, source: 'automatic' }],
    workflow: { phase: 'verifying', lastToolSignature: 'verify_project:{}' },
  })
  const ledgerB = buildEvidenceLedger({
    exploration: base,
    lifecycle: [],
    mutations: [{ callId: 'call-b', turnId: 'turn-b', path: '/tmp/project/a.ts', operation: 'update', beforeHash: 'b', afterHash: 'c' }],
    tasks: [{ id: 'task-b', kind: 'shell', status: 'exited', termination: 'completed', exitCode: 0, output: 'different', outputPath: '/tmp/tasks/b.log', outputBytes: 2000000, outputTruncated: false }],
    automaticVerifications: [{ tool: 'verify_project', status: 'passed', ok: true, commandFingerprint: 'cmd', taskId: 'task-b', outputPath: '/tmp/tasks/b.log', outputBytes: 2000000, outputTruncated: false, source: 'automatic' }],
    workflow: { phase: 'verifying', lastToolSignature: 'verify_project:{}' },
  })
  assert.equal(ledgerA.fingerprint, ledgerB.fingerprint)
  const bounded = buildEvidenceLedger({
    exploration: {
      ...base,
      discoveredFiles: Array.from({ length: 300 }, (_, i) => `/tmp/project/${i}.ts`),
      files: Array.from({ length: 300 }, (_, i) => ({ canonicalPath: `/tmp/project/${i}.ts`, mtimeMs: i, size: 1, totalLines: 1, coveredRanges: [{ startLine: 1, endLine: 1 }], fullCoverage: true })),
      searches: Array.from({ length: 120 }, (_, i) => ({ kind: 'grep', signature: `grep:${i}`, query: String(i), path: '/tmp/project', discoveredFiles: [], symbols: [], resultKeys: [] })),
      symbols: Array.from({ length: 600 }, (_, i) => ({ name: `s${i}`, path: '/tmp/project/a.ts', line: i + 1 })),
    },
  })
  assert.equal(bounded.files.length, 256)
  assert.equal(bounded.searches.length, 96)
  assert.equal(bounded.symbols.length, 512)
  assert.equal(ledgerA.mutations[0].callId, 'call-a')
  assert.equal(ledgerA.tasks[0].outputPath, '/tmp/tasks/a.log')
  assert.equal(ledgerA.verifications[0].outputPath, '/tmp/tasks/a.log')
  assert.equal(ledgerA.files.length, 1)
  assert.equal(ledgerA.searches.length, 1)
})

test('13N-D ledger survives ContextMachineState serialization', async () => {
  const { machineStateFromRuntime } = await import('../../dist/context/state.js')
  const { buildEvidenceLedger } = await import('../../dist/context/evidence-ledger.js')
  const ledger = buildEvidenceLedger({
    exploration: {
      version: 1,
      cwd: '/tmp/project',
      scopePaths: [],
      discoveredFiles: [],
      files: [],
      reads: [],
      searches: [],
      symbols: [],
      progressRevision: 0,
      settledVerificationFacts: [],
    },
    automaticVerifications: [{ tool: 'verify_project', status: 'passed', ok: true, commandFingerprint: 'cmd', source: 'automatic' }],
  })
  const state = machineStateFromRuntime({
    sessionId: 's',
    turnId: 't',
    epoch: 1,
    sourceEventCount: 3,
    summaryRevision: 0,
    messages: [],
    evidenceLedger: ledger,
  })
  assert.deepEqual(state.evidenceLedger, ledger)
})

test('13N-D verification event kind is durable and classified as verification', async () => {
  const { legacyEventKind, legacyEventCategory } = await import('../../dist/protocol/session-events.js')
  const kind = legacyEventKind({ type: 'verification', data: {} })
  assert.equal(kind, 'session.verification.completed')
  assert.equal(legacyEventCategory(kind), 'verification')
})
