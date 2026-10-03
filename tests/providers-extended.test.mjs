import test from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicProvider } from '../dist/providers/anthropic.js'
import { GeminiProvider } from '../dist/providers/gemini.js'

test('Anthropic adapter translates assistant tool calls and tool results', async()=>{
  const old=global.fetch
  global.fetch=async(_u,opts)=>{
    const body=JSON.parse(opts.body)
    assert.equal(body.messages[0].role,'assistant')
    assert.equal(body.messages[0].content[0].type,'tool_use')
    assert.equal(body.messages[1].content[0].type,'tool_result')
    const payload='data: '+JSON.stringify({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'inspect tools'}})+'\n\n'+'data: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:' and reason'}})+'\n\n'+'data: '+JSON.stringify({type:'content_block_delta',index:1,delta:{type:'text_delta',text:'ok'}})+'\n\n'+'data: '+JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn'}})+'\n\n'
    return new Response(payload,{status:200,headers:{'content-type':'text/event-stream'}})
  }
  try{
    const p=new AnthropicProvider({model:'x',baseUrl:'https://api.anthropic.com/v1',apiKey:'k'})
    const events=[];for await(const e of p.stream([{role:'assistant',content:null,tool_calls:[{id:'t1',type:'function',function:{name:'read_file',arguments:'{"path":"a"}'}}]},{role:'tool',tool_call_id:'t1',name:'read_file',content:'hello'}],[],new AbortController().signal))events.push(e)
    assert.equal(events.filter(x=>x.type==='reasoning').map(x=>x.delta).join(''),'inspect tools and reason');assert.equal(events.find(x=>x.type==='text').delta,'ok');assert.equal(events.at(-1).finishReason,'end_turn')
  }finally{global.fetch=old}
})

test('Gemini adapter emits text and function calls', async()=>{
  const old=global.fetch
  global.fetch=async(_u,opts)=>{
    const body=JSON.parse(opts.body);assert.equal(body.contents[0].role,'model');assert.equal(body.contents[1].role,'user')
    const payload='data: '+JSON.stringify({candidates:[{content:{parts:[{text:'think',thought:true},{text:'hi'},{functionCall:{name:'read_file',args:{path:'a'}}}]}}]})+'\n\n'
    return new Response(payload,{status:200,headers:{'content-type':'text/event-stream'}})
  }
  try{
    const p=new GeminiProvider({model:'gemini-test',baseUrl:'https://generativelanguage.googleapis.com',apiKey:'k'})
    const events=[];for await(const e of p.stream([{role:'assistant',content:'previous'},{role:'user',content:'go'}],[],new AbortController().signal))events.push(e)
    assert.equal(events[0].type,'reasoning');assert.equal(events[0].delta,'think');assert.equal(events.find(x=>x.type==='text').delta,'hi');assert.equal(events.find(x=>x.type==='tool_call').call.function.name,'read_file')
  }finally{global.fetch=old}
})
