import type { ChatMessage } from '../session/store.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { Provider, ProviderConfig, ProviderTokenCount, StreamEvent } from './types.js'
import { ProviderHttpError, responseHeaders } from './errors.js'

export class GeminiProvider implements Provider {
  readonly id = 'gemini'
  readonly model: string
  readonly config: ProviderConfig
  private tokenCountingUnavailable = false

  constructor(private cfg: ProviderConfig) {
    this.model = cfg.model
    this.config = cfg
  }

  async countTokens(messages: ChatMessage[], tools: ReturnType<ToolRegistry['schemas']>, signal: AbortSignal): Promise<ProviderTokenCount | undefined> {
    if (!this.cfg.apiKey || this.tokenCountingUnavailable || signal.aborted) return undefined
    const generated = buildGeminiRequest(this.cfg, messages, tools)
    const countBody: Record<string, unknown> = {}
    for (const key of ['contents', 'systemInstruction', 'tools', 'cachedContent']) {
      if (generated[key] !== undefined) countBody[key] = generated[key]
    }

    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(this.cfg.model)}:countTokens`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.apiKey },
        body: JSON.stringify(countBody),
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
      const result = await response.json() as { totalTokens?: unknown; total_tokens?: unknown }
      const count = usageNumber(result.totalTokens ?? result.total_tokens)
      return count === undefined ? undefined : { inputTokens: count, source: 'gemini-count-tokens' }
    } catch {
      return undefined
    }
  }

  async *stream(messages:ChatMessage[],tools:ReturnType<ToolRegistry['schemas']>,signal:AbortSignal):AsyncGenerator<StreamEvent>{
    if(!this.cfg.apiKey)throw new Error('No Gemini API key configured.')
    const body = buildGeminiRequest(this.cfg, messages, tools)
    const url=`${this.cfg.baseUrl.replace(/\/$/,'')}/v1beta/models/${encodeURIComponent(this.cfg.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.cfg.apiKey)}`
    const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});if(!res.ok){const body=await res.text();throw new ProviderHttpError(res.status,body,responseHeaders(res))};if(!res.body)throw new Error('Gemini returned no stream')
    const {sseLines}=await import('./sse.js');for await(const payload of sseLines(res.body,signal,{idleTimeoutMs:this.cfg.streamIdleTimeoutMs??90000})){if(!payload)continue;let j:any;try{j=JSON.parse(payload)}catch{continue};const u=j.usageMetadata;if(u){
      const promptTokens=usageNumber(u.promptTokenCount)||0
      const reportedToolUsePromptTokens=usageNumber(u.toolUsePromptTokenCount)
      const toolUsePromptTokens=reportedToolUsePromptTokens??0
      const candidatesTokens=usageNumber(u.candidatesTokenCount)||0
      const reasoningTokens=usageNumber(u.thoughtsTokenCount)||0
      const modalityTokens=normalizeGeminiModalityUsage(u)
      yield {type:'usage',usage:{inputTokens:promptTokens+toolUsePromptTokens,contextTokens:promptTokens+toolUsePromptTokens,outputTokens:candidatesTokens+reasoningTokens,totalTokens:usageNumber(u.totalTokenCount)??promptTokens+toolUsePromptTokens+candidatesTokens+reasoningTokens,cacheReadTokens:usageNumber(u.cachedContentTokenCount),reasoningTokens,...(reportedToolUsePromptTokens===undefined?{}:{toolUsePromptTokens:reportedToolUsePromptTokens}),...(modalityTokens?{modalityTokens}:{})}}
    };for(const p of j.candidates?.[0]?.content?.parts||[]){if(p.text&&p.thought)yield {type:'reasoning',delta:p.text};else if(p.text)yield {type:'text',delta:p.text};if(p.functionCall){yield {type:'tool_call',call:{id:`gemini_${Date.now()}`,type:'function',function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})}}}}}if(j.candidates?.[0]?.finishReason)yield {type:'done',finishReason:j.candidates[0].finishReason}}
  }
}

function buildGeminiRequest(cfg: ProviderConfig, messages: ChatMessage[], tools: ReturnType<ToolRegistry['schemas']>): Record<string, any> {
  const contents: any[] = []
  for (const message of messages.filter(item => item.role !== 'system')) {
    if (message.role === 'assistant') {
      const parts: any[] = []
      if (message.content) parts.push({ text: message.content })
      for (const call of message.tool_calls || []) parts.push({ functionCall: { name: call.function.name, args: safeJson(call.function.arguments) } })
      contents.push({ role: 'model', parts })
    } else if (message.role === 'tool') {
      const call = messages.find(item => item.role === 'assistant' && item.tool_calls?.some(toolCall => toolCall.id === message.tool_call_id))?.tool_calls?.find(toolCall => toolCall.id === message.tool_call_id)
      const name = call?.function.name || message.name || 'tool'
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: { output: message.content || '' } } }] })
    } else {
      contents.push({ role: 'user', parts: [{ text: message.content || '' }] })
    }
  }

  const generationConfig: Record<string, unknown> = { temperature: cfg.temperature ?? 0.2 }
  const maxOutputTokens = cfg.maxOutputTokens ?? cfg.maxTokens
  if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens
  if (cfg.reasoningEffort) generationConfig.thinkingConfig = { thinkingBudget: cfg.reasoningEffort === 'low' ? 1024 : cfg.reasoningEffort === 'medium' ? 4096 : cfg.reasoningEffort === 'high' ? 8192 : 16384 }

  const body: Record<string, any> = { contents, generationConfig }
  const system = messages.find(message => message.role === 'system')?.content
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (cfg.extra && typeof cfg.extra === 'object') Object.assign(body, cfg.extra)
  const declarations = tools.map((tool: any) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }))
  if (declarations.length) body.tools = [{ functionDeclarations: declarations }]
  return body
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function safeJson(s:string){try{return JSON.parse(s||'{}')}catch{return {}}}


function normalizeGeminiModalityUsage(usage:any){
  const categories=[
    ['promptTokensDetails','prompt'],
    ['cacheTokensDetails','cached'],
    ['candidatesTokensDetails','candidates'],
    ['toolUsePromptTokensDetails','toolUsePrompt'],
  ] as const
  const result:any={}
  for(const [source,target] of categories){
    const rows=usage?.[source]
    if(!Array.isArray(rows))continue
    const counts:Record<string,number>={}
    for(const row of rows){
      if(!row||typeof row!=='object'||typeof row.modality!=='string')continue
      const count=usageNumber(row.tokenCount)
      if(count===undefined)continue
      const modality=row.modality.trim().toLowerCase().replace(/[^a-z0-9_-]/g,'')
      if(!modality)continue
      counts[modality]=(counts[modality]||0)+count
    }
    if(Object.keys(counts).length)result[target]=counts
  }
  return Object.keys(result).length?result:undefined
}
