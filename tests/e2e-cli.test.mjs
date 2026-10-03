import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function runCli(cwd, env, input){
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[path.resolve('dist/index.js')],{cwd,env:{...process.env,...env},stdio:['pipe','pipe','pipe']})
    let out='',err=''; p.stdout.on('data',b=>out+=b); p.stderr.on('data',b=>err+=b); p.on('error',reject); p.on('close',code=>resolve({code,out,err})); p.stdin.write(input); p.stdin.end()
  })
}

test('CLI /provider without an argument shows provider state instead of being sent to the model', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-e2e-provider-list-'))
  const home=await mkdtemp(path.join(tmpdir(),'termagent-e2e-provider-home-'))
  try {
    const result=await runCli(root,{HOME:home,TERMAGENT_MODEL:'mock',TERMAGENT_BASE_URL:'http://127.0.0.1:9',TERMAGENT_API_KEY:'test',TERMAGENT_APPROVALS:'auto'},'/provider\n/quit\n')
    assert.equal(result.code,0,result.err)
    assert.match(result.out,/active: openai-compatible · mock/)
    assert.doesNotMatch(result.out,/System context exceeds|Provider HTTP|No model configured/)
  } finally {
    await rm(root,{recursive:true,force:true});await rm(home,{recursive:true,force:true})
  }
})

test('CLI works end-to-end against a local mock provider', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-e2e-')); let calls=0; let requests=[]
  const server=http.createServer((req,res)=>{
    calls++; let body=''; req.on('data',b=>body+=b); req.on('end',()=>requests.push(JSON.parse(body))); res.writeHead(200,{'content-type':'text/event-stream'})
    if(calls===1){
      res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'write_file',arguments:'{"path":"e2e.txt","content":"ok"}'}}]}}]})+'\n\n')
      res.write('data: '+JSON.stringify({choices:[{finish_reason:'tool_calls',delta:{}}]})+'\n\n')
    } else {
      res.write('data: '+JSON.stringify({choices:[{delta:{content:'Finished'}}]})+'\n\n')
      res.write('data: '+JSON.stringify({choices:[{finish_reason:'stop',delta:{}}]})+'\n\n')
    }
    res.end()
  })
  await new Promise(r=>server.listen(0,r)); const port=server.address().port
  const result=await runCli(root,{TERMAGENT_API_KEY:'test',TERMAGENT_BASE_URL:`http://127.0.0.1:${port}`,TERMAGENT_MODEL:'mock',TERMAGENT_APPROVALS:'auto'},'create e2e file\n/quit\n')
  assert.equal(result.code,0,result.err); console.log('STDERR', result.err); console.log('STDOUT', result.out); assert.match(result.out,/Finished/); assert.equal(await readFile(path.join(root,'e2e.txt'),'utf8'),'ok'); assert.equal(calls,2); assert.match(String(requests[0].body?.[0]?.content || requests[0].messages?.[0]?.content || ''),/Repository:/); assert.match(String(requests[0].body?.[0]?.content || requests[0].messages?.[0]?.content || ''),/e2e\.txt|package\.json|Repository:/)
  await new Promise(r=>server.close(r)); await rm(root,{recursive:true,force:true})
})

test('CLI undo/redo restores the agent filesystem turn', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-e2e-undo-'))
  const home=await mkdtemp(path.join(tmpdir(),'termagent-e2e-home-'))
  let calls=0
  const server=http.createServer((req,res)=>{
    calls++; let body=''; req.on('data',b=>body+=b); req.on('end',()=>{
      res.writeHead(200,{'content-type':'text/event-stream'})
      if(calls===1){
        res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'write_file',arguments:JSON.stringify({path:'undo-redo.txt',content:'restored'})}}]}}]})+'\n\n')
        res.write('data: '+JSON.stringify({choices:[{finish_reason:'tool_calls',delta:{}}]})+'\n\n')
      } else {
        res.write('data: '+JSON.stringify({choices:[{delta:{content:'Finished'}}]})+'\n\n')
        res.write('data: '+JSON.stringify({choices:[{finish_reason:'stop',delta:{}}]})+'\n\n')
      }
      res.end()
    })
  })
  await new Promise(r=>server.listen(0,r))
  try{
    const port=server.address().port
    const child=spawn(process.execPath,[path.resolve('dist/index.js')],{cwd:root,env:{...process.env,HOME:home,TERMAGENT_API_KEY:'test',TERMAGENT_BASE_URL:`http://127.0.0.1:${port}`,TERMAGENT_MODEL:'mock',TERMAGENT_APPROVALS:'auto'},stdio:['pipe','pipe','pipe']})
    let out='',err=''; let done=false
    const closed=new Promise(resolve=>child.on('close',code=>resolve(code)))
    child.stdout.on('data',chunk=>{
      out+=chunk
      if(!done && out.includes('Finished')){
        done=true
        child.stdin.write('/undo\n')
        child.stdin.write('/redo\n')
        child.stdin.write('/quit\n')
      }
    })
    child.stderr.on('data',chunk=>{err+=chunk})
    child.stdin.write('create undo redo file\n')
    const code=await closed
    assert.equal(code,0,err)
    assert.match(out,/undid turn/)
    assert.match(out,/redid turn/)
    assert.equal(await readFile(path.join(root,'undo-redo.txt'),'utf8'),'restored')
    assert.equal(calls,2)
  } finally {
    await new Promise(r=>server.close(r))
    await rm(root,{recursive:true,force:true})
    await rm(home,{recursive:true,force:true})
  }
})

test('CLI /auto enforces planning, edits, verification, and final completion', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-e2e-auto-'))
  const home=await mkdtemp(path.join(tmpdir(),'termagent-e2e-auto-home-'))
  await (await import('node:fs/promises')).writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node verify.js'}}))
  await (await import('node:fs/promises')).writeFile(path.join(root,'target.txt'),'before\n')
  await (await import('node:fs/promises')).writeFile(path.join(root,'verify.js'),'process.exit(0)\n')
  let calls=0; const requests=[]
  const server=http.createServer((req,res)=>{
    calls++; let body=''; req.on('data',b=>body+=b); req.on('end',()=>{
      requests.push(JSON.parse(body)); res.writeHead(200,{'content-type':'text/event-stream'})
      const response = calls===1
        ? {delta:{tool_calls:[{index:0,id:'todo1',function:{name:'todo',arguments:JSON.stringify({action:'set',items:[{id:'1',task:'edit target',status:'pending'}]})}}]}}
        : calls===2
        ? {delta:{tool_calls:[{index:0,id:'write1',function:{name:'write_file',arguments:JSON.stringify({path:'target.txt',content:'after\n'})}}]}}
        : calls===3
        ? {delta:{tool_calls:[{index:0,id:'verify1',function:{name:'verify_project',arguments:'{}'}}]}}
        : {delta:{content:'Implemented, verified, and completed.'}}
      res.write('data: '+JSON.stringify({choices:[response]})+'\n\n')
      res.write('data: '+JSON.stringify({choices:[{finish_reason:calls<4?'tool_calls':'stop',delta:{}}]})+'\n\n')
      res.end()
    })
  })
  await new Promise(r=>server.listen(0,r))
  try{
    const port=server.address().port
    const result=await runCli(root,{HOME:home,TERMAGENT_API_KEY:'test',TERMAGENT_BASE_URL:`http://127.0.0.1:${port}`,TERMAGENT_MODEL:'mock',TERMAGENT_APPROVALS:'auto',TERMAGENT_AUTONOMOUS_MAX_STEPS:'8'},'/auto edit target\n/quit\n')
    assert.equal(result.code,0,result.err)
    assert.match(result.out,/Implemented, verified, and completed\./)
    assert.equal(await readFile(path.join(root,'target.txt'),'utf8'),'after\n')
    assert.equal(calls,4)
    const firstSystem=String(requests[0].messages?.[0]?.content||'')
    assert.match(firstSystem,/AUTONOMOUS MODE/)
    assert.match(firstSystem,/planning/i)
  } finally { await new Promise(r=>server.close(r)); await rm(root,{recursive:true,force:true}); await rm(home,{recursive:true,force:true}) }
})

test('CLI /repomap renders structural context and stats without invoking a model', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'termagent-e2e-repomap-'))
  const home=await mkdtemp(path.join(tmpdir(),'termagent-e2e-repomap-home-'))
  try {
    await (await import('node:fs/promises')).mkdir(path.join(root,'src'),{recursive:true})
    await (await import('node:fs/promises')).writeFile(path.join(root,'src','main.ts'),'export function hello() { return "world" }\n')
    const result=await runCli(root,{HOME:home,TERMAGENT_API_KEY:'test',TERMAGENT_BASE_URL:'http://127.0.0.1:9',TERMAGENT_MODEL:'mock',TERMAGENT_APPROVALS:'auto'},'/repomap --stats\n/quit\n')
    assert.equal(result.code,0,result.err)
    assert.match(result.out,/Repository:/)
    assert.match(result.out,/Structural file map/)
    assert.match(result.out,/cache:/)
    assert.match(result.out,/symbols:/)
  } finally {
    await rm(root,{recursive:true,force:true});await rm(home,{recursive:true,force:true})
  }
})
