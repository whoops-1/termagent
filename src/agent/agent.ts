import { normalizeProviderUsageReport, type Provider, type ProviderUsageReport } from '../providers/types.js'
import { captureProviderTrace } from '../providers/trace.js'
import type { ChatMessage } from '../session/store.js'
import { SessionStore } from '../session/store.js'
import { ToolRegistry } from '../tools/registry.js'
import { compactMessages, microPruneToolResults } from './compaction.js'
import { allocateContextSections, createContextBudget, estimateMessageTokens, estimateMessagesTokens, estimateTokens, truncateToTokenBudget } from '../context/budget.js'
import { resolveContextLimits } from '../context/model-limits.js'
import { withRetry } from './retry.js'
import { isProviderContextOverflowError } from '../providers/errors.js'
import { discoverSkills, formatSkillSearchResults, type SkillSearchResult } from '../skills/discovery.js'
import { formatSkillDescriptors, type SkillDescriptor } from '../skills/catalog.js'
import { profileFor } from './profiles.js'
import type { CustomAgent } from './custom.js'
import { activeTodoItems, type TodoItem } from '../tools/todo.js'
import { ToolOutputStore } from './tool-output-store.js'
import { accountContext } from '../context/budget.js'
import { ExecutionWorkflow, initialWorkflow, workflowSummary } from './workflow.js'
import { ToolLoopGuard } from './loop-guard.js'
import type { PluginHookManager } from '../plugins/hooks.js'
import { FileReadStateCache } from '../tools/file-state.js'
import { ExplorationState } from '../context/exploration.js'
import { ToolCallLifecycle, classifyToolError, normalizeToolCalls, parseToolArguments } from './tool-call-lifecycle.js'
import { XmlToolCallStreamParser } from './text-tool-call-parser.js'
import type { QuestionResponse } from '../tools/types.js'
import { machineStateFromRuntime, renderMachineState, type ContextMachineState, type ContextInstructionReference } from '../context/state.js'
import { formatInstructionFiles, loadInstructionFiles, loadInstructionPaths, loadScopedInstructionFiles, type InstructionFile } from '../context/instructions.js'
import { loadSkill, boundSkillContent } from '../skills/invoker.js'
import { semanticProgressFingerprint } from './progress.js'
import { explorationInterventionMessage, explorationInterventionToolActions } from './exploration-intervention.js'
import { ExplorationTelemetry, type ExplorationTelemetrySnapshot } from './exploration-telemetry.js'
import { renderExplorationGuidance } from './exploration-guidance.js'
import { buildEvidenceLedger, type EvidenceLedgerSnapshot, type EvidenceLedgerVerification, type EvidenceLedgerLspDiagnostic } from '../context/evidence-ledger.js'
import { normalizePostEditVerificationConfig, runAutomaticPostEditVerification, type AutomaticVerificationResult } from './post-edit-verification.js'
import type { PostEditVerificationConfig } from '../config/config.js'
import { TaskManager } from '../tasks/manager.js'
import { specialistRole } from './specialists.js'
import { canonicalJson } from '../util/canonical.js'
import crypto from 'node:crypto'

const WRITE_TOOLS = new Set(['write_file','edit_file','apply_patch'])

function instructionTargetsForTool(name:string,args:any):string[]{
  const values:string[]=[]
  const add=(value:unknown)=>{if(typeof value==='string'&&value.trim())values.push(value.trim())}
  if(name==='apply_patch' && typeof args?.patch==='string'){
    for(const match of args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(match[1])
    for(const match of args.patch.matchAll(/^(?:\+\+\+|---) [ab]\/(.+)$/gm)) add(match[1])
  }
  if(name==='list_dir') add(args?.path||args?.directory)
  else {
    add(args?.path)
    add(args?.filePath)
    add(args?.target)
    add(args?.directory)
    add(args?.paths)
  }
  if(name==='glob') add(args?.pattern)
  if(name==='grep') add(args?.include)
  return [...new Set(values.map(value=>{
    const clean=value.replace(/[\*?{}[\]]/g,'')
    const slash=clean.lastIndexOf('/')
    return slash>0 && /[*?{}[]/.test(value) ? clean.slice(0,slash) : clean
  }))]
}

function mutationEvidenceFromLifecycle(records: ReturnType<ToolCallLifecycle['snapshot']>) {
  return records.flatMap(record => {
    const mutation=(record.metadata as any)?.mutation
    if(!mutation || typeof mutation!=='object') return []
    const base={callId:record.callId,turnId:record.turnId}
    const fromItem=(item:any)=>({
      ...base,
      path:String(item?.path||''),
      operation:String(item?.operation||'update'),
      beforeHash:item?.beforeHash ?? null,
      afterHash:typeof item?.afterHash==='string'?item.afterHash:undefined,
      additions:Number.isFinite(Number(item?.additions ?? (record.metadata as any)?.fileDiff?.additions)) ? Number(item?.additions ?? (record.metadata as any)?.fileDiff?.additions) : undefined,
      deletions:Number.isFinite(Number(item?.deletions ?? (record.metadata as any)?.fileDiff?.deletions)) ? Number(item?.deletions ?? (record.metadata as any)?.fileDiff?.deletions) : undefined,
    })
    if(typeof mutation.path==='string' && mutation.path.trim()) return [fromItem(mutation)]
    if(Array.isArray(mutation.files)) return mutation.files.filter((item:any)=>item && typeof item.path==='string' && item.path.trim()).slice(0,64).map(fromItem)
    return []
  })
}

function mutationFingerprint(mutations: readonly unknown[]): string {
  return crypto.createHash('sha256').update(canonicalJson(mutations.map((item:any)=>({path:item?.path,operation:item?.operation,beforeHash:item?.beforeHash??null,afterHash:item?.afterHash,additions:item?.additions,deletions:item?.deletions})).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b))))).digest('hex')
}

function nonSystemMessages(messages:readonly ChatMessage[]):ChatMessage[] {
  return messages.filter(message=>message.role!=='system').map(message=>({...message,tool_calls:message.tool_calls?.map(call=>({...call,function:{...call.function}}))}))
}

function checkpointNotice(summary:string,machineState:ContextMachineState,evidence:string[],maxTokens:number):string {
  const summaryText=summary.trim() || '(none)'
  const machine=renderMachineState(machineState,maxTokens,evidence)
  const content=`Earlier conversation summary. The structured machine context below is authoritative state, not prose to reinterpret.\n\n${summaryText}\n\n${machine}`
  return truncateToTokenBudget(content,Math.max(64,maxTokens))
}

function normalizeTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item: any) => ({
      id: String(item?.id ?? ''),
      task: String(item?.task ?? ''),
      status: (item?.status ?? 'pending') as TodoItem['status'],
      priority: ['high','medium','low'].includes(item?.priority) ? item.priority : undefined,
    }))
    .filter(item => item.id && item.task && ['pending', 'in_progress', 'done'].includes(item.status))
}

function todoFingerprint(items: TodoItem[]): string {
  return JSON.stringify(items.map(item => ({ id: item.id, task: item.task, status: item.status, priority:item.priority || undefined })))
}

function clearStaleTodoSections(messages: ChatMessage[], activeTodos: readonly TodoItem[]) {
  if (activeTodos.some(item => item.status !== 'done')) return
  for (const message of messages) {
    if (message.role !== 'system' || typeof message.content !== 'string' || !message.content.startsWith('Earlier conversation summary.')) continue
    message.content = message.content
      .replace(/(^|\n)## Todo\n[\s\S]*?(?=\n## Next Move|$)/m, '$1## Todo\n- (no active todo list)')
      .replace(/(^|\n)## Next Move\n[\s\S]*?(?=\n## Relevant Files|$)/m, '$1## Next Move\n1. Follow the current user request and verify only the changes it requires.')
  }
}

function redactCompletedTodoToolMessages(messages: ChatMessage[]) {
  for (const message of messages) {
    if (message.role !== 'tool' || message.name !== 'todo' || typeof message.content !== 'string') continue
    try {
      const parsed = JSON.parse(message.content)
      const items = Array.isArray(parsed) ? normalizeTodoItems(parsed) : []
      if (items.length > 0 && items.every(item => item.status === 'done')) {
        message.content = '[]'
      }
    } catch {}
  }
}

// Only metadata that changes semantic session state may activate the
// exploration no-progress guard. Execution bookkeeping such as task IDs is
// deliberately excluded: a shell/task completion can be useful work even
// when repository state is unchanged.
const SEMANTIC_METADATA_KEYS = new Set(['mutation', 'todo'])

function containsSemanticMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsSemanticMetadata)
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (SEMANTIC_METADATA_KEYS.has(key)) return true
    if (containsSemanticMetadata(record[key])) return true
  }
  return false
}

const WORKFLOW_TOOL_SCHEMA = {type:'function',function:{name:'workflow_phase',description:'Advance the autonomous execution workflow when the current phase is complete. Planning must precede building; verification gates completion.',parameters:{type:'object',properties:{phase:{type:'string',enum:['planning','building','verifying','iterating','complete','blocked']},reason:{type:'string'}},required:['phase']}}}

function roleForPhase(phase:string):string {
  if(phase==='planning') return 'planning'
  if(phase==='verifying') return 'verification'
  if(phase==='iterating') return 'building'
  if(phase==='building') return 'building'
  return 'default'
}

export class Agent {
  private readonly toolOutputStore: ToolOutputStore
  constructor(private provider:Provider,private tools:ToolRegistry,private sessions:SessionStore,private maxRounds=0,private maxContextTokens=0,private retryMax=4,private onStatus?:(s:string)=>void,private skills:unknown[]=[],private contextOptions:{threshold?:number;reserveTokens?:number;recentTokens?:number}={},private hookManager?:PluginHookManager,toolOutputOptions:{maxLines?:number;maxBytes?:number;retentionDays?:number}={},private postEditVerificationConfig?:PostEditVerificationConfig,private taskManager?:TaskManager){
    this.toolOutputStore=new ToolOutputStore(toolOutputOptions)
  }

  async run(input:{sessionId:string;messages:ChatMessage[];cwd:string;instructions:string;repositoryContext?:string;skillsContext?:string;prompt?:string;onText?:(s:string)=>void;onTool?:(name:string,args:any,callId?:string)=>void;onToolResult?:(name:string,out:string,metadata?:any)=>void;onReasoning?:(s:string)=>void;autonomous?:boolean;mode?:string;customAgent?:CustomAgent;scopePaths?:string[];signal?:AbortSignal;onQuestion?: (questions:any[], signal?:AbortSignal)=>Promise<string[][]|QuestionResponse>;onTodo?:(items:TodoItem[])=>void;onExplorationTelemetry?:(snapshot:ExplorationTelemetrySnapshot)=>void;onExplorationState?:(snapshot:ReturnType<ExplorationState['snapshot']>)=>void;skillDiscoverySuppressed?:boolean;explicitSkill?:{id:string;content:string;sha256:string};allowedTools?:string[];taskId?:string;delegationDepth?:number;specialistRole?:string;onUsage?:(usage:ProviderUsageReport)=>void;onContextEstimate?:(tokens:number,contextWindow:number)=>void}){
    const messages=input.messages
    const readFileState = new FileReadStateCache()
    const explorationState = new ExplorationState(input.cwd, input.scopePaths)
    const explorationTelemetry = new ExplorationTelemetry()
    const postEditVerification = normalizePostEditVerificationConfig(this.postEditVerificationConfig)
    const verificationManager = postEditVerification.enabled ? (this.taskManager ?? new TaskManager()) : undefined
    const automaticVerifications: EvidenceLedgerVerification[] = []
    let automaticVerificationSatisfied: {mutationFingerprint:string;result:AutomaticVerificationResult}|undefined
    const publishExplorationState = () => input.onExplorationState?.(explorationState.snapshot())
    const publishExplorationTelemetry = () => { input.onExplorationTelemetry?.(explorationTelemetry.snapshot()); publishExplorationState() }
    await this.toolOutputStore.cleanupIfDue()
    const mode=input.mode||'build'
    const profile=profileFor(mode)
    const custom=input.customAgent
    const autonomous=Boolean(input.autonomous)
    const enforcedAutonomous=autonomous && Boolean(this.tools.get('todo')) && Boolean(this.tools.get('verify_project'))
    const allowWrite=custom?.permission?.edit==='deny'?false:profile.allowWrite
    const allowShell=custom?.permission?.bash==='deny'?false:profile.allowShell
    const configuredAllowed = input.allowedTools?.length ? new Set(input.allowedTools) : custom?.tools?.length ? new Set(custom.tools) : undefined
    const configuredDisallowed = new Set(custom?.disallowedTools || [])
    const toolAllowed = (name:string) => (!configuredAllowed || configuredAllowed.has(name)) && !configuredDisallowed.has(name)
    const rounds=custom?.steps ?? profile.maxRounds
    const loopGuard=new ToolLoopGuard({
      repeatThreshold: this.readLoopGuardLimit(process.env.TERMAGENT_REPEAT_TOOL_THRESHOLD, 3),
      writeOnlyRoundThreshold: this.readLoopGuardLimit(process.env.TERMAGENT_WRITE_LOOP_ROUNDS, 3),
      semanticRepeatThreshold: this.readLoopGuardLimit(process.env.TERMAGENT_SEMANTIC_LOOP_THRESHOLD, 3, 2, 12),
      semanticNudgeThreshold: this.readLoopGuardLimit(process.env.TERMAGENT_SEMANTIC_NUDGE_THRESHOLD, 1, 1, 12),
      semanticConstrainThreshold: this.readLoopGuardLimit(process.env.TERMAGENT_SEMANTIC_CONSTRAIN_THRESHOLD, 2, 2, 12),
      readOnlyRoundThreshold: mode==='explore' ? Number.MAX_SAFE_INTEGER : this.readLoopGuardLimit(process.env.TERMAGENT_READ_LOOP_ROUNDS, 32),
    })
    let loopStopReason:string|undefined
    let completionRequested:string|undefined
    const providerRouteRole=input.specialistRole ? 'subagent' : enforcedAutonomous ? 'planning' : mode
    this.provider.setRole?.(providerRouteRole)
    // Resolve the model limits for the route the smart router will actually
    // choose. Previously the context budget was calculated before the router
    // received the prompt, so a request routed to a larger/smaller model could
    // inherit the wrong window for the entire turn.
    this.provider.setTurnContext?.({userText:input.prompt||'',turnNumber:messages.length+1})
    const initialProviderConfig=this.provider.getActiveConfig?.() || this.provider.config
    let resolvedLimits=resolveContextLimits({providerConfig:initialProviderConfig,configuredContextWindow:this.maxContextTokens>0?this.maxContextTokens:undefined})
    let budget=createContextBudget({maxContextTokens:resolvedLimits.contextWindow,maxOutputTokens:resolvedLimits.maxOutputTokens,...this.contextOptions})
    const persistedSession=await this.sessions.load(input.sessionId)
    const instructionSectionBudget=allocateContextSections(budget.usableTokens,{explicitSkill:Boolean(input.explicitSkill)}).instructions
    const instructionBudgetBytes=Math.min(512*1024,Math.max(16*1024,Math.floor(instructionSectionBudget*4)))
    const instructionFileBytes=Math.min(128*1024,Math.max(4*1024,Math.floor(instructionBudgetBytes/3)))
    const baseInstructionLoad=await loadInstructionFiles(input.cwd,{maxBytes:Math.floor(instructionBudgetBytes*0.8),maxFileBytes:instructionFileBytes})
    const instructionFiles=new Map<string,InstructionFile>(baseInstructionLoad.files.map(file=>[file.path,file]))
    const persistedInstructionPaths=[...persistedSession.events]
      .filter((event:any)=>event.type==='context.instructions' && Array.isArray(event.data?.files))
      .flatMap((event:any)=>event.data.files.map((file:any)=>typeof file?.path==='string'?file.path:''))
      .filter(Boolean)
    const instructionBytesUsed=[...instructionFiles.values()].reduce((sum,file)=>sum+Buffer.byteLength(file.content,'utf8'),0)
    const restoredInstructionLoad=await loadInstructionPaths(input.cwd,persistedInstructionPaths,{maxBytes:Math.max(0,instructionBudgetBytes-instructionBytesUsed),maxFileBytes:instructionFileBytes})
    for(const file of restoredInstructionLoad.files) instructionFiles.set(file.path,file)
    const suppliedInstructions=input.instructions?.trim()||''
    const supplementalInstructions=suppliedInstructions && !baseInstructionLoad.text.includes(suppliedInstructions) && !restoredInstructionLoad.text.includes(suppliedInstructions)
      ? suppliedInstructions
      : ''
    let effectiveInstructions=[baseInstructionLoad.text,restoredInstructionLoad.text,supplementalInstructions]
      .filter((value,index,items)=>Boolean(value?.trim()) && items.indexOf(value)===index)
      .join('\n\n')
    const instructionReferences:ContextInstructionReference[]=[...instructionFiles.values()].map(file=>({path:file.path,sha256:file.sha256,scope:file.scope}))
    const restoredCheckpoint=await this.sessions.latestContextCheckpoint(input.sessionId)
    let checkpointSummary=typeof restoredCheckpoint?.summary==='string'?restoredCheckpoint.summary:''
    let contextEpoch=Number.isInteger(restoredCheckpoint?.epoch)?Number(restoredCheckpoint.epoch):0
    let summaryRevision=Number.isInteger(restoredCheckpoint?.summaryRevision)?Number(restoredCheckpoint.summaryRevision):0
    let activeCheckpointProjection:Array<ChatMessage>|undefined
    let restoredReadEvidence:string[]=[]
    if(restoredCheckpoint && Array.isArray(restoredCheckpoint.messages)) {
      activeCheckpointProjection=nonSystemMessages(restoredCheckpoint.messages)
      messages.splice(0,messages.length,...activeCheckpointProjection)
      if (restoredCheckpoint.machineState?.exploration) explorationState.restore(restoredCheckpoint.machineState.exploration)
      try {
        const readEvidenceBudget=Math.min(24_000,Math.max(600,Math.floor(budget.usableTokens*0.05)))
        const readEvidenceFiles=Math.min(64,Math.max(5,Math.floor(budget.usableTokens/1_500)))
        const readRestore = await readFileState.restoreCoverage(restoredCheckpoint.machineState?.readCoverage || [], {
          cwd: input.cwd,
          scopePaths: input.scopePaths,
          maxFiles:readEvidenceFiles,
          maxBytes:Math.min(8*1024*1024,Math.max(256*1024,readEvidenceBudget*4)),
        })
        restoredReadEvidence = await readFileState.rehydrateContextEvidence(readEvidenceBudget, readEvidenceFiles)
        if (readRestore.restoredRanges || readRestore.skipped) {
          this.onStatus?.(`context: restored ${readRestore.restoredRanges} inspected range(s) across ${readRestore.restoredFiles} file(s); skipped ${readRestore.skipped} stale, out-of-scope, or unavailable file record(s)`)
        }
      } catch (error) {
        this.onStatus?.(`context: read-coverage recovery failed: ${String((error as Error).message || error).slice(0, 180)}`)
      }
    }
    const persistedLoadedSkills=[...persistedSession.events].filter((event:any)=>event.type==='skill.load' && event.data?.id).map((event:any)=>({id:String(event.data.id),sha256:typeof event.data.sha256==='string'?event.data.sha256:undefined,path:typeof event.data.path==='string'?event.data.path:undefined}))
    const loadedSkillContents=new Map<string,string>()
    const restoredSkillBudget=Math.min(48_000,budget.explicitSkillTokens)
    if(input.explicitSkill && !persistedLoadedSkills.some(item=>item.id===input.explicitSkill!.id)) persistedLoadedSkills.push({id:input.explicitSkill.id,sha256:input.explicitSkill.sha256,path:undefined})
    const uniqueSkillRefs=[...new Map(persistedLoadedSkills.map(item=>[item.id,item])).values()].slice(-24)
    for(const [index,skillRef] of uniqueSkillRefs.entries()){
      try{
        const loaded=await loadSkill(input.cwd,skillRef.id)
        if(skillRef.sha256 && loaded.sha256!==skillRef.sha256){
          this.onStatus?.(`context: previously loaded skill '${skillRef.id}' changed; stale instructions were not restored`)
          continue
        }
        const share=Math.max(128,Math.floor(restoredSkillBudget/Math.max(1,uniqueSkillRefs.length)))
        loadedSkillContents.set(skillRef.id,boundSkillContent(loaded.content,share))
        if(!skillRef.path) skillRef.path=loaded.path
        if(!skillRef.sha256) skillRef.sha256=loaded.sha256
      }catch(error){
        this.onStatus?.(`context: could not restore skill '${skillRef.id}': ${String((error as Error).message||error).slice(0,180)}`)
      }
    }
    let restoredSkillContext=[...loadedSkillContents.entries()].map(([id,content])=>`<restored_skill id="${id}">\n${content}\n</restored_skill>`).join('\n\n')
    const persistedQuestionAnswers=[...persistedSession.events].filter((event:any)=>['question.replied','question.rejected','question.cancelled'].includes(event.type) && event.data?.requestId).map((event:any)=>({requestId:String(event.data.requestId),status:String(event.type).replace('question.',''),answers:Array.isArray(event.data.answers)?event.data.answers.map((a:any)=>Array.isArray(a)?a.map(String):[]):[]}))
    const latestTodoEvent=[...persistedSession.events].reverse().find((event:any)=>event.type==='todo')
    const latestPersistedTodo=[...messages].reverse().find((message:any)=>message.role==='tool'&&message.name==='todo')
    const checkpointTodos=normalizeTodoItems(restoredCheckpoint?.machineState?.todo)
    const persistedTodoRaw=latestTodoEvent
      ? normalizeTodoItems(latestTodoEvent.data?.items)
      : checkpointTodos.length ? checkpointTodos : normalizeTodoItems(typeof latestPersistedTodo?.content==='string' ? (()=>{ try { return JSON.parse(latestPersistedTodo.content) } catch { return [] } })() : [])
    // Completed-only todos are historical state, not an active objective for
    // a new turn. The terminal UI follows the same lifecycle: hide the todo
    // surface once every item is completed.
    const persistedTodo=activeTodoItems(persistedTodoRaw)
    redactCompletedTodoToolMessages(messages)
    clearStaleTodoSections(messages,persistedTodo)
    let currentTodoItems=persistedTodo
    const workflow=enforcedAutonomous ? new ExecutionWorkflow(initialWorkflow(),Number(process.env.TERMAGENT_VERIFY_MAX_ITERATIONS||3)) : undefined
    const skillDiscoveryEnabled = !input.skillDiscoverySuppressed && Boolean(this.tools.get('search_skills'))
    let discoveredSkills:SkillSearchResult[]=[]
    const discoveryKeys=new Set<string>()
    const recordSkillDiscovery=async(signal:string,query:string)=>{
      if(!skillDiscoveryEnabled || !query.trim()) return [] as SkillSearchResult[]
      const key=`${signal}:${query.replace(/\s+/g,' ').trim().toLowerCase()}`
      if(discoveryKeys.has(key)) return discoveredSkills
      discoveryKeys.add(key)
      const result=await discoverSkills(input.cwd,query,signal,{limit:8})
      const merged=new Map(discoveredSkills.map(skill=>[skill.id,skill]))
      for(const skill of result.results) merged.set(skill.id,skill)
      discoveredSkills=[...merged.values()].sort((a,b)=>b.relevance-a.relevance||a.id.localeCompare(b.id)).slice(0,12)
      await this.sessions.append(input.sessionId,{type:'skill.search',ts:Date.now(),data:{signal,query,resultCount:result.results.length,skills:result.results.map(skill=>({id:skill.id,relevance:skill.relevance}))}})
      if(result.results.length===0) await this.sessions.append(input.sessionId,{type:'skill.skip',ts:Date.now(),data:{signal,query,reason:'no-match'}})
      return result.results
    }
    const renderSkillContext=()=>formatSkillSearchResults(discoveredSkills,5000)
    const buildSchemas=()=>{
      const phase=workflow?.state.phase || 'none'
      const bounded=this.tools.selectSchemas({
        mode,
        autonomous,
        workflowPhase:phase,
        allowedTools:configuredAllowed,
        disallowedTools:configuredDisallowed,
        allowWrite,
        allowShell,
        budgetTokens:budget.toolSchemaTokens,
        workflowAllowed:workflow ? (tool => workflow.allowedTool(tool,true)) : undefined,
        extraSchemas:workflow && (phase==='planning' || phase==='building' || phase==='iterating') ? [WORKFLOW_TOOL_SCHEMA as any] : undefined,
      })
      if(bounded.dropped.length) this.onStatus?.(`context: omitted ${bounded.dropped.length} low-priority tool schema(s) to fit budget`)
      if(this.tools.list().length > 0 && bounded.tools.length === 0){
        throw new Error(`Tool definitions exceed the configured context budget (${bounded.originalTokens} estimated tokens >= ${budget.usableTokens} usable tokens)`)
      }
      return bounded
    }
    const initialSchemaResult=buildSchemas()
    const schemaTokens=initialSchemaResult.estimatedTokens
    type ProviderUsageBaseline={measuredTokens:number;estimatedRequestTokens:number;provider:string;model:string;contextWindow:number}
    let providerUsageBaseline:ProviderUsageBaseline|undefined
    let providerTokenRatio=1
    const matchingUsageReports:ProviderUsageReport[]=[]
    const sessionEvents=Array.isArray((persistedSession as any)?.events)?(persistedSession as any).events:[]
    let latestCompactionIndex=-1
    for(let index=0;index<sessionEvents.length;index++){
      const event=sessionEvents[index]
      if(event?.type==='compaction' && event.data?.stage!=='started') latestCompactionIndex=index
    }
    for(const event of sessionEvents.slice(latestCompactionIndex+1)){
      if(event?.type!=='provider.usage') continue
      const report=normalizeProviderUsageReport({...event.data,recordedAt:event.data?.recordedAt??event.ts})
      if(!report || report.estimated || report.provider!==resolvedLimits.provider || report.model!==resolvedLimits.model || report.contextWindow!==resolvedLimits.contextWindow) continue
      matchingUsageReports.push(report)
    }
    let recentRatios=matchingUsageReports.slice(-5).flatMap(report=>{
      const estimate=report.estimateRequestTokens ?? (report.estimateInputTokens+schemaTokens)
      const measured=report.contextTokens??report.inputTokens
      if(!Number.isFinite(estimate)||estimate<=0||!Number.isFinite(measured)||measured<=0)return []
      return [Math.max(1,Math.min(4,measured/estimate))]
    }).sort((a,b)=>a-b)
    if(recentRatios.length) providerTokenRatio=recentRatios[Math.floor(recentRatios.length/2)]!
    // A compaction changes the prompt projection enough that pre-compaction
    // samples must not remain in the rolling window. Keep a bounded warm start
    // for the first request in the new epoch, shrinking the prior route ratio
    // 75% of the way toward neutral; the first new measurement then replaces it.
    // This avoids both stale full-strength carry-over and a completely cold
    // first request after every compaction.
    const COMPACTION_EPOCH_PRIOR_WEIGHT=0.75
    const startProviderUsageCalibrationEpoch=()=>{
      const priorRatio=providerTokenRatio
      providerUsageBaseline=undefined
      recentRatios=[]
      providerTokenRatio=1+(priorRatio-1)*COMPACTION_EPOCH_PRIOR_WEIGHT
    }
    const latestMeasured=matchingUsageReports.at(-1)
    if(latestMeasured){
      providerUsageBaseline={
        measuredTokens:latestMeasured.contextTokens??latestMeasured.inputTokens,
        estimatedRequestTokens:latestMeasured.estimateRequestTokens??(latestMeasured.estimateInputTokens+schemaTokens),
        provider:latestMeasured.provider,
        model:latestMeasured.model,
        contextWindow:latestMeasured.contextWindow,
      }
    }
    const routeMatchesBaseline=()=>Boolean(providerUsageBaseline && providerUsageBaseline.provider===resolvedLimits.provider && providerUsageBaseline.model===resolvedLimits.model && providerUsageBaseline.contextWindow===resolvedLimits.contextWindow)
    const requestFootprintParts=(accounting:ReturnType<typeof accountContext>,additional=0,native?:import('../providers/types.js').ProviderTokenCount)=>{
      const extra=Math.max(0,additional)
      const local=accounting.total+extra
      const ratioAdjusted=Math.ceil(accounting.total*providerTokenRatio)+extra
      const baselineAdjusted=routeMatchesBaseline()
        ? Math.max(0,providerUsageBaseline!.measuredTokens+(accounting.total-providerUsageBaseline!.estimatedRequestTokens)+extra)
        : 0
      const nativeAdjusted=Math.max(0,native?.inputTokens||0)
      return {local,ratioAdjusted,baselineAdjusted,nativeAdjusted,effective:Math.max(local,ratioAdjusted,baselineAdjusted,nativeAdjusted)}
    }
    const estimateRequestFootprint=(accounting:ReturnType<typeof accountContext>,additional=0,native?:import('../providers/types.js').ProviderTokenCount)=>requestFootprintParts(accounting,additional,native).effective
    let rawMessageBudget=Math.max(256,Math.floor((budget.usableTokens-schemaTokens)/providerTokenRatio))
    // Checkpoint notices contain the machine-readable continuation state. A
    // fixed 240-token ceiling silently discarded most of that state on large
    // sessions, defeating the point of durable context checkpoints.
    let checkpointNoticeBudget=Math.min(48_000,Math.max(64,Math.floor(rawMessageBudget*0.08)))
    let restoreNoticeBudget=restoredCheckpoint ? checkpointNoticeBudget : 0
    let messageBudget=Math.max(128,rawMessageBudget-restoreNoticeBudget)
    const descriptorContext=this.skills.length ? formatSkillDescriptors(this.skills as SkillDescriptor[], 5000) : '(skill discovery pending)'
    const system=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${effectiveInstructions}`,input.repositoryContext,descriptorContext,autonomous,mode,messageBudget,input.explicitSkill,restoredSkillContext)
    const existing=messages.find(m=>m.role==='system')
    if(existing) existing.content=system; else messages.unshift({role:'system',content:system})
    let contextNoticeMessage:ChatMessage|undefined
    if(restoredCheckpoint?.machineState){
      const restoredState=restoredCheckpoint.machineState as ContextMachineState
      contextNoticeMessage={role:'system',content:checkpointNotice(checkpointSummary,restoredState,restoredReadEvidence,restoreNoticeBudget||192)}
      messages.splice(1,0,contextNoticeMessage)
    }
    const persistWorkflow=async()=>{if(!workflow)return;await this.sessions.appendWorkflow(input.sessionId,{...workflow.state,summary:workflowSummary(workflow.state)})}

    const buildLedger=async(lifecycleRecords: ReturnType<ToolCallLifecycle['snapshot']>) => {
      const tasks = verificationManager ? await verificationManager.list().catch(() => []) : []
      return buildEvidenceLedger({
        exploration: explorationState.snapshot(),
        lifecycle: lifecycleRecords,
        mutations: mutationEvidenceFromLifecycle(lifecycleRecords),
        tasks,
        automaticVerifications,
        workflow: workflow?.state,
      })
    }
    const readFileStateSnapshot=()=>{
      const snapshot=readFileState.contextSnapshot(64)
      return snapshot.map((item:any)=>({
        canonicalPath:item.canonicalPath,mtimeMs:item.mtimeMs,size:item.size,totalLines:item.totalLines,lastUse:item.lastUse,contentHash:item.contentHash,
        segments:(item.ranges||[]).map((range:any)=>({startLine:range.startLine,endLine:range.endLine,content:'',bytes:0,complete:true,recordedAt:item.lastUse||Date.now()})),
        requests:[],
      }))
    }

    let latestMachineState:ContextMachineState|undefined=restoredCheckpoint?.machineState
    const upsertCheckpointNotice=(machine:ContextMachineState,evidence:string[])=>{
      latestMachineState=machine
      if(!contextNoticeMessage){ contextNoticeMessage={role:'system',content:''}; messages.splice(1,0,contextNoticeMessage) }
      contextNoticeMessage.content=checkpointNotice(checkpointSummary,machine,evidence,checkpointNoticeBudget)
    }

    const maybeCompact=async(additionalRequestTokens=0,trigger:'turn-entry'|'route-change'|'provider-request'|'post-tool-round'|'post-provider-response'='post-tool-round',providerCount?:import('../providers/types.js').ProviderTokenCount,forceOverflowRecovery=false)=>{
      const schemaResult=buildSchemas()
      const schemas=schemaResult.tools
      const liveSchemaTokens=schemaResult.estimatedTokens
      if(liveSchemaTokens>=budget.usableTokens) throw new Error(`Tool definitions exceed the configured context budget (${liveSchemaTokens} estimated tokens >= ${budget.usableTokens} usable tokens)`)
      const beforeAccounting=accountContext(messages,schemas)
      const extraTokens=Math.max(0,additionalRequestTokens)
      const beforeRequestTokens=estimateRequestFootprint(beforeAccounting,extraTokens,providerCount)
      if(beforeRequestTokens<=budget.usableTokens && !forceOverflowRecovery)return

      // A provider overflow is authoritative evidence that the local estimate
      // under-counted. Force a materially smaller target for this one recovery
      // attempt instead of repeating the same oversized request.
      const compactionTargetTokens=forceOverflowRecovery?Math.floor(budget.usableTokens*0.72):Math.floor(budget.usableTokens*0.90)

      // Keep multimodal estimates out of the text-message allowance. The
      // repository compactor and safe tool-result pruner operate on text only.
      const footprint=requestFootprintParts(beforeAccounting,extraTokens,providerCount)
      const providerCorrection=Math.max(0,Math.max(footprint.baselineAdjusted,footprint.nativeAdjusted)-footprint.ratioAdjusted)
      const liveMessageBudget=Math.floor((compactionTargetTokens-liveSchemaTokens-extraTokens-beforeAccounting.multimodal-providerCorrection)/providerTokenRatio)
      if(liveMessageBudget<64) throw new Error(`Conversation cannot fit within the configured context budget after reserving tool definitions and multimodal payloads (${liveMessageBudget} message tokens available)`)

      const snapshot=(messageCount:number,accounting:ReturnType<typeof accountContext>,extra:number,count?:import('../providers/types.js').ProviderTokenCount)=>({
        estimatedRequestTokens:estimateRequestFootprint(accounting,extra),
        messageTokens:estimateMessagesTokens(messages),
        toolSchemaTokens:accounting.toolDefinitions,
        multimodalTokens:accounting.multimodal,
        additionalRequestTokens:Math.max(0,extra),
        usableTokens:budget.usableTokens,
        headroomTokens:budget.usableTokens-estimateRequestFootprint(accounting,extra),
        contextWindowTokens:budget.maxContextTokens,
        outputReserveTokens:budget.maxOutputTokens,
        safetyReserveTokens:budget.safetyReserveTokens,
        threshold:budget.threshold,
        messageCount,
        ...(count ? { providerCount: { inputTokens: count.inputTokens, source: count.source } } : {}),
        ...(routeMatchesBaseline() ? { providerUsageBaseline: { measuredTokens:providerUsageBaseline!.measuredTokens, estimatedRequestTokens:providerUsageBaseline!.estimatedRequestTokens, ratio:providerTokenRatio, provider:providerUsageBaseline!.provider, model:providerUsageBaseline!.model } } : {}),
      })
      const before=snapshot(messages.length,beforeAccounting,extraTokens,providerCount)
      await this.sessions.append(input.sessionId,{type:'compaction',ts:Date.now(),data:{stage:'started',reason:forceOverflowRecovery?'provider-context-overflow':'estimated-request-footprint-exceeded-budget',trigger,before,compactionTargetTokens,epoch:contextEpoch}})

      const reductionMessageBudget=Math.max(64,liveMessageBudget-checkpointNoticeBudget)
      const messageCountBefore=messages.length
      const beforeMicro=messages.map(message=>({...message,tool_calls:message.tool_calls?.map(call=>({...call,function:{...call.function}}))}))
      const lifecycleRecords=toolLifecycle.snapshot()
      const refs=new Map(lifecycleRecords.filter(record=>Boolean(record.outputReference)).map(record=>[record.callId,record.outputReference!] as const))
      const protectedCallIds=new Set(lifecycleRecords
        .filter(record=>record.state!=='completed'||record.outcome!=='success')
        .map(record=>record.callId))
      const clearableToolNames=new Set(this.tools.list()
        .filter(tool=>tool.risk==='read'&&tool.readOnly===true)
        .map(tool=>tool.name))
      const micro=microPruneToolResults(messages,reductionMessageBudget,{preserveRecentTurns:2,minToolTokens:32,references:refs,clearableToolNames,protectedCallIds})
      if(micro.pruned>0){
        messages.splice(0,messages.length,...micro.messages)
        activeCheckpointProjection=nonSystemMessages(messages)
        const afterPruneAccounting=accountContext(messages,schemas)
        const afterPruneTokens=estimateRequestFootprint(afterPruneAccounting,extraTokens)
        if(afterPruneTokens+Math.ceil(checkpointNoticeBudget*providerTokenRatio)<=compactionTargetTokens){
          const loaded=await this.sessions.load(input.sessionId)
          const lifecycle=toolLifecycle.snapshot()
          const machine=machineStateFromRuntime({sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,summaryRevision,messages:nonSystemMessages(messages),readStates:readFileStateSnapshot(),exploration:explorationState.snapshot(),toolLifecycle:lifecycle,workflow:workflow?.state,todo:currentTodoItems,mutations:mutationEvidenceFromLifecycle(lifecycle),evidenceLedger:await buildLedger(lifecycle),loadedSkills:persistedLoadedSkills,instructions:instructionReferences,answeredQuestions:persistedQuestionAnswers,continuation:{lastUserPrompt:input.prompt,nextAction:workflow?.state?.lastProgress}})
          const data={version:1,id:machine.checkpointId,sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,projectionHash:machine.projectionHash,summaryRevision,summary:checkpointSummary,messages:nonSystemMessages(messages),machineState:machine,stage:'micro-prune',createdAt:Date.now()}
          await this.sessions.saveContextCheckpoint(input.sessionId,data)
          upsertCheckpointNotice(machine,[])
          startProviderUsageCalibrationEpoch()
          const afterAccounting=accountContext(messages,schemas)
          const after=snapshot(messages.length,afterAccounting,extraTokens)
          if(after.estimatedRequestTokens>budget.usableTokens) throw new Error(`Context checkpoint notice exceeds the configured context budget (${after.estimatedRequestTokens} estimated request tokens > ${budget.usableTokens} usable tokens)`)
          await this.sessions.append(input.sessionId,{type:'compaction',ts:Date.now(),data:{stage:'micro-prune',reason:forceOverflowRecovery?'provider-context-overflow':'estimated-request-footprint-exceeded-budget',trigger,method:'safe-read-only-tool-result-prune',before,after,prunedToolResults:micro.pruned,savedTokens:micro.savedTokens,removedMessages:0,retainedMessages:messages.length,epoch:contextEpoch}})
          this.onStatus?.(`micro-pruned ${micro.pruned} older read-only tool result(s); ${before.estimatedRequestTokens} → ${after.estimatedRequestTokens} estimated tokens (${after.headroomTokens} headroom; ${trigger})`)
          input.onContextEstimate?.(after.estimatedRequestTokens,budget.maxContextTokens)
          return
        }
      }

      const c=compactMessages(beforeMicro,reductionMessageBudget,{maxOutputTokens:0,threshold:1,reserveTokens:0,recentTokens:Math.min(budget.recentTokens,Math.max(96,Math.floor(reductionMessageBudget*0.38)))},{activeObjective:input.prompt,todo:activeTodoItems(currentTodoItems),completionState:currentTodoItems.length?`${currentTodoItems.filter(item=>item.status==='done').length}/${currentTodoItems.length} todo items complete`:'no explicit todo list'})
      messages.splice(0,messages.length,...c.messages)
      activeCheckpointProjection=nonSystemMessages(messages)
      contextEpoch+=1
      summaryRevision+=1
      checkpointSummary=c.summary
      readFileState.noteCompaction()
      const readEvidenceBudget=Math.min(24_000,Math.max(600,Math.floor(budget.usableTokens*0.05)))
      const readEvidenceFiles=Math.min(64,Math.max(5,Math.floor(budget.usableTokens/1_500)))
      const readEvidence=await readFileState.rehydrateContextEvidence(readEvidenceBudget,readEvidenceFiles)
      const loaded=await this.sessions.load(input.sessionId)
      const compactedMessageTokens=estimateMessagesTokens(messages)
      if(compactedMessageTokens>reductionMessageBudget) throw new Error(`Conversation still exceeds the staged compaction budget after compaction (${compactedMessageTokens} estimated message tokens > ${reductionMessageBudget})`)
      const lifecycle=toolLifecycle.snapshot()
      const machine=machineStateFromRuntime({sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,summaryRevision,messages:nonSystemMessages(messages),readStates:readFileStateSnapshot(),exploration:explorationState.snapshot(),toolLifecycle:lifecycle,workflow:workflow?.state,todo:currentTodoItems,mutations:mutationEvidenceFromLifecycle(lifecycle),evidenceLedger:await buildLedger(lifecycle),loadedSkills:persistedLoadedSkills,instructions:instructionReferences,answeredQuestions:persistedQuestionAnswers,continuation:{lastUserPrompt:input.prompt,nextAction:workflow?.state?.lastProgress}})
      const checkpoint={version:1,id:machine.checkpointId,sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,projectionHash:machine.projectionHash,summaryRevision,summary:c.summary,messages:nonSystemMessages(messages),machineState:machine,stage:'full-compaction',createdAt:Date.now()}
      await this.sessions.saveContextCheckpoint(input.sessionId,checkpoint)
      upsertCheckpointNotice(machine,readEvidence)
      startProviderUsageCalibrationEpoch()
      const afterAccounting=accountContext(messages,schemas)
      const after=snapshot(messages.length,afterAccounting,extraTokens)
      if(after.estimatedRequestTokens>budget.usableTokens) throw new Error(`Conversation still exceeds the configured context budget after checkpoint projection (${after.estimatedRequestTokens} estimated request tokens > ${budget.usableTokens} usable tokens)`)
      await this.sessions.append(input.sessionId,{type:'compaction',ts:Date.now(),data:{removed:c.removed,tokens:after.estimatedRequestTokens,messageTokens:after.messageTokens,schemaTokens:after.toolSchemaTokens,summary:c.summary,budget,workflow:workflow?.state,readState:readFileState.contextSnapshot(8),stage:'full-compaction',reason:forceOverflowRecovery?'provider-context-overflow':'estimated-request-footprint-exceeded-budget',trigger,method:'summary-compaction',before,after,messagesBefore:messageCountBefore,messagesAfter:messages.length,removedMessages:c.removed,prunedToolResults:micro.pruned,savedTokens:micro.savedTokens,retainedMessages:messages.length,epoch:contextEpoch,summaryRevision}})
      this.onStatus?.(`compacted context (${c.removed} messages removed; ${before.estimatedRequestTokens} → ${after.estimatedRequestTokens} estimated tokens; ${after.headroomTokens} headroom; ${trigger}; epoch ${contextEpoch})`)
      input.onContextEstimate?.(after.estimatedRequestTokens,budget.maxContextTokens)
    }

    const refreshActiveRouteContext=async()=>{
      const role=input.specialistRole ? 'subagent' : workflow?.state.phase ? roleForPhase(workflow.state.phase) : mode
      this.provider.setRole?.(role)
      this.provider.setTurnContext?.({userText:input.prompt||'',turnNumber:turnNumberHint})
      const activeConfig=this.provider.getActiveConfig?.()||this.provider.config
      const nextLimits=resolveContextLimits({providerConfig:activeConfig,configuredContextWindow:this.maxContextTokens>0?this.maxContextTokens:undefined})
      const changed=nextLimits.provider!==resolvedLimits.provider
        || nextLimits.model!==resolvedLimits.model
        || nextLimits.contextWindow!==resolvedLimits.contextWindow
        || nextLimits.maxOutputTokens!==resolvedLimits.maxOutputTokens
        || nextLimits.contextSource!==resolvedLimits.contextSource
        || nextLimits.outputSource!==resolvedLimits.outputSource
      if(!changed)return false
      const previous=resolvedLimits
      resolvedLimits=nextLimits
      budget=createContextBudget({maxContextTokens:resolvedLimits.contextWindow,maxOutputTokens:resolvedLimits.maxOutputTokens,...this.contextOptions})
      const schemas=buildSchemas()
      providerUsageBaseline=undefined
      recentRatios=[]
      providerTokenRatio=1
      rawMessageBudget=Math.max(256,Math.floor((budget.usableTokens-schemas.estimatedTokens)/providerTokenRatio))
      checkpointNoticeBudget=Math.min(48_000,Math.max(64,Math.floor(rawMessageBudget*0.08)))
      restoreNoticeBudget=latestMachineState ? checkpointNoticeBudget : 0
      messageBudget=Math.max(128,rawMessageBudget-restoreNoticeBudget)
      const systemMessage=messages.find(message=>message.role==='system')
      if(systemMessage)systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${effectiveInstructions}`,input.repositoryContext,renderSkillContext(),autonomous,mode,messageBudget,input.explicitSkill,restoredSkillContext)
      if(latestMachineState){
        const readEvidenceBudget=Math.min(24_000,Math.max(600,Math.floor(budget.usableTokens*0.05)))
        const readEvidenceFiles=Math.min(64,Math.max(5,Math.floor(budget.usableTokens/1_500)))
        restoredReadEvidence=await readFileState.rehydrateContextEvidence(readEvidenceBudget,readEvidenceFiles)
        if(contextNoticeMessage)contextNoticeMessage.content=checkpointNotice(checkpointSummary,latestMachineState,restoredReadEvidence,checkpointNoticeBudget)
      }
      this.onStatus?.(`context route changed: ${previous.provider}/${previous.model} (${previous.contextWindow.toLocaleString()} tokens) → ${nextLimits.provider}/${nextLimits.model} (${nextLimits.contextWindow.toLocaleString()} tokens; ${nextLimits.contextSource})`)
      await maybeCompact(0,'route-change')
      return true
    }

    const turnNumberHint=messages.length+1
    const turn=await this.sessions.beginTurn(input.sessionId,input.cwd,messages,input.prompt)
    const deliverTaskNotification=async(notification:any)=>{
      const status=String(notification?.status||'completed')
      const summary=String(notification?.summary||'No completion summary was recorded.').trim()
      const taskId=String(notification?.taskId||'unknown')
      const childSessionId=notification?.childSessionId?String(notification.childSessionId):''
      const outputPath=notification?.outputPath?String(notification.outputPath):''
      const noteParts=[`<task-notification id="${taskId}" state="${status}">`,summary,childSessionId?`child_session=${childSessionId}`:'',outputPath?`output_path=${outputPath}`:'','</task-notification>'].filter(Boolean)
      const message:ChatMessage={role:'user',content:noteParts.join('\n')}
      messages.push(message)
      await this.sessions.appendMessage(input.sessionId,message,turn.id)
    }
    const notifications=await this.sessions.consumeTaskNotifications(input.sessionId)
    for(const notification of notifications){ await deliverTaskNotification(notification) }
    const toolLifecycle=new ToolCallLifecycle(this.sessions)
    await toolLifecycle.recoverUnsettled(input.sessionId)
    const appendProviderTurn=async(round:number,state:'started'|'tool_settling'|'completed'|'error'|'interrupted',extra:Record<string,unknown>={})=>{
      await this.sessions.append(input.sessionId,{type:'provider.turn',ts:Date.now(),data:{sessionId:input.sessionId,turnId:turn.id,round,state,...extra}})
    }
    const reloadDurableTurnHistory=async()=>{
      const loaded=await this.sessions.load(input.sessionId)
      const systemMessage=messages.find(m=>m.role==='system')
      const turnMessages=loaded.events
        .filter((event:any)=>event.type==='message' && event.data?.turnId===turn.id)
        .map((event:any)=>event.data.message as ChatMessage)
      const committed=activeCheckpointProjection ? activeCheckpointProjection.slice() : loaded.messages.filter(m=>m.role!=='system')
      messages.splice(0,messages.length,...(systemMessage?[systemMessage]:[]),...committed,...turnMessages)
      if(contextNoticeMessage){ messages.splice(1,0,contextNoticeMessage) }
    }
    const controller=new AbortController()
    let removeInputAbortListener: (()=>void)|undefined
    if(input.signal){
      const forwardAbort=()=>{ if(!controller.signal.aborted) controller.abort(input.signal?.reason) }
      if(input.signal.aborted) forwardAbort()
      else { input.signal.addEventListener('abort',forwardAbort,{once:true}); removeInputAbortListener=()=>input.signal?.removeEventListener('abort',forwardAbort) }
    }
    if(this.hookManager){
      await this.hookManager.emit({event:'SessionStart',cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}).catch(e=>this.onStatus?.(`plugin hook error: ${e instanceof Error?e.message:String(e)}`))
      await this.hookManager.emit({event:'UserPromptSubmit',cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}).catch(e=>this.onStatus?.(`plugin hook error: ${e instanceof Error?e.message:String(e)}`))
    }
    // Smart routing was primed before resolving the context budget above. Keep
    // the durable turn number authoritative once the session has allocated it.
    this.provider.setTurnContext?.({userText:input.prompt||'',turnNumber:turn.beforeMessageCount+1})
    const routed=(this.provider as any).routingDecision?.()
    if(routed) this.onStatus?.(`model route: ${routed.complexity} → ${routed.model} (${routed.reason})`)
    if(workflow) { workflow.state={...workflow.state,lastProgress:'autonomous turn started'}; await persistWorkflow() }
    if(input.prompt){
      const user:ChatMessage={role:'user',content:input.prompt};messages.push(user);await this.sessions.appendMessage(input.sessionId,user,turn.id)
      if(skillDiscoveryEnabled){
        await recordSkillDiscovery('user_input',input.prompt)
        const systemMessage=messages.find(m=>m.role==='system')
        if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${effectiveInstructions}`,input.repositoryContext,renderSkillContext(),autonomous,mode,messageBudget,input.explicitSkill,restoredSkillContext)
      } else if(input.explicitSkill){
        const systemMessage=messages.find(m=>m.role==='system')
        if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${effectiveInstructions}`,input.repositoryContext,'(automatic skill discovery suppressed for explicit skill invocation)',autonomous,mode,messageBudget,input.explicitSkill,restoredSkillContext)
      }
    }
    const hasLimit=this.maxRounds>0 || rounds>0 || enforcedAutonomous
    const configuredLimit=enforcedAutonomous ? Math.max(1,Number(process.env.TERMAGENT_AUTONOMOUS_MAX_STEPS||40)) : Number.MAX_SAFE_INTEGER
    const maxSteps=hasLimit ? Math.min(this.maxRounds>0?this.maxRounds:Number.MAX_SAFE_INTEGER,rounds>0?rounds:Number.MAX_SAFE_INTEGER,configuredLimit) : Number.MAX_SAFE_INTEGER
    let resultText=''
    let turnError: unknown
    let semanticTrackingActive=Boolean(workflow)
    let explorationInterventionNotice: ChatMessage|undefined
    let explorationStopNotice: string|undefined
    let lastSemanticProgressFingerprint=semanticProgressFingerprint({
      exploration:explorationState.snapshot(),
      todos:currentTodoItems,
      workflow:workflow?.state,
      toolLifecycle:[],
      mutations:[],
    })

    try {
      await maybeCompact(0,'turn-entry')
      if(input.prompt){const lastUser=[...messages].reverse().find(m=>m.role==='user');if(!lastUser||lastUser.content!==input.prompt) throw new Error('Current user prompt could not be preserved within the configured context budget')}

      let overflowRecoveryUsed=false
      let overflowRecoveryRounds=0
      for(let round=0;round<maxSteps+overflowRecoveryRounds;round++){
        if(round>0){
          // Parent-orchestration wakeup (TODO 14I items 1–4): child tasks that
          // settle while this turn is active are delivered into the running
          // turn at the next round boundary instead of waiting for the next
          // user prompt. consumeTaskNotifications is idempotent (durable
          // task.notification.consumed markers) and race-safe under the
          // session lock, so active-turn delivery cannot double-report.
          const wakeups=await this.sessions.consumeTaskNotifications(input.sessionId).catch(()=>[])
          for(const notification of wakeups){ await deliverTaskNotification(notification) }
        }
        await refreshActiveRouteContext()
        workflow?.assertProgressAllowed()
        await persistWorkflow()
        const phase=workflow?.state.phase
        const forcedFinal=hasLimit && round===maxSteps-1
        const completeOrBlocked=phase==='complete'||phase==='blocked'
        const finalStep=forcedFinal||completeOrBlocked||Boolean(loopStopReason)||Boolean(completionRequested)
        const finalNotice=loopStopReason
          ? `${explorationStopNotice ? `${explorationStopNotice}\n\n` : ''}Loop safety stop: ${loopStopReason}. Do not make additional tool calls. Re-check the original request mentally and respond with a concise summary of what was completed and anything that remains.`
          : 'Tool budget reached for this turn. Do not call tools. Respond with a concise summary of the work completed, verification performed, and any remaining work.'
        const executionInstruction=finalStep ? `${finalNotice}${workflow ? `\nCurrent execution state: ${workflowSummary(workflow.state)}` : ''}` : workflow ? `${workflow.reminder()}\nCurrent execution state: ${workflowSummary(workflow.state)}` : ''
        const requestSchemaResult=finalStep ? ({ tools: [], originalTokens: 0, estimatedTokens: 0, dropped: [] } as ReturnType<typeof buildSchemas>) : buildSchemas()
        const requestTools=requestSchemaResult.tools
        const availableToolNames=requestTools.map(tool=>String(tool.function?.name||'')).filter(Boolean)
        const shouldRenderExplorationGuidance = !finalStep && (mode === 'explore' || (round > 0 && semanticTrackingActive) || Boolean(explorationInterventionNotice))
        const explorationGuidanceText = shouldRenderExplorationGuidance
          ? renderExplorationGuidance({
              prompt: input.prompt || '',
              availableTools: availableToolNames,
              state: (() => {
                const snapshot=explorationState.snapshot()
                const telemetry=explorationTelemetry.snapshot()
                return {
                  discoveredFiles: snapshot.discoveredFiles.length,
                  coveredRanges: snapshot.files.reduce((total,file)=>total+file.coveredRanges.length,0),
                  searchObservations: snapshot.searches.length,
                  symbols: snapshot.symbols.length,
                  verificationFacts: snapshot.settledVerificationFacts?.length ?? 0,
                  progressRevision: snapshot.progressRevision,
                  noProgressRounds: telemetry.noProgressRounds,
                  lastProgress: snapshot.lastProgress,
                }
              })(),
            })
          : ''
        let requestMessages:ChatMessage[]=messages
        if(explorationGuidanceText) requestMessages=[...requestMessages,{role:'system',content:truncateToTokenBudget(explorationGuidanceText,128)} as ChatMessage]
        if(explorationInterventionNotice && !finalStep) requestMessages=[...requestMessages,explorationInterventionNotice]
        if(executionInstruction){
          const availableForNotice=Math.max(0,budget.usableTokens-accountContext(requestMessages,requestTools).total)
          const notice=truncateToTokenBudget(executionInstruction,availableForNotice)
          if(notice.trim()) requestMessages=[...requestMessages,{role:'system',content:notice} as ChatMessage]
        }
        let accounting=accountContext(requestMessages,requestTools)
        let requestTokens=estimateRequestFootprint(accounting)
        let providerTokenCount: import('../providers/types.js').ProviderTokenCount | undefined
        const countProviderInput = async () => {
          if (!this.provider.countTokens) return undefined
          try {
            return await this.provider.countTokens(requestMessages, requestTools, controller.signal)
          } catch (error) {
            const status = Number((error as { status?: unknown })?.status)
            if (controller.signal.aborted || status === 401 || status === 403) throw error
            this.onStatus?.(`provider-native token count unavailable; using conservative local estimate (${String((error as Error)?.message || error).slice(0, 120)})`)
            return undefined
          }
        }
        // Native count endpoints add a network round trip, so use them only
        // when the local request estimate is close enough to the budget for
        // tokenizer/framing drift to change the compaction decision.
        const nativeCountThreshold = Math.ceil(budget.usableTokens * 0.72)
        if (requestTokens >= nativeCountThreshold && this.provider.countTokens) {
          providerTokenCount = await countProviderInput()
          if (providerTokenCount) requestTokens = estimateRequestFootprint(accounting,0,providerTokenCount)
        }
        if(requestTokens>budget.usableTokens){
          const baseRequestTokens=accountContext(messages,requestTools).total
          const additionalRequestTokens=Math.max(0,accounting.total-baseRequestTokens)
          await maybeCompact(additionalRequestTokens,'provider-request',providerTokenCount)

          requestMessages=messages
          if(explorationGuidanceText) requestMessages=[...requestMessages,{role:'system',content:truncateToTokenBudget(explorationGuidanceText,128)} as ChatMessage]
          if(explorationInterventionNotice && !finalStep) requestMessages=[...requestMessages,explorationInterventionNotice]
          if(executionInstruction){
            const availableForNotice=Math.max(0,budget.usableTokens-accountContext(requestMessages,requestTools).total)
            const notice=truncateToTokenBudget(executionInstruction,availableForNotice)
            if(notice.trim()) requestMessages=[...requestMessages,{role:'system',content:notice} as ChatMessage]
          }
          accounting=accountContext(requestMessages,requestTools)
          requestTokens=estimateRequestFootprint(accounting)
          if (providerTokenCount) {
            const afterCompactionCount = await countProviderInput()
            providerTokenCount = afterCompactionCount
            if (afterCompactionCount) requestTokens = estimateRequestFootprint(accounting,0,afterCompactionCount)
          }
          if(requestTokens>budget.usableTokens){
            const measured = providerTokenCount ? `; providerCount=${providerTokenCount.inputTokens} (${providerTokenCount.source})` : ''
            throw new Error(`Request still exceeds the configured context budget after tool/schema bounding (${requestTokens} estimated/provider-counted request tokens > ${budget.usableTokens}; toolDefinitions=${accounting.toolDefinitions},toolCalls=${accounting.toolCalls},toolResults=${accounting.toolResults}${measured})`)
          }
        }
        let text='';let reasoning='';const calls:any[]=[]
        const textEncodedCalls:any[]=[]
        const parserTools: ReturnType<ToolRegistry['list']> = finalStep
          ? this.tools.list()
          : requestTools.flatMap(tool => {
              const definition = this.tools.get(String(tool.function?.name || ''))
              return definition ? [definition] : []
            })
        const textToolCallParser = new XmlToolCallStreamParser(parserTools)
        const providerCalls=new Map<string,{providerExecuted:boolean;providerMetadata?:unknown}>()
        const providerResults=new Map<string,{output:string;error?:string;providerMetadata?:unknown}>()
        let providerUsage: import('../providers/types.js').ProviderUsage | undefined
        await appendProviderTurn(round,'started',{startedAt:Date.now()})
        // The browser and terminal need a useful stage while the provider is
        // thinking but has not emitted its first token yet. This is a status
        // label, not model reasoning or a fabricated reasoning transcript.
        // Keep a terminal safety intervention visible while the model writes
        // its required text-only wrap-up. Otherwise this generic stage label
        // overwrites the more useful loop-guard status just before `run` ends.
        if (!loopStopReason) this.onStatus?.('Thinking')
        try {
          await withRetry(async()=>{
            text='';reasoning='';calls.length=0;textEncodedCalls.length=0;providerCalls.clear();providerResults.clear();providerUsage=undefined;textToolCallParser.reset()
            for await(const ev of this.provider.stream(requestMessages,requestTools,controller.signal)){
              if(ev.type==='usage'){ providerUsage=ev.usage; continue }
              if(ev.type==='reasoning'){reasoning+=ev.delta;input.onReasoning?.(ev.delta)}
              if(ev.type==='text'){
                const parsedText=textToolCallParser.feed(ev.delta)
                if(parsedText.text){text+=parsedText.text;input.onText?.(parsedText.text)}
                if(parsedText.calls.length){ calls.push(...parsedText.calls); textEncodedCalls.push(...parsedText.calls) }
              }
              if(ev.type==='tool_call'){
                calls.push(ev.call)
                providerCalls.set(String(ev.call.id||''),{providerExecuted:Boolean(ev.providerExecuted),...(ev.providerMetadata!==undefined?{providerMetadata:ev.providerMetadata}: {})})
              }
              if(ev.type==='tool_result'){
                providerResults.set(String(ev.call.id||''),{output:ev.output,error:ev.error,...(ev.providerMetadata!==undefined?{providerMetadata:ev.providerMetadata}: {})})
              }
            }
            const finishedText=textToolCallParser.finish()
            if(finishedText.text){text+=finishedText.text;input.onText?.(finishedText.text)}
            if(finishedText.calls.length){ calls.push(...finishedText.calls); textEncodedCalls.push(...finishedText.calls) }
            if(!text.trim()&&!calls.length)throw new Error('Provider returned an empty model response')
          },{max:this.retryMax,signal:controller.signal,onRetry:x=>this.onStatus?.(`retry ${x.attempt}/${this.retryMax} in ${Math.ceil(x.delay/1000)}s: ${x.message}`)})
        } catch(error) {
          if((error as any)?.code==='PROVIDER_STREAM_IDLE') this.onStatus?.(String((error as Error).message||error))
          const interrupted=controller.signal.aborted
          const state=interrupted?'interrupted':'error'
          await appendProviderTurn(round,state,{endedAt:Date.now(),error:error instanceof Error?error.message:String(error)})
          if(interrupted){
            const normalized=new Error('Provider turn interrupted',{cause:error})
            ;(normalized as any).code='ABORT_ERR'
            throw normalized
          }
          if(!overflowRecoveryUsed && isProviderContextOverflowError(error)){
            overflowRecoveryUsed=true
            this.onStatus?.('provider rejected context size; compacting conversation and retrying once')
            await maybeCompact(0,'provider-request',undefined,true)
            overflowRecoveryRounds++
            continue
          }
          throw error
        }
        try {
          const xmlCallsThisRound = textEncodedCalls
          if(xmlCallsThisRound.length && !finalStep){
            this.onStatus?.(`recovered ${xmlCallsThisRound.length} text-encoded tool call${xmlCallsThisRound.length===1?'':'s'} from provider output`)
          } else if(xmlCallsThisRound.length && finalStep){
            this.onStatus?.(`ignored ${xmlCallsThisRound.length} text-encoded tool call${xmlCallsThisRound.length===1?'':'s'} because tool execution is disabled for this turn`)
            if(!text.trim()){
              text=loopStopReason ? `Turn stopped before another tool call: ${loopStopReason}.` : 'Tool execution is no longer available in this turn.'
              input.onText?.(text)
            }
          }
          const normalized=normalizeToolCalls(this.provider.id,turn.id,calls)
          calls.splice(0,calls.length,...normalized)
          if(!text.trim()&&!calls.length)throw new Error('Provider returned an empty model response')
        } catch(error) {
          await appendProviderTurn(round,'error',{endedAt:Date.now(),error:error instanceof Error?error.message:String(error)})
          throw error
        }

        const estimatedInputTokens=estimateMessagesTokens(requestMessages)
        const estimatedOutputTokens=estimateTokens(`${text}${reasoning}`)
        const separatelyReportedCacheTokens=providerUsage?.cacheTokensExcludedFromInput
          ? (providerUsage.cacheReadTokens||0)+(providerUsage.cacheWriteTokens||0)
          : 0
        const actualInputTokens=providerUsage ? providerUsage.inputTokens+separatelyReportedCacheTokens : estimatedInputTokens
        const actualOutputTokens=providerUsage?.outputTokens ?? estimatedOutputTokens
        // Provider-reported totalTokens is already the inclusive request total.
        // Anthropic has no native total field, so its adapter derives it from
        // input + output + separately reported cache counts. Do not add cache
        // counts again here (that previously double-counted Anthropic usage).
        const actualTotalTokens=providerUsage?.totalTokens!==undefined
          ? providerUsage.totalTokens
          : actualInputTokens+actualOutputTokens
        const nonCachedInputTokens=Math.max(0,actualInputTokens-(providerUsage?.cacheReadTokens||0)-(providerUsage?.cacheWriteTokens||0))
        const measuredContextTokens=providerUsage?.contextTokens??actualInputTokens
        const driftPercent=providerUsage?.inputTokens!==undefined ? Math.round(((measuredContextTokens-estimatedInputTokens)/Math.max(1,measuredContextTokens))*1000)/10 : undefined
        const usageReport=normalizeProviderUsageReport({
          inputTokens:actualInputTokens,
          contextTokens:providerUsage?.contextTokens,
          nonCachedInputTokens,
          outputTokens:actualOutputTokens,
          totalTokens:actualTotalTokens,
          estimated:!providerUsage,
          contextWindow:resolvedLimits.contextWindow,
          contextSource:resolvedLimits.contextSource,
          provider:resolvedLimits.provider,
          model:resolvedLimits.model,
          cacheReadTokens:providerUsage?.cacheReadTokens,
          cacheWriteTokens:providerUsage?.cacheWriteTokens,
          reasoningTokens:providerUsage?.reasoningTokens,
          toolUsePromptTokens:providerUsage?.toolUsePromptTokens,
          modalityTokens:providerUsage?.modalityTokens,
          estimateInputTokens:estimatedInputTokens,
          estimateRequestTokens:accounting.total,
          driftPercent,
          recordedAt:Date.now(),
        })
        if(usageReport){
          // Usage history is a compact, secret-free durable event. It is deliberately
          // separate from conversation messages so it never enters model context.
          try {
            await this.sessions.append(input.sessionId,{type:'provider.usage',ts:usageReport.recordedAt||Date.now(),data:{...usageReport,turnId:turn.id,round}})
          } catch(error) {
            this.onStatus?.(`provider usage history could not be saved: ${error instanceof Error?error.message.slice(0,160):'unknown session storage error'}`)
          }
          input.onUsage?.(usageReport)
          if(!usageReport.estimated && usageReport.provider===resolvedLimits.provider && usageReport.model===resolvedLimits.model && usageReport.contextWindow===resolvedLimits.contextWindow){
            const measured=usageReport.contextTokens??usageReport.inputTokens
            const sampleRatio=Math.max(1,Math.min(4,measured/Math.max(1,usageReport.estimateRequestTokens??accounting.total)))
            recentRatios=[...recentRatios.slice(-4),sampleRatio]
            const recent=[...recentRatios].sort((a,b)=>a-b)
            providerTokenRatio=recent[Math.floor(recent.length/2)]||1
            providerUsageBaseline={measuredTokens:measured,estimatedRequestTokens:usageReport.estimateRequestTokens??accounting.total,provider:usageReport.provider,model:usageReport.model,contextWindow:usageReport.contextWindow}
          }
        }
        // Real provider traces are opt-in and written outside the session store.
        // The trace contains exact prompts/tool schemas for a later clean replay;
        // it is never emitted to the daemon event stream or model context.
        try {
          await captureProviderTrace({
            sessionId:input.sessionId,
            turnId:turn.id,
            round,
            provider:resolvedLimits.provider,
            model:resolvedLimits.model,
            contextWindow:resolvedLimits.contextWindow,
            contextSource:resolvedLimits.contextSource,
            maxOutputTokens:resolvedLimits.maxOutputTokens,
            usableTokens:budget.usableTokens,
            messages:requestMessages,
            tools:requestTools,
            accounting,
            estimatedMessageTokens:estimatedInputTokens,
            providerTokenCount,
            providerUsage,
            assistantText:text,
            assistantReasoning:reasoning,
            assistantToolCalls:calls,
            recordedAt:usageReport?.recordedAt,
          })
        } catch(error) {
          this.onStatus?.(`provider trace capture failed: ${error instanceof Error?error.message.slice(0,160):'unknown trace error'}`)
        }
        const assistant:any={role:'assistant',content:text||null};if(reasoning)assistant.reasoning=reasoning;if(calls.length)assistant.tool_calls=calls
        messages.push(assistant);await this.sessions.appendMessage(input.sessionId,assistant,turn.id)

        if(finalStep && calls.length){
          const warningText=loopStopReason ? `ERROR: ${loopStopReason}. Tool calls are disabled for the remainder of this turn.` : 'ERROR: Tool calls are disabled after the workflow/step limit.'
          for(const call of calls){
            const parsed=parseToolArguments(call.function.arguments)
            const parsedArgs=parsed.ok?parsed.value:undefined
            const providerMeta=providerCalls.get(call.id)
            const lifecycleDefinition=this.tools.get(call.function.name)
            const provenance=providerMeta?.providerExecuted
              ? {kind:'provider-hosted' as const,provider:this.provider.id,model:this.provider.model}
              : lifecycleDefinition?.provenance
            await toolLifecycle.pending({sessionId:input.sessionId,turnId:turn.id,callId:call.id,name:call.function.name,argumentsRaw:call.function.arguments,parsedArguments:parsedArgs,providerExecuted:providerMeta?.providerExecuted,providerMetadata:providerMeta?.providerMetadata,kind:providerMeta?.providerExecuted?'provider-hosted':lifecycleDefinition?.kind,provenance,metadata:{finalStep:true}})
            await toolLifecycle.transition(call.id,{state:'error',outcome:'error',error:warningText})
            const warning:ChatMessage={role:'tool',tool_call_id:call.id,content:warningText,name:call.function.name}
            messages.push(warning);await this.sessions.appendMessage(input.sessionId,warning,turn.id);input.onToolResult?.(warning.name||'tool',warning.content||'',{toolLifecycle:{state:'error',outcome:'error'}})
          }
          await appendProviderTurn(round,'completed',{endedAt:Date.now(),finishReason:'tool_calls_blocked',toolCallIds:calls.map(call=>call.id)})
          await maybeCompact(0,'post-provider-response')
          resultText=text;break
        }

        let wroteFiles=false
        let meaningfulProgress=false
        const mutatedCallIds=new Set<string>()
        const mutatedToolNames=new Set<string>()
        const explorationRoundActions:{toolName:string;input:unknown;scope:{cwd:string;scopePaths?:readonly string[]}}[]=[]
        const runOne = async (call:any) => {
          const providerMeta=providerCalls.get(call.id)
          const lifecycleDefinition=this.tools.get(call.function.name)
          const provenance=providerMeta?.providerExecuted
            ? {kind:'provider-hosted' as const,provider:this.provider.id,model:this.provider.model}
            : lifecycleDefinition?.provenance
          await toolLifecycle.pending({sessionId:input.sessionId,turnId:turn.id,callId:call.id,name:call.function.name,argumentsRaw:typeof call.function.arguments==='string'?call.function.arguments:'',providerExecuted:providerMeta?.providerExecuted,providerMetadata:providerMeta?.providerMetadata,kind:providerMeta?.providerExecuted?'provider-hosted':lifecycleDefinition?.kind,provenance})
          const parsed=parseToolArguments(call.function.arguments)
          let args:any=parsed.ok?parsed.value:{}
          input.onTool?.(call.function.name,args,call.id)
          if(!parsed.ok){
            const error=new Error(parsed.error)
            return {call,args,output:`ERROR: ${parsed.error}`,metadata:undefined,workflowOnly:false,error,lifecycleState:'error',lifecycleOutcome:'error'}
          }
          if(call.function.name==='verify_project' && automaticVerificationSatisfied && args?.force!==true){
            const currentMutations=mutationEvidenceFromLifecycle(toolLifecycle.snapshot())
            if(mutationFingerprint(currentMutations)===automaticVerificationSatisfied.mutationFingerprint){
              const cached=automaticVerificationSatisfied.result
              const metadata={status:cached.status,ok:cached.ok,cached:true,verification:{status:cached.status,ok:cached.ok,settled:true,commandFingerprint:cached.commandFingerprint,facts:cached.ok?[`verify:${cached.status}:${cached.commandFingerprint||'cached'}`]:[]}}
              return {call,args,output:`AUTOMATIC VERIFICATION ALREADY ${cached.status.toUpperCase()} FOR THE CURRENT MUTATION BATCH. Use force=true only when an explicit verification rerun was requested.\n\n${cached.output}`,metadata,workflowOnly:false,error:undefined,definition:this.tools.get('verify_project'),lifecycleState:'completed',lifecycleOutcome:'success'}
            }
          }
          const loopCheck=loopGuard.check(call.function.name,args,{cwd:input.cwd,scopePaths:input.scopePaths})
          if(loopCheck.blocked){
            if(loopCheck.intervention==='constrain' && !loopCheck.stop){
              const error=new Error(loopCheck.reason||'exploration action constrained by loop safety')
              this.onStatus?.(`loop guard: constrained ${call.function.name} after repeated no-progress exploration`)
              return {call,args,output:`ERROR: ${error.message}`,metadata:{explorationIntervention:'constrain'},workflowOnly:false,error,lifecycleState:'error',lifecycleOutcome:'error'}
            }
            let repeatAllowed=false
            if(loopCheck.kind==='repeat' && !autonomous && input.onQuestion){
              try {
                const response=await input.onQuestion([{question:`The same ${call.function.name} tool call has been requested repeatedly. Repeat it once?`,header:'Repeat tool call?',options:[{label:'Repeat once',description:'Allow this identical call one more time.'},{label:'Stop',description:'Keep the loop-safety stop active.'}],multi:false,custom:false}])
                const answers=Array.isArray(response) ? response : response.answers
                const answer=String(answers?.[0]?.[0]??'').toLowerCase()
                repeatAllowed=response && !Array.isArray(response) ? response.status==='replied' && /repeat|continue|yes|allow/.test(answer) : /repeat|continue|yes|allow/.test(answer)
              } catch(error) {
                const classified=classifyToolError(error,controller.signal)
                return {call,args,output:`ERROR: ${classified.message}`,metadata:undefined,workflowOnly:false,error,lifecycleState:classified.state,lifecycleOutcome:classified.outcome}
              }
            }
            if(!repeatAllowed){
              loopStopReason=loopCheck.reason
              this.onStatus?.(`loop guard: ${loopCheck.reason}`)
              return {call,args,output:`ERROR: ${loopCheck.reason}. The tool call was blocked to prevent an execution loop.`,metadata:undefined,workflowOnly:false,error:new Error(loopCheck.reason),lifecycleState:'error',lifecycleOutcome:'error'}
            }
            loopGuard.allowRepeat()
            this.onStatus?.(`loop guard: confirmed repeat of ${call.function.name}`)
          }
          explorationRoundActions.push({toolName:call.function.name,input:args,scope:{cwd:input.cwd,scopePaths:input.scopePaths}})
          try{
            if(providerMeta?.providerExecuted){
              const providerResult=providerResults.get(call.id)
              if(!providerResult) throw new Error(`Provider-hosted tool '${call.function.name}' returned no provider result`)
              if(providerResult.error) throw new Error(providerResult.error)
              return {call,args,output:providerResult.output,metadata:{providerExecuted:true,providerMetadata:providerResult.providerMetadata},workflowOnly:false,error:undefined,definition:undefined,providerHosted:true,lifecycleState:'completed',lifecycleOutcome:'provider_hosted'}
            }
            await toolLifecycle.transition(call.id,{state:'running',startedAt:Date.now(),parsedArguments:args})
            if(workflow && call.function.name==='workflow_phase') {
              workflow.transitionTo(String(args.phase) as any,String(args.reason||'model requested transition'))
              meaningfulProgress=true
              const output=JSON.stringify(workflow.state)
              return {call,args,output,metadata:undefined,workflowOnly:true}
            }
            if(!toolAllowed(call.function.name)) throw new Error(`Tool '${call.function.name}' is not allowed by the active plugin/agent tool policy`)
            const definition=this.tools.get(call.function.name)
            if(!definition) throw new Error(`Unknown tool: ${call.function.name}`)
            if(workflow && !workflow.allowedTool(definition,true)) throw new Error(`Tool '${call.function.name}' is not allowed during autonomous ${workflow.state.phase} phase`)
            if(!allowWrite&&WRITE_TOOLS.has(call.function.name))throw new Error(`Agent mode '${mode}' is read-only`)
            if(!allowShell&&definition.risk==='shell')throw new Error(`Agent mode '${mode}' does not allow shell commands`)
            const instructionTargets=instructionTargetsForTool(call.function.name,args)
            const directoryPaths=['list_dir','glob','grep'].includes(call.function.name) ? instructionTargets : []
            const instructionBytesUsed=[...instructionFiles.values()].reduce((sum,file)=>sum+Buffer.byteLength(file.content,'utf8'),0)
            const remainingInstructionBytes=Math.max(0,instructionBudgetBytes-instructionBytesUsed)
            const scopedInstructions=remainingInstructionBytes>=1024
              ? await loadScopedInstructionFiles(input.cwd,instructionTargets,{maxBytes:remainingInstructionBytes,maxFileBytes:instructionFileBytes,directoryPaths})
              : {files:[],text:'',totalBytes:0,truncated:true}
            const newlyLoadedInstructions=scopedInstructions.files.filter(file=>{
              const previous=instructionFiles.get(file.path)
              return !previous || previous.sha256!==file.sha256
            })
            if(newlyLoadedInstructions.length){
              for(const file of newlyLoadedInstructions) instructionFiles.set(file.path,file)
              effectiveInstructions=[...instructionFiles.values()].map(file=>`## ${file.relativePath}\n${file.content}`).concat(input.instructions && !effectiveInstructions.includes(input.instructions) ? [input.instructions] : []).join('\n\n')
              instructionReferences.splice(0,instructionReferences.length,...[...instructionFiles.values()].map(file=>({path:file.path,sha256:file.sha256,scope:file.scope})))
              const eventFiles=newlyLoadedInstructions.map(file=>({path:file.path,sha256:file.sha256,scope:file.scope,mtimeMs:file.mtimeMs,size:file.size}))
              await this.sessions.append(input.sessionId,{type:'context.instructions',ts:Date.now(),data:{action:'loaded',reason:'path-scope',tool:call.function.name,files:eventFiles}} as any)
              const systemMessage=messages.find(message=>message.role==='system')
              if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${effectiveInstructions}`,input.repositoryContext,renderSkillContext(),autonomous,mode,messageBudget,input.explicitSkill,restoredSkillContext)
              const loadedNames=newlyLoadedInstructions.map(file=>file.relativePath).join(', ')
              return {call,args,output:`Scoped project instructions were loaded before this operation: ${loadedNames}. The requested tool operation was intentionally deferred and was NOT executed. Read and follow these instructions, then issue the required tool call again.`,metadata:{instructionDeferred:true,loadedInstructions:eventFiles},workflowOnly:false,error:undefined,lifecycleState:'completed',lifecycleOutcome:'deferred'}
            }
            if(this.hookManager){ await this.hookManager.emit({event:'PreToolUse',toolName:call.function.name,toolArgs:args,cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}) }
            let result
            try {
              result=await this.tools.execute(call.function.name,args,{sessionID:input.sessionId,agent:mode,cwd:input.cwd,abort:controller.signal,toolCallId:call.id,scopePaths:input.scopePaths,taskId:input.taskId,delegationDepth:input.delegationDepth,specialistRole:input.specialistRole,questioner:input.onQuestion,readFileState,contextWindow:budget.maxContextTokens})
              if(controller.signal.aborted && !result?.metadata?.background) throw new Error('Tool execution interrupted')
            }
            catch(e){
              if(this.hookManager && /permission denied/i.test(e instanceof Error ? e.message : String(e))){ await this.hookManager.emit({event:'PermissionDenied',toolName:call.function.name,toolArgs:args,error:e instanceof Error?e.message:String(e),cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}).catch(hookError=>this.onStatus?.(`plugin hook error: ${hookError instanceof Error?hookError.message:String(hookError)}`)) }
              throw e
            }
            if(this.hookManager){
              await this.hookManager.emit({event:'PostToolUse',toolName:call.function.name,toolArgs:args,toolOutput:result.output,cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}).catch(hookError=>this.onStatus?.(`plugin hook error: ${hookError instanceof Error?hookError.message:String(hookError)}`))
              if(WRITE_TOOLS.has(call.function.name)){ const filePath=typeof args?.path==='string'?args.path:undefined; await this.hookManager.emit({event:'FileChanged',toolName:call.function.name,toolArgs:args,toolOutput:result.output,filePath,cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}).catch(hookError=>this.onStatus?.(`plugin hook error: ${hookError instanceof Error?hookError.message:String(hookError)}`)) }
            }
            return {call,args,output:result.output,metadata:result.metadata,workflowOnly:false,definition,error:undefined,lifecycleState:'completed',lifecycleOutcome:'success'}
          }catch(e){
            if(this.hookManager){ await this.hookManager.emit({event:'PostToolUseFailure',toolName:call.function.name,toolArgs:args,error:e instanceof Error?e.message:String(e),cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}).catch(hookError=>this.onStatus?.(`plugin hook error: ${hookError instanceof Error?hookError.message:String(hookError)}`)) }
            const classified=classifyToolError(e,controller.signal)
            return {call,args,output:`ERROR: ${classified.message}`,metadata:undefined,workflowOnly:false,error:e,lifecycleState:classified.state,lifecycleOutcome:classified.outcome}
          }
        }
        const settle = async (item:any) => {
          const {call,args,output,metadata,workflowOnly,error:toolError}=item
          const preserveOutput=Boolean(metadata?.preserveOutput) || ['use_skill','skill'].includes(call.function.name)
          const currentContextTokens=estimateMessagesTokens(messages)
          const requestHeadroom=Math.max(256,budget.usableTokens-currentContextTokens-requestSchemaResult.estimatedTokens)
          const previewTokens=Math.max(256,Math.min(1800,Math.floor(requestHeadroom*0.30)))
          const previewBytes=Math.max(1024,Math.min(this.toolOutputStore.limits().maxBytes,previewTokens*4))
          const bound=preserveOutput
            ? {text:output,truncated:false,persisted:false,totalBytes:Buffer.byteLength(output,'utf8'),totalLines:output?output.split('\n').length:0,contentHash:'',previewBytes:Buffer.byteLength(output,'utf8'),previewLines:output?output.split('\n').length:0,previewStrategy:'complete' as const}
            : await this.toolOutputStore.bind({sessionId:input.sessionId,toolCallId:call.id,text:output,metadata},{maxBytes:previewBytes,maxLines:Math.max(64,Math.min(this.toolOutputStore.limits().maxLines,Math.floor(previewTokens/2)))})
          const storedOutput=bound.text
          const lifecycleState=item.lifecycleState || (toolError?'error':'completed')
          const lifecycleOutcome=item.lifecycleOutcome || (toolError?'error':'success')
          const outputReference='reference' in bound ? bound.reference : undefined
          const outputPath='outputPath' in bound ? bound.outputPath : undefined
          await toolLifecycle.transition(call.id,{state:lifecycleState,outcome:lifecycleOutcome,metadata,outputReference,outputPath,error:toolError ? String((toolError as Error).message || toolError) : undefined,parsedArguments:args,providerExecuted:providerCalls.get(call.id)?.providerExecuted,providerMetadata:providerCalls.get(call.id)?.providerMetadata})
          const msg:ChatMessage={role:'tool',tool_call_id:call.id,content:storedOutput,name:call.function.name}
          messages.push(msg)
          await this.sessions.appendMessage(input.sessionId,msg,turn.id)
          input.onToolResult?.(call.function.name,output,{...metadata,toolOutput:bound,toolLifecycle:{state:lifecycleState,outcome:lifecycleOutcome,callId:call.id,turnId:turn.id,providerExecuted:Boolean(providerCalls.get(call.id)?.providerExecuted)}})
          const explorationObservation = toolError
            ? { meaningful:false, reason:metadata?.explorationIntervention === 'constrain' ? 'exploration action was constrained before execution' : 'tool execution failed before producing exploration evidence', newFiles:[], newRanges:[], newSearch:false, overlap:false, evidence:{newFiles:[],newRanges:[],reconstructedRanges:[],novelSearchResults:0,newSymbols:[],settledVerificationFacts:[]} }
            : explorationState.observeTool(call.function.name,args,metadata)
          explorationTelemetry.recordCall({
            toolName:call.function.name,
            input:args,
            scope:{cwd:input.cwd,scopePaths:input.scopePaths},
            observation:explorationObservation,
          })
          publishExplorationTelemetry()
          if (explorationObservation.reason !== 'tool is not exploration-tracked') semanticTrackingActive=true
          if (containsSemanticMetadata(metadata)) semanticTrackingActive=true
          if (explorationObservation.meaningful) meaningfulProgress=true
          if(!toolError && ['skill','use_skill'].includes(call.function.name) && metadata?.skill){
            const skillInfo=metadata.skill as any
            const exists=persistedLoadedSkills.some(item=>item.id===String(skillInfo.id))
            if(!exists) persistedLoadedSkills.push({id:String(skillInfo.id),sha256:typeof skillInfo.sha256==='string'?skillInfo.sha256:undefined,path:typeof skillInfo.path==='string'?skillInfo.path:undefined})
            await this.sessions.append(input.sessionId,{type:'skill.load',ts:Date.now(),data:{action:'load',id:String(skillInfo.id),sha256:skillInfo.sha256,path:skillInfo.path,source:'tool'}} as any)
            try{
              const loaded=await loadSkill(input.cwd,String(skillInfo.id))
              if(!skillInfo.sha256 || loaded.sha256===skillInfo.sha256){
                loadedSkillContents.set(loaded.descriptor.id,boundSkillContent(loaded.content,Math.max(128,Math.floor(budget.explicitSkillTokens/Math.max(1,loadedSkillContents.size+1)))))
                restoredSkillContext=[...loadedSkillContents.entries()].map(([id,content])=>`<restored_skill id="${id}">\n${content}\n</restored_skill>`).join('\n\n')
                const systemMessage=messages.find(m=>m.role==='system')
                if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${effectiveInstructions}`,input.repositoryContext,renderSkillContext(),autonomous,mode,messageBudget,input.explicitSkill,restoredSkillContext)
              }
            }catch(error){ this.onStatus?.(`context: skill '${skillInfo.id}' was not added to restored instructions: ${String((error as Error).message||error).slice(0,180)}`) }
          }
          if(!toolError && call.function.name==='question' && metadata?.question){
            const q=metadata.question as any
            const priorIndex=persistedQuestionAnswers.findIndex(item=>item.requestId===String(q.requestId))
            const value={requestId:String(q.requestId),status:String(q.status||'replied'),answers:Array.isArray(q.answers)?q.answers.map((a:any)=>Array.isArray(a)?a.map(String):[]):[]}
            if(priorIndex>=0) persistedQuestionAnswers[priorIndex]=value; else persistedQuestionAnswers.push(value)
          }
          if(WRITE_TOOLS.has(call.function.name)&&!/^[\s]*error[\s]*:/i.test(output)){
            wroteFiles=true
            if(metadata?.mutation && typeof metadata.mutation==='object'){
              mutatedCallIds.add(call.id)
              mutatedToolNames.add(call.function.name)
            }
          }
          if(skillDiscoveryEnabled && !input.skillDiscoverySuppressed){
              const pivotValues:string[]=[]
              if(args && typeof args==='object'){
                for(const key of ['path','filePath','file','target']){
                  const value=(args as any)[key]
                  if(typeof value==='string' && value.trim()) pivotValues.push(value.trim())
                }
                if(Array.isArray((args as any).paths)) pivotValues.push(...(args as any).paths.filter((value:any)=>typeof value==='string').slice(0,8))
              }
              const pivotBits=[...pivotValues,call.function.name].filter(Boolean).join(' ') || input.prompt || ''
              await recordSkillDiscovery('write_pivot',pivotBits)
              const systemMessage=messages.find(m=>m.role==='system')
              if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${effectiveInstructions}`,input.repositoryContext,renderSkillContext(),autonomous,mode,messageBudget,input.explicitSkill,restoredSkillContext)
            }
          if(['background_agent','parallel_agents'].includes(call.function.name) && !toolError){ if(this.hookManager) await this.hookManager.emit({event:'SubagentStart',toolName:call.function.name,toolArgs:args,toolOutput:output,cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}).catch(e=>this.onStatus?.(`plugin hook error: ${e instanceof Error?e.message:String(e)}`)) }
          if(['background_agent','parallel_agents'].includes(call.function.name) && !toolError && skillDiscoveryEnabled && !input.skillDiscoverySuppressed){
            const delegated=typeof args==='object' ? JSON.stringify(args) : String(args||'')
            await recordSkillDiscovery('subagent_spawn',[input.prompt||'',delegated].filter(Boolean).join(' '))
            const systemMessage=messages.find(m=>m.role==='system')
            if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${effectiveInstructions}`,input.repositoryContext,renderSkillContext(),autonomous,mode,messageBudget,input.explicitSkill,restoredSkillContext)
          }
          if(call.function.name==='todo' && !toolError){
            try {
              const nextTodos=normalizeTodoItems(metadata?.todo?.new ?? JSON.parse(output))
              const changed=todoFingerprint(nextTodos)!==todoFingerprint(currentTodoItems)
              currentTodoItems=nextTodos
              input.onTodo?.(activeTodoItems(currentTodoItems))
              if(changed) meaningfulProgress=true
              if(nextTodos.length>0 && nextTodos.every(item=>item.status==='done') && !enforcedAutonomous) completionRequested='all explicit todo items are complete'
            } catch {}
          }
          if(workflow){
            if(workflowOnly){
              workflow.observeTool(call.function.name,args,output)
              await persistWorkflow()
              this.onStatus?.(`workflow ${workflow.state.phase}`)
            } else {
              if(call.function.name==='todo'){try{const todos=metadata?.todo?.new ?? JSON.parse(output);if(workflow.applyTodo(Array.isArray(todos)?todos:[])) meaningfulProgress=true}catch{}}
              workflow.observeTool(call.function.name,args,output,toolError ? {ok:false,status:'failed',metadata} : metadata)
              if(call.function.name==='todo' && !toolError && metadata?.todo?.verificationNudge && workflow.state.phase!=='verifying' && workflow.state.phase!=='complete'){
                workflow.transitionTo('verifying','All todo items are complete; deterministic verification is now required.')
              }
              await persistWorkflow()
              this.onStatus?.(`workflow ${workflow.state.phase}`)
            }
          }
        }

        await appendProviderTurn(round,'tool_settling',{toolCallIds:calls.map(call=>call.id),startedAt:Date.now()})
        for(let i=0;i<calls.length;){
          const firstDef=this.tools.get(calls[i]!.function.name)
          const batchable=Boolean(firstDef?.parallelSafe)&&(!workflow||workflow.allowedTool(firstDef!,true))
          const batch:any[]=[calls[i]!]
          if(batchable){
            let j=i+1
            while(j<calls.length&&batch.length<4){
              const def=this.tools.get(calls[j]!.function.name)
              if(!def?.parallelSafe|| (workflow&& !workflow.allowedTool(def,true))) break
              batch.push(calls[j]!);j++
            }
            if(batch.length>1){
              const results=await Promise.all(batch.map(runOne))
              for(const result of results) await settle(result)
              i=j
              continue
            }
          }
          const result=await runOne(calls[i]!)
          await settle(result)
          i++
        }

        const shouldRunPostEditVerification = [...mutatedToolNames].some(name => postEditVerification.tools.includes(name))
        if(mutatedCallIds.size && shouldRunPostEditVerification && postEditVerification.enabled && verificationManager){
          try {
            const preVerificationMutations=mutationEvidenceFromLifecycle(toolLifecycle.snapshot())
            const mutationRevision=mutationFingerprint(preVerificationMutations)
            const result=await runAutomaticPostEditVerification({
              config:postEditVerification,
              manager:verificationManager,
              context:{sessionID:input.sessionId,agent:mode,cwd:input.cwd,abort:controller.signal,scopePaths:input.scopePaths},
            })
            const verificationRecord:EvidenceLedgerVerification={
              tool:'verify_project',
              status:result.status,
              ok:result.ok,
              ...(result.exitCode===undefined?{}:{exitCode:result.exitCode}),
              ...(result.signal?{signal:result.signal}:{}),
              ...(result.termination?{termination:result.termination}:{}),
              ...(result.commandFingerprint?{commandFingerprint:result.commandFingerprint}:{}),
              ...(result.taskId?{taskId:result.taskId}:{}),
              ...(result.outputPath?{outputPath:result.outputPath}:{}),
              ...(result.outputBytes===undefined?{}:{outputBytes:result.outputBytes}),
              ...(result.outputTruncated===undefined?{}:{outputTruncated:result.outputTruncated}),
              source:'automatic',
            }
            automaticVerifications.push(verificationRecord)
            const statusLine=`AUTOMATIC VERIFICATION: ${result.status.toUpperCase()}${result.taskId?` (task ${result.taskId})`:''}`
            const verificationNotice = result.ok
              ? 'Verification passed. Do not call verify_project again for this mutation batch unless the user explicitly requests a rerun; use force=true for that explicit rerun.'
              : `Verification did not pass (${result.status}). Treat the result as the next iteration requirement.`
            messages.push({role:'system',content:`${statusLine}.\n${verificationNotice}`})
            await this.sessions.appendMessage(input.sessionId,messages[messages.length-1]!,turn.id)
            await this.sessions.append(input.sessionId,{type:'verification',ts:Date.now(),data:{status:result.status,ok:result.ok,source:'automatic',taskId:result.taskId,commandFingerprint:result.commandFingerprint,exitCode:result.exitCode,signal:result.signal,termination:result.termination,mutationFingerprint:mutationRevision}})
            const observation=explorationState.observeTool('verify_project',{}, {verification:{status:result.status,ok:result.ok,settled:true,commandFingerprint:result.commandFingerprint,facts:result.ok?[`verify:${result.status}:${result.commandFingerprint||'automatic'}`]:[]}})
            if(observation.meaningful) meaningfulProgress=true
            explorationTelemetry.recordCall({toolName:'verify_project',input:{automatic:true},scope:{cwd:input.cwd,scopePaths:input.scopePaths},observation})
            publishExplorationTelemetry()
            if(result.ok) automaticVerificationSatisfied={mutationFingerprint:mutationRevision,result}
            if(workflow){
              workflow.observeTool('verify_project',{},result.output,{status:result.status,ok:result.ok,verification:{status:result.status,ok:result.ok,settled:true}})
              await persistWorkflow()
            }
            this.onStatus?.(`automatic verification: ${result.status}`)
          } catch(error) {
            const message=error instanceof Error?error.message:String(error)
            const failed:EvidenceLedgerVerification={tool:'verify_project',status:'failed',ok:false,source:'automatic'}
            automaticVerifications.push(failed)
            await this.sessions.append(input.sessionId,{type:'verification',ts:Date.now(),data:{status:'failed',ok:false,source:'automatic',error:message}})
            messages.push({role:'system',content:`AUTOMATIC VERIFICATION: FAILED TO START. ${message}`})
            await this.sessions.appendMessage(input.sessionId,messages[messages.length-1]!,turn.id)
            if(workflow){workflow.observeTool('verify_project',{},`ERROR: ${message}`,{status:'failed',ok:false,verification:{status:'failed',ok:false,settled:true}});await persistWorkflow()}
            this.onStatus?.(`automatic verification failed to start: ${message}`)
          }
        }

        if(controller.signal.aborted){
          for(const record of toolLifecycle.snapshot().filter(record=>record.turnId===turn.id && (record.state==='pending'||record.state==='running'))){
            await toolLifecycle.transition(record.callId,{state:'interrupted',outcome:'interrupted',error:'Tool execution interrupted',endedAt:Date.now()})
          }
          await appendProviderTurn(round,'interrupted',{endedAt:Date.now(),toolCallIds:calls.map(call=>call.id),error:'Provider turn interrupted'})
          throw new Error('Provider turn interrupted')
        }

        await reloadDurableTurnHistory()
        await appendProviderTurn(round,'completed',{endedAt:Date.now(),toolCallIds:calls.map(call=>call.id)})

        if(!loopStopReason){
          const readOnlyRound=calls.length>0 && calls.every((call:any)=>{
            const name=String(call.function?.name||'')
            if(WRITE_TOOLS.has(name) || name==='workflow_phase') return false
            const definition=this.tools.get(name)
            return Boolean(definition?.risk==='read')
          })
          const readOnlyCheck=loopGuard.observeReadOnlyRound(readOnlyRound && !meaningfulProgress)
          if(readOnlyCheck.blocked){
            loopStopReason=readOnlyCheck.reason
            explorationTelemetry.setTerminationReason('loop-guard')
            publishExplorationTelemetry()
            if(workflow) workflow.state={...workflow.state,phase:'blocked',lastProgress:readOnlyCheck.reason}
            this.onStatus?.(`loop guard: ${readOnlyCheck.reason}`)
          }
        }

        const semanticFingerprint=semanticProgressFingerprint({
          exploration:explorationState.snapshot(),
          todos:currentTodoItems,
          mutations:mutationEvidenceFromLifecycle(toolLifecycle.snapshot()),
          toolLifecycle:toolLifecycle.snapshot(),
          workflow:workflow?.state,
        })
        const semanticProgress=lastSemanticProgressFingerprint !== undefined && semanticFingerprint!==lastSemanticProgressFingerprint
        if(semanticProgress) meaningfulProgress=true
        lastSemanticProgressFingerprint=semanticFingerprint

        // Semantic no-progress is an exploration/state-reasoning guard, not a
        // generic command-attempt limiter. Once exploration tracking has been
        // activated earlier in the turn, a later run of distinct shell/write
        // operations must not inherit the exploration stagnation streak.
        // Key repeated-call safety on the concrete tool and canonical input,
        // rather than treating unrelated operational calls as one repeated action.
        const operationalRound=calls.some((call:any)=>{
          const name=String(call.function?.name||'')
          if(WRITE_TOOLS.has(name)) return true
          return this.tools.get(name)?.risk==='shell'
        })
        if(!loopStopReason && semanticTrackingActive && !operationalRound){
          const semanticCheck=loopGuard.observeNoProgressRound(
            semanticFingerprint,
            semanticProgress,
            explorationInterventionToolActions(explorationRoundActions),
          )
          if(semanticCheck.intervention){
            const intervention=semanticCheck.intervention
            const notice=explorationInterventionMessage(
              intervention,
              explorationRoundActions,
              explorationState.snapshot(),
              semanticCheck.count,
            )
            explorationInterventionNotice={role:'system',content:notice}
            this.onStatus?.(`loop guard: ${intervention} after ${semanticCheck.count} no-progress round(s)`)
          }
          if(semanticCheck.blocked && semanticCheck.stop){
            const stopNotice=explorationInterventionMessage('stop',explorationRoundActions,explorationState.snapshot(),semanticCheck.count)
            explorationInterventionNotice={role:'system',content:stopNotice}
            explorationStopNotice=stopNotice
            loopStopReason=semanticCheck.reason
            explorationTelemetry.setTerminationReason('semantic-no-progress')
            publishExplorationTelemetry()
            if(workflow) workflow.state={...workflow.state,phase:'blocked',lastProgress:semanticCheck.reason}
            this.onStatus?.(`loop guard: ${semanticCheck.reason}`)
          }
        } else if(!loopStopReason && semanticTrackingActive && operationalRound){
          // Execution/tooling rounds do not count toward the exploration
          // stagnation streak. Preserve the fingerprint so the next eligible
          // round can still tell whether the repository state actually changed.
          loopGuard.resetSemanticNoProgress()
        }

        if(completionRequested && !loopStopReason) this.onStatus?.(`completion gate: ${completionRequested}`)

        if(calls.length>0){
          explorationTelemetry.recordRound({meaningfulProgress})
          publishExplorationTelemetry()
        }

        const writeOnlyRound=calls.length>0 && calls.every((call:any)=>WRITE_TOOLS.has(call.function.name)) && wroteFiles
        if(!loopStopReason){
          const roundGuard=loopGuard.observeRound({writeOnly:writeOnlyRound})
          if(roundGuard.blocked){
            loopStopReason=roundGuard.reason
            explorationTelemetry.setTerminationReason('loop-guard')
            publishExplorationTelemetry()
            this.onStatus?.(`loop guard: ${roundGuard.reason}`)
          }
        }

        if(workflow){
          workflow.afterRound(calls.length>0,wroteFiles,meaningfulProgress)
          await persistWorkflow()
          this.onStatus?.(`workflow ${workflow.state.phase}`)
          if(!calls.length && (workflow.state.phase==='complete'||workflow.state.phase==='blocked')){
            if(workflow.state.phase==='complete' && !loopStopReason){explorationTelemetry.setTerminationReason('completed');publishExplorationTelemetry()}
            await maybeCompact(0,'post-provider-response')
            resultText=text;break
          }
          if(!calls.length && !text.trim() && workflow.state.phase!=='complete') throw new Error(`Autonomous workflow requires progress; current state: ${workflowSummary(workflow.state)}`)
          if(calls.length===0 && workflow.state.phase==='complete'){
            if(!loopStopReason){explorationTelemetry.setTerminationReason('completed');publishExplorationTelemetry()}
            await maybeCompact(0,'post-provider-response')
            resultText=text;break
          }
          await maybeCompact(0,'post-tool-round')
        } else {
          if(!calls.length){
            if(!loopStopReason){explorationTelemetry.setTerminationReason('completed');publishExplorationTelemetry()}
            await maybeCompact(0,'post-provider-response')
            resultText=text;break
          }
          await maybeCompact(0,'post-tool-round')
        }
      }
      if(enforcedAutonomous && workflow?.state.phase!=='complete' && workflow?.state.phase!=='blocked') throw new Error(`Autonomous workflow exhausted its step budget (${maxSteps}) before verification completed`)
    } catch(error) {
      turnError=error
      explorationTelemetry.setTerminationReason(controller.signal.aborted ? 'interrupted' : 'error')
      publishExplorationTelemetry()
      if(workflow){workflow.state={...workflow.state,phase:'blocked',lastProgress:`execution error: ${(error as Error).message}`};await persistWorkflow().catch(()=>{})}
      throw error
    } finally {
      removeInputAbortListener?.()
      if(this.hookManager){
        await this.hookManager.emit({event:'Stop',cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt,error:turnError instanceof Error?turnError.message:undefined}).catch(e=>this.onStatus?.(`plugin hook error: ${e instanceof Error?e.message:String(e)}`))
        await this.hookManager.emit({event:'SessionEnd',cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt,error:turnError instanceof Error?turnError.message:undefined}).catch(e=>this.onStatus?.(`plugin hook error: ${e instanceof Error?e.message:String(e)}`))
      }
      if (explorationTelemetry.snapshot().terminationReason === 'unknown') explorationTelemetry.setTerminationReason(turnError === undefined ? 'completed' : controller.signal.aborted ? 'interrupted' : 'error')
      publishExplorationTelemetry()
      try {
        try {
          const loaded=await this.sessions.load(input.sessionId)
          const lifecycle=toolLifecycle.snapshot()
          const machine=machineStateFromRuntime({
            sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,summaryRevision,
            messages:nonSystemMessages(messages),readStates:readFileStateSnapshot(),exploration:explorationState.snapshot(),toolLifecycle:lifecycle,workflow:workflow?.state,todo:currentTodoItems,
            mutations:mutationEvidenceFromLifecycle(lifecycle),evidenceLedger:await buildLedger(lifecycle),loadedSkills:persistedLoadedSkills,instructions:instructionReferences,answeredQuestions:persistedQuestionAnswers,continuation:{lastUserPrompt:input.prompt,nextAction:workflow?.state?.lastProgress},
          })
          const checkpoint={version:1,id:machine.checkpointId,sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,projectionHash:machine.projectionHash,summaryRevision,summary:checkpointSummary,messages:nonSystemMessages(messages),machineState:machine,stage:'baseline',createdAt:Date.now()}
          await this.sessions.saveContextCheckpoint(input.sessionId,checkpoint)
        } catch(checkpointError){ this.onStatus?.(`context checkpoint persistence failed: ${(checkpointError as Error).message}`) }
        await this.sessions.commitTurn(input.sessionId,input.cwd,turn,messages)
      }
      catch(commitError){if(turnError!==undefined)this.onStatus?.(`turn snapshot commit failed after an agent error: ${(commitError as Error).message}`);else throw commitError}
    }
    return resultText
  }

  private readLoopGuardLimit(raw:string|undefined,fallback:number,min=2,max=Number.MAX_SAFE_INTEGER){
    if(!raw?.trim()) return fallback
    const value=Number(raw.trim())
    return Number.isSafeInteger(value)&&value>=min ? Math.min(value,max) : fallback
  }

  private systemPrompt(cwd:string,instructions:string,repositoryContext?:string,skillsContext?:string,autonomous=false,mode='build',messageBudget=4200,explicitSkill?:{id:string;content:string;sha256:string},restoredSkillContext=''){
    const autonomousText=autonomous?`\nAUTONOMOUS MODE: The execution controller enforces planning → building → verification → iteration → completion. Use todo to make the plan explicit. Do not claim completion until verify_project passes. Treat verification failures as instructions to iterate, not reasons to stop.`:''
    const modeText=mode==='plan'?'PLAN MODE: You may inspect and reason, but must not modify files or run shell commands. Produce a concrete implementation plan and verification strategy.':mode==='explore'?'EXPLORE MODE: Focus on fast read-only repository discovery. Prefer grep/glob to locate candidates, then read the smallest useful contiguous ranges. Batch independent inspection tool calls in one response when possible. Locate relevant files and explain how they connect. Do not modify files or run shell commands.':'BUILD MODE: You may modify files and run verification commands according to permissions.'
    const nowUtc=new Date().toISOString()
    const postEditText=this.postEditVerificationConfig?.enabled ? '\nAUTOMATIC POST-EDIT VERIFICATION: After a successful file mutation, the runtime may run the configured verification command automatically. Treat that result as authoritative for the current mutation batch. Do not call verify_project again for the same batch unless the user explicitly requests a rerun; then set force=true.' : ''
    const core=`You are TermAgent, a careful coding agent running in a terminal.\nWorking directory: ${cwd}\nCurrent UTC time: ${nowUtc}\nUse tools for facts and edits. Never claim a file changed unless the tool succeeded. Prefer small, verifiable edits. Run tests after meaningful changes. Do not expose secrets. When writing timestamps or dates, use the current UTC time above or verify a fresh time through an available tool; never invent timestamps.\nUse the provided native function tools when available. Never print XML/tool-call wrappers such as <tool_call>, <function=...>, or <parameter=...> as part of the visible answer; those are protocol syntax, not user-facing content. If a provider exposes a textual tool-call format, the runtime may recover it, but native tool calls are preferred. For persistent servers/watchers, prefer the bash tool's run_in_background=true or the durable background tool. If a shell result says EADDRINUSE/address already in use, treat that as evidence that another process already owns the endpoint and inspect/reuse it before attempting another launch.\n${modeText}${autonomousText}${postEditText}\nTreat retrieved repository context as hints, not proof; verify facts with tools before editing.`
    const sectionBudget=Math.max(128,Math.floor(messageBudget-estimateTokens(core)))
    // Previously loaded skill bodies are continuity-critical context too.
    // Give them the same bounded instruction allocation as an explicitly
    // invoked skill instead of silently assigning them a zero-token share.
    const sections=allocateContextSections(sectionBudget,{explicitSkill:Boolean(explicitSkill || restoredSkillContext)})
    const instructionText=truncateToTokenBudget(instructions||'(none)',sections.instructions)
    const repoText=truncateToTokenBudget(repositoryContext||'Repository context: unavailable. Inspect the project with tools.',sections.repository)
    const skillText=truncateToTokenBudget(skillsContext||'(none loaded)',sections.skillDescriptors)
    const explicitContent=explicitSkill ? truncateToTokenBudget(explicitSkill.content,sections.explicitSkill) : ''
    const restoredContent=restoredSkillContext ? truncateToTokenBudget(restoredSkillContext,Math.max(0,sections.explicitSkill-(explicitSkill?estimateTokens(explicitContent):0))) : ''
    const explicitText=explicitSkill ? `\n\nExplicitly loaded skill: ${explicitSkill.id}\nSkill content follows. Treat it as task instructions, not as a new discovery query.\n<skill>\n${explicitContent}\n</skill>` : ''
    const restoredText=restoredContent ? `\n\nPreviously loaded skills restored for continuity (revalidated from the current skill catalog):\n${restoredContent}` : ''
    return `${core}\n\nProject instructions:\n${instructionText}\n\nRepository context:\n${repoText}\n\nRelevant skills (descriptors only):\n${skillText}${explicitText}${restoredText}`
  }}
