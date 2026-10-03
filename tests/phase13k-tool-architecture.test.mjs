import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ToolRegistry, normalizeToolDefinition } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { ToolValidationError } from '../dist/tools/schema.js'
import { loadPlugins } from '../dist/plugins/loader.js'
import { SessionStore } from '../dist/session/store.js'
import { ToolCallLifecycle } from '../dist/agent/tool-call-lifecycle.js'
import { Agent } from '../dist/agent/agent.js'

function signal(){ return new AbortController().signal }
function ctx(cwd, extra={}){ return {sessionID:'phase13k',agent:'build',cwd,abort:signal(),...extra} }
function tool(overrides={}){
  return {name:'demo',description:'demo tool',risk:'read',schema:{type:'object',properties:{value:{type:'string'}},required:['value']},async execute(){return {output:'ok'}},...overrides}
}
async function tmp(){return fs.mkdtemp(path.join(os.tmpdir(),'termagent-phase13k-'))}

test('13K collision overlays latest registration and closing restores the previous tool', async () => {
  const registry=new ToolRegistry(new PermissionGate('auto'))
  const first=registry.register(tool({description:'first',async execute(){return {output:'first'}}}))
  const second=registry.register(tool({description:'second',async execute(){return {output:'second'}}}))
  assert.equal(registry.get('demo').description,'second')
  assert.equal((await registry.execute('demo',{value:'x'},ctx(process.cwd()))).output,'second')
  assert.equal(second.close(),true)
  assert.equal(registry.get('demo').description,'first')
  assert.equal((await registry.execute('demo',{value:'x'},ctx(process.cwd()))).output,'first')
  assert.equal(first.close(),true)
  assert.equal(registry.get('demo'),undefined)
})

test('13K normalized metadata distinguishes local, plugin, MCP, declarative and provider-hosted tools', () => {
  const local=normalizeToolDefinition(tool())
  const plugin=normalizeToolDefinition(tool({name:'plugin_demo',provenance:{kind:'plugin',pluginId:'p'}}))
  const mcp=normalizeToolDefinition(tool({name:'mcp_demo',provenance:{kind:'mcp',server:'s'}}))
  const declarative=normalizeToolDefinition(tool({name:'declarative_demo',kind:'declarative',execute:undefined}))
  const hosted=normalizeToolDefinition(tool({name:'hosted_demo',kind:'provider-hosted',provenance:{kind:'provider-hosted',provider:'x',model:'m'},execute:undefined}))
  assert.equal(local.kind,'local'); assert.equal(local.provenance.kind,'builtin')
  assert.equal(plugin.kind,'plugin'); assert.equal(mcp.kind,'mcp')
  assert.equal(declarative.kind,'declarative'); assert.equal(hosted.kind,'provider-hosted')
  assert.equal(local.readOnly,true); assert.equal(local.concurrency,'safe')
})

test('13K invalid input never invokes the executor and produces a structured validation failure', async () => {
  let invoked=0
  const registry=new ToolRegistry(new PermissionGate('auto')).add(tool({async execute(){invoked++;return {output:'should-not-run'}}}))
  await assert.rejects(() => registry.execute('demo',{},ctx(process.cwd())), error => error instanceof ToolValidationError && /value/.test(error.message))
  assert.equal(invoked,0)
})

test('13K output schema validation rejects invalid structured tool output after execution', async () => {
  const registry=new ToolRegistry(new PermissionGate('auto')).add(tool({outputSchema:{type:'string',minLength:3},async execute(){return {output:'x'}}}))
  await assert.rejects(()=>registry.execute('demo',{value:'x'},ctx(process.cwd())),error => error instanceof ToolValidationError && error.phase==='output')
})

test('13K declarative and provider-hosted definitions cannot be executed by the local registry', async () => {
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add(tool({name:'decl',kind:'declarative',execute:undefined}))
  registry.add(tool({name:'host',kind:'provider-hosted',execute:undefined,provenance:{kind:'provider-hosted',provider:'p'}}))
  await assert.rejects(()=>registry.execute('decl',{},ctx(process.cwd())),/not locally executable/)
  await assert.rejects(()=>registry.execute('host',{},ctx(process.cwd())),/not locally executable/)
})

test('13K permission actions use resource patterns and external-directory protection', async () => {
  const prompts=[]
  const gate=new PermissionGate('ask')
  gate.setRequester(async request=>{prompts.push(request);return 'once'})
  const registry=new ToolRegistry(gate)
  registry.add(tool({name:'edit_file',risk:'write',permission:{action:'edit',externalDirectory:true},schema:{type:'object',properties:{path:{type:'string'}},required:['path']},async execute(){return {output:'edited'}}}))
  const root=await tmp()
  try {
    const c=ctx(root)
    await registry.execute('edit_file',{path:'/tmp/outside.txt'},c)
    assert.ok(prompts.some(p=>p.action==='edit'))
    assert.ok(prompts.some(p=>p.action==='external_directory'))
    assert.ok(prompts.find(p=>p.action==='external_directory').resources.includes('/tmp/outside.txt'))
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13K resource-pattern permission rules match canonical actions and concrete resources', async () => {
  const gate=new PermissionGate('ask',process.stdin,process.stdout,[{tool:'read',decision:'deny',pattern:'secret/*'}])
  const registry=new ToolRegistry(gate).add(tool({name:'read_file',schema:{type:'object',properties:{path:{type:'string'}},required:['path']},async execute(){return {output:'no'}}}))
  await assert.rejects(()=>registry.execute('read_file',{path:'secret/key.txt'},ctx(process.cwd())),/Permission denied/)
  await assert.doesNotReject(()=>registry.execute('read_file',{path:'public/key.txt'},ctx(process.cwd())))
})

test('13K static deny rules remove denied actions from model-visible schemas', () => {
  const gate=new PermissionGate('ask',process.stdin,process.stdout,[{tool:'shell',decision:'deny'}])
  const registry=new ToolRegistry(gate)
    .add(tool({name:'read_file',risk:'read'}))
    .add(tool({name:'bash',risk:'shell',schema:{type:'object',properties:{command:{type:'string'}},required:['command']}}))
  const result=registry.selectSchemas({allowWrite:true,allowShell:true,budgetTokens:2000})
  const names=result.tools.map(x=>x.function.name)
  assert.deepEqual(names,['read_file'])
})

test('13K dynamic availability remains context-aware while stable schemas stay cached', () => {
  let enabled=true
  const registry=new ToolRegistry(new PermissionGate('auto')).add(tool({isEnabled:()=>enabled}))
  const first=registry.schemas(); const second=registry.schemas()
  assert.strictEqual(first,second)
  assert.equal(registry.selectSchemas({budgetTokens:2000}).tools.length,1)
  enabled=false
  assert.equal(registry.selectSchemas({budgetTokens:2000}).tools.length,0)
  registry.add(tool({name:'second',schema:{type:'object'},async execute(){return {output:'x'}}}))
  assert.notStrictEqual(registry.schemas(),first)
})

test('13K bounded schema selection respects agent/mode/workflow filters and budget', () => {
  const registry=new ToolRegistry(new PermissionGate('auto'))
  registry.add(tool({name:'read_file',description:'read',risk:'read'}))
  registry.add(tool({name:'write_file',description:'write',risk:'write'}))
  registry.add(tool({name:'bash',description:'shell',risk:'shell',schema:{type:'object',properties:{command:{type:'string'}},required:['command']}}))
  registry.add(tool({name:'special',description:'special',risk:'read'}))
  const noWrite=registry.selectSchemas({allowWrite:false,allowShell:false,allowedTools:new Set(['read_file','special']),workflowAllowed:t=>t.name!=='special',budgetTokens:400})
  assert.deepEqual(noWrite.tools.map(x=>x.function.name),['read_file'])
  assert.ok(noWrite.estimatedTokens<=400)
})

test('13K provenance persists with durable tool-call lifecycle records', async () => {
  const root=await tmp()
  try {
    const store=new SessionStore(path.join(root,'sessions'))
    const session=await store.create(root,'provenance')
    const lifecycle=new ToolCallLifecycle(store)
    await lifecycle.pending({sessionId:session.id,turnId:'turn-1',callId:'call-1',name:'mcp_demo',argumentsRaw:'{}',kind:'mcp',provenance:{kind:'mcp',server:'demo'}})
    await lifecycle.transition('call-1',{state:'running'})
    await lifecycle.transition('call-1',{state:'completed',outcome:'success',providerMetadata:{trace:'x'}})
    const loaded=await store.load(session.id)
    const records=loaded.events.filter(e=>e.type==='tool.call').map(e=>e.data)
    assert.equal(records.at(-1).provenance.kind,'mcp')
    assert.equal(records.at(-1).provenance.server,'demo')
    assert.equal(records.at(-1).providerMetadata.trace,'x')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13K plugin registration attaches plugin provenance without changing the plugin execution contract', async () => {
  const root=await tmp(); const pluginDir=path.join(root,'.plugins'); await fs.mkdir(pluginDir,{recursive:true})
  await fs.writeFile(path.join(pluginDir,'sample.mjs'),`export default async ({registerTool}) => registerTool({name:'plugin_sample',description:'plugin',risk:'read',schema:{type:'object'},execute:async()=>({output:'plugin-ok'})})`)
  try {
    const registry=new ToolRegistry(new PermissionGate('auto'))
    await loadPlugins(root,registry,[pluginDir])
    const def=registry.get('plugin_sample')
    assert.equal(def.kind,'plugin'); assert.equal(def.provenance.kind,'plugin'); assert.match(def.provenance.pluginName,/sample/)
    assert.equal((await registry.execute('plugin_sample',{},ctx(root))).output,'plugin-ok')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13K provider-hosted calls are represented as non-local definitions', () => {
  const registry=new ToolRegistry(new PermissionGate('auto'))
  const def=registry.providerHostedDefinition('search','anthropic','claude')
  assert.equal(def.kind,'provider-hosted')
  assert.equal(def.provenance.provider,'anthropic')
  assert.equal(def.provenance.model,'claude')
  assert.equal(def.execute,undefined)
})
test('13K Agent persists provider-hosted provenance without invoking the local definition', async () => {
  const root=await tmp()
  try {
    const sessions=new SessionStore(path.join(root,'sessions'))
    const session=await sessions.create(root,'provider')
    const registry=new ToolRegistry(new PermissionGate('auto'))
    let localRuns=0
    registry.add(tool({name:'remote_tool',risk:'write',async execute(){localRuns++;return {output:'local'}}}))
    const provider={id:'mock-provider',model:'remote-model',n:0,async *stream(){
      this.n++
      if(this.n===1){
        const call={id:'remote-1',type:'function',function:{name:'remote_tool',arguments:'{"value":"x"}'}}
        yield {type:'tool_call',call,providerExecuted:true,providerMetadata:{remote:true}}
        yield {type:'tool_result',call,output:'remote-ok',providerExecuted:true,providerMetadata:{remote:true}}
        yield {type:'done',finishReason:'tool_calls'}
        return
      }
      yield {type:'text',delta:'done'}; yield {type:'done',finishReason:'stop'}
    }}
    const agent=new Agent(provider,registry,sessions,3,6000,1)
    await agent.run({sessionId:session.id,messages:[],cwd:root,instructions:'',prompt:'remote',mode:'build'})
    assert.equal(localRuns,0)
    const loaded=await sessions.load(session.id)
    const record=loaded.events.filter(e=>e.type==='tool.call'&&e.data.callId==='remote-1').at(-1).data
    assert.equal(record.kind,'provider-hosted')
    assert.equal(record.provenance.provider,'mock-provider')
    assert.equal(record.provenance.model,'remote-model')
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('13K task and skill tool names map to canonical permission actions', () => {
  const prompts=[]
  const gate=new PermissionGate('ask')
  gate.setRequester(async request=>{prompts.push(request);return 'once'})
  const registry=new ToolRegistry(gate)
  registry.add(tool({name:'task',risk:'shell',schema:{type:'object',properties:{prompt:{type:'string'}},required:['prompt']},async execute(){return {output:'task'}}}))
  registry.add(tool({name:'use_skill',risk:'read',schema:{type:'object',properties:{name:{type:'string'}},required:['name']},async execute(){return {output:'skill'}}}))
  // task needs approval in ask mode; read skill remains safe by default.
  return registry.execute('task',{prompt:'do'},ctx(process.cwd())).then(()=>assert.equal(prompts.at(-1).action,'task'))
})
