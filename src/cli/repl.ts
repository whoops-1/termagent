import process from 'node:process'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { loadConfig, resolveProviderConfig, saveUIPreferences } from '../config/config.js'
import { loadInstructions } from '../context/instructions.js'
import { migrateLegacyState } from '../migration.js'
import { buildRepositoryMap, formatRepositoryMap, invalidateRepositoryCache } from '../context/repository.js'
import { retrieveContext } from '../context/retrieval.js'
import { compactMessages } from '../agent/compaction.js'
import { estimateMessagesTokens } from '../context/budget.js'
import { projectionHash } from '../context/state.js'
import { createProvider } from '../providers/registry.js'
import { ProviderRouter } from '../providers/router.js'
import { resolveProviderTarget } from '../providers/selection.js'
import { listProviderProfiles, removeProviderProfile, saveProviderProfile, setActiveProviderProfile, useEnvironmentProvider, type ProviderProfileDraft } from '../providers/manager.js'
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
import { renderGitDiff } from '../diff/render.js'
import { searchHistory, formatHistory, userPromptHistory } from './history.js'
import { editExternally, exportConversation, markdownConversation } from './external-editor.js'
import { PromptQueueStore } from './prompt-queue.js'
import { SessionPromptQueue, type QueuedPrompt } from '../session/prompt-queue.js'
import { formatTaskDetail, formatTaskList } from '../tasks/format.js'
import { Agent } from '../agent/agent.js'
import { loadSkill } from '../skills/invoker.js'
import { doctor } from '../doctor.js'
import { verifyTool } from '../tools/verify.js'
import { agentModeTool } from '../tools/agent-mode.js'
import { activeTodoItems, todoTool } from '../tools/todo.js'
import { parallelAgentTool } from '../tools/parallel.js'
import { banner, error, toolEnd, toolStart } from './renderer.js'
import { loadCustomAgents, loadCustomCommands } from '../agent/custom.js'
import { loadInstalledPluginComponents } from '../plugins/components.js'
import { installPlugin, listPluginStates, removePlugin, setPluginEnabled } from '../plugins/plugin-install.js'
import { getMarketplace, loadKnownMarketplaces, refreshMarketplace, removeMarketplace, reconcileMarketplaces, getMarketplaceAutoUpdate, setMarketplaceAutoUpdate } from '../plugins/marketplace.js'
import { listSkillDescriptors, getSkillDetails } from '../skills/catalog.js'
import { addSkillRegistry, getSkillRegistry, installSkillFromRegistry, listInstalledRegistrySkills, listRegistrySkills, listSkillRegistries, refreshSkillRegistry, removeSkillRegistry, uninstallRegistrySkill } from '../skills/registry.js'
import type { PluginManagerSnapshot, PluginUIPlugin, MarketplaceUI } from './tui/plugin-manager.js'
import { PluginHookManager } from '../plugins/hooks.js'
import { reconcilePluginStateOnStartup } from '../plugins/reconcile.js'
import { autoUpdatePluginsInBackground } from '../plugins/updates.js'
import { interpolateCommandTemplate } from '../agent/interpolation.js'
import { PromptEditor, defaultCompletionItems, defaultCompletions, type EditorShortcut } from './input.js'
import { TerminalUI } from './ui.js'
import { listThemes, loadThemeCatalog, THEMES } from '../design-system/theme.js'
import { renderEffectPickerRows } from '../design-system/effects.js'
import { renderBannerStyleRows } from '../design-system/banner.js'

export async function start(cwd=process.cwd(),resume?:string){
 try { await migrateLegacyState(cwd) } catch (migrationError) { console.warn(`startup migration: ${(migrationError as Error).message}`) }
 const cfg=await loadConfig(cwd); const themeCatalog=await loadThemeCatalog(cwd); const store=new SessionStore(); let session:any; let messages:any[]=[]; let initialTodo:any[]=[]
 if(resume){const loaded=await store.load(resume);session=loaded.meta;messages=loaded.messages;const latest=[...loaded.events].reverse().find((e:any)=>e.type==='todo');if(Array.isArray(latest?.data?.items))initialTodo=activeTodoItems(latest.data.items)}else session=await store.create(cwd,cfg.model)
 const gate=new PermissionGate(cfg.approvals, process.stdin, process.stdout, cfg.permissionRules || []); const registry=new ToolRegistry(gate)
 builtinTools({timeout:cfg.shellTimeoutMs,maxOutput:cfg.maxOutputBytes,toolOutputMaxLines:cfg.toolOutputMaxLines,toolOutputMaxBytes:cfg.toolOutputMaxBytes,toolOutputRetentionDays:cfg.toolOutputRetentionDays}).forEach(t=>registry.add(t)); registry.add(questionTool(store))
 const tasks=new TaskManager(); await tasks.recover()
 let providerCfg:any=resolveProviderConfig(cfg); let provider:any=createProvider(providerCfg)
 let uiRef:TerminalUI|null=null
 registry.add(backgroundTool(tasks)); registry.add(taskStatusTool(tasks)); registry.add(taskCancelTool(tasks)); registry.add(verifyTool(cfg.shellTimeoutMs,cfg.maxOutputBytes,tasks))
 let agentMode='build'; let selectedCustom:any=undefined; const todoState:any[]=[...initialTodo]
 const clearCompletedTodoState=()=>{if(todoState.length && !todoState.some((item:any)=>item.status!=='done')){todoState.splice(0,todoState.length);uiRef?.setTodos(todoState)}}
 registry.add(agentModeTool(()=>agentMode,(m)=>{agentMode=m})); registry.add(todoTool(todoState,async items=>store.appendTodo(session.id,items),items=>uiRef?.setTodos(items)))
 const buildProvider=()=>{
   const base=createProvider(providerCfg)
   const fallbackProviders=(cfg.fallbackProviders||[]).map(name=>createProvider(resolveProviderConfig(cfg,name) as any))
   const roleProviders:any={}
   for(const [role,name] of Object.entries(cfg.routing||{})){if(typeof name==='string'&&name){const target=resolveProviderTarget(cfg,name);if(target)roleProviders[role]=[target]}}
   const smart=cfg.smartRouting
   if(smart?.enabled){
     const simple=resolveProviderTarget(cfg,smart.simpleModel); const strong=resolveProviderTarget(cfg,smart.strongModel)
     if(simple)roleProviders.simple=[simple]
     if(strong)roleProviders.strong=[strong]
   }
   if(fallbackProviders.length||Object.keys(roleProviders).length||smart?.enabled) return new ProviderRouter([base,...fallbackProviders],(from,to,reason)=>uiRef?.system(`provider route: ${from} → ${to} (${reason.slice(0,160)})`,'warn'),roleProviders,smart)
   return base
 }
 provider=buildProvider()
 const applyProviderTarget=(target:string)=>{
   const next=resolveProviderTarget(cfg,target)
   if(!next) throw new Error(`Unknown configured model/provider: ${target}`)
   providerCfg=resolveProviderConfig(cfg,target) as any
   provider=buildProvider()
   registry.add(backgroundAgentTool(tasks,provider,provider.config,registry))
   registry.add(parallelAgentTool(tasks,provider,provider.config||providerCfg,registry))
   registry.add(taskTool(provider,store,registry,tasks,provider.config))
   uiRef?.setModel(`${providerCfg.model}${providerCfg.variant?` [${providerCfg.variant}]`:''}`,providerCfg.provider||cfg.provider)
   return provider
 }
 registry.add(backgroundAgentTool(tasks,provider,provider.config,registry)); registry.add(parallelAgentTool(tasks,provider,provider.config||providerCfg,registry)); registry.add(taskTool(provider,store,registry,tasks,provider.config))
 await loadPlugins(cwd,registry,cfg.plugins||[])
 try {
   const marketplaceReconcile = await reconcileMarketplaces()
   const pluginReconcile = await reconcilePluginStateOnStartup()
   const summary = [
     marketplaceReconcile.broken.length ? `${marketplaceReconcile.broken.length} marketplace(s) broken` : '',
     pluginReconcile.dependencyBroken.length ? `${pluginReconcile.dependencyBroken.length} plugin dependency issue(s)` : '',
     pluginReconcile.cleaned.length ? `${pluginReconcile.cleaned.length} interrupted staging item(s) cleaned` : '',
   ].filter(Boolean)
   if (summary.length) console.warn(`startup reconciliation: ${summary.join('; ')}`)
 } catch (reconcileError) {
   console.warn(`startup plugin reconciliation failed: ${(reconcileError as Error).message}`)
 }
 const pluginComponents=await loadInstalledPluginComponents(); pluginComponents.errors.forEach(e=>output(`[plugin:${e.plugin}:${e.component}] ${e.error}`,'warn')); const hookManager=new PluginHookManager(pluginComponents.hooks,gate,(status)=>uiRef?.setStatus(status)); const mcp=await connectMCP({...cfg.mcp,...pluginComponents.mcpServers},cwd); mcp.tools.forEach(t=>registry.add(t))
 const instructions=await loadInstructions(cwd); const customAgents=[...(await loadCustomAgents(cwd)),...pluginComponents.agents]; const customCommands=[...(await loadCustomCommands(cwd)),...pluginComponents.commands]
 let repositoryMap=await buildRepositoryMap(cwd)
 const interactive=Boolean(process.stdin.isTTY&&process.stdout.isTTY)
 const promptStore=new PromptQueueStore(cwd)
 const runtimeQueue=new SessionPromptQueue(store)
 let handleQueueAction:(action:'edit'|'cancel'|'up'|'down',id:string)=>Promise<void> = async()=>{}
 let dispatchInteractiveInput:(value:string)=>Promise<boolean> = async value=>handleInput(value)
 const ui=interactive ? new TerminalUI({title: pathBasename(cwd),model:providerCfg.model,provider:cfg.provider,mode:agentMode,cwd,theme:cfg.ui?.theme,themes:themeCatalog,bannerStyle:cfg.ui?.bannerStyle,effect:cfg.ui?.effect,animations:cfg.ui?.animations !== false,motion:cfg.ui?.motion ?? (cfg.ui?.animations === false ? 'off' : 'full'),onMouseTarget:async(id)=>{
   if(!id.startsWith('picker:')) return
   const index=Number(id.slice('picker:'.length))
   if(!Number.isInteger(index)||index<0) return
   const result=await editor.clickCompletion(index)
   if(result?.type==='submit') await dispatchInteractiveInput(result.value)
 },onQueueAction:async(action,id)=>{await handleQueueAction(action,id)}}) : null
 uiRef=ui
 if(ui){
   gate.setRequester(request => ui.requestPermission(request))
   ui.hydrate(messages)
   ui.setTodos(todoState)
   ui.setContextUsage(estimateMessagesTokens(messages), cfg.maxContextTokens || 12000)
   ui.enter()
 } else banner(`${cfg.provider}:${providerCfg.model}`,cwd)

 // Upgrades are deliberately background-only: the current session keeps the
 // already-loaded component set and picks up installed versions after restart.
 autoUpdatePluginsInBackground({onProgress:(message)=>uiRef?.setStatus(message)})
 const commands=['help','model','models','variants','provider','agent','agents','commands','theme','effect','banner','animations','plugins','marketplace','marketplace-auto-update','skill','skill-registry','plan','build','explore','sessions','resume','fork','skills','doctor','permissions','context','compact','thinking','details','undo','redo','diff','repomap','history','editor','export','stash','queue','vim','tasks','task-log','checkpoints','checkpoint','restore','cancel','auto','clear','quit','exit']
 const builtinAgentModes=['build','plan','explore'] as const
 let processingQueue=false
 let activeTurnPromise:Promise<unknown>|null=null
 let editingQueuedId:string|undefined
 const agentShortcut=async(name:EditorShortcut)=>{
   if(name==='variants'){
     const variants=providerCfg && (providerCfg as any).variants ? Object.keys((providerCfg as any).variants) : []
     if(!variants.length){ output('no model variants configured for the active provider','warn'); return }
     const current=String((providerCfg as any).variant||'default')
     const next=variants[(variants.indexOf(current)+1+variants.length)%variants.length] || variants[0]
     const variant=(providerCfg as any).variants[next]||{}
     providerCfg={...providerCfg,variant:next,reasoningEffort:variant.reasoningEffort,temperature:variant.temperature??providerCfg.temperature,maxTokens:variant.maxTokens??providerCfg.maxTokens,extra:variant.extra}
     provider=buildProvider()
     ui?.setModel(`${providerCfg.model} [${next}]`,providerCfg.provider||cfg.provider)
     output(`model variant: ${next}`)
     return
   }
   if(name==='commands'){
     editor.openCommandPalette(commands.map(x=>`/${x}`))
     return
   }
   if(name==='thinking'){ ui?.openReasoningView(); return }
   if(name==='details'){ ui?.openLatestToolDetails(); return }
   if(name==='history'){
     editor.openHistoryPalette(userPromptHistory(messages).slice(-120).reverse())
     return
   }
   if(name==='editor'){
     const result=await editExternally(editor.value(),cwd,'.txt')
     editor.setValue(result.text)
     output(`editor: ${result.editor}`)
     return
   }
   if(name==='sessions'){
     const sessions=await store.list()
     if(!sessions.length){output('no saved sessions','warn');return}
     editor.openCommandPalette(sessions.map((s:any)=>`/resume ${s.id} · ${s.model} · ${s.cwd}`), async(value)=>{const id=String(value).match(/^\/resume\s+(\S+)/)?.[1];if(id)await resumeSession(id)})
     return
   }
   if(name==='stash'){
     const draft=editor.value()
     if(!draft.trim()){output('prompt draft is empty','warn');return}
     await promptStore.stash(draft)
     editor.setValue('')
     output('prompt draft stashed')
     return
   }
   const current=Math.max(0,builtinAgentModes.indexOf(agentMode as typeof builtinAgentModes[number]))
   const next=name==='agents-reverse'
     ? (current-1+builtinAgentModes.length)%builtinAgentModes.length
     : (current+1)%builtinAgentModes.length
   agentMode=builtinAgentModes[next]!
   selectedCustom=undefined
   ui?.setMode(agentMode)
   output(`agent mode: ${agentMode}`)
 }
 let visualPreview: { kind: 'theme'|'effect'|'banner'; theme?: string; effect?: string; banner?: string } | null = null
 const beginVisualPreview=(kind:'theme'|'effect'|'banner')=>{
   if (!ui) return
   if (!visualPreview || visualPreview.kind!==kind) visualPreview={kind,theme:ui.getThemeId(),effect:ui.getBannerEffect(),banner:ui.getBannerStyle()}
 }
 const restoreVisualPreview=()=>{
   if (!ui || !visualPreview) return
   if (visualPreview.theme) ui.setTheme(visualPreview.theme)
   if (visualPreview.effect) ui.setBannerEffect(visualPreview.effect as any)
   if (visualPreview.banner) ui.setBannerStyle(visualPreview.banner as any)
   visualPreview=null
 }
 const persistVisualPreference=async(kind:'theme'|'effect'|'banner',value:string)=>{
   if (!ui) return
   beginVisualPreview(kind)
   if(kind==='theme') ui.setTheme(value)
   if(kind==='effect') ui.setBannerEffect(value as any)
   if(kind==='banner') ui.setBannerStyle(value as any)
   const patch=kind==='theme'?{theme:ui.getThemeId()}:kind==='effect'?{effect:ui.getBannerEffect()}:{bannerStyle:ui.getBannerStyle()}
   await saveUIPreferences(cwd,patch)
   visualPreview=null
   output(`${kind}: ${kind==='theme'?ui.getThemeName():kind==='effect'?ui.getBannerEffect():ui.getBannerStyle()}`)
 }
 const historyFromMessages=messages.filter(m=>m.role==='user' && typeof m.content==='string').map(m=>m.content as string)
 const editor=new PromptEditor({
  prompt:'',secondaryPrompt:'',history:historyFromMessages,
  completions:defaultCompletionItems(commands,customAgents.map(a=>a.name),cwd),
  onChange:(value,cursor)=>ui?.setInput(value,cursor),
  onCompletion:(state, reason)=>{
    ui?.setCompletion(state)
    if (!ui) return
    if (state?.kind === 'theme' || state?.kind === 'effect' || state?.kind === 'banner') {
      const row = state.rows[state.index]
      if (row && !row.disabled) {
        if (state.kind === 'theme') ui.setTheme(row.value)
        else if (state.kind === 'effect') ui.setBannerEffect(row.value as any)
        else ui.setBannerStyle(row.value as any)
      }
      return
    }
    // The editor tells us why a visual palette closed. Escape restores the
    // previous selection, while Enter has already applied and persisted it.
    if (reason === 'cancel') restoreVisualPreview()
  },
  onScroll:(delta)=>{if(delta<=-100000)ui?.scrollToTop();else if(delta>=100000)ui?.scrollToBottom();else ui?.scroll(delta)},
  onMouse:(event)=>{void ui?.handleMouse(event)},
  onShortcut:agentShortcut,
  keybinds: cfg.keybinds as any,
  onReadStateChange:(active)=>ui?.setEditorReading(active),
  isModalActive:()=>Boolean(ui?.isProviderManagerActive() || ui?.isPluginManagerActive() || ui?.isPermissionActive() || ui?.isQuestionActive() || ui?.isInspectorActive())
 })
 const output=(text:string,tone:'dim'|'warn'|'error'='dim')=>ui?ui.system(text,tone):console.log(text)
 const showError=(e:unknown)=>ui?ui.system((e as Error).message||String(e),'error'):error(e)
 const providerManagerCallbacks = {
   refresh: () => listProviderProfiles(cwd, cfg),
   setActive: async (name:string) => {
     if (name === '__environment__') {
       const envCfg=await loadConfig(cwd)
       await useEnvironmentProvider(cwd)
       cfg.provider=envCfg.provider; cfg.model=envCfg.model; cfg.baseUrl=envCfg.baseUrl; cfg.apiKeyEnv=envCfg.apiKeyEnv
       providerCfg=resolveProviderConfig(cfg) as any
       provider=buildProvider(); registry.add(taskTool(provider,store,registry,tasks,provider.config)); registry.add(backgroundAgentTool(tasks,provider,provider.config,registry)); registry.add(parallelAgentTool(tasks,provider,provider.config||providerCfg,registry))
       ui?.setModel(`${providerCfg.model || 'No model'}`, providerCfg.provider||cfg.provider)
       return 'Using environment/default provider for this session.'
     }
     const result=await setActiveProviderProfile(cwd,name)
     if(!cfg.providers) cfg.providers={}
     cfg.provider=name; cfg.model=result.profile.model; cfg.baseUrl=result.profile.baseUrl; cfg.apiKeyEnv=result.profile.apiKeyEnv||''; cfg.providers[name]=result.profile
     providerCfg={...result.profile,apiKey:result.profile.apiKey||process.env[result.profile.apiKeyEnv||'']}
     provider=buildProvider(); registry.add(taskTool(provider,store,registry,tasks,provider.config)); registry.add(backgroundAgentTool(tasks,provider,provider.config,registry)); registry.add(parallelAgentTool(tasks,provider,provider.config||providerCfg,registry))
     ui?.setModel(`${providerCfg.model}${providerCfg.variant?` [${providerCfg.variant}]`:''}`,name)
     return `Provider switched to ${name}.`
   },
   save: async (draft:ProviderProfileDraft,existingName?:string) => {
     const wasActive=Boolean(existingName && cfg.provider===existingName)
     const result=await saveProviderProfile(cwd,draft,existingName)
     if(!cfg.providers) cfg.providers={}
     if(existingName && existingName!==result.name) delete cfg.providers[existingName]
     cfg.providers[result.name]=result.profile
     const shouldActivate=!existingName || wasActive
     if(shouldActivate){
       await setActiveProviderProfile(cwd,result.name)
       cfg.provider=result.name; cfg.model=result.profile.model; cfg.baseUrl=result.profile.baseUrl; cfg.apiKeyEnv=result.profile.apiKeyEnv||''
       providerCfg={...result.profile,apiKey:result.profile.apiKey||process.env[result.profile.apiKeyEnv||'']}
       provider=buildProvider(); registry.add(taskTool(provider,store,registry,tasks,provider.config)); registry.add(backgroundAgentTool(tasks,provider,provider.config,registry)); registry.add(parallelAgentTool(tasks,provider,provider.config||providerCfg,registry))
       ui?.setModel(`${providerCfg.model}${providerCfg.variant?` [${providerCfg.variant}]`:''}`,result.name)
       return `Saved and activated ${result.name}.`
     }
     return `Saved ${result.name}.`
   },
   remove: async (name:string) => {
     const result=await removeProviderProfile(cwd,name)
     if(cfg.providers) delete cfg.providers[name]
     if(result.nextActive && cfg.providers?.[result.nextActive]) {
       cfg.provider=result.nextActive; cfg.model=cfg.providers[result.nextActive].model; cfg.baseUrl=cfg.providers[result.nextActive].baseUrl; cfg.apiKeyEnv=cfg.providers[result.nextActive].apiKeyEnv||''
       providerCfg={...cfg.providers[result.nextActive],apiKey:cfg.providers[result.nextActive].apiKey||process.env[cfg.providers[result.nextActive].apiKeyEnv||'']}
       provider=buildProvider(); registry.add(taskTool(provider,store,registry,tasks,provider.config)); registry.add(backgroundAgentTool(tasks,provider,provider.config,registry)); registry.add(parallelAgentTool(tasks,provider,provider.config||providerCfg,registry)); ui?.setModel(providerCfg.model,result.nextActive)
     }
     return `Removed ${name}.`
   }
 }
 const getPluginManagerSnapshot=async():Promise<PluginManagerSnapshot>=>{
   const [states, known, freshSkills, activeComponents] = await Promise.all([
     listPluginStates(),
     loadKnownMarketplaces(),
     listSkillDescriptors(cwd),
     loadInstalledPluginComponents({includeDisabled:true}),
   ])
   const componentCounts=new Map<string,{commands:number;agents:number;skills:number;mcp:number;hooks:number}>()
   for(const plugin of activeComponents.commands){const c=componentCounts.get(plugin.plugin.pluginId)||{commands:0,agents:0,skills:0,mcp:0,hooks:0};c.commands++;componentCounts.set(plugin.plugin.pluginId,c)}
   for(const plugin of activeComponents.agents){const c=componentCounts.get(plugin.plugin.pluginId)||{commands:0,agents:0,skills:0,mcp:0,hooks:0};c.agents++;componentCounts.set(plugin.plugin.pluginId,c)}
   for(const server of Object.values(activeComponents.mcpServers)){const c=componentCounts.get(server.pluginId)||{commands:0,agents:0,skills:0,mcp:0,hooks:0};c.mcp++;componentCounts.set(server.pluginId,c)}
   for(const specs of Object.values(activeComponents.hooks)){for(const spec of specs||[]){const c=componentCounts.get(spec.pluginId)||{commands:0,agents:0,skills:0,mcp:0,hooks:0};c.hooks++;componentCounts.set(spec.pluginId,c)}}
   for(const skill of freshSkills){if(skill.pluginId){const c=componentCounts.get(skill.pluginId)||{commands:0,agents:0,skills:0,mcp:0,hooks:0};c.skills++;componentCounts.set(skill.pluginId,c)}}
   const plugins:PluginUIPlugin[]=states.map(state=>({
     ...state,
     enabled: state.enabled !== false,
     components: componentCounts.get(state.id)||{commands:0,agents:0,skills:0,mcp:0,hooks:0},
   }))
   const marketplaces:MarketplaceUI[]=[]
   for(const [name,state] of Object.entries(known)){
     try{
       const data=await getMarketplace(name)
       marketplaces.push({name:data.marketplace.name,owner:data.marketplace.owner.name,description:data.marketplace.metadata?.description,source:data.state.source,status:data.state.status,lastUpdated:data.state.lastUpdated,revision:data.state.revision,digest:data.state.digest,plugins:data.marketplace.plugins,installLocation:data.installLocation})
     }catch(error){
       marketplaces.push({name,owner:'unknown',source:state.source,status:'broken',lastUpdated:state.lastUpdated,revision:state.revision,digest:state.digest,plugins:[],installLocation:state.installLocation})
     }
   }
   return {plugins,marketplaces,skills:freshSkills}
 }
 const pluginManagerCallbacks={
   refresh:getPluginManagerSnapshot,
   togglePlugin:async(marketplace:string,plugin:string,enabled:boolean)=>{await setPluginEnabled(marketplace,plugin,enabled)},
   removePlugin:async(marketplace:string,plugin:string)=>{await removePlugin(marketplace,plugin)},
   installPlugin:async(marketplace:string,plugin:string,confirmed:boolean)=>{const result=await installPlugin(marketplace,plugin,{thirdPartyConfirmed:confirmed,onProgress:(message)=>ui?.setStatus(message)});return {message:result.status,requiresConfirmation:result.error?.includes('confirmation')||false}},
   refreshMarketplace:async(name:string)=>{await refreshMarketplace(name,(event)=>ui?.setStatus(event.type==='fetch'?`fetching ${event.source}`:event.type==='validate'?`validating ${event.marketplace}`:`ready ${event.marketplace}`))},
   removeMarketplace:async(name:string)=>{await removeMarketplace(name)},
   skillDetails:async(id:string)=>getSkillDetails(cwd,id),
 }

 const resumeSession=async(id:string)=>{
   const loaded=await store.load(id); session=loaded.meta; messages=loaded.messages
   await runtimeQueue.recoverStaleExecuting(session.id)
   const latest=[...loaded.events].reverse().find((e:any)=>e.type==='todo')
   todoState.splice(0,todoState.length,...(Array.isArray(latest?.data?.items)?activeTodoItems(latest.data.items):[]))
   ui?.clearConversation(); ui?.hydrate(messages); ui?.setContextUsage(estimateMessagesTokens(messages), cfg.maxContextTokens || 12000); await syncQueue(); output(`resumed ${id}`)
 }
 const requestQuestion=async(questions:any[],signal?:AbortSignal)=>ui?ui.requestQuestion(questions,signal):questions.map(()=>[])
 const selectRequestProvider=(custom:any)=>custom?.model ? (resolveProviderTarget(cfg,custom.model) || provider) : provider
 const turnCommands=new Set(['auto','skill'])
 const blockedWhileTurn=new Set(['resume','restore','fork','branch','checkpoint','compact','clear','undo','redo','provider','quit','exit'])
 const commandName=(input:string)=>input.slice(1).trim().split(/\s+/,1)[0]?.toLowerCase() || ''
 const isTurnInput=(input:string)=>{
   if(!input.trim()) return false
   if(!input.startsWith('/')) return true
   const command=commandName(input)
   return turnCommands.has(command) || customCommands.some(cmd=>cmd.name===command)
 }
 const queueTarget=(raw:string,items:QueuedPrompt[])=>{
   const token=raw.trim()
   if(!token) return undefined
   const numeric=Number(token)
   if(Number.isInteger(numeric)&&numeric>=1) return items[numeric-1]
   return items.find(item=>item.id===token)
 }
 const syncQueue=async()=>{ ui?.setQueue(await runtimeQueue.list(session.id)); }
 await runtimeQueue.recoverStaleExecuting(session.id)
 await syncQueue()
 const handleInput = async (raw:string,fromQueue=false):Promise<boolean> => {
   const input=raw.trimEnd(); if(!input.trim()) return false
   try {
    if(editingQueuedId && fromQueue===false && !input.startsWith('/queue ')){
      await runtimeQueue.edit(session.id, editingQueuedId, input)
      editingQueuedId=undefined
      await syncQueue()
      ui?.setStatus('queued prompt updated')
      return false
    }
    if(input==='/quit'||input==='/exit') return true
    ui?.setInput('', 0)
    ui?.addUser(input)
    if(input==='/help'){output('/help  /theme  /effect  /banner  /animations  /model  /models  /provider <name>  /agent [build|plan|explore|custom]  /agents  /commands  /skill <id> [args]  /variants\n/plugins  /marketplace  /marketplace-auto-update <name> [on|off]  /skills [query|install|uninstall|installed|registries]  /skill-registry [list|add|remove|refresh|search|install|installed|uninstall]\n/plan  /build  /explore  /sessions  /resume <id>  /fork [message-count|checkpoint <id>]  /branch <checkpoint-id> [--restore]  /history [query]  /doctor  /context\n/permissions  /compact  /thinking  /undo  /redo  /diff  /details  /repomap [--tokens N] [--focus PATH] [--focus-symbols NAME] [--stats|--invalidate]\n/editor  /export  /vim  /stash [list|clear]  /queue [prompt|clear]  /tasks  /task-log <id>  /checkpoints  /checkpoint  /restore <id>  /cancel <id>  /auto <task>  /clear  /quit');return false}
    if(input==='/agent'){output(`${agentMode} · ${agentMode==='build'?'full development access':agentMode==='plan'?'read-only planning':'read-only exploration'}`);return false}
    if(input==='/theme' || input.startsWith('/theme ')){
      const requested = input.slice('/theme'.length).trim().toLowerCase()
      const themes=listThemes(themeCatalog)
      if(!requested && interactive && ui){
        beginVisualPreview('theme')
        editor.openThemePalette(themes.map(theme=>({id:`theme:${theme.id}`,label:theme.label,value:theme.id,detail:theme.detail,badge:theme.id===ui.getThemeId()?'selected':'theme',status:theme.id===ui.getThemeId()?'active':'default',swatches:theme.swatches} as any)),async value=>{await persistVisualPreference('theme',String(value))},ui.getThemeId())
        return false
      }
      if(!requested){output(`theme: ${ui?.getThemeName() ?? 'TermAgent'}
available: ${themes.map(t=>t.id).join(', ')}`);return false}
      if(ui && (themeCatalog[requested] || THEMES[requested])) { await persistVisualPreference('theme',requested); return false }
      throw new Error(`Unknown theme: ${requested}`)
    }
    if(input==='/effect' || input.startsWith('/effect ')){
      const requested=input.slice('/effect'.length).trim().toLowerCase()
      if(!requested && interactive && ui){
        beginVisualPreview('effect')
        editor.openEffectPalette(renderEffectPickerRows(ui.getTheme(), ui.getBannerEffect()),async value=>{await persistVisualPreference('effect',String(value))},ui.getBannerEffect())
        return false
      }
      if(!requested){output(`effect: ${ui?.getBannerEffect() ?? 'off'}
available: off, drift, glyphfall, spark, ripple, dust, pulse`);return false}
      if(ui && ['off','drift','glyphfall','spark','ripple','dust','pulse'].includes(requested)){await persistVisualPreference('effect',requested);return false}
      throw new Error(`Unknown banner effect: ${requested}`)
    }
    if(input==='/banner' || input.startsWith('/banner ')){
      const requested=input.slice('/banner'.length).trim().toLowerCase()
      if(!requested && interactive && ui){
        beginVisualPreview('banner')
        editor.openBannerPalette(renderBannerStyleRows(ui.getTheme(),ui.getBannerStyle()),async value=>{await persistVisualPreference('banner',String(value))},ui.getBannerStyle())
        return false
      }
      if(!requested){output(`banner: ${ui?.getBannerStyle() ?? 'showcase'}
available: showcase, split, signal, minimal`);return false}
      if(ui && ['showcase','split','signal','minimal'].includes(requested)){await persistVisualPreference('banner',requested);return false}
      throw new Error(`Unknown banner style: ${requested}`)
    }
    if(input==='/animations' || input==='/animations on' || input==='/animations off' || input==='/animations reduced'){
      if(!ui){output(`motion: ${cfg.ui?.motion ?? (cfg.ui?.animations===false?'off':'full')}`);return false}
      const raw=input.slice('/animations'.length).trim().toLowerCase()
      const mode=raw==='reduced'?'reduced':raw==='off'?'off':raw==='on'?'full':ui.getMotionMode()==='off'?'full':'off'
      ui.setMotionMode(mode)
      await saveUIPreferences(cwd,{motion:mode,animations:mode!=='off'})
      output(`motion: ${mode}`)
      return false
    }
    if(input==='/history'||input.startsWith('/history ')){const q=input.slice(8).trim();output(formatHistory(searchHistory(messages,q,40)));return false}
    if(input==='/variants'){const variants=(providerCfg as any).variants||{};output(Object.keys(variants).length ? [`active: ${String((providerCfg as any).variant||'default')}`, ...Object.entries(variants).map(([n,v]:any[])=>`${n}${v?.reasoningEffort?` · reasoning=${v.reasoningEffort}`:''}`)].join('\n') : 'no model variants configured');return false}
    if(input==='/models'){
      const names=Object.keys(cfg.providers||{})
      if(interactive && names.length){
        editor.openCommandPalette(names.map(n=>{const profile=(cfg.providers||{})[n] as any;return `${n} :: ${profile?.model||'unconfigured'}${profile?.variants?` · ${Object.keys(profile.variants).length} variants`:''}`}), async(value)=>{const name=String(value).split(' :: ',1)[0];applyProviderTarget(name);output(`active model: ${providerCfg.model} (${providerCfg.provider||cfg.provider})`)})
        return false
      }
      output([`active: ${provider.model} (${provider.id})`,...names.map(n=>`${n}: ${(cfg.providers||{})[n]?.model||'unconfigured'} @ ${(cfg.providers||{})[n]?.baseUrl||''}`),...Object.entries(cfg.routing||{}).filter(([,v])=>v).map(([r,v])=>`route ${r}: ${v}`)].join('\n'));return false
    }
    if(input==='/details'){if(ui) ui.openLatestToolDetails(); else output('tool details are only available in interactive mode');return false}
    if(input==='/vim'){const enabled=!editor.isVimMode();editor.setVimMode(enabled);ui?.setVimMode(enabled);output(`vim mode: ${enabled?'enabled':'disabled'}`);return false}
    if(input==='/stash'){const value=await promptStore.popStash();if(value){editor.setValue(value);output('restored stashed prompt')}else output('no stashed prompt','warn');return false}
    if(input==='/stash clear'){await promptStore.clearStash();output('stashed prompt cleared');return false}
    if(input==='/stash list'){const state=await promptStore.list();output(state.stash?`stashed prompt: ${state.stash.length} chars`:'no stashed prompt');return false}
    if(input==='/queue' || input.startsWith('/queue ')){
      const args=input.slice('/queue'.length).trim()
      const items=await runtimeQueue.list(session.id,false)
      if(!args){ const active=items.filter(item=>item.status==='queued'||item.status==='executing'); const queued=active.filter(item=>item.status==='queued'); const lines=active.filter(item=>item.status==='executing').map(q=>`running  ${q.content.replace(/\s+/g,' ').slice(0,160)}`); lines.push(...queued.map((q,i)=>`${i+1}. queued  ${q.content.replace(/\s+/g,' ').slice(0,160)}`)); output(lines.length ? lines.join('\n') : 'queue empty'); return false }
      const parts=args.split(/\s+/).filter(Boolean)
      const action=parts[0]?.toLowerCase()
      if(action==='clear'){ for(const item of items.filter(q=>q.status==='queued')) await runtimeQueue.cancel(session.id,item.id); await syncQueue(); output('queued prompts cleared'); return false }
      const queuedItems=items.filter(item=>item.status==='queued')
      const targetForAction=(raw:string)=>{ const token=raw.trim(); if(!token) return undefined; const numeric=Number(token); if(Number.isInteger(numeric)&&numeric>=1) return queuedItems[numeric-1]; return queuedItems.find(item=>item.id===token) }
      if(action==='edit'){ const item=targetForAction(parts[1]||''); if(!item) throw new Error('Usage: /queue edit <queued-number|id>'); editingQueuedId=item.id; editor.setValue(item.content); ui?.setStatus('editing queued prompt · Enter saves changes'); return false }
      if(action==='remove'||action==='cancel'){ const item=targetForAction(parts[1]||''); if(!item) throw new Error('Usage: /queue remove <queued-number|id>'); await runtimeQueue.cancel(session.id,item.id); await syncQueue(); output(`cancelled queued prompt ${item.id.slice(-8)}`); return false }
      if(action==='up'||action==='down'){ const item=targetForAction(parts[1]||''); if(!item) throw new Error(`Usage: /queue ${action} <queued-number|id>`); await runtimeQueue.move(session.id,item.id,action==='up'?-1:1); await syncQueue(); return false }
      const queued=await runtimeQueue.enqueue(session.id,args,{sourceClient:'terminal'}); await syncQueue(); output(`queued prompt ${queued.position+1}`); return false
    }
    if(input==='/editor'){const result=await editExternally('',cwd,'.txt');editor.setValue(result.text);return false}
    if(input==='/export'){const markdown=markdownConversation(messages,session);await exportConversation(markdown,cwd);output('conversation exported to the external editor');return false}
    if(input==='/agents'){
      if(interactive && customAgents.length){
        editor.openCommandPalette(customAgents.map(a=>`${a.name} :: ${a.mode} · ${a.description}`), async(value)=>{const name=String(value).split(' :: ',1)[0];const custom=customAgents.find(a=>a.name===name);if(!custom)throw new Error(`Unknown agent: ${name}`);selectedCustom=custom;agentMode=custom.mode==='subagent'?'build':custom.mode;ui?.setMode(agentMode);output(`custom agent: ${name}`)})
        return false
      }
      for(const a of customAgents)output(`${a.name}  ${a.mode}  ${a.description}`);return false
    }
    if(input==='/commands'){for(const c of customCommands)output(`/${c.name}  ${c.description}`);return false}
    if(input.startsWith('/task-log ')){for(const e of await tasks.history(input.slice(10).trim()))output(`${e.seq} ${new Date(e.ts).toISOString()} ${e.type} ${JSON.stringify(e.data).slice(0,500)}`);return false}
    if(input==='/plan'||input==='/build'||input==='/explore'){agentMode=input.slice(1);ui?.setMode(agentMode);output(`agent mode: ${agentMode}`);return false}
    if(input.startsWith('/agent ')){const m=input.slice(7).trim();if(['build','plan','explore'].includes(m)){agentMode=m;selectedCustom=undefined;ui?.setMode(agentMode);output(`agent mode: ${agentMode}`);return false}const custom=customAgents.find(a=>a.name===m);if(!custom)throw new Error(`Unknown agent: ${m}`);agentMode=m;selectedCustom=custom;ui?.setMode(agentMode);output(`custom agent: ${m}`);return false}
    if(input==='/model'){output(`${provider.model} (${provider.id}) @ ${providerCfg.baseUrl}`);return false}
    if(input==='/provider'){
      if(interactive && ui){ await ui.openProviderManager(providerManagerCallbacks as any); return false }
      const names=Object.keys(cfg.providers||{})
      const lines=[`active: ${providerCfg.provider||provider.id} · ${providerCfg.model||'unconfigured'} @ ${providerCfg.baseUrl}`]
      if(names.length) lines.push(...names.map(n=>{const profile=(cfg.providers||{})[n] as any;return `${n} :: ${profile?.model||'unconfigured'} @ ${profile?.baseUrl||''}`}))
      else lines.push('no configured provider profiles. Use /provider in an interactive terminal to add one.')
      output(lines.join('\n'));return false
    }
    const switchSession = async (child:any, messagePrefix:string) => {
      if(activeTurnPromise || processingQueue) throw new Error('Cannot switch sessions while an agent turn is active')
      editingQueuedId=undefined
      session=child
      const loaded=await store.load(child.id)
      messages=loaded.messages
      await runtimeQueue.recoverStaleExecuting(session.id)
      const latest=[...loaded.events].reverse().find((e:any)=>e.type==='todo')
      todoState.splice(0,todoState.length,...(Array.isArray(latest?.data?.items)?activeTodoItems(latest.data.items):[]))
      ui?.clearConversation(); ui?.hydrate(messages); ui?.setContextUsage(estimateMessagesTokens(messages), cfg.maxContextTokens || 12000)
      await syncQueue()
      output(`${messagePrefix} ${child.id}`)
    }
    if(input==='/fork'){const child=await store.fork(session.id,messages.length);await switchSession(child,'forked');return false}
    if(input.startsWith('/fork checkpoint ')){const checkpointId=input.slice('/fork checkpoint '.length).trim();if(!checkpointId)throw new Error('Usage: /fork checkpoint <checkpoint-id>');const child=await store.forkFromCheckpoint(session.id,checkpointId);await switchSession(child,`forked from checkpoint ${checkpointId}`);return false}
    if(input.startsWith('/fork ')){const n=Number(input.slice(6).trim());const child=await store.fork(session.id,Number.isFinite(n)?n:messages.length);await switchSession(child,'forked');return false}
    if(input.startsWith('/branch ')){
      const args=input.slice('/branch '.length).trim().split(/\s+/).filter(Boolean)
      const checkpointId=args.find(x=>!x.startsWith('--'))
      if(!checkpointId)throw new Error('Usage: /branch <checkpoint-id> [--restore]')
      const child=await store.forkFromCheckpoint(session.id,checkpointId,{restoreWorkspace:args.includes('--restore')})
      await switchSession(child,`branched from checkpoint ${checkpointId}${args.includes('--restore')?' · workspace restored':' · workspace unchanged'}`)
      return false
    }
    if(input.startsWith('/provider ')){const name=input.slice(10).trim();const p=cfg.providers?.[name];if(!p)throw new Error(`Unknown provider profile: ${name}`);providerCfg={...p,apiKey:p.apiKey||process.env[p.apiKeyEnv||'']};provider=createProvider(providerCfg);registry.add(taskTool(provider,store,registry,tasks,provider.config));registry.add(backgroundAgentTool(tasks,provider,providerCfg));registry.add(parallelAgentTool(tasks,provider,providerCfg));ui?.setModel(providerCfg.model,name);output(`provider switched to ${name}`);return false}
    if(input==='/plugins'){if(!ui) {output('plugin manager is only available in interactive mode','warn');return false} await ui.openPluginManager(pluginManagerCallbacks,'plugins'); return false}
    if(input==='/marketplace-auto-update' || input.startsWith('/marketplace-auto-update ')){
      const parts=input.slice('/marketplace-auto-update'.length).trim().split(/\s+/).filter(Boolean)
      const name=parts[0]||''
      if(!name) throw new Error('Usage: /marketplace-auto-update <name> [on|off]')
      if(parts.length===1){ output(`${name}: auto-update ${await getMarketplaceAutoUpdate(name) ? 'on' : 'off'}`); return false }
      const value=parts[1].toLowerCase()
      if(value!=='on'&&value!=='off') throw new Error('Usage: /marketplace-auto-update <name> [on|off]')
      const enabled=await setMarketplaceAutoUpdate(name,value==='on')
      output(`${name}: auto-update ${enabled ? 'on' : 'off'}`)
      return false
    }
    if(input==='/marketplace' || input.startsWith('/marketplace ')){if(!ui){output('marketplace browser is only available in interactive mode','warn');return false} const query=input.slice('/marketplace'.length).trim(); await ui.openPluginManager(pluginManagerCallbacks,'marketplaces',query); return false}
    if(input==='/skill-registry' || input.startsWith('/skill-registry ')){
      const parts=input.slice('/skill-registry'.length).trim().split(/\s+/).filter(Boolean)
      const action=parts.shift()||'list'
      if(action==='list'){
        const registries=await listSkillRegistries()
        output(registries.length ? registries.map(r=>`${r.id}  ${r.url}${r.stale?'  [stale]':''}${r.error?`  [${r.error}]`:''}`).join('\n') : 'no skill registries configured')
        return false
      }
      if(action==='add'){
        const id=parts.shift()||''; const url=parts.shift()||''; const revocationsUrl=parts.shift()
        if(!id||!url) throw new Error('Usage: /skill-registry add <id> <registry.json URL> [revocations.json URL]')
        await addSkillRegistry(id,url,revocationsUrl?{revocationsUrl}:{}); output(`skill registry added: ${id}`); return false
      }
      if(action==='remove' || action==='rm'){
        const id=parts.shift()||''; if(!id) throw new Error('Usage: /skill-registry remove <id>'); await removeSkillRegistry(id); output(`skill registry removed: ${id}`); return false
      }
      if(action==='refresh'){
        const id=parts.shift()||''; if(!id) throw new Error('Usage: /skill-registry refresh <id>')
        const result=await refreshSkillRegistry(id); output(`${id}: ${result.fromCache?'offline cache':'refreshed'}${result.stale?' [stale]':''} · ${result.document.skills.length} skills`); return false
      }
      if(action==='search'){
        const id=parts.shift()||''; const query=parts.join(' '); if(!id) throw new Error('Usage: /skill-registry search <id> [query]')
        const result=await listRegistrySkills(id,{query,allowStale:true}); output(result.skills.length ? result.skills.map(skill=>`${skill.id}@${skill.version}  ${skill.trust}  ${skill.description}`).join('\n') : 'no matching registry skills'); return false
      }
      if(action==='install'){
        const id=parts.shift()||''; const skillId=parts.shift()||''; const confirmed=parts.includes('--yes')||parts.includes('--confirm'); const allowStale=parts.includes('--allow-stale')
        if(!id||!skillId) throw new Error('Usage: /skill-registry install <registry-id> <namespace/skill> [--yes] [--allow-stale]')
        const installed=await installSkillFromRegistry(id,skillId,{confirm:confirmed,allowStale}); output(`installed pure skill ${installed.id}@${installed.version} from ${installed.registryId} (no plugin permissions granted)`); return false
      }
      if(action==='installed'){
        const installed=await listInstalledRegistrySkills(); output(installed.length ? installed.map(skill=>`${skill.id}@${skill.version}  ${skill.status}  ${skill.registryId}`).join('\n') : 'no pure registry skills installed'); return false
      }
      if(action==='remove-skill' || action==='uninstall'){
        const id=parts.shift()||''; if(!id) throw new Error('Usage: /skill-registry uninstall <namespace/skill>'); await uninstallRegistrySkill(id); output(`uninstalled pure skill: ${id}`); return false
      }
      throw new Error('Usage: /skill-registry [list|add|remove|refresh|search|install|installed|uninstall]')
    }
    if(input==='/skills' || input.startsWith('/skills ')){
      const raw=input.slice('/skills'.length).trim()
      const sub=raw.split(/\s+/)
      if(sub[0]==='install' || sub[0]==='uninstall' || sub[0]==='remove' || sub[0]==='installed' || sub[0]==='registries'){
        if(sub[0]==='registries'){
          const registries=await listSkillRegistries(); output(registries.length ? registries.map(r=>`${r.id}  ${r.url}`).join('\n') : 'no skill registries configured'); return false
        }
        if(sub[0]==='installed'){const installed=await listInstalledRegistrySkills(); output(installed.length ? installed.map(skill=>`${skill.id}@${skill.version}  ${skill.status}  ${skill.registryId}`).join('\n') : 'no pure registry skills installed'); return false}
        const skillId=sub[1]||''
        if(!skillId) throw new Error(`Usage: /skills ${sub[0]} <namespace/skill>`)
        if(sub[0]==='install'){
          const at=skillId.indexOf('/')
          if(at<=0) throw new Error('Pure registry skill ids must be namespace/name; use /skill-registry install <registry-id> <namespace/skill>')
          const registries=await listSkillRegistries()
          const registry=registries.find(r=>r.id===skillId.slice(0,at).toLowerCase())
          if(!registry) throw new Error(`No configured skill registry matches namespace '${skillId.slice(0,at)}'`)
          const installed=await installSkillFromRegistry(registry.id,skillId,{confirm:sub.includes('--yes')||sub.includes('--confirm'),allowStale:sub.includes('--allow-stale')}); output(`installed pure skill ${installed.id}@${installed.version} from ${installed.registryId} (no plugin permissions granted)`); return false
        }
        await uninstallRegistrySkill(skillId); output(`uninstalled pure skill: ${skillId}`); return false
      }
      if(!ui){const descriptors=await listSkillDescriptors(cwd);for(const skill of descriptors)output(`${skill.id}  ${skill.description}`);return false}
      await ui.openPluginManager(pluginManagerCallbacks,'skills',raw); return false
    }
    if(input==='/doctor' || input.startsWith('/doctor ')){const args=input.slice('/doctor'.length).trim().split(/\s+/).filter(Boolean);const d=await doctor(cwd);if(args.includes('--json')){output(JSON.stringify(d,null,2));return false} for(const group of ['environment','configuration','migration','marketplaces','plugins','skills','storage']){const rows=d.checks.filter(item=>item.group===group);if(!rows.length)continue;output(`\n${group.toUpperCase()}`);for(const item of rows){const mark=item.status==='ok'?'✓':item.status==='warn'?'!':'✗';output(`${mark} ${item.label}: ${item.value}${item.detail?` · ${item.detail}`:''}`);if(item.remediation)output(`  → ${item.remediation}`)}} output(`\ndoctor: ${d.counts.ok} ok · ${d.counts.warn} warnings · ${d.counts.error} errors`);return false}
    if(input==='/permissions'){output(`approvals=${cfg.approvals}`);if(cfg.permissionRules?.length)for(const r of cfg.permissionRules)output(`${r.decision} ${r.tool}${r.pattern?`  ${r.pattern}`:''}`);return false}
    if(input==='/context'){const tokens=estimateMessagesTokens(messages);const limit=cfg.maxContextTokens||12000;output(`context: ${tokens}/${limit} tokens (${limit?Math.round(tokens/limit*100):0}%)\nmessages: ${messages.length}\ntool messages: ${messages.filter((m:any)=>m.role==='tool').length}\nremaining: ${Math.max(0,limit-tokens)}`);return false}
    if(input==='/thinking'){if(ui) ui.openReasoningView(); else output('reasoning inspection is only available in interactive mode');return false}
    if(input==='/repomap'||input.startsWith('/repomap ')){const parts=input.slice(8).trim().split(/\s+/).filter(Boolean);let tokens=Number(cfg.repoMapTokens||2048);const focusFiles:string[]=[];const focusSymbols:string[]=[];let stats=false;let invalidate=false;for(let i=0;i<parts.length;i++){const part=parts[i];if(part==='--tokens')tokens=Number(parts[++i]||tokens);else if(part==='--focus')focusFiles.push(parts[++i]||'');else if(part==='--focus-symbols')focusSymbols.push(parts[++i]||'');else if(part==='--stats')stats=true;else if(part==='--invalidate')invalidate=true}if(invalidate)await invalidateRepositoryCache(cwd);repositoryMap=await buildRepositoryMap(cwd);output(formatRepositoryMap(repositoryMap,180,Math.max(256,Math.min(tokens||2048,8192)),{focusFiles,focusSymbols}));if(stats)output(`cache: ${repositoryMap.cache.hit} reused, ${repositoryMap.cache.miss} parsed\nfiles: ${repositoryMap.files.length}\nsymbols: ${repositoryMap.files.reduce((n,f)=>n+f.symbols.length,0)}\nedges: ${repositoryMap.edges.length}`);return false}
    if(input==='/undo'){const result=await store.undo(session.id,cwd);messages=result.messages;ui?.clearConversation();ui?.hydrate(messages);output(`undid turn ${result.turn.id}`);return false}
    if(input==='/redo'){const result=await store.redo(session.id,cwd);messages=result.messages;ui?.clearConversation();ui?.hydrate(messages);output(`redid turn ${result.turn.id}`);return false}
    if(input==='/sessions'){const sessions=await store.list();if(interactive){if(!sessions.length){output('no saved sessions','warn');return false}editor.openCommandPalette(sessions.map((s:any)=>`/resume ${s.id} · ${s.model} · ${s.cwd}`), async(value)=>{const id=String(value).match(/^\/resume\s+(\S+)/)?.[1];if(id)await resumeSession(id)});return false}for(const s of sessions)output(`${s.id}  ${s.model}  ${s.cwd}`);return false}
    if(input==='/checkpoints'){
      const checkpoints=await store.listCheckpoints(session.id)
      if(!checkpoints.length){output('no checkpoints','warn');return false}
      for(const c of checkpoints) output(`${c.id}  ${new Date(c.ts).toISOString()}  ${c.messageCount} messages  ${c.label||'manual'}${c.snapshotId?'  · snapshot '+String(c.snapshotId).slice(0,12):''}`)
      return false
    }
    if(input==='/tasks'){
      const taskList=await tasks.list()
      if(interactive && taskList.length){
        editor.openCommandPalette(taskList.map(t=>`${t.id} :: ${t.status} · ${String(t.command||t.prompt||'').replace(/\s+/g,' ').slice(0,120)}`), async(value)=>{const id=String(value).split(' :: ',1)[0];const task=await tasks.get(id);output(formatTaskDetail(task));const history=await tasks.history(id);if(history.length)output(`events: ${history.length} · latest: ${history.at(-1)?.type||'unknown'}`)})
        return false
      }
      output(formatTaskList(taskList));return false
    }
    if(input.startsWith('/tasks ')){const task=await tasks.get(input.slice(7).trim());output(formatTaskDetail(task));if(task.output)output(`\n${task.output}`);return false}
    if(input.startsWith('/cancel ')){output((await tasks.cancel(input.slice(8).trim())).status);return false}
    if(input==='/diff'){const diff=await renderGitDiff(cwd,{color:false,maxBytes:cfg.maxOutputBytes});if(ui){ui.openWorkingTreeDiff(diff,'Working tree')}else{output(diff.text);if(diff.files.length)output(`\n${diff.files.map(f=>`${f.path}  +${f.additions} -${f.deletions}${f.binary?' · binary':''}`).join('\n')}`)}return false}
    if(input==='/clear'){messages=[];ui?.clearConversation();output('conversation cleared for this session');return false}
    if(input==='/skill' || input.startsWith('/skill ')){
      const parts=input.slice(6).trim().split(/\s+/);
      const skillId=parts.shift()||'';
      if(!skillId) throw new Error('Usage: /skill <skill-id> [task arguments]')
      let loaded
      try {
        loaded=await loadSkill(cwd,skillId,{requireUserInvocable:true})
      } catch(e) {
        await store.append(session.id,{type:'skill.skip',ts:Date.now(),data:{action:'skip',id:skillId.replace(/^\//,''),source:'slash',reason:e instanceof Error?e.message:String(e)}} as any)
        throw e
      }
      await store.append(session.id,{type:'skill.load',ts:Date.now(),data:{action:'load',id:loaded.descriptor.id,source:'slash',sha256:loaded.sha256}} as any)
      const task=parts.join(' ').trim() || `Apply skill ${loaded.descriptor.id} to the current task and project.`
      clearCompletedTodoState();
      ui?.setStatus('working…');
      await providerRun(selectRequestProvider(selectedCustom),registry,store,session,messages,cwd,instructions,formatRepositoryMap(repositoryMap,100,cfg.repoMapTokens||2600),task,cfg,'(automatic skill discovery suppressed for explicit skill invocation)',false,agentMode,selectedCustom,ui,requestQuestion,{id:loaded.descriptor.id,content:loaded.content,sha256:loaded.sha256},undefined,hookManager);
      repositoryMap=await buildRepositoryMap(cwd);
      return false
    }
    if(input==='/compact'){const c=compactMessages(messages,cfg.maxContextTokens||12000,{maxOutputTokens:provider.config?.maxTokens||0,threshold:cfg.compactionThreshold,reserveTokens:cfg.contextReserveTokens,recentTokens:cfg.contextRecentTokens});messages.splice(0,messages.length,...c.messages);if(c.removed){const loaded=await store.load(session.id);const prior=await store.latestContextCheckpoint(session.id);const activeTurn=[...loaded.events].reverse().find((e:any)=>e.type==='turn'&&e.data?.status==='committed')?.data;const epoch=Number(prior?.epoch||0)+1;const summaryRevision=Number(prior?.summaryRevision||0)+1;const id=crypto.randomBytes(8).toString('hex');const machine={...(prior?.machineState||{}),version:1,sessionId:session.id,turnId:activeTurn?.id,epoch,checkpointId:id,sourceEventCount:loaded.events.length,projectionHash:projectionHash(messages),summaryRevision,createdAt:Date.now()};await store.append(session.id,{type:'compaction',ts:Date.now(),data:{removed:c.removed,tokens:c.budget.usableTokens,summary:c.summary,budget:c.budget,manual:true,stage:'full-compaction',epoch,summaryRevision}});await store.saveContextCheckpoint(session.id,{version:1,id,sessionId:session.id,turnId:activeTurn?.id,epoch,sourceEventCount:loaded.events.length,projectionHash:machine.projectionHash,summaryRevision,summary:c.summary,messages:messages.filter(m=>m.role!=='system'),machineState:machine,stage:'full-compaction',createdAt:Date.now()});}output(c.removed?`context compacted (${c.removed} messages removed from active context)`:'context already within budget');return false}
    if(input==='/checkpoint'){const cp=await store.checkpoint(session.id,messages,{agent:agentMode,provider:provider.id,model:provider.model});output(`checkpoint saved: ${cp.id}`);return false}
    if(input.startsWith('/resume ')){await resumeSession(input.slice(8).trim());return false}
    if(input.startsWith('/restore ')){const parts=input.slice(9).trim().split(/\s+/);const checkpointId=parts[0];if(!checkpointId)throw new Error('Usage: /restore <checkpoint-id>');const restored=await store.restoreCheckpoint(session.id,checkpointId);messages=restored.messages;ui?.clearConversation();ui?.hydrate(messages);output(`restored checkpoint ${restored.checkpoint.id} · workspace restored`);return false}
    if(input.startsWith('/') && !input.startsWith('/auto ')){
      const parts=input.slice(1).split(/\s+/); const cmd=customCommands.find(c=>c.name===parts[0])
      if(cmd){clearCompletedTodoState();ui?.setStatus('working…');const rendered=await interpolateCommandTemplate(cmd.template,parts.slice(1),cwd,cfg.maxOutputBytes||12000);const agentName=cmd.agent||agentMode;const custom=customAgents.find(a=>a.name===agentName);const prompt=custom?`${custom.prompt}\n\nUSER COMMAND:\n${rendered}`:rendered;const mode=custom?.mode==='subagent'?'build':(['build','plan','explore'].includes(agentName)?agentName:'build');await providerRun(cmd.model ? (resolveProviderTarget(cfg,cmd.model) || selectRequestProvider(custom)) : selectRequestProvider(custom),registry,store,session,messages,cwd,instructions,formatRepositoryMap(repositoryMap,100,cfg.repoMapTokens||2600),prompt,cfg,'(automatic skill discovery is performed by the agent)',false,mode,custom,ui,requestQuestion,undefined,cmd.allowedTools,hookManager);repositoryMap=await buildRepositoryMap(cwd);return false}
    }
    if(input.startsWith('/auto ')){const taskPrompt=input.slice(6).trim();clearCompletedTodoState();ui?.setStatus('working…');const repositoryOverview=formatRepositoryMap(repositoryMap,100,cfg.repoMapTokens||2600);const retrieved=await retrieveContext(repositoryMap,taskPrompt,{maxFiles:6,maxBytes:cfg.maxContextBytes||36000,maxTokens:Math.floor((cfg.maxContextBytes||36000)/4)});const selected=[];await providerRun(provider,registry,store,session,messages,cwd,instructions,`${repositoryOverview}\n\n${retrieved}`,taskPrompt,cfg,'(automatic skill discovery is performed by the agent)',true,'build',undefined,ui,requestQuestion,undefined,undefined,hookManager);repositoryMap=await buildRepositoryMap(cwd);return false}
    clearCompletedTodoState()
    ui?.setStatus('working…');const repositoryOverview=formatRepositoryMap(repositoryMap,100,cfg.repoMapTokens||2600);const retrieved=await retrieveContext(repositoryMap,input,{maxFiles:6,maxBytes:cfg.maxContextBytes||36000,maxTokens:Math.floor((cfg.maxContextBytes||36000)/4)});const selected=[];await providerRun(selectRequestProvider(selectedCustom),registry,store,session,messages,cwd,instructions,`${repositoryOverview}\n\n${retrieved}`,input,cfg,'(automatic skill discovery is performed by the agent)',false,agentMode,selectedCustom,ui,requestQuestion,undefined,undefined,hookManager);repositoryMap=await buildRepositoryMap(cwd);return false
   } catch(e){showError(e);ui?.clearStatus();return false}
 }

 const drainPromptQueue=async()=>{
   if(processingQueue || activeTurnPromise)return
   processingQueue=true
   try{
     while(true){
       const next=await runtimeQueue.claimNext(session.id)
       if(!next)break
       await syncQueue()
       output(`running queued prompt: ${next.content.replace(/\s+/g,' ').slice(0,100)}`)
       const run=handleInput(next.content,true)
       activeTurnPromise=run
       let exit=false
       try{ exit=await run }catch(error){ await runtimeQueue.fail(session.id,next.id,error); await syncQueue(); throw error }finally{ if(activeTurnPromise===run)activeTurnPromise=null }
       if(exit){ await runtimeQueue.fail(session.id,next.id,'session exit requested'); await syncQueue(); break }
       await runtimeQueue.complete(session.id,next.id)
       await syncQueue()
     }
   }finally{processingQueue=false;await syncQueue()}
 }

 handleQueueAction=async(action,id)=>{
   try{
     const items=await runtimeQueue.list(session.id)
     const item=items.find(value=>value.id===id)
     if(!item) return
     if(action==='edit'){ editingQueuedId=item.id; editor.setValue(item.content); ui?.setStatus('editing queued prompt · Enter saves changes'); return }
     if(action==='cancel'){ await runtimeQueue.cancel(session.id,id) }
     else if(action==='up'){ await runtimeQueue.move(session.id,id,-1) }
     else if(action==='down'){ await runtimeQueue.move(session.id,id,1) }
     await syncQueue()
   }catch(error){showError(error)}
 }

 dispatchInteractiveInput=async(value)=>{
   const trimmed=value.trim()
   const command=trimmed.startsWith('/') ? commandName(trimmed) : ''
   if(activeTurnPromise && command && blockedWhileTurn.has(command)){
     output(`/${command} is unavailable while the current turn is running`,'warn')
     return false
   }
   if(editingQueuedId && !trimmed.startsWith('/queue ')){
     return await handleInput(value)
   }
   if(isTurnInput(value)){
     if(activeTurnPromise || processingQueue){
       const queued=await runtimeQueue.enqueue(session.id,value,{sourceClient:'terminal'})
       editor.setValue('')
       await syncQueue()
       output(`queued prompt ${queued.position+1}`)
       return false
     }
     const run=handleInput(value)
     activeTurnPromise=run
     void run.catch(error=>showError(error)).finally(()=>{
       if(activeTurnPromise===run)activeTurnPromise=null
       void drainPromptQueue()
     })
     return false
   }
   return await handleInput(value)
 }
 if(interactive){
   while(true){
     const result=await editor.read()
     if(result.type==='exit') break
     if(result.type==='cancel') continue
     const shouldExit=await dispatchInteractiveInput(result.value)
     if(shouldExit) break
   }
 } else {
   const lineReader=readline.createInterface({input:process.stdin,output:process.stdout})
   for await(const line of lineReader){
     const shouldExit=await handleInput(String(line))
     if(shouldExit) break
   }
   lineReader.close()
 }
 await Promise.all(mcp.clients.map(c=>c.close()))
 ui?.leave(session.id)
}

async function providerRun(provider:any,registry:any,store:any,session:any,messages:any[],cwd:string,instructions:string,repositoryContext:string,input:string,cfg:any,skillsContext='(none loaded)',autonomous=false,mode='build',customAgent?:any,ui?:TerminalUI|null,onQuestion?:(questions:any[],signal?:AbortSignal)=>Promise<string[][]|import('../tools/types.js').QuestionResponse>,explicitSkill?:{id:string;content:string;sha256:string},allowedTools?:string[],hookManager?:PluginHookManager){
 const skillDescriptors=await listSkillDescriptors(cwd); const agent=new Agent(provider,registry,store,cfg.maxToolRounds,cfg.maxContextTokens||12000,cfg.retryMax||4,(s:string)=>{if(ui){if(/^retry\b/i.test(s))ui.setActivity('retrying',s);else if(/^compacted context/i.test(s))ui.setActivity('compacting',s);else ui.setStatus(s)}else console.log(`\n[${s}]`)},skillDescriptors,{threshold:cfg.compactionThreshold,reserveTokens:cfg.contextReserveTokens,recentTokens:cfg.contextRecentTokens},hookManager,{maxLines:cfg.toolOutputMaxLines,maxBytes:cfg.toolOutputMaxBytes,retentionDays:cfg.toolOutputRetentionDays},cfg.postEditVerification);
 if(messages.length>cfg.maxContextMessages){messages.splice(1,messages.length-cfg.maxContextMessages);messages.unshift({role:'system',content:`Previous context was trimmed. Current working directory: ${cwd}. Preserve the active task and verify facts with tools.`})}
 if(autonomous) await store.checkpoint(session.id,messages,{label:'auto-start',agent:mode,provider:provider.id,model:provider.model})
 ui?.startAssistant()
 ui?.setStatus('thinking…')
 const controller=new AbortController()
 const interactive=Boolean(process.stdin.isTTY&&process.stdout.isTTY)
 if(interactive && ui){
   ui.beginAgentTurn(controller)
 } else if(interactive){
   process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.setEncoding('utf8')
 }
 try {
   let explorationSnapshot:any
   let explorationTelemetry:any
   const publishExploration=()=>ui?.setExploration(explorationSnapshot,explorationTelemetry)
   await agent.run({sessionId:session.id,messages,cwd,instructions,repositoryContext,skillsContext,prompt:input,onReasoning:(s:string)=>{ui?.appendReasoning(s)},onText:(s:string)=>{ui?.appendAssistant(s);if(!ui)process.stdout.write(s)},onTool:(n:string,a:any)=>{ui?.startTool(n,a);if(!ui)toolStart(n,a)},onToolResult:(n:string,o:string,m:any)=>{ui?.endTool(n,o,m);if(!ui)toolEnd(n,o)},onQuestion,onTodo:(items:any[])=>ui?.setTodos(items),onUsage:(usage:any)=>{ui?.setContextUsage(usage.totalTokens,cfg.maxContextTokens||12000)},onExplorationState:(snapshot:any)=>{explorationSnapshot=snapshot;publishExploration()},onExplorationTelemetry:(snapshot:any)=>{explorationTelemetry=snapshot;publishExploration()},autonomous,mode,customAgent,signal:controller.signal,skillDiscoverySuppressed:Boolean(explicitSkill),explicitSkill}  as any)
   ui?.clearStatus()
 } catch(e){
   if(controller.signal.aborted){ ui?.system('interrupted','warn'); return }
   throw e
 } finally {
   if(interactive && ui){
     ui.endAgentTurn()
   } else if(interactive){
     process.stdin.setRawMode?.(false); process.stdin.pause?.()
   }
 }
}

function pathBasename(cwd:string){ return cwd.split(/[\\/]/).filter(Boolean).pop() || cwd }
