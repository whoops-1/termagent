import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { builtinTools } from '../../dist/tools/builtin.js'
import { FileReadStateCache } from '../../dist/tools/file-state.js'

async function temp(prefix='termagent-13n-a-'){ return fs.mkdtemp(path.join(os.tmpdir(), prefix)) }
const signal = new AbortController().signal
const ctx = (cwd, cache) => ({sessionID:'phase13n-a',agent:'build',cwd,abort:signal,readFileState:cache})
const readTool = () => builtinTools({timeout:5000,maxOutput:100000}).find(tool => tool.name === 'read_file')

async function writeLines(file, count, prefix='line') {
  await fs.writeFile(file, Array.from({length:count}, (_, i) => `${prefix}-${i+1}`).join('\n'), 'utf8')
}

test('13N-A blocks fully covered non-exact reads and ignores cosmetic arguments', async () => {
  const root = await temp()
  try {
    const file = path.join(root, 'sample.txt')
    await writeLines(file, 100)
    const cache = new FileReadStateCache()
    const tool = readTool()

    await tool.execute({path:'sample.txt',startLine:1,endLine:100},ctx(root,cache))
    const subrange = await tool.execute({path:'sample.txt',startLine:1,endLine:50,probe:'different'},ctx(root,cache))
    const tail = await tool.execute({path:'sample.txt',startLine:51,endLine:100,probe:'another'},ctx(root,cache))
    const middle = await tool.execute({path:'sample.txt',startLine:25,endLine:75,probe:'yet-another'},ctx(root,cache))

    assert.equal(subrange.metadata.cache, 'already-covered')
    assert.equal(tail.metadata.cache, 'already-covered')
    assert.equal(middle.metadata.cache, 'already-covered')
    assert.match(subrange.output, /already covered/i)
    assert.doesNotMatch(subrange.output, /1: line-1/)
  } finally {
    await fs.rm(root,{recursive:true,force:true})
  }
})

test('13N-A rehydrates a fully covered non-exact range after compaction', async () => {
  const root = await temp()
  try {
    const file = path.join(root, 'sample.txt')
    await writeLines(file, 100)
    const cache = new FileReadStateCache()
    const tool = readTool()

    await tool.execute({path:'sample.txt',startLine:1,endLine:100},ctx(root,cache))
    cache.noteCompaction()
    const result = await tool.execute({path:'sample.txt',startLine:25,endLine:75},ctx(root,cache))

    assert.equal(result.metadata.cache, 'rehydrated')
    assert.match(result.output, /25: line-25/)
    assert.match(result.output, /75: line-75/)
  } finally {
    await fs.rm(root,{recursive:true,force:true})
  }
})

test('13N-A overlap reads only uncovered lines', async () => {
  const root = await temp()
  try {
    const file = path.join(root, 'sample.txt')
    await writeLines(file, 150)
    const cache = new FileReadStateCache()
    const tool = readTool()

    await tool.execute({path:'sample.txt',startLine:1,endLine:100},ctx(root,cache))
    const result = await tool.execute({path:'sample.txt',startLine:51,endLine:150},ctx(root,cache))

    assert.equal(result.metadata.cache, 'overlap')
    assert.equal(result.metadata.lineStart, 101)
    assert.equal(result.metadata.lineEnd, 150)
    assert.match(result.output, /101: line-101/)
    assert.doesNotMatch(result.output, /51: line-51/)
    assert.doesNotMatch(result.output, /100: line-100/)
  } finally {
    await fs.rm(root,{recursive:true,force:true})
  }
})

test('13N-A file-version drift invalidates prior coverage', async () => {
  const root = await temp()
  try {
    const file = path.join(root, 'sample.txt')
    await writeLines(file, 20, 'old')
    const cache = new FileReadStateCache()
    const tool = readTool()

    await tool.execute({path:'sample.txt',startLine:1,endLine:20},ctx(root,cache))
    await fs.writeFile(file, Array.from({length:20}, (_, i) => `new-${i+1}`).join('\n'), 'utf8')
    const result = await tool.execute({path:'sample.txt',startLine:1,endLine:10},ctx(root,cache))

    assert.equal(result.metadata.cache, 'miss')
    assert.match(result.output, /1: new-1/)
    assert.doesNotMatch(result.output, /old-1/)
  } finally {
    await fs.rm(root,{recursive:true,force:true})
  }
})

test('13N-A truncated line evidence does not become complete read coverage', async () => {
  const root = await temp()
  try {
    const file = path.join(root, 'huge.txt')
    const long = 'x'.repeat(2100)
    await fs.writeFile(file, Array.from({length:5}, (_, i) => `${i+1}-${long}`).join('\n'), 'utf8')
    const cache = new FileReadStateCache()
    const tool = readTool()

    const first = await tool.execute({path:'huge.txt',startLine:1,endLine:5},ctx(root,cache))
    assert.equal(first.metadata.truncated, false)
    assert.equal(cache.lookup(file,{startLine:3,endLine:3},{mtimeMs:first.metadata.mtimeMs,size:first.metadata.size,totalLines:5}).uncovered.length > 0, true)
  } finally {
    await fs.rm(root,{recursive:true,force:true})
  }
})

test('13N-A context-budget truncation reserves its marker tokens', async () => {
  const { estimateTokens, truncateToTokenBudget } = await import(new URL('../../dist/context/budget.js', import.meta.url))
  const input = 'x'.repeat(500)

  for (const limit of [8, 12, 16, 24, 32]) {
    const truncated = truncateToTokenBudget(input, limit)
    assert.ok(estimateTokens(truncated) <= limit, `truncated text must fit ${limit} tokens`)
  }
})

test('13N-A Agent integration keeps redundant range requests on the cache path', async () => {
  const root = await temp()
  try {
    const { Agent } = await import('../../dist/agent/agent.js')
    const { SessionStore } = await import('../../dist/session/store.js')
    const { ToolRegistry } = await import('../../dist/tools/registry.js')
    const { PermissionGate } = await import('../../dist/tools/permissions.js')

    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, '13n-a-agent')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    for (const tool of builtinTools({ timeout: 5000, maxOutput: 100000 })) registry.add(tool)

    await writeLines(path.join(root, 'sample.txt'), 100)
    const sequence = [
      { path: 'sample.txt', startLine: 1, endLine: 100, probe: 1 },
      { path: 'sample.txt', startLine: 1, endLine: 50, probe: 2 },
      { path: 'sample.txt', startLine: 51, endLine: 100, probe: 3 },
      { path: 'sample.txt', startLine: 25, endLine: 75, probe: 4 },
    ]

    class Provider {
      calls = 0
      async *stream() {
        this.calls += 1
        const action = sequence[this.calls - 1]
        if (!action) {
          yield { type: 'text', delta: 'done' }
          yield { type: 'done', finishReason: 'stop' }
          return
        }
        yield {
          type: 'tool_call',
          call: {
            id: `read-${this.calls}`,
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify(action) },
          },
        }
        yield { type: 'done', finishReason: 'tool_calls' }
      }
    }

    const provider = new Provider()
    const statuses = []
    await new Agent(provider, registry, sessions, 0, 12000, 1, value => statuses.push(value)).run({
      sessionId: session.id,
      messages: [],
      cwd: root,
      instructions: 'inspect sample.txt',
      prompt: 'inspect sample.txt',
      mode: 'build',
    })

    const persisted = await sessions.load(session.id)
    const toolMessages = persisted.messages.filter(message => message.role === 'tool')
    assert.equal(provider.calls, 5)
    assert.equal(toolMessages.length, 4)
    assert.match(toolMessages[0].content, /1: line-1/)
    assert.match(toolMessages[1].content, /already covered/i)
    assert.match(toolMessages[2].content, /already covered/i)
    assert.match(toolMessages[3].content, /already covered/i)
    assert.equal(statuses.some(value => /loop guard/i.test(value)), true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
