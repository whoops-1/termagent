import type { Provider } from '../providers/openai-compatible.js'
import type { ProviderConfig } from '../providers/types.js'
import { SessionStore } from '../session/store.js'
import { TaskManager, type TaskRecord } from '../tasks/manager.js'
import { persistedSubagentConfigForTask } from '../tasks/task-provider.js'
import type { ToolDefinition } from './types.js'
import { ToolRegistry } from './registry.js'
import { sessionTodoTool } from './session-todo.js'
import { specialistRole, specialistRoleNames, restrictSpecialistTools } from '../agent/specialists.js'

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000

function renderTask(task:TaskRecord, state:'running'|'completed'|'error'|'cancelled', text:string) {
  const tag=state==='error'?'task_error':'task_result'
  const summary=(text||'').replace(/\s+/g,' ').trim().slice(0,2000)
  return `<task id="${task.id}" state="${state}">\n<summary>${summary||'No task result was produced.'}</summary>\n<${tag}>\n${text||'(no result)'}\n</${tag}>\n</task>`
}

function taskResultState(task:TaskRecord):'completed'|'error'|'cancelled'|'running'{
  if(task.status==='exited')return 'completed'
  if(task.status==='cancelled')return 'cancelled'
  if(task.status==='failed')return 'error'
  return 'running'
}

export function taskTool(provider:Provider, store:SessionStore, parentRegistry:ToolRegistry, manager:TaskManager=new TaskManager(), providerConfig?:ProviderConfig):ToolDefinition {
  return {
    name:'task', risk:'shell',
    description:'Run a focused child coding task with a durable task id. Optional specialist roles restrict tools and behavior. Foreground waits for completion; background returns immediately and notifies the parent when the task finishes. Reusing task_id resumes the same child session, or queues a message when it is already running.',
    schema:{type:'object',properties:{description:{type:'string',minLength:1},prompt:{type:'string',minLength:1},task_id:{type:'string'},background:{type:'boolean'},scope_paths:{type:'array',items:{type:'string'}},context:{type:'string'},role:{type:'string',enum:specialistRoleNames()}},required:['prompt']},
    async execute(args,ctx){
      const prompt=String(args.prompt||'').trim()
      if(!prompt)throw new Error('task prompt must not be empty')
      const context=String(args.context||'').trim()
      const effectivePrompt=context?`${prompt}\n\nAdditional context from the parent task:\n${context}`:prompt
      const description=String(args.description||prompt.split(/\s+/).slice(0,5).join(' ')).trim().slice(0,120)
      const background=Boolean(args.background)
      const requestedScopes=Array.isArray(args.scope_paths)?args.scope_paths.map(String).filter(Boolean):[]
      const scopePaths=requestedScopes.length?requestedScopes:(ctx.scopePaths?.length?ctx.scopePaths:['.'])
      const policy=parentRegistry.gate.deriveChildPolicy(parentRegistry.list())
      const role=specialistRole(typeof args.role==='string' ? args.role : 'general')
      const roleAllowedTools=restrictSpecialistTools(role.name,policy.allowedTools)
      if(role.name !== 'general' && roleAllowedTools.length===0) throw new Error(`Specialist role '${role.name}' has no tools permitted by the parent policy.`)
      const persistedProvider=persistedSubagentConfigForTask(provider,providerConfig)
      let task:TaskRecord

      if(args.task_id){
        const existing=await manager.get(String(args.task_id))
        if(existing.kind!=='agent')throw new Error(`Task ${existing.id} is not an agent task`)
        if(existing.status==='queued'||existing.status==='running'){
          if(background && existing.status==='running'){
            await manager.queuePrompt(existing.id,effectivePrompt)
            return {title:description,output:`Queued a message for running task ${existing.id}. It will continue in the same child session after its current turn.`,metadata:{taskId:existing.id,childSessionId:existing.childSessionId,status:'running',background:true,queued:true}}
          }
          await manager.queuePrompt(existing.id,effectivePrompt)
          const waited=await manager.wait(existing.id,Number(process.env.TERMAGENT_TASK_TIMEOUT_MS||DEFAULT_TASK_TIMEOUT_MS),ctx.abort)
          if(waited.status==='queued'||waited.status==='running') return {title:description,output:renderTask(waited,'running','The child task is still running. Use task_status or task_output to inspect it explicitly.'),metadata:{taskId:waited.id,childSessionId:waited.childSessionId,status:'running',specialistRole:waited.specialistRole||role.name}}
          const text=waited.result||waited.error||waited.output||''
          return {title:description,output:renderTask(waited,taskResultState(waited),text),metadata:{taskId:waited.id,childSessionId:waited.childSessionId,status:waited.status}}
        }
        task=await manager.resume(existing.id,effectivePrompt)
        task=await manager.update(task.id,{parentSessionId:existing.parentSessionId||ctx.sessionID,scopePaths:existing.scopePaths||scopePaths,permissionMode:existing.permissionMode||policy.mode,permissionRules:existing.permissionRules||policy.rules,allowedTools:existing.allowedTools||roleAllowedTools,background,provider:existing.provider||persistedProvider,specialistRole:existing.specialistRole||role.name,delegationDepth:existing.delegationDepth??((ctx.delegationDepth||0)+1),parentTaskId:existing.parentTaskId||ctx.taskId})
      } else {
        task=await manager.createAgent(effectivePrompt,ctx.cwd,persistedProvider,scopePaths,ctx.sessionID,{permissionMode:policy.mode,permissionRules:policy.rules,allowedTools:roleAllowedTools,background,specialistRole:role.name,delegationDepth:(ctx.delegationDepth||0)+1,parentTaskId:ctx.taskId})
      }

      await manager.spawnWorker(task.id)
      if(background){
        return {title:description,output:renderTask(task,'running','The child task is working in the background. You will receive a completion notification. Do not poll unless you need the explicit result.'),metadata:{taskId:task.id,childSessionId:task.childSessionId,status:'running',background:true,scopePaths:task.scopePaths||[],specialistRole:task.specialistRole||role.name,allowedTools:task.allowedTools||[]}}
      }
      const waited=await manager.wait(task.id,Number(process.env.TERMAGENT_TASK_TIMEOUT_MS||DEFAULT_TASK_TIMEOUT_MS),ctx.abort)
      if(waited.status==='queued'||waited.status==='running') return {title:description,output:renderTask(waited,'running','The child task is still running. Use task_status or task_output to inspect it explicitly.'),metadata:{taskId:waited.id,childSessionId:waited.childSessionId,status:'running',specialistRole:waited.specialistRole||role.name}}
      const text=waited.result||waited.error||waited.output||''
      return {title:description,output:renderTask(waited,taskResultState(waited),text),metadata:{taskId:waited.id,childSessionId:waited.childSessionId,status:waited.status,scopePaths:waited.scopePaths||[],specialistRole:waited.specialistRole||role.name,allowedTools:waited.allowedTools||[]}}
    }
  }
}
