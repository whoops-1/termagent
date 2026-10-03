export type JSONSchema = Record<string, any>
export interface QuestionPrompt { id?:string; question:string; header?:string; options?:Array<{label:string;description?:string}>; multi?:boolean; multiple?:boolean; custom?:boolean }
export type QuestionStatus = 'replied'|'rejected'|'cancelled'
export interface QuestionResponse { requestId?:string; status:QuestionStatus; answers:string[][] }
export type Questioner = (questions:QuestionPrompt[], signal?:AbortSignal)=>Promise<string[][]|QuestionResponse>

export type ToolKind = 'local'|'provider-hosted'|'plugin'|'mcp'|'declarative'
export type ToolConcurrency = 'safe'|'unsafe'
export type PermissionAction = 'read'|'edit'|'shell'|'external_directory'|'task'|'skill'

export type ToolProvenance = {
  kind:'mcp'|'plugin'|'builtin'|'provider-hosted'|'declarative'
  server?:string
  pluginId?:string
  pluginName?:string
  marketplace?:string
  provider?:string
  model?:string
  source?:string
}

export type ToolPermissionRequest = {
  action: PermissionAction
  resources?: string[]
  save?: string[]
  force?: boolean
}

export type ToolPermissionDeclaration = {
  action?: PermissionAction
  resources?: (args:any, ctx:ToolContext)=>string[]
  /** Opt a tool into an explicit external-directory request when extracted paths leave its workspace. */
  externalDirectory?: boolean
  requests?: (args:any, ctx:ToolContext)=>ToolPermissionRequest[]
}

export type ToolAvailabilityContext = {
  mode?:string
  autonomous?:boolean
  workflowPhase?:string
  allowedTools?:ReadonlySet<string>
  disallowedTools?:ReadonlySet<string>
}

export interface ToolContext { sessionID: string; agent: string; cwd: string; abort: AbortSignal; toolCallId?: string; scopePaths?: string[]; taskId?: string; delegationDepth?: number; specialistRole?: string; questioner?: Questioner; permissionRules?: import('../config/config.js').PermissionRule[]; readFileState?: import('./file-state.js').FileReadStateCache }

export interface ToolResult { output:string; title?:string; metadata?:any }

export interface ToolDefinition {
  name: string
  description: string
  /** Backward-compatible schema alias. `inputSchema` is canonical. */
  schema: JSONSchema
  inputSchema?: JSONSchema
  outputSchema?: JSONSchema
  risk: 'read'|'write'|'shell'
  readOnly?: boolean
  concurrency?: ToolConcurrency
  parallelSafe?: boolean
  kind?: ToolKind
  provenance?: ToolProvenance
  permission?: ToolPermissionDeclaration
  isEnabled?: (ctx?:ToolAvailabilityContext)=>boolean
  isAvailable?: (ctx?:ToolAvailabilityContext)=>boolean
  /** Validate and precompute tool input before any permission prompt or side effect. */
  preflight?: (args:any,ctx:ToolContext)=>Promise<void>
  execute?: (args:any, ctx:ToolContext)=>Promise<ToolResult>
}
