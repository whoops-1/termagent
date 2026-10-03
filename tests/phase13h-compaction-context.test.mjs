import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'termagent-13h-'))

function toolCall(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function pairedTurn(id, command = 'npm test') {
  return [
    { role: 'user', content: `run ${command}` },
    { role: 'assistant', content: null, tool_calls: [toolCall(id, 'bash', { command })] },
    { role: 'tool', tool_call_id: id, name: 'bash', content: 'PASS: verification completed ' + 'x'.repeat(180) },
  ]
}

test('13H micro-prune reduces old tool payloads while keeping recent tool pairs intact', async () => {
  const { microPruneToolResults } = await import('../dist/agent/compaction.js')
  const old = [
    { role: 'user', content: 'old request' },
    { role: 'assistant', content: null, tool_calls: [toolCall('old-1', 'bash', { command: 'npm test' })] },
    { role: 'tool', tool_call_id: 'old-1', name: 'bash', content: 'old output ' + 'x'.repeat(1600) },
  ]
  const recent = pairedTurn('recent-1')
  const messages = [
    { role: 'system', content: 'SYSTEM' },
    ...old,
    ...recent,
  ]
  const refs = new Map([['old-1', 'tool-output://abc']])
  const result = microPruneToolResults(messages, 300, { preserveRecentTurns: 1, minToolTokens: 20, references: refs })
  assert.equal(result.pruned, 1)
  assert.match(result.messages.find(m => m.tool_call_id === 'old-1').content, /full_output=tool-output:\/\/abc/)
  assert.match(result.messages.find(m => m.tool_call_id === 'old-1').content, /call_id=old-1/)
  const ai = result.messages.findIndex(m => m.tool_calls?.[0]?.id === 'recent-1')
  const tool = result.messages.findIndex(m => m.tool_call_id === 'recent-1')
  assert.equal(ai + 1, tool)
  assert.ok(result.remainingTokens <= 300)
})

test('13H full compaction preserves tool-call anchors, exact errors, verification evidence, and read ranges', async () => {
  const { compactMessages } = await import('../dist/agent/compaction.js')
  const messages = [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'Investigate parser failure' + 'x'.repeat(500) },
    { role: 'assistant', content: 'I will inspect src/parser.ts', tool_calls: [toolCall('call-77', 'read_file', { path: 'src/parser.ts', startLine: 120, endLine: 145 })] },
    { role: 'tool', tool_call_id: 'call-77', name: 'read_file', content: 'src/parser.ts#L120-145\n120: parser state\n145: return' },
    { role: 'assistant', content: 'Run verification' + 'y'.repeat(500), tool_calls: [toolCall('call-88', 'bash', { command: 'npm run build' })] },
    { role: 'tool', tool_call_id: 'call-88', name: 'bash', content: 'ERROR: exact compiler message TS2322 at src/parser.ts:143' },
    { role: 'user', content: 'Continue with the parser fix' },
  ]
  const c = compactMessages(messages, 360, { maxOutputTokens: 0, threshold: 1, reserveTokens: 0, recentTokens: 80 }, { activeObjective: 'Fix parser regression' })
  assert.ok(c.removed > 0)
  assert.match(c.summary, /call-77: read_file\(\{"path":"src\/parser\.ts"/) 
  assert.match(c.summary, /call-88: bash\(\{"command":"npm run build"\}\)/)
  assert.match(c.summary, /TS2322/)
  assert.match(c.summary, /parser\.ts#L120-145/)
  const summary = c.messages.find(m => m.role === 'system' && m.content.includes('Earlier conversation summary.'))
  assert.ok(summary)
  assert.match(summary.content, /Fix parser regression/)
})

test('13H machine state keeps read coverage, tool output refs, active tasks, workflow, todo, and mutations outside prose summary', async () => {
  const { machineStateFromRuntime, renderMachineState } = await import('../dist/context/state.js')
  const state = machineStateFromRuntime({
    sessionId: 'session-1',
    turnId: 'turn-1',
    epoch: 3,
    sourceEventCount: 42,
    summaryRevision: 2,
    messages: [{ role: 'user', content: 'continue' }],
    readStates: [{
      canonicalPath: '/repo/src/app.ts', mtimeMs: 10, size: 100, totalLines: 20, lastUse: 50,
      contentHash: 'abc', bom: false, lineEnding: 'LF',
      segments: [{ startLine: 3, endLine: 8, content: '', bytes: 0, complete: true, recordedAt: 50 }], requests: [],
    }],
    toolLifecycle: [{
      sessionId: 'session-1', turnId: 'turn-1', callId: 'bg-1', name: 'background', argumentsRaw: '{}', state: 'running',
      metadata: { background: true, taskId: 'task-42', status: 'running' }, outputReference: 'tool-output://ref-42',
    }],
    workflow: { phase: 'verifying', verificationPassed: false },
    todo: [{ id: '1', task: 'Verify parser', status: 'in_progress' }],
    mutations: [{ callId: 'call-9', turnId: 'turn-1', path: 'src/app.ts', operation: 'edit', afterHash: 'def', additions: 2, deletions: 1 }],
    continuation: { lastUserPrompt: 'continue', nextAction: 'run npm test' },
  })
  assert.deepEqual(state.activeTaskIds, ['task-42'])
  assert.equal(state.toolOutputReferences[0].reference, 'tool-output://ref-42')
  assert.equal(state.readCoverage[0].ranges[0].startLine, 3)
  const rendered = renderMachineState(state, 500)
  assert.match(rendered, /epoch=3/)
  assert.match(rendered, /task-42/)
  assert.match(rendered, /tool-output:\/\/ref-42/)
  assert.match(rendered, /Verify parser/)
  assert.match(rendered, /src\/app\.ts edit/)
})

test('13H read coverage can be rehydrated only when file identity still matches', async () => {
  const { rehydrateReadCoverageEvidence } = await import('../dist/tools/file-state.js')
  const root = await tmp()
  try {
    const file = path.join(root, 'evidence.ts')
    const content = Array.from({ length: 12 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n') + '\n'
    await fs.writeFile(file, content)
    const stat = await fs.stat(file)
    const crypto = await import('node:crypto')
    const hash = crypto.createHash('sha256').update(content).digest('hex')
    const evidence = await rehydrateReadCoverageEvidence([{ canonicalPath: file, mtimeMs: stat.mtimeMs, size: stat.size, totalLines: 12, contentHash: hash, ranges: [{ startLine: 4, endLine: 6 }] }], 80, 2)
    assert.equal(evidence.length, 1)
    assert.match(evidence[0], /evidence\.ts#L4-6/)
    assert.match(evidence[0], /4: const line4/)
    await fs.writeFile(file, content.replace('line5', 'changed5'))
    const stale = await rehydrateReadCoverageEvidence([{ canonicalPath: file, mtimeMs: stat.mtimeMs, size: stat.size, totalLines: 12, contentHash: hash, ranges: [{ startLine: 4, endLine: 6 }] }], 80, 2)
    assert.equal(stale.length, 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('13H context checkpoints are idempotent and undo ignores checkpoints from abandoned turns', async () => {
  const { SessionStore } = await import('../dist/session/store.js')
  const { projectionHash } = await import('../dist/context/state.js')
  const root = await tmp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'mock')
    const turn = await store.beginTurn(session.id, root, [{ role: 'user', content: 'x' }], 'x')
    const messages = [{ role: 'user', content: 'x' }]
    const base = { version: 1, id: 'cp-1', sessionId: session.id, turnId: turn.id, epoch: 1, sourceEventCount: 2, projectionHash: projectionHash(messages), summaryRevision: 1, summary: 'one', messages, machineState: { version: 1, sessionId: session.id, turnId: turn.id, epoch: 1, checkpointId: 'cp-1', sourceEventCount: 2, projectionHash: projectionHash(messages), summaryRevision: 1, readCoverage: [], toolOutputReferences: [], activeTaskIds: [], todo: [], mutations: [], createdAt: Date.now() }, stage: 'full-compaction', createdAt: Date.now() }
    await store.saveContextCheckpoint(session.id, base)
    const again = await store.saveContextCheckpoint(session.id, { ...base, id: 'different-id' })
    assert.equal(again.id, 'cp-1')
    await store.commitTurn(session.id, root, turn, messages)
    assert.equal((await store.latestContextCheckpoint(session.id)).id, 'cp-1')
    await store.append(session.id, { type: 'undo', ts: Date.now(), data: { turnId: turn.id } })
    assert.equal(await store.latestContextCheckpoint(session.id), undefined)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('13H repeated compaction carries prior summary forward while adding newer evidence', async () => {
  const { compactMessages } = await import('../dist/agent/compaction.js')
  const first = compactMessages([
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'Implement auth in src/auth/service.ts ' + 'x'.repeat(900) },
    { role: 'assistant', content: 'Refresh token rotation is enabled' + 'y'.repeat(700) },
    { role: 'tool', content: 'PASS: auth tests' },
    { role: 'user', content: 'Continue' },
  ], 420, { maxOutputTokens: 0, threshold: 1, reserveTokens: 0, recentTokens: 90 })
  const firstSummary = first.messages.find(m => m.role === 'system' && m.content.includes('Earlier conversation summary.')).content
  const second = compactMessages([
    ...first.messages,
    { role: 'user', content: 'Now handle idle timeout in src/session/idle.ts ' + 'q'.repeat(900) },
    { role: 'assistant', content: 'Idle timeout is wired and npm test passes' + 'w'.repeat(700) },
    { role: 'tool', content: 'PASS: session tests' },
  ], 420, { maxOutputTokens: 0, threshold: 1, reserveTokens: 0, recentTokens: 90 })
  const summary = second.messages.find(m => m.role === 'system' && m.content.includes('Earlier conversation summary.')).content
  assert.match(summary, /auth\/service\.ts/)
  assert.match(summary, /idle\.ts/)
  assert.match(summary, /Refresh token rotation is enabled/)
  assert.match(summary, /PASS: session tests/)
  assert.ok(summary.length >= firstSummary.length || /idle\.ts/.test(summary))
})

test('13H agent restores the checkpoint projection instead of replaying the full durable transcript', async () => {
  const { SessionStore } = await import('../dist/session/store.js')
  const { Agent } = await import('../dist/agent/agent.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const { projectionHash } = await import('../dist/context/state.js')
  const root = await tmp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'mock')
    const firstTurn = await store.beginTurn(session.id, root, [], 'seed')
    const projected = [{ role: 'user', content: 'checkpoint-visible' }, { role: 'assistant', content: 'keep this' }]
    await store.appendMessage(session.id, projected[0], firstTurn.id)
    await store.appendMessage(session.id, projected[1], firstTurn.id)
    await store.commitTurn(session.id, root, firstTurn, projected)
    const history = await store.load(session.id)
    const machine = { version: 1, sessionId: session.id, turnId: firstTurn.id, epoch: 2, checkpointId: 'cp-visible', sourceEventCount: history.events.length, projectionHash: projectionHash(projected), summaryRevision: 1, readCoverage: [], toolOutputReferences: [], activeTaskIds: [], todo: [], mutations: [], createdAt: Date.now() }
    await store.saveContextCheckpoint(session.id, { version: 1, id: 'cp-visible', sessionId: session.id, turnId: firstTurn.id, epoch: 2, sourceEventCount: history.events.length, projectionHash: machine.projectionHash, summaryRevision: 1, summary: 'checkpoint summary', messages: projected, machineState: machine, stage: 'baseline', createdAt: Date.now() })
    const oldTurn = await store.beginTurn(session.id, root, [], 'old')
    for (let i = 0; i < 30; i++) await store.appendMessage(session.id, { role: 'user', content: `old durable message ${i} ${'x'.repeat(300)}` }, oldTurn.id)
    await store.commitTurn(session.id, root, oldTurn, [{ role: 'user', content: 'old durable message' }])
    const registry = new ToolRegistry(new PermissionGate('auto'))
    const seen = []
    const provider = { id: 'mock', model: 'mock', async *stream(messages) { seen.push(messages); yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' } } }
    const agent = new Agent(provider, registry, store, 1, 8000, 1)
    await agent.run({ sessionId: session.id, messages: [], cwd: root, instructions: '', prompt: 'next' })
    assert.equal(seen.length, 1)
    assert.ok(seen[0].some(m => m.content === 'checkpoint-visible'))
    assert.ok(!seen[0].some(m => typeof m.content === 'string' && m.content.includes('old durable message 29')))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('13H repeated reads survive compaction and only valid file evidence is rehydrated', async () => {
  const { FileReadStateCache } = await import('../dist/tools/file-state.js')
  const root = await tmp()
  try {
    const file = path.join(root, 'repeated.ts')
    const content = Array.from({ length: 30 }, (_, i) => `export const item${i + 1} = ${i + 1};`).join('\n') + '\n'
    await fs.writeFile(file, content)
    const stat = await fs.stat(file)
    const crypto = await import('node:crypto')
    const hash = crypto.createHash('sha256').update(content).digest('hex')
    const cache = new FileReadStateCache()
    cache.record(file, { mtimeMs: stat.mtimeMs, size: stat.size, totalLines: 30, contentHash: hash, bom: false, lineEnding: 'LF' }, { startLine: 4, endLine: 8 }, [{ startLine: 4, endLine: 8, content: content.split('\n').slice(3, 8).join('\n') }], { lineCount: 5, truncated: false })
    cache.record(file, { mtimeMs: stat.mtimeMs, size: stat.size, totalLines: 30, contentHash: hash, bom: false, lineEnding: 'LF' }, { startLine: 20, endLine: 24 }, [{ startLine: 20, endLine: 24, content: content.split('\n').slice(19, 24).join('\n') }], { lineCount: 5, truncated: false })
    cache.noteCompaction()
    const lookup = cache.lookup(file, { startLine: 4, endLine: 8 }, { mtimeMs: stat.mtimeMs, size: stat.size, totalLines: 30 })
    assert.equal(lookup?.status, 'rehydrated')
    assert.match(lookup?.content || '', /item4/)
    const evidence = await cache.rehydrateContextEvidence(120, 2)
    assert.equal(evidence.length, 2)
    assert.match(evidence[0], /repeated\.ts#L4-8/)
    assert.match(evidence[1], /repeated\.ts#L20-24/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('13H many short tool calls compact deterministically without breaking the latest complete tool unit', async () => {
  const { compactMessages } = await import('../dist/agent/compaction.js')
  const messages = [{ role: 'system', content: 'SYSTEM' }]
  for (let i = 0; i < 60; i++) {
    const id = `call-short-${i}`
    messages.push({ role: 'user', content: `request ${i}` })
    messages.push({ role: 'assistant', content: null, tool_calls: [toolCall(id, 'read_file', { path: 'src/repeated.ts', startLine: 1, endLine: 3 })] })
    messages.push({ role: 'tool', tool_call_id: id, name: 'read_file', content: `file-${i}: ok` })
  }
  const result = compactMessages(messages, 500, { maxOutputTokens: 0, threshold: 1, reserveTokens: 0, recentTokens: 140 })
  assert.ok(result.removed > 0)
  const recentAssistant = result.messages.find(m => m.tool_calls?.[0]?.id === 'call-short-59')
  const recentTool = result.messages.find(m => m.tool_call_id === 'call-short-59')
  assert.ok(recentAssistant)
  assert.ok(recentTool)
  assert.ok(result.messages.indexOf(recentAssistant) < result.messages.indexOf(recentTool))
  assert.ok(result.messages.some(m => m.role === 'system' && m.content.includes('Earlier conversation summary.')))
})

test('13H large todo state stays machine-owned even when the rendered context must be bounded', async () => {
  const { machineStateFromRuntime, renderMachineState } = await import('../dist/context/state.js')
  const todos = Array.from({ length: 180 }, (_, i) => ({ id: `todo-${i + 1}`, task: `Complete verification item ${i + 1}`, status: i === 0 ? 'in_progress' : 'pending' }))
  const state = machineStateFromRuntime({
    sessionId: 'todo-session', epoch: 4, sourceEventCount: 90, summaryRevision: 3,
    messages: [{ role: 'user', content: 'continue' }], todo: todos,
  })
  assert.equal(state.todo.length, 180)
  assert.equal(state.todo[179].id, 'todo-180')
  const rendered = renderMachineState(state, 160)
  assert.ok(rendered.length < 1400)
  assert.match(rendered, /todo=/)
})

test('13H subagent completion keeps task identity and output reference in machine state', async () => {
  const { machineStateFromRuntime } = await import('../dist/context/state.js')
  const state = machineStateFromRuntime({
    sessionId: 'parent', turnId: 'turn-7', epoch: 2, sourceEventCount: 55, summaryRevision: 1,
    messages: [{ role: 'user', content: 'continue' }],
    toolLifecycle: [{
      sessionId: 'parent', turnId: 'turn-7', callId: 'task-call', name: 'task',
      argumentsRaw: JSON.stringify({ prompt: 'inspect auth' }), state: 'completed', outcome: 'success',
      metadata: { taskId: 'child-session-1', status: 'completed', kind: 'subagent', sessionId: 'child-session-1' },
      outputReference: 'tool-output://child-output',
    }],
  })
  assert.equal(state.activeTaskIds.length, 0)
  assert.equal(state.toolOutputReferences[0].reference, 'tool-output://child-output')
  assert.equal(state.toolOutputReferences[0].callId, 'task-call')
})

test('13H interrupted turns settle lifecycle state instead of leaving pending or running calls', async () => {
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolCallLifecycle } = await import('../dist/agent/tool-call-lifecycle.js')
  const root = await tmp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'mock')
    const turn = await store.beginTurn(session.id, root, [], 'interrupt')
    const lifecycle = new ToolCallLifecycle(store)
    await lifecycle.pending({ sessionId: session.id, turnId: turn.id, callId: 'interrupt-call', name: 'bash', argumentsRaw: '{}', metadata: { background: false } })
    await lifecycle.transition('interrupt-call', { state: 'running' })
    const recovered = await lifecycle.recoverUnsettled(session.id)
    assert.deepEqual(recovered, ['interrupt-call'])
    const record = lifecycle.snapshot().find(item => item.callId === 'interrupt-call')
    assert.equal(record?.state, 'interrupted')
    assert.equal(record?.outcome, 'interrupted')
    assert.match(record?.error || '', /recovery/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('13H compaction never runs in the middle of an executing tool', async () => {
  const { SessionStore } = await import('../dist/session/store.js')
  const { Agent } = await import('../dist/agent/agent.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const root = await tmp()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const session = await store.create(root, 'mock')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    let started = false
    let release
    const released = new Promise(resolve => { release = resolve })
    registry.add({
      name: 'slow_read', risk: 'read', description: 'slow read fixture', schema: { type: 'object', properties: {} },
      async execute() {
        started = true
        const during = await store.load(session.id)
        assert.equal(during.events.some(event => event.type === 'context.checkpoint'), false)
        release()
        await new Promise(resolve => setTimeout(resolve, 10))
        return { output: 'slow read complete' }
      },
    })
    let providerRounds = 0
    const provider = {
      id: 'mock', model: 'mock', config: { maxTokens: 0 },
      async *stream() {
        providerRounds++
        if (providerRounds === 1) {
          yield { type: 'tool_call', call: toolCall('slow-call', 'slow_read', {}) }
        } else {
          yield { type: 'text', delta: 'done' }
        }
      },
    }
    const agent = new Agent(provider, registry, store, 2, 2000, 1, undefined, [], { threshold: 1, reserveTokens: 0, recentTokens: 100 })
    const runPromise = agent.run({ sessionId: session.id, messages: [], cwd: root, instructions: '', prompt: 'run slow read' })
    await released
    assert.equal(started, true)
    await runPromise
    const after = await store.load(session.id)
    assert.equal(after.events.some(event => event.type === 'context.checkpoint'), true)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
