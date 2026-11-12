import type { ChatMessage, ToolCall } from '../session/store.js'
import type { ToolRegistry } from '../tools/registry.js'

export interface ProviderModalityUsage {
  prompt?: Record<string, number>
  cached?: Record<string, number>
  candidates?: Record<string, number>
  toolUsePrompt?: Record<string, number>
}

export interface ProviderUsage {
  /** Input-side tokens billed for the request/turn. Cache subsets may be separate. */
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  /** Input occupancy of the final model request, when different from billed turn input. */
  contextTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  /** Gemini reports tool execution results as an additional input-side token bucket. */
  toolUsePromptTokens?: number
  modalityTokens?: ProviderModalityUsage
  /** True when cache tokens are reported separately from inputTokens rather than included in it. */
  cacheTokensExcludedFromInput?: boolean
}

/** Durable, secret-free snapshot of one completed provider request. */
export interface ProviderUsageReport {
  inputTokens: number
  contextTokens?: number
  nonCachedInputTokens: number
  outputTokens: number
  totalTokens: number
  estimated: boolean
  contextWindow: number
  contextSource: string
  provider: string
  model: string
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  toolUsePromptTokens?: number
  modalityTokens?: ProviderModalityUsage
  estimateInputTokens: number
  /** Full local request footprint, including tool schemas and multimodal estimates. */
  estimateRequestTokens?: number
  driftPercent?: number
  recordedAt?: number
}

const USAGE_MODALITY_GROUPS = ['prompt', 'cached', 'candidates', 'toolUsePrompt'] as const

/** Validate and bound persisted or provider-derived usage before it reaches durable session history. */
export function normalizeProviderUsageReport(value: unknown): ProviderUsageReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const token = (candidate: unknown): number | undefined =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(candidate))
      : undefined
  const text = (candidate: unknown, fallback: string, max = 96) =>
    typeof candidate === 'string' && candidate.trim()
      ? candidate.trim().replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').slice(0, max)
      : fallback
  const inputTokens = token(input.inputTokens)
  const nonCachedInputTokens = token(input.nonCachedInputTokens)
  const outputTokens = token(input.outputTokens)
  const totalTokens = token(input.totalTokens)
  const contextWindow = token(input.contextWindow)
  const estimateInputTokens = token(input.estimateInputTokens)
  const estimateRequestTokens = token(input.estimateRequestTokens)
  if ([inputTokens, nonCachedInputTokens, outputTokens, totalTokens, contextWindow, estimateInputTokens].some(item => item === undefined) || contextWindow === 0) return undefined
  const modalityTokens: ProviderModalityUsage = {}
  if (input.modalityTokens && typeof input.modalityTokens === 'object' && !Array.isArray(input.modalityTokens)) {
    const source = input.modalityTokens as Record<string, unknown>
    for (const group of USAGE_MODALITY_GROUPS) {
      const raw = source[group]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const entries: Array<[string, number]> = []
      let examined = 0
      for (const name in raw as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(raw, name)) continue
        examined++
        if (examined > 64) break
        if (!/^[a-zA-Z0-9_.:-]{1,48}$/.test(name)) continue
        const count = token((raw as Record<string, unknown>)[name])
        if (count === undefined) continue
        entries.push([name, count])
        if (entries.length >= 12) break
      }
      if (entries.length) modalityTokens[group] = Object.fromEntries(entries)
    }
  }
  const optionalToken = (key: string) => token(input[key])
  const drift = typeof input.driftPercent === 'number' && Number.isFinite(input.driftPercent)
    ? Math.max(-1000, Math.min(1000, Math.round(input.driftPercent * 10) / 10))
    : undefined
  const recordedAt = optionalToken('recordedAt')
  return {
    inputTokens: inputTokens!,
    ...(token(input.contextTokens) === undefined ? {} : { contextTokens: token(input.contextTokens) }),
    nonCachedInputTokens: nonCachedInputTokens!,
    outputTokens: outputTokens!,
    totalTokens: totalTokens!,
    estimated: input.estimated === true,
    contextWindow: contextWindow!,
    contextSource: text(input.contextSource, 'unknown'),
    provider: text(input.provider, 'unknown'),
    model: text(input.model, 'unknown'),
    ...(optionalToken('cacheReadTokens') === undefined ? {} : { cacheReadTokens: optionalToken('cacheReadTokens') }),
    ...(optionalToken('cacheWriteTokens') === undefined ? {} : { cacheWriteTokens: optionalToken('cacheWriteTokens') }),
    ...(optionalToken('reasoningTokens') === undefined ? {} : { reasoningTokens: optionalToken('reasoningTokens') }),
    ...(optionalToken('toolUsePromptTokens') === undefined ? {} : { toolUsePromptTokens: optionalToken('toolUsePromptTokens') }),
    ...(Object.keys(modalityTokens).length ? { modalityTokens } : {}),
    estimateInputTokens: estimateInputTokens!,
    ...(estimateRequestTokens === undefined ? {} : { estimateRequestTokens }),
    ...(drift === undefined ? {} : { driftPercent: drift }),
    ...(recordedAt === undefined ? {} : { recordedAt: Math.min(8_640_000_000_000_000, recordedAt) }),
  }
}

/** Iterate valid, secret-free provider usage snapshots without materializing another event-sized array. */
function* iterateProviderUsageReports(events: readonly unknown[]): Generator<ProviderUsageReport> {
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const record = event as Record<string, unknown>
    if (record.type !== 'provider.usage' || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) continue
    const data = record.data as Record<string, unknown>
    const report = normalizeProviderUsageReport({ ...data, recordedAt: data.recordedAt ?? record.ts })
    if (report) yield report
  }
}

/** Read valid, secret-free provider usage snapshots from a durable session event stream. */
export function providerUsageReportsFromEvents(events: readonly unknown[]): ProviderUsageReport[] {
  return [...iterateProviderUsageReports(events)]
}

/** Recover the newest valid usage report from durable session events. */
export function latestProviderUsageFromEvents(events: readonly unknown[]): ProviderUsageReport | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    const record = event as Record<string, unknown>
    if (record.type !== 'provider.usage' || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) continue
    const data = record.data as Record<string, unknown>
    const report = normalizeProviderUsageReport({ ...data, recordedAt: data.recordedAt ?? record.ts })
    if (report) return report
  }
  return undefined
}

export interface ProviderUsageRouteAggregate {
  provider: string
  model: string
  requests: number
  estimatedRequests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ProviderUsageAggregate {
  requests: number
  providerReportedRequests: number
  estimatedRequests: number
  inputTokens: number
  nonCachedInputTokens: number
  outputTokens: number
  totalTokens: number
  estimateInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  toolUsePromptTokens: number
  contextSamples: number
  averageContextTokens?: number
  peakContextTokens?: number
  driftSamples: number
  driftPercent?: number
  firstRecordedAt?: number
  lastRecordedAt?: number
  routes: ProviderUsageRouteAggregate[]
}

/** Aggregate persisted reports without double-counting cache/reasoning breakdowns in inclusive totals. */
export function aggregateProviderUsageReports(reports: Iterable<ProviderUsageReport>): ProviderUsageAggregate {
  const total = (): ProviderUsageAggregate => ({
    requests: 0,
    providerReportedRequests: 0,
    estimatedRequests: 0,
    inputTokens: 0,
    nonCachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimateInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    toolUsePromptTokens: 0,
    contextSamples: 0,
    driftSamples: 0,
    routes: [],
  })
  const result = total()
  const routeMap = new Map<string, ProviderUsageRouteAggregate>()
  let contextTokenSum = 0
  let measuredContextTokenSum = 0
  let measuredEstimateTokenSum = 0
  const add = (left: number, right: number) => Math.min(Number.MAX_SAFE_INTEGER, left + right)

  for (const report of reports) {
    result.requests++
    if (report.estimated) result.estimatedRequests++
    else result.providerReportedRequests++
    result.inputTokens = add(result.inputTokens, report.inputTokens)
    result.nonCachedInputTokens = add(result.nonCachedInputTokens, report.nonCachedInputTokens)
    result.outputTokens = add(result.outputTokens, report.outputTokens)
    result.totalTokens = add(result.totalTokens, report.totalTokens)
    result.estimateInputTokens = add(result.estimateInputTokens, report.estimateInputTokens)
    result.cacheReadTokens = add(result.cacheReadTokens, report.cacheReadTokens ?? 0)
    result.cacheWriteTokens = add(result.cacheWriteTokens, report.cacheWriteTokens ?? 0)
    result.reasoningTokens = add(result.reasoningTokens, report.reasoningTokens ?? 0)
    result.toolUsePromptTokens = add(result.toolUsePromptTokens, report.toolUsePromptTokens ?? 0)

    if (report.contextTokens !== undefined) {
      result.contextSamples++
      contextTokenSum = add(contextTokenSum, report.contextTokens)
      result.peakContextTokens = Math.max(result.peakContextTokens ?? 0, report.contextTokens)
    }
    // Only provider-measured requests contribute to estimator drift. The cache and
    // reasoning values are breakdowns, not additional tokens to add to totalTokens.
    if (!report.estimated && report.driftPercent !== undefined) {
      result.driftSamples++
      measuredContextTokenSum = add(measuredContextTokenSum, report.contextTokens ?? report.inputTokens)
      measuredEstimateTokenSum = add(measuredEstimateTokenSum, report.estimateInputTokens)
    }
    if (report.recordedAt !== undefined) {
      result.firstRecordedAt = Math.min(result.firstRecordedAt ?? report.recordedAt, report.recordedAt)
      result.lastRecordedAt = Math.max(result.lastRecordedAt ?? report.recordedAt, report.recordedAt)
    }

    const key = `${report.provider}\u0000${report.model}`
    const routeKey = routeMap.has(key) || routeMap.size < 32 ? key : '__other_routes__'
    let route = routeMap.get(routeKey)
    if (!route) {
      route = routeKey === '__other_routes__'
        ? {
            provider: 'other',
            model: 'additional routes',
            requests: 0,
            estimatedRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }
        : {
            provider: report.provider,
            model: report.model,
            requests: 0,
            estimatedRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }
      routeMap.set(routeKey, route)
    }
    route.requests++
    if (report.estimated) route.estimatedRequests++
    route.inputTokens = add(route.inputTokens, report.inputTokens)
    route.outputTokens = add(route.outputTokens, report.outputTokens)
    route.totalTokens = add(route.totalTokens, report.totalTokens)
    route.cacheReadTokens = add(route.cacheReadTokens, report.cacheReadTokens ?? 0)
    route.cacheWriteTokens = add(route.cacheWriteTokens, report.cacheWriteTokens ?? 0)
  }

  if (result.contextSamples) result.averageContextTokens = Math.round(contextTokenSum / result.contextSamples)
  if (result.driftSamples && measuredContextTokenSum > 0) {
    result.driftPercent = Math.round(((measuredContextTokenSum - measuredEstimateTokenSum) / measuredContextTokenSum) * 1000) / 10
  }
  result.routes = [...routeMap.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
  return result
}

/** Aggregate durable events directly to avoid an intermediate array on large mobile session logs. */
export function aggregateProviderUsageEvents(events: readonly unknown[]): ProviderUsageAggregate {
  return aggregateProviderUsageReports(iterateProviderUsageReports(events))
}

export type StreamEvent =
  | { type:'text'; delta:string }
  | { type:'usage'; usage:ProviderUsage }
  | { type:'reasoning'; delta:string }
  | { type:'tool_call'; call:ToolCall; providerExecuted?:boolean; providerMetadata?:unknown }
  | { type:'tool_result'; call:ToolCall; output:string; error?:string; providerExecuted?:boolean; providerMetadata?:unknown }
  | { type:'done'; finishReason?:string }

export interface ProviderConfig { provider?:string; providerId?:string; model:string; apiKey?:string; apiKeyEnv?:string; baseUrl:string; temperature?:number; maxTokens?:number; maxOutputTokens?:number; contextWindow?:number; variant?:string; reasoningEffort?:'low'|'medium'|'high'|'max'; streamIdleTimeoutMs?:number; extra?:Record<string,unknown> }
export interface ProviderTokenCount {
  /** Provider-counted input tokens, including supported system/tool framing. */
  inputTokens: number
  /** Identifies the provider-native counting endpoint used for this result. */
  source: string
}

export interface Provider {
  readonly id: string
  readonly model: string
  readonly config?: ProviderConfig
  getActiveConfig?(): ProviderConfig
  setRole?(role: string): void
  setTurnContext?(input: { userText: string; turnNumber?: number; hasNonTextContent?: boolean }): void
  /** Optional exact-input preflight. Unsupported gateways return undefined and use the local estimate. */
  countTokens?(messages: ChatMessage[], tools: ReturnType<ToolRegistry['schemas']>, signal: AbortSignal): Promise<ProviderTokenCount | undefined>
  stream(messages: ChatMessage[], tools: ReturnType<ToolRegistry['schemas']>, signal: AbortSignal): AsyncGenerator<StreamEvent>
}
