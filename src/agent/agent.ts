import type { Provider } from '../providers/types.js'
import type { ChatMessage } from '../session/store.js'
import { SessionStore } from '../session/store.js'
import { ToolRegistry } from '../tools/registry.js'
import { compactMessages, microPruneToolResults } from './compaction.js'
import { allocateContextSections, createContextBudget, estimateMessageTokens, estimateMessagesTokens, estimateTokens, truncateToTokenBudget } from '../context/budget.js'
import { withRetry } from './retry.js'
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
import { FileReadStateCache, rehydrateReadCoverageEvidence } from '../tools/file-state.js'
import { ExplorationState } from '../context/exploration.js'
import { ToolCallLifecycle, TextToolCallStreamGate, classifyToolError, normalizeToolCalls, parseToolArguments, recoverTextToolCalls } from './tool-call-lifecycle.js'
import type { QuestionResponse } from '../tools/types.js'
import { machineStateFromRuntime, renderMachineState, type ContextMachineState } from '../context/state.js'
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

const SEMANTIC_METADATA_KEYS = new Set(['taskId', 'taskID', 'taskIds', 'mutation', 'todo'])

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
  constructor(private provider:Provider,private tools:ToolRegistry,private sessions:SessionStore,private maxRounds=0,private maxContextTokens=12000,private retryMax=4,private onStatus?:(s:string)=>void,private skills:unknown[]=[],private contextOptions:{threshold?:number;reserveTokens?:number;recentTokens?:number}={},private hookManager?:PluginHookManager,toolOutputOptions:{maxLines?:number;maxBytes?:number;retentionDays?:number}={},private postEditVerificationConfig?:PostEditVerificationConfig,private taskManager?:TaskManager){
    this.toolOutputStore=new ToolOutputStore(toolOutputOptions)
  }

  async run(input:{sessionId:string;messages:ChatMessage[];cwd:string;instructions:string;repositoryContext?:string;skillsContext?:string;prompt?:string;onText?:(s:string)=>void;onTool?:(name:string,args:any)=>void;onToolResult?:(name:string,out:string,metadata?:any)=>void;onReasoning?:(s:string)=>void;autonomous?:boolean;mode?:string;customAgent?:CustomAgent;scopePaths?:string[];signal?:AbortSignal;onQuestion?: (questions:any[], signal?:AbortSignal)=>Promise<string[][]|QuestionResponse>;onTodo?:(items:TodoItem[])=>void;onExplorationTelemetry?:(snapshot:ExplorationTelemetrySnapshot)=>void;onExplorationState?:(snapshot:ReturnType<ExplorationState['snapshot']>)=>void;skillDiscoverySuppressed?:boolean;explicitSkill?:{id:string;content:string;sha256:string};allowedTools?:string[];taskId?:string;delegationDepth?:number;specialistRole?:string;onUsage?:(usage:{inputTokens:number;outputTokens:number;totalTokens:number;estimated:boolean})=>void}){
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
    const persistedSession=await this.sessions.load(input.sessionId)
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
        restoredReadEvidence=await rehydrateReadCoverageEvidence(restoredCheckpoint.machineState?.readCoverage||[],600,5)
      } catch {}
    }
    const persistedLoadedSkills=[...persistedSession.events].filter((event:any)=>event.type==='skill.load' && event.data?.id).map((event:any)=>({id:String(event.data.id),sha256:typeof event.data.sha256==='string'?event.data.sha256:undefined}))
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
    const budget=createContextBudget({maxContextTokens:this.maxContextTokens,maxOutputTokens:this.provider.config?.maxTokens,...this.contextOptions})
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
    const rawMessageBudget=Math.max(256,budget.usableTokens-schemaTokens)
    const checkpointNoticeBudget=Math.min(240,Math.max(64,Math.floor(rawMessageBudget*0.14)))
    const restoreNoticeBudget=restoredCheckpoint ? checkpointNoticeBudget : 0
    const messageBudget=Math.max(128,rawMessageBudget-restoreNoticeBudget)
    const descriptorContext=this.skills.length ? formatSkillDescriptors(this.skills as SkillDescriptor[], 5000) : '(skill discovery pending)'
    const system=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${input.instructions}`,input.repositoryContext,descriptorContext,autonomous,mode,messageBudget,input.explicitSkill)
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
      const snapshot=readFileState.contextSnapshot(16)
      return snapshot.map((item:any)=>({
        canonicalPath:item.canonicalPath,mtimeMs:item.mtimeMs,size:item.size,totalLines:item.totalLines,lastUse:item.lastUse,contentHash:item.contentHash,
        segments:(item.ranges||[]).map((range:any)=>({startLine:range.startLine,endLine:range.endLine,content:'',bytes:0,complete:true,recordedAt:item.lastUse||Date.now()})),
        requests:[],
      }))
    }

    const upsertCheckpointNotice=(machine:ContextMachineState,evidence:string[])=>{
      if(!contextNoticeMessage){ contextNoticeMessage={role:'system',content:''}; messages.splice(1,0,contextNoticeMessage) }
      contextNoticeMessage.content=checkpointNotice(checkpointSummary,machine,evidence,checkpointNoticeBudget)
    }

    const maybeCompact=async(additionalRequestTokens=0)=>{
      const schemaResult=buildSchemas()
      const schemas=schemaResult.tools
      const liveSchemaTokens=schemaResult.estimatedTokens
      if(liveSchemaTokens>=budget.usableTokens) throw new Error(`Tool definitions exceed the configured context budget (${liveSchemaTokens} estimated tokens >= ${budget.usableTokens} usable tokens)`)
      const requestTokens=estimateMessagesTokens(messages)+liveSchemaTokens+Math.max(0,additionalRequestTokens)
      if(requestTokens<=budget.usableTokens)return
      const liveMessageBudget=budget.usableTokens-liveSchemaTokens
      if(liveMessageBudget<64) throw new Error(`Conversation cannot fit within the configured context budget after reserving tool definitions (${liveMessageBudget} message tokens available)`)

      const reductionMessageBudget=Math.max(64,liveMessageBudget-checkpointNoticeBudget)
      const beforeMicro=messages.map(message=>({...message,tool_calls:message.tool_calls?.map(call=>({...call,function:{...call.function}}))}))
      const refs=new Map((typeof toolLifecycle!=='undefined'?toolLifecycle.snapshot():[]).filter(record=>Boolean(record.outputReference)).map(record=>[record.callId,record.outputReference!] as const))
      const micro=microPruneToolResults(messages,reductionMessageBudget,{preserveRecentTurns:2,minToolTokens:32,references:refs})
      if(micro.pruned>0){
        messages.splice(0,messages.length,...micro.messages)
        activeCheckpointProjection=nonSystemMessages(messages)
        const finalTokens=estimateMessagesTokens(messages)+liveSchemaTokens+Math.max(0,additionalRequestTokens)
        if(finalTokens+checkpointNoticeBudget<=budget.usableTokens){
          const loaded=await this.sessions.load(input.sessionId)
          const lifecycle=toolLifecycle.snapshot()
          const machine=machineStateFromRuntime({sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,summaryRevision,messages:nonSystemMessages(messages),readStates:readFileStateSnapshot(),exploration:explorationState.snapshot(),toolLifecycle:lifecycle,workflow:workflow?.state,todo:currentTodoItems,mutations:mutationEvidenceFromLifecycle(lifecycle),evidenceLedger:await buildLedger(lifecycle),loadedSkills:persistedLoadedSkills,answeredQuestions:persistedQuestionAnswers,continuation:{lastUserPrompt:input.prompt,nextAction:workflow?.state?.lastProgress}})
          const data={version:1,id:machine.checkpointId,sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,projectionHash:machine.projectionHash,summaryRevision,summary:checkpointSummary,messages:nonSystemMessages(messages),machineState:machine,stage:'micro-prune',createdAt:Date.now()}
          await this.sessions.saveContextCheckpoint(input.sessionId,data)
          upsertCheckpointNotice(machine,[])
          const noticeTokens=estimateMessagesTokens(messages)+liveSchemaTokens+Math.max(0,additionalRequestTokens)
          if(noticeTokens>budget.usableTokens) throw new Error(`Context checkpoint notice exceeds the configured context budget (${noticeTokens} estimated request tokens > ${budget.usableTokens})`)
          this.onStatus?.(`micro-pruned ${micro.pruned} older tool result(s); ${noticeTokens} estimated request tokens`)
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
      const readEvidence=await readFileState.rehydrateContextEvidence(600,5)
      const loaded=await this.sessions.load(input.sessionId)
      const compactedMessageTokens=estimateMessagesTokens(messages)
      if(compactedMessageTokens>reductionMessageBudget) throw new Error(`Conversation still exceeds the staged compaction budget after compaction (${compactedMessageTokens} estimated message tokens > ${reductionMessageBudget})`)
      const lifecycle=toolLifecycle.snapshot()
      const machine=machineStateFromRuntime({sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,summaryRevision,messages:nonSystemMessages(messages),readStates:readFileStateSnapshot(),exploration:explorationState.snapshot(),toolLifecycle:lifecycle,workflow:workflow?.state,todo:currentTodoItems,mutations:mutationEvidenceFromLifecycle(lifecycle),evidenceLedger:await buildLedger(lifecycle),loadedSkills:persistedLoadedSkills,answeredQuestions:persistedQuestionAnswers,continuation:{lastUserPrompt:input.prompt,nextAction:workflow?.state?.lastProgress}})
      const checkpoint={version:1,id:machine.checkpointId,sessionId:input.sessionId,turnId:turn.id,epoch:contextEpoch,sourceEventCount:loaded.events.length,projectionHash:machine.projectionHash,summaryRevision,summary:checkpointSummary,messages:nonSystemMessages(messages),machineState:machine,stage:'full-compaction',createdAt:Date.now()}
      await this.sessions.append(input.sessionId,{type:'compaction',ts:Date.now(),data:{removed:c.removed,tokens:compactedMessageTokens+liveSchemaTokens,messageTokens:compactedMessageTokens,schemaTokens:liveSchemaTokens,summary:c.summary,budget,workflow:workflow?.state,readState:readFileState.contextSnapshot(8),stage:'full-compaction',epoch:contextEpoch,summaryRevision}})
      await this.sessions.saveContextCheckpoint(input.sessionId,checkpoint)
      upsertCheckpointNotice(machine,readEvidence)
      const finalTokens=estimateMessagesTokens(messages)+liveSchemaTokens+Math.max(0,additionalRequestTokens)
      if(finalTokens>budget.usableTokens) throw new Error(`Conversation still exceeds the configured context budget after checkpoint projection (${finalTokens} estimated request tokens > ${budget.usableTokens})`)
      this.onStatus?.(`compacted context (${c.removed} messages; ${finalTokens} estimated request tokens; epoch ${contextEpoch})`)
    }

    const turn=await this.sessions.beginTurn(input.sessionId,input.cwd,messages,input.prompt)
    const notifications=await this.sessions.consumeTaskNotifications(input.sessionId)
    for(const notification of notifications){
      const status=String(notification.status||'completed')
      const summary=String(notification.summary||'No completion summary was recorded.').trim()
      const taskId=String(notification.taskId||'unknown')
      const childSessionId=notification.childSessionId?String(notification.childSessionId):''
      const outputPath=notification.outputPath?String(notification.outputPath):''
      const noteParts=[`<task-notification id="${taskId}" state="${status}">`,summary,childSessionId?`child_session=${childSessionId}`:'',outputPath?`output_path=${outputPath}`:'','</task-notification>'].filter(Boolean)
      const message:ChatMessage={role:'user',content:noteParts.join('\n')}
      messages.push(message)
      await this.sessions.appendMessage(input.sessionId,message,turn.id)
    }
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
    this.provider.setTurnContext?.({userText:input.prompt||'',turnNumber:turn.beforeMessageCount+1})
    const routed=(this.provider as any).routingDecision?.()
    if(routed) this.onStatus?.(`model route: ${routed.complexity} → ${routed.model} (${routed.reason})`)
    if(workflow) { workflow.state={...workflow.state,lastProgress:'autonomous turn started'}; await persistWorkflow() }
    if(input.prompt){
      const user:ChatMessage={role:'user',content:input.prompt};messages.push(user);await this.sessions.appendMessage(input.sessionId,user,turn.id)
      if(skillDiscoveryEnabled){
        await recordSkillDiscovery('user_input',input.prompt)
        const systemMessage=messages.find(m=>m.role==='system')
        if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${input.instructions}`,input.repositoryContext,renderSkillContext(),autonomous,mode,messageBudget,input.explicitSkill)
      } else if(input.explicitSkill){
        const systemMessage=messages.find(m=>m.role==='system')
        if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${input.instructions}`,input.repositoryContext,'(automatic skill discovery suppressed for explicit skill invocation)',autonomous,mode,messageBudget,input.explicitSkill)
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
      await maybeCompact()
      if(input.prompt){const lastUser=[...messages].reverse().find(m=>m.role==='user');if(!lastUser||lastUser.content!==input.prompt) throw new Error('Current user prompt could not be preserved within the configured context budget')}

      for(let round=0;round<maxSteps;round++){
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
          const availableForNotice=Math.max(0,budget.usableTokens-estimateMessagesTokens(requestMessages)-requestSchemaResult.estimatedTokens)
          const notice=truncateToTokenBudget(executionInstruction,availableForNotice)
          if(notice.trim()) requestMessages=[...requestMessages,{role:'system',content:notice} as ChatMessage]
        }
        let accounting=accountContext(requestMessages,requestTools)
        let requestTokens=accounting.total
        if(requestTokens>budget.usableTokens){
          const baseMessageTokens=estimateMessagesTokens(messages)
          const requestMessageTokens=estimateMessagesTokens(requestMessages)
          const additionalRequestTokens=Math.max(0,requestMessageTokens-baseMessageTokens)
          await maybeCompact(additionalRequestTokens)

          requestMessages=messages
          if(explorationGuidanceText) requestMessages=[...requestMessages,{role:'system',content:truncateToTokenBudget(explorationGuidanceText,128)} as ChatMessage]
          if(explorationInterventionNotice && !finalStep) requestMessages=[...requestMessages,explorationInterventionNotice]
          if(executionInstruction){
            const availableForNotice=Math.max(0,budget.usableTokens-estimateMessagesTokens(requestMessages)-requestSchemaResult.estimatedTokens)
            const notice=truncateToTokenBudget(executionInstruction,availableForNotice)
            if(notice.trim()) requestMessages=[...requestMessages,{role:'system',content:notice} as ChatMessage]
          }
          accounting=accountContext(requestMessages,requestTools)
          requestTokens=accounting.total
          if(requestTokens>budget.usableTokens){
            throw new Error(`Request still exceeds the configured context budget after tool/schema bounding (${requestTokens} estimated request tokens > ${budget.usableTokens}; toolDefinitions=${accounting.toolDefinitions},toolCalls=${accounting.toolCalls},toolResults=${accounting.toolResults})`)
          }
        }
        let text='';let reasoning='';const calls:any[]=[]
        let streamedText=''
        const textToolCallGate=new TextToolCallStreamGate()
        const providerCalls=new Map<string,{providerExecuted:boolean;providerMetadata?:unknown}>()
        const providerResults=new Map<string,{output:string;error?:string;providerMetadata?:unknown}>()
        this.provider.setRole?.(phase?roleForPhase(phase):mode)
        await appendProviderTurn(round,'started',{startedAt:Date.now()})
        try {
          await withRetry(async()=>{
            text='';reasoning='';calls.length=0;providerCalls.clear();providerResults.clear();streamedText='';textToolCallGate.reset()
            for await(const ev of this.provider.stream(requestMessages,requestTools,controller.signal)){
              if(ev.type==='reasoning'){reasoning+=ev.delta;input.onReasoning?.(ev.delta)}
              if(ev.type==='text'){
                text+=ev.delta
                const visible=textToolCallGate.push(ev.delta)
                if(visible){streamedText+=visible;input.onText?.(visible)}
              }
              if(ev.type==='tool_call'){
                calls.push(ev.call)
                providerCalls.set(String(ev.call.id||''),{providerExecuted:Boolean(ev.providerExecuted),...(ev.providerMetadata!==undefined?{providerMetadata:ev.providerMetadata}: {})})
              }
              if(ev.type==='tool_result'){
                providerResults.set(String(ev.call.id||''),{output:ev.output,error:ev.error,...(ev.providerMetadata!==undefined?{providerMetadata:ev.providerMetadata}: {})})
              }
            }
            const withheld=textToolCallGate.finish()
            if(withheld){
              const recoveryToolNames=finalStep ? this.tools.list().map(tool=>tool.name) : availableToolNames
              const recovery=recoverTextToolCalls(text,recoveryToolNames)
              if(!recovery.recovered){
                streamedText+=withheld
                input.onText?.(withheld)
              }
            }
            if(!text.trim()&&!calls.length)throw new Error('Provider returned an empty model response')
          },{max:this.retryMax,signal:controller.signal,onRetry:x=>this.onStatus?.(`retry ${x.attempt}/${this.retryMax} in ${Math.ceil(x.delay/1000)}s: ${x.message}`)})
        } catch(error) {
          if((error as any)?.code==='PROVIDER_STREAM_IDLE') this.onStatus?.(String((error as Error).message||error))
          const state=controller.signal.aborted?'interrupted':'error'
          await appendProviderTurn(round,state,{endedAt:Date.now(),error:error instanceof Error?error.message:String(error)})
          throw error
        }
        try {
          const recoveryToolNames=finalStep ? this.tools.list().map(tool=>tool.name) : availableToolNames
          const textualRecovery=recoverTextToolCalls(text,recoveryToolNames)
          if(textualRecovery.recovered){
            const tail=textualRecovery.text.startsWith(streamedText) ? textualRecovery.text.slice(streamedText.length) : textualRecovery.text
            if(tail && !finalStep){streamedText+=tail;input.onText?.(tail)}
            text=textualRecovery.text
            if(!finalStep){
              calls.push(...textualRecovery.calls)
              this.onStatus?.(`recovered ${textualRecovery.calls.length} text-encoded tool call${textualRecovery.calls.length===1?'':'s'} from provider output`)
            } else {
              this.onStatus?.(`ignored ${textualRecovery.calls.length} text-encoded tool call${textualRecovery.calls.length===1?'':'s'} because tool execution is disabled for this turn`)
              if(!text.trim()){
                text=loopStopReason ? `Turn stopped before another tool call: ${loopStopReason}.` : 'Tool execution is no longer available in this turn.'
                input.onText?.(text)
              }
            }
          }
          const normalized=normalizeToolCalls(this.provider.id,turn.id,calls)
          calls.splice(0,calls.length,...normalized)
          if(!text.trim()&&!calls.length)throw new Error('Provider returned an empty model response')
        } catch(error) {
          await appendProviderTurn(round,'error',{endedAt:Date.now(),error:error instanceof Error?error.message:String(error)})
          throw error
        }

        input.onUsage?.({inputTokens:estimateMessagesTokens(requestMessages),outputTokens:estimateTokens(`${text}${reasoning}`),totalTokens:estimateMessagesTokens(requestMessages)+estimateTokens(`${text}${reasoning}`),estimated:true})
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
          input.onTool?.(call.function.name,args)
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
            if(this.hookManager){ await this.hookManager.emit({event:'PreToolUse',toolName:call.function.name,toolArgs:args,cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}) }
            let result
            try {
              result=await this.tools.execute(call.function.name,args,{sessionID:input.sessionId,agent:mode,cwd:input.cwd,abort:controller.signal,toolCallId:call.id,scopePaths:input.scopePaths,taskId:input.taskId,delegationDepth:input.delegationDepth,specialistRole:input.specialistRole,questioner:input.onQuestion,readFileState})
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
            if(!exists) persistedLoadedSkills.push({id:String(skillInfo.id),sha256:typeof skillInfo.sha256==='string'?skillInfo.sha256:undefined})
            await this.sessions.append(input.sessionId,{type:'skill.load',ts:Date.now(),data:{action:'load',id:String(skillInfo.id),sha256:skillInfo.sha256,path:skillInfo.path,source:'tool'}} as any)
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
              if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${input.instructions}`,input.repositoryContext,renderSkillContext(),autonomous,mode,messageBudget,input.explicitSkill)
            }
          if(['background_agent','parallel_agents'].includes(call.function.name) && !toolError){ if(this.hookManager) await this.hookManager.emit({event:'SubagentStart',toolName:call.function.name,toolArgs:args,toolOutput:output,cwd:input.cwd,sessionID:input.sessionId,prompt:input.prompt}).catch(e=>this.onStatus?.(`plugin hook error: ${e instanceof Error?e.message:String(e)}`)) }
          if(['background_agent','parallel_agents'].includes(call.function.name) && !toolError && skillDiscoveryEnabled && !input.skillDiscoverySuppressed){
            const delegated=typeof args==='object' ? JSON.stringify(args) : String(args||'')
            await recordSkillDiscovery('subagent_spawn',[input.prompt||'',delegated].filter(Boolean).join(' '))
            const systemMessage=messages.find(m=>m.role==='system')
            if(systemMessage) systemMessage.content=this.systemPrompt(input.cwd,`${custom?.prompt ? custom.prompt+'\n\n' : ''}${input.instructions}`,input.repositoryContext,renderSkillContext(),autonomous,mode,messageBudget,input.explicitSkill)
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

        if(!loopStopReason && semanticTrackingActive){
          const semanticFingerprint=semanticProgressFingerprint({
            exploration:explorationState.snapshot(),
            todos:currentTodoItems,
            mutations:mutationEvidenceFromLifecycle(toolLifecycle.snapshot()),
            toolLifecycle:toolLifecycle.snapshot(),
            workflow:workflow?.state,
          })
          const semanticProgress=semanticFingerprint!==lastSemanticProgressFingerprint
          if(semanticProgress) meaningfulProgress=true
          const semanticCheck=loopGuard.observeNoProgressRound(
            semanticFingerprint,
            semanticProgress,
            explorationInterventionToolActions(explorationRoundActions),
          )
          lastSemanticProgressFingerprint=semanticFingerprint
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
            resultText=text;break
          }
          if(!calls.length && !text.trim() && workflow.state.phase!=='complete') throw new Error(`Autonomous workflow requires progress; current state: ${workflowSummary(workflow.state)}`)
          if(calls.length===0 && workflow.state.phase==='complete'){
            if(!loopStopReason){explorationTelemetry.setTerminationReason('completed');publishExplorationTelemetry()}
            resultText=text;break
          }
          await maybeCompact()
        } else {
          if(!calls.length){
            if(!loopStopReason){explorationTelemetry.setTerminationReason('completed');publishExplorationTelemetry()}
            resultText=text;break
          }
          await maybeCompact()
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
            mutations:mutationEvidenceFromLifecycle(lifecycle),evidenceLedger:await buildLedger(lifecycle),loadedSkills:persistedLoadedSkills,answeredQuestions:persistedQuestionAnswers,continuation:{lastUserPrompt:input.prompt,nextAction:workflow?.state?.lastProgress},
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

  private systemPrompt(cwd:string,instructions:string,repositoryContext?:string,skillsContext?:string,autonomous=false,mode='build',messageBudget=4200,explicitSkill?:{id:string;content:string;sha256:string}){
    const autonomousText=autonomous?`\nAUTONOMOUS MODE: The execution controller enforces planning → building → verification → iteration → completion. Use todo to make the plan explicit. Do not claim completion until verify_project passes. Treat verification failures as instructions to iterate, not reasons to stop.`:''
    const modeText=mode==='plan'?'PLAN MODE: You may inspect and reason, but must not modify files or run shell commands. Produce a concrete implementation plan and verification strategy.':mode==='explore'?'EXPLORE MODE: Focus on fast read-only repository discovery. Prefer grep/glob to locate candidates, then read the smallest useful contiguous ranges. Batch independent inspection tool calls in one response when possible. Locate relevant files and explain how they connect. Do not modify files or run shell commands.':'BUILD MODE: You may modify files and run verification commands according to permissions.'
    const nowUtc=new Date().toISOString()
    const postEditText=this.postEditVerificationConfig?.enabled ? '\nAUTOMATIC POST-EDIT VERIFICATION: After a successful file mutation, the runtime may run the configured verification command automatically. Treat that result as authoritative for the current mutation batch. Do not call verify_project again for the same batch unless the user explicitly requests a rerun; then set force=true.' : ''
    const core=`You are TermAgent, a careful coding agent running in a terminal.\nWorking directory: ${cwd}\nCurrent UTC time: ${nowUtc}\nUse tools for facts and edits. Never claim a file changed unless the tool succeeded. Prefer small, verifiable edits. Run tests after meaningful changes. Do not expose secrets. When writing timestamps or dates, use the current UTC time above or verify a fresh time through an available tool; never invent timestamps.\nUse the provided native function tools when available. Never print XML/tool-call wrappers such as <tool_call>, <function=...>, or <parameter=...> as part of the visible answer; those are protocol syntax, not user-facing content. If a provider exposes a textual tool-call format, the runtime may recover it, but native tool calls are preferred.\n${modeText}${autonomousText}${postEditText}\nTreat retrieved repository context as hints, not proof; verify facts with tools before editing.`
    const sectionBudget=Math.max(128,Math.floor(messageBudget-estimateTokens(core)))
    const sections=allocateContextSections(sectionBudget,{explicitSkill:Boolean(explicitSkill)})
    const instructionText=truncateToTokenBudget(instructions||'(none)',sections.instructions)
    const repoText=truncateToTokenBudget(repositoryContext||'Repository context: unavailable. Inspect the project with tools.',sections.repository)
    const skillText=truncateToTokenBudget(skillsContext||'(none loaded)',sections.skillDescriptors)
    const explicitContent=explicitSkill ? truncateToTokenBudget(explicitSkill.content,sections.explicitSkill) : ''
    const explicitText=explicitSkill ? `\n\nExplicitly loaded skill: ${explicitSkill.id}\nSkill content follows. Treat it as task instructions, not as a new discovery query.\n<skill>\n${explicitContent}\n</skill>` : ''
    return `${core}\n\nProject instructions:\n${instructionText}\n\nRepository context:\n${repoText}\n\nRelevant skills (descriptors only):\n${skillText}${explicitText}`
  }}
