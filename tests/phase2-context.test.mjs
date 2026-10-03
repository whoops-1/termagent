import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { buildRepositoryMap, formatRepositoryMap, invalidateRepositoryCache } from '../dist/context/repository.js'
import { analyzeSource } from '../dist/context/symbols.js'
import { retrieveContext } from '../dist/context/retrieval.js'
import { compactMessages, estimateTokens } from '../dist/agent/compaction.js'
import { createContextBudget, estimateMessagesTokens, estimateTokens as estimateContextTokens } from '../dist/context/budget.js'
import { Agent } from '../dist/agent/agent.js'
import { SessionStore } from '../dist/session/store.js'
import { ToolRegistry } from '../dist/tools/registry.js'

async function temp(prefix){return await mkdtemp(path.join(tmpdir(),prefix))}
async function cleanup(root){await rm(root,{recursive:true,force:true})}

async function writeProject(root){
  await mkdir(path.join(root,'src'),{recursive:true})
  await mkdir(path.join(root,'lib'),{recursive:true})
  await writeFile(path.join(root,'lib','auth.ts'),`export function authenticateUser(token: string) {\n  return token.length > 0\n}\nexport class AuthService {}\n`)
  await writeFile(path.join(root,'src','auth-client.ts'),`import { authenticateUser, AuthService } from '../lib/auth'\nexport function login(token: string) {\n  const ok = authenticateUser(token)\n  return new AuthService() && ok\n}\n`)
  await writeFile(path.join(root,'src','unrelated.ts'),`export function formatDate(x: string) { return x }\n`)
}

test('phase 2: cached repository map extracts symbols and reuses unchanged analysis', async()=>{
  const root=await temp('termagent-p2-map-');await writeProject(root)
  await invalidateRepositoryCache(root)
  const first=await buildRepositoryMap(root)
  assert.ok(first.files.find(f=>f.path==='lib/auth.ts')?.symbols.some(s=>s.name==='authenticateUser'))
  assert.ok(first.files.find(f=>f.path==='lib/auth.ts')?.symbols.some(s=>s.name==='AuthService'))
  assert.ok(first.edges.some(e=>e.from==='src/auth-client.ts'&&e.to==='lib/auth.ts'))
  assert.ok(first.files.find(f=>f.path==='lib/auth.ts')?.structural>0)
  const second=await buildRepositoryMap(root)
  assert.ok(second.cache.hit>=first.files.length-1)
  assert.equal(second.cache.miss,0)
  await cleanup(root)
})

test('phase 2: cache reparses only the changed file', async()=>{
  const root=await temp('termagent-p2-cache-');await writeProject(root);await invalidateRepositoryCache(root)
  await buildRepositoryMap(root)
  await writeFile(path.join(root,'src','unrelated.ts'),'export function formatDate(x: string) { return x + x }\n')
  const next=await buildRepositoryMap(root)
  assert.equal(next.cache.miss,1)
  assert.ok(next.cache.hit>=2)
  await cleanup(root)
})

test('phase 2: invalidation forces a cold structural rebuild', async()=>{
  const root=await temp('termagent-p2-invalidate-');await writeProject(root);await invalidateRepositoryCache(root)
  await buildRepositoryMap(root);const warm=await buildRepositoryMap(root);assert.equal(warm.cache.miss,0)
  await invalidateRepositoryCache(root);const cold=await buildRepositoryMap(root);assert.ok(cold.cache.miss>=3)
  await cleanup(root)
})

test('phase 2: file deletion removes stale symbols and graph edges', async()=>{
  const root=await temp('termagent-p2-delete-');await writeProject(root);await invalidateRepositoryCache(root);await buildRepositoryMap(root)
  await rm(path.join(root,'lib','auth.ts'));await writeFile(path.join(root,'src','auth-client.ts'),'export const x = 1\n')
  const map=await buildRepositoryMap(root)
  assert.ok(!map.files.some(f=>f.path==='lib/auth.ts'));assert.ok(!map.edges.some(e=>e.to==='lib/auth.ts'))
  await cleanup(root)
})

test('phase 2: structural map renders signatures within a token budget', async()=>{
  const root=await temp('termagent-p2-render-');await writeProject(root);const map=await buildRepositoryMap(root);const text=formatRepositoryMap(map,20,500)
  assert.ok(text.length<=2200)
  assert.match(text,/authenticateUser/)
  assert.match(text,/Structural file map/)
  await cleanup(root)
})

test('phase 2: retrieval finds a content-only match in a low-importance file', async()=>{
  const root=await temp('termagent-p2-content-');await mkdir(path.join(root,'a'),{recursive:true});await mkdir(path.join(root,'z'),{recursive:true})
  await writeFile(path.join(root,'a','main.ts'),'export function unrelated() { return 1 }\n'.repeat(20))
  await writeFile(path.join(root,'z','obscure.ts'),'const x = 1\n'.repeat(20)+`\n// UNIQUE_NEEDLE_9321\n`+'const y = 2\n'.repeat(20))
  const map=await buildRepositoryMap(root);const ctx=await retrieveContext(map,'UNIQUE_NEEDLE_9321',{maxFiles:1,maxTokens:700,maxBytes:2800})
  assert.match(ctx,/z\/obscure\.ts/);assert.match(ctx,/UNIQUE_NEEDLE_9321/);assert.ok(ctx.length<=2800)
  await cleanup(root)
})

test('phase 2: symbol match recenters retrieval around the definition instead of file start', async()=>{
  const root=await temp('termagent-p2-center-');await mkdir(path.join(root,'src'),{recursive:true});
  const filler=Array.from({length:180},(_,i)=>`// filler ${i}`).join('\n')
  await writeFile(path.join(root,'src','big.ts'),`${filler}\nexport function authenticateUser(token: string) { return token.length > 0 }\n// tail\n`)
  const map=await buildRepositoryMap(root);const ctx=await retrieveContext(map,'authenticateUser',{maxFiles:1,maxTokens:500,maxBytes:2000})
  assert.match(ctx,/authenticateUser/);assert.match(ctx,/181:/);assert.ok(!ctx.includes('// filler 0'))
  await cleanup(root)
})

test('phase 2: reference-aware retrieval keeps an imported dependency near its caller', async()=>{
  const root=await temp('termagent-p2-graph-');await writeProject(root);const map=await buildRepositoryMap(root)
  const ctx=await retrieveContext(map,'login authentication',{maxFiles:2,maxTokens:1000,maxBytes:4000})
  assert.match(ctx,/src\/auth-client\.ts/);assert.match(ctx,/lib\/auth\.ts/)
  await cleanup(root)
})

test('phase 2: focusFiles and focusSymbols override weak lexical relevance', async()=>{
  const root=await temp('termagent-p2-focus-');await writeProject(root);const map=await buildRepositoryMap(root)
  const ctx=await retrieveContext(map,'unrelated',{maxFiles:1,maxTokens:600,maxBytes:2400,focusFiles:['lib/auth.ts']})
  assert.match(ctx,/lib\/auth\.ts/)
  const ctx2=await retrieveContext(map,'service',{maxFiles:1,maxTokens:600,maxBytes:2400,focusSymbols:['authenticateUser']})
  assert.match(ctx2,/authenticateUser/)
  await cleanup(root)
})

test('phase 2: retrieval bounds tiny byte budgets instead of exceeding the contract', async()=>{
  const root=await temp('termagent-p2-budget-');await mkdir(path.join(root,'src'),{recursive:true});await writeFile(path.join(root,'src','a.ts'),'export function needle(){return "x"}\n'.repeat(20));const map=await buildRepositoryMap(root)
  for(const size of [300,500,900,1200]){
    const ctx=await retrieveContext(map,'needle',{maxFiles:2,maxBytes:size,maxTokens:Math.max(100,Math.floor(size/4))});assert.ok(ctx.length<=size,`size ${size}, got ${ctx.length}`)
  }
  await cleanup(root)
})

test('phase 2: budget accounts for output reserve and thresholds', ()=>{
  const b=createContextBudget({maxContextTokens:10000,maxOutputTokens:2000,threshold:0.8,reserveTokens:500,recentTokens:2500})
  assert.equal(b.usableTokens,6000)
  assert.equal(b.recentTokens,2500)
  assert.ok(b.compactTargetTokens<6000)
})

test('phase 2: legacy compaction API stays within its requested hard limit', ()=>{
  const messages=[{role:'system',content:'system'},...Array.from({length:18},(_,i)=>({role:'user',content:`request ${i} `+'x'.repeat(500)})),{role:'tool',content:'ERROR: command failed'},]
  const c=compactMessages(messages,900)
  assert.ok(estimateTokens(c.messages)<=900)
  assert.ok(c.removed>0)
  assert.match(c.messages.find(m=>m.role==='system'&&m.content?.includes('Earlier conversation summary'))?.content||'',/Objective/)
})

test('phase 2: compaction preserves tool-error evidence and recent whole turns', ()=>{
  const messages=[
    {role:'system',content:'SYSTEM'},
    {role:'user',content:'old task '+('x'.repeat(900))},
    {role:'assistant',content:'I changed src/foo.ts '+('y'.repeat(900))},
    {role:'tool',content:'ERROR: test failed in src/foo.test.ts '+('z'.repeat(1400))},
    {role:'user',content:'latest task'},
    {role:'assistant',content:'I will inspect src/foo.ts next'},
    {role:'tool',content:'PASS: npm test'},
  ]
  const c=compactMessages(messages,500,{maxOutputTokens:0,threshold:1,reserveTokens:0,recentTokens:90})
  assert.ok(estimateTokens(c.messages)<=500)
  assert.match(c.messages.find(m=>m.content?.includes('Earlier conversation summary'))?.content||'',/test failed/i)
  assert.ok(c.messages.some(m=>m.content==='latest task'))
})

test('phase 2: compaction does not split assistant tool-call/result pairs in the recent tail', ()=>{
  const messages=[
    {role:'system',content:'SYSTEM'},
    {role:'user',content:'old'},
    {role:'assistant',content:'old answer'},
    {role:'user',content:'current'},
    {role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'read_file',arguments:'{"path":"x"}'}}]},
    {role:'tool',tool_call_id:'c1',name:'read_file',content:'line 1\nline 2'},
    {role:'assistant',content:'done'},
  ]
  const c=compactMessages(messages,500,{maxOutputTokens:0,threshold:1,reserveTokens:0,recentTokens:260})
  const aiIndex=c.messages.findIndex(m=>m.tool_calls?.[0]?.id==='c1');const toolIndex=c.messages.findIndex(m=>m.tool_call_id==='c1')
  assert.equal(aiIndex+1,toolIndex)
})

test('phase 2: compaction remains bounded with huge tool output and preserves a compact error', ()=>{
  const huge='ERROR: '+('x'.repeat(80_000))
  const messages=[{role:'system',content:'SYS'},{role:'user',content:'do task'},{role:'assistant',content:'checking'},{role:'tool',content:huge},{role:'user',content:'continue'},{role:'assistant',content:'continuing'}]
  const c=compactMessages(messages,1200)
  assert.ok(estimateTokens(c.messages)<=1200)
  assert.match(c.summary,/ERROR/)
})

test('phase 2: agent compacts against request budget including tool schemas', async()=>{
  const root=await temp('termagent-p2-agent-budget-');const store=new SessionStore(path.join(root,'sessions'));const session=await store.create(root,'mock')
  const registry=new ToolRegistry();registry.add({name:'giant_tool',description:'x'.repeat(2400),risk:'read',schema:{type:'object',properties:{q:{type:'string',description:'x'.repeat(1200)}}},execute:async()=>({output:'ok'})})
  const provider={id:'mock',model:'mock',config:{maxTokens:1000},calls:0,seen:[],async *stream(messages,tools){this.calls++;this.seen.push({messages,tools});yield {type:'text',delta:'ok'};yield {type:'done',finishReason:'stop'}}}
  const agent=new Agent(provider,registry,store,0,5000,1,undefined,[],{threshold:0.9,reserveTokens:200,recentTokens:500})
  await agent.run({sessionId:session.id,messages:[{role:'user',content:'x'.repeat(12_000)}],cwd:root,instructions:'test',prompt:'hello'})
  assert.equal(provider.calls,1)
  const total=estimateMessagesTokens(provider.seen[0].messages)
  assert.ok(total + estimateTokens(provider.seen[0].tools) <= 4500)
  await cleanup(root)
})

test('phase 2: repository map tolerates inaccessible/stale files without poisoning the whole index', async()=>{
  const root=await temp('termagent-p2-tolerant-');await writeProject(root)
  await writeFile(path.join(root,'src','ok.ts'),'export function ok() { return true }')
  const map=await buildRepositoryMap(root)
  assert.ok(map.files.some(f=>f.path==='src/ok.ts'))
  await utimes(path.join(root,'src','ok.ts'),new Date(),new Date())
  const map2=await buildRepositoryMap(root)
  assert.ok(map2.files.length>=map.files.length)
  await cleanup(root)
})
test('phase 2 hardening: aliased imports resolve to the exported symbol without same-name cross-talk', async()=>{
  const root=await temp('termagent-p2-alias-');await mkdir(path.join(root,'lib'),{recursive:true});await mkdir(path.join(root,'src'),{recursive:true})
  await writeFile(path.join(root,'lib','a.ts'),'export function handle(value: string) { return value }\n')
  await writeFile(path.join(root,'lib','b.ts'),'export function handle(value: string) { return value + "b" }\n')
  await writeFile(path.join(root,'src','main.ts'),'import { handle as authHandle } from "../lib/a"\nexport function run(value: string) { return authHandle(value) }\n')
  const map=await buildRepositoryMap(root);const edge=map.edges.find(e=>e.from==='src/main.ts'&&e.to==='lib/a.ts')
  assert.ok(edge);assert.ok(edge.symbols.includes('authHandle'));assert.ok(!map.edges.some(e=>e.from==='src/main.ts'&&e.to==='lib/b.ts'))
  await cleanup(root)
})

test('phase 2 hardening: Python relative aliases create a precise dependency edge', async()=>{
  const root=await temp('termagent-p2-python-');await mkdir(path.join(root,'src'),{recursive:true});await writeFile(path.join(root,'src','lib.py'),'def helper(value):\n    return value\n');await writeFile(path.join(root,'src','main.py'),'from .lib import helper as run_helper\ndef execute(value):\n    return run_helper(value)\n')
  const analysis=analyzeSource('src/main.py',await readFile(path.join(root,'src','main.py'),'utf8'));assert.deepEqual(analysis.imports[0],{name:'run_helper',source:'.lib',imported:'helper'});
  const map=await buildRepositoryMap(root);assert.ok(map.edges.some(e=>e.from==='src/main.py'&&e.to==='src/lib.py'&&e.symbols.includes('run_helper')))
  await cleanup(root)
})

test('phase 2 hardening: multi-call tool units are all-or-nothing when a result cannot fit', ()=>{
  const messages=[
    {role:'system',content:'SYS'},
    {role:'user',content:'old task '+('x'.repeat(1200))},
    {role:'assistant',content:null,tool_calls:[
      {id:'c1',type:'function',function:{name:'read_file',arguments:'{"path":"a"}'}},
      {id:'c2',type:'function',function:{name:'read_file',arguments:'{"path":"b"}'}}
    ]},
    {role:'tool',tool_call_id:'c1',name:'read_file',content:'small'},
    {role:'tool',tool_call_id:'c2',name:'read_file',content:'x'.repeat(6000)},
    {role:'user',content:'latest task'},
    {role:'assistant',content:'latest answer'}
  ]
  const c=compactMessages(messages,700,{maxOutputTokens:0,threshold:1,reserveTokens:0,recentTokens:260})
  const call=c.messages.find(m=>m.tool_calls?.length)
  assert.equal(call,undefined)
  assert.equal(c.messages.some(m=>m.tool_call_id==='c1'||m.tool_call_id==='c2'),false)
  assert.ok(c.messages.some(m=>m.content==='latest task'))
  assert.ok(estimateTokens(c.messages)<=700)
})

test('phase 2 hardening: concurrent repository-map builds produce a valid shared cache', async()=>{
  const root=await temp('termagent-p2-concurrent-map-');await writeProject(root);await invalidateRepositoryCache(root)
  const maps=await Promise.all(Array.from({length:20},()=>buildRepositoryMap(root)))
  for(const map of maps){assert.ok(map.files.some(f=>f.path==='lib/auth.ts'));assert.ok(map.edges.some(e=>e.from==='src/auth-client.ts'&&e.to==='lib/auth.ts'))}
  const warm=await buildRepositoryMap(root);assert.equal(warm.cache.miss,0);assert.ok(warm.cache.hit>=3)
  await cleanup(root)
})

test('phase 2 hardening: corrupted repository cache fails closed and rebuilds cleanly', async()=>{
  const root=await temp('termagent-p2-cache-corrupt-');await writeProject(root);await invalidateRepositoryCache(root);const first=await buildRepositoryMap(root)
  await writeFile(first.cache.path,'{"version":2,"root":"broken","files":')
  const rebuilt=await buildRepositoryMap(root);assert.ok(rebuilt.files.some(f=>f.path==='lib/auth.ts'));assert.ok(rebuilt.cache.miss>=3)
  const warm=await buildRepositoryMap(root);assert.equal(warm.cache.miss,0)
  await cleanup(root)
})

test('phase 2 hardening: token estimator is conservative for dense Unicode text', ()=>{
  const ascii=estimateContextTokens('a'.repeat(1200))
  const hindi=estimateContextTokens('नमस्ते'.repeat(300))
  const cjk=estimateContextTokens('漢字'.repeat(300))
  const emoji=estimateContextTokens('😀'.repeat(300))
  assert.equal(ascii,300)
  assert.ok(hindi>ascii*0.35)
  assert.ok(cjk>ascii*0.35)
  assert.ok(emoji>ascii*0.35)
})

test('phase 2 hardening: tool schema bytes are part of the hard request budget', async()=>{
  const root=await temp('termagent-p2-schema-hard-');const store=new SessionStore(path.join(root,'sessions'));const session=await store.create(root,'mock')
  const registry=new ToolRegistry();registry.add({name:'huge_tool',description:'d'.repeat(7000),risk:'read',schema:{type:'object',properties:{q:{type:'string',description:'q'.repeat(5000)}}},execute:async()=>({output:'ok'})})
  const provider={id:'mock',model:'mock',config:{maxTokens:200},calls:0,seen:[],async *stream(messages,tools){this.calls++;this.seen.push({messages,tools});yield {type:'text',delta:'ok'};yield {type:'done',finishReason:'stop'}}}
  const agent=new Agent(provider,registry,store,0,6000,1,undefined,[],{threshold:0.9,reserveTokens:200,recentTokens:600})
  await agent.run({sessionId:session.id,messages:[{role:'user',content:'x'.repeat(18000)}],cwd:root,instructions:'test',prompt:'hello'})
  const total=estimateMessagesTokens(provider.seen[0].messages)+estimateTokens(provider.seen[0].tools)
  assert.ok(total<=5100,`request estimate ${total}`)
  await cleanup(root)
})
test('phase 2 hardening: repository map preserves filenames containing newlines', async()=>{
  const root=await temp('termagent-p2-nul-name-');const git=(args)=>new Promise((resolve,reject)=>execFile('git',args,{cwd:root},(e,stdout)=>e?reject(e):resolve(stdout)))
  await git(['init']);const weird='src/file\nname.ts';await mkdir(path.dirname(path.join(root,weird)),{recursive:true});await writeFile(path.join(root,weird),'export function weirdName() { return true }\n');await git(['add','--',weird])
  const map=await buildRepositoryMap(root);assert.ok(map.files.some(f=>f.path===weird));assert.ok(map.files.find(f=>f.path===weird)?.symbols.some(s=>s.name==='weirdName'))
  await cleanup(root)
})

test('phase 2 hardening: repeated compaction preserves facts from the previous compaction checkpoint', ()=>{
  const first=[
    {role:'system',content:'SYSTEM'},
    {role:'user',content:'Implement authentication in src/auth/service.ts using refresh tokens '+('x'.repeat(800))},
    {role:'assistant',content:'Changed src/auth/service.ts and src/auth/refresh.ts; token rotation is enabled '+('y'.repeat(900))},
    {role:'tool',content:'PASS: npm test auth '+('z'.repeat(700))},
    {role:'user',content:'Then add session expiry handling '+('q'.repeat(700))},
    {role:'assistant',content:'Working on src/session/expiry.ts '+('w'.repeat(800))},
  ]
  const c1=compactMessages(first,420,{maxOutputTokens:0,threshold:1,reserveTokens:0,recentTokens:120})
  assert.ok(c1.summary.includes('auth/service.ts'))
  const c2input=[...c1.messages,
    {role:'user',content:'Now add idle timeout in src/session/idle.ts'},
    {role:'assistant',content:'Added idle timeout and will verify'},
    {role:'tool',content:'PASS: npm test session'},
    {role:'user',content:'Keep the refresh token rotation behavior'},
  ]
  const c2=compactMessages(c2input,420,{maxOutputTokens:0,threshold:1,reserveTokens:0,recentTokens:120})
  const joined=c2.messages.map(m=>typeof m.content==='string'?m.content:'').join('\n')
  assert.match(joined,/auth\/service\.ts/)
  assert.match(joined,/refresh token/i)
  assert.match(joined,/idle\.ts/)
  assert.ok(estimateTokens(c2.messages)<=420)
})

test('phase 2 hardening: combined default and named JavaScript imports map both aliases precisely', async()=>{
  const root=await temp('termagent-p2-combined-import-');await mkdir(path.join(root,'lib'),{recursive:true});await mkdir(path.join(root,'src'),{recursive:true})
  await writeFile(path.join(root,'lib','auth.ts'),'export default class AuthService { login() { return true } }\nexport function authenticateUser() { return true }\n')
  await writeFile(path.join(root,'src','main.ts'),'import AuthService, { authenticateUser as loginUser } from "../lib/auth"\nexport function run() { const service = new AuthService(); return service.login() && loginUser() }\n')
  const analysis=analyzeSource('src/main.ts',await readFile(path.join(root,'src','main.ts'),'utf8'))
  assert.deepEqual(analysis.imports,[
    {name:'AuthService',source:'../lib/auth',imported:'default'},
    {name:'loginUser',source:'../lib/auth',imported:'authenticateUser'}
  ])
  const map=await buildRepositoryMap(root)
  const edge=map.edges.find(e=>e.from==='src/main.ts'&&e.to==='lib/auth.ts')
  assert.ok(edge)
  assert.ok(edge.symbols.includes('AuthService'))
  assert.ok(edge.symbols.includes('loginUser'))
  await cleanup(root)
})

test('phase 2 hardening: side-effect JavaScript imports still create a dependency edge', async()=>{
  const root=await temp('termagent-p2-side-effect-');await mkdir(path.join(root,'src'),{recursive:true});await writeFile(path.join(root,'src','setup.ts'),'export const initialized = true\n');await writeFile(path.join(root,'src','main.ts'),'import "./setup"\nexport const app = true\n')
  const map=await buildRepositoryMap(root)
  assert.ok(map.edges.some(e=>e.from==='src/main.ts'&&e.to==='src/setup.ts'))
  await cleanup(root)
})

test('phase 2 hardening: imported aliases appear in usage references for weighted dependency edges', ()=>{
  const analysis=analyzeSource('src/main.ts','import { authenticateUser as loginUser } from "../lib/auth"\nexport function run() { return loginUser() }\n')
  const refs=analysis.references.filter(r=>r.name==='loginUser'&&r.kind!=='import')
  assert.ok(refs.some(r=>r.kind==='call'&&r.line===2))
})

test('phase 2 hardening: cache notices same-size edits even when mtime is restored', async()=>{
  const root=await temp('termagent-p2-cache-ctime-');await mkdir(path.join(root,'src'),{recursive:true});const file=path.join(root,'src','same.ts')
  await writeFile(file,'export function alpha() { return 1 }\n')
  await invalidateRepositoryCache(root);const first=await buildRepositoryMap(root);const oldMtime=first.files.find(f=>f.path==='src/same.ts')?.mtime
  assert.ok(oldMtime)
  await writeFile(file,'export function bravo() { return 2 }\n')
  await utimes(file, new Date(oldMtime), new Date(oldMtime))
  const next=await buildRepositoryMap(root)
  assert.equal(next.cache.miss,1)
  assert.ok(next.files.find(f=>f.path==='src/same.ts')?.symbols.some(s=>s.name==='bravo'))
  assert.ok(!next.files.find(f=>f.path==='src/same.ts')?.symbols.some(s=>s.name==='alpha'))
  await cleanup(root)
})

test('phase 2 hardening: compaction preserves the exact system prompt when the budget permits', ()=>{
  const system='SYSTEM: follow project instructions exactly. '+('policy '.repeat(140))
  const messages=[
    {role:'system',content:system},
    ...Array.from({length:12},(_,i)=>({role:'user',content:`old request ${i} `+'x'.repeat(220)})),
    {role:'user',content:'current request'},
  ]
  const c=compactMessages(messages,900,{maxOutputTokens:0,threshold:1,reserveTokens:0,recentTokens:180})
  assert.equal(c.messages.find(m=>m.role==='system')?.content,system)
  assert.ok(estimateTokens(c.messages)<=900)
})

test('phase 2 hardening: a new oversized user prompt is compacted before the provider request', async()=>{
  const root=await temp('termagent-p2-prompt-overflow-');const store=new SessionStore(path.join(root,'sessions'));const session=await store.create(root,'mock')
  const provider={id:'mock',model:'mock',config:{maxTokens:100},calls:0,seen:[],async *stream(messages,tools){this.calls++;this.seen.push({messages,tools});yield {type:'text',delta:'ok'};yield {type:'done',finishReason:'stop'}}}
  const registry=new ToolRegistry()
  const existing=[{role:'user',content:'old context '+('x'.repeat(1800))}]
  const agent=new Agent(provider,registry,store,0,1800,1,undefined,[],{threshold:1,reserveTokens:0,recentTokens:260})
  const prompt='new task '+('y'.repeat(2600))
  await agent.run({sessionId:session.id,messages:existing,cwd:root,instructions:'test',prompt})
  assert.equal(provider.calls,1)
  const seen=provider.seen[0]
  assert.ok(estimateMessagesTokens(seen.messages)+estimateTokens(seen.tools)<=1800-100)
  assert.equal([...seen.messages].reverse().find(m=>m.role==='user')?.content,prompt)
  await cleanup(root)
})

test('phase 2 hardening: oversized tool schemas fail before provider execution instead of overflowing the request', async()=>{
  const root=await temp('termagent-p2-schema-fail-');const store=new SessionStore(path.join(root,'sessions'));const session=await store.create(root,'mock')
  const registry=new ToolRegistry();registry.add({name:'huge',description:'x'.repeat(30000),risk:'read',schema:{type:'object'},execute:async()=>({output:'ok'})})
  const provider={id:'mock',model:'mock',config:{maxTokens:50},calls:0,async *stream(){this.calls++;yield {type:'text',delta:'should-not-run'};yield {type:'done',finishReason:'stop'}}}
  const agent=new Agent(provider,registry,store,0,2000,1)
  await assert.rejects(()=>agent.run({sessionId:session.id,messages:[],cwd:root,instructions:'test',prompt:'hello'}),/Tool definitions exceed the configured context budget/)
  assert.equal(provider.calls,0)
  await cleanup(root)
})

test('phase 2 hardening: repository graph avoids same-name N-squared explosion', async()=>{
  const root=await temp('termagent-p2-graph-scale-');await mkdir(path.join(root,'lib'),{recursive:true});await mkdir(path.join(root,'src'),{recursive:true})
  for(let i=0;i<260;i++) await writeFile(path.join(root,'lib',`f${i}.ts`),'export function common() { return true }\n')
  await writeFile(path.join(root,'src','main.ts'),'import { common as selected } from "../lib/f123"\nexport function run() { return selected() }\n')
  const start=Date.now();const map=await buildRepositoryMap(root);const elapsed=Date.now()-start
  assert.ok(elapsed<2500,`repo graph took ${elapsed}ms`)
  assert.ok(map.edges.length<20,`edge count ${map.edges.length}`)
  assert.ok(map.edges.some(e=>e.from==='src/main.ts'&&e.to==='lib/f123.ts'))
  await cleanup(root)
})

test('phase 2 hardening: retrieval maxBytes is enforced in UTF-8 bytes for dense Unicode content', async()=>{
  const root=await temp('termagent-p2-unicode-bytes-');await mkdir(path.join(root,'src'),{recursive:true})
  await writeFile(path.join(root,'src','unicode.ts'),('const needle = "हिन्दी 😀 漢字";\n').repeat(100))
  const map=await buildRepositoryMap(root)
  const ctx=await retrieveContext(map,'needle',{maxFiles:1,maxTokens:2500,maxBytes:700})
  assert.ok(Buffer.byteLength(ctx,'utf8')<=700,`utf8 bytes ${Buffer.byteLength(ctx,'utf8')}`)
  await cleanup(root)
})

test('phase 2 hardening: CommonJS require and Python package imports contribute precise graph edges', async()=>{
  const root=await temp('termagent-p2-cjs-python-');await mkdir(path.join(root,'lib','pkg'),{recursive:true});await mkdir(path.join(root,'src'),{recursive:true})
  await writeFile(path.join(root,'lib','cjs.js'),'module.exports = { helper() { return true } }\n')
  await writeFile(path.join(root,'src','cjs-main.js'),'const auth = require("../lib/cjs")\nmodule.exports = function run() { return auth.helper() }\n')
  await writeFile(path.join(root,'lib','pkg','__init__.py'),'def helper():\n    return True\n')
  await writeFile(path.join(root,'lib','pkg','main.py'),'from . import helper\ndef run():\n    return helper()\n')
  const cjs=analyzeSource('src/cjs-main.js',await readFile(path.join(root,'src','cjs-main.js'),'utf8'))
  assert.ok(cjs.imports.some(i=>i.name==='auth'&&i.source==='../lib/cjs'))
  const py=analyzeSource('lib/pkg/main.py',await readFile(path.join(root,'lib','pkg','main.py'),'utf8'))
  assert.ok(py.imports.some(i=>i.name==='helper'&&i.source==='.'&&i.imported==='helper'))
  const map=await buildRepositoryMap(root)
  assert.ok(map.edges.some(e=>e.from==='src/cjs-main.js'&&e.to==='lib/cjs.js'))
  assert.ok(map.edges.some(e=>e.from==='lib/pkg/main.py'&&e.to==='lib/pkg/__init__.py'))
  await cleanup(root)
})

test('phase 2 hardening: analyzer caps pathological symbol/reference counts per file', ()=>{
  const lines=['export function target() { return true }']
  for(let i=0;i<7000;i++)lines.push(`target(); // ${i}`)
  const analysis=analyzeSource('src/huge.ts',lines.join('\n'))
  assert.ok(analysis.symbols.length<=1000)
  assert.ok(analysis.references.length<=4000)
})
test('phase 2 hardening: active turn objective and todo state survive repeated compaction', ()=>{
  const context={
    activeObjective:'Create demo.txt, edit it twice, run verification, then finish.',
    todo:[
      {id:'1',task:'Create demo.txt',status:'done'},
      {id:'2',task:'Run verification',status:'in_progress'},
      {id:'3',task:'Return final response',status:'pending'},
    ],
    completionState:'1/3 todo items complete',
  }
  let messages=[
    {role:'system',content:'SYSTEM'},
    {role:'user',content:'irrelevant old request '+('x'.repeat(2400))},
    {role:'assistant',content:'old work '+('y'.repeat(2400))},
    {role:'tool',content:'PASS: created demo.txt '+('z'.repeat(1800))},
  ]
  const first=compactMessages(messages,420,{maxOutputTokens:0,threshold:1,reserveTokens:0,recentTokens:80},context)
  const firstSummary=first.messages.find(m=>m.role==='system'&&m.content?.includes('Earlier conversation summary'))?.content||''
  assert.match(firstSummary,/Create demo\.txt, edit it twice, run verification, then finish\./)
  assert.match(firstSummary,/\[x\] 1: Create demo\.txt/)
  assert.match(firstSummary,/\[>\] 2: Run verification/)
  assert.match(firstSummary,/\[ \] 3: Return final response/)
  messages=[
    ...first.messages,
    {role:'assistant',content:'more intermediate state '+('q'.repeat(2600))},
    {role:'tool',content:'same state '+('r'.repeat(1800))},
  ]
  const second=compactMessages(messages,420,{maxOutputTokens:0,threshold:1,reserveTokens:80,recentTokens:80},context)
  const secondSummary=second.messages.find(m=>m.role==='system'&&m.content?.includes('Earlier conversation summary'))?.content||''
  assert.match(secondSummary,/Create demo\.txt, edit it twice, run verification, then finish\./)
  assert.match(secondSummary,/\[>\] 2: Run verification/)
})
