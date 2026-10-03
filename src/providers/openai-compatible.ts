import type { ChatMessage, ToolCall } from '../session/store.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Provider, ProviderConfig, StreamEvent } from './types.js'
import { sseLines } from './sse.js'
import { ProviderHttpError, responseHeaders } from './errors.js'

export type { Provider, StreamEvent }

export class OpenAICompatibleProvider implements Provider {
  readonly id='openai-compatible'; readonly model:string; readonly config:ProviderConfig
  constructor(private cfg:ProviderConfig){this.model=cfg.model;this.config=cfg}
  async *stream(messages:ChatMessage[],tools:ReturnType<ToolRegistry['schemas']>,signal:AbortSignal):AsyncGenerator<StreamEvent>{
    if(!this.cfg.model) throw new Error('No model configured. Set TERMAGENT_MODEL.')
    const headers:any={'content-type':'application/json'}; if(this.cfg.apiKey) headers.authorization=`Bearer ${this.cfg.apiKey}`
    const url=this.cfg.baseUrl.replace(/\/$/,'')+'/chat/completions'
    const body:any={model:this.cfg.model,messages,stream:true,temperature:this.cfg.temperature??0.2,tools}; if(this.cfg.reasoningEffort) body.reasoning_effort=this.cfg.reasoningEffort; if(this.cfg.extra&&typeof this.cfg.extra==='object') Object.assign(body,this.cfg.extra)
    if(this.cfg.maxTokens) body.max_tokens=this.cfg.maxTokens
    const res=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal})
    if(!res.ok){const body=await res.text();throw new ProviderHttpError(res.status,body,responseHeaders(res))}
    if(!res.body) throw new Error('Provider returned no stream')
    const calls=new Map<number,{id:string;name:string;args:string}>()
    for await(const payload of sseLines(res.body,signal,{idleTimeoutMs:this.cfg.streamIdleTimeoutMs??90000})){
      if(!payload)continue; if(payload==='[DONE]'){yield* flush(calls);yield {type:'done',finishReason:'stop'};return}
      let json:any; try{json=JSON.parse(payload)}catch{continue}; const choice=json.choices?.[0]; const delta=choice?.delta
      const reasoning = extractReasoning(delta)
      if(reasoning)yield {type:'reasoning',delta:reasoning}
      const content = extractText(delta?.content)
      if(content)yield {type:'text',delta:content}
      for(const tc of delta?.tool_calls||[]){const idx=tc.index??0;const cur=calls.get(idx)||{id:tc.id||`call_${idx}`,name:'',args:''};if(tc.id)cur.id=tc.id;if(tc.function?.name)cur.name=tc.function.name;if(tc.function?.arguments)cur.args+=tc.function.arguments;calls.set(idx,cur)}
      if(choice?.finish_reason==='tool_calls'){yield* flush(calls);calls.clear();yield {type:'done',finishReason:'tool_calls'}}
      else if(choice?.finish_reason){yield* flush(calls);calls.clear();yield {type:'done',finishReason:choice.finish_reason}}
    }
  }
}
function* flush(calls:Map<number,{id:string;name:string;args:string}>):Generator<StreamEvent>{for(const c of calls.values())yield {type:'tool_call',call:{id:c.id,type:'function',function:{name:c.name,arguments:c.args}}}}

function extractReasoning(delta:any): string {
  if(!delta)return ''
  const direct = delta.reasoning_content ?? delta.reasoning ?? delta.thinking
  if(typeof direct === 'string') return direct
  if(Array.isArray(delta.content)) {
    return delta.content.filter((x:any)=>x && (x.type==='reasoning' || x.type==='thinking' || x.type==='output_thinking')).map((x:any)=>typeof x.text==='string'?x.text:typeof x.reasoning==='string'?x.reasoning:'').join('')
  }
  return ''
}

function extractText(content:any): string {
  if(typeof content==='string') return content
  if(!Array.isArray(content)) return ''
  return content.filter((x:any)=>!x || x.type==='text' || x.type==='output_text').map((x:any)=>typeof x==='string'?x:(typeof x?.text==='string'?x.text:'' )).join('')
}
