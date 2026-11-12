import type { ChatMessage } from '../session/store.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Provider, ProviderConfig, ProviderTokenCount, ProviderUsage, StreamEvent } from './types.js'
import { sseLines } from './sse.js'
import { ProviderHttpError, responseHeaders } from './errors.js'

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic'
  readonly model: string
  readonly config: ProviderConfig
  private tokenCountingUnavailable = false

  constructor(private cfg: ProviderConfig) {
    this.model = cfg.model
    this.config = cfg
  }

  async countTokens(messages: ChatMessage[], tools: ReturnType<ToolRegistry['schemas']>, signal: AbortSignal): Promise<ProviderTokenCount | undefined> {
    if (!this.cfg.apiKey || this.tokenCountingUnavailable || signal.aborted) return undefined
    const generated = buildAnthropicRequest(this.cfg, messages, tools)
    const countFields = ['model', 'messages', 'system', 'tools', 'thinking', 'tool_choice', 'output_config', 'cache_control', 'speed']
    const body = Object.fromEntries(countFields.filter(key => generated[key] !== undefined).map(key => [key, generated[key]]))

    let response: Response
    try {
      response = await fetch(this.cfg.baseUrl.replace(/\/$/, '') + '/messages/count_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      return undefined
    }

    if (!response.ok) {
      const responseBody = await response.text()
      if (response.status === 401 || response.status === 403) throw new ProviderHttpError(response.status, responseBody, responseHeaders(response))
      if ([404, 405, 501].includes(response.status)) this.tokenCountingUnavailable = true
      return undefined
    }

    try {
      const result = await response.json() as { input_tokens?: unknown }
      if (typeof result.input_tokens !== 'number' || !Number.isFinite(result.input_tokens) || result.input_tokens < 0) return undefined
      return { inputTokens: Math.floor(result.input_tokens), source: 'anthropic-count-tokens' }
    } catch {
      return undefined
    }
  }

  async *stream(messages:ChatMessage[],tools:ReturnType<ToolRegistry['schemas']>,signal:AbortSignal):AsyncGenerator<StreamEvent>{
    if(!this.cfg.apiKey)throw new Error('No Anthropic API key configured.')
    const body:any = {
      ...buildAnthropicRequest(this.cfg, messages, tools),
      max_tokens: this.cfg.maxOutputTokens || this.cfg.maxTokens || 4096,
      stream: true,
    }
    const res=await fetch(this.cfg.baseUrl.replace(/\/$/,'')+'/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':this.cfg.apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify(body),signal})
    if(!res.ok){const body=await res.text();throw new ProviderHttpError(res.status,body,responseHeaders(res))}; if(!res.body)throw new Error('Anthropic returned no stream')
    const calls=new Map<number,{id:string;name:string;args:string}>(); let block=-1; let usageRaw:Record<string,unknown>|undefined
    for await(const payload of sseLines(res.body,signal,{idleTimeoutMs:this.cfg.streamIdleTimeoutMs??90000})){if(!payload)continue;let e:any;try{e=JSON.parse(payload)}catch{continue}
      if(e.type==='message_start' && isRecord(e.message?.usage)) usageRaw=mergeAnthropicUsageRaw(usageRaw,e.message.usage)
      if(e.type==='content_block_start'){block=e.index??block;if(e.content_block?.type==='tool_use')calls.set(block,{id:e.content_block.id,name:e.content_block.name,args:''});if(e.content_block?.type==='thinking'&&e.content_block.thinking)yield {type:'reasoning',delta:e.content_block.thinking}}
      else if(e.type==='content_block_delta'){if(e.delta?.type==='text_delta'&&e.delta.text)yield {type:'text',delta:e.delta.text};if(e.delta?.type==='thinking_delta'&&e.delta.thinking)yield {type:'reasoning',delta:e.delta.thinking};if(e.delta?.type==='input_json_delta'&&calls.has(e.index)){calls.get(e.index)!.args+=e.delta.partial_json||''}}
      else if(e.type==='message_delta'){
        if(isRecord(e.usage)) usageRaw=mergeAnthropicUsageRaw(usageRaw,e.usage)
        if(e.delta?.stop_reason){
          for(const c of calls.values())yield {type:'tool_call',call:{id:c.id,type:'function',function:{name:c.name,arguments:c.args}}}
          calls.clear()
          const usage=normalizeAnthropicUsage(usageRaw)
          if(usage) yield {type:'usage',usage}
          yield {type:'done',finishReason:e.delta.stop_reason}
        }
      }
    }
  }
}

function buildAnthropicRequest(cfg: ProviderConfig, messages: ChatMessage[], tools: ReturnType<ToolRegistry['schemas']>): Record<string, any> {
  const system = messages.find(message => message.role === 'system')?.content || ''
  const input = messages.filter(message => message.role !== 'system').map(message => {
    if (message.role === 'user') return { role: 'user', content: message.content || '' }
    if (message.role === 'assistant') {
      const content: any[] = []
      if (message.content) content.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls || []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: safeJson(call.function.arguments) })
      return { role: 'assistant', content: content.length ? content : '' }
    }
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id || '', content: message.content || '' }] }
  })
  const anthropicTools = tools.map((tool: any) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }))
  const body: Record<string, any> = { model: cfg.model, messages: input }
  if (system) body.system = system
  if (anthropicTools.length) body.tools = anthropicTools
  if (cfg.reasoningEffort) {
    body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, cfg.reasoningEffort === 'low' ? 1024 : cfg.reasoningEffort === 'medium' ? 4096 : cfg.reasoningEffort === 'high' ? 8192 : 16384) }
  }
  if (cfg.extra && typeof cfg.extra === 'object') Object.assign(body, cfg.extra)
  return body
}

function safeJson(s:string){try{return JSON.parse(s||'{}')}catch{return {}}}


/**
 * Anthropic repeats request usage in message_start and message_delta. The final
 * delta is authoritative, but some gateways omit unchanged fields; deep-merging
 * snapshots preserves those values without adding the same request twice.
 */
function mergeAnthropicUsageRaw(previous:Record<string,unknown>|undefined,next:Record<string,unknown>):Record<string,unknown>{
  if(!previous)return {...next}
  const merged:Record<string,unknown>={...previous}
  for(const [key,value] of Object.entries(next)){
    if(isRecord(value)&&isRecord(merged[key])) merged[key]={...(merged[key] as Record<string,unknown>),...value}
    else if(value!==undefined) merged[key]=value
  }
  return merged
}

function normalizeAnthropicUsage(raw:Record<string,unknown>|undefined):ProviderUsage|undefined{
  if(!raw)return undefined
  const number=(value:unknown):number|undefined=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.floor(value):undefined
  const records=Array.isArray(raw.iterations)&&raw.iterations.length
    ? raw.iterations.filter(isRecord)
    : [raw]
  if(!records.length)return undefined
  const counters=['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens']
  const hasCounters=records.some(item=>counters.some(key=>number(item[key])!==undefined)||number(isRecord(item.output_tokens_details)?item.output_tokens_details.thinking_tokens:undefined)!==undefined)
  if(!hasCounters)return undefined
  const sum=(key:string,detail?:string):number|undefined=>{
    const values=records.map(item=>detail&&isRecord(item[detail])?number((item[detail] as Record<string,unknown>)[key]):number(item[key])).filter((n):n is number=>n!==undefined)
    return values.length?values.reduce((total,value)=>total+value,0):undefined
  }
  const nonCachedInputTokens=sum('input_tokens')??0
  const cacheReadTokens=sum('cache_read_input_tokens')
  const cacheWriteTokens=sum('cache_creation_input_tokens')
  const outputTokens=sum('output_tokens')??0
  const reasoningTokens=sum('thinking_tokens','output_tokens_details')
  const last=records[records.length-1]
  const contextInput=number(last.input_tokens)
  const contextRead=number(last.cache_read_input_tokens)
  const contextWrite=number(last.cache_creation_input_tokens)
  const hasContextCounters=contextInput!==undefined||contextRead!==undefined||contextWrite!==undefined
  const inclusiveInput=nonCachedInputTokens+(cacheReadTokens??0)+(cacheWriteTokens??0)
  const providerTotal=number(raw.total_tokens)
  return {
    inputTokens:nonCachedInputTokens,
    outputTokens,
    totalTokens:providerTotal??inclusiveInput+outputTokens,
    ...(hasContextCounters?{contextTokens:(contextInput??0)+(contextRead??0)+(contextWrite??0)}:{}),
    ...(cacheReadTokens===undefined?{}:{cacheReadTokens}),
    ...(cacheWriteTokens===undefined?{}:{cacheWriteTokens}),
    ...(reasoningTokens===undefined?{}:{reasoningTokens}),
    cacheTokensExcludedFromInput:true,
  }
}

function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value)}
