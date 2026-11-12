import test from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicProvider } from '../dist/providers/anthropic.js'
import { GeminiProvider } from '../dist/providers/gemini.js'

const tools = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a source file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}]
const messages = [
  { role: 'system', content: 'Follow project instructions.' },
  { role: 'user', content: 'Inspect the current implementation.' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } }] },
  { role: 'tool', tool_call_id: 'call-1', name: 'read_file', content: 'export const ready = true' },
]

test('Anthropic native count includes converted messages, system prompt, tools, and thinking config', async () => {
  const previousFetch = global.fetch
  let request
  global.fetch = async (url, options) => {
    request = { url: String(url), headers: options.headers, body: JSON.parse(options.body) }
    return new Response(JSON.stringify({ input_tokens: 412 }), { status: 200 })
  }
  try {
    const provider = new AnthropicProvider({
      model: 'claude-test',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test-key',
      reasoningEffort: 'medium',
    })
    const result = await provider.countTokens(messages, tools, new AbortController().signal)
    assert.deepEqual(result, { inputTokens: 412, source: 'anthropic-count-tokens' })
    assert.equal(request.url, 'https://api.anthropic.com/v1/messages/count_tokens')
    assert.equal(request.headers['x-api-key'], 'test-key')
    assert.equal(request.headers['anthropic-version'], '2023-06-01')
    assert.equal(request.body.system, 'Follow project instructions.')
    assert.equal(request.body.messages[1].content[0].type, 'tool_use')
    assert.equal(request.body.messages[2].content[0].type, 'tool_result')
    assert.equal(request.body.tools[0].input_schema.required[0], 'path')
    assert.deepEqual(request.body.thinking, { type: 'enabled', budget_tokens: 4096 })
    assert.equal(Object.hasOwn(request.body, 'max_tokens'), false)
    assert.equal(Object.hasOwn(request.body, 'stream'), false)
  } finally {
    global.fetch = previousFetch
  }
})

test('Anthropic count endpoint unsupported by a gateway is cached as unavailable', async () => {
  const previousFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    return new Response('not supported', { status: 404 })
  }
  try {
    const provider = new AnthropicProvider({ model: 'claude-test', baseUrl: 'https://gateway.example/v1', apiKey: 'k' })
    assert.equal(await provider.countTokens(messages, [], new AbortController().signal), undefined)
    assert.equal(await provider.countTokens(messages, [], new AbortController().signal), undefined)
    assert.equal(calls, 1)
  } finally {
    global.fetch = previousFetch
  }
})

test('Anthropic native count preserves fail-fast authentication errors', async () => {
  const previousFetch = global.fetch
  global.fetch = async () => new Response('invalid key', { status: 401 })
  try {
    const provider = new AnthropicProvider({ model: 'claude-test', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'bad' })
    await assert.rejects(provider.countTokens(messages, [], new AbortController().signal), error => error.status === 401)
  } finally {
    global.fetch = previousFetch
  }
})


test('Anthropic request-specific 400 does not permanently disable native counting', async () => {
  const previousFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    return calls === 1
      ? new Response('request-specific count limitation', { status: 400 })
      : new Response(JSON.stringify({ input_tokens: 90 }), { status: 200 })
  }
  try {
    const provider = new AnthropicProvider({ model: 'claude-test', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k' })
    assert.equal(await provider.countTokens(messages, [], new AbortController().signal), undefined)
    assert.deepEqual(await provider.countTokens(messages, [], new AbortController().signal), { inputTokens: 90, source: 'anthropic-count-tokens' })
    assert.equal(calls, 2)
  } finally {
    global.fetch = previousFetch
  }
})

test('Gemini unsupported count endpoint is cached without hiding authentication failures', async () => {
  const previousFetch = global.fetch
  let calls = 0
  global.fetch = async () => {
    calls++
    return new Response('not supported', { status: 404 })
  }
  try {
    const provider = new GeminiProvider({ model: 'gemini-test', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'k' })
    assert.equal(await provider.countTokens(messages, [], new AbortController().signal), undefined)
    assert.equal(await provider.countTokens(messages, [], new AbortController().signal), undefined)
    assert.equal(calls, 1)
  } finally {
    global.fetch = previousFetch
  }
  global.fetch = async () => new Response('permission denied', { status: 403 })
  try {
    const provider = new GeminiProvider({ model: 'gemini-test', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'bad' })
    await assert.rejects(provider.countTokens(messages, [], new AbortController().signal), error => error.status === 403)
  } finally {
    global.fetch = previousFetch
  }
})

test('Gemini native count includes function declarations and system instruction but omits generation config', async () => {
  const previousFetch = global.fetch
  let request
  global.fetch = async (url, options) => {
    request = { url: String(url), headers: options.headers, body: JSON.parse(options.body) }
    return new Response(JSON.stringify({ totalTokens: 287 }), { status: 200 })
  }
  try {
    const provider = new GeminiProvider({
      model: 'gemini-test',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'test-key',
      maxOutputTokens: 1024,
      temperature: 0.1,
    })
    const result = await provider.countTokens(messages, tools, new AbortController().signal)
    assert.deepEqual(result, { inputTokens: 287, source: 'gemini-count-tokens' })
    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:countTokens')
    assert.equal(request.headers['x-goog-api-key'], 'test-key')
    assert.equal(request.body.systemInstruction.parts[0].text, 'Follow project instructions.')
    assert.equal(request.body.contents[1].parts[0].functionCall.name, 'read_file')
    assert.equal(request.body.contents[2].parts[0].functionResponse.name, 'read_file')
    assert.equal(request.body.tools[0].functionDeclarations[0].name, 'read_file')
    assert.equal(Object.hasOwn(request.body, 'generationConfig'), false)
  } finally {
    global.fetch = previousFetch
  }
})
