import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ToolRegistry } from '../dist/tools/registry.js'
import { PermissionGate } from '../dist/tools/permissions.js'
import { loadPlugins } from '../dist/plugins/loader.js'
import { connectMCP } from '../dist/mcp/client.js'

test('local plugin can register a tool', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'termagent-plugin-'))
  try{
    await writeFile(path.join(dir,'hello.mjs'),`export default async ({registerTool}) => registerTool({name:'hello',risk:'read',description:'hello',schema:{type:'object',properties:{}},execute:async()=>({output:'hello'})})`)
    const reg=new ToolRegistry(new PermissionGate('auto'));await loadPlugins(dir,reg,[dir])
    const result=await reg.execute('hello',{}, {sessionID:'x',agent:'build',cwd:dir,abort:new AbortController().signal});assert.equal(result.output,'hello')
  }finally{await rm(dir,{recursive:true,force:true})}
})

test('MCP stdio server exposes tools', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'termagent-mcp-'))
  try{
    const server=path.join(dir,'server.mjs')
    await writeFile(server,`import readline from 'node:readline'; readline.createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);if(r.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:'2025-06-18',capabilities:{},serverInfo:{name:'test',version:'1'}}})+'\\n');else if(r.method==='tools/list')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{tools:[{name:'hello',description:'hello',inputSchema:{type:'object',properties:{}}}]}})+'\\n');else if(r.method==='tools/call')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:'mcp-ok'}]}})+'\\n')})`)
    const {clients,tools}=await connectMCP({test:{command:process.execPath,args:[server]}},dir);assert.equal(tools.length,1);const out=await tools[0].execute({}, {sessionID:'x',agent:'build',cwd:dir,abort:new AbortController().signal});assert.equal(out.output,'mcp-ok');await clients[0].close()
  }finally{await rm(dir,{recursive:true,force:true})}
})
