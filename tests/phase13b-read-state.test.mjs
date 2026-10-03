import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { builtinTools } from '../dist/tools/builtin.js'
import { FileReadStateCache, mergeReadRanges } from '../dist/tools/file-state.js'

async function temp(prefix='termagent-phase13b-'){ return fs.mkdtemp(path.join(os.tmpdir(), prefix)) }
const signal = new AbortController().signal
const ctx = (cwd, cache) => ({sessionID:'phase13b',agent:'build',cwd,abort:signal,readFileState:cache})
const readTool = () => builtinTools({timeout:5000,maxOutput:100000}).find(t => t.name === 'read_file')

async function writeLines(file, lines, encoding='utf8') {
  await fs.writeFile(file, lines.join('\n'), encoding)
}
test('13B cache has bounded LRU entry eviction', () => {
  const cache = new FileReadStateCache(2, 1024 * 1024)
  for (let i = 1; i <= 3; i++) {
    cache.record(`/tmp/file-${i}`,{mtimeMs:1,size:20,totalLines:2},{startLine:1,endLine:2},[{startLine:1,endLine:2,content:`a-${i}\nb-${i}`}],{lineCount:2,truncated:false})
  }
  assert.equal(cache.stats().entries,2)
  assert.equal(cache.get('/tmp/file-1'),undefined)
  assert.ok(cache.get('/tmp/file-2'))
  assert.ok(cache.get('/tmp/file-3'))
})

test('13B successful writes and edits replace existing read state with the new file state', async () => {
  const root = await temp()
  try {
    const cache = new FileReadStateCache()
    const tools = builtinTools({timeout:5000,maxOutput:100000})
    const read = tools.find(t => t.name === 'read_file')
    const write = tools.find(t => t.name === 'write_file')
    const edit = tools.find(t => t.name === 'edit_file')
    await fs.writeFile(path.join(root,'mutable.txt'),'one\ntwo\nthree','utf8')
    await read.execute({path:'mutable.txt',startLine:1,endLine:3},ctx(root,cache))
    assert.equal(cache.stats().entries,1)
    await write.execute({path:'mutable.txt',content:'new\ncontent'},ctx(root,cache))
    assert.equal(cache.stats().entries,1)
    assert.equal(cache.mutationState(path.join(root,'mutable.txt')).contentHash.length,64)
    await read.execute({path:'mutable.txt',startLine:1,endLine:2},ctx(root,cache))
    await edit.execute({path:'mutable.txt',oldText:'content',newText:'changed'},ctx(root,cache))
    assert.equal(cache.stats().entries,1)
    assert.match(cache.mutationState(path.join(root,'mutable.txt')).contentHash,/^[0-9a-f]{64}$/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

 test('13B cache merges and subtracts coverage deterministically', () => {
  assert.deepEqual(mergeReadRanges([{startLine:1,endLine:3},{startLine:4,endLine:9},{startLine:20,endLine:21}]), [{startLine:1,endLine:9},{startLine:20,endLine:21}])
  const cache = new FileReadStateCache(2, 1024 * 1024)
  cache.record('/tmp/a',{mtimeMs:1,size:10,totalLines:30},{startLine:1,endLine:10},[{startLine:1,endLine:10,content:'a\nb\nc\nd\ne\nf\ng\nh\ni\nj'}],{lineCount:10,truncated:false})
  const overlap = cache.lookup('/tmp/a',{startLine:5,endLine:15},{mtimeMs:1,size:10})
  assert.equal(overlap.status,'overlap')
  assert.deepEqual(overlap.uncovered,[{startLine:11,endLine:15}])
})

test('13B identical unchanged reads return compact cache result', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'sample.txt')
    await writeLines(file, Array.from({length:40},(_,i)=>`line-${i+1}`))
    const cache = new FileReadStateCache()
    const tool = readTool(); const first = await tool.execute({path:'sample.txt',startLine:1,endLine:10},ctx(root,cache))
    assert.equal(first.metadata.cache,'miss')
    assert.match(first.output,/1: line-1/)
    const second = await tool.execute({path:'sample.txt',startLine:1,endLine:10},ctx(root,cache))
    assert.equal(second.metadata.cache,'unchanged')
    assert.doesNotMatch(second.output,/1: line-1/)
    assert.match(second.output,/unchanged since last read/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13B compaction marks read results for rehydration without discarding cached content', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'sample.txt')
    await writeLines(file, Array.from({length:20},(_,i)=>`value-${i+1}`))
    const cache = new FileReadStateCache()
    const tool = readTool()
    await tool.execute({path:'sample.txt',startLine:1,endLine:5},ctx(root,cache))
    cache.noteCompaction()
    const rehydrated = await tool.execute({path:'sample.txt',startLine:1,endLine:5},ctx(root,cache))
    assert.equal(rehydrated.metadata.cache,'rehydrated')
    assert.match(rehydrated.output,/1: value-1/)
    assert.match(rehydrated.output,/5: value-5/)
    const again = await tool.execute({path:'sample.txt',startLine:1,endLine:5},ctx(root,cache))
    assert.equal(again.metadata.cache,'unchanged')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13B overlapping reads skip already covered lines and continue at the uncovered range', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'sample.txt')
    await writeLines(file, Array.from({length:160},(_,i)=>`line-${i+1}`))
    const cache = new FileReadStateCache()
    const tool = readTool()
    await tool.execute({path:'sample.txt',startLine:1,endLine:100},ctx(root,cache))
    const result = await tool.execute({path:'sample.txt',startLine:50,endLine:150},ctx(root,cache))
    assert.equal(result.metadata.cache,'overlap')
    assert.equal(result.metadata.lineStart,101)
    assert.equal(result.metadata.lineEnd,150)
    assert.match(result.output,/101: line-101/)
    assert.doesNotMatch(result.output,/50: line-50/)
    assert.doesNotMatch(result.output,/100: line-100/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13B file metadata changes invalidate cached content', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'sample.txt')
    await writeLines(file,['old-1','old-2','old-3'])
    const cache = new FileReadStateCache()
    const tool = readTool()
    await tool.execute({path:'sample.txt',startLine:1,endLine:3},ctx(root,cache))
    await writeLines(file,['new-1','new-2','new-3','new-4'])
    const result = await tool.execute({path:'sample.txt',startLine:1,endLine:3},ctx(root,cache))
    assert.equal(result.metadata.cache,'miss')
    assert.match(result.output,/1: new-1/)
    assert.doesNotMatch(result.output,/old-1/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13B default reads are capped at 2000 lines and provide continuation metadata', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'large.txt')
    await writeLines(file, Array.from({length:2050},(_,i)=>`line-${i+1}`))
    const cache = new FileReadStateCache()
    const result = await readTool().execute({path:'large.txt'},ctx(root,cache))
    assert.equal(result.metadata.lineStart,1)
    assert.equal(result.metadata.lineEnd,2000)
    assert.equal(result.metadata.totalLines,2050)
    assert.equal(result.metadata.truncated,false)
    assert.equal(result.metadata.nextLine,2001)
    assert.match(result.output,/2000: line-2000/)
    assert.match(result.output,/startLine=2001/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13B large output keeps both head and tail when the 50 KB result cap is reached', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'huge-lines.txt')
    const payload='x'.repeat(1900)
    await writeLines(file, Array.from({length:100},(_,i)=>`${i+1}-${payload}`))
    const cache = new FileReadStateCache()
    const result = await readTool().execute({path:'huge-lines.txt',startLine:1,endLine:100},ctx(root,cache))
    assert.equal(result.metadata.truncated,true)
    assert.ok(Buffer.byteLength(result.output,'utf8') < 52 * 1024)
    assert.match(result.output,/1: 1-/)
    assert.match(result.output,/100: 100-/)
    assert.match(result.output,/middle truncated; read a smaller range/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13B binary files are rejected before text decoding', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'payload.bin')
    await fs.writeFile(file, Buffer.from([0,1,2,3,4,5,6,7,8]))
    await assert.rejects(() => readTool().execute({path:'payload.bin'},ctx(root,new FileReadStateCache())), /binary/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13B invalid UTF-8 is rejected instead of returning replacement characters', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'broken.txt')
    await fs.writeFile(file, Buffer.from([0x66,0x6f,0x80,0x6f]))
    await assert.rejects(() => readTool().execute({path:'broken.txt'},ctx(root,new FileReadStateCache())), /UTF-8/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})
test('13B reproduces the 1372-line reread failure sequence and reaches the tail after compaction', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'crypto.py')
    const lines = Array.from({length:1372},(_,i)=>`def generated_line_${i+1}(): return ${JSON.stringify(`value-${i+1}-` + 'x'.repeat(70))}`)
    await writeLines(file, lines)
    const cache = new FileReadStateCache()
    const tool = readTool()
    const results = []
    const read = async (startLine,endLine) => {
      const result = await tool.execute({path:'crypto.py',startLine,endLine},ctx(root,cache))
      results.push(result)
      return result
    }
    await read(1,200)
    await read(201,400)
    await read(401,600)
    await read(601,800)
    await read(801,1000)
    cache.noteCompaction()
    assert.equal((await read(201,400)).metadata.cache,'rehydrated')
    assert.equal((await read(401,600)).metadata.cache,'rehydrated')
    assert.equal((await read(601,800)).metadata.cache,'rehydrated')
    assert.equal((await read(801,1000)).metadata.cache,'rehydrated')
    const tail = await read(1001,1372)
    assert.equal(tail.metadata.cache,'miss')
    assert.equal(tail.metadata.lineStart,1001)
    assert.equal(tail.metadata.lineEnd,1372)
    assert.equal(tail.metadata.totalLines,1372)
    assert.match(tail.output,/1001: /)
    assert.match(tail.output,/1372: /)
    assert.equal(results.filter(r => r.metadata.cache === 'rehydrated').length,4)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13B Agent.run supplies the read cache to tools and records preserved cache state on compaction', async () => {
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { PermissionGate } = await import('../dist/tools/permissions.js')
  const root = await temp()
  try {
    await writeLines(path.join(root,'read-me.txt'), Array.from({length:500},(_,i)=>`line-${i+1}-${'x'.repeat(80)}`))
    const store = new SessionStore(path.join(root,'sessions'))
    const session = await store.create(root,'phase13b')
    const registry = new ToolRegistry(new PermissionGate('auto'))
    builtinTools({timeout:5000,maxOutput:100000}).forEach(t => registry.add(t))
    class Provider {
      calls = 0
      async *stream() {
        this.calls++
        if (this.calls === 1 || this.calls === 2) {
          yield {type:'tool_call',call:{id:`r${this.calls}`,type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'read-me.txt'})}}}
          yield {type:'done',finishReason:'tool_calls'}
          return
        }
        yield {type:'text',delta:'done'}
        yield {type:'done',finishReason:'stop'}
      }
    }
    const provider = new Provider()
    const seen = []
    const agent = new Agent(provider,registry,store,3,2600,1,undefined,[],{threshold:1,reserveTokens:0,recentTokens:420})
    await agent.run({sessionId:session.id,messages:[],cwd:root,instructions:'read the file twice and finish',prompt:'inspect',onToolResult:(name,output,metadata)=>{ if(name==='read_file') seen.push({output,metadata}) }})
    assert.equal(provider.calls,3)
    assert.equal(seen.length,2)
    assert.equal(seen[0].metadata.cache,'miss')
    assert.equal(seen[1].metadata.cache,'rehydrated')
    const loaded = await store.load(session.id)
    const compaction = loaded.events.find(event => event.type === 'compaction')
    assert.ok(compaction)
    assert.ok(Array.isArray(compaction.data.readState))
    assert.ok(compaction.data.readState.some(entry => entry.canonicalPath.endsWith('read-me.txt')))
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13B Unicode and CRLF text remain readable with normalized output line endings', async () => {
  const root = await temp()
  try {
    const file = path.join(root,'unicode.txt')
    await fs.writeFile(file, 'α\r\nहिन्दी\r\nemoji 😀\r\n', 'utf8')
    const result = await readTool().execute({path:'unicode.txt',startLine:1,endLine:3},ctx(root,new FileReadStateCache()))
    assert.match(result.output,/1: α/)
    assert.match(result.output,/2: हिन्दी/)
    assert.match(result.output,/3: emoji 😀/)
    assert.doesNotMatch(result.output,/\r/)
    assert.equal(result.metadata.totalLines,3)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})
