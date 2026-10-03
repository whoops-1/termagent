import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureDir, within } from '../util/fs.js'
import { spawn } from 'node:child_process'
import { terminateProcessGroup } from '../util/child-process.js'
import { TaskEventLog } from './events.js'
import type { ApprovalMode, PermissionRule } from '../config/config.js'
import type { ProviderConfig } from '../providers/types.js'

export type TaskKind = 'shell'|'agent'
export type TaskStatus = 'queued'|'running'|'exited'|'failed'|'cancelled'
export interface TaskRecord {
  id:string; kind:TaskKind; command?:string; prompt?:string; cwd:string; started:number; updated:number; ended?:number;
  status:TaskStatus; pid?:number; exitCode?:number; output:string; sessionId?:string; childSessionId?:string; parentSessionId?:string;
  result?:string; error?:string; pendingPrompts?:string[]; runCount?:number; background?:boolean; parentNotified?:boolean;
  permissionMode?:ApprovalMode; permissionRules?:PermissionRule[]; allowedTools?:string[]; coordinated?:boolean; specialistRole?:string; delegationDepth?:number; parentTaskId?:string;
  provider?:ProviderConfig;
  usage?:{inputTokens:number;outputTokens:number;totalTokens:number;estimated:boolean};
  workerToken?:string;
  processIdentity?:{command:string;cwd:string;startTime?:string};
  scopePaths?:string[]; outputPath?:string; outputBytes?:number; outputTruncated?:boolean; timeoutMs?:number; backgrounded?:boolean; signal?:any; termination?:'completed'|'nonzero'|'timeout'|'cancelled'|'signal'|'output-limit'|'stdin-timeout'|'spawn-error';
}

export class TaskManager {
  private events:TaskEventLog
  private saveQueues=new Map<string,Promise<void>>()
  private readonly sessionRoot:string
  constructor(private root=process.env.TERMAGENT_TASK_ROOT||path.join(process.env.HOME||process.cwd(),'.termagent','tasks'), private workerDetached=true, sessionRoot=process.env.TERMAGENT_SESSION_ROOT||path.join(process.env.HOME||process.cwd(),'.termagent','sessions')){this.events=new TaskEventLog(root);this.sessionRoot=sessionRoot}
  private file(id:string){return path.join(this.root,`${id}.json`)}
  async event(id:string,type:string,data:any){return this.events.append(id,type,data)}
  async history(id:string){return this.events.read(id)}
  private lockFile(id:string){return path.join(this.root,`.${id}.task.lock`)}
  private sessionLockFile(sessionId:string){return path.join(this.root,`.session-${crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0,32)}.lock`)}
  private async withTaskLock<T>(id:string,fn:()=>Promise<T>):Promise<T>{
    await ensureDir(this.root)
    const lockPath=this.lockFile(id),token=crypto.randomBytes(12).toString('hex'),payload=JSON.stringify({pid:process.pid,token,started:Date.now()})+'\n'
    for(let attempt=0;attempt<60;attempt++){
      try{
        const handle=await fs.open(lockPath,'wx'); try{await handle.writeFile(payload,'utf8')}finally{await handle.close()}
        try{return await fn()}finally{
          try{const owner=JSON.parse(await fs.readFile(lockPath,'utf8'));if(owner?.pid===process.pid&&owner?.token===token)await fs.rm(lockPath,{force:true})}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
        }
      }catch(error){
        if((error as {code?:string}).code!=='EEXIST')throw error
        let owner:any
        try{owner=JSON.parse(await fs.readFile(lockPath,'utf8'))}catch(error){
          if((error as {code?:string}).code==='ENOENT')continue
          const info=await fs.stat(lockPath).catch(()=>undefined); if(info&&Date.now()-info.mtimeMs<5000){await new Promise(r=>setTimeout(r,10));continue}
          await fs.rm(lockPath,{force:true}); continue
        }
        const pid=Number(owner?.pid)
        if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,10));continue}catch(error){if((error as {code?:string}).code!=='ESRCH')throw error}}
        await fs.rm(lockPath,{force:true})
      }
    }
    throw new Error(`Task ${id} is busy: unable to acquire task lock`)
  }
  private async saveUnlocked(t:TaskRecord){
    await ensureDir(this.root)
    t.updated=Date.now()
    const target=this.file(t.id)
    const tmp=`${target}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    await fs.writeFile(tmp,JSON.stringify(t,null,2))
    await fs.rename(tmp,target)
    await this.events.append(t.id,'state',{status:t.status,pid:t.pid,exitCode:t.exitCode,outputTail:(t.output||'').slice(-2000),sessionId:t.sessionId})
  }
  async save(t:TaskRecord){
    const previous=this.saveQueues.get(t.id)||Promise.resolve()
    const next=previous.then(()=>this.withTaskLock(t.id,()=>this.saveUnlocked(t)))
    this.saveQueues.set(t.id,next.catch(()=>{}))
    await next
  }
  async list(){await ensureDir(this.root);const out:TaskRecord[]=[];for(const f of await fs.readdir(this.root)){if(!f.endsWith('.json'))continue;try{out.push(JSON.parse(await fs.readFile(path.join(this.root,f),'utf8')))}catch{}}return out.sort((a,b)=>b.started-a.started)}
  async get(id:string){return JSON.parse(await fs.readFile(this.file(id),'utf8')) as TaskRecord}
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
  async createShell(command:string,cwd:string,parentSessionId?:string,scopePaths?:string[],options:{background?:boolean;coordinated?:boolean;timeoutMs?:number}={}){
    const normalized=scopePaths?.length?scopePaths.map(String):[]
    this.assertValidScopes(cwd,normalized)
    await this.assertScopeAvailable(cwd,normalized,undefined,Boolean(options.coordinated))
    const id=crypto.randomBytes(5).toString('hex');const outputPath=path.join(this.root,'outputs',`${id}.log`);const t:TaskRecord={id,kind:'shell',command,cwd,started:Date.now(),updated:Date.now(),status:'queued',output:'',outputPath,parentSessionId,scopePaths:normalized,background:Boolean(options.background),coordinated:Boolean(options.coordinated),timeoutMs:options.timeoutMs};await this.save(t);return t
  }
  outputPath(id:string){ return path.join(this.root,'outputs',`${id}.log`) }
  async createAgent(prompt:string,cwd:string,provider:any,scopePaths?:string[],parentSessionId?:string,options:{permissionMode?:ApprovalMode;permissionRules?:PermissionRule[];allowedTools?:string[];background?:boolean;coordinated?:boolean;sessionId?:string;specialistRole?:string;delegationDepth?:number;parentTaskId?:string}={}){
    const normalized=scopePaths?.length?scopePaths.map(String):['.']
    this.assertValidScopes(cwd,normalized)
    await this.assertScopeAvailable(cwd,normalized,undefined,Boolean(options.coordinated))
    const active=parentSessionId ? await this.activeAgentTasks(parentSessionId) : []
    const limit=Number(process.env.TERMAGENT_MAX_ACTIVE_AGENTS||4)
    if(active.length >= Math.max(1,Number.isFinite(limit)?Math.floor(limit):4)) throw new Error(`Agent delegation limit exceeded: ${active.length} active child agent(s); at most ${Math.max(1,Number.isFinite(limit)?Math.floor(limit):4)} may run concurrently for this parent session.`)
    const depth=Number.isFinite(options.delegationDepth) ? Math.max(0,Math.floor(options.delegationDepth!)) : (options.parentTaskId ? 1 : 0)
    const maxDepth=Math.max(0,Number(process.env.TERMAGENT_MAX_AGENT_DEPTH||1))
    if(depth>maxDepth) throw new Error(`Agent delegation depth ${depth} exceeds the configured maximum of ${maxDepth}.`)
    const id=crypto.randomBytes(5).toString('hex');const t:TaskRecord={id,kind:'agent',prompt,cwd,started:Date.now(),updated:Date.now(),status:'queued',output:'',provider,sessionId:parentSessionId,parentSessionId,scopePaths:normalized,childSessionId:options.sessionId,permissionMode:options.permissionMode,permissionRules:options.permissionRules,allowedTools:options.allowedTools,background:Boolean(options.background),coordinated:Boolean(options.coordinated),runCount:0,pendingPrompts:[],specialistRole:options.specialistRole||'general',delegationDepth:depth,parentTaskId:options.parentTaskId};await this.save(t);return t
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
    for(const task of await this.list()){
      if((task.status==='queued'||task.status==='running')||task.updated>cutoff)continue
      try{if(task.outputPath)await fs.rm(task.outputPath,{force:true})}catch{}
    }
  }
  private async acquireNamedLock(lockPath:string):Promise<{lockPath:string;token:string}> {
    await ensureDir(this.root)
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
    throw new Error(`Task scheduler is busy: unable to acquire ${path.basename(lockPath)}`)
  }
  private async releaseNamedLock(lock:{lockPath:string;token:string}){
    try{
      const owner=JSON.parse(await fs.readFile(lock.lockPath,'utf8'))
      if(owner?.pid===process.pid&&owner?.token===lock.token)await fs.rm(lock.lockPath,{force:true})
    }catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
  }
  async withSessionLock<T>(sessionId:string,fn:()=>Promise<T>):Promise<T>{
    const lock=await this.acquireNamedLock(this.sessionLockFile(sessionId))
    try{return await fn()}finally{await this.releaseNamedLock(lock)}
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
    const workerEntry=new URL('./worker-entry.js',import.meta.url).pathname
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
