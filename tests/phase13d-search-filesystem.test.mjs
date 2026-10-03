import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { builtinTools } from '../dist/tools/builtin.js'
import { globToRegExp, listDirectoryPage } from '../dist/tools/filesystem-search.js'
import { FileReadStateCache } from '../dist/tools/file-state.js'

const tools = () => builtinTools({timeout:5000,maxOutput:12000})
const context = (cwd, cache = new FileReadStateCache()) => ({
  sessionID:'phase13d', agent:'build', cwd, abort:new AbortController().signal, readFileState:cache,
})
const temp = () => fs.mkdtemp(path.join(os.tmpdir(),'termagent-phase13d-'))

async function seed(root){
  await fs.mkdir(path.join(root,'src','nested'),{recursive:true})
  await fs.mkdir(path.join(root,'node_modules','fake'),{recursive:true})
  await fs.mkdir(path.join(root,'.git'),{recursive:true})
  await fs.writeFile(path.join(root,'src','a.ts'),'const needle = 1\nconst other = 2\n','utf8')
  await fs.writeFile(path.join(root,'src','b.ts'),'const NEEDLE = 3\n','utf8')
  await fs.writeFile(path.join(root,'src','nested','c.js'),'console.log("needle")\n','utf8')
  await fs.writeFile(path.join(root,'README.md'),'needle docs\n','utf8')
  await fs.writeFile(path.join(root,'node_modules','fake','ignored.ts'),'needle hidden\n','utf8')
  await fs.writeFile(path.join(root,'.git','ignored.txt'),'needle git\n','utf8')
}

function restorePath(previous){ if(previous === undefined) delete process.env.PATH; else process.env.PATH=previous }

 test('13D grep uses regex semantics and structured pagination metadata', async()=>{
  const root=await temp()
  try {
    await seed(root)
    const grep=tools().find(t=>t.name==='grep')
    const result=await grep.execute({pattern:'needle|NEEDLE',glob:'**/*.ts',maxResults:1},context(root))
    assert.match(result.output,/src\/a\.ts:1:const needle = 1/)
    assert.equal(result.metadata.search.matches,1)
    assert.equal(result.metadata.search.truncated,true)
    assert.equal(result.metadata.search.nextOffset,1)
    assert.ok(['ripgrep','node'].includes(result.metadata.search.engine))
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13D glob supports **, path roots, stable ordering, and truncation continuation', async()=>{
  const root=await temp()
  try {
    await seed(root)
    const glob=tools().find(t=>t.name==='glob')
    const result=await glob.execute({pattern:'**/*.ts',maxResults:1},context(root))
    assert.equal(result.output.split('\n')[0],'src/a.ts')
    assert.equal(result.metadata.glob.files,1)
    assert.equal(result.metadata.glob.truncated,true)
    assert.equal(result.metadata.glob.nextOffset,1)
    const next=await glob.execute({pattern:'**/*.ts',offset:1,maxResults:2},context(root))
    assert.match(next.output,/src\/b\.ts/)
    assert.doesNotMatch(next.output,/node_modules/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13D brace glob matching remains supported by shared fallback matcher', async()=>{
  const matcher=globToRegExp('src/**/*.{ts,js}')
  assert.equal(matcher.test('src/a.ts'),true)
  assert.equal(matcher.test('src/nested/c.js'),true)
  assert.equal(matcher.test('src/a.css'),false)
})

test('13D grep handles a single-file search root in the Node fallback', async()=>{
  const root=await temp()
  const previous=process.env.PATH
  try {
    await seed(root)
    process.env.PATH=''
    const grep=tools().find(t=>t.name==='grep')
    const result=await grep.execute({pattern:'needle',path:'src/a.ts'},context(root))
    assert.equal(result.metadata.search.engine,'node')
    assert.match(result.output,/src\/a\.ts:1:const needle = 1/)
    assert.doesNotMatch(result.output,/src\/b\.ts/)
  } finally { restorePath(previous); await fs.rm(root,{recursive:true,force:true}) }
})

test('13D invalid regex is rejected instead of silently falling back to substring search', async()=>{
  const root=await temp()
  try {
    await seed(root)
    const grep=tools().find(t=>t.name==='grep')
    await assert.rejects(() => grep.execute({pattern:'['},context(root)),/Invalid regex/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13D grep Node fallback preserves regex behavior and ignore policy when rg is unavailable', async()=>{
  const root=await temp()
  const previous=process.env.PATH
  try {
    await seed(root)
    process.env.PATH=''
    const grep=tools().find(t=>t.name==='grep')
    const result=await grep.execute({pattern:'needle'},context(root))
    assert.equal(result.metadata.search.engine,'node')
    assert.match(result.output,/src\/a\.ts:1:const needle = 1/)
    assert.match(result.output,/src\/nested\/c\.js:1:console\.log/) 
    assert.doesNotMatch(result.output,/node_modules/)
    assert.doesNotMatch(result.output,/\.git/)
  } finally { restorePath(previous); await fs.rm(root,{recursive:true,force:true}) }
})

test('13D glob Node fallback supports recursive patterns and ignores VCS/build directories', async()=>{
  const root=await temp()
  const previous=process.env.PATH
  try {
    await seed(root)
    process.env.PATH=''
    const glob=tools().find(t=>t.name==='glob')
    const result=await glob.execute({pattern:'**/*.ts'},context(root))
    assert.equal(result.metadata.glob.engine,'node')
    assert.deepEqual(result.output.split('\n').filter(Boolean),['src/a.ts','src/b.ts'])
  } finally { restorePath(previous); await fs.rm(root,{recursive:true,force:true}) }
})

test('13D read_file provides paginated directory entries using the shared filesystem policy', async()=>{
  const root=await temp()
  try {
    await fs.mkdir(path.join(root,'alpha'),{recursive:true})
    await fs.mkdir(path.join(root,'beta'),{recursive:true})
    await fs.mkdir(path.join(root,'node_modules'),{recursive:true})
    await fs.writeFile(path.join(root,'z.txt'),'z')
    await fs.writeFile(path.join(root,'a.txt'),'a')
    const read=tools().find(t=>t.name==='read_file')
    const first=await read.execute({path:'.',offset:1,limit:2},context(root))
    assert.equal(first.metadata.directory.entries,2)
    assert.equal(first.metadata.directory.truncated,true)
    assert.ok(first.output.includes('alpha/'))
    assert.equal(first.metadata.directory.nextOffset,3)
    const second=await read.execute({path:'.',offset:3,limit:2},context(root))
    assert.equal(second.metadata.directory.entries,2)
    assert.ok(second.output.includes('beta/'))
    assert.ok(second.output.includes('z.txt'))
    assert.doesNotMatch(second.output,/node_modules/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13D directory listing rejects symlink targets outside the workspace', async()=>{
  const root=await temp()
  try {
    const outside=await fs.mkdtemp(path.join(os.tmpdir(),'termagent-phase13d-outside-'))
    await fs.writeFile(path.join(outside,'secret.txt'),'secret')
    await fs.symlink(outside,path.join(root,'outside-link'),'dir')
    const page=await listDirectoryPage(root,{offset:1,limit:50})
    assert.doesNotMatch(page.entries.map(x=>x.name).join('\n'),/outside-link/)
    await fs.rm(outside,{recursive:true,force:true})
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13D search bounds 100+ matches and exposes continuation without unbounded output', async()=>{
  const root=await temp()
  try {
    const lines=Array.from({length:140},(_,i)=>`needle-${i+1}`)
    await fs.writeFile(path.join(root,'many.txt'),lines.join('\n'),'utf8')
    const grep=tools().find(t=>t.name==='grep')
    const result=await grep.execute({pattern:'^needle-',maxResults:100},context(root))
    assert.equal(result.metadata.search.matches,100)
    assert.equal(result.metadata.search.truncated,true)
    assert.equal(result.metadata.search.nextOffset,100)
    assert.ok(result.output.includes('many.txt:100:needle-100'))
    assert.ok(!result.output.includes('many.txt:101:needle-101'))
    assert.ok(Buffer.byteLength(result.output,'utf8')<12000)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13D zero-match searches stay explicit and do not report false positives', async()=>{
  const root=await temp()
  try {
    await fs.writeFile(path.join(root,'one.txt'),'alpha\nbeta\n','utf8')
    const grep=tools().find(t=>t.name==='grep')
    const result=await grep.execute({pattern:'not-present'},context(root))
    assert.equal(result.metadata.search.matches,0)
    assert.equal(result.metadata.search.truncated,false)
    assert.equal(result.output,'No matches')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13D Unicode filenames and narrow search scopes remain deterministic', async()=>{
  const root=await temp()
  try {
    const scoped=path.join(root,'scope')
    await fs.mkdir(scoped,{recursive:true})
    await fs.writeFile(path.join(scoped,'हिन्दी.ts'),'needle unicode\n','utf8')
    await fs.writeFile(path.join(root,'outside.ts'),'needle outside\n','utf8')
    const grep=tools().find(t=>t.name==='grep')
    const result=await grep.execute({pattern:'needle',path:'scope'},context(root))
    assert.match(result.output,/scope\/हिन्दी\.ts:1:needle unicode/)
    assert.doesNotMatch(result.output,/outside\.ts/)
    const narrowed=await grep.execute({pattern:'needle',path:'scope',maxResults:1},context(root))
    assert.equal(narrowed.metadata.search.path,scoped)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13D grep does not follow symlinks and the shared fallback does not escape through them', async()=>{
  const root=await temp()
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'termagent-phase13d-link-target-'))
  const previous=process.env.PATH
  try {
    await fs.writeFile(path.join(outside,'secret.txt'),'needle secret\n','utf8')
    await fs.symlink(path.join(outside,'secret.txt'),path.join(root,'secret-link.txt'),'file')
    await fs.writeFile(path.join(root,'visible.txt'),'needle visible\n','utf8')
    const grep=tools().find(t=>t.name==='grep')
    process.env.PATH=''
    const result=await grep.execute({pattern:'needle'},context(root))
    assert.match(result.output,/visible\.txt:1:needle visible/)
    assert.doesNotMatch(result.output,/secret-link|secret\.txt/)
  } finally { restorePath(previous); await fs.rm(root,{recursive:true,force:true}); await fs.rm(outside,{recursive:true,force:true}) }
})
