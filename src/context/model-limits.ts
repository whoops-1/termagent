import type { ProviderConfig } from '../providers/types.js'

export const CONSERVATIVE_CONTEXT_WINDOW = 128_000
export const DEFAULT_OUTPUT_RESERVE = 8_192
export const MAX_OUTPUT_RESERVE = 32_768

type LimitSource = 'user-config' | 'provider-profile' | 'provider-metadata' | 'conservative-fallback'
type OutputLimitSource = Exclude<LimitSource, 'conservative-fallback'> | 'adapter-config' | 'derived-default'

export interface ResolvedContextLimits {
  provider: string
  model: string
  contextWindow: number
  maxOutputTokens: number
  contextSource: LimitSource
  outputSource: OutputLimitSource
}

export interface ResolveContextLimitsInput {
  providerConfig?: ProviderConfig
  configuredContextWindow?: number
  configuredOutputTokens?: number
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 256 ? number : undefined
}

function metadataNumber(config: ProviderConfig | undefined, key: string): number | undefined {
  const extra = config?.extra
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return undefined
  return positiveInteger((extra as Record<string, unknown>)[key])
}

/**
 * Resolve the active route's effective context limits without pretending that
 * an unknown model supports the largest window seen in the market.
 *
 * Precedence is deliberately explicit and inspectable: user override,
 * provider profile, provider/catalog metadata, then a conservative fallback.
 * `maxTokens` remains the provider adapter's request output cap; the separate
 * `maxOutputTokens` field is a model capability hint used for budgeting.
 */
export function resolveContextLimits(input: ResolveContextLimitsInput = {}): ResolvedContextLimits {
  const config = input.providerConfig
  const configuredWindow = positiveInteger(input.configuredContextWindow)
  const profileWindow = positiveInteger(config?.contextWindow)
  const metadataWindow = metadataNumber(config, 'contextWindow')
  const contextWindow = configuredWindow ?? profileWindow ?? metadataWindow ?? CONSERVATIVE_CONTEXT_WINDOW
  const contextSource: LimitSource = configuredWindow !== undefined
    ? 'user-config'
    : profileWindow !== undefined
      ? 'provider-profile'
      : metadataWindow !== undefined
        ? 'provider-metadata'
        : 'conservative-fallback'

  const configuredOutput = positiveInteger(input.configuredOutputTokens)
  const profileOutput = positiveInteger(config?.maxOutputTokens)
  const metadataOutput = metadataNumber(config, 'maxOutputTokens')
  const adapterOutput = positiveInteger(config?.maxTokens)
  const outputHardLimit = Math.max(128, Math.floor(contextWindow * 0.40))
  const requestedOutput = configuredOutput ?? profileOutput ?? metadataOutput ?? adapterOutput ?? Math.min(
    MAX_OUTPUT_RESERVE,
    Math.max(512, Math.min(DEFAULT_OUTPUT_RESERVE, Math.floor(contextWindow * 0.08))),
  )
  const maxOutputTokens = Math.min(outputHardLimit, requestedOutput)
  const outputSource: ResolvedContextLimits['outputSource'] = configuredOutput !== undefined
    ? 'user-config'
    : profileOutput !== undefined
      ? 'provider-profile'
      : metadataOutput !== undefined
        ? 'provider-metadata'
        : adapterOutput !== undefined
          ? 'adapter-config'
          : 'derived-default'

  return {
    provider: String(config?.provider || config?.providerId || 'unknown'),
    model: String(config?.model || 'unknown'),
    contextWindow,
    maxOutputTokens,
    contextSource,
    outputSource,
  }
}
