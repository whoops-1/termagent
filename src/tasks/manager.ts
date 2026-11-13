import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDir, within } from '../util/fs.js'
import { canonicalJson } from '../util/canonical.js'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { terminateProcessGroup } from '../util/child-process.js'
import { TaskEventLog } from './events.js'
import type { ApprovalMode, PermissionRule } from '../config/config.js'
import type { ProviderConfig } from '../providers/types.js'

// Task lock lease policy. Mirrors the session state-lease discipline (bounded
// exponential backoff + jitter, owner classification, redacted contention
// diagnostics) while staying self-contained: the tasks domain must not import
// src/session. envNonNegativeInt mirrors src/config/config.ts because a
// config import would couple tasks to configuration loading.
function envNonNegativeInt(name:string,fallback:number){ return envNonNegativeIntFrom(process.env,name,fallback) }
function envNonNegativeIntFrom(env:Record<string,string|undefined>,name:string,fallback:number){
  const raw=env[name]
  if(raw===undefined||raw.trim()==='') return fallback
  const value=Number(raw)
  return Number.isSafeInteger(value)&&value>=0 ? value : fallback
}
const TASK_LEASE_INITIAL_WAIT_MS=10
const TASK_LEASE_MAX_WAIT_MS=200
// ~8x the previous fixed ~600 ms budget so concurrent task-record and
// scheduler writes on slow mobile/Termux storage stop failing spuriously,
// while staying well under a user-perceived hang.
// TERMAGENT_TASK_LOCK_TIMEOUT_MS overrides it.
const TASK_LEASE_DEFAULT_TIMEOUT_MS=5000
// A lock whose contents cannot be classified (malformed/incomplete payload)
// may still be mid-write by another process; only aged contents are recoverable.
const TASK_LEASE_MALFORMED_FRESH_MS=5000
// Attempt bound against pathological recreate/delete churn; the wall-clock
// budget above is the primary bound for waiting on a live owner.
const TASK_LEASE_MAX_ATTEMPTS=512
// Bounded poll cadence for settle wakeups: cross-process task records change
// by file write, so waiters re-read on a bounded cadence. Same-process settles
// wake waiters immediately through the in-process notification set; fs.watch
// is deliberately not used (platform/API fragmentation and fd pressure on
// mobile; the 100 ms cadence is imperceptible for orchestration purposes).
const TASK_WAIT_FALLBACK_POLL_MS=100
// 14I-O (item 859) launch guardrails. The knobs are explicit so an operator
// can widen or tighten orchestration without a rebuild. Legacy names stay
// honored so existing deployments keep their configured limits.
const TASK_MAX_FANOUT_DEFAULT=8
const TASK_MAX_DEPTH_DEFAULT=3
const TASK_MAX_RETRIES_DEFAULT=2
export function taskFanoutLimit(env:Record<string,string|undefined>=process.env):number{
  const explicit=envNonNegativeIntFrom(env,'TERMAGENT_TASK_MAX_FANOUT',0)
  if(explicit>0)return explicit
  const legacy=envNonNegativeIntFrom(env,'TERMAGENT_MAX_ACTIVE_AGENTS',0)
  if(legacy>0)return legacy
  return TASK_MAX_FANOUT_DEFAULT
}
export function taskMaxDepth(env:Record<string,string|undefined>=process.env):number{
  const explicit=envNonNegativeIntFrom(env,'TERMAGENT_TASK_MAX_DEPTH',-1)
  if(explicit>=0)return explicit
  const legacy=envNonNegativeIntFrom(env,'TERMAGENT_MAX_AGENT_DEPTH',-1)
  if(legacy>=0)return legacy
  return TASK_MAX_DEPTH_DEFAULT
}
export function taskMaxRetries(env:Record<string,string|undefined>=process.env):number{
  const explicit=envNonNegativeIntFrom(env,'TERMAGENT_TASK_MAX_RETRIES',-1)
  if(explicit>=0)return explicit
  return TASK_MAX_RETRIES_DEFAULT
}
/**
 * Stable launch fingerprint (14I-O, item 859). Two launches with the same
 * kind, prompt, and workspace scope are the same unit of work; the
 * fingerprint is what lets the runtime detect duplicate/no-progress
 * orchestration before a second child is ever spawned.
 */
export function computeLaunchFingerprint(input:{kind:string;prompt:string;scopePaths?:readonly string[]}):string{
  const prompt=String(input.prompt||'').replace(/\s+/g,' ').trim()
  const scopePaths=[...(input.scopePaths||[])].map(value=>String(value).replace(/\\/g,'/').trim()).filter(Boolean).sort()
  return crypto.createHash('sha256').update(canonicalJson({kind:String(input.kind||''),prompt,scopePaths})).digest('hex')
}
export type TaskProviderPreflightResult={ok:true}|{ok:false;kind:string;reason:string}
function declaresCredentialSource(snapshot:unknown):boolean{
  if(!snapshot||typeof snapshot!=='object')return false
  const config=snapshot as {credentialRef?:unknown;apiKey?:unknown;apiKeyEnv?:unknown}
  if(typeof config.credentialRef==='string'&&config.credentialRef.trim())return true
  if(typeof config.apiKey==='string'&&config.apiKey.trim())return true
  if(typeof config.apiKeyEnv==='string'&&config.apiKeyEnv.trim())return true
  return false
}
/**
 * 14I-O: consume the child-provider preflight contract when the provider
 * snapshot layer exports it. The export is resolved dynamically so this
 * stream never depends on a contract that may not be present yet; when it is
 * missing, launching proceeds exactly as before.
 *
 * Two documented boundaries (reported at the batch-3 gate):
 * - A parent route that declares NO provider adapter was never adapter-typed,
 *   so there is no route to validate; the preflight is skipped and the launch
 *   behaves exactly as before this stream.
 * - A snapshot that declares NO credential source at all is a credential-free
 *   (local / no-key) route. The provider stream's preflight classifies that
 *   as 'missing-credential'; enforcing it here would refuse legitimate local
 *   providers. A credential that IS declared but cannot be resolved (dangling
 *   credentialRef, unresolvable apiKeyEnv) is always enforced, as are the
 *   'missing-model' and 'incompatible-route' classes.
 */
export async function preflightChildProviderSnapshot(snapshot:unknown,opts:{label:string;kind:string;declaredAdapter?:string}):Promise<void>{
  if(!String(opts.declaredAdapter||'').trim())return
  const module=await import('./task-provider.js') as unknown as {preflightTaskProviderConfig?:(snapshot:unknown,options?:unknown)=>TaskProviderPreflightResult}
  const preflight=module.preflightTaskProviderConfig
  if(typeof preflight!=='function')return
  const result=await preflight(snapshot,{label:opts.label,kind:opts.kind})
  if(result&&result.ok===true)return
  const failure=result as {ok:false;kind?:string;reason?:string}|undefined
  if(failure?.kind==='missing-credential'&&!declaresCredentialSource(snapshot))return
  throw new Error(`Child provider preflight failed (${failure?.kind||'unknown'}): ${failure?.reason||'the child provider configuration is not usable'}`)
}
/**
 * 14I-O: single entry point used by the launch tools to apply the duplicate /
 * no-progress launch guardrails. The manager owns the policy; the tools only
 * supply the launch fingerprint and the explicit retry cause.
 */
export async function assertChildLaunchPermitted(manager:TaskManager,input:{parentSessionId?:string;fingerprint:string;retryCause?:string;label?:string}):Promise<void>{
  if(!manager||typeof manager.assertLaunchPermitted!=='function')return
  await manager.assertLaunchPermitted(input)
}
export type TaskLeaseContention={
  operation:string
  lockId:string
  attempts:number
  waitedMs:number
  outcome:'acquired'|'recovered-stale'|'recovered-malformed'|'timeout'
  ownerPid?:number
  decidedAt:number
  // 14I-O (item 866, task side): structured, redacted lock diagnostics.
  // `lock` separates the task-record lock from the scheduler session lock,
  // `decision` names the recovery action that was actually taken, and
  // `waitMs`/`retries`/`heldMs` describe the acquisition attempt. No prompt,
  // task output, credential, or user content is ever stored here.
  lock:'task'|'session'
  id:string
  opKind:string
  waitMs:number
  retries:number
  decision:'acquired'|'recovered-stale'|'recovered-malformed'|'live-owner'|'failed'
  at:number
  ownerIdentity?:string
  heldMs?:number
  jsonlBytes?:number
}
/**
 * Corrupt/unreadable task-record diagnostics. This is deliberately a
 * different class from lock contention: a damaged record is a data problem,
 * not a scheduling problem, and the two must never be reported as one.
 */
export type TaskRecordDiagnostic={
  class:'task-record'
  kind:'corrupt-record'|'unreadable-record'
  id:string
  file:string
  bytes?:number
  error:string
  at:number
}
type LeaseVerdict=
  | {kind:'gone';pid?:undefined;identity?:undefined}
  | {kind:'wait';reason:'live-owner'|'fresh-malformed';pid?:number;identity?:string}
  | {kind:'recover-stale';pid:number;token:string;identity?:string}
  | {kind:'recover-malformed';pid?:undefined;identity?:string}

export type TaskKind = 'shell'|'agent'
export type TaskStatus = 'queued'|'running'|'exited'|'failed'|'cancelled'
export type TaskActivity = {kind:'tool'|'status'|'turn'|'output';label:string;detail?:string;at:number;callId?:string;outcome?:'success'|'error'|'running'}
export interface TaskRecord {
  id:string; kind:TaskKind; command?:string; prompt?:string; cwd:string; started:number; updated:number; ended?:number;
  status:TaskStatus; pid?:number; exitCode?:number; output:string; sessionId?:string; childSessionId?:string; parentSessionId?:string;
  result?:string; error?:string; pendingPrompts?:string[]; runCount?:number; background?:boolean; parentNotified?:boolean;
  permissionMode?:ApprovalMode; permissionRules?:PermissionRule[]; allowedTools?:string[]; coordinated?:boolean; specialistRole?:string; delegationDepth?:number; parentTaskId?:string;
  provider?:ProviderConfig & { credentialRef?:string };
  usage?:{inputTokens:number;outputTokens:number;totalTokens:number;estimated:boolean};
  activity?:TaskActivity;
  workerToken?:string;
  processIdentity?:{command:string;cwd:string;startTime?:string};
  scopePaths?:string[]; outputPath?:string; outputBytes?:number; outputTruncated?:boolean; timeoutMs?:number; backgrounded?:boolean; backgroundChildrenPreserved?:boolean; signal?:any; termination?:'completed'|'nonzero'|'timeout'|'cancelled'|'signal'|'output-limit'|'stdin-timeout'|'spawn-error';
  // 14I-O (item 859): durable orchestration bookkeeping.
  // launchFingerprint identifies the unit of work (kind + prompt + scope) so
  // duplicate/no-progress launches can be refused before a child is spawned.
  // launchRetryCause records the explicit changed cause that justified a
  // retry. terminalCredentialError is set by the provider preflight layer for
  // credential-terminal failures; such tasks are never auto-retried or
  // respawned by orchestration.
  launchFingerprint?:string; launchRetryCause?:string; terminalCredentialError?:boolean;
}

export class TaskManager {
  private events:TaskEventLog
  private saveQueues=new Map<string,Promise<void>>()
  private settleWaiters=new Set<()=>void>()
  private lastTaskLeaseContentionRecord:TaskLeaseContention|undefined
  private recordDiagnostics:TaskRecordDiagnostic[]=[]
  private identityTagPromise:Promise<string|undefined>|undefined
  private readonly sessionRoot:string
  constructor(private root=process.env.TERMAGENT_TASK_ROOT||path.join(process.env.HOME||process.cwd(),'.termagent','tasks'), private workerDetached=true, sessionRoot=process.env.TERMAGENT_SESSION_ROOT||path.join(process.env.HOME||process.cwd(),'.termagent','sessions')){this.events=new TaskEventLog(root);this.sessionRoot=sessionRoot}
  private file(id:string){return path.join(this.root,`${id}.json`)}
  async event(id:string,type:string,data:any){return this.events.append(id,type,data)}
  async history(id:string){return this.events.read(id)}
  private lockFile(id:string){return path.join(this.root,`.${id}.task.lock`)}
  private sessionLockFile(sessionId:string){return path.join(this.root,`.session-${crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0,32)}.lock`)}
  private async withTaskLock<T>(id:string,fn:()=>Promise<T>):Promise<T>{
    await ensureDir(this.root)
    const lockPath=this.lockFile(id)
    const lock=await this.acquireNamedLock(lockPath,`task-record:${id}`,`Task ${id}`,id,'task')
    const acquiredAt=Date.now()
    try{return await fn()}finally{this.noteLeaseHeld(Date.now()-acquiredAt);await this.releaseNamedLock(lock)}
  }
  private async saveUnlocked(t:TaskRecord){
    await ensureDir(this.root)
    t.updated=Date.now()
    const target=this.file(t.id)
    const tmp=`${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    await fs.writeFile(tmp,JSON.stringify(t,null,2))
    await fs.rename(tmp,target)
    await this.events.append(t.id,'state',{kind:t.kind,status:t.status,pid:t.pid,exitCode:t.exitCode,outputTail:(t.output||'').slice(-2000),sessionId:t.sessionId,childSessionId:t.childSessionId,parentSessionId:t.parentSessionId,parentTaskId:t.parentTaskId,specialistRole:t.specialistRole,activity:t.activity})
    // Settle wakeup (parent orchestration): same-process transitions resolve
    // waiters immediately; cross-process writers are observed on the bounded
    // poll cadence inside waitTaskSettled.
    if(t.status!=='queued'&&t.status!=='running') this.wakeSettleWaiters()
  }
  async save(t:TaskRecord){
    const previous=this.saveQueues.get(t.id)||Promise.resolve()
    const next=previous.then(()=>this.withTaskLock(t.id,()=>this.saveUnlocked(t)))
    this.saveQueues.set(t.id,next.catch(()=>{}))
    await next
  }
  async list(){
    await ensureDir(this.root)
    const out:TaskRecord[]=[]
    for(const f of await fs.readdir(this.root)){
      if(!f.endsWith('.json'))continue
      const file=path.join(this.root,f)
      let text:string
      try{text=await fs.readFile(file,'utf8')}catch{continue}
      try{out.push(JSON.parse(text) as TaskRecord)}
      catch(error){await this.noteRecordDiagnostic(f.replace(/\.json$/,''),file,error,Buffer.byteLength(text,'utf8'))}
    }
    return out.sort((a,b)=>b.started-a.started)
  }
  async get(id:string){
    const file=this.file(id)
    let text:string
    try{text=await fs.readFile(file,'utf8')}
    catch(error){await this.noteRecordDiagnostic(id,file,error);throw error}
    try{return JSON.parse(text) as TaskRecord}
    catch(error){
      await this.noteRecordDiagnostic(id,file,error,Buffer.byteLength(text,'utf8'))
      throw new Error(`Task record ${id} is corrupt and cannot be parsed (${error instanceof Error?error.name:'Error'}).`)
    }
  }
  async update(id:string,patch:Partial<TaskRecord>){return await this.withTaskLock(id,async()=>{const t=await this.get(id);Object.assign(t,patch);await this.saveUnlocked(t);return t})}
  async claimWorker(id:string,pid:number,workerToken?:string){
    return await this.withTaskLock(id,async()=>{
      const t=await this.get(id)
      if(t.status!=='queued') return false
      if(t.workerToken && workerToken && t.workerToken!==workerToken) return false
      t.status='running'; t.pid=pid
      await this.saveUnlocked(t)
      await this.events.append(id,'started',{pid})
      return true
    })
  }
  async attachPid(id:string,pid:number){
    return await this.withTaskLock(id,async()=>{
      const t=await this.get(id)
      if(t.status==='queued'||t.status==='running'){
        t.pid=pid; await this.saveUnlocked(t)
      }
      return t
    })
  }
  async finish(id:string,patch:Partial<TaskRecord>){
    const result=await this.withTaskLock(id,async()=>{
      const t=await this.get(id)
      if(t.status==='cancelled') return t
      Object.assign(t,patch)
      if(['exited','failed','cancelled'].includes(t.status)) t.ended ??= Date.now()
      t.updated=Date.now()
      const terminal=['exited','failed','cancelled'].includes(t.status)
      const needsParentNotification=terminal&&(t.background||t.backgrounded)&&Boolean(t.parentSessionId)&&!t.parentNotified
      if(needsParentNotification){
        try {
          await this.notifyParentCompletion(t)
          t.parentNotified=true
        } catch {}
      }
      await this.saveUnlocked(t)
      return t
    })
    return result
  }
  async recover(){
    const tasks=await this.list()
    for(const t of tasks){
      if(t.status==='queued' && !t.pid){
        const failed=await this.update(t.id,{status:'failed',error:'Worker never started before recovery.',output:(t.output||'')+'\nWorker never started before recovery.',ended:Date.now()})
        if(failed.parentSessionId && (failed.background||failed.backgrounded)) await this.notifyParentCompletion(failed).catch(()=>{})
        continue
      }
      if((t.status==='running'||t.status==='queued') && t.pid){
        let alive=true; try{process.kill(t.pid,0)}catch{alive=false}
        if(!alive){
          const failed=await this.update(t.id,{status:'failed',error:'Worker disappeared before completion.',output:(t.output||'')+'\nWorker disappeared before completion.',ended:Date.now()})
          if(failed.parentSessionId && (failed.background||failed.backgrounded) && !failed.parentNotified) {
            await this.notifyParentCompletion(failed).catch(()=>{})
            await this.update(failed.id,{parentNotified:true}).catch(()=>{})
          }
        }
      }
    }
    await this.cleanup().catch(()=>{})
  }
  async createShell(command:string,cwd:string,parentSessionId?:string,scopePaths?:string[],options:{background?:boolean;coordinated?:boolean;timeoutMs?:number;launchFingerprint?:string;launchRetryCause?:string}={}){
    const normalized=scopePaths?.length?scopePaths.map(String):[]
    this.assertValidScopes(cwd,normalized)
    await this.assertScopeAvailable(cwd,normalized,undefined,Boolean(options.coordinated))
    const id=crypto.randomBytes(5).toString('hex');const outputPath=path.join(this.root,'outputs',`${id}.log`);const t:TaskRecord={id,kind:'shell',command,cwd,started:Date.now(),updated:Date.now(),status:'queued',output:'',outputPath,parentSessionId,scopePaths:normalized,background:Boolean(options.background),coordinated:Boolean(options.coordinated),timeoutMs:options.timeoutMs,launchFingerprint:options.launchFingerprint,launchRetryCause:options.launchRetryCause};await this.save(t);return t
  }
  outputPath(id:string){ return path.join(this.root,'outputs',`${id}.log`) }
  taskRoot(): string { return this.root }
  async createAgent(prompt:string,cwd:string,provider:any,scopePaths?:string[],parentSessionId?:string,options:{permissionMode?:ApprovalMode;permissionRules?:PermissionRule[];allowedTools?:string[];background?:boolean;coordinated?:boolean;sessionId?:string;specialistRole?:string;delegationDepth?:number;parentTaskId?:string;launchFingerprint?:string;launchRetryCause?:string}={}){
    const normalized=scopePaths?.length?scopePaths.map(String):['.']
    this.assertValidScopes(cwd,normalized)
    await this.assertScopeAvailable(cwd,normalized,undefined,Boolean(options.coordinated))
    const active=parentSessionId ? await this.activeAgentTasks(parentSessionId) : []
    const fanout=taskFanoutLimit()
    if(active.length >= fanout) throw new Error(`Agent delegation limit exceeded: ${active.length} active child agent(s) for parent session ${parentSessionId||'unknown'}; at most ${fanout} may run concurrently (TERMAGENT_TASK_MAX_FANOUT).`)
    const depth=Number.isFinite(options.delegationDepth) ? Math.max(0,Math.floor(options.delegationDepth!)) : (options.parentTaskId ? 1 : 0)
    const maxDepth=taskMaxDepth()
    if(depth>maxDepth) throw new Error(`Agent delegation depth ${depth} exceeds the configured maximum of ${maxDepth} (TERMAGENT_TASK_MAX_DEPTH).`)
    const id=crypto.randomBytes(5).toString('hex');const t:TaskRecord={id,kind:'agent',prompt,cwd,started:Date.now(),updated:Date.now(),status:'queued',output:'',provider,sessionId:parentSessionId,parentSessionId,scopePaths:normalized,childSessionId:options.sessionId,permissionMode:options.permissionMode,permissionRules:options.permissionRules,allowedTools:options.allowedTools,background:Boolean(options.background),coordinated:Boolean(options.coordinated),runCount:0,pendingPrompts:[],specialistRole:options.specialistRole||'general',delegationDepth:depth,parentTaskId:options.parentTaskId,launchFingerprint:options.launchFingerprint,launchRetryCause:options.launchRetryCause};await this.save(t);await this.events.append(id,'agent.created',{specialistRole:t.specialistRole,parentSessionId,parentTaskId:t.parentTaskId,delegationDepth:depth,scopePaths:normalized,prompt:prompt.slice(0,500)});return t
  }
  /**
   * 14I-O (item 859): decide whether a new launch is allowed to proceed.
   * A launch is refused when the same unit of work (kind + prompt + scope)
   * is already in flight, already reached a terminal state without a changed
   * cause, already exhausted the retry budget, or failed with a terminal
   * credential error (which must never be auto-retried or respawned).
   */
  async evaluateLaunchAttempt(input:{parentSessionId?:string;fingerprint:string;retryCause?:string;label?:string}):Promise<{allowed:boolean;reason?:'duplicate-in-flight'|'duplicate-terminal'|'terminal-credential'|'retry-budget';taskId?:string;attempts:number;message?:string}>{
    const label=input.label||'task'
    const parentSessionId=input.parentSessionId
    if(!parentSessionId||!input.fingerprint)return {allowed:true,attempts:0}
    const prior=(await this.list()).filter(task=>task.parentSessionId===parentSessionId&&task.launchFingerprint===input.fingerprint)
    if(!prior.length)return {allowed:true,attempts:0}
    const terminal=prior.filter(task=>task.status==='exited'||task.status==='failed'||task.status==='cancelled')
    const inFlight=prior.filter(task=>task.status==='queued'||task.status==='running')
    const credentialTerminal=prior.find(task=>task.terminalCredentialError===true)
    if(credentialTerminal)return {allowed:false,reason:'terminal-credential',taskId:credentialTerminal.id,attempts:prior.length,message:`Refusing to launch ${label}: task ${credentialTerminal.id} failed with a terminal credential error. Fix the credential configuration before launching again; this failure is never retried or replaced automatically.`}
    if(inFlight.length){
      const first=inFlight[0]!
      return {allowed:false,reason:'duplicate-in-flight',taskId:first.id,attempts:prior.length,message:`Refusing to launch ${label}: task ${first.id} is already ${first.status} with identical inputs (same prompt and scope). Wait for it to settle or change the request instead of duplicating the work.`}
    }
    if(!terminal.length)return {allowed:true,attempts:prior.length}
    // list() is ordered newest-first, so the first terminal entry is the most
    // recent attempt for this unit of work.
    const last=terminal[0]!
    const maxRetries=taskMaxRetries()
    if(terminal.length>maxRetries)return {allowed:false,reason:'retry-budget',taskId:last.id,attempts:prior.length,message:`Refusing to launch ${label}: ${terminal.length} previous attempt(s) with identical inputs already reached a terminal state; at most ${maxRetries} retries are allowed (TERMAGENT_TASK_MAX_RETRIES).`}
    const cause=String(input.retryCause||'').trim()
    if(!cause)return {allowed:false,reason:'duplicate-terminal',taskId:last.id,attempts:prior.length,message:`Refusing to launch ${label}: task ${last.id} already ${last.status==='exited'?'completed':last.status} with identical inputs (same prompt and scope). Change the prompt or the scope, or set retry_cause to describe the changed cause before retrying.`}
    // A cause that was already used for this unit of work is not a changed
    // cause: repeating it would reproduce the same deterministic failure.
    const recordedCauses=terminal.map(task=>String(task.launchRetryCause||'').trim()).filter(Boolean)
    if(recordedCauses.includes(cause))return {allowed:false,reason:'duplicate-terminal',taskId:last.id,attempts:prior.length,message:`Refusing to launch ${label}: task ${last.id} already failed with the same retry cause ("${cause}"). A retry requires a materially changed cause or configuration.`}
    return {allowed:true,attempts:prior.length}
  }
  async assertLaunchPermitted(input:{parentSessionId?:string;fingerprint:string;retryCause?:string;label?:string}){
    const decision=await this.evaluateLaunchAttempt(input)
    if(decision.allowed)return
    throw new Error(decision.message||'Task launch refused by the orchestration guardrails.')
  }
  async activeAgentTasks(sessionId:string){ return (await this.list()).filter(t=>t.kind==='agent'&&t.parentSessionId===sessionId&&(t.status==='queued'||t.status==='running')) }
  async appendOutput(id:string,chunk:string){
    if(!chunk)return
    const task=await this.get(id)
    const outputPath=task.outputPath||this.outputPath(id)
    const previous=(this.saveQueues.get(`output:${id}`)||Promise.resolve())
    const next=previous.then(async()=>{await ensureDir(path.dirname(outputPath));await fs.appendFile(outputPath,chunk,'utf8')})
    this.saveQueues.set(`output:${id}`,next.catch(()=>{})); await next
  }
  async flushOutput(id:string){ await (this.saveQueues.get(`output:${id}`)||Promise.resolve()) }
  async readOutput(id:string,maxBytes=20_000,tail=true){
    const task=await this.get(id); await this.flushOutput(id)
    const p=task.outputPath||this.outputPath(id)
    try{
      const stat=await fs.stat(p); if(stat.size===0)return ''
      const n=Math.max(1,Math.min(maxBytes,stat.size))
      if(!tail)return await fs.readFile(p,'utf8').then((x:string)=>x.slice(0,maxBytes))
      const h=await fs.open(p,'r'); try{const start=Math.max(0,stat.size-n);const b=Buffer.alloc(n);const {bytesRead}=await h.read(b,0,n,start);const text=b.subarray(0,bytesRead).toString('utf8');return start>0?`[earlier output omitted]
${text}`:text}finally{await h.close()}
    }catch(error){if((error as {code?:string}).code==='ENOENT')return '';throw error}
  }
  async wait(id:string,timeoutMs=30_000,signal?:AbortSignal,cancelOnAbort=true){
    const started=Date.now()
    while(Date.now()-started<Math.max(0,timeoutMs)){
      if(signal?.aborted){
        if(cancelOnAbort) { await this.cancel(id); throw new Error(`Task ${id} cancelled because the parent run was aborted`) }
        throw new Error(`Task ${id} wait was cancelled because the parent run was aborted`)
      }
      const task=await this.get(id)
      if(task.status!=='queued'&&task.status!=='running') return task
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    return await this.get(id)
  }
  async queuePrompt(id:string,prompt:string){
    const text=String(prompt||'').trim(); if(!text)throw new Error('Task message must not be empty')
    return await this.withTaskLock(id,async()=>{const t=await this.get(id);if(t.kind!=='agent')throw new Error(`Task ${id} is not an agent task`);if(t.status!=='running'&&t.status!=='queued')throw new Error(`Task ${id} is ${t.status}; resume the task instead of sending it a live message`);t.pendingPrompts=[...(t.pendingPrompts||[]),text];await this.saveUnlocked(t);await this.events.append(id,'message_queued',{message:text});return t})
  }
  async resume(id:string,prompt:string){
    const text=String(prompt||'').trim(); if(!text)throw new Error('Task resume prompt must not be empty')
    return await this.withTaskLock(id,async()=>{const t=await this.get(id);if(t.kind!=='agent')throw new Error(`Task ${id} is not an agent task`);if(t.status==='running'||t.status==='queued')throw new Error(`Task ${id} is already ${t.status}; send a message instead`);t.status='queued';t.pid=undefined;t.exitCode=undefined;t.error=undefined;t.termination=undefined;t.result=undefined;t.output='';t.prompt=text;t.pendingPrompts=[];t.updated=Date.now();await this.saveUnlocked(t);await this.events.append(id,'resumed',{prompt:text});return t})
  }
  async takePendingPrompt(id:string){ return await this.withTaskLock(id,async()=>{const t=await this.get(id);const next=t.pendingPrompts?.shift();if(next!==undefined){await this.saveUnlocked(t)}return next}) }
  private async scopesOverlap(cwd:string,a?:string[],b?:string[]){
    if(!a?.length || !b?.length) return false
    const left=a.map(value=>path.resolve(cwd,value)),right=b.map(value=>path.resolve(cwd,value))
    const overlaps=(x:string,y:string)=>x===y||x.startsWith(y+path.sep)||y.startsWith(x+path.sep)
    return left.some(x=>right.some(y=>overlaps(x,y)))
  }
  private assertValidScopes(cwd:string,scopePaths:string[]){
    for(const scope of scopePaths){
      const absolute=path.resolve(cwd,scope)
      if(!within(cwd,absolute)) throw new Error(`Task scope escapes the project: ${scope}`)
    }
  }
  async assertScopeAvailable(cwd:string,scopePaths:string[],ignoreId?:string,coordinated=false){
    const active=(await this.list()).filter(t=>t.status==='queued'||t.status==='running').filter(t=>t.id!==ignoreId)
    for(const existing of active){
      // Two explicitly coordinated launches may not claim the same workspace
      // scope: a coordinated batch already requires non-overlapping scopes,
      // so an overlap between two coordinated tasks is duplicate work and is
      // refused with the conflicting task id.
      if(coordinated&&existing.coordinated){
        if(await this.scopesOverlap(cwd,scopePaths,existing.scopePaths))throw new Error(`Task scope conflict: ${existing.id} (${existing.kind}) already owns an overlapping workspace scope. Coordinate the tasks explicitly or choose a non-overlapping scope.`)
        continue
      }
      if(coordinated || existing.coordinated)continue
      if(await this.scopesOverlap(cwd,scopePaths,existing.scopePaths))throw new Error(`Task scope conflict: ${existing.id} (${existing.kind}) already owns an overlapping workspace scope. Coordinate the tasks explicitly or choose a non-overlapping scope.`)
    }
  }
  async notifyParentCompletion(task:TaskRecord){
    if(!task.parentSessionId)return
    const { SessionStore }=await import('../session/store.js')
    const store=new SessionStore(this.sessionRoot)
    const status=task.status==='exited'?'completed':task.status==='cancelled'?'cancelled':'failed'
    const summary=(task.result||task.error||task.output||'').replace(/\s+/g,' ').trim().slice(0,2000)
    await store.append(task.parentSessionId,{type:'task.notification',ts:Date.now(),data:{taskId:task.id,kind:task.kind,status,summary,outputPath:task.outputPath,childSessionId:task.childSessionId||task.sessionId,completedAt:Date.now()}})
    await this.events.append(task.id,'parent_notified',{parentSessionId:task.parentSessionId,status})
  }
  async cleanup(retentionDays=7){
    const cutoff=Date.now()-Math.max(1,retentionDays)*86400000
    const tasks=await this.list()
    const liveCredentialRefs=new Set<string>()
    for(const task of tasks){
      if((task.status==='queued'||task.status==='running')||task.updated>cutoff)continue
      try{if(task.outputPath)await fs.rm(task.outputPath,{force:true})}catch{}
    }
    for(const task of tasks){
      const ref=task.provider?.credentialRef
      if(!ref)continue
      const settled=task.status!=='queued'&&task.status!=='running'
      if(settled&&task.updated<=cutoff)continue
      liveCredentialRefs.add(ref)
    }
    const credentialDir=path.join(this.root,'credentials')
    let credentialFiles:string[]
    try{credentialFiles=await fs.readdir(credentialDir)}catch{credentialFiles=[]}
    for(const entry of credentialFiles){
      if(!entry.endsWith('.json'))continue
      if(liveCredentialRefs.has(entry.slice(0,-'.json'.length)))continue
      try{await fs.rm(path.join(credentialDir,entry),{force:true})}catch{}
    }
  }
  lastTaskLeaseContention(){ return this.lastTaskLeaseContentionRecord }
  /** Corrupt/unreadable task-record diagnostics (separate class from lock contention). */
  taskRecordDiagnostics(){ return [...this.recordDiagnostics] }
  lastTaskRecordDiagnostic(){ return this.recordDiagnostics[this.recordDiagnostics.length-1] }
  private async noteRecordDiagnostic(id:string,file:string,error:unknown,bytes?:number){
    const code=(error as {code?:string})?.code
    const name=error instanceof Error?error.name:'Error'
    this.recordDiagnostics.push({class:'task-record',kind:code==='ENOENT'?'unreadable-record':'corrupt-record',id,file,bytes,error:code?`${name}:${code}`:name,at:Date.now()})
    while(this.recordDiagnostics.length>32) this.recordDiagnostics.shift()
  }
  private rememberTaskLease(record:TaskLeaseContention){ this.lastTaskLeaseContentionRecord=record }
  private noteLeaseHeld(heldMs:number){
    const record=this.lastTaskLeaseContentionRecord
    if(record&&record.heldMs===undefined) this.lastTaskLeaseContentionRecord={...record,heldMs}
  }
  private async currentProcessIdentityTag():Promise<string|undefined>{
    if(!this.identityTagPromise) this.identityTagPromise=(async()=>{
      const identity=await this.processIdentity(process.pid)
      if(!identity)return undefined
      const executable=String(identity.command||'').split(/\s+/)[0]||''
      const base=path.basename(executable)||'process'
      return `${base}#${identity.startTime||'unknown-start'}`
    })()
    return await this.identityTagPromise
  }
  private async buildLeaseRecord(input:{operation:string;lockId:string;lock:'task'|'session';id:string;opKind:string;attempts:number;waitedMs:number;outcome:'acquired'|'recovered-stale'|'recovered-malformed'|'timeout';decision:'acquired'|'recovered-stale'|'recovered-malformed'|'live-owner'|'failed';ownerPid?:number;ownerIdentity?:string}):Promise<TaskLeaseContention>{
    const jsonlBytes=input.lock==='task'?await this.fileSize(path.join(this.root,`${input.id}.events.jsonl`)):undefined
    const at=Date.now()
    return {
      operation:input.operation,
      lockId:input.lockId,
      attempts:input.attempts,
      waitedMs:input.waitedMs,
      outcome:input.outcome,
      ownerPid:input.ownerPid,
      decidedAt:at,
      lock:input.lock,
      id:input.id,
      opKind:input.opKind,
      waitMs:input.waitedMs,
      retries:Math.max(0,input.attempts-1),
      decision:input.decision,
      at,
      ownerIdentity:input.ownerIdentity,
      heldMs:undefined,
      jsonlBytes,
    }
  }
  private async fileSize(file:string):Promise<number|undefined>{
    const stat=await fs.stat(file).catch(()=>undefined)
    return stat?stat.size:undefined
  }
  private async classifyTaskLease(lockPath:string):Promise<LeaseVerdict> {
    let owner:any
    try{ owner=JSON.parse(await fs.readFile(lockPath,'utf8')) }catch(error){
      const code=(error as {code?:string}).code
      if(code==='ENOENT') return {kind:'gone'}
      const info=await fs.stat(lockPath).catch(()=>undefined)
      if(!info) return {kind:'gone'}
      return Date.now()-info.mtimeMs<TASK_LEASE_MALFORMED_FRESH_MS ? {kind:'wait',reason:'fresh-malformed'} : {kind:'recover-malformed'}
    }
    const pid=Number(owner?.pid)
    const token=typeof owner?.token==='string'?owner.token:''
    const identity=typeof owner?.identity==='string'?owner.identity:undefined
    if(!Number.isInteger(pid)||pid<=0||!token){
      const info=await fs.stat(lockPath).catch(()=>undefined)
      if(!info) return {kind:'gone'}
      return Date.now()-info.mtimeMs<TASK_LEASE_MALFORMED_FRESH_MS ? {kind:'wait',reason:'fresh-malformed'} : {kind:'recover-malformed'}
    }
    try{ process.kill(pid,0); return {kind:'wait',reason:'live-owner',pid,identity} }
    catch(error){
      if((error as {code?:string}).code==='ESRCH') return {kind:'recover-stale',pid,token,identity}
      // EPERM/EACCES: liveness cannot be proven either way; treat the owner as
      // live so an unprovable-dead owner's lock is never deleted.
      return {kind:'wait',reason:'live-owner',pid,identity}
    }
  }
  private async acquireNamedLock(lockPath:string,operation:string,busySubject:string,subjectId:string,lockKind:'task'|'session'='task'):Promise<{lockPath:string;token:string}> {
    await ensureDir(this.root)
    const token=crypto.randomBytes(12).toString('hex')
    const identity=await this.currentProcessIdentityTag()
    const payload=JSON.stringify({pid:process.pid,token,started:Date.now(),identity})+'\n'
    const lockId=path.basename(lockPath)
    const budget=envNonNegativeInt('TERMAGENT_TASK_LOCK_TIMEOUT_MS',TASK_LEASE_DEFAULT_TIMEOUT_MS)
    const startedAt=Date.now()
    let attempt=0
    let waitedMs=0
    let waitMs=TASK_LEASE_INITIAL_WAIT_MS
    let recovery:'stale'|'malformed'|undefined
    let observedPid:number|undefined
    let observedIdentity:string|undefined
    for(;;){
      attempt++
      if(attempt>TASK_LEASE_MAX_ATTEMPTS){
        const elapsed=Date.now()-startedAt
        this.rememberTaskLease(await this.buildLeaseRecord({operation,lockId,lock:lockKind,id:subjectId,opKind:operation,attempts:attempt,waitedMs,outcome:'timeout',decision:'failed',ownerPid:observedPid,ownerIdentity:observedIdentity}))
        throw new Error(`${busySubject} is busy: unable to acquire ${lockId} after ${attempt} attempt(s) and ${elapsed} ms wait (attempt bound reached)`)
      }
      try{
        const handle=await fs.open(lockPath,'wx')
        try{await handle.writeFile(payload,'utf8')}finally{await handle.close()}
        if(attempt>1){
          const outcome=recovery==='stale'?'recovered-stale':recovery==='malformed'?'recovered-malformed':'acquired'
          this.rememberTaskLease(await this.buildLeaseRecord({operation,lockId,lock:lockKind,id:subjectId,opKind:operation,attempts:attempt,waitedMs,outcome,decision:outcome,ownerPid:observedPid,ownerIdentity:observedIdentity}))
        }
        return {lockPath,token}
      }catch(error){
        const code=(error as {code?:string}).code
        // Windows surfaces EPERM for create-exclusive when the file already
        // exists under concurrent acquisition; treat it as contention like
        // EEXIST. A genuine permission problem degrades to the classified
        // busy path below instead of an unclassified crash.
        if(code!=='EEXIST'&&code!=='EPERM') throw error
        const verdict=await this.classifyTaskLease(lockPath)
        if(verdict.pid!==undefined) observedPid=verdict.pid
        if(verdict.identity!==undefined) observedIdentity=verdict.identity
        if(verdict.kind==='gone') continue
        if(verdict.kind==='recover-stale'){
          // Compare-before-recover: re-read and match the exact token that was
          // classified stale, so a lock recreated by a new owner in between is
          // never deleted.
          try{
            const current=JSON.parse(await fs.readFile(lockPath,'utf8'))
            if(current?.token===verdict.token) await fs.rm(lockPath,{force:true})
          }catch{}
          recovery='stale'
          continue
        }
        if(verdict.kind==='recover-malformed'){
          try{await fs.rm(lockPath,{force:true})}catch{}
          recovery='malformed'
          continue
        }
        // live-owner / fresh-malformed: wait within the budget; never delete.
        const elapsed=Date.now()-startedAt
        const remaining=budget-elapsed
        if(remaining<=0){
          const detail=verdict.reason==='live-owner'
            ? `live owner pid ${verdict.pid} still holds the lock`
            : 'malformed or incomplete lock payload aged beyond recovery'
          this.rememberTaskLease(await this.buildLeaseRecord({operation,lockId,lock:lockKind,id:subjectId,opKind:operation,attempts:attempt,waitedMs,outcome:'timeout',decision:verdict.reason==='live-owner'?'live-owner':'failed',ownerPid:verdict.pid,ownerIdentity:verdict.identity}))
          throw new Error(`${busySubject} is busy: unable to acquire ${lockId} after ${attempt} attempt(s) and ${elapsed} ms wait (${detail})`)
        }
        const jittered=Math.round(waitMs*(0.5+Math.random()*0.5))
        const slice=Math.max(1,Math.min(jittered,remaining))
        await new Promise<void>(resolve=>setTimeout(resolve,slice))
        waitedMs+=slice
        waitMs=Math.min(TASK_LEASE_MAX_WAIT_MS,waitMs*2)
      }
    }
  }
  private async releaseNamedLock(lock:{lockPath:string;token:string}){
    try{
      const owner=JSON.parse(await fs.readFile(lock.lockPath,'utf8'))
      if(owner?.pid===process.pid&&owner?.token===lock.token)await fs.rm(lock.lockPath,{force:true})
    }catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
  }
  /**
   * Resolves with the task record once it is no longer queued/running, or
   * undefined when the deadline expires before settlement (or the task record
   * disappears). Same-process settlements wake immediately; cross-process
   * settlements are observed on the bounded poll cadence. Cancellation via
   * abort resolves with the last-known record instead of throwing.
   */
  async waitTaskSettled(id:string,timeoutMs:number,abort?:AbortSignal):Promise<TaskRecord|undefined> {
    const deadline=Date.now()+Math.max(0,timeoutMs)
    for(;;){
      const task=await this.get(id).catch(()=>undefined as TaskRecord|undefined)
      if(!task) return undefined
      if(task.status!=='queued'&&task.status!=='running') return task
      const remaining=deadline-Date.now()
      if(remaining<=0) return undefined
      await this.waitForSettleSignal(Math.min(remaining,TASK_WAIT_FALLBACK_POLL_MS),abort)
    }
  }
  private waitForSettleSignal(sliceMs:number,abort?:AbortSignal):Promise<void> {
    return new Promise(resolve=>{
      let done=false
      const finish=()=>{
        if(done)return
        done=true
        clearTimeout(timer)
        this.settleWaiters.delete(wake)
        if(abort) abort.removeEventListener('abort',onAbort)
        resolve()
      }
      const wake=()=>finish()
      const onAbort=()=>finish()
      const timer=setTimeout(finish,sliceMs)
      this.settleWaiters.add(wake)
      if(abort){ if(abort.aborted) finish(); else abort.addEventListener('abort',onAbort,{once:true}) }
    })
  }
  private wakeSettleWaiters(){
    const waiters=[...this.settleWaiters]
    this.settleWaiters.clear()
    for(const waiter of waiters){ try{waiter()}catch{} }
  }
  async withSessionLock<T>(sessionId:string,fn:()=>Promise<T>):Promise<T>{
    const lock=await this.acquireNamedLock(this.sessionLockFile(sessionId),'session-state','Task scheduler',sessionId,'session')
    const acquiredAt=Date.now()
    try{return await fn()}finally{this.noteLeaseHeld(Date.now()-acquiredAt);await this.releaseNamedLock(lock)}
  }
  private async processIdentity(pid:number){
    if(!Number.isInteger(pid)||pid<=0) return undefined
    try {
      const command=(await fs.readFile(`/proc/${pid}/cmdline`,'utf8')).replaceAll('\0',' ').trim()
      const cwd=await fs.readlink(`/proc/${pid}/cwd`)
      let startTime:string|undefined
      try {
        const stat=(await fs.readFile(`/proc/${pid}/stat`,'utf8')).trim()
        const close=stat.lastIndexOf(')')
        const fields=close>=0?stat.slice(close+2).split(' '):[]
        startTime=fields[19]
      } catch {}
      return {command,cwd,startTime}
    } catch {
      return undefined
    }
  }
  async recordProcessIdentity(id:string,pid:number,expectedCommand?:string,expectedCwd?:string){
    return await this.withTaskLock(id,async()=>{
      const t=await this.get(id)
      const actual=await this.processIdentity(pid)
      const identity=actual||{command:expectedCommand||'',cwd:expectedCwd||t.cwd}
      if(expectedCommand) identity.command=expectedCommand
      if(expectedCwd) identity.cwd=expectedCwd
      t.pid=pid; t.processIdentity=identity
      await this.saveUnlocked(t); return t
    })
  }
  private async matchesProcess(t:TaskRecord){
    if(!t.pid) return false
    try { process.kill(t.pid,0) } catch { return false }
    const actual=await this.processIdentity(t.pid)
    if(!actual||!t.processIdentity) return true
    const commandExpected=t.processIdentity.command
    const commandOk=!commandExpected || actual.command===commandExpected || actual.command.includes(commandExpected) || commandExpected.includes(actual.command)
    const cwdOk=!t.processIdentity.cwd || actual.cwd===t.processIdentity.cwd
    const startOk=!t.processIdentity.startTime || !actual.startTime || actual.startTime===t.processIdentity.startTime
    return commandOk && cwdOk && startOk
  }
  async spawnWorker(id:string,detached=this.workerDetached){
    const task=await this.get(id)
    const workerToken=crypto.randomBytes(16).toString('hex')
    await this.update(id,{workerToken})
    const workerEntry=fileURLToPath(new URL('./worker-entry.js',import.meta.url))
    const env={...process.env,TERMAGENT_TASK_ROOT:this.root,TERMAGENT_WORKER_TOKEN:workerToken}; delete (env as any).NODE_TEST_CONTEXT; delete (env as any).NODE_TEST_WORKER_ID
    const child=spawn(process.execPath,[workerEntry,id],{cwd:task.cwd,detached,stdio:'ignore',env})
    const pid=await new Promise<number>((resolve,reject)=>{
      const onSpawn=()=>{cleanup();resolve(child.pid||0)}
      const onError=(error:Error)=>{cleanup();reject(error)}
      const cleanup=()=>{child.off('spawn',onSpawn);child.off('error',onError)}
      child.once('spawn',onSpawn);child.once('error',onError)
    })
    child.unref(); await this.recordProcessIdentity(id,pid,`${process.execPath} ${workerEntry} ${id}`,task.cwd).catch(()=>{}); return pid
  }
  async cancel(id:string){
    let cancelledTask:TaskRecord|undefined
    let signalledPid:number|undefined
    const result=await this.withTaskLock(id,async()=>{
      const t=await this.get(id)
      const backgroundGroupActive=Boolean(t.backgrounded && t.pid && (await import('../util/child-process.js')).processGroupAlive(t.pid))
      if(t.status!=='queued'&&t.status!=='running'&&!backgroundGroupActive) return t
      let signalled=false
      if(t.pid && await this.matchesProcess(t)){
        signalledPid=t.pid
        try{process.kill(-t.pid,'SIGTERM');signalled=true}catch{try{process.kill(t.pid,'SIGTERM');signalled=true}catch{}}
      }
      t.status='cancelled'; t.termination='cancelled'; t.ended=Date.now(); t.updated=Date.now()
      if(!signalled && t.pid) t.output=(t.output||'')+'\nCancellation did not signal the stored PID because its process identity no longer matched.'
      await this.saveUnlocked(t)
      await this.events.append(id,'cancelled',{signalled})
      cancelledTask=t
      return t
    })
    if(signalledPid) {
      void terminateProcessGroup(signalledPid, { graceMs: 1_500, pollMs: 30 }).catch(()=>{})
    }
    if(cancelledTask){
      const children=(await this.list()).filter(child=>child.parentTaskId===cancelledTask!.id&&(child.status==='queued'||child.status==='running'))
      for(const child of children) await this.cancel(child.id).catch(()=>{})
    }
    if(cancelledTask?.parentSessionId && (cancelledTask.background||cancelledTask.backgrounded) && !cancelledTask.parentNotified){
      try { await this.notifyParentCompletion(cancelledTask); await this.update(cancelledTask.id,{parentNotified:true}) } catch {}
    }
    return result
  }
}
