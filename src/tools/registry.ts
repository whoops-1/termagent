import { boundToolSchemas, type BoundToolSchemas } from '../context/budget.js'
import type { ToolContext, ToolDefinition, ToolKind, ToolPermissionRequest } from './types.js'
import { PermissionGate, defaultPermissionAction } from './permissions.js'
import { validateToolInput, validateToolOutput } from './schema.js'

export type ToolSchema = {
  type:'function'
  function:{name:string;description:string;parameters:Record<string,any>}
}

export type ToolSelectionOptions = {
  context?:ToolContext
  mode?:string
  autonomous?:boolean
  workflowPhase?:string
  allowedTools?:ReadonlySet<string>
  disallowedTools?:ReadonlySet<string>
  allowWrite?:boolean
  allowShell?:boolean
  budgetTokens?:number
  extraSchemas?:ToolSchema[]
  workflowAllowed?: (tool:ToolDefinition)=>boolean
}

export type ToolRegistration = {
  readonly name:string
  readonly tool:ToolDefinition
  readonly close:()=>boolean
}

export function normalizeToolDefinition(tool:ToolDefinition):ToolDefinition {
  const provenance = tool.provenance
  const inferredKind:ToolKind = tool.kind ?? (provenance?.kind === 'plugin' ? 'plugin' : provenance?.kind === 'mcp' ? 'mcp' : provenance?.kind === 'provider-hosted' ? 'provider-hosted' : provenance?.kind === 'declarative' ? 'declarative' : 'local')
  const readOnly = tool.readOnly ?? tool.risk === 'read'
  const concurrency = tool.concurrency ?? (tool.parallelSafe || readOnly ? 'safe' : 'unsafe')
  const inputSchema = tool.inputSchema ?? tool.schema
  const parallelSafe = tool.parallelSafe ?? concurrency === 'safe'
  const normalized:ToolDefinition={
    ...tool,
    schema:inputSchema,
    inputSchema,
    readOnly,
    concurrency,
    parallelSafe,
    kind:inferredKind,
    provenance: provenance ?? (inferredKind === 'local' ? {kind:'builtin'} : undefined),
    permission: tool.permission ?? {action: defaultPermissionAction(tool.name,tool.risk)},
  }
  return normalized
}

export class ToolRegistry {
  readonly gate: PermissionGate
  private registrations = new Map<string,Array<{token:symbol;tool:ToolDefinition}>>()
  private schemaCache:ToolSchema[]|null = null
  private revision = 0

  constructor(gate:PermissionGate) { this.gate = gate }

  add(tool:ToolDefinition) {
    this.register(tool)
    return this
  }

  register(tool:ToolDefinition):ToolRegistration {
    const normalized=normalizeToolDefinition(tool)
    if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(normalized.name)) throw new Error(`Invalid tool name: ${normalized.name}`)
    const token=Symbol(normalized.name)
    const entries=this.registrations.get(normalized.name)??[]
    entries.push({token,tool:normalized})
    this.registrations.set(normalized.name,entries)
    this.invalidateSchemas()
    let closed=false
    return {name:normalized.name,tool:normalized,close:()=>{
      if(closed)return false
      closed=true
      const current=this.registrations.get(normalized.name)??[]
      const next=current.filter(item=>item.token!==token)
      if(next.length) this.registrations.set(normalized.name,next); else this.registrations.delete(normalized.name)
      if(next.length!==current.length) this.invalidateSchemas()
      return next.length!==current.length
    }}
  }

  remove(name:string, tool?:ToolDefinition):boolean {
    const current=this.registrations.get(name)
    if(!current?.length)return false
    let index=current.length-1
    if(tool){ index=-1; for(let i=current.length-1;i>=0;i--){ if(current[i]!.tool===tool){ index=i; break } } }
    if(index<0)return false
    current.splice(index,1)
    if(current.length)this.registrations.set(name,current); else this.registrations.delete(name)
    this.invalidateSchemas()
    return true
  }

  get(name:string) { return this.registrations.get(name)?.at(-1)?.tool }
  list() { return [...this.registrations.values()].map(items=>items.at(-1)!.tool) }

  private invalidateSchemas(){ this.schemaCache=null; this.revision++ }

  revisionToken(){ return this.revision }

  private renderSchemas():ToolSchema[] {
    return this.list().map(t=>({type:'function' as const,function:{name:t.name,description:t.description,parameters:t.inputSchema||t.schema}}))
  }

  schemas() {
    if(!this.schemaCache)this.schemaCache=this.renderSchemas()
    return this.schemaCache
  }

  selectSchemas(options:ToolSelectionOptions={}):BoundToolSchemas {
    const ctx=options.context
    const definitions=this.list()
    const base:ToolSchema[]=[]
    for(const tool of definitions){
      if(options.allowedTools && !options.allowedTools.has(tool.name))continue
      if(options.disallowedTools?.has(tool.name))continue
      if(tool.isEnabled && !tool.isEnabled({mode:options.mode,autonomous:options.autonomous,workflowPhase:options.workflowPhase,allowedTools:options.allowedTools,disallowedTools:options.disallowedTools}))continue
      if(tool.isAvailable && !tool.isAvailable({mode:options.mode,autonomous:options.autonomous,workflowPhase:options.workflowPhase,allowedTools:options.allowedTools,disallowedTools:options.disallowedTools}))continue
      if(options.allowWrite===false && !tool.readOnly)continue
      if(options.allowShell===false && tool.risk==='shell')continue
      if(options.workflowAllowed && !options.workflowAllowed(tool))continue
      if(this.gate.isStaticallyDenied(tool,ctx))continue
      base.push({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.inputSchema||tool.schema}})
    }
    if(options.extraSchemas?.length)base.push(...options.extraSchemas)
    return boundToolSchemas(base,options.budgetTokens ?? 1200)
  }

  async execute(name:string,args:any,ctx:ToolContext) {
    const tool=this.get(name)
    if(!tool) throw new Error(`Unknown tool: ${name}`)
    if(tool.kind==='provider-hosted' || tool.kind==='declarative' || !tool.execute) throw new Error(`Tool '${name}' is not locally executable`)
    const validated=validateToolInput(args,tool.inputSchema||tool.schema)
    if(tool.preflight) await tool.preflight(validated,ctx)
    await this.gate.check(tool,validated,ctx.abort,ctx)
    const result=await tool.execute(validated,ctx)
    if(!result || typeof result.output!=='string') throw new Error(`Tool '${name}' returned an invalid result: output must be a string`)
    if(tool.outputSchema) validateToolOutput(result.output,tool.outputSchema)
    return result
  }

  providerHostedDefinition(name:string,provider:string,model?:string):ToolDefinition {
    return normalizeToolDefinition({name,description:`Provider-hosted tool: ${name}`,schema:{type:'object'},risk:'read',readOnly:true,concurrency:'safe',kind:'provider-hosted',provenance:{kind:'provider-hosted',provider,model},execute:undefined})
  }
}

