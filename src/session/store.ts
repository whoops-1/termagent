import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDir } from '../util/fs.js'
import { SnapshotStore } from './snapshot.js'
import { enrichStoredEvent, toDurableEventEnvelope, legacyEventKind, legacyEventCategory } from '../protocol/session-events.js'
import type { CommandReceipt, DurableEventEnvelope, EventCategory, EventKind, InteractionRequestState, PermissionRequestState, QuestionRequestState, PermissionResolution, QuestionResolution } from '../protocol/types.js'
import { firstWriterWins } from '../protocol/types.js'
import { canonicalJson } from '../util/canonical.js'

export type ChatMessage = { role: 'system'|'user'|'assistant'|'tool'; content: string | null; tool_call_id?: string; tool_calls?: ToolCall[]; name?: string; reasoning?: string }
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type SessionEvent = { type:'message'|'meta'|'compaction'|'context.checkpoint'|'branch'|'summary'|'todo'|'workflow'|'checkpoint'|'checkpoint.restore'|'turn'|'undo'|'redo'|'skill.search'|'skill.load'|'skill.skip'|'question.asked'|'question.replied'|'question.rejected'|'question.cancelled'|'permission.asked'|'permission.resolved'|'permission.cancelled'|'command.receipt'|'tool.call'|'provider.turn'|'task.notification'|'task.notification.consumed'|'prompt.queue'|'mutation'|'diff'|'verification'; ts:number; data:any; eventId?:string; version?:1; sequence?:number; durable?:true; category?:EventCategory; kind?:EventKind }
export type SessionMeta = { id:string; cwd:string; model:string; created:number; updated:number; parentId?:string; branchPoint?:number; parentCheckpointId?:string; parentSnapshotId?:string }
export type TurnRecord = { id:string; prompt?:string; beforeSnapshot:string; afterSnapshot?:string; afterProtectedSnapshot?:string; started:number; committed?:number; beforeMessageCount:number; afterMessageCount?:number; status:'started'|'committed' }

const SESSION_LOCKS = new Map<string, Promise<void>>()
const SESSION_BUSY = new Set<string>()
type TurnLease = { lockPath:string; token:string }

export class SessionStore {
  readonly root:string
  private snapshots = new Map<string, SnapshotStore>()
  private mutationDepth = new Map<string, number>()
  constructor(root=path.join(process.env.HOME||process.cwd(),'.termagent','sessions')) { this.root=root }
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
        if((error as {code?:string}).code!=='EEXIST') throw error
        let owner:any
        try{owner=JSON.parse(await fs.readFile(lockPath,'utf8'))}catch(error){
          if((error as {code?:string}).code==='ENOENT'){continue}
          const info=await fs.stat(lockPath).catch(()=>undefined)
          if(info && Date.now()-info.mtimeMs<5000) throw new Error('Session is busy: another process is acquiring the turn lock')
          await fs.rm(lockPath,{force:true})
          continue
        }
        const pid=Number(owner?.pid)
        if(Number.isInteger(pid) && pid>0){
          try{process.kill(pid,0); throw new Error('Session is busy: another process is running a turn')}
          catch(error){
            if((error as {code?:string}).code!=='ESRCH') throw error
          }
        }
        await fs.rm(lockPath,{force:true})
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

  private async acquireStateLease(id:string):Promise<TurnLease>{
    await ensureDir(this.root)
    const lockPath=this.stateLockFile(id)
    const token=crypto.randomBytes(12).toString('hex')
    const payload=JSON.stringify({pid:process.pid,token,started:Date.now()})+'\n'
    for(let attempt=0;attempt<60;attempt++){
      try{
        const handle=await fs.open(lockPath,'wx')
        try{await handle.writeFile(payload,'utf8')}finally{await handle.close()}
        return {lockPath,token}
      }catch(error){
        if((error as {code?:string}).code!=='EEXIST')throw error
        let owner:any
        try{owner=JSON.parse(await fs.readFile(lockPath,'utf8'))}catch(error){
          if((error as {code?:string}).code==='ENOENT')continue
          const info=await fs.stat(lockPath).catch(()=>undefined)
          if(info&&Date.now()-info.mtimeMs<5000){await new Promise(r=>setTimeout(r,10));continue}
          await fs.rm(lockPath,{force:true});continue
        }
        const pid=Number(owner?.pid)
        if(Number.isInteger(pid)&&pid>0){
          try{process.kill(pid,0);await new Promise(r=>setTimeout(r,10));continue}catch(error){if((error as {code?:string}).code!=='ESRCH')throw error}
        }
        await fs.rm(lockPath,{force:true})
      }
    }
    throw new Error('Session state is busy: unable to acquire state lock')
  }
  private async releaseStateLease(lease:TurnLease){
    try{
      const owner=JSON.parse(await fs.readFile(lease.lockPath,'utf8'))
      if(owner?.pid===process.pid&&owner?.token===lease.token)await fs.rm(lease.lockPath,{force:true})
    }catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
  }
  async withSessionMutation<T>(id:string,fn:()=>Promise<T>):Promise<T>{
    const nested=(this.mutationDepth.get(id)??0)>0
    if(nested){
      this.mutationDepth.set(id,(this.mutationDepth.get(id)??0)+1)
      try{return await fn()}finally{this.decrementMutationDepth(id)}
    }
    return await this.withSessionLock(id,async()=>{
      const lease=await this.acquireStateLease(id)
      this.mutationDepth.set(id,1)
      try{return await fn()}finally{this.decrementMutationDepth(id);await this.releaseStateLease(lease)}
    })
  }

  private decrementMutationDepth(id:string){
    const depth=this.mutationDepth.get(id)??0
    if(depth<=1)this.mutationDepth.delete(id)
    else this.mutationDepth.set(id,depth-1)
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
      if(text.endsWith('\n')) throw new Error(`Corrupt trailing session event at line ${lastNonEmpty+1}`)
      const offset=lines.slice(0,lastNonEmpty).reduce((total,line)=>total+line.length+1,0)
      await fs.truncate(this.file(id),offset)
    }
  }

  private async appendCore(id:string,event:SessionEvent){
    await ensureDir(this.root)
    await this.repairTrailingPartialEvent(id)
    const sequence=await this.nextDurableSequence(id)
    const enriched=enrichStoredEvent(id,event,sequence)
    await fs.appendFile(this.file(id),JSON.stringify(enriched)+'\n')
    return enriched
  }

  private async appendUnlocked(id:string,event:SessionEvent){
    if((this.mutationDepth.get(id)??0)>0)return await this.appendCore(id,event)
    const lease=await this.acquireStateLease(id)
    try{return await this.appendCore(id,event)}finally{await this.releaseStateLease(lease)}
  }

  async append(id:string,event:SessionEvent){
    if((this.mutationDepth.get(id)??0)>0) return await this.appendUnlocked(id,event)
    return await this.withSessionLock(id,()=>this.appendUnlocked(id,event))
  }
  async currentSequence(id:string):Promise<import('../protocol/types.js').DurableSequence>{
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
        states.set(requestId,{kind:'permission',requestId,sessionId:id,revision:Math.max(Number(data.revision||1),prior?.revision||0),status:'pending',tool:String(data.tool||''),action:String(data.action||''),resources:Array.isArray(data.resources)?data.resources.map(String):[],createdAt:Number(data.createdAt||event.ts)})
        continue
      }
      if(event.type==='permission.resolved' || event.type==='permission.cancelled'){
        const prior=states.get(requestId)
        if(!prior||prior.kind!=='permission')continue
        const status=event.type==='permission.cancelled'?'cancelled':'resolved'
        states.set(requestId,{...prior,status,resolvedAt:Number(data.resolvedAt||event.ts),revision:prior.revision+1,resolution:event.type==='permission.resolved'?data.resolution:undefined})
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

  async pendingInteractions(id:string):Promise<InteractionRequestState[]>{
    return (await this.interactionStates(id)).filter(state=>state.status==='pending')
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

  async consumeTaskNotifications(id:string){
    return await this.withSessionLock(id,async()=>{
      const loaded=await this.load(id)
      const notifications=loaded.events.filter((event:SessionEvent)=>event.type==='task.notification').map(event=>event.data).filter(Boolean)
      const consumed=new Set(loaded.events.filter((event:SessionEvent)=>event.type==='task.notification.consumed').map((event:SessionEvent)=>String(event.data?.taskId||'')))
      const pending=notifications.filter((item:any)=>item.taskId&&!consumed.has(String(item.taskId)))
      for(const item of pending) await this.appendUnlocked(id,{type:'task.notification.consumed',ts:Date.now(),data:{taskId:item.taskId,completedAt:item.completedAt}})
      return pending
    })
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
