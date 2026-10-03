import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Agent } from '../dist/agent/agent.js'
import { SessionStore } from '../dist/session/store.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { builtinTools } from '../dist/tools/builtin.js'

class MockProvider {
  constructor(){ this.calls=0 }
  async *stream(messages){
    this.calls++
    if(this.calls===1){
      yield {type:'tool_call',call:{id:'c1',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'hello.txt',content:'hello from agent'})}}}
      yield {type:'done',finishReason:'tool_calls'}
    } else {
      yield {type:'text',delta:'Done.'}
      yield {type:'done',finishReason:'stop'}
    }
  }
}

test('agent executes structured tool call and persists messages', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-'))
  const store=new SessionStore(path.join(root,'sessions'))
  const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  builtinTools({timeout:5000,maxOutput:5000}).forEach(t=>registry.add(t))
  const provider=new MockProvider(); const agent=new Agent(provider,registry,store,4)
  let output=''
  await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'create hello',onText:s=>output+=s})
  assert.equal(output,'Done.')
  assert.equal(await readFile(path.join(root,'hello.txt'),'utf8'),'hello from agent')
  const loaded=await store.load(meta.id)
  assert.ok(loaded.messages.some(m=>m.role==='tool'))
  await rm(root,{recursive:true,force:true})
})
test('autonomous mode instructs plan, implementation and verification', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-auto-')); const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto')); let seen=''
  class P { async *stream(messages){ seen=messages.find(m=>m.role==='system')?.content||''; yield {type:'text',delta:'verified'}; yield {type:'done',finishReason:'stop'} } }
  const agent=new Agent(new P(),registry,store,2); await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'fix it',autonomous:true});
  assert.match(seen,/AUTONOMOUS MODE/); assert.match(seen,/verify_project/); await rm(root,{recursive:true,force:true})
})
test('agent tool loop is protected by the repeat guard before a provider can burn an unlimited turn', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-uncapped-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add({name:'read_file',description:'read',risk:'read',schema:{type:'object'},execute:async()=>({output:'ok'})})
  class P {
    calls=0
    async *stream(messages,schemas){
      this.calls++
      if(this.calls<=35){
        yield {type:'tool_call',call:{id:`c${this.calls}`,type:'function',function:{name:'read_file',arguments:'{}'}}}
        yield {type:'done',finishReason:'tool_calls'}
      } else {
        yield {type:'text',delta:'stopped by provider'}
        yield {type:'done',finishReason:'stop'}
      }
    }
  }
  const provider=new P(); const agent=new Agent(provider,registry,store,0)
  await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'explore'})
  assert.equal(provider.calls,4)
  await rm(root,{recursive:true,force:true})
})

test('agent respects an explicit tool-step cap with a final text-only step', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-capped-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add({name:'read_file',description:'read',risk:'read',schema:{type:'object'},execute:async()=>({output:'ok'})})
  class P {
    calls=0
    async *stream(messages,schemas){
      this.calls++
      if(this.calls===1){
        assert.equal(schemas.length,1)
        yield {type:'tool_call',call:{id:'c1',type:'function',function:{name:'read_file',arguments:'{}'}}}
        yield {type:'done',finishReason:'tool_calls'}
      } else {
        assert.equal(schemas.length,0)
        yield {type:'text',delta:'summary'}
        yield {type:'done',finishReason:'stop'}
      }
    }
  }
  const provider=new P(); const agent=new Agent(provider,registry,store,2)
  let output=''
  await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'explore',onText:s=>output+=s})
  assert.equal(provider.calls,2)
  assert.equal(output,'summary')
  await rm(root,{recursive:true,force:true})
})
test('agent retries an empty provider response instead of silently ending', async()=>{
  const { Agent } = await import('../dist/agent/agent.js')
  const { SessionStore } = await import('../dist/session/store.js')
  const { ToolRegistry } = await import('../dist/tools/registry.js')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  let calls=0
  const provider={model:'mock',id:'mock',stream:async function*(){ calls++; if(calls<3){yield {type:'done',finishReason:'stop'};return} yield {type:'text',delta:'recovered'};yield {type:'done',finishReason:'stop'} }}
  const root=await mkdtemp(join(tmpdir(),'termagent-empty-')); const store=new SessionStore(root); const session=await store.create(root,'mock');
  const agent=new Agent(provider,new ToolRegistry(),store,0,12000,2); const messages=[];
  const text=await agent.run({sessionId:session.id,messages,cwd:root,instructions:'',prompt:'hello'});
  assert.equal(text,'recovered'); assert.equal(calls,3);
  await rm(root,{recursive:true,force:true})
})
test('agent forwards explicit reasoning and persists it with the assistant message', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-reasoning-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  class P { async *stream(){ yield {type:'reasoning',delta:'inspect first'}; yield {type:'reasoning',delta:' then explain'}; yield {type:'text',delta:'Done'}; yield {type:'done',finishReason:'stop'} } }
  const seen=[]
  const agent=new Agent(new P(),registry,store,0); await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'explain',onReasoning:s=>seen.push(s)})
  assert.deepEqual(seen,['inspect first',' then explain'])
  const loaded=await store.load(meta.id); const assistant=loaded.messages.find(m=>m.role==='assistant')
  assert.equal(assistant.reasoning,'inspect first then explain')
  assert.equal(assistant.content,'Done')
  await rm(root,{recursive:true,force:true})
})
test('normal turns stop after repeated identical tool calls', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-loop-identical-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add({name:'read_file',description:'read',risk:'read',schema:{type:'object'},execute:async()=>({output:'ok'})})
  class P {
    calls=0
    async *stream(messages,schemas){
      this.calls++
      if(this.calls<=3){
        yield {type:'tool_call',call:{id:`c${this.calls}`,type:'function',function:{name:'read_file',arguments:'{"path":"README.md"}'}}}
        yield {type:'done',finishReason:'tool_calls'}
      } else {
        assert.equal(schemas.length,0)
        yield {type:'text',delta:'loop stopped'}
        yield {type:'done',finishReason:'stop'}
      }
    }
  }
  const provider=new P(); let status=''
  const agent=new Agent(provider,registry,store,0,12000,2,s=>{status=s})
  let out=''
  await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'read the file',onText:s=>out+=s})
  assert.equal(provider.calls,4)
  assert.match(status,/loop guard/)
  assert.equal(out,'loop stopped')
  await rm(root,{recursive:true,force:true})
})

test('normal turns stop after three consecutive write-only rounds', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-loop-writes-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  builtinTools({timeout:5000,maxOutput:5000}).forEach(t=>registry.add(t))
  class P {
    calls=0
    async *stream(messages,schemas){
      this.calls++
      if(this.calls<=3){
        const content=`version-${this.calls}\n`
        yield {type:'tool_call',call:{id:`w${this.calls}`,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'loop.txt',content})}}}
        yield {type:'done',finishReason:'tool_calls'}
      } else {
        assert.equal(schemas.length,0)
        yield {type:'text',delta:'completed after safety stop'}
        yield {type:'done',finishReason:'stop'}
      }
    }
  }
  const provider=new P(); let status=''; const agent=new Agent(provider,registry,store,0,12000,2,s=>{status=s})
  let out=''; await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'create the file',onText:s=>out+=s})
  assert.equal(provider.calls,4)
  assert.match(status,/loop guard/)
  assert.match(out,/completed after safety stop/)
  assert.equal(await readFile(path.join(root,'loop.txt'),'utf8'),'version-3\n')
  await rm(root,{recursive:true,force:true})
})
test('configured interactive tool rounds default to 50 and explicit zero remains opt-out', async()=>{
  const { loadConfig } = await import('../dist/config/config.js')
  const root=await mkdtemp(path.join(tmpdir(),'termagent-loop-config-'))
  const original=process.env.TERMAGENT_MAX_TOOL_ROUNDS
  delete process.env.TERMAGENT_MAX_TOOL_ROUNDS
  try {
    assert.equal((await loadConfig(root)).maxToolRounds,50)
    process.env.TERMAGENT_MAX_TOOL_ROUNDS='0'
    assert.equal((await loadConfig(root)).maxToolRounds,0)
  } finally {
    if(original===undefined) delete process.env.TERMAGENT_MAX_TOOL_ROUNDS
    else process.env.TERMAGENT_MAX_TOOL_ROUNDS=original
    await rm(root,{recursive:true,force:true})
  }
})
test('semantic loop guard stops a repeating no-progress execution cycle', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-semantic-loop-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add({name:'task_status',description:'status',risk:'read',schema:{type:'object'},execute:async()=>({output:'agent-a: completed\nagent-b: completed'})})
  registry.add({name:'read_file',description:'read',risk:'read',schema:{type:'object'},execute:async()=>({output:'stable file contents'})})
  registry.add({name:'todo',description:'todo',risk:'read',schema:{type:'object'},execute:async()=>({output:'[]'})})
  class P {
    calls=0
    async *stream(messages,schemas){
      this.calls++
      if(this.calls<=4){
        yield {type:'tool_call',call:{id:`a${this.calls}1`,type:'function',function:{name:'task_status',arguments:'{}'}}}
        yield {type:'tool_call',call:{id:`a${this.calls}2`,type:'function',function:{name:'read_file',arguments:'{"path":"demo.txt"}'}}}
        yield {type:'tool_call',call:{id:`a${this.calls}3`,type:'function',function:{name:'todo',arguments:'{"action":"list"}'}}}
        yield {type:'done',finishReason:'tool_calls'}
      } else {
        assert.equal(schemas.length,0)
        yield {type:'text',delta:'loop stopped safely'}
        yield {type:'done',finishReason:'stop'}
      }
    }
  }
  const provider=new P(); let status=''; let out=''
  const agent=new Agent(provider,registry,store,0,12000,1,s=>{status=s})
  await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'finish the task',onText:s=>out+=s})
  assert.equal(provider.calls,5)
  assert.match(status,/loop guard: the agent repeated the same no-progress execution state/i)
  assert.equal(out,'loop stopped safely')
  await rm(root,{recursive:true,force:true})
})
test('agent stops prolonged read-only churn', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-read-churn-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add({name:'task_status',description:'status',risk:'read',schema:{type:'object'},execute:async()=>({output:'no new task state'})})
  class P {
    calls=0
    async *stream(messages,schemas){
      this.calls++
      if(this.calls<=32){
        assert.equal(schemas.length,1)
        yield {type:'tool_call',call:{id:`r${this.calls}`,type:'function',function:{name:'task_status',arguments:JSON.stringify({task:`probe-${this.calls}`})}}}
        yield {type:'done',finishReason:'tool_calls'}
      } else {
        assert.equal(schemas.length,0)
        yield {type:'text',delta:'read loop stopped'}
        yield {type:'done',finishReason:'stop'}
      }
    }
  }
  const provider=new P(); let status=''
  const agent=new Agent(provider,registry,store,0,12000,1,s=>{status=s})
  let output=''
  await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'inspect the repository',onText:s=>output+=s})
  assert.equal(provider.calls,33)
  assert.match(status,/read-only rounds without changing files/i)
  assert.equal(output,'read loop stopped')
  await rm(root,{recursive:true,force:true})
})

test('completed persisted todos are not restored as active state on a new turn', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-todo-lifecycle-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  await store.appendTodo(meta.id,[
    {id:'1',task:'stale completed task',status:'done'},
    {id:'2',task:'another completed task',status:'done'},
  ])
  const registry=new ToolRegistry(new PermissionGate('auto'))
  class P {
    seen=''
    async *stream(messages){
      this.seen=messages.map(m=>typeof m.content==='string'?m.content:'').join('\n')
      yield {type:'text',delta:'new turn only'}
      yield {type:'done',finishReason:'stop'}
    }
  }
  const provider=new P()
  const history=[]
  for(let i=0;i<18;i++){
    history.push({role:'user',content:`historical user ${i} ${'context '.repeat(90)}`})
    history.push({role:'assistant',content:`historical assistant ${i} ${'answer '.repeat(90)}`})
  }
  const messages=history.slice()
  const agent=new Agent(provider,registry,store,0,5000,1)
  await agent.run({sessionId:meta.id,messages,cwd:root,instructions:'test',prompt:'good'})
  const loaded=await store.load(meta.id)
  const compactions=loaded.events.filter((event)=>event.type==='compaction')
  assert.ok(compactions.length>0,'expected context compaction to occur')
  const summary=compactions.at(-1)?.data?.summary||''
  assert.doesNotMatch(summary,/stale completed task/)
  assert.doesNotMatch(summary,/another completed task/)
  assert.match(summary,/Completion state: no explicit todo list/)
  assert.doesNotMatch(provider.seen,/stale completed task/)
  assert.doesNotMatch(provider.seen,/another completed task/)
  await rm(root,{recursive:true,force:true})
})
test('completed todo state cannot steer an unrelated follow-up into an old write', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-todo-followup-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  await store.appendTodo(meta.id,[{id:'1',task:'edit the stale file',status:'done'}])
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add({name:'write_file',description:'write',risk:'write',schema:{type:'object'},execute:async()=>{throw new Error('write should not be reached')}})
  class P {
    seen=''
    calls=0
    async *stream(messages,schemas){
      this.calls++
      this.seen=messages.map(m=>typeof m.content==='string'?m.content:'').join('\n')
      assert.doesNotMatch(this.seen,/edit the stale file/)
      yield {type:'text',delta:'acknowledged'}
      yield {type:'done',finishReason:'stop'}
    }
  }
  const provider=new P()
  const agent=new Agent(provider,registry,store,0,12000,1)
  await agent.run({sessionId:meta.id,messages:[
    {role:'system',content:'base system'},
    {role:'assistant',content:'The previous task was completed.'},
    {role:'tool',name:'todo',tool_call_id:'old',content:JSON.stringify([{id:'1',task:'edit the stale file',status:'done'}])},
  ],cwd:root,instructions:'test',prompt:'good'})
  assert.equal(provider.calls,1)
  await rm(root,{recursive:true,force:true})
})

test('old compaction summaries cannot resurrect completed todo work on an unrelated turn', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-stale-summary-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  await store.appendTodo(meta.id,[{id:'1',task:'stale summary task',status:'done'}])
  const registry=new ToolRegistry(new PermissionGate('auto'))
  class P {
    seen=''
    async *stream(messages){
      this.seen=messages.map(m=>typeof m.content==='string'?m.content:'').join('\n')
      yield {type:'text',delta:'new task'}
      yield {type:'done',finishReason:'stop'}
    }
  }
  const provider=new P()
  const messages=[
    {role:'system',content:'base system'},
    {role:'system',content:'Earlier conversation summary. Preserve exact paths, identifiers, decisions, failures, and verification evidence when using this summary.\n\n## Objective\n- old objective\n\n## Todo\n- [x] 1: stale summary task\n- Completion state: 1/1 todo items complete\n\n## Next Move\n1. Continue the old task.'},
  ]
  const agent=new Agent(provider,registry,store,0,12000,1)
  await agent.run({sessionId:meta.id,messages,cwd:root,instructions:'test',prompt:'good'})
  assert.doesNotMatch(provider.seen,/stale summary task/)
  assert.doesNotMatch(provider.seen,/old task/)
  assert.match(provider.seen,/## Todo\n- \(no active todo list\)/)
  await rm(root,{recursive:true,force:true})
})

test('system prompt provides a current UTC timestamp for date-sensitive edits', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-current-time-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  class P {
    seen=''
    async *stream(messages){
      this.seen=messages.find(m=>m.role==='system')?.content||''
      yield {type:'text',delta:'timestamped'}
      yield {type:'done',finishReason:'stop'}
    }
  }
  const provider=new P()
  const agent=new Agent(provider,registry,store,0,12000,1)
  await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'add a timestamp'})
  assert.match(provider.seen,/Current UTC time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
  await rm(root,{recursive:true,force:true})
})

test('todo completion gate forces a final text-only turn immediately after all todos are done', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-todo-gate-'))
  const store=new SessionStore(path.join(root,'sessions')); const meta=await store.create(root,'mock')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add({name:'todo',description:'todo',risk:'read',schema:{type:'object'},execute:async()=>({output:JSON.stringify([{id:'1',task:'finish task',status:'done'}])})})
  class P {
    calls=0
    async *stream(messages,schemas){
      this.calls++
      if(this.calls===1){
        assert.ok(schemas.some(x=>x.function?.name==='todo'))
        yield {type:'tool_call',call:{id:'todo1',type:'function',function:{name:'todo',arguments:'{"action":"list"}'}}}
        yield {type:'done',finishReason:'tool_calls'}
      } else {
        assert.equal(schemas.length,0)
        yield {type:'text',delta:'all done'}
        yield {type:'done',finishReason:'stop'}
      }
    }
  }
  const provider=new P(); let out=''
  const agent=new Agent(provider,registry,store,0,12000,1)
  await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'test',prompt:'finish it',onText:s=>out+=s})
  assert.equal(provider.calls,2)
  assert.equal(out,'all done')
  await rm(root,{recursive:true,force:true})
})

test('tool loop identity canonicalizes nested object key order without changing arrays or ranges', async()=>{
  const { canonicalJson, canonicalToolCallIdentity } = await import('../dist/util/canonical.js')
  assert.equal(canonicalJson({outer:{b:2,a:1},first:3}), canonicalJson({first:3,outer:{a:1,b:2}}))
  assert.notEqual(canonicalJson({paths:['a','b']}), canonicalJson({paths:['b','a']}))
  assert.notEqual(
    canonicalToolCallIdentity('read_file',{path:'demo.py',offset:1,limit:40}),
    canonicalToolCallIdentity('read_file',{path:'demo.py',offset:41,limit:40}),
  )
})

test('tool loop identity treats omitted and undefined optional values as equivalent', async()=>{
  const { canonicalToolCallIdentity } = await import('../dist/util/canonical.js')
  assert.equal(
    canonicalToolCallIdentity('read_file',{path:'README.md'}),
    canonicalToolCallIdentity('read_file',{path:'README.md',limit:undefined}),
  )
  const guard = new (await import('../dist/agent/loop-guard.js')).ToolLoopGuard({repeatThreshold:3})
  assert.equal(guard.check('read_file',{path:'README.md'}).blocked,false)
  assert.equal(guard.check('read_file',{limit:undefined,path:'README.md'}).blocked,false)
  assert.equal(guard.check('read_file',{path:'README.md'}).blocked,true)
})

test('tool loop identity includes tool name and execution scope', async()=>{
  const { canonicalToolCallIdentity } = await import('../dist/util/canonical.js')
  const same = { cwd:'/workspace/project', scopePaths:['src','tests'] }
  assert.equal(
    canonicalToolCallIdentity('read_file',{path:'a.ts'},same),
    canonicalToolCallIdentity('read_file',{path:'a.ts'},same),
  )
  assert.notEqual(
    canonicalToolCallIdentity('read_file',{path:'a.ts'},same),
    canonicalToolCallIdentity('grep',{path:'a.ts'},same),
  )
  assert.notEqual(
    canonicalToolCallIdentity('read_file',{path:'a.ts'},same),
    canonicalToolCallIdentity('read_file',{path:'a.ts'},{cwd:'/workspace/other',scopePaths:['src','tests']}),
  )
  assert.notEqual(
    canonicalToolCallIdentity('read_file',{path:'a.ts'},same),
    canonicalToolCallIdentity('read_file',{path:'a.ts'},{cwd:'/workspace/project',scopePaths:['docs']}),
  )
})

test('tool loop guard does not treat reordered scoped inputs as a repeat', async()=>{
  const { ToolLoopGuard } = await import('../dist/agent/loop-guard.js')
  const guard=new ToolLoopGuard({repeatThreshold:3})
  assert.equal(guard.check('read_file',{path:'a.ts',range:{offset:1,limit:20}},{cwd:'/workspace',scopePaths:['src','tests']}).blocked,false)
  assert.equal(guard.check('read_file',{range:{limit:20,offset:1},path:'a.ts'},{cwd:'/workspace',scopePaths:['tests','src']}).blocked,false)
  assert.equal(guard.check('read_file',{path:'a.ts',range:{limit:20,offset:1}},{cwd:'/workspace',scopePaths:['src','tests']}).blocked,true)
})
