import { TaskManager, type TaskRecord } from './manager.js'
import { SessionStore } from '../session/store.js'
import { PermissionGate } from '../tools/permissions.js'
import { ToolRegistry } from '../tools/registry.js'
import { builtinTools } from '../tools/builtin.js'
import { createProvider } from '../providers/registry.js'
import { Agent } from '../agent/agent.js'
import { resolveTaskProviderConfig } from './task-provider.js'
import { loadInstructions } from '../context/instructions.js'
import { buildRepositoryMap, formatRepositoryMap } from '../context/repository.js'
import { retrieveContext } from '../context/retrieval.js'
import { resolveContextLimits } from '../context/model-limits.js'
import { deriveRepositoryContextBudget } from '../context/budget.js'
import { loadSkillCatalog } from '../skills/catalog.js'
import { skillTools } from '../tools/skills.js'
import { taskOutputTool, taskStatusTool } from '../tools/background.js'
import { sessionTodoTool } from '../tools/session-todo.js'
import { verifyTool } from '../tools/verify.js'
import path from 'node:path'
import { specialistRole, restrictSpecialistTools } from '../agent/specialists.js'
import type { TaskActivity } from './manager.js'

const DEFAULT_SHELL_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_BYTES = 20_000

function renderSpecialistText(task:TaskRecord){
  const role=specialistRole(task.specialistRole)
  return `\nSPECIALIST ROLE: ${role.name}. ${role.prompt}\nROLE TOOL POLICY: ${role.allowedTools.length ? role.allowedTools.join(', ') : 'inherit parent policy'}. Maximum rounds for this role: ${role.maxRounds}.`
}

function renderScopeText(task:TaskRecord){
  if(!task.scopePaths?.length) return ''
  const scopes=task.scopePaths.join(', ')
  return `\nSTRICT WORKSPACE SCOPE: only modify files under these declared workspace paths: ${scopes}. Do not use shell or git tools in this scoped worker; use bounded file tools instead.`
}

async function createChildSession(store:SessionStore,task:TaskRecord,providerModel:string){
  const existingId=task.childSessionId
  if(existingId){
    const loaded=await store.load(existingId)
    if(!loaded.meta) throw new Error(`Child session ${existingId} is missing or invalid`)
    if(pathResolveSafe(loaded.meta.cwd)!==pathResolveSafe(task.cwd)) throw new Error(`Child task ${task.id} belongs to ${loaded.meta.cwd}, not ${task.cwd}`)
    return loaded.meta
  }
  return await store.create(task.cwd,providerModel,task.parentSessionId?{id:task.parentSessionId,at:task.started}:undefined)
}

function pathResolveSafe(value:string){ return path.resolve(value) }

function activityDetail(args:unknown):string|undefined{
  if(!args||typeof args!=='object'||Array.isArray(args))return undefined
  const value=args as Record<string,unknown>
  for(const key of ['path','filePath','query','pattern','command','url','role','task_id']){
    const item=value[key]
    if(typeof item==='string'&&item.trim())return `${key}: ${item.replace(/\s+/g,' ').trim().slice(0,180)}`
  }
  if(Array.isArray(value.paths)&&value.paths.length)return `paths: ${value.paths.filter((item):item is string=>typeof item==='string').slice(0,3).join(', ').slice(0,180)}`
  return undefined
}

function compactActivityText(value:string,max=180){
  const text=String(value||'').replace(/\s+/g,' ').trim()
  return text.length>max?`${text.slice(0,max-1)}…`:text
}

export async function runTaskWorker(id:string, suppliedManager?:TaskManager){
  const manager=suppliedManager||new TaskManager()
  let task=await manager.get(id)
  if(!(await manager.claimWorker(id,process.pid,process.env.TERMAGENT_WORKER_TOKEN))) return
  task=await manager.get(id)
  let activityWrites:Promise<void>=Promise.resolve()
  let outputProgressWrites:Promise<void>=Promise.resolve()
  let lastOutputProgressBytes=Number(task.outputBytes||0)
  try{
    if(task.kind==='shell') return await runShell(task,manager)
    if(task.kind!=='agent') throw new Error(`Unsupported task kind: ${task.kind}`)
    const providerConfig=await resolveTaskProviderConfig(task.provider,{taskRoot:manager.taskRoot()})
    const provider=createProvider(providerConfig)
    provider.setRole?.('subagent')
    provider.setTurnContext?.({userText:task.prompt||'',turnNumber:1})
    const contextLimits=resolveContextLimits({providerConfig:provider.getActiveConfig?.()||provider.config,configuredContextWindow:Number(process.env.TERMAGENT_MAX_CONTEXT_TOKENS||0)||undefined})
    const store=new SessionStore(process.env.TERMAGENT_SESSION_ROOT||undefined)
    const session=await createChildSession(store,task,provider.model)
    await manager.update(task.id,{sessionId:session.id,childSessionId:session.id})

    let outputBytes=Number(task.outputBytes||0)
    let lastOutputProgressAt=0
    const recordActivity=(activity:TaskActivity,eventType:string,data:Record<string,unknown>={})=>{
      activityWrites=activityWrites.then(async()=>{
        await manager.update(task.id,{activity})
        await manager.event(task.id,eventType,{...data,activity})
      }).catch(()=>{})
    }

    const gate=new PermissionGate(task.permissionMode||'deny',process.stdin,process.stdout,task.permissionRules||[])
    const registry=new ToolRegistry(gate)
    const scoped=Boolean(task.scopePaths?.length)
    builtinTools({
      timeout:120000,
      maxOutput:20000,
      toolOutputMaxLines:Number(process.env.TERMAGENT_TOOL_OUTPUT_MAX_LINES||2000),
      toolOutputMaxBytes:Number(process.env.TERMAGENT_TOOL_OUTPUT_MAX_BYTES||51200),
      toolOutputRetentionDays:Number(process.env.TERMAGENT_TOOL_OUTPUT_RETENTION_DAYS||7),
    }).filter(t=>!scoped||!['bash','git'].includes(t.name)).forEach(t=>registry.add(t))
    registry.add(taskStatusTool(manager)); registry.add(taskOutputTool(manager)); registry.add(sessionTodoTool(store)); registry.add(verifyTool(120000,20000,manager))
    skillTools(async (sessionID,event)=>{ await store.append(sessionID,{type:`skill.${event.action}` as any,ts:Date.now(),data:event}) }, { maxBodyTokens: Math.min(48_000,Math.max(2_048,Math.floor(contextLimits.contextWindow*0.14))) }).forEach(t=>registry.add(t))

    const instructions=await loadInstructions(task.cwd)
    const skillCatalog=await loadSkillCatalog(task.cwd)
    const skills=skillCatalog.list()
    const map=await buildRepositoryMap(task.cwd)
    const repositoryBudget=deriveRepositoryContextBudget(contextLimits.contextWindow,{repositoryFiles:map.files.length})
    const retrieved=await retrieveContext(map,task.prompt||'',{maxFiles:repositoryBudget.retrievalFiles,maxBytes:repositoryBudget.retrievalBytes,maxTokens:repositoryBudget.retrievalTokens,maxFileBytes:repositoryBudget.retrievalFileBytes})
    const role=specialistRole(task.specialistRole)
    const roleTools=task.allowedTools?.length ? restrictSpecialistTools(role.name,task.allowedTools) : undefined
    const allowedTools=roleTools?.length ? roleTools : task.allowedTools?.length ? task.allowedTools : undefined
    if(role.name!=='general' && !allowedTools?.length) throw new Error(`Specialist role '${role.name}' has no permitted tools after parent-policy intersection.`)
    const agent=new Agent(
      provider,
      registry,
      store,
      Math.min(Number(process.env.TERMAGENT_MAX_TOOL_ROUNDS||80), role.maxRounds),
      Number(process.env.TERMAGENT_MAX_CONTEXT_TOKENS||0),
      4,
      (message:string)=>{const at=Date.now();recordActivity({kind:'status',label:compactActivityText(message,140),at,outcome:'running'},'status',{message:compactActivityText(message,220)})},
      skills,
      {threshold:Number(process.env.TERMAGENT_COMPACTION_THRESHOLD||0.82),reserveTokens:Number(process.env.TERMAGENT_CONTEXT_RESERVE||768),recentTokens:Number(process.env.TERMAGENT_CONTEXT_RECENT||3000)},
      undefined,
      {maxLines:Number(process.env.TERMAGENT_TOOL_OUTPUT_MAX_LINES||2000),maxBytes:Number(process.env.TERMAGENT_TOOL_OUTPUT_MAX_BYTES||51200),retentionDays:Number(process.env.TERMAGENT_TOOL_OUTPUT_RETENTION_DAYS||7)},
    )

    let nextPrompt=task.prompt||''
    let resultText=''
    let usage={inputTokens:0,outputTokens:0,totalTokens:0,estimated:true}
    while(nextPrompt){
      const loaded=await store.load(session.id)
      let runText=''
      const startedAt=Date.now()
      recordActivity({kind:'turn',label:'Agent turn started',detail:compactActivityText(nextPrompt,160),at:startedAt,outcome:'running'},'turn.started',{run:(task.runCount||0)+1,prompt:compactActivityText(nextPrompt,320),startedAt})
      runText=await agent.run({
        sessionId:session.id,
        messages:loaded.messages,
        cwd:task.cwd,
        instructions:instructions+renderSpecialistText(task)+renderScopeText(task),
        repositoryContext:`${formatRepositoryMap(map,repositoryBudget.mapPaths,repositoryBudget.mapTokens)}\n\n${retrieved}`,
        skillsContext:'(automatic skill discovery is performed by the agent)',
        prompt:nextPrompt,
        allowedTools,
        scopePaths:task.scopePaths,
        taskId:task.id,delegationDepth:task.delegationDepth||0,specialistRole:role.name,
        onUsage:(delta:{inputTokens:number;outputTokens:number;totalTokens:number;estimated:boolean})=>{ usage={inputTokens:usage.inputTokens+delta.inputTokens,outputTokens:usage.outputTokens+delta.outputTokens,totalTokens:usage.totalTokens+delta.totalTokens,estimated:usage.estimated||delta.estimated}; },
        onTool:(name:string,args:unknown,callId?:string)=>{
          const at=Date.now()
          const detail=activityDetail(args)
          recordActivity({kind:'tool',label:`Using ${name}`,detail,at,callId,outcome:'running'},'tool.started',{name,callId,detail})
        },
        onToolResult:(name:string,output:string,metadata?:any)=>{
          const at=Date.now()
          const lifecycle=metadata?.toolLifecycle||{}
          const callId=typeof lifecycle.callId==='string'?lifecycle.callId:undefined
          const outcome=lifecycle.outcome==='error'||lifecycle.state==='error'?'error':'success'
          recordActivity({kind:'tool',label:`${outcome==='error'?'Failed':'Finished'} ${name}`,detail:outcome==='error'?'Tool returned an error':undefined,at,callId,outcome},'tool.completed',{name,callId,outcome,outputLength:String(output||'').length})
        },
        onText:(chunk:string)=>{
          void manager.appendOutput(task.id,chunk)
          resultText+=chunk
          outputBytes+=Buffer.byteLength(chunk,'utf8')
          const now=Date.now()
          if(now-lastOutputProgressAt>=900){
            lastOutputProgressAt=now
            outputProgressWrites=outputProgressWrites.then(async()=>{
              await manager.update(task.id,{outputBytes})
              await manager.event(task.id,'output.progress',{outputBytes})
            }).catch(()=>{})
          }
        },
      } as any)
      await manager.flushOutput(task.id)
      await Promise.all([activityWrites,outputProgressWrites])
      resultText=(runText||resultText).trim()||resultText.trim()
      const current=await manager.get(task.id)
      const completedAt=Date.now()
      await manager.update(task.id,{runCount:(current.runCount||0)+1,updated:completedAt,result:resultText.slice(-12000),usage,outputBytes:Math.max(current.outputBytes||0,outputBytes),activity:{kind:'turn',label:'Agent turn completed',detail:`${Math.max(0,completedAt-startedAt)} ms`,at:completedAt,outcome:'success'}})
      await manager.event(task.id,'turn.completed',{run:(current.runCount||0)+1,durationMs:Math.max(0,completedAt-startedAt),outputBytes:Math.max(current.outputBytes||0,outputBytes),usage})
      const pending=await manager.takePendingPrompt(task.id)
      if(!pending) break
      nextPrompt=pending
      resultText=''
      await manager.event(task.id,'continued',{prompt:compactActivityText(nextPrompt,320),previousRunMs:Date.now()-startedAt}).catch(()=>{})
    }

    await manager.flushOutput(task.id)
    await Promise.all([activityWrites,outputProgressWrites])
    if(lastOutputProgressBytes!==outputBytes){
      await manager.update(task.id,{outputBytes})
      await manager.event(task.id,'output.progress',{outputBytes,final:true})
      lastOutputProgressBytes=outputBytes
    }
    const finalOutput=await manager.readOutput(task.id,DEFAULT_OUTPUT_BYTES,true)
    const finalResult=resultText||task.result||''
    const compactReport=`[${role.name} specialist]\n${finalResult.replace(/\s+/g,' ').trim().slice(0,6000)}`
    const finished=await manager.finish(task.id,{status:'exited',exitCode:0,result:compactReport,output:finalOutput,sessionId:session.id,childSessionId:session.id,ended:Date.now(),usage,activity:{kind:'turn',label:'Agent completed',at:Date.now(),outcome:'success'}})
    if(finished.status==='exited') await manager.event(task.id,'completed',{exitCode:0,sessionId:session.id,childSessionId:session.id})
  }catch(e){
    const message=e instanceof Error?e.message:String(e)
    await Promise.all([activityWrites,outputProgressWrites]).catch(()=>{})
    const current=await manager.get(id).catch(()=>task)
    const failed=await manager.finish(id,{status:'failed',exitCode:1,error:message,output:(current.output||'')+'\nERROR: '+message,ended:Date.now(),activity:{kind:'turn',label:'Agent failed',detail:compactActivityText(message,180),at:Date.now(),outcome:'error'}})
    if(failed.status==='failed') await manager.event(id,'failed',{error:message})
  }
}

async function runShell(task:TaskRecord,manager:TaskManager){
  const { runManagedShellTask } = await import('./shell-command.js')
  // Shell resolution is centralized in src/util/platform-shell.ts; passing no
  // explicit shell keeps POSIX behavior identical and fixes win32 selection.
  await runManagedShellTask(manager,task,undefined,task.timeoutMs||DEFAULT_SHELL_TIMEOUT_MS,DEFAULT_OUTPUT_BYTES,undefined)
}
