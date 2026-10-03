import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import test from 'node:test'

const tmp = (prefix='termagent-13n-g-') => fs.mkdtemp(path.join(os.tmpdir(), prefix))
const sig = new AbortController().signal

async function makeServer(text='specialist complete') {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\n`)
    res.write(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {server, baseUrl:`http://127.0.0.1:${server.address().port}/v1`}
}

test('13N-G specialist registry is explicit, bounded, and tool-scoped', async () => {
  const {SPECIALIST_ROLES, specialistRole, specialistRoleNames, restrictSpecialistTools} = await import('../dist/agent/specialists.js')
  assert.deepEqual(specialistRoleNames(), ['general','researcher','planner','coder','reviewer','tester'])
  assert.equal(specialistRole('REVIEWER').readOnly, true)
  assert.equal(specialistRole('tester').allowShell, true)
  assert.equal(specialistRole('coder').allowShell, false)
  assert.ok(SPECIALIST_ROLES.coder.allowedTools.includes('apply_patch'))
  assert.ok(!SPECIALIST_ROLES.reviewer.allowedTools.includes('write_file'))
  assert.deepEqual(restrictSpecialistTools('reviewer',['read_file','grep','write_file']), ['read_file','grep'])
  assert.deepEqual(restrictSpecialistTools('coder',['read_file','edit_file','bash']), ['read_file','edit_file'])
})

test('13N-G task creation inherits the parent scope and intersects specialist tools', async () => {
  const root = await tmp()
  try {
    const {TaskManager} = await import('../dist/tasks/manager.js')
    const {ToolRegistry} = await import('../dist/tools/registry.js')
    const {PermissionGate} = await import('../dist/tools/permissions.js')
    const {taskTool} = await import('../dist/tools/task.js')
    const manager = new TaskManager(path.join(root,'tasks'), false, path.join(root,'sessions'))
    manager.spawnWorker = async id => { await manager.update(id, {status:'exited', result:'done', ended:Date.now()}); return 111 }
    const registry = new ToolRegistry(new PermissionGate('auto'))
    for (const name of ['read_file','grep','glob','repo_map','write_file','edit_file','apply_patch','verify_project']) {
      registry.add({name, risk: name==='verify_project' ? 'shell' : ['write_file','edit_file','apply_patch'].includes(name) ? 'write' : 'read', description:name, schema:{type:'object'}, execute:async()=>({output:'ok'})})
    }
    const provider = {id:'mock',model:'mock',config:{provider:'openai-compatible',model:'mock',baseUrl:'http://127.0.0.1'}}
    registry.add(taskTool(provider,{root:path.join(root,'sessions')},registry,manager,provider.config))
    const ctx={sessionID:'parent',agent:'build',cwd:root,abort:sig,scopePaths:['src']}
    const result = await registry.execute('task',{prompt:'review src',role:'reviewer'},ctx)
    const task = (await manager.list())[0]
    assert.equal(task.specialistRole,'reviewer')
    assert.equal(task.delegationDepth,1)
    assert.deepEqual(task.scopePaths,['src'])
    assert.deepEqual(task.allowedTools,['read_file','grep','glob','repo_map'])
    assert.match(result.output,/done/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13N-G delegation concurrency is enforced centrally, including coordinated tasks', async () => {
  const root = await tmp()
  const prev = process.env.TERMAGENT_MAX_ACTIVE_AGENTS
  process.env.TERMAGENT_MAX_ACTIVE_AGENTS = '2'
  try {
    const {TaskManager} = await import('../dist/tasks/manager.js')
    const manager = new TaskManager(path.join(root,'tasks'), false, path.join(root,'sessions'))
    const provider={provider:'openai-compatible',model:'m',baseUrl:'http://x'}
    const one=await manager.createAgent('1',root,provider,['a'],'parent',{background:true})
    const two=await manager.createAgent('2',root,provider,['b'],'parent',{background:true})
    await manager.update(one.id,{status:'running'}); await manager.update(two.id,{status:'running'})
    await assert.rejects(() => manager.createAgent('3',root,provider,['c'],'parent',{background:true}), /delegation limit exceeded/i)
    await assert.rejects(() => manager.createAgent('3',root,provider,['c'],'parent',{background:true,coordinated:true}), /delegation limit exceeded/i)
  } finally {
    if(prev===undefined) delete process.env.TERMAGENT_MAX_ACTIVE_AGENTS; else process.env.TERMAGENT_MAX_ACTIVE_AGENTS=prev
    await fs.rm(root,{recursive:true,force:true})
  }
})

test('13N-G parent cancellation propagates through durable parentTaskId links', async () => {
  const root = await tmp()
  try {
    const {TaskManager} = await import('../dist/tasks/manager.js')
    const manager = new TaskManager(path.join(root,'tasks'), false, path.join(root,'sessions'))
    const cfg={provider:'openai-compatible',model:'m',baseUrl:'http://x'}
    const parent=await manager.createAgent('parent',root,cfg,['src'],'session',{background:true})
    const child=await manager.createAgent('child',root,cfg,['tests'],'session',{background:true,parentTaskId:parent.id,delegationDepth:1})
    await manager.cancel(parent.id)
    assert.equal((await manager.get(parent.id)).status,'cancelled')
    assert.equal((await manager.get(child.id)).status,'cancelled')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13N-G worker preserves specialist role, bounded report, and estimated usage accounting', async () => {
  const root=await tmp(); const taskRoot=path.join(root,'tasks'); const sessionRoot=path.join(root,'sessions')
  const server=await makeServer('research finished with evidence')
  try {
    process.env.TERMAGENT_TASK_ROOT=taskRoot; process.env.TERMAGENT_SESSION_ROOT=sessionRoot
    const {TaskManager}=await import('../dist/tasks/manager.js')
    const {runTaskWorker}=await import('../dist/tasks/worker.js')
    const manager=new TaskManager(taskRoot,false,sessionRoot)
    const task=await manager.createAgent('Research the repository and report one finding.',root,{provider:'openai-compatible',model:'mock',baseUrl:server.baseUrl},['.'],'parent',{specialistRole:'researcher',delegationDepth:1,allowedTools:['read_file','grep','glob','repo_map'],background:true})
    await runTaskWorker(task.id,manager)
    const done=await manager.get(task.id)
    assert.equal(done.status,'exited')
    assert.equal(done.specialistRole,'researcher')
    assert.equal(done.delegationDepth,1)
    assert.ok((done.usage?.totalTokens||0)>0)
    assert.equal(done.usage?.estimated,true)
    assert.match(done.result,/\[researcher specialist\]/)
    assert.ok((done.result||'').length<=6000)
  } finally {
    server.server.close()
    delete process.env.TERMAGENT_TASK_ROOT; delete process.env.TERMAGENT_SESSION_ROOT
    await fs.rm(root,{recursive:true,force:true})
  }
})
