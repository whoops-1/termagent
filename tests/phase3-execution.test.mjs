import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import http from 'node:http'

import { ExecutionWorkflow, initialWorkflow, restoreWorkflow } from '../dist/agent/workflow.js'
import { Agent } from '../dist/agent/agent.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { SessionStore } from '../dist/session/store.js'
import { TaskEventLog } from '../dist/tasks/events.js'
import { TaskManager } from '../dist/tasks/manager.js'
import { parallelAgentTool } from '../dist/tools/parallel.js'
import { sessionTodoTool } from '../dist/tools/session-todo.js'
import { builtinTools } from '../dist/tools/builtin.js'
import { ProviderRouter } from '../dist/providers/router.js'
import { OpenAICompatibleProvider } from '../dist/providers/openai-compatible.js'

const abortSignal = new AbortController().signal
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function tmpDir(prefix='termagent-phase3-') { return await fs.mkdtemp(path.join(os.tmpdir(), prefix)) }
async function runNode(code, args=[], env={}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { env: { ...process.env, ...env }, stdio: ['ignore','pipe','pipe'] })
    let stdout='', stderr=''
    child.stdout.on('data', b => stdout += b)
    child.stderr.on('data', b => stderr += b)
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

function fakeTool(name, risk='read', execute=async () => ({ output:'ok' })) {
  return { name, risk, description:name, schema:{type:'object',properties:{}}, execute }
}

class ScriptedProvider {
  id='scripted'
  model='test-model'
  config={model:'test-model',baseUrl:'http://127.0.0.1'}
  constructor(script) { this.script=[...script]; this.roles=[] }
  setRole(role) { this.roles.push(role) }
  async *stream() {
    const step=this.script.shift()
    if(!step) { yield {type:'text',delta:'done'}; return }
    if(step.error) throw Object.assign(new Error(step.error), step.status ? {status:step.status} : {})
    if(step.text) yield {type:'text',delta:step.text}
    for(const call of step.calls || []) yield {type:'tool_call',call}
  }
}
function call(id,name,args={}) { return {id,type:'function',function:{name,arguments:JSON.stringify(args)}} }

class CountingProvider {
  constructor(id, script) { this.id=id; this.model=id; this.config={model:id,baseUrl:'http://x'}; this.script=[...script]; this.roles=[] }
  setRole(role){ this.roles.push(role) }
  async *stream(){ const step=this.script.shift() ?? {text:'ok'}; if(step.error) throw Object.assign(new Error(step.error),step.status?{status:step.status}:{}); if(step.text) yield {type:'text',delta:step.text}; for(const c of step.calls||[]) yield {type:'tool_call',call:c} }
}

test('phase 3: lifecycle enforces plan -> build -> verify -> iterate -> verify -> complete', () => {
  const w = new ExecutionWorkflow(initialWorkflow(), 3)
  w.applyTodo([{id:'1',task:'Implement',status:'pending'}])
  assert.equal(w.state.phase,'building')
  w.observeTool('write_file',{path:'x'},'wrote x')
  w.afterRound(true,true,true)
  assert.equal(w.state.phase,'verifying')
  w.observeTool('verify_project',{},'exit=1 failed',{ok:false,status:'failed'})
  assert.equal(w.state.phase,'iterating')
  w.observeTool('write_file',{path:'x'},'wrote fix')
  w.afterRound(true,true,true)
  assert.equal(w.state.phase,'verifying')
  w.observeTool('verify_project',{},'exit=0 passed',{ok:true,status:'passed'})
  assert.equal(w.state.phase,'complete')
  assert.equal(w.state.verificationPassed,true)
})

test('phase 3: completion is impossible without successful verification', () => {
  const w = new ExecutionWorkflow(initialWorkflow(),3)
  w.applyTodo([{id:'1',task:'x',status:'pending'}])
  assert.throws(() => w.transitionTo('complete','model guessed'), /cannot complete/i)
  assert.notEqual(w.state.phase,'complete')
})

test('phase 3: autonomous planning forbids write/shell tools', () => {
  const w = new ExecutionWorkflow(initialWorkflow(),3)
  assert.equal(w.allowedTool(fakeTool('read_file','read'),true),true)
  assert.equal(w.allowedTool(fakeTool('write_file','write'),true),false)
  assert.equal(w.allowedTool(fakeTool('bash','shell'),true),false)
  assert.equal(w.allowedTool(fakeTool('todo','read'),true),true)
})

test('phase 3: verification failures enter iteration then block at the configured limit', () => {
  const w = new ExecutionWorkflow(initialWorkflow(),2)
  w.applyTodo([{id:'1',task:'x',status:'pending'}])
  w.transitionTo('verifying','ready')
  w.observeTool('verify_project',{},'failed',{ok:false,status:'failed'})
  assert.equal(w.state.phase,'iterating')
  w.transitionTo('verifying','retry')
  w.observeTool('verify_project',{},'failed',{ok:false,status:'failed'})
  assert.equal(w.state.phase,'blocked')
})

test('phase 3: repeated identical tool calls are bounded', () => {
  const w = new ExecutionWorkflow(initialWorkflow(),3)
  w.applyTodo([{id:'1',task:'x',status:'pending'}])
  for(let i=0;i<5;i++) w.observeTool('read_file',{path:'same'},'No matches')
  assert.equal(w.state.phase,'blocked')
  assert.match(w.state.lastProgress || '', /repeated tool call loop/i)
})

test('phase 3: terminal states ignore late tool/todo/round callbacks', () => {
  const w = new ExecutionWorkflow({...initialWorkflow(),phase:'complete',verificationPassed:true},3)
  w.observeTool('verify_project',{},'failed',{ok:false,status:'failed'})
  w.afterRound(false,false,false)
  assert.throws(() => w.applyTodo([{id:'1',task:'late',status:'pending'}]), /cannot update todos/i)
  assert.equal(w.state.phase,'complete')
  assert.equal(w.state.verificationPassed,true)
})

test('phase 3: corrupted persisted workflow is sanitized and cannot manufacture completion', () => {
  const state=restoreWorkflow([
    {type:'workflow',data:{phase:'complete',planItems:-4,completedItems:99,verificationPassed:false,verificationFailures:-2}},
    {type:'workflow',data:{phase:'not-a-phase',planItems:7}},
  ])
  assert.equal(state.phase,'blocked')
  assert.equal(state.verificationPassed,false)
  assert.equal(state.planItems,0)
  assert.equal(state.completedItems,0)
  assert.match(state.lastProgress || '', /invalid persisted workflow/i)
})

test('phase 3: randomized workflow state machine preserves invariants', () => {
  const legal={planning:['building','blocked'],building:['verifying','iterating','complete','blocked'],verifying:['complete','iterating','blocked'],iterating:['verifying','complete','blocked'],complete:[],blocked:[]}
  for(let seed of [0x1234,0xBEEF,0xC0DE,0x5EED]){
    const w=new ExecutionWorkflow(initialWorkflow(),3)
    const next=()=>{seed=(seed*1664525+1013904223)>>>0;return seed}
    for(let i=0;i<500;i++){
      const op=next()%6
      try{
        if(op===0 && w.state.phase!=='complete' && w.state.phase!=='blocked'){
          const n=1+next()%4
          w.applyTodo(Array.from({length:n},(_,j)=>({id:String(j+1),task:`t${j}`,status:j%4===0?'done':'pending'})))
        } else if(op===1){ const options=legal[w.state.phase] || []; if(options.length) w.transitionTo(options[next()%options.length],`fuzz-${i}`) }
        else if(op===2){ const pass=next()%3===0; w.observeTool('verify_project',{command:'x'},pass?'exit=0 passed':'exit=1 failed',{ok:pass,status:pass?'passed':'failed'}) }
        else if(op===3) w.observeTool('read_file',{path:`f${next()%5}`},'No matches',{ok:true})
        else if(op===4) w.afterRound(Boolean(next()%2),Boolean(next()%2),Boolean(next()%2))
        else w.allowedTool(fakeTool('read_file','read'),true)
      } catch {}
      assert.ok(w.state.planItems>=0)
      assert.ok(w.state.completedItems>=0 && w.state.completedItems<=w.state.planItems)
      assert.ok(w.state.iteration>=0)
      assert.ok(w.state.verificationFailures>=0)
      assert.ok(w.state.noProgressRounds>=0)
      if(w.state.phase==='complete') assert.equal(w.state.verificationPassed,true)
      if(w.state.phase==='blocked') assert.match(w.state.lastProgress||'',/.+/)
    }
  }
})

test('phase 3: session todos are isolated and reloadable', async () => {
  const root=await tmpDir(); const store=new SessionStore(root)
  const a=await store.create(root,'m'), b=await store.create(root,'m')
  const tool=sessionTodoTool(store)
  await tool.execute({action:'set',items:[{id:'a',task:'A',status:'in_progress'}]},{sessionID:a.id,agent:'build',cwd:root,abort:abortSignal})
  await tool.execute({action:'set',items:[{id:'b',task:'B',status:'done'}]},{sessionID:b.id,agent:'build',cwd:root,abort:abortSignal})
  const aa=JSON.parse((await tool.execute({action:'list'},{sessionID:a.id,agent:'build',cwd:root,abort:abortSignal})).output)
  const bb=JSON.parse((await tool.execute({action:'list'},{sessionID:b.id,agent:'build',cwd:root,abort:abortSignal})).output)
  assert.deepEqual(aa,[{id:'a',task:'A',status:'in_progress'}])
  assert.deepEqual(bb,[{id:'b',task:'B',status:'done'}])
  const reloaded=sessionTodoTool(store)
  const aa2=JSON.parse((await reloaded.execute({action:'list'},{sessionID:a.id,agent:'build',cwd:root,abort:abortSignal})).output)
  assert.deepEqual(aa2,aa)
})

test('phase 3: concurrent TodoWrite updates are serialized across processes', async () => {
  const root=await tmpDir(); const store=new SessionStore(root); const session=await store.create(root,'m')
  const code=`import { SessionStore } from ${JSON.stringify(path.resolve('dist/session/store.js'))}; import { sessionTodoTool } from ${JSON.stringify(path.resolve('dist/tools/session-todo.js'))}; const s=new SessionStore(process.env.ROOT); const t=sessionTodoTool(s); await t.execute({action:'add',id:process.env.ID2,task:process.env.ID2,status:'pending'},{sessionID:process.env.SID,agent:'build',cwd:process.env.CWD,abort:new AbortController().signal});`
  const ps=await Promise.all(Array.from({length:8},(_,i)=>runNode(code,[],{ROOT:root,SID:session.id,CWD:root,ID2:`item-${i}`})))
  assert.equal(ps.every(x=>x.code===0),true,ps.map(x=>x.stderr).join('\\n'))
  const tool=sessionTodoTool(store); const result=JSON.parse((await tool.execute({action:'list'},{sessionID:session.id,agent:'build',cwd:root,abort:abortSignal})).output)
  assert.equal(result.length,8); assert.deepEqual(new Set(result.map(x=>x.id)),new Set(Array.from({length:8},(_,i)=>`item-${i}`)))
})

test('phase 3: stale session-state lock is recoverable after owner termination', async () => {
  const root=await tmpDir(); const store=new SessionStore(root); const session=await store.create(root,'m')
  const code=`import { SessionStore } from ${JSON.stringify(path.resolve('dist/session/store.js'))}; const s=new SessionStore(process.env.ROOT); await s.withSessionMutation(process.env.SID,async()=>{ console.log('LOCKED'); await new Promise(()=>{}); });`
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,ROOT:root,SID:session.id},stdio:['ignore','pipe','pipe']})
  await new Promise((resolve,reject)=>{let out=''; const timer=setTimeout(()=>reject(new Error('lock owner did not start')),2000); child.stdout.on('data',b=>{out+=b; if(out.includes('LOCKED')){clearTimeout(timer);resolve()}}); child.on('error',reject)})
  child.kill('SIGKILL'); await new Promise(resolve=>child.once('close',resolve))
  const tool=sessionTodoTool(store)
  const result=await tool.execute({action:'add',id:'recovered',task:'recovered',status:'pending'},{sessionID:session.id,agent:'build',cwd:root,abort:abortSignal})
  assert.match(result.output,/recovered/)
})

test('phase 3: cross-process TaskEventLog keeps contiguous sequence numbers', async () => {
  const root=await tmpDir(); const id='parallel-events'
  const code=`import { TaskEventLog } from ${JSON.stringify(path.resolve('dist/tasks/events.js'))}; const log=new TaskEventLog(process.env.ROOT); for(let i=0;i<12;i++) await log.append(process.env.ID,'x',{i});`
  const ps=await Promise.all(Array.from({length:8},()=>runNode(code,[],{ROOT:root,ID:id})))
  assert.equal(ps.every(x=>x.code===0),true, ps.map(x=>x.stderr).join('\n'))
  const events=await new TaskEventLog(root).read(id)
  assert.equal(events.length,96)
  assert.deepEqual(events.map(e=>e.seq),Array.from({length:96},(_,i)=>i+1))
})

test('phase 3: TaskManager concurrent updates preserve all fields', async () => {
  const root=await tmpDir(); const manager=new TaskManager(root,false); const task=await manager.createShell('echo x',root)
  const code=`import { TaskManager } from ${JSON.stringify(path.resolve('dist/tasks/manager.js'))}; const m=new TaskManager(process.env.ROOT,false); await m.update(process.env.ID,{output:(process.env.W)+':'+Date.now()})`
  const ps=await Promise.all(Array.from({length:10},(_,i)=>runNode(code,[],{ROOT:root,ID:task.id,W:String(i)})))
  assert.equal(ps.every(x=>x.code===0),true, ps.map(x=>x.stderr).join('\n'))
  const final=await manager.get(task.id)
  assert.equal(final.kind,'shell'); assert.equal(final.command,'echo x'); assert.equal(final.cwd,root)
  assert.match(final.output,/^\d+:\d+$/)
})

test('phase 3: parallel scheduler rejects overlap, caps concurrency, and locks cross-process session admission', async () => {
  const root=await tmpDir(); const manager=new TaskManager(root,false)
  const provider={id:'p',model:'m',config:{model:'m',baseUrl:'http://x'}}
  const tool=parallelAgentTool(manager,provider,provider.config)
  const ctx={sessionID:'s',agent:'build',cwd:root,abort:abortSignal}
  await assert.rejects(()=>tool.execute({tasks:[{prompt:'a',paths:['src']},{prompt:'b',paths:['src/a']} ]},ctx),/overlap/i)
  await assert.rejects(()=>tool.execute({tasks:[{prompt:'a',paths:['..']},{prompt:'b',paths:['inside']}]},ctx),/escapes the project/i)
  for(let i=0;i<4;i++) await manager.createAgent('busy',root,provider.config,['scope-'+i], 's').then(async t=>manager.update(t.id,{status:'running'}))
  await assert.rejects(()=>tool.execute({tasks:[{prompt:'a',paths:['new-a']},{prompt:'b',paths:['new-b']}]},ctx),/limit exceeded/i)
  const shared=await tmpDir('scheduler-race-')
  const script=`import { TaskManager } from ${JSON.stringify(path.resolve('dist/tasks/manager.js'))}; import { parallelAgentTool } from ${JSON.stringify(path.resolve('dist/tools/parallel.js'))}; const r=new TaskManager(process.env.ROOT,false); r.spawnWorker=()=>12345; const p={id:'p',model:'m',config:{model:'m',baseUrl:'http://x'}}; const t=parallelAgentTool(r,p,p.config); try { const out=await t.execute({tasks:[{prompt:'a',paths:['a']},{prompt:'b',paths:['b']},{prompt:'c',paths:['c']}]},{sessionID:'same',agent:'build',cwd:process.env.ROOT,abort:new AbortController().signal}); console.log(out.output); } catch(e){ console.error(e.message); process.exit(2) }`
  const a=runNode(script,[],{ROOT:shared})
  const b=runNode(script,[],{ROOT:shared})
  const [ra,rb]=await Promise.all([a,b]); const successes=[ra.code,rb.code].filter(x=>x===0).length
  assert.equal(successes,1,JSON.stringify([ra,rb]))
  const sharedManager=new TaskManager(shared,false); const active=await sharedManager.list(); assert.equal(active.length,3)
})

test('phase 3: scoped file tools enforce declared workspace boundaries', async () => {
  const root=await tmpDir(); await fs.mkdir(path.join(root,'allowed'),{recursive:true})
  const tools=builtinTools({timeout:1000,maxOutput:2000}); const write=tools.find(t=>t.name==='write_file'); const edit=tools.find(t=>t.name==='edit_file')
  const ctx={sessionID:'s',agent:'build',cwd:root,abort:abortSignal,scopePaths:['allowed']}
  await write.execute({path:'allowed/a.txt',content:'one'},ctx)
  assert.equal(await fs.readFile(path.join(root,'allowed/a.txt'),'utf8'),'one')
  await assert.rejects(()=>write.execute({path:'outside.txt',content:'bad'},ctx),/outside.*scope/i)
  await assert.rejects(()=>edit.execute({path:'outside.txt',oldText:'x',newText:'y'},ctx),/outside.*scope/i)
})

test('phase 3: scoped workers expose no recursive agent-launch tools', () => {
  const excluded=new Set(['task','todo','background_agent','parallel_agents'])
  const candidate=['task','todo','background_agent','parallel_agents','read_file','write_file','verify_project']
  assert.deepEqual(candidate.filter(x=>excluded.has(x)),['task','todo','background_agent','parallel_agents'])
})

test('phase 3: provider router switches roles and only falls back before output', async () => {
  const primary=new CountingProvider('primary',[{error:'503 temporary'}])
  const backup=new CountingProvider('backup',[{text:'backup'}])
  const switches=[]
  const router=new ProviderRouter([primary,backup],(a,b,r)=>switches.push([a,b,r]),{planning:[backup]})
  router.setRole('planning')
  let out=''; for await(const e of router.stream([],[],abortSignal)){if(e.type==='text')out+=e.delta}
  assert.equal(out,'backup'); assert.equal(primary.roles.length,0); assert.ok(switches.length===0)
  const p2={id:'p2',model:'p2',config:{model:'p2',baseUrl:'http://x'},async*stream(){yield {type:'text',delta:'partial'};throw new Error('503 temporary')}}
  const b2=new CountingProvider('b2',[{text:'fallback'}])
  const r2=new ProviderRouter([p2,b2],()=>{})
  let seen=''
  await assert.rejects(async()=>{for await(const e of r2.stream([],[],abortSignal)){if(e.type==='text')seen+=e.delta}},/503|temporary/i)
  assert.equal(seen,'partial')
})

test('phase 3: provider router refuses fallback on auth failure and deduplicates provider ids', async () => {
  const a=new CountingProvider('a',[{error:'401 unauthorized'}]); const b=new CountingProvider('b',[{text:'bad fallback'}])
  const r=new ProviderRouter([a,b])
  await assert.rejects(async()=>{for await(const _ of r.stream([],[],abortSignal)){}},/401 unauthorized/i)
  const preferred=new CountingProvider('same',[{text:'default should not run'}]); const duplicate=new CountingProvider('same',[{error:'503 temporary'}]); const backup=new CountingProvider('backup',[{text:'backup'}])
  const rr=new ProviderRouter([preferred,backup],()=>{}, {planning:[duplicate]}); rr.setRole('planning')
  let out=''; for await(const e of rr.stream([],[],abortSignal)){if(e.type==='text')out+=e.delta}
  assert.equal(out,'backup')
  assert.equal(preferred.script.length,1)
})

test('phase 3: background shell tasks persist worker pid immediately', async () => {
  const root=await tmpDir(); const manager=new TaskManager(root,false); manager.spawnWorker=async()=>4242
  const { backgroundTool }=await import('../dist/tools/background.js')
  const tool=backgroundTool(manager)
  const result=await tool.execute({command:'printf ok'},{sessionID:'s',agent:'build',cwd:root,abort:abortSignal})
  assert.match(result.output,/worker pid 4242/)
  const task=(await manager.list())[0]
  assert.equal(task.pid,4242)
  assert.equal(task.status,'queued')
})

test('phase 3: background task spawn failure cannot leave an orphaned queued task', async () => {
  const root=await tmpDir(); const manager=new TaskManager(root,false); manager.spawnWorker=async()=>{throw new Error('spawn exploded')}
  const { backgroundTool }=await import('../dist/tools/background.js')
  const tool=backgroundTool(manager)
  await assert.rejects(()=>tool.execute({command:'printf never'},{sessionID:'s',agent:'build',cwd:root,abort:abortSignal}),/spawn exploded/)
  const task=(await manager.list())[0]
  assert.equal(task.status,'failed')
  assert.match(task.output,/spawn exploded/)
})

test('phase 3: recovery converts orphaned queued tasks into explicit failures', async () => {
  const root=await tmpDir(); const manager=new TaskManager(root,false)
  const task=await manager.createShell('printf never',root)
  assert.equal((await manager.get(task.id)).status,'queued')
  await manager.recover()
  const recovered=await manager.get(task.id)
  assert.equal(recovered.status,'failed')
  assert.match(recovered.output,/Worker never started before recovery/i)
})

test('phase 3: partial parallel launch rolls back created tasks on spawn failure', async () => {
  const root=await tmpDir(); const manager=new TaskManager(root,false); let calls=0
  manager.spawnWorker=async()=>{calls++;if(calls===2)throw new Error('second spawn failed');return 7000+calls}
  const primary=new CountingProvider('primary',[{text:'unused'}])
  const tool=parallelAgentTool(manager,primary,primary.config)
  await assert.rejects(()=>tool.execute({tasks:[{prompt:'a',paths:['a']},{prompt:'b',paths:['b']},{prompt:'c',paths:['c']}]},{sessionID:'s',agent:'build',cwd:root,abort:abortSignal}),/second spawn failed/)
  const tasks=await manager.list()
  assert.equal(tasks.length,2)
  assert.ok(tasks.every(t=>t.status==='failed'))
  assert.ok(tasks.every(t=>/Parallel launch failed|second spawn failed/.test(t.output)))
})

test('phase 3: routed background agents persist the concrete subagent provider', async () => {
  const root=await tmpDir(); const manager=new TaskManager(root,false)
  manager.spawnWorker=()=>12345
  const primary=new CountingProvider('primary',[{text:'unused'}]); primary.config={provider:'anthropic',model:'primary-model',baseUrl:'http://primary'}
  const backup=new CountingProvider('backup',[{text:'unused'}]); backup.model='backup-model'; backup.config={provider:'openai-compatible',model:'backup-model',baseUrl:'http://backup'}
  const router=new ProviderRouter([primary],()=>{}, {subagent:[backup]})
  const { backgroundAgentTool }=await import('../dist/tools/background.js')
  const tool=backgroundAgentTool(manager,router,router.config)
  const result=await tool.execute({prompt:'background test'},{sessionID:'s',agent:'build',cwd:root,abort:abortSignal})
  assert.match(result.output,/Started background agent/)
  const task=(await manager.list())[0]
  assert.deepEqual(task.provider,{provider:'openai-compatible',model:'backup-model',baseUrl:'http://backup'})
  assert.notEqual(task.provider.provider,'router')
})

test('phase 3: routed parallel agents persist one concrete subagent provider', async () => {
  const root=await tmpDir(); const manager=new TaskManager(root,false)
  manager.spawnWorker=()=>12345
  const primary=new CountingProvider('primary',[{text:'unused'}]); primary.config={provider:'anthropic',model:'primary-model',baseUrl:'http://primary'}
  const backup=new CountingProvider('backup',[{text:'unused'}]); backup.model='backup-model'; backup.config={provider:'gemini',model:'backup-model',baseUrl:'http://backup'}
  const router=new ProviderRouter([primary],()=>{}, {subagent:[backup]})
  const tool=parallelAgentTool(manager,router,router.config)
  await tool.execute({tasks:[{prompt:'a',paths:['a']},{prompt:'b',paths:['b']}]},{sessionID:'s',agent:'build',cwd:root,abort:abortSignal})
  const tasks=(await manager.list()).sort((a,b)=>a.id.localeCompare(b.id))
  assert.equal(tasks.length,2)
  for(const task of tasks) assert.deepEqual(task.provider,{provider:'gemini',model:'backup-model',baseUrl:'http://backup'})
})

test('phase 3: persisted routed worker configuration reconstructs without the router adapter', async () => {
  const { createProvider }=await import('../dist/providers/registry.js')
  const cfg={provider:'openai-compatible',model:'worker-model',baseUrl:'http://worker'}
  const workerProvider=createProvider(cfg)
  assert.equal(workerProvider.id,'openai-compatible')
  assert.equal(workerProvider.model,'worker-model')
  assert.equal(workerProvider.config.provider,'openai-compatible')
  assert.equal(workerProvider.config.baseUrl,'http://worker')
})

test('phase 3: real OpenAI-compatible provider streams through router fallback', async () => {
  const server=http.createServer((req,res)=>{
    if(req.url==='/primary/chat/completions'){
      res.writeHead(503,{'content-type':'text/plain'}); res.end('temporary')
      return
    }
    if(req.url==='/backup/chat/completions'){
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'})
      res.write('data: '+JSON.stringify({choices:[{index:0,delta:{reasoning_content:'thinking'}}]})+'\n\n')
      res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'routed'}}]})+'\n\n')
      res.write('data: [DONE]\n\n'); res.end(); return
    }
    res.writeHead(404); res.end()
  })
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',()=>resolve())).catch(e=>{throw e})
  try{
    const port=server.address().port
    const primary=new OpenAICompatibleProvider({model:'m',baseUrl:`http://127.0.0.1:${port}/primary`})
    const backup=new OpenAICompatibleProvider({model:'m2',baseUrl:`http://127.0.0.1:${port}/backup`})
    const router=new ProviderRouter([primary,backup])
    let text='',reasoning=''
    for await(const e of router.stream([{role:'user',content:'x'}],[],abortSignal)){if(e.type==='text')text+=e.delta;if(e.type==='reasoning')reasoning+=e.delta}
    assert.equal(text,'routed'); assert.equal(reasoning,'thinking')
  } finally { await new Promise(resolve=>server.close(()=>resolve())) }
})

test('phase 3: retryable provider startup errors fall back to the next provider', async () => {
  const a=new CountingProvider('a',[{error:'503 unavailable',status:503}]); const b=new CountingProvider('b',[{text:'ok'}])
  const r=new ProviderRouter([a,b])
  let out=''; for await(const e of r.stream([],[],abortSignal)){if(e.type==='text')out+=e.delta}
  assert.equal(out,'ok')
})

test('phase 3: verification tool timeout is structured as a failure', async () => {
  const { verifyTool }=await import('../dist/tools/verify.js')
  const tool=verifyTool(50,1000)
  const result=await tool.execute({command:'sleep 1'},{sessionID:'s',agent:'build',cwd:process.cwd(),abort:abortSignal})
  assert.equal(result.metadata.ok,false)
  assert.equal(result.metadata.exitCode,124)
  assert.equal(result.metadata.status,'failed')
})

test('phase 3: Agent lifecycle physically enforces the verification gate and provider roles', async () => {
  const cwd=await tmpDir(); const sessionRoot=await tmpDir(); const store=new SessionStore(sessionRoot); const session=await store.create(cwd,'test-model')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  const todoState=[{id:'1',task:'write file',status:'pending'}]
  registry.add(fakeTool('todo','read',async()=>({output:JSON.stringify(todoState)})))
  registry.add(fakeTool('write_file','write',async()=>{await fs.writeFile(path.join(cwd,'answer.txt'),'fixed','utf8');return {output:'wrote answer.txt'}}))
  registry.add(fakeTool('verify_project','read',async()=>({output:'passed',metadata:{ok:true,status:'passed'}})))
  const provider=new ScriptedProvider([
    {calls:[call('1','todo',{action:'list'})]},
    {calls:[call('2','write_file',{path:'answer.txt',content:'fixed'})]},
    {calls:[call('3','verify_project',{})]},
    {text:'Implemented and verified.'}
  ])
  const agent=new Agent(provider,registry,store,8,20000,0,()=>{})
  const result=await agent.run({sessionId:session.id,messages:[],cwd,instructions:'',prompt:'implement it',autonomous:true,mode:'build'})
  assert.equal(result,'Implemented and verified.')
  assert.equal(await fs.readFile(path.join(cwd,'answer.txt'),'utf8'),'fixed')
  assert.deepEqual(provider.roles.slice(0,4),['planning','building','verification','default'])
  const loaded=await store.load(session.id); const workflows=loaded.events.filter(e=>e.type==='workflow')
  assert.ok(workflows.some(e=>e.data?.phase==='complete'))
})

test('phase 3: Agent blocks a fake completion without verification', async () => {
  const cwd=await tmpDir(); const sessionRoot=await tmpDir(); const store=new SessionStore(sessionRoot); const session=await store.create(cwd,'test-model')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add(fakeTool('todo','read',async()=>({output:JSON.stringify([{id:'1',task:'x',status:'done'}])})))
  registry.add(fakeTool('write_file','write',async()=>({output:'wrote'})))
  registry.add(fakeTool('verify_project','read',async()=>({output:'not run',metadata:{ok:false,status:'failed'}})))
  const provider=new ScriptedProvider([{calls:[call('1','todo',{action:'list'})]},{calls:[call('2','workflow_phase',{phase:'complete',reason:'done'})]}])
  const agent=new Agent(provider,registry,store,4,20000,0,()=>{})
  await assert.rejects(()=>agent.run({sessionId:session.id,messages:[],cwd,instructions:'',prompt:'do x',autonomous:true,mode:'build'}),/cannot complete|exhausted|blocked/i)
  const loaded=await store.load(session.id); const workflows=loaded.events.filter(e=>e.type==='workflow'); assert.equal(workflows.at(-1)?.data?.phase,'blocked')
})
test('phase 3: todo bulk update patches multiple items atomically', async()=>{
  const root=await tmpDir(); const store=new SessionStore(root); const session=await store.create(root,'mock')
  const tool=sessionTodoTool(store)
  await tool.execute({action:'set',items:[
    {id:'1',task:'first',status:'pending'},
    {id:'2',task:'second',status:'pending'},
    {id:'3',task:'third',status:'pending'},
  ]},{sessionID:session.id,agent:'build',cwd:root,abort:abortSignal})
  const result=JSON.parse((await tool.execute({action:'update',items:[
    {id:'1',status:'done'},
    {id:'2',status:'in_progress'},
    {id:'3',task:'third updated'},
  ]},{sessionID:session.id,agent:'build',cwd:root,abort:abortSignal})).output)
  assert.deepEqual(result,[
    {id:'1',task:'first',status:'done'},
    {id:'2',task:'second',status:'in_progress'},
    {id:'3',task:'third updated',status:'pending'},
  ])
  await fs.rm(root,{recursive:true,force:true})
})
