import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import test from 'node:test'

const tmp = (prefix='termagent-13i-') => fs.mkdtemp(path.join(os.tmpdir(), prefix))
const signal = new AbortController().signal

class StubTaskManager {
  constructor(manager, finishResult) { this.manager = manager; this.finishResult = finishResult }
}

async function makeProviderServer(text='child complete') {
  const server=http.createServer((_req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\n`)
    res.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  return {server,baseUrl:`http://127.0.0.1:${server.address().port}`}
}

function providerConfig(baseUrl,model='mock-model') { return {provider:'openai-compatible',model,baseUrl} }
function context(cwd,sessionID='parent') { return {sessionID,agent:'build',cwd,abort:signal} }

function stubProvider() {
  return {id:'mock',model:'mock',config:{provider:'openai-compatible',model:'mock',baseUrl:'http://127.0.0.1'},async*stream(){yield {type:'text',delta:'unused'};yield {type:'done',finishReason:'stop'}}}
}

async function makeTaskManager(root, sessionRoot) {
  const {TaskManager}=await import('../dist/tasks/manager.js')
  return new TaskManager(root,false,sessionRoot)
}

test('13I foreground task is worker-backed and returns durable child result', async()=>{
  const root=await tmp(); const sessionsRoot=path.join(root,'sessions'); const tasksRoot=path.join(root,'tasks')
  try {
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const {taskTool}=await import('../dist/tools/task.js')
    const {ToolRegistry}=await import('../dist/tools/registry.js')
    const {PermissionGate}=await import('../dist/tools/permissions.js')
    const manager=new TaskManager(tasksRoot,false,sessionsRoot)
    manager.spawnWorker=async id=>{await manager.update(id,{status:'exited',result:'worker child result',childSessionId:'child-session',sessionId:'parent',ended:Date.now()});return 4321}
    const registry=new ToolRegistry(new PermissionGate('auto'))
    registry.add({name:'read_file',risk:'read',description:'read',schema:{type:'object'},execute:async()=>({output:'ok'})})
    const provider=stubProvider()
    registry.add(taskTool(provider,{root:sessionsRoot},registry,manager,provider.config))
    const session={id:'parent'}
    const result=await registry.execute('task',{description:'inspect child',prompt:'inspect the bug',context:'Focus on lifecycle persistence.'},context(root,session.id))
    assert.match(result.output,/worker child result/)
    const task=(await manager.list())[0]
    assert.equal(task.kind,'agent'); assert.equal(task.parentSessionId,'parent'); assert.equal(task.childSessionId,'child-session'); assert.equal(task.status,'exited')
    assert.match(task.prompt,/Focus on lifecycle persistence/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13I background task returns immediately and active task_id messages are queued without waiting', async()=>{
  const root=await tmp(); try {
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const {taskTool}=await import('../dist/tools/task.js')
    const {ToolRegistry}=await import('../dist/tools/registry.js')
    const {PermissionGate}=await import('../dist/tools/permissions.js')
    const manager=new TaskManager(path.join(root,'tasks'),false,path.join(root,'sessions'))
    manager.spawnWorker=async()=>555
    const registry=new ToolRegistry(new PermissionGate('auto'))
    const provider=stubProvider()
    registry.add(taskTool(provider,{root:path.join(root,'sessions')},registry,manager,provider.config))
    const c=context(root,'parent')
    const first=await registry.execute('task',{prompt:'long child',background:true},c)
    const id=first.metadata.taskId
    assert.equal(first.metadata.background,true)
    await manager.update(id,{status:'running'})
    const second=await registry.execute('task',{task_id:id,prompt:'add cancellation checks',background:true},c)
    assert.equal(second.metadata.taskId,id); assert.equal(second.metadata.queued,true)
    assert.deepEqual((await manager.get(id)).pendingPrompts,['add cancellation checks'])
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13I terminal task_id resumes the same task identity and child session', async()=>{
  const root=await tmp(); try {
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const {taskTool}=await import('../dist/tools/task.js')
    const {ToolRegistry}=await import('../dist/tools/registry.js')
    const {PermissionGate}=await import('../dist/tools/permissions.js')
    const manager=new TaskManager(path.join(root,'tasks'),false,path.join(root,'sessions'))
    const provider=stubProvider()
    const base=await manager.createAgent('first',root,provider.config,['src'],'parent',{sessionId:'child-123',permissionMode:'auto',allowedTools:['read_file']})
    await manager.update(base.id,{status:'exited',result:'first result',ended:Date.now()})
    manager.spawnWorker=async id=>{await manager.update(id,{status:'exited',result:'resumed result',ended:Date.now()});return 777}
    const registry=new ToolRegistry(new PermissionGate('auto'))
    registry.add({name:'read_file',risk:'read',description:'read',schema:{type:'object'},execute:async()=>({output:'ok'})})
    registry.add(taskTool(provider,{root:path.join(root,'sessions')},registry,manager,provider.config))
    const result=await registry.execute('task',{task_id:base.id,prompt:'resume child work'},context(root,'parent'))
    assert.match(result.output,/resumed result/)
    const resumed=await manager.get(base.id)
    assert.equal(resumed.childSessionId,'child-123'); assert.equal(resumed.id,base.id); assert.equal(resumed.runCount,0)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13I task_status separates state from explicit task_output and supports blocking waits', async()=>{
  const root=await tmp(); try {
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const {taskStatusTool,taskOutputTool}=await import('../dist/tools/background.js')
    const manager=new TaskManager(path.join(root,'tasks'),false,path.join(root,'sessions'))
    const task=await manager.createShell('printf secret',root,'parent',[],{background:true})
    await manager.appendOutput(task.id,'secret output\n')
    const statusTool=taskStatusTool(manager); const outputTool=taskOutputTool(manager)
    const status=JSON.parse((await statusTool.execute({id:task.id,block:false},context(root,'parent'))).output)
    assert.equal(status.id,task.id); assert.equal(status.status,'queued'); assert.equal(status.outputPath,task.outputPath); assert.equal(status.result,null); assert.equal(status.error,null)
    assert.equal(JSON.stringify(status).includes('secret output'),false)
    const output=JSON.parse((await outputTool.execute({id:task.id,block:false},context(root,'parent'))).output)
    assert.match(output.output,/secret output/)
    const finish=()=>manager.update(task.id,{status:'exited',result:'done',ended:Date.now()})
    setTimeout(finish,50)
    const blocked=JSON.parse((await statusTool.execute({id:task.id,block:true,timeout:1000},context(root,'parent'))).output)
    assert.equal(blocked.status,'exited'); assert.equal(blocked.result,'done')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13I read-only task waits abort without cancelling the background task', async()=>{
  const root=await tmp(); try {
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const {taskStatusTool}=await import('../dist/tools/background.js')
    const manager=new TaskManager(path.join(root,'tasks'),false,path.join(root,'sessions'))
    const task=await manager.createShell('sleep 1',root,'parent',[],{background:true})
    const ac=new AbortController(); const promise=taskStatusTool(manager).execute({id:task.id,block:true,timeout:5000},{...context(root,'parent'),abort:ac.signal})
    setTimeout(()=>ac.abort('parent-stop'),30)
    await assert.rejects(promise,/wait was cancelled/i)
    assert.equal((await manager.get(task.id)).status,'queued')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13I background completion creates a compact parent notification without reading child output', async()=>{
  const root=await tmp(); const sessionsRoot=path.join(root,'sessions'); try {
    const {SessionStore}=await import('../dist/session/store.js')
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const parentStore=new SessionStore(sessionsRoot); const parent=await parentStore.create(root,'mock')
    const manager=new TaskManager(path.join(root,'tasks'),false,sessionsRoot)
    const task=await manager.createAgent('child',root,providerConfig('http://127.0.0.1'),[],parent.id,{background:true})
    await manager.appendOutput(task.id,'FULL CHILD OUTPUT THAT MUST NOT BE INJECTED')
    await manager.finish(task.id,{status:'exited',result:'compact result',childSessionId:'child-1',ended:Date.now()})
    const loaded=await parentStore.load(parent.id)
    const notification=loaded.events.find(e=>e.type==='task.notification')?.data
    assert.equal(notification.taskId,task.id); assert.equal(notification.status,'completed'); assert.equal(notification.summary,'compact result'); assert.equal(notification.childSessionId,'child-1')
    assert.equal(JSON.stringify(notification).includes('FULL CHILD OUTPUT'),false)
    assert.equal(loaded.events.some(e=>e.type==='task.notification.consumed'),false)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13I Agent consumes parent notifications into the next turn and never rereads output', async()=>{
  const root=await tmp(); const sessionsRoot=path.join(root,'sessions'); try {
    const {SessionStore}=await import('../dist/session/store.js')
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const {Agent}=await import('../dist/agent/agent.js')
    const {ToolRegistry}=await import('../dist/tools/registry.js')
    const {PermissionGate}=await import('../dist/tools/permissions.js')
    const sessions=new SessionStore(sessionsRoot); const parent=await sessions.create(root,'mock')
    const manager=new TaskManager(path.join(root,'tasks'),false,sessionsRoot)
    const task=await manager.createAgent('child',root,providerConfig('http://127.0.0.1'),[],parent.id,{background:true})
    await manager.finish(task.id,{status:'failed',error:'child boom',output:'HUGE RAW OUTPUT SHOULD STAY OUT',ended:Date.now()})
    let captured=[]
    const provider={id:'mock',model:'mock',config:{model:'mock',baseUrl:'http://127.0.0.1'},async*stream(messages){captured.push(messages.map(m=>({role:m.role,content:m.content})));yield {type:'text',delta:'ack'};yield {type:'done',finishReason:'stop'}}}
    const agent=new Agent(provider,new ToolRegistry(new PermissionGate('auto')),sessions,1,6000,1)
    await agent.run({sessionId:parent.id,messages:[],cwd:root,instructions:'',prompt:'continue'})
    const injected=captured.flat().find(m=>m.role==='user'&&String(m.content).includes('<task-notification'))
    assert.ok(injected)
    assert.equal(String(injected.content).includes('HUGE RAW OUTPUT'),false)
    const loaded=await sessions.load(parent.id)
    assert.equal(loaded.events.some(e=>e.type==='task.notification.consumed'&&e.data?.taskId===task.id),true)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13I real worker creates a durable child session under the parent and completes the task', async()=>{
  const root=await tmp(); const tasksRoot=path.join(root,'tasks'); const sessionsRoot=path.join(root,'sessions'); const oldSessionRoot=process.env.TERMAGENT_SESSION_ROOT
  const {server,baseUrl}=await makeProviderServer('real worker complete')
  try {
    process.env.TERMAGENT_SESSION_ROOT=sessionsRoot
    const {SessionStore}=await import('../dist/session/store.js')
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const {runTaskWorker}=await import('../dist/tasks/worker.js')
    const parentStore=new SessionStore(sessionsRoot); const parent=await parentStore.create(root,'mock')
    const manager=new TaskManager(tasksRoot,false,sessionsRoot)
    const task=await manager.createAgent('do real work',root,providerConfig(baseUrl),['.'],parent.id,{background:true,permissionMode:'auto',allowedTools:[]})
    await runTaskWorker(task.id,manager)
    const finished=await manager.get(task.id)
    assert.equal(finished.status,'exited'); assert.equal(finished.parentSessionId,parent.id); assert.ok(finished.childSessionId)
    assert.match(finished.result,/real worker complete/)
    const child=await parentStore.load(finished.childSessionId)
    assert.equal(child.meta.parentId,parent.id)
    assert.ok(child.messages.some(m=>m.role==='assistant'&&String(m.content).includes('real worker complete')))
    const parentLoaded=await parentStore.load(parent.id)
    assert.equal(parentLoaded.events.some(e=>e.type==='task.notification'),true)
  } finally { process.env.TERMAGENT_SESSION_ROOT=oldSessionRoot; await new Promise(resolve=>server.close(resolve)); await fs.rm(root,{recursive:true,force:true}) }
})

test('13I child permission derivation narrows recursive task capabilities and preserves explicit parent denies', async()=>{
  const {PermissionGate}=await import('../dist/tools/permissions.js')
  const gate=new PermissionGate('auto',process.stdin,process.stdout,[{tool:'write_file',pattern:'*',decision:'deny'}])
  const policy=gate.deriveChildPolicy([
    {name:'read_file',risk:'read',description:'read',schema:{type:'object'},execute:async()=>({output:''})},
    {name:'write_file',risk:'write',description:'write',schema:{type:'object'},execute:async()=>({output:''})},
    {name:'task',risk:'shell',description:'task',schema:{type:'object'},execute:async()=>({output:''})},
  ])
  assert.ok(policy.allowedTools.includes('read_file'))
  assert.equal(policy.allowedTools.includes('write_file'),false)
  assert.equal(policy.allowedTools.includes('task'),false)
  assert.ok(policy.rules.some(r=>r.decision==='deny'&&r.tool==='write_file'))
})

test('13I overlapping workspace scopes are rejected unless explicitly coordinated', async()=>{
  const root=await tmp(); try {
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const manager=new TaskManager(path.join(root,'tasks'),false,path.join(root,'sessions'))
    const cfg=providerConfig('http://127.0.0.1')
    await manager.createAgent('one',root,cfg,['src'],'parent',{background:true})
    await assert.rejects(()=>manager.createAgent('two',root,cfg,['src/lib'],'parent',{background:true}),/scope conflict/i)
    const coordinated=await manager.createAgent('three',root,cfg,['src/lib'],'parent',{background:true,coordinated:true})
    assert.equal(coordinated.coordinated,true)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13I shell background task records parent linkage, output file, timeout, and cancellation', async()=>{
  const root=await tmp(); try {
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const {startManagedShell}=await import('../dist/tasks/shell-command.js')
    const manager=new TaskManager(path.join(root,'tasks'),false,path.join(root,'sessions'))
    const timeoutTask=await manager.createShell('sleep 1',root,'parent',[],{background:true,timeoutMs:50})
    const timeoutHandle=await startManagedShell(manager,{shell:process.env.SHELL||'sh',command:'sleep 1',cwd:root,timeout:50,maxPreviewBytes:500,detached:true,parentSessionId:'parent',background:true},timeoutTask)
    const timeoutResult=await timeoutHandle.result
    assert.equal(timeoutResult.termination,'timeout'); assert.equal((await manager.get(timeoutTask.id)).status,'failed')

    const cancelTask=await manager.createShell('sleep 5',root,'parent',[],{background:true})
    const cancelHandle=await startManagedShell(manager,{shell:process.env.SHELL||'sh',command:'sleep 5',cwd:root,timeout:5000,maxPreviewBytes:500,detached:true,parentSessionId:'parent',background:true},cancelTask)
    await new Promise(r=>setTimeout(r,50))
    await manager.cancel(cancelTask.id)
    assert.equal((await manager.get(cancelTask.id)).status,'cancelled')
    await cancelHandle.result.catch(()=>{})
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})
