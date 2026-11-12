import type { Config } from '../config/config.js'
import type { Provider } from '../providers/types.js'
import { resolveContextLimits, type ResolvedContextLimits } from './model-limits.js'
import { deriveRepositoryContextBudget, type RepositoryContextBudget } from './budget.js'

export function contextLimitsFor(provider: Provider, config: Config, role = 'default', userText?: string, turnNumber?: number): ResolvedContextLimits {
  provider.setRole?.(role)
  if (userText !== undefined) provider.setTurnContext?.({userText, turnNumber})
  return resolveContextLimits({
    providerConfig: provider.getActiveConfig?.() || provider.config,
    configuredContextWindow: config.maxContextTokens,
  })
}

export function repositoryBudgetFor(
  provider: Provider,
  config: Config,
  role = 'default',
  repositoryFiles = 0,
  userText?: string,
  turnNumber?: number,
): RepositoryContextBudget {
  const limits = contextLimitsFor(provider, config, role, userText, turnNumber)
  return deriveRepositoryContextBudget(limits.contextWindow, {
    mapTokens: config.repoMapTokens,
    maxBytes: config.maxContextBytes,
    repositoryFiles,
  })
}
