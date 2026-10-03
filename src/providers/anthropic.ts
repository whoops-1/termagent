import type { ChatMessage } from '../session/store.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Provider, ProviderConfig, StreamEvent } from './types.js'
import { sseLines } from './sse.js'
import { ProviderHttpError, responseHeaders } from './errors.js'

export class AnthropicProvider implements Provider {
  readonly id='anthropic'; readonly model:string; readonly config:ProviderConfig
  constructor(private cfg:ProviderConfig){this.model=cfg.model;this.config=cfg}
  async *stream(messages:ChatMessage[],tools:ReturnType<ToolRegistry['schemas']>,signal:AbortSignal):AsyncGenerator<StreamEvent>{
    if(!this.cfg.apiKey)throw new Error('No Anthropic API key configured.')
    const system=messages.find(m=>m.role==='system')?.content||''
    const input:any[]=messages.filter(m=>m.role!=='system').map(m=>{
      if(m.role==='user') return {role:'user',content:m.content||''}
      if(m.role==='assistant') {
        const content:any[]=[]
        if(m.content) content.push({type:'text',text:m.content})
        for(const tc of m.tool_calls||[]) content.push({type:'tool_use',id:tc.id,name:tc.function.name,input:safeJson(tc.function.arguments)})
        return {role:'assistant',content:content.length?content:''}
      }
      return {role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id||'',content:m.content||''}]}
    })
    const atools=tools.map((x:any)=>({name:x.function.name,description:x.function.description,input_schema:x.function.parameters}))
    const body:any={model:this.cfg.model,max_tokens:this.cfg.maxTokens||4096,stream:true,messages:input,tools:atools}; if(system)body.system=system
    if(this.cfg.reasoningEffort) body.thinking={type:'enabled',budget_tokens:Math.max(1024,this.cfg.reasoningEffort==='low'?1024:this.cfg.reasoningEffort==='medium'?4096:this.cfg.reasoningEffort==='high'?8192:16384)}
    if(this.cfg.extra&&typeof this.cfg.extra==='object') Object.assign(body,this.cfg.extra)
    const res=await fetch(this.cfg.baseUrl.replace(/\/$/,'')+'/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':this.cfg.apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify(body),signal})
    if(!res.ok){const body=await res.text();throw new ProviderHttpError(res.status,body,responseHeaders(res))}; if(!res.body)throw new Error('Anthropic returned no stream')
    const calls=new Map<number,{id:string;name:string;args:string}>(); let block=-1
    for await(const payload of sseLines(res.body,signal,{idleTimeoutMs:this.cfg.streamIdleTimeoutMs??90000})){if(!payload)continue;let e:any;try{e=JSON.parse(payload)}catch{continue}
      if(e.type==='content_block_start'){block=e.index??block;if(e.content_block?.type==='tool_use')calls.set(block,{id:e.content_block.id,name:e.content_block.name,args:''});if(e.content_block?.type==='thinking'&&e.content_block.thinking)yield {type:'reasoning',delta:e.content_block.thinking}}
      else if(e.type==='content_block_delta'){if(e.delta?.type==='text_delta'&&e.delta.text)yield {type:'text',delta:e.delta.text};if(e.delta?.type==='thinking_delta'&&e.delta.thinking)yield {type:'reasoning',delta:e.delta.thinking};if(e.delta?.type==='input_json_delta'&&calls.has(e.index)){calls.get(e.index)!.args+=e.delta.partial_json||''}}
      else if(e.type==='message_delta'&&e.delta?.stop_reason){for(const c of calls.values())yield {type:'tool_call',call:{id:c.id,type:'function',function:{name:c.name,arguments:c.args}}};calls.clear();yield {type:'done',finishReason:e.delta.stop_reason}}
    }
  }
}

function safeJson(s:string){try{return JSON.parse(s||'{}')}catch{return {}}}
