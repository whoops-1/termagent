import type { Config, ProviderProfile } from '../config/config.js'
import { resolveProviderConfig } from '../config/config.js'
import { createProvider } from './registry.js'
import type { Provider } from './types.js'

export function resolveProviderTarget(cfg: Config, target?: string): Provider | undefined {
  const value = String(target || '').trim()
  if (!value) return undefined
  if (cfg.providers?.[value]) return createProvider(resolveProviderConfig(cfg, value) as any)

  const profile = Object.entries(cfg.providers || {}).find(([, p]) => p?.model === value)?.[0]
  if (profile) return createProvider(resolveProviderConfig(cfg, profile) as any)

  if (value === cfg.model || value === cfg.provider) return createProvider(resolveProviderConfig(cfg) as any)
  return undefined
}

export function resolveProfileTarget(cfg: Config, target?: string): { name?: string; profile?: ProviderProfile } {
  const value = String(target || '').trim()
  if (!value) return {}
  const direct = cfg.providers?.[value]
  if (direct) return { name: value, profile: direct }
  const entry = Object.entries(cfg.providers || {}).find(([, p]) => p?.model === value)
  if (entry) return { name: entry[0], profile: entry[1] }
  return {}
}

export function configuredModelList(cfg: Config) {
  return Object.entries(cfg.providers || {}).map(([name, profile]) => ({ name, provider: profile.provider, model: profile.model }))
}
