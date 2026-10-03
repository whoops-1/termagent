import test from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from '../dist/agent/agent.js'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { SessionStore } from '../dist/session/store.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function provider(toolName,args){return {id:'mock',model:'mock',async *stream(messages,schemas){const last=messages[messages.length-1]; if(last.role==='user' && schemas.some(x=>x.function.name===toolName)){yield {type:'tool_call',call:{id:'1',type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}}} else yield {type:'text',delta:'done'}}}}

test('plan mode excludes write and shell tools from model schema', async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'termagent-mode-')); const store=new SessionStore(path.join(root,'sessions')); const reg=new ToolRegistry(new PermissionGate('auto'))
 reg.add({name:'read_file',description:'read',risk:'read',schema:{type:'object'},execute:async()=>({output:'ok'})})
 reg.add({name:'write_file',description:'write',risk:'write',schema:{type:'object'},execute:async()=>({output:'written'})})
 reg.add({name:'bash',description:'shell',risk:'shell',schema:{type:'object'},execute:async()=>({output:'ran'})})
 const meta=await store.create(root,'mock'); const agent=new Agent(provider('read_file',{}),reg,store,3)
 await agent.run({sessionId:meta.id,messages:[],cwd:root,instructions:'',prompt:'inspect',mode:'plan'})
 const loaded=await store.load(meta.id); const assistant=loaded.messages.filter(m=>m.role==='assistant').at(-1); assert.ok(assistant)
 assert.equal(String(assistant.content),'done')
})
