import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const tempDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'termagent-13f-'))

async function withEnv(name, value, fn) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try { return await fn() } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test('13F store bounds oversized output by bytes and lines while retaining the full file', async () => {
  const { ToolOutputStore } = await import('../dist/agent/tool-output-store.js')
  const root = await tempDir()
  try {
    const store = new ToolOutputStore({ root, maxLines: 6, maxBytes: 256 })
    const source = Array.from({ length: 40 }, (_, i) => `line-${i.toString().padStart(2, '0')}-xxxxxxxx`).join('\n')
    const result = await store.bind({ sessionId: 'session-a', toolCallId: 'call-a', text: source, metadata: { kind: 'report' } })
    assert.equal(result.truncated, true)
    assert.equal(result.persisted, true)
    assert.equal((await fs.readFile(result.outputPath, 'utf8')), source)
    assert.ok(Buffer.byteLength(result.text, 'utf8') <= 256)
    assert.ok(result.text.includes('line-00'))
    assert.ok(result.text.includes('line-39'))
    assert.match(result.text, /tool-output:\/\/[a-f0-9]{64}/)
    assert.equal(result.totalLines, 40)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('13F same tool-call id reuses persisted output without rewriting the text file', async () => {
  const { ToolOutputStore } = await import('../dist/agent/tool-output-store.js')
  const root = await tempDir()
  try {
    const store = new ToolOutputStore({ root, maxBytes: 256, maxLines: 2 })
    const input = { sessionId: 'session-a', toolCallId: 'call-stable', text: 'HEAD\n' + 'x'.repeat(200) + '\nTAIL', metadata: { status: 'ok' } }
    const first = await store.bind(input)
    const stat1 = await fs.stat(first.outputPath)
    await new Promise(resolve => setTimeout(resolve, 25))
    const second = await store.bind(input)
    const stat2 = await fs.stat(second.outputPath)
    assert.equal(second.reference, first.reference)
    assert.equal(second.outputPath, first.outputPath)
    assert.equal(stat2.mtimeMs, stat1.mtimeMs)
    assert.equal(await fs.readFile(second.outputPath, 'utf8'), input.text)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('13F stores tool metadata separately from the text preview', async () => {
  const { ToolOutputStore } = await import('../dist/agent/tool-output-store.js')
  const root = await tempDir()
  try {
    const store = new ToolOutputStore({ root, maxBytes: 256, maxLines: 2 })
    const metadata = { structured: { kind: 'report', count: 3 }, attachments: [{ uri: 'file:///tmp/a.png', mime: 'image/png' }] }
    const result = await store.bind({ sessionId: 's', toolCallId: 'c', text: 'a'.repeat(400), metadata })
    const saved = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'))
    assert.deepEqual(saved.metadata, metadata)
    assert.equal(saved.contentHash, result.contentHash)
    assert.equal(saved.totalBytes, result.totalBytes)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('13F read_file can deliberately retrieve a persisted tool result by virtual reference', async () => {
  const { ToolOutputStore } = await import('../dist/agent/tool-output-store.js')
  const { builtinTools } = await import('../dist/tools/builtin.js')
  const root = await tempDir()
  await withEnv('TERMAGENT_TOOL_OUTPUT_ROOT', root, async () => {
    try {
      const store = new ToolOutputStore({ root, maxBytes: 256, maxLines: 2 })
      const source = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')
      const persisted = await store.bind({ sessionId: 's', toolCallId: 'c', text: source })
      const read = builtinTools({ timeout: 1000, maxOutput: 2000 })[0]
      const page = await read.execute({ path: persisted.reference, startLine: 3, endLine: 4 }, { cwd: root, abort: new AbortController().signal })
      assert.match(page.output, /3: line-2/)
      assert.match(page.output, /4: line-3/)
      assert.equal(page.metadata.toolOutput.reference, persisted.reference)
      assert.equal(page.metadata.toolOutput.totalLines, 20)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})

test('13F retention cleanup removes only expired managed files', async () => {
  const { ToolOutputStore } = await import('../dist/agent/tool-output-store.js')
  const root = await tempDir()
  try {
    const store = new ToolOutputStore({ root, retentionDays: 1, maxBytes: 256, maxLines: 1 })
    const result = await store.bind({ sessionId: 's', toolCallId: 'c', text: Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n') })
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    await fs.utimes(result.outputPath, old, old)
    await fs.utimes(result.metadataPath, old, old)
    await fs.writeFile(path.join(root, 'keep.txt'), 'keep')
    const removed = await store.cleanup()
    assert.equal(removed, 2)
    assert.equal(await fs.stat(path.join(root, 'keep.txt')).then(() => true, () => false), true)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('13F context accounting uses one estimator across definitions, calls and results', async () => {
  const { accountContext } = await import('../dist/context/budget.js')
  const messages = [
    { role: 'system', content: '## Skills\nUse skill discovery.\n## Next Move\nContinue.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'grep', content: 'x'.repeat(400) },
  ]
  const tools = [{ type: 'function', function: { name: 'grep', description: 'Search', parameters: { type: 'object' } } }]
  const accounting = accountContext(messages, tools)
  assert.ok(accounting.toolDefinitions > 0)
  assert.ok(accounting.toolCalls > 0)
  assert.ok(accounting.toolResults > 0)
  assert.ok(accounting.skills > 0 || accounting.summaries > 0)
  assert.equal(accounting.total, accounting.toolDefinitions + accounting.toolCalls + accounting.toolResults + accounting.summaries + accounting.skills + accounting.systemNotices + accounting.other)
})

test('13F compatibility helper still produces bounded head/tail summaries for legacy callers', async () => {
  const { summarizeToolOutput } = await import('../dist/agent/tool-output.js')
  const source = ['HEAD', ...Array.from({ length: 500 }, (_, i) => `line-${i}`), 'TAIL'].join('\n')
  const out = summarizeToolOutput(source, 900)
  assert.ok(out.length <= 1200)
  assert.match(out, /HEAD/)
  assert.match(out, /TAIL/)
  assert.match(out, /tool output summarized/)
})
test('13F large tool output stays bounded enough to avoid premature full-session compaction', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { estimateMessagesTokens } = await import('../dist/context/budget.js')
  const root = await tempDir()
  const outputRoot = path.join(root, 'tool-output')
  await withEnv('TERMAGENT_TOOL_OUTPUT_ROOT', outputRoot, async () => {
    try {
      const sessionStore = new SessionStore(path.join(root, 'sessions'))
      const session = await sessionStore.create(root, 'mock')
      const gate = new PermissionGate('auto')
      const registry = new ToolRegistry(gate)
      const huge = Array.from({ length: 20000 }, (_, i) => `oversized-${i}-${'x'.repeat(30)}`).join('\n')
      registry.add({
        name: 'emit_huge', risk: 'read', description: 'Emit a huge deterministic output.', schema: { type: 'object' },
        async execute() { return { output: huge } },
      })
      const provider = {
        id: 'mock', model: 'mock', calls: 0, seen: [],
        async *stream(messages, tools) {
          this.calls++
          this.seen.push({ messages, tools })
          if (this.calls === 1) {
            yield { type: 'tool_call', call: { id: 'call-huge-budget', type: 'function', function: { name: 'emit_huge', arguments: '{}' } } }
            yield { type: 'done', finishReason: 'tool_calls' }
            return
          }
          yield { type: 'text', delta: 'finished' }
          yield { type: 'done', finishReason: 'stop' }
        },
      }
      const agent = new Agent(provider, registry, sessionStore, 2, 12000, 1, undefined, [], {}, undefined, {
        root: outputRoot,
        maxBytes: 2048,
        maxLines: 80,
        retentionDays: 7,
      })
      const messages = []
      await agent.run({ sessionId: session.id, messages, cwd: root, instructions: '', prompt: 'emit huge output and finish' })
      assert.equal(provider.calls, 2)
      const compactions = (await sessionStore.load(session.id)).events.filter(event => event.type === 'compaction')
      assert.equal(compactions.length, 0, 'large output should not force compaction once stored out-of-band')
      const secondRequest = provider.seen[1]
      assert.ok(secondRequest)
      const secondTokens = estimateMessagesTokens(secondRequest.messages)
      assert.ok(secondTokens < 1500, `bounded second request messages were ${secondTokens} tokens`)
      const stored = secondRequest.messages.find(message => message.role === 'tool')
      assert.ok(stored)
      assert.match(stored.content, /tool-output:\/\/[a-f0-9]{64}/)
      assert.ok(Buffer.byteLength(stored.content, 'utf8') <= 2048)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})

test('13F agent stores a large tool result and exposes only the bounded provider-facing projection', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { promises: fs } = await import('node:fs')
  const root = await tempDir()
  const outputRoot = path.join(root, 'tool-output')
  await withEnv('TERMAGENT_TOOL_OUTPUT_ROOT', outputRoot, async () => {
    try {
      const sessionStore = new SessionStore(path.join(root, 'sessions'))
      const session = await sessionStore.create(root, 'mock')
      const gate = new PermissionGate('auto')
      const registry = new ToolRegistry(gate)
      const huge = Array.from({ length: 6000 }, (_, i) => `important-line-${i}`).join('\n')
      registry.add({
        name: 'emit_large', risk: 'read', description: 'Emit a large deterministic output.', schema: { type: 'object' },
        async execute() { return { output: huge, metadata: { structured: { kind: 'fixture', count: 6000 } } } },
      })
      let calls = 0
      const provider = {
        id: 'mock', model: 'mock',
        async *stream(messages) {
          calls++
          if (calls === 1) yield { type: 'tool_call', call: { id: 'call-large', type: 'function', function: { name: 'emit_large', arguments: '{}' } } }
          else yield { type: 'text', delta: 'done' }
        },
      }
      const messages = []
      const agent = new Agent(provider, registry, sessionStore, 2, 12000, 1, undefined, [], {}, undefined, { root: outputRoot, maxBytes: 1024, maxLines: 80, retentionDays: 7 })
      await agent.run({ sessionId: session.id, messages, cwd: root, instructions: '', prompt: 'emit it' })
      const toolMessage = messages.find(m => m.role === 'tool')
      assert.ok(toolMessage)
      assert.ok((toolMessage.content || '').length < 2000)
      assert.match(toolMessage.content, /tool-output:\/\/[a-f0-9]{64}/)
      assert.ok((toolMessage.content || '').includes('important-line-0'))
      assert.ok((toolMessage.content || '').includes('important-line-5999'))
      const files = await fs.readdir(outputRoot)
      assert.equal(files.filter(name => name.endsWith('.log')).length, 1)
      assert.equal(await fs.readFile(path.join(outputRoot, files.find(name => name.endsWith('.log'))), 'utf8'), huge)
      assert.equal((await sessionStore.load(session.id)).messages.find(m => m.role === 'tool')?.content, toolMessage.content)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})
