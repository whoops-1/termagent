import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

async function gitRepo() {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-phase5-'))
  spawnSync('git', ['init', '-q'], { cwd: root })
  spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root })
  spawnSync('git', ['config', 'user.name', 'TermAgent Tests'], { cwd: root })
  await writeFile(path.join(root, 'README.md'), '# fixture\n')
  spawnSync('git', ['add', '.'], { cwd: root })
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: root })
  return root
}
test('phase 5: oversized dynamic repository context is bounded instead of blocking the turn', async()=>{
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { estimateMessagesTokens, estimateTokens } = await import('../dist/context/budget.js')
  const root=await mkdtemp(path.join(tmpdir(), 'termagent-p5-context-overflow-'))
  try {
    const store=new SessionStore(path.join(root,'sessions'));const session=await store.create(root,'mock')
    const provider={id:'mock',model:'mock',config:{maxTokens:100},calls:0,seen:[],async *stream(messages,tools){this.calls++;this.seen.push({messages,tools});yield {type:'text',delta:'ok'};yield {type:'done',finishReason:'stop'}}}
    const agent=new Agent(provider,new ToolRegistry(),store,0,1800,1)
    await agent.run({sessionId:session.id,messages:[],cwd:root,instructions:'test instructions',repositoryContext:'repo '.repeat(30000),skillsContext:'skill '.repeat(3000),prompt:'hi'})
    assert.equal(provider.calls,1)
    const system=provider.seen[0].messages.find(m=>m.role==='system')
    assert.ok(system)
    assert.match(system.content,/truncated to fit context budget/)
    assert.ok(estimateMessagesTokens(provider.seen[0].messages)+estimateTokens(provider.seen[0].tools)<=1656)
  } finally {
    await rm(root,{recursive:true,force:true})
  }
})
test('phase 5: default and custom editor keybinds resolve through one binding map', async () => {
  const { buildEditorKeybinds, parseKeybind } = await import('../dist/cli/keybinds.js')
  assert.equal(parseKeybind('ctrl+p'), '\x10')
  assert.equal(buildEditorKeybinds().get('\x10'), 'commands')
  const custom = buildEditorKeybinds({ commands: 'ctrl+k', history: 'ctrl+h' })
  assert.equal(custom.get('\x0b'), 'commands')
  assert.equal(custom.get('\x08'), 'history')
  assert.equal(custom.get('\x10'), undefined)
})

test('phase 5: smart routing chooses once using deterministic safe-default heuristics', async () => {
  const { chooseSmartRoute } = await import('../dist/agent/smart-routing.js')
  const config = { enabled: true, simpleModel: 'simple', strongModel: 'strong' }
  assert.equal(chooseSmartRoute({ userText: 'thanks' }, config).model, 'simple')
  assert.equal(chooseSmartRoute({ userText: 'plan the refactor' }, config).model, 'strong')
  assert.equal(chooseSmartRoute({ userText: 'continue', turnNumber: 1 }, config).model, 'strong')
  assert.equal(chooseSmartRoute({ userText: 'hello', hasNonTextContent: true }, config).model, 'strong')
})

test('phase 5: OpenAI-compatible variants emit reasoning, limits, and extra request options', async () => {
  const { OpenAICompatibleProvider } = await import('../dist/providers/openai-compatible.js')
  const old = global.fetch
  let body
  global.fetch = async (_url, options) => {
    body = JSON.parse(options.body)
    const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n'
    return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const p = new OpenAICompatibleProvider({ model: 'variant-model', baseUrl: 'https://example.invalid/v1', apiKey: 'k', reasoningEffort: 'high', maxTokens: 123, temperature: 0.4, extra: { top_p: 0.8 } })
    const events = []
    for await (const event of p.stream([{ role: 'user', content: 'hello' }], [], new AbortController().signal)) events.push(event)
    assert.equal(body.reasoning_effort, 'high')
    assert.equal(body.max_tokens, 123)
    assert.equal(body.temperature, 0.4)
    assert.equal(body.top_p, 0.8)
    assert.equal(events.find(x => x.type === 'text').delta, 'ok')
  } finally { global.fetch = old }
})

test('phase 5: permission rules override global mode and support argument patterns', async () => {
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const write = { name: 'write_file', description: 'write', risk: 'write', schema: { type: 'object' }, execute: async () => ({ output: 'ok' }) }
  const read = { name: 'read_file', description: 'read', risk: 'read', schema: { type: 'object' }, execute: async () => ({ output: 'ok' }) }
  const allow = new PermissionGate('ask', process.stdin, process.stdout, [{ tool: 'write_*', decision: 'allow' }])
  await allow.check(write, { path: 'a.txt' })
  const deny = new PermissionGate('auto', process.stdin, process.stdout, [{ tool: 'read_file', decision: 'deny' }])
  await assert.rejects(() => deny.check(read, { path: 'a.txt' }), /denied by rule/)
  let asked = 0
  const pattern = new PermissionGate('auto', process.stdin, process.stdout, [{ tool: 'bash', decision: 'ask', pattern: '*rm -rf*' }])
  pattern.setRequester(async () => { asked++; return 'once' })
  await pattern.check({ name: 'bash', description: 'shell', risk: 'shell', schema: { type: 'object' } }, { command: 'rm -rf tmp' })
  assert.equal(asked, 1)
})

test('phase 5: parallel-safe read tools run concurrently while results preserve model order', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const root = await gitRepo()
  try {
    const store = new SessionStore(path.join(root, 'sessions'))
    const meta = await store.create(root, 'mock')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    const started = []
    const timings = {}
    registry.add({ name: 'read_a', description: 'a', risk: 'read', parallelSafe: true, schema: { type: 'object' }, execute: async () => { started.push('a'); timings.aStart=Date.now(); await new Promise(r => setTimeout(r, 70)); timings.aEnd=Date.now(); return { output: 'A' } } })
    registry.add({ name: 'read_b', description: 'b', risk: 'read', parallelSafe: true, schema: { type: 'object' }, execute: async () => { started.push('b'); timings.bStart=Date.now(); await new Promise(r => setTimeout(r, 70)); timings.bEnd=Date.now(); return { output: 'B' } } })
    let calls = 0
    const provider = {
      id: 'mock', model: 'mock',
      async *stream() {
        calls++
        if (calls === 1) {
          yield { type: 'tool_call', call: { id: 'a', type: 'function', function: { name: 'read_a', arguments: '{}' } } }
          yield { type: 'tool_call', call: { id: 'b', type: 'function', function: { name: 'read_b', arguments: '{}' } } }
          yield { type: 'done', finishReason: 'tool_calls' }
        } else { yield { type: 'text', delta: 'done' }; yield { type: 'done', finishReason: 'stop' } }
      }
    }
    const messages = []
    const t0 = Date.now()
    await new Agent(provider, registry, store, 2).run({ sessionId: meta.id, messages, cwd: root, instructions: '', prompt: 'read both' })
    const elapsed = Date.now() - t0
    assert.deepEqual(started, ['a', 'b'])
    assert.ok(timings.aStart < timings.bEnd && timings.bStart < timings.aEnd, 'parallel-safe tools did not overlap')
    assert.ok(elapsed < 450, `unexpectedly slow execution, took ${elapsed}ms`)
    const toolMessages = messages.filter(m => m.role === 'tool')
    assert.deepEqual(toolMessages.map(m => m.content), ['A', 'B'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('phase 5: oversized tool output is bounded while keeping head and tail', async () => {
  const { summarizeToolOutput } = await import('../dist/agent/tool-output.js')
  const source = ['HEAD', ...Array.from({ length: 500 }, (_, i) => `line-${i}`), 'TAIL'].join('\n')
  const out = summarizeToolOutput(source, 900)
  assert.ok(out.length <= 1100)
  assert.match(out, /HEAD/)
  assert.match(out, /TAIL/)
  assert.match(out, /tool output summarized/)
})

test('phase 5: per-agent model target resolves independently of the active provider', async () => {
  const { resolveProviderTarget } = await import('../dist/providers/selection.js')
  const cfg = { provider: 'openai-compatible', model: 'base-model', baseUrl: 'https://base.invalid/v1', apiKeyEnv: 'BASE_KEY', approvals: 'ask', maxToolRounds: 1, maxOutputBytes: 1000, shellTimeoutMs: 1000, maxContextMessages: 10, maxContextBytes: 1000, compactionThreshold: .8, contextReserveTokens: 10, contextRecentTokens: 10, repoMapTokens: 100, providers: { reviewer: { provider: 'openai-compatible', model: 'review-model', baseUrl: 'https://review.invalid/v1', apiKeyEnv: 'REVIEW_KEY' } } }
  const provider = resolveProviderTarget(cfg, 'reviewer')
  assert.equal(provider.model, 'review-model')
  assert.equal(provider.config.baseUrl, 'https://review.invalid/v1')
})
test('tool loop guard hashes complete input and blocks only after threshold', async()=>{
  const { ToolLoopGuard } = await import('../dist/agent/loop-guard.js')
  const guard=new ToolLoopGuard({repeatThreshold:3,writeOnlyRoundThreshold:3})
  assert.equal(guard.check('write_file',{path:'a',content:'one'}).blocked,false)
  assert.equal(guard.check('write_file',{path:'a',content:'two'}).blocked,false)
  assert.equal(guard.check('write_file',{path:'a',content:'one'}).blocked,false)
  assert.equal(guard.check('write_file',{path:'a',content:'one'}).blocked,false)
  assert.equal(guard.check('write_file',{path:'a',content:'one'}).blocked,true)
})
