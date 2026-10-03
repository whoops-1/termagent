import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function request(base, method, pathname, body, headers={}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base)
    const payload = body == null ? '' : JSON.stringify(body)
    const req = http.request(u, {method, headers:{'content-type':'application/json', ...(payload ? {'content-length':Buffer.byteLength(payload)}:{}), ...headers}}, res => {
      let data=''; res.setEncoding('utf8'); res.on('data', c => data += c); res.on('end', () => resolve({status:res.statusCode,body:data,headers:res.headers}))
    })
    req.on('error', reject); if(payload) req.write(payload); req.end()
  })
}

function restoreEnv(old) {
  const mapping={HOME:'HOME',PROVIDER:'TERMAGENT_PROVIDER',BASE:'TERMAGENT_BASE_URL',KEY:'TERMAGENT_API_KEY',MODEL:'TERMAGENT_MODEL',APPROVALS:'TERMAGENT_APPROVALS'}
  for(const [key,name] of Object.entries(mapping)){const value=old[key];if(value===undefined)delete process.env[name];else process.env[name]=value}
}

test('public client consumes paged session/events/diff and model discovery endpoints', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-api-'))
  const home = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-api-home-'))
  let modelServer, server, runtime
  const old={HOME:process.env.HOME,PROVIDER:process.env.TERMAGENT_PROVIDER,BASE:process.env.TERMAGENT_BASE_URL,KEY:process.env.TERMAGENT_API_KEY,MODEL:process.env.TERMAGENT_MODEL,APPROVALS:process.env.TERMAGENT_APPROVALS}
  try {
    await mkdir(path.join(root,'.termagent'),{recursive:true})
    await writeFile(path.join(root,'.termagent','config.json'),JSON.stringify({approvals:'auto'}))
    modelServer=http.createServer((req,res)=>{let data='';req.on('data',c=>data+=c);req.on('end',()=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'ok'}}]})+'\n\n');res.write('data: '+JSON.stringify({choices:[{finish_reason:'stop',delta:{}}]})+'\n\n');res.end()})})
    await new Promise(resolve=>modelServer.listen(0,resolve))
    const modelPort=modelServer.address().port
    process.env.HOME=home; process.env.TERMAGENT_PROVIDER='openai-compatible'; process.env.TERMAGENT_BASE_URL=`http://127.0.0.1:${modelPort}`; process.env.TERMAGENT_API_KEY='test'; process.env.TERMAGENT_MODEL='mock'; process.env.TERMAGENT_APPROVALS='auto'
    const {createRuntime}=await import('../dist/server/runtime.js')
    const {startServer}=await import('../dist/server/http.js')
    runtime=await createRuntime(root)
    server=await startServer(runtime,{host:'127.0.0.1',port:0,token:'secret'})
    const base=`http://127.0.0.1:${server.address().port}`
    const {TermAgentClient, TermAgentError}=await import('../dist/client/client.js')
    const client=new TermAgentClient({baseUrl:base,token:'secret'})
    const session=await client.createSession()
    const result=await client.prompt(session.id,'hello')
    assert.match(result.text,/ok/)
    const messages=await client.getMessages(session.id,1)
    assert.equal(messages.offset,1)
    assert.ok(messages.total >= 2)
    const events=await client.getEvents(session.id,0)
    assert.ok(events.events.length >= 2)
    const stream = client.streamEvents(session.id, 0)
    const first = await stream.next()
    assert.equal(first.done, false)
    assert.equal(first.value.event, 'ready')
    await stream.return()
    const status=await client.getSessionStatus(session.id)
    assert.equal(status.running,false)
    const models=await client.listModels()
    assert.equal(models.active.model,'mock')
    const tools=await client.listTools()
    assert.ok(Array.isArray(tools.tools))
    await assert.rejects(() => client.undo('missing-session'), e => e instanceof TermAgentError && e.status === 500)
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve))
    if(runtime) await runtime.close()
    if(modelServer) await new Promise(resolve=>modelServer.close(resolve))
    restoreEnv(old)
    await rm(root,{recursive:true,force:true}); await rm(home,{recursive:true,force:true})
  }
})

test('prompt SSE emits text and completes cleanly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-sse-'))
  const home = await mkdtemp(path.join(os.tmpdir(),'termagent-phase4-sse-home-'))
  let modelServer, server, runtime
  const old={HOME:process.env.HOME,PROVIDER:process.env.TERMAGENT_PROVIDER,BASE:process.env.TERMAGENT_BASE_URL,KEY:process.env.TERMAGENT_API_KEY,MODEL:process.env.TERMAGENT_MODEL,APPROVALS:process.env.TERMAGENT_APPROVALS}
  try {
    await mkdir(path.join(root,'.termagent'),{recursive:true})
    await writeFile(path.join(root,'.termagent','config.json'),JSON.stringify({approvals:'auto'}))
    modelServer=http.createServer((req,res)=>{
      let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
        res.writeHead(200,{'content-type':'text/event-stream'})
        res.write('data: '+JSON.stringify({choices:[{delta:{content:'answer'}}]})+'\n\n')
        res.write('data: '+JSON.stringify({choices:[{finish_reason:'stop',delta:{}}]})+'\n\n')
        res.end()
      })
    })
    await new Promise(resolve=>modelServer.listen(0,resolve))
    const modelPort=modelServer.address().port
    process.env.HOME=home; process.env.TERMAGENT_PROVIDER='openai-compatible'; process.env.TERMAGENT_BASE_URL=`http://127.0.0.1:${modelPort}`; process.env.TERMAGENT_API_KEY='test'; process.env.TERMAGENT_MODEL='mock'; process.env.TERMAGENT_APPROVALS='auto'
    const {createRuntime}=await import('../dist/server/runtime.js')
    const {startServer}=await import('../dist/server/http.js')
    runtime=await createRuntime(root)
    server=await startServer(runtime,{host:'127.0.0.1',port:0,token:'secret'})
    const {TermAgentClient}=await import('../dist/client/client.js')
    const client=new TermAgentClient({baseUrl:`http://127.0.0.1:${server.address().port}`,token:'secret'})
    const session=await client.createSession()
    const seen=[]
    for await (const frame of client.streamPrompt(session.id,'hello')) {
      seen.push(frame.event)
      if(frame.event==='error') throw new Error(`prompt stream error: ${JSON.stringify(frame.data)}`)
      if(frame.event==='done')break
    }
    assert.deepEqual(seen,['text','done'])
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve))
    if(runtime) await runtime.close()
    if(modelServer) await new Promise(resolve=>modelServer.close(resolve))
    restoreEnv(old)
    await rm(root,{recursive:true,force:true}); await rm(home,{recursive:true,force:true})
  }
})
