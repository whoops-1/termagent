import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { withRetry, retryDelay, isRetryableError } from '../dist/agent/retry.js'
import { sseLines } from '../dist/providers/sse.js'
import { ProviderHttpError, ProviderStreamIdleError } from '../dist/providers/errors.js'
import { OpenAICompatibleProvider } from '../dist/providers/openai-compatible.js'
import { AnthropicProvider } from '../dist/providers/anthropic.js'
import { GeminiProvider } from '../dist/providers/gemini.js'
import { Agent } from '../dist/agent/agent.js'
import { SessionStore } from '../dist/session/store.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const abortSignal = new AbortController().signal

function streamResponse(lines) {
  const body = lines.map(x => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}


test('14H OpenAI-compatible usage normalizes Chat cache/reasoning details and Responses-style aliases', async () => {
  const oldFetch = global.fetch
  const fixtures = [
    {
      usage: {
        prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
        prompt_tokens_details: { cached_tokens: 500, cache_write_tokens: 25 },
        completion_tokens_details: { reasoning_tokens: 40 },
      },
      choices: [],
    },
    {
      choices: [{ usage: {
        input_tokens: 300, output_tokens: 50, total_tokens: 350,
        input_tokens_details: { cached_tokens: 100, cache_write_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 15 },
      } }],
    },
    {
      usage: {
        prompt_tokens: 80, completion_tokens: 12, total_tokens: 92,
        prompt_cache_hit_tokens: 60, cache_created_input_tokens: 4,
      },
      choices: [],
    },
  ]
  global.fetch = async () => streamResponse([...fixtures, '[DONE]'])
  try {
    const provider = new OpenAICompatibleProvider({ model: 'usage-model', baseUrl: 'https://gateway.test/v1' })
    const events = []
    for await (const event of provider.stream([], [], abortSignal)) if (event.type === 'usage') events.push(event.usage)
    assert.deepEqual(events, [
      { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 500, cacheWriteTokens: 25, reasoningTokens: 40 },
      { inputTokens: 300, outputTokens: 50, totalTokens: 350, cacheReadTokens: 100, cacheWriteTokens: 20, reasoningTokens: 15 },
      { inputTokens: 80, outputTokens: 12, totalTokens: 92, cacheReadTokens: 60, cacheWriteTokens: 4 },
    ])
  } finally {
    global.fetch = oldFetch
  }
})

test('14H Gemini usage includes thinking tokens in output totals without double-counting cached prompt tokens', async () => {
  const oldFetch = global.fetch
  global.fetch = async () => streamResponse([{
    usageMetadata: {
      promptTokenCount: 100, cachedContentTokenCount: 40,
      candidatesTokenCount: 10, thoughtsTokenCount: 6, totalTokenCount: 116,
    },
    candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
  }])
  try {
    const provider = new GeminiProvider({ model: 'gemini-usage', baseUrl: 'https://gemini.test', apiKey: 'key' })
    const events = []
    for await (const event of provider.stream([], [], abortSignal)) if (event.type === 'usage') events.push(event.usage)
    assert.deepEqual(events, [{ inputTokens: 100, contextTokens: 100, outputTokens: 16, totalTokens: 116, cacheReadTokens: 40, reasoningTokens: 6 }])
  } finally {
    global.fetch = oldFetch
  }
})

test('14H Anthropic final usage delta updates cumulative cache and reasoning fields', async () => {
  const oldFetch = global.fetch
  global.fetch = async () => streamResponse([
    { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 0, output_tokens_details: { thinking_tokens: 0 } } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'complete' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 60, cache_read_input_tokens: 20, cache_creation_input_tokens: 7, output_tokens: 18, output_tokens_details: { thinking_tokens: 6 } } },
    { type: 'message_stop' },
  ])
  try {
    const provider = new AnthropicProvider({ model: 'claude-usage', baseUrl: 'https://anthropic.test/v1', apiKey: 'key' })
    const events = []
    for await (const event of provider.stream([], [], abortSignal)) if (event.type === 'usage') events.push(event.usage)
    assert.deepEqual(events, [{ inputTokens: 60, outputTokens: 18, totalTokens: 105, contextTokens: 87, cacheReadTokens: 20, cacheWriteTokens: 7, reasoningTokens: 6, cacheTokensExcludedFromInput: true }])
  } finally {
    global.fetch = oldFetch
  }
})

test('14H Anthropic empty usage snapshots do not masquerade as a zero-token provider report', async () => {
  const oldFetch = global.fetch
  global.fetch = async () => streamResponse([
    { type: 'message_start', message: { usage: {} } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
  ])
  try {
    const provider = new AnthropicProvider({ model: 'claude-empty-usage', baseUrl: 'https://anthropic.test/v1', apiKey: 'key' })
    const events = []
    for await (const event of provider.stream([], [], abortSignal)) if (event.type === 'usage') events.push(event.usage)
    assert.deepEqual(events, [])
  } finally {
    global.fetch = oldFetch
  }
})

test('14H Anthropic iteration usage sums billed work but keeps final request context separate', async () => {
  const oldFetch = global.fetch
  global.fetch = async () => streamResponse([{
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { iterations: [
      { type: 'message', input_tokens: 80, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 20, output_tokens_details: { thinking_tokens: 3 } },
      { type: 'compaction', input_tokens: 40, cache_read_input_tokens: 4, cache_creation_input_tokens: 1, output_tokens: 8, output_tokens_details: { thinking_tokens: 2 } },
    ] },
  }])
  try {
    const provider = new AnthropicProvider({ model: 'claude-iterations', baseUrl: 'https://anthropic.test/v1', apiKey: 'key' })
    const events = []
    for await (const event of provider.stream([], [], abortSignal)) if (event.type === 'usage') events.push(event.usage)
    assert.deepEqual(events, [{ inputTokens: 120, outputTokens: 28, totalTokens: 168, contextTokens: 45, cacheReadTokens: 14, cacheWriteTokens: 6, reasoningTokens: 5, cacheTokensExcludedFromInput: true }])
  } finally {
    global.fetch = oldFetch
  }
})

test('14H Gemini usage accounts for tool-use prompt tokens and modality breakdowns', async () => {
  const oldFetch = global.fetch
  global.fetch = async () => streamResponse([{
    usageMetadata: {
      promptTokenCount: 90, cachedContentTokenCount: 30, toolUsePromptTokenCount: 12,
      candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 127,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 70 }, { modality: 'IMAGE', tokenCount: 20 }],
      cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 30 }],
      candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 19 }, { modality: 'IMAGE', tokenCount: 1 }],
      toolUsePromptTokensDetails: [{ modality: 'TEXT', tokenCount: 12 }],
    },
    candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
  }])
  try {
    const provider = new GeminiProvider({ model: 'gemini-modal-usage', baseUrl: 'https://gemini.test', apiKey: 'key' })
    const events = []
    for await (const event of provider.stream([], [], abortSignal)) if (event.type === 'usage') events.push(event.usage)
    assert.deepEqual(events, [{
      inputTokens: 102, contextTokens: 102, outputTokens: 25, totalTokens: 127,
      cacheReadTokens: 30, reasoningTokens: 5, toolUsePromptTokens: 12,
      modalityTokens: {
        prompt: { text: 70, image: 20 }, cached: { text: 30 },
        candidates: { text: 19, image: 1 }, toolUsePrompt: { text: 12 },
      },
    }])
  } finally {
    global.fetch = oldFetch
  }
})

function createOpenAiServer() {
  let calls = 0
  const server = http.createServer((req, res) => {
    calls += 1
    if (calls === 1) {
      res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '0.01' })
      res.end('rate limited')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n' + 'data: [DONE]\n\n')
  })
  return server
}

test('13N-F retry delay honors Retry-After and deterministic jitter', () => {
  assert.equal(retryDelay(1, undefined, 0), 500)
  assert.equal(retryDelay(2, undefined, 0), 1000)
  assert.equal(retryDelay(2, 275, 1), 275)
})

test('13N-F retry backoff is cancellation-aware', async () => {
  let attempts = 0
  const controller = new AbortController()
  const promise = withRetry(async () => {
    attempts += 1
    const error = new Error('temporary')
    error.status = 503
    throw error
  }, { max: 3, signal: controller.signal, random: () => 0 })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(promise, error => error?.code === 'ABORT_ERR')
  assert.equal(attempts, 1)
})

test('13N-F ProviderHttpError preserves status, headers, body, and Retry-After', () => {
  const error = new ProviderHttpError(429, 'slow down', { 'retry-after': '2', 'x-request-id': 'req-1' })
  assert.equal(error.status, 429)
  assert.equal(error.responseBody, 'slow down')
  assert.equal(error.headers['x-request-id'], 'req-1')
  assert.equal(error.retryAfterMs, 2000)
  assert.equal(isRetryableError(error), true)
})

test('13N-F OpenAI-compatible adapter retries 429 using Retry-After metadata', async () => {
  const server = createOpenAiServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    const provider = new OpenAICompatibleProvider({ model: 'm', baseUrl: `http://127.0.0.1:${port}` })
    let attempts = 0
    let output = ''
    await withRetry(async () => {
      attempts += 1
      output = ''
      for await (const event of provider.stream([{ role: 'user', content: 'x' }], [], abortSignal)) {
        if (event.type === 'text') output += event.delta
      }
      return output
    }, { max: 1, random: () => 0 })
    assert.equal(attempts, 2)
    assert.equal(output, 'ok')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('13N-F stream idle timeout is explicit and safe to retry only before output', async () => {
  const stalled = new ReadableStream({
    start() {},
  })
  const iterator = sseLines(stalled, undefined, { idleTimeoutMs: 20 })
  await assert.rejects(() => iterator.next(), error => error instanceof ProviderStreamIdleError && error.safeToRetry === true)

  const partial = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'))
    },
  })
  const second = sseLines(partial, undefined, { idleTimeoutMs: 20 })
  const first = await second.next()
  assert.equal(first.value, '{"ok":true}')
  await assert.rejects(() => second.next(), error => error instanceof ProviderStreamIdleError && error.safeToRetry === false)
})

test('13N-F partial streamed output is never retried from scratch', async () => {
  let attempts = 0
  const promise = withRetry(async () => {
    attempts += 1
    const error = new ProviderStreamIdleError(10, false)
    throw error
  }, { max: 3, random: () => 0 })
  await assert.rejects(promise, ProviderStreamIdleError)
  assert.equal(attempts, 1)
})

test('13N-F provider-specific reasoning parameters do not leak across adapters', async () => {
  const oldFetch = global.fetch
  const seen = []
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body)
    seen.push({ url: String(url), body })
    if (String(url).includes('/messages')) return streamResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }])
    if (String(url).includes(':streamGenerateContent')) return streamResponse([{ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }])
    return streamResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]'])
  }
  try {
    const signal = new AbortController().signal
    for await (const _ of new OpenAICompatibleProvider({ model: 'o', baseUrl: 'https://openai.test', reasoningEffort: 'high', streamIdleTimeoutMs: 20 }).stream([], [], signal)) {}
    for await (const _ of new AnthropicProvider({ model: 'a', baseUrl: 'https://anthropic.test/v1', apiKey: 'k', reasoningEffort: 'high', streamIdleTimeoutMs: 20 }).stream([], [], signal)) {}
    for await (const _ of new GeminiProvider({ model: 'g', baseUrl: 'https://gemini.test', apiKey: 'k', reasoningEffort: 'high', streamIdleTimeoutMs: 20 }).stream([], [], signal)) {}

    const openai = seen.find(x => x.url.includes('openai.test')).body
    const anthropic = seen.find(x => x.url.includes('anthropic.test')).body
    const gemini = seen.find(x => x.url.includes('gemini.test')).body
    assert.equal(openai.reasoning_effort, 'high')
    assert.equal(openai.thinking, undefined)
    assert.equal(anthropic.thinking.type, 'enabled')
    assert.equal(anthropic.reasoning_effort, undefined)
    assert.equal(gemini.generationConfig.thinkingConfig.thinkingBudget, 8192)
    assert.equal(gemini.thinking, undefined)
    assert.equal(gemini.reasoning_effort, undefined)
  } finally {
    global.fetch = oldFetch
  }
})

test('13N-F nested provider metadata round-trips unchanged through the session lifecycle', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-13n-f-metadata-'))
  const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-13n-f-session-'))
  try {
    const sessions = new SessionStore(sessionRoot)
    const session = await sessions.create(cwd, 'provider')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    registry.add(registry.providerHostedDefinition('remote_tool', 'mock-provider', 'remote-model'))
    const metadata = {
      trace: { requestId: 'req-7', nested: { flags: ['a', 'b'], score: 0.91 } },
      opaque: [{ k: 'v' }, 42, true],
    }
    let turn = 0
    const provider = {
      id: 'mock-provider',
      model: 'remote-model',
      async *stream() {
        turn += 1
        if (turn === 1) {
          const call = { id: 'remote-1', type: 'function', function: { name: 'remote_tool', arguments: '{}' } }
          yield { type: 'tool_call', call, providerExecuted: true, providerMetadata: metadata }
          yield { type: 'tool_result', call, output: 'remote-ok', providerExecuted: true, providerMetadata: metadata }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const agent = new Agent(provider, registry, sessions, 3, 6000, 0)
    await agent.run({ sessionId: session.id, messages: [], cwd, instructions: '', prompt: 'remote', mode: 'build' })
    const loaded = await sessions.load(session.id)
    const record = loaded.events.find(e => e.type === 'tool.call' && e.data.callId === 'remote-1')
    assert.deepEqual(record.data.providerMetadata, metadata)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
    await fs.rm(sessionRoot, { recursive: true, force: true })
  }
})

test('13N-F provider stream cancellation aborts promptly', async () => {
  const body = new ReadableStream({
    start() {},
  })
  const controller = new AbortController()
  const iterator = sseLines(body, controller.signal, { idleTimeoutMs: 0 })
  const next = iterator.next()
  setTimeout(() => controller.abort(), 15)
  await assert.rejects(next, error => error?.code === 'ABORT_ERR')
})
