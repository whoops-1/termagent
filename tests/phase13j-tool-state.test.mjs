import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { todoTool } from '../dist/tools/todo.js'
import { sessionTodoTool } from '../dist/tools/session-todo.js'
import { questionTool } from '../dist/tools/question.js'
import { skillTools } from '../dist/tools/skills.js'
import { SessionStore } from '../dist/session/store.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { ExecutionWorkflow, initialWorkflow } from '../dist/agent/workflow.js'
import { workflowPhaseTool } from '../dist/tools/workflow-phase.js'
import { Agent } from '../dist/agent/agent.js'
import { machineStateFromRuntime, renderMachineState } from '../dist/context/state.js'

async function tmp(prefix='termagent-phase13j-') { return fs.mkdtemp(path.join(os.tmpdir(), prefix)) }
const signal = new AbortController().signal

class ScriptedProvider {
  id='scripted'; model='test-model'; config={model:'test-model',baseUrl:'http://127.0.0.1'}
  constructor(script){ this.script=[...script] }
  async *stream(){
    const step=this.script.shift() ?? {text:'done'}
    if(step.text) yield {type:'text',delta:step.text}
    for(const call of step.calls||[]) yield {type:'tool_call',call}
  }
}
function call(id,name,args){ return {id,type:'function',function:{name,arguments:JSON.stringify(args)}} }

function ctx(cwd, overrides={}) { return {sessionID:'s',agent:'build',cwd,abort:signal,...overrides} }

async function writeSkill(root,name,body){
  const dir=path.join(root,'.termagent','skills',name)
  await fs.mkdir(dir,{recursive:true})
  await fs.writeFile(path.join(dir,'SKILL.md'),body,'utf8')
  return dir
}

test('13J todo returns structured old/new state and collapses completed live state', async()=>{
  const state=[]; let visible
  const tool=todoTool(state, async()=>{}, items=>{visible=items})
  const first=await tool.execute({action:'set',items:[{id:'a',task:'inspect',status:'pending',priority:'high'},{id:'b',task:'verify',status:'pending'}]})
  assert.deepEqual(first.metadata.todo.old,[])
  assert.equal(first.metadata.todo.new[0].priority,'high')
  assert.equal(first.metadata.todo.collapsed,false)
  const done=await tool.execute({action:'update',items:[{id:'a',status:'done'},{id:'b',status:'done'}]})
  assert.equal(done.metadata.todo.collapsed,true)
  assert.equal(done.metadata.todo.verificationNudge,true)
  assert.deepEqual(done.metadata.todo.active,[])
  assert.equal(done.metadata.todo.completed.length,2)
  assert.deepEqual(visible,[])
  assert.equal(state.length,2)
})

test('13J session todo persists old/new state and reloads with priority', async()=>{
  const root=await tmp(); const store=new SessionStore(path.join(root,'sessions')); const session=await store.create(root,'mock')
  try {
    const tool=sessionTodoTool(store); const c={...ctx(root),sessionID:session.id}
    const set=await tool.execute({action:'set',items:[{id:'1',task:'build',status:'pending',priority:'high'}]},c)
    assert.deepEqual(set.metadata.todo.old,[])
    const updated=await tool.execute({action:'update',items:[{id:'1',status:'done',priority:'low'}]},c)
    assert.equal(updated.metadata.todo.new[0].priority,'low')
    assert.equal(updated.metadata.todo.collapsed,true)
    assert.equal(updated.metadata.todo.verificationNudge,true)
    const reloaded=sessionTodoTool(new SessionStore(path.join(root,'sessions')))
    const listed=JSON.parse((await reloaded.execute({action:'list'},c)).output)
    assert.deepEqual(listed,[{id:'1',task:'build',status:'done',priority:'low'}])
    const events=(await store.load(session.id)).events.filter(e=>e.type==='todo')
    assert.equal(events.at(-1).data.previous[0].status,'pending')
    assert.equal(events.at(-1).data.items[0].status,'done')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13J question persists stable request state and does not re-ask completed requests', async()=>{
  const root=await tmp(); const store=new SessionStore(path.join(root,'sessions')); const session=await store.create(root,'mock')
  let asks=0; const questions=[{header:'Format',question:'Preferred format?',options:[{label:'JSON',description:'Machine-readable'},{label:'Markdown',description:'Human-readable'}],multiple:true,custom:true}]
  try {
    const tool=questionTool(store)
    const c={...ctx(root),sessionID:session.id,toolCallId:'call-question',questioner:async(qs,sig)=>{asks++;assert.equal(qs[0].multiple,true);assert.equal(qs[0].custom,true);assert.equal(sig,c.abort);return {status:'replied',answers:[['JSON','Markdown']]}}}
    const first=await tool.execute({questions},c)
    const second=await tool.execute({questions},c)
    assert.equal(asks,1)
    assert.equal(first.metadata.question.status,'replied')
    assert.equal(second.metadata.question.replayed,true)
    assert.equal(second.metadata.question.requestId,first.metadata.question.requestId)
    assert.deepEqual(second.metadata.question.answers,[['JSON','Markdown']])
    const events=(await store.load(session.id)).events
    assert.equal(events.filter(e=>e.type==='question.asked').length,1)
    assert.equal(events.filter(e=>e.type==='question.replied').length,1)
    const machine=machineStateFromRuntime({sessionId:session.id,epoch:1,sourceEventCount:events.length,summaryRevision:1,messages:[],answeredQuestions:[{requestId:first.metadata.question.requestId,status:'replied',answers:[['JSON','Markdown']]}]})
    const rendered=renderMachineState(machine)
    assert.match(rendered, /answeredQuestions=.*replied/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13J question rejection and cancellation are terminal durable states', async()=>{
  const root=await tmp(); const store=new SessionStore(path.join(root,'sessions')); const session=await store.create(root,'mock')
  try {
    const tool=questionTool(store)
    const base={questions:[{header:'One',question:'Choose',options:[{label:'A'}]}]}
    const rejected=await tool.execute(base,{...ctx(root),sessionID:session.id,toolCallId:'reject',questioner:async()=>({status:'rejected',answers:[]})})
    const cancelled=await tool.execute(base,{...ctx(root),sessionID:session.id,toolCallId:'cancel',questioner:async()=>({status:'cancelled',answers:[]})})
    assert.equal(rejected.metadata.question.status,'rejected')
    assert.equal(cancelled.metadata.question.status,'cancelled')
    const events=(await store.load(session.id)).events
    assert.equal(events.some(e=>e.type==='question.rejected'),true)
    assert.equal(events.some(e=>e.type==='question.cancelled'),true)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13J native skill tool loads bounded SKILL.md plus resource references', async()=>{
  const root=await tmp();
  try {
    const dir=await writeSkill(root,'testing','---\ndescription: Run tests\n---\n# Testing\nRULE_ONE\nRULE_TWO\nRULE_THREE\n')
    await fs.writeFile(path.join(dir,'reference.md'),'reference','utf8')
    await fs.writeFile(path.join(dir,'script.sh'),'echo ok','utf8')
    const events=[]; const tools=skillTools((_id,e)=>events.push(e),{maxBodyTokens:20})
    assert.deepEqual(tools.map(t=>t.name),['search_skills','skill','use_skill'])
    const skill=tools.find(t=>t.name==='skill')
    const result=await skill.execute({name:'testing'},ctx(root))
    assert.match(result.output,/skill_content name="testing"/)
    assert.match(result.output,/Base directory:/)
    assert.match(result.output,/reference\.md/)
    assert.match(result.output,/script\.sh/)
    assert.equal(result.metadata.skill.resourceCount,2)
    assert.equal(result.metadata.preserveOutput,true)
    assert.deepEqual(events.map(e=>e.action),['load'])
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13J agent places compact skill descriptors in base context without loading bodies', async()=>{
  const root=await tmp(); const store=new SessionStore(path.join(root,'sessions')); const session=await store.create(root,'mock')
  try {
    class DescriptorProvider {
      seen=''
      async *stream(messages){
        this.seen=String(messages.find(m=>m.role==='system')?.content||'')
        yield {type:'text',delta:'ok'}
        yield {type:'done',finishReason:'stop'}
      }
    }
    const provider=new DescriptorProvider()
    const registry=new ToolRegistry(new PermissionGate('auto'))
    const skills=[{id:'testing',name:'testing',description:'Run verification and tests',source:'project',userInvocable:true}]
    const agent=new Agent(provider,registry,store,0,12000,0,undefined,skills)
    const out=await agent.run({sessionId:session.id,messages:[],cwd:root,instructions:'test',prompt:'hello'})
    assert.equal(out,'ok')
    assert.match(provider.seen,/Relevant skills \(descriptors only\):/)
    assert.match(provider.seen,/testing/)
    assert.match(provider.seen,/Run verification and tests/)
    assert.doesNotMatch(provider.seen,/<skill_content/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13J skill load remains security/digest checked while native alias is available', async()=>{
  const root=await tmp();
  try {
    await writeSkill(root,'secure','---\ndescription: Safe skill\n---\n# Safe\nSAFE\n')
    const tools=skillTools(); const skill=tools.find(t=>t.name==='skill')
    const first=await skill.execute({name:'secure'},ctx(root))
    await fs.appendFile(path.join(root,'.termagent','skills','secure','SKILL.md'),'MUTATED\n')
    const second=await skill.execute({name:'secure'},ctx(root))
    assert.match(first.output,/SAFE/)
    assert.match(second.output,/MUTATED/)
    assert.notEqual(second.metadata.skill.sha256,first.metadata.skill.sha256)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13J workflow tool keeps structured workflow state separate from rendered text', async()=>{
  const workflow=new ExecutionWorkflow(initialWorkflow())
  const tool=workflowPhaseTool(workflow)
  const result=await tool.execute({phase:'planning',reason:'create plan'})
  assert.equal(result.metadata.workflow.phase,'planning')
  assert.equal(JSON.parse(result.output).phase,'planning')
})

test('13J autonomous todo completion emits deterministic verification gate', async()=>{
  const cwd=await tmp(); const sessionRoot=await tmp(); const store=new SessionStore(sessionRoot); const session=await store.create(cwd,'mock')
  try {
    const registry=new ToolRegistry(new PermissionGate('auto'))
    registry.add(sessionTodoTool(store))
    registry.add({name:'verify_project',risk:'read',description:'verify',schema:{type:'object',properties:{}},async execute(){return {output:'exit=0 passed',metadata:{ok:true,status:'passed'}}}})
    const provider=new ScriptedProvider([
      {calls:[call('todo-1','todo',{action:'set',items:[{id:'1',task:'done task',status:'done'}]})]},
      {calls:[call('verify-1','verify_project',{})]},
      {text:'verified'}
    ])
    const statuses=[]; const agent=new Agent(provider,registry,store,6,12000,0,s=>statuses.push(s))
    const out=await agent.run({sessionId:session.id,messages:[],cwd,instructions:'',prompt:'finish the task',autonomous:true,mode:'build'})
    assert.equal(out,'verified')
    const workflows=(await store.load(session.id)).events.filter(e=>e.type==='workflow')
    assert.equal(workflows.some(e=>e.data.phase==='verifying'),true)
    assert.equal(workflows.at(-1).data.phase,'complete')
    assert.ok(statuses.length>0)
  } finally { await fs.rm(cwd,{recursive:true,force:true}); await fs.rm(sessionRoot,{recursive:true,force:true}) }
})
