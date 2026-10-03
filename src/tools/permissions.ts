import readline from 'node:readline/promises'
import process from 'node:process'
import path from 'node:path'
import type { ToolContext, ToolDefinition, PermissionAction, ToolPermissionRequest } from './types.js'
import type { ApprovalMode, PermissionRule, PermissionDecision } from '../config/config.js'
import { within } from '../util/fs.js'
import crypto from 'node:crypto'
import { canonicalJson } from '../util/canonical.js'
import type { SessionStore } from '../session/store.js'

export type PermissionChoice = 'once' | 'always' | 'deny'

export type PermissionRequest = {
  requestId: string
  sessionId: string
  tool: ToolDefinition
  args: any
  signal?: AbortSignal
  action?: PermissionAction
  resources?: string[]
  save?: string[]
}

export type PermissionRequester = (request: PermissionRequest) => Promise<PermissionChoice>

function globMatches(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  try { return new RegExp(`^${escaped}$`, 'i').test(value) } catch { return false }
}

export function defaultPermissionAction(name:string,risk:ToolDefinition['risk']):PermissionAction {
  const lower=name.toLowerCase()
  if(lower==='skill'||lower==='use_skill'||lower==='search_skills') return 'skill'
  if(lower==='task'||lower.startsWith('task_')||lower.includes('agent')||lower.startsWith('parallel_')||lower==='background') return 'task'
  if(risk==='shell') return 'shell'
  if(risk==='write') return 'edit'
  return 'read'
}

function extractPathResources(args:any):string[] {
  const keys=new Set(['path','paths','file_path','filePath','directory','dir','scope_paths','scopePaths','workspace','root'])
  const found:string[]=[]
  const walk=(value:any,depth:number)=>{
    if(depth>5||value===null||value===undefined)return
    if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return}
    if(typeof value!=='object')return
    for(const [key,item] of Object.entries(value)){
      if(keys.has(key)){
        if(typeof item==='string'&&item.trim())found.push(item.trim())
        else if(Array.isArray(item))for(const entry of item)if(typeof entry==='string'&&entry.trim())found.push(entry.trim())
      } else if(typeof item==='object')walk(item,depth+1)
    }
  }
  walk(args,0)
  return [...new Set(found)]
}

function extractResources(action:PermissionAction,args:any):string[] {
  if(action==='shell')return typeof args?.command==='string'?[args.command]:[]
  if(action==='skill')return [typeof args?.name==='string'?args.name:'*']
  if(action==='task')return [typeof args?.task_id==='string'?args.task_id:'*']
  return extractPathResources(args)
}

function outsideWorkspace(cwd:string,resource:string,scopePaths?:string[]):boolean {
  if(!resource || typeof resource!=='string')return false
  if(/^https?:\/\//i.test(resource))return false
  const target=resource.startsWith('~') ? path.resolve(process.env.HOME||cwd,resource.slice(2)) : path.resolve(cwd,resource)
  if(!within(cwd,target))return true
  if(scopePaths?.length && !scopePaths.some(scope=>within(path.resolve(cwd,scope),target)))return true
  return false
}

export function permissionRequests(tool:ToolDefinition,args:any,ctx:ToolContext):ToolPermissionRequest[] {
  const declared=tool.permission
  if(declared?.requests)return declared.requests(args,ctx)
  const action=declared?.action ?? defaultPermissionAction(tool.name,tool.risk)
  const resources=declared?.resources ? declared.resources(args,ctx) : extractResources(action,args)
  const requests:ToolPermissionRequest[]=[{action,resources,save:['*']}]
  if(declared?.externalDirectory){
    const outside=extractPathResources(args).filter(resource=>outsideWorkspace(ctx.cwd,resource,ctx.scopePaths))
    if(outside.length)requests.push({action:'external_directory',resources:[...new Set(outside)],save:['*'],force:true})
  }
  return requests
}

function permissionRequestId(sessionId:string,toolCallId:string|undefined,tool:ToolDefinition,args:any,action:PermissionAction,resources:string[]):string {
  const seed=canonicalJson({sessionId,toolCallId:toolCallId||'runtime',tool:tool.name,args,action,resources:[...resources].sort()})
  return `perm_${crypto.createHash('sha256').update(seed).digest('hex').slice(0,24)}`
}

export class PermissionGate {
  private approved = new Set<string>()
  private requester?: PermissionRequester

  constructor(private mode: ApprovalMode, private input = process.stdin, private output = process.stdout, private rules: PermissionRule[] = [], private store?: SessionStore) {}

  private ruleFor(tool: ToolDefinition, args: any, action:PermissionAction, resource?:string): PermissionRule | undefined {
    const text = JSON.stringify(args ?? {})
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i]!
      if (!globMatches(rule.tool, tool.name) && !globMatches(rule.tool, action)) continue
      if (rule.pattern) {
        const candidates=[resource,text].filter((value):value is string=>typeof value==='string')
        if (!candidates.some(value=>globMatches(rule.pattern!,value))) continue
      }
      return rule
    }
    return undefined
  }

  setRequester(requester: PermissionRequester | undefined) { this.requester=requester }
  modeValue(): ApprovalMode { return this.mode }
  rulesSnapshot(): PermissionRule[] { return this.rules.map(rule => ({ ...rule })) }

  isStaticallyDenied(tool:ToolDefinition, _ctx?:ToolContext):boolean {
    const action=tool.permission?.action ?? defaultPermissionAction(tool.name,tool.risk)
    const rule=this.ruleFor(tool,{},action,tool.name)
    if(rule?.decision==='deny' && !rule.pattern)return true
    return false
  }

  approvedToolsSnapshot(): string[] { return [...new Set([...this.approved].map(item => item.split('|',1)[0]).filter(Boolean))] }

  deriveChildPolicy(tools: ToolDefinition[]): { mode: ApprovalMode; rules: PermissionRule[]; allowedTools: string[] } {
    const denied = new Set(['task','todo','background_agent','parallel_agents','background','task_cancel','task_status','task_output'])
    const rules = this.rulesSnapshot()
    const allowed = tools.filter(tool => {
      if (denied.has(tool.name)) return false
      if (this.isStaticallyDenied(tool)) return false
      const toolRule = [...this.rules].reverse().find(rule => globMatches(rule.tool, tool.name))
      if (toolRule?.decision === 'deny') return false
      if (tool.risk === 'read') return true
      if (this.mode === 'deny') return false
      if (this.mode === 'auto') return true
      if (toolRule?.decision === 'allow') return true
      if ([...this.approved].some(item=>item===tool.name || item.startsWith(`${tool.name}|`))) return true
      return false
    }).map(tool => tool.name)
    return { mode: this.mode, rules, allowedTools: allowed }
  }

  async check(tool: ToolDefinition, args: any, signal?: AbortSignal, ctx?:ToolContext) {
    const context=ctx||({cwd:process.cwd(),sessionID:'',agent:'',abort:signal||new AbortController().signal} as ToolContext)
    const requests=permissionRequests(tool,args,context)
    for(const request of requests){
      const action=request.action
      const resources=request.resources?.length?[...new Set(request.resources)]:['*']
      const pending:string[]=[]
      const pendingKeys=new Map<string,string>()
      for(const resource of resources){
        const rule=this.ruleFor(tool,args,action,resource)
        const decision: PermissionDecision | undefined = rule?.decision
        if(decision==='deny')throw new Error(`Permission denied by rule for ${tool.name} (${action}${resource&&resource!=='*'?` ${resource}`:''})`)
        if(decision==='allow')continue
        const forcedAsk=Boolean(request.force)||action==='external_directory'||decision==='ask'
        if(!forcedAsk && (tool.risk==='read'||action==='read'||this.mode==='auto'))continue
        if(!forcedAsk && this.mode==='deny')throw new Error(`Permission denied for ${tool.name}`)
        const approvedKey=`${tool.name}|${action}|${resource}|${rule?.tool||'*'}|${rule?.pattern||'*'}`
        if(this.approved.has(approvedKey)||this.approved.has(`${tool.name}|${action}|*|*|*`))continue
        pending.push(resource)
        pendingKeys.set(resource,approvedKey)
      }
      if(pending.length===0)continue
      if(signal?.aborted)throw new Error(`Permission cancelled for ${tool.name}`)
      const requestId=permissionRequestId(context.sessionID,context.toolCallId,tool,args,action,pending)
      await this.store?.appendPermissionAsked(context.sessionID,{requestId,sessionID:context.sessionID,tool:tool.name,action,resources:pending})
      let choice=this.requester
        ? await this.requester({requestId,sessionId:context.sessionID,tool,args,signal,action,resources:pending,save:request.save})
        : await this.askLegacy(tool,args,action,pending)
      if(choice!=='once'&&choice!=='always') {
        if(this.store){
          await this.store.resolvePermission(context.sessionID,requestId,{commandId:`permission:${requestId}`,clientId:'runtime',decision:'deny'})
        } else throw new Error(`Permission denied for ${tool.name}`)
        throw new Error(`Permission denied for ${tool.name}`)
      }
      if(this.store){
        const resolution=await this.store.resolvePermission(context.sessionID,requestId,{commandId:`permission:${requestId}`,clientId:'runtime',decision:choice})
        if(resolution.applied===false && resolution.request.kind==='permission'){
          if(resolution.request.resolution?.decision==='deny')throw new Error(`Permission denied for ${tool.name}`)
          if(resolution.request.resolution?.decision==='always')choice='always'
        }
      }
      if(choice==='always'){
        for(const resource of pending){ const key=pendingKeys.get(resource); if(key)this.approved.add(key) }
        this.approved.add(`${tool.name}|${action}|*|*|*`)
      }
    }
  }

  private async askLegacy(tool:ToolDefinition,args:any,action:PermissionAction,resources?:string[]):Promise<PermissionChoice>{
    const rl=readline.createInterface({input:this.input,output:this.output})
    try{
      const list=(resources||[]).filter(item=>item && item!=='*')
      const target=list.length?` ${list.join(', ')}`:''
      const answer=(await rl.question(`\nAllow ${action}${target} via ${tool.name} with ${JSON.stringify(args)}? [y]es/[a]lways/[n]o: `)).trim().toLowerCase()
      if(answer==='a'||answer==='always')return'always'
      if(answer==='y'||answer==='yes')return'once'
      return'deny'
    } finally { rl.close() }
  }
}
