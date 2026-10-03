import type { ChatMessage } from '../session/store.js'
import { createContextBudget, estimateMessageTokens, estimateMessagesTokens, estimateTokens, type ContextBudget, type ContextBudgetOptions } from '../context/budget.js'

export { estimateMessagesTokens as estimateTokens }
export type { ContextBudget, ContextBudgetOptions }

function oneLine(text:string,max=320):string {
  return text
    .replace(/(.)\1{24,}/g,'$1…')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0,max)
}

function fileMentions(text:string):string[] {
  const found=new Set<string>()
  const patterns=[/(?:^|\s|[`'"(])((?:\.?\.?\/)?[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+)(?=$|\s|[`'",:;)])/g,/\b([A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md|yml|yaml|rs|go|java|kt|c|h|cpp|hpp|css|html))\b/g]
  for(const re of patterns)for(const match of text.matchAll(re)){const value=match[1];if(value&&value.length<180&&!/^https?:\/\//.test(value))found.add(value)}
  return [...found].slice(0,20)
}

function groups(messages:readonly ChatMessage[]):ChatMessage[][] {
  const result:ChatMessage[][]=[];let current:ChatMessage[]=[]
  for(const message of messages){
    if(message.role==='system')continue
    if(message.role==='user'&&current.length){result.push(current);current=[]}
    current.push(message)
  }
  if(current.length)result.push(current)
  return result
}

function summarySection(text:string,title:string):string[] {
  const lines=text.split(/\r?\n/)
  const wanted=new RegExp(`^#{2,3} ${title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*$`,'i')
  const start=lines.findIndex(line=>wanted.test(line.trimEnd()))
  if(start<0)return []
  const values:string[]=[]
  for(let i=start+1;i<lines.length;i++){
    const line=lines[i]||''
    if(/^#{2,3} /.test(line))break
    const value=line.replace(/^\s*-\s*/,'').trim()
    if(value)values.push(value)
  }
  return values.slice(-8)
}

export type CompactionContext = {
  activeObjective?: string
  todo?: Array<{id:string;task:string;status:string}>
  completionState?: string
}

function buildSummary(removed:ChatMessage[], previousSummary='', context:CompactionContext={}):string {
  const users=removed.filter(m=>m.role==='user'&&m.content).map(m=>oneLine(m.content||'',500))
  const assistants=removed.filter(m=>m.role==='assistant'&&m.content).map(m=>oneLine(m.content||'',420))
  const tools=removed.filter(m=>m.role==='tool'&&m.content).map(m=>oneLine(m.content||'',520))
  const errors=tools.filter(x=>/\b(?:error|failed|failure|exception|denied|cannot|could not)\b/i.test(x)).slice(-8)
  const successes=tools.filter(x=>!errors.includes(x)&&/\b(?:pass(?:ed)?|success|created|updated|fixed|built|verified)\b/i.test(x)).slice(-8)
  const allText=[previousSummary,...removed.map(m=>typeof m.content==='string'?m.content:'')].filter(Boolean).join('\n')
  const files=fileMentions(allText)
  const exactCalls=removed.flatMap(m=>m.role==='assistant'&&m.tool_calls?m.tool_calls:[]).slice(-12).map(call=>{
    const args=call.function?.arguments||'{}'
    return `${call.id}: ${call.function?.name||'tool'}(${oneLine(args,700)})`
  })
  const exactErrors=removed.filter(m=>m.role==='tool'&&typeof m.content==='string'&&/\b(?:error|failed|failure|exception|denied|cannot|could not|timed out)\b/i.test(m.content)).slice(-8).map(m=>`${m.tool_call_id||'unknown'}: ${oneLine(m.content||'',700)}`)
  const verification=removed.filter(m=>typeof m.content==='string'&&/\b(?:PASS|PASSED|VERIFIED|VERIFY|npm test|npm run build|tsc|test suite)\b/i.test(m.content||'')).slice(-8).map(m=>oneLine(m.content||'',700))
  const ranges=removed.flatMap(m=>m.role==='assistant'&&m.tool_calls?m.tool_calls.flatMap(call=>{
    try { const args=JSON.parse(call.function?.arguments||'{}'); const start=Number(args?.startLine); const end=Number(args?.endLine??args?.startLine); const file=typeof args?.path==='string'?args.path:undefined; return file&&Number.isInteger(start)&&start>0?[`${file}#L${start}-${Number.isInteger(end)&&end>=start?end:start}`]:[] } catch { return [] }
  }):[]).slice(-12)
  const previousObjective=summarySection(previousSummary,'Objective')[0]
  const previousDetails=summarySection(previousSummary,'Important Details')
  const previousActive=summarySection(previousSummary,'Active')
  const lines:string[]=[]
  const objective=context.activeObjective?.trim() || users.at(-1) || previousObjective || '(none)'
  lines.push('## Objective',`- ${oneLine(objective,500)}`)
  lines.push('','## Important Details')
  for(const detail of [...previousDetails,...previousActive,...users.slice(0,-1).slice(-4),...exactCalls,...exactErrors,...verification].slice(-12))lines.push(`- ${oneLine(detail,650)}`)
  if(ranges.length) for(const range of ranges) lines.push(`- continuation range: ${range}`)
  if(!previousDetails.length&&users.length<=1&&!exactCalls.length&&!exactErrors.length)lines.push('- (none)')
  const previousCompletedLines=summarySection(previousSummary,'Completed')
  const previousBlockedLines=summarySection(previousSummary,'Blocked')
  lines.push('','## Work State','### Completed')
  const completed=[...previousCompletedLines,...successes].slice(-10)
  if(completed.length)for(const item of completed)lines.push(`- ${item}`);else lines.push('- (none)')
  lines.push('','### Active')
  const active=assistants.slice(-3)
  if(active.length)for(const a of active)lines.push(`- ${a}`);else lines.push('- (none)')
  lines.push('','### Blocked')
  const blocked=[...previousBlockedLines,...errors].slice(-10)
  if(blocked.length)for(const e of blocked)lines.push(`- ${e}`);else lines.push('- (none)')
  lines.push('','## Todo')
  if(context.todo?.length){
    for(const item of context.todo) lines.push(`- [${item.status==='done'?'x':item.status==='in_progress'?'>':' '}] ${oneLine(`${item.id}: ${item.task}`,260)}`)
  } else {
    lines.push('- (not available)')
  }
  if(context.completionState) lines.push(`- Completion state: ${oneLine(context.completionState,300)}`)
  lines.push('','## Next Move',`1. ${active.at(-1)||'Continue the current task and verify changes.'}`,'','## Relevant Files')
  if(files.length)for(const f of files)lines.push(`- ${f}`);else lines.push('- (none)')
  return lines.join('\n')
}

function fitText(text:string,maxTokens:number):string {
  if(maxTokens<=0)return ''
  if(estimateTokens(text)<=maxTokens)return text
  const lines=text.split(/\r?\n/)
  const priority=(line:string) =>
    /^## Objective|^## Important Details|^### (?:Completed|Active|Blocked)|^## Next Move|^## Relevant Files/.test(line) ? 0 :
    /^- /.test(line) ? 1 : 2
  const scored=lines.map((line,index)=>({line,index,priority:priority(line)}))
  const keep=new Set<number>()
  for(const item of scored.filter(x=>x.priority===0)) keep.add(item.index)
  const candidates=scored.filter(x=>x.priority===1).sort((a,b)=>a.index-b.index)
  let built=[...keep].sort((a,b)=>a-b).map(i=>lines[i])
  let remaining=maxTokens-estimateTokens(built.join('\n'))
  if(remaining>0){
    for(const item of candidates){
      const next=[...built,item.line].join('\n')
      if(estimateTokens(next)>maxTokens)break
      built.push(item.line); remaining=maxTokens-estimateTokens(next); if(remaining<=0)break
    }
  }
  if(!built.length)return truncateToBudgetFallback(text,maxTokens)
  return `${built.join('\n')}\n…[summary truncated]`
}

function truncateToBudgetFallback(text:string,maxTokens:number):string {
  const maxChars=Math.max(80,maxTokens*4)
  return `${text.slice(0,Math.max(1,maxChars-24)).trimEnd()}\n…[summary truncated]`
}

function trimMessage(message:ChatMessage,maxTokens:number):ChatMessage {
  const copy={...message}
  const chars=Math.max(64,maxTokens*4)
  if(typeof copy.content==='string'&&copy.content.length>chars)copy.content=`${copy.content.slice(0,Math.max(1,chars-28))}\n[truncated for context budget]`
  if(copy.reasoning&&copy.reasoning.length>Math.floor(chars*0.75))copy.reasoning=`${copy.reasoning.slice(0,Math.max(1,Math.floor(chars*0.75)-20))}\n[reasoning truncated]`
  return copy
}

function selectTail(turns:ChatMessage[][],budgetTokens:number):ChatMessage[] {
  const target=Math.max(0,budgetTokens)
  const selected:ChatMessage[]=[];let used=0
  for(let i=turns.length-1;i>=0;i--){
    const turn=turns[i];const cost=estimateMessagesTokens(turn)
    if(!selected.length){selected.unshift(...turn);used+=cost;continue}
    if(used+cost>target)break
    selected.unshift(...turn);used+=cost
  }
  return selected
}

function messageUnits(messages:ChatMessage[]):ChatMessage[][] {
  const units:ChatMessage[][]=[]
  for(let i=0;i<messages.length;i++){
    const m=messages[i]
    if(m.role==='assistant'&&m.tool_calls?.length){
      const ids=new Set(m.tool_calls.map(c=>c.id));const unit=[m];let j=i+1
      while(j<messages.length&&messages[j].role==='tool'){
        const toolId=messages[j].tool_call_id
        if(!toolId||!ids.has(toolId))break
        unit.push(messages[j]);j++
      }
      units.push(unit);i=j-1;continue
    }
    if(m.role==='tool'&&m.tool_call_id)continue
    units.push([m])
  }
  return units
}

function fitUnit(unit:ChatMessage[],budgetTokens:number):ChatMessage[] {
  if(!unit.length||budgetTokens<=0)return []
  if(estimateMessagesTokens(unit)<=budgetTokens)return unit
  const out:ChatMessage[]=[];let remaining=budgetTokens
  for(const message of unit){
    const baseCost=estimateMessageTokens(message)
    if(message.role==='assistant'&&message.tool_calls){
      const fitted={...message,content:typeof message.content==='string'?oneLine(message.content,Math.max(64,Math.floor(remaining*2))):message.content}
      const cost=estimateMessageTokens(fitted);if(cost<=remaining){out.push(fitted);remaining-=cost}else return []
      continue
    }
    if(message.role==='tool'){
      const fitted=trimMessage(message,Math.max(16,Math.floor(remaining*0.9)));const cost=estimateMessageTokens(fitted)
      if(cost<=remaining){out.push(fitted);remaining-=cost}
      else if(!out.length)return []
      continue
    }
    const fitted=trimMessage(message,Math.max(16,Math.floor(remaining*0.9)));const cost=estimateMessageTokens(fitted)
    if(cost>remaining)return out.length?out:[]
    out.push(fitted);remaining-=cost
  }
  const calls=unit[0].role==='assistant'?unit[0].tool_calls||[]:[]
  if(calls.length){
    const resultIds=new Set(out.filter(m=>m.role==='tool'&&m.tool_call_id).map(m=>m.tool_call_id as string))
    if(calls.some(call=>!resultIds.has(call.id)))return []
  }
  return out
}

function preserveTailWithinBudget(tail:ChatMessage[],budgetTokens:number):ChatMessage[] {
  if(!tail.length||budgetTokens<=0)return []
  const units=messageUnits(tail);const out:ChatMessage[]=[];let remaining=budgetTokens
  for(const unit of units){
    const fitted=fitUnit(unit,remaining)
    if(!fitted.length)continue
    const cost=estimateMessagesTokens(fitted);if(cost>remaining)continue
    out.push(...fitted);remaining-=cost
  }
  const lastUser=[...out].reverse().find(m=>m.role==='user')
  if(!lastUser){
    const latestUser=[...tail].reverse().find(m=>m.role==='user');if(latestUser){const fitted=fitUnit([latestUser],remaining);if(fitted.length)out.push(...fitted)}
  }
  return out
}
export type MicroPruneOptions = {
  preserveRecentTurns?: number
  minToolTokens?: number
  references?: ReadonlyMap<string,string>
}

export type MicroPruneResult = {
  messages: ChatMessage[]
  pruned: number
  savedTokens: number
  remainingTokens: number
}

function isPruneMarker(content:string):boolean {
  return content.includes('[Older tool result pruned from active context;')
}

/**
 * established style staged reduction: trim old tool-result payloads before asking
 * the summarizer to remove conversation history. Tool messages remain paired
 * with their assistant tool calls, and the complete output stays in the
 * durable ToolOutputStore when a reference is available.
 */
export function microPruneToolResults(messages:ChatMessage[], targetTokens:number, options:MicroPruneOptions={}):MicroPruneResult {
  const preservedTurns=Math.max(1,Math.floor(options.preserveRecentTurns??2))
  const minToolTokens=Math.max(16,Math.floor(options.minToolTokens??32))
  const current=estimateMessagesTokens(messages)
  if(current<=targetTokens) return {messages,pruned:0,savedTokens:0,remainingTokens:current}

  const body=messages.filter(m=>m.role!=='system')
  const turnGroups=groups(body)
  const protectedMessages=new Set(turnGroups.slice(-preservedTurns).flat())
  const candidates=messages
    .map((message,index)=>({message,index}))
    .filter(item=>item.message.role==='tool' && typeof item.message.content==='string' && item.message.content && !protectedMessages.has(item.message) && !isPruneMarker(item.message.content))
    .map(item=>({
      ...item,
      cost:estimateMessageTokens(item.message),
      age:item.index,
    }))
    .filter(item=>item.cost>=minToolTokens)
    .sort((a,b)=>a.age-b.age || b.cost-a.cost)

  if(!candidates.length) return {messages,pruned:0,savedTokens:0,remainingTokens:current}

  const out=messages.map(message=>({...message}))
  let remaining=current
  let pruned=0
  let savedTokens=0
  for(const candidate of candidates){
    if(remaining<=targetTokens) break
    const callId=candidate.message.tool_call_id||'unknown'
    const ref=options.references?.get(callId)
    const marker=`[Older tool result pruned from active context; call_id=${callId}${ref ? `; full_output=${ref}` : ''}]`
    const next={...out[candidate.index],content:marker}
    const nextCost=estimateMessageTokens(next)
    const saved=candidate.cost-nextCost
    if(saved<=0) continue
    out[candidate.index]=next
    remaining-=saved
    savedTokens+=saved
    pruned+=1
  }
  return {messages:out,pruned,savedTokens,remainingTokens:remaining}
}

export function compactMessages(messages:ChatMessage[], maxTokens:number, options:Partial<ContextBudgetOptions>={}, context:CompactionContext={}):{messages:ChatMessage[];summary:string;removed:number;budget:ContextBudget} {
  const budget=createContextBudget(Object.keys(options).length ? {maxContextTokens:maxTokens,...options} : {maxContextTokens:maxTokens,maxOutputTokens:0,threshold:1,reserveTokens:0,recentTokens:Math.max(0,Math.min(8000,Math.floor(maxTokens*0.28)))})
  if(estimateMessagesTokens(messages)<=budget.usableTokens)return {messages,summary:'',removed:0,budget}
  const system=messages.find(m=>m.role==='system');
  const previousSummaryMessages=messages.filter(m=>m!==system&&m.role==='system'&&typeof m.content==='string'&&m.content.startsWith('Earlier conversation summary.'))
  const previousSummary=previousSummaryMessages.map(m=>m.content||'').join('\n\n')
  const body=messages.filter(m=>m!==system&&!(m.role==='system'&&previousSummaryMessages.includes(m)))
  const turnGroups=groups(body)
  const roughTail=selectTail(turnGroups,Math.min(budget.recentTokens,Math.floor(budget.compactTargetTokens*0.45)))
  const tailBudget=Math.min(budget.recentTokens,Math.floor(budget.compactTargetTokens*0.48))
  const tail=preserveTailWithinBudget(roughTail,tailBudget)
  const tailSet=new Set(tail);const removedMessages=body.filter(m=>!tailSet.has(m))
  const summary=buildSummary(removedMessages,previousSummary,context)
  const systemCost=system?estimateMessageTokens(system):0
  const overhead=24
  const summaryBudget=Math.max(32,budget.usableTokens-tailBudget-systemCost-overhead)
  const fittedSummary=fitText(summary,summaryBudget)
  const summaryMessage:ChatMessage={role:'system',content:`Earlier conversation summary. Preserve exact paths, identifiers, decisions, failures, and verification evidence when using this summary.\n\n${fittedSummary}`}
  const compacted:ChatMessage[]=[]
  if(system)compacted.push(system)
  if(estimateMessageTokens(summaryMessage)+estimateMessagesTokens(compacted)<=budget.usableTokens)compacted.push(summaryMessage)
  const remainingForTail=Math.max(0,budget.usableTokens-estimateMessagesTokens(compacted))
  compacted.push(...preserveTailWithinBudget(tail,remainingForTail))
  while(estimateMessagesTokens(compacted)>budget.usableTokens&&compacted.length>1)compacted.pop()
  if(estimateMessagesTokens(compacted)>budget.usableTokens && system){
    const fittedSystem=trimMessage(system,Math.max(32,budget.usableTokens))
    compacted.splice(0,compacted.length,fittedSystem)
  }
  return {messages:compacted,summary,removed:removedMessages.length,budget}
}
