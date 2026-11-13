import path from 'node:path'
import { TaskManager, assertChildLaunchPermitted, computeLaunchFingerprint, preflightChildProviderSnapshot } from '../tasks/manager.js'
import { subagentProviderSnapshot } from '../tasks/task-provider.js'
import type { Provider, ProviderConfig } from '../providers/types.js'
import type { ToolDefinition } from './types.js'
import { ToolRegistry } from './registry.js'
import { within } from '../util/fs.js'
import { specialistRole, specialistRoleNames, restrictSpecialistTools } from '../agent/specialists.js'

type ParallelTask={prompt:string;paths:string[];role:string;retryCause:string}
function normalizePaths(cwd:string,paths:string[]):string[]{return [...new Set(paths.map(x=>path.resolve(cwd,String(x))))].sort()}
function overlaps(a:string,b:string){return a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep)}

export function parallelAgentTool(manager:TaskManager,provider:Provider,providerConfig:ProviderConfig,parentRegistry?:ToolRegistry):ToolDefinition {
  return {
    name:'parallel_agents', risk:'shell',
    description:'Launch 2-4 independent background coding agents concurrently. Each task must declare non-overlapping workspace paths so concurrent edits are bounded and reviewable.',
    schema:{
      type:'object',
      properties:{
        tasks:{
          type:'array',minItems:2,maxItems:4,
          items:{type:'object',properties:{prompt:{type:'string',minLength:1},paths:{type:'array',minItems:1,items:{type:'string'}},role:{type:'string',enum:specialistRoleNames()},retry_cause:{type:'string',description:'Required to retry an identical parallel agent after it failed: describe the changed cause or configuration.'}},required:['prompt','paths']}
        }
      },
      required:['tasks']
    },
    async execute(a:any,c:any){
      if(!Array.isArray(a.tasks)||a.tasks.length<2||a.tasks.length>4)throw new Error('parallel_agents requires 2-4 tasks')
      const tasks=(a.tasks as any[]).map((x:any)=>({prompt:String(x.prompt||'').trim(),paths:normalizePaths(c.cwd,Array.isArray(x.paths)?x.paths.map(String):[]),role:typeof x.role==='string'?x.role:'general',retryCause:String(x.retry_cause??x.retryCause??'').trim()} as ParallelTask))
      for(const [index,task] of tasks.entries()){
        if(!task.prompt)throw new Error(`parallel task ${index+1} has no prompt`)
        if(!task.paths.length)throw new Error(`parallel task ${index+1} must declare at least one workspace path`)
        for(const scope of task.paths) if(!within(c.cwd,scope)) throw new Error(`Parallel task ${index+1} scope escapes the project: ${path.relative(c.cwd,scope)||scope}`)
      }
      for(let i=0;i<tasks.length;i++)for(let j=i+1;j<tasks.length;j++)for(const left of tasks[i]!.paths)for(const right of tasks[j]!.paths){
        if(overlaps(left,right))throw new Error(`Parallel tasks ${i+1} and ${j+1} overlap at ${path.relative(c.cwd,left)||'.'} / ${path.relative(c.cwd,right)||'.'}; run them sequentially instead.`)
      }
      const active=await manager.activeAgentTasks(c.sessionID)
      if(active.length+tasks.length>4) throw new Error(`Parallel agent limit exceeded: ${active.length} already active for this session; at most 4 may run concurrently.`)
      for(const candidate of tasks){
        for(const existing of active){
          for(const left of candidate.paths) for(const right of (existing.scopePaths||[]).map(x=>path.resolve(c.cwd,x))){
            if(overlaps(left,right)) throw new Error(`Parallel task overlaps active task ${existing.id} at ${path.relative(c.cwd,left)||'.'} / ${path.relative(c.cwd,right)||'.'}; wait for it to finish or choose another scope.`)
          }
        }
      }
      return await manager.withSessionLock(c.sessionID,async()=>{
      const lockedActive=await manager.activeAgentTasks(c.sessionID)
      if(lockedActive.length+tasks.length>4) throw new Error(`Parallel agent limit exceeded: ${lockedActive.length} already active for this session; at most 4 may run concurrently.`)
      for(const candidate of tasks){
        for(const existing of lockedActive){
          for(const left of candidate.paths) for(const right of (existing.scopePaths||[]).map(x=>path.resolve(c.cwd,x))){
            if(overlaps(left,right)) throw new Error(`Parallel task overlaps active task ${existing.id} at ${path.relative(c.cwd,left)||'.'} / ${path.relative(c.cwd,right)||'.'}; wait for it to finish or choose another scope.`)
          }
        }
      }
      const ids:string[]=[]
      const created:string[]=[]
      const persisted=await subagentProviderSnapshot(provider,providerConfig,{label:'parallel agents',taskRoot:manager.taskRoot()})
      await preflightChildProviderSnapshot(persisted,{label:'parallel agents',kind:'agent',declaredAdapter:String(provider.config?.provider||providerConfig?.provider||'')})
      const policy=parentRegistry?parentRegistry.gate.deriveChildPolicy(parentRegistry.list()):{mode:'deny' as const,rules:[],allowedTools:[]}
      // 14I-O (item 859): preflight the complete batch before any child is
      // created so a refused launch never leaves half-applied work behind.
      const launchPlans=tasks.map(task=>{
        const relPaths=task.paths.map(p=>path.relative(c.cwd,p)||'.')
        return {task,relPaths,fingerprint:computeLaunchFingerprint({kind:'agent',prompt:task.prompt,scopePaths:relPaths})}
      })
      for(const plan of launchPlans){
        await assertChildLaunchPermitted(manager,{parentSessionId:c.sessionID,fingerprint:plan.fingerprint,retryCause:plan.task.retryCause,label:'parallel agent'})
      }
      try{
        for(const plan of launchPlans){
          const {task,relPaths,fingerprint}=plan
          const role=specialistRole(task.role)
          const allowedTools=restrictSpecialistTools(role.name,policy.allowedTools)
          if(role.name!=='general' && !allowedTools.length) throw new Error(`Specialist role '${role.name}' has no tools permitted by the parent policy.`)
          const t=await manager.createAgent(task.prompt,c.cwd,persisted,relPaths,c.sessionID,{allowedTools,specialistRole:role.name,delegationDepth:(c.delegationDepth||0)+1,parentTaskId:c.taskId,background:true,coordinated:true,permissionMode:policy.mode,permissionRules:policy.rules,launchFingerprint:fingerprint,launchRetryCause:task.retryCause||undefined});created.push(t.id)
          const pid=await manager.spawnWorker(t.id)
          const current=await manager.attachPid(t.id,pid);if(current.status==='cancelled'){try{process.kill(pid,'SIGTERM')}catch{}}
          await manager.event(t.id,'scope',{paths:relPaths});ids.push(t.id)
        }
      }catch(error){
        for(const id of created){
          try{
            const current=await manager.get(id)
            if(current.status==='queued'||current.status==='running') await manager.finish(id,{status:'failed',output:(current.output||'')+`\nERROR: Parallel launch failed: ${(error as Error).message}`})
          }catch{}
        }
        throw error
      }
      return {output:`Started ${ids.length} bounded parallel agents: ${ids.join(', ')}. Declared workspace paths do not overlap. Use task_status to observe results.`,metadata:{taskIds:ids,status:'running',background:true,coordinated:true,allowedTools:policy.allowedTools,roles:tasks.map(task=>task.role)}}
    })
    }
  }
}
