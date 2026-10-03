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
