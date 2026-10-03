import type { ChatMessage } from '../session/store.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Provider, ProviderConfig, StreamEvent } from './types.js'
import { ProviderHttpError, responseHeaders } from './errors.js'

export class GeminiProvider implements Provider {
  readonly id='gemini'; readonly model:string; readonly config:ProviderConfig
  constructor(private cfg:ProviderConfig){this.model=cfg.model;this.config=cfg}
  async *stream(messages:ChatMessage[],tools:ReturnType<ToolRegistry['schemas']>,signal:AbortSignal):AsyncGenerator<StreamEvent>{
    if(!this.cfg.apiKey)throw new Error('No Gemini API key configured.')
    const contents:any[]=[]
    for(const m of messages.filter(m=>m.role!=='system')){
      if(m.role==='assistant'){
        const parts:any[]=[];if(m.content)parts.push({text:m.content});for(const tc of m.tool_calls||[])parts.push({functionCall:{name:tc.function.name,args:safeJson(tc.function.arguments)}});contents.push({role:'model',parts})
      } else if(m.role==='tool'){
        const name=messages.find(x=>x.role==='assistant'&&x.tool_calls?.some(tc=>tc.id===m.tool_call_id))?.tool_calls?.find(tc=>tc.id===m.tool_call_id)?.function.name||m.name||'tool';contents.push({role:'user',parts:[{functionResponse:{name,response:{output:m.content||''}}}]})
      } else contents.push({role:'user',parts:[{text:m.content||''}]})
    }
    const system=messages.find(m=>m.role==='system')?.content
    const generationConfig:any={temperature:this.cfg.temperature??0.2};if(this.cfg.maxTokens)generationConfig.maxOutputTokens=this.cfg.maxTokens;if(this.cfg.reasoningEffort)generationConfig.thinkingConfig={thinkingBudget:this.cfg.reasoningEffort==='low'?1024:this.cfg.reasoningEffort==='medium'?4096:this.cfg.reasoningEffort==='high'?8192:16384};const body:any={contents,generationConfig};if(system)body.systemInstruction={parts:[{text:system}]};if(this.cfg.extra&&typeof this.cfg.extra==='object')Object.assign(body,this.cfg.extra)
    const fns=tools.map((x:any)=>({name:x.function.name,description:x.function.description,parameters:x.function.parameters}));if(fns.length)body.tools=[{functionDeclarations:fns}]
    const url=`${this.cfg.baseUrl.replace(/\/$/,'')}/v1beta/models/${encodeURIComponent(this.cfg.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.cfg.apiKey)}`
    const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});if(!res.ok){const body=await res.text();throw new ProviderHttpError(res.status,body,responseHeaders(res))};if(!res.body)throw new Error('Gemini returned no stream')
    const {sseLines}=await import('./sse.js');for await(const payload of sseLines(res.body,signal,{idleTimeoutMs:this.cfg.streamIdleTimeoutMs??90000})){if(!payload)continue;let j:any;try{j=JSON.parse(payload)}catch{continue};for(const p of j.candidates?.[0]?.content?.parts||[]){if(p.text&&p.thought)yield {type:'reasoning',delta:p.text};else if(p.text)yield {type:'text',delta:p.text};if(p.functionCall){yield {type:'tool_call',call:{id:`gemini_${Date.now()}`,type:'function',function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})}}}}}if(j.candidates?.[0]?.finishReason)yield {type:'done',finishReason:j.candidates[0].finishReason}}
  }
}

function safeJson(s:string){try{return JSON.parse(s||'{}')}catch{return {}}}
