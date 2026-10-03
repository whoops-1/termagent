import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { builtinTools } from '../dist/tools/builtin.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { questionTool } from '../dist/tools/question.js'
import { backgroundTool, taskStatusTool, taskCancelTool, backgroundAgentTool } from '../dist/tools/background.js'
import { parallelAgentTool } from '../dist/tools/parallel.js'
import { taskTool } from '../dist/tools/task.js'
import { sessionTodoTool } from '../dist/tools/session-todo.js'
import { todoTool } from '../dist/tools/todo.js'
import { verifyTool } from '../dist/tools/verify.js'
import { agentModeTool } from '../dist/tools/agent-mode.js'
import { skillTools } from '../dist/tools/skills.js'
import { workflowPhaseTool } from '../dist/tools/workflow-phase.js'
import { ExecutionWorkflow, initialWorkflow } from '../dist/agent/workflow.js'
import { SessionStore } from '../dist/session/store.js'
import { TaskManager } from '../dist/tasks/manager.js'
import { AGENT_PROFILES } from '../dist/agent/profiles.js'
import { FileReadStateCache } from '../dist/tools/file-state.js'

const signal = new AbortController().signal
const ctx = cwd => ({ sessionID:'phase13a', agent:'build', cwd, abort:signal })
const fakeProvider = () => ({
  id:'phase13a-provider', model:'phase13a-model', config:{model:'phase13a-model',baseUrl:'http://127.0.0.1'},
  async *stream() { yield { type:'text', delta:'child complete' }; yield { type:'done', finishReason:'stop' } },
})

async function temp(prefix='termagent-phase13a-'){ return fs.mkdtemp(path.join(os.tmpdir(), prefix)) }

class StubTaskManager extends TaskManager {
  constructor(root) { super(root, false) }
  async spawnWorker(id) { return 0 }
}

function registerAll(registry, tools) { for (const tool of tools) registry.add(tool); return registry }

test('13A inventory covers every fixed tool contract', async () => {
  const inventory = JSON.parse(await fs.readFile(path.resolve('docs/phase13/tool-inventory.json'),'utf8'))
  const concrete = inventory.entries.filter(x => x.name && !x.name.includes('*'))
  const names = new Set(concrete.map(x => x.name))
  const required = ['schema','output','permission','cancellation','concurrency','persistence','contextCost','severity','gap','designNotes']
  for (const entry of concrete) for (const key of required) assert.ok(Object.prototype.hasOwnProperty.call(entry, key), `inventory ${entry.name} missing ${key}`)
  const expected = [
    ...builtinTools({timeout:1000,maxOutput:100}).map(t => t.name),
    questionTool().name,
    backgroundTool(new StubTaskManager(process.cwd())).name,
    taskStatusTool(new StubTaskManager(process.cwd())).name,
    taskCancelTool(new StubTaskManager(process.cwd())).name,
    backgroundAgentTool(new StubTaskManager(process.cwd()), fakeProvider()).name,
    parallelAgentTool(new StubTaskManager(process.cwd()), fakeProvider(), fakeProvider().config).name,
    taskTool(fakeProvider(), new SessionStore(process.cwd()), new ToolRegistry(new PermissionGate('auto'))).name,
    sessionTodoTool(new SessionStore(process.cwd())).name,
    todoTool([]).name,
    verifyTool().name,
    agentModeTool(()=> 'build', ()=>{}).name,
    ...skillTools().map(t=>t.name),
    workflowPhaseTool(new ExecutionWorkflow(initialWorkflow())).name,
  ]
  for (const name of [...new Set(expected)]) assert.ok(names.has(name), `missing inventory entry: ${name}`)
  assert.ok(inventory.entries.some(x => x.name === 'plugin:*'))
  assert.ok(inventory.entries.some(x => x.name === 'mcp_<server>_<tool>'))
  assert.ok(inventory.entries.some(x => x.name === 'PermissionGate'))
  assert.ok(inventory.entries.some(x => x.name === 'ToolRegistry'))
  assert.ok(inventory.entries.some(x => x.name === 'Agent.run'))
  assert.ok(inventory.entries.some(x => x.name === 'compactMessages'))
})

test('13A builtins preserve their existing basic contracts', async () => {
  const root = await temp()
  try {
    const registry = registerAll(new ToolRegistry(new PermissionGate('auto')), builtinTools({timeout:5000,maxOutput:5000}))
    const c = { ...ctx(root), readFileState: new FileReadStateCache() }
    const write = await registry.execute('write_file',{path:'src/a.txt',content:'one\ntwo\nthree\n'},c)
    assert.match(write.output,/wrote 14 bytes/)
    const read = await registry.execute('read_file',{path:'src/a.txt',startLine:2,endLine:3},c)
    assert.match(read.output,/already covered/i)
    await registry.execute('read_file',{path:'src/a.txt',startLine:1,endLine:3},c)
    const grep = await registry.execute('grep',{pattern:'two'},c)
    assert.match(grep.output,/src\/a\.txt/)
    const glob = await registry.execute('glob',{pattern:'src/*.txt'},c)
    assert.match(glob.output,/src\/a\.txt/)
    const edit = await registry.execute('edit_file',{path:'src/a.txt',oldText:'two',newText:'TWO'},c)
    assert.match(edit.output,/edited 1 occurrence/)
    const bash = await registry.execute('bash',{command:'printf shell-ok'},c)
    assert.match(bash.output,/shell-ok/)
    const git = await registry.execute('git',{args:['--version']},c)
    assert.match(git.output,/git version/i)
    const map = await registry.execute('repo_map',{tokens:256},c)
    assert.ok(map.output.length <= 5000)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13A question contract passes answers through the supplied questioner', async () => {
  const tool = questionTool()
  const answer = await tool.execute({questions:[{header:'x',question:'Pick',options:[{label:'one'}]}]}, { ...ctx(process.cwd()), questioner: async questions => { assert.equal(questions.length,1); return [['one']] } })
  assert.match(answer.output,/one/)
})

test('13A task/status/cancel contracts use durable TaskManager state', async () => {
  const root = await temp(); const manager = new StubTaskManager(path.join(root,'tasks'))
  try {
    const c = ctx(root)
    const registry = new ToolRegistry(new PermissionGate('auto'))
    registry.add(backgroundTool(manager)).add(taskStatusTool(manager)).add(taskCancelTool(manager))
    const started = await registry.execute('background',{command:'printf task-ok'},c)
    const id = started.output.match(/Started background task ([a-f0-9]+)/)?.[1]
    assert.ok(id)
    const status = JSON.parse((await registry.execute('task_status',{id},c)).output)
    assert.equal(status.kind,'shell'); assert.equal(status.status,'queued')
    const cancelled = await registry.execute('task_cancel',{id},c)
    assert.match(cancelled.output,/cancelled/i)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13A background-agent and parallel-agent contracts create bounded task records', async () => {
  const root = await temp(); const manager = new StubTaskManager(path.join(root,'tasks')); const provider = fakeProvider()
  try {
    const registry = new ToolRegistry(new PermissionGate('auto')).add(backgroundAgentTool(manager,provider,provider.config)).add(parallelAgentTool(manager,provider,provider.config))
    const c = ctx(root)
    const bg = await registry.execute('background_agent',{prompt:'inspect',scope_paths:['background-agent']},c); assert.match(bg.output,/Started background agent/)
    const par = await registry.execute('parallel_agents',{tasks:[{prompt:'a',paths:['src/a']},{prompt:'b',paths:['src/b']}]},c)
    assert.match(par.output,/2 bounded parallel agents/)
    const records = await manager.list();
    const created = records.filter(t => t.kind === 'agent' && t.sessionId === c.sessionID);
    assert.equal(created.length, 3);
    assert.ok(created.every(t => t.status === 'queued' || t.status === 'running'));
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13A task tool remains foreground and returns child text', async () => {
  const root=await temp(); const store = new SessionStore(path.join(root,'sessions')); const manager = new StubTaskManager(path.join(root,'tasks'))
  manager.spawnWorker = async id => { await manager.update(id,{status:'exited',result:'child complete',childSessionId:'child-session'}); return 1 }
  try {
    const parent = new ToolRegistry(new PermissionGate('auto'))
    parent.add(taskTool(fakeProvider(),store,parent,manager,fakeProvider().config))
    const result = await parent.execute('task',{prompt:'do child'},ctx(root))
    assert.match(result.output,/child complete/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13A both todo implementations remain contract-compatible', async () => {
  const state=[]; const cliTodo=todoTool(state); await cliTodo.execute({action:'add',id:'1',task:'first',status:'pending'})
  assert.deepEqual(JSON.parse((await cliTodo.execute({action:'list'})).output),state)
  const root=await temp(); const store=new SessionStore(path.join(root,'sessions')); const session=await store.create(root,'todo')
  try {
    const sessionTodo=sessionTodoTool(store)
    const c={...ctx(root),sessionID:session.id}
    await sessionTodo.execute({action:'set',items:[{id:'1',task:'first',status:'pending'}]},c)
    assert.deepEqual(JSON.parse((await sessionTodo.execute({action:'list'},c)).output),[{id:'1',task:'first',status:'pending'}])
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13A verification and workflow contracts preserve current semantics', async () => {
  const root=await temp();
  try {
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{test:'printf verify-ok'}}))
    const verify=await verifyTool(5000,1000).execute({},ctx(root))
    assert.equal(verify.metadata.ok,true); assert.match(verify.output,/verify-ok/)
    const workflow=new ExecutionWorkflow(initialWorkflow())
    const result=await workflowPhaseTool(workflow).execute({phase:'planning',reason:'baseline'})
    assert.match(result.output,/planning/)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13A agent mode, skill tools, and dynamic provenance contracts are intact', async () => {
  let mode='build'; const modeTool=agentModeTool(()=>mode,m=>{mode=m})
  await modeTool.execute({mode:'plan'}); assert.equal(mode,'plan'); assert.ok(AGENT_PROFILES.plan)
  const skills=skillTools(); const search=skills.find(t=>t.name==='search_skills'); const use=skills.find(t=>t.name==='use_skill')
  assert.ok(search && use); assert.equal(search.risk,'read'); assert.equal(use.risk,'read')
  const registry=new ToolRegistry(new PermissionGate('auto'))
  const dynamic={name:'plugin_phase13a',description:'dynamic',risk:'read',schema:{type:'object'},provenance:{kind:'plugin',pluginId:'phase13a'},execute:async()=>({output:'plugin-ok'})}
  registry.add(dynamic); const pluginResult=await registry.execute(dynamic.name,{},ctx(process.cwd())); assert.equal(pluginResult.output,'plugin-ok')
  const mcp={name:'mcp_phase13a_echo',description:'mcp',risk:'read',schema:{type:'object'},provenance:{kind:'mcp',server:'phase13a'},execute:async()=>({output:'mcp-ok'})}
  registry.add(mcp); const mcpResult=await registry.execute(mcp.name,{},ctx(process.cwd())); assert.equal(mcpResult.output,'mcp-ok')
})
