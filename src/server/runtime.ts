import process from 'node:process'
import crypto from 'node:crypto'
import { loadConfig, resolveProviderConfig, type Config, type ProviderProfile } from '../config/config.js'
import { loadInstructions } from '../context/instructions.js'
import { compactMessages } from '../agent/compaction.js'
import { buildRepositoryMap, formatRepositoryMap } from '../context/repository.js'
import { retrieveContext } from '../context/retrieval.js'
import { createProvider } from '../providers/registry.js'
import { ProviderRouter } from '../providers/router.js'
import { resolveProviderTarget } from '../providers/selection.js'
import { SessionStore } from '../session/store.js'
import { PermissionGate } from '../tools/permissions.js'
import { ToolRegistry } from '../tools/registry.js'
import { builtinTools } from '../tools/builtin.js'
import { taskTool } from '../tools/task.js'
import { questionTool } from '../tools/question.js'
import { backgroundTool, taskStatusTool, taskCancelTool, backgroundAgentTool } from '../tools/background.js'
import { TaskManager } from '../tasks/manager.js'
import { loadPlugins } from '../plugins/loader.js'
import { connectMCP } from '../mcp/client.js'
import { Agent } from '../agent/agent.js'
import { projectionHash } from '../context/state.js'
import { loadSkillCatalog } from '../skills/catalog.js'
import { skillTools } from '../tools/skills.js'
import { verifyTool } from '../tools/verify.js'
import { agentModeTool } from '../tools/agent-mode.js'
import { sessionTodoTool } from '../tools/session-todo.js'
import { parallelAgentTool } from '../tools/parallel.js'
import { loadCustomAgents, loadCustomCommands } from '../agent/custom.js'
import { loadInstalledPluginComponents } from '../plugins/components.js'
import { PluginHookManager } from '../plugins/hooks.js'

export type Runtime = Awaited<ReturnType<typeof createRuntime>>

export async function createRuntime(cwd:string) {
  const cfg=await loadConfig(cwd)
  const store=new SessionStore()
  const gate=new PermissionGate(cfg.approvals, process.stdin, process.stdout, cfg.permissionRules || [], store)
  const registry=new ToolRegistry(gate)
  builtinTools({timeout:cfg.shellTimeoutMs,maxOutput:cfg.maxOutputBytes,toolOutputMaxLines:cfg.toolOutputMaxLines,toolOutputMaxBytes:cfg.toolOutputMaxBytes,toolOutputRetentionDays:cfg.toolOutputRetentionDays}).forEach(t=>registry.add(t)); registry.add(questionTool(store))
  const tasks=new TaskManager(); await tasks.recover()
  let providerCfg:any=resolveProviderConfig(cfg)
  let provider:any=createProvider(providerCfg)
  registry.add(backgroundTool(tasks)); registry.add(taskStatusTool(tasks)); registry.add(taskCancelTool(tasks));
  registry.add(verifyTool(cfg.shellTimeoutMs,cfg.maxOutputBytes,tasks))
  let agentMode='build'; let selectedCustom:any=undefined
  registry.add(agentModeTool(()=>agentMode,(m)=>{agentMode=m})); registry.add(sessionTodoTool(store))
  const fallbackProviders=(cfg.fallbackProviders||[]).map(name=>createProvider(resolveProviderConfig(cfg,name) as any))
  const roleProviders:any={}
  for(const [role,name] of Object.entries(cfg.routing||{})){if(typeof name==='string'&&name){const target=resolveProviderTarget(cfg,name);if(target)roleProviders[role]=[target]}}
  const smart=cfg.smartRouting
  if(smart?.enabled){
    const simple=resolveProviderTarget(cfg,smart.simpleModel); const strong=resolveProviderTarget(cfg,smart.strongModel)
    if(simple)roleProviders.simple=[simple]
    if(strong)roleProviders.strong=[strong]
  }
  if(fallbackProviders.length||Object.keys(roleProviders).length||smart?.enabled) provider=new ProviderRouter([provider,...fallbackProviders],()=>{},roleProviders,smart)
  registry.add(backgroundAgentTool(tasks,provider,provider.config,registry)); registry.add(parallelAgentTool(tasks,provider,provider.config||providerCfg,registry))
  registry.add(taskTool(provider,store,registry,tasks,provider.config))
  await loadPlugins(cwd,registry,cfg.plugins||[])
  const pluginComponents=await loadInstalledPluginComponents()
  pluginComponents.errors.forEach(e=>console.error(`[plugin:${e.plugin}:${e.component}] ${e.error}`))
  const hookManager=new PluginHookManager(pluginComponents.hooks,gate)
  const mcp=await connectMCP({...cfg.mcp,...pluginComponents.mcpServers},cwd); mcp.tools.forEach(t=>registry.add(t))
  skillTools(async (sessionID,event)=>{ await store.append(sessionID,{type:`skill.${event.action}` as any,ts:Date.now(),data:event}) }, { maxBodyTokens: Math.max(512, Math.floor((cfg.maxContextTokens || 12000) * 0.16)) }).forEach(t=>registry.add(t))
  const instructions=await loadInstructions(cwd)
  const skillCatalog=await loadSkillCatalog(cwd); const skills=skillCatalog.list()
  const customAgents=[...(await loadCustomAgents(cwd)),...pluginComponents.agents]
  const customCommands=[...(await loadCustomCommands(cwd)),...pluginComponents.commands]
  const activeControllers=new Map<string,AbortController>()
  let repositoryMap=await buildRepositoryMap(cwd)
  return {
    cwd,cfg,store,registry,tasks,mcp,instructions,skills,customAgents,customCommands,getProvider:()=>provider,getProviderCfg:()=>providerCfg,
    getMode:()=>agentMode,setMode:(m:string)=>{agentMode=m;selectedCustom=undefined},getCustom:()=>selectedCustom,
    setCustom:(a:any)=>{selectedCustom=a},getRepository:()=>repositoryMap,
    async refresh(){ repositoryMap=await buildRepositoryMap(cwd); return repositoryMap },
    async runPrompt(sessionId:string,messages:any[],prompt:string,opts:{mode?:string;customAgent?:any;autonomous?:boolean;signal?:AbortSignal;onText?:(s:string)=>void;onReasoning?:(s:string)=>void;onTool?:(n:string,a:any)=>void;onToolResult?:(n:string,o:string,m?:any)=>void;onQuestion?:(questions:any[],signal?:AbortSignal)=>Promise<string[][]|import('../tools/types.js').QuestionResponse>;onStatus?:(s:string)=>void;allowedTools?:string[]}={}){
      const mode=opts.mode||agentMode
      const custom=opts.customAgent
      const selectedProvider = custom?.model ? (resolveProviderTarget(cfg, custom.model) || provider) : provider
      const repositoryOverview=formatRepositoryMap(repositoryMap,100)
      const retrieved=await retrieveContext(repositoryMap,prompt,{maxFiles:5,maxBytes:cfg.maxContextBytes||36000})
      const selected=skills
      const agent=new Agent(selectedProvider,registry,store,cfg.maxToolRounds,cfg.maxContextTokens||12000,cfg.retryMax||4,opts.onStatus,skills,{threshold:cfg.compactionThreshold,reserveTokens:cfg.contextReserveTokens,recentTokens:cfg.contextRecentTokens},hookManager,{maxLines:cfg.toolOutputMaxLines,maxBytes:cfg.toolOutputMaxBytes,retentionDays:cfg.toolOutputRetentionDays},cfg.postEditVerification)
      const controller=new AbortController()
      if(opts.signal){if(opts.signal.aborted)controller.abort();else opts.signal.addEventListener('abort',()=>controller.abort(),{once:true})}
      if(activeControllers.has(sessionId)) throw new Error('Session is busy: another prompt is already running')
      activeControllers.set(sessionId,controller)
      try {
        return await agent.run({sessionId,messages,cwd,instructions,repositoryContext:`${repositoryOverview}\n\n${retrieved}`,skillsContext:'(automatic skill discovery is performed by the agent)',prompt,onText:opts.onText,onReasoning:opts.onReasoning,onTool:opts.onTool,onToolResult:opts.onToolResult,onQuestion:opts.onQuestion,autonomous:opts.autonomous,mode,customAgent:opts.customAgent,signal:controller.signal,allowedTools:opts.allowedTools} as any)
      } finally { activeControllers.delete(sessionId) }
    },
    async contextSnapshot(sessionId:string){
      const { estimateMessagesTokens, createContextBudget } = await import('../context/budget.js')
      const x=await store.load(sessionId)
      const contextCheckpoint=await store.latestContextCheckpoint(sessionId)
      const projectedMessages=Array.isArray(contextCheckpoint?.messages) ? contextCheckpoint.messages : x.messages
      const tokens=estimateMessagesTokens(projectedMessages)
      const limit=cfg.maxContextTokens||12000
      const budget=createContextBudget({maxContextTokens:limit,reserveTokens:cfg.contextReserveTokens||0,recentTokens:cfg.contextRecentTokens||3000,maxOutputTokens:provider.config?.maxTokens||0})
      return {sessionId,tokens,limit,remaining:Math.max(0,limit-tokens),utilization:limit?tokens/limit:0,messageCount:projectedMessages.length,toolMessages:projectedMessages.filter((m:any)=>m.role==='tool').length,updated:x.meta?.updated,checkpoint:contextCheckpoint?{id:contextCheckpoint.id,epoch:contextCheckpoint.epoch,stage:contextCheckpoint.stage,summaryRevision:contextCheckpoint.summaryRevision}:undefined}
    },
    async compactSession(sessionId:string){
      const x=await store.load(sessionId)
      const budget=cfg.maxContextTokens||12000
      const compacted=compactMessages(x.messages,budget,{maxOutputTokens:provider.config?.maxTokens||0,threshold:1,reserveTokens:0,recentTokens:cfg.contextRecentTokens||3000})
      if(compacted.removed){
        const prior=await store.latestContextCheckpoint(sessionId)
        const loaded=await store.load(sessionId)
        const activeTurn=[...loaded.events].reverse().find((e:any)=>e.type==='turn'&&e.data?.status==='committed')?.data
        const epoch=Number(prior?.epoch||0)+1
        const summaryRevision=Number(prior?.summaryRevision||0)+1
        const machine={...(prior?.machineState||{}),version:1,sessionId,turnId:activeTurn?.id,epoch,checkpointId:crypto.randomBytes(8).toString('hex'),sourceEventCount:loaded.events.length,projectionHash:projectionHash(compacted.messages),summaryRevision,createdAt:Date.now()}
        await store.append(sessionId,{type:'compaction',ts:Date.now(),data:{removed:compacted.removed,tokens:compacted.budget.usableTokens,summary:compacted.summary,budget:compacted.budget,manual:true,api:true,stage:'full-compaction',epoch,summaryRevision}})
        await store.saveContextCheckpoint(sessionId,{version:1,id:machine.checkpointId,sessionId,turnId:activeTurn?.id,epoch,sourceEventCount:loaded.events.length,projectionHash:machine.projectionHash,summaryRevision,summary:compacted.summary,messages:compacted.messages.filter((m:any)=>m.role!=='system'),machineState:machine,stage:'full-compaction',createdAt:Date.now()})
      }
      return {messages:compacted.messages,removed:compacted.removed,budget:compacted.budget,summary:compacted.summary}
    },
    interrupt(sessionId:string){ const controller=activeControllers.get(sessionId); if(!controller) return false; controller.abort(); return true },
    isRunning(sessionId:string){ return activeControllers.has(sessionId) },
    async close(){await Promise.all(mcp.clients.map(c=>c.close()))}
  }
}
