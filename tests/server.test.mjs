import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

function request(base, method, pathname, body, headers={}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base)
    const payload = body == null ? '' : JSON.stringify(body)
    const req = http.request(u, { method, headers: {'content-type':'application/json', ...(payload ? {'content-length':Buffer.byteLength(payload)} : {}), ...headers} }, res => {
      let data=''
      res.setEncoding('utf8')
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, body:data}))
    })
    req.on('error', reject)
    if(payload) req.write(payload)
    req.end()
  })
}

async function sseRequest(base, pathname, body, headers={}) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathname, base)
    const payload = JSON.stringify(body)
    const req = http.request(u, {method:'POST', headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload),...headers}}, res => {
      let data=''
      res.setEncoding('utf8')
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({status:res.statusCode, headers:res.headers, body:data}))
    })
    req.on('error', reject)
    req.write(payload); req.end()
  })
}

test('HTTP API supports auth, sessions, prompts, SSE, tasks and discovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'termagent-server-'))
  const home = await mkdtemp(path.join(os.tmpdir(),'termagent-home-'))
  const old = {HOME:process.env.HOME, BASE:process.env.TERMAGENT_BASE_URL, KEY:process.env.TERMAGENT_API_KEY, MODEL:process.env.TERMAGENT_MODEL, APPROVALS:process.env.TERMAGENT_APPROVALS}
  let modelServer
  try {
    await mkdir(path.join(root,'.termagent'),{recursive:true})
    await writeFile(path.join(root,'.termagent','config.json'), JSON.stringify({maxToolRounds:4, approvals:'auto'}))
    modelServer = http.createServer((req,res) => {
      let data=''; req.on('data',c=>data+=c); req.on('end',()=>{
        res.writeHead(200,{'content-type':'text/event-stream'})
        res.write('data: '+JSON.stringify({choices:[{delta:{content:'hello from server'}}]})+'\n\n')
        res.write('data: '+JSON.stringify({choices:[{finish_reason:'stop',delta:{}}]})+'\n\n')
        res.end()
      })
    })
    await new Promise(resolve => modelServer.listen(0, resolve))
    const modelPort=modelServer.address().port
    process.env.HOME=home
    process.env.TERMAGENT_BASE_URL=`http://127.0.0.1:${modelPort}`
    process.env.TERMAGENT_API_KEY='test'
    process.env.TERMAGENT_MODEL='mock'
    process.env.TERMAGENT_APPROVALS='auto'

    const {createRuntime}=await import('../dist/server/runtime.js')
    const {startServer}=await import('../dist/server/http.js')
    const runtime=await createRuntime(root)
    const server=await startServer(runtime,{host:'127.0.0.1',port:0,token:'secret'})
    const port=server.address().port
    const base=`http://127.0.0.1:${port}`

    let r=await request(base,'GET','/health')
    assert.equal(r.status,401)
    r=await request(base,'GET','/health',null,{authorization:'Bearer secret'})
    assert.equal(r.status,200); assert.match(r.body,/"ok":true/)

    r=await request(base,'GET','/api/v1/info',null,{authorization:'Bearer secret'})
    assert.equal(r.status,200); assert.match(r.body,/"name":"termagent"/)

    r=await request(base,'POST','/api/v1/sessions',{}, {authorization:'Bearer secret'})
    assert.equal(r.status,201)
    const session=JSON.parse(r.body)
    assert.equal(session.cwd,root)

    r=await request(base,'POST',`/api/v1/sessions/${session.id}/prompt`,{prompt:'say hello',stream:false},{authorization:'Bearer secret'})
    assert.equal(r.status,200); assert.match(r.body,/hello from server/)

    r=await sseRequest(base,`/api/v1/sessions/${session.id}/prompt`,{prompt:'stream hello',stream:true},{authorization:'Bearer secret'})
    assert.equal(r.status,200); assert.equal(r.headers['content-type'],'text/event-stream; charset=utf-8'); assert.match(r.body,/event: text/); assert.match(r.body,/event: done/)

    r=await request(base,'GET','/api/v1/sessions',null,{authorization:'Bearer secret'})
    assert.equal(r.status,200); assert.match(r.body, new RegExp(session.id))

    r=await request(base,'GET',`/api/v1/sessions/${session.id}`,null,{authorization:'Bearer secret'})
    assert.equal(r.status,200); assert.match(r.body,/hello from server/)

    r=await request(base,'POST',`/api/v1/sessions/${session.id}/checkpoint`,{label:'server checkpoint'},{authorization:'Bearer secret'})
    assert.equal(r.status,201)
    const checkpoint=JSON.parse(r.body)
    assert.equal(checkpoint.label,'server checkpoint')
    assert.match(checkpoint.id,/^[0-9a-f]+$/)

    r=await request(base,'GET',`/api/v1/sessions/${session.id}/checkpoints`,null,{authorization:'Bearer secret'})
    assert.equal(r.status,200)
    const checkpointList=JSON.parse(r.body).checkpoints
    assert.equal(checkpointList.length,1)
    assert.equal(checkpointList[0].id,checkpoint.id)

    r=await request(base,'POST',`/api/v1/sessions/${session.id}/checkpoints/${checkpoint.id}/branch`,{restoreWorkspace:false},{authorization:'Bearer secret'})
    assert.equal(r.status,201)
    const branch=JSON.parse(r.body)
    assert.equal(branch.parentId,session.id)
    assert.equal(branch.parentCheckpointId,checkpoint.id)

    r=await request(base,'POST',`/api/v1/sessions/${session.id}/checkpoints/${checkpoint.id}/restore`,{}, {authorization:'Bearer secret'})
    assert.equal(r.status,200)
    const restored=JSON.parse(r.body)
    assert.equal(restored.checkpoint.id,checkpoint.id)

    r=await request(base,'GET','/api/v1/tasks',null,{authorization:'Bearer secret'})
    assert.equal(r.status,200); assert.match(r.body,/tasks/)

    r=await request(base,'GET','/api/v1/agents',null,{authorization:'Bearer secret'})
    assert.equal(r.status,200); assert.match(r.body,/build/)

    r=await request(base,'GET','/api/v1/skills',null,{authorization:'Bearer secret'})
    assert.equal(r.status,200); assert.match(r.body,/skills/)

    await new Promise(resolve=>server.close(resolve))
    await runtime.close()
  } finally {
    if(modelServer) await new Promise(resolve=>modelServer.close(resolve))
    for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k]; else if(k==='HOME')process.env.HOME=v; else if(k==='BASE')process.env.TERMAGENT_BASE_URL=v; else if(k==='KEY')process.env.TERMAGENT_API_KEY=v; else if(k==='MODEL')process.env.TERMAGENT_MODEL=v; else if(k==='APPROVALS')process.env.TERMAGENT_APPROVALS=v}
    await rm(root,{recursive:true,force:true}); await rm(home,{recursive:true,force:true})
  }
})
