import crypto from 'node:crypto'
import type { ChatMessage } from '../session/store.js'
import type { ReadFileState } from '../tools/file-state.js'
import type { ExplorationStateSnapshot } from './exploration.js'
import type { EvidenceLedgerSnapshot } from './evidence-ledger.js'
import type { ToolCallLifecycleRecord } from '../agent/tool-call-lifecycle.js'
import { estimateTokens, truncateToTokenBudget } from './budget.js'

export const CONTEXT_STATE_VERSION = 1

export interface ContextReadCoverage {
  canonicalPath: string
  mtimeMs: number
  size: number
  totalLines: number
  contentHash?: string
  ranges: Array<{ startLine: number; endLine: number }>
}

export interface ContextToolOutputReference {
  callId: string
  reference: string
  totalBytes?: number
  totalLines?: number
  outputPath?: string
}

export interface ContextMutationEvidence {
  callId?: string
  turnId?: string
  path: string
  operation: string
  beforeHash?: string | null
  afterHash?: string
  additions?: number
  deletions?: number
}

export interface ContextMachineState {
  version: number
  sessionId: string
  turnId?: string
  epoch: number
  checkpointId: string
  sourceEventCount: number
  projectionHash: string
  summaryRevision: number
  readCoverage: ContextReadCoverage[]
  exploration?: ExplorationStateSnapshot
  evidenceLedger?: EvidenceLedgerSnapshot
  toolOutputReferences: ContextToolOutputReference[]
  activeTaskIds: string[]
  workflow?: unknown
  todo: Array<{ id: string; task: string; status: string; priority?: string }>
  mutations: ContextMutationEvidence[]
  loadedSkills?: Array<{id:string;sha256?:string}>
  answeredQuestions?: Array<{requestId:string;status:string;answers:string[][]}>
  continuation?: { lastUserPrompt?: string; nextAction?: string }
  createdAt: number
}

export interface ContextCheckpointRecord {
  version: number
  id: string
  sessionId: string
  turnId?: string
  epoch: number
  sourceEventCount: number
  projectionHash: string
  summaryRevision: number
  summary: string
  messages: ChatMessage[]
  machineState: ContextMachineState
  stage: 'baseline' | 'micro-prune' | 'full-compaction'
  createdAt: number
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current
    return Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
  })
}

export function projectionHash(messages: readonly ChatMessage[]): string {
  const stable = messages.filter(message => message.role !== 'system').map(message => ({
    role: message.role,
    content: message.content,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls,
    name: message.name,
    reasoning: message.reasoning,
  }))
  return crypto.createHash('sha256').update(stableJson(stable)).digest('hex')
}

function collectTaskId(value: unknown, out: Set<string>) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectTaskId(item, out)
    return
  }
  const record = value as Record<string, unknown>
  for (const key of ['taskId', 'taskID', 'id']) {
    if (key === 'id' && !('taskId' in record) && !('taskID' in record)) continue
    const item = record[key]
    if (typeof item === 'string' && item.trim()) out.add(item.trim())
  }
  for (const key of ['shell', 'git', 'task', 'background', 'activeTask']) collectTaskId(record[key], out)
}

function isRunningLifecycle(record: ToolCallLifecycleRecord): boolean {
  const metadata = record.metadata
  if (!metadata || typeof metadata !== 'object') return false
  const status = (metadata as any).shell?.status ?? (metadata as any).git?.status ?? (metadata as any).status
  const background = (metadata as any).shell?.background ?? (metadata as any).git?.background ?? (metadata as any).background
  return background === true && status === 'running'
}

export function machineStateFromRuntime(input: {
  sessionId: string
  turnId?: string
  epoch: number
  checkpointId?: string
  sourceEventCount: number
  summaryRevision: number
  messages: readonly ChatMessage[]
  readStates?: readonly ReadFileState[]
  exploration?: ExplorationStateSnapshot
  evidenceLedger?: EvidenceLedgerSnapshot
  toolLifecycle?: readonly ToolCallLifecycleRecord[]
  workflow?: unknown
  todo?: readonly { id: string; task: string; status: string; priority?: string }[]
  mutations?: readonly ContextMutationEvidence[]
  loadedSkills?: readonly {id:string;sha256?:string}[]
  answeredQuestions?: readonly {requestId:string;status:string;answers:string[][]}[]
  continuation?: ContextMachineState['continuation']
}): ContextMachineState {
  const taskIds = new Set<string>()
  const outputReferences: ContextToolOutputReference[] = []
  const activeFromLifecycle = new Set<string>()
  for (const record of input.toolLifecycle ?? []) {
    if (record.outputReference) {
      outputReferences.push({
        callId: record.callId,
        reference: record.outputReference,
        outputPath: record.outputPath,
        ...(record.metadata && typeof record.metadata === 'object' && (record.metadata as any).toolOutput
          ? {
              totalBytes: Number((record.metadata as any).toolOutput.totalBytes) || undefined,
              totalLines: Number((record.metadata as any).toolOutput.totalLines) || undefined,
            }
          : {}),
      })
    }
    if (isRunningLifecycle(record)) {
      const before=taskIds.size
      collectTaskId(record.metadata, taskIds)
      if (taskIds.size>before) for (const id of taskIds) activeFromLifecycle.add(id)
    }
  }
  const mutations = [...(input.mutations ?? [])].slice(-24)
  const reads = [...(input.readStates ?? [])]
    .sort((a, b) => b.lastUse - a.lastUse)
    .slice(0, 16)
    .map(state => ({
      canonicalPath: state.canonicalPath,
      mtimeMs: state.mtimeMs,
      size: state.size,
      totalLines: state.totalLines,
      contentHash: state.contentHash,
      ranges: state.segments.filter(segment => segment.complete).map(segment => ({ startLine: segment.startLine, endLine: segment.endLine })),
    }))
  const activeTaskIds = [...activeFromLifecycle].sort()
  const checkpointId = input.checkpointId || crypto.randomBytes(8).toString('hex')
  return {
    version: CONTEXT_STATE_VERSION,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    epoch: input.epoch,
    checkpointId,
    sourceEventCount: input.sourceEventCount,
    projectionHash: projectionHash(input.messages),
    summaryRevision: input.summaryRevision,
    readCoverage: reads,
    ...(input.exploration ? { exploration: input.exploration } : {}),
    ...(input.evidenceLedger ? { evidenceLedger: input.evidenceLedger } : {}),
    toolOutputReferences: outputReferences.slice(-32),
    activeTaskIds,
    workflow: input.workflow,
    todo: [...(input.todo ?? [])].map(item => ({ id: item.id, task: item.task, status: item.status, ...(item.priority ? {priority:item.priority} : {}) })),
    loadedSkills: [...(input.loadedSkills ?? [])].map(item => ({id:String(item.id), ...(item.sha256 ? {sha256:String(item.sha256)} : {})})).slice(-24),
    answeredQuestions: [...(input.answeredQuestions ?? [])].map(item => ({requestId:String(item.requestId),status:String(item.status),answers:Array.isArray(item.answers)?item.answers.map(a=>Array.isArray(a)?a.map(String):[]):[]})).slice(-16),
    mutations,
    continuation: input.continuation,
    createdAt: Date.now(),
  }
}

export function renderMachineState(state: ContextMachineState, tokenBudget = 700, evidence: string[] = []): string {
  const lines: string[] = [
    '[TermAgent machine context]',
    `version=${state.version} epoch=${state.epoch} checkpoint=${state.checkpointId} baselineEvents=${state.sourceEventCount} summaryRevision=${state.summaryRevision}`,
    `projection=${state.projectionHash}`,
    'readCoverage=',
  ]
  if (state.readCoverage.length) {
    for (const item of state.readCoverage.slice(0, 10)) {
      const ranges = item.ranges.slice(0, 8).map(range => `${range.startLine}-${range.endLine}`).join(',') || 'none'
      lines.push(`- ${item.canonicalPath} [${ranges}]${item.contentHash ? ` sha256=${item.contentHash}` : ''}`)
    }
  } else lines.push('- none')
  if (state.exploration) lines.push(`exploration=progress:${state.exploration.progressRevision} files:${state.exploration.discoveredFiles.length} reads:${state.exploration.reads.length} searches:${state.exploration.searches.length} symbols:${state.exploration.symbols.length}`)
  if (state.evidenceLedger) {
    const lspCount = Array.isArray(state.evidenceLedger.lspDiagnostics) ? state.evidenceLedger.lspDiagnostics.length : 0
    const lsp = lspCount ? ` lsp:${lspCount}` : ''
    lines.push(`evidenceLedger=rev:${state.evidenceLedger.progressRevision} files:${state.evidenceLedger.files.length} searches:${state.evidenceLedger.searches.length} symbols:${state.evidenceLedger.symbols.length} verifications:${state.evidenceLedger.verifications.length}${lsp} mutations:${state.evidenceLedger.mutations.length} tasks:${state.evidenceLedger.tasks.length}`)
  }
  lines.push('toolOutputReferences=')
  if (state.toolOutputReferences.length) for (const item of state.toolOutputReferences.slice(-10)) lines.push(`- ${item.callId} ${item.reference}`)
  else lines.push('- none')
  lines.push(`activeTaskIds=${state.activeTaskIds.length ? state.activeTaskIds.join(', ') : 'none'}`)
  lines.push(`loadedSkills=${state.loadedSkills?.length ? state.loadedSkills.map(x=>x.id).join(', ') : 'none'}`)
  lines.push(`answeredQuestions=${state.answeredQuestions?.length ? state.answeredQuestions.map(x=>x.requestId+':'+x.status).join(', ') : 'none'}`)
  lines.push(`todo=${state.todo.length ? JSON.stringify(state.todo) : 'none'}`)
  lines.push(`workflow=${state.workflow ? JSON.stringify(state.workflow) : 'none'}`)
  lines.push('mutations=')
  if (state.mutations.length) for (const item of state.mutations.slice(-8)) lines.push(`- ${item.path} ${item.operation}${item.afterHash ? ` after=${item.afterHash}` : ''}`)
  else lines.push('- none')
  if (state.continuation?.lastUserPrompt) lines.push(`continuation.user=${state.continuation.lastUserPrompt}`)
  if (state.continuation?.nextAction) lines.push(`continuation.next=${state.continuation.nextAction}`)
  if (evidence.length) {
    lines.push('rehydratedReadEvidence=')
    lines.push(...evidence)
  }
  return truncateToTokenBudget(lines.join('\n'), Math.max(64, tokenBudget))
}

export function estimateMachineStateTokens(state: ContextMachineState, evidence: string[] = []): number {
  return estimateTokens(renderMachineState(state, 100_000, evidence))
}
