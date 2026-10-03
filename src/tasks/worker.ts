import { TaskManager, type TaskRecord } from './manager.js'
import { SessionStore } from '../session/store.js'
import { PermissionGate } from '../tools/permissions.js'
import { ToolRegistry } from '../tools/registry.js'
import { builtinTools } from '../tools/builtin.js'
import { createProvider } from '../providers/registry.js'
import { Agent } from '../agent/agent.js'
import { loadInstructions } from '../context/instructions.js'
import { buildRepositoryMap, formatRepositoryMap } from '../context/repository.js'
import { retrieveContext } from '../context/retrieval.js'
import { loadSkillCatalog } from '../skills/catalog.js'
import { skillTools } from '../tools/skills.js'
import { taskOutputTool, taskStatusTool } from '../tools/background.js'
import { sessionTodoTool } from '../tools/session-todo.js'
import { verifyTool } from '../tools/verify.js'
import path from 'node:path'
import { specialistRole, restrictSpecialistTools } from '../agent/specialists.js'

const DEFAULT_SHELL_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_BYTES = 20_000

function normalizeProvider(task:TaskRecord){
  if(!task.provider) throw new Error('Agent task is missing provider configuration')
  return task.provider
}

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

export async function runTaskWorker(id:string, suppliedManager?:TaskManager){
  const manager=suppliedManager||new TaskManager()
  let task=await manager.get(id)
  if(!(await manager.claimWorker(id,process.pid,process.env.TERMAGENT_WORKER_TOKEN))) return
  task=await manager.get(id)
  try{
    if(task.kind==='shell') return await runShell(task,manager)
    if(task.kind!=='agent') throw new Error(`Unsupported task kind: ${task.kind}`)
    const providerConfig=normalizeProvider(task)
    const provider=createProvider(providerConfig)
    const store=new SessionStore(process.env.TERMAGENT_SESSION_ROOT||undefined)
    const session=await createChildSession(store,task,provider.model)
    await manager.update(task.id,{sessionId:session.id,childSessionId:session.id})

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
    skillTools(async (sessionID,event)=>{ await store.append(sessionID,{type:`skill.${event.action}` as any,ts:Date.now(),data:event}) }, { maxBodyTokens: 2048 }).forEach(t=>registry.add(t))

    const instructions=await loadInstructions(task.cwd)
    const skillCatalog=await loadSkillCatalog(task.cwd)
    const skills=skillCatalog.list()
    const map=await buildRepositoryMap(task.cwd)
    const retrieved=await retrieveContext(map,task.prompt||'',{maxFiles:8,maxBytes:36000})
    const role=specialistRole(task.specialistRole)
    const roleTools=task.allowedTools?.length ? restrictSpecialistTools(role.name,task.allowedTools) : undefined
    const allowedTools=roleTools?.length ? roleTools : task.allowedTools?.length ? task.allowedTools : undefined
    if(role.name!=='general' && !allowedTools?.length) throw new Error(`Specialist role '${role.name}' has no permitted tools after parent-policy intersection.`)
    const agent=new Agent(
      provider,
      registry,
      store,
      Math.min(Number(process.env.TERMAGENT_MAX_TOOL_ROUNDS||80), role.maxRounds),
      Number(process.env.TERMAGENT_MAX_CONTEXT_TOKENS||12000),
      4,
      ()=>{},
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
      runText=await agent.run({
        sessionId:session.id,
        messages:loaded.messages,
        cwd:task.cwd,
        instructions:instructions+renderSpecialistText(task)+renderScopeText(task),
        repositoryContext:`${formatRepositoryMap(map,100)}\n\n${retrieved}`,
        skillsContext:'(automatic skill discovery is performed by the agent)',
        prompt:nextPrompt,
        allowedTools,
        scopePaths:task.scopePaths,
        taskId:task.id,delegationDepth:task.delegationDepth||0,specialistRole:role.name,
        onUsage:(delta:{inputTokens:number;outputTokens:number;totalTokens:number;estimated:boolean})=>{ usage={inputTokens:usage.inputTokens+delta.inputTokens,outputTokens:usage.outputTokens+delta.outputTokens,totalTokens:usage.totalTokens+delta.totalTokens,estimated:usage.estimated||delta.estimated}; },
        onText:(chunk:string)=>{
          void manager.appendOutput(task.id,chunk)
          resultText+=chunk
        },
      } as any)
      await manager.flushOutput(task.id)
      resultText=(runText||resultText).trim()||resultText.trim()
      const current=await manager.get(task.id)
      await manager.update(task.id,{runCount:(current.runCount||0)+1,updated:Date.now(),result:resultText.slice(-12000),usage})
      const pending=await manager.takePendingPrompt(task.id)
      if(!pending) break
      nextPrompt=pending
      resultText=''
      await manager.event(task.id,'continued',{prompt:nextPrompt,previousRunMs:Date.now()-startedAt}).catch(()=>{})
    }

    await manager.flushOutput(task.id)
    const finalOutput=await manager.readOutput(task.id,DEFAULT_OUTPUT_BYTES,true)
    const finalResult=resultText||task.result||''
    const compactReport=`[${role.name} specialist]\n${finalResult.replace(/\s+/g,' ').trim().slice(0,6000)}`
    const finished=await manager.finish(task.id,{status:'exited',exitCode:0,result:compactReport,output:finalOutput,sessionId:session.id,childSessionId:session.id,ended:Date.now(),usage})
    if(finished.status==='exited') await manager.event(task.id,'completed',{exitCode:0,sessionId:session.id,childSessionId:session.id})
  }catch(e){
    const message=e instanceof Error?e.message:String(e)
    const current=await manager.get(id).catch(()=>task)
    const failed=await manager.finish(id,{status:'failed',exitCode:1,error:message,output:(current.output||'')+'\nERROR: '+message,ended:Date.now()})
    if(failed.status==='failed') await manager.event(id,'failed',{error:message})
  }
}

async function runShell(task:TaskRecord,manager:TaskManager){
  const { runManagedShellTask } = await import('./shell-command.js')
  await runManagedShellTask(manager,task,process.env.SHELL||'sh',task.timeoutMs||DEFAULT_SHELL_TIMEOUT_MS,DEFAULT_OUTPUT_BYTES,undefined)
}
