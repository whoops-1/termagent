import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AnthropicProvider } from '../dist/providers/anthropic.js'
import { GeminiProvider } from '../dist/providers/gemini.js'
import { OpenAICompatibleProvider } from '../dist/providers/openai-compatible.js'
import { ProviderRouter } from '../dist/providers/router.js'
import { createReplayProvider, readFixture, recordProviderStream, writeFixture } from '../dist/providers/recorder.js'

const signal = new AbortController().signal
const noTools = []
const noMessages = []

class ScriptedProvider {
  constructor(events, error) { this.events = events; this.error = error }
  get id() { return 'scripted' }
  get model() { return 'scripted-model' }
  get config() { return { model: 'scripted-model', baseUrl: '' } }
  get capabilities() { return { streaming: true, toolCalls: true, supportsToolCallIds: true, reasoning: true, structuredOutput: false } }
  async *stream() {
    for (const event of this.events) yield event
    if (this.error) throw new Error(this.error)
  }
}

const scriptedEvents = [
  { type: 'reasoning', delta: 'think' },
  { type: 'text', delta: 'hello ' },
  { type: 'text', delta: 'world' },
  { type: 'tool_call', call: { id: 'call_x', type: 'function', function: { name: 'grep', arguments: '{"pattern":"y"}' } } },
  { type: 'done', finishReason: 'tool_calls' },
]

test('16F adapters expose honest capability metadata', () => {
  const oai = new OpenAICompatibleProvider({ model: 'm', baseUrl: 'http://x' })
  assert.deepEqual(oai.capabilities, { streaming: true, toolCalls: true, supportsToolCallIds: true, reasoning: true, structuredOutput: false })
  const anthropic = new AnthropicProvider({ model: 'm', baseUrl: 'http://x', apiKey: 'k' })
  assert.deepEqual(anthropic.capabilities, { streaming: true, toolCalls: true, supportsToolCallIds: true, reasoning: true, structuredOutput: false })
  const gemini = new GeminiProvider({ model: 'm', baseUrl: 'http://x', apiKey: 'k' })
  assert.equal(gemini.capabilities.supportsToolCallIds, false)
  assert.equal(gemini.capabilities.streaming, true)
  const router = new ProviderRouter([oai, gemini])
  assert.deepEqual(router.capabilities, oai.capabilities)
})

test('16F record then replay is deterministic and byte-identical across runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-p16f-'))
  try {
    const first = await recordProviderStream(new ScriptedProvider(scriptedEvents), noMessages, noTools, signal)
    assert.deepEqual(first.events, scriptedEvents)
    assert.equal(first.error, undefined)

    const fileA = path.join(root, 'a.jsonl')
    const fileB = path.join(root, 'b.jsonl')
    await writeFixture(fileA, first)
    await writeFixture(fileB, first)
    assert.equal(await readFile(fileA, 'utf8'), await readFile(fileB, 'utf8'))

    const loaded = await readFixture(fileA)
    assert.deepEqual(loaded.events, scriptedEvents)
    const replay = createReplayProvider(loaded)
    const collected = []
    for await (const event of replay.stream(noMessages, noTools, signal)) collected.push(event)
    assert.deepEqual(collected, scriptedEvents)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('16F static fixture replays the recorded stream exactly', async () => {
  const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'provider-replay-sample.jsonl')
  const recorded = await readFixture(fixturePath)
  assert.equal(recorded.events.length, 5)
  const replay = createReplayProvider(recorded)
  const collected = []
  for await (const event of replay.stream(noMessages, noTools, signal)) collected.push(event)
  assert.deepEqual(collected, recorded.events)
  assert.equal(collected[0].type, 'reasoning')
  assert.equal(collected[3].type, 'tool_call')
  assert.equal(collected[3].call.function.name, 'read_file')
  assert.equal(collected[4].finishReason, 'tool_calls')
})

test('16F recorder captures provider errors and replay rethrows them', async () => {
  const recorded = await recordProviderStream(new ScriptedProvider([{ type: 'text', delta: 'partial' }], 'boom'), noMessages, noTools, signal)
  assert.equal(recorded.error, 'boom')
  const replay = createReplayProvider(recorded)
  const collected = []
  await assert.rejects(async () => {
    for await (const event of replay.stream(noMessages, noTools, signal)) collected.push(event)
  }, /boom/)
  assert.deepEqual(collected, [{ type: 'text', delta: 'partial' }])
})

test('16F replay honors abort between events', async () => {
  const replay = createReplayProvider({ events: scriptedEvents })
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(async () => {
    for await (const _event of replay.stream(noMessages, noTools, aborted.signal)) { /* noop */ }
  }, /Provider turn interrupted/)
})
