import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { OpenAICompatibleProvider } from '../dist/providers/openai-compatible.js'

test('OpenAI-compatible SSE parser handles text and tool calls', async()=>{
  const server=http.createServer((req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'})
    const lines=[
      'data: '+JSON.stringify({choices:[{delta:{reasoning_content:'inspect the repo'}}]}),
      'data: '+JSON.stringify({choices:[{delta:{content:'hello '}}]}),
      'data: '+JSON.stringify({choices:[{delta:{content:'world'}}]}),
      'data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'read_file',arguments:'{"path":"a'}}]}}]}),
      'data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'.txt"}'}}]}}]}),
      'data: '+JSON.stringify({choices:[{finish_reason:'tool_calls',delta:{}}]}),
      'data: [DONE]'
    ]
    for(const x of lines) res.write(x+'\n\n'); res.end()
  })
  await new Promise(r=>server.listen(0,r)); const port=server.address().port
  const p=new OpenAICompatibleProvider({baseUrl:`http://127.0.0.1:${port}`,apiKey:'x',model:'m'})
  const events=[]; for await(const e of p.stream([{role:'user',content:'x'}],[],new AbortController().signal)) events.push(e)
  assert.equal(events.filter(x=>x.type==='reasoning').map(x=>x.delta).join(''),'inspect the repo')
  assert.equal(events.filter(x=>x.type==='text').map(x=>x.delta).join(''),'hello world')
  const call=events.find(x=>x.type==='tool_call'); assert.equal(call.call.function.name,'read_file'); assert.equal(call.call.function.arguments,'{"path":"a.txt"}')
  await new Promise(r=>server.close(r))
})
