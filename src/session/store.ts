import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ensureDir } from '../util/fs.js'
import { SnapshotStore } from './snapshot.js'
import { enrichStoredEvent, toDurableEventEnvelope, legacyEventKind, legacyEventCategory } from '../protocol/session-events.js'
import { SessionEventBus } from './event-bus.js'
import type { CommandReceipt, DurableEventEnvelope, EventCategory, EventKind, InteractionRequestState, PermissionRequestState, QuestionRequestState, PermissionResolution, QuestionResolution } from '../protocol/types.js'
import { firstWriterWins } from '../protocol/types.js'
import { canonicalJson } from '../util/canonical.js'

export type ChatMessage = import('../protocol/api.js').ChatMessage
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type SessionEvent = { type:'message'|'meta'|'compaction'|'context.checkpoint'|'context.instructions'|'branch'|'summary'|'todo'|'workflow'|'checkpoint'|'checkpoint.restore'|'turn'|'undo'|'redo'|'skill.search'|'skill.load'|'skill.skip'|'question.asked'|'question.replied'|'question.rejected'|'question.cancelled'|'permission.asked'|'permission.resolved'|'permission.cancelled'|'command.receipt'|'tool.call'|'provider.turn'|'provider.usage'|'task.notification'|'task.notification.consumed'|'prompt.queue'|'mutation'|'diff'|'verification'; ts:number; data:any; eventId?:string; version?:1; sequence?:number; durable?:true; category?:EventCategory; kind?:EventKind }
export type SessionMeta = import('../protocol/api.js').SessionMeta
export type TurnRecord = { id:string; prompt?:string; beforeSnapshot:string; afterSnapshot?:string; afterProtectedSnapshot?:string; started:number; committed?:number; interruptedAt?:number; beforeMessageCount:number; afterMessageCount?:number; status:'started'|'committed'|'failed'|'interrupted'; recovery?:{reason:'daemon-restart';ownerId:string} }
// Redacted, in-memory view of a task.notification awaiting delivery: the task
// identity plus optional child output references and the durable sequence of the
// notification event being consumed. No prompt or credential content is retained.
type PendingTaskNotification={
  taskId:string
  completedAt:number
  kind?:string
  status?:string
  outputPath?:string
  childSessionId?:string
  summary?:string
  notificationSequence:number
}

const SESSION_LOCKS = new Map<string, Promise<void>>()
const SESSION_BUSY = new Set<string>()
type TurnLease = { lockPath:string; token:string }

// Session state lease policy. Mirrors envNonNegativeInt from src/config/config.ts
// because the session domain must not import config.
function envNonNegativeInt(name:string,fallback:number){
  const raw=process.env[name]
  if(raw===undefined||raw.trim()==='') return fallback
  const value=Number(raw)
  return Number.isSafeInteger(value)&&value>=0 ? value : fallback
}
const SESSION_LEASE_INITIAL_WAIT_MS=10
const SESSION_LEASE_MAX_WAIT_MS=200
// ~8x the previous fixed 600 ms budget so concurrent session writes on slow
// mobile/Termux storage stop failing spuriously, while staying well under a
// user-perceived hang; TERMAGENT_SESSION_LOCK_TIMEOUT_MS overrides it.
const SESSION_LEASE_DEFAULT_TIMEOUT_MS=5000
// A lock whose contents cannot be classified (malformed/incomplete payload) may
// still be mid-write by another process; only aged contents are recoverable.
const SESSION_LEASE_MALFORMED_FRESH_MS=5000
// Attempt bound against pathological recreate/delete churn; the wall-clock
// budget above is the primary bound for waiting on a live owner.
const SESSION_LEASE_MAX_ATTEMPTS=512
// Redacted session-state lease contention decision. 'live-owner' means the
// acquisition gave up waiting on a live owner (budget exhausted); 'failed' means
// the attempt bound was exhausted without a resolution.
export type SessionLeaseDecision='acquired'|'recovered-stale'|'recovered-malformed'|'live-owner'|'failed'
export type SessionLeaseOutcome='acquired'|'recovered-stale'|'recovered-malformed'|'timeout'|'failed'
// Structured, redacted session lease contention record (LIVE in-memory state,
// never persisted, never replayed; no prompt text, credentials, or message
// content — only lease mechanics). Field names keep the batch-1 S2
// classification surface (sessionId/operation/attempts/waitedMs/outcome/
// ownerPid/decidedAt) and extend it with hold/diagnostic context (retries,
// decision, heldMs, jsonlBytes, sequenceState, at).
export type SessionLeaseContentionRecord={
  lock:'session'
  sessionId:string
  id:string
  operation:string
  opKind:string
  ownerPid?:number
  ownerIdentity?:string
  attempts:number
  retries:number
  decision:SessionLeaseDecision
  outcome:SessionLeaseOutcome
  waitedMs:number
  heldMs?:number
  jsonlBytes?:number
  sequenceState?:{current:number;cached?:number}
  decidedAt:number
  at:number
}
/** Backwards-compatible alias for the redacted session lease contention record. */
export type SessionLeaseContention=SessionLeaseContentionRecord
// Corrupt-JSONL diagnostics are a SEPARATE class from lock contention and are
// surfaced through their own accessor with their own record type; they are never
// merged into a contention record.
export type SessionDataIssueKind='corrupt-jsonl'|'trailing-partial-repair'
export type SessionDataIssue={
  sessionId:string
  kind:SessionDataIssueKind
  line?:number
  detail:string
  jsonlBytes?:number
  at:number
}
type StateLockVerdict =
  | {kind:'gone';pid?:undefined}
  | {kind:'wait';reason:'live-owner'|'fresh-malformed';pid?:number}
  | {kind:'recover-stale';pid:number}
  | {kind:'recover-malformed';pid?:undefined}

export class SessionStore {
  readonly root:string
  private snapshots = new Map<string, SnapshotStore>()
  private readonly mutationContext = new AsyncLocalStorage<ReadonlySet<string>>()
  readonly events?: SessionEventBus
  constructor(root=path.join(process.env.HOME||process.cwd(),'.termagent','sessions'), eventBus?: SessionEventBus) { this.root=root; this.events=eventBus }
  private snapshotStore(cwd:string, id:string) {
    let store=this.snapshots.get(id)
    if(!store){ store=new SnapshotStore({root:cwd,storeRoot:path.join(path.dirname(this.root),'snapshots',id)}); this.snapshots.set(id,store) }
    return store
  }
  async create(cwd:string,model:string,parent?:{id:string;at:number;checkpointId?:string;snapshotId?:string}) {
    await ensureDir(this.root); const id=`${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
    const meta:SessionMeta={id,cwd,model,created:Date.now(),updated:Date.now(),...(parent?{parentId:parent.id,branchPoint:parent.at,parentCheckpointId:parent.checkpointId,parentSnapshotId:parent.snapshotId}: {})}
    await this.append(id,{type:'meta',ts:Date.now(),data:meta}); if(parent) await this.append(id,{type:'branch',ts:Date.now(),data:parent})
    return meta
  }
  file(id:string){return path.join(this.root,`${id}.jsonl`)}
  private leases = new Map<string, TurnLease>()
  private lastAcquisitionAt=0

  private async withSessionLock<T>(id:string,fn:()=>Promise<T>):Promise<T>{
    const key=this.file(id)
    const previous=SESSION_LOCKS.get(key)??Promise.resolve()
    let release!:()=>void
    const next=new Promise<void>(resolve=>{release=resolve})
    const queued=previous.then(()=>next)
    SESSION_LOCKS.set(key,queued)
    await previous
    try{return await fn()}finally{release();if(SESSION_LOCKS.get(key)===queued)SESSION_LOCKS.delete(key)}
  }

  private turnLockFile(id:string){return path.join(this.root,`.${id}.turn.lock`)}
  private stateLockFile(id:string){return path.join(this.root,`.${id}.state.lock`)}

  private async acquireTurnLease(id:string):Promise<TurnLease>{
    await ensureDir(this.root)
    const lockPath=this.turnLockFile(id)
    const token=crypto.randomBytes(12).toString('hex')
    const payload=JSON.stringify({pid:process.pid,token,started:Date.now()})+'\n'
    for(let attempt=0;attempt<20;attempt++){
      try{
        const handle=await fs.open(lockPath,'wx')
        try{await handle.writeFile(payload,'utf8')}finally{await handle.close()}
        const lease={lockPath,token}
        this.leases.set(id,lease)
        return lease
      }catch(error){
        // EPERM is Windows' create-exclusive "already exists" signal under
        // concurrency; treat it as contention like EEXIST (see manager core).
        const code=(error as {code?:string}).code
        if(code!=='EEXIST'&&code!=='EPERM') throw error
        let owner:any
        try{owner=JSON.parse(await fs.readFile(lockPath,'utf8'))}catch(error){
          if((error as {code?:string}).code==='ENOENT'){continue}
          const info=await fs.stat(lockPath).catch(()=>undefined)
          if(info && Date.now()-info.mtimeMs<5000) throw new Error('Session is busy: another process is acquiring the turn lock')
          // Same recreation guard as below: an aged unparseable lock is only
          // recovered when it has not been recreated since we probed it.
          const confirm=await fs.stat(lockPath).catch(()=>undefined)
          if(!confirm || (info && confirm.mtimeMs===info.mtimeMs && confirm.size===info.size)) await fs.rm(lockPath,{force:true})
          continue
        }
        const pid=Number(owner?.pid)
        if(Number.isInteger(pid) && pid>0){
          try{process.kill(pid,0); throw new Error('Session is busy: another process is running a turn')}
          catch(error){
            if((error as {code?:string}).code!=='ESRCH') throw error
            // Compare-before-recover (turn-lease hardening): the owner may
            // have released and a new acquirer recreated the lock between our
            // liveness probe and the recovery, so only remove the exact
            // payload classified as stale.
            try{
              const current=JSON.parse(await fs.readFile(lockPath,'utf8'))
              if(current?.token===owner?.token) await fs.rm(lockPath,{force:true})
            }catch{}
            continue
          }
        }
        const info=await fs.stat(lockPath).catch(()=>undefined)
        if(info && Date.now()-info.mtimeMs<5000) throw new Error('Session is busy: another process is acquiring the turn lock')
        // Recover an aged malformed lock only if it has not been recreated
        // since we probed it: a fresh mtime/size means another acquirer owns
        // it now, and their lock must not be deleted.
        const confirm=await fs.stat(lockPath).catch(()=>undefined)
        if(!confirm || (info && confirm.mtimeMs===info.mtimeMs && confirm.size===info.size)) await fs.rm(lockPath,{force:true})
        continue
      }
    }
    throw new Error('Session is busy: unable to acquire turn lock')
  }

  private async releaseTurnLease(id:string){
    const lease=this.leases.get(id)
    if(!lease) return
    this.leases.delete(id)
    try{
      const owner=JSON.parse(await fs.readFile(lease.lockPath,'utf8'))
      if(owner?.pid===process.pid && owner?.token===lease.token) await fs.rm(lease.lockPath,{force:true})
    }catch(error){
      if((error as {code?:string}).code!=='ENOENT') throw error
    }
  }

  private async acquireMutationLease(id:string){
    return await this.acquireTurnLease(id)
  }

  // Bounded in-memory contention projection (LIVE state, never persisted):
  // only the most recent contended acquisition is kept; clean acquisitions do
  // not overwrite it. Redacted by construction — no message or credential
  // content, only lease mechanics.
  private lastContention?:SessionLeaseContentionRecord
  lastSessionLeaseContention():SessionLeaseContentionRecord|undefined{
    return this.lastContention?{...this.lastContention}:undefined
  }
  // Corrupt-JSONL / trailing-partial diagnostics are a separate class from lock
  // contention; they are surfaced through their own accessor with their own
  // record type and never merged into the contention projection.
  private lastDataIssue?:SessionDataIssue
  lastSessionDataIssue():SessionDataIssue|undefined{
    return this.lastDataIssue?{...this.lastDataIssue}:undefined
  }

  // NOTE(deferred): robust cross-platform process-start identity (pid + process
  // start time) is deferred to the Windows-port work stream. Stale detection
  // therefore relies on pid liveness plus the lock file's mtime/started
  // heuristics; a recycled pid can keep a stale lock looking live until its
  // contents age past the malformed-fresh recovery threshold.
  private async acquireStateLease(id:string,operation='state'):Promise<TurnLease>{
    await ensureDir(this.root)
    const lockPath=this.stateLockFile(id)
    const token=crypto.randomBytes(12).toString('hex')
    const payload=JSON.stringify({pid:process.pid,token,started:Date.now()})+'\n'
    const budgetMs=envNonNegativeInt('TERMAGENT_SESSION_LOCK_TIMEOUT_MS',SESSION_LEASE_DEFAULT_TIMEOUT_MS)
    const deadline=Date.now()+budgetMs
    let attempts=0
    let waitedMs=0
    let waitIndex=0
    let observedPid:number|undefined
    let recovery:'stale'|'malformed'|undefined
    const recordContention=async(decision:SessionLeaseDecision)=>{
      const decidedAt=Date.now()
      const outcome:SessionLeaseOutcome=decision==='live-owner'?'timeout':decision
      let jsonlBytes:number|undefined
      try{ jsonlBytes=(await fs.stat(this.file(id))).size }catch{ }
      let sequence=0
      try{ sequence=await this.currentSequence(id) }catch{ sequence=0 }
      this.lastContention={
        lock:'session',
        sessionId:id,
        id,
        operation,
        opKind:operation,
        ownerPid:observedPid,
        ownerIdentity:observedPid!==undefined?`pid:${observedPid}`:undefined,
        attempts,
        retries:Math.max(0,attempts-1),
        decision,
        outcome,
        waitedMs,
        heldMs:this.lastAcquisitionAt>0?Math.max(0,Date.now()-this.lastAcquisitionAt):undefined,
        jsonlBytes,
        sequenceState:{current:sequence,cached:this.sequenceCache.get(id)?.sequence},
        decidedAt,
        at:decidedAt,
      }
    }
    while(attempts<SESSION_LEASE_MAX_ATTEMPTS){
      attempts++
      try{
        const handle=await fs.open(lockPath,'wx')
        try{await handle.writeFile(payload,'utf8')}finally{await handle.close()}
        if(attempts>1){
          this.lastAcquisitionAt=Date.now()
          await recordContention(recovery==='stale'?'recovered-stale':recovery==='malformed'?'recovered-malformed':'acquired')
        }
        return {lockPath,token}
      }catch(error){
        // EPERM is Windows' create-exclusive "already exists" signal under
        // concurrency; treat it as contention like EEXIST (see manager core).
        const code=(error as {code?:string}).code
        if(code!=='EEXIST'&&code!=='EPERM')throw error
        const verdict=await this.classifyStateLock(lockPath)
        observedPid=verdict.pid
        if(verdict.kind==='gone')continue
        if(verdict.kind==='wait'){
          const remaining=deadline-Date.now()
          if(remaining<=0){
            // Budget exhausted while a live owner holds the lock: report and
            // leave the owner's lock untouched. Never delete on timeout.
            await recordContention('live-owner')
            const detail=verdict.reason==='live-owner'&&verdict.pid!==undefined?`live owner pid ${verdict.pid} still holds the state lock`:'malformed or incomplete state lock contents'
            throw new Error(`Session state is busy: unable to acquire state lock after ${attempts} attempt(s) and ${waitedMs} ms wait (${detail})`)
          }
          const wait=Math.max(0,Math.min(Math.round(Math.min(SESSION_LEASE_MAX_WAIT_MS,SESSION_LEASE_INITIAL_WAIT_MS*2**waitIndex)*(0.5+Math.random()*0.5)),remaining))
          waitIndex++
          if(wait>0){await new Promise(resolve=>setTimeout(resolve,wait));waitedMs+=wait}
          continue
        }
        // Stale owner (provable dead pid) or aged malformed/incomplete
        // contents: recover immediately, then retry the open attempt.
        recovery=verdict.kind==='recover-stale'?'stale':'malformed'
        await fs.rm(lockPath,{force:true})
        // Jitter after recovery keeps concurrent recovery loops from deleting
        // and recreating the same lock in lockstep.
        await new Promise(resolve=>setTimeout(resolve,1+Math.floor(Math.random()*9)))
      }
    }
    await recordContention('failed')
    throw new Error(`Session state is busy: unable to acquire state lock after ${attempts} attempt(s) and ${waitedMs} ms wait (acquisition attempts exhausted)`)
  }

  private async classifyStateLock(lockPath:string):Promise<StateLockVerdict>{
    let owner:any
    try{owner=JSON.parse(await fs.readFile(lockPath,'utf8'))}catch(error){
      if((error as {code?:string}).code==='ENOENT')return {kind:'gone'}
      return await this.stateLockFreshnessVerdict(lockPath)
    }
    const pid=Number(owner?.pid)
    const started=Number(owner?.started)
    const complete=Number.isInteger(pid)&&pid>0&&Number.isFinite(started)&&started>0&&typeof owner?.token==='string'&&owner.token.length>0
    if(!complete)return await this.stateLockFreshnessVerdict(lockPath)
    try{
      process.kill(pid,0)
      return {kind:'wait',reason:'live-owner',pid}
    }catch(error){
      if((error as {code?:string}).code==='ESRCH')return {kind:'recover-stale',pid}
      // EPERM/EACCES or any other unresolved liveness signal means we could not
      // prove the owner is dead; treat it as live so its lock is never deleted.
      return {kind:'wait',reason:'live-owner',pid}
    }
  }

  private async stateLockFreshnessVerdict(lockPath:string):Promise<StateLockVerdict>{
    const info=await fs.stat(lockPath).catch(()=>undefined)
    if(info&&Date.now()-info.mtimeMs<SESSION_LEASE_MALFORMED_FRESH_MS)return {kind:'wait',reason:'fresh-malformed'}
    return {kind:'recover-malformed'}
  }
  private async releaseStateLease(lease:TurnLease){
    const heldMs=this.lastAcquisitionAt>0?Math.max(0,Date.now()-this.lastAcquisitionAt):undefined
    this.lastAcquisitionAt=0
    const record=this.lastContention
    if(heldMs!==undefined&&record)record.heldMs=heldMs
    try{
      // Compare-before-release: only delete the lock file whose payload token
      // still matches the token we acquired; a foreign or tampered owner's
      // lock must never be removed by our release path.
      const owner=JSON.parse(await fs.readFile(lease.lockPath,'utf8'))
      if(owner?.token===lease.token)await fs.rm(lease.lockPath,{force:true})
    }catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
  }
  async withSessionMutation<T>(id:string,fn:()=>Promise<T>,operation:string='mutation'):Promise<T>{
    // Re-entrancy must be scoped to the current async call chain. A process-wide
    // per-session depth counter lets an unrelated concurrent worker mistake an
    // in-flight transaction for its own nested call and skip the lease. That
    // can allocate duplicate durable sequence numbers under daemon load.
    const inherited=this.mutationContext.getStore()
    if(inherited?.has(id))return await fn()
    return await this.withSessionLock(id,async()=>{
      const lease=await this.acquireStateLease(id,operation)
      const active=new Set(inherited??[])
      active.add(id)
      try{return await this.mutationContext.run(active,fn)}finally{await this.releaseStateLease(lease)}
    })
  }

  private async readEventsRaw(id:string):Promise<SessionEvent[]>{
    const text=await fs.readFile(this.file(id),'utf8')
    const lines=text.split('\n')
    const events:SessionEvent[]=[]
    let lastNonEmpty=-1
    for(let i=lines.length-1;i>=0;i--){if(lines[i]?.trim()){lastNonEmpty=i;break}}
    for(let i=0;i<=lastNonEmpty;i++){
      const line=lines[i]
      if(!line?.trim())continue
      try{events.push(JSON.parse(line) as SessionEvent)}
      catch(error){
        if(i===lastNonEmpty)break
        const info=await fs.stat(this.file(id)).catch(()=>undefined)
        const issue:SessionDataIssue={sessionId:id,kind:'corrupt-jsonl',line:i+1,detail:'invalid-json-line',at:Date.now()}
        if(info)issue.jsonlBytes=info.size
        this.lastDataIssue=issue
        throw new Error(`Corrupt session log at line ${i+1}: ${(error as Error).message}`)
      }
    }
    return events
  }

  private async nextDurableSequence(id:string):Promise<number>{
    let events:SessionEvent[]=[]
    try{events=await this.readEventsRaw(id)}catch(error){
      if((error as {code?:string}).code==='ENOENT')return 1
      throw error
    }
    let maximum=0
    for(let i=0;i<events.length;i++){
      const candidate=Number.isSafeInteger(events[i]?.sequence)&&Number(events[i]?.sequence)>0 ? Number(events[i]!.sequence) : i+1
      if(candidate>maximum)maximum=candidate
    }
    if(maximum>=Number.MAX_SAFE_INTEGER)throw new Error('Session durable event sequence exhausted safe integer range')
    return maximum+1
  }

  private async repairTrailingPartialEvent(id:string){
    let text:string
    try{text=await fs.readFile(this.file(id),'utf8')}catch(error){
      if((error as {code?:string}).code==='ENOENT') return
      throw error
    }
    const lines=text.split('\n')
    let lastNonEmpty=-1
    for(let i=lines.length-1;i>=0;i--){if(lines[i].trim().length>0){lastNonEmpty=i;break}}
    if(lastNonEmpty<0) return
    const candidate=lines[lastNonEmpty]
    try{JSON.parse(candidate)}catch{
      const issue:SessionDataIssue={sessionId:id,kind:text.endsWith('\n')?'corrupt-jsonl':'trailing-partial-repair',line:lastNonEmpty+1,detail:text.endsWith('\n')?'invalid-json-line':'partial-trailing-record',at:Date.now()}
      let jsonlBytes:number|undefined
      try{jsonlBytes=(await fs.stat(this.file(id))).size}catch{}
      issue.jsonlBytes=jsonlBytes
      this.lastDataIssue=issue
      if(text.endsWith('\n')) throw new Error(`Corrupt trailing session event at line ${lastNonEmpty+1}`)
      const offset=lines.slice(0,lastNonEmpty).reduce((total,line)=>total+line.length+1,0)
      await fs.truncate(this.file(id),offset)
    }
  }

  private async appendCore(id:string,event:SessionEvent){
    await ensureDir(this.root)
    // Durable-sequence append optimization (Phase 14I batch 2): the fast path
    // reuses the sequence cached after our own last append when the file size
    // still matches, skipping the two full-history JSONL rescans (repair scan
    // + max-sequence scan) that previously ran per append. The cache is
    // DERIVED state validated against the file before every use: any external
    // append, truncation, or cache loss (including after a crash) falls back
    // to the authoritative full scan, so cross-process correctness, atomic
    // monotonic sequences, and crash recovery are unchanged. The validation
    // runs while the state lease is held, so no other writer can move the
    // file between the size check and the append.
    const cached=await this.fastNextSequence(id)
    let sequence:number
    if(cached===undefined){
      await this.repairTrailingPartialEvent(id)
      sequence=await this.nextDurableSequence(id)
    }else{
      sequence=cached
    }
    const enriched=enrichStoredEvent(id,event,sequence)
    await fs.appendFile(this.file(id),JSON.stringify(enriched)+'\n')
    const size=await this.fileSize(id)
    if(size===undefined) this.sequenceCache.delete(id)
    else this.sequenceCache.set(id,{sequence,size})
    this.events?.publishDurable(toDurableEventEnvelope(id,enriched,sequence))
    return enriched
  }

  private sequenceCache=new Map<string,{sequence:number;size:number}>()
  private async fileSize(id:string):Promise<number|undefined>{
    try{ const info=await fs.stat(this.file(id)); return info.size }catch{ return undefined }
  }
  private async fastNextSequence(id:string):Promise<number|undefined>{
    const cached=this.sequenceCache.get(id)
    if(!cached) return undefined
    const size=await this.fileSize(id)
    if(size===undefined||size!==cached.size){ this.sequenceCache.delete(id); return undefined }
    return cached.sequence+1
  }
  private async fastCurrentSequence(id:string):Promise<number|undefined>{
    const cached=this.sequenceCache.get(id)
    if(!cached) return undefined
    const size=await this.fileSize(id)
    if(size===undefined||size!==cached.size){ this.sequenceCache.delete(id); return undefined }
    return cached.sequence
  }

  private async appendUnlocked(id:string,event:SessionEvent){
    if(this.mutationContext.getStore()?.has(id))return await this.appendCore(id,event)
    const lease=await this.acquireStateLease(id,'append')
    try{return await this.appendCore(id,event)}finally{await this.releaseStateLease(lease)}
  }

  async append(id:string,event:SessionEvent){
    if(this.mutationContext.getStore()?.has(id)) return await this.appendUnlocked(id,event)
    return await this.withSessionLock(id,()=>this.appendUnlocked(id,event))
  }
  async currentSequence(id:string):Promise<import('../protocol/types.js').DurableSequence>{
    const cached=await this.fastCurrentSequence(id)
    if(cached!==undefined) return cached as import('../protocol/types.js').DurableSequence
    let events:SessionEvent[]=[]
    try{events=await this.readEventsRaw(id)}catch(error){
      if((error as {code?:string}).code==='ENOENT')return 0 as import('../protocol/types.js').DurableSequence
      throw error
    }
    let maximum=0
    for(let i=0;i<events.length;i++){
      const candidate=Number.isSafeInteger(events[i]?.sequence)&&Number(events[i]?.sequence)>0 ? Number(events[i]!.sequence) : i+1
      if(candidate>maximum)maximum=candidate
    }
    return maximum as import('../protocol/types.js').DurableSequence
  }

  async revision(id:string):Promise<string>{
    let events:SessionEvent[]=[]
    try{events=await this.readEventsRaw(id)}catch(error){
      if((error as {code?:string}).code==='ENOENT')return crypto.createHash('sha256').update(`${id}\0empty`).digest('hex')
      throw error
    }
    const last=events.at(-1)
    const sequence=await this.currentSequence(id)
    const eventId=last?.eventId ?? (last ? enrichStoredEvent(id,last,Number(sequence||events.length)).eventId : 'none')
    return crypto.createHash('sha256').update(canonicalJson({sessionId:id,sequence,eventId})).digest('hex')
  }

  async durableEvents(id:string,after=0,limit=100):Promise<{events:DurableEventEnvelope[];hasMore:boolean;currentSequence:import('../protocol/types.js').DurableSequence}>{
    if(after<0||!Number.isSafeInteger(after))throw new Error('Invalid durable event cursor')
    const size=Math.max(1,Math.min(100,Math.floor(limit)))
    const loaded=await this.load(id)
    const mapped:DurableEventEnvelope[]=[]
    for(let i=0;i<loaded.events.length;i++){
      const event=loaded.events[i]!
      const sequence = Number.isSafeInteger(event.sequence) && Number(event.sequence) > 0 ? Number(event.sequence) : i + 1
      if(sequence<=after)continue
      mapped.push(toDurableEventEnvelope(id,event,sequence))
    }
    let previous=after
    for(const event of mapped){
      if(event.sequence<=previous) throw new Error(`Session durable event sequence is not strictly increasing: ${previous} -> ${event.sequence}`)
      previous=event.sequence
    }
    const page=mapped.slice(0,size)
    return {events:page,hasMore:mapped.length>size,currentSequence:await this.currentSequence(id)}
  }

  async getCommandReceipt(id:string,key:string):Promise<{key:string;fingerprint:string;receipt:CommandReceipt}|undefined>{
    const loaded=await this.load(id)
    for(let i=loaded.events.length-1;i>=0;i--){
      const event=loaded.events[i]
      if(event?.type!=='command.receipt')continue
      if(String(event.data?.key||'')!==key)continue
      if(!event.data?.receipt)return undefined
      return {key,fingerprint:String(event.data.fingerprint||''),receipt:event.data.receipt as CommandReceipt}
    }
    return undefined
  }

  async appendCommandReceipt(id:string,key:string,fingerprint:string,receipt:CommandReceipt){
    await this.append(id,{type:'command.receipt',ts:Date.now(),data:{key,fingerprint,receipt}})
  }

  async interactionStates(id:string):Promise<InteractionRequestState[]>{
    const loaded=await this.load(id)
    const states=new Map<string,InteractionRequestState>()
    for(const event of loaded.events){
      const data=event.data||{}
      const requestId=typeof data.requestId==='string'?data.requestId:''
      if(!requestId)continue
      if(event.type==='permission.asked'){
        const prior=states.get(requestId)
        if(prior && prior.kind==='permission' && prior.status!=='pending') continue
        states.set(requestId,{kind:'permission',requestId,sessionId:id,revision:Math.max(Number(data.revision||1),prior?.revision||0),status:'pending',tool:String(data.tool||''),...(typeof data.toolCallId==='string'?{toolCallId:data.toolCallId}:{}),action:String(data.action||''),resources:Array.isArray(data.resources)?data.resources.map(String):[],createdAt:Number(data.createdAt||event.ts)})
        continue
      }
      if(event.type==='permission.resolved' || event.type==='permission.cancelled'){
        const prior=states.get(requestId)
        if(!prior||prior.kind!=='permission')continue
        const status=event.type==='permission.cancelled'?'cancelled':'resolved'
        states.set(requestId,{...prior,status,resolvedAt:Number(data.resolvedAt||event.ts),revision:prior.revision+1,...(event.type==='permission.cancelled'&&typeof data.reason==='string'?{cancelReason:data.reason}:{}),resolution:event.type==='permission.resolved'?data.resolution:undefined})
        continue
      }
      if(event.type==='question.asked'){
        const questions=Array.isArray(data.questions)?data.questions.map((q:any,i:number)=>({id:String(q?.id||`q_${i+1}`),question:String(q?.question||''),...(Array.isArray(q?.options)?{options:q.options.map((o:any)=>({label:String(o?.label||''),description:o?.description===undefined?undefined:String(o.description)})).filter((o:any)=>o.label)}:{}),...(q?.multiple!==undefined||q?.multi!==undefined?{multi:Boolean(q?.multiple??q?.multi)}:{})})):[]
        const prior=states.get(requestId)
        if(prior && prior.kind==='question' && prior.status!=='pending') continue
        states.set(requestId,{kind:'question',requestId,sessionId:id,revision:Math.max(Number(data.revision||1),prior?.revision||0),status:'pending',questions,createdAt:Number(data.createdAt||event.ts)})
        continue
      }
      if(event.type==='question.replied' || event.type==='question.rejected' || event.type==='question.cancelled'){
        const prior=states.get(requestId)
        if(!prior||prior.kind!=='question')continue
        states.set(requestId,{...prior,status:event.type==='question.replied'?'replied':event.type==='question.rejected'?'rejected':'cancelled',resolvedAt:Number(data.resolvedAt||event.ts),revision:prior.revision+1,resolution:{commandId:String(data.commandId||''),clientId:String(data.clientId||'runtime'),disposition:event.type==='question.replied'?'replied':event.type==='question.rejected'?'rejected':'cancelled',...(Array.isArray(data.answers)?{answers:data.answers.map((a:any)=>Array.isArray(a)?a.map(String):[String(a)])}:{})}})
      }
    }
    return [...states.values()]
  }


  async waitForInteractionResolution(id:string,requestId:string,signal?:AbortSignal,timeoutMs=86_400_000){
    // Subscribe before reading the durable projection. The event bus is only a
    // wakeup; the append-only session log remains the source of truth.
    const subscription=this.events?.subscribe(id)
    const timeout=Math.max(1,timeoutMs)
    let timer:ReturnType<typeof setTimeout>|undefined
    let abortListener:(()=>void)|undefined
    try {
      const timeoutPromise=new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>reject(new Error(`Interaction request timed out: ${requestId}`)),timeout)
      })
      // A shutdown can abort before the first durable-state read finishes. Mark
      // these long-lived race branches handled immediately; Promise.race below
      // still observes and propagates their rejection to the waiter.
      void timeoutPromise.catch(()=>undefined)
      const abortPromise=signal ? new Promise<never>((_,reject)=>{
        abortListener=()=>reject(new Error(`Interaction ${requestId} cancelled`))
        signal.addEventListener('abort',abortListener,{once:true})
        if(signal.aborted)abortListener()
      }) : undefined
      if(abortPromise)void abortPromise.catch(()=>undefined)

      while(true){
        const state=await this.getInteractionState(id,requestId)
        if(!state) throw new Error(`Interaction request not found: ${requestId}`)
        if(state.status!=='pending') return state
        if(signal?.aborted) throw new Error(`Interaction ${requestId} cancelled`)
        const changed=subscription?.waitForChange() ?? new Promise<boolean>(resolve=>setTimeout(()=>resolve(true),250))
        try {
          await Promise.race([changed,timeoutPromise,...(abortPromise?[abortPromise]:[])])
        } catch(error) {
          // An abort/timeout can race with a durable reply. Re-read before
          // rejecting so the committed first-writer decision always wins.
          const latest=await this.getInteractionState(id,requestId)
          if(latest && latest.status!=='pending') return latest
          throw error
        }
      }
    } finally {
      if(signal&&abortListener) signal.removeEventListener('abort',abortListener)
      if(timer)clearTimeout(timer)
      subscription?.close()
    }
  }

  async pendingInteractions(id:string):Promise<InteractionRequestState[]>{
    return (await this.interactionStates(id)).filter(state=>state.status==='pending')
  }

  /**
   * Reconcile runtime-owned state left pending by a process that exited without
   * graceful shutdown. Call only after the workspace daemon lease is acquired.
   */
  async recoverOrphanedRuntimeState(cwd:string,ownerId:string,preserveSessionIds:ReadonlySet<string>=new Set()){
    const workspace=path.resolve(cwd)
    const sessions=await this.listForWorkspace(workspace)
    let permissionsCancelled=0
    let questionsCancelled=0
    let turnsInterrupted=0
    let taskSessionsPreserved=0
    for(const meta of sessions){
      const id=String(meta.id||'')
      if(!id)continue
      if(preserveSessionIds.has(id)){taskSessionsPreserved++;continue}
      const loaded=await this.load(id)
      if(!loaded.meta||path.resolve(loaded.meta.cwd)!==workspace)continue
      for(const interaction of await this.pendingInteractions(id)){
        try{
          if(interaction.kind==='permission'){
            const result=await this.cancelPermission(id,interaction.requestId,'daemon-restart')
            if(result.applied)permissionsCancelled++
          }else{
            const result=await this.resolveQuestion(id,interaction.requestId,{
              commandId:`daemon-recovery-${ownerId}-${interaction.requestId}`,
              clientId:`daemon-recovery:${ownerId}`,
              disposition:'cancelled',
            })
            if(result.applied)questionsCancelled++
          }
        }catch(error){
          // A reply committed during recovery wins. Other errors remain visible
          // to the caller rather than silently leaving runtime state ambiguous.
          const latest=await this.getInteractionState(id,interaction.requestId).catch(()=>undefined)
          if(latest?.status==='pending')throw error
        }
      }
      const turnState=new Map<string,{turn:TurnRecord;terminal:boolean}>()
      for(const event of loaded.events){
        if(event.type!=='turn'||!event.data||typeof event.data!=='object')continue
        const turn=event.data as TurnRecord
        if(!turn.id)continue
        if(turn.status==='started')turnState.set(turn.id,{turn,terminal:false})
        else if(['committed','failed','interrupted'].includes(turn.status)){
          const current=turnState.get(turn.id)
          if(current)current.terminal=true
        }
      }
      for(const {turn,terminal} of turnState.values()){
        if(terminal)continue
        const interruptedAt=Date.now()
        await this.append(id,{type:'turn',ts:interruptedAt,data:{
          ...turn,
          status:'interrupted',
          interruptedAt,
          recovery:{reason:'daemon-restart',ownerId},
        }})
        turnsInterrupted++
      }
    }
    return {sessionsChecked:sessions.length,taskSessionsPreserved,permissionsCancelled,questionsCancelled,turnsInterrupted}
  }

  async listForWorkspace(cwd:string){
    await ensureDir(this.root)
    const workspace=path.resolve(cwd)
    const files=(await fs.readdir(this.root)).filter((name:string)=>name.endsWith('.jsonl')).sort().reverse()
    const output:any[]=[]
    for(const file of files){
      try{
        const first=(await fs.readFile(path.join(this.root,file),'utf8')).split('\n',1)[0]
        const meta=JSON.parse(first).data
        if(meta&&typeof meta.id==='string'&&typeof meta.cwd==='string'&&path.resolve(meta.cwd)===workspace)output.push(meta)
      }catch{}
    }
    return output
  }

  async getInteractionState(id:string,requestId:string):Promise<InteractionRequestState|undefined>{
    return (await this.interactionStates(id)).find(state=>state.requestId===requestId)
  }

  async resolvePermission(id:string,requestId:string,resolution:PermissionResolution){
    return await this.withSessionMutation(id,async()=>{
      const request=await this.getInteractionState(id,requestId)
      if(!request||request.kind!=='permission')throw new Error(`Permission request not found: ${requestId}`)
      const result=firstWriterWins(request,resolution)
      if(result.applied){
        await this.append(id,{type:resolution.decision==='deny'?'permission.resolved':'permission.resolved',ts:Date.now(),data:{requestId,resolvedAt:result.request.resolvedAt,resolution}})
      }
      return result
    })
  }

  async cancelPermission(id:string,requestId:string,reason='cancelled'){
    return await this.withSessionMutation(id,async()=>{
      const request=await this.getInteractionState(id,requestId)
      if(!request||request.kind!=='permission')throw new Error(`Permission request not found: ${requestId}`)
      if(request.status!=='pending')return {applied:false as const,reason:'already-resolved' as const,request}
      const resolvedAt=Date.now()
      await this.append(id,{type:'permission.cancelled',ts:resolvedAt,data:{requestId,reason,resolvedAt}})
      const cancelled=await this.getInteractionState(id,requestId)
      if(!cancelled||cancelled.kind!=='permission')throw new Error(`Permission request disappeared while being cancelled: ${requestId}`)
      return {applied:true as const,request:cancelled}
    })
  }

  async resolveQuestion(id:string,requestId:string,resolution:QuestionResolution){
    return await this.withSessionMutation(id,async()=>{
      const request=await this.getInteractionState(id,requestId)
      if(!request||request.kind!=='question')throw new Error(`Question request not found: ${requestId}`)
      const result=firstWriterWins(request,resolution)
      if(result.applied){
        const eventType=resolution.disposition==='replied'?'question.replied':resolution.disposition==='rejected'?'question.rejected':'question.cancelled'
        await this.append(id,{type:eventType,ts:Date.now(),data:{requestId,commandId:resolution.commandId,clientId:resolution.clientId,answers:resolution.answers??[],resolvedAt:result.request.resolvedAt}})
      }
      return result
    })
  }

  private async assertCwd(id:string,cwd:string){
    const loaded=await this.load(id)
    const expected=path.resolve(loaded.meta?.cwd||'')
    const actual=path.resolve(cwd)
    if(!loaded.meta) throw new Error(`Invalid session: ${id}`)
    if(expected!==actual) throw new Error(`Session belongs to ${loaded.meta.cwd}; refusing to operate on ${cwd}`)
  }

  // Task notification consumed-marker payload. Keeps the batch-2 marker shape
  // ({taskId, completedAt}) backward compatible while preserving child output
  // references and the durable notification sequence for deliberate retrieval.
  private taskNotificationMarkerData(notification:{taskId?:unknown;completedAt?:unknown;kind?:unknown;status?:unknown;outputPath?:unknown;childSessionId?:unknown;notificationSequence?:unknown}){
    const taskId=String(notification.taskId||'')
    const completedAt=Number(notification.completedAt||Date.now())
    const data:{taskId:string;completedAt:number;kind?:string;status?:string;outputPath?:string;childSessionId?:string;notificationSequence:number}={taskId,completedAt,notificationSequence:Number(notification.notificationSequence||0)}
    if(typeof notification.kind==='string')data.kind=notification.kind
    if(typeof notification.status==='string')data.status=notification.status
    if(typeof notification.outputPath==='string')data.outputPath=notification.outputPath
    if(typeof notification.childSessionId==='string')data.childSessionId=notification.childSessionId
    data.notificationSequence=Number(notification.notificationSequence||0)
    return data
  }
  private async collectPendingTaskNotifications(id:string):Promise<PendingTaskNotification[]>{
    const loaded=await this.load(id)
    const consumed=new Set(loaded.events.filter((event:SessionEvent)=>event.type==='task.notification.consumed').map((event:SessionEvent)=>String(event.data?.taskId||'')))
    const pending:PendingTaskNotification[]=[]
    for(const event of loaded.events){
      if(event.type!=='task.notification')continue
      const item=event.data
      if(!item||typeof item!=='object')continue
      const taskId=String((item as {taskId?:unknown}).taskId||'')
      if(!taskId||consumed.has(taskId))continue
      pending.push({
        taskId,
        completedAt:Number((item as {completedAt?:unknown}).completedAt||Date.now()),
        kind:typeof (item as {kind?:unknown}).kind==='string'?(item as {kind:string}).kind:undefined,
        status:typeof (item as {status?:unknown}).status==='string'?(item as {status:string}).status:undefined,
        outputPath:typeof (item as {outputPath?:unknown}).outputPath==='string'?(item as {outputPath:string}).outputPath:undefined,
        childSessionId:typeof (item as {childSessionId?:unknown}).childSessionId==='string'?(item as {childSessionId:string}).childSessionId:undefined,
        summary:typeof (item as {summary?:unknown}).summary==='string'?(item as {summary:string}).summary:undefined,
        notificationSequence:Number(event.sequence||0),
      })
    }
    return pending
  }
  async consumeTaskNotifications(id:string):Promise<PendingTaskNotification[]>{
    return await this.withSessionLock(id,async()=>{
      const pending=await this.collectPendingTaskNotifications(id)
      for(const notification of pending) await this.appendUnlocked(id,{type:'task.notification.consumed',ts:Date.now(),data:this.taskNotificationMarkerData(notification)})
      return pending
    })
  }
  async pendingTaskNotifications(id:string):Promise<unknown[]>{
    // Observe-only: no consumed markers, no durable mutation. Reconnect and
    // restart paths use this to check for undelivered task notifications before
    // re-entering the deliver pass.
    return await this.withSessionLock(id,async()=>{
      const pending=await this.collectPendingTaskNotifications(id)
      return pending
    })
  }
  async deliverTaskNotifications(id:string,deliver:(notification:unknown)=>Promise<void>):Promise<unknown[]>{
    // Delivery is at-least-once and never-lost: each pending notification is
    // handed to the deliver callback first and only after the delivery settles
    // is the task.notification.consumed marker (carrying the notification
    // sequence) appended, so a crash between deliver and marker re-delivers on
    // the next pass. The marker prevents duplicate delivery once it lands.
    // Dedup semantics: the taskId task.notification.consumed marker set is the
    // cross-pass deduplication primitive; within a single pass a taskId observed
    // more than once (duplicate worker completion) is collapsed to one delivery.
    return await this.withSessionMutation(id,async()=>{
      const pending=await this.collectPendingTaskNotifications(id)
      const delivered:unknown[]=[]
      const deliveredTaskIds=new Set<string>()
      for(const notification of pending){
        const taskId=notification.taskId
        if(deliveredTaskIds.has(taskId))continue
        deliveredTaskIds.add(taskId)
        await deliver(notification)
        delivered.push(notification)
        await this.appendUnlocked(id,{type:'task.notification.consumed',ts:Date.now(),data:this.taskNotificationMarkerData(notification)})
      }
      return delivered
    },'deliver')
  }

  async appendTodo(id:string,items:any[],previous?:any[]){await this.append(id,{type:'todo',ts:Date.now(),data:{items,previous:previous||[]}})}
  async getTodo(id:string){const loaded=await this.load(id);const e=[...loaded.events].reverse().find((x:SessionEvent)=>x.type==='todo');return Array.isArray(e?.data?.items)?e.data.items:[]}
  async appendQuestionAsked(id:string,data:any){await this.append(id,{type:'question.asked',ts:Date.now(),data:{...data,createdAt:data.createdAt??Date.now(),revision:data.revision??1}})}
  async appendQuestionReplied(id:string,data:any){await this.append(id,{type:'question.replied',ts:Date.now(),data:{...data,resolvedAt:data.resolvedAt??Date.now()}})}
  async appendQuestionRejected(id:string,data:any){await this.append(id,{type:'question.rejected',ts:Date.now(),data:{...data,resolvedAt:data.resolvedAt??Date.now()}})}
  async appendQuestionCancelled(id:string,data:any){await this.append(id,{type:'question.cancelled',ts:Date.now(),data:{...data,resolvedAt:data.resolvedAt??Date.now()}})}
  async getQuestion(id:string,requestId:string){const loaded=await this.load(id);for(let i=loaded.events.length-1;i>=0;i--){const e=loaded.events[i];if(e?.type==='question.replied' || e?.type==='question.rejected' || e?.type==='question.cancelled'){if(String(e.data?.requestId||'')===requestId)return e.data}}return undefined}
  async getQuestionState(id:string,requestId:string){const pending=await this.pendingInteractions(id);const current=pending.find(state=>state.kind==='question'&&state.requestId===requestId);if(current)return current;const loaded=await this.load(id);for(let i=loaded.events.length-1;i>=0;i--){const e=loaded.events[i];if(String(e?.data?.requestId||'')!==requestId)continue;if(e.type==='question.asked'){const states=await this.pendingInteractions(id);return states.find(state=>state.kind==='question'&&state.requestId===requestId)}if(['question.replied','question.rejected','question.cancelled'].includes(e.type)){const all=await this.pendingInteractions(id);return all.find(state=>state.kind==='question'&&state.requestId===requestId)} }return undefined}
  async appendPermissionAsked(id:string,data:any){await this.append(id,{type:'permission.asked',ts:Date.now(),data:{...data,createdAt:data.createdAt??Date.now(),revision:data.revision??1}})}
  async appendPermissionResolved(id:string,data:any){await this.append(id,{type:'permission.resolved',ts:Date.now(),data:{...data,resolvedAt:data.resolvedAt??Date.now()}})}
  async appendPermissionCancelled(id:string,data:any){await this.append(id,{type:'permission.cancelled',ts:Date.now(),data:{...data,resolvedAt:data.resolvedAt??Date.now()}})}
  async appendWorkflow(id:string,data:any){await this.append(id,{type:'workflow',ts:Date.now(),data})}
  async saveContextCheckpoint(id:string,data:any){
    return await this.withSessionLock(id,async()=>{
      const loaded=await this.load(id)
      const history=this.historyState(loaded.events)
      const latest=loaded.events.filter((event:SessionEvent)=>event.type==='context.checkpoint').at(-1)?.data
      if(latest && latest.turnId && !history.active.includes(latest.turnId) && latest.turnId!==data.turnId) {
        await this.appendUnlocked(id,{type:'context.checkpoint',ts:Date.now(),data})
        return data
      }
      if(latest && latest.sessionId===id && latest.turnId===data.turnId && latest.epoch===data.epoch && latest.projectionHash===data.projectionHash && latest.summaryRevision===data.summaryRevision) return latest
      await this.appendUnlocked(id,{type:'context.checkpoint',ts:Date.now(),data})
      return data
    })
  }
  async latestContextCheckpoint(id:string){
    const loaded=await this.load(id)
    const state=this.historyState(loaded.events)
    for(let i=loaded.events.length-1;i>=0;i--){
      const event=loaded.events[i]
      if(event?.type!=='context.checkpoint' || !event.data) continue
      const sequence=Number(event.sequence||i+1)
      if(sequence<=state.resetSequence) continue
      const turnId=event.data.turnId
      if(turnId && !state.active.includes(turnId)) continue
      return event.data
    }
    return undefined
  }
  private liveSnapshotIds(state:{active:string[];redo:string[];turns:Map<string,TurnRecord>},events:SessionEvent[]=[]) {
    const keep=new Set<string>()
    for (const id of [...state.active,...state.redo]) {
      const turn=state.turns.get(id)
      if (!turn) continue
      keep.add(turn.beforeSnapshot)
      if (turn.afterSnapshot) keep.add(turn.afterSnapshot)
      if (turn.afterProtectedSnapshot) keep.add(turn.afterProtectedSnapshot)
    }
    for (const event of events) {
      if (event.type!=='checkpoint') continue
      const snapshotId=event.data?.snapshotId
      if (typeof snapshotId==='string' && snapshotId) keep.add(snapshotId)
    }
    return keep
  }
  async beginTurn(id:string,cwd:string,messages:ChatMessage[],prompt?:string){
    if(SESSION_BUSY.has(this.file(id))) throw new Error('Session is busy: another turn is already running')
    await this.acquireMutationLease(id)
    SESSION_BUSY.add(this.file(id))
    const beginTurnResult:{turn?:TurnRecord}={}
    try {
      await this.withSessionLock(id,async()=>{
        const loaded=await this.load(id)
        await this.assertCwd(id,cwd)
        const state=this.historyState(loaded.events)
        const branching=state.redo.length>0
        if(branching){
          await this.appendUnlocked(id,{type:'branch',ts:Date.now(),data:{reason:'new-turn'}})
        }
        const refreshed=await this.load(id)
        const refreshedState=this.historyState(refreshed.events)
        const snapshots=this.snapshotStore(cwd,id)
        await snapshots.cleanupIfDue(this.liveSnapshotIds(refreshedState,refreshed.events),branching)
        const snapshot=await snapshots.create('before-turn')
        const turn:TurnRecord={id:crypto.randomBytes(8).toString('hex'),prompt,beforeSnapshot:snapshot,started:Date.now(),beforeMessageCount:messages.length,status:'started'}
        await this.appendUnlocked(id,{type:'turn',ts:turn.started,data:turn})
        beginTurnResult.turn=turn
      })
      return beginTurnResult.turn!
    } catch(error) {
      SESSION_BUSY.delete(this.file(id))
      await this.releaseTurnLease(id).catch(()=>{})
      throw error
    }
  }
  async commitTurn(id:string,cwd:string,turn:TurnRecord,messages:ChatMessage[]){
    if(!SESSION_BUSY.has(this.file(id))) throw new Error('Turn is not active')
    try {
      return await this.withSessionLock(id,async()=>{
        await this.assertCwd(id,cwd)
        const snapshots=this.snapshotStore(cwd,id)
        const afterSnapshot=await snapshots.create('after-turn')
        const afterProtectedSnapshot=await snapshots.create('after-turn-protected',turn.beforeSnapshot)
        const committed:TurnRecord={...turn,afterSnapshot,afterProtectedSnapshot,afterMessageCount:messages.length,committed:Date.now(),status:'committed'}
        await this.appendUnlocked(id,{type:'turn',ts:committed.committed!,data:committed})
        return committed
      })
    } finally {
      SESSION_BUSY.delete(this.file(id))
      await this.releaseTurnLease(id).catch(()=>{})
    }
  }
  private historyState(events:SessionEvent[]){
    const active:string[]=[]; const redo:string[]=[]; const turns=new Map<string,TurnRecord>();
    let resetSequence=0
    let restoredBaseMessages:ChatMessage[]|undefined
    for(let index=0;index<events.length;index++){
      const e=events[index]
      const sequence=Number.isSafeInteger(e.sequence)&&Number(e.sequence)>0?Number(e.sequence):index+1
      if(e.type==='checkpoint.restore'){
        resetSequence=sequence
        active.length=0
        redo.length=0
        restoredBaseMessages=Array.isArray(e.data?.messages)?structuredClone(e.data.messages):[]
        continue
      }
      if(e.type==='turn' && e.data?.status==='committed'){ const t=e.data as TurnRecord; turns.set(t.id,t); active.push(t.id); redo.length=0 }
      else if(e.type==='undo'){ const id=e.data?.turnId; if(active[active.length-1]===id){ active.pop(); redo.push(id) } }
      else if(e.type==='redo'){ const id=e.data?.turnId; if(redo[redo.length-1]===id){ redo.pop(); active.push(id) } }
      else if(e.type==='branch'){ redo.length=0 }
    }
    return {active,redo,turns,resetSequence,restoredBaseMessages}
  }
  async undo(id:string,cwd:string){
    if(SESSION_BUSY.has(this.file(id))) throw new Error('Session is busy: cannot undo while a turn is running')
    const lease=await this.acquireMutationLease(id)
    try{
      return await this.withSessionLock(id,async()=>{
        if(SESSION_BUSY.has(this.file(id))) throw new Error('Session is busy: cannot undo while a turn is running')
        await this.assertCwd(id,cwd)
      const loaded=await this.load(id); const state=this.historyState(loaded.events); const turnId=state.active[state.active.length-1]; if(!turnId) throw new Error('Nothing to undo')
      const turn=state.turns.get(turnId)!; if(!turn.afterSnapshot) throw new Error('Turn has no completed snapshot')
      const snapshots=this.snapshotStore(cwd,id)
      const current=await snapshots.create('undo-check',undefined,false)
      if(current!==turn.afterSnapshot) throw new Error('Working tree changed since the last agent turn; refusing to undo automatically. Review /diff first.')
      if(turn.afterProtectedSnapshot){
        const protectedCurrent=await snapshots.create('undo-protected-check',turn.beforeSnapshot,false)
        if(protectedCurrent!==turn.afterProtectedSnapshot) throw new Error('Working tree changed since the last agent turn; refusing to undo automatically. Review /diff first.')
      }
      await snapshots.restore(turn.beforeSnapshot)
        await this.appendUnlocked(id,{type:'undo',ts:Date.now(),data:{turnId}})
        return {turn,messages:(await this.load(id)).messages}
      })
    } finally {
      await this.releaseTurnLease(id).catch(()=>{})
    }
  }
  async redo(id:string,cwd:string){
    if(SESSION_BUSY.has(this.file(id))) throw new Error('Session is busy: cannot redo while a turn is running')
    const lease=await this.acquireMutationLease(id)
    try{
      return await this.withSessionLock(id,async()=>{
        if(SESSION_BUSY.has(this.file(id))) throw new Error('Session is busy: cannot redo while a turn is running')
        await this.assertCwd(id,cwd)
      const loaded=await this.load(id); const state=this.historyState(loaded.events); const turnId=state.redo[state.redo.length-1]; if(!turnId) throw new Error('Nothing to redo')
      const turn=state.turns.get(turnId)!; if(!turn.afterSnapshot) throw new Error('Turn has no completed snapshot')
      const snapshots=this.snapshotStore(cwd,id)
      const current=await snapshots.create('redo-check',undefined,false)
      if(current!==turn.beforeSnapshot) throw new Error('Working tree changed since undo; refusing to redo automatically. Review /diff first.')
      await snapshots.restore(turn.afterSnapshot)
        await this.appendUnlocked(id,{type:'redo',ts:Date.now(),data:{turnId}})
        return {turn,messages:(await this.load(id)).messages}
      })
    } finally {
      await this.releaseTurnLease(id).catch(()=>{})
    }
  }
  async checkpoint(id:string,messages:ChatMessage[],data:any={}){
    return await this.withSessionLock(id,async()=>{
      const loaded=await this.load(id)
      if(!loaded.meta) throw new Error(`Invalid session: ${id}`)
      const snapshots=this.snapshotStore(loaded.meta.cwd,id)
      const snapshot=await snapshots.create(data.label||'checkpoint')
      const sourceSequence=await this.currentSequence(id)
      const messageSnapshot=structuredClone(messages)
      const messageHash=crypto.createHash('sha256').update(canonicalJson(messageSnapshot)).digest('hex')
      const cp={schemaVersion:1,id:crypto.randomBytes(5).toString('hex'),ts:Date.now(),sourceSequence,messageCount:messageSnapshot.length,messageHash,snapshotId:snapshot,label:data.label||'manual',agent:data.agent,provider:data.provider,model:data.model,messages:messageSnapshot}
      await this.appendUnlocked(id,{type:'checkpoint',ts:cp.ts,data:cp})
      return cp
    })
  }
  async listCheckpoints(id:string){
    const loaded=await this.load(id)
    return loaded.events.filter((e:SessionEvent)=>e.type==='checkpoint').map((e:SessionEvent)=>{
      const d=e.data||{}
      return {schemaVersion:Number(d.schemaVersion||1),id:String(d.id),ts:Number(d.ts||e.ts),label:String(d.label||'manual'),messageCount:Number(d.messageCount||0),sourceSequence:Number(d.sourceSequence||e.sequence||0),snapshotId:d.snapshotId?String(d.snapshotId):undefined,agent:d.agent,provider:d.provider,model:d.model,messageHash:d.messageHash?String(d.messageHash):undefined}
    })
  }
  private resolveCheckpoint(checkpoints:any[],ref:string){
    const key=String(ref||'').trim().replace(/^#/,'')
    if(!key) return undefined
    const index=Number(key)
    if(Number.isInteger(index)&&index>=1&&index<=checkpoints.length) return checkpoints[index-1]
    const exact=checkpoints.find((cp:any)=>cp?.id===key)
    if(exact) return exact
    const prefix=checkpoints.filter((cp:any)=>typeof cp?.id==='string'&&cp.id.startsWith(key))
    return prefix.length===1?prefix[0]:undefined
  }
  async restoreCheckpoint(id:string,checkpointId:string){
    if(SESSION_BUSY.has(this.file(id))) throw new Error('Session is busy: cannot restore a checkpoint while a turn is running')
    return await this.withSessionMutation(id,async()=>{
      const loaded=await this.load(id)
      const checkpoints=loaded.events.filter((e:SessionEvent)=>e.type==='checkpoint').map((e:SessionEvent)=>e.data)
      const cp=this.resolveCheckpoint(checkpoints,checkpointId)
      if(!cp) throw new Error(`Checkpoint not found or ambiguous: ${checkpointId}`)
      if(!Array.isArray(cp.messages)) throw new Error(`Checkpoint ${checkpointId} is legacy metadata-only and cannot be restored safely`)
      if(cp.snapshotId){
        const snapshots=this.snapshotStore(loaded.meta?.cwd||'',''+id)
        await snapshots.restore(String(cp.snapshotId))
      }
      await this.appendUnlocked(id,{type:'checkpoint.restore',ts:Date.now(),data:{checkpointId:String(cp.id),messages:structuredClone(cp.messages),sourceSequence:Number(cp.sourceSequence||0),snapshotId:cp.snapshotId?String(cp.snapshotId):undefined,restoredAt:Date.now()}})
      const refreshed=await this.load(id)
      return {meta:refreshed.meta,messages:refreshed.messages,checkpoint:cp}
    })
  }
  async forkFromCheckpoint(id:string,checkpointId:string,options:{restoreWorkspace?:boolean}={}){
    const loaded=await this.load(id)
    if(!loaded.meta) throw new Error(`Invalid session: ${id}`)
    if(SESSION_BUSY.has(this.file(id))) throw new Error('Session is busy: cannot branch while a turn is running')
    const checkpoints=loaded.events.filter((e:SessionEvent)=>e.type==='checkpoint').map((e:SessionEvent)=>e.data)
    const cp=this.resolveCheckpoint(checkpoints,checkpointId)
    if(!cp) throw new Error(`Checkpoint not found or ambiguous: ${checkpointId}`)
    if(!Array.isArray(cp.messages)) throw new Error(`Checkpoint ${checkpointId} is legacy metadata-only and cannot be branched safely`)
    if(options.restoreWorkspace && cp.snapshotId){
      const snapshots=this.snapshotStore(loaded.meta.cwd,id)
      await snapshots.restore(String(cp.snapshotId))
    }
    const child=await this.create(loaded.meta.cwd,loaded.meta.model,{id,at:Number(cp.messageCount||0),checkpointId:String(cp.id),snapshotId:cp.snapshotId?String(cp.snapshotId):undefined})
    // Branching only copies immutable semantic state. Render/UI buffers are intentionally not persisted here.
    await this.append(child.id,{type:'branch',ts:Date.now(),data:{reason:'checkpoint',parentSessionId:id,checkpointId:String(cp.id),sourceSequence:Number(cp.sourceSequence||0),snapshotId:cp.snapshotId?String(cp.snapshotId):undefined,restoreWorkspace:Boolean(options.restoreWorkspace)}})
    for(const message of structuredClone(cp.messages)) await this.appendMessage(child.id,message)
    return child
  }
  async load(id:string){
    const rawEvents=await this.readEventsRaw(id)
    const events=rawEvents.map((event,index)=>enrichStoredEvent(id,event,Number.isSafeInteger(event.sequence)&&Number(event.sequence)>0?Number(event.sequence):index+1) as SessionEvent)
    const meta=events.find((e:SessionEvent)=>e.type==='meta')?.data as SessionMeta|undefined
    const messageEvents=events.filter((e:SessionEvent)=>e.type==='message')
    const raw:Array<{message:ChatMessage;turnId?:string}>=messageEvents.map((e:SessionEvent)=>e.data?.message ? {message:e.data.message as ChatMessage,turnId:e.data.turnId as string|undefined} : {message:e.data as ChatMessage})
    const state=this.historyState(events)
    const ordered=state.active.map(id=>state.turns.get(id)).filter(Boolean) as TurnRecord[]
    const rawWithSequence=messageEvents.map((e:SessionEvent)=>({sequence:Number.isSafeInteger(e.sequence)&&Number(e.sequence)>0?Number(e.sequence):events.indexOf(e)+1,raw:e.data?.message ? {message:e.data.message as ChatMessage,turnId:e.data.turnId as string|undefined} : {message:e.data as ChatMessage}}))
    const base=rawWithSequence.filter(x=>x.sequence>state.resetSequence&&!x.raw.turnId).map(x=>x.raw.message)
    const byTurn=new Map<string,ChatMessage[]>()
    for(const x of rawWithSequence) if(x.sequence>state.resetSequence&&x.raw.turnId){const list=byTurn.get(x.raw.turnId)||[];list.push(x.raw.message);byTurn.set(x.raw.turnId,list)}
    const messages=[...(state.restoredBaseMessages||[]),...base]
    for(const turn of ordered) messages.push(...(byTurn.get(turn.id)||[]))
    return {meta,messages,events}
  }
  async appendMessage(id:string,message:ChatMessage,turnId?:string){ await this.append(id,{type:'message',ts:Date.now(),data:turnId?{message,turnId}:message}) }
  async fork(id:string,at?:number){
    const loaded=await this.load(id); if(!loaded.meta) throw new Error(`Invalid session: ${id}`)
    const messages=loaded.messages; const point=Math.max(0,Math.min(at??messages.length,messages.length));
    const child=await this.create(loaded.meta.cwd,loaded.meta.model,{id,at:point})
    for(const m of messages.slice(0,point)) await this.appendMessage(child.id,m)
    return child
  }
  async list(){await ensureDir(this.root);const files=(await fs.readdir(this.root)).filter((x:string)=>x.endsWith('.jsonl')).sort().reverse();const out:any[]=[];for(const f of files.slice(0,50)){try{const first=JSON.parse((await fs.readFile(path.join(this.root,f),'utf8')).split('\n')[0]);out.push(first.data)}catch{}}return out}
}
