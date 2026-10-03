import crypto from 'node:crypto'
import type { TaskManager } from '../tasks/manager.js'
import { verifyTool } from '../tools/verify.js'
import type { PostEditVerificationConfig } from '../config/config.js'
import type { ToolContext, ToolResult } from '../tools/types.js'

export const DEFAULT_POST_EDIT_VERIFICATION_TOOLS = ['write_file', 'edit_file', 'apply_patch'] as const

export interface AutomaticVerificationResult {
  status: 'passed' | 'failed' | 'timeout' | 'cancelled' | 'no_command'
  ok: boolean
  output: string
  taskId?: string
  commandFingerprint?: string
  exitCode?: number
  signal?: string
  termination?: string
  outputPath?: string
  outputBytes?: number
  outputTruncated?: boolean
}

export function normalizePostEditVerificationConfig(config?: PostEditVerificationConfig): Required<Pick<PostEditVerificationConfig, 'enabled' | 'timeoutMs' | 'maxOutputBytes' | 'tools'>> & Pick<PostEditVerificationConfig, 'command'> {
  const configuredTimeout = Number(config?.timeoutMs)
  const configuredOutput = Number(config?.maxOutputBytes)
  const timeoutMs = Math.min(300000, Math.max(1, Number.isFinite(configuredTimeout) ? Math.floor(configuredTimeout) : 120000))
  const maxOutputBytes = Math.min(64 * 1024 * 1024, Math.max(1024, Number.isFinite(configuredOutput) ? Math.floor(configuredOutput) : 20000))
  const tools = Array.isArray(config?.tools) && config.tools.length
    ? [...new Set(config.tools.map(String).filter(Boolean))]
    : [...DEFAULT_POST_EDIT_VERIFICATION_TOOLS]
  return {
    enabled: config?.enabled === true,
    command: typeof config?.command === 'string' && config.command.trim() ? config.command.trim() : undefined,
    timeoutMs,
    maxOutputBytes,
    tools,
  }
}

function commandFingerprint(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return crypto.createHash('sha256').update(value).digest('hex')
}

export async function runAutomaticPostEditVerification(input: {
  config?: PostEditVerificationConfig
  manager: TaskManager
  context: ToolContext
}): Promise<AutomaticVerificationResult> {
  const config = normalizePostEditVerificationConfig(input.config)
  if (!config.enabled) return { status: 'no_command', ok: false, output: 'automatic post-edit verification is disabled' }

  const tool = verifyTool(config.timeoutMs, config.maxOutputBytes, input.manager)
  const result: ToolResult = await tool.execute!({
    ...(config.command ? { command: config.command } : {}),
    timeoutMs: config.timeoutMs,
  }, input.context)
  const verification = result.metadata?.verification
  const status = verification?.status === 'passed' || verification?.status === 'failed' || verification?.status === 'timeout' || verification?.status === 'cancelled' || verification?.status === 'no_command'
    ? verification.status
    : result.metadata?.ok === true ? 'passed' : 'failed'
  return {
    status,
    ok: status === 'passed',
    output: result.output,
    ...(typeof result.metadata?.task?.taskId === 'string' ? { taskId: result.metadata.task.taskId } : {}),
    ...(typeof result.metadata?.task?.outputPath === 'string' ? { outputPath: result.metadata.task.outputPath } : {}),
    ...(Number.isFinite(Number(result.metadata?.task?.outputBytes)) ? { outputBytes: Number(result.metadata.task.outputBytes) } : {}),
    ...(result.metadata?.task?.outputTruncated !== undefined ? { outputTruncated: Boolean(result.metadata.task.outputTruncated) } : {}),
    ...(typeof verification?.commandFingerprint === 'string' ? { commandFingerprint: verification.commandFingerprint } : commandFingerprint(config.command) ? { commandFingerprint: commandFingerprint(config.command) } : {}),
    ...(Number.isSafeInteger(Number(verification?.exitCode)) ? { exitCode: Number(verification.exitCode) } : {}),
    ...(typeof verification?.signal === 'string' ? { signal: verification.signal } : {}),
    ...(typeof verification?.termination === 'string' ? { termination: verification.termination } : {}),
  }
}
