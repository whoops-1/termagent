import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { captureProviderTrace } from '../dist/providers/trace.js'
import { analyzeProviderTraces, analyzeRuntimeCalibration, loadProviderTraces } from '../tools/phase14h-provider-trace-replay.mjs'

const temp = prefix => fs.mkdtemp(path.join(os.tmpdir(), prefix))
const originalTraceDir = process.env.TERMAGENT_PROVIDER_TRACE_DIR

test('14H provider trace capture is disabled unless an explicit directory is configured', async () => {
  delete process.env.TERMAGENT_PROVIDER_TRACE_DIR
  try {
    const result = await captureProviderTrace({})
    assert.equal(result, undefined)
  } finally {
    if (originalTraceDir === undefined) delete process.env.TERMAGENT_PROVIDER_TRACE_DIR
    else process.env.TERMAGENT_PROVIDER_TRACE_DIR = originalTraceDir
  }
})

test('14H provider capture writes exact request/usage data atomically with private file permissions', async () => {
  const root = await temp('termagent-14h-provider-trace-')
  const directory = path.join(root, 'captures')
  process.env.TERMAGENT_PROVIDER_TRACE_DIR = directory
  try {
    const messages = [
      { role: 'system', content: 'Use project instructions.' },
      { role: 'user', content: 'Inspect src/index.ts and preserve the API contract.' },
    ]
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]
    const accounting = {
      toolDefinitions: 12, toolCalls: 0, toolResults: 0, summaries: 0, skills: 0,
      systemNotices: 8, instructions: 0, repository: 0, skillDescriptors: 0,
      loadedSkills: 0, multimodal: 0, other: 28, total: 48,
    }
    const destination = await captureProviderTrace({
      sessionId: 'session-private-id', turnId: 'turn-private-id', round: 2,
      provider: 'anthropic', model: 'claude-test', contextWindow: 200_000,
      contextSource: 'provider-profile', maxOutputTokens: 8_192, usableTokens: 150_000,
      messages, tools, accounting, estimatedMessageTokens: 36,
      providerTokenCount: { inputTokens: 51, source: 'anthropic-count-tokens' },
      providerUsage: { inputTokens: 50, outputTokens: 7, contextTokens: 51, cacheReadTokens: 4, cacheWriteTokens: 0 },
      assistantText: 'Done.', assistantReasoning: 'Checked the route.', assistantToolCalls: [],
      recordedAt: 1_800_000_000_000,
    })
    assert.ok(destination)
    const file = await fs.readFile(destination, 'utf8')
    const trace = JSON.parse(file)
    assert.deepEqual(trace.request.messages, messages)
    assert.deepEqual(trace.request.tools, tools)
    assert.equal(trace.request.sha256.length, 64)
    assert.equal(trace.measurement.providerNativeCount.inputTokens, 51)
    assert.equal(trace.measurement.providerUsage.inputTokens, 50)
    assert.equal(trace.route.provider, 'anthropic')
    assert.equal(trace.route.apiKey, undefined)
    assert.equal(trace.endpoint, undefined)
    assert.equal(trace.sessionId, undefined)
    assert.equal(trace.sessionIdHash.length, 64)
    assert.equal(trace.privacy.containsPromptContent, true)
    assert.equal((await fs.stat(destination)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
    assert.equal(await fs.readdir(directory).then(rows => rows.some(name => name.endsWith('.tmp'))), false)
  } finally {
    if (originalTraceDir === undefined) delete process.env.TERMAGENT_PROVIDER_TRACE_DIR
    else process.env.TERMAGENT_PROVIDER_TRACE_DIR = originalTraceDir
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H trace replay verifies payload identity and compares full estimator footprint to provider usage', async () => {
  const root = await temp('termagent-14h-provider-replay-')
  process.env.TERMAGENT_PROVIDER_TRACE_DIR = root
  try {
    await captureProviderTrace({
      sessionId: 'session-a', turnId: 'turn-a', round: 0,
      provider: 'gemini', model: 'gemini-test', contextWindow: 128_000,
      contextSource: 'provider-profile', maxOutputTokens: 8_192, usableTokens: 96_000,
      messages: [{ role: 'system', content: 'System.' }, { role: 'user', content: 'Explain the API.' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
      accounting: {
        toolDefinitions: 10, toolCalls: 0, toolResults: 0, summaries: 0, skills: 0,
        systemNotices: 7, instructions: 0, repository: 0, skillDescriptors: 0,
        loadedSkills: 0, multimodal: 0, other: 16, total: 33,
      },
      estimatedMessageTokens: 23,
      providerTokenCount: { inputTokens: 38, source: 'gemini-count-tokens' },
      providerUsage: { inputTokens: 40, contextTokens: 40, outputTokens: 5, totalTokens: 45 },
    })
    await captureProviderTrace({
      sessionId: 'session-a', turnId: 'turn-a', round: 1,
      provider: 'openai-compatible', model: 'compat-test', contextWindow: 32_000,
      contextSource: 'conservative-fallback', maxOutputTokens: 2_048, usableTokens: 24_000,
      messages: [{ role: 'user', content: 'No usage in this provider response.' }],
      tools: [],
      accounting: {
        toolDefinitions: 0, toolCalls: 0, toolResults: 0, summaries: 0, skills: 0,
        systemNotices: 0, instructions: 0, repository: 0, skillDescriptors: 0,
        loadedSkills: 0, multimodal: 0, other: 10, total: 10,
      },
      estimatedMessageTokens: 10,
    })

    const traces = await loadProviderTraces(root)
    assert.equal(traces.length, 2)
    const report = analyzeProviderTraces(traces)
    assert.equal(report.captureCount, 2)
    assert.equal(report.providerReportedCount, 1)
    assert.equal(report.missingUsageCount, 1)
    assert.equal(report.providerUsageAvailable, true)
    assert.equal(report.exactPayloadsVerified, true)
    assert.equal(report.cleanEquivalentCompactionAB, false)
    assert.equal(report.samples[0].observedContextTokens, 40)
    assert.equal(report.samples[0].providerNativeCount, 38)
    assert.equal(report.samples[0].requestDriftTokens, report.samples[0].estimatedRequestTokens - 40)
    assert.equal(report.routes[0].provider, 'gemini')

    const tampered = structuredClone(traces[0])
    tampered.request.messages[1].content = 'tampered'
    assert.throws(() => analyzeProviderTraces([tampered]), /SHA-256 mismatch/)
  } finally {
    if (originalTraceDir === undefined) delete process.env.TERMAGENT_PROVIDER_TRACE_DIR
    else process.env.TERMAGENT_PROVIDER_TRACE_DIR = originalTraceDir
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H provider replay rejects arbitrary or malformed input files', async () => {
  const root = await temp('termagent-14h-provider-invalid-')
  try {
    const file = path.join(root, 'invalid.json')
    await fs.writeFile(file, JSON.stringify({ hello: 'world' }))
    await assert.rejects(loadProviderTraces(file), /unsupported or invalid TermAgent provider trace format/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H Agent.run captures the exact completed provider request without serializing provider configuration credentials', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const root = await temp('termagent-14h-agent-trace-')
  const directory = path.join(root, 'provider-traces')
  process.env.TERMAGENT_PROVIDER_TRACE_DIR = directory
  try {
    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, 'claude-trace-test')
    const observed = []
    const provider = {
      id: 'anthropic',
      model: 'claude-trace-test',
      config: {
        provider: 'anthropic', model: 'claude-trace-test',
        baseUrl: 'https://api.example.test/v1?api_key=must-not-be-captured',
        apiKey: 'sk-ant-test-secret-must-not-be-captured',
        contextWindow: 32_000, maxOutputTokens: 2_048,
      },
      async *stream(messages, tools) {
        observed.push({ messages: structuredClone(messages), tools: structuredClone(tools) })
        yield { type: 'usage', usage: { inputTokens: 31, contextTokens: 31, outputTokens: 4, totalTokens: 35 } }
        yield { type: 'text', delta: 'captured response' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const agent = new Agent(provider, new ToolRegistry(), sessions, 0, 8_000, 1)
    await agent.run({
      sessionId: session.id,
      messages: [{ role: 'user', content: 'Use the existing provider adapter and summarize the API.' }],
      cwd: root,
      instructions: 'Keep the existing API contract.',
      prompt: 'Summarize this API.',
    })

    assert.equal(observed.length, 1)
    const files = await fs.readdir(directory)
    assert.equal(files.length, 1)
    const capture = JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8'))
    assert.deepEqual(capture.request.messages, observed[0].messages)
    assert.deepEqual(capture.request.tools, observed[0].tools)
    assert.equal(capture.measurement.providerUsage.inputTokens, 31)
    assert.equal(capture.response.text, 'captured response')
    const serialized = JSON.stringify(capture)
    assert.doesNotMatch(serialized, /must-not-be-captured/)
    assert.doesNotMatch(serialized, /sk-ant-test-secret/)
    assert.equal(capture.privacy.providerConfigurationCaptured, false)
    assert.equal(capture.privacy.promptOrResponseContentMayContainSecrets, true)
  } finally {
    if (originalTraceDir === undefined) delete process.env.TERMAGENT_PROVIDER_TRACE_DIR
    else process.env.TERMAGENT_PROVIDER_TRACE_DIR = originalTraceDir
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('14H Agent.run does not capture a provider request that ends in failure', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const root = await temp('termagent-14h-agent-trace-failure-')
  const directory = path.join(root, 'provider-traces')
  process.env.TERMAGENT_PROVIDER_TRACE_DIR = directory
  try {
    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, 'failed-trace-test')
    const provider = {
      id: 'anthropic', model: 'claude-failure-test',
      config: { provider: 'anthropic', model: 'claude-failure-test', baseUrl: 'https://api.example.test/v1', contextWindow: 32_000 },
      async *stream() { throw new Error('provider request failed') },
    }
    const agent = new Agent(provider, new ToolRegistry(), sessions, 0, 8_000, 1)
    await assert.rejects(agent.run({
      sessionId: session.id, messages: [{ role: 'user', content: 'fail' }], cwd: root,
      instructions: '', prompt: 'trigger failure',
    }), /provider request failed/)
    await assert.rejects(fs.readdir(directory), error => error.code === 'ENOENT')
  } finally {
    if (originalTraceDir === undefined) delete process.env.TERMAGENT_PROVIDER_TRACE_DIR
    else process.env.TERMAGENT_PROVIDER_TRACE_DIR = originalTraceDir
    await fs.rm(root, { recursive: true, force: true })
  }
})


test('14H adaptive calibration replay uses only prior usage and decays prior calibration across compaction', () => {
  const hash = value => createHash('sha256').update(value).digest('hex')
  const sessionId = 'session-calibration'
  const turnA = 'turn-calibration-a'
  const turnB = 'turn-calibration-b'
  const route = { provider: 'openai-compatible', model: 'mercury-test', contextWindow: 2_000, usableTokens: 500 }
  const captures = [
    { turnId: turnA, round: 0, capturedAt: 200, estimated: 100, observed: 200 },
    { turnId: turnA, round: 1, capturedAt: 300, estimated: 120, observed: 240 },
    { turnId: turnA, round: 2, capturedAt: 400, estimated: 130, observed: 260 },
    { turnId: turnB, round: 0, capturedAt: 600, estimated: 140, observed: 280 },
  ].map((capture, index) => ({
    schemaVersion: 1,
    kind: 'termagent.provider-request-trace',
    traceId: `calibration-${index}`,
    sessionIdHash: hash(sessionId),
    turnIdHash: hash(capture.turnId),
    round: capture.round,
    capturedAt: capture.capturedAt,
    route,
    measurement: {
      estimatedRequestTokens: capture.estimated,
      observedContextTokens: capture.observed,
      observedInputTokens: capture.observed,
      providerNativeCount: null,
      providerUsage: { inputTokens: capture.observed, outputTokens: 4 },
      requestComponents: { toolDefinitions: 10 },
    },
  }))

  const sessionEvents = [
    { type: 'meta', ts: 90, data: { id: sessionId } },
    { type: 'turn', ts: 100, data: { id: turnA, status: 'started' } },
    { type: 'provider.usage', ts: 200, data: { turnId: turnA, round: 0, provider: route.provider, model: route.model, contextWindow: route.contextWindow, inputTokens: 200, outputTokens: 4, estimateRequestTokens: 100, estimated: false } },
    { type: 'provider.usage', ts: 300, data: { turnId: turnA, round: 1, provider: route.provider, model: route.model, contextWindow: route.contextWindow, inputTokens: 240, outputTokens: 4, estimateRequestTokens: 120, estimated: false } },
    { type: 'compaction', ts: 350, data: { stage: 'full-compaction' } },
    { type: 'provider.usage', ts: 400, data: { turnId: turnA, round: 2, provider: route.provider, model: route.model, contextWindow: route.contextWindow, inputTokens: 260, outputTokens: 4, estimateRequestTokens: 130, estimated: false } },
    { type: 'turn', ts: 450, data: { id: turnA, status: 'committed' } },
    { type: 'turn', ts: 500, data: { id: turnB, status: 'started' } },
    { type: 'provider.usage', ts: 600, data: { turnId: turnB, round: 0, provider: route.provider, model: route.model, contextWindow: route.contextWindow, inputTokens: 280, outputTokens: 4, estimateRequestTokens: 140, estimated: false } },
  ]

  const result = analyzeRuntimeCalibration(captures, sessionEvents)
  assert.equal(result.available, true)
  assert.equal(result.sessionIdentityMatched, true)
  assert.equal(result.matchedTurns, 2)
  assert.equal(result.skippedTurns, 0)
  assert.equal(result.matchedUsageEvents, 4)
  assert.equal(result.mismatchedUsageEvents, 0)
  assert.equal(result.compactionCount, 1)
  assert.equal(result.compactionBoundaries, 1)
  assert.equal(result.calibrationPolicy, 'decay')
  assert.equal(result.calibrationDecayFactor, 0.75)
  assert.deepEqual(result.samples.map(sample => sample.adaptiveEstimatedRequestTokens), [100, 240, 228, 280])
  assert.deepEqual(result.samples.map(sample => sample.providerTokenRatio), [1, 2, 1.75, 2])
  assert.deepEqual(result.samples.map(sample => sample.calibrationSource), ['cold-start-estimate', 'measured-baseline+rolling-route-ratio', 'compaction-epoch-prior', 'measured-baseline+rolling-route-ratio'])
  assert.ok(Math.abs(result.aggregateSignedErrorPercent - (-13.46938775510204)) < 1e-9)

  const carry = analyzeRuntimeCalibration(captures, sessionEvents, { mode: 'carry' })
  const reset = analyzeRuntimeCalibration(captures, sessionEvents, { mode: 'reset' })
  assert.deepEqual(carry.samples.map(sample => sample.adaptiveEstimatedRequestTokens), [100, 240, 260, 280])
  assert.deepEqual(reset.samples.map(sample => sample.adaptiveEstimatedRequestTokens), [100, 240, 130, 280])
  assert.equal(result.samples[0].adaptiveEstimatedRequestTokens, 100, 'the first prediction must not use its own provider usage')
  assert.equal(result.adaptiveMissedBudgetCrossingCount, 0)
})

test('14H adaptive calibration replay refuses a session log with a different identity', () => {
  const result = analyzeRuntimeCalibration([
    {
      sessionIdHash: 'a'.repeat(64),
      turnIdHash: 'b'.repeat(64),
      round: 0,
      capturedAt: 200,
      route: { provider: 'openai-compatible', model: 'mercury-test', contextWindow: 2_000, usableTokens: 500 },
      measurement: { estimatedRequestTokens: 100, observedContextTokens: 200 },
    },
  ], [
    { type: 'meta', ts: 90, data: { id: 'different-session' } },
    { type: 'turn', ts: 100, data: { id: 'turn-a', status: 'started' } },
  ])
  assert.equal(result.available, false)
  assert.equal(result.sessionIdentityMatched, false)
  assert.match(result.reason, /identity does not match/)
})

test('14H adaptive calibration replay resets route samples and baseline when the provider route changes', () => {
  const sessionId = 'session-route-switch'
  const turnId = 'turn-route-switch'
  const hash = value => createHash('sha256').update(value).digest('hex')
  const makeTrace = (round, capturedAt, provider, estimate, observed) => ({
    sessionIdHash: hash(sessionId),
    turnIdHash: hash(turnId),
    round,
    capturedAt,
    route: { provider, model: 'model-a', contextWindow: 2_000, usableTokens: 500 },
    measurement: {
      estimatedRequestTokens: estimate,
      observedContextTokens: observed,
      providerUsage: { inputTokens: observed, outputTokens: 3 },
      requestComponents: { toolDefinitions: 5 },
    },
  })
  const result = analyzeRuntimeCalibration([
    makeTrace(0, 200, 'provider-a', 100, 200),
    makeTrace(1, 300, 'provider-b', 120, 180),
  ], [
    { type: 'meta', ts: 90, data: { id: sessionId } },
    { type: 'turn', ts: 100, data: { id: turnId, status: 'started' } },
  ])
  assert.equal(result.available, true)
  assert.deepEqual(result.samples.map(sample => sample.providerTokenRatio), [1, 1])
  assert.equal(result.samples[1].adaptiveEstimatedRequestTokens, 120)
  assert.equal(result.samples[1].calibrationSource, 'cold-start-estimate')
})
