import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Agent } from '../../dist/agent/agent.js'
import { XmlToolCallStreamParser, recoverTextToolCalls } from '../../dist/agent/text-tool-call-parser.js'
import { SessionStore } from '../../dist/session/store.js'
import { ToolRegistry } from '../../dist/tools/registry.js'
import { PermissionGate } from '../../dist/tools/permissions.js'

const readTool = {
  name: 'read_file',
  description: 'read a file',
  risk: 'read',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      note: { type: 'string' },
      payload: { type: 'object' },
      enabled: { type: 'boolean' },
    },
  },
  execute: async () => ({ output: 'unused' }),
}

const parser = () => new XmlToolCallStreamParser([readTool])
const screenshotXml = (tool = 'read_file') => `<tool_call>\n<function=${tool}>\n<parameter=path>/tmp/example.txt</parameter>\n</function>\n</tool_call>`

function collect(p, chunks) {
  let text = ''
  const calls = []
  for (const chunk of chunks) {
    const result = p.feed(chunk)
    text += result.text
    calls.push(...result.calls)
  }
  const final = p.finish()
  text += final.text
  calls.push(...final.calls)
  return { text, calls }
}

function firstCall(result) {
  assert.equal(result.calls.length, 1)
  return result.calls[0]
}

test('13N text-tool parser recovers the canonical function/parameter dialect', () => {
  const result = recoverTextToolCalls(screenshotXml(), [readTool])
  assert.equal(result.recovered, true)
  assert.equal(result.text, '')
  assert.deepEqual(JSON.parse(firstCall(result).function.arguments), { path: '/tmp/example.txt' })
})

test('13N text-tool parser resolves model compatibility spelling through the real registry', () => {
  const bash = {
    name: 'bash',
    description: 'run shell commands',
    risk: 'shell',
    schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } },
    execute: async () => ({ output: '' }),
  }
  const result = recoverTextToolCalls(
    '<tool_call><function=shell><parameter=command>cd /tmp && node server.mjs &</parameter><parameter=description>Start the proxy server in background</parameter></function></tool_call>',
    [bash],
  )
  assert.equal(result.recovered, true)
  assert.equal(firstCall(result).function.name, 'bash')
  assert.deepEqual(JSON.parse(firstCall(result).function.arguments), {
    command: 'cd /tmp && node server.mjs &',
    description: 'Start the proxy server in background',
  })
})

test('13N text-tool parser supports quoted parameters, entities, JSON-like values, and Unicode', () => {
  const result = recoverTextToolCalls(
    '<tool_call><function=read_file><parameter name="path">a&amp;b.txt</parameter><parameter name="note">hello "world" 日本語</parameter><parameter name="payload">{"nested":[1,true,"✓"]}</parameter><parameter name="enabled">true</parameter></function></tool_call>',
    [readTool],
  )
  assert.deepEqual(JSON.parse(firstCall(result).function.arguments), {
    path: 'a&b.txt',
    note: 'hello "world" 日本語',
    payload: { nested: [1, true, '✓'] },
    enabled: true,
  })
})

test('13N text-tool parser accepts an upstream-style JSON tool-call wrapper', () => {
  const json = recoverTextToolCalls(
    '<tool_call>{\"name\":\"read_file\",\"arguments\":{\"path\":\"/tmp/json.txt\"}}</tool_call>',
    [readTool],
  )
  assert.equal(json.recovered, true)
  assert.deepEqual(JSON.parse(firstCall(json).function.arguments), { path: '/tmp/json.txt' })
})

test('13N text-tool parser supports wrapperless function calls and preserves surrounding text', () => {
  const result = collect(parser(), [
    'before ',
    '<function=read_file><parameter=path>/tmp/a</parameter></function>',
    ' after',
  ])
  assert.equal(result.text, 'before  after')
  assert.deepEqual(JSON.parse(firstCall(result).function.arguments), { path: '/tmp/a' })
})

test('13N text-tool parser keeps a wrapperless function opener buffered across partial chunks', () => {
  const result = collect(parser(), [
    'before ',
    '<fun',
    'ction=',
    'read',
    '_file>',
    '<parameter=path>',
    '/tmp/split-wrapperless.txt',
    '</par',
    'ameter>',
    '</function>',
    ' after',
  ])
  assert.equal(result.text, 'before  after')
  assert.deepEqual(JSON.parse(firstCall(result).function.arguments), { path: '/tmp/split-wrapperless.txt' })
})

test('13N text-tool parser handles multiple calls with prose before, between, and after them', () => {
  const result = collect(parser(), [
    'start ',
    '<tool_call><function=read_file><parameter=path>a</parameter></function></tool_call>',
    ' middle ',
    '<tool_call><function=read_file><parameter=path>b</parameter></function></tool_call>',
    ' end',
  ])
  assert.equal(result.text, 'start  middle  end')
  assert.deepEqual(result.calls.map(call => JSON.parse(call.function.arguments)), [{ path: 'a' }, { path: 'b' }])
})

test('13N text-tool parser never emits protocol fragments when the opener is split arbitrarily', () => {
  const xml = screenshotXml()
  for (let split = 1; split < xml.length; split++) {
    const result = collect(parser(), [xml.slice(0, split), xml.slice(split)])
    assert.equal(result.text, '', `split=${split}`)
    assert.equal(result.calls.length, 1, `split=${split}`)
  }

  const explicit = collect(parser(), [
    'Hello, I will run ',
    '<to',
    'ol_',
    'call><function=rea',
    'd_file><parameter=pa',
    'th>/tmp/x</param',
    'eter></function></tool_',
    'call>',
  ])
  assert.equal(explicit.text, 'Hello, I will run ')
  assert.deepEqual(JSON.parse(firstCall(explicit).function.arguments), { path: '/tmp/x' })
})

test('13N text-tool parser reconciles missing parameter, function, and wrapper closing tags at finish', () => {
  const result = collect(parser(), [
    'before ',
    '<tool_call><function=read_file><parameter=path>/tmp/x',
  ])
  assert.equal(result.text, 'before ')
  assert.deepEqual(JSON.parse(firstCall(result).function.arguments), { path: '/tmp/x' })

  const missingOuter = collect(parser(), [
    'before <tool_call><function=read_file><parameter=path>/tmp/x</parameter>',
  ])
  assert.equal(missingOuter.text, 'before ')
  assert.deepEqual(JSON.parse(firstCall(missingOuter).function.arguments), { path: '/tmp/x' })

  const missingOuterWithTail = collect(parser(), [
    'before <tool_call><function=read_file><parameter=path>/tmp/x</parameter></function>',
    '\nAfter the call.',
  ])
  assert.equal(missingOuterWithTail.text, 'before \nAfter the call.')
  assert.deepEqual(JSON.parse(firstCall(missingOuterWithTail).function.arguments), { path: '/tmp/x' })
})

test('13N text-tool parser handles empty arguments without inventing input', () => {
  const result = collect(parser(), ['<tool_call><function=read_file></function></tool_call>'])
  assert.deepEqual(JSON.parse(firstCall(result).function.arguments), {})
})

test('13N text-tool parser preserves XML-looking ordinary prose and fenced examples', () => {
  const prose = 'The <tool_call> tag is documented here. It is not a request.'
  const plain = collect(parser(), [prose])
  assert.equal(plain.text, prose)
  assert.equal(plain.calls.length, 0)

  const fenced = collect(parser(), ['```\n', screenshotXml(), '\n```'])
  assert.equal(fenced.text, `\`\`\`\n${screenshotXml()}\n\`\`\``)
  assert.equal(fenced.calls.length, 0)
})

test('13N text-tool parser does not execute unknown or malformed protocol markup', () => {
  const unknown = recoverTextToolCalls('<tool_call><function=delete_everything><parameter=path>/tmp/x</parameter></function></tool_call>', [readTool])
  assert.equal(unknown.recovered, false)
  assert.equal(unknown.calls.length, 0)
  assert.doesNotMatch(unknown.text, /<tool_call|<function=|<parameter=/)

  const malformed = recoverTextToolCalls('<tool_call><function=delete_everything><parameter=path>/tmp/x', [readTool])
  assert.equal(malformed.recovered, false)
  assert.equal(malformed.calls.length, 0)
  assert.doesNotMatch(malformed.text, /<tool_call|<function=|<parameter=/)
})

test('13N exact trace-shaped XML reaches the existing Agent tool lifecycle with no XML transcript leakage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-text-tool-'))
  const store = new SessionStore(path.join(root, 'sessions'))
  const session = await store.create(root, 'mock')
  const gate = new PermissionGate('auto')
  const registry = new ToolRegistry(gate)
  let executions = 0
  registry.add({
    name: 'bash',
    description: 'run a shell command',
    risk: 'shell',
    schema: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] },
    execute: async args => {
      executions += 1
      return { output: `ran:${args.command}` }
    },
  })

  const exact = '<tool_call>\n<function=shell>\n<parameter=command>\ncd /data/data/com.termux/files/home/proxy-server && node server.mjs &\n</parameter>\n<parameter=description>\nStart the proxy server in background\n</parameter>\n</function>\n</tool_call>'
  class Provider {
    id = 'mock'
    model = 'mock'
    calls = 0
    config = { model: 'mock', baseUrl: 'http://mock.invalid' }
    async *stream() {
      this.calls += 1
      if (this.calls === 1) {
        yield { type: 'text', delta: "I'll start the server.\n" }
        for (const chunk of [exact.slice(0, 17), exact.slice(17, 41), exact.slice(41, 88), exact.slice(88)]) yield { type: 'text', delta: chunk }
        yield { type: 'done', finishReason: 'stop' }
        return
      }
      yield { type: 'text', delta: 'Server check completed.' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  const provider = new Provider()
  const visible = []
  const toolEvents = []
  await new Agent(provider, registry, store, 4).run({
    sessionId: session.id,
    messages: [],
    cwd: root,
    instructions: 'use tools',
    prompt: 'start and test the server',
    onText: value => visible.push(value),
    onTool: (name, args) => toolEvents.push({ name, args }),
  })

  assert.equal(executions, 1)
  assert.equal(provider.calls, 2)
  const visibleText = visible.join('')
  assert.equal(visibleText, "I'll start the server.\nServer check completed.")
  assert.doesNotMatch(visibleText, /<tool_call|<function=|<parameter=/)
  assert.equal(toolEvents.length, 1)
  assert.equal(toolEvents[0].name, 'bash')
  assert.match(toolEvents[0].args.command, /node server\.mjs &/)

  const loaded = await store.load(session.id)
  const assistants = loaded.messages.filter(message => message.role === 'assistant')
  assert.match(assistants[0]?.content ?? '', /I'll start the server\./)
  assert.doesNotMatch(assistants[0]?.content ?? '', /<tool_call|<function=|<parameter=/)
  assert.equal(assistants[0]?.tool_calls?.[0]?.function?.name, 'bash')
  assert.match(assistants[0]?.tool_calls?.[0]?.function?.arguments ?? '', /node server\.mjs/)

  const lifecycle = loaded.events.filter(event => event.type === 'tool.call').map(event => event.data)
  assert.equal(lifecycle.some(record => record.state === 'pending' && record.name === 'bash'), true)
  assert.equal(lifecycle.some(record => record.state === 'running' && record.name === 'bash'), true)
  assert.equal(lifecycle.some(record => record.state === 'completed' && record.name === 'bash'), true)
  assert.equal(loaded.messages.some(message => message.role === 'tool' && message.name === 'bash'), true)
  await rm(root, { recursive: true, force: true })
})

test('13N text-tool compatibility keeps the existing permission lifecycle intact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-text-tool-perm-'))
  const store = new SessionStore(path.join(root, 'sessions'))
  const session = await store.create(root, 'mock')
  const gate = new PermissionGate('ask', process.stdin, process.stdout, [], store)
  let permissionRequests = 0
  gate.setRequester(async request => {
    permissionRequests += 1
    assert.equal(request.tool.name, 'bash')
    assert.equal(request.action, 'shell')
    return 'once'
  })
  const registry = new ToolRegistry(gate)
  let executions = 0
  registry.add({ name: 'bash', description: 'run shell', risk: 'shell', schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, execute: async () => { executions += 1; return { output: 'ok' } } })

  class Provider {
    id = 'mock'; model = 'mock'; config = { model: 'mock', baseUrl: 'http://mock.invalid' }; round = 0
    async *stream() {
      this.round += 1
      if (this.round === 1) {
        yield { type: 'text', delta: '<tool_call><function=shell><parameter=command>printf test</parameter></function></tool_call>' }
      } else {
        yield { type: 'text', delta: 'done' }
      }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  await new Agent(new Provider(), registry, store, 3).run({ sessionId: session.id, messages: [], cwd: root, instructions: 'test', prompt: 'run it' })
  assert.equal(permissionRequests, 1)
  assert.equal(executions, 1)
  const loaded = await store.load(session.id)
  assert.equal(loaded.events.some(event => event.type === 'permission.asked'), true)
  assert.equal(loaded.events.some(event => event.type === 'permission.resolved'), true)
  await rm(root, { recursive: true, force: true })
})

test('13N native and XML tool calls share one semantic call stream', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-text-tool-native-'))
  const store = new SessionStore(path.join(root, 'sessions'))
  const session = await store.create(root, 'mock')
  const registry = new ToolRegistry(new PermissionGate('auto'))
  const executed = []
  registry.add({ name: 'read_file', description: 'read', risk: 'read', schema: { type: 'object', properties: { path: { type: 'string' } } }, execute: async args => { executed.push(`xml:${args.path}`); return { output: 'xml' } } })
  registry.add({ name: 'bash', description: 'shell', risk: 'shell', schema: { type: 'object', properties: { command: { type: 'string' } } }, execute: async args => { executed.push(`native:${args.command}`); return { output: 'native' } } })

  class Provider {
    id = 'mock'; model = 'mock'; config = { model: 'mock', baseUrl: 'http://mock.invalid' }; round = 0
    async *stream() {
      this.round += 1
      if (this.round === 1) {
        yield { type: 'text', delta: screenshotXml() }
        yield { type: 'tool_call', call: { id: 'native-1', type: 'function', function: { name: 'bash', arguments: '{"command":"native"}' } } }
      } else yield { type: 'text', delta: 'done' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  await new Agent(new Provider(), registry, store, 3).run({ sessionId: session.id, messages: [], cwd: root, instructions: 'test', prompt: 'run both' })
  assert.deepEqual(executed, ['xml:/tmp/example.txt', 'native:native'])
  const loaded = await store.load(session.id)
  const firstAssistant = loaded.messages.find(message => message.role === 'assistant')
  assert.equal(firstAssistant?.tool_calls?.length, 2)
  assert.equal(firstAssistant?.tool_calls?.map(call => call.function.name).join(','), 'read_file,bash')
  assert.doesNotMatch(firstAssistant?.content ?? '', /<tool_call|<function=/)
  await rm(root, { recursive: true, force: true })
})

test('13N-N loop safety does not stop distinct shell verification calls because task metadata is not semantic progress', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-shell-loop-'))
  const store = new SessionStore(path.join(root, 'sessions'))
  const session = await store.create(root, 'mock')
  const registry = new ToolRegistry(new PermissionGate('auto'))
  let executions = 0
  registry.add({
    name: 'bash',
    description: 'run shell commands',
    risk: 'shell',
    schema: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
    execute: async ({ command }) => {
      executions += 1
      return {
        output: executions < 4 ? `Command nonzero: ${command}` : 'health ok',
        metadata: {
          taskId: `task-${executions}`,
          shell: { taskId: `task-${executions}`, command, status: executions < 4 ? 'nonzero' : 'completed' },
        },
      }
    },
  })

  class Provider {
    id = 'mock'
    model = 'mock'
    config = { model: 'mock', baseUrl: 'http://mock.invalid' }
    calls = 0
    async *stream() {
      this.calls += 1
      const commands = [
        'cd /tmp && node server.mjs &',
        'sleep 2 && curl -s http://localhost:6446/health',
        'sleep 3 && curl -s http://localhost:6446/health',
      ]
      if (this.calls <= commands.length) {
        const command = commands[this.calls - 1]
        yield {
          type: 'tool_call',
          call: {
            id: `call-${this.calls}`,
            type: 'function',
            function: { name: 'bash', arguments: JSON.stringify({ command, description: `check ${this.calls}` }) },
          },
        }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text', delta: 'The health checks completed without a semantic-loop stop.' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  const provider = new Provider()
  let status = ''
  const agent = new Agent(provider, registry, store, 6, 12000, 1, value => { status = value })
  const visible = []
  await agent.run({
    sessionId: session.id,
    messages: [],
    cwd: root,
    instructions: 'verify the local service',
    prompt: 'start and check the service',
    onText: value => visible.push(value),
  })

  assert.equal(executions, 3)
  assert.equal(provider.calls, 4)
  assert.doesNotMatch(status, /same no-progress execution state 3 times/i)
  assert.match(visible.join(''), /health checks completed/i)
  await rm(root, { recursive: true, force: true })
})


test('13N operational shell rounds do not inherit an exploration no-progress streak', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'termagent-shell-operational-'))
  const store = new SessionStore(path.join(root, 'sessions'))
  const session = await store.create(root, 'mock')
  const registry = new ToolRegistry(new PermissionGate('auto'))
  let executions = 0
  registry.add({
    name: 'read_file',
    description: 'read a file',
    risk: 'read',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async ({ path: requested }) => ({
      output: 'server.mjs line 1',
      metadata: {
        canonicalPath: path.resolve(root, requested),
        requestedRange: { startLine: 1, endLine: 1 },
        returnedRanges: [{ startLine: 1, endLine: 1 }],
        totalLines: 1,
        size: 18,
        mtimeMs: 1,
        contentHash: 'prime-read',
      },
    }),
  })
  registry.add({
    name: 'bash',
    description: 'run shell commands',
    risk: 'shell',
    schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async ({ command }) => ({
      output: `Command completed: ${command}`,
      metadata: { shell: { taskId: `task-${++executions}`, command, status: 'completed' } },
    }),
  })

  class Provider {
    id = 'mock'
    model = 'mock'
    config = { model: 'mock', baseUrl: 'http://mock.invalid' }
    round = 0
    calls = 0
    async *stream() {
      this.round += 1
      if (this.round === 1) {
        yield { type: 'tool_call', call: { id: 'read-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'server.mjs' }) } } }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      const commands = [
        'printf one',
        'printf two',
        'printf three',
      ]
      if (this.round <= 4) {
        const command = commands[this.round - 2]
        this.calls += 1
        yield { type: 'tool_call', call: { id: `bash-${this.calls}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } } }
        yield { type: 'done', finishReason: 'tool_calls' }
        return
      }
      yield { type: 'text', delta: 'Reached the next reasoning turn.' }
      yield { type: 'done', finishReason: 'stop' }
    }
  }

  const provider = new Provider()
  const visible = []
  let status = ''
  await new Agent(provider, registry, store, 6, 12000, 1, value => { status = value }).run({
    sessionId: session.id,
    messages: [],
    cwd: root,
    instructions: 'inspect then run distinct shell checks',
    prompt: 'start and verify the service',
    onText: value => visible.push(value),
  })

  assert.equal(executions, 3)
  assert.equal(provider.round, 5)
  assert.match(visible.join(''), /Reached the next reasoning turn\./)
  assert.doesNotMatch(status, /same no-progress execution state 3 times/i)
  await rm(root, { recursive: true, force: true })
})
