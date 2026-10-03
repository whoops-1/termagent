import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { builtinTools } from '../dist/tools/builtin.js'
import { FileReadStateCache } from '../dist/tools/file-state.js'

const signal = new AbortController().signal
const ctx = (cwd, cache) => ({sessionID:'phase13c',agent:'build',cwd,abort:signal,readFileState:cache})
const tools = () => builtinTools({timeout:5000,maxOutput:100000})
const getTools = () => {
  const all = tools()
  return { read: all.find(x=>x.name==='read_file'), write: all.find(x=>x.name==='write_file'), edit: all.find(x=>x.name==='edit_file') }
}
async function temp(){ return fs.mkdtemp(path.join(os.tmpdir(),'termagent-phase13c-')) }

async function readFull(read, root, file, cache){
  return read.execute({path:file,startLine:1,endLine:3000},ctx(root,cache))
}

test('13C existing write requires a fresh complete read', async () => {
  const root=await temp()
  try {
    const file=path.join(root,'a.txt'); await fs.writeFile(file,'one\ntwo\nthree\n','utf8')
    const {write}=getTools()
    await assert.rejects(() => write.execute({path:'a.txt',content:'new\n'},ctx(root,new FileReadStateCache())),/fully (and freshly )?read/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13C edit requires a fresh complete read and rejects stale content', async () => {
  const root=await temp()
  try {
    const file=path.join(root,'a.txt'); await fs.writeFile(file,'one\ntwo\nthree','utf8')
    const {read,edit}=getTools(); const cache=new FileReadStateCache()
    await assert.rejects(() => edit.execute({path:'a.txt',oldText:'two',newText:'TWO'},ctx(root,cache)),/fully (and freshly )?read/i)
    await readFull(read,root,'a.txt',cache)
    await fs.writeFile(file,'one\nTWO\nthree','utf8')
    await assert.rejects(() => edit.execute({path:'a.txt',oldText:'two',newText:'TWO'},ctx(root,cache)),/modified since it was read/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13C partial reads cannot authorize mutation until complete coverage exists', async () => {
  const root=await temp()
  try {
    const file=path.join(root,'large.txt'); await fs.writeFile(file,Array.from({length:2050},(_,i)=>`line-${i+1}`).join('\n'),'utf8')
    const {read,write}=getTools(); const cache=new FileReadStateCache()
    await read.execute({path:'large.txt',startLine:1,endLine:2000},ctx(root,cache))
    await assert.rejects(() => write.execute({path:'large.txt',content:'replaced'},ctx(root,cache)),/fully (and freshly )?read/i)
    await read.execute({path:'large.txt',startLine:2001,endLine:2050},ctx(root,cache))
    await write.execute({path:'large.txt',content:'replaced'},ctx(root,cache))
    assert.equal(await fs.readFile(file,'utf8'),'replaced')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13C write preserves an existing UTF-8 BOM and CRLF line endings', async () => {
  const root=await temp()
  try {
    const file=path.join(root,'bom-crlf.txt'); const original=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('one\r\ntwo\r\n','utf8')])
    await fs.writeFile(file,original)
    const {read,write}=getTools(); const cache=new FileReadStateCache()
    await readFull(read,root,'bom-crlf.txt',cache)
    await write.execute({path:'bom-crlf.txt',content:'ONE\nTWO\n'},ctx(root,cache))
    const bytes=await fs.readFile(file)
    assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf])
    assert.equal(bytes.subarray(3).toString('utf8'),'ONE\r\nTWO\r\n')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13C edit preserves BOM and CRLF while normalizing model old/new strings to the file ending', async () => {
  const root=await temp()
  try {
    const file=path.join(root,'edit.txt'); await fs.writeFile(file,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('hello\r\nworld\r\n','utf8')]))
    const {read,edit}=getTools(); const cache=new FileReadStateCache(); await readFull(read,root,'edit.txt',cache)
    const result=await edit.execute({path:'edit.txt',oldText:'hello\nworld',newText:'HELLO\nWORLD'},ctx(root,cache))
    const bytes=await fs.readFile(file)
    assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf])
    assert.equal(bytes.subarray(3).toString('utf8'),'HELLO\r\nWORLD\r\n')
    assert.equal(result.metadata.mutation.replacements,1)
    assert.equal(result.metadata.mutation.bomPreserved,true)
    assert.equal(result.metadata.mutation.lineEnding,'CRLF')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13C edit rejects empty and identical edits and ambiguous matches by default', async () => {
  const root=await temp()
  try {
    const file=path.join(root,'a.txt'); await fs.writeFile(file,'x\nx\n','utf8')
    const {read,edit}=getTools(); const cache=new FileReadStateCache(); await readFull(read,root,'a.txt',cache)
    await assert.rejects(() => edit.execute({path:'a.txt',oldText:'',newText:'x'},ctx(root,cache)),/oldText must not be empty/i)
    await assert.rejects(() => edit.execute({path:'a.txt',oldText:'x',newText:'x'},ctx(root,cache)),/No changes to apply/i)
    await assert.rejects(() => edit.execute({path:'a.txt',oldText:'x',newText:'y'},ctx(root,cache)),/Found 2 matches/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13C replaceAll replaces every exact match and reports structured mutation metadata', async () => {
  const root=await temp()
  try {
    const file=path.join(root,'a.txt'); await fs.writeFile(file,'x\ny\nx\n','utf8')
    const {read,edit}=getTools(); const cache=new FileReadStateCache(); await readFull(read,root,'a.txt',cache)
    const result=await edit.execute({path:'a.txt',oldText:'x',newText:'z',all:true},ctx(root,cache))
    assert.equal(await fs.readFile(file,'utf8'),'z\ny\nz\n')
    assert.equal(result.metadata.mutation.replacements,2)
    assert.equal(result.metadata.mutation.replaceAll,true)
    assert.match(result.metadata.mutation.beforeHash,/^[0-9a-f]{64}$/)
    assert.match(result.metadata.mutation.afterHash,/^[0-9a-f]{64}$/)
    assert.equal(result.metadata.mutation.writeGuard,'write-if-unchanged')
    assert.equal(typeof result.metadata.diff,'string')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13C concurrent edits serialize and only one mutation can consume the original content', async () => {
  const root=await temp()
  try {
    const file=path.join(root,'race.txt'); await fs.writeFile(file,'value\n','utf8')
    const {read,edit}=getTools(); const cache=new FileReadStateCache(); await readFull(read,root,'race.txt',cache)
    const results=await Promise.allSettled([
      edit.execute({path:'race.txt',oldText:'value',newText:'one'},ctx(root,cache)),
      edit.execute({path:'race.txt',oldText:'value',newText:'two'},ctx(root,cache)),
    ])
    const fulfilled=results.filter(x=>x.status==='fulfilled')
    const rejected=results.filter(x=>x.status==='rejected')
    assert.equal(fulfilled.length,1)
    assert.equal(rejected.length,1)
    assert.match(String(rejected[0].reason?.message || rejected[0].reason),/Could not find oldText|modified since it was read|changed during mutation/i)
    assert.match(await fs.readFile(file,'utf8'),/^(one|two)\n$/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13C an independent writer cannot silently overwrite a file created by another writer', async () => {
  const root=await temp(); try {
    const {write}=getTools(); const firstCache=new FileReadStateCache(); const secondCache=new FileReadStateCache();
    await write.execute({path:'race.txt',content:'one'},ctx(root,firstCache))
    await assert.rejects(() => write.execute({path:'race.txt',content:'two'},ctx(root,secondCache)),/fully .*read/i)
    assert.equal(await fs.readFile(path.join(root,'race.txt'),'utf8'),'one')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})
