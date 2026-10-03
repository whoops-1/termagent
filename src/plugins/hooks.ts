import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { resolvePluginComponentPath } from './manifest.js'
import { assertRealpathWithin } from './security.js'
import type { PermissionGate } from '../tools/permissions.js'
import type { ToolDefinition } from '../tools/types.js'

export type PluginHookEvent = 'SessionStart'|'SessionEnd'|'UserPromptSubmit'|'PreToolUse'|'PostToolUse'|'PostToolUseFailure'|'Stop'|'PermissionDenied'|'SubagentStart'|'SubagentStop'|'FileChanged'
export type PluginHookSpec = {type:'command';command:string;matcher?:string;timeout?:number;async?:boolean;once?:boolean;statusMessage?:string;pluginId:string;pluginRoot:string;pluginName:string}
export type PluginHooks = Partial<Record<PluginHookEvent, PluginHookSpec[]>>
export type HookContext = {event:PluginHookEvent;toolName?:string;toolArgs?:unknown;toolOutput?:string;error?:string;prompt?:string;filePath?:string;cwd:string;sessionID:string}

const EVENTS: PluginHookEvent[]=['SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','PermissionDenied','SubagentStart','SubagentStop','FileChanged']

function glob(pattern:string,value:string){const escaped=pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');try{return new RegExp(`^${escaped}$`,'i').test(value)}catch{return false}}
function matches(spec:PluginHookSpec, ctx:HookContext){const value=ctx.event==='FileChanged' ? (ctx.filePath || ctx.toolName || ctx.event) : (ctx.toolName || ctx.event); return !spec.matcher || glob(spec.matcher,value)}

export async function loadPluginHooks(root:string, manifest:any, pluginId:string):Promise<PluginHooks>{
  const pluginName=pluginId.split('@')[0] || pluginId
  const out:PluginHooks={}
  const add=(event:string,value:any)=>{
    if(!EVENTS.includes(event as PluginHookEvent) || !Array.isArray(value)) return
    const list=value.flatMap((m:any)=>Array.isArray(m?.hooks)?m.hooks.map((h:any)=>({h,m})):[])
    for(const {h,m} of list){
      if(h?.type!=='command' || typeof h.command!=='string' || !h.command.trim()) continue
      ;(out[event as PluginHookEvent] ||= []).push({type:'command',command:h.command,matcher:m.matcher,timeout:Math.max(1,Number(h.timeout||30)),async:Boolean(h.async),once:Boolean(h.once),statusMessage:typeof h.statusMessage==='string'?h.statusMessage:undefined,pluginId,pluginRoot:root,pluginName})
    }
  }
  const standard=path.join(root,'hooks','hooks.json')
  if(await fs.stat(standard).then((s: any)=>s.isFile()).catch(()=>false)){
    try{const safeStandard=await assertRealpathWithin(root,standard,'plugin hook definition');const parsed=JSON.parse(await fs.readFile(safeStandard,'utf8'));for(const [event,value] of Object.entries(parsed.hooks||{}))add(event,value)}catch{}
  }
  if(manifest?.hooks){
    const specs=Array.isArray(manifest.hooks)?manifest.hooks:[manifest.hooks]
    for(const spec of specs){
      try{
        const value=typeof spec==='string'?JSON.parse(await fs.readFile(await assertRealpathWithin(root,resolvePluginComponentPath(root,spec),'plugin hook definition'),'utf8')):spec
        for(const [event,v] of Object.entries(value.hooks||value))add(event,v)
      }catch{}
    }
  }
  return out
}

async function executeOne(spec:PluginHookSpec,ctx:HookContext,gate:PermissionGate,onStatus?: (status:string)=>void):Promise<void>{
  const command=spec.command.replaceAll('$ARGUMENTS',JSON.stringify(ctx))
  const tool:ToolDefinition={name:`plugin_hook_${spec.pluginName}_${ctx.event}`,risk:'shell',description:`Plugin hook ${spec.pluginName}:${ctx.event}`,schema:{type:'object'},execute:async()=>({output:''})}
  await gate.check(tool,{event:ctx.event,command},new AbortController().signal)
  if(spec.statusMessage) onStatus?.(spec.statusMessage)
  await new Promise<void>((resolve,reject)=>{
    const child=spawn('sh',['-c',command],{cwd:spec.pluginRoot,env:{...process.env,CLAUDE_PLUGIN_ROOT:spec.pluginRoot,TERMAGENT_PLUGIN_ROOT:spec.pluginRoot,TERMAGENT_PLUGIN_ID:spec.pluginId,TERMAGENT_HOOK_EVENT:ctx.event},stdio:['pipe','pipe','pipe']})
    let err=''; child.stderr.on('data',(b:any)=>{err+=b.toString().slice(0,8000)})
    child.stdin.end(JSON.stringify(ctx)+'\n')
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error(`plugin hook timed out after ${spec.timeout}s`))},Math.round((spec.timeout||30)*1000))
    child.on('error',(e: Error)=>{clearTimeout(timer);reject(e)})
    child.on('close',(code: number|null)=>{clearTimeout(timer); if(code===0)resolve(); else reject(new Error(`plugin hook exited with ${code}${err?`: ${err.trim()}`:''}`))})
  })
}

export class PluginHookManager {
  private hooks: PluginHooks
  private onceUsed=new Set<string>()
  constructor(hooks:PluginHooks,private gate:PermissionGate,private onStatus?: (s:string)=>void){this.hooks=hooks}
  async emit(ctx:HookContext):Promise<void>{
    const specs=this.hooks[ctx.event] || []
    for(const [index,spec] of specs.entries()){
      if(!matches(spec,ctx)) continue
      const key=`${spec.pluginId}:${ctx.event}:${index}`
      if(spec.once && this.onceUsed.has(key)) continue
      if(spec.once)this.onceUsed.add(key)
      if(spec.async){void executeOne(spec,ctx,this.gate,this.onStatus).catch(e=>this.onStatus?.(`plugin hook error: ${e instanceof Error?e.message:String(e)}`));continue}
      await executeOne(spec,ctx,this.gate,this.onStatus)
    }
  }
}
