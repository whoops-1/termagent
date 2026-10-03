import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { builtinTools } from '../dist/tools/builtin.js'
import { FileReadStateCache } from '../dist/tools/file-state.js'

test('file and search tools work without native addons', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-tools-'))
  const registry=new ToolRegistry(new PermissionGate('auto')); builtinTools({timeout:5000,maxOutput:5000}).forEach(t=>registry.add(t))
  const ctx={sessionID:'t',agent:'build',cwd:root,abort:new AbortController().signal,readFileState:new FileReadStateCache()}
  await registry.execute('write_file',{path:'src/a.txt',content:'needle here\n'},ctx)
  const r=await registry.execute('read_file',{path:'src/a.txt'},ctx); assert.ok(/needle here|File unchanged since last read/.test(r.output))
  const g=await registry.execute('grep',{pattern:'needle'},ctx); assert.match(g.output,/a\.txt/)
  await registry.execute('edit_file',{path:'src/a.txt',oldText:'needle',newText:'changed'},ctx)
  assert.equal(await readFile(path.join(root,'src/a.txt'),'utf8'),'changed here\n')
  await rm(root,{recursive:true,force:true})
})
test('todo tool persists completed history but hides completed-only live state', async()=>{
  const { todoTool } = await import('../dist/tools/todo.js')
  const state=[]
  let persisted=null
  let visible=null
  const tool=todoTool(state,async items=>{ persisted=items },items=>{ visible=items })
  const result=await tool.execute({action:'set',items:[
    {id:'1',task:'first',status:'done'},
    {id:'2',task:'second',status:'done'},
  ]})
  assert.deepEqual(JSON.parse(result.output),[
    {id:'1',task:'first',status:'done'},
    {id:'2',task:'second',status:'done'},
  ])
  assert.deepEqual(persisted, state)
  assert.deepEqual(visible,[])
  assert.equal(state.length,2)
  const listed=await tool.execute({action:'list'})
  assert.deepEqual(JSON.parse(listed.output),state)
})

test('path traversal is blocked', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-safe-'))
  const registry=new ToolRegistry(new PermissionGate('auto')); builtinTools({timeout:5000,maxOutput:5000}).forEach(t=>registry.add(t))
  const ctx={sessionID:'t',agent:'build',cwd:root,abort:new AbortController().signal}
  await assert.rejects(()=>registry.execute('read_file',{path:'../secret'},ctx),/escapes project/)
  await rm(root,{recursive:true,force:true})
})
test('repo_map tool returns bounded structural context with focus', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-repomap-tool-'))
  const registry=new ToolRegistry(new PermissionGate('auto')); builtinTools({timeout:5000,maxOutput:1800}).forEach(t=>registry.add(t))
  const ctx={sessionID:'t',agent:'build',cwd:root,abort:new AbortController().signal}
  await registry.execute('write_file',{path:'src/api.ts',content:'export function targetApi() { return true }\n'},ctx)
  await registry.execute('write_file',{path:'src/other.ts',content:'export function other() { return false }\n'},ctx)
  const r=await registry.execute('repo_map',{tokens:2048,focusSymbols:['targetApi']},ctx)
  assert.ok(r.output.length<=1800)
  assert.match(r.output,/targetApi/)
  await rm(root,{recursive:true,force:true})
})

test('todo tool accepts bulk updates without requiring task text on every patch', async()=>{
  const { todoTool } = await import('../dist/tools/todo.js')
  const state=[]
  const tool=todoTool(state)
  const ctx={sessionID:'t',agent:'build',cwd:process.cwd(),abort:new AbortController().signal}
  await tool.execute({action:'set',items:[
    {id:'1',task:'first',status:'pending'},
    {id:'2',task:'second',status:'pending'},
  ]},ctx)
  const result=JSON.parse((await tool.execute({action:'update',items:[
    {id:'1',status:'done'},
    {id:'2',status:'in_progress'},
  ]},ctx)).output)
  assert.deepEqual(result,[
    {id:'1',task:'first',status:'done'},
    {id:'2',task:'second',status:'in_progress'},
  ])
})
