import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChatMessage } from '../session/store.js'
import type { ContextAccounting } from '../context/budget.js'
import type { ProviderTokenCount, ProviderUsage } from './types.js'

export const PROVIDER_TRACE_ENV = 'TERMAGENT_PROVIDER_TRACE_DIR'
export const PROVIDER_TRACE_SCHEMA_VERSION = 1
export const PROVIDER_TRACE_MAX_BYTES = 32 * 1024 * 1024

export interface ProviderTraceCaptureInput {
  sessionId: string
  turnId: string
  round: number
  provider: string
  model: string
  contextWindow: number
  contextSource: string
  maxOutputTokens: number
  usableTokens: number
  messages: readonly ChatMessage[]
  tools: readonly Record<string, unknown>[]
  accounting: ContextAccounting
  estimatedMessageTokens: number
  providerTokenCount?: ProviderTokenCount
  providerUsage?: ProviderUsage
  assistantText?: string
  assistantReasoning?: string
  assistantToolCalls?: unknown[]
  recordedAt?: number
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(source).sort().map(key => [key, stable(source[key])]))
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function hashIdentifier(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * Write an opt-in, local-only capture of the exact message/tool payload passed
 * to a provider and the usage returned for that completed request. This file
 * intentionally contains prompt contents; it must not be enabled by default
 * or shared without review. Credentials, authorization headers and endpoint
 * query strings are never part of the capture shape.
 */
export async function captureProviderTrace(input: ProviderTraceCaptureInput): Promise<string | undefined> {
  const configuredDirectory = process.env[PROVIDER_TRACE_ENV]?.trim()
  if (!configuredDirectory) return undefined

  if (!Number.isSafeInteger(input.round) || input.round < 0) throw new Error('Provider trace round must be a non-negative integer')
  if (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 256) throw new Error('Provider trace contextWindow is invalid')
  if (!Array.isArray(input.messages) || !Array.isArray(input.tools)) throw new Error('Provider trace request payload is invalid')

  const request = {
    messages: input.messages,
    tools: input.tools,
  }
  const requestSha256 = digest(request)
  const recordedAt = Number.isSafeInteger(input.recordedAt) && (input.recordedAt ?? 0) > 0 ? input.recordedAt! : Date.now()
  const providerUsage = input.providerUsage ?? null
  const separatelyReportedCacheTokens = providerUsage?.cacheTokensExcludedFromInput
    ? (providerUsage.cacheReadTokens ?? 0) + (providerUsage.cacheWriteTokens ?? 0)
    : 0
  const observedInputTokens = providerUsage
    ? providerUsage.inputTokens + separatelyReportedCacheTokens
    : undefined
  const observedContextTokens = providerUsage
    ? providerUsage.contextTokens ?? observedInputTokens
    : undefined

  const record = {
    schemaVersion: PROVIDER_TRACE_SCHEMA_VERSION,
    kind: 'termagent.provider-request-trace',
    capturedAt: recordedAt,
    traceId: crypto.randomUUID(),
    sessionIdHash: hashIdentifier(input.sessionId),
    turnIdHash: hashIdentifier(input.turnId),
    round: input.round,
    route: {
      provider: String(input.provider).slice(0, 96),
      model: String(input.model).slice(0, 160),
      contextWindow: input.contextWindow,
      contextSource: String(input.contextSource).slice(0, 64),
      maxOutputTokens: input.maxOutputTokens,
      usableTokens: input.usableTokens,
    },
    request: {
      ...request,
      sha256: requestSha256,
    },
    measurement: {
      estimatedMessageTokens: input.estimatedMessageTokens,
      estimatedRequestTokens: input.accounting.total,
      requestComponents: input.accounting,
      providerNativeCount: input.providerTokenCount
        ? { inputTokens: input.providerTokenCount.inputTokens, source: input.providerTokenCount.source }
        : null,
      providerUsage,
      observedInputTokens: observedInputTokens ?? null,
      observedContextTokens: observedContextTokens ?? null,
    },
    response: {
      text: input.assistantText ?? '',
      reasoning: input.assistantReasoning ?? '',
      toolCalls: input.assistantToolCalls ?? [],
    },
    privacy: {
      containsPromptContent: true,
      containsProviderResponseContent: true,
      providerConfigurationCaptured: false,
      providerConfigurationCredentialsCaptured: false,
      providerConfigurationEndpointCaptured: false,
      promptOrResponseContentMayContainSecrets: true,
      reviewBeforeSharing: true,
    },
  }

  const serialized = `${JSON.stringify(record)}\n`
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > PROVIDER_TRACE_MAX_BYTES) {
    throw new Error(`Provider trace is ${bytes} bytes; capture limit is ${PROVIDER_TRACE_MAX_BYTES} bytes. No truncated trace was written.`)
  }

  const directory = path.resolve(configuredDirectory)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
  const fileName = `${recordedAt}-${record.traceId}.json`
  const destination = path.join(directory, fileName)
  const temporary = path.join(directory, `.${fileName}.tmp`)
  let handle: any
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, destination)
    await fs.chmod(destination, 0o600)
    return destination
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
