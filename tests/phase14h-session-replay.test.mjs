import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { analyzeSessionEvents, analyzeSessionFile } from '../tools/phase14h-session-replay.mjs'

function fixtureEvents() {
  const summary = [
    '## Objective', '- inspect the repository',
    '## Requirements', '- keep state durable',
    '## Decisions', '- reuse the existing store',
    '## Important Details', '- exact path: src/session/store.ts',
    '## Work State', '### Completed', '- inspect source', '### Active', '- replay', '### Blocked', '- none',
    '## Todo', '- replay', '## Next Move', '1. test', '## Relevant Files', '- src/session/store.ts',
  ].join('\n')
  const messages = [
    { role: 'user', content: 'Inspect the repository' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'glob', arguments: '{"pattern":"src/**/*.ts"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'src/session/store.ts' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'glob', arguments: '{"pattern":"src/**/*.ts"}' } }] },
    { role: 'tool', tool_call_id: 'call-2', content: 'src/session/store.ts' },
    { role: 'assistant', content: 'Found the session store.' },
  ]
  const event = (sequence, type, data, extra = {}) => ({ type, ts: 1_000 + sequence, data, sequence, eventId: `evt-${sequence}`, version: 1, durable: true, ...extra })
  const machineState = { version: 1, sessionId: 'replay-fixture', turnId: 'turn-1', epoch: 1, checkpointId: 'cp-1', sourceEventCount: 6, projectionHash: 'hash', summaryRevision: 1, readCoverage: [], exploration: { discoveredFiles: ['src/session/store.ts'] }, evidenceLedger: { files: [] }, toolOutputReferences: [], activeTaskIds: [], todo: [], loadedSkills: [], answeredQuestions: [], mutations: [], continuation: { lastUserPrompt: 'Inspect the repository' }, createdAt: 1_000 }
  const compactData = { removed: 0, tokens: 700, messageTokens: 400, schemaTokens: 300, summary, budget: { maxContextTokens: 12_000, usableTokens: 1_000, recentTokens: 200 }, stage: 'full-compaction', epoch: 1, summaryRevision: 1 }
  return [
    event(1, 'meta', { id: 'replay-fixture', cwd: '/tmp/workspace', model: 'test-model' }),
    event(2, 'turn', { id: 'turn-1', status: 'started', beforeSnapshot: 'before', started: 1_002 }),
    event(3, 'message', { message: messages[0], turnId: 'turn-1' }),
    event(4, 'message', { message: messages[1], turnId: 'turn-1' }),
    event(5, 'message', { message: messages[2], turnId: 'turn-1' }),
    event(6, 'compaction', compactData),
    event(7, 'context.checkpoint', { version: 1, id: 'cp-1', sessionId: 'replay-fixture', turnId: 'turn-1', epoch: 1, sourceEventCount: 6, projectionHash: 'hash', summaryRevision: 1, summary, messages, machineState, stage: 'full-compaction', createdAt: 1_007 }),
    event(8, 'message', { message: messages[3], turnId: 'turn-1' }),
    event(9, 'message', { message: messages[4], turnId: 'turn-1' }),
    event(10, 'tool.call', { callId: 'call-2', name: 'glob', state: 'pending', argumentsRaw: '{"pattern":"src/**/*.ts"}' }),
    event(11, 'tool.call', { callId: 'call-2', name: 'glob', state: 'running', startedAt: 1_011 }),
    event(12, 'tool.call', { callId: 'call-2', name: 'glob', state: 'completed', startedAt: 1_011, endedAt: 1_012 }),
    event(13, 'message', { message: messages[5], turnId: 'turn-1' }),
    event(14, 'turn', { id: 'turn-1', status: 'committed', started: 1_002, committed: 1_014 }),
  ]
}

test('14H replay reconstructs the canonical session projection and detects repeated exploration across compaction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-14h-replay-test-'))
  const file = path.join(root, 'trace.jsonl')
  try {
    const events = fixtureEvents()
    await fs.writeFile(file, `${events.map(event => JSON.stringify(event)).join('\n')}\n`)
    const result = await analyzeSessionFile(file)
    assert.equal(result.canonicalReplay.sessionStoreProjectionLoaded, true)
    assert.equal(result.canonicalReplay.latestCheckpointResolved, true)
    assert.equal(result.source.sequence.gaps, 0)
    assert.equal(result.transcript.reconstructedMessages, 6)
    assert.equal(result.transcript.committedTurns, 1)
    assert.equal(result.toolMessages.uniqueCalls, 2)
    assert.deepEqual(result.toolMessages.unmatchedCalls, [])
    assert.deepEqual(result.toolMessages.unmatchedResults, [])
    assert.equal(result.toolMessages.exploration.repeatedExactSignatures, 1)
    assert.equal(result.toolMessages.exploration.repeatedCallsAcrossCompactionEpochs, 1)
    assert.equal(result.toolLifecycle.incompleteCalls, 0)
    assert.equal(result.checkpoints.unmatchedCompactionEpochs.length, 0)
    assert.equal(result.currentCompactorCounterfactual.unmatchedRetainedToolCalls.length, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H replay reads dedicated provider usage events and avoids double-counting embedded compatibility records', () => {
  const event = (sequence, type, data) => ({ type, ts: 2_000 + sequence, data, sequence })
  const usage = {
    inputTokens: 1_000,
    contextTokens: 1_000,
    nonCachedInputTokens: 250,
    outputTokens: 50,
    totalTokens: 1_050,
    estimated: false,
    contextWindow: 10_000,
    contextSource: 'provider-profile',
    provider: 'openai-compatible',
    model: 'mercury-3',
    cacheReadTokens: 750,
    estimateInputTokens: 800,
    driftPercent: 20,
    recordedAt: 2_010,
    turnId: 'turn-usage',
    round: 0,
  }
  const events = [
    event(1, 'provider.turn', { turnId: 'turn-usage', round: 0, state: 'started' }),
    event(2, 'provider.turn', { turnId: 'turn-usage', round: 0, state: 'completed', usage }),
    event(3, 'provider.usage', usage),
  ]
  const result = analyzeSessionEvents(events, { messages: [], meta: { id: 'usage-fixture', model: 'mercury-3' } })
  const report = result.compactions.providerUsage
  assert.equal(report.providerRoundEvents, 2)
  assert.equal(report.providerRounds, 1)
  assert.equal(report.eventsWithUsage, 1)
  assert.equal(report.providerReportedRequests, 1)
  assert.equal(report.estimatedRequests, 0)
  assert.equal(report.missingUsageRounds, 0)
  assert.equal(report.inputTokens, 1_000)
  assert.equal(report.nonCachedInputTokens, 250)
  assert.equal(report.cacheReadTokens, 750)
  assert.equal(report.outputTokens, 50)
  assert.equal(report.totalTokens, 1_050)
  assert.equal(report.driftPercent, 20)
  assert.equal(report.routes.length, 1)
  assert.equal(report.routes[0].model, 'mercury-3')
})

test('14H replay retains compatibility with provider usage embedded only in legacy provider.turn events', () => {
  const event = (sequence, type, data) => ({ type, ts: 3_000 + sequence, data, sequence })
  const usage = {
    inputTokens: 400,
    nonCachedInputTokens: 400,
    outputTokens: 25,
    totalTokens: 425,
    estimated: false,
    contextWindow: 8_000,
    contextSource: 'fallback',
    provider: 'legacy-provider',
    model: 'legacy-model',
    estimateInputTokens: 350,
    turnId: 'legacy-turn',
    round: 0,
  }
  const events = [event(1, 'provider.turn', { turnId: 'legacy-turn', round: 0, state: 'completed', usage })]
  const result = analyzeSessionEvents(events, { messages: [], meta: { id: 'legacy-fixture' } })
  assert.equal(result.compactions.providerUsage.eventsWithUsage, 1)
  assert.equal(result.compactions.providerUsage.providerReportedRequests, 1)
  assert.equal(result.compactions.providerUsage.inputTokens, 400)
})

test('14H replay does not coerce null or blank provider round identifiers to round zero', () => {
  const event = (sequence, type, data) => ({ type, ts: 4_000 + sequence, data, sequence })
  const usage = {
    inputTokens: 120,
    nonCachedInputTokens: 120,
    outputTokens: 8,
    totalTokens: 128,
    estimated: false,
    contextWindow: 20_000,
    contextSource: 'fixture',
    provider: 'round-validation-provider',
    model: 'round-validation-model',
    estimateInputTokens: 100,
  }
  const legacyUsage = { ...usage, inputTokens: 300, nonCachedInputTokens: 300, totalTokens: 305, outputTokens: 5 }
  const events = [
    event(1, 'provider.turn', { turnId: 'turn-null', round: null, state: 'started' }),
    event(2, 'provider.turn', { turnId: 'turn-blank', round: ' ', state: 'started' }),
    event(3, 'provider.turn', { turnId: 'turn-null', round: null, state: 'completed', usage: legacyUsage }),
    event(4, 'provider.usage', { ...usage, turnId: 'turn-null', round: 0 }),
  ]
  const result = analyzeSessionEvents(events, { messages: [], meta: { id: 'round-validation' } })
  assert.equal(result.compactions.providerUsage.providerRounds, 2)
  assert.equal(result.compactions.providerUsage.eventsWithUsage, 2)
  assert.equal(result.compactions.providerUsage.missingUsageRounds, 0)
  assert.equal(result.compactions.providerUsage.inputTokens, 420)
})

test('14H replay reports malformed JSONL and refuses files without a TermAgent metadata event', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-14h-replay-invalid-'))
  const file = path.join(root, 'invalid.jsonl')
  try {
    await fs.writeFile(file, '{not-json}\n')
    await assert.rejects(analyzeSessionFile(file), /Invalid JSONL/)
    await fs.writeFile(file, `${JSON.stringify({ type: 'message', sequence: 1, data: {} })}\n`)
    await assert.rejects(analyzeSessionFile(file), /leading meta event/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H compaction retains every structural summary heading after the fitted summary is budgeted', async () => {
  const { compactMessages } = await import('../dist/agent/compaction.js')
  const { estimateMessagesTokens } = await import('../dist/context/budget.js')
  const messages = [{ role: 'system', content: 'Stable system prompt' }]
  for (let index = 0; index < 24; index++) {
    messages.push({ role: 'user', content: `Requirement ${index}: the implementation must preserve durable state and avoid repeated repository exploration. ${'context '.repeat(45)}` })
    messages.push({
      role: 'assistant',
      content: `I decided to inspect module ${index}. ${'analysis '.repeat(35)}`,
      tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/module-${index}.ts`, startLine: 10, endLine: 40 }) } }],
    })
    messages.push({ role: 'tool', tool_call_id: `call-${index}`, content: `Verified module ${index}. ${'implementation '.repeat(45)}` })
    messages.push({ role: 'assistant', content: `The change in module ${index} was completed and verified. ${'result '.repeat(30)}` })
  }

  const result = compactMessages(messages, 3_000, {
    maxOutputTokens: 0,
    threshold: 1,
    reserveTokens: 0,
    recentTokens: 700,
  }, { activeObjective: 'Preserve the current repository implementation objective.' })
  const summary = result.messages.find(message => message.role === 'system' && String(message.content || '').startsWith('Earlier conversation summary.'))?.content || ''
  for (const heading of [
    '## Objective', '## Requirements', '## Decisions', '## Important Details', '## Work State',
    '### Completed', '### Active', '### Blocked', '## Todo', '## Next Move', '## Relevant Files',
  ]) assert.match(summary, new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `missing ${heading}`)
  assert.ok(estimateMessagesTokens(result.messages) <= result.budget.usableTokens)
  const calls = result.messages.filter(message => message.role === 'assistant' && message.tool_calls).flatMap(message => message.tool_calls)
  const results = new Set(result.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
  assert.ok(calls.every(call => results.has(call.id)), 'compaction must not retain a tool call without its result')
})

test('14H repeated compaction cycles preserve the objective, requirements, decisions, outcomes, files, and complete tool units', async () => {
  const { compactMessages } = await import('../dist/agent/compaction.js')
  const { estimateMessagesTokens } = await import('../dist/context/budget.js')
  const objective = 'Finish the context continuity implementation without repeating verified repository exploration.'
  const policy = 'The agent must preserve the active objective, exact file paths, decisions, and verification evidence across every compaction cycle.'
  let messages = [{ role: 'system', content: 'Stable TermAgent system prompt.' }, { role: 'user', content: `Objective: ${objective}\nRequirement: ${policy}` }]
  const options = { maxOutputTokens: 0, threshold: 1, reserveTokens: 0, recentTokens: 180 }
  const requiredHeadings = [
    '## Objective', '## Requirements', '## Decisions', '## Important Details', '## Work State',
    '### Completed', '### Active', '### Blocked', '## Todo', '## Next Move', '## Relevant Files',
  ]

  for (let cycle = 1; cycle <= 4; cycle++) {
    const file = `src/context/module-${cycle}.ts`
    messages.push(
      { role: 'user', content: `Cycle ${cycle}: continue the context task without repeating broad scans. ${'investigation '.repeat(250)}` },
      { role: 'assistant', content: `We decided to reuse the existing context checkpoint path in ${file}. The previous cache digest was validated. ${'reasoning '.repeat(90)}`, tool_calls: [{ id: `context-call-${cycle}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: file, startLine: 18, endLine: 42 }) } }] },
      { role: 'tool', tool_call_id: `context-call-${cycle}`, content: `PASS: focused context regression cycle ${cycle}; verified ${file}#L18-42.` },
      { role: 'assistant', content: `Completed cycle ${cycle}; the context checkpoint and read coverage were preserved. ${'result '.repeat(65)}` },
    )

    const compacted = compactMessages(messages, 1_500, options, {
      activeObjective: objective,
      todo: [{ id: '14H-CONTINUITY', task: 'Preserve machine state across compaction', status: 'in_progress' }],
    })
    messages = compacted.messages
    const summary = messages.find(message => message.role === 'system' && String(message.content || '').startsWith('Earlier conversation summary.'))?.content || ''
    for (const heading of requiredHeadings) assert.match(summary, new RegExp(`^${heading.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'm'), `cycle ${cycle} lost ${heading}`)
    assert.match(summary, new RegExp(objective.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')))
    assert.match(summary, /must preserve the active objective/i)
    assert.match(summary, new RegExp(file.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')))
    const hasVerification =
      summary.includes('PASS: focused context regression') ||
      messages.some(message =>
        message.role === 'tool' &&
        /PASS: focused context regression cycle [1-4]/.test(String(message.content || '')),
      )
    assert.ok(hasVerification, `cycle ${cycle} lost all retained verification evidence`)
    assert.match(summary, /14H-CONTINUITY/)
    assert.ok(estimateMessagesTokens(messages) <= compacted.budget.usableTokens)

    const calls = messages.filter(message => message.role === 'assistant' && message.tool_calls).flatMap(message => message.tool_calls)
    const results = new Set(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
    assert.ok(calls.every(call => results.has(call.id)), `cycle ${cycle} retained a tool call without a result`)
  }
})
