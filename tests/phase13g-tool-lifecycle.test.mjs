import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import test from 'node:test'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'termagent-13g-'))
const abortSignal = new AbortController().signal

async function makeSession(root, model='mock') {
  const { SessionStore } = await import('../dist/session/store.js')
  const sessions = new SessionStore(path.join(root, 'sessions'))
  const session = await sessions.create(root, model)
  return { sessions, session }
}

function makeRegistry() {
  return import('../dist/tools/registry.js').then(async ({ ToolRegistry }) => {
    const { PermissionGate } = await import('../dist/tools/permissions.js')
    return { registry: new ToolRegistry(new PermissionGate('auto')), ToolRegistry, PermissionGate }
  })
}

async function runAgent({ root, sessions, session, provider, tools, prompt='run tool', signal, onQuestion, onToolResult, customAgent, mode='build', maxRounds=4 }) {
  const { Agent } = await import('../dist/agent/agent.js')
  const agent = new Agent(provider, tools, sessions, maxRounds, 8000, 1, undefined, [], {}, undefined, {
    root: path.join(root, 'tool-output'),
    maxBytes: 2048,
    maxLines: 40,
    retentionDays: 7,
  })
  const messages = []
  const result = await agent.run({
    sessionId: session.id,
    messages,
    cwd: root,
    instructions: '',
    prompt,
    signal,
    onQuestion,
    onToolResult: onToolResult ? ((name, output, metadata) => onToolResult({ name, output, metadata, messages })) : undefined,
    customAgent,
    mode,
  })
  return { result, messages }
}

test('13G stable call IDs normalize missing IDs and reject duplicate provider IDs', async () => {
  const { normalizeToolCalls, DuplicateToolCallIdError } = await import('../dist/agent/tool-call-lifecycle.js')
  const calls = [
    { type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    { type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
  ]
  const normalized = normalizeToolCalls('mock', 'turn-123', calls)
  assert.notEqual(normalized[0].id, normalized[1].id, 'fallback IDs include call index')
  assert.match(normalized[0].id, /^call_mock_turn-123_0_/)
  assert.throws(() => normalizeToolCalls('mock', 'turn-123', [
    { id: 'same', type: 'function', function: { name: 'a', arguments: '{}' } },
    { id: 'same', type: 'function', function: { name: 'b', arguments: '{}' } },
  ]), DuplicateToolCallIdError)
})

test('13G malformed tool JSON becomes an explicit lifecycle error and never executes the tool', async () => {
  const root = await tmp();
  try {
    const { sessions, session } = await makeSession(root)
    const { registry } = await makeRegistry()
    let executions = 0
    registry.add({ name: 'danger', risk: 'write', parallelSafe: false, description: 'Danger', schema: { type: 'object' }, async execute() { executions++; return { output: 'should-not-run' } } })
    const provider = { id: 'mock', model: 'mock', calls: 0, async *stream() {
      this.calls++
      if (this.calls === 1) { yield { type:'tool_call', call:{ id:'bad-json', type:'function', function:{ name:'danger', arguments:'{"path":' } } }; yield {type:'done',finishReason:'tool_calls'}; return }
      yield {type:'text',delta:'done'}; yield {type:'done',finishReason:'stop'}
    } }
    await runAgent({root,sessions,session,provider,tools:registry})
    assert.equal(executions,0)
    const loaded = await sessions.load(session.id)
    const life = loaded.events.filter(e=>e.type==='tool.call' && e.data.callId==='bad-json')
    assert.equal(life.at(-1).data.state, 'error')
    assert.equal(life.at(-1).data.outcome, 'error')
    assert.match(life.at(-1).data.error, /Invalid JSON tool arguments/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13G tool error and permission denial are explicit lifecycle outcomes', async () => {
  const root = await tmp();
  try {
    const { sessions, session } = await makeSession(root)
    const { registry } = await makeRegistry()
    registry.add({ name:'broken', risk:'read', description:'Broken', schema:{type:'object'}, async execute(){ throw new Error('boom') } })
    const provider = { id:'mock', model:'mock', n:0, async *stream(){ this.n++; if(this.n===1){yield {type:'tool_call',call:{id:'broken-1',type:'function',function:{name:'broken',arguments:'{}'}}};yield {type:'done',finishReason:'tool_calls'};return} yield {type:'text',delta:'done'};yield {type:'done',finishReason:'stop'} } }
    await runAgent({root,sessions,session,provider,tools:registry})
    const loaded=await sessions.load(session.id)
    const life=loaded.events.filter(e=>e.type==='tool.call'&&e.data.callId==='broken-1')
    assert.equal(life.at(-1).data.state,'error'); assert.equal(life.at(-1).data.outcome,'error'); assert.equal(life.at(-1).data.error,'boom')

    const { SessionStore } = await import('../dist/session/store.js')
    const { ToolRegistry } = await import('../dist/tools/registry.js')
    const { PermissionGate } = await import('../dist/tools/permissions.js')
    const deniedSessions=new SessionStore(path.join(root,'denied-sessions')); const denied=await deniedSessions.create(root,'mock')
    const deniedRegistry=new ToolRegistry(new PermissionGate('deny'))
    deniedRegistry.add({name:'write_secret',risk:'write',description:'write',schema:{type:'object'},async execute(){throw new Error('should not execute')}})
    const deniedProvider={id:'mock',model:'mock',n:0,async *stream(){this.n++;if(this.n===1){yield {type:'tool_call',call:{id:'denied-1',type:'function',function:{name:'write_secret',arguments:'{}'}}};yield {type:'done',finishReason:'tool_calls'};return}yield {type:'text',delta:'done'};yield {type:'done',finishReason:'stop'}}}
    await runAgent({root,sessions:deniedSessions,session:denied,provider:deniedProvider,tools:deniedRegistry})
    const dl=await deniedSessions.load(denied.id); const d=dl.events.filter(e=>e.type==='tool.call'&&e.data.callId==='denied-1'); assert.equal(d.at(-1).data.outcome,'permission_denied')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13G question rejection is distinct from generic tool failure', async () => {
  const root=await tmp();
  try {
    const { sessions, session }=await makeSession(root); const { registry }=await makeRegistry()
    registry.add({name:'asks',risk:'read',description:'asks',schema:{type:'object'},async execute(_args,ctx){await ctx.questioner([{question:'Continue?',header:'Continue?',options:[{label:'Yes'},{label:'No'}]}]);return {output:'yes'}}})
    const provider={id:'mock',model:'mock',n:0,async *stream(){this.n++;if(this.n===1){yield {type:'tool_call',call:{id:'q-1',type:'function',function:{name:'asks',arguments:'{}'}}};yield {type:'done',finishReason:'tool_calls'};return}yield {type:'text',delta:'done'};yield {type:'done',finishReason:'stop'}}}
    const onQuestion=async()=>{throw new Error('Question cancelled')}
    await runAgent({root,sessions,session,provider,tools:registry,onQuestion})
    const loaded=await sessions.load(session.id);const life=loaded.events.filter(e=>e.type==='tool.call'&&e.data.callId==='q-1');assert.equal(life.at(-1).data.outcome,'question_rejected')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13G interruption settles started tools and leaves no pending/running lifecycle records', async () => {
  const root=await tmp();
  try {
    const { sessions, session }=await makeSession(root); const { registry }=await makeRegistry()
    registry.add({name:'slow',risk:'read',description:'slow',schema:{type:'object'},async execute(_args,ctx){await new Promise(resolve=>{if(ctx.abort.aborted) return resolve();ctx.abort.addEventListener('abort',resolve,{once:true})});return {output:'aborted'}}})
    const provider={id:'mock',model:'mock',async *stream(){yield {type:'tool_call',call:{id:'slow-1',type:'function',function:{name:'slow',arguments:'{}'}}};yield {type:'done',finishReason:'tool_calls'}}}
    const ac=new AbortController();setTimeout(()=>ac.abort('test'),50)
    await assert.rejects(runAgent({root,sessions,session,provider,tools:registry,signal:ac.signal}),/Provider turn interrupted|interrupted/i)
    const loaded=await sessions.load(session.id);const life=loaded.events.filter(e=>e.type==='tool.call'&&e.data.callId==='slow-1');assert.equal(life.at(-1).data.state,'interrupted');assert.equal(life.at(-1).data.outcome,'interrupted')
    assert.equal(life.at(-1).data.state==='pending'||life.at(-1).data.state==='running',false)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13G parallel-safe tools execute concurrently but tool results are persisted in provider order', async () => {
  const root=await tmp();
  try {
    const { sessions, session }=await makeSession(root); const { registry }=await makeRegistry()
    let active=0,maxActive=0
    for (const [name,delay] of [['one',100],['two',10],['three',20],['four',5],['five',1]]) {
      registry.add({name,risk:'read',parallelSafe:true,description:name,schema:{type:'object'},async execute(){active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,delay));active--;return {output:name}}})
    }
    const calls=['one','two','three','four','five'].map((name,i)=>({id:`p${i}`,type:'function',function:{name,arguments:'{}'}}))
    const provider={id:'mock',model:'mock',n:0,seen:[],async *stream(messages){this.n++;this.seen.push(messages.map(m=>({role:m.role,tool_call_id:m.tool_call_id,content:m.content})));if(this.n===1){for(const call of calls)yield {type:'tool_call',call};yield {type:'done',finishReason:'tool_calls'};return}yield {type:'text',delta:'done'};yield {type:'done',finishReason:'stop'}}}
    await runAgent({root,sessions,session,provider,tools:registry})
    assert.equal(maxActive,4)
    const loaded=await sessions.load(session.id)
    const turnMessages=loaded.events.filter(e=>e.type==='message' && e.data?.turnId).map(e=>e.data.message)
    const results=turnMessages.filter(m=>m.role==='tool'&&m.tool_call_id).map(m=>m.tool_call_id)
    assert.deepEqual(results.slice(-5),['p0','p1','p2','p3','p4'])
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13G durable reload replaces post-settlement in-memory mutation before next provider turn', async () => {
  const root=await tmp();
  try {
    const { sessions, session }=await makeSession(root); const { registry }=await makeRegistry()
    registry.add({name:'read_once',risk:'read',description:'read',schema:{type:'object'},async execute(){return {output:'durable-result'}}})
    const provider={id:'mock',model:'mock',n:0,seen:[],async *stream(messages){this.n++;this.seen.push(messages.map(m=>({...m})));if(this.n===1){yield {type:'tool_call',call:{id:'reload-1',type:'function',function:{name:'read_once',arguments:'{}'}}};yield {type:'done',finishReason:'tool_calls'};return}yield {type:'text',delta:'done'};yield {type:'done',finishReason:'stop'}}}
    await runAgent({root,sessions,session,provider,tools:registry,onToolResult:({messages})=>{const tool=messages.find(m=>m.role==='tool');if(tool)tool.content='MUTATED-IN-MEMORY'}})
    // The provider's second request must contain the durable tool result, not the post-settlement in-memory mutation.
    const second=provider.seen[1].find(m=>m.role==='tool')
    assert.equal(second.content,'durable-result')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13G provider-hosted calls are never dispatched to the local registry', async () => {
  const root=await tmp();
  try {
    const { sessions, session }=await makeSession(root); const { registry }=await makeRegistry(); let localRuns=0
    registry.add({name:'hosted',risk:'write',description:'hosted',schema:{type:'object'},async(){localRuns++;return {output:'local'}}})
    const provider={id:'mock',model:'mock',n:0,async *stream(){this.n++;if(this.n===1){const call={id:'host-1',type:'function',function:{name:'hosted',arguments:'{}'}};yield {type:'tool_call',call,providerExecuted:true,providerMetadata:{remote:'yes'}};yield {type:'tool_result',call,output:'remote-result',providerExecuted:true,providerMetadata:{remote:'yes'}};yield {type:'done',finishReason:'tool_calls'};return}yield {type:'text',delta:'done'};yield {type:'done',finishReason:'stop'}}}
    await runAgent({root,sessions,session,provider,tools:registry})
    assert.equal(localRuns,0)
    const loaded=await sessions.load(session.id);const life=loaded.events.filter(e=>e.type==='tool.call'&&e.data.callId==='host-1');assert.equal(life.at(-1).data.outcome,'provider_hosted');assert.equal(life.at(-1).data.providerExecuted,true)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})
test('13G provider turn failures are durably distinct from tool failures', async () => {
  const root=await tmp();
  try {
    const { sessions, session }=await makeSession(root); const { registry }=await makeRegistry()
    const provider={id:'mock',model:'mock',async *stream(){throw new Error('provider exploded')}}
    await assert.rejects(runAgent({root,sessions,session,provider,tools:registry}),/provider exploded/i)
    const loaded=await sessions.load(session.id);const turns=loaded.events.filter(e=>e.type==='provider.turn'&&e.data.turnId);assert.equal(turns[0].data.state,'started');assert.equal(turns.at(-1).data.state,'error');assert.equal(turns.at(-1).data.error,'provider exploded')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13G duplicate provider call IDs stop the turn before local dispatch', async () => {
  const root=await tmp();
  try {
    const { sessions, session }=await makeSession(root); const { registry }=await makeRegistry(); let executions=0
    registry.add({name:'never',risk:'read',description:'never',schema:{type:'object'},async execute(){executions++;return {output:'bad'}}})
    const provider={id:'mock',model:'mock',async *stream(){yield {type:'tool_call',call:{id:'dup',type:'function',function:{name:'never',arguments:'{}'}}};yield {type:'tool_call',call:{id:'dup',type:'function',function:{name:'never',arguments:'{}'}}};yield {type:'done',finishReason:'tool_calls'}}}
    await assert.rejects(runAgent({root,sessions,session,provider,tools:registry}),/duplicate tool call id/i)
    assert.equal(executions,0)
    const loaded=await sessions.load(session.id);const turn=loaded.events.filter(e=>e.type==='provider.turn').at(-1);assert.equal(turn.data.state,'error');assert.match(turn.data.error,/duplicate tool call id/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13G repeat loop guard has a confirmation escape hatch', async () => {
  const root=await tmp();
  const previous=process.env.TERMAGENT_REPEAT_TOOL_THRESHOLD; process.env.TERMAGENT_REPEAT_TOOL_THRESHOLD='3'
  try {
    const { sessions, session }=await makeSession(root); const { registry }=await makeRegistry(); let executions=0; let questions=0
    registry.add({name:'repeatable',risk:'read',description:'repeatable',schema:{type:'object'},async execute(){executions++;return {output:`run-${executions}`}}})
    const provider={id:'mock',model:'mock',n:0,async *stream(){this.n++;if(this.n<=3){yield {type:'tool_call',call:{id:`r${this.n}`,type:'function',function:{name:'repeatable',arguments:'{}'}}};yield {type:'done',finishReason:'tool_calls'};return}yield {type:'text',delta:'done'};yield {type:'done',finishReason:'stop'}}}
    await runAgent({root,sessions,session,provider,tools:registry,onQuestion:async()=>{questions++;return [['Repeat once']]}})
    assert.equal(executions,3);assert.equal(questions,1)
  } finally { if(previous===undefined)delete process.env.TERMAGENT_REPEAT_TOOL_THRESHOLD;else process.env.TERMAGENT_REPEAT_TOOL_THRESHOLD=previous; await fs.rm(root,{recursive:true,force:true}) }
})

test('13G recovery converts abandoned pending/running lifecycle states to interrupted', async () => {
  const root=await tmp();
  try {
    const { SessionStore }=await import('../dist/session/store.js'); const { ToolCallLifecycle }=await import('../dist/agent/tool-call-lifecycle.js')
    const sessions=new SessionStore(path.join(root,'sessions'));const session=await sessions.create(root,'mock')
    const lifecycle=new ToolCallLifecycle(sessions)
    await lifecycle.pending({sessionId:session.id,turnId:'old-turn',callId:'old-1',name:'slow',argumentsRaw:'{}'})
    await lifecycle.transition('old-1',{state:'running'})
    const recovered=await new ToolCallLifecycle(sessions).recoverUnsettled(session.id)
    assert.deepEqual(recovered,['old-1'])
    const loaded=await sessions.load(session.id);const events=loaded.events.filter(e=>e.type==='tool.call'&&e.data.callId==='old-1');assert.equal(events.at(-1).data.state,'interrupted');assert.equal(events.at(-1).data.outcome,'interrupted')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13G OpenAI-compatible streaming assembles partial tool arguments into one call', async () => {
  const { OpenAICompatibleProvider }=await import('../dist/providers/openai-compatible.js')
  const server=http.createServer((_req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'})
    const events=[
      {choices:[{delta:{tool_calls:[{index:0,id:'part-1',function:{name:'read_file',arguments:'{"pa'}}]}}]},
      {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'th":"a"}'}}]}}]},
      {choices:[{delta:{},finish_reason:'tool_calls'}]},
      '[DONE]',
    ]
    for(const event of events)res.write('data: '+(typeof event==='string'?event:JSON.stringify(event))+'\n\n')
    res.end()
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port=server.address().port
  try {
    const provider=new OpenAICompatibleProvider({model:'mock',baseUrl:`http://127.0.0.1:${port}`,temperature:0})
    const events=[];for await(const event of provider.stream([{role:'user',content:'x'}],[],abortSignal))events.push(event)
    const call=events.find(e=>e.type==='tool_call')?.call
    assert.equal(call.id,'part-1');assert.equal(call.function.name,'read_file');assert.equal(call.function.arguments,'{"path":"a"}')
  } finally { await new Promise(resolve=>server.close(resolve)) }
})

test('13G lifecycle rejects duplicate records for the same session/turn/call key', async () => {
  const root = await tmp()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const { ToolCallLifecycle } = await import('../dist/agent/tool-call-lifecycle.js')
    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, 'mock')
    const lifecycle = new ToolCallLifecycle(sessions)
    await lifecycle.pending({ sessionId: session.id, turnId: 'turn-1', callId: 'same', name: 'read_file', argumentsRaw: '{}' })
    await assert.rejects(
      lifecycle.pending({ sessionId: session.id, turnId: 'turn-1', callId: 'same', name: 'read_file', argumentsRaw: '{}' }),
      /Duplicate tool call lifecycle/,
    )
    const loaded = await sessions.load(session.id)
    const events = loaded.events.filter(e => e.type === 'tool.call' && e.data.callId === 'same')
    assert.equal(events.length, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('13G recovery refreshes the lifecycle snapshot with interrupted state', async () => {
  const root = await tmp()
  try {
    const { SessionStore } = await import('../dist/session/store.js')
    const { ToolCallLifecycle } = await import('../dist/agent/tool-call-lifecycle.js')
    const sessions = new SessionStore(path.join(root, 'sessions'))
    const session = await sessions.create(root, 'mock')
    const lifecycle = new ToolCallLifecycle(sessions)
    await lifecycle.pending({ sessionId: session.id, turnId: 'turn-1', callId: 'recover-me', name: 'slow', argumentsRaw: '{}' })
    await lifecycle.transition('recover-me', { state: 'running' })
    await lifecycle.recoverUnsettled(session.id)
    const snapshot = lifecycle.snapshot().find(record => record.callId === 'recover-me')
    assert.equal(snapshot?.state, 'interrupted')
    assert.equal(snapshot?.outcome, 'interrupted')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
