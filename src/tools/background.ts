import type { Provider, ProviderConfig } from '../providers/types.js'
import { ProviderRouter } from '../providers/router.js'
import { TaskManager } from '../tasks/manager.js'
import { summarizeTask } from '../tasks/format.js'
import type { ToolDefinition } from './types.js'
import { ToolRegistry } from './registry.js'
import { specialistRole, specialistRoleNames, restrictSpecialistTools } from '../agent/specialists.js'

function persistedSubagentConfig(provider: Provider, fallback?: ProviderConfig): ProviderConfig & { provider: string } {
  const selected = provider instanceof ProviderRouter ? provider.select('subagent') : { provider, config: provider.config || fallback }
  const cfg = selected.config
  if(!cfg?.baseUrl) throw new Error(`Provider ${selected.provider.id} has no base URL for a background agent`)
  const {apiKey: _apiKey, ...safe} = cfg
  return { ...safe, apiKeyEnv: cfg.apiKeyEnv, provider: cfg.provider || selected.provider.id, model: selected.provider.model, baseUrl: cfg.baseUrl }
}

export function backgroundTool(manager: TaskManager): ToolDefinition {
  return {
    name:'background',
    risk:'shell',
    description:'Start a persistent shell command in the background. Returns a durable task id.',
    schema:{type:'object',properties:{command:{type:'string',minLength:1},scope_paths:{type:'array',items:{type:'string'}}},required:['command']},
    async execute(a,c){
      const scopes=Array.isArray(a.scope_paths)?a.scope_paths.map(String).filter(Boolean):(c.scopePaths?.length?c.scopePaths:['.'])
      const task=await manager.createShell(String(a.command||''),c.cwd,c.sessionID,scopes,{background:true})
      try {
        const pid=await manager.spawnWorker(task.id)
        const current=await manager.attachPid(task.id,pid)
        if(current.status==='cancelled'){try{process.kill(pid,'SIGTERM')}catch{}}
        return {output:`Started background task ${task.id} (worker pid ${pid}). Use task_status to observe it or task_output when you explicitly need its output.`,metadata:{background:true,taskId:task.id,status:'running',pid,kind:'shell',scopePaths:scopes}}
      } catch(error) {
        await manager.finish(task.id,{status:'failed',error:(error as Error).message,output:`ERROR: ${(error as Error).message}`}).catch(()=>{})
        throw error
      }
    }
  }
}

export function taskStatusTool(manager: TaskManager): ToolDefinition {
  return {
    name:'task_status',
    risk:'read',
    description:'Get durable task state. By default this does not read task output; use task_output when output is explicitly needed.',
    schema:{type:'object',properties:{id:{type:'string',minLength:1},block:{type:'boolean'},timeout:{type:'number',minimum:0}},required:['id']},
    async execute(a,c){
      const id=String(a.id||'')
      if(!id)throw new Error('task_status requires a task id')
      const block=Boolean(a.block)
      const timeout=Number.isFinite(Number(a.timeout))?Math.max(0,Number(a.timeout)):30_000
      const task=block?await manager.wait(id,timeout,c.abort,false):await manager.get(id)
      const summary=summarizeTask(task)
      return {output:JSON.stringify({...summary,result:task.result??null,error:task.error??null,ended:task.ended??null,background:Boolean(task.background||task.backgrounded),outputPath:task.outputPath??null,parentSessionId:task.parentSessionId??null,parentTaskId:task.parentTaskId??null,childSessionId:task.childSessionId||task.sessionId||null,specialistRole:task.specialistRole||'general',delegationDepth:task.delegationDepth??0,usage:task.usage??null},null,2),metadata:{taskId:task.id,status:task.status,blocked:block,timeoutMs:block?timeout:0}}
    }
  }
}

export function taskOutputTool(manager: TaskManager): ToolDefinition {
  return {
    name:'task_output',
    risk:'read',
    description:'Explicitly retrieve task output from the durable output file. Blocking waits for terminal state first; non-blocking returns the current output immediately.',
    schema:{type:'object',properties:{id:{type:'string',minLength:1},block:{type:'boolean'},timeout:{type:'number',minimum:0},max_bytes:{type:'number',minimum:256},tail:{type:'boolean'}},required:['id']},
    async execute(a,c){
      const id=String(a.id||'')
      if(!id)throw new Error('task_output requires a task id')
      const block=a.block===undefined?true:Boolean(a.block)
      const timeout=Number.isFinite(Number(a.timeout))?Math.max(0,Number(a.timeout)):30_000
      const maxBytes=Number.isFinite(Number(a.max_bytes))?Math.max(256,Math.min(2_000_000,Number(a.max_bytes))):20_000
      const tail=a.tail===undefined?true:Boolean(a.tail)
      const task=block?await manager.wait(id,timeout,c.abort,false):await manager.get(id)
      const output=await manager.readOutput(task.id,maxBytes,tail)
      return {output:JSON.stringify({id:task.id,status:task.status,kind:task.kind,outputPath:task.outputPath||null,outputBytes:task.outputBytes||null,outputTruncated:Boolean(task.outputTruncated)||output.includes('[earlier output omitted]'),result:task.result??null,error:task.error??null,output},null,2),metadata:{taskId:task.id,status:task.status,blocked:block,timedOut:block&&(task.status==='queued'||task.status==='running'),outputPath:task.outputPath||null}}
    }
  }
}

export function taskCancelTool(manager: TaskManager): ToolDefinition {
  return {name:'task_cancel',risk:'shell',description:'Cancel a background task by id.',schema:{type:'object',properties:{id:{type:'string',minLength:1}},required:['id']},async execute(a){const t=await manager.cancel(String(a.id||''));return {output:`Task ${t.id} is ${t.status}.`,metadata:{taskId:t.id,status:t.status}}}}
}

export function backgroundAgentTool(manager: TaskManager, provider: Provider, providerConfig?: ProviderConfig, parentRegistry?: ToolRegistry): ToolDefinition {
  return {
    name:'background_agent',
    risk:'shell',
    description:'Start a persistent autonomous coding agent task. It runs independently and stores status/output for later inspection.',
    schema:{type:'object',properties:{prompt:{type:'string',minLength:1},scope_paths:{type:'array',items:{type:'string'}},role:{type:'string',enum:specialistRoleNames()}},required:['prompt']},
    async execute(a,c){
      const cfg=persistedSubagentConfig(provider,providerConfig)
      const policy=parentRegistry?parentRegistry.gate.deriveChildPolicy(parentRegistry.list()):{mode:'deny' as const,rules:[],allowedTools:[]}
      const role=specialistRole(typeof a.role==='string'?a.role:'general')
      const allowedTools=restrictSpecialistTools(role.name,policy.allowedTools)
      if(role.name!=='general' && !allowedTools.length) throw new Error(`Specialist role '${role.name}' has no tools permitted by the parent policy.`)
      const scopes=Array.isArray(a.scope_paths)?a.scope_paths.map(String).filter(Boolean):(c.scopePaths?.length?c.scopePaths:['.'])
      const task=await manager.createAgent(String(a.prompt||''),c.cwd,cfg,scopes,c.sessionID,{permissionMode:policy.mode,permissionRules:policy.rules,allowedTools,background:true,specialistRole:role.name,delegationDepth:(c.delegationDepth||0)+1,parentTaskId:c.taskId})
      try {
        const pid=await manager.spawnWorker(task.id)
        const current=await manager.attachPid(task.id,pid)
        if(current.status==='cancelled'){try{process.kill(pid,'SIGTERM')}catch{}}
        return {output:`Started background agent ${task.id} (${task.specialistRole||'general'} specialist; worker pid ${pid}). Use task_status to observe it or task_output when you explicitly need its output.`,metadata:{background:true,taskId:task.id,status:'running',pid,kind:'agent',scopePaths:scopes,allowedTools:task.allowedTools||[],specialistRole:task.specialistRole||role.name}}
      } catch(error) {
        await manager.finish(task.id,{status:'failed',error:(error as Error).message,output:`ERROR: ${(error as Error).message}`}).catch(()=>{})
        throw error
      }
    }
  }
}
