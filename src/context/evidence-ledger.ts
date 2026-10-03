import crypto from 'node:crypto'
import { canonicalJson } from '../util/canonical.js'
import type { ExplorationStateSnapshot } from './exploration.js'
import type { ToolCallLifecycleRecord } from '../agent/tool-call-lifecycle.js'
import type { TaskRecord } from '../tasks/manager.js'
import type { ContextMutationEvidence } from './state.js'
import type { LspDiagnosticStatus } from './lsp-diagnostics.js'

export const EVIDENCE_LEDGER_VERSION = 1 as const

export interface EvidenceLedgerVerification {
  tool: string
  status: string
  ok: boolean
  exitCode?: number
  signal?: string
  termination?: string
  commandFingerprint?: string
  taskId?: string
  outputPath?: string
  outputBytes?: number
  outputTruncated?: boolean
  source: 'tool' | 'automatic'
}

export interface EvidenceLedgerLspDiagnostic {
  serverId: string
  filePath: string
  status: LspDiagnosticStatus
  diagnosticCount: number
  errorCount: number
  warningCount: number
  reason?: string
}

export interface EvidenceLedgerTask {
  id: string
  kind?: string
  status?: string
  termination?: string
  exitCode?: number
  outputTruncated?: boolean
  outputPath?: string
  outputBytes?: number
}

export interface EvidenceLedgerSnapshot {
  version: typeof EVIDENCE_LEDGER_VERSION
  progressRevision: number
  fingerprint: string
  files: ExplorationStateSnapshot['files']
  searches: ExplorationStateSnapshot['searches']
  symbols: ExplorationStateSnapshot['symbols']
  verifications: EvidenceLedgerVerification[]
  lspDiagnostics: EvidenceLedgerLspDiagnostic[]
  mutations: ContextMutationEvidence[]
  tasks: EvidenceLedgerTask[]
  workflow?: unknown
}

function stableFingerprint(input: Omit<EvidenceLedgerSnapshot, 'fingerprint'>): string {
  const semantic = {
    files: input.files,
    searches: input.searches.map(item => ({
      kind: item.kind,
      signature: item.signature,
      query: item.query,
      path: item.path,
      include: item.include,
      discoveredFiles: item.discoveredFiles,
      symbols: item.symbols,
      resultKeys: item.resultKeys,
    })),
    symbols: input.symbols,
    verifications: input.verifications.map(item => ({
      tool: item.tool,
      status: item.status,
      ok: item.ok,
      exitCode: item.exitCode,
      signal: item.signal,
      termination: item.termination,
      commandFingerprint: item.commandFingerprint,
    })),
    lspDiagnostics: input.lspDiagnostics.map(item => ({
      serverId: item.serverId,
      filePath: item.filePath,
      status: item.status,
      diagnosticCount: item.diagnosticCount,
      errorCount: item.errorCount,
      warningCount: item.warningCount,
    })),
    mutations: input.mutations.map(item => ({
      path: item.path,
      operation: item.operation,
      beforeHash: item.beforeHash ?? null,
      afterHash: item.afterHash,
      additions: item.additions,
      deletions: item.deletions,
    })),
    tasks: input.tasks.map(item => ({
      kind: item.kind,
      status: item.status,
      termination: item.termination,
      exitCode: item.exitCode,
    })),
    workflow: input.workflow,
  }
  return crypto.createHash('sha256').update(canonicalJson(semantic)).digest('hex')
}

function verificationFromLifecycle(records: readonly ToolCallLifecycleRecord[]): EvidenceLedgerVerification[] {
  const out: EvidenceLedgerVerification[] = []
  for (const record of records) {
    const metadata = record.metadata
    if (!metadata || typeof metadata !== 'object') continue
    const metadataRecord = metadata as Record<string, unknown>
    const verification = (metadataRecord as any).verification
    if (!verification || typeof verification !== 'object') continue
    const status = typeof verification.status === 'string' ? verification.status : record.outcome === 'success' ? 'passed' : 'failed'
    const task = metadataRecord.task && typeof metadataRecord.task === 'object' ? metadataRecord.task as Record<string, unknown> : undefined
    out.push({
      tool: record.name,
      status,
      ok: verification.ok === true || (status === 'passed' && record.outcome === 'success'),
      ...(Number.isSafeInteger(Number(verification.exitCode)) ? { exitCode: Number(verification.exitCode) } : {}),
      ...(typeof verification.signal === 'string' ? { signal: verification.signal } : {}),
      ...(typeof verification.termination === 'string' ? { termination: verification.termination } : {}),
      ...(typeof verification.commandFingerprint === 'string' ? { commandFingerprint: verification.commandFingerprint } : {}),
      ...(typeof task?.taskId === 'string' ? { taskId: task.taskId } : {}),
      ...(typeof task?.outputPath === 'string' ? { outputPath: task.outputPath } : {}),
      ...(Number.isFinite(Number(task?.outputBytes)) ? { outputBytes: Number(task!.outputBytes) } : {}),
      ...(task?.outputTruncated !== undefined ? { outputTruncated: Boolean(task.outputTruncated) } : {}),
      source: 'tool',
    })
  }
  return out.slice(-32)
}
function lspDiagnosticsFromLifecycle(records: readonly ToolCallLifecycleRecord[]): EvidenceLedgerLspDiagnostic[] {
  const out: EvidenceLedgerLspDiagnostic[] = []
  for (const record of records) {
    const metadata = record.metadata
    if (!metadata || typeof metadata !== 'object') continue
    const value = (metadata as Record<string, unknown>).lspDiagnostics
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    if (typeof item.serverId !== 'string' || typeof item.filePath !== 'string') continue
    const status = typeof item.status === 'string' ? item.status as LspDiagnosticStatus : 'unknown'
    if (!['unknown', 'running', 'provisional', 'clean', 'failed', 'timed_out', 'cancelled'].includes(status)) continue
    out.push({
      serverId: item.serverId,
      filePath: item.filePath,
      status,
      diagnosticCount: Math.max(0, Number(item.diagnosticCount) || 0),
      errorCount: Math.max(0, Number(item.errorCount) || 0),
      warningCount: Math.max(0, Number(item.warningCount) || 0),
      ...(typeof item.reason === 'string' && item.reason ? { reason: item.reason.slice(0, 512) } : {}),
    })
  }
  return out.slice(-64)
}

export function buildEvidenceLedger(input: {
  exploration: ExplorationStateSnapshot
  lifecycle?: readonly ToolCallLifecycleRecord[]
  mutations?: readonly ContextMutationEvidence[]
  tasks?: readonly TaskRecord[]
  automaticVerifications?: readonly EvidenceLedgerVerification[]
  lspDiagnostics?: readonly EvidenceLedgerLspDiagnostic[]
  workflow?: unknown
}): EvidenceLedgerSnapshot {
  const verifications = [
    ...verificationFromLifecycle(input.lifecycle ?? []),
    ...(input.automaticVerifications ?? []),
  ].slice(-32)
  const lspDiagnostics = [
    ...lspDiagnosticsFromLifecycle(input.lifecycle ?? []),
    ...(input.lspDiagnostics ?? []),
  ].slice(-64)
  const tasks = (input.tasks ?? []).map(task => ({
    id: String(task.id),
    ...(task.kind ? { kind: task.kind } : {}),
    ...(task.status ? { status: task.status } : {}),
    ...(task.termination ? { termination: task.termination } : {}),
    ...(Number.isSafeInteger(Number(task.exitCode)) ? { exitCode: Number(task.exitCode) } : {}),
    ...(task.outputTruncated !== undefined ? { outputTruncated: Boolean(task.outputTruncated) } : {}),
    ...(typeof task.outputPath === 'string' ? { outputPath: task.outputPath } : {}),
    ...(Number.isFinite(Number(task.outputBytes)) ? { outputBytes: Number(task.outputBytes) } : {}),
  })).slice(-64)
  const draft: Omit<EvidenceLedgerSnapshot, 'fingerprint'> = {
    version: EVIDENCE_LEDGER_VERSION,
    progressRevision: input.exploration.progressRevision,
    files: input.exploration.files.slice(-256),
    searches: input.exploration.searches.slice(-96),
    symbols: input.exploration.symbols.slice(-512),
    verifications,
    lspDiagnostics,
    mutations: [...(input.mutations ?? [])].slice(-32),
    tasks,
    workflow: input.workflow,
  }
  return { ...draft, fingerprint: stableFingerprint(draft) }
}
