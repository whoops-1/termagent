import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Agent } from '../../dist/agent/agent.js'
import { recoverTextToolCalls, TextToolCallStreamGate } from '../../dist/agent/tool-call-lifecycle.js'
import { SessionStore } from '../../dist/session/store.js'
import { ToolRegistry } from '../../dist/tools/registry.js'
import { PermissionGate } from '../../dist/tools/permissions.js'

const xml = `<tool_call>\n<function=read_file>\n<parameter=path>/tmp/example.txt</parameter>\n</function>\n</tool_call>`

test('13N text-tool compatibility recovers screenshot-style function/parameter markup', () => {
  const result = recoverTextToolCalls(xml, ['read_file', 'grep'])
  assert.equal(result.recovered, true)
  assert.equal(result.text, '')
  assert.deepEqual(result.calls[0]?.function, {
    name: 'read_file',
    arguments: JSON.stringify({ path: '/tmp/example.txt' }),
  })
})

test('13N text-tool compatibility supports quoted parameter names and XML entities', () => {
  const result = recoverTextToolCalls(
    '<tool_call><function=write_file><parameter name="path">a&amp;b.txt</parameter><parameter name="content">x &lt; y</parameter></function></tool_call>',
    ['write_file'],
  )
  assert.equal(result.recovered, true)
  assert.deepEqual(JSON.parse(result.calls[0]?.function.arguments ?? '{}'), { path: 'a&b.txt', content: 'x < y' })
})

test('13N text-tool stream gate withholds protocol markup but streams ordinary text', () => {
  const gate = new TextToolCallStreamGate()
  assert.equal(gate.push('hello '), 'hello ')
  assert.equal(gate.push('<tool'), '')
  assert.equal(gate.push('_call><function=read_file>'), '')
  assert.match(gate.finish(), /tool_call/)
})

test('13N text-tool compatibility executes a recovered call through the normal agent pipeline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-text-tool-'))
  const store = new SessionStore(path.join(root, 'sessions'))
  const session = await store.create(root, 'mock')
  const registry = new ToolRegistry(new PermissionGate('auto'))
  let executions = 0
  registry.add({
    name: 'read_file',
    description: 'read a file',
    risk: 'read',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async ({ path: filePath }) => {
      executions += 1
      return { output: `contents:${filePath}` }
    },
  })

  class Provider {
    id = 'mock'
    model = 'mock'
    calls = 0
    config = { model: 'mock', baseUrl: 'http://mock.invalid' }
    async *stream() {
      this.calls += 1
      if (this.calls === 1) {
        yield { type: 'text', delta: xml.replace('/tmp/example.txt', path.join(root, 'example.txt')) }
        yield { type: 'done', finishReason: 'stop' }
        return
      }
      yield { type: 'text', delta: 'Summary recovered successfully.' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  const provider = new Provider()
  const agent = new Agent(provider, registry, store, 4)
  const visible = []
  await agent.run({
    sessionId: session.id,
    messages: [],
    cwd: root,
    instructions: 'use tools',
    prompt: 'read the file and summarize',
    onText: text => visible.push(text),
  })

  assert.equal(executions, 1)
  assert.equal(provider.calls, 2)
  assert.equal(visible.join(''), 'Summary recovered successfully.')
  const loaded = await store.load(session.id)
  const assistants = loaded.messages.filter(message => message.role === 'assistant')
  assert.equal(assistants[0]?.content, null)
  assert.equal(assistants[0]?.tool_calls?.[0]?.function?.name, 'read_file')
  assert.match(assistants[0]?.tool_calls?.[0]?.function?.arguments ?? '', /example\.txt/)
  await rm(root, { recursive: true, force: true })
})

test('13N text-tool compatibility hides protocol markup emitted after tools are disabled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-text-tool-final-'))
  const store = new SessionStore(path.join(root, 'sessions'))
  const session = await store.create(root, 'mock')
  const registry = new ToolRegistry(new PermissionGate('auto'))
  registry.add({ name: 'read_file', description: 'read', risk: 'read', schema: { type: 'object' }, execute: async () => ({ output: 'unused' }) })
  class Provider {
    id = 'mock'; model = 'mock'; config = { model: 'mock', baseUrl: 'http://mock.invalid' }
    async *stream(_messages, tools) {
      assert.equal(tools.length, 0)
      yield { type: 'text', delta: xml }
      yield { type: 'done', finishReason: 'stop' }
    }
  }
  const visible = []
  await new Agent(new Provider(), registry, store, 1).run({ sessionId: session.id, messages: [], cwd: root, instructions: 'test', prompt: 'finish', onText: value => visible.push(value) })
  assert.doesNotMatch(visible.join(''), /<tool_call>|<function=/)
  assert.match(visible.join(''), /tool execution is no longer available/i)
  await rm(root, { recursive: true, force: true })
})

test('13N text-tool compatibility ignores unknown functions instead of executing arbitrary markup', () => {
  const result = recoverTextToolCalls(
    '<tool_call><function=delete_everything><parameter=path>/tmp/x</parameter></function></tool_call>',
    ['read_file'],
  )
  assert.equal(result.recovered, false)
  assert.equal(result.calls.length, 0)
  assert.match(result.text, /delete_everything/)
})
